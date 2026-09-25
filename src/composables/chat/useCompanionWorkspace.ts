
import { useCharacterRoomSession } from '@/composables/chat/useCharacterRoomSession';
import { useConversationReading } from '@/composables/chat/useConversationReading';
import { publishChatReceipt } from '@/utils/chatRelayReceipt';
import { useRoomPresentation } from '@/composables/chat/useRoomPresentation';
import { useCompanionAffection } from '@/composables/useCompanionAffection';
import { useCompanionBehaviorRuntime } from '@/composables/useCompanionBehaviorRuntime';
import { useCompanionClipboardImport } from '@/composables/useCompanionClipboardImport';
import { useCompanionSpeechInput } from '@/composables/useCompanionSpeechInput';
import { useCompanionPerformance } from '@/composables/useCompanionPerformance';
import { pickCompanionLine } from '@/config/characters';
import { listCompanionUiCharacters } from '@/utils/companionRegistry';
import { resolveCompanionPresence } from '@/utils/companionPresence';
import { scrollBehavior } from '@/utils/motionPreference';
import { COMPANION_CHAT_LIVE_KEY,COMPANION_LIVE2D_KEY } from '@/utils/storageKeys';
import { computed,onMounted,onUnmounted,ref,watch } from 'vue';
/** Owns workspace state and lifecycle; the view only binds presentation. */
export function useCompanionWorkspace() {
    const companionCharacters = listCompanionUiCharacters();
    const { voice, chatListRef, characterStageRef, activeChar, busy, voiceActive, chatError, chatErrorKind, toolActivity, thinkingActivity, voiceStatusText, voiceCapabilityState, isSpeaking, autoVoice, volume, preparingRoom, storage, chatProvider, chatStatusText, statusKind, chatReady, currentCharacter, companionMessages, setupTitle, inputText, replyAnnouncement, onVolumeChange, handleSend, onInputChange, prepareRoom, stopEverything, switchCharacter, onAutoVoiceChange, refreshRoomState } = useCharacterRoomSession();
    const desktopBridge = window.companionDesktop;
    const presentationSuspended = useRoomPresentation('companion');
    const { getScore, getLevelInfo } = useCompanionAffection();
    const affectionScore = computed(() => getScore(activeChar.value));
    const affectionInfo = computed(() => getLevelInfo(activeChar.value));
    const composerFocused = ref(false);
    const alwaysOnTop = ref(false);
    const ignoreMouseEvents = ref(false);
    const onBatteryPower = ref(false);
    const desktopWindowVisible = ref(!desktopBridge);
    const desktopWindowBounds = ref<{
        x: number;
        y: number;
        width: number;
        height: number;
    } | null>(null);
    const desktopLive2dOverride = ref(readDesktopLive2dOverride());
    const companionAutoLoad = computed(() => desktopBridge
        ? desktopWindowVisible.value && desktopLive2dOverride.value !== false
        : storage.state.settings.live2dEnabled);
    const immersiveMessages = computed(() => companionMessages.value.slice(-2));
    const { hasNew: hasNewMessages, latest: latestMessages } = useConversationReading(
        chatListRef, () => immersiveMessages.value, activeChar,
    );
    // ── 角色行为运行时（提醒/问候/事件轮询/勿扰）已下沉 useCompanionBehaviorRuntime ──
    // 两只 30s 心跳与轮询 AbortController 生命周期由 composable 自持；
    // 导入/剪贴板入册走 noteReturn 族 + resetEventDetector 重置检测基线。
    const { behaviorEnabled, dnd, pendingReminders, inQuietHours, quietHoursText, noteActivity, getLastActivityAt, getIdleMinutes, noteReturn, noteReturnPlain, toggleDnd, dismissReminder, maybeGreetByTime, openReminderRoute, resetEventDetector } = useCompanionBehaviorRuntime({
        activeChar,
        desktopBridge,
        desktopWindowVisible: () => desktopWindowVisible.value,
        // 语音簇在本簇之后接线（它依赖 dnd/inQuietHours），这里延迟引用避免 TDZ。
        reconcileAutoListen: () => reconcileAutoListen(),
    });
    // ── 语音输入（按住说话/Space 保持/唤醒会话/auto-listen gating）已下沉
    //    useCompanionSpeechInput；visibilitychange 监听与卸载释放自持。──
    const { speechReady, speechState, speechLevel, speechError, speechAutoListening, speechSessionActive, speechButtonDisabled, speechButtonText, speechStateText, speechSettingsOpen, pageVisible, onSpeechPress, onSpeechRelease, onSpeechCancel, onSpeechLeave, onSpeechSessionEnd, onSpeechSettingsSaved, handleSpaceKeyDown, handleSpaceKeyUp, cancelSpeechActivity, reconcileAutoListen } = useCompanionSpeechInput({
        busy,
        chatReady,
        inputText,
        currentCharacter,
        currentCharacterName: () => currentCharacter.value.name,
        desktopBridge,
        desktopWindowVisible,
        dnd,
        inQuietHours,
        handleSend,
        isEditableTarget,
    });
    useCompanionPerformance({ activeChar, reminders: pendingReminders, stage: characterStageRef, voice, autoVoice, voiceActive,
        voiceId: () => currentCharacter.value.voice, affection: () => affectionScore.value,
        allowed: () => !presentationSuspended.value && behaviorEnabled.value && !dnd.value && !inQuietHours.value && pageVisible.value && desktopWindowVisible.value
            && !busy.value && !thinkingActivity.value && !toolActivity.value && !preparingRoom.value
            && !composerFocused.value && !inputText.value.trim() && speechState.value !== 'capturing',
    });
    // ── 剪贴板浮卡 / 本地导入 / 看屏检视（已下沉 useCompanionClipboardImport）──
    // 剪贴板订阅、拖拽监听与浮卡 20s 计时器生命周期由 composable 自持。
    const { importInputRef, clipboardCard, capturingScreen, onImportInputChange, dismissClipboardCard, acceptClipboardCard, onCaptureAndInspectScreen, inspectClipboardImage } = useCompanionClipboardImport({
        activeChar,
        desktopBridge,
        currentCharacterName: () => currentCharacter.value.name,
        noteReturn,
        noteReturnPlain,
        resetEventDetector,
        inputText,
        persistDraft: text => storage.setDraft(activeChar.value, text),
        scrollChatToBottom: () => chatListRef.value?.scrollTo({ top: chatListRef.value.scrollHeight, behavior: scrollBehavior() }),
        handleSend,
        busy,
        chatReady,
    });
    const settingsOpen = ref(false);
    const workspaceOpen = ref(false);
    const workspaceInput = ref('');
    const workspaceExists = ref(false);
    const workspaceSaving = ref(false);
    const workspaceTooltip = computed(() => workspaceExists.value
        ? `AI 工作区：${workspaceInput.value || '已配置'}`
        : '未配置 AI 工作区：样张预览与训练不可用，点击设置');
    let uiIdleTimer = 0;
    const uiHidden = ref(false);
    let lastPointerMove = Date.now();
    let mouseToggleBlockedUntil = 0;
    const immersive = ref(false);
    const presence = computed(() => resolveCompanionPresence({
        visible: pageVisible.value,
        dnd: dnd.value,
        quietHours: inQuietHours.value,
        speaking: isSpeaking.value,
        listening: speechState.value === 'capturing',
        thinking: busy.value || Boolean(thinkingActivity.value) || Boolean(toolActivity.value),
        composing: composerFocused.value || Boolean(inputText.value.trim()),
        hasReminder: pendingReminders.value.length > 0,
    }));
    /* ============================================================
     * 真双窗口（桌面）：实时状态下行 + 聊天窗指令接入
     * 角色窗是会话运行时唯一写者；聊天窗经 COMPANION_CHAT_LIVE_KEY
     * 下行 busy/thinking/speaking/activeChar/chatReady，经
     * bridge.onChatCommand 接收 send/switch/stop 中继。
     * ============================================================ */
    const liveDotState = computed(() => {
        if (isSpeaking.value)
            return 'speaking';
        if (busy.value || thinkingActivity.value || Boolean(toolActivity.value))
            return 'busy';
        return 'idle';
    });
    const liveDotText = computed(() => {
        if (!chatReady.value)
            return '聊天未就绪';
        if (isSpeaking.value)
            return '配音中';
        if (busy.value)
            return '回复中';
        if (thinkingActivity.value || Boolean(toolActivity.value))
            return '思考中';
        return '陪伴中';
    });
    function publishLiveState() {
        if (!desktopBridge)
            return;
        try {
            localStorage.setItem(COMPANION_CHAT_LIVE_KEY, JSON.stringify({
                busy: busy.value,
                thinking: Boolean(thinkingActivity.value || toolActivity.value),
                speaking: isSpeaking.value,
                activeChar: activeChar.value,
                chatReady: chatReady.value,
                ts: Date.now(),
            }));
        }
        catch { /* 隐私模式忽略 */ }
    }
    watch([busy, thinkingActivity, toolActivity, isSpeaking, activeChar, chatReady], publishLiveState, { flush: 'sync' });
    function openChatWindow() {
        desktopBridge?.openChat?.();
    }
    function onChatCommand(payload: {
        command?: string;
        text?: string;
        imageUrl?: string;
        character?: string;
        requestId?: string;
    }) {
        if (!viewAlive)
            return;
        if (payload.command === 'send' && typeof payload.text === 'string' && payload.text.trim()) {
            if (payload.character && payload.character !== activeChar.value) { publishChatReceipt(payload.requestId, false); return; }
            handleSend(payload.text, payload.imageUrl, accepted => publishChatReceipt(payload.requestId, accepted));
        }
        else if (payload.command === 'switch-character' && payload.character) {
            switchCharacter(payload.character);
        }
        else if (payload.command === 'stop') {
            stopEverything();
        }
    }
    let chatCommandSubscription: number | undefined;
    let resumeSubscription: number | undefined;
    let shownSubscription: number | undefined;
    let visibilitySubscription: number | undefined;
    let windowBoundsSubscription: number | undefined;
    let powerModeSubscription: number | undefined;
    let interactionModeSubscription: number | undefined;
    let globalMouseSubscription: number | undefined;
    let viewAlive = true;
    let visibilityRevision = 0;
    let powerRevision = 0;
    let boundsRevision = 0;
    /** 沉浸模式：鼠标在舞台活动时 UI 浮现，静止数秒后自动隐去（桌面窗口）。 */
    function setUiHidden(hidden: boolean) {
        if (uiHidden.value === hidden)
            return;
        uiHidden.value = hidden;
        document.documentElement.classList.toggle('companion-ui-hidden', hidden);
    }
    function enterImmersive() {
        if (!desktopBridge)
            return;
        immersive.value = true;
        document.documentElement.classList.add('companion-immersive');
        // 进入沉浸前取消自动隐现计时，避免冲突
        clearTimeout(uiIdleTimer);
        uiHidden.value = false;
        document.documentElement.classList.remove('companion-ui-hidden');
    }
    function exitImmersive() {
        if (!immersive.value)
            return;
        immersive.value = false;
        document.documentElement.classList.remove('companion-immersive');
    }
    function onWindowKeydown(event: KeyboardEvent) {
        noteActivity();
        setUiHidden(false);
        if (event.key === 'Escape' && immersive.value) {
            exitImmersive();
            return;
        }
        if (event.key === 'Escape' && settingsOpen.value) {
            settingsOpen.value = false;
            return;
        }
        // 真双窗口：角色窗不再内嵌输入；Space 呼出聊天窗（如已开则落到聊天窗自身处理）
        if (desktopBridge) {
            if (event.key === ' ' && !event.repeat && !isEditableTarget(event.target)) {
                event.preventDefault();
                void openChatWindow();
            }
            return;
        }
        handleSpaceKeyDown(event);
    }
    function isEditableTarget(target: EventTarget | null): boolean {
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
            || target instanceof HTMLSelectElement)
            return true;
        if (target instanceof HTMLElement) {
            return target.isContentEditable || Boolean(target.closest('button, a, [role="button"]'));
        }
        return false;
    }
    function onWindowKeyup(event: KeyboardEvent) {
        handleSpaceKeyUp(event);
    }
    /** 点击齿轮弹层外部时关闭设置弹层（弹层内已 @pointerdown.stop）。 */
    function onDocPointerDown(event: PointerEvent) {
        if (!settingsOpen.value)
            return;
        const target = event.target;
        if (target instanceof Element && target.closest('.companion-settings-popover, .companion-settings-btn'))
            return;
        settingsOpen.value = false;
    }
    function onPointerMove(event: PointerEvent) {
        lastPointerMove = Date.now();
        if (uiHidden.value)
            setUiHidden(false);
        clearTimeout(uiIdleTimer);
        if (!desktopBridge)
            return;
        // 穿透模式只转发 mousemove、不转发 click——鼠标悬停在可交互元素上时
        // 自动恢复交互，否则"恢复交互"按钮永远点不到（看起来像卡死）。
        // 排除穿透切换按钮本身：悬停它不应恢复（会刚穿透又立刻恢复）。
        if (ignoreMouseEvents.value && Date.now() >= mouseToggleBlockedUntil) {
            const element = document.elementFromPoint(event.clientX, event.clientY);
            const interactive = element instanceof HTMLElement
                && Boolean(element.closest('button, a, input, textarea, select, [role="button"], [tabindex]'));
            // 排除穿透切换按钮本身：悬停它不应恢复（会刚穿透又立刻恢复）
            const self = element instanceof HTMLElement ? element.closest('button') : null;
            const onToggleButton = Boolean(self && /穿透|恢复交互/.test(self.textContent || ''));
            if (interactive && !onToggleButton) {
                ignoreMouseEvents.value = false;
                desktopBridge.setIgnoreMouseEvents(false);
            }
        }
        scheduleUiHide();
    }
    function scheduleUiHide() {
        clearTimeout(uiIdleTimer);
        if (!desktopBridge || immersive.value) return;
        uiIdleTimer = window.setTimeout(() => {
            if (!viewAlive || !desktopWindowVisible.value)
                return;
            // Editing or choosing a character must not be interrupted by idle hiding.
            if (settingsOpen.value || workspaceOpen.value || document.querySelector('.character-controls[open]') || window.getSelection()?.toString()) return;
            if (document.activeElement instanceof HTMLTextAreaElement
                || document.activeElement instanceof HTMLInputElement
                || document.activeElement instanceof HTMLSelectElement)
                return;
            if (Date.now() - lastPointerMove > 3000)
                setUiHidden(true);
        }, 3200) as unknown as number;
    }
    async function refreshWorkspaceState() {
        if (!desktopBridge)
            return;
        try {
            const workspace = await desktopBridge.getWorkspace();
            if (!viewAlive)
                return;
            workspaceInput.value = workspace.root;
            workspaceExists.value = workspace.exists;
        }
        catch {
            // 桌面桥未就绪时忽略
        }
    }
    async function saveWorkspace() {
        if (!desktopBridge || workspaceSaving.value)
            return;
        const value = workspaceInput.value.trim();
        if (!value)
            return;
        workspaceSaving.value = true;
        try {
            const result = await desktopBridge.setWorkspace(value);
            workspaceInput.value = result.root;
            workspaceExists.value = true;
            workspaceOpen.value = false;
            chatError.value = 'AI 工作区已更新，网关已重启。';
            chatErrorKind.value = 'info';
            void refreshRoomState();
        }
        catch (error) {
            chatError.value = (error as Error).message || '工作区设置失败';
            chatErrorKind.value = 'error';
        }
        finally {
            workspaceSaving.value = false;
        }
    }
    function readDesktopLive2dOverride(): boolean | null {
        if (!desktopBridge)
            return null;
        try {
            const value = localStorage.getItem(COMPANION_LIVE2D_KEY);
            return value == null ? null : value === 'true';
        }
        catch {
            return null;
        }
    }
    function handleLive2dPreference(enabled: boolean) {
        if (desktopBridge) {
            desktopLive2dOverride.value = enabled;
            desktopBridge.setLive2dEnabled(enabled);
            try {
                localStorage.setItem(COMPANION_LIVE2D_KEY, String(enabled));
            }
            catch { /* 隐私模式忽略 */ }
        }
        storage.setLive2dEnabled(enabled);
    }
    watch(replyAnnouncement, announcement => {
        if (!desktopBridge || !announcement || document.hasFocus())
            return;
        desktopBridge.notify(currentCharacter.value.name, announcement);
    });
    async function togglePin() {
        if (!desktopBridge)
            return;
        try {
            alwaysOnTop.value = await desktopBridge.toggleAlwaysOnTop();
        }
        catch (e) {
            console.warn('companion pin toggle failed', e);
        }
    }
    function toggleMouseEvents() {
        if (!desktopBridge)
            return;
        // 本地立即翻转（主进程回发 desktop:interaction-mode 作兜底同步），
        // 避免回发丢失时按钮状态与真实穿透不一致
        const next = !ignoreMouseEvents.value;
        ignoreMouseEvents.value = next;
        desktopBridge.setIgnoreMouseEvents(next);
        // 刚切换穿透的瞬间抑制自动恢复：防止点击"穿透"按钮时
        // 悬停触发的恢复把状态又翻回去
        mouseToggleBlockedUntil = Date.now() + 400;
    }
    function setDesktopVisibility(visible: boolean) {
        characterStageRef.value?.setDesktopVisible?.(visible);
        if (!visible) {
            cancelSpeechActivity();
            characterStageRef.value?.releasePointerFocus?.();
        }
        if (desktopWindowVisible.value === visible)
            return;
        desktopWindowVisible.value = visible;
        if (visible) {
            // 重新可见且离开超过提醒阈值：入队一条"回来"问候
            const awayMs = Date.now() - getLastActivityAt();
            const idleMinutes = getIdleMinutes();
            if (idleMinutes > 0 && awayMs > idleMinutes * 60000) {
                noteReturn(offset => pickCompanionLine(activeChar.value, 'return', offset));
            }
            // 窗口重新可见：若时间片/周末状态变了，给一条环境问候
            maybeGreetByTime();
            noteActivity();
        }
        reconcileAutoListen();
    }
    function setDesktopPowerMode(onBattery: boolean) {
        onBatteryPower.value = onBattery;
        characterStageRef.value?.setDesktopPerformanceMode?.(onBattery);
    }
    onMounted(async () => {
        document.documentElement.classList.add('companion-mode');
        window.addEventListener('pointerdown', noteActivity, { passive: true });
        window.addEventListener('pointerdown', onDocPointerDown, { passive: true });
        window.addEventListener('keydown', onWindowKeydown, { passive: false });
        window.addEventListener('keyup', onWindowKeyup, { passive: false });
        window.addEventListener('wheel', noteActivity, { passive: true });
        window.addEventListener('pointermove', onPointerMove, { passive: true });
        reconcileAutoListen();
        void refreshWorkspaceState();
        if (desktopBridge) {
            document.documentElement.classList.add('companion-desktop');
            lastPointerMove = Date.now();
            scheduleUiHide();
            // 真双窗口：先下行一次实时状态，聊天窗打开即有正确内容
            publishLiveState();
            chatCommandSubscription = desktopBridge.onChatCommand(onChatCommand);
            shownSubscription = desktopBridge.onShown(() => { visibilityRevision++; setDesktopVisibility(true); });
            visibilitySubscription = desktopBridge.onVisibilityChanged(visible => { visibilityRevision++; setDesktopVisibility(visible); });
            if (desktopBridge.onWindowBoundsChanged) {
                windowBoundsSubscription = desktopBridge.onWindowBoundsChanged(bounds => {
                    boundsRevision++;
                    desktopWindowBounds.value = bounds;
                    characterStageRef.value?.setDesktopWindowBounds?.(bounds);
                });
            }
            powerModeSubscription = desktopBridge.onPowerModeChanged(onBattery => { powerRevision++; setDesktopPowerMode(onBattery); });
            interactionModeSubscription = desktopBridge.onInteractionModeChanged(value => { ignoreMouseEvents.value = value; });
            // 全局目光跟随：鼠标在悬浮窗之外时，角色目光仍随屏幕鼠标转动。
            // 窗口内由舞台 DOM 事件驱动（更平滑），这里跳过 inWindow 更新。
            globalMouseSubscription = desktopBridge.onGlobalMouse(state => {
                if (state.inWindow || !desktopWindowVisible.value)
                    return;
                characterStageRef.value?.setGlobalPointer?.(state.x, state.y, state.bounds);
            });
            resumeSubscription = desktopBridge.onResume(() => {
                if (!desktopWindowVisible.value)
                    return;
                characterStageRef.value?.setDesktopVisible?.(desktopWindowVisible.value);
                void refreshRoomState();
            });
            let desktopState: Awaited<ReturnType<typeof desktopBridge.getState>> | null = null;
            const initialRevision = { visibility: visibilityRevision, power: powerRevision, bounds: boundsRevision };
            try {
                desktopState = await desktopBridge.getState();
            }
            catch (e) {
                console.warn('companion desktop state unavailable', e);
            }
            if (!viewAlive)
                return;
            if (desktopState) {
                alwaysOnTop.value = desktopState.alwaysOnTop;
                ignoreMouseEvents.value = desktopState.ignoreMouseEvents;
                const legacyLive2dOverride = desktopLive2dOverride.value;
                desktopLive2dOverride.value = desktopState.live2dEnabled ?? legacyLive2dOverride;
                if (desktopState.live2dEnabled == null && legacyLive2dOverride != null) {
                    desktopBridge.setLive2dEnabled(legacyLive2dOverride);
                }
                // Events received after the snapshot request own the newer state.
                if (visibilityRevision === initialRevision.visibility) setDesktopVisibility(desktopState.visible);
                if (powerRevision === initialRevision.power) setDesktopPowerMode(desktopState.onBatteryPower);
                if (desktopState.bounds && boundsRevision === initialRevision.bounds)
                    desktopWindowBounds.value = desktopState.bounds;
            }
            else {
                // IPC 失败时按页面可见性兜底，保证可见窗口里的 Live2D 仍能按需加载
                if (visibilityRevision === initialRevision.visibility) setDesktopVisibility(!document.hidden);
            }
        }
    });
    onUnmounted(() => {
        viewAlive = false;
        clearTimeout(uiIdleTimer);
        window.removeEventListener('pointerdown', noteActivity);
        window.removeEventListener('pointerdown', onDocPointerDown);
        window.removeEventListener('keydown', onWindowKeydown);
        window.removeEventListener('keyup', onWindowKeyup);
        window.removeEventListener('wheel', noteActivity);
        window.removeEventListener('pointermove', onPointerMove);
        if (desktopBridge && resumeSubscription != null)
            desktopBridge.offResume(resumeSubscription);
        if (desktopBridge && shownSubscription != null)
            desktopBridge.offShown(shownSubscription);
        if (desktopBridge && visibilitySubscription != null)
            desktopBridge.offVisibilityChanged(visibilitySubscription);
        if (desktopBridge && desktopBridge.offWindowBoundsChanged && windowBoundsSubscription != null) {
            desktopBridge.offWindowBoundsChanged(windowBoundsSubscription);
        }
        if (desktopBridge && powerModeSubscription != null)
            desktopBridge.offPowerModeChanged(powerModeSubscription);
        if (desktopBridge && interactionModeSubscription != null)
            desktopBridge.offInteractionModeChanged(interactionModeSubscription);
        if (desktopBridge && globalMouseSubscription != null)
            desktopBridge.offGlobalMouse(globalMouseSubscription);
        if (desktopBridge && chatCommandSubscription != null)
            desktopBridge.offChatCommand(chatCommandSubscription);
        document.documentElement.classList.remove('companion-mode', 'companion-desktop', 'companion-immersive', 'companion-ui-hidden');
        uiHidden.value = false;
        immersive.value = false;
    });
    return {
chatListRef,
characterStageRef,
        activeChar, desktopBridge, onBatteryPower, uiHidden, presence, immersive, presentationSuspended,
        currentCharacter, affectionScore, affectionInfo, companionCharacters, switchCharacter, settingsOpen,
        autoVoice, onAutoVoiceChange, behaviorEnabled, dnd, toggleDnd, importInputRef,
        onImportInputChange, alwaysOnTop, togglePin, ignoreMouseEvents, toggleMouseEvents, enterImmersive,
        workspaceExists, workspaceTooltip, workspaceOpen, volume, onVolumeChange, exitImmersive,
        isSpeaking, chatStatusText, statusKind, companionAutoLoad, desktopWindowBounds, storage,
        handleLive2dPreference, pendingReminders, openReminderRoute, dismissReminder, clipboardCard, inspectClipboardImage,
        acceptClipboardCard, dismissClipboardCard, companionMessages, immersiveMessages, hasNewMessages, latestMessages, toolActivity, thinkingActivity,
        chatReady, voiceCapabilityState, preparingRoom, setupTitle, chatProvider, prepareRoom,
        inputText, composerFocused, handleSend, onInputChange, busy, capturingScreen,
        onCaptureAndInspectScreen, voiceActive, stopEverything, speechReady, speechState, speechLevel, speechButtonDisabled,
        speechError, onSpeechPress, onSpeechRelease, onSpeechCancel, onSpeechLeave, speechButtonText,
        speechStateText, speechAutoListening, speechSessionActive, onSpeechSessionEnd, speechSettingsOpen, voiceStatusText,
        inQuietHours, quietHoursText, onSpeechSettingsSaved, chatErrorKind, chatError, replyAnnouncement,
        workspaceInput, saveWorkspace, workspaceSaving, openChatWindow, liveDotState, liveDotText,
    };
}
