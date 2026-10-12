<template>
  <section class="panel-card interrogate-setup" aria-labelledby="interrogate-setup-title">
    <span class="panel-kicker">按需能力</span>
    <h2 id="interrogate-setup-title" class="panel-heading">PixAI 图片反推</h2>
    <p class="panel-desc">只读检查当前运行时的本地模型与依赖，不下载、不加载模型或执行反推。</p>
    <p role="status" aria-live="polite">{{ readiness.status.value.message }}</p>
    <button class="btn btn-ghost btn-sm" type="button" :disabled="readiness.checking.value" @click="readiness.refresh()">{{ readiness.checking.value ? '检查中…' : '重新检查反推条件' }}</button>
    <details :open="readiness.status.value.state === 'missing'">
      <summary>准备方法与范围</summary>
      <div data-disclosure-content>
        <p>反推不随 Anima 一键准备安装。需要单独准备 PixAI Tagger v1.0、Python 3.11+、CUDA 版 Torch 与 timm；WD14 文件不用于当前反推。</p>
        <p>桌面版暂没有反推一键准备按钮。源码维护入口：<code>npm run wf -- models:prepare-pixai --plan</code>，先查看固定下载清单；实际准备时去掉 <code>--plan</code>，按本机环境指定 <code>--python</code> 与 <code>--torch-site-packages</code>。</p>
        <p>用 <code>--target-dir</code> 指向当前绘遇使用的 PixAI 根目录；源码默认的 <code>runtime/pixai</code> 不一定是已安装桌面的运行目录。若准备在其他目录，启动绘遇时需让进程继承 <code>AICS_PIXAI_CONFIG</code>，值为生成的 <code>runtime-config.json</code> 绝对路径。</p>
        <p>确认运行时采用了上述配置后，完全退出并重启绘遇，再重新检查。准备入口复用已有 CUDA Torch，只向独立目录准备 PixAI 文件与 timm，不修改现有 ComfyUI。</p>
        <p>文件检查通过不代表 GPU 可运行。首次反推还需加载模型；后续会驻留 GPU，活跃反推取消或退出绘遇会回收对应进程。</p>
      </div>
    </details>
  </section>
</template>
<script setup lang="ts">
import { onMounted } from 'vue'
import { useInterrogateReadiness } from '@/composables/useInterrogateReadiness'
const readiness = useInterrogateReadiness()
onMounted(() => { void readiness.refresh() })
</script>
<style scoped>
.interrogate-setup { margin-bottom: var(--s-5); color: var(--text-primary); }
.interrogate-setup p { color: var(--text-secondary); line-height: var(--lh-loose); overflow-wrap: anywhere; }
.interrogate-setup details { margin-top: var(--s-3); }
.interrogate-setup summary { cursor: pointer; min-height: 44px; align-content: center; }
.interrogate-setup :is(summary, button):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.interrogate-setup button:disabled { color: var(--text-disabled); opacity: 1; }
</style>
