package main

import (
	"encoding/json"
	"log"
	"math/rand"
	"sort"
	"sync"
	"time"
)

const (
	PhaseLobby    = "lobby"
	PhasePlaying  = "playing"
	PhaseGameOver = "gameover"
)

type inputMsg struct {
	playerID int
	input    InputState
}

type actionMsg struct {
	playerID int
	action   string // "start", "restart"
}

type Hub struct {
	// Room metadata (set once at creation, read-only after).
	roomID    string
	roomName  string
	mapName   string
	timerSecs int
	onEmpty   func() // called when the last client leaves

	gameMap       *GameMap
	clients       map[int]*Client
	players       map[int]*Player
	register      chan *Client
	unregister    chan *Client
	inputs        chan inputMsg
	actions       chan actionMsg
	mu            sync.Mutex
	phase         string
	taggedID      int
	loserId       int
	timerEnd      time.Time
	timerDuration time.Duration
	tagContact    map[int]bool // players currently overlapping with tagger (prevents bounce)
}


func (h *Hub) Full() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients) >= MaxPlayers
}

func (h *Hub) Phase() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.phase
}

func (h *Hub) nextSlot() int {
	for i := 0; i < MaxPlayers; i++ {
		if _, taken := h.clients[i]; !taken {
			return i
		}
	}
	return -1
}

// randomPlayer returns the ID of a random connected player.
func (h *Hub) randomPlayer() int {
	ids := make([]int, 0, len(h.players))
	for id := range h.players {
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return -1
	}
	return ids[rand.Intn(len(ids))]
}

