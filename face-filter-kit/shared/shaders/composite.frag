#version 300 es
// Final pass: face reshape (warp), skin smoothing, blush, lips, colour grade. All blending happens
// in linear light so colours mix like real pigment and highlights stay white. One pass, full res.
// Every new control is a no-op at 0, so renderers that never set those uniforms are unchanged.
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uFrame;    // camera frame, full res, image space
uniform sampler2D uMask;     // face masks for THIS frame: r lips, g blush, b skin
uniform sampler2D uSmooth;   // half res, edge-preserving blur
uniform sampler2D uBlur;     // quarter res, gaussian (local mean)
uniform vec2 uTexel;         // 1 / full-res size

uniform float uFade;         // face presence 0..1 (fades instead of popping)

uniform vec3  uLipColor;     // sRGB 0..1
uniform float uLipOpacity;   // overall strength
uniform float uLipCoverage;  // 0 = sheer tint, 1 = full-coverage lipstick
uniform float uLipTexture;   // how much natural lip texture survives (0..1)
uniform float uLipGloss;     // 0..1
uniform float uLipRefine;    // 0..1, snap mask edge to the real lip edge using colour
uniform vec2  uSkinRefPos;   // image-space point on the cheek (skin colour reference)
uniform vec2  uLipRefPos;    // image-space point on the lower lip (lip colour reference)

uniform vec3  uBlushColor;   // sRGB
uniform float uBlushIntensity;

uniform float uSmoothAmount; // 0..1
uniform float uPoreKeep;     // 0..1, fine skin texture kept after smoothing
uniform float uBrighten;     // 0..1

uniform float uTan;          // 0..1 warm bronze on skin tones

// Face reshape, built from THIS frame's landmarks (web/src/engine/warp.ts documents the maths)
#define MAX_WARPS 20
uniform vec2 uSize;          // full-res size in px
uniform int  uWarpCount;
uniform vec4 uWarpA[MAX_WARPS]; // center px xy, radius px, scale
uniform vec2 uWarpB[MAX_WARPS]; // move px

// Colour grade (whole picture)
uniform float uWarmth;       // -1..1
uniform float uSaturation;   // -1..1
uniform float uContrast;     // -1..1 (negative = matte, lifted blacks)
uniform float uExposure;     // -1..1
uniform float uGlow;         // 0..1
uniform float uVignette;     // 0..1
uniform float uSharpen;      // 0..1

uniform float uSplit;        // before/after divider in image x (0 = all filtered)
uniform int   uDebug;        // 1 = show masks

vec3 toLin(vec3 c) { return c * c * (c * 0.2848 + 0.7152); }            // fast sRGB -> linear (max err < 1%)
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return 1.138 * sqrt(c) - 0.138 * c; } // fast linear -> sRGB
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec2 chroma(vec3 c) { float s = c.r + c.g + c.b + 1e-4; return vec2(c.r, c.g) / s; }

// Soft YCbCr skin locus. Wide on purpose: covers light to deep skin tones (they differ mostly in Y).
float skinProb(vec3 srgb) {
  float y  = dot(srgb, vec3(0.299, 0.587, 0.114));
  float cb = 0.5 + dot(srgb, vec3(-0.168736, -0.331264, 0.5));
  float cr = 0.5 + dot(srgb, vec3(0.5, -0.418688, -0.081312));
  float d = length((vec2(cb, cr) - vec2(0.41, 0.60)) / vec2(0.11, 0.09));
  return (1.0 - smoothstep(0.9, 1.7, d)) * smoothstep(0.04, 0.12, y);
}

// Output pixel samples the source at p - sum(w * (move + scale * (p - center))).
vec2 warpUv(vec2 uv) {
  if (uWarpCount <= 0) return uv;
  vec2 p = uv * uSize;
  vec2 d = vec2(0.0);
  for (int i = 0; i < MAX_WARPS; i++) {
    if (i >= uWarpCount) break;
    vec4 a = uWarpA[i];
    vec2 q = p - a.xy;
    float t = dot(q, q) / (a.z * a.z);
    if (t < 1.0) { float w = (1.0 - t) * (1.0 - t); d += w * (uWarpB[i] + a.w * q); }
  }
  return (p - d) / uSize;
}

