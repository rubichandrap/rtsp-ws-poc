import { useState } from 'react';
import { Play, Square, AlertCircle } from 'lucide-react';

interface StreamControllerProps {
  onStartStream: (rtspUrl: string) => Promise<void>;
  onStopStream: () => void;
  isStreaming: boolean;
  isLoading: boolean;
  error?: string;
}

export function StreamController({
  onStartStream,
  onStopStream,
  isStreaming,
  isLoading,
  error,
}: StreamControllerProps) {
  // Read default RTSP URL from Vite env (create a .env with VITE_DEFAULT_RTSP_URL)
  const DEFAULT_RTSP = (import.meta.env.VITE_DEFAULT_RTSP_URL as string) || '';
  const [rtspUrl, setRtspUrl] = useState<string>(DEFAULT_RTSP);
  const [localError, setLocalError] = useState('');

  const handleStartStream = async () => {
    setLocalError('');

    if (!rtspUrl.trim()) {
      setLocalError('Please enter an RTSP URL');
      return;
    }

    if (!rtspUrl.startsWith('rtsp://') && !rtspUrl.startsWith('rtsps://')) {
      setLocalError('URL must start with rtsp:// or rtsps://');
      return;
    }

    try {
      await onStartStream(rtspUrl);
    } catch (err: any) {
      setLocalError(err.message || 'Failed to start stream');
    }
  };

  const handleStopStream = () => {
    setLocalError('');
    onStopStream();
  };

  const displayError = error || localError;

  return (
    <div className="bg-white rounded-lg shadow-md p-6 border border-gray-200">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Stream Control
      </h2>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            RTSP Stream URL
          </label>
          <input
            type="text"
            value={rtspUrl}
            onChange={(e) => {
              setRtspUrl(e.target.value);
              setLocalError('');
            }}
            placeholder="rtsp://example.com:554/stream"
            disabled={isStreaming}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none disabled:bg-gray-100 disabled:cursor-not-allowed transition"
          />
          <p className="text-xs text-gray-500 mt-1">
            Enter a valid RTSP URL to stream from
          </p>
        </div>

        {displayError && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex gap-2">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">{displayError}</p>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={handleStartStream}
            disabled={isStreaming || isLoading}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition font-medium"
          >
            {isLoading ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Starting...
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                Start Stream
              </>
            )}
          </button>

          <button
            onClick={handleStopStream}
            disabled={!isStreaming || isLoading}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition font-medium"
          >
            <Square className="w-4 h-4" />
            Stop Stream
          </button>
        </div>
      </div>

      {isStreaming && (
        <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm text-green-700 flex items-center gap-2">
            <span className="w-2 h-2 bg-green-600 rounded-full animate-pulse" />
            Stream is active and broadcasting
          </p>
        </div>
      )}
    </div>
  );
}
