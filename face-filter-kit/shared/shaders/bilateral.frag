#version 300 es
// Separable edge-preserving blur for skin smoothing (run H then V at half resolution).
// uStep = texel size * direction * radius scale (scaled with face size by the engine).
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uStep;
uniform float uSigmaRange;   // colour difference that still counts as "same surface", ~0.06-0.10
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c0 = texture(uTex, vUv).rgb;
  vec3 sum = c0;
  float wsum = 1.0;
  float inv2r = 1.0 / (2.0 * uSigmaRange * uSigmaRange);
  for (int i = 1; i <= 7; i++) {
    float fi = float(i);
    float ws = exp(-fi * fi / 24.5);                // spatial sigma 3.5 taps
    vec3 a = texture(uTex, vUv + uStep * fi).rgb;
    vec3 b = texture(uTex, vUv - uStep * fi).rgb;
    vec3 da = a - c0, db = b - c0;
    float wa = ws * exp(-dot(da, da) * inv2r);
    float wb = ws * exp(-dot(db, db) * inv2r);
    sum += a * wa + b * wb;
    wsum += wa + wb;
  }
  outColor = vec4(sum / wsum, 1.0);
}
