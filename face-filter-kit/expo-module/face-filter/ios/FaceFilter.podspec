require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'FaceFilter'
  s.version        = package['version']
  s.summary        = package['description']
  s.license        = 'UNLICENSED'
  s.author         = ''
  s.homepage       = 'https://example.invalid'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'react-native-webrtc'      # brings the WebRTC framework (import WebRTC)
  s.dependency 'MediaPipeTasksVision'     # pin the version you test with

  s.source_files   = '*.swift'
  # Assets/: face_mesh.json, makeup_atlas.png, presets.json, FaceFilterShaders.metalsrc (copy of Shaders.metal),
  # face_landmarker.task. Populated by tools/sync_assets.sh.
  s.resource_bundles = { 'FaceFilterAssets' => ['Assets/*'] }
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
