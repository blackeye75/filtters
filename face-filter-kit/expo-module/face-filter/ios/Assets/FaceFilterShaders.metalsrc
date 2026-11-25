// Metal port of shared/shaders/*.glsl. Keep the maths identical to the GLSL (web + Android).
// Image space: uv (0,0) = top-left; Metal textures are top-left origin, NDC y is up.
#include <metal_stdlib>
using namespace metal;

struct VOut { float4 pos [[position]]; float2 uv; };

constexpr sampler linearClamp(filter::linear, address::clamp_to_edge);
constexpr sampler atlasSampler(filter::linear, mip_filter::linear, address::clamp_to_edge);

vertex VOut fullscreen_vs(uint vid [[vertex_id]]) {
  float2 uv = float2(float((vid << 1) & 2), float(vid & 2));
  VOut o;
  o.uv = uv;
  o.pos = float4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  return o;
}

// ------------------------------------------------------------------ camera -> RGBA
struct CopyU { float fullRange; float3 pad; };

fragment float4 copy_nv12_fs(VOut in [[stage_in]],
                             texture2d<float> yTex [[texture(0)]],
                             texture2d<float> cTex [[texture(1)]],
                             constant CopyU& u [[buffer(0)]]) {
  float y = yTex.sample(linearClamp, in.uv).r;
  float2 c = cTex.sample(linearClamp, in.uv).rg - 0.5;
  if (u.fullRange < 0.5) { y = (y - 16.0 / 255.0) * (255.0 / 219.0); c *= 255.0 / 224.0; }
  float3 rgb = float3(y + 1.402 * c.y, y - 0.344136 * c.x - 0.714136 * c.y, y + 1.772 * c.x);
  return float4(saturate(rgb), 1.0);
}

fragment float4 copy_bgra_fs(VOut in [[stage_in]], texture2d<float> tex [[texture(0)]]) {
  return float4(tex.sample(linearClamp, in.uv).rgb, 1.0);
}

// ------------------------------------------------------------------ model input (upright, small)
struct PrepU { float3x3 prep; };

fragment float4 prep_fs(VOut in [[stage_in]], texture2d<float> frame [[texture(0)]], constant PrepU& u [[buffer(0)]]) {
  float2 src = (u.prep * float3(in.uv, 1.0)).xy;
  return float4(frame.sample(linearClamp, src).rgb, 1.0);
}

// ------------------------------------------------------------------ blur chains
struct StepU { float2 v; float sigmaRange; float pad; };

fragment float4 down2_fs(VOut in [[stage_in]], texture2d<float> t [[texture(0)]], constant StepU& u [[buffer(0)]]) {
  float2 d = u.v;
  return 0.25 * (t.sample(linearClamp, in.uv + float2(-d.x, -d.y)) + t.sample(linearClamp, in.uv + float2(d.x, -d.y)) +
                 t.sample(linearClamp, in.uv + float2(-d.x,  d.y)) + t.sample(linearClamp, in.uv + float2(d.x,  d.y)));
}

fragment float4 bilateral_fs(VOut in [[stage_in]], texture2d<float> t [[texture(0)]], constant StepU& u [[buffer(0)]]) {
  float3 c0 = t.sample(linearClamp, in.uv).rgb;
  float3 sum = c0;
  float wsum = 1.0;
  float inv2r = 1.0 / (2.0 * u.sigmaRange * u.sigmaRange);
  for (int i = 1; i <= 7; i++) {
    float fi = float(i);
    float ws = exp(-fi * fi / 24.5);
    float3 a = t.sample(linearClamp, in.uv + u.v * fi).rgb;
    float3 b = t.sample(linearClamp, in.uv - u.v * fi).rgb;
    float3 da = a - c0, db = b - c0;
    float wa = ws * exp(-dot(da, da) * inv2r);
    float wb = ws * exp(-dot(db, db) * inv2r);
    sum += a * wa + b * wb;
    wsum += wa + wb;
  }
  return float4(sum / wsum, 1.0);
}

fragment float4 gauss_fs(VOut in [[stage_in]], texture2d<float> t [[texture(0)]], constant StepU& u [[buffer(0)]]) {
  float4 s = t.sample(linearClamp, in.uv) * 0.2270270270;
  s += (t.sample(linearClamp, in.uv + u.v * 1.3846153846) + t.sample(linearClamp, in.uv - u.v * 1.3846153846)) * 0.3162162162;
  s += (t.sample(linearClamp, in.uv + u.v * 3.2307692308) + t.sample(linearClamp, in.uv - u.v * 3.2307692308)) * 0.0702702703;
  return s;
}

// ------------------------------------------------------------------ face mesh -> masks
struct MeshOut { float4 pos [[position]]; float2 uv; };

vertex MeshOut mesh_vs(uint vid [[vertex_id]],
                       device const float* pos [[buffer(0)]],     // 468 x (x, y, z), image space
                       device const float2* uvs [[buffer(1)]],
                       constant float& depthScale [[buffer(2)]]) {
  float x = pos[vid * 3], y = pos[vid * 3 + 1], z = pos[vid * 3 + 2];
  MeshOut o;
  o.uv = uvs[vid];
  o.pos = float4(x * 2.0 - 1.0, 1.0 - y * 2.0, clamp(z * depthScale * 0.5 + 0.5, 0.0, 1.0), 1.0);
  return o;
}

fragment float4 mesh_fs(MeshOut in [[stage_in]], texture2d<float> atlas [[texture(0)]]) {
  return float4(atlas.sample(atlasSampler, in.uv).rgb, 1.0);
}

