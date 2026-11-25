package com.google.mediapipe.tasks.vision.facelandmarker; import java.util.List; import com.google.mediapipe.tasks.components.containers.NormalizedLandmark;
public abstract class FaceLandmarkerResult { public abstract List<List<NormalizedLandmark>> faceLandmarks(); }
