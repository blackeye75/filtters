import Foundation
import simd

// MARK: - Parameters (same fields and defaults as web/src/engine/types.ts and FilterParams.kt)

struct FilterParams {
  struct Lips { var enabled = true; var color = SIMD3<Float>(0.7216, 0.2627, 0.3529); var opacity: Float = 0.75; var coverage: Float = 0.55; var texture: Float = 0.85; var gloss: Float = 0.35; var refine: Float = 0.7 }
  struct Blush { var enabled = true; var color = SIMD3<Float>(0.9412, 0.4784, 0.5255); var intensity: Float = 0.35 }
  struct Skin { var enabled = true; var smooth: Float = 0.5; var poreKeep: Float = 0.35; var brighten: Float = 0.25 }
  var lips = Lips()
  var blush = Blush()
  var skin = Skin()

  /// Merge a partial JS object: { lips?: {...}, blush?: {...}, skin?: {...} }
  func merged(_ m: [String: Any]) -> FilterParams {
    var p = self
    func f(_ d: [String: Any], _ k: String, _ v: Float) -> Float { (d[k] as? NSNumber).map { min(max($0.floatValue, 0), 1) } ?? v }
    func b(_ d: [String: Any], _ k: String, _ v: Bool) -> Bool { d[k] as? Bool ?? v }
    func c(_ d: [String: Any], _ k: String, _ v: SIMD3<Float>) -> SIMD3<Float> {
      guard let a = d[k] as? [NSNumber], a.count >= 3 else { return v }
      return SIMD3(a[0].floatValue, a[1].floatValue, a[2].floatValue)
    }
    if let l = m["lips"] as? [String: Any] {
      p.lips = Lips(enabled: b(l, "enabled", lips.enabled), color: c(l, "color", lips.color), opacity: f(l, "opacity", lips.opacity),
                    coverage: f(l, "coverage", lips.coverage), texture: f(l, "texture", lips.texture), gloss: f(l, "gloss", lips.gloss), refine: f(l, "refine", lips.refine))
    }
    if let bl = m["blush"] as? [String: Any] {
      p.blush = Blush(enabled: b(bl, "enabled", blush.enabled), color: c(bl, "color", blush.color), intensity: f(bl, "intensity", blush.intensity))
    }
    if let s = m["skin"] as? [String: Any] {
      p.skin = Skin(enabled: b(s, "enabled", skin.enabled), smooth: f(s, "smooth", skin.smooth), poreKeep: f(s, "poreKeep", skin.poreKeep), brighten: f(s, "brighten", skin.brighten))
    }
    return p
  }
}

// MARK: - Mesh data (shared/face_mesh.json)

struct FaceMeshData {
  let uv: [Float]
  let triangles: [UInt16]
  let lipIndices: [Int]
  let eyeCorners: [Int]
  let cheekSample: [Int]
  let lowerLipBody: [Int]

  init?(url: URL) {
    guard let data = try? Data(contentsOf: url),
          let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let uv = j["uv"] as? [NSNumber], let tris = j["triangles"] as? [NSNumber],
          let g = j["groups"] as? [String: [NSNumber]] else { return nil }
    self.uv = uv.map { $0.floatValue }
    self.triangles = tris.map { $0.uint16Value }
    func ints(_ k: String) -> [Int] { (g[k] ?? []).map { $0.intValue } }
    lipIndices = Array(Set(ints("lipsOuter") + ints("lipsInner")))
    eyeCorners = ints("eyeCorners"); cheekSample = ints("cheekSample"); lowerLipBody = ints("lowerLipBody")
  }
}

// MARK: - One Euro smoother (port of web/src/engine/OneEuro.ts; the web version has unit tests)

final class LandmarkSmoother {
  private let n: Int
  private var x: [Float]
  private var dx: [Float]
  private var minCut: [Float]
  private let beta: Float = 8, dCutoff: Float = 1, localDeadzone: Float = 0.35
  private var globalSpeed: Float = 0
  private var prevC = SIMD2<Float>(0, 0)
  private var lastT: Double = -1
  private var initialized = false

  init(count: Int, lipIndices: [Int], minCutoff: Float = 1.2, lipMinCutoff: Float = 3.0) {
    n = count
    x = [Float](repeating: 0, count: count * 3)
    dx = [Float](repeating: 0, count: count)
    minCut = [Float](repeating: minCutoff, count: count)
    for i in lipIndices where i < count { minCut[i] = lipMinCutoff }
  }

  func reset() { initialized = false; lastT = -1 }

  private func alpha(_ cutoff: Float, _ dt: Float) -> Float { 1 / (1 + (1 / (2 * .pi * cutoff)) / dt) }

  /// raw: xyz per point in pixels; returns filtered xyz.
  func filter(_ raw: [Float], t: Double, scale: Float) -> [Float] {
    var c = SIMD2<Float>(0, 0)
    for i in 0..<n { c += SIMD2(raw[i * 3], raw[i * 3 + 1]) }
    c /= Float(n)
    if !initialized || t <= lastT {
      x = Array(raw.prefix(n * 3)); dx = [Float](repeating: 0, count: n)
      globalSpeed = 0; prevC = c; lastT = t; initialized = true
      return x
    }
    let dt = min(max(Float(t - lastT), 1 / 240), 0.2)
    lastT = t
    let inv = 1 / max(scale, 1)
    let aD = alpha(dCutoff, dt)
    globalSpeed += aD * (simd_length(c - prevC) * inv / dt - globalSpeed)
    prevC = c
    for i in 0..<n {
      let o = i * 3
      let ex = raw[o] - x[o], ey = raw[o + 1] - x[o + 1]
      dx[i] += aD * ((ex * ex + ey * ey).squareRoot() * inv / dt - dx[i])
      let local = max(0, dx[i] - localDeadzone)
      let a = alpha(minCut[i] + beta * max(local, globalSpeed), dt)
      x[o] += a * ex; x[o + 1] += a * ey; x[o + 2] += a * (raw[o + 2] - x[o + 2])
    }
    return x
  }
}
