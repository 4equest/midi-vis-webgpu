export type WgslParamValue = number | number[]

export interface WgslShaderDefinition {
  id: string
  name: string
  code: string
  builtin: boolean
  defaultParams?: Record<string, WgslParamValue>
}

export interface WgslLayerConfig {
  id: string
  enabled: boolean
  shaderId: string
  params: Record<string, WgslParamValue>
}

export interface WgslStackState {
  shaders: WgslShaderDefinition[]
  layers: WgslLayerConfig[]
}

