package expo.modules.facefilter

import kotlin.math.PI
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * One Euro landmark smoother. Line-for-line port of web/src/engine/OneEuro.ts (keep them in sync;
 * the web version has unit tests). Speed is in face units (px / inter-ocular distance).
 */
class LandmarkSmoother(
  private val n: Int,
  lipIndices: IntArray,
  private val minCutoff: Float = 1.2f,
  private val beta: Float = 8.0f,
  private val dCutoff: Float = 1.0f,
  lipMinCutoff: Float = 3.0f,
  private val localDeadzone: Float = 0.35f,
) {
  private val x = FloatArray(n * 3)
  private val dx = FloatArray(n)
  private val minCut = FloatArray(n) { minCutoff }
  private var globalSpeed = 0f
  private var prevCx = 0f
  private var prevCy = 0f
  private var lastT = -1.0
  private var initialized = false

  init { for (i in lipIndices) if (i < n) minCut[i] = lipMinCutoff }

  fun reset() { initialized = false; lastT = -1.0 }

  private fun alpha(cutoff: Float, dt: Float): Float {
    val tau = 1f / (2f * PI.toFloat() * cutoff)
    return 1f / (1f + tau / dt)
  }

  /** raw/out: xyz per point in pixels. tSec: camera timestamp. scale: inter-ocular distance in px. */
  fun filter(raw: FloatArray, tSec: Double, scale: Float, out: FloatArray) {
    var cx = 0f; var cy = 0f
    for (i in 0 until n) { cx += raw[i * 3]; cy += raw[i * 3 + 1] }
    cx /= n; cy /= n

    if (!initialized || tSec <= lastT) {
      System.arraycopy(raw, 0, x, 0, n * 3)
      dx.fill(0f); globalSpeed = 0f
      prevCx = cx; prevCy = cy; lastT = tSec; initialized = true
      System.arraycopy(x, 0, out, 0, n * 3)
      return
    }
    val dt = min(max((tSec - lastT).toFloat(), 1f / 240f), 0.2f)
    lastT = tSec
    val invScale = 1f / max(scale, 1f)
    val aD = alpha(dCutoff, dt)
    val gs = hypot(cx - prevCx, cy - prevCy) * invScale / dt
    prevCx = cx; prevCy = cy
    globalSpeed += aD * (gs - globalSpeed)

    for (i in 0 until n) {
      val o = i * 3
      val ex = raw[o] - x[o]
      val ey = raw[o + 1] - x[o + 1]
      val speed = hypot(ex, ey) * invScale / dt
      dx[i] += aD * (speed - dx[i])
      val local = max(0f, dx[i] - localDeadzone)
      val a = alpha(minCut[i] + beta * max(local, globalSpeed), dt)
      x[o] += a * ex
      x[o + 1] += a * ey
      x[o + 2] += a * (raw[o + 2] - x[o + 2])
    }
    System.arraycopy(x, 0, out, 0, n * 3)
  }
}
