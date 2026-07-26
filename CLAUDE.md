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

For a long-running deployment (e.g. behind the ngrok/cloudflared tunnel), `./run.sh` from the repo root builds `server/tag-server` once and restarts it on crash, writing to `logs/server.log`. The binary accepts `-addr` (listen address, default `:8080`) and `-logfile` (default stderr). `GET /health` returns `{"status":"ok"}`.

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

**Hub (`hub.go`):** Single goroutine, select loop at 30 Hz. All game state lives here (no shared mutable state outside the hub). Channels: `register`, `unregister`, `inputs`, `actions`. The `inputs` case only appends to a per-player queue (`inputQueue`); the tick case drains that queue (see Netcode), then runs physics, tag collision, and timer check. `broadcastState()` sends a JSON snapshot to all clients every tick.

**Physics (`game.go`):** `Player.Step()` does per-axis collision — move X, check `IsSolid`, revert if colliding; then move Y with gravity, check, snap to tile boundary. Jump uses a `WantsJump` flag set on the rising edge of the Up key (when an input is dequeued in the tick case, or via the explicit `jump` flag), consumed when the player is on ground. This avoids the timing race of checking input state mid-tick.

**Tag mechanic:** `tagContact map[int]bool` tracks which players are currently overlapping with the tagger. Tag transfers only on the **first frame** of contact, preventing bounce-back while players remain touching.

**Client (`client.go`):** Two goroutines per connection — `readPump` (parses messages, forwards to hub channels) and `writePump` (drains send channel, sends pings). Send buffer is 8 messages (~260ms at 30 Hz). Because `state` is a full snapshot, `broadcastState` uses `queueState`, which evicts the **oldest** buffered frame when the buffer is full so a slow client always gets the freshest snapshot rather than draining a multi-second backlog of stale ones (a deep buffer inflated apparent RTT and lag through the tunnel).

### Netcode

The client (`game.js`) runs its own 30 Hz prediction of the local player (`stepPred` mirrors `Player.Step` exactly) and sends one input message **per predicted tick** with a monotonic `seq`. The server acks the last seq applied per player (`seqs` in the state message); on each snapshot the client re-simulates unacked ticks on top of the server state (rollback reconciliation). Corrections are folded into a visual offset (`corrX/corrY`) that decays over ~150ms instead of snapping. Seq must map 1:1 to ticks — sending inputs only on key events breaks reconciliation and causes rubberbanding at real-network RTT (invisible on localhost).

**Server input queue (the other half of the 1:1 invariant):** the server must also apply exactly one physics step per input seq, or the client's reconciliation snaps onto an under-stepped position. So the hub buffers each player's inputs in a per-player FIFO (`inputQueue`) and, in the tick case, consumes **one input per player per tick** — applying it, recording its seq as the ack (`lastSeq`), then stepping once. `lastSeq` is the seq *actually simulated*, never merely received. Under jitter, inputs arrive in bursts: when a queue has backed up (`len > MaxInputLag`) the server drains 2/tick to catch up so latency doesn't accumulate; when a queue is empty (input starved) it holds the last input and still steps (gravity keeps applying) but does **not** advance `lastSeq`, so the client keeps replaying its unacked ticks. `MaxQueue` caps the buffer and drops the oldest under a flood. The earlier model sampled "latest input per tick" and acked the latest *received* seq — on localhost that accidentally equals one-input-per-tick, but through a tunnel the burst/starve mismatch rubberbanded the authoritative position (the classic "local box passes the turn, server box stuck").

Remote players render through a snapshot jitter buffer: state messages carry a server `tick`, and the client renders other players ~3 ticks (100ms) in the past, interpolating between buffered snapshots. Measured RTT (client timestamp `t` echoed back via `pings`) is drawn in the canvas corner during play.

To test netcode changes under latency, run a delay proxy in front of the server and drive two browsers — DevTools throttling does not affect WebSockets, and headless Chrome runs rAF below 30fps which masks prediction bugs (use headful).

### Message protocol

Client → server:
- `{type:"input", seq, jump, t, up, down, left, right}` — sent every client tick while playing; `seq` is a per-tick counter, `jump` requests a jump (edge-detected keydowns can fall between ticks), `t` is a client timestamp echoed back for RTT
- `{type:"start"}` — start the round (lobby only, requires ≥2 players)
- `{type:"restart"}` — return to lobby (gameover only)

Server → client:
- `{type:"welcome", id, roomName, timerSecs, maxPlayers, world:{w,h}, playerSize, tileSize, map, blockTypes}` — sent on join
- `{type:"state", phase, tick, players, taggedId?, timeLeft?, seqs?, pings?, loserId?}` — broadcast every tick; `seqs` = last input seq applied per player, `pings` = last input timestamp per player (echo)
- `{type:"in_progress"}` or `{type:"full"}` — rejection messages

### Map format

`maps/*.json`: `{cols: 26, rows: 20, tiles: [[int]]}`. Block IDs: 0=Empty, 1=Wall (solid), 2=Spike, 3=Ice. Only Wall is currently solid. Maps are loaded once when a room is created.

### Frontend

`index.html` / `game.js` — home screen polls `GET /api/rooms` every 3s, renders room list. Creating a room hits `POST /api/rooms` then opens a WebSocket to `/ws?room=<id>&name=<name>`. Phase-based UI: lobby overlay → canvas + timer → gameover overlay.

`editor.html` / `editor.js` — standalone map editor. Left-click paints, right-click erases. Saves via `POST /api/maps/<name>`. Map names for the editor are restricted to `[a-zA-Z0-9_-]` (no spaces); room names allow spaces.
