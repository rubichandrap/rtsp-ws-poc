# RTSP → WebSocket fMP4 gateway

This repository implements a small proof-of-concept gateway that converts RTSP camera streams to fragmented MP4 (fMP4) using FFmpeg, then serves the init segment and fMP4 chunks to browsers over Socket.IO (WebSocket) so they can be played with the MediaSource Extensions (MSE).

---

## Quick Start

Prereqs: Node 18+, pnpm/npm, optionally FFmpeg (the project will fall back to `ffmpeg-static` or system `ffmpeg`).

1. Install dependencies: `npm install`
2. Start dev servers (runs server + client): `npm run dev`
   - Server only: `npm run dev:server` (runs `tsx server/index.ts` directly)
   - Client only: `npm run dev:client` (Vite)
3. Start a test stream (example):
   ```bash
   curl -X POST http://localhost:3001/api/stream/start \
     -H "Content-Type: application/json" \
     -d '{"rtspUrl":"rtsp://<CAMERA>/path"}'
   ```
   The endpoint returns `{ sessionId }` which you can use in the UI to watch the stream.

Stop a session:
```
POST /api/stream/stop/:sessionId
```

---

## Where to look for problems / debugging tips

- FFmpeg selection: the server prefers a binary at `server/bin/ffmpeg` (useful for testing platform-specific builds). Next it will use `ffmpeg-static` if available, otherwise falls back to system `ffmpeg` on PATH. See `server/rtsp-service.ts` for the exact logic and clear spawn error messages.
- Init segment: the server buffers until it detects `ftyp`/`moov`/`moof` in stdout and writes the init to `server/tmp/init-<sessionId>.mp4` for inspection. Look at console logs for `Init segment detected` or warning about promoting buffered data.
- Socket events: `stream:init`, `stream:data`, `stream:ready`, `stream:end`, `stream:error` — check `server/index.ts` and `src/components/VideoPlayer.tsx` for how they're emitted/handled.

---

## Key files

- `server/index.ts` — Express + Socket.IO entrypoint and REST API.
- `server/rtsp-service.ts` — spawns FFmpeg, buffers init segment, and exposes session/stream APIs.
- `src/components/VideoPlayer.tsx` — client MSE & SourceBuffer management.
- `src/services/socket.ts` — client Socket.IO initialization.

---

## Developer notes

- Typecheck: `npm run typecheck`
- Lint: `npm run lint`
- Build client for production: `npm run build`

For more guidance aimed at AI coding agents or contributors, see `.github/copilot-instructions.md` which documents architecture, common pitfalls, and recommended low-risk changes.