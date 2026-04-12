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
          if (msg.map) tileMap = msg.map;
          if (msg.blockTypes) blockTypes = msg.blockTypes;
          if (msg.roomName) lobbyTitleEl.textContent = msg.roomName;
          break;

        case "state":
          players = msg.players || [];
          phase = msg.phase || "lobby";
          taggedId = msg.taggedId ?? -1;
          timeLeft = msg.timeLeft ?? 0;
          loserId = msg.loserId ?? -1;
          updateUI();
          break;

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

  function drawTiles() {
    if (!tileMap) return;
    for (let r = 0; r < tileMap.rows; r++) {
      for (let c = 0; c < tileMap.cols; c++) {
        const id = tileMap.tiles[r][c];
        if (id === 0) continue;
        ctx.fillStyle = blockColor(id);
        ctx.fillRect(c * tileSize, r * tileSize, tileSize, tileSize);
      }
    }
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

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawTiles();
    for (const p of players) {
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, playerSize, playerSize);
      if (p.id === myId) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ffffff";
        ctx.strokeRect(p.x + 0.5, p.y + 0.5, playerSize - 1, playerSize - 1);
      }
      if (p.id === taggedId && phase === "playing") {
        drawArrow(p.x, p.y);
      }
    }
    requestAnimationFrame(draw);
  }

  requestAnimationFrame(draw);
})();
