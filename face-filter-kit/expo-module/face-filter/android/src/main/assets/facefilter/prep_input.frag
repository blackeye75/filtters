#version 300 es
// Native only: builds the small upright RGBA image the landmark model reads.
// uPrep maps upright-output coords (0..1, top-left) to frame image-space coords; it carries the
// sensor rotation and front-camera mirroring. The same matrix maps landmarks back.
precision mediump float;
uniform sampler2D uFrame;
uniform mat3 uPrep;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 src = (uPrep * vec3(vUv, 1.0)).xy;
  outColor = vec4(texture(uFrame, src).rgb, 1.0);
}
