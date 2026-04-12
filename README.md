# Tag

A multiplayer browser game of tag with 2D platformer physics. Up to 4 players join a room, one player is randomly tagged "it", and the last one holding the tag when the timer runs out loses.

## How to play

- **Arrow keys / WASD** — move and jump
- Don't be "it" when the timer hits zero

Rooms are ephemeral — they disappear when the last player leaves.

## Running

```bash
cd server
go run .
```

Open `http://localhost:8080`. The server serves both the API and frontend on port 8080.

## Map editor

Go to `http://localhost:8080/editor.html`.

- Left-click to paint tiles, right-click to erase
- Maps are saved to `maps/<name>.json` via `POST /api/maps/<name>`

### Tile types

| ID | Name  | Solid |
|----|-------|-------|
| 0  | Empty | No    |
| 1  | Wall  | Yes   |
| 2  | Spike | No    |
| 3  | Ice   | No    |

## Stack

- **Backend:** Go, no framework. `gorilla/websocket` for WebSocket connections.
- **Frontend:** Plain HTML + vanilla JS, no build step.
- **Protocol:** WebSocket JSON messages. State is broadcast to all clients at 30 Hz.

## Project structure

```
tag/
  server/           Go backend
    main.go         HTTP routes
    hub.go          Game loop (30 Hz tick, tag logic, timer)
    game.go         Physics, map loading, player struct
    client.go       Per-connection read/write pumps
    room_manager.go Room registry
  frontend/
    index.html      Home screen + room list
    game.js         Game rendering and input
    editor.html     Map editor
    editor.js       Map editor logic
  maps/             JSON map files
```
