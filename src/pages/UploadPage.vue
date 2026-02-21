<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'

import { appActions } from '../state/appState'

const router = useRouter()

const fileInputEl = ref<HTMLInputElement | null>(null)
const isLoading = ref(false)
const errorMessage = ref<string | null>(null)

function openFilePicker() {
  fileInputEl.value?.click()
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  isLoading.value = true
  errorMessage.value = null

  try {
    await appActions.loadMidiFile(file)
    await router.push({ name: 'tracks' })
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    isLoading.value = false
    input.value = ''
  }
}
</script>

<template>
  <div class="page">
    <div class="panel">
      <h1 class="panel-title">Upload MIDI</h1>
      <button class="btn" type="button" :disabled="isLoading" @click="openFilePicker">
        {{ isLoading ? 'Loading…' : 'Select .mid / .midi' }}
      </button>

      <input
        ref="fileInputEl"
        class="hidden"
        type="file"
        accept=".mid,.midi"
        @change="onFileChange"
      />

      <p class="muted" style="margin: 12px 0 0">Audio unlock happens on first play.</p>
      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
    </div>
  </div>
</template>

