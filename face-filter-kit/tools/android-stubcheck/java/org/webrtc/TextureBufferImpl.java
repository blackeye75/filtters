package org.webrtc; import android.graphics.Matrix; import android.os.Handler;
public class TextureBufferImpl implements VideoFrame.TextureBuffer { public TextureBufferImpl(int w,int h,Type type,int id,Matrix m,Handler hd,YuvConverter y,Runnable rc){}
 public int getWidth(){return 0;} public int getHeight(){return 0;} public void retain(){} public void release(){} public Type getType(){return Type.RGB;} public int getTextureId(){return 0;} public Matrix getTransformMatrix(){return null;} }
