import type { WgslLayerConfig, WgslShaderDefinition } from '../wgsl/types'
import { inferParamsSchema, MAX_WGSL_PARAMS_BYTE_SIZE, packParamsInto, type WgslParamSchema } from '../wgsl/paramsSchema'
import { wrapEffectWgsl } from '../wgsl/wrapEffect'

interface CompiledLayer {
  readonly id: string
  readonly shaderId: string
  readonly pipeline: GPURenderPipeline
  readonly paramsSchema: WgslParamSchema | null
  readonly paramsBuffer: GPUBuffer | null
  readonly params: WgslLayerConfig['params']
  readonly cpuParamsBuf: ArrayBuffer | null
  readonly cpuParamsF32: Float32Array | null

  bindGroupPing: GPUBindGroup | null
  bindGroupPong: GPUBindGroup | null
}

export class PostProcessChain {
  private readonly device: GPUDevice
  private readonly format: GPUTextureFormat
  private readonly sampler: GPUSampler
  private readonly globalsBuffer: GPUBuffer
  private readonly globalsF32 = new Float32Array(4)
  private disposed = false

  private width = 0
  private height = 0

  private pingTex: GPUTexture | null = null
  private pongTex: GPUTexture | null = null
  private pingView: GPUTextureView | null = null
  private pongView: GPUTextureView | null = null

  private layers: CompiledLayer[] = []
  private readonly blitLayer: CompiledLayer

