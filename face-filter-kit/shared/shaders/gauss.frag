#version 300 es
// Separable 9-tap Gaussian (sigma ~2 texels) at quarter resolution: local mean brightness for
// lip texture transfer and the colour references for lip-edge refinement.
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uStep;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 s = texture(uTex, vUv) * 0.2270270270;
  s += (texture(uTex, vUv + uStep * 1.3846153846) + texture(uTex, vUv - uStep * 1.3846153846)) * 0.3162162162;
  s += (texture(uTex, vUv + uStep * 3.2307692308) + texture(uTex, vUv - uStep * 3.2307692308)) * 0.0702702703;
  outColor = s;
}
