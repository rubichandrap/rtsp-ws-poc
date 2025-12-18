import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { getSocket } from '../services/socket';

interface VideoPlayerProps {
  sessionId: string | null;
  onStreamEnd?: () => void;
}

export function VideoPlayer({ sessionId, onStreamEnd }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [bufferHealth, setBufferHealth] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');

  // queue of pending fMP4 segments (to avoid appending while updating)
  const pendingBuffersRef = useRef<Uint8Array[]>([]);
  const initReceivedRef = useRef(false);
  const firstSegmentAppliedRef = useRef(false);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;

    const socket = getSocket();
    if (!socket) return;

    const video = videoRef.current;
    if (!video) return;

    const mediaSource = new MediaSource();
    mediaSourceRef.current = mediaSource;
    video.src = URL.createObjectURL(mediaSource);

    // (pendingBuffersRef is declared in outer scope via useRef)

    mediaSource.addEventListener('sourceopen', () => {
      if (
        mediaSource.readyState === 'open' &&
        !sourceBufferRef.current
      ) {
        try {
          const sourceBuffer = mediaSource.addSourceBuffer(
            'video/mp4; codecs="avc1.42E01E"'
          );
          sourceBufferRef.current = sourceBuffer;

          sourceBuffer.addEventListener('error', () => {
            setErrorMessage('Buffer error occurred');
          });

          // When an append finishes, flush the next queued buffer
          sourceBuffer.addEventListener('updateend', () => {
            // Flush as many queued buffers as possible (loop) so we don't re-enter updateend races
            while (!sourceBuffer.updating && pendingBuffersRef.current.length > 0) {
              const next = pendingBuffersRef.current.shift();
              if (!next) break;

              try {
                // If video element already has a media error, abort flushing
                if (video && video.error) {
                  console.error('Video element error detected before append:', video.error);
                  handleAppendFailure(new Error('Video element has a media error'));
                  break;
                }

                // Convert Uint8Array to an ArrayBuffer copy to satisfy TS DOM types
                const nextArrayBuf = (new Uint8Array(next)).buffer; // copy into ArrayBuffer
                sourceBuffer.appendBuffer(nextArrayBuf);

                // Mark first-segment applied and try autoplay once the first segment is appended
                if (!firstSegmentAppliedRef.current && initReceivedRef.current) {
                  firstSegmentAppliedRef.current = true;
                  attemptAutoplay();
                }
              } catch (err: any) {
                console.error('Append buffer error during flush:', err);
                handleAppendFailure(err);
                break;
              }
            }
          });

          // flush any buffers that arrived before sourceopen
          const first = pendingBuffersRef.current.shift();
          if (first) {
            try {
              const firstArrayBuf = (new Uint8Array(first)).buffer;
            sourceBuffer.appendBuffer(firstArrayBuf);
            } catch (err: any) {
              console.error('Append buffer error on initial flush:', err);
              handleAppendFailure(err);
            }
          }

          socket.emit('stream:watch', sessionId);
        } catch (err: any) {
          setErrorMessage(
            `Cannot create source buffer: ${err.message}`
          );
        }
      }
    });

    socket.on('stream:ready', ({ sessionId: sid }: any) => {
      console.debug('stream:ready received', sid);
      if (sid === sessionId) {
        setIsConnected(true);
        setErrorMessage('');

        // Attempt autoplay; mute first to increase chance of success
        try {
          if (video) {
            video.muted = true;
            setIsMuted(true);
            const p = video.play();
            if (p && typeof p.then === 'function') {
              p.then(() => setIsPlaying(true)).catch((err) => {
                console.warn('Autoplay failed:', err);
              });
            }
          }
        } catch (err) {
          console.warn('Autoplay attempt failed:', err);
        }
      }
    });

    // Helper: normalize various incoming payloads to Uint8Array
    const toUint8Array = async (payload: any): Promise<Uint8Array | null> => {
      try {
        if (!payload) return null;
        // ArrayBuffer
        if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
        // Blob (browser)
        if (payload instanceof Blob) {
          const ab = await payload.arrayBuffer();
          return new Uint8Array(ab);
        }
        // Uint8Array already
        if (payload instanceof Uint8Array) return payload;
        // If server sent an object with {data: base64}
        if (typeof payload === 'object' && payload.data && typeof payload.data === 'string') {
          const binaryString = atob(payload.data);
          const len = binaryString.length;
          const uint8 = new Uint8Array(len);
          for (let i = 0; i < len; i++) uint8[i] = binaryString.charCodeAt(i);
          return uint8;
        }
        // If server sent plain base64 string
        if (typeof payload === 'string') {
          const binaryString = atob(payload);
          const len = binaryString.length;
          const uint8 = new Uint8Array(len);
          for (let i = 0; i < len; i++) uint8[i] = binaryString.charCodeAt(i);
          return uint8;
        }

        return null;
      } catch (err) {
        console.error('Failed to normalize payload to Uint8Array:', err);
        return null;
      }
    };

    const attemptAutoplay = () => {
      try {
        if (!video) return;
        if (!isPlaying && isMuted) {
          const p = video.play();
          if (p && typeof p.then === 'function') {
            p.then(() => setIsPlaying(true)).catch((err: any) => {
              if (err && err.name !== 'AbortError') console.warn('Autoplay failed:', err);
            });
          }
        }
      } catch (err) {
        console.warn('Autoplay attempt failed:', err);
      }
    };

    const handleAppendFailure = (err: any) => {
      console.error('Handling append failure:', err);

      if (video && video.error) {
        console.error('Video element error:', video.error);
        const code = video.error.code;
        const codeMap: Record<number, string> = {
          1: 'MEDIA_ERR_ABORTED',
          2: 'MEDIA_ERR_NETWORK',
          3: 'MEDIA_ERR_DECODE',
          4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
        };
        const msg = codeMap[code] || `code_${code}`;
        setErrorMessage(`Media error: ${msg}`);
      } else if (err && err.message) {
        setErrorMessage(`Buffer error: ${err.message}`);
      } else {
        setErrorMessage('Unknown buffer error');
      }

      // Stop watching and cleanup once on failure
      if (!stoppedRef.current) {
        stoppedRef.current = true;
        try { socket.emit('stream:unwatch'); } catch (e) {}
        setIsConnected(false);
        onStreamEnd?.();
      }

      // Clear pending buffers so we don't try to append again
      pendingBuffersRef.current.length = 0;
    };

    // Handle explicit init segment
    socket.on('stream:init', async (payload: any) => {
      const uint8 = await toUint8Array(payload);
      if (!uint8) return;
      initReceivedRef.current = true;

      // Always prepend init so it gets applied before subsequent segments
      pendingBuffersRef.current.unshift(uint8);

      // If sourceBuffer ready and not updating, flush immediately (and attempt autoplay once flushed)
      const sourceBuffer = sourceBufferRef.current;
      if (sourceBuffer && !sourceBuffer.updating && pendingBuffersRef.current.length > 0) {
        const next = pendingBuffersRef.current.shift();
        if (next) {
          try {
            const nextArrayBuf = (new Uint8Array(next)).buffer; // copy into ArrayBuffer
            sourceBuffer.appendBuffer(nextArrayBuf);
            firstSegmentAppliedRef.current = true;
            attemptAutoplay();
          } catch (err: any) {
            console.error('Append buffer error when applying init:', err);
            handleAppendFailure(err);
          }
        }
      }
    });

    socket.on('stream:data', async (payload: any) => {
      if (!sourceBufferRef.current) return;

      // normalize payload to Uint8Array, supports binary (ArrayBuffer/Blob) or legacy object/base64
      const uint8Array = await toUint8Array(payload);
      if (!uint8Array) return;

      // Debug occasionally
      if (Math.random() < 0.01) console.debug('stream:data received size', uint8Array.byteLength);

      const sourceBuffer = sourceBufferRef.current;
      if (!sourceBuffer) {
        pendingBuffersRef.current.push(uint8Array);
        return;
      }

      if (sourceBuffer.updating || pendingBuffersRef.current.length > 0) {
        pendingBuffersRef.current.push(uint8Array);
      } else {
        try {
          const arrayBuf = (new Uint8Array(uint8Array)).buffer;
          sourceBuffer.appendBuffer(arrayBuf);
        } catch (err: any) {
          console.error('Append buffer error:', err);

          // If the video element reports a media error, log and show it
          if (video && video.error) {
            console.error('Video element error:', video.error);
            const code = video.error.code;
            const codeMap: Record<number, string> = {
              1: 'MEDIA_ERR_ABORTED',
              2: 'MEDIA_ERR_NETWORK',
              3: 'MEDIA_ERR_DECODE',
              4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
            };
            const msg = codeMap[code] || `code_${code}`;
            setErrorMessage(`Media error: ${msg}`);

            // Stop watching and notify parent
            socket.emit('stream:unwatch');
            setIsConnected(false);
            onStreamEnd?.();
          } else {
            setErrorMessage(`Buffer error: ${err.message}`);
          }
        }
      }
    });

    socket.on('stream:error', ({ error }: any) => {
      setIsConnected(false);
      setErrorMessage(error || 'Stream error occurred');
    });

    socket.on('stream:init', () => {}); // noop placeholder to ensure handler is attached (actual handler above)


    socket.on('stream:end', () => {
      setIsConnected(false);
      if (sourceBufferRef.current && mediaSourceRef.current) {
        try {
          mediaSourceRef.current.endOfStream();
        } catch (err) {
          console.error('Error ending stream:', err);
        }
      }
      onStreamEnd?.();
    });

    const handleTimeUpdate = () => {
      if (sourceBufferRef.current && video) {
        const buffered = video.buffered;
        if (buffered.length > 0) {
          const bufferedEnd = buffered.end(buffered.length - 1);
          const currentTime = video.currentTime;
          const health = Math.min(
            100,
            Math.round(((bufferedEnd - currentTime) / 10) * 100)
          );
          setBufferHealth(Math.max(0, health));
        }
      }
    };

    video.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      try { socket.emit('stream:unwatch'); } catch (e) {}
      socket.off('stream:ready');
      socket.off('stream:data');
      socket.off('stream:error');
      socket.off('stream:end');
      socket.off('stream:init');
      pendingBuffersRef.current.length = 0;
      stoppedRef.current = true;
      if (mediaSourceRef.current) {
        try { URL.revokeObjectURL(video.src); } catch (e) {}
      }
    };
  }, [sessionId, onStreamEnd]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.pause();
    } else {
      video.play();
    }
    setIsPlaying(!isPlaying);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = !video.muted;
    setIsMuted(!isMuted);
  };

  return (
    <div className="relative bg-black rounded-lg overflow-hidden shadow-xl">
      <video
        ref={videoRef}
        className="w-full h-auto"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
      />

      {!isConnected && !errorMessage && (
        <div className="absolute inset-0 bg-black bg-opacity-75 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin mb-4">
              <div className="h-12 w-12 border-4 border-blue-400 border-t-transparent rounded-full mx-auto" />
            </div>
            <p className="text-white text-sm">Connecting to stream...</p>
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="absolute inset-0 bg-black bg-opacity-75 flex items-center justify-center">
          <div className="text-center max-w-xs">
            <p className="text-red-400 text-sm font-medium mb-2">
              Stream Error
            </p>
            <p className="text-gray-300 text-xs">{errorMessage}</p>
          </div>
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black to-transparent p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              className="p-2 hover:bg-white hover:bg-opacity-20 rounded-full transition"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 text-white" />
              ) : (
                <Play className="w-5 h-5 text-white" />
              )}
            </button>

            <button
              onClick={toggleMute}
              className="p-2 hover:bg-white hover:bg-opacity-20 rounded-full transition"
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? (
                <VolumeX className="w-5 h-5 text-white" />
              ) : (
                <Volume2 className="w-5 h-5 text-white" />
              )}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="text-xs text-gray-300">
              {isConnected ? (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-green-400 rounded-full" />
                  Live
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 bg-red-400 rounded-full" />
                  Offline
                </span>
              )}
            </div>

            <div className="flex items-center gap-1">
              <div className="w-16 h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{ width: `${bufferHealth}%` }}
                />
              </div>
              <span className="text-xs text-gray-400 w-6 text-right">
                {bufferHealth}%
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
