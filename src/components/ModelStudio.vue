<template>
  <Teleport to="body">
    <dialog ref="dialog" class="model-studio" aria-label="模型导入与校准" @cancel.prevent="close" @click="backdrop">
      <header class="model-studio-heading">
        <div><small>LIVE2D</small><h2>模型导入与校准</h2></div>
        <button class="btn btn-ghost" type="button" aria-label="关闭模型工作室" @click="close"><ArchiveIcon name="close" /></button>
      </header>
      <div class="model-studio-scroll">
        <p class="model-studio-note">模型保存在本机。新角色使用独立设定和记忆；语音需另行配置。</p>
        <div class="model-studio-grid">
          <section class="model-preview-panel" aria-label="模型预览">
            <div :id="hostId" class="model-preview-host"></div>
            <p v-if="!studio.ready.value">{{ studio.busy.value ? '正在处理模型…' : '加载预览后，可观察口型、眨眼和作者动作。' }}</p>
            <div class="model-actions">
              <button class="btn btn-primary" type="button" :disabled="studio.busy.value || studio.saved.value?.disabled || (!studio.inspection.value?.valid && !studio.saved.value)" @click="studio.preview">加载预览</button>
              <button class="btn btn-ghost" type="button" :disabled="!studio.ready.value" @click="studio.stopTest">停止测试并复位</button>
              <button class="btn btn-ghost" type="button" :disabled="studio.busy.value" @click="studio.stopPreview">释放预览</button>
            </div>
            <p role="status" class="model-status">{{ studio.message.value }}</p>
            <p v-if="studio.needsReload.value">配置已落盘。完成当前对话后，重新载入页面即可生效。</p>
          </section>
          <section class="model-config-panel" aria-label="模型配置">
            <fieldset :disabled="studio.busy.value">
              <legend>选择模型</legend>
              <label v-if="existing.length">已导入角色
                <select v-model="selected" @change="studio.openExisting(selected)">
                  <option value="" disabled>选择本机角色</option>
                  <option v-for="character in existing" :key="character.id" :value="character.id">{{ character.name }}</option>
                </select>
              </label>
              <label>导入新模型文件夹<input type="file" webkitdirectory multiple aria-label="模型文件夹" @change="chooseFolder" /></label>
              <p>支持完整 Cubism 3 文件夹。最多 512 个文件、总计 256 MiB；浏览器预览的模型依赖最多 96 MiB。缺少引用会停止导入。</p>
            </fieldset>
            <details v-if="studio.inspection.value" open>
              <summary>文件检查 · {{ studio.inspection.value.valid ? '通过' : '需要修正' }}</summary>
              <p>{{ studio.inspection.value.entries.length }} 个文件 · {{ (studio.inspection.value.totalBytes / 1048576).toFixed(1) }} MiB</p>
              <ul><li v-for="(issue, index) in studio.inspection.value.issues" :key="index">{{ issue.message }} {{ issue.path || '' }}</li></ul>
              <p v-if="studio.inspection.value.candidates.parameters.length">发现 {{ studio.inspection.value.candidates.parameters.length }} 个声明或名称候选；实际范围以预览读取为准。</p>
            </details>
            <fieldset v-if="!studio.saved.value" :disabled="studio.busy.value">
              <legend>角色与来源</legend>
              <label>角色 ID<input v-model.trim="studio.identity.id" maxlength="80" placeholder="my_character" /></label>
              <label>角色名称<input v-model.trim="studio.identity.name" maxlength="80" /></label>
              <label>独立角色设定<textarea v-model="studio.identity.persona" rows="3" maxlength="8000" /></label>
              <label>作者或来源<input v-model.trim="studio.identity.author" maxlength="500" /></label>
              <label>许可与使用范围<textarea v-model="studio.identity.terms" rows="2" maxlength="2000" placeholder="记录来源及获准的使用、修改、展示或分发范围" /></label>
            </fieldset>
            <details :open="studio.ready.value">
              <summary>口型与眨眼</summary>
              <p>先选择参数，再调整闭合与张开值。可以反向；未选择的通道保持作者动画。</p>
              <ModelCalibrationFields title="口型" :binding="studio.mouth" :parameters="studio.parameters.value" :disabled="studio.busy.value" @update="(value, select) => updateBinding(studio.mouth, value, select)" />
              <label>模拟语音电平<input v-model.number="studio.level.value" type="range" min="0" max="1" step="0.02" :disabled="!studio.ready.value" @input="studio.test('mouth')" /></label>
              <ModelCalibrationFields title="左眼" :binding="studio.leftEye" :parameters="studio.parameters.value" :disabled="studio.busy.value" @update="(value, select) => updateBinding(studio.leftEye, value, select)" />
              <ModelCalibrationFields title="右眼" :binding="studio.rightEye" :parameters="studio.parameters.value" :disabled="studio.busy.value" @update="(value, select) => updateBinding(studio.rightEye, value, select)" />
              <label>眨眼开合<input v-model.number="studio.blinkLevel.value" type="range" min="0" max="1" step="0.02" :disabled="!studio.ready.value" @input="studio.test('blink')" /></label>
            </details>
            <details v-if="studio.ready.value">
              <summary>作者动作、表情与视线</summary>
              <p>名称仅用于识别文件；请逐项观察实际表现。</p>
              <div class="model-actions">
                <button v-for="name in studio.expressions.value" :key="name" type="button" class="btn btn-ghost" @click="studio.play('expression', name)">{{ name }}</button>
                <button v-for="motion in studio.motions.value" :key="`${motion.group}-${motion.index}`" type="button" class="btn btn-ghost" @click="studio.play('motion', motion.group, motion.index)">{{ motion.group }} {{ motion.index + 1 }}</button>
                <button type="button" class="btn btn-ghost" @click="studio.stopTest">恢复默认表情</button>
              </div>
              <label>视线左右<input v-model.number="studio.focusX.value" type="range" min="-1" max="1" step="0.05" @input="studio.test('focus')" /></label>
              <label>视线上下<input v-model.number="studio.focusY.value" type="range" min="-1" max="1" step="0.05" @input="studio.test('focus')" /></label>
            </details>
            <details>
              <summary>草稿、配置与诊断</summary>
              <div class="model-actions">
                <button class="btn btn-ghost" type="button" :disabled="studio.busy.value" @click="studio.saveDraft">保存校准草稿</button>
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
            </details>
          </section>
        </div>
      </div>
      <footer class="model-studio-footer">
        <span>新校准配置使用浏览器渲染；语音需另行配置。</span>
        <button class="btn btn-primary" type="button" :disabled="studio.busy.value || !studio.ready.value || studio.needsReload.value" @click="studio.save">{{ studio.saved.value ? '保存校准配置' : '保存并加入角色列表' }}</button>
      </footer>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useModelStudio } from '@/composables/useModelStudio'
import type { CalibrationBinding } from '@/live2d/modelCalibration'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import { listCompanionUiCharacters } from '@/utils/companionRegistry'
import ModelCalibrationFields from './ModelCalibrationFields.vue'
import ArchiveIcon from './visual/ArchiveIcon.vue'
import '@/assets/css/model-studio.css'
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const fluid = useFluidDialog(dialog)
const hostId = `model-preview-${crypto.randomUUID()}`
const studio = useModelStudio(hostId)
const selected = ref('')
const existing = listCompanionUiCharacters().filter(character => character.tags?.includes('local-import'))
function updateBinding(target: CalibrationBinding, value: CalibrationBinding, select: boolean) {
  studio.stopTest(); Object.assign(target, value)
  if (select) studio.selectBinding(target)
}
onMounted(() => fluid.open())
function close() { studio.dispose(); fluid.close(() => emit('close')) }
function backdrop(event: MouseEvent) { if (isBackdropClick(event, dialog.value)) close() }
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
