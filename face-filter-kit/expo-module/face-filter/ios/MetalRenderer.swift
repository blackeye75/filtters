import CoreVideo
import ImageIO
import Metal
import simd

/// Metal implementation of the shared render graph (see Shaders.metal / shared/shaders).
/// Two command buffers per frame:
///   A) camera -> RGBA, small upright copy for the model, both blur chains  (GPU works while the CPU
///      runs inference on the small copy)
///   B) this frame's face mesh -> masks, composite -> output pixel buffer
final class MetalRenderer {
  struct Geometry {
    var points: [Float]       // 468 x (x, y, z), image space 0..1
    var skinRef: SIMD2<Float>
    var lipRef: SIMD2<Float>
    var iodPx: Float
  }

  struct CompositeU {
    var lipColorOpacity: SIMD4<Float>
    var lipParams: SIMD4<Float>
    var refs: SIMD4<Float>
    var blush: SIMD4<Float>
    var skin: SIMD4<Float>
    var texel: SIMD4<Float>
  }
  private struct StepU { var v: SIMD2<Float>; var sigmaRange: Float; var pad: Float = 0 }
  private struct CopyU { var fullRange: Float; var pad: SIMD3<Float> = .zero }

  let device: MTLDevice
  private let queue: MTLCommandQueue
  private var cache: CVMetalTextureCache!
  private let pCopyNV12, pCopyBGRA, pPrep, pDown, pBilateral, pGauss, pComposite: MTLRenderPipelineState
  private let pMesh: MTLRenderPipelineState
  private let depthState: MTLDepthStencilState
  private let atlas: MTLTexture
  private let uvBuffer: MTLBuffer
  private let indexBuffer: MTLBuffer
  private let indexCount: Int
  private let posBuffer: MTLBuffer

  private var frameTex, half, halfB, smoothT, quarter, quarterB, maskTex: MTLTexture?
  private var depthTex: MTLTexture?
  private var size = (w: 0, h: 0)
  private var outPool: CVPixelBufferPool?
  private var outPoolSize = (w: 0, h: 0)
  private var inPool: CVPixelBufferPool?
  private var inPoolSize = (w: 0, h: 0)
  private var keepAlive: [CVMetalTexture] = []

  /// shaderSource = Shaders.metal, shipped as a resource and compiled once at startup (~50 ms).
  /// Runtime compilation works the same for static and dynamic pod linkage.
  init?(mesh: FaceMeshData, atlasURL: URL, shaderSource: String) {
    guard let dev = MTLCreateSystemDefaultDevice(), let q = dev.makeCommandQueue() else { return nil }
    device = dev; queue = q
    guard CVMetalTextureCacheCreate(nil, nil, dev, nil, &cache) == kCVReturnSuccess else { return nil }
    let lib: MTLLibrary
    do { lib = try dev.makeLibrary(source: shaderSource, options: nil) } catch {
      NSLog("[FaceFilter] Metal compile failed: \(error)"); return nil
    }

    func pipe(_ fs: String, _ fmt: MTLPixelFormat, vs: String = "fullscreen_vs", depth: Bool = false) -> MTLRenderPipelineState? {
      let d = MTLRenderPipelineDescriptor()
      d.vertexFunction = lib.makeFunction(name: vs)
      d.fragmentFunction = lib.makeFunction(name: fs)
      d.colorAttachments[0].pixelFormat = fmt
      if depth { d.depthAttachmentPixelFormat = .depth32Float }
      return try? dev.makeRenderPipelineState(descriptor: d)
    }
    guard let a = pipe("copy_nv12_fs", .rgba8Unorm), let b = pipe("copy_bgra_fs", .rgba8Unorm),
          let c = pipe("prep_fs", .bgra8Unorm), let d = pipe("down2_fs", .rgba8Unorm),
          let e = pipe("bilateral_fs", .rgba8Unorm), let f = pipe("gauss_fs", .rgba8Unorm),
          let g = pipe("composite_fs", .bgra8Unorm),
          let h = pipe("mesh_fs", .rgba8Unorm, vs: "mesh_vs", depth: true) else { return nil }
    pCopyNV12 = a; pCopyBGRA = b; pPrep = c; pDown = d; pBilateral = e; pGauss = f; pComposite = g; pMesh = h

    let ds = MTLDepthStencilDescriptor()
    ds.depthCompareFunction = .less
    ds.isDepthWriteEnabled = true
    depthState = dev.makeDepthStencilState(descriptor: ds)!

    uvBuffer = dev.makeBuffer(bytes: mesh.uv, length: mesh.uv.count * 4)!
    indexBuffer = dev.makeBuffer(bytes: mesh.triangles, length: mesh.triangles.count * 2)!
    indexCount = mesh.triangles.count
    posBuffer = dev.makeBuffer(length: 468 * 3 * 4, options: .storageModeShared)!

    guard let atlasTex = MetalRenderer.loadAtlas(device: dev, url: atlasURL) else { return nil }
    atlas = atlasTex
  }

