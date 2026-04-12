(() => {
  const TILE = 30;
  const COLS = 26;
  const ROWS = 20;

  const BLOCK_TYPES = [
    { id: 0, name: "Empty",  color: "#2a2a2a", solid: false },
    { id: 1, name: "Wall",   color: "#555555", solid: true  },
    { id: 2, name: "Spike",  color: "#c0392b", solid: false },
    { id: 3, name: "Ice",    color: "#85c1e9", solid: false },
  ];

  const canvas = document.getElementById("editor");
  const ctx = canvas.getContext("2d");
  const statusEl = document.getElementById("status");
  const serverMapsEl = document.getElementById("server-maps");
  const mapNameEl = document.getElementById("map-name");

  const host = location.host || "localhost:8080";
  const base = `${location.protocol || "http:"}//${host}`;

  // --- Server map list ---
  async function refreshMapList() {
    try {
      const res = await fetch(`${base}/api/maps`);
      const names = await res.json();
      serverMapsEl.innerHTML = "";
      for (const name of names) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        serverMapsEl.appendChild(opt);
      }
    } catch {
      serverMapsEl.innerHTML = "<option>--</option>";
    }
  }
  refreshMapList();

  document.getElementById("btn-server-load").addEventListener("click", async () => {
    const name = serverMapsEl.value;
    if (!name) return;
    try {
      const res = await fetch(`${base}/api/maps/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (!data.tiles || !Array.isArray(data.tiles)) throw new Error("missing tiles");
      tiles = data.tiles;
      mapNameEl.value = name;
      render();
      statusEl.textContent = `opened "${name}" from server`;
    } catch (err) {
      statusEl.textContent = "load failed: " + err.message;
    }
  });

  // Initialize empty map.
  let tiles = [];
  for (let r = 0; r < ROWS; r++) {
    tiles.push(new Array(COLS).fill(0));
  }

  let selectedBlock = 1; // default to Wall
  let painting = false;
  let erasing = false;

  // --- Palette ---
  const paletteEl = document.getElementById("palette");
  BLOCK_TYPES.forEach((bt) => {
    const btn = document.createElement("button");
    btn.className = "palette-btn" + (bt.id === selectedBlock ? " active" : "");
    btn.innerHTML = `<span class="palette-swatch" style="background:${bt.color}"></span>${bt.name}`;
    btn.addEventListener("click", () => {
      selectedBlock = bt.id;
      document.querySelectorAll(".palette-btn").forEach((b, i) => {
        b.classList.toggle("active", i === bt.id);
      });
    });
    paletteEl.appendChild(btn);
  });

  // --- Drawing ---
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const id = tiles[r][c];
        ctx.fillStyle = BLOCK_TYPES[id] ? BLOCK_TYPES[id].color : "#2a2a2a";
        ctx.fillRect(c * TILE, r * TILE, TILE, TILE);
      }
    }
    // Grid lines.
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 0.5;
    for (let c = 0; c <= COLS; c++) {
      ctx.beginPath();
      ctx.moveTo(c * TILE + 0.5, 0);
      ctx.lineTo(c * TILE + 0.5, ROWS * TILE);
      ctx.stroke();
    }
    for (let r = 0; r <= ROWS; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * TILE + 0.5);
      ctx.lineTo(COLS * TILE, r * TILE + 0.5);
      ctx.stroke();
    }
  }

  function paint(e) {
    const rect = canvas.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / TILE);
    const row = Math.floor((e.clientY - rect.top) / TILE);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;
    tiles[row][col] = erasing ? 0 : selectedBlock;
    render();
  }

  canvas.addEventListener("mousedown", (e) => {
    e.preventDefault();
    erasing = e.button === 2;
    painting = true;
    paint(e);
  });
  canvas.addEventListener("mousemove", (e) => {
    if (painting) paint(e);
  });
  window.addEventListener("mouseup", () => {
    painting = false;
    erasing = false;
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // --- Save / Load ---
  function mapJSON() {
    return JSON.stringify({ cols: COLS, rows: ROWS, tiles }, null, 2);
  }

  document.getElementById("btn-save").addEventListener("click", async () => {
    const name = mapNameEl.value.trim();
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      statusEl.textContent = "invalid map name (letters, numbers, - and _ only)";
      return;
    }
    try {
      const res = await fetch(`${base}/api/maps/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: mapJSON(),
      });
      if (!res.ok) throw new Error(await res.text());
      statusEl.textContent = `saved "${name}" to server`;
      refreshMapList();
    } catch (err) {
      statusEl.textContent = "save failed: " + err.message;
    }
  });

  document.getElementById("btn-download").addEventListener("click", () => {
    const name = mapNameEl.value.trim() || "map";
    const blob = new Blob([mapJSON()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    statusEl.textContent = `downloaded ${name}.json`;
  });

  const fileInput = document.querySelector("#btn-load input");
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.tiles || !Array.isArray(data.tiles)) throw new Error("missing tiles");
        tiles = data.tiles;
        render();
        statusEl.textContent = "loaded " + file.name;
      } catch (err) {
        statusEl.textContent = "load failed: " + err.message;
      }
    };
    reader.readAsText(file);
    fileInput.value = "";
  });

  document.getElementById("btn-clear").addEventListener("click", () => {
    for (let r = 0; r < ROWS; r++) {
      tiles[r].fill(0);
    }
    render();
    statusEl.textContent = "cleared";
  });

  // Initial render.
  render();
})();
