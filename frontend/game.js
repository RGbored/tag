(() => {
  // --- DOM refs ---
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const statusEl = document.getElementById("status");
  const messageEl = document.getElementById("message");
  const homeScreen = document.getElementById("home-screen");
  const gameWrap = document.getElementById("game-wrap");
  const mapSelect = document.getElementById("map-select");
  const timerSelect = document.getElementById("timer-select");
  const btnCreate = document.getElementById("btn-create");
  const roomNameInput = document.getElementById("room-name-input");
  const nameInput = document.getElementById("name-input");
  const roomListEl = document.getElementById("room-list");
  const noRoomsEl = document.getElementById("no-rooms");
  const waitingEl = document.getElementById("waiting");
  const lobbyTitleEl = document.getElementById("lobby-title");
  const playerListEl = document.getElementById("player-list");
  const waitingHint = document.getElementById("waiting-hint");
  const btnStart = document.getElementById("btn-start");
  const btnLeaveLobby = document.getElementById("btn-leave-lobby");
  const timerDisplay = document.getElementById("timer-display");
  const gameOverEl = document.getElementById("game-over");
  const loserText = document.getElementById("loser-text");
  const btnPlayAgain = document.getElementById("btn-play-again");
  const btnLeave = document.getElementById("btn-leave");

  const host = location.host || "localhost:8080";
  const base = `${location.protocol || "http:"}//${host}`;
  const wsScheme = location.protocol === "https:" ? "wss" : "ws";

  // --- Game state ---
  let myId = null;
  let playerSize = 30;
  let tileSize = 30;
  let players = [];
  let tileMap = null;
  let blockTypes = [];
  let phase = "lobby";
  let taggedId = -1;
  let timeLeft = 0;
  let loserId = -1;
  let ws = null;

  // Snapshot interpolation — buffer recent server snapshots and render remote players
  // a few ticks in the past, so bursty delivery (tunnels, Wi-Fi power save) stays smooth.
  let snapBuf = [];          // { tick, players } ordered by server tick
  let renderTick = 0;        // fractional server tick remote players are rendered at
  let lastFrameTs = 0;       // rAF timestamp of previous frame
  let rtt = -1;              // measured round-trip ms, -1 = unknown
  const TICK_MS = 1000 / 30;
  const INTERP_DELAY_TICKS = 3;  // ~100ms playback delay for remote players
  const SNAP_BUF_MAX = 30;       // ~1s of snapshots

  // Offscreen canvas baked once on map load; redrawn each frame via drawImage.
  let tileCache = null;

  // Physics constants — must match server/game.go exactly.
  const PLAYER_SPEED = 7;
  const GRAVITY = 0.7;
  const JUMP_VEL = 12.0;
  const MAX_FALL = 16.0;
  const WORLD_W = 780;
  const WORLD_H = 600;

  // Client-side prediction state.
  let pred = null;        // { x, y, velY, onGround, wantsJump } — local player only
  let predPrev = null;    // pred at start of current tick, for intra-tick lerp
  let solidGrid = null;   // boolean[row][col] built from tile map
  let lastPredTick = 0;   // rAF timestamp of last physics step
  let inputSeq = 0;       // per-tick counter; one input message sent per predicted tick
  let predHistory = [];   // { seq, keys:{up,down,left,right}, wantsJump } — one entry per tick
  // Visual offset that absorbs reconciliation corrections and decays over ~150ms,
  // so small (±1 tick) server disagreements never appear as instant jumps.
  let corrX = 0, corrY = 0;

  const keys = { up: false, down: false, left: false, right: false };
  const keyMap = {
    ArrowUp: "up", w: "up", W: "up",
    ArrowDown: "down", s: "down", S: "down",
    ArrowLeft: "left", a: "left", A: "left",
    ArrowRight: "right", d: "right", D: "right",
  };

  // --- Populate map list ---
  async function loadMapList() {
    try {
      const res = await fetch(`${base}/api/maps`);
      const names = await res.json();
      mapSelect.innerHTML = "";
      for (const name of names) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        mapSelect.appendChild(opt);
      }
    } catch {
      mapSelect.innerHTML = "<option value='default'>default</option>";
    }
  }

  // --- Room list polling ---
  let roomPollTimer = null;

  function startRoomPolling() {
    refreshRooms();
    roomPollTimer = setInterval(refreshRooms, 3000);
  }

  function stopRoomPolling() {
    if (roomPollTimer) { clearInterval(roomPollTimer); roomPollTimer = null; }
  }

  async function refreshRooms() {
    try {
      const res = await fetch(`${base}/api/rooms`);
      const rooms = await res.json();
      renderRoomList(rooms || []);
    } catch {
      // ignore — server may not be up yet
    }
  }

  function renderRoomList(rooms) {
    roomListEl.innerHTML = "";
    if (!rooms || rooms.length === 0) {
      roomListEl.appendChild(noRoomsEl);
      return;
    }
    for (const room of rooms) {
      const row = document.createElement("div");
      row.className = "room-row";
      const isFull = room.playerCount >= room.maxPlayers;
      const inProgress = room.phase !== "lobby";
      const disabled = isFull || inProgress;
      const statusStr = inProgress
        ? room.phase === "playing" ? "in progress" : "game over"
        : `${room.playerCount}/${room.maxPlayers} players`;
      row.innerHTML = `
        <div>
          <div>${escHtml(room.name)}</div>
          <div class="room-meta">${escHtml(room.mapName)} &bull; ${room.timerSecs}s &bull; ${statusStr}</div>
        </div>
        <button ${disabled ? "disabled" : ""} data-id="${escHtml(room.id)}">join</button>
      `;
      const btn = row.querySelector("button");
      if (!disabled) {
        btn.addEventListener("click", () => joinRoom(room.id));
      }
      roomListEl.appendChild(row);
    }
  }

  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // --- Init ---
  loadMapList();
  startRoomPolling();

  // --- Create room ---
  btnCreate.addEventListener("click", async () => {
    const roomName = roomNameInput.value.trim();
    if (!roomName) { roomNameInput.focus(); return; }
    const mapName = mapSelect.value;
    const timerSecs = parseInt(timerSelect.value, 10) || 60;

    btnCreate.disabled = true;
    try {
      const res = await fetch(`${base}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: roomName, map: mapName, timerSecs }),
      });
      if (!res.ok) {
        const text = await res.text();
        messageEl.textContent = "error: " + text;
        return;
      }
      const { id } = await res.json();
      joinRoom(id);
    } catch (e) {
      messageEl.textContent = "network error";
    } finally {
      btnCreate.disabled = false;
    }
  });

  // --- Join room ---
  function joinRoom(roomId) {
    const playerName = nameInput.value.trim();
    stopRoomPolling();
    homeScreen.style.display = "none";
    gameWrap.style.display = "block";
    messageEl.textContent = "";
    connect(roomId, playerName);
  }

  // --- Leave room (back to home) ---
  function leaveRoom() {
    if (ws) { ws.close(); ws = null; }
    myId = null;
    players = [];
    tileMap = null;
    blockTypes = [];
    phase = "lobby";
    taggedId = -1;
    loserId = -1;
    snapBuf = [];
    renderTick = 0;
    rtt = -1;
    corrX = 0; corrY = 0;
    for (const k of Object.keys(keys)) keys[k] = false;
    gameWrap.style.display = "none";
    homeScreen.style.display = "flex";
    statusEl.textContent = "";
    messageEl.textContent = "";
    startRoomPolling();
    refreshRooms();
  }

  btnLeaveLobby.addEventListener("click", leaveRoom);
  btnLeave.addEventListener("click", leaveRoom);

  // --- WebSocket ---
  function connect(roomId, playerName) {
    let url = `${wsScheme}://${host}/ws?room=${encodeURIComponent(roomId)}`;
    if (playerName) url += `&name=${encodeURIComponent(playerName)}`;
    ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      statusEl.textContent = "connected";
    });

    ws.addEventListener("close", () => {
      statusEl.textContent = "disconnected";
    });

    ws.addEventListener("error", () => {
      statusEl.textContent = "connection error";
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      switch (msg.type) {
        case "welcome":
          myId = msg.id;
          playerSize = msg.playerSize;
          tileSize = msg.tileSize || 30;
          if (msg.blockTypes) blockTypes = msg.blockTypes;
          if (msg.map) { tileMap = msg.map; buildTileCache(); buildSolidGrid(); }
          if (msg.roomName) lobbyTitleEl.textContent = msg.roomName;
          break;

        case "state": {
          const newPhase = msg.phase || "lobby";
          const newPlayers = msg.players || [];
          players = newPlayers;

          const tick = msg.tick ?? 0;
          const last = snapBuf[snapBuf.length - 1];
          if (last && last.tick === tick) {
            last.players = newPlayers; // mid-tick broadcast (join/leave) — replace
          } else {
            snapBuf.push({ tick, players: newPlayers });
            if (snapBuf.length > SNAP_BUF_MAX) snapBuf.shift();
          }

          if (msg.pings && msg.pings[myId] > 0) {
            rtt = performance.now() - msg.pings[myId];
          }

          // Initialise prediction when entering playing phase.
          if (newPhase === "playing" && phase !== "playing") {
            const me = newPlayers.find(p => p.id === myId);
            if (me) {
              pred = { x: me.x, y: me.y, velY: me.velY ?? 0, onGround: me.onGround ?? false, wantsJump: false };
              predPrev = { ...pred };
              lastPredTick = performance.now();
              predHistory = [];
            }
            snapBuf = [{ tick, players: newPlayers }];
            renderTick = tick - INTERP_DELAY_TICKS;
          }
          // Clear prediction when leaving playing phase.
          if (newPhase !== "playing") { pred = null; predPrev = null; predHistory = []; rtt = -1; corrX = 0; corrY = 0; }

          // Rollback reconciliation: when the server acknowledges an input seq, start from
          // the server's authoritative state and re-simulate all inputs the server hasn't
          // seen yet. This eliminates rubberbanding caused by stale positional corrections.
          if (newPhase === "playing" && pred !== null) {
            const me = newPlayers.find(p => p.id === myId);
            if (me) {
              const ackSeq = (msg.seqs && msg.seqs[myId]) || 0;
              if (ackSeq > 0) {
                const oldX = pred.x, oldY = pred.y;
                // Find the first history entry that the server hasn't processed yet.
                const replayStart = predHistory.findIndex(e => e.seq > ackSeq);
                if (replayStart === -1) {
                  // Server is fully caught up — its state is ground truth.
                  pred = { x: me.x, y: me.y, velY: me.velY ?? 0, onGround: me.onGround ?? false, wantsJump: pred.wantsJump };
                  predPrev = { ...pred };
                  predHistory = [];
                } else {
                  // Re-simulate unacknowledged inputs on top of the confirmed server state.
                  let s = { x: me.x, y: me.y, velY: me.velY ?? 0, onGround: me.onGround ?? false, wantsJump: false };
                  for (let i = replayStart; i < predHistory.length; i++) {
                    s.wantsJump = predHistory[i].wantsJump;
                    s = stepPred(s, predHistory[i].keys);
                  }
                  s.wantsJump = pred.wantsJump; // preserve a jump queued since the last tick
                  pred = s;
                  predPrev = { ...pred };
                  predHistory = predHistory.slice(replayStart);
                }
                // Fold the correction into the visual offset so the rendered
                // position stays continuous; it decays to zero in draw().
                corrX += oldX - pred.x;
                corrY += oldY - pred.y;
                if (Math.hypot(corrX, corrY) > 60) { corrX = 0; corrY = 0; } // teleport (e.g. respawn): snap
              }
              // If ackSeq === 0 the server hasn't received our first input yet —
              // pred was seeded from server state on phase entry, so no correction needed.
            }
          }

          phase = newPhase;
          taggedId = msg.taggedId ?? -1;
          timeLeft = msg.timeLeft ?? 0;
          loserId = msg.loserId ?? -1;
          updateUI();
          break;
        }

        case "full":
          messageEl.textContent = "room is full";
          leaveRoom();
          break;

        case "in_progress":
          messageEl.textContent = "game in progress — try again later";
          leaveRoom();
          break;
      }
    });
  }

  // --- UI updates based on phase ---
  function updateUI() {
    waitingEl.style.display = phase === "lobby" ? "flex" : "none";
    gameOverEl.style.display = phase === "gameover" ? "flex" : "none";
    timerDisplay.style.display = phase === "playing" ? "block" : "none";

    if (phase === "lobby") {
      updatePlayerList();
      const canStart = players.length >= 2;
      btnStart.disabled = !canStart;
      btnStart.style.opacity = canStart ? "1" : "0.4";
      waitingHint.style.display = canStart ? "none" : "block";
    }

    if (phase === "playing") {
      const secs = Math.ceil(timeLeft);
      timerDisplay.textContent = secs + "s";
      timerDisplay.style.color = secs <= 10 ? "#e74c3c" : "#fff";
    }

    if (phase === "gameover") {
      if (loserId === -1) {
        loserText.textContent = "You win!";
        loserText.style.color = "#2ecc71";
      } else {
        const loser = players.find(p => p.id === loserId);
        const color = loser ? loser.color : "#ddd";
        const name = loser ? pname(loser) : ("Player " + (loserId + 1));
        loserText.innerHTML = `<span style="color:${color}">${escHtml(name)}</span> loses!`;
      }
    }
  }

  function pname(p) {
    return p.name || ("Player " + (p.id + 1));
  }

  function updatePlayerList() {
    playerListEl.innerHTML = "";
    for (const p of players) {
      const chip = document.createElement("div");
      chip.className = "player-chip";
      const label = pname(p) + (p.id === myId ? " (you)" : "");
      chip.innerHTML = `<span class="swatch" style="background:${p.color}"></span>${escHtml(label)}`;
      playerListEl.appendChild(chip);
    }
  }

  // --- Lobby: start game ---
  btnStart.addEventListener("click", () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "start" }));
  });

  // --- Game over: play again ---
  btnPlayAgain.addEventListener("click", () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "restart" }));
  });

  // --- Input ---
  // Sent once per prediction tick (not per key event) so seq maps 1:1 to ticks —
  // the server's ack of seq N then means "state includes ticks ≤ N", which is what
  // rollback reconciliation needs. `jump` is explicit because a quick tap could
  // otherwise fall entirely between two per-tick sends.
  function sendInput(seq, jump) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "input", seq, jump, t: performance.now(), ...keys }));
  }

  window.addEventListener("keydown", (e) => {
    if (phase !== "playing") return;
    const k = keyMap[e.key];
    if (!k) return;
    e.preventDefault();
    if (!keys[k]) {
      keys[k] = true;
      // Set wantsJump on rising edge of Up — recorded into history and consumed by stepPred.
      if (k === "up" && pred !== null) pred.wantsJump = true;
    }
  });

  window.addEventListener("keyup", (e) => {
    const k = keyMap[e.key];
    if (!k) return;
    e.preventDefault();
    keys[k] = false;
  });

  window.addEventListener("blur", () => {
    let changed = false;
    for (const k of Object.keys(keys)) {
      if (keys[k]) { keys[k] = false; changed = true; }
    }
    // rAF (and with it the per-tick send) pauses in hidden tabs — push the stop
    // immediately so the player doesn't run off. Reuses the current seq: no
    // history entry corresponds to this send.
    if (changed) sendInput(inputSeq, false);
  });

  // --- Render ---
  function blockColor(id) {
    if (id >= 0 && id < blockTypes.length) return blockTypes[id].color;
    return "#2a2a2a";
  }

  function buildSolidGrid() {
    solidGrid = [];
    for (let r = 0; r < tileMap.rows; r++) {
      solidGrid[r] = [];
      for (let c = 0; c < tileMap.cols; c++) {
        const id = tileMap.tiles[r][c];
        solidGrid[r][c] = id >= 0 && id < blockTypes.length && blockTypes[id].solid;
      }
    }
  }

  function isSolidPred(px, py) {
    if (!solidGrid) return false;
    const colMin = Math.floor(px / tileSize);
    const colMax = Math.floor((px + playerSize - 1) / tileSize);
    const rowMin = Math.floor(py / tileSize);
    const rowMax = Math.floor((py + playerSize - 1) / tileSize);
    for (let r = rowMin; r <= rowMax; r++) {
      for (let c = colMin; c <= colMax; c++) {
        if (r >= 0 && r < solidGrid.length && c >= 0 && c < solidGrid[r].length && solidGrid[r][c]) return true;
      }
    }
    return false;
  }

  function clampPred(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // Advance prediction state by one tick — mirrors server Player.Step() exactly.
  function stepPred(s, inp) {
    let { x, y, velY, onGround, wantsJump } = s;

    // Horizontal
    let dx = 0;
    if (inp.left) dx -= PLAYER_SPEED;
    if (inp.right) dx += PLAYER_SPEED;
    x += dx;
    x = clampPred(x, 0, WORLD_W - playerSize);
    if (isSolidPred(x, y)) { x -= dx; x = clampPred(x, 0, WORLD_W - playerSize); }

    // Jump: only fires if on ground this tick; no buffering.
    if (wantsJump && onGround) { velY = -JUMP_VEL; onGround = false; }
    wantsJump = false;

    // Gravity
    velY = Math.min(velY + GRAVITY, MAX_FALL);
    y += velY;
    y = clampPred(y, 0, WORLD_H - playerSize);

    if (isSolidPred(x, y)) {
      if (velY > 0) {
        y = Math.floor((y + playerSize) / tileSize) * tileSize - playerSize;
      } else {
        y = Math.ceil(y / tileSize) * tileSize;
      }
      velY = 0;
    }
    // Ground probe: check 2px below so onGround stays true across the small gravity oscillation.
    onGround = isSolidPred(x, y + 2);

    return { x, y, velY, onGround, wantsJump };
  }

  function buildTileCache() {
    const oc = new OffscreenCanvas(canvas.width, canvas.height);
    const octx = oc.getContext('2d');
    octx.fillStyle = blockColor(0);
    octx.fillRect(0, 0, canvas.width, canvas.height);
    for (let r = 0; r < tileMap.rows; r++) {
      for (let c = 0; c < tileMap.cols; c++) {
        const id = tileMap.tiles[r][c];
        if (id === 0) continue;
        octx.fillStyle = blockColor(id);
        octx.fillRect(c * tileSize, r * tileSize, tileSize, tileSize);
      }
    }
    tileCache = oc;
  }

  function drawTiles() {
    if (tileCache) ctx.drawImage(tileCache, 0, 0);
  }

  // Advance the remote-player playback clock by real time, gently steered toward
  // (latest server tick − delay). Bursty snapshot arrival moves the target in jumps,
  // but renderTick itself always moves smoothly.
  function advanceRenderTick(dtMs) {
    if (snapBuf.length === 0) return;
    const latestTick = snapBuf[snapBuf.length - 1].tick;
    const target = latestTick - INTERP_DELAY_TICKS;
    renderTick += dtMs / TICK_MS;
    if (Math.abs(renderTick - target) > INTERP_DELAY_TICKS) {
      renderTick = target; // way off (join, long stall) — resync hard
    } else {
      renderTick += (target - renderTick) * 0.05; // drift correction
    }
    if (renderTick > latestTick) renderTick = latestTick; // never extrapolate
  }

  function getInterpolatedPlayers() {
    if (snapBuf.length === 0) return players;
    // Find the pair of snapshots straddling renderTick (buffer is tick-ordered).
    let a = snapBuf[0];
    let b = snapBuf[snapBuf.length - 1];
    for (let i = snapBuf.length - 1; i >= 0; i--) {
      if (snapBuf[i].tick <= renderTick) {
        a = snapBuf[i];
        b = snapBuf[i + 1] || a;
        break;
      }
    }
    const span = b.tick - a.tick;
    const t = span > 0 ? Math.min(Math.max((renderTick - a.tick) / span, 0), 1) : 1;
    return b.players.map(curr => {
      const prev = a.players.find(p => p.id === curr.id);
      if (!prev) return curr;
      return { ...curr, x: prev.x + (curr.x - prev.x) * t, y: prev.y + (curr.y - prev.y) * t };
    });
  }

  function drawArrow(px, py) {
    const cx = px + playerSize / 2;
    const top = py - 16;
    ctx.beginPath();
    ctx.moveTo(cx, py - 4);
    ctx.lineTo(cx - 7, top);
    ctx.lineTo(cx + 7, top);
    ctx.closePath();
    ctx.fillStyle = "#fff";
    ctx.fill();
  }

  function draw(ts) {
    const dtMs = lastFrameTs > 0 ? Math.min(ts - lastFrameTs, 250) : 0;
    lastFrameTs = ts;

    // Advance local prediction at 30 Hz, sending this tick's input with a matching seq.
    if (pred !== null && phase === "playing") {
      // After a long stall (hidden tab) don't fast-forward — resync and continue.
      if (ts - lastPredTick > TICK_MS * 10) lastPredTick = ts - TICK_MS;
      while (ts - lastPredTick >= TICK_MS) {
        inputSeq++;
        sendInput(inputSeq, pred.wantsJump);
        // Record this tick in history (pre-step state) for rollback reconciliation.
        predHistory.push({ seq: inputSeq, keys: { ...keys }, wantsJump: pred.wantsJump });
        if (predHistory.length > 120) predHistory.shift(); // keep ~4s
        predPrev = { ...pred };
        pred = stepPred(pred, keys);
        lastPredTick += TICK_MS;
      }
    }

    advanceRenderTick(dtMs);

    // Decay the reconciliation-correction offset (~90% per 60fps frame → gone in ~250ms).
    if (corrX !== 0 || corrY !== 0) {
      const decay = Math.pow(0.9, dtMs / 16.7);
      corrX *= decay;
      corrY *= decay;
      if (Math.abs(corrX) < 0.3) corrX = 0;
      if (Math.abs(corrY) < 0.3) corrY = 0;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawTiles();

    // Intra-tick lerp factor for local player — mirrors getInterpolatedPlayers() for smoothness.
    const predT = (pred !== null && predPrev !== null)
      ? Math.min((ts - lastPredTick) / TICK_MS, 1)
      : 1;

    for (const p of getInterpolatedPlayers()) {
      const isMe = p.id === myId;
      let rx, ry;
      if (isMe && pred !== null && predPrev !== null) {
        rx = predPrev.x + (pred.x - predPrev.x) * predT + corrX;
        ry = predPrev.y + (pred.y - predPrev.y) * predT + corrY;
      } else {
        rx = p.x;
        ry = p.y;
      }
      ctx.fillStyle = p.color;
      ctx.fillRect(rx, ry, playerSize, playerSize);
      if (isMe) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ffffff";
        ctx.strokeRect(rx + 0.5, ry + 0.5, playerSize - 1, playerSize - 1);
      }
      if (p.id === taggedId && phase === "playing") {
        drawArrow(rx, ry);
      }
    }

    if (phase === "playing" && rtt >= 0) {
      ctx.fillStyle = rtt > 200 ? "#e74c3c" : "#7f8c8d";
      ctx.font = "12px monospace";
      ctx.textAlign = "left";
      ctx.fillText(Math.round(rtt) + "ms", 6, 14);
    }

    requestAnimationFrame(draw);
  }

  requestAnimationFrame(draw);
})();
