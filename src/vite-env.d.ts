/// <reference types="vite/client" />

declare module 'virtual:data-version' {
  export const DATA_VERSION: number
}

declare module '*.json?chat-presentation' {
  const card: { data: { name: string; first_mes: string } }
  export default card
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, unknown>
  export default component
}

declare module '*.css' {
  const content: Record<string, string>
  export default content
}
