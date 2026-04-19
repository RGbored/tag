package main

import (
	"encoding/json"
	"math"
	"os"
)

const (
	MaxPlayers  = 4
	TileSize    = 30
	GridCols    = 26
	GridRows    = 20
	WorldWidth  = GridCols * TileSize // 780
	WorldHeight = GridRows * TileSize // 600
	PlayerSize  = 30
	PlayerSpeed  = 7   // pixels per tick (horizontal)
	TickRate     = 30
	Gravity      = 0.7 // px/tick²
	JumpVelocity = 12.0 // px/tick upward
	MaxFallSpeed = 16.0 // terminal velocity
)

// Colors assigned by slot index.
var Colors = []string{
	"#e74c3c", // red
	"#3498db", // blue
	"#2ecc71", // green
	"#f1c40f", // yellow
}

// Spawn positions per slot (pixels). Placed inset from corners on empty tiles.
var SpawnPositions = [][2]float64{
	{TileSize + 5, TileSize + 5},
	{WorldWidth - PlayerSize - TileSize - 5, TileSize + 5},
	{TileSize + 5, WorldHeight - PlayerSize - TileSize - 5},
	{WorldWidth - PlayerSize - TileSize - 5, WorldHeight - PlayerSize - TileSize - 5},
}

// --- Block types ---

type BlockType struct {
	ID    int    `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
	Solid bool   `json:"solid"`
}

var BlockTypes = []BlockType{
	{0, "Empty", "#2a2a2a", false},
	{1, "Wall", "#555555", true},
	{2, "Spike", "#c0392b", false},
	{3, "Ice", "#85c1e9", false},
}

// --- Game map ---

type GameMap struct {
	Cols  int     `json:"cols"`
	Rows  int     `json:"rows"`
	Tiles [][]int `json:"tiles"`
}

func LoadMap(path string) (*GameMap, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var m GameMap
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// tileAt returns the block ID at grid position (col, row), or 0 if out of bounds.
func (m *GameMap) tileAt(col, row int) int {
	if row < 0 || row >= m.Rows || col < 0 || col >= m.Cols {
		return 0
	}
	return m.Tiles[row][col]
}

// IsSolid reports whether a player-sized rectangle at pixel position (px, py)
// overlaps any solid tile.
func (m *GameMap) IsSolid(px, py float64) bool {
	colMin := int(math.Floor(px / TileSize))
	colMax := int(math.Floor((px + PlayerSize - 1) / TileSize))
	rowMin := int(math.Floor(py / TileSize))
	rowMax := int(math.Floor((py + PlayerSize - 1) / TileSize))

	for r := rowMin; r <= rowMax; r++ {
		for c := colMin; c <= colMax; c++ {
			id := m.tileAt(c, r)
			if id >= 0 && id < len(BlockTypes) && BlockTypes[id].Solid {
				return true
			}
		}
	}
	return false
}

// --- Input / Player ---

type InputState struct {
	Up    bool `json:"up"`
	Down  bool `json:"down"`
	Left  bool `json:"left"`
	Right bool `json:"right"`
}

type Player struct {
	ID         int     `json:"id"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	Color      string  `json:"color"`
	Name       string  `json:"name"`
	VelY       float64 `json:"velY"`
	OnGround   bool    `json:"onGround"`
	WantsJump  bool    `json:"-"` // set on rising edge of Up, cleared each tick
	Input      InputState
}

// Step advances the player one tick with gravity-based platformer physics.
// Horizontal movement is immediate; vertical movement uses velocity + gravity.
// Up/W = jump (when on ground), Left/Right/A/D = move.
func (p *Player) Step(m *GameMap) {
	// --- Horizontal ---
	dx := 0.0
	if p.Input.Left {
		dx -= PlayerSpeed
	}
	if p.Input.Right {
		dx += PlayerSpeed
	}
	p.X += dx
	p.clamp()
	if m != nil && m.IsSolid(p.X, p.Y) {
		p.X -= dx
		p.clamp()
	}

	// --- Jump: only fires if on ground this tick; no buffering ---
	if p.WantsJump && p.OnGround {
		p.VelY = -JumpVelocity
		p.OnGround = false
	}
	p.WantsJump = false

	// --- Gravity ---
	p.VelY += Gravity
	if p.VelY > MaxFallSpeed {
		p.VelY = MaxFallSpeed
	}

	p.Y += p.VelY
	p.clamp()

	if m != nil && m.IsSolid(p.X, p.Y) {
		if p.VelY > 0 {
			// Falling — snap bottom of player to top of the solid tile row.
			p.Y = math.Floor((p.Y+PlayerSize)/TileSize)*TileSize - PlayerSize
		} else {
			// Rising — snap top of player to bottom of the ceiling tile row.
			p.Y = math.Ceil(p.Y/TileSize) * TileSize
		}
		p.VelY = 0
	}
	// Ground probe: check 2px below so onGround stays true across the small gravity oscillation.
	p.OnGround = m != nil && m.IsSolid(p.X, p.Y+2)
}

// PlayersOverlap reports whether two player rectangles overlap (AABB).
func PlayersOverlap(a, b *Player) bool {
	return a.X < b.X+PlayerSize && a.X+PlayerSize > b.X &&
		a.Y < b.Y+PlayerSize && a.Y+PlayerSize > b.Y
}

func (p *Player) clamp() {
	if p.X < 0 {
		p.X = 0
	}
	if p.Y < 0 {
		p.Y = 0
	}
	if p.X > WorldWidth-PlayerSize {
		p.X = WorldWidth - PlayerSize
	}
	if p.Y > WorldHeight-PlayerSize {
		p.Y = WorldHeight - PlayerSize
	}
}
