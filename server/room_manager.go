package main

import (
	"fmt"
	"log"
	"sync"

	"github.com/google/uuid"
)

// RoomInfo is the public view of a room (for listing).
type RoomInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	MapName     string `json:"mapName"`
	TimerSecs   int    `json:"timerSecs"`
	PlayerCount int    `json:"playerCount"`
	MaxPlayers  int    `json:"maxPlayers"`
	Phase       string `json:"phase"`
}

// RoomManager owns all active game rooms.
type RoomManager struct {
	mu    sync.Mutex
	rooms map[string]*Hub
}

func NewRoomManager() *RoomManager {
	return &RoomManager{
		rooms: make(map[string]*Hub),
	}
}

// Create starts a new hub and returns its ID.
func (rm *RoomManager) Create(roomName, mapPath, mapName string, timerSecs int) (*Hub, string, error) {
	id := uuid.NewString()

	gm, err := LoadMap(mapPath)
	if err != nil {
		return nil, "", fmt.Errorf("load map %s: %w", mapPath, err)
	}
	log.Printf("room %s: loaded map %s (%dx%d)", id, mapName, gm.Cols, gm.Rows)

	hub := &Hub{
		roomID:    id,
		roomName:  roomName,
		mapName:   mapName,
		timerSecs: timerSecs,
		gameMap:   gm,
		clients:   make(map[int]*Client),
		players:   make(map[int]*Player),
		register:  make(chan *Client),
		unregister: make(chan *Client),
		inputs:    make(chan inputMsg, 64),
		actions:   make(chan actionMsg, 16),
		phase:     PhaseLobby,
		taggedID:  -1,
		loserId:   -1,
		tagContact: make(map[int]bool),
	}
	hub.onEmpty = func() {
		rm.mu.Lock()
		delete(rm.rooms, id)
		rm.mu.Unlock()
		log.Printf("room %s deleted (empty)", id)
	}

	rm.mu.Lock()
	rm.rooms[id] = hub
	rm.mu.Unlock()

	go hub.Run()
	return hub, id, nil
}

// Get returns the hub for a room ID, or nil if not found.
func (rm *RoomManager) Get(id string) *Hub {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	return rm.rooms[id]
}

// List returns a snapshot of all room infos.
func (rm *RoomManager) List() []RoomInfo {
	rm.mu.Lock()
	hubs := make([]*Hub, 0, len(rm.rooms))
	for _, h := range rm.rooms {
		hubs = append(hubs, h)
	}
	rm.mu.Unlock()

	infos := make([]RoomInfo, 0, len(hubs))
	for _, h := range hubs {
		h.mu.Lock()
		infos = append(infos, RoomInfo{
			ID:          h.roomID,
			Name:        h.roomName,
			MapName:     h.mapName,
			TimerSecs:   h.timerSecs,
			PlayerCount: len(h.clients),
			MaxPlayers:  MaxPlayers,
			Phase:       h.phase,
		})
		h.mu.Unlock()
	}
	return infos
}
