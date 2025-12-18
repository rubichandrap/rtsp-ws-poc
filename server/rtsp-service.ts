/// <reference path="../types/ffmpeg-static.d.ts" />
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { Readable, PassThrough } from 'stream';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import ffmpegPath from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INIT_TIMEOUT_MS = 3000; // ms to wait for an init segment
const MAX_PREINIT_BYTES = 5 * 1024 * 1024; // 5MB cap for buffering before giving up

interface StreamSession {
  id: string;
  rtspUrl: string;
  process: ChildProcessWithoutNullStreams | null;
  source: Readable | null;
  isActive: boolean;
  clientCount: number;
  clients: Set<PassThrough>;
  // buffering until we detect initialization segment (ftyp/moov/moof)
  preInitChunks: Buffer[];
  preInitSize: number;
  initBuffer: Buffer | null;
  initTimer: NodeJS.Timeout | null;
} 

class RTSPService extends EventEmitter {
  private sessions: Map<string, StreamSession> = new Map();

  startStream(sessionId: string, rtspUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.sessions.has(sessionId)) {
        const existing = this.sessions.get(sessionId);
        if (existing && existing.isActive) return resolve();
      }

      const args = [
        '-rtsp_transport', 'tcp',
        '-i', rtspUrl,
        '-c:v', 'copy',
        '-an', // drop audio
        '-fflags', 'nobuffer',
        '-flags', 'low_delay',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4',
        '-' // output fragmented mp4 (fMP4) to stdout
      ];

      let proc: ChildProcessWithoutNullStreams;
      try {
        // prefer project-local binary in `server/bin` (user renamed lib->bin)
        const localFfmpeg = path.join(__dirname, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

        // use ffmpegPath from ffmpeg-static only if it exists on the FS
        const staticFfmpeg = ffmpegPath && fs.existsSync(ffmpegPath) ? ffmpegPath : null;

        // choose a candidate: local -> static -> fallback to system 'ffmpeg'
        const ffmpegBinary = fs.existsSync(localFfmpeg)
          ? localFfmpeg
          : staticFfmpeg || 'ffmpeg';

        console.info(`Using ffmpeg binary: ${ffmpegBinary}`);

        proc = spawn(ffmpegBinary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err: any) {
        // Provide clearer error message when spawn fails (e.g., ENOENT)
        const advice = `Could not spawn ffmpeg. Ensure ffmpeg exists at server/bin/ffmpeg or install ffmpeg or add it to PATH.`;
        console.error(advice, err);
        return reject(new Error(`${err.message || String(err)} — ${advice}`));
      }

      const session: StreamSession = {
        id: sessionId,
        rtspUrl,
        process: proc,
        source: proc.stdout,
        isActive: false,
        clientCount: 0,
        clients: new Set(),
        preInitChunks: [],
        preInitSize: 0,
        initBuffer: null,
        initTimer: null,
      };

      proc.on('spawn', () => {
        session.isActive = true;
        this.emit('stream-started', { sessionId });

        // start a timer: if no init arrives within INIT_TIMEOUT_MS, promote buffered data as init
        session.initTimer = setTimeout(() => {
          if (!session.initBuffer) {
            if (session.preInitChunks.length > 0) {
              session.initBuffer = Buffer.concat(session.preInitChunks);
              session.preInitChunks = [];
              session.preInitSize = 0;
              console.warn(`Init not found within ${INIT_TIMEOUT_MS}ms for ${sessionId}; promoting buffered data as init (size=${session.initBuffer.length})`);

              // send init to any connected clients
              for (const c of session.clients) {
                try {
                  if (!c.destroyed) c.write(session.initBuffer);
                } catch (e) {
                  console.warn(`Failed to send init to client for ${sessionId}:`, e);
                }
              }
            } else {
              console.warn(`Init not found within ${INIT_TIMEOUT_MS}ms and no preinit data for ${sessionId}`);
            }
            session.initTimer = null;
          }
        }, INIT_TIMEOUT_MS);

        resolve();
      });

      proc.stderr?.on('data', (b) => {
        console.error(`ffmpeg stderr [${sessionId}]:`, b.toString());
      });

      proc.on('error', (err: any) => {
        session.isActive = false;
        this.emit('stream-error', { sessionId, error: err.message || String(err) });
        reject(err);
      });

      proc.on('close', (code, signal) => {
        session.isActive = false;
        if (session.initTimer) { clearTimeout(session.initTimer); session.initTimer = null; }
        for (const c of session.clients) {
          try { c.end(); } catch (e) {}
        }
        session.clients.clear();
        this.sessions.delete(sessionId);
        this.emit('stream-ended', { sessionId });
      });

      // Distribute stdout data to connected client streams and buffer until init segment discovered
      let stdoutChunkCount = 0;
      let loggedFirstChunk = false;
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutChunkCount++;

        // Diagnostic log of the very first chunk
        if (!loggedFirstChunk) {
          loggedFirstChunk = true;
          console.info(`First stdout chunk for ${sessionId}: size=${chunk.length}`);
        }

        // If we haven't found an init segment yet, buffer and scan
        if (!session.initBuffer) {
          session.preInitChunks.push(chunk);
          session.preInitSize += chunk.length;

          // Keep buffer size in check
          if (session.preInitSize > MAX_PREINIT_BYTES) {
            session.initBuffer = Buffer.concat(session.preInitChunks);
            session.preInitChunks = [];
            session.preInitSize = 0;
            console.warn(`Pre-init buffer exceeded ${MAX_PREINIT_BYTES} bytes for ${sessionId}; using what we have as init (size=${session.initBuffer.length})`);

            for (const c of session.clients) {
              try { if (!c.destroyed) c.write(session.initBuffer); } catch (e) { console.warn(`Failed to send init to client for ${sessionId}:`, e); }
            }

            if (session.initTimer) { clearTimeout(session.initTimer); session.initTimer = null; }
            return;
          }

          const combined = Buffer.concat(session.preInitChunks);

          const hasFtyp = combined.indexOf('ftyp') !== -1;
          const hasMoov = combined.indexOf('moov') !== -1;
          const hasMoof = combined.indexOf('moof') !== -1;

          if (hasFtyp || hasMoov || hasMoof) {
              session.initBuffer = combined;
            // clear buffer to release memory
            session.preInitChunks = [];
            session.preInitSize = 0;

            if (session.initTimer) { clearTimeout(session.initTimer); session.initTimer = null; }

            // Inspect init for diagnostics
            try {
              const inspectLen = Math.min(1024, session.initBuffer.length);
              const asciiSnippet = session.initBuffer.toString('ascii', 0, inspectLen);
              const hexSnippet = session.initBuffer.slice(0, inspectLen).toString('hex').slice(0, 400);
              const hasAvcC = asciiSnippet.includes('avcC') || asciiSnippet.includes('avc1');

              console.info(
                `Init segment detected for ${sessionId}: ftyp=${hasFtyp}, moov=${hasMoov}, moof=${hasMoof}, avcC=${hasAvcC}, size=${session.initBuffer.length}`
              );
              console.debug('Init snippet (ascii):', asciiSnippet.slice(0, 200));
              console.debug('Init snippet (hex):', hexSnippet);

              // Write init to tmp for inspection
              const tmpDir = path.join(__dirname, 'tmp');
              try {
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                const p = path.join(tmpDir, `init-${sessionId}.mp4`);
                fs.writeFileSync(p, session.initBuffer);
                console.info(`Wrote init segment to ${p}`);
              } catch (e) {
                console.warn('Failed to write init segment to tmp:', e);
              }
            } catch (e) {
              console.warn('Failed to inspect/write init buffer:', e);
            }

            // send init to any connected clients
            for (const c of session.clients) {
              try {
                if (!c.destroyed) c.write(session.initBuffer);
              } catch (e) {
                console.warn(`Failed to send init to client for ${sessionId}:`, e);
              }
            }
          } else {
            // Still buffering; skip writing to clients until init discovered
            if (stdoutChunkCount % 50 === 0) {
              console.debug(`Buffering stdout chunk #${stdoutChunkCount} for ${sessionId} (still waiting for init)`);
            }
            return;
          }
        } else {
          if (stdoutChunkCount % 25 === 0) {
            console.debug(`stdout chunk #${stdoutChunkCount} for ${sessionId}: size=${chunk.length}`);
          }

          // Normal streaming: write chunk to clients
          for (const c of session.clients) {
            if (!c.destroyed) c.write(chunk);
          }
        }
      });