  // MARK: - Pass group A

  /// Converts the camera buffer, renders the model input, runs both blur chains. Blocks until the
  /// model input is ready and returns it (BGRA pixel buffer, upright, small).
  func prepare(camera: CVPixelBuffer, prep: simd_float3x3, inW: Int, inH: Int, smoothRadius: Float, smoothSigma: Float, doSmooth: Bool) -> CVPixelBuffer? {
    let w = CVPixelBufferGetWidth(camera), h = CVPixelBufferGetHeight(camera)
    ensureTargets(w, h)
    guard let cmd = queue.makeCommandBuffer(), let frameTex, let half, let halfB, let smoothT, let quarter, let quarterB else { return nil }
    keepAlive.removeAll(keepingCapacity: true)

    // camera -> RGBA
    let fmt = CVPixelBufferGetPixelFormatType(camera)
    if fmt == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange || fmt == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange {
      guard let y = wrap(camera, plane: 0, .r8Unorm), let c = wrap(camera, plane: 1, .rg8Unorm) else { return nil }
      var u = CopyU(fullRange: fmt == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange ? 1 : 0)
      pass(cmd, pCopyNV12, frameTex) { e in
        e.setFragmentTexture(y, index: 0); e.setFragmentTexture(c, index: 1)
        e.setFragmentBytes(&u, length: MemoryLayout<CopyU>.stride, index: 0)
      }
    } else if fmt == kCVPixelFormatType_32BGRA {
      guard let t = wrap(camera, plane: -1, .bgra8Unorm) else { return nil }
      pass(cmd, pCopyBGRA, frameTex) { e in e.setFragmentTexture(t, index: 0) }
    } else { return nil }

    // model input
    guard let input = pixelBuffer(&inPool, &inPoolSize, inW, inH), let inTex = wrap(input, plane: -1, .bgra8Unorm) else { return nil }
    var p = prep
    pass(cmd, pPrep, inTex) { e in
      e.setFragmentTexture(frameTex, index: 0)
      e.setFragmentBytes(&p, length: MemoryLayout<simd_float3x3>.stride, index: 0)
    }
    // blur chains (independent of landmarks: they overlap with inference)
    step(cmd, pDown, src: frameTex, dst: half, v: SIMD2(1 / Float(w), 1 / Float(h)))
    if doSmooth {
      step(cmd, pBilateral, src: half, dst: halfB, v: SIMD2(smoothRadius / Float(half.width), 0), sigma: smoothSigma)
      step(cmd, pBilateral, src: halfB, dst: smoothT, v: SIMD2(0, smoothRadius / Float(half.height)), sigma: smoothSigma)
    }
    step(cmd, pDown, src: half, dst: quarter, v: SIMD2(1 / Float(half.width), 1 / Float(half.height)))
    step(cmd, pGauss, src: quarter, dst: quarterB, v: SIMD2(1 / Float(quarter.width), 0))
    step(cmd, pGauss, src: quarterB, dst: quarter, v: SIMD2(0, 1 / Float(quarter.height)))
    cmd.commit()
    cmd.waitUntilCompleted()   // prep is needed now; the blur passes are usually done by then too
    return input
  }

