import type { WgslShaderDefinition } from './types'

export const BUILTIN_WGSL_SHADERS: WgslShaderDefinition[] = [
  {
    id: 'passthrough',
    name: 'Passthrough',
    builtin: true,
    code: /* wgsl */ `
fn effect(_uv: vec2<f32>, color: vec4<f32>) -> vec4<f32> {
  return color;
}
`.trim(),
  },
  {
    id: 'fps-cap',
    name: 'FPS Cap (Throttle)',
    builtin: true,
    defaultParams: {
      fps: 30.0,
    },
    code: /* wgsl */ `
struct Params {
  fps: f32,
};

fn effect(_uv: vec2<f32>, color: vec4<f32>) -> vec4<f32> {
  return color;
}
`.trim(),
  },
  {
    id: 'mirage-crayon',
    name: 'Mirage Crayon (Vertical Wobble)',
    builtin: true,
    defaultParams: {
      amplitudePx: 3.0,
      scalePx: 4.0,
      speed: 18.0,
    },
    code: /* wgsl */ `
struct Params {
  amplitudePx: f32,
  scalePx: f32, // feature size (pixels)
  speed: f32,
};

fn hash21(p: vec2<f32>) -> f32 {
  let h = dot(p, vec2<f32>(127.1, 311.7));
  return fract(sin(h) * 43758.5453);
}

fn noise2(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);

  let a = hash21(i);
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let d = hash21(i + vec2<f32>(1.0, 1.0));

  let u = f * f * (3.0 - 2.0 * f); // smoothstep
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn effect(uv: vec2<f32>, color: vec4<f32>) -> vec4<f32> {
  let res = max(vec2<f32>(1.0), uGlobals.resolution);

  // Smooth high-frequency noise field (VHS-ish) with small horizontal feature size (~3-5px by default).
  let scale = max(1.0, uParams.scalePx);
  let t = uGlobals.timeSeconds * max(0.0, uParams.speed);
  let p = (uv * res) / scale + vec2<f32>(t, t * 0.37);

  // Randomize amplitude with an additional slower noise field (requested).
  let ampBase = max(0.0, uParams.amplitudePx) / res.y;
  let ampN = noise2(p * 0.5 + vec2<f32>(7.2, t * 0.2));
  let amp = ampBase * (0.6 + 0.8 * ampN);

  let n0 = noise2(p);
  let n1 = noise2(p * 2.03 + vec2<f32>(13.7, 9.2));
  let n = (n0 + 0.5 * n1) / 1.5;

  // Nonlinear shaping for a more stylized (less uniform) feel.
  let v = n - 0.5;
  let shaped = sign(v) * pow(abs(v), 1.7);
  let jitter = shaped * 2.0 * amp;

  let uv2 = vec2<f32>(uv.x, uv.y + jitter);
  let c = sample(uv2);
  return vec4<f32>(c.rgb, color.a);
}
`.trim(),
  },
  {
    id: 'glow',
    name: 'Glow (4-tap)',
    builtin: true,
    defaultParams: {
      radius: 1.5,
      strength: 0.25,
    },
    code: /* wgsl */ `
struct Params {
  radius: f32,
  strength: f32,
};

fn effect(uv: vec2<f32>, color: vec4<f32>) -> vec4<f32> {
  let r = max(0.0, uParams.radius);
  let texel = vec2<f32>(1.0) / max(vec2<f32>(1.0), uGlobals.resolution);
  let ox = vec2<f32>(texel.x * r, 0.0);
  let oy = vec2<f32>(0.0, texel.y * r);

  let b =
    (sample(uv + ox).rgb + sample(uv - ox).rgb + sample(uv + oy).rgb + sample(uv - oy).rgb) * 0.25;

  let s = clamp(uParams.strength, 0.0, 2.0);
  let outRgb = color.rgb + b * s;
  return vec4<f32>(outRgb, color.a);
}
`.trim(),
  },
  {
    id: 'grain',
    name: 'Grain',
    builtin: true,
    defaultParams: {
      strength: 0.06,
      scale: 1.0,
    },
    code: /* wgsl */ `
struct Params {
  strength: f32,
  scale: f32,
};

fn hash21(p: vec2<f32>) -> f32 {
  let h = dot(p, vec2<f32>(127.1, 311.7));
  return fract(sin(h) * 43758.5453);
}

fn effect(uv: vec2<f32>, color: vec4<f32>) -> vec4<f32> {
  let s = clamp(uParams.strength, 0.0, 1.0);
  let n = hash21(uv * uGlobals.resolution * max(0.25, uParams.scale) + uGlobals.timeSeconds);
  return vec4<f32>(color.rgb + (n - 0.5) * s, color.a);
}
`.trim(),
  },
  {
    id: 'scanlines',
    name: 'Scanlines',
    builtin: true,
    defaultParams: {
      strength: 0.12,
      frequency: 3.1415927,
    },
    code: /* wgsl */ `
struct Params {
  strength: f32,
  frequency: f32, // radians per pixel
};

fn effect(uv: vec2<f32>, color: vec4<f32>) -> vec4<f32> {
  let y = uv.y * uGlobals.resolution.y;
  let w = 0.5 + 0.5 * sin(y * uParams.frequency);
  let s = clamp(uParams.strength, 0.0, 1.0);
  let shade = mix(1.0 - s, 1.0, w);
  return vec4<f32>(color.rgb * shade, color.a);
}
`.trim(),
  },
  {
    id: 'vignette',
    name: 'Vignette',
    builtin: true,
    defaultParams: {
      strength: 0.35,
      radius: 0.72,
    },
    code: /* wgsl */ `
struct Params {
  strength: f32,
  radius: f32,
};

fn effect(uv: vec2<f32>, color: vec4<f32>) -> vec4<f32> {
  let p = uv - vec2<f32>(0.5, 0.5);
  let d = length(p);
  let r = clamp(uParams.radius, 0.0, 1.0);
  let v = smoothstep(r, 0.7071, d);
  let s = clamp(uParams.strength, 0.0, 1.0);
  let shade = 1.0 - v * s;
  return vec4<f32>(color.rgb * shade, color.a);
}
`.trim(),
  },
  {
    id: 'chromatic-aberration',
    name: 'Chromatic Aberration',
    builtin: true,
    defaultParams: {
      amountPx: 1.5,
    },
    code: /* wgsl */ `
struct Params {
  amountPx: f32,
};

fn effect(uv: vec2<f32>, color: vec4<f32>) -> vec4<f32> {
  let texel = vec2<f32>(1.0) / max(vec2<f32>(1.0), uGlobals.resolution);
  let a = max(0.0, uParams.amountPx);
  let off = vec2<f32>(texel.x * a, 0.0);

  let r = sample(uv + off).r;
  let b = sample(uv - off).b;
  return vec4<f32>(r, color.g, b, color.a);
}
`.trim(),
  },
  {
    id: 'pixelate',
    name: 'Pixelate',
    builtin: true,
    defaultParams: {
      pixelSize: 4.0,
    },
    code: /* wgsl */ `
struct Params {
  pixelSize: f32, // pixels per block
};

fn effect(uv: vec2<f32>, color: vec4<f32>) -> vec4<f32> {
  let p = max(1.0, uParams.pixelSize);
  let res = max(vec2<f32>(1.0), uGlobals.resolution);
  let uvPx = uv * res;
  let snapped = (floor(uvPx / p) * p + vec2<f32>(0.5 * p)) / res;
  return sample(snapped);
}
`.trim(),
  },
  {
    id: 'sharpen',
    name: 'Sharpen (Unsharp Mask)',
    builtin: true,
    defaultParams: {
      radius: 1.0,
      strength: 0.5,
    },
    code: /* wgsl */ `
struct Params {
  radius: f32,
  strength: f32,
};

fn effect(uv: vec2<f32>, color: vec4<f32>) -> vec4<f32> {
  let texel = vec2<f32>(1.0) / max(vec2<f32>(1.0), uGlobals.resolution);
  let r = max(0.0, uParams.radius);
  let ox = vec2<f32>(texel.x * r, 0.0);
  let oy = vec2<f32>(0.0, texel.y * r);

  let blur = (sample(uv + ox).rgb + sample(uv - ox).rgb + sample(uv + oy).rgb + sample(uv - oy).rgb) * 0.25;
  let s = clamp(uParams.strength, 0.0, 2.0);
  let outRgb = color.rgb + (color.rgb - blur) * s;
  return vec4<f32>(outRgb, color.a);
}
`.trim(),
  },
]
