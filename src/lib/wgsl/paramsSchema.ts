import type { WgslParamValue } from './types'

export type WgslParamType = 'f32' | 'vec2f' | 'vec3f' | 'vec4f'

export interface WgslParamField {
  name: string
  type: WgslParamType
  /** byte offset in the uniform buffer */
  offset: number
}

export interface WgslParamSchema {
  fields: WgslParamField[]
  byteSize: number
}

// Prevent user-supplied WGSL from creating huge per-layer uniform buffers (DoS/perf risk).
export const MAX_WGSL_PARAMS_FIELDS = 1024
export const MAX_WGSL_PARAMS_BYTE_SIZE = 4096

function alignTo(n: number, align: number): number {
  const a = Math.max(1, align | 0)
  return Math.ceil(n / a) * a
}

function typeInfo(t: WgslParamType): { align: number; size: number; lanes: number } {
  switch (t) {
    case 'f32':
      return { align: 4, size: 4, lanes: 1 }
    case 'vec2f':
      return { align: 8, size: 8, lanes: 2 }
    case 'vec3f':
      return { align: 16, size: 12, lanes: 3 }
    case 'vec4f':
      return { align: 16, size: 16, lanes: 4 }
  }
}

function parseType(raw: string): WgslParamType | null {
  const t = raw.trim()
  if (t === 'f32') return 'f32'
  if (t === 'vec2<f32>' || t === 'vec2f') return 'vec2f'
  if (t === 'vec3<f32>' || t === 'vec3f') return 'vec3f'
  if (t === 'vec4<f32>' || t === 'vec4f') return 'vec4f'
  return null
}

export function inferParamsSchema(wgsl: string): WgslParamSchema | null {
  const stripped = wgsl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const m = /struct\s+Params\s*\{([\s\S]*?)\}\s*;?/m.exec(stripped)
  if (!m) return null

  const body = m[1] ?? ''
  const fields: Array<{ name: string; type: WgslParamType }> = []

  for (const line of body.split('\n')) {
    const cleaned = line.replace(/\/\/.*$/, '').trim()
    if (!cleaned) continue
    const fm = /^([A-Za-z_]\w*)\s*:\s*([^,]+)\s*,?\s*$/.exec(cleaned)
    if (!fm) return null
    const name = fm[1]!
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') return null
    const type = parseType(fm[2]!)
    if (!type) return null
    fields.push({ name, type })
    if (fields.length > MAX_WGSL_PARAMS_FIELDS) return null
  }

  if (fields.length === 0) return { fields: [], byteSize: 16 }

  const outFields: WgslParamField[] = []
  let offset = 0
  for (const f of fields) {
    const info = typeInfo(f.type)
    offset = alignTo(offset, info.align)
    outFields.push({ name: f.name, type: f.type, offset })
    offset += info.size
  }

  const byteSize = alignTo(offset, 16)
  if (byteSize > MAX_WGSL_PARAMS_BYTE_SIZE) return null
  return { fields: outFields, byteSize }
}

export function defaultParamsForSchema(schema: WgslParamSchema): Record<string, WgslParamValue> {
  const out = Object.create(null) as Record<string, WgslParamValue>
  for (const f of schema.fields) {
    const lanes = typeInfo(f.type).lanes
    out[f.name] = lanes === 1 ? 0 : Array.from({ length: lanes }, () => 0)
  }
  return out
}

export function packParamsInto(schema: WgslParamSchema, values: Record<string, WgslParamValue>, f32: Float32Array): void {
  f32.fill(0)
  for (const f of schema.fields) {
    const idx = (f.offset / 4) | 0
    const info = typeInfo(f.type)
    const v = values[f.name]

    if (info.lanes === 1) {
      const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
      f32[idx] = n
      continue
    }

    const arr = Array.isArray(v) ? v : []
    for (let i = 0; i < info.lanes; i++) {
      const n = typeof arr[i] === 'number' && Number.isFinite(arr[i]) ? (arr[i] as number) : 0
      f32[idx + i] = n
    }
  }
}

export function packParams(schema: WgslParamSchema, values: Record<string, WgslParamValue>): ArrayBuffer {
  const buf = new ArrayBuffer(schema.byteSize)
  packParamsInto(schema, values, new Float32Array(buf))
  return buf
}

