import { createApp } from 'vue'
import '../assets/css/tailwind.css'
import '../assets/css/design-system.css'
import '../assets/css/native-controls.css'
import '../assets/css/studio-fields.css'
import '../assets/css/light-theme.css'
import '../assets/css/director/workspace.css'
import '../assets/css/director/atelier.css'
import './guestStudio.css'
import { initGuestTheme } from './guestTheme'
import GuestStudio from './GuestStudio.vue'

initGuestTheme()
createApp(GuestStudio).mount('#guest-app')
