package expo.modules.facefilter

import android.content.Context
import android.util.Log
import com.google.mediapipe.framework.image.ByteBufferImageBuilder
import com.google.mediapipe.framework.image.MPImage
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/**
 * MediaPipe Face Landmarker in VIDEO mode (synchronous, tracks between frames).
 *
 * Inference runs on its own thread and the caller BLOCKS for the result. Two reasons:
 *  1. The frame stays synchronous: frame N is painted with frame N's landmarks.
 *  2. MediaPipe's GPU delegate may switch EGL contexts on the thread it runs on; keeping it off the
 *     WebRTC capture thread protects the camera's GL context. The hop costs ~0.1 ms.
 */
class FaceTracker(context: Context, preferGpu: Boolean = true) {
  private val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "FaceFilter-Inference").apply { priority = Thread.MAX_PRIORITY } }
  @Volatile private var landmarker: FaceLandmarker? = null
  @Volatile var delegateInUse: String = "none"; private set
  private var lastTs = -1L
  @Volatile private var pending: Future<Boolean>? = null

  /** True while a timed-out inference is still running; the caller must not touch the input buffer. */
  val busy: Boolean get() = pending?.isDone == false

  init {
    exec.execute {
      landmarker = create(context, if (preferGpu) Delegate.GPU else Delegate.CPU)
        ?: if (preferGpu) create(context, Delegate.CPU) else null
    }
  }

  val ready: Boolean get() = landmarker != null

  private fun create(context: Context, d: Delegate): FaceLandmarker? = try {
    // Load into a direct buffer ourselves: works whether or not the APK compressed the asset.
    val bytes = context.assets.open("facefilter/face_landmarker.task").use { it.readBytes() }
    val model = ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).put(bytes)
    model.rewind()
    val base = BaseOptions.builder()
      .setModelAssetBuffer(model)
      .setDelegate(d)
      .build()
    val opts = FaceLandmarker.FaceLandmarkerOptions.builder()
      .setBaseOptions(base)
      .setRunningMode(RunningMode.VIDEO)
      .setNumFaces(1)
      .setMinFaceDetectionConfidence(0.5f)
      .setMinFacePresenceConfidence(0.5f)
      .setMinTrackingConfidence(0.5f)
      .setOutputFaceBlendshapes(false)
      .setOutputFacialTransformationMatrixes(false)
      .build()
    FaceLandmarker.createFromOptions(context, opts).also { delegateInUse = d.name }
  } catch (t: Throwable) {
    Log.w("FaceFilter", "FaceLandmarker with $d failed: ${t.message}")
    null
  }

  /**
   * Returns 468+ landmarks as (u, v, z) in the UPRIGHT input image (normalized), or null.
   * Blocks up to [timeoutMs]; on timeout the frame is treated as "no face" (never stale data).
   */
  fun detect(rgba: ByteBuffer, w: Int, h: Int, timestampMs: Long, out: FloatArray, timeoutMs: Long = 45): Boolean {
    val lm = landmarker ?: return false
    val ts = if (timestampMs > lastTs) timestampMs else lastTs + 1   // VIDEO mode needs increasing timestamps
    lastTs = ts
    val task: Future<Boolean> = exec.submit<Boolean> {
      val img: MPImage = ByteBufferImageBuilder(rgba, w, h, MPImage.IMAGE_FORMAT_RGBA).build()
      val res = lm.detectForVideo(img, ts)
      val face = res.faceLandmarks().firstOrNull() ?: return@submit false
      val n = minOf(face.size, out.size / 3)
      for (i in 0 until n) {
        val p = face[i]
        out[i * 3] = p.x(); out[i * 3 + 1] = p.y(); out[i * 3 + 2] = p.z()
      }
      n >= 468
    }
    pending = task
    return try { task.get(timeoutMs, TimeUnit.MILLISECONDS) } catch (t: Throwable) { task.cancel(false); false }
  }

  fun close() {
    exec.execute { landmarker?.close(); landmarker = null }
    exec.shutdown()
  }
}
