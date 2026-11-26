<template>
  <div class="chat-message-rich">
    <template v-for="(block, bIndex) in blocks" :key="bIndex">
      <details v-if="block.type === 'disclosure'" class="chat-rich-disclosure" :data-kind="block.kind">
        <summary class="chat-rich-summary">
          <ArchiveIcon class="chat-rich-chevron" name="chevron-down" />
          <span class="chat-rich-summary-label">{{ block.title }}</span>
        </summary>
        <div class="chat-rich-disclosure-body">
          <dl v-if="block.rows?.length" class="chat-status-grid">
            <div v-for="(row, rIndex) in block.rows" :key="rIndex" class="chat-status-row">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </div>
          </dl>
          <template v-else>
            <p v-for="(inlines, pIndex) in block.paragraphs" :key="pIndex" class="chat-rich-paragraph">
              <template v-for="(part, iIndex) in inlines" :key="iIndex">
                <a v-if="part.type === 'link'" :href="part.href" target="_blank" rel="noopener noreferrer">{{ part.text }}</a>
                <strong v-else-if="part.type === 'strong'">{{ part.text }}</strong>
                <em v-else-if="part.type === 'em'" class="chat-rp-action">{{ part.text }}</em>
                <code v-else-if="part.type === 'code'" class="chat-inline-code">{{ part.text }}</code>
                <del v-else-if="part.type === 'del'">{{ part.text }}</del>
                <template v-else>{{ part.text }}</template>
              </template>
            </p>
          </template>
        </div>
      </details>
      <pre v-else-if="block.type === 'code'" class="chat-code-block"><code :data-lang="block.lang || undefined">{{ block.code }}</code></pre>
      <blockquote v-else-if="block.type === 'blockquote'" class="chat-rich-quote">
        <p v-for="(inlines, pIndex) in block.paragraphs" :key="pIndex" class="chat-rich-paragraph">
          <template v-for="(part, iIndex) in inlines" :key="iIndex">
            <a v-if="part.type === 'link'" :href="part.href" target="_blank" rel="noopener noreferrer">{{ part.text }}</a>
            <strong v-else-if="part.type === 'strong'">{{ part.text }}</strong>
            <em v-else-if="part.type === 'em'" class="chat-rp-action">{{ part.text }}</em>
            <code v-else-if="part.type === 'code'" class="chat-inline-code">{{ part.text }}</code>
            <del v-else-if="part.type === 'del'">{{ part.text }}</del>
            <template v-else>{{ part.text }}</template>
          </template>
        </p>
      </blockquote>
      <hr v-else-if="block.type === 'hr'" class="chat-rich-divider" />
      <p v-else class="chat-rich-paragraph">
        <template v-for="(part, iIndex) in block.inlines" :key="iIndex">
          <a v-if="part.type === 'link'" :href="part.href" target="_blank" rel="noopener noreferrer">{{ part.text }}</a>
          <strong v-else-if="part.type === 'strong'">{{ part.text }}</strong>
          <em v-else-if="part.type === 'em'" class="chat-rp-action">{{ part.text }}</em>
          <code v-else-if="part.type === 'code'" class="chat-inline-code">{{ part.text }}</code>
          <del v-else-if="part.type === 'del'">{{ part.text }}</del>
          <template v-else>{{ part.text }}</template>
        </template>
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { parseChatMessageBlocks } from '@/utils/chatMessageFormat'
import { applyChatDisplayRegex, type ChatRegexRule } from '@/utils/chatRpSettings'

const props = defineProps<{ text: string; regexRules?: readonly ChatRegexRule[] }>()
const blocks = computed(() => parseChatMessageBlocks(applyChatDisplayRegex(props.text, props.regexRules)))
</script>

<style scoped>
.chat-message-rich { display:grid; gap:var(--s-2); white-space:pre-wrap; overflow-wrap:anywhere; }
.chat-rich-paragraph { margin:0; }
.chat-message-rich a { color:inherit; text-decoration:underline; text-underline-offset:3px; }
.chat-message-rich a:focus-visible { outline:none; box-shadow:var(--focus-shadow); border-radius:2px; }
.chat-rp-action { font-style:italic; color:var(--text-secondary); }
.chat-inline-code { padding:1px 5px; border:1px solid var(--border-soft); border-radius:var(--r-sm); background:var(--bg-elevated); font:400 0.9em/1.4 var(--font-mono); }
.chat-code-block { margin:0; padding:var(--s-2) var(--s-3); overflow-x:auto; border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-elevated); font:400 var(--fs-label-sm)/1.55 var(--font-mono); white-space:pre; }
.chat-rich-quote { margin:0; padding:var(--s-1) var(--s-3); border-left:2px solid var(--accent); color:var(--text-secondary); display:grid; gap:var(--s-1); }
.chat-rich-divider { width:100%; border:0; border-top:1px solid var(--border-soft); margin:var(--s-1) 0; }
.chat-rich-disclosure { border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-surface); overflow:hidden; }
.chat-rich-summary { list-style:none; display:flex; align-items:center; gap:var(--s-2); padding:var(--s-2) var(--s-3); color:var(--text-secondary); font:500 var(--fs-label-xs)/var(--lh-label) var(--font-sans); cursor:pointer; user-select:none; }
.chat-rich-summary::-webkit-details-marker { display:none; }
.chat-rich-summary:hover { background:var(--bg-hover); color:var(--text-primary); }
.chat-rich-summary:focus-visible { outline:none; box-shadow:var(--focus-shadow); }
.chat-rich-chevron { width:14px; height:14px; flex:none; transform:rotate(-90deg); transition:transform var(--motion-control) var(--ease-out); }
.chat-rich-disclosure[open] > .chat-rich-summary .chat-rich-chevron { transform:rotate(0deg); }
.chat-rich-disclosure::details-content { interpolate-size:allow-keywords; overflow:clip; contain:layout; }
.chat-rich-disclosure:not([open])::details-content { block-size:0; }
.chat-rich-disclosure-body { padding:var(--s-2) var(--s-3) var(--s-3); border-top:1px solid var(--border-soft); display:grid; gap:var(--s-2); font-size:var(--fs-label); }
.chat-status-grid { margin:0; display:grid; gap:var(--s-1); }
.chat-status-row { display:grid; grid-template-columns:minmax(72px,auto) minmax(0,1fr); gap:var(--s-2); align-items:baseline; }
.chat-status-row dt { color:var(--text-secondary); font:500 var(--fs-label-xs)/var(--lh-label) var(--font-sans); }
.chat-status-row dd { margin:0; color:var(--text-primary); font:400 var(--fs-label)/var(--lh-body) var(--font-sans); }
@media (prefers-reduced-motion:no-preference) {
  .chat-rich-disclosure::details-content { transition:block-size var(--motion-route) var(--ease-out), content-visibility var(--motion-route) allow-discrete; }
}
@media (prefers-reduced-motion:reduce) {
  :root:not([data-motion='full']) .chat-rich-chevron { transition:none; }
}
:root:is([data-motion='reduce'],[data-motion='reduced']) .chat-rich-chevron,
:root:is([data-motion='reduce'],[data-motion='reduced']) .chat-rich-disclosure::details-content { transition:none; }
</style>
