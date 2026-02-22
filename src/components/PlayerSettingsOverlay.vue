<script setup lang="ts">
import TrackSettingsForm from './TrackSettingsForm.vue'

const emit = defineEmits<{
  close: []
}>()
</script>

<template>
  <div class="overlay" @pointerdown.self="emit('close')">
    <div class="panel settings-panel">
      <div class="settings-header">
        <h1 class="panel-title" style="margin: 0">Settings</h1>
        <button class="btn" type="button" @click="emit('close')">Close</button>
      </div>

      <TrackSettingsForm />
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

