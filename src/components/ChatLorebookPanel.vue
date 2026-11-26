<template>
  <section class="chat-lorebook-panel room-tool-panel" aria-labelledby="chatLorebookTitle">
    <header class="room-tool-heading">
      <div>
        <span class="clb-kicker">WORLD INFO & LOREBOOKS</span>
        <h2 id="chatLorebookTitle">世界书与动态知识库</h2>
      </div>
      <button type="button" class="btn btn-quiet btn-icon" aria-label="关闭世界书面板" @click="emit('close')">
        <ArchiveIcon name="close" />
      </button>
    </header>

    <div class="room-tool-body clb-body">
      <section class="clb-global-bar" aria-label="世界书全局扫描设置">
        <label class="clb-budget-label">
          <span>单轮世界书字数预算：<strong>{{ store.budget }} 字</strong></span>
          <input v-model.number="store.budget" type="range" min="500" max="16000" step="500" @change="persist" />
        </label>
        <ToggleSwitch v-model="store.recursive" label="递归扫描" @update:model-value="persist">
          递归扫描（命中条目的正文可继续触发下一条世界书）
        </ToggleSwitch>
        <div class="clb-global-actions">
          <input ref="importInputRef" type="file" accept=".json,application/json" multiple hidden @change="onImportJson" />
          <button type="button" class="btn btn-primary btn-sm" @click="addBook">新建世界书</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="importInputRef?.click()">导入 Tavern JSON</button>
        </div>
      </section>

      <div v-if="!store.books.length" class="clb-empty">
        暂无独立或全局世界书。你可以点击上方「新建世界书」或导入标准 SillyTavern World Info JSON。
      </div>

      <template v-else>
        <div class="clb-book-tabs" role="tablist" aria-label="选择世界书">
          <button
            v-for="book in store.books"
            :key="book.id"
            type="button"
            role="tab"
            class="clb-book-tab"
            :class="{ 'is-selected': book.id === selectedBookId, 'is-disabled': !book.enabled }"
            :aria-selected="book.id === selectedBookId"
            @click="selectedBookId = book.id"
          >
            <strong>{{ book.name }}</strong>
            <span>{{ book.scope === 'global' ? '全局' : `${book.characterIds.length} 角色` }} · {{ book.entries.length }} 条</span>
          </button>
        </div>

        <section v-if="activeBook" class="clb-book-editor" aria-label="编辑当前世界书">
          <div class="clb-book-head">
            <input v-model="activeBook.name" class="input" maxlength="64" placeholder="世界书名称" @change="persist" />
            <ToggleSwitch v-model="activeBook.enabled" label="启用此世界书" @update:model-value="persist">启用</ToggleSwitch>
            <button type="button" class="btn btn-ghost btn-sm" @click="exportBook(activeBook)">导出 JSON</button>
            <button type="button" class="btn btn-quiet btn-sm" @click="removeBook(activeBook)">删除</button>
          </div>

          <input v-model="activeBook.description" class="input" maxlength="200" placeholder="世界书简介（可选）" @change="persist" />

          <div class="clb-scope-box">
            <div class="clb-scope-radios">
              <label>
                <input v-model="activeBook.scope" type="radio" value="global" @change="persist" />
                <span>全局生效（所有角色对话均可触发）</span>
              </label>
              <label>
                <input v-model="activeBook.scope" type="radio" value="characters" @change="persist" />
                <span>仅指定角色生效</span>
              </label>
            </div>
            <div v-if="activeBook.scope === 'characters'" class="clb-char-bindings">
              <button type="button" class="btn btn-ghost btn-sm" @click="toggleCharacterBinding(activeBook, characterId)">
                {{ activeBook.characterIds.includes(characterId) ? `取消绑定当前角色（${characterName}）` : `绑定到当前角色（${characterName}）` }}
              </button>
              <div class="clb-char-chips">
                <button
                  v-for="char in availableCharacters"
                  :key="char.id"
                  type="button"
                  class="clb-char-chip"
                  :class="{ 'is-bound': activeBook.characterIds.includes(char.id) }"
                  @click="toggleCharacterBinding(activeBook, char.id)"
                >
                  {{ char.name }}
                </button>
              </div>
            </div>
          </div>

          <div class="clb-entries-bar">
            <strong>条目列表（{{ activeBook.entries.length }} / 200）</strong>
            <button type="button" class="btn btn-primary btn-sm" @click="addEntry(activeBook)">+ 新增条目</button>
          </div>

          <div class="clb-entries-list">
            <details v-for="(entry, idx) in activeBook.entries" :key="entry.id" class="clb-entry-card" :open="idx === 0">
              <summary class="clb-entry-summary">
                <span class="clb-dot" :class="{ 'is-on': entry.enabled }" aria-hidden="true" />
                <strong>{{ entry.comment || (entry.keys.length ? entry.keys.join(', ') : entry.constant ? '常驻设定' : '未命名条目') }}</strong>
                <small>{{ positionLabel(entry.position, entry.depth) }} · 权重 {{ entry.insertionOrder }}</small>
              </summary>
              <div class="clb-entry-body">
                <div class="clb-entry-row">
                  <input v-model="entry.comment" class="input" maxlength="64" placeholder="条目标题 / 备注" @change="persist" />
                  <ToggleSwitch v-model="entry.enabled" label="启用条目" @update:model-value="persist">启用</ToggleSwitch>
                  <button type="button" class="btn btn-quiet btn-sm" @click="removeEntry(activeBook, idx)">删除</button>
                </div>

                <label class="clb-field">
                  <span>主关键词（多个用英文逗号分隔）</span>
                  <input
                    :value="entry.keys.join(', ')"
                    class="input"
                    placeholder="例如：黑猫, 夜樱, 咖啡馆 或 /^晚安/i"
                    @change="entry.keys = splitKeys(($event.target as HTMLInputElement).value); persist()"
                  />
                </label>

                <label v-if="entry.selective" class="clb-field">
                  <span>次关键词（选择性开启时，主次关键词需同时命中）</span>
                  <input
                    :value="entry.secondaryKeys.join(', ')"
                    class="input"
                    placeholder="次关键词，英文逗号分隔"
                    @change="entry.secondaryKeys = splitKeys(($event.target as HTMLInputElement).value); persist()"
                  />
                </label>

                <div class="clb-flags-grid">
                  <label><input v-model="entry.constant" type="checkbox" @change="persist" /> 常驻激活</label>
                  <label><input v-model="entry.selective" type="checkbox" @change="persist" /> 选择性（需次词）</label>
                  <label><input v-model="entry.useRegex" type="checkbox" @change="persist" /> 正则匹配</label>
                  <label><input v-model="entry.caseSensitive" type="checkbox" @change="persist" /> 区分大小写</label>
                  <label><input v-model="entry.wholeWords" type="checkbox" @change="persist" /> 全词匹配</label>
                </div>

                <div class="clb-pos-grid">
                  <label class="clb-field">
                    <span>注入位置</span>
                    <select v-model="entry.position" class="input" @change="persist">
                      <option value="before_char">角色设定之前</option>
                      <option value="after_char">角色设定之后</option>
                      <option value="at_depth">对话历史指定深度</option>
                    </select>
                  </label>
                  <label v-if="entry.position === 'at_depth'" class="clb-field">
                    <span>插入深度（0~16）</span>
                    <input v-model.number="entry.depth" type="number" class="input" min="0" max="16" @change="persist" />
                  </label>
                  <label class="clb-field">
                    <span>排序权重</span>
                    <input v-model.number="entry.insertionOrder" type="number" class="input" min="-9999" max="9999" @change="persist" />
                  </label>
                </div>

                <label class="clb-field">
                  <span>条目内容</span>
                  <textarea
                    v-model="entry.content"
                    class="textarea clb-autosize"
                    rows="3"
                    maxlength="4000"
                    placeholder="触发时注入给模型参考的世界设定内容（支持 {{user}} / {{char}}）"
                    @change="persist"
                  />
                </label>
              </div>
            </details>
          </div>
        </section>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import { confirmAction } from '@/composables/useConfirm'
