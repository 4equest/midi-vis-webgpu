export interface GpuDeviceContext {
  device: GPUDevice
  format: GPUTextureFormat
}

let cached: Promise<GpuDeviceContext> | null = null
type GpuDeviceLostListener = (info: GPUDeviceLostInfo) => void
const lostListeners = new Set<GpuDeviceLostListener>()
type GpuUncapturedErrorListener = (err: GPUError) => void
const uncapturedErrorListeners = new Set<GpuUncapturedErrorListener>()

export function onGpuDeviceLost(cb: GpuDeviceLostListener): () => void {
  lostListeners.add(cb)
  return () => lostListeners.delete(cb)
}

export function onGpuUncapturedError(cb: GpuUncapturedErrorListener): () => void {
  uncapturedErrorListeners.add(cb)
  return () => uncapturedErrorListeners.delete(cb)
}

export function isWebGpuSupported(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

export async function getGpuDevice(): Promise<GpuDeviceContext> {
  if (cached) return cached

  cached = (async () => {
    if (!isWebGpuSupported()) throw new Error('WebGPU is not supported in this browser.')

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('Failed to acquire a WebGPU adapter.')

    const device = await adapter.requestDevice()
    const format = navigator.gpu.getPreferredCanvasFormat()

    device.addEventListener('uncapturederror', (ev) => {
      const err = (ev as GPUUncapturedErrorEvent).error
      for (const cb of uncapturedErrorListeners) {
        try {
          cb(err)
        } catch (e) {
          console.error('onGpuUncapturedError listener threw', e)
        }
      }
    })

    // Allow recovery by re-acquiring a device after GPU reset/device loss.
    device.lost
      .then((info) => {
        cached = null
        for (const cb of lostListeners) {
          try {
            cb(info)
          } catch (err) {
            console.error('onGpuDeviceLost listener threw', err)
          }
        }
      })
      .catch(() => {
        cached = null
      })
    return { device, format }
  })().catch((err) => {
    cached = null
    throw err
  })

  return cached
}