void main() {
  if (vUv.x < uSplit && uDebug != 1) { outColor = vec4(texture(uFrame, vUv).rgb, 1.0); return; }

  // Every lookup below uses the warped uv, so makeup moves with the reshaped face.
  vec2 uv = warpUv(vUv);
  vec3 src = texture(uFrame, uv).rgb;
  vec4 m = texture(uMask, uv);

  if (uDebug == 1) { outColor = vec4(mix(src * 0.35, m.rgb, 0.8), 1.0); return; }

  vec3 c = toLin(src);

  // ---------------------------------------------------------------- detail (sharpen + pores)
  float k = m.b * uSmoothAmount * uFade;
  vec3 fine = vec3(0.0);                        // pores and fine texture
  if (k > 0.002 || uSharpen > 0.0) {
    vec3 n = toLin(0.25 * (texture(uFrame, uv + vec2(uTexel.x, 0.0)).rgb + texture(uFrame, uv - vec2(uTexel.x, 0.0)).rgb +
                           texture(uFrame, uv + vec2(0.0, uTexel.y)).rgb + texture(uFrame, uv - vec2(0.0, uTexel.y)).rgb));
    fine = c - n;
    c = max(c + fine * uSharpen * 1.5, 0.0);    // skin smoothing below replaces it on skin
  }

  // ---------------------------------------------------------------- skin smoothing
  if (k > 0.002) {
    k *= skinProb(src);
    vec3 s = toLin(texture(uSmooth, uv).rgb);
    vec3 sm = s + fine * uPoreKeep;             // keep some pores, or skin looks plastic
    sm = mix(sm, sm * 1.07 + 0.003, uBrighten); // gentle lift
    c = mix(c, max(sm, 0.0), k);
  }

  // ---------------------------------------------------------------- bronze
  // All skin-coloured pixels (face, neck, shoulders), so there is no seam at the jaw.
  if (uTan > 0.0) {
    float tw = uTan * skinProb(src) * mix(0.6, 1.0, m.b);
    c *= mix(vec3(1.0), vec3(0.93, 0.74, 0.55), tw * 0.8);
  }

  // ---------------------------------------------------------------- blush
  float bA = m.g * uBlushIntensity * uFade;
  if (bA > 0.002) {
    vec3 t = toLin(uBlushColor);
    vec3 tint = t / max(luma(t), 1e-4);         // hue of the blush at luminance 1
    vec3 colorMode = clamp(luma(c) * tint, 0.0, 1.0);          // skin lightness, blush hue
    vec3 pigment = c * mix(vec3(1.0), clamp(tint, 0.0, 2.0), 0.55); // subtractive, like real powder
    c = mix(c, mix(colorMode, pigment, 0.5), bA * 0.75);
  }

  // ---------------------------------------------------------------- lips
  // 5-tap mask blur = 1-2 px anti-aliasing on the mesh edge
  float lipM = (m.r * 4.0 +
                texture(uMask, uv + vec2(uTexel.x, 0.0)).r + texture(uMask, uv - vec2(uTexel.x, 0.0)).r +
                texture(uMask, uv + vec2(0.0, uTexel.y)).r + texture(uMask, uv - vec2(0.0, uTexel.y)).r) * 0.125;
  float lA = lipM * uLipOpacity * uFade;
  if (lA > 0.002) {
    vec3 low = toLin(texture(uBlur, uv).rgb);
    float L = luma(c);
    float Llow = max(luma(low), 1e-4);
    float detail = clamp(L / Llow, 0.35, 2.5);  // lip lines, creases and highlights

    if (uLipRefine > 0.0) {
      // Where does this pixel sit on the line from skin colour to lip colour?
      vec3 skin = toLin(texture(uBlur, uSkinRefPos).rgb);
      vec3 lip  = toLin(texture(uBlur, uLipRefPos).rgb);
      vec2 ax = chroma(lip) - chroma(skin);
      float sep = length(ax);
      float conf = smoothstep(0.010, 0.035, sep);           // pale lips: trust the mesh instead
      float tpos = dot(chroma(c) - chroma(skin), ax) / max(sep * sep, 1e-6);
      float lipness = smoothstep(0.15, 0.70, tpos);
      lipness *= smoothstep(0.004, 0.02, L);                // mouth interior / deep shadow
      float neutral = 1.0 - smoothstep(0.0, 0.035, length(chroma(c) - vec2(0.3333)));
      lipness *= 1.0 - smoothstep(0.30, 0.55, L) * neutral; // teeth: bright and colourless
      lA *= mix(1.0, lipness, uLipRefine * conf);
    }

    vec3 t = toLin(uLipColor);
    float Lt = max(luma(t), 1e-4);
    float Lbase = mix(Llow, Lt, uLipCoverage);
    float Lout = Lbase * pow(detail, uLipTexture);
    vec3 lipRgb = t * (Lout / Lt);
    float spec = smoothstep(1.04, 1.55, detail) * uLipGloss;  // grow the natural highlights
    lipRgb += vec3(spec) * (0.30 + 0.70 * Lout);
    lipRgb *= 1.0 + 0.06 * uLipGloss;                         // wet look
    c = mix(c, clamp(lipRgb, 0.0, 1.0), lA);
  }

  // ---------------------------------------------------------------- colour grade
  if (uWarmth != 0.0) c *= vec3(1.0 + 0.16 * uWarmth, 1.0 + 0.03 * uWarmth, 1.0 - 0.18 * uWarmth);
  if (uExposure != 0.0) c *= exp2(uExposure * 0.6);
  if (uGlow > 0.0) {                              // screen in the blurred highlights
    vec3 bl = toLin(texture(uBlur, uv).rgb);
    vec3 g = bl * smoothstep(0.08, 0.7, luma(bl)) * uGlow * 0.7;
    c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - g);
  }
  vec3 o = clamp(toSrgb(c), 0.0, 1.0);            // contrast and saturation read better in sRGB
  if (uContrast > 0.0) o = mix(o, o * o * (3.0 - 2.0 * o), uContrast);
  else if (uContrast < 0.0) o = mix(o, vec3(0.5), -0.35 * uContrast);
  if (uSaturation != 0.0) o = clamp(mix(vec3(luma(o)), o, 1.0 + uSaturation), 0.0, 1.0);
  if (uVignette > 0.0) {
    vec2 vq = (vUv - 0.5) * vec2(uSize.x / max(uSize.y, 1.0), 1.0);
    o *= 1.0 - uVignette * 0.55 * smoothstep(0.3, 0.95, length(vq));
  }
  outColor = vec4(o, 1.0);
}
