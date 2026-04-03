# Rust/WASM Bot

This folder contains the primary Rust/WebAssembly bot engine used by the browser app.

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

## Notes

- The frontend now runs this WASM engine only.
