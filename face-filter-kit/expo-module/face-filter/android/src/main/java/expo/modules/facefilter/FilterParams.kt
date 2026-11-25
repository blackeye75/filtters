package expo.modules.facefilter

import org.json.JSONObject

/** Immutable snapshot. The JS thread swaps in a new one; the capture thread reads it once per frame. */
data class FilterParams(
  val lipsEnabled: Boolean = true,
  val lipColor: FloatArray = floatArrayOf(0.7216f, 0.2627f, 0.3529f),
  val lipOpacity: Float = 0.75f,
  val lipCoverage: Float = 0.55f,
  val lipTexture: Float = 0.85f,
  val lipGloss: Float = 0.35f,
  val lipRefine: Float = 0.7f,
  val blushEnabled: Boolean = true,
  val blushColor: FloatArray = floatArrayOf(0.9412f, 0.4784f, 0.5255f),
  val blushIntensity: Float = 0.35f,
  val skinEnabled: Boolean = true,
  val skinSmooth: Float = 0.5f,
  val skinPoreKeep: Float = 0.35f,
  val skinBrighten: Float = 0.25f,
) {
  /** Merge a partial JS object: { lips?: {...}, blush?: {...}, skin?: {...} } */
  @Suppress("UNCHECKED_CAST")
  fun merge(m: Map<String, Any?>): FilterParams {
    val l = m["lips"] as? Map<String, Any?> ?: emptyMap()
    val b = m["blush"] as? Map<String, Any?> ?: emptyMap()
    val s = m["skin"] as? Map<String, Any?> ?: emptyMap()
    return copy(
      lipsEnabled = l.bool("enabled", lipsEnabled),
      lipColor = l.rgb("color", lipColor),
      lipOpacity = l.f("opacity", lipOpacity),
      lipCoverage = l.f("coverage", lipCoverage),
      lipTexture = l.f("texture", lipTexture),
      lipGloss = l.f("gloss", lipGloss),
      lipRefine = l.f("refine", lipRefine),
      blushEnabled = b.bool("enabled", blushEnabled),
      blushColor = b.rgb("color", blushColor),
      blushIntensity = b.f("intensity", blushIntensity),
      skinEnabled = s.bool("enabled", skinEnabled),
      skinSmooth = s.f("smooth", skinSmooth),
      skinPoreKeep = s.f("poreKeep", skinPoreKeep),
      skinBrighten = s.f("brighten", skinBrighten),
    )
  }

  companion object {
    private fun Map<String, Any?>.f(k: String, d: Float) = (this[k] as? Number)?.toFloat()?.coerceIn(0f, 1f) ?: d
    private fun Map<String, Any?>.bool(k: String, d: Boolean) = this[k] as? Boolean ?: d
    private fun Map<String, Any?>.rgb(k: String, d: FloatArray): FloatArray {
      val v = this[k] as? List<*> ?: return d
      if (v.size < 3) return d
      return FloatArray(3) { (v[it] as? Number)?.toFloat()?.coerceIn(0f, 1f) ?: d[it] }
    }

    /** presets.json -> map of name to partial params (same file the iOS module and web use). */
    fun loadPresets(json: String): Map<String, Map<String, Any?>> {
      val root = JSONObject(json).getJSONObject("presets")
      return root.keys().asSequence().associateWith { name -> toMap(root.getJSONObject(name)) }
    }

    private fun toMap(o: JSONObject): Map<String, Any?> = o.keys().asSequence().associateWith { k ->
      when (val v = o.get(k)) {
        is JSONObject -> toMap(v)
        is org.json.JSONArray -> List(v.length()) { v.get(it) }
        else -> v
      }
    }
  }
}