import { listCompanionUiCharacters } from '@/utils/companionRegistry'
import {
  createBlankLorebook,
  createBlankLoreEntry,
  exportTavernLorebookJson,
  importTavernLorebookJson,
  loadLorebookStore,
  saveLorebookStore,
  type Lorebook,
  type LorebookPosition,
} from '@/utils/chatLorebooks'

const props = defineProps<{
  characterId: string
  characterName: string
}>()

const emit = defineEmits<{
  close: []
  notice: [message: string, kind?: 'info' | 'warning' | 'error']
}>()

const store = reactive(loadLorebookStore())
const selectedBookId = ref(store.books[0]?.id || '')
const importInputRef = ref<HTMLInputElement>()

const activeBook = computed(() => store.books.find(book => book.id === selectedBookId.value) || store.books[0] || null)
const availableCharacters = computed(() => listCompanionUiCharacters().map(char => ({ id: char.id, name: char.name })))

function persist() {
  const saved = saveLorebookStore(store)
  Object.assign(store, saved)
  if (!store.books.some(b => b.id === selectedBookId.value)) {
    selectedBookId.value = store.books[0]?.id || ''
  }
}

function splitKeys(raw: string): string[] {
  return raw.split(',').map(item => item.trim()).filter(Boolean)
}

function positionLabel(pos: LorebookPosition, depth: number): string {
  if (pos === 'before_char') return '设定前'
  if (pos === 'at_depth') return `深度 ${depth}`
  return '设定后'
}

