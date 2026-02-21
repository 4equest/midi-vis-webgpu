import { describe, expect, it, vi } from 'vitest'

import { navigateToPlayerWithAutoplay } from '../src/lib/navigation/autoplayToPlayer'
import { appState } from '../src/state/appState'

describe('navigateToPlayerWithAutoplay', () => {
  it('sets autoplay=true and navigates', async () => {
    appState.autoplay = false
    const router = { push: vi.fn().mockResolvedValue(undefined) }

    await navigateToPlayerWithAutoplay(router as any)

    expect(appState.autoplay).toBe(true)
    expect(router.push).toHaveBeenCalledWith({ name: 'player' })
  })

  it('resets autoplay=false when navigation fails', async () => {
    appState.autoplay = false
    const router = { push: vi.fn().mockRejectedValue(new Error('push failed')) }

    await expect(navigateToPlayerWithAutoplay(router as any)).rejects.toThrow('push failed')
    expect(appState.autoplay).toBe(false)
  })

  it('resets autoplay=false when navigation resolves to a failure', async () => {
    appState.autoplay = false
    const router = { push: vi.fn().mockResolvedValue({}) }

    await expect(navigateToPlayerWithAutoplay(router as any)).rejects.toThrow('Navigation failed.')
    expect(appState.autoplay).toBe(false)
  })
})

