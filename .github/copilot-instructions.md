# Copilot / Agent Instructions for rtsp-ws-poc

Short, actionable notes to help an AI coding agent be immediately productive in this repo.

## Quick summary (big picture) ✅
- Purpose: a gateway that converts RTSP camera streams to fragmented MP4 (fMP4) and serves them to browsers over WebSocket (Socket.IO) for playback via MediaSource Extensions (MSE).
- Architecture: server (Node + TS) runs FFmpeg to read RTSP -> stdout fMP4 -> server buffers an init segment and streams fMP4 chunks to clients via Socket.IO. Client (React) uses MSE to append the init + segments.

## How to run / dev workflow 🔧
- Start both server and client in development: `npm run dev` (uses `concurrently`).
  - Server alone: `npm run dev:server` → runs `tsx server/index.ts` (no separate build step; server runs TS directly).
  - Client alone: `npm run dev:client` → runs `vite`.
- Build client for production: `npm run build` (Vite). Type-checks: `npm run typecheck`. Lint: `npm run lint`.

## Key files & responsibilities 📁
- `server/index.ts` — Express + Socket.IO entrypoint; REST endpoints:
  - `POST /api/stream/start` { rtspUrl } → starts ffmpeg session and returns `sessionId`.
  - `POST /api/stream/stop/:sessionId` → stops session.
  - `GET /api/streams` and `GET /api/stream/status/:sessionId` → session info.
  - Socket events: `stream:watch`, `stream:init`, `stream:data`, `stream:end`, `stream:error`.
- `server/rtsp-service.ts` — core streaming logic:
  - Spawns FFmpeg (prefers `server/bin/ffmpeg`, then `ffmpeg-static`, then system `ffmpeg`).
  - Buffers until an init segment (checks for `ftyp`, `moov`, `moof`) then sends init to clients, afterwards sends fMP4 chunks.
  - Exposes `startStream`, `stopStream`, `getStreamData`, `getInitSegment`, `getSessionStatus`, `getAllSessions`.
  - Writes init segment to `server/tmp/init-<sessionId>.mp4` for debugging when detected.
- `src/services/socket.ts` — client Socket.IO setup (`http://localhost:3001`).
- `src/components/VideoPlayer.tsx` — MSE logic: handles `stream:init` and `stream:data`, appends to SourceBuffer, robust error handling and fallbacks for different payload shapes (ArrayBuffer/Blob/base64).

## Protocol & data shapes (must be exact) 🔁
- Server emits binary chunks (Node Buffer) via Socket.IO; client supports ArrayBuffer/Blob/Uint8Array and a legacy base64 object `{data}`.
- The client expects fMP4 (init + segments) and uses `video/mp4; codecs="avc1.42E01E"` in the SourceBuffer.

## Important implementation details & gotchas ⚠️
- FFmpeg selection: put a platform binary in `server/bin/ffmpeg` to force local use, otherwise `ffmpeg-static` is used only if the binary path exists; otherwise it falls back to `ffmpeg` on PATH. If spawn fails you’ll see a clear advice log message in `rtsp-service.ts`.
- Init detection: a timeout (`INIT_TIMEOUT_MS = 3000ms`) and a max pre-init buffer (`MAX_PREINIT_BYTES = 5MB`) exist; code will promote buffered data to init if these triggers fire — this can affect playback if the data lacks a proper init segment.
- Audio is dropped by default (`-an`) — streams are video-only.
- The server logs FFmpeg stderr and diagnostic info for init segments — check console output and `server/tmp` for saved init files when debugging.

## How to reproduce a streaming test (example) 🧪
1. Start server: `npm run dev:server` (or `npm run dev`).
2. Start a stream:
   curl -X POST http://localhost:3001/api/stream/start -H "Content-Type: application/json" -d '{"rtspUrl":"rtsp://<CAMERA>/path"}'
   -> returns `{ sessionId }`.
3. Open the app in browser, use the UI to watch the returned `sessionId` (or call Socket.IO `stream:watch` manually). Monitor server logs and `server/tmp/init-<sessionId>.mp4`.
4. Stop the stream: `POST /api/stream/stop/<sessionId>`.

## Debugging tips & where to add instrumentation 🕵️
- Look in server logs for: "Using ffmpeg binary", "Init segment detected", warnings about promoting pre-init buffer, and FFmpeg stderr output.
- If clients fail to initialize, check for `stream:init` being sent; check `server/tmp/init-<sessionId>.mp4` to inspect the init segment.
- Add more granular logs in `rtsp-service.ts` around stdout chunk handling and error handlers; `server/index.ts` surfaces socket events per connection.

## Conventions & patterns to follow 🧭
- The service uses a singleton pattern for `rtsp-service` (export default new RTSPService()).
- Prefer attaching diagnostics (write init to `server/tmp`) so you can reproduce failed inits locally.
- Client-side prefers binary transport over base64; keep server emissions as Buffer/ArrayBuffer where possible.

## Small, safe changes you can try first (low-risk starter tasks) ✅
- Add more detailed logging when a client connects and when `getStreamData` creates a client `PassThrough`.
- Improve error messages when FFmpeg exits unexpectedly (include stderr tail).
- Add a small debug endpoint to dump session internals (only for dev).

---
If any of these sections are unclear or you'd like me to expand examples (e.g., a sample integration test or suggested debug endpoint), tell me what to add and I will iterate. Thanks!