package expo.modules.facefilter

import android.content.Context
import android.graphics.Matrix
import android.opengl.GLES30
import android.os.SystemClock
import android.util.Log
import com.oney.WebRTCModule.videoEffects.VideoFrameProcessor
import com.oney.WebRTCModule.videoEffects.VideoFrameProcessorFactoryInterface
import org.webrtc.RendererCommon
import org.webrtc.SurfaceTextureHelper
import org.webrtc.TextureBufferImpl
import org.webrtc.VideoFrame
import org.webrtc.YuvConverter
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Shared state between the JS module and the capture thread. */
object FaceFilterState {
  val params = AtomicReference(FilterParams())
  @Volatile var enabled = true
  @Volatile var stats: Map<String, Any> = emptyMap()
}

class FaceFilterProcessorFactory(private val context: Context) : VideoFrameProcessorFactoryInterface {
  override fun build(): VideoFrameProcessor = FaceFilterProcessor(context.applicationContext)
}

/**
 * Called by react-native-webrtc for every camera frame, on the SurfaceTextureHelper thread (EGL
 * context current, camera OES texture valid). Returns a NEW frame with the makeup painted in, so the
 * local preview (RTCView) and the encoder both get identical, already-filtered pixels.
 *
 * Per frame: copy OES -> RGBA, small upright copy -> MediaPipe (blocking), One Euro, render, wrap.
 */
class FaceFilterProcessor(private val context: Context) : VideoFrameProcessor {
  private var renderer: FaceRenderer? = null
  private var tracker: FaceTracker? = null
  private var smoother: LandmarkSmoother? = null
  private var yuvConverter: YuvConverter? = null
  private var glOk: Boolean? = null

  private val pool = ArrayList<PooledTarget>()
  private class PooledTarget(val t: FaceRenderer.Target) { @Volatile var inUse = false }

  private val upright = FloatArray(478 * 3)
  private val raw = FloatArray(468 * 3)
  private val smoothed = FloatArray(468 * 3)
  private val norm = FloatArray(468 * 3)
  private var haveFace = false
  private var missing = 0
  private var fade = 0f
  private var lastFrameNs = 0L

  // Probe: some devices report sensor rotation the other way round. Until the first face is found,
  // alternate between r and r+180 for 90/270 frames, then lock whichever finds a face.
  private var rotationFlip = false
  private var rotationLocked = false
  private var framesWithoutFace = 0

  override fun process(frame: VideoFrame, textureHelper: SurfaceTextureHelper): VideoFrame {
    val buffer = frame.buffer
    if (!FaceFilterState.enabled || buffer !is VideoFrame.TextureBuffer || buffer.type != VideoFrame.TextureBuffer.Type.OES) {
      return passthrough(frame)
    }
    if (!init()) return passthrough(frame)
    val r = renderer!!; val tr = tracker!!
    val t0 = SystemClock.elapsedRealtimeNanos()
    val W = buffer.width; val H = buffer.height

    // 0. camera -> RGBA (same orientation as the camera buffer; rotation stays as metadata)
    val texMatrix = RendererCommon.convertMatrixFromAndroidGraphicsMatrix(buffer.transformMatrix)
    r.copyCamera(buffer.textureId, texMatrix, W, H)

    // 1. landmarks for THIS frame
    var found = false
    val tsMs = frame.timestampNs / 1_000_000
    if (tr.ready && !tr.busy) {
      val rot = effectiveRotation(frame.rotation)
      val swap = rot == 90 || rot == 270
      val uW = if (swap) H else W; val uH = if (swap) W else H
      val long = if (max(uW, uH) > 960) 640 else 480
      val s = long.toFloat() / max(uW, uH)
      val inW = max(16, (uW * s).roundToInt()); val inH = max(16, (uH * s).roundToInt())
      val prep = prepMatrix(rot)
      val pixels = r.readModelInput(prep, inW, inH)
      if (tr.detect(pixels, inW, inH, tsMs, upright)) {
        found = true
        // upright (u,v) -> frame image space (x,y) via the same matrix, then to pixels
        val zScale = if (swap) H.toFloat() else W.toFloat()
        for (i in 0 until 468) {
          val u = upright[i * 3]; val v = upright[i * 3 + 1]
          val x = prep[0] * u + prep[3] * v + prep[6]
          val y = prep[1] * u + prep[4] * v + prep[7]
          raw[i * 3] = x * W; raw[i * 3 + 1] = y * H; raw[i * 3 + 2] = upright[i * 3 + 2] * zScale
        }
      }
      updateRotationProbe(found, frame.rotation)
    }
    val tInfer = SystemClock.elapsedRealtimeNanos()

    // 2. smoothing, presence, fade
    val sm = smoother!!
    if (found) {
      val iod = iod(raw)
      if (!haveFace || missing > HOLD_FRAMES) sm.reset()
      sm.filter(raw, frame.timestampNs / 1e9, iod, smoothed)
      haveFace = true; missing = 0
    } else if (haveFace) missing++
    val present = haveFace && missing <= HOLD_FRAMES
    val dt = if (lastFrameNs != 0L) min((frame.timestampNs - lastFrameNs) / 1e9f, 0.2f) else 1f / 30f
    lastFrameNs = frame.timestampNs
    fade = (fade + (if (present) 1f else -1f) * dt / FADE_SECONDS).coerceIn(0f, 1f)
    if (!present && fade == 0f) haveFace = false
    if (!haveFace) { publishStats(t0, tInfer, false, tr); return passthrough(frame) }

    // 3. render into a pooled output texture
    val out = acquire(W, H) ?: return passthrough(frame)
    r.render(FaceFilterState.params.get(), geometry(W, H), fade, out.t)
    GLES30.glFinish() // other EGL contexts (preview, encoder) read this texture next

    // 4. wrap as a WebRTC frame; texture returns to the pool when every consumer has released it
    val flip = Matrix().apply { preTranslate(0f, 1f); preScale(1f, -1f) } // memory row 0 = image top
    val outBuffer = TextureBufferImpl(
      W, H, VideoFrame.TextureBuffer.Type.RGB, out.t.tex, flip,
      textureHelper.handler, yuvConverter!!, Runnable { out.inUse = false },
    )
    publishStats(t0, tInfer, true, tr)
    return VideoFrame(outBuffer, frame.rotation, frame.timestampNs)
  }

