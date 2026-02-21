import type { GpuDeviceContext } from './gpuDevice'

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const WGSL = /* wgsl */ `
struct Uniforms {
  resolution: vec2<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VsIn {
  @location(0) a_pos: vec2<f32>,       // quad vertex in [0..1]
  @location(1) i_rect: vec4<f32>,      // x,y,w,h (pixels)
  @location(2) i_color: vec4<f32>,     // rgba (0..1)
};

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs(input: VsIn) -> VsOut {
  let xy = input.i_rect.xy + input.a_pos * input.i_rect.zw;

  // px -> NDC, y-down to y-up
  let ndc = vec2<f32>(
    (xy.x / u.resolution.x) * 2.0 - 1.0,
    1.0 - (xy.y / u.resolution.y) * 2.0
  );

  var out: VsOut;
  out.position = vec4<f32>(ndc, 0.0, 1.0);
  out.color = input.i_color;
  return out;
}

@fragment
fn fs(input: VsOut) -> @location(0) vec4<f32> {
  return input.color;
}
`

const QUAD_VERTS = new Float32Array([
  0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1,
])

export class RectRenderer {
  private readonly device: GPUDevice
  private readonly format: GPUTextureFormat
  private readonly context: GPUCanvasContext
  private readonly canvas: HTMLCanvasElement

  private readonly pipeline: GPURenderPipeline
  private readonly uniformBuffer: GPUBuffer
  private readonly bindGroup: GPUBindGroup

  private readonly quadVertexBuffer: GPUBuffer
  private instanceBuffer: GPUBuffer
  private instanceCapacity = 0

  private width = 0
  private height = 0
  private dpr = 1
  private disposed = false

  constructor(args: GpuDeviceContext & { canvas: HTMLCanvasElement }) {
    this.device = args.device
    this.format = args.format
    this.canvas = args.canvas

    const context = this.canvas.getContext('webgpu')
    if (!context) throw new Error('Failed to create a WebGPU canvas context.')
    this.context = context

    const module = this.device.createShaderModule({ code: WGSL })

    this.pipeline = this.device.createRenderPipeline({
      label: 'rect-pipeline',
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 2 * 4,
            stepMode: 'vertex',
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
          },
          {
            arrayStride: 8 * 4,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'float32x4' }, // rect
              { shaderLocation: 2, offset: 4 * 4, format: 'float32x4' }, // color
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    })

    this.uniformBuffer = this.device.createBuffer({
      // WGSL uniform struct alignment requires 16-byte size.
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    })

    this.quadVertexBuffer = this.device.createBuffer({
      size: QUAD_VERTS.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    })
    new Float32Array(this.quadVertexBuffer.getMappedRange()).set(QUAD_VERTS)
    this.quadVertexBuffer.unmap()

    this.instanceBuffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
  }

  private resizeToCanvas(dpr = window.devicePixelRatio || 1): void {
    if (this.disposed) return
    this.dpr = Math.max(1, Math.min(4, dpr))
    const nextW = Math.max(1, Math.floor(this.canvas.clientWidth * this.dpr))
    const nextH = Math.max(1, Math.floor(this.canvas.clientHeight * this.dpr))

    if (nextW === this.width && nextH === this.height) return

    this.width = nextW
    this.height = nextH
    this.canvas.width = this.width
    this.canvas.height = this.height

    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
    })

    this.device.queue.writeBuffer(this.uniformBuffer, 0, new Float32Array([this.width, this.height]))
  }

  getSize(dpr = window.devicePixelRatio || 1): { width: number; height: number; dpr: number } {
    this.resizeToCanvas(dpr)
    return { width: this.width, height: this.height, dpr: this.dpr }
  }

  getCurrentTextureView(dpr = window.devicePixelRatio || 1): GPUTextureView {
    this.resizeToCanvas(dpr)
    return this.context.getCurrentTexture().createView()
  }

  render(args: { instances: Float32Array; instanceCount: number; clear: Rgba; targetView?: GPUTextureView }): void {
    if (this.disposed) return
    const count = Number.isFinite(args.instanceCount) ? Math.max(0, args.instanceCount | 0) : 0
    this.resizeToCanvas(window.devicePixelRatio || 1)

    const requiredFloats = count * 8
    if (args.instances.length < requiredFloats) {
      throw new Error(`Instance buffer too small: need ${requiredFloats} floats, got ${args.instances.length}.`)
    }

    if (count > this.instanceCapacity) {
      this.instanceCapacity = Math.max(64, Math.ceil(count * 1.5))
      this.instanceBuffer.destroy()
      this.instanceBuffer = this.device.createBuffer({
        size: this.instanceCapacity * 8 * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
    }

    if (count > 0) {
      this.device.queue.writeBuffer(
        this.instanceBuffer,
        0,
        args.instances.buffer,
        args.instances.byteOffset,
        count * 8 * 4,
      )
    }

    const encoder = this.device.createCommandEncoder()
    const view = args.targetView ?? this.context.getCurrentTexture().createView()

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: args.clear,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })

    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup)
    pass.setVertexBuffer(0, this.quadVertexBuffer)
    pass.setVertexBuffer(1, this.instanceBuffer)
    pass.draw(6, count, 0, 0)
    pass.end()

    this.device.queue.submit([encoder.finish()])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.uniformBuffer.destroy()
    this.quadVertexBuffer.destroy()
    this.instanceBuffer.destroy()
  }
}