// randomPlayerExcept returns a random connected player that isn't `exclude`.
func (h *Hub) randomPlayerExcept(exclude int) int {
	ids := make([]int, 0, len(h.players))
	for id := range h.players {
		if id != exclude {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return -1
	}
	return ids[rand.Intn(len(ids))]
}

func (h *Hub) resetPlayersToSpawn() {
	for _, p := range h.players {
		spawn := SpawnPositions[p.ID]
		p.X = spawn[0]
		p.Y = spawn[1]
		p.VelY = 0
		p.OnGround = false
		p.Input = InputState{}
	}
}

func (h *Hub) Run() {
	ticker := time.NewTicker(time.Second / TickRate)
	defer ticker.Stop()

	for {
		select {
		case c := <-h.register:
			h.mu.Lock()
			// Reject joins when game is in progress.
			if h.phase != PhaseLobby {
				h.mu.Unlock()
				c.sendJSON(map[string]any{"type": "in_progress"})
				close(c.send)
				continue
			}
			slot := h.nextSlot()
			if slot == -1 {
				h.mu.Unlock()
				c.sendJSON(map[string]any{"type": "full"})
				close(c.send)
				continue
			}
			c.id = slot
			spawn := SpawnPositions[slot]
			name := c.playerName
			if name == "" {
				name = "Player " + string(rune('1'+slot))
			}
			p := &Player{
				ID:    slot,
				X:     spawn[0],
				Y:     spawn[1],
				Color: Colors[slot],
				Name:  name,
			}
			h.clients[slot] = c
			h.players[slot] = p
			h.mu.Unlock()

			c.sendJSON(map[string]any{
				"type":       "welcome",
				"id":         slot,
				"roomName":   h.roomName,
				"timerSecs":  h.timerSecs,
				"maxPlayers": MaxPlayers,
				"world":      map[string]int{"w": WorldWidth, "h": WorldHeight},
				"playerSize": PlayerSize,
				"tileSize":   TileSize,
				"map":        h.gameMap,
				"blockTypes": BlockTypes,
			})
			h.broadcastState()
			log.Printf("player %d joined (%d/%d)", slot, len(h.clients), MaxPlayers)

		case c := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[c.id]; ok {
				delete(h.clients, c.id)
				delete(h.players, c.id)
				close(c.send)
				log.Printf("player %d left", c.id)

				if h.phase == PhasePlaying {
					if len(h.players) < 2 {
						// Not enough players — end the game.
						if len(h.players) == 1 {
							// Remaining player wins (loserId = -1 means "nobody lost").
							h.loserId = -1
						} else {
							h.loserId = -1
						}
						h.phase = PhaseGameOver
					} else if c.id == h.taggedID {
						// Tagged player left — pick new random.
						h.taggedID = h.randomPlayer()
					}
				}

				if len(h.clients) == 0 {
					// Everyone left — notify manager to delete room.
					h.mu.Unlock()
					if h.onEmpty != nil {
						h.onEmpty()
					}
					return
				}
			}
			h.mu.Unlock()
			h.broadcastState()

		case in := <-h.inputs:
			if h.phase == PhasePlaying {
				if p, ok := h.players[in.playerID]; ok {
					// Set WantsJump on rising edge of Up key.
					if in.input.Up && !p.Input.Up {
						p.WantsJump = true
					}
					p.Input = in.input
				}
			}

		case act := <-h.actions:
			switch act.action {
			case "start":
				if h.phase != PhaseLobby || len(h.players) < 2 {
					continue
				}
				h.timerDuration = time.Duration(h.timerSecs) * time.Second
				h.timerEnd = time.Now().Add(h.timerDuration)
				h.taggedID = h.randomPlayer()
				h.loserId = -1
				h.tagContact = make(map[int]bool)
				h.resetPlayersToSpawn()
				h.phase = PhasePlaying
				h.broadcastState()
				log.Printf("room %s: game started (%ds, tagged=%d)", h.roomID, h.timerSecs, h.taggedID)

			case "restart":
				if h.phase != PhaseGameOver {
					continue
				}
				h.resetPlayersToSpawn()
				h.taggedID = -1
				h.loserId = -1
				h.phase = PhaseLobby
				h.broadcastState()
				log.Printf("returned to lobby")
			}

		case <-ticker.C:
			if h.phase == PhasePlaying {
				// Physics.
				for _, p := range h.players {
					p.Step(h.gameMap)
				}

				// Tag collision — only transfer on first contact (not while overlapping).
				if tagged, ok := h.players[h.taggedID]; ok {
					nowOverlapping := make(map[int]bool)
					for _, other := range h.players {
						if other.ID == h.taggedID {
							continue
						}
						if PlayersOverlap(tagged, other) {
							nowOverlapping[other.ID] = true
							if !h.tagContact[other.ID] {
								// First frame of contact — transfer tag.
								oldTagger := h.taggedID
								h.taggedID = other.ID
								// Rebuild contact set for the new tagger.
								h.tagContact = make(map[int]bool)
								h.tagContact[oldTagger] = true // still touching old tagger
								// Also mark anyone else currently overlapping with new tagger.
								for _, p2 := range h.players {
									if p2.ID != h.taggedID && PlayersOverlap(other, p2) {
										h.tagContact[p2.ID] = true
									}
								}
								break
							}
						}
					}
					// If tag didn't transfer, update contact set for current tagger.
					if _, ok := h.players[h.taggedID]; ok && h.taggedID == tagged.ID {
						h.tagContact = nowOverlapping
					}
				}

				// Timer check.
				if time.Now().After(h.timerEnd) {
					h.loserId = h.taggedID
					h.phase = PhaseGameOver
					// Clear all inputs so players freeze.
					for _, p := range h.players {
						p.Input = InputState{}
					}
					log.Printf("game over, loser=%d", h.loserId)
				}
			}
			h.broadcastState()
		}
	}
}

func (h *Hub) broadcastState() {
	players := make([]Player, 0, len(h.players))
	for _, p := range h.players {
		players = append(players, *p)
	}
	sort.Slice(players, func(i, j int) bool { return players[i].ID < players[j].ID })

	msg := map[string]any{
		"type":    "state",
		"phase":   h.phase,
		"players": players,
	}

	switch h.phase {
	case PhasePlaying:
		msg["taggedId"] = h.taggedID
		remaining := time.Until(h.timerEnd).Seconds()
		if remaining < 0 {
			remaining = 0
		}
		msg["timeLeft"] = remaining
	case PhaseGameOver:
		msg["loserId"] = h.loserId
	}

	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("marshal state: %v", err)
		return
	}
	for _, c := range h.clients {
		select {
		case c.send <- data:
		default:
		}
	}
}
