import { describe, expect, it } from 'vitest'

import { inferParamsSchema, MAX_WGSL_PARAMS_BYTE_SIZE, MAX_WGSL_PARAMS_FIELDS } from '../src/lib/wgsl/paramsSchema'

function wgslWithFields(lines: string[]): string {
  return `struct Params {\n${lines.join('\n')}\n};\nfn effect(_uv: vec2<f32>, color: vec4<f32>) -> vec4<f32> { return color; }`
}

describe('inferParamsSchema', () => {
  it('returns null when packed size exceeds MAX_WGSL_PARAMS_BYTE_SIZE', () => {
    const fields = Array.from({ length: MAX_WGSL_PARAMS_BYTE_SIZE / 16 + 1 }, (_, i) => `p${i}: vec4f,`)
    const code = wgslWithFields(fields)
    expect(inferParamsSchema(code)).toBeNull()
  })

  it('accepts Params at the max size boundary', () => {
    const maxVec4 = MAX_WGSL_PARAMS_BYTE_SIZE / 16
    const fields = Array.from({ length: maxVec4 }, (_, i) => `p${i}: vec4f,`)
    const code = wgslWithFields(fields)
    const schema = inferParamsSchema(code)
    expect(schema).not.toBeNull()
    expect(schema?.byteSize).toBe(MAX_WGSL_PARAMS_BYTE_SIZE)
  })

  it('returns null when field count exceeds MAX_WGSL_PARAMS_FIELDS', () => {
    const fields = Array.from({ length: MAX_WGSL_PARAMS_FIELDS + 1 }, (_, i) => `p${i}: f32,`)
    const code = wgslWithFields(fields)
    expect(inferParamsSchema(code)).toBeNull()
  })
})

