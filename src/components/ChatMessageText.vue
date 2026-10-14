<template>
  <span class="chat-message-text"><template v-for="(part, index) in parts" :key="index"><a v-if="part.href" :href="part.href" target="_blank" rel="noopener noreferrer">{{ part.text }}</a><template v-else>{{ part.text }}</template></template></span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ text: string }>()
const parts = computed(() => {
  const result: { text: string; href?: string }[] = []
  const links = /\[([^\]\r\n]{1,200})\]\((https?:\/\/(?:[^\s<>()]|\([^\s<>()]*\))+)\)|(https?:\/\/[^\s<>]+)/g
  let offset = 0
  for (const match of props.text.matchAll(links)) {
    const start = match.index!
    if (start > offset) result.push({ text: props.text.slice(offset, start) })
    let raw = match[2] || match[3].replace(/[.,;!?，。；！？）]+$/, '')
    if (!match[2]) {
      while (raw.endsWith(')') && raw.split(')').length > raw.split('(').length) raw = raw.slice(0, -1)
    }
    try {
      const url = new URL(raw)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid link')
      result.push({ text: match[1] || raw, href: url.href })
      if (!match[2] && raw.length < match[0].length) result.push({ text: match[0].slice(raw.length) })
    } catch { result.push({ text: match[0] }) }
    offset = start + match[0].length
  }
  if (offset < props.text.length) result.push({ text: props.text.slice(offset) })
  return result
})
</script>

<style scoped>
.chat-message-text { white-space:pre-wrap; overflow-wrap:anywhere; }
.chat-message-text a { color:inherit; text-decoration:underline; text-underline-offset:3px; }
.chat-message-text a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:2px; }
</style>
