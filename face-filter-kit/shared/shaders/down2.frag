#version 300 es
// 2x downsample. Four bilinear taps one source texel off-centre = smooth 4x4 box, no aliasing.
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uSrcTexel;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 d = uSrcTexel;
  outColor = 0.25 * (texture(uTex, vUv + vec2(-d.x, -d.y)) + texture(uTex, vUv + vec2(d.x, -d.y)) +
                     texture(uTex, vUv + vec2(-d.x,  d.y)) + texture(uTex, vUv + vec2(d.x,  d.y)));
}
