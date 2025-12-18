I received a requirement from my office to implement a live streaming feature where the video source is CCTV, and the only supported protocol is RTSP.

Since browsers cannot connect to RTSP directly, the initial approach was to build a gateway server that connects to the RTSP stream using FFmpeg.

The video data buffered over time would then be transmitted to the client via WebSocket.