function addBook() {
  const book = createBlankLorebook(`世界书 ${store.books.length + 1}`)
  store.books.push(book)
  selectedBookId.value = book.id
  persist()
}

function toggleCharacterBinding(book: Lorebook, id: string) {
  const index = book.characterIds.indexOf(id)
  if (index >= 0) book.characterIds.splice(index, 1)
  else book.characterIds.push(id)
  persist()
}

function addEntry(book: Lorebook) {
  if (book.entries.length >= 200) {
    emit('notice', '单本世界书最多 200 条。', 'warning')
    return
  }
  const order = (book.entries.at(-1)?.insertionOrder ?? 90) + 10
  book.entries.push(createBlankLoreEntry(order))
  persist()
}

function removeEntry(book: Lorebook, index: number) {
  book.entries.splice(index, 1)
  persist()
}

async function removeBook(book: Lorebook) {
  const ok = await confirmAction({
    title: `删除世界书「${book.name}」？`,
    message: `包含 ${book.entries.length} 条设定，删除后无法撤销。`,
    confirmLabel: '删除世界书',
    danger: true,
  })
  if (!ok) return
  const index = store.books.findIndex(item => item.id === book.id)
  if (index >= 0) store.books.splice(index, 1)
  persist()
  emit('notice', `已删除世界书「${book.name}」`, 'info')
}

async function onImportJson(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  if (!files.length) return
  let imported = 0
  for (const file of files) {
    try {
      const parsed = JSON.parse(await file.text())
      const book = importTavernLorebookJson(parsed, file.name)
      store.books.push(book)
      selectedBookId.value = book.id
      imported += 1
    } catch (error) {
      emit('notice', `${file.name} 导入失败：${error instanceof Error ? error.message : '格式错误'}`, 'warning')
    }
  }
  if (imported) {
    persist()
    emit('notice', `已成功导入 ${imported} 本世界书。`, 'info')
  }
}

function exportBook(book: Lorebook) {
  const json = JSON.stringify(exportTavernLorebookJson(book), null, 2)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${book.name.replace(/[^\w\u4e00-\u9fa5-]+/g, '_') || 'lorebook'}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}
</script>