  // ---------------------------------------------------------------------------------------------

  /** The caller releases both the input and the returned frame, so a passthrough must retain. */
  private fun passthrough(frame: VideoFrame): VideoFrame { frame.retain(); return frame }

  private fun init(): Boolean {
    glOk?.let { if (!it) return false }
    if (renderer != null) return true
    val version = GLES30.glGetString(GLES30.GL_VERSION) ?: ""
    if (!version.contains("OpenGL ES 3")) {
      Log.e(TAG, "Needs an OpenGL ES 3 context, got '$version'. Filter disabled.")
      glOk = false; return false
    }
    return try {
      val r = FaceRenderer(context)
      renderer = r
      smoother = LandmarkSmoother(468, r.lipIndices)
      tracker = FaceTracker(context)
      yuvConverter = YuvConverter()
      glOk = true; true
    } catch (t: Throwable) {
      Log.e(TAG, "init failed", t); glOk = false; false
    }
  }

  private fun acquire(w: Int, h: Int): PooledTarget? {
    pool.firstOrNull { !it.inUse && it.t.w == w && it.t.h == h }?.let { it.inUse = true; return it }
    // drop free targets of the wrong size (resolution changed)
    pool.filter { !it.inUse && (it.t.w != w || it.t.h != h) }.forEach { renderer!!.free(it.t); pool.remove(it) }
    if (pool.size >= MAX_POOL) return null
    return PooledTarget(renderer!!.target(w, h)).also { it.inUse = true; pool.add(it) }
  }

  private fun effectiveRotation(r: Int): Int =
    if (rotationFlip && (r == 90 || r == 270)) (r + 180) % 360 else r

  private fun updateRotationProbe(found: Boolean, r: Int) {
    if (rotationLocked) return
    if (found) { rotationLocked = true; return }
    if (r != 90 && r != 270) return
    if (++framesWithoutFace >= 8) { rotationFlip = !rotationFlip; framesWithoutFace = 0 }
  }

  /** Column-major 3x3: upright (u, v, 1) -> frame image space (x, y). r = clockwise rotation to upright. */
  private fun prepMatrix(r: Int): FloatArray = when (r) {
    90 -> floatArrayOf(0f, -1f, 0f, 1f, 0f, 0f, 0f, 1f, 1f)    // x = v,     y = 1 - u
    180 -> floatArrayOf(-1f, 0f, 0f, 0f, -1f, 0f, 1f, 1f, 1f)  // x = 1 - u, y = 1 - v
    270 -> floatArrayOf(0f, 1f, 0f, -1f, 0f, 0f, 1f, 0f, 1f)   // x = 1 - v, y = u
    else -> floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f)
  }

  private fun iod(p: FloatArray): Float {
    val e = renderer!!.eyeCorners
    return hypot(p[e[0] * 3] - p[e[1] * 3], p[e[0] * 3 + 1] - p[e[1] * 3 + 1])
  }

  private fun geometry(w: Int, h: Int): FaceRenderer.Geometry {
    for (i in 0 until 468) {
      norm[i * 3] = smoothed[i * 3] / w
      norm[i * 3 + 1] = smoothed[i * 3 + 1] / h
      norm[i * 3 + 2] = smoothed[i * 3 + 2] / w
    }
    val r = renderer!!
    val nose = 4
    val (cR, cL) = r.cheekSample.let { it[0] to it[1] }
    val c = if (abs(norm[cR * 3] - norm[nose * 3]) > abs(norm[cL * 3] - norm[nose * 3])) cR else cL
    val (l1, l2) = r.lowerLipBody.let { it[0] to it[1] }
    return FaceRenderer.Geometry(
      points = norm,
      skinRef = floatArrayOf(norm[c * 3], norm[c * 3 + 1]),
      lipRef = floatArrayOf((norm[l1 * 3] + norm[l2 * 3]) / 2, (norm[l1 * 3 + 1] + norm[l2 * 3 + 1]) / 2),
      iodPx = iod(smoothed),
    )
  }

  private fun publishStats(t0: Long, tInfer: Long, faceFound: Boolean, tr: FaceTracker) {
    val now = SystemClock.elapsedRealtimeNanos()
    FaceFilterState.stats = mapOf(
      "inferenceMs" to (tInfer - t0) / 1e6,
      "totalMs" to (now - t0) / 1e6,
      "faceFound" to faceFound,
      "delegate" to tr.delegateInUse,
    )
  }

  companion object {
    private const val TAG = "FaceFilter"
    private const val HOLD_FRAMES = 2
    private const val FADE_SECONDS = 0.1f
    private const val MAX_POOL = 6
  }
}
