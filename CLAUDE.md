# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All server commands run from `server/`:

```bash
# Run the server (serves both API and frontend on :8080)
go run .

# Build
go build ./...

# Add a dependency
go get <package>
```

There are no tests. The frontend is plain HTML/JS with no build step — edit and refresh.

The map editor is at `http://localhost:8080/editor.html`.

## Architecture

```
tag/
  server/      Go backend
  frontend/    Static files served by Go
  maps/        JSON map files (loaded at runtime)
```

### Server

Single Go process, no framework. `main.go` registers HTTP routes and hands off to handlers. There are no tests.

**Room lifecycle:** `RoomManager` (`room_manager.go`) owns all active games. `POST /api/rooms` creates a room (name, map, timerSecs), returns a UUID. Each room is a `Hub` goroutine. When the last player disconnects, the hub calls `onEmpty()` and the goroutine exits — rooms are ephemeral.

**Hub (`hub.go`):** Single goroutine, select loop at 30 Hz. All game state lives here (no shared mutable state outside the hub). Channels: `register`, `unregister`, `inputs`, `actions`. The tick case runs physics, tag collision, and timer check. `broadcastState()` sends a JSON snapshot to all clients every tick.

**Physics (`game.go`):** `Player.Step()` does per-axis collision — move X, check `IsSolid`, revert if colliding; then move Y with gravity, check, snap to tile boundary. Jump uses a `WantsJump` flag set on the rising edge of the Up key (in the hub's inputs case), consumed when the player is on ground. This avoids the timing race of checking input state mid-tick.

**Tag mechanic:** `tagContact map[int]bool` tracks which players are currently overlapping with the tagger. Tag transfers only on the **first frame** of contact, preventing bounce-back while players remain touching.

**Client (`client.go`):** Two goroutines per connection — `readPump` (parses messages, forwards to hub channels) and `writePump` (drains send channel, sends pings). Send buffer is 16 messages; full buffers are dropped silently.

### Message protocol

Client → server:
- `{type:"input", up, down, left, right}` — sent on keydown/keyup
- `{type:"start"}` — start the round (lobby only, requires ≥2 players)
- `{type:"restart"}` — return to lobby (gameover only)

Server → client:
- `{type:"welcome", id, roomName, timerSecs, playerSize, tileSize, map, blockTypes}` — sent on join
- `{type:"state", phase, players, taggedId?, timeLeft?, loserId?}` — broadcast every tick
- `{type:"in_progress"}` or `{type:"full"}` — rejection messages

### Map format

`maps/*.json`: `{cols: 26, rows: 20, tiles: [[int]]}`. Block IDs: 0=Empty, 1=Wall (solid), 2=Spike, 3=Ice. Only Wall is currently solid. Maps are loaded once when a room is created.

### Frontend

`index.html` / `game.js` — home screen polls `GET /api/rooms` every 3s, renders room list. Creating a room hits `POST /api/rooms` then opens a WebSocket to `/ws?room=<id>&name=<name>`. Phase-based UI: lobby overlay → canvas + timer → gameover overlay.

`editor.html` / `editor.js` — standalone map editor. Left-click paints, right-click erases. Saves via `POST /api/maps/<name>`. Map names for the editor are restricted to `[a-zA-Z0-9_-]` (no spaces); room names allow spaces.
