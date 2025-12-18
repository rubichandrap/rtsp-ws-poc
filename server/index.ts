import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import cors from 'cors';
import rtspService from './rtsp-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

const PORT = 3001;
const activeStreams: Map<string, Readable> = new Map();

// REST Endpoints

app.post('/api/stream/start', async (req: Request, res: Response) => {
  try {
    const { rtspUrl } = req.body;

    if (!rtspUrl) {
      res.status(400).json({ error: 'rtspUrl is required' });
      return;
    }

    const sessionId = `stream-${Date.now()}`;

    await rtspService.startStream(sessionId, rtspUrl);

    res.json({
      success: true,
      sessionId,
      message: 'Stream started successfully',
    });
  } catch (error: any) {
    res.status(500).json({
      error: 'Failed to start stream',
      message: error.message,
    });
  }
});

app.post('/api/stream/stop/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;

  rtspService.stopStream(sessionId);

  // Stop and remove any active client streams associated with this session
  const keysToDelete: string[] = [];
  activeStreams.forEach((stream, key) => {
    if (key.startsWith(`${sessionId}-`)) {
      try { (stream as any)?.destroy?.(); } catch (err) { console.warn(`Failed to destroy stream ${key}:`, err); }
      keysToDelete.push(key);
    }
  });

  keysToDelete.forEach((key) => activeStreams.delete(key));

  res.json({ success: true, message: 'Stream stopped' });
});

app.get('/api/stream/status/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const status = rtspService.getSessionStatus(sessionId);

  if (!status) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.json(status);
});

app.get('/api/streams', (req: Request, res: Response) => {
  const sessions = rtspService.getAllSessions();
  res.json(sessions);
});

// Socket.IO Events

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('stream:watch', (sessionId: string) => {
    console.info(`socket ${socket.id} requested to watch session ${sessionId}`);
    const sessionStatus = rtspService.getSessionStatus(sessionId);
    console.info(`sessionStatus for ${sessionId}:`, sessionStatus);

    if (!sessionStatus || !sessionStatus.isActive) {
      console.warn(`stream not active for ${sessionId} (socket ${socket.id})`);
      socket.emit('stream:error', {
        error: 'Stream not found or not active',
      });
      return;
    }

    const streamKey = `${sessionId}-${socket.id}`;

    if (activeStreams.has(streamKey)) {
      socket.emit('stream:error', { error: 'Already watching this stream' });
      return;
    }

    const stream = rtspService.getStreamData(sessionId);

    if (!stream) {
      console.warn(`getStreamData returned null for ${sessionId} (socket ${socket.id})`);
      socket.emit('stream:error', { error: 'Failed to get stream' });
      return;
    }

    activeStreams.set(streamKey, stream);

    // If we have a cached init segment, send it explicitly to the client so it can initialize MSE
    const init = rtspService.getInitSegment(sessionId);
    if (init) {
      try {
        socket.emit('stream:init', init);
        console.info(`stream:init sent to ${socket.id} for ${sessionId} (size=${init.length})`);
      } catch (e) {
        console.warn(`Failed to emit stream:init to ${socket.id}:`, e);
      }
    }

    socket.emit('stream:ready', { sessionId });
    console.info(`stream:ready sent to ${socket.id} for ${sessionId}`);

    // Send each chunk immediately (fMP4 segments) — client will queue/apply
    let chunkCount = 0;
    stream.on('data', (chunk: Buffer) => {
      chunkCount++;
      if (chunkCount % 10 === 0) {
        console.debug(`Emitting chunk #${chunkCount} (size=${chunk.length}) for ${streamKey}`);
      }
      try {
        // send binary chunk directly (avoids base64 overhead)
        socket.emit('stream:data', chunk);
      } catch (err) {
        console.error(`Failed to emit chunk for ${streamKey}:`, err);
      }
    });

    stream.on('error', (err) => {
      console.error(`Stream error for ${streamKey}:`, err);
      socket.emit('stream:error', { error: err.message });
      activeStreams.delete(streamKey);
    });

    stream.on('end', () => {
      socket.emit('stream:end', { sessionId });
      activeStreams.delete(streamKey);
    });

    socket.on('stream:unwatch', () => {
      if (activeStreams.has(streamKey)) {
        const s = activeStreams.get(streamKey);
        if (s) s.destroy();
        activeStreams.delete(streamKey);
      }
      socket.removeAllListeners('stream:unwatch');
    });
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);

    const keysToDelete: string[] = [];
    activeStreams.forEach((stream, key) => {
      if (key.includes(socket.id)) {
        stream.destroy();
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach((key) => {
      activeStreams.delete(key);
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
