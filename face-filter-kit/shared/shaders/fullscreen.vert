#version 300 es
// Fullscreen triangle, no vertex buffer. vUv is image space: (0,0) = top-left of the image,
// because every texture in the engine stores image row 0 in memory row 0.
// uFlipY = 1.0 only when drawing to an on-screen framebuffer (GL shows memory row 0 at the bottom).
uniform float uFlipY;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, mix(p.y, 1.0 - p.y, uFlipY));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
