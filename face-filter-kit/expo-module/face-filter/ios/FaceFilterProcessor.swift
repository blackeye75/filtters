import CoreVideo
import Foundation
import MediaPipeTasksVision
import QuartzCore
import WebRTC
import simd

/// Shared between the JS module and the capture queue.
final class FaceFilterState {
  static let shared = FaceFilterState()
  private let lock = NSLock()
  private var _params = FilterParams()
  var params: FilterParams {
    get { lock.lock(); defer { lock.unlock() }; return _params }
    set { lock.lock(); _params = newValue; lock.unlock() }
  }
  var enabled = true
  var stats: [String: Any] = [:]
}

/// MediaPipe Face Landmarker, VIDEO mode (synchronous, tracks between frames).
final class FaceTracker {
  private var landmarker: FaceLandmarker?
  private(set) var delegateName = "none"
  private var lastTs = -1

  init(modelPath: String) {
    for delegate in [Delegate.GPU, Delegate.CPU] {
      let o = FaceLandmarkerOptions()
      o.baseOptions.modelAssetPath = modelPath
      o.baseOptions.delegate = delegate
      o.runningMode = .video
      o.numFaces = 1
      o.minFaceDetectionConfidence = 0.5
      o.minFacePresenceConfidence = 0.5
      o.minTrackingConfidence = 0.5
      o.outputFaceBlendshapes = false
      o.outputFacialTransformationMatrixes = false
      if let lm = try? FaceLandmarker(options: o) {
        landmarker = lm
        delegateName = delegate == .GPU ? "GPU" : "CPU"
        break
      }
    }
  }

  /// (u, v, z) per landmark in the upright input image, or nil.
  func detect(_ pb: CVPixelBuffer, timestampMs: Int) -> [SIMD3<Float>]? {
    guard let lm = landmarker, let img = try? MPImage(pixelBuffer: pb) else { return nil }
    let ts = timestampMs > lastTs ? timestampMs : lastTs + 1
    lastTs = ts
    guard let res = try? lm.detect(videoFrame: img, timestampInMilliseconds: ts),
          let face = res.faceLandmarks.first, face.count >= 468 else { return nil }
    return face.map { SIMD3($0.x, $0.y, $0.z) }
  }
}

/// react-native-webrtc calls `capturer:didCaptureVideoFrame:` on the camera queue for every frame.
/// We return a NEW frame with the makeup painted in; preview and encoder get identical pixels.
/// Registered through the ObjC runtime (see FaceFilterModule), so no react-native-webrtc headers are
/// needed in Swift.
@objc(FaceFilterProcessor)
public final class FaceFilterProcessor: NSObject {
  @objc public static let shared = FaceFilterProcessor()

  private var renderer: MetalRenderer?
  private var tracker: FaceTracker?
  private var smoother: LandmarkSmoother?
  private var mesh: FaceMeshData?
  private var initTried = false

  private var raw = [Float](repeating: 0, count: 468 * 3)
  private var smoothed = [Float](repeating: 0, count: 468 * 3)
  private var haveFace = false
  private var missing = 0
  private var fade: Float = 0
  private var lastNs: Int64 = 0
  private var lastIod: Float = 120
  private var rotationFlip = false, rotationLocked = false, framesWithoutFace = 0

  private let holdFrames = 2
  private let fadeSeconds: Float = 0.1

