#version 300 es
// Face mesh: positions = smoothed landmarks of THIS frame (image space 0..1), z for depth so the
// far cheek is hidden behind the nose on profile views. UVs index the makeup atlas.
in vec3 aPos;
in vec2 aUv;
uniform float uDepthScale;
out vec2 vAtlasUv;
void main() {
  vAtlasUv = aUv;
  gl_Position = vec4(aPos.xy * 2.0 - 1.0, clamp(aPos.z * uDepthScale, -1.0, 1.0), 1.0);
}
