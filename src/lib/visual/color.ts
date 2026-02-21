export interface Rgb255 {
  r: number
  g: number
  b: number
}

export function parseHexRgb(hex: string): Rgb255 | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = Number.parseInt(m[1]!, 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

export function rgb01FromHex(hex: string, fallback: [number, number, number]): [number, number, number] {
  const rgb = parseHexRgb(hex)
  if (!rgb) return fallback
  return [rgb.r / 255, rgb.g / 255, rgb.b / 255]
}

export function rgbaCssFromHex(hex: string, alpha: number, fallback: string): string {
  const rgb = parseHexRgb(hex)
  if (!rgb) return fallback
  const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`
}