// ------------------------------------------------------------------ composite
struct CompositeU {
  float4 lipColorOpacity;   // rgb, opacity
  float4 lipParams;         // coverage, texture, gloss, refine
  float4 refs;              // skinRef.xy, lipRef.xy
  float4 blush;             // rgb, intensity
  float4 skin;              // smooth, poreKeep, brighten, fade
  float4 texel;             // 1/w, 1/h, 0, 0
};

static float3 toLin(float3 c) { return c * c * (c * 0.2848 + 0.7152); }
static float3 toSrgb(float3 c) { c = max(c, 0.0); return 1.138 * sqrt(c) - 0.138 * c; }
static float luma(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }
static float2 chroma(float3 c) { float s = c.r + c.g + c.b + 1e-4; return float2(c.r, c.g) / s; }
static float skinProb(float3 srgb) {
  float y  = dot(srgb, float3(0.299, 0.587, 0.114));
  float cb = 0.5 + dot(srgb, float3(-0.168736, -0.331264, 0.5));
  float cr = 0.5 + dot(srgb, float3(0.5, -0.418688, -0.081312));
  float d = length((float2(cb, cr) - float2(0.41, 0.60)) / float2(0.11, 0.09));
  return (1.0 - smoothstep(0.9, 1.7, d)) * smoothstep(0.04, 0.12, y);
}

fragment float4 composite_fs(VOut in [[stage_in]],
                             texture2d<float> frame [[texture(0)]],
                             texture2d<float> mask [[texture(1)]],
                             texture2d<float> smoothT [[texture(2)]],
                             texture2d<float> blurT [[texture(3)]],
                             constant CompositeU& u [[buffer(0)]]) {
  float2 uv = in.uv;
  float2 tx = u.texel.xy;
  float fade = u.skin.w;
  float3 src = frame.sample(linearClamp, uv).rgb;
  float4 m = mask.sample(linearClamp, uv);
  float3 c = toLin(src);

  float k = m.b * u.skin.x * fade;
  if (k > 0.002) {
    k *= skinProb(src);
    float3 s = toLin(smoothT.sample(linearClamp, uv).rgb);
    float3 n = toLin(0.25 * (frame.sample(linearClamp, uv + float2(tx.x, 0)).rgb + frame.sample(linearClamp, uv - float2(tx.x, 0)).rgb +
                             frame.sample(linearClamp, uv + float2(0, tx.y)).rgb + frame.sample(linearClamp, uv - float2(0, tx.y)).rgb));
    float3 sm = s + (c - n) * u.skin.y;
    sm = mix(sm, sm * 1.07 + 0.003, u.skin.z);
    c = mix(c, max(sm, 0.0), k);
  }

  float bA = m.g * u.blush.w * fade;
  if (bA > 0.002) {
    float3 t = toLin(u.blush.rgb);
    float3 tint = t / max(luma(t), 1e-4);
    float3 colorMode = saturate(luma(c) * tint);
    float3 pigment = c * mix(float3(1.0), clamp(tint, 0.0, 2.0), 0.55);
    c = mix(c, mix(colorMode, pigment, 0.5), bA * 0.75);
  }

  float lipM = (m.r * 4.0 +
                mask.sample(linearClamp, uv + float2(tx.x, 0)).r + mask.sample(linearClamp, uv - float2(tx.x, 0)).r +
                mask.sample(linearClamp, uv + float2(0, tx.y)).r + mask.sample(linearClamp, uv - float2(0, tx.y)).r) * 0.125;
  float lA = lipM * u.lipColorOpacity.w * fade;
  if (lA > 0.002) {
    float3 low = toLin(blurT.sample(linearClamp, uv).rgb);
    float L = luma(c);
    float Llow = max(luma(low), 1e-4);
    float detail = clamp(L / Llow, 0.35, 2.5);
    float refine = u.lipParams.w;
    if (refine > 0.0) {
      float3 skin = toLin(blurT.sample(linearClamp, u.refs.xy).rgb);
      float3 lip  = toLin(blurT.sample(linearClamp, u.refs.zw).rgb);
      float2 ax = chroma(lip) - chroma(skin);
      float sep = length(ax);
      float conf = smoothstep(0.010, 0.035, sep);
      float tpos = dot(chroma(c) - chroma(skin), ax) / max(sep * sep, 1e-6);
      float lipness = smoothstep(0.15, 0.70, tpos);
      lipness *= smoothstep(0.004, 0.02, L);
      float neutral = 1.0 - smoothstep(0.0, 0.035, length(chroma(c) - float2(0.3333)));
      lipness *= 1.0 - smoothstep(0.30, 0.55, L) * neutral;
      lA *= mix(1.0, lipness, refine * conf);
    }
    float3 t = toLin(u.lipColorOpacity.rgb);
    float Lt = max(luma(t), 1e-4);
    float Lbase = mix(Llow, Lt, u.lipParams.x);
    float Lout = Lbase * pow(detail, u.lipParams.y);
    float3 lipRgb = t * (Lout / Lt);
    float spec = smoothstep(1.04, 1.55, detail) * u.lipParams.z;
    lipRgb += float3(spec) * (0.30 + 0.70 * Lout);
    lipRgb *= 1.0 + 0.06 * u.lipParams.z;
    c = mix(c, saturate(lipRgb), lA);
  }
  return float4(toSrgb(c), 1.0);
}
