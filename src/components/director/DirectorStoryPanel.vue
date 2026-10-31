<template>
  <div class="panel step-panel" id="stepStory">
    <label class="panel-title" for="directorStoryInput">故事</label>
    <textarea id="directorStoryInput" class="story-input" v-model="pb.story"
      aria-label="故事"
      placeholder="描述这一幕情节或台词…"
      spellcheck="false"
      autocorrect="off"
      autocapitalize="off"
      @input="onStoryInput"></textarea>
    <label class="visual-description-label" for="visualDescription">画面描述</label>
    <textarea id="visualDescription" class="visual-description-input" v-model="pb.visualDescription"
      placeholder="描述动作、表情、服装与光影…"
      spellcheck="false"
      autocorrect="off"
      autocapitalize="off"></textarea>
    <div v-if="pb.activeScene" class="scene-context">
      <span class="scene-context-title">{{ pb.activeScene.title }}</span>
      <button class="btn btn-quiet btn-sm" type="button" @click="detachScene()"><ArchiveIcon name="close" />解除绑定</button>
    </div>
    <div class="story-chips">
      <button v-for="s in storyChips" :key="s" type="button" class="btn btn-ghost btn-sm story-chip"
        @click="pb.setStory(s)">{{ s }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { onMounted } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import { storyChips } from '@/composables/scene/directorOptions'
import '@/assets/css/director/components/DirectorStoryPanel.css'

const pb = usePromptBuilderStore()
const emit = defineEmits<{ ready: [] }>()
onMounted(() => emit('ready'))

function detachScene() {
  if (!pb.sceneId) return
  pb.clearScene({ keepStory: true })
  pb.flash('已解除场景绑定，保留当前故事')
}

function onStoryInput() {
  if (pb.sceneId && pb.story !== pb.sceneBaseStory) {
    detachScene()
  }
}
</script>
