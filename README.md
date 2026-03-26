# Hexagonal Tic-Tac-Toe

Prototype web app for hex-grid tic-tac-toe, including a minimal AWS multiplayer backend.

## Features

- Infinite-feel hex board with pan + zoom
- Live mode rules:
  - Opening turn: `X` places 1
  - Then alternating turns of 2 placements each (`O:2`, `X:2`, ...)
  - Win at 6 in a row
- Plan mode with separate colors and free placement
- Multiplayer room sync over WebSocket:
  - Share one link
  - Host creates a short game code (up to 5 letters/numbers)
  - Friend joins using that code
  - Moves sync live through AWS

## Local frontend run

```bash
npm install
npm run dev
```

If using multiplayer locally, create `.env` from `.env.example` and set `VITE_WS_URL`.

## AWS stack (minimal prototype)

Infra lives in `infra/`.

Resources created:

- `S3 + CloudFront` for frontend hosting
- `API Gateway WebSocket API` (`create`, `join`, `place`, `sync` routes)
- `Lambda` handlers (`connect`, `disconnect`, `message`)
- `DynamoDB` tables for rooms and connections

### Deploy

1. Build frontend assets:

```bash
npm run build
```

2. Bootstrap account once per region (if not already done):

```bash
cd infra
npm install
npx cdk bootstrap
```

3. Deploy stack:

```bash
npm run deploy
```

4. Copy outputs:

- `SiteUrl` -> share this with friends
- `WebSocketUrl` -> put into frontend `.env` as `VITE_WS_URL`

5. Rebuild and redeploy frontend after setting websocket URL:

```bash
cd ..
cp .env.example .env
# edit .env with real WebSocketUrl
npm run build
cd infra
npm run deploy
```

## Useful root scripts

- `npm run infra:install`
- `npm run infra:build`
- `npm run infra:synth`
- `npm run infra:deploy`
- `npm run bot:api`

## Stateless bot API (for external bot platforms)

This repo includes a stateless HTTP bot adapter at `bot-api/server.ts`.

- Endpoint: `POST /v1-alpha/turn`
- Health: `GET /healthz`
- Local run: `npm run bot:api`
- Dockerfile: `bot-api/Dockerfile`

See `bot-api/README.md` for request/response examples.

## Notes

- For this prototype, game codes are 5-char uppercase alphanumeric values generated server-side.
- No user identity/auth ownership yet; any joined client can place `X` or `O`.
- This is intentionally minimal and optimized for quick iteration.
