export type ChordSmootherConfig = {
  /** Delay before switching from one chord to another (ms). */
  switchDelayMs: number
  /** Delay before switching to N.C. (ms). */
  ncDelayMs: number
}

const DEFAULT_CONFIG: ChordSmootherConfig = {
  switchDelayMs: 200,
  ncDelayMs: 300,
}

export class ChordSmoother {
  private current: string
  private candidate: string | null = null
  private candidateSinceMs = 0
  private readonly cfg: ChordSmootherConfig

  constructor(cfg: Partial<ChordSmootherConfig> = {}, initial = 'N.C.') {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg }
    this.current = initial
  }

  reset(value = 'N.C.'): void {
    this.current = value
    this.candidate = null
    this.candidateSinceMs = 0
  }

  get(): string {
    return this.current
  }

  update(raw: string, nowMs: number): string {
    const next = raw && raw.trim() ? raw.trim() : 'N.C.'

    if (next === this.current) {
      this.candidate = null
      return this.current
    }

    // If we are currently at N.C., switch immediately to the first detected chord
    // so the display feels responsive.
    if (this.current === 'N.C.' && next !== 'N.C.') {
      this.current = next
      this.candidate = null
      return this.current
    }

    if (this.candidate !== next) {
      this.candidate = next
      this.candidateSinceMs = nowMs
      return this.current
    }

    const delay = next === 'N.C.' ? this.cfg.ncDelayMs : this.cfg.switchDelayMs
    if (nowMs - this.candidateSinceMs >= delay) {
      this.current = next
      this.candidate = null
    }

    return this.current
  }
}

