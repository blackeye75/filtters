package expo.modules.facefilter

import com.oney.WebRTCModule.videoEffects.ProcessorProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS surface. Registers the processor with react-native-webrtc under the name "faceFilter";
 * JS then enables it on the local camera track with track._setVideoEffects(["faceFilter"]).
 * Parameter changes are a pointer swap read once per frame: no per-frame JS, no bridge traffic.
 */
class FaceFilterModule : Module() {
  private var presets: Map<String, Map<String, Any?>> = emptyMap()

  override fun definition() = ModuleDefinition {
    Name("FaceFilter")

    OnCreate {
      val ctx = appContext.reactContext ?: return@OnCreate
      ProcessorProvider.addProcessor(PROCESSOR_NAME, FaceFilterProcessorFactory(ctx))
      presets = ctx.assets.open("facefilter/presets.json").bufferedReader().use { FilterParams.loadPresets(it.readText()) }
    }

    Constant("processorName") { PROCESSOR_NAME }

    Function("setParams") { partial: Map<String, Any?> ->
      FaceFilterState.params.updateAndGet { it.merge(partial) }
      Unit
    }

    Function("applyPreset") { name: String ->
      val p = presets[name] ?: throw IllegalArgumentException("Unknown preset '$name'")
      FaceFilterState.params.updateAndGet { it.merge(p) }
      Unit
    }

    Function("presetNames") { presets.keys.toList() }

    Function("setEnabled") { on: Boolean -> FaceFilterState.enabled = on }

    Function("getStats") { FaceFilterState.stats }
  }

  companion object { const val PROCESSOR_NAME = "faceFilter" }
}
