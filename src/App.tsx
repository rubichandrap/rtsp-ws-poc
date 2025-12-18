import { useEffect, useState } from 'react';
import { initializeSocket, closeSocket } from './services/socket';
import { VideoPlayer } from './components/VideoPlayer';
import { StreamController } from './components/StreamController';

function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    initializeSocket();

    return () => {
      closeSocket();
    };
  }, []);

  const handleStartStream = async (rtspUrl: string) => {
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch('http://localhost:3001/api/stream/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rtspUrl }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(
          data.message || data.error || 'Failed to start stream'
        );
      }

      const data = await response.json();
      setSessionId(data.sessionId);
    } catch (err: any) {
      setError(err.message);
      console.error('Error starting stream:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleStopStream = async () => {
    if (!sessionId) return;

    try {
      const response = await fetch(
        `http://localhost:3001/api/stream/stop/${sessionId}`,
        {
          method: 'POST',
        }
      );

      if (!response.ok) {
        throw new Error('Failed to stop stream');
      }

      setSessionId(null);
      setError('');
    } catch (err: any) {
      setError(err.message);
      console.error('Error stopping stream:', err);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">
            RTSP Stream Viewer
          </h1>
          <p className="text-gray-400">
            Connect to an RTSP stream and view it in real-time
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            {sessionId ? (
              <div className="space-y-4">
                <VideoPlayer
                  sessionId={sessionId}
                  onStreamEnd={() => {
                    setSessionId(null);
                  }}
                />
                <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
                  <p className="text-sm text-gray-400">
                    Session ID:{' '}
                    <span className="text-gray-200 font-mono text-xs">
                      {sessionId}
                    </span>
                  </p>
                </div>
              </div>
            ) : (
              <div className="bg-gray-800 rounded-lg border-2 border-dashed border-gray-700 p-12 flex items-center justify-center min-h-96">
                <div className="text-center">
                  <div className="w-16 h-16 bg-gray-700 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg
                      className="w-8 h-8 text-gray-500"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </div>
                  <p className="text-gray-400">
                    Start a stream to view the video feed
                  </p>
                </div>
              </div>
            )}
          </div>

          <div>
            <StreamController
              onStartStream={handleStartStream}
              onStopStream={handleStopStream}
              isStreaming={!!sessionId}
              isLoading={isLoading}
              error={error}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
