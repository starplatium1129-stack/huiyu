import { createApp } from 'vue'
import '../../src/assets/css/design-system.css'
import '../../src/assets/css/tailwind.css'
import '../../src/assets/css/light-theme.css'
import '../../src/assets/css/native-controls.css'
import './preview.css'
import Preview from './Preview.vue'

createApp(Preview).mount('#preview')
