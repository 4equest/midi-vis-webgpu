<script setup lang="ts">
import { computed } from 'vue'

import { rgbaCssFromHex } from './lib/visual/color'
import { appState } from './state/appState'

const themeStyle = computed(() => {
  return {
    '--bg-main': appState.theme.bgMain,
    '--bg-panel': appState.theme.bgPanel,
    '--ink': rgbaCssFromHex(appState.theme.ink, 0.92, 'rgba(254, 253, 221, 0.92)'),
    '--ink-dim': rgbaCssFromHex(appState.theme.ink, 0.65, 'rgba(254, 253, 221, 0.65)'),
    '--ink-panel': rgbaCssFromHex(appState.theme.panelInk, 0.92, 'rgba(28, 26, 14, 0.92)'),
    '--ink-panel-dim': rgbaCssFromHex(appState.theme.panelInk, 0.65, 'rgba(28, 26, 14, 0.65)'),
  } as Record<string, string>
})
</script>

<template>
  <div class="app-root" :style="themeStyle">
    <div class="app-frame">
      <RouterView />
    </div>
  </div>
</template>
