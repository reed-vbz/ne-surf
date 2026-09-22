/**
 * Rolling Wavefronts — Layer 1 custom deck.gl layer (subclass of BitmapLayer: quad, projection and MapLibre interleaving
 * come for free; the fragment shader, a second texture binding, one uniform block and the blend state are ours).
 *
 * Textures
 *   bitmapTexture  per WW3 step: R,G = swell travel time t(x) (16-bit, s × tScale) from the eikonal solution over the CRM
 *                  bathymetry (metric fast marching on a Gaussian-smoothed depth field), B = H_s (m / hMax), t = 0 = land
 *   geomTexture    static: R,G = signed distance to the shoreline (m + 8192, 16-bit), B = depth (m / 2)
 * Both are 8-bit PNGs carrying 16-bit data in two channels, so hardware LINEAR filtering would corrupt the values; the
 * shader therefore reconstructs each field with a cubic B-spline over 16 texels (smoother than gl.LINEAR, C² continuous),
 * weighted by water so land never drags the phase.
 *
 * Crests   φ = ω·(t(x) − u_time·speed) / crestEvery ;  I = exp(−(sin φ / w)²)  with w widened to ≥ ~1 px by fwidth(φ)
 *          so thin crests never alias; white core → electric cyan edges; troughs fully transparent; additive blending.
 * Physics  local phase speed c = √(g·max(h, 0.5)) from the smoothed depth narrows the crest profile in the shallows
 *          (wavelength shrinks as c falls) and the crest intensity tapers to zero over the last 50 m of water (signed
 *          distance) — breaking-wave decay before the coastal ribbon. Land texels are discarded and the layer is also clipped
 *          by the authoritative ocean polygon through MaskExtension.
 */
import { BitmapLayer, type BitmapLayerProps } from "@deck.gl/layers";
import type { Texture } from "@luma.gl/core";

export interface RollingProps { time: number; omega: number; speed: number; tScale: number; hMax: number; crestEvery: number; crestWidth: number; geometry: ImageBitmap | null }
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
  float crestWidth;
  float hasGeom;
} rolling;
`;
const rollingUniforms = {
  name: "rolling", vs: rollingBlock, fs: rollingBlock,
  uniformTypes: { time: "f32", omega: "f32", speed: "f32", tScale: "f32", hMax: "f32", crestEvery: "f32", crestWidth: "f32", hasGeom: "f32" },
} as const;

const FS = /* glsl */ `\
#version 300 es
#define SHADER_NAME rolling-wavefronts-fragment-shader
precision highp float;

uniform sampler2D bitmapTexture;
uniform sampler2D geomTexture;
in vec2 vTexCoord;
in vec2 vTexPos;
out vec4 fragColor;

const float TILE_SIZE = 512.0;
const float PI = 3.1415926536;
const float WORLD_SCALE = TILE_SIZE / PI / 2.0;
const float G = 9.81;
vec2 mercator_to_lnglat(vec2 xy) { xy /= WORLD_SCALE; return degrees(vec2(xy.x - PI, atan(exp(xy.y - PI)) * 2.0 - PI * 0.5)); }
vec2 getUV(vec2 pos) { return vec2((pos.x - bitmap.bounds[0]) / (bitmap.bounds[2] - bitmap.bounds[0]), (pos.y - bitmap.bounds[3]) / (bitmap.bounds[1] - bitmap.bounds[3])); }

// ---- texel decoders (16-bit data lives in R,G) ----
vec3 waveTexel(ivec2 p) {                       // (t seconds, H_s metres, water 0/1)
  vec4 c = texelFetch(bitmapTexture, p, 0);
  float t = (c.r * 255.0 * 256.0 + c.g * 255.0) * rolling.tScale;
  return vec3(t, c.b * rolling.hMax, t > 0.0 ? 1.0 : 0.0);
}
vec2 geomTexel(ivec2 p) {                       // (signed distance to shore m, depth m)
  vec4 c = texelFetch(geomTexture, p, 0);
  return vec2(c.r * 255.0 * 256.0 + c.g * 255.0 - 8192.0, c.b * 255.0 * 2.0);
}

// cubic B-spline weights (all positive → no ringing; C² continuous → no kinks along contours)
vec4 bspline(float x) {
  float x2 = x * x, x3 = x2 * x;
  return vec4((1.0 - 3.0 * x + 3.0 * x2 - x3) / 6.0, (4.0 - 6.0 * x2 + 3.0 * x3) / 6.0, (1.0 + 3.0 * x + 3.0 * x2 - 3.0 * x3) / 6.0, x3 / 6.0);
}

