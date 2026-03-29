# Hexo Archive Export Research

## Goal

Build a reusable dataset of finished Hexo games with enough metadata to filter by quality before downloading full move histories at scale.

For the downstream dataset, the fields that matter most are:

- winner
- full move history
- player Elo
- move count

Later we can derive narrower training slices such as openings, middlegames, and endgames from the same source data.

## What The Site Exposes

The public site at `https://hexo.did.science/games` server-renders its archive data into HTML. The replay pages do the same for full move histories.

Observed on 2026-03-29:

- archive page exposes `totalGames = 50231`
- archive page exposes `totalMoves = 2205012`
- archive page exposes `totalPages = 2512`
- archive page exposes `pageSize = 20`
- replay page exposes full move list, players, Elo, result, timestamps, and time control

The archive has two practical access paths:

- HTML pages:
  - `GET /games` returns page 1 plus a `baseTimestamp`
  - `GET /games?page=N&at=<baseTimestamp>` server-renders some archive pages
- API pages used by the frontend:
  - `GET /api/finished-games?page=N&pageSize=S`
  - `GET /api/finished-games?page=N&pageSize=S&baseTimestamp=<baseTimestamp>`

In practice, the API path is the correct Stage 1 source because server-side embedding stops on deeper archive pages, while the frontend continues by calling `/api/finished-games`.

## Practicality

Bulk metadata export is easy.

- Stage 1 metadata crawl:
  - about `2512` requests with HTML page size `20`
  - about `503` requests with API page size `100`
- Stage 2 full replay crawl: about `50231` requests if we later fetch every replay

Stage 1 is low-risk and relatively cheap. It gives enough data to choose a subset instead of downloading every replay immediately.

## Load / Etiquette

`robots.txt` allows `/` and disallows `/api/`.

Operationally, the frontend itself relies on `/api/finished-games` for deeper archive pages, and the JSON endpoint is substantially lighter than the HTML path. If we use it, we should keep request volume low and treat it as an internal research crawl rather than a high-throughput scraper.

Recommended collection behavior:

- keep concurrency low
- include retry and resume support
- avoid re-fetching pages already stored locally
- fetch archive metadata first, then decide replay scope

For the replay stage, a slow sustained rate is preferable to high parallelism.

## Data We Can Get In Stage 1

From archive pages alone we get, per finished game:

- game id
- session id
- started / finished timestamps
- winner id
- result reason
- move count
- visibility
- rated flag
- time control
- both player display names
- both player post-game Elo values
- both player Elo deltas

From those fields we can derive:

- pre-game Elo when `eloChange` is present
- guest vs registered-player heuristics
- rating bands
- short / medium / long game buckets

## Filtering Strategy

Do not filter during Stage 1.

Stage 1 should capture all archive metadata because:

- the crawl is cheap
- it preserves optionality
- it lets us tune thresholds from real distributions instead of guessing

For replay download later, likely filters are:

- exclude `visibility = private`
- exclude very short games
- prefer `rated = true`
- require a minimum derived pre-game Elo threshold

Good first-pass candidate filters to compare after Stage 1:

- `moveCount >= 20`
- `moveCount >= 25`
- `rated = true`
- `minKnownPreGameElo >= 900`
- `minKnownPreGameElo >= 1000`
- `maxKnownPreGameElo >= 1100`

The best threshold should be chosen after seeing how many games survive each cut.

## Privacy Note

The archive currently includes games marked `visibility = private`, and those replay pages were still publicly retrievable when sampled.

For dataset construction, the safer default is:

- capture private-game metadata in Stage 1 so we can measure prevalence
- exclude private games from later replay export unless there is a strong reason to include them

## Recommended Workflow

1. Run Stage 1 archive metadata crawl.
2. Inspect the resulting summary statistics.
3. Choose replay filters using real counts.
4. Run Stage 2 replay download only for the chosen subset.
5. Convert replay rows into training-oriented slices later.

## Outputs Added In This Change

- `planning/hexo-archive-research.md`
- `scripts/hexo-archive/fetch-archive-metadata.ts`
- `datasets/hexo-archive/README.md`

Stage 1 output layout:

- raw per-page archive payloads
- normalized game metadata JSONL
- crawl manifest
- summary stats for subset selection
