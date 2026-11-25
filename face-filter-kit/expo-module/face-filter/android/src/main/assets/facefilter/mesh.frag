#version 300 es
precision mediump float;
uniform sampler2D uAtlas;   // R lips, G blush, B skin
in vec2 vAtlasUv;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uAtlas, vAtlasUv).rgb, 1.0);
}