  // MARK: - Pass group B

  func render(params: FilterParams, face: Geometry?, fade: Float, doSmooth: Bool) -> CVPixelBuffer? {
    guard let frameTex, let half, let smoothT, let quarter, let maskTex, let depthTex,
          let cmd = queue.makeCommandBuffer(),
          let out = pixelBuffer(&outPool, &outPoolSize, size.w, size.h), let outTex = wrap(out, plane: -1, .bgra8Unorm) else { return nil }
    let faceOn = face != nil && fade > 0.001

    // masks from THIS frame's mesh
    let rp = MTLRenderPassDescriptor()
    rp.colorAttachments[0].texture = maskTex
    rp.colorAttachments[0].loadAction = .clear
    rp.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
    rp.colorAttachments[0].storeAction = .store
    rp.depthAttachment.texture = depthTex
    rp.depthAttachment.loadAction = .clear
    rp.depthAttachment.clearDepth = 1
    rp.depthAttachment.storeAction = .dontCare
    if let e = cmd.makeRenderCommandEncoder(descriptor: rp) {
      if faceOn, let face {
        face.points.withUnsafeBytes { posBuffer.contents().copyMemory(from: $0.baseAddress!, byteCount: 468 * 3 * 4) }
        var depthScale: Float = 4
        e.setRenderPipelineState(pMesh)
        e.setDepthStencilState(depthState)
        e.setVertexBuffer(posBuffer, offset: 0, index: 0)
        e.setVertexBuffer(uvBuffer, offset: 0, index: 1)
        e.setVertexBytes(&depthScale, length: 4, index: 2)
        e.setFragmentTexture(atlas, index: 0)
        e.drawIndexedPrimitives(type: .triangle, indexCount: indexCount, indexType: .uint16, indexBuffer: indexBuffer, indexBufferOffset: 0)
      }
      e.endEncoding()
    }

    let L = params.lips, B = params.blush, S = params.skin
    var u = CompositeU(
      lipColorOpacity: SIMD4(L.color.x, L.color.y, L.color.z, L.enabled ? L.opacity : 0),
      lipParams: SIMD4(L.coverage, L.texture, L.gloss, L.refine),
      refs: SIMD4(face?.skinRef.x ?? 0, face?.skinRef.y ?? 0, face?.lipRef.x ?? 0, face?.lipRef.y ?? 0),
      blush: SIMD4(B.color.x, B.color.y, B.color.z, B.enabled ? B.intensity : 0),
      skin: SIMD4(doSmooth && faceOn ? S.smooth : 0, S.poreKeep, S.brighten, faceOn ? fade : 0),
      texel: SIMD4(1 / Float(size.w), 1 / Float(size.h), 0, 0))
    pass(cmd, pComposite, outTex) { e in
      e.setFragmentTexture(frameTex, index: 0)
      e.setFragmentTexture(maskTex, index: 1)
      e.setFragmentTexture(doSmooth ? smoothT : half, index: 2)
      e.setFragmentTexture(quarter, index: 3)
      e.setFragmentBytes(&u, length: MemoryLayout<CompositeU>.stride, index: 0)
    }
    cmd.commit()
    cmd.waitUntilCompleted()   // the encoder and preview read the buffer right after we return
    keepAlive.removeAll(keepingCapacity: true)
    return out
  }

  // MARK: - helpers

  private func pass(_ cmd: MTLCommandBuffer, _ p: MTLRenderPipelineState, _ target: MTLTexture, _ set: (MTLRenderCommandEncoder) -> Void) {
    let rp = MTLRenderPassDescriptor()
    rp.colorAttachments[0].texture = target
    rp.colorAttachments[0].loadAction = .dontCare
    rp.colorAttachments[0].storeAction = .store
    guard let e = cmd.makeRenderCommandEncoder(descriptor: rp) else { return }
    e.setRenderPipelineState(p)
    set(e)
    e.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    e.endEncoding()
  }

