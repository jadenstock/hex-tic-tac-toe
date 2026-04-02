# Rust/WASM Bot (Preview)

This folder contains an additive Rust/WebAssembly bot backend for the browser.

## Prerequisites

1. Install Rust toolchain (`rustup`).
2. Install `wasm-pack`:

```bash
cargo install wasm-pack
```

## Build for the frontend

From repo root:

```bash
npm run bot:wasm:build
```

That command writes the generated glue + wasm binary to:

- `public/wasm-bot/hex_ttt_wasm.js`
- `public/wasm-bot/hex_ttt_wasm_bg.wasm`

## Runtime selection

In the app, open the **Bot** panel and switch backend to **Rust WASM (preview)**.

The app will automatically fall back to the TypeScript bot if the WASM runtime
is unavailable or fails to load.

## Notes

- Current Rust bot is a first-pass deterministic engine.
- It is integrated as additive infrastructure so we can iterate toward parity
  with the current TypeScript bot before making it the default.
