package main

import (
	"encoding/json"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 1024
	sendBufferSize = 16
)

// Client is a single WebSocket connection.
type Client struct {
	id         int
	hub        *Hub
	conn       *websocket.Conn
	send       chan []byte
	playerName string // display name
}

func NewClient(hub *Hub, conn *websocket.Conn) *Client {
	return &Client{
		hub:  hub,
		conn: conn,
		send: make(chan []byte, sendBufferSize),
	}
}

// sendJSON marshals v and pushes it onto the client's send channel.
// Safe to call before readPump/writePump start.
func (c *Client) sendJSON(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("sendJSON marshal: %v", err)
		return
	}
	select {
	case c.send <- data:
	default:
	}
}

// readPump reads input messages from the socket and forwards them to the hub.
func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()
	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("read error: %v", err)
			}
			return
		}
		var msg struct {
			Type  string `json:"type"`
			Up    bool   `json:"up"`
			Down  bool   `json:"down"`
			Left  bool   `json:"left"`
			Right bool   `json:"right"`
		}
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		switch msg.Type {
		case "input":
			c.hub.inputs <- inputMsg{
				playerID: c.id,
				input: InputState{
					Up:    msg.Up,
					Down:  msg.Down,
					Left:  msg.Left,
					Right: msg.Right,
				},
			}
		case "start", "restart":
			c.hub.actions <- actionMsg{
				playerID: c.id,
				action:   msg.Type,
			}
		}
	}
}

// writePump drains the send channel to the socket and sends periodic pings.
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case data, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// Hub closed the channel.
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