  constructor(args: { device: GPUDevice; format: GPUTextureFormat }) {
    this.device = args.device
    this.format = args.format
    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' })

    // Globals: timeSeconds, padding, resolution.xy
    this.globalsBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Built-in blit layer.
    this.blitLayer = this.compileLayer({
      id: '__blit__',
      shaderId: '__blit__',
      code: `fn effect(_uv: vec2<f32>, color: vec4<f32>) -> vec4<f32> { return color; }`,
      params: {},
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pingTex?.destroy()
    this.pongTex?.destroy()
    this.globalsBuffer.destroy()
    this.layers.forEach((l) => l.paramsBuffer?.destroy())
    this.blitLayer.paramsBuffer?.destroy()

    this.layers = []
    this.pingTex = null
    this.pongTex = null
    this.pingView = null
    this.pongView = null
  }

  getBaseRenderTargetView(): GPUTextureView | null {
    if (this.disposed) return null
    return this.pingView
  }

  setStack(args: { shaders: readonly WgslShaderDefinition[]; layers: readonly WgslLayerConfig[] }): void {
    if (this.disposed) return
    // Dispose old param buffers.
    for (const l of this.layers) l.paramsBuffer?.destroy()
    this.layers = []

    const shaderById = new Map(args.shaders.map((s) => [s.id, s] as const))
    const enabledLayers = args.layers.filter((l) => l.enabled && l.shaderId !== 'fps-cap')
    this.layers = enabledLayers.map((l) => {
      const s = shaderById.get(l.shaderId)
      const code = s?.code ?? `fn effect(_uv: vec2<f32>, color: vec4<f32>) -> vec4<f32> { return color; }`
      return this.compileLayer({ id: l.id, shaderId: l.shaderId, code, params: l.params })
    })

    this.rebuildBindGroups()
  }

  resize(width: number, height: number): void {
    if (this.disposed) return
    const w = Number.isFinite(width) ? Math.max(1, width | 0) : 1
    const h = Number.isFinite(height) ? Math.max(1, height | 0) : 1
    if (w === this.width && h === this.height && this.pingTex && this.pongTex) return

    this.width = w
    this.height = h

    this.pingTex?.destroy()
    this.pongTex?.destroy()

    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    this.pingTex = this.device.createTexture({
      size: { width: w, height: h },
      format: this.format,
      usage,
    })
    this.pongTex = this.device.createTexture({
      size: { width: w, height: h },
      format: this.format,
      usage,
    })
    this.pingView = this.pingTex.createView()
    this.pongView = this.pongTex.createView()

    this.rebuildBindGroups()
  }

  render(args: { destinationView: GPUTextureView; timeSeconds: number }): void {
    if (this.disposed) return
    if (!this.pingView || !this.pongView) return

    const time = Number.isFinite(args.timeSeconds) ? args.timeSeconds : 0
    this.globalsF32[0] = time
    this.globalsF32[1] = 0
    this.globalsF32[2] = this.width
    this.globalsF32[3] = this.height
    this.device.queue.writeBuffer(this.globalsBuffer, 0, this.globalsF32)

    const encoder = this.device.createCommandEncoder()

    const doPass = (layer: CompiledLayer, inputIsPing: boolean, outputView: GPUTextureView) => {
      if (layer.paramsSchema && layer.paramsBuffer && layer.cpuParamsF32 && layer.cpuParamsBuf) {
        packParamsInto(layer.paramsSchema, layer.params, layer.cpuParamsF32)
        this.device.queue.writeBuffer(layer.paramsBuffer, 0, layer.cpuParamsBuf)
      }

      const bindGroup = inputIsPing ? layer.bindGroupPing : layer.bindGroupPong
      if (!bindGroup) return

      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: outputView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      pass.setPipeline(layer.pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3, 1, 0, 0)
      pass.end()
    }

    const stack = this.layers.length > 0 ? this.layers : [this.blitLayer]
    let inputIsPing = true
    for (let i = 0; i < stack.length; i++) {
      const layer = stack[i]!
      const isLast = i === stack.length - 1
      const outputView = isLast ? args.destinationView : inputIsPing ? this.pongView : this.pingView
      doPass(layer, inputIsPing, outputView)
      inputIsPing = !inputIsPing
    }

    this.device.queue.submit([encoder.finish()])
  }

  private compileLayer(args: { id: string; shaderId: string; code: string; params: WgslLayerConfig['params'] }): CompiledLayer {
    if (this.disposed) throw new Error('PostProcessChain used after dispose().')
    const noComments = args.code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

    if (!/\bfn\s+effect\s*\(/.test(noComments)) {
      throw new Error(`WGSL shader "${args.shaderId}" must define fn effect(uv: vec2<f32>, color: vec4<f32>) -> vec4<f32>.`)
    }

    const paramsSchema = inferParamsSchema(args.code)
    const mentionsParams = /\bstruct\s+Params\b/.test(noComments) || /\buParams\s*\./.test(noComments)
    if (mentionsParams && !paramsSchema) {
      throw new Error(
        `WGSL shader "${args.shaderId}" has an unsupported or too-large Params struct. Supported types: f32, vec2<f32>, vec3<f32>, vec4<f32>. Max packed size: ${MAX_WGSL_PARAMS_BYTE_SIZE} bytes.`,
      )
    }
    const usesParams = Boolean(paramsSchema && paramsSchema.fields.length > 0)
    if (usesParams && paramsSchema && paramsSchema.byteSize > this.device.limits.maxUniformBufferBindingSize) {
      throw new Error(
        `WGSL shader "${args.shaderId}" Params struct is too large (${paramsSchema.byteSize} bytes). Device maxUniformBufferBindingSize=${this.device.limits.maxUniformBufferBindingSize}.`,
      )
    }
    const full = wrapEffectWgsl({ userCode: args.code, usesParams })

    const module = this.device.createShaderModule({ code: full })

    const bglEntries: GPUBindGroupLayoutEntry[] = [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: 16 },
      },
    ]
    if (usesParams && paramsSchema) {
      bglEntries.splice(2, 0, {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: paramsSchema.byteSize },
      })
    }
    const bindGroupLayout = this.device.createBindGroupLayout({ entries: bglEntries })
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] })

    const pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
    })

    const paramsBuffer =
      usesParams && paramsSchema
        ? this.device.createBuffer({
            size: paramsSchema.byteSize,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          })
        : null
    const cpuParamsBuf = usesParams && paramsSchema ? new ArrayBuffer(paramsSchema.byteSize) : null
    const cpuParamsF32 = cpuParamsBuf ? new Float32Array(cpuParamsBuf) : null

    return {
      id: args.id,
      shaderId: args.shaderId,
      pipeline,
      paramsSchema: usesParams ? paramsSchema : null,
      paramsBuffer,
      params: args.params,
      cpuParamsBuf,
      cpuParamsF32,
      bindGroupPing: null,
      bindGroupPong: null,
    }
  }

  private rebuildBindGroups(): void {
    if (this.disposed) return
    if (!this.pingView || !this.pongView) return

    const rebuild = (layer: CompiledLayer) => {
      const layout = layer.pipeline.getBindGroupLayout(0)
      const mk = (view: GPUTextureView): GPUBindGroup => {
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: view },
          { binding: 1, resource: this.sampler },
          { binding: 3, resource: { buffer: this.globalsBuffer } },
        ]
        if (layer.paramsSchema && layer.paramsBuffer) {
          entries.splice(2, 0, { binding: 2, resource: { buffer: layer.paramsBuffer } })
        }
        return this.device.createBindGroup({ layout, entries })
      }

      layer.bindGroupPing = mk(this.pingView!)
      layer.bindGroupPong = mk(this.pongView!)
    }

    rebuild(this.blitLayer)
    for (const l of this.layers) rebuild(l)
  }
}

