package org.webrtc; import android.graphics.Matrix;
public class VideoFrame { public interface Buffer { int getWidth(); int getHeight(); void retain(); void release(); }
 public interface TextureBuffer extends Buffer { enum Type { OES, RGB } Type getType(); int getTextureId(); Matrix getTransformMatrix(); }
 public VideoFrame(Buffer b, int rotation, long ts){} public Buffer getBuffer(){return null;} public int getRotation(){return 0;} public long getTimestampNs(){return 0;} public void retain(){} public void release(){} }
