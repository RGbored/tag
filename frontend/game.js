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

  // Snapshot interpolation — keep last two server snapshots, lerp between them each frame.
  let prevSnapshot = null;
  let currSnapshot = null;
  const TICK_MS = 1000 / 30;

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
  let pred = null;       // { x, y, velY, onGround, wantsJump } — local player only
  let predPrev = null;   // pred at start of current tick, for intra-tick lerp
  let solidGrid = null;  // boolean[row][col] built from tile map
  let lastPredTick = 0;  // rAF timestamp of last physics step

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
          prevSnapshot = currSnapshot;
          currSnapshot = { players: newPlayers, time: performance.now() };
          players = newPlayers;

          // Initialise prediction when entering playing phase.
          if (newPhase === "playing" && phase !== "playing") {
            const me = newPlayers.find(p => p.id === myId);
            if (me) {
              pred = { x: me.x, y: me.y, velY: me.velY ?? 0, onGround: me.onGround ?? false, wantsJump: false };
              predPrev = { ...pred };
              lastPredTick = performance.now();
            }
          }
          // Clear prediction when leaving playing phase.
          if (newPhase !== "playing") { pred = null; predPrev = null; }

          // Soft correction: gently blend pred toward server's authoritative position.
          // For local play the delta is <1px; for network play it smooths out without snapping.
          if (newPhase === "playing" && pred !== null) {
            const me = newPlayers.find(p => p.id === myId);
            if (me) {
              const dx = me.x - pred.x;
              const dy = me.y - pred.y;
              if (Math.hypot(dx, dy) > 120) {
                // Large gap (e.g. spawn): snap immediately.
                pred.x = me.x; pred.y = me.y;
                pred.velY = me.velY ?? 0;
                pred.onGround = me.onGround ?? false;
                predPrev = { ...pred };
              } else {
                // Small drift: nudge 25% toward server each tick.
                pred.x += dx * 0.25;
                pred.y += dy * 0.25;
                pred.velY = me.velY ?? pred.velY;
                pred.onGround = me.onGround ?? pred.onGround;
              }
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
  function sendInput() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "input", ...keys }));
  }

  window.addEventListener("keydown", (e) => {
    if (phase !== "playing") return;
    const k = keyMap[e.key];
    if (!k) return;
    e.preventDefault();
    if (!keys[k]) {
      keys[k] = true;
      // Set wantsJump directly on rising edge of Up — consumed by stepPred when on ground.
      if (k === "up" && pred !== null) pred.wantsJump = true;
      sendInput();
    }
  });

  window.addEventListener("keyup", (e) => {
    const k = keyMap[e.key];
    if (!k) return;
    e.preventDefault();
    if (keys[k]) {
      keys[k] = false;
      sendInput();
    }
  });

  window.addEventListener("blur", () => {
    let changed = false;
    for (const k of Object.keys(keys)) {
      if (keys[k]) { keys[k] = false; changed = true; }
    }
    if (changed) sendInput();
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

  function getInterpolatedPlayers() {
    if (!prevSnapshot || !currSnapshot) return players;
    const t = Math.min((performance.now() - currSnapshot.time) / TICK_MS, 1);
    return currSnapshot.players.map(curr => {
      const prev = prevSnapshot.players.find(p => p.id === curr.id);
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
    // Advance local prediction at 30 Hz — one step per tick, same rate as server.
    if (pred !== null && phase === "playing" && ts - lastPredTick >= TICK_MS) {
      predPrev = { ...pred };
      pred = stepPred(pred, keys);
      lastPredTick += TICK_MS;
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
        rx = predPrev.x + (pred.x - predPrev.x) * predT;
        ry = predPrev.y + (pred.y - predPrev.y) * predT;
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
    requestAnimationFrame(draw);
  }

  requestAnimationFrame(draw);
})();
