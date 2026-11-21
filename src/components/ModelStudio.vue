<template>
  <div class="model-studio-content">
      <div class="model-studio-scroll">
        <div class="model-studio-grid">
          <section class="model-preview-panel" aria-label="模型预览">
            <div class="model-preview-frame" :class="{ 'is-ready': studio.ready.value }" :aria-busy="studio.previewLoading.value">
              <div :id="hostId" class="model-preview-host" :aria-hidden="!studio.ready.value"></div>
              <div v-if="!studio.ready.value" class="model-preview-feedback" role="status">
                <ArchiveIcon name="model" />
                <strong>{{ studio.previewLoading.value ? '正在载入模型…' : studio.previewFailed.value ? '预览暂未载入' : '等待角色入画' }}</strong>
                <span>{{ studio.previewLoading.value ? '正在读取模型与贴图，可随时取消加载。' : studio.previewFailed.value ? '请检查下方提示，修正后重新加载。' : studio.busy.value ? '正在读取模型资料…' : '选择模型并加载预览，校准口型与眨眼。' }}</span>
              </div>
            </div>
            <div class="model-actions">
              <button class="btn btn-primary" type="button" :disabled="studio.busy.value || studio.saved.value?.disabled || (!studio.inspection.value?.valid && !studio.saved.value)" @click="loadPreview">{{ studio.previewFailed.value ? '重新加载预览' : '加载预览' }}</button>
              <button class="btn btn-ghost" type="button" :disabled="!studio.ready.value" @click="studio.stopTest">停止测试并复位</button>
              <button ref="previewAction" class="btn btn-ghost" type="button" :disabled="studio.busy.value && !studio.previewLoading.value" @click="studio.releasePreview">{{ studio.previewLoading.value ? '取消加载' : '释放预览' }}</button>
            </div>
            <p role="status" class="model-status">{{ studio.message.value }}</p>
            <p v-if="studio.needsReload.value">配置已落盘。完成当前对话后，重新载入页面即可生效。</p>
            <p v-if="studio.saved.value">{{ studio.dirty.value ? '有未保存的校准修改；保存草稿可保留进度，保存配置后才会应用。' : '当前校准与已保存配置一致。' }}</p>
          </section>
          <section class="model-config-panel" aria-label="模型配置">
            <section class="model-card-section" aria-labelledby="model-select-heading">
              <div class="model-card-header">
                <h3 id="model-select-heading" class="model-card-title">选择模型</h3>
                <span class="model-card-subtitle">Cubism 3 本地归档与导入</span>
              </div>
              <label v-if="existing.length">已导入角色
                <StudioSelect v-model="selected" placeholder="选择本机角色" label="已导入角色"
                  :disabled="studio.busy.value"
                  :options="existing.map(character => ({ value: character.id, label: character.name }))"
                  @update:model-value="(value) => studio.openExisting(String(value))" />
              </label>
              <label>导入新模型文件夹<input type="file" webkitdirectory multiple aria-label="模型文件夹" :disabled="studio.busy.value" @change="chooseFolder" /></label>
              <p>支持完整 Cubism 3 文件夹。最多 512 个文件、总计 256 MiB；浏览器预览的模型依赖最多 96 MiB。缺少引用会停止导入。</p>
            </section>
            <details v-if="studio.inspection.value" open>
              <StudioDisclosureSummary>文件检查 · {{ studio.inspection.value.valid ? '通过' : '需要修正' }}</StudioDisclosureSummary><div data-disclosure-content>
              <p>{{ studio.inspection.value.entries.length }} 个文件 · {{ (studio.inspection.value.totalBytes / 1048576).toFixed(1) }} MiB</p>
              <ul><li v-for="(issue, index) in studio.inspection.value.issues" :key="index">{{ issue.message }} {{ issue.path || '' }}</li></ul>
              <p v-if="studio.inspection.value.candidates.parameters.length">发现 {{ studio.inspection.value.candidates.parameters.length }} 个声明或名称候选；实际范围以预览读取为准。</p>
            </div></details>
            <section v-if="!studio.saved.value" class="model-card-section" aria-labelledby="model-identity-heading">
              <div class="model-card-header">
                <h3 id="model-identity-heading" class="model-card-title">角色与来源</h3>
                <span class="model-card-subtitle">身份档案与署名记录</span>
              </div>
              <label>角色 ID<input class="input" v-model.trim="studio.identity.id" maxlength="80" placeholder="my_character" :disabled="studio.busy.value" /></label>
              <label>角色名称<input class="input" v-model.trim="studio.identity.name" maxlength="80" :disabled="studio.busy.value" /></label>
              <label>独立角色设定<textarea class="input" v-model="studio.identity.persona" rows="3" maxlength="8000" :disabled="studio.busy.value" /></label>
              <label>作者或来源<input class="input" v-model.trim="studio.identity.author" maxlength="500" :disabled="studio.busy.value" /></label>
              <label>许可与使用范围<textarea class="input" v-model="studio.identity.terms" rows="2" maxlength="2000" placeholder="记录来源及获准的使用、修改、展示或分发范围" :disabled="studio.busy.value" /></label>
            </section>
            <details :open="studio.ready.value">
              <StudioDisclosureSummary>口型与眨眼</StudioDisclosureSummary><div data-disclosure-content>
              <ModelCalibrationFields title="口型" :binding="studio.mouth" :parameters="studio.parameters.value" :disabled="studio.busy.value" @update="(value, select) => updateBinding(studio.mouth, value, select)" />
              <div class="model-slider-field">
                <div class="model-slider-head"><span>模拟语音电平</span><span class="model-slider-val">{{ Math.round(studio.level.value * 100) }}%</span></div>
                <StudioSlider v-model="studio.level.value" :min="0" :max="1" :step="0.02" compact :disabled="!studio.ready.value" aria-label="模拟语音电平" @update:model-value="() => studio.test('mouth')" />
              </div>
              <ModelCalibrationFields title="左眼" :binding="studio.leftEye" :parameters="studio.parameters.value" :disabled="studio.busy.value" @update="(value, select) => updateBinding(studio.leftEye, value, select)" />
              <ModelCalibrationFields title="右眼" :binding="studio.rightEye" :parameters="studio.parameters.value" :disabled="studio.busy.value" @update="(value, select) => updateBinding(studio.rightEye, value, select)" />
              <div class="model-slider-field">
                <div class="model-slider-head"><span>眨眼开合</span><span class="model-slider-val">{{ Math.round(studio.blinkLevel.value * 100) }}%</span></div>
                <StudioSlider v-model="studio.blinkLevel.value" :min="0" :max="1" :step="0.02" compact :disabled="!studio.ready.value" aria-label="眨眼开合" @update:model-value="() => studio.test('blink')" />
              </div>
            </div></details>
            <details v-if="studio.ready.value">
              <StudioDisclosureSummary>作者动作、表情与视线</StudioDisclosureSummary><div data-disclosure-content>
              <div class="model-expression-grid" role="group" aria-label="表情与动作预设">
                <button
                  v-for="name in studio.expressions.value"
                  :key="name"
                  type="button"
                  class="model-expression-card"
                  :aria-pressed="activePreset === `exp:${name}`"
                  @click="playExpression(name)"
                >
                  <span class="model-expression-icon"><ArchiveIcon name="spark" /></span>
                  <span class="model-expression-copy">
                    <strong>{{ name }}</strong>
                    <small>表情预设</small>
                  </span>
                </button>
                <button
                  v-for="motion in studio.motions.value"
                  :key="`${motion.group}-${motion.index}`"
                  type="button"
                  class="model-expression-card"
                  :aria-pressed="activePreset === `mot:${motion.group}-${motion.index}`"
                  @click="playMotion(motion.group, motion.index)"
                >
                  <span class="model-expression-icon"><ArchiveIcon name="wand" /></span>
                  <span class="model-expression-copy">
                    <strong>{{ motion.group }} {{ motion.index + 1 }}</strong>
                    <small>动作片段</small>
                  </span>
                </button>
                <button
                  type="button"
                  class="model-expression-card is-reset"
                  :aria-pressed="activePreset === ''"
                  @click="resetExpression"
                >
                  <span class="model-expression-icon"><ArchiveIcon name="refresh" /></span>
                  <span class="model-expression-copy">
                    <strong>恢复默认表情</strong>
                    <small>静置归位</small>
                  </span>
                </button>
              </div>
              <div class="model-slider-field">
                <div class="model-slider-head"><span>视线左右</span><span class="model-slider-val">{{ studio.focusX.value.toFixed(2) }}</span></div>
                <StudioSlider v-model="studio.focusX.value" :min="-1" :max="1" :step="0.05" compact aria-label="视线左右" @update:model-value="() => studio.test('focus')" />
              </div>
              <div class="model-slider-field">
                <div class="model-slider-head"><span>视线上下</span><span class="model-slider-val">{{ studio.focusY.value.toFixed(2) }}</span></div>
                <StudioSlider v-model="studio.focusY.value" :min="-1" :max="1" :step="0.05" compact aria-label="视线上下" @update:model-value="() => studio.test('focus')" />
              </div>
            </div></details>
            <details>
              <StudioDisclosureSummary>草稿、配置与诊断</StudioDisclosureSummary><div data-disclosure-content>
              <div class="model-actions">
                <button class="btn btn-ghost" type="button" :disabled="studio.busy.value || studio.draftSaving.value" @click="studio.saveDraft">{{ studio.draftSaving.value ? '正在保存草稿…' : '保存校准草稿' }}</button>
                <button class="btn btn-ghost" type="button" :disabled="studio.busy.value" @click="studio.restoreDraft">恢复草稿</button>
                <button class="btn btn-ghost" type="button" :disabled="studio.busy.value" @click="studio.undo">撤销未保存修改</button>
                <button class="btn btn-ghost" type="button" :disabled="studio.busy.value" @click="studio.exportProfile">导出配置</button>
              </div>
              <label>载入口型与眨眼配置<input type="file" accept="application/json,.json" :disabled="studio.busy.value" @change="chooseProfile" /></label>
              <p>配置绑定当前模型指纹，不能跨模型复用；草稿不包含模型文件。</p>
              <code v-if="studio.fingerprint.value">{{ studio.fingerprint.value }}</code>
              <div class="model-parameter-list"><p v-for="parameter in studio.parameters.value" :key="parameter.id">{{ parameter.id }}：{{ parameter.min }} ～ {{ parameter.max }}，默认 {{ parameter.default }}</p></div>
              <button v-if="studio.saved.value" class="btn btn-ghost" type="button" :disabled="studio.busy.value || studio.saved.value.disabled || studio.saved.value.canRollback === false" @click="studio.rollback">恢复上一份已保存配置</button>
              <template v-if="studio.saved.value">
                <p>停用会在重新载入页面后移出角色列表；模型文件、聊天和角色记忆均保留。</p>
                <button class="btn btn-ghost" type="button" :disabled="studio.busy.value || studio.saved.value.disabled" @click="studio.deactivate">{{ studio.saved.value.disabled ? '模型已停用' : '停用此模型，保留文件与记忆' }}</button>
              </template>
            </div></details>
          </section>
        </div>
      </div>
      <footer class="model-studio-footer">
        <button class="btn btn-primary" type="button" :disabled="studio.busy.value || !studio.ready.value || studio.needsReload.value || Boolean(studio.saved.value) && !studio.dirty.value" @click="studio.save">{{ studio.saved.value ? '保存校准配置' : '保存并加入角色列表' }}</button>
      </footer>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useModelStudio } from '@/composables/useModelStudio'
