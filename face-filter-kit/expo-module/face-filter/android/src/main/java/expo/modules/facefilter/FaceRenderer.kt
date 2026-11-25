package expo.modules.facefilter

import android.content.Context
import android.graphics.BitmapFactory
import android.opengl.GLES11Ext
import android.opengl.GLES30
import android.opengl.GLUtils
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

/**
 * GLES 3.0 port of web/src/engine/GLRenderer.ts, running the SAME shader files (assets/facefilter).
 * Must be created and used on the GL thread that owns the camera texture (the SurfaceTextureHelper
 * thread react-native-webrtc calls processors on).
 *
 * Texture convention everywhere: memory row 0 = image top ("image space", same as web and iOS).
 */
class FaceRenderer(context: Context) {
  class Target(val tex: Int, val fbo: Int, val w: Int, val h: Int, val depth: Int = 0)

  data class Geometry(
    val points: FloatArray,      // 468 x (x, y, z), image space 0..1
    val skinRef: FloatArray,     // 2
    val lipRef: FloatArray,      // 2
    val iodPx: Float,
  )

  private val pCopy: GlProgram
  private val pPrep: GlProgram
  private val pDown: GlProgram
  private val pBilateral: GlProgram
  private val pGauss: GlProgram
  private val pMesh: GlProgram
  private val pComposite: GlProgram
  private val emptyVao: Int
  private val meshVao: Int
  private val meshPosBuf: Int
  private val triCount: Int
  private val atlasTex: Int
  private val posScratch: FloatBuffer = ByteBuffer.allocateDirect(468 * 3 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()

  private var frame: Target? = null
  private var half: Target? = null
  private var halfB: Target? = null
  private var smooth: Target? = null
  private var quarter: Target? = null
  private var quarterB: Target? = null
  private var mask: Target? = null
  private var prep: Target? = null
  private var prepPixels: ByteBuffer? = null

  val lipIndices: IntArray
  val eyeCorners: IntArray
  val cheekSample: IntArray
  val lowerLipBody: IntArray

  init {
    val a = context.assets
    fun src(name: String) = a.open("facefilter/$name").bufferedReader().use { it.readText() }
    val vs = src("fullscreen.vert")
    pCopy = GlProgram(vs, src("copy_oes.frag"))
    pPrep = GlProgram(vs, src("prep_input.frag"))
    pDown = GlProgram(vs, src("down2.frag"))
    pBilateral = GlProgram(vs, src("bilateral.frag"))
    pGauss = GlProgram(vs, src("gauss.frag"))
    pMesh = GlProgram(src("mesh.vert"), src("mesh.frag"))
    pComposite = GlProgram(vs, src("composite.frag"))

    // mesh data shared with web/iOS
    val mesh = JSONObject(src("face_mesh.json"))
    val uvJ = mesh.getJSONArray("uv")
    val triJ = mesh.getJSONArray("triangles")
    val groups = mesh.getJSONObject("groups")
    fun ints(name: String) = groups.getJSONArray(name).let { arr -> IntArray(arr.length()) { arr.getInt(it) } }
    lipIndices = (ints("lipsOuter") + ints("lipsInner")).distinct().toIntArray()
    eyeCorners = ints("eyeCorners")
    cheekSample = ints("cheekSample")
    lowerLipBody = ints("lowerLipBody")
    val uv = FloatArray(uvJ.length()) { uvJ.getDouble(it).toFloat() }
    val tris = ShortArray(triJ.length()) { triJ.getInt(it).toShort() }
    triCount = tris.size

    val ids = IntArray(3)
    GLES30.glGenVertexArrays(2, ids, 0)
    emptyVao = ids[0]; meshVao = ids[1]
    GLES30.glBindVertexArray(meshVao)
    GLES30.glGenBuffers(3, ids, 0)
    meshPosBuf = ids[0]
    GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, meshPosBuf)
    GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, 468 * 3 * 4, null, GLES30.GL_DYNAMIC_DRAW)
    val locPos = GLES30.glGetAttribLocation(pMesh.id, "aPos")
    GLES30.glEnableVertexAttribArray(locPos)
    GLES30.glVertexAttribPointer(locPos, 3, GLES30.GL_FLOAT, false, 0, 0)
    GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, ids[1])
    GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, uv.size * 4, floatBuf(uv), GLES30.GL_STATIC_DRAW)
    val locUv = GLES30.glGetAttribLocation(pMesh.id, "aUv")
    GLES30.glEnableVertexAttribArray(locUv)
    GLES30.glVertexAttribPointer(locUv, 2, GLES30.GL_FLOAT, false, 0, 0)
    GLES30.glBindBuffer(GLES30.GL_ELEMENT_ARRAY_BUFFER, ids[2])
    val ib = ByteBuffer.allocateDirect(tris.size * 2).order(ByteOrder.nativeOrder()).asShortBuffer().put(tris)
    ib.position(0)
    GLES30.glBufferData(GLES30.GL_ELEMENT_ARRAY_BUFFER, tris.size * 2, ib, GLES30.GL_STATIC_DRAW)
    GLES30.glBindVertexArray(0)

    // atlas: Bitmap row 0 = image top, uploaded as memory row 0 (matches top-left UVs)
    val bmp = a.open("facefilter/makeup_atlas.png").use {
      BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inPremultiplied = false; inScaled = false })
    }!!
    atlasTex = newTexture()
    GLUtils.texImage2D(GLES30.GL_TEXTURE_2D, 0, bmp, 0)
    GLES30.glGenerateMipmap(GLES30.GL_TEXTURE_2D)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR_MIPMAP_LINEAR)
    bmp.recycle()
  }

  /** Pass 0: camera OES texture -> RGBA frame texture (applies the TextureBuffer transform). */
  fun copyCamera(oesTex: Int, texMatrix: FloatArray, w: Int, h: Int): Target {
    ensureTargets(w, h)
    val t = frame!!
    fullscreen(pCopy, t) {
      GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
      GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex)
      GLES30.glUniform1i(pCopy.u("uCamera"), 0)
      GLES30.glUniformMatrix4fv(pCopy.u("uTexMatrix"), 1, false, texMatrix, 0)
    }
    return t
  }

  /**
   * Pass 1: small upright RGBA copy for the landmark model, read back to CPU.
   * prepMatrix (column-major 3x3) maps upright 0..1 coords -> frame image-space coords.
   */
  fun readModelInput(prepMatrix: FloatArray, outW: Int, outH: Int): ByteBuffer {
    var p = prep
    if (p == null || p.w != outW || p.h != outH) {
      p?.let { free(it) }
      p = target(outW, outH); prep = p
      prepPixels = ByteBuffer.allocateDirect(outW * outH * 4).order(ByteOrder.nativeOrder())
    }
    fullscreen(pPrep, p) {
      bindTex(0, frame!!.tex, pPrep.u("uFrame"))
      GLES30.glUniformMatrix3fv(pPrep.u("uPrep"), 1, false, prepMatrix, 0)
    }
    val buf = prepPixels!!
    buf.position(0)
    GLES30.glReadPixels(0, 0, outW, outH, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, buf) // memory row 0 = image top
    buf.position(0)
    return buf
  }

  /** Passes 2-6: blur chains, this frame's face masks, composite into [out]. */
  fun render(params: FilterParams, face: Geometry?, fade: Float, out: Target) {
    val f = frame ?: return
    val W = f.w; val H = f.h
    GLES30.glDisable(GLES30.GL_BLEND)
    GLES30.glDisable(GLES30.GL_DEPTH_TEST)
    GLES30.glBindVertexArray(emptyVao)
    val faceOn = face != null && fade > 0.001f
    val needSmooth = faceOn && params.skinEnabled && params.skinSmooth > 0f
    val h1 = half!!; val h2 = halfB!!; val sm = smooth!!; val q1 = quarter!!; val q2 = quarterB!!; val mk = mask!!

    fullscreen(pDown, h1) { bindTex(0, f.tex, pDown.u("uTex")); GLES30.glUniform2f(pDown.u("uSrcTexel"), 1f / W, 1f / H) }
    if (needSmooth && face != null) {
      val radius = (face.iodPx / 110f).coerceIn(0.75f, 3f)
      val sigma = 0.05f + 0.05f * params.skinSmooth
      fullscreen(pBilateral, h2) {
        bindTex(0, h1.tex, pBilateral.u("uTex")); GLES30.glUniform2f(pBilateral.u("uStep"), radius / h1.w, 0f)
        GLES30.glUniform1f(pBilateral.u("uSigmaRange"), sigma)
      }
      fullscreen(pBilateral, sm) {
        bindTex(0, h2.tex, pBilateral.u("uTex")); GLES30.glUniform2f(pBilateral.u("uStep"), 0f, radius / h1.h)
        GLES30.glUniform1f(pBilateral.u("uSigmaRange"), sigma)
      }
    }
    fullscreen(pDown, q1) { bindTex(0, h1.tex, pDown.u("uTex")); GLES30.glUniform2f(pDown.u("uSrcTexel"), 1f / h1.w, 1f / h1.h) }
    fullscreen(pGauss, q2) { bindTex(0, q1.tex, pGauss.u("uTex")); GLES30.glUniform2f(pGauss.u("uStep"), 1f / q1.w, 0f) }
    fullscreen(pGauss, q1) { bindTex(0, q2.tex, pGauss.u("uTex")); GLES30.glUniform2f(pGauss.u("uStep"), 0f, 1f / q1.h) }

    // masks from THIS frame's mesh
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, mk.fbo)
    GLES30.glViewport(0, 0, W, H)
    GLES30.glClearColor(0f, 0f, 0f, 1f)
    GLES30.glClearDepthf(1f)
    GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT or GLES30.GL_DEPTH_BUFFER_BIT)
    if (faceOn && face != null) {
      GLES30.glEnable(GLES30.GL_DEPTH_TEST)
      GLES30.glDepthFunc(GLES30.GL_LESS)
      GLES30.glUseProgram(pMesh.id)
      posScratch.position(0); posScratch.put(face.points, 0, 468 * 3); posScratch.position(0)
      GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, meshPosBuf)
      GLES30.glBufferSubData(GLES30.GL_ARRAY_BUFFER, 0, 468 * 3 * 4, posScratch)
      bindTex(0, atlasTex, pMesh.u("uAtlas"))
      GLES30.glUniform1f(pMesh.u("uDepthScale"), 4f)
      GLES30.glBindVertexArray(meshVao)
      GLES30.glDrawElements(GLES30.GL_TRIANGLES, triCount, GLES30.GL_UNSIGNED_SHORT, 0)
      GLES30.glBindVertexArray(emptyVao)
      GLES30.glDisable(GLES30.GL_DEPTH_TEST)
    }

    val c = pComposite
    fullscreen(c, out) {
      bindTex(0, f.tex, c.u("uFrame"))
      bindTex(1, mk.tex, c.u("uMask"))
      bindTex(2, if (needSmooth) sm.tex else h1.tex, c.u("uSmooth"))
      bindTex(3, q1.tex, c.u("uBlur"))
      GLES30.glUniform2f(c.u("uTexel"), 1f / W, 1f / H)
      GLES30.glUniform1f(c.u("uFade"), if (faceOn) fade else 0f)
      GLES30.glUniform3fv(c.u("uLipColor"), 1, params.lipColor, 0)
      GLES30.glUniform1f(c.u("uLipOpacity"), if (params.lipsEnabled) params.lipOpacity else 0f)
      GLES30.glUniform1f(c.u("uLipCoverage"), params.lipCoverage)
      GLES30.glUniform1f(c.u("uLipTexture"), params.lipTexture)
      GLES30.glUniform1f(c.u("uLipGloss"), params.lipGloss)
      GLES30.glUniform1f(c.u("uLipRefine"), params.lipRefine)
      GLES30.glUniform2fv(c.u("uSkinRefPos"), 1, face?.skinRef ?: FloatArray(2), 0)
      GLES30.glUniform2fv(c.u("uLipRefPos"), 1, face?.lipRef ?: FloatArray(2), 0)
      GLES30.glUniform3fv(c.u("uBlushColor"), 1, params.blushColor, 0)
      GLES30.glUniform1f(c.u("uBlushIntensity"), if (params.blushEnabled) params.blushIntensity else 0f)
      GLES30.glUniform1f(c.u("uSmoothAmount"), if (needSmooth) params.skinSmooth else 0f)
      GLES30.glUniform1f(c.u("uPoreKeep"), params.skinPoreKeep)
      GLES30.glUniform1f(c.u("uBrighten"), params.skinBrighten)
      GLES30.glUniform1f(c.u("uSplit"), 0f)
      GLES30.glUniform1i(c.u("uDebug"), 0)
    }
  }

  /** New RGBA8 render target (used by the output pool). */
  fun target(w: Int, h: Int, withDepth: Boolean = false): Target {
    val tex = newTexture()
    GLES30.glTexStorage2D(GLES30.GL_TEXTURE_2D, 1, GLES30.GL_RGBA8, w, h)
    val ids = IntArray(1)
    GLES30.glGenFramebuffers(1, ids, 0)
    val fbo = ids[0]
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo)
    GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, tex, 0)
    var depth = 0
    if (withDepth) {
      GLES30.glGenRenderbuffers(1, ids, 0); depth = ids[0]
      GLES30.glBindRenderbuffer(GLES30.GL_RENDERBUFFER, depth)
      GLES30.glRenderbufferStorage(GLES30.GL_RENDERBUFFER, GLES30.GL_DEPTH_COMPONENT16, w, h)
      GLES30.glFramebufferRenderbuffer(GLES30.GL_FRAMEBUFFER, GLES30.GL_DEPTH_ATTACHMENT, GLES30.GL_RENDERBUFFER, depth)
    }
    check(GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER) == GLES30.GL_FRAMEBUFFER_COMPLETE) { "framebuffer incomplete" }
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
    return Target(tex, fbo, w, h, depth)
  }

  fun free(t: Target) {
    GLES30.glDeleteTextures(1, intArrayOf(t.tex), 0)
    GLES30.glDeleteFramebuffers(1, intArrayOf(t.fbo), 0)
    if (t.depth != 0) GLES30.glDeleteRenderbuffers(1, intArrayOf(t.depth), 0)
  }

  fun release() {
    listOfNotNull(frame, half, halfB, smooth, quarter, quarterB, mask, prep).forEach { free(it) }
    listOf(pCopy, pPrep, pDown, pBilateral, pGauss, pMesh, pComposite).forEach { it.release() }
    GLES30.glDeleteTextures(1, intArrayOf(atlasTex), 0)
  }

  // ------------------------------------------------------------------ helpers

  private fun ensureTargets(w: Int, h: Int) {
    if (frame?.w == w && frame?.h == h) return
    listOfNotNull(frame, half, halfB, smooth, quarter, quarterB, mask).forEach { free(it) }
    val hw = maxOf(1, w shr 1); val hh = maxOf(1, h shr 1)
    val qw = maxOf(1, w shr 2); val qh = maxOf(1, h shr 2)
    frame = target(w, h)
    half = target(hw, hh); halfB = target(hw, hh); smooth = target(hw, hh)
    quarter = target(qw, qh); quarterB = target(qw, qh)
    mask = target(w, h, withDepth = true)
  }

  private inline fun fullscreen(p: GlProgram, t: Target, set: () -> Unit) {
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, t.fbo)
    GLES30.glViewport(0, 0, t.w, t.h)
    GLES30.glUseProgram(p.id)
    GLES30.glUniform1f(p.u("uFlipY"), 0f)
    set()
    GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
  }

  private fun bindTex(unit: Int, tex: Int, loc: Int) {
    GLES30.glActiveTexture(GLES30.GL_TEXTURE0 + unit)
    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, tex)
    GLES30.glUniform1i(loc, unit)
  }

  private fun newTexture(): Int {
    val ids = IntArray(1)
    GLES30.glGenTextures(1, ids, 0)
    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, ids[0])
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
    return ids[0]
  }

  private fun floatBuf(a: FloatArray): FloatBuffer =
    ByteBuffer.allocateDirect(a.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().put(a).also { it.position(0) }
}