  @objc(capturer:didCaptureVideoFrame:)
  public func process(_ capturer: RTCVideoCapturer, frame: RTCVideoFrame) -> RTCVideoFrame {
    guard FaceFilterState.shared.enabled, let pb = (frame.buffer as? RTCCVPixelBuffer)?.pixelBuffer, setup() else { return frame }
    let r = renderer!, tr = tracker!, sm = smoother!
    let params = FaceFilterState.shared.params
    let t0 = CACurrentMediaTime()
    let W = CVPixelBufferGetWidth(pb), H = CVPixelBufferGetHeight(pb)

    // 1. camera -> RGBA, small upright copy, blur chains (GPU), then landmarks for THIS frame (CPU/GPU)
    let rot = effectiveRotation(frame.rotation)
    let swap = rot == 90 || rot == 270
    let uW = swap ? H : W, uH = swap ? W : H
    let long = max(uW, uH) > 960 ? 640 : 480
    let s = Float(long) / Float(max(uW, uH))
    let inW = max(16, Int((Float(uW) * s).rounded())), inH = max(16, Int((Float(uH) * s).rounded()))
    let prep = prepMatrix(rot)
    let doSmooth = params.skin.enabled && params.skin.smooth > 0
    let radius = min(max(lastIod / 110, 0.75), 3), sigma = 0.05 + 0.05 * params.skin.smooth
    guard let input = r.prepare(camera: pb, prep: prep, inW: inW, inH: inH, smoothRadius: radius, smoothSigma: sigma, doSmooth: doSmooth) else { return frame }

    let up = tr.detect(input, timestampMs: Int(frame.timeStampNs / 1_000_000))
    let tInfer = CACurrentMediaTime()
    updateRotationProbe(found: up != nil, rotation: frame.rotation)

    // 2. map to frame pixels, smooth, presence and fade
    if let up {
      let zScale = Float(swap ? H : W)
      for i in 0..<468 {
        let p = prep * SIMD3(up[i].x, up[i].y, 1)
        raw[i * 3] = p.x * Float(W); raw[i * 3 + 1] = p.y * Float(H); raw[i * 3 + 2] = up[i].z * zScale
      }
      let iod = self.iod(raw)
      if !haveFace || missing > holdFrames { sm.reset() }
      smoothed = sm.filter(raw, t: Double(frame.timeStampNs) / 1e9, scale: iod)
      lastIod = self.iod(smoothed)
      haveFace = true; missing = 0
    } else if haveFace { missing += 1 }
    let present = haveFace && missing <= holdFrames
    let dt: Float = lastNs != 0 ? min(Float(frame.timeStampNs - lastNs) / 1e9, 0.2) : 1 / 30
    lastNs = frame.timeStampNs
    fade = min(1, max(0, fade + (present ? 1 : -1) * dt / fadeSeconds))
    if !present && fade == 0 { haveFace = false }
    guard haveFace else { publish(t0, tInfer, false); return frame }

    // 3. masks from this frame's mesh + composite -> new pixel buffer
    guard let out = r.render(params: params, face: geometry(W, H), fade: fade, doSmooth: doSmooth) else { return frame }
    publish(t0, tInfer, true)
    return RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: out), rotation: frame.rotation, timeStampNs: frame.timeStampNs)
  }

  // MARK: - helpers

  private func setup() -> Bool {
    if renderer != nil { return true }
    if initTried { return false }
    initTried = true
    guard let bundleURL = Bundle(for: FaceFilterProcessor.self).url(forResource: "FaceFilterAssets", withExtension: "bundle"),
          let bundle = Bundle(url: bundleURL),
          let meshURL = bundle.url(forResource: "face_mesh", withExtension: "json"),
          let atlasURL = bundle.url(forResource: "makeup_atlas", withExtension: "png"),
          let modelPath = bundle.path(forResource: "face_landmarker", ofType: "task"),
          let shaderURL = bundle.url(forResource: "FaceFilterShaders", withExtension: "metalsrc"),
          let shaderSource = try? String(contentsOf: shaderURL, encoding: .utf8),
          let m = FaceMeshData(url: meshURL),
          let r = MetalRenderer(mesh: m, atlasURL: atlasURL, shaderSource: shaderSource) else {
      NSLog("[FaceFilter] setup failed (assets or Metal)"); return false
    }
    mesh = m; renderer = r
    tracker = FaceTracker(modelPath: modelPath)
    smoother = LandmarkSmoother(count: 468, lipIndices: m.lipIndices)
    return true
  }

  private func degrees(_ r: RTCVideoRotation) -> Int {
    switch r { case ._90: return 90; case ._180: return 180; case ._270: return 270; default: return 0 }
  }

  private func effectiveRotation(_ r: RTCVideoRotation) -> Int {
    let d = degrees(r)
    return rotationFlip && (d == 90 || d == 270) ? (d + 180) % 360 : d
  }

  private func updateRotationProbe(found: Bool, rotation: RTCVideoRotation) {
    if rotationLocked { return }
    if found { rotationLocked = true; return }
    let d = degrees(rotation)
    guard d == 90 || d == 270 else { return }
    framesWithoutFace += 1
    if framesWithoutFace >= 8 { rotationFlip.toggle(); framesWithoutFace = 0 }
  }

  /// upright (u, v, 1) -> frame image space (x, y); r = clockwise rotation that makes the frame upright
  private func prepMatrix(_ r: Int) -> simd_float3x3 {
    switch r {
    case 90:  return simd_float3x3(SIMD3(0, -1, 0), SIMD3(1, 0, 0), SIMD3(0, 1, 1))    // x = v,     y = 1 - u
    case 180: return simd_float3x3(SIMD3(-1, 0, 0), SIMD3(0, -1, 0), SIMD3(1, 1, 1))   // x = 1 - u, y = 1 - v
    case 270: return simd_float3x3(SIMD3(0, 1, 0), SIMD3(-1, 0, 0), SIMD3(1, 0, 1))    // x = 1 - v, y = u
    default:  return matrix_identity_float3x3
    }
  }

  private func iod(_ p: [Float]) -> Float {
    guard let e = mesh?.eyeCorners, e.count == 2 else { return 120 }
    let dx = p[e[0] * 3] - p[e[1] * 3], dy = p[e[0] * 3 + 1] - p[e[1] * 3 + 1]
    return (dx * dx + dy * dy).squareRoot()
  }

  private func geometry(_ w: Int, _ h: Int) -> MetalRenderer.Geometry {
    var n = [Float](repeating: 0, count: 468 * 3)
    for i in 0..<468 {
      n[i * 3] = smoothed[i * 3] / Float(w); n[i * 3 + 1] = smoothed[i * 3 + 1] / Float(h); n[i * 3 + 2] = smoothed[i * 3 + 2] / Float(w)
    }
    let m = mesh!
    let nose = 4, cR = m.cheekSample[0], cL = m.cheekSample[1]
    let c = abs(n[cR * 3] - n[nose * 3]) > abs(n[cL * 3] - n[nose * 3]) ? cR : cL
    let l1 = m.lowerLipBody[0], l2 = m.lowerLipBody[1]
    return MetalRenderer.Geometry(points: n,
                                  skinRef: SIMD2(n[c * 3], n[c * 3 + 1]),
                                  lipRef: SIMD2((n[l1 * 3] + n[l2 * 3]) / 2, (n[l1 * 3 + 1] + n[l2 * 3 + 1]) / 2),
                                  iodPx: lastIod)
  }

  private func publish(_ t0: CFTimeInterval, _ tInfer: CFTimeInterval, _ face: Bool) {
    let now = CACurrentMediaTime()
    FaceFilterState.shared.stats = ["inferenceMs": (tInfer - t0) * 1000, "totalMs": (now - t0) * 1000,
                                    "faceFound": face, "delegate": tracker?.delegateName ?? "none"]
  }
}

