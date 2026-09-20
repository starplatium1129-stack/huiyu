<template>
  <details class="monitor advanced-decision prompt-health-panel" :class="{ 'prompt-health-compact': compact }" id="promptMonitor" :open="open !== false">
    <summary class="panel-title prompt-health-summary">
      <span>{{ compact ? '提示词与编译' : 'Prompt 实时编译 · Live Preview' }}</span>
      <span v-if="modelName" class="monitor-profile">{{ modelName }}</span>
      <span class="token-counter" :class="report.level">
        <span class="bar"><i :style="{ '--progress': progress + '%' }"></i></span>
        <span class="num">{{ report.positiveCount }}</span>
        <span class="muted">正向</span>
        <span class="prompt-health">{{ report.label }}</span>
      </span>
    </summary>

    <div class="prompt-health-body">
      <div v-if="!prompt" class="preview-output preview-empty">
        选择场景或勾选词条，提示词将在此实时动态编译呈现。
      </div>
      <div v-else class="preview-output-structured">
        <!-- 正向标签流或自然语言 -->
        <div v-for="(line, idx) in promptLines" :key="idx" class="prompt-line-block">
          <div v-if="line.type === 'tags'" class="prompt-tag-stream" aria-label="正向标签流">
            <span
              v-for="(tok, tIdx) in line.tokens"
              :key="tIdx"
              class="token-chip"
              :class="tok.kind"
              :title="tok.tooltip"
            >
              {{ tok.text }}
            </span>
          </div>
          <div v-else-if="line.type === 'prose'" class="prompt-prose-block">
            <span class="prose-label">视觉叙事引导 (Prose Directing)</span>
            <p class="prose-text">{{ line.text }}</p>
          </div>
        </div>

        <!-- 负向排除流 -->
        <div v-if="negativeText" class="prompt-neg-block">
          <span class="neg-label">负向排除 (Negative Exclusions)</span>
          <p class="neg-text">{{ negativeText }}</p>
        </div>
      </div>

      <div class="token-row">
        <span class="token-counter" :class="report.level">
          <span class="num">{{ report.positiveCount }}</span>
          <span class="muted">正向 /</span>
          <span class="neg-num">{{ report.negativeCount }}</span>
          <span class="muted">负向</span>
        </span>
        <span v-if="loraText" class="lora-hint">LoRA {{ loraText }}</span>
      </div>

      <ul v-if="warnings.length" class="prompt-health-warnings" aria-label="Prompt 优化建议">
        <li v-for="warning in warnings" :key="warning">{{ warning }}</li>
      </ul>
      <p v-else class="prompt-health-ok">提示词编译完成，格式与当前引擎完全匹配。</p>

      <div class="preview-actions">
        <button class="btn btn-primary" type="button" @click="emit('copy')">复制完整 Prompt</button>
        <button class="btn btn-ghost" type="button" @click="emit('save')">保存当前草稿</button>
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { QUALITY_WORDS } from '@/utils/promptPolicy'
import type { PromptReport } from '@/utils/promptPolicy'
import '@/assets/css/director/components/PromptHealthPanel.css'

const props = withDefaults(defineProps<{
  prompt: string
  modelName?: string
  report: PromptReport
  artViolations: string[]
  loraText?: string
  open?: boolean
  compact?: boolean
}>(), {
  open: true,
})

const emit = defineEmits<{
  copy: []
  save: []
}>()

interface FormattedToken {
  text: string
  kind: 'quality' | 'character' | 'lora' | 'tag'
  tooltip?: string
}

interface PromptLine {
  type: 'tags' | 'prose'
  tokens?: FormattedToken[]
  text?: string
}

// 质量词从 promptPolicy.QUALITY_WORDS 单一权威清单派生（空格形式匹配 Anima 展示态），
// 评级/门控词仅用于本面板的 UI 分类（2026-08-15 审计：三处质量词清单合并为一处）。
const QUALITY_RE = new RegExp(`^(?:${QUALITY_WORDS.join('|').replace(/_/g, ' ')}|score_\\d+|safe|sensitive|nsfw|general)`, 'i')
const CHAR_IDENTITY_RE = /^(?:1girl|1boy|solo|ayachi[ _]nene|shiki[ _]natsume|nene|natsume|[a-z0-9_-]+(?:_[a-z0-9_-]+)*_(?:nene|natsume))/i
const LORA_RE = /^<lora:[^>]+>$/i

function classifyToken(token: string): FormattedToken {
  const trimmed = token.trim()
  if (LORA_RE.test(trimmed)) {
    return { text: trimmed, kind: 'lora', tooltip: 'LoRA 权重注入' }
  }
  if (QUALITY_RE.test(trimmed)) {
    return { text: trimmed, kind: 'quality', tooltip: '质量/评级前缀' }
  }
  if (CHAR_IDENTITY_RE.test(trimmed)) {
    return { text: trimmed, kind: 'character', tooltip: '角色核心特征与身份' }
  }
  return { text: trimmed, kind: 'tag', tooltip: '画面属性/场景微调词条' }
}

const splitPrompt = computed(() => {
  if (!props.prompt) return { positive: '', negative: '' }
  const parts = props.prompt.split(/\n\[NEG\]\n/)
  return {
    positive: parts[0] || '',
    negative: parts[1] || '',
  }
})

const promptLines = computed<PromptLine[]>(() => {
  const positive = splitPrompt.value.positive.trim()
  if (!positive) return []
  const lines = positive.split('\n').filter(Boolean)
  return lines.map(line => {
    // If line has multiple commas or looks like tags
    if (line.includes(',') || line.startsWith('<lora:')) {
      const tokens = line
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
        .map(classifyToken)
      return { type: 'tags', tokens }
    }
    return { type: 'prose', text: line.trim() }
  })
})

const negativeText = computed(() => splitPrompt.value.negative.trim())

const progress = computed(() => Math.min(100, Math.round(props.report.positiveCount / 72 * 100)))
const warnings = computed(() => {
  const result = [...props.report.warnings]
  if (props.artViolations.length && !result.some(item => item.startsWith('违反美术规范'))) {
    result.push(`违反美术规范：${props.artViolations.join(', ')}`)
  }
  return [...new Set(result)]
})
</script>