<style scoped>
.clb-kicker { display:block; color:var(--text-secondary); font:600 var(--fs-label-xs)/var(--lh-label) var(--font-mono); letter-spacing:0.08em; }
.clb-body { display:grid; gap:var(--s-3); align-content:start; }
.clb-global-bar { display:grid; gap:var(--s-2); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.clb-budget-label { display:grid; gap:var(--s-1); font:500 var(--fs-label)/1.4 var(--font-sans); color:var(--text-primary); }
.clb-global-actions { display:flex; flex-wrap:wrap; gap:var(--s-2); }
.clb-empty { padding:var(--s-5); border:1px dashed var(--border-soft); border-radius:var(--r-lg); text-align:center; color:var(--text-secondary); font:400 var(--fs-label)/var(--lh-body) var(--font-sans); }
.clb-book-tabs { display:flex; flex-wrap:wrap; gap:var(--s-2); }
.clb-book-tab { display:grid; gap:2px; text-align:left; padding:var(--s-2) var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-base); cursor:pointer; color:var(--text-primary); }
.clb-book-tab.is-selected { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 10%, var(--bg-base)); }
.clb-book-tab.is-disabled { color:var(--text-disabled); }
.clb-book-tab strong { font:600 var(--fs-label)/1.3 var(--font-sans); }
.clb-book-tab span { color:var(--text-secondary); font:400 11px/1.3 var(--font-sans); }
.clb-book-editor { display:grid; gap:var(--s-3); }
.clb-book-head { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); }
.clb-book-head .input { flex:1 1 180px; }
.clb-scope-box { display:grid; gap:var(--s-2); padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); }
.clb-scope-radios { display:flex; flex-wrap:wrap; gap:var(--s-3); font:500 var(--fs-label)/1.4 var(--font-sans); }
.clb-scope-radios label { display:flex; align-items:center; gap:var(--s-1); cursor:pointer; }
.clb-char-bindings { display:grid; gap:var(--s-2); justify-items:start; }
.clb-char-chips { display:flex; flex-wrap:wrap; gap:var(--s-1); }
.clb-char-chip { padding:3px 10px; border:1px solid var(--border-soft); border-radius:999px; background:var(--bg-surface); color:var(--text-secondary); font:400 var(--fs-label-xs)/1.4 var(--font-sans); cursor:pointer; }
.clb-char-chip.is-bound { border-color:var(--accent); color:var(--accent); background:color-mix(in srgb, var(--accent) 12%, transparent); }
.clb-entries-bar { display:flex; align-items:center; justify-content:space-between; gap:var(--s-2); }
.clb-entries-list { display:grid; gap:var(--s-2); }
.clb-entry-card { border:1px solid var(--border-soft); border-radius:var(--r-lg); background:var(--bg-base); padding:var(--s-2) var(--s-3); }
.clb-entry-summary { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); cursor:pointer; }
.clb-entry-summary small { margin-left:auto; color:var(--text-secondary); font:400 11px/1.3 var(--font-mono); }
.clb-dot { width:8px; height:8px; border-radius:50%; background:var(--text-disabled); flex:none; }
.clb-dot.is-on { background:var(--accent); }
.clb-entry-body { display:grid; gap:var(--s-2); margin-top:var(--s-3); padding-top:var(--s-2); border-top:1px solid var(--border-soft); }
.clb-entry-row { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-2); }
.clb-entry-row .input { flex:1 1 160px; }
.clb-field { display:grid; gap:4px; }
.clb-field > span { color:var(--text-secondary); font:600 var(--fs-label-xs)/1.3 var(--font-sans); }
.clb-flags-grid { display:flex; flex-wrap:wrap; gap:var(--s-2) var(--s-3); font:400 var(--fs-label-xs)/1.4 var(--font-sans); color:var(--text-secondary); }
.clb-flags-grid label { display:flex; align-items:center; gap:4px; cursor:pointer; }
.clb-pos-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:var(--s-2); }
@supports (field-sizing:content) {
  .clb-autosize { field-sizing:content; resize:none; min-block-size:2.5lh; max-block-size:12lh; }
}
</style>