      this.sessions.set(sessionId, session);
    });
  }

  getStreamData(sessionId: string): Readable | null {
    const session = this.sessions.get(sessionId);
    if (!session || !session.source || !session.isActive) return null;

    const client = new PassThrough();
    session.clients.add(client);
    session.clientCount++;

    // If we have an init buffer, send it to the client immediately so it can initialize MSE
    if (session.initBuffer) {
      try {
        if (!client.destroyed) client.write(session.initBuffer);
      } catch (e) {
        console.warn(`Failed to write init to new client for ${sessionId}:`, e);
      }
    }

    const cleanup = () => {
      if (session.clients.has(client)) session.clients.delete(client);
      session.clientCount = Math.max(0, session.clientCount - 1);
    };

    client.on('close', cleanup);
    client.on('end', cleanup);
    client.on('error', cleanup);
    client.on('finish', cleanup);

    return client;
  }

  stopStream(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.process) {
      try {
        session.process.kill('SIGKILL');
      } catch (e) {}
      session.isActive = false;
      if (session.initTimer) { clearTimeout(session.initTimer); session.initTimer = null; }
      for (const c of session.clients) {
        try { c.end(); } catch (e) {}
      }
      session.clients.clear();
      this.sessions.delete(sessionId);
      this.emit('stream-stopped', { sessionId });
    }
  }

  getInitSegment(sessionId: string): Buffer | null {
    const session = this.sessions.get(sessionId);
    return session ? session.initBuffer : null;
  }

  getSessionStatus(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return session
      ? {
          id: session.id,
          isActive: session.isActive,
          clientCount: session.clientCount,
          rtspUrl: session.rtspUrl,
        }
      : null;
  }

  getAllSessions() {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      isActive: session.isActive,
      clientCount: session.clientCount,
      rtspUrl: session.rtspUrl,
    }));
  }
}

export default new RTSPService();
