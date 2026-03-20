# Hexagonal Tic-Tac-Toe (Prototype)

Local prototype for a hex-grid tic-tac-toe variant.

## Rules currently implemented

- Board is effectively unbounded (you can pan forever).
- `X` places **1** mark on the opening turn.
- After that, each turn is **2 placements** for the active player.
- First player to make **6 in a row** wins.
- Plan mode is available for hypothetical moves (separate from live game state).

## Controls

- Drag board: pan horizontally/vertically
- Mouse wheel / trackpad scroll: zoom in/out
- Click a hex: place on current layer
- `Live mode`: real game moves
- `Plan mode`: analysis moves (does not change live moves)

## Run locally (WSL)

```bash
npm install
npm run dev
```

Then open the local URL shown by Vite (usually `http://localhost:5173`).

## Build

```bash
npm run build
```
