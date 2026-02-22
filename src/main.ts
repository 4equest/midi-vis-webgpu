import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { initSettingsPersistence } from './lib/state/settingsPersistence'
import { appState } from './state/appState'

const stopPersistence = initSettingsPersistence(appState)
if (import.meta.hot) {
  import.meta.hot.dispose(() => stopPersistence())
}

createApp(App).use(router).mount('#app')
