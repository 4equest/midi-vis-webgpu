<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import { defaultParamsForSchema, inferParamsSchema } from '../lib/wgsl/paramsSchema'
import type { WgslLayerConfig, WgslParamValue, WgslShaderDefinition } from '../lib/wgsl/types'
import { appState } from '../state/appState'

const router = useRouter()
const errorMessage = ref<string | null>(null)

function makeId(prefix: string): string {
  const uuid = (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID?.()
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function toFiniteOr0(raw: string): number {
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : 0
}

const shadersById = computed(() => new Map(appState.wgsl.shaders.map((s) => [s.id, s] as const)))
const schemaByShaderId = computed(() => {
  const m = new Map<string, ReturnType<typeof inferParamsSchema>>()
  for (const s of appState.wgsl.shaders) m.set(s.id, inferParamsSchema(s.code))
  return m
})

function getShader(id: string): WgslShaderDefinition | null {
  return shadersById.value.get(id) ?? null
}

function layerSchema(layer: WgslLayerConfig) {
  return schemaByShaderId.value.get(layer.shaderId) ?? null
}

function addLayer() {
  const fallback = appState.wgsl.shaders[0]?.id ?? 'passthrough'
  const shaderId = appState.wgsl.shaders.find((s) => s.id === 'mirage-crayon')?.id ?? fallback
  const shader = getShader(shaderId)
  const schema = shader ? inferParamsSchema(shader.code) : null
  const params: Record<string, WgslParamValue> = {
    ...(schema ? defaultParamsForSchema(schema) : {}),
    ...(shader?.defaultParams ?? {}),
  }

  appState.wgsl.layers.push({
    id: makeId('layer'),
    enabled: true,
    shaderId,
    params,
  })
}

function moveLayer(i: number, delta: -1 | 1) {
  const j = i + delta
  if (j < 0 || j >= appState.wgsl.layers.length) return
  const next = [...appState.wgsl.layers]
  const tmp = next[i]!
  next[i] = next[j]!
  next[j] = tmp
  appState.wgsl.layers = next
}

function removeLayer(i: number) {
  appState.wgsl.layers.splice(i, 1)
}

function setLayerShader(layer: WgslLayerConfig, shaderId: string) {
  layer.shaderId = shaderId
  const shader = getShader(shaderId)
  const schema = shader ? inferParamsSchema(shader.code) : null
  layer.params = {
    ...(schema ? defaultParamsForSchema(schema) : {}),
    ...(shader?.defaultParams ?? {}),
  }
}

function setParam(layer: WgslLayerConfig, name: string, value: WgslParamValue) {
  layer.params = { ...layer.params, [name]: value }
}

function onUploadWgsl(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0] ?? null
  input.value = ''
  if (!f) return

  void (async () => {
    try {
      const code = await f.text()
      const id = makeId('user')
      const schema = inferParamsSchema(code)
      appState.wgsl.shaders.push({
        id,
        name: f.name.replace(/\.wgsl$/i, ''),
        code,
        builtin: false,
        defaultParams: schema ? defaultParamsForSchema(schema) : undefined,
      })
      errorMessage.value = null
    } catch (err) {
      errorMessage.value = err instanceof Error ? err.message : String(err)
    }
  })()
}

function onScalarParamInput(layer: WgslLayerConfig, name: string, e: Event) {
  setParam(layer, name, toFiniteOr0((e.target as HTMLInputElement).value))
}

function onVecParamInput(layer: WgslLayerConfig, name: string, laneIndex: number, lanes: number, e: Event) {
  const cur = Array.isArray(layer.params[name]) ? ([...(layer.params[name] as number[])] as number[]) : []
  while (cur.length < lanes) cur.push(0)
  cur[laneIndex] = toFiniteOr0((e.target as HTMLInputElement).value)
  setParam(layer, name, cur)
}
</script>

<template>
  <div class="page">
    <div class="panel">
      <div style="display: flex; justify-content: space-between; gap: 10px; align-items: center; margin-bottom: 12px">
        <h1 class="panel-title" style="margin: 0">WGSL Shaders</h1>
        <div style="display: flex; gap: 10px">
          <button class="btn" type="button" @click="router.push({ name: 'tracks' })">Back</button>
          <button class="btn" type="button" @click="addLayer">Add Layer</button>
        </div>
      </div>

      <label style="display: grid; gap: 6px; margin-bottom: 14px">
        <span class="muted">Upload WGSL (effect snippet)</span>
        <input type="file" accept=".wgsl,text/plain" @change="onUploadWgsl" />
      </label>

      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>

      <div style="display: grid; gap: 12px">
        <div
          v-for="(layer, i) in appState.wgsl.layers"
          :key="layer.id"
          style="display: grid; gap: 10px; padding: 12px; border-radius: 10px; background: rgba(0, 0, 0, 0.06)"
        >
          <div style="display: grid; grid-template-columns: 20px 1fr auto auto auto; gap: 10px; align-items: center">
            <input v-model="layer.enabled" type="checkbox" />

            <select :value="layer.shaderId" @change="setLayerShader(layer, ($event.target as HTMLSelectElement).value)">
              <option v-for="s in appState.wgsl.shaders" :key="s.id" :value="s.id">
                {{ s.name }}
              </option>
            </select>

            <button class="btn" type="button" style="padding: 8px 10px" @click="moveLayer(i, -1)">↑</button>
            <button class="btn" type="button" style="padding: 8px 10px" @click="moveLayer(i, 1)">↓</button>
            <button class="btn" type="button" style="padding: 8px 10px" @click="removeLayer(i)">Remove</button>
          </div>

          <div v-if="layerSchema(layer)?.fields?.length" style="display: grid; gap: 10px">
            <div class="muted">Parameters</div>
            <div v-for="f in layerSchema(layer)!.fields" :key="f.name" style="display: grid; gap: 6px">
              <div class="muted">{{ f.name }} ({{ f.type }})</div>
              <div v-if="f.type === 'f32'">
                <input
                  type="number"
                  step="0.001"
                  :value="typeof layer.params[f.name] === 'number' ? (layer.params[f.name] as number) : 0"
                  @input="onScalarParamInput(layer, f.name, $event)"
                />
              </div>
              <div v-else style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px">
                <input
                  v-for="k in (f.type === 'vec2f' ? 2 : f.type === 'vec3f' ? 3 : 4)"
                  :key="k"
                  type="number"
                  step="0.001"
                  :value="Array.isArray(layer.params[f.name]) ? (layer.params[f.name] as number[])[k - 1] ?? 0 : 0"
                  @input="onVecParamInput(layer, f.name, k - 1, f.type === 'vec2f' ? 2 : f.type === 'vec3f' ? 3 : 4, $event)"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

