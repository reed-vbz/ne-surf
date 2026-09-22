/**
 * Rolling Wavefronts — Layer 1 custom deck.gl layer (subclass of BitmapLayer, so the quad, projection and interleaving
 * with MapLibre come for free; only the fragment shader and one uniform block are ours).
 *
 * The texture is the backend wave field (workers/nesurf/wavefield.py, or the PINN API): per cell the swell's travel time
 * t(x) from the eikonal solution over the CRM bathymetry (R,G 16-bit), and H_s (B). Crests are the level sets of the
 * phase  φ = ω·t(x) − ω·u_time : they are continuous, spaced by the local wavelength L = c(h)·T (= gT²/2π in deep
 * water), they slow, bunch and bend around headlands where c → √(g h), and they align to coves — all baked into t(x).
 * Styling: electric cyan → white ridge with a Gaussian-ish glow, transparent troughs, opacity scaled by H_s, fade to 0
 * against land (t = 0 texels) — plus the layer draws under MapLibre's land layer (beforeId), so zero bleed twice over.
 */
import { BitmapLayer, type BitmapLayerProps } from "@deck.gl/layers";

export interface RollingProps { time: number; omega: number; speed: number; tScale: number; hMax: number; crestEvery: number }
export type RollingExtra = Partial<RollingProps> & { beforeId?: string };
export type RollingWavefrontsLayerProps = BitmapLayerProps & RollingExtra;

const rollingBlock = `\
layout(std140) uniform rollingUniforms {
  float time;
  float omega;
  float speed;
  float tScale;
  float hMax;
  float crestEvery;
} rolling;
`;
const rollingUniforms = {
  name: "rolling", vs: rollingBlock, fs: rollingBlock,
  uniformTypes: { time: "f32", omega: "f32", speed: "f32", tScale: "f32", hMax: "f32", crestEvery: "f32" },
} as const;

const FS = /* glsl */ `\
#version 300 es
#define SHADER_NAME rolling-wavefronts-fragment-shader
precision highp float;

uniform sampler2D bitmapTexture;
in vec2 vTexCoord;
in vec2 vTexPos;
out vec4 fragColor;

const float TILE_SIZE = 512.0;
const float PI = 3.1415926536;
const float WORLD_SCALE = TILE_SIZE / PI / 2.0;
vec2 mercator_to_lnglat(vec2 xy) { xy /= WORLD_SCALE; return degrees(vec2(xy.x - PI, atan(exp(xy.y - PI)) * 2.0 - PI * 0.5)); }
vec2 getUV(vec2 pos) { return vec2((pos.x - bitmap.bounds[0]) / (bitmap.bounds[2] - bitmap.bounds[0]), (pos.y - bitmap.bounds[3]) / (bitmap.bounds[1] - bitmap.bounds[3])); }

// one texel → (travel time s, H_s m, water 0/1)
vec3 decodeTexel(ivec2 p) {
  vec4 c = texelFetch(bitmapTexture, p, 0);
  float t = (c.r * 255.0 * 256.0 + c.g * 255.0) * rolling.tScale;
  return vec3(t, c.b * rolling.hMax, t > 0.0 ? 1.0 : 0.0);
}

void main(void) {
  vec2 uv = vTexCoord;
  if (bitmap.coordinateConversion < -0.5) { uv = getUV(mercator_to_lnglat(vTexPos)); }   // image rows are equal-latitude
  ivec2 size = textureSize(bitmapTexture, 0);
  vec2 p = uv * vec2(size) - 0.5;
  ivec2 p0 = ivec2(floor(p)); vec2 f = fract(p); ivec2 mx = size - 1;
  vec3 a = decodeTexel(clamp(p0, ivec2(0), mx));
  vec3 b = decodeTexel(clamp(p0 + ivec2(1, 0), ivec2(0), mx));
  vec3 c = decodeTexel(clamp(p0 + ivec2(0, 1), ivec2(0), mx));
  vec3 d = decodeTexel(clamp(p0 + ivec2(1, 1), ivec2(0), mx));
  // water-weighted bilinear blend: land texels (t = 0) do not drag the phase toward zero at the shoreline
  float wa = (1.0 - f.x) * (1.0 - f.y) * a.z, wb = f.x * (1.0 - f.y) * b.z, wc = (1.0 - f.x) * f.y * c.z, wd = f.x * f.y * d.z;
  float wsum = wa + wb + wc + wd;
  float water = mix(mix(a.z, b.z, f.x), mix(c.z, d.z, f.x), f.y);   // fraction of water under this pixel → shoreline dissipation
  if (wsum <= 0.0 || water < 0.02) discard;
  float t = (wa * a.x + wb * b.x + wc * c.x + wd * d.x) / wsum;
  float hs = (wa * a.y + wb * b.y + wc * c.y + wd * d.y) / wsum;

  // φ = k·x − ωt with k·x ≡ ω t(x) from the eikonal field; crestEvery draws one crest per N wavelengths (every wave at 1,
  // a readable subset at 3–4 — the geometry, spacing ratios and speed stay physical)
  float phase = rolling.omega * (t - rolling.time * rolling.speed) / rolling.crestEvery;
  float cph = cos(phase);
  float ridge = smoothstep(0.45, 0.985, cph);                          // sharp crest line
  float glow = exp(-pow((1.0 - cph) * 1.6, 2.0)) * 0.45;              // Gaussian softness around the crest
  float amp = clamp(hs / 1.2, 0.18, 1.0);                             // small swell → faint crests, big → vivid
  float shore = smoothstep(0.05, 0.6, water);                          // fade to 0 where the 270 m cells turn to land (≈ the coastal ribbon)
  vec3 col = mix(vec3(0.0, 0.898, 1.0), vec3(1.0), ridge * ridge);     // #00E5FF → white
  float alpha = clamp(ridge * 0.95 + glow, 0.0, 1.0) * amp * shore * layer.opacity;
  fragColor = vec4(col, alpha);
  geometry.uv = uv;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

export default class RollingWavefrontsLayer extends BitmapLayer<RollingExtra> {
  static layerName = "RollingWavefrontsLayer";
  static defaultProps = { ...BitmapLayer.defaultProps, time: 0, omega: 0.7, speed: 1, tScale: 0.25, hMax: 10, crestEvery: 3 };

  getShaders() {
    const s = super.getShaders();
    return { ...s, fs: FS, modules: [...s.modules, rollingUniforms] };
  }
  draw(opts: Parameters<BitmapLayer["draw"]>[0]) {
    const model = (this.state as { model?: { shaderInputs: { setProps: (p: Record<string, unknown>) => void } } }).model;
    const { time, omega, speed, tScale, hMax, crestEvery } = this.props as RollingProps;
    model?.shaderInputs.setProps({ rolling: { time, omega, speed, tScale, hMax, crestEvery } });
    super.draw(opts);
  }
}
