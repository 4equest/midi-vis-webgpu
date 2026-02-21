export function wrapEffectWgsl(args: { userCode: string; usesParams: boolean }): string {
  const paramsDecl = args.usesParams ? '@group(0) @binding(2) var<uniform> uParams: Params;' : ''

  return /* wgsl */ `
struct Globals {
  timeSeconds: f32,
  _pad0: f32,
  resolution: vec2<f32>,
};

@group(0) @binding(0) var tSrc: texture_2d<f32>;
@group(0) @binding(1) var sSrc: sampler;
${paramsDecl}
@group(0) @binding(3) var<uniform> uGlobals: Globals;

fn sample(uv: vec2<f32>) -> vec4<f32> {
  return textureSample(tSrc, sSrc, uv);
}

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var uv = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(2.0, 1.0),
    vec2<f32>(0.0, -1.0),
  );

  var out: VsOut;
  out.position = vec4<f32>(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}

${args.userCode}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  // Some browsers can produce >1 UVs due to the full-screen triangle trick.
  let uv = clamp(in.uv, vec2<f32>(0.0), vec2<f32>(1.0));
  let color = sample(uv);
  return effect(uv, color);
}
`.trim()
}

