package com.google.mediapipe.tasks.core; import java.nio.ByteBuffer;
public abstract class BaseOptions { public static Builder builder(){return null;} public abstract static class Builder { public abstract Builder setModelAssetBuffer(ByteBuffer b); public abstract Builder setModelAssetPath(String p); public abstract Builder setDelegate(Delegate d); public abstract BaseOptions build(); } }
