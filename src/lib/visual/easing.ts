export function easeOutExpo(t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  return 1 - Math.pow(2, -10 * t)
}

