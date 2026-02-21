import { createRouter, createWebHashHistory } from 'vue-router'

import PlayerPage from './pages/PlayerPage.vue'
import ShaderSettingsPage from './pages/ShaderSettingsPage.vue'
import TrackSelectPage from './pages/TrackSelectPage.vue'
import UploadPage from './pages/UploadPage.vue'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'upload', component: UploadPage },
    { path: '/tracks', name: 'tracks', component: TrackSelectPage },
    { path: '/shaders', name: 'shaders', component: ShaderSettingsPage },
    { path: '/play', name: 'player', component: PlayerPage },
  ],
})

