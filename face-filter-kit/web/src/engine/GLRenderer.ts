import fullscreenVert from "../../../shared/shaders/fullscreen.vert?raw";
import down2Frag from "../../../shared/shaders/down2.frag?raw";
import bilateralFrag from "../../../shared/shaders/bilateral.frag?raw";
import gaussFrag from "../../../shared/shaders/gauss.frag?raw";
import meshVert from "../../../shared/shaders/mesh.vert?raw";
import meshFrag from "../../../shared/shaders/mesh.frag?raw";
import compositeFrag from "../../../shared/shaders/composite.frag?raw";
import { FACE_TRIANGLES, FACE_UV } from "./faceMeshData";
import type { FilterParams } from "./types";

type Uniforms = Record<string, WebGLUniformLocation | null>;
interface Program { prog: WebGLProgram; u: Uniforms }
interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number; depth?: WebGLRenderbuffer }

export interface FaceGeometry {
  /** 468 x (x, y, z) in image space: x, y in 0..1 (top-left origin), z scaled like x. */
  points: Float32Array;
  /** Image-space reference points for lip-edge refinement. */
  skinRef: [number, number];
  lipRef: [number, number];
  /** Inter-ocular distance in pixels (drives smoothing radius). */
  iodPx: number;
  /** Face reshape ops for this frame (see warp.ts); count 0 = no reshape. */
  warpA?: Float32Array;
  warpB?: Float32Array;
  warpCount?: number;
}

export interface RenderOptions {
  fade: number;      // 0..1
  split: number;     // before/after divider, 0 = off
  debugMasks: boolean;
  flipY: boolean;    // true when drawing to the canvas
}

const NUM_VERTS = 468;

/**
 * WebGL2 implementation of the shared render graph:
 *   frame -> half (down2) -> bilateral H/V (skin) ; half -> quarter -> gauss H/V (local mean)
 *   face mesh (this frame's landmarks) -> mask target (lips/blush/skin, depth tested)
 *   composite -> canvas
 * Android runs the same GLSL; iOS runs a Metal port of it.
 */
export class GLRenderer {
  readonly gl: WebGL2RenderingContext;
  private frameTex: WebGLTexture;
  private frameW = 0;
  private frameH = 0;
  private atlas: WebGLTexture;
  private atlasReady = false;
  private pDown: Program;
  private pBilateral: Program;
  private pGauss: Program;
  private pMesh: Program;
  private pComposite: Program;
  private emptyVao: WebGLVertexArrayObject;
  private meshVao: WebGLVertexArrayObject;
  private meshPosBuf: WebGLBuffer;
  private half?: Target;
  private halfB?: Target;
  private smooth?: Target;
  private quarter?: Target;
  private quarterB?: Target;
  private mask?: Target;

