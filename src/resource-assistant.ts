import { createApp } from 'vue'
import './assets/css/design-system.css'
import './assets/css/tailwind.css'
import './assets/css/light-theme.css'
import './assets/css/native-controls.css'
import './assets/css/interaction-motion.css'

// This entry deliberately owns no workspace, model service or editor state.
// Its bundled assets and host IPC remain usable with the gateway stopped.
void import('./views/ResourceAssistantView.vue').then(({ default: view }) => createApp(view).mount('#app'))