/** Compiled program with cached uniform locations. */
class GlProgram(vs: String, fs: String) {
  val id: Int
  private val cache = HashMap<String, Int>()

  init {
    fun compile(type: Int, src: String): Int {
      val s = GLES30.glCreateShader(type)
      GLES30.glShaderSource(s, src)
      GLES30.glCompileShader(s)
      val ok = IntArray(1)
      GLES30.glGetShaderiv(s, GLES30.GL_COMPILE_STATUS, ok, 0)
      check(ok[0] != 0) { "shader compile failed: " + GLES30.glGetShaderInfoLog(s) }
      return s
    }
    id = GLES30.glCreateProgram()
    GLES30.glAttachShader(id, compile(GLES30.GL_VERTEX_SHADER, vs))
    GLES30.glAttachShader(id, compile(GLES30.GL_FRAGMENT_SHADER, fs))
    GLES30.glLinkProgram(id)
    val ok = IntArray(1)
    GLES30.glGetProgramiv(id, GLES30.GL_LINK_STATUS, ok, 0)
    check(ok[0] != 0) { "program link failed: " + GLES30.glGetProgramInfoLog(id) }
  }

  fun u(name: String): Int = cache.getOrPut(name) { GLES30.glGetUniformLocation(id, name) }
  fun release() = GLES30.glDeleteProgram(id)
}
