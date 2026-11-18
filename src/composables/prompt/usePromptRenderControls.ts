import { computed, type Ref } from 'vue'
import type { DrawEngine } from '@/storage/settingsRepository'
import type { useDirectorEngine, UseDirectorEngineInput } from '@/composables/scene/useDirectorEngine'

type Controls = Pick<UseDirectorEngineInput, 'pb' | 'sdSize' | 'drawEngine' | 'animaState' | 'livePrompt'>
export const BUSY_HINT = '生成中，请稍候';

export function usePromptRenderControls({ pb, sdSize, drawEngine, animaState, livePrompt }: Controls,
    engine: ReturnType<typeof useDirectorEngine>, generationBusy: Readonly<Ref<boolean>>) {
    const { applyRecommendedSize, supportsDualCharacter, currentCapabilities, engineOnline, engineStatusText } = engine;
    // SD 直写 sdSize；Anima/Krea 2 通过底模的尺寸规则同步双引擎。
    const genBarSize = computed({
        get: () => drawEngine.value === 'sd'
            ? sdSize.value
            : `${animaState.value.width}x${animaState.value.height}`,
        set: (value: string) => {
            if (drawEngine.value === 'sd') { sdSize.value = value; pb.markParamTouched('size'); }
            else
                applyRecommendedSize(value);
        },
    });
    /** 画幅预设保留当前生效尺寸，供紧凑选择器显示。 */
    const animaBarSizes = computed<string[]>(() => {
        const activeModel = animaState.value.models.find(model => model.id === animaState.value.modelId);
        const sizes = activeModel?.sizes?.length ? [...activeModel.sizes] : ['832x1216', '1024x1024', '1216x832'];
        const current = `${animaState.value.width}x${animaState.value.height}`;
        if (!sizes.includes(current))
            sizes.unshift(current);
        return sizes;
    });
    function resetSdParams() {
        if (pb.resetParamsToProfile()) {
            applyRecommendedSize(pb.lastRecommendedSize);
            pb.flash('已恢复这套底模的推荐参数');
        }
        else
            pb.flash('当前底模没有对应的推荐参数档位，未能恢复');
    }
    function engineTitle(engine: DrawEngine) {
        if (generationBusy.value)
            return BUSY_HINT;
        if (engine === 'sd')
            return pb.isPopular ? '热门角色仅支持 Anima 无 LoRA 或 Krea 2' : undefined;
        if (!pb.isPopular && pb.char === 'triad' && !supportsDualCharacter(engine)) {
            return '双人模式请使用 SD 引擎';
        }
        return undefined;
    }
    const generateBlockReason = computed(() => {
        if (drawEngine.value === 'sd')
            return '当前仅查看旧 SD 成片；新生成请切到 Anima 或 Krea 2';
        if (!livePrompt.value)
            return '先选择场景或填写故事';
        if (!engineOnline.value)
            return engineStatusText.value;
        if (drawEngine.value === 'anima' && !pb.isPopular && !pb.isUnbound) {
            if (pb.char === 'triad' && !currentCapabilities.value.dualCharacter) return '当前模型不支持双角色，请选择单个角色';
            if (currentCapabilities.value.lora && currentCapabilities.value.characterIdentity && (animaState.value.characterLoraEnabled === false ? !currentCapabilities.value.noLora : !animaState.value.loraId)) return animaState.value.characterLoraEnabled === false ? '当前底模不支持无角色 LoRA，请更换底模或启用角色 LoRA' : '缺少角色 LoRA，请准备角色包，或关闭角色 LoRA';
        }
        return '';
    });
    return { genBarSize, animaBarSizes, resetSdParams, engineTitle, generateBlockReason };
}