import type { CalibrationBinding } from '@/live2d/modelCalibration'
import { listCompanionUiCharacters } from '@/utils/companionRegistry'
import ModelCalibrationFields from './ModelCalibrationFields.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioSlider from '@/components/ui/StudioSlider.vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import '@/assets/css/model-studio.css'
const hostId = `model-preview-${crypto.randomUUID()}`
const studio = useModelStudio(hostId)
const selected = ref('')
const activePreset = ref('')
const previewAction = ref<HTMLButtonElement>()
const existing = listCompanionUiCharacters().filter(character => character.tags?.includes('local-import'))
function playExpression(name: string) {
  activePreset.value = `exp:${name}`
  studio.play('expression', name)
}
function playMotion(group: string, index: number) {
  activePreset.value = `mot:${group}-${index}`
  studio.play('motion', group, index)
}
function resetExpression() {
  activePreset.value = ''
  studio.stopTest()
}
function loadPreview(event: MouseEvent) {
  if (event.currentTarget === document.activeElement) previewAction.value?.focus({ preventScroll: true })
  void studio.preview()
}
function updateBinding(target: CalibrationBinding, value: CalibrationBinding, select: boolean) {
  studio.stopTest(); Object.assign(target, value)
  if (select) studio.selectBinding(target)
}
function chooseFolder(event: Event) {
  selected.value = ''
  const input = event.target as HTMLInputElement
  if (input.files?.length) void studio.selectFiles(Array.from(input.files))
  input.value = ''
}
function chooseProfile(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files?.[0]) void studio.importProfile(input.files[0])
  input.value = ''
}
</script>
