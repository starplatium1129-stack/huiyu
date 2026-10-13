<script setup lang="ts">
import { inject } from 'vue'
import Icon from '../../src/components/visual/ArchiveIcon.vue'
import { previewKey, characters, choices } from './usePreview'
import Select from '../../src/components/ui/StudioSelect.vue'
const p = inject(previewKey)!
const tabs = [{ id:'character', name:'角色', icon:'character' }, { id:'scenes', name:'场景', icon:'scene' }, { id:'story', name:'描述', icon:'spark' }] as const
</script>
<template>
  <aside class="materials side-panel" aria-label="创作素材" @keydown.esc="p.s.narrow && p.toggleMaterials()">
    <div class="panel-heading"><div><span class="eyebrow">起笔</span><h2>创作素材</h2></div><button class="icon-button collapse-control" aria-label="收起素材栏" @click="p.toggleMaterials()"><Icon name="chevron-down" /></button></div>
    <div class="panel-tabs" role="group" aria-label="素材分类">
      <button v-for="tab in tabs" :key="tab.id" :aria-pressed="p.s.material===tab.id" @click="p.s.material=tab.id"><Icon :name="tab.icon" />{{ tab.name }}</button>
      <button v-if="p.s.expert" :aria-pressed="p.s.material==='history'" @click="p.s.material='history'">历史</button>
    </div>
    <div class="panel-scroll">
      <template v-if="p.s.material==='character'">
        <div class="source-switch" role="group" aria-label="角色来源"><button :aria-pressed="p.s.source==='studio'" @click="p.s.source='studio'">工作室角色</button><button :aria-pressed="p.s.source==='popular'" @click="p.s.source='popular'">热门角色</button></div>
        <template v-if="p.s.source==='studio'">
          <div class="character-grid">
            <button v-for="c in characters" :key="c.id" class="character-card" :aria-pressed="p.s.char===c.id" @click="p.changeCharacter(c.id)">
              <div class="portrait"><img :src="c.image" :alt="c.name" /><span v-if="p.s.char===c.id" class="selected-mark"><Icon name="success" /></span></div>
              <strong>{{ c.name }}</strong><small>{{ c.id==='nene' ? '魔女的夜宴' : 'CAFÉ STELLA' }}</small>
            </button>
          </div>
          <div class="character-note"><span class="violet-line" :class="{amber:p.s.char==='natsume'}"></span><div><strong>{{ p.character.name }}</strong><p>{{ p.s.char==='nene' ? '银发与紫眸，藏在温柔里的小小心事。' : '琥珀灯下，留一点时间给咖啡与故事。' }}</p></div></div>
        </template>
        <div v-else class="quiet-state"><Icon name="character" /><h3>热门角色 · 无需 LoRA</h3><p>正式版从角色档案选择人物与服装。这次原型仅提供两位工作室角色的预览。</p><button @click="p.s.source='studio'">返回工作室角色</button></div>
        <section class="form-section"><div class="section-heading"><h3>这一幕</h3><button class="text-button" @click="p.s.material='scenes'">更换场景<Icon name="chevron-down" /></button></div>
          <button class="selected-scene" @click="p.s.material='scenes'"><span class="scene-placeholder"><Icon name="scene" /></span><span><small>{{ p.scene.category }} · {{ p.scene.lighting }}</small><strong>{{ p.scene.title }}</strong><small>本机场景样张暂缺</small></span><Icon name="chevron-down" /></button>
          <p class="story-excerpt">{{ p.scene.story }}</p>
          <button class="subtle-button wide" @click="p.s.material='story'"><Icon name="spark" />编辑画面描述</button>
        </section>
        <section class="form-section"><div class="section-heading"><h3>角色特征</h3><span class="muted">跟随角色</span></div><div class="tag-row"><span>{{ p.s.char==='nene' ? '银色长发' : '黑色长发' }}</span><span>{{ p.s.char==='nene' ? '紫色眼眸' : '泪痣' }}</span><span>角色 LoRA</span></div><p class="hint">角色身份沿用已有配置，服装与镜头跟随场景。</p></section>
      </template>
      <template v-else-if="p.s.material==='scenes'">
        <label class="search-field"><Icon name="search" /><input v-model="p.s.search" aria-label="搜索场景" placeholder="搜索场景名称…" /></label><p class="hint">3 个现有 All 分级场景 · 设计预览范围</p>
        <button v-for="scene in p.visibleScenes" :key="scene.id" class="scene-option" :aria-pressed="p.s.sceneId===scene.id" @click="p.selectScene(scene.id)"><span class="scene-placeholder"><Icon name="scene" /></span><span><strong>{{ scene.title }}</strong><small>{{ scene.category }} · {{ scene.camera }}</small><small>本机场景样张暂缺</small></span><Icon v-if="p.s.sceneId===scene.id" name="success" /></button>
        <p v-if="!p.visibleScenes.length" class="quiet-state">没有匹配的预览场景，试试更短的名称。</p>
      </template>
      <template v-else-if="p.s.material==='story'">
        <label class="field-label" for="story">故事</label><textarea id="story" v-model="p.s.story" rows="7" @input="p.editStory()" />
        <label class="field-label" for="description">画面描述</label><textarea id="description" v-model="p.s.visualDescription" rows="5" placeholder="描述动作、表情、服装和周围的光线…" />
        <p class="hint">故事记录情绪；画面描述写清希望看到的细节。原型中的修改仅停留在本页。</p>
        <div class="form-section field-grid"><label>情绪<Select v-model="p.s.emotion" label="情绪" :options="[{value:'',label:'跟随场景'},...choices.EMOTION.map(x=>({value:x.id,label:x.name}))]" /></label><label>镜头<Select v-model="p.s.shot" label="镜头" :options="[{value:'',label:'跟随场景'},...choices.SHOT.map(x=>({value:x.id,label:x.name}))]" /></label><label class="span-two">光照<Select v-model="p.s.lighting" label="光照" :options="[{value:'',label:'跟随场景'},...choices.LIGHTING.map(x=>({value:x.id,label:x.name}))]" /></label></div>
      </template>
      <div v-else class="quiet-state"><Icon name="gallery" /><h3>尚无生成历史</h3><p>此预览没有读取或修改你的作品记录。</p></div>
    </div>
    <div class="panel-foot"><Icon name="info" /><span>角色与场景素材来自绘遇现有资源</span></div>
  </aside>
</template>
