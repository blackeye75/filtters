package com.oney.WebRTCModule.videoEffects; import org.webrtc.*; public interface VideoFrameProcessor { VideoFrame process(VideoFrame frame, SurfaceTextureHelper textureHelper); }