void main(void) {
  vec2 uv = vTexCoord;
  if (bitmap.coordinateConversion < -0.5) { uv = getUV(mercator_to_lnglat(vTexPos)); }   // image rows are equal-latitude
  ivec2 size = textureSize(bitmapTexture, 0);
  vec2 p = uv * vec2(size) - 0.5;
  ivec2 p0 = ivec2(floor(p)); vec2 f = fract(p); ivec2 mx = size - 1;
  vec4 wx = bspline(f.x), wy = bspline(f.y);

  // water-weighted 4×4 B-spline reconstruction of travel time and height
  float tAcc = 0.0, hAcc = 0.0, wAcc = 0.0, water = 0.0;
  for (int j = -1; j <= 2; j++) {
    for (int i = -1; i <= 2; i++) {
      float w = wx[i + 1] * wy[j + 1];
      vec3 s = waveTexel(clamp(p0 + ivec2(i, j), ivec2(0), mx));
      tAcc += w * s.z * s.x; hAcc += w * s.z * s.y; wAcc += w * s.z; water += w * s.z;
    }
  }
  if (wAcc <= 1e-4 || water < 0.02) discard;
  float t = tAcc / wAcc, hs = hAcc / wAcc;

  // geometry: signed distance to the shoreline and smoothed depth (same 4×4 B-spline; shares the grid)
  float sdf = 200.0, depth = 30.0;
  if (rolling.hasGeom > 0.5) {
    ivec2 gsize = textureSize(geomTexture, 0);
    vec2 gp = uv * vec2(gsize) - 0.5; ivec2 g0 = ivec2(floor(gp)); vec2 gf = fract(gp); ivec2 gmx = gsize - 1;
    vec4 gx = bspline(gf.x), gy = bspline(gf.y); vec2 acc = vec2(0.0);
    for (int j = -1; j <= 2; j++) for (int i = -1; i <= 2; i++) acc += gx[i + 1] * gy[j + 1] * geomTexel(clamp(g0 + ivec2(i, j), ivec2(0), gmx));
    sdf = geomTexel(clamp(ivec2(uv * vec2(gsize)), ivec2(0), gmx)).x; depth = acc.y;
    if (sdf <= 0.0) discard;
  }

  // phase: k·x ≡ ω t(x) from the eikonal field; crestEvery draws one crest per N wavelengths (spacing ratios stay physical)
  float phase = rolling.omega * (t - rolling.time * rolling.speed) / rolling.crestEvery;
  // crest profile width: the requested w, narrowed in the shallows as c = sqrt(g·max(h, 0.5)) falls (shorter wavelength),
  // and never thinner than ~one pixel (fwidth) so crests do not alias at low zoom
  float c = sqrt(G * max(depth, 0.5)), cDeep = sqrt(G * 60.0);
  float w = rolling.crestWidth * mix(0.6, 1.0, clamp(c / cDeep, 0.0, 1.0));
  w = max(w, fwidth(phase) * 0.8);
  // One crest per 2π; suppress frequencies that exceed the pixel Nyquist limit.
  float s = 2.0 * sin(0.5 * phase);
  float crest = exp(-(s * s) / (w * w));                                // I = exp(−(sin φ / w)²): the crisp white core
  float halo = exp(-(s * s) / (16.0 * w * w)) * 0.45;                   // 4× wider cyan halo so the line reads at every zoom

  float amp = smoothstep(0.02, 0.12, hs) * mix(0.45, 1.0, clamp(hs / 1.5, 0.0, 1.0)) * (1.0 - smoothstep(1.5, PI, fwidth(phase)));                               // small swell → dimmer crests
  float shoreFade = smoothstep(0.0, 50.0, sdf) * smoothstep(0.05, 0.6, water);   // breaking-wave decay over the last 50 m
  vec3 cyan = vec3(0.0, 0.898, 1.0);
  vec3 col = cyan * halo + mix(cyan, vec3(1.0), crest * crest) * crest;   // #00E5FF halo + edges → #FFFFFF core
  float alpha = clamp(crest + halo, 0.0, 1.0) * amp * shoreFade * layer.opacity;
  fragColor = vec4(col * amp * shoreFade * layer.opacity, alpha);         // premultiplied for additive (one, one) blending
  geometry.uv = uv;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

export default class RollingWavefrontsLayer extends BitmapLayer<RollingExtra> {
  static layerName = "RollingWavefrontsLayer";
  static defaultProps = { ...BitmapLayer.defaultProps, time: 0, omega: 0.7, speed: 1, tScale: 0.25, hMax: 10, crestEvery: 3, crestWidth: 0.08, geometry: null,
    // additive luminance: crests glow over the floor, troughs add nothing
    parameters: { blend: true, blendColorOperation: "add", blendColorSrcFactor: "one", blendColorDstFactor: "one", blendAlphaOperation: "add", blendAlphaSrcFactor: "one", blendAlphaDstFactor: "one", depthCompare: "always" } as const };

  getShaders() {
    const s = super.getShaders();
    return { ...s, fs: FS, modules: [...s.modules, rollingUniforms] };
  }
  updateState(params: Parameters<BitmapLayer<RollingExtra>["updateState"]>[0]) {
    super.updateState(params as never);
    const { props, oldProps } = params as unknown as { props: RollingExtra; oldProps: RollingExtra };
    if (props.geometry !== oldProps.geometry) {
      const st = this.state as { geomTexture?: Texture };
      st.geomTexture?.destroy();
      st.geomTexture = props.geometry ? this.context.device.createTexture({ data: props.geometry, width: props.geometry.width, height: props.geometry.height, format: "rgba8unorm", sampler: { minFilter: "nearest", magFilter: "nearest" } }) : undefined;
    }
  }
  finalizeState(context: Parameters<BitmapLayer["finalizeState"]>[0]) {
    (this.state as { geomTexture?: Texture }).geomTexture?.destroy();
    super.finalizeState(context);
  }
  draw(opts: Parameters<BitmapLayer["draw"]>[0]) {
    const st = this.state as { model?: { shaderInputs: { setProps: (p: Record<string, unknown>) => void }; setBindings: (b: Record<string, unknown>) => void }; geomTexture?: Texture };
    const { time, omega, speed, tScale, hMax, crestEvery, crestWidth } = this.props as RollingProps;
    st.model?.shaderInputs.setProps({ rolling: { time, omega, speed, tScale, hMax, crestEvery, crestWidth, hasGeom: st.geomTexture ? 1 : 0 } });
    if (st.geomTexture) st.model?.setBindings({ geomTexture: st.geomTexture });
    super.draw(opts);
  }
}
