<script setup lang="ts">
import { computed } from 'vue'

import { appState } from '../state/appState'

const emit = defineEmits<{
  close: []
}>()

const midiSummary = computed(() => {
  const midi = appState.midi
  if (!midi) return null
  return {
    tracks: midi.tracks.length,
    enabled: appState.trackSettings.filter((t) => t.enabled).length,
    durationSeconds: midi.durationSeconds,
  }
})

function formatTrackLabel(trackIndex: number): string {
  const tr = appState.midi?.tracks[trackIndex]
  const base = tr?.name?.trim() || `Track ${trackIndex + 1}`
  if (!tr) return base
  const ch = tr.channel + 1
  return tr.isDrum ? `${base} (Ch ${ch}, drums)` : `${base} (Ch ${ch})`
}
</script>

<template>
  <div class="overlay" @pointerdown.self="emit('close')">
    <div class="panel settings-panel">
      <div class="settings-header">
        <h1 class="panel-title" style="margin: 0">Settings</h1>
        <button class="btn" type="button" @click="emit('close')">Close</button>
      </div>

      <p v-if="midiSummary" class="muted" style="margin: 0 0 12px">
        Tracks: {{ midiSummary.tracks }} / Display: {{ midiSummary.enabled }} / Duration:
        {{ midiSummary.durationSeconds.toFixed(2) }}s
      </p>

      <div style="display: grid; gap: 12px">
        <label style="display: grid; gap: 6px">
          <span class="muted">Title</span>
          <input v-model="appState.title" type="text" />
        </label>

        <div style="display: grid; gap: 8px">
          <span class="muted">Theme</span>
          <label style="display: grid; grid-template-columns: 1fr 70px; gap: 10px; align-items: center">
            <span class="muted">Main background</span>
            <input v-model="appState.theme.bgMain" type="color" />
          </label>
          <label style="display: grid; grid-template-columns: 1fr 70px; gap: 10px; align-items: center">
            <span class="muted">Panel background</span>
            <input v-model="appState.theme.bgPanel" type="color" />
          </label>
          <label style="display: grid; grid-template-columns: 1fr 70px; gap: 10px; align-items: center">
            <span class="muted">Player ink</span>
            <input v-model="appState.theme.ink" type="color" />
          </label>
          <label style="display: grid; grid-template-columns: 1fr 70px; gap: 10px; align-items: center">
            <span class="muted">Settings ink</span>
            <input v-model="appState.theme.panelInk" type="color" />
          </label>
        </div>

        <label style="display: grid; gap: 6px">
          <span class="muted">Measures to display (default 2)</span>
          <input v-model.number="appState.measuresToDisplay" type="number" min="1" max="16" />
        </label>

        <div style="display: grid; gap: 8px">
          <span class="muted">Display tracks</span>
          <div style="display: grid; gap: 8px; max-height: 240px; overflow: auto; padding: 6px 0">
            <div
              v-for="t in appState.trackSettings"
              :key="t.trackIndex"
              style="
                display: grid;
                grid-template-columns: 20px 1fr 70px;
                gap: 10px;
                align-items: center;
              "
            >
              <input v-model="t.enabled" type="checkbox" />
              <div class="muted">{{ formatTrackLabel(t.trackIndex) }}</div>
              <input v-model="t.color" type="color" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.3);
  z-index: 10;
}

.settings-panel {
  width: min(760px, 92%);
  max-height: 92%;
}

.settings-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}
</style>

