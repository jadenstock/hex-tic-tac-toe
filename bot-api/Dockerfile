FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/bot/engine.ts ./src/bot/engine.ts
COPY bot-api/server.ts ./bot-api/server.ts

ENV PORT=8080
EXPOSE 8080

CMD ["node", "--experimental-strip-types", "bot-api/server.ts"]