  constructor(private canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
      powerPreference: "high-performance", desynchronized: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;

    this.pDown = this.program(fullscreenVert, down2Frag);
    this.pBilateral = this.program(fullscreenVert, bilateralFrag);
    this.pGauss = this.program(fullscreenVert, gaussFrag);
    this.pMesh = this.program(meshVert, meshFrag);
    this.pComposite = this.program(fullscreenVert, compositeFrag);

    this.frameTex = this.texture();
    this.atlas = this.texture();
    this.emptyVao = gl.createVertexArray()!;

    // Face mesh: dynamic positions (this frame's landmarks), static UVs and triangles.
    this.meshVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.meshVao);
    this.meshPosBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, NUM_VERTS * 3 * 4, gl.DYNAMIC_DRAW);
    const locPos = gl.getAttribLocation(this.pMesh.prog, "aPos");
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 3, gl.FLOAT, false, 0, 0);
    const uvBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, FACE_UV, gl.STATIC_DRAW);
    const locUv = gl.getAttribLocation(this.pMesh.prog, "aUv");
    gl.enableVertexAttribArray(locUv);
    gl.vertexAttribPointer(locUv, 2, gl.FLOAT, false, 0, 0);
    const idx = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, FACE_TRIANGLES, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  async loadAtlas(url: string): Promise<void> {
    const img = await createImageBitmap(await (await fetch(url)).blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    this.setAtlas(img);
  }

  setAtlas(img: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.atlasReady = true;
  }

  /** Uploads the camera frame. Row 0 of the source = row 0 of the texture (image space). */
  uploadFrame(src: TexImageSource, w: number, h: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (w !== this.frameW || h !== this.frameH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
      this.frameW = w;
      this.frameH = h;
      this.allocTargets(w, h);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }
  }

  render(params: FilterParams, face: FaceGeometry | null, opt: RenderOptions): void {
    const gl = this.gl;
    const W = this.frameW, H = this.frameH;
    if (!W || !this.half || !this.halfB || !this.smooth || !this.quarter || !this.quarterB || !this.mask) return;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.emptyVao);

    const faceOn = !!face && opt.fade > 0.001 && this.atlasReady;
    const needSmooth = faceOn && params.skin.enabled && params.skin.smooth > 0;

    // 1. half-res copy (input to both blur chains)
    this.fullscreen(this.pDown, this.half, (u) => {
      this.bindTex(0, this.frameTex, u.uTex);
      gl.uniform2f(u.uSrcTexel, 1 / W, 1 / H);
    });

    // 2. skin smoothing: separable bilateral, radius follows face size
    if (needSmooth && face) {
      const radius = Math.min(Math.max(face.iodPx / 110, 0.75), 3.0);
      const hw = this.half.w, hh = this.half.h;
      const sigma = 0.05 + 0.05 * params.skin.smooth;
      this.fullscreen(this.pBilateral, this.halfB, (u) => {
        this.bindTex(0, this.half!.tex, u.uTex);
        gl.uniform2f(u.uStep, radius / hw, 0);
        gl.uniform1f(u.uSigmaRange, sigma);
      });
      this.fullscreen(this.pBilateral, this.smooth, (u) => {
        this.bindTex(0, this.halfB!.tex, u.uTex);
        gl.uniform2f(u.uStep, 0, radius / hh);
        gl.uniform1f(u.uSigmaRange, sigma);
      });
    }

    // 3. quarter-res gaussian = local mean (lip texture transfer + colour references)
    this.fullscreen(this.pDown, this.quarter, (u) => {
      this.bindTex(0, this.half!.tex, u.uTex);
      gl.uniform2f(u.uSrcTexel, 1 / this.half!.w, 1 / this.half!.h);
    });
    this.fullscreen(this.pGauss, this.quarterB, (u) => {
      this.bindTex(0, this.quarter!.tex, u.uTex);
      gl.uniform2f(u.uStep, 1 / this.quarter!.w, 0);
    });
    this.fullscreen(this.pGauss, this.quarter, (u) => {
      this.bindTex(0, this.quarterB!.tex, u.uTex);
      gl.uniform2f(u.uStep, 0, 1 / this.quarter!.h);
    });

    // 4. masks from THIS frame's mesh
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mask.fbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (faceOn && face) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.useProgram(this.pMesh.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPosBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, face.points.subarray(0, NUM_VERTS * 3));
      this.bindTex(0, this.atlas, this.pMesh.u.uAtlas);
      gl.uniform1f(this.pMesh.u.uDepthScale, 4.0);
      gl.bindVertexArray(this.meshVao);
      gl.drawElements(gl.TRIANGLES, FACE_TRIANGLES.length, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(this.emptyVao);
      gl.disable(gl.DEPTH_TEST);
    }

    // 5. composite to the canvas
    const c = this.canvas;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const P = this.pComposite;
    gl.useProgram(P.prog);
    const u = P.u;
    gl.uniform1f(u.uFlipY, opt.flipY ? 1 : 0);
    this.bindTex(0, this.frameTex, u.uFrame);
    this.bindTex(1, this.mask.tex, u.uMask);
    this.bindTex(2, needSmooth ? this.smooth.tex : this.half.tex, u.uSmooth);
    this.bindTex(3, this.quarter.tex, u.uBlur);
    gl.uniform2f(u.uTexel, 1 / W, 1 / H);
    gl.uniform1f(u.uFade, faceOn ? opt.fade : 0);
    const L = params.lips, B = params.blush, S = params.skin, T = params.tone;
    const tone = T.enabled ? T : null;
    const warps = faceOn && face?.warpCount ? face.warpCount : 0;
    gl.uniform2f(u.uSize, W, H);
    gl.uniform1i(u.uWarpCount, warps);
    if (warps && face?.warpA && face.warpB) {
      gl.uniform4fv(u["uWarpA[0]"], face.warpA);
      gl.uniform2fv(u["uWarpB[0]"], face.warpB);
    }
    gl.uniform1f(u.uTan, S.enabled ? S.tan : 0);
    gl.uniform1f(u.uWarmth, tone ? tone.warmth : 0);
    gl.uniform1f(u.uSaturation, tone ? tone.saturation : 0);
    gl.uniform1f(u.uContrast, tone ? tone.contrast : 0);
    gl.uniform1f(u.uExposure, tone ? tone.brightness : 0);
    gl.uniform1f(u.uGlow, tone ? tone.glow : 0);
    gl.uniform1f(u.uVignette, tone ? tone.vignette : 0);
    gl.uniform1f(u.uSharpen, tone ? tone.sharpen : 0);
    gl.uniform3fv(u.uLipColor, L.color);
    gl.uniform1f(u.uLipOpacity, L.enabled ? L.opacity : 0);
    gl.uniform1f(u.uLipCoverage, L.coverage);
    gl.uniform1f(u.uLipTexture, L.texture);
    gl.uniform1f(u.uLipGloss, L.gloss);
    gl.uniform1f(u.uLipRefine, L.refine);
    gl.uniform2fv(u.uSkinRefPos, face ? face.skinRef : [0, 0]);
    gl.uniform2fv(u.uLipRefPos, face ? face.lipRef : [0, 0]);
    gl.uniform3fv(u.uBlushColor, B.color);
    gl.uniform1f(u.uBlushIntensity, B.enabled ? B.intensity : 0);
    gl.uniform1f(u.uSmoothAmount, needSmooth ? S.smooth : 0);
    gl.uniform1f(u.uPoreKeep, S.poreKeep);
    gl.uniform1f(u.uBrighten, S.brighten);
    gl.uniform1f(u.uSplit, opt.split);
    gl.uniform1i(u.uDebug, opt.debugMasks ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy(): void {
    const ext = this.gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
  }

  // ------------------------------------------------------------------ helpers

  private fullscreen(p: Program, t: Target, set: (u: Uniforms) => void): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.useProgram(p.prog);
    gl.uniform1f(p.u.uFlipY, 0);
    set(p.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindTex(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private target(w: number, h: number, withDepth = false): Target {
    const gl = this.gl;
    const tex = this.texture();
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let depth: WebGLRenderbuffer | undefined;
    if (withDepth) {
      depth = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete: 0x${status.toString(16)}`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h, depth };
  }

  private freeTarget(t?: Target): void {
    if (!t) return;
    const gl = this.gl;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
    if (t.depth) gl.deleteRenderbuffer(t.depth);
  }

  private allocTargets(w: number, h: number): void {
    [this.half, this.halfB, this.smooth, this.quarter, this.quarterB, this.mask].forEach((t) => this.freeTarget(t));
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.half = this.target(hw, hh);
    this.halfB = this.target(hw, hh);
    this.smooth = this.target(hw, hh);
    this.quarter = this.target(qw, qh);
    this.quarterB = this.target(qw, qh);
    this.mask = this.target(w, h, true);
  }

  private program(vs: string, fs: string): Program {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link failed");
    const u: Uniforms = {};
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(prog, i)!;
      u[info.name] = gl.getUniformLocation(prog, info.name);
    }
    return { prog, u };
  }
}
