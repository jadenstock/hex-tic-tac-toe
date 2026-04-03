# Stateless Bot API Adapter

HTTP wrapper around the existing in-repo bot engine, compatible with `htttx-bot-api` stateless `v1-alpha`.

## Run locally

```bash
npm install
npm run bot:api
```

Server listens on `PORT` (default `8080`).

Health check:

```bash
curl -sS http://localhost:8080/healthz
```

Capabilities:

```bash
curl -sS http://localhost:8080/v1/capabilities.json
```

Main move endpoint (from capabilities `api_root`):

```bash
curl -sS -X POST http://localhost:8080/v1/stateless/v1-alpha/turn \
  -H 'content-type: application/json' \
  -d '{"board":{"to_move":"x","cells":[]}}'
```

Backward-compatible alias is also available:

`POST /v1-alpha/turn`

## Request example

```bash
curl -sS -X POST http://localhost:8080/v1/stateless/v1-alpha/turn \
  -H 'content-type: application/json' \
  -d '{
    "board": {
      "to_move": "x",
      "cells": [
        {"q":0,"r":0,"p":"x"},
        {"q":1,"r":0,"p":"o"},
        {"q":0,"r":1,"p":"o"}
      ]
    },
    "time_limit": 1.5
  }'
```

Example response shape:

```json
{
  "move": {
    "pieces": [{"q": -1, "r": 0}, {"q": 0, "r": -1}],
    "evaluation": {
      "heuristic": 0.42,
      "win_in": 1
    }
  }
}
```

## Docker

```bash
docker build -f bot-api/Dockerfile -t hex-ttt-bot-api .
docker run --rm -p 8080:8080 hex-ttt-bot-api
```

## Notes

- Rules assumed by adapter match this repo:
  - Opening turn is one placement for `x`.
  - Subsequent turns alternate in two placements.
- If `board.to_move` does not match the move count under those rules, the API returns `400`.
