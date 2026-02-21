import type { Router } from 'vue-router'

import { appState } from '../../state/appState'

export async function navigateToPlayerWithAutoplay(router: Pick<Router, 'push'>): Promise<void> {
  appState.autoplay = true
  let res: unknown
  try {
    res = await router.push({ name: 'player' })
  } catch (err) {
    appState.autoplay = false
    throw err
  }

  // vue-router can resolve with a NavigationFailure (truthy) instead of throwing.
  if (res) {
    appState.autoplay = false
    throw new Error('Navigation failed.')
  }
}

