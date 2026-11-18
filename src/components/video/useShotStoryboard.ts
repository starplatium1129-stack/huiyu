import { ref, watch, type Ref } from 'vue'
import { createVideoStoryboard } from '@/api/videoApi'
import { useCharacterBlueprints } from '@/composables/scene/useCharacterBlueprints'
import type { ShotDraft } from './shotListTypes'
import { inferShotParams } from './useShotImport'

export function useShotStoryboard(shots: Ref<ShotDraft[]>, routeActive: Ref<boolean>, isLocked: () => boolean, batchError: Ref<string>) {
  // ── 场景蓝图一键剧本（2026-08-23）：服务端起承转合四镜确定性派生 ──────────
  // 与「AI 生成脚本」互补：零 LLM 依赖、即时返回，台词取蓝图原文；生成会整体
  // 替换镜头草稿（用户主动点生成即明确意图，草稿未提交可随时撤销重生成）。
  const storyboardBlueprintId = ref('');
  const storyboardIntent = ref('');
  const storyboardBusy = ref(false);
  let storyboardRequest: AbortController | null = null;
  function stopStoryboard() { storyboardRequest?.abort(); storyboardRequest = null; storyboardBusy.value = false; }
  async function runStoryboard() {
      const blueprintId = storyboardBlueprintId.value;
      if (!blueprintId || storyboardBusy.value || !routeActive.value || isLocked()) return;
      const controller = new AbortController(); storyboardRequest = controller;
      const originalShots = shots.value.slice(), originalText = JSON.stringify(shots.value);
      const intent = storyboardIntent.value.trim();
      const current = () => storyboardRequest === controller && !controller.signal.aborted && routeActive.value;
      storyboardBusy.value = true;
      batchError.value = '';
      try {
          const res = await createVideoStoryboard(blueprintId, intent || undefined, controller.signal);
          if (!current()) return;
          if (isLocked() || storyboardBlueprintId.value !== blueprintId || storyboardIntent.value.trim() !== intent
              || JSON.stringify(shots.value) !== originalText || shots.value.some((shot, index) => shot !== originalShots[index])) {
              batchError.value = '生成期间工作区已变化，已保留当前内容；请确认后重新生成剧本';
              return;
          }
          shots.value.forEach(shot => { if (shot.imageUrl) URL.revokeObjectURL(shot.imageUrl); });
          shots.value = res.storyboard.shots.map((shot) => ({
              prompt: shot.prompt, dialogue: shot.dialogue ?? '', shotSize: shot.shotSize,
              camera: shot.camera, motion: shot.motion,
              // 服务端固定产 3 秒；这里对 API number 做字面量收窄，非法值回落 3。
              duration: (shot.duration === 5 || shot.duration === 10 || shot.duration === 15 ? shot.duration : 3) as ShotDraft['duration'],
              seedText: '', imageName: '', imageUrl: '', cast: '',
              firstFramePrompt: shot.firstFramePrompt ?? undefined,
          }));
          storyboardBlueprintId.value = '';
          storyboardIntent.value = '';
      }
      catch (error) {
          if (current()) batchError.value = error instanceof Error ? error.message : '剧本生成失败，请稍后重试';
      }
      finally {
          if (storyboardRequest === controller) { storyboardRequest = null; storyboardBusy.value = false; }
      }
  }
  const sceneFillId = ref('')
  const blueprintCharacter = ref('');
  const blueprints = useCharacterBlueprints(() => routeActive.value ? blueprintCharacter.value : '');
  watch(blueprintCharacter, () => { sceneFillId.value = ''; storyboardBlueprintId.value = ''; });
  watch(blueprints.items, items => {
      if (blueprints.ready.value && !items.some(item => item.id === storyboardBlueprintId.value)) storyboardBlueprintId.value = '';
  });
  // 场景蓝图 → 填入所有空镜头（用户已写的不覆盖），并顺带推断景别/镜头/运动。
  watch(sceneFillId, (id) => {
      if (!id)
          return;
      const blueprint = blueprints.items.value.find((item) => item.id === id);
      if (!blueprint)
          return;
      const prose = (blueprint.promptProse || '').trim()
          || [blueprint.description, blueprint.action, blueprint.lighting].filter(Boolean).join('，');
      if (prose) {
          shots.value.forEach((shot) => {
              if (!shot.prompt.trim()) {
                  shot.prompt = prose;
                  const inferred = inferShotParams(prose);
                  shot.shotSize = inferred.shotSize;
                  shot.camera = inferred.camera;
                  shot.motion = inferred.motion;
              }
          });
      }
      sceneFillId.value = '';
  });
  return { sceneFillId, blueprintCharacter, sceneBlueprints: blueprints.items,
    blueprintReady: blueprints.ready, blueprintError: blueprints.error, retryBlueprints: blueprints.retry,
    storyboardBlueprintId, storyboardIntent, storyboardBusy, runStoryboard, stopStoryboard }
}
