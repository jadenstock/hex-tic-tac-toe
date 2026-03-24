# Bot Optimizer (Local-only)

This workspace is for offline bot-vs-bot tuning only.

- No AWS usage.
- No UI wiring during optimization runs.
- All run data lives in `.bot-opt/` (gitignored).

## Core commands

Run a tournament using JSON configs:

```bash
npm run bot:opt
```

Generate additional challenger configs:

```bash
npm run bot:opt:gen -- --count 12 --seed 123
```

Promote current top result into UI default config (`DEFAULT_BOT_TUNING`):

```bash
npm run bot:opt:promote
```

## Data layout

- `.bot-opt/population/*.json`: bot configs (editable)
- `.bot-opt/runs/latest.json`: latest leaderboard + exact decoded tunings
- `.bot-opt/optimization-log.md`: appended qualitative run notes
- `.bot-opt/research.md`: ongoing bot catalog + hypothesis backlog

On first run, if population is empty, seed configs are auto-created.

## Config format

Each config can use normalized multipliers (recommended) and/or raw overrides.

```json
{
  "id": "pressure-builder",
  "name": "Pressure Builder",
  "notes": "Leans into fork pressure.",
  "normalized": {
    "threatWeightsMul": [1, 1, 1, 1.12, 1.18, 1.12, 1],
    "threatBreadthWeightsMul": [1, 1, 1, 1.2, 1.3, 1.3, 1],
    "defenseWeight": 0.45,
    "candidateRadius": 5,
    "topKFirstMoves": 8
  },
  "rawTuning": {
    "oneTurnForkBonus": 27000
  }
}
```

Normalized fields are scaled relative to `DEFAULT_BOT_TUNING`, which makes coefficients easier to reason about than raw large scalars.

## Compute controls

- Hard cap search parameters at runtime:
  - `--hard-radius-cap` (default `6`)
  - `--hard-topk-cap` (default `12`)
- Optional ranking penalty for slow decision time:
  - `--compute-penalty-per-ms`

Example:

```bash
npm run bot:opt -- --compute-penalty-per-ms 0.05 --hard-radius-cap 5 --hard-topk-cap 10
```
