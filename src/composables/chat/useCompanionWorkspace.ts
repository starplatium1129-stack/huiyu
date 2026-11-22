import { companionWindow, getDesktopCapabilities } from '../../platform/desktop/capabilities.ts'
import { useCompanionInput } from './useCompanionInput'
import { profileLocalStorage as localStorage } from '../../platform/web/profileStorage.ts'

import { useCharacterRoomSession } from './useCharacterRoomSession.ts';
import { useConversationReading } from './useConversationReading.ts';
import { isChatRelayCancelled, publishChatReceipt } from '../../utils/chatRelayReceipt.ts';
import { parseCompanionChatImage, type CompanionChatCommand } from '@/types/companionDrawing';
import { assertWorkspaceMediaAuthority } from '@/platform/desktop/workspaceMediaSource';
import { useRoomPresentation } from './useRoomPresentation.ts';
import { useWorkspaceDirectorySettings } from './useWorkspaceDirectorySettings.ts';
import { useCompanionAffection } from '../useCompanionAffection.ts';
import { useCompanionBehaviorRuntime } from '../useCompanionBehaviorRuntime.ts';
import { useCompanionClipboardImport } from '../useCompanionClipboardImport.ts';
import { useCompanionSpeechInput } from '../useCompanionSpeechInput.ts';
import { useCompanionPerformance } from '../useCompanionPerformance.ts';
import { useCompanionScreenWatch } from './useCompanionScreenWatch';
import { pickCompanionLine } from '../../config/characters.ts';
import { resolveCompanionPresence } from '../../utils/companionPresence.ts';
import { scrollBehavior } from '../../utils/motionPreference.ts';
import { COMPANION_CHAT_LIVE_KEY,COMPANION_LIVE2D_KEY } from '../../utils/storageKeys.ts';
import type { CompanionChatLiveState } from '../../utils/companionChatLiveState';
import { computed,onMounted,onUnmounted,ref,watch } from 'vue';
import { loadCompanionDirectory, savedCompanionCharacter } from '@/router/companionResources'
/** Owns workspace state and lifecycle; the view only binds presentation. */
export function useCompanionWorkspace() {
    const desktopBridge = getDesktopCapabilities('companion');
    const companionInput = useCompanionInput();
    let admitConversation: (() => void) | undefined;
    let cancelConversationIdle: (() => void) | undefined;
    const presentation = desktopBridge ? {
        character: savedCompanionCharacter(),
        startConversation: new Promise<void>(resolve => { admitConversation = resolve; }),
    } : undefined;
    function startConversation() {
        cancelConversationIdle?.();
        cancelConversationIdle = undefined;
        admitConversation?.();
        admitConversation = undefined;
    }
    function warmConversation() {
        if (!admitConversation || cancelConversationIdle) return;
        if (typeof requestIdleCallback === 'function') {
            const work = requestIdleCallback(startConversation, { timeout: 1200 });
            cancelConversationIdle = () => cancelIdleCallback(work);
        } else {
            const work = window.setTimeout(startConversation, 0);
            cancelConversationIdle = () => clearTimeout(work);
        }
    }
    const { voice, chatListRef, characterStageRef, activeChar, busy, voiceActive, chatError, chatErrorKind, toolActivity, thinkingActivity, voiceStatusText, voiceCapabilityState, isSpeaking, autoVoice, volume, preparingRoom, storage, chatProvider, chatStatusText, statusKind, chatReady, currentCharacter, companionMessages, setupTitle, inputText, replyAnnouncement, onVolumeChange, handleSend, onInputChange, prepareRoom, stopEverything, switchCharacter, onAutoVoiceChange, refreshRoomState, branchId, storyBusy, handleStoryAction, screenWatchTarget } = useCharacterRoomSession(undefined, presentation);
    const presentationSuspended = useRoomPresentation('companion');
    const { getScore, getLevelInfo } = useCompanionAffection();
    const affectionScore = computed(() => getScore(activeChar.value));
    const affectionInfo = computed(() => getLevelInfo(activeChar.value));
    const composerFocused = ref(false);
    const alwaysOnTop = ref(false);
    const onBatteryPower = ref(false);
    const desktopWindowVisible = ref(!desktopBridge);
    const desktopPreparing = ref(false);
    const desktopInitialized = ref(false);
    const desktopStageActive = computed(() => desktopPreparing.value || desktopWindowVisible.value);
    const desktopWindowBounds = ref<{
        x: number;
        y: number;
        width: number;
        height: number;
    } | null>(null);
    const desktopLive2dOverride = ref(readDesktopLive2dOverride());
    const companionAutoLoad = computed(() => desktopBridge
        ? desktopStageActive.value && desktopLive2dOverride.value !== false
        : storage.state.settings.live2dEnabled);
    const recentMessages = computed(() => companionMessages.value.slice(-2));
    const { showLatest: hasNewMessages, latest: latestMessages } = useConversationReading(
        chatListRef, () => recentMessages.value.length > 0, computed(() => `${activeChar.value}:${branchId.value}`),
    );
    // ── 角色行为运行时（提醒/问候/事件轮询/勿扰）已下沉 useCompanionBehaviorRuntime ──
    // 两只 30s 心跳与轮询 AbortController 生命周期由 composable 自持；
    // 导入/剪贴板入册走 noteReturn 族；生成通知由真实任务结果独立驱动。
    const { behaviorEnabled, dnd, pendingReminders, inQuietHours, quietHoursText, noteActivity, getLastActivityAt, getIdleMinutes, noteReturn, noteReturnPlain, toggleDnd, dismissReminder, maybeGreetByTime, openReminderRoute } = useCompanionBehaviorRuntime({
        activeChar,
        desktopBridge,
        desktopWindowVisible: () => desktopWindowVisible.value,
        // 语音簇在本簇之后接线（它依赖 dnd/inQuietHours），这里延迟引用避免 TDZ。
        reconcileAutoListen: () => reconcileAutoListen(),
    });
    // ── 语音输入（按住说话/Space 保持/唤醒会话/auto-listen gating）已下沉
    //    useCompanionSpeechInput；visibilitychange 监听与卸载释放自持。──
    const { speechReady, speechState, speechLevel, speechError, speechAutoListening, speechSessionActive, speechButtonDisabled, speechButtonText, speechStateText, speechSettingsOpen, pageVisible, speechHold, onSpeechSessionEnd, onSpeechSettingsSaved, handleSpaceKeyDown, handleSpaceKeyUp, cancelSpeechActivity, reconcileAutoListen } = useCompanionSpeechInput({
        busy: computed(() => busy.value || voiceActive.value),
        chatReady,
        inputText,
        onInputChange,
        currentCharacter,
        currentCharacterName: () => currentCharacter.value.name,
        desktopBridge,
        desktopWindowVisible,
        dnd,
        inQuietHours,
        handleSend: accepted => handleSend(undefined, undefined, accepted),
        isEditableTarget,
    });
    // ── 剪贴板浮卡 / 本地导入 / 看屏检视（已下沉 useCompanionClipboardImport）──
    // 剪贴板订阅、拖拽监听与浮卡 20s 计时器生命周期由 composable 自持。
    const { importInputRef, importRecovery, openImportPicker, clipboardCard, capturingScreen, onImportInputChange, dismissClipboardCard, acceptClipboardCard, onCaptureAndInspectScreen, inspectClipboardImage } = useCompanionClipboardImport({
        activeChar,
        desktopBridge,
        listenClipboard: !desktopBridge,
        onError: message => { chatError.value = message; chatErrorKind.value = 'warning' },
        currentCharacterName: () => currentCharacter.value.name,
        noteReturn,
        noteReturnPlain,
        inputText,
        persistDraft: text => storage.setDraft(activeChar.value, text),
        scrollChatToBottom: () => chatListRef.value?.scrollTo({ top: chatListRef.value.scrollHeight, behavior: scrollBehavior() }),
        handleSend,
        busy,
        chatReady: computed(() => chatReady.value && chatProvider.value !== 'muse'),
    });
    let screenVoiceMid = '';
    function releaseScreenVoice(stop = false) {
        if (!screenVoiceMid) return;
        const mid = screenVoiceMid;
        screenVoiceMid = '';
        if (stop && voice.ownsTurn(mid)) voice.stop({ preserveMessageAudio: true, silent: true });
        voice.clearMessages([mid]);
    }
    const screenWatch = useCompanionScreenWatch({
        connection: () => screenWatchTarget.value,
        character: () => activeChar.value,
        visible: () => pageVisible.value && desktopWindowVisible.value,
        chatting: () => busy.value || storyBusy.value || !chatReady.value || preparingRoom.value || capturingScreen.value
            || presentationSuspended.value || Boolean(inputText.value.trim())
            || ['acquiring', 'capturing', 'recognizing'].includes(speechState.value)
            || voiceActive.value && !voice.ownsTurn(screenVoiceMid),
        quiet: () => dnd.value || inQuietHours.value,
        onGesture: () => { if (autoVoice.value) voice.ensureAudioContext(); },
        onComment: (line, aloud) => {
            const voiceId = currentCharacter.value.voice;
            if (!aloud || !autoVoice.value || voice.isActive() || !voice.readyFor(voiceId)) return;
            releaseScreenVoice();
            screenVoiceMid = `screen-watch-${crypto.randomUUID()}`;
            voice.startTurn({ mid: screenVoiceMid, character: activeChar.value, voice: voiceId });
            voice.append(line);
            voice.finishTurn();
        },
        onInterrupt: () => releaseScreenVoice(true),
    });
    watch(voiceActive, playing => { if (!playing && !voice.isActive()) releaseScreenVoice(); });
    useCompanionPerformance({ activeChar, reminders: pendingReminders, stage: characterStageRef, voice, autoVoice, voiceActive,
        voiceId: () => currentCharacter.value.voice, affection: () => affectionScore.value,
        allowed: () => !presentationSuspended.value && behaviorEnabled.value && !dnd.value && !inQuietHours.value && pageVisible.value && desktopWindowVisible.value
            && !busy.value && !thinkingActivity.value && !toolActivity.value && !preparingRoom.value && !screenWatch.inspecting.value
            && !composerFocused.value && !inputText.value.trim() && speechState.value !== 'capturing',
    });
    const settingsOpen = ref(false);
    const { workspaceOpen, workspaceInput, workspaceExists, workspaceSaving, workspaceError,
        workspaceRestartRequired, workspaceTooltip, saveWorkspace } = useWorkspaceDirectorySettings(
        desktopBridge, (message, kind) => { chatError.value = message; chatErrorKind.value = kind; });
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
     * 下行 busy/thinking/speaking/voiceActive/activeChar/chatReady，经
     * bridge.onChatCommand 接收 send/switch/stop 中继。
     * ============================================================ */
    function publishLiveState() {
        if (!desktopBridge)
            return;
        try {
            localStorage.setItem(COMPANION_CHAT_LIVE_KEY, JSON.stringify({
                busy: busy.value || storyBusy.value,
                thinking: Boolean(thinkingActivity.value || toolActivity.value),
                toolActivity: toolActivity.value,
                speaking: isSpeaking.value,
                voiceActive: voiceActive.value,
                activeChar: activeChar.value,
                chatReady: chatReady.value,
                textOnly: chatProvider.value === 'muse',
                chatError: chatError.value,
                ts: Date.now(),
            } satisfies CompanionChatLiveState));
        }
        catch { /* 隐私模式忽略 */ }
    }
    watch([busy, storyBusy, thinkingActivity, toolActivity, isSpeaking, voiceActive, activeChar, chatReady, chatProvider, chatError], publishLiveState, { flush: 'sync' });
    function openChatWindow() {
        startConversation();
        desktopBridge?.openChat?.();
    }
    function onChatCommand(payload: CompanionChatCommand) {
        if (!viewAlive)
            return;
        if (payload.command === 'send' && typeof payload.text === 'string' && payload.text.trim()) {
            if (payload.character && payload.character !== activeChar.value) { publishChatReceipt(payload.requestId, false); return; }
            const image = parseCompanionChatImage(payload.image);
            if (payload.image && !image || payload.action && (payload.action !== 'generate-from-image' || !image)) { publishChatReceipt(payload.requestId, false); return; }
            // handleSend calls this admission only after acquiring its chat writer.
            const accept = (accepted: boolean) => {
                if (accepted && image) {
                    try { assertWorkspaceMediaAuthority(payload.imageAuthority || ''); }
                    catch { publishChatReceipt(payload.requestId, false); return false; }
                }
                return publishChatReceipt(payload.requestId, accepted);
            };
            handleSend(payload.text, payload.imageUrl, accept, { ...(image ? { image, imageAuthority: payload.imageAuthority } : {}), ...(payload.action ? { action: payload.action } : {}) });
        }
        else if (payload.command === 'story-action' && payload.storyAction && payload.requestId) {
            if (payload.character !== activeChar.value || payload.branchId !== branchId.value) { publishChatReceipt(payload.requestId, false); return; }
            handleStoryAction(payload.storyAction, accepted => publishChatReceipt(payload.requestId, accepted), payload.branchId, () => isChatRelayCancelled(payload.requestId));
        }
        else if (payload.command === 'switch-character' && payload.character) {
            const character = payload.character;
            startConversation();
            void loadCompanionDirectory().then(() => { if (viewAlive) switchCharacter(character); }).catch(() => {});
        }
        else if (payload.command === 'stop') {
            stopEverything();
        }
    }
    let chatCommandSubscription: number | undefined;
    const stopCompanionSignals: (() => void)[] = [];
    let resumeSubscription: number | undefined;
    let shownSubscription: number | undefined;
    let visibilitySubscription: number | undefined;
    let windowBoundsSubscription: number | undefined;
    let powerModeSubscription: number | undefined;
    let globalMouseSubscription: number | undefined;
    let viewAlive = true;
    let visibilityRevision = 0;
    let powerRevision = 0;
    let boundsRevision = 0, pinRevision = 0;
    let pinPending = false;
    function onWindowKeydown(event: KeyboardEvent) {
        noteActivity();
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector('dialog[open]')) return;
        if (event.key === 'Escape' && speechSettingsOpen.value) { event.preventDefault(); speechSettingsOpen.value = false; return; }
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
        if (!desktopBridge || !viewAlive || pinPending)
            return;
        pinRevision++; pinPending = true;
        try {
            const pinned = await desktopBridge.toggleAlwaysOnTop();
            if (viewAlive) alwaysOnTop.value = pinned;
        }
        catch (e) {
            console.warn('companion pin toggle failed', e);
        } finally { pinPending = false; }
    }
    function setDesktopVisibility(visible: boolean) {
        const changed = desktopWindowVisible.value !== visible;
        desktopWindowVisible.value = visible;
        desktopPreparing.value = false;
        if (!visible) {
            cancelSpeechActivity();
            characterStageRef.value?.releasePointerFocus?.();
        }
        if (!changed) return;
        if (visible) {
            warmConversation();
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
    // The stage is lazy-loaded. Host events may arrive before its ref exists;
    // replay the latest observed state when the actual renderer attaches.
    watch(characterStageRef, stage => {
        if (!stage || !desktopBridge) return;
        stage.setDesktopVisible?.(desktopStageActive.value);
        stage.setDesktopPerformanceMode?.(onBatteryPower.value);
        if (desktopWindowBounds.value) stage.setDesktopWindowBounds?.(desktopWindowBounds.value);
    }, { flush: 'post' });
    watch(desktopStageActive, visible => characterStageRef.value?.setDesktopVisible?.(visible), { flush: 'sync' });
    onMounted(async () => {
        document.documentElement.classList.add('companion-mode');
        document.documentElement.classList.toggle('companion-desktop', Boolean(desktopBridge));
        window.addEventListener('pointerdown', noteActivity, { passive: true });
        window.addEventListener('keydown', onWindowKeydown, { passive: false });
        window.addEventListener('keyup', onWindowKeyup, { passive: false });
        window.addEventListener('wheel', noteActivity, { passive: true });
        reconcileAutoListen();
        if (desktopBridge) {
            // 真双窗口：先下行一次实时状态，聊天窗打开即有正确内容
            publishLiveState();
            chatCommandSubscription = desktopBridge.onChatCommand(onChatCommand);
            shownSubscription = desktopBridge.onShown(() => { visibilityRevision++; setDesktopVisibility(true); });
            visibilitySubscription = desktopBridge.onVisibilityChanged(visible => { visibilityRevision++; setDesktopVisibility(visible); });
            if (desktopBridge.onWindowBoundsChanged) {
                windowBoundsSubscription = desktopBridge.onWindowBoundsChanged(bounds => {
                    boundsRevision++;
                    const previous = desktopWindowBounds.value;
                    // The native model follows its HWND. Only a viewport resize needs Vue layout.
                    if (previous?.width === bounds.width && previous.height === bounds.height) return;
                    desktopWindowBounds.value = bounds;
                });
            }
            powerModeSubscription = desktopBridge.onPowerModeChanged(onBattery => { powerRevision++; setDesktopPowerMode(onBattery); });
            stopCompanionSignals.push(companionWindow.on('prepare', () => { visibilityRevision++; desktopPreparing.value = true; }));
            stopCompanionSignals.push(companionWindow.on('pin', value => { pinRevision++; alwaysOnTop.value = value; }));
            stopCompanionSignals.push(companionWindow.onChatVisibility(visible => { if (visible) startConversation(); }));
            // 全局目光跟随：鼠标在悬浮窗之外时，角色目光仍随屏幕鼠标转动。
            // 窗口内由舞台 DOM 事件驱动（更平滑），这里跳过 inWindow 更新。
            globalMouseSubscription = desktopBridge.onGlobalMouse(state => {
                companionInput?.setPointer(state.x, state.y, state.bounds);
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
            const initialRevision = { visibility: visibilityRevision, power: powerRevision, bounds: boundsRevision, pin: pinRevision };
            try {
                desktopState = await desktopBridge.getState();
            }
            catch (e) {
                console.warn('companion desktop state unavailable', e);
            }
            if (!viewAlive)
                return;
            if (desktopState) {
                if (pinRevision === initialRevision.pin) alwaysOnTop.value = desktopState.alwaysOnTop;
                const legacyLive2dOverride = desktopLive2dOverride.value;
                desktopLive2dOverride.value = desktopState.live2dEnabled ?? legacyLive2dOverride;
                if (desktopState.live2dEnabled == null && legacyLive2dOverride != null) {
                    desktopBridge.setLive2dEnabled(legacyLive2dOverride);
                }
                // Events received after the snapshot request own the newer state.
                if (visibilityRevision === initialRevision.visibility) {
                    if (desktopState.preparing) desktopPreparing.value = true;
                    else setDesktopVisibility(desktopState.visible);
                }
                if (desktopState.chatVisible) startConversation();
                if (powerRevision === initialRevision.power) setDesktopPowerMode(desktopState.onBatteryPower);
                if (desktopState.bounds && boundsRevision === initialRevision.bounds)
                    desktopWindowBounds.value = desktopState.bounds;
            }
            else {
                // IPC 失败时按页面可见性兜底，保证可见窗口里的 Live2D 仍能按需加载
                if (visibilityRevision === initialRevision.visibility) setDesktopVisibility(!document.hidden);
            }
            desktopInitialized.value = true;
        }
    });
    onUnmounted(() => {
        viewAlive = false;
        cancelConversationIdle?.();
        stopCompanionSignals.forEach(stop => stop());
        window.removeEventListener('pointerdown', noteActivity);
        window.removeEventListener('keydown', onWindowKeydown);
        window.removeEventListener('keyup', onWindowKeyup);
        window.removeEventListener('wheel', noteActivity);
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
        if (desktopBridge && globalMouseSubscription != null)
            desktopBridge.offGlobalMouse(globalMouseSubscription);
        if (desktopBridge && chatCommandSubscription != null)
            desktopBridge.offChatCommand(chatCommandSubscription);
        document.documentElement.classList.remove('companion-mode', 'companion-desktop');
    });
    return {
chatListRef,
characterStageRef,
        activeChar, desktopBridge, onBatteryPower, presence, presentationSuspended,
        currentCharacter, affectionScore, affectionInfo, switchCharacter, settingsOpen,
        autoVoice, onAutoVoiceChange, behaviorEnabled, dnd, toggleDnd, importInputRef, importRecovery, openImportPicker,
        onImportInputChange, alwaysOnTop, togglePin,
        workspaceExists, workspaceRestartRequired, workspaceTooltip, workspaceOpen, volume, onVolumeChange,
        isSpeaking, chatStatusText, statusKind, companionAutoLoad, desktopWindowBounds, desktopStageActive, desktopInitialized, storage,
        handleLive2dPreference, pendingReminders, openReminderRoute, dismissReminder, clipboardCard, inspectClipboardImage,
        acceptClipboardCard, dismissClipboardCard, companionMessages, recentMessages, hasNewMessages, latestMessages, toolActivity, thinkingActivity,
        chatReady, voiceCapabilityState, preparingRoom, setupTitle, chatProvider, prepareRoom,
        inputText, composerFocused, handleSend, onInputChange, busy, capturingScreen,
        onCaptureAndInspectScreen, voiceActive, stopEverything, speechReady, speechState, speechLevel, speechButtonDisabled,
        speechError, speechHold, speechButtonText,
        speechStateText, speechAutoListening, speechSessionActive, onSpeechSessionEnd, speechSettingsOpen, voiceStatusText,
        inQuietHours, quietHoursText, onSpeechSettingsSaved, chatErrorKind, chatError, replyAnnouncement,
        workspaceInput, saveWorkspace, workspaceSaving, workspaceError, openChatWindow, screenWatch,
    };
}
