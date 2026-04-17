package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// mapNameRe restricts map/room names to simple alphanumeric + dash/underscore + space.
var mapNameRe = regexp.MustCompile(`^[a-zA-Z0-9_\- ]+$`)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	logfile := flag.String("logfile", "", "path to log file (default: stderr)")
	flag.Parse()

	if *logfile != "" {
		f, err := os.OpenFile(*logfile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
		if err != nil {
			log.Fatalf("open log file: %v", err)
		}
		defer f.Close()
		log.SetOutput(f)
	}
	log.SetFlags(log.Ldate | log.Ltime | log.Lmsgprefix)

	rm := NewRoomManager()

	mux := http.NewServeMux()

	// List rooms.
	mux.HandleFunc("/api/rooms", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(rm.List())
			return
		}
		handleCreateRoom(rm, w, r)
	})

	// WebSocket — join a room.
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWS(rm, w, r)
	})

	// Map list.
	mux.HandleFunc("/api/maps", func(w http.ResponseWriter, r *http.Request) {
		handleMapList(w, r)
	})

	// Map save/load.
	mux.HandleFunc("/api/maps/", func(w http.ResponseWriter, r *http.Request) {
		handleMapSave(w, r)
	})

	// Health check.
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	mux.Handle("/", http.FileServer(http.Dir("../frontend")))

	srv := &http.Server{Addr: *addr, Handler: mux}

	go func() {
		log.Printf("listening on %s", *addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	log.Println("stopped")
}

func handleCreateRoom(rm *RoomManager, w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		http.Error(w, "read error", http.StatusInternalServerError)
		return
	}
	var req struct {
		Name      string `json:"name"`
		Map       string `json:"map"`
		TimerSecs int    `json:"timerSecs"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Name == "" || !mapNameRe.MatchString(req.Name) {
		http.Error(w, "invalid room name", http.StatusBadRequest)
		return
	}
	if req.Map == "" {
		req.Map = "default"
	}
	mapPath := filepath.Join("..", "maps", req.Map+".json")
	if _, err := os.Stat(mapPath); err != nil {
		http.Error(w, "map not found", http.StatusBadRequest)
		return
	}
	if req.TimerSecs < 10 {
		req.TimerSecs = 10
	}
	if req.TimerSecs > 300 {
		req.TimerSecs = 300
	}

	_, id, err := rm.Create(req.Name, mapPath, req.Map, req.TimerSecs)
	if err != nil {
		http.Error(w, "create room: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]string{"id": id, "name": req.Name})
}

func serveWS(rm *RoomManager, w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	if roomID == "" {
		http.Error(w, "missing room", http.StatusBadRequest)
		return
	}
	hub := rm.Get(roomID)
	if hub == nil {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}
	if hub.Phase() != PhaseLobby {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"type": "in_progress"})
		return
	}
	if hub.Full() {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"type": "full"})
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}

	client := NewClient(hub, conn)
	client.playerName = r.URL.Query().Get("name")
	hub.register <- client

	go client.writePump()
	go client.readPump()
}

func handleMapList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	entries, err := os.ReadDir("../maps")
	if err != nil {
		http.Error(w, "read dir: "+err.Error(), http.StatusInternalServerError)
		return
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		names = append(names, strings.TrimSuffix(e.Name(), ".json"))
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(names)
}

func handleMapSave(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(r.URL.Path)
	if !mapNameRe.MatchString(name) {
		http.Error(w, "invalid map name", http.StatusBadRequest)
		return
	}

	switch r.Method {
	case http.MethodGet:
		path := filepath.Join("..", "maps", name+".json")
		data, err := os.ReadFile(path)
		if err != nil {
			http.Error(w, "map not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(data)

	case http.MethodPost:
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			http.Error(w, "read error", http.StatusInternalServerError)
			return
		}
		var m GameMap
		if err := json.Unmarshal(body, &m); err != nil {
			http.Error(w, "invalid map JSON: "+err.Error(), http.StatusBadRequest)
			return
		}
		dest := filepath.Join("..", "maps", name+".json")
		if err := os.WriteFile(dest, body, 0644); err != nil {
			http.Error(w, "write error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		log.Printf("saved map %s (%dx%d)", name, m.Cols, m.Rows)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
