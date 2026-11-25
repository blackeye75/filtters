#version 300 es
// Android only: camera OES texture -> RGBA8 frame texture in image space.
// uTexMatrix = the WebRTC TextureBuffer transform matrix (GL convention: origin bottom-left).
#extension GL_OES_EGL_image_external_essl3 : require
precision mediump float;
uniform samplerExternalOES uCamera;
uniform mat4 uTexMatrix;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 gl = vec2(vUv.x, 1.0 - vUv.y);          // image space -> GL quad space
  vec2 tc = (uTexMatrix * vec4(gl, 0.0, 1.0)).xy;
  outColor = vec4(texture(uCamera, tc).rgb, 1.0);
}
