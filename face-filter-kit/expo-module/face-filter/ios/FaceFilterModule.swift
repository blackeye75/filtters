import ExpoModulesCore

/// JS surface. Registers FaceFilterProcessor with react-native-webrtc's ProcessorProvider under
/// "faceFilter" (JS enables it with track._setVideoEffects(["faceFilter"])).
/// Registration goes through the ObjC runtime so this module does not import react-native-webrtc
/// headers into Swift (works with static and dynamic frameworks alike).
public class FaceFilterModule: Module {
  static let processorName = "faceFilter"
  private var presets: [String: [String: Any]] = [:]

  public func definition() -> ModuleDefinition {
    Name("FaceFilter")

    OnCreate {
      if let provider = NSClassFromString("ProcessorProvider") as AnyObject? {
        _ = provider.perform(NSSelectorFromString("addProcessor:forName:"),
                             with: FaceFilterProcessor.shared, with: FaceFilterModule.processorName as NSString)
      } else {
        NSLog("[FaceFilter] react-native-webrtc ProcessorProvider not found")
      }
      if let url = Bundle(for: FaceFilterProcessor.self).url(forResource: "FaceFilterAssets", withExtension: "bundle")
                    .flatMap({ Bundle(url: $0) })?.url(forResource: "presets", withExtension: "json"),
         let data = try? Data(contentsOf: url),
         let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let p = j["presets"] as? [String: [String: Any]] {
        self.presets = p
      }
    }

    Constants(["processorName": FaceFilterModule.processorName])

    Function("setParams") { (partial: [String: Any]) in
      let s = FaceFilterState.shared
      s.params = s.params.merged(partial)
    }

    Function("applyPreset") { (name: String) in
      guard let p = self.presets[name] else { throw Exception(name: "UnknownPreset", description: "Unknown preset '\(name)'") }
      let s = FaceFilterState.shared
      s.params = s.params.merged(p)
    }

    Function("presetNames") { () -> [String] in Array(self.presets.keys).sorted() }

    Function("setEnabled") { (on: Bool) in FaceFilterState.shared.enabled = on }

    Function("getStats") { () -> [String: Any] in FaceFilterState.shared.stats }
  }
}