  private func step(_ cmd: MTLCommandBuffer, _ p: MTLRenderPipelineState, src: MTLTexture, dst: MTLTexture, v: SIMD2<Float>, sigma: Float = 0) {
    var u = StepU(v: v, sigmaRange: sigma)
    pass(cmd, p, dst) { e in
      e.setFragmentTexture(src, index: 0)
      e.setFragmentBytes(&u, length: MemoryLayout<StepU>.stride, index: 0)
    }
  }

  /// plane -1 = non-planar buffer
  private func wrap(_ pb: CVPixelBuffer, plane: Int, _ fmt: MTLPixelFormat) -> MTLTexture? {
    let w = plane < 0 ? CVPixelBufferGetWidth(pb) : CVPixelBufferGetWidthOfPlane(pb, plane)
    let h = plane < 0 ? CVPixelBufferGetHeight(pb) : CVPixelBufferGetHeightOfPlane(pb, plane)
    var cv: CVMetalTexture?
    guard CVMetalTextureCacheCreateTextureFromImage(nil, cache, pb, nil, fmt, w, h, max(plane, 0), &cv) == kCVReturnSuccess,
          let cv, let t = CVMetalTextureGetTexture(cv) else { return nil }
    keepAlive.append(cv)
    return t
  }

  private func pixelBuffer(_ pool: inout CVPixelBufferPool?, _ poolSize: inout (w: Int, h: Int), _ w: Int, _ h: Int) -> CVPixelBuffer? {
    if pool == nil || poolSize != (w, h) {
      let attrs: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: w,
        kCVPixelBufferHeightKey as String: h,
        kCVPixelBufferMetalCompatibilityKey as String: true,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
      ]
      var p: CVPixelBufferPool?
      CVPixelBufferPoolCreate(nil, [kCVPixelBufferPoolMinimumBufferCountKey as String: 4] as CFDictionary, attrs as CFDictionary, &p)
      pool = p; poolSize = (w, h)
    }
    guard let pool else { return nil }
    var pb: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
    return pb
  }

  private func ensureTargets(_ w: Int, _ h: Int) {
    if size == (w, h) { return }
    size = (w, h)
    func tex(_ w: Int, _ h: Int, _ fmt: MTLPixelFormat = .rgba8Unorm) -> MTLTexture? {
      let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: fmt, width: max(1, w), height: max(1, h), mipmapped: false)
      d.usage = [.renderTarget, .shaderRead]
      d.storageMode = .private
      return device.makeTexture(descriptor: d)
    }
    frameTex = tex(w, h)
    half = tex(w / 2, h / 2); halfB = tex(w / 2, h / 2); smoothT = tex(w / 2, h / 2)
    quarter = tex(w / 4, h / 4); quarterB = tex(w / 4, h / 4)
    maskTex = tex(w, h)
    depthTex = tex(w, h, .depth32Float)
  }

  private static func loadAtlas(device: MTLDevice, url: URL) -> MTLTexture? {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
    let w = img.width, h = img.height
    var bytes = [UInt8](repeating: 0, count: w * h * 4)
    guard let ctx = CGContext(data: &bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))   // row 0 = image top in memory
    let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: w, height: h, mipmapped: true)
    d.usage = [.shaderRead]
    guard let t = device.makeTexture(descriptor: d) else { return nil }
    t.replace(region: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0, withBytes: bytes, bytesPerRow: w * 4)
    if let q = device.makeCommandQueue(), let cmd = q.makeCommandBuffer(), let blit = cmd.makeBlitCommandEncoder() {
      blit.generateMipmaps(for: t); blit.endEncoding(); cmd.commit(); cmd.waitUntilCompleted()
    }
    return t
  }
}

