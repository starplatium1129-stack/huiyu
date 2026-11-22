<template>
  <section class="chatgpt-settings" aria-label="ChatGPT 订阅额度设置">
    <div class="chatgpt-head">
      <div class="chatgpt-title">
        <strong>ChatGPT 订阅额度</strong>
        <small>用你的 ChatGPT 订阅额度在绘遇里聊天</small>
      </div>
      <span class="chatgpt-storage-note" role="note" aria-label="令牌加密保存在本机，不写入浏览器存储">
        <ArchiveIcon name="lock" aria-hidden="true" />本机加密
      </span>
    </div>

    <div v-if="auth.authPending.value" class="chatgpt-pending">
      <p role="status">请在系统浏览器完成 ChatGPT 登录和授权。</p>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="busy || auth.acting.value" @click="auth.cancelAuth()">取消登录</button>
    </div>

    <div v-else-if="auth.signedIn.value && !auth.planEnabled.value" class="chatgpt-callout" data-state="warning">
      <p><strong>已登录账号，但未开启 ChatGPT 订阅额度权限</strong></p>
      <div class="chatgpt-actions">
        <button class="btn btn-primary btn-sm" type="button" data-oai-siwc-button :disabled="locked" @click="auth.requestPlanConsent()">
          开启 ChatGPT 订阅额度
        </button>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="emit('switch-api')">改用 API 服务</button>
      </div>
    </div>

    <template v-else-if="auth.signedIn.value && auth.planEnabled.value">
      <div class="chatgpt-plan-bar">
        <div class="chatgpt-plan-meta">
          <span class="chatgpt-plan-badge">使用 ChatGPT 订阅额度</span>
          <span v-if="auth.activeAccount.value" class="chatgpt-account-name">{{ auth.activeAccount.value.label }}</span>
        </div>
        <a v-if="!auth.usagePaused.value" class="chatgpt-usage-link" :href="CHATGPT_USAGE_SETTINGS_URL" target="_blank" rel="noopener noreferrer" aria-label="前往 ChatGPT 用量设置管理额度，在新窗口打开">
          管理用量
        </a>
      </div>
      <div v-if="auth.usagePaused.value" class="chatgpt-callout" data-state="warning">
        <p>ChatGPT 订阅额度已达上限，发送已暂停。</p>
        <div class="chatgpt-actions">
          <a class="btn btn-primary btn-sm" :href="CHATGPT_USAGE_SETTINGS_URL" target="_blank" rel="noopener noreferrer">管理用量</a>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="locked" @click="auth.resumeUsage()">恢复发送</button>
        </div>
      </div>

      <div class="chatgpt-model-row">
        <div class="chatgpt-field">
          <span>聊天模型</span>
          <ChatModelPicker
            :model-value="auth.selectedModel.value"
            :options="modelOptions"
            label="选择 ChatGPT 模型"
            :placeholder="auth.loadingModels.value ? '正在获取可用模型…' : '搜索或选择模型'"
            :disabled="locked || auth.loadingModels.value || !modelOptions.length"
            @update:model-value="auth.selectModel(String($event))"
          />
        </div>
        <button class="btn btn-ghost chatgpt-refresh-btn" type="button" :disabled="locked || auth.loadingModels.value" @click="auth.refreshModels()">
          <ArchiveIcon name="refresh" />{{ auth.loadingModels.value ? '获取中…' : '刷新模型' }}
        </button>
      </div>
    </template>

    <div v-else class="chatgpt-signin-box">
      <button
        class="btn chatgpt-continue-btn"
        type="button"
        data-oai-siwc-button
        :disabled="locked"
        :data-oai-siwc-button-client="auth.activeAccount.value?.clientId"
        @click="auth.activeAccount.value ? auth.reauthorizeAccount(auth.activeAccount.value.clientId) : auth.startSignIn()"
      >
        <span lang="en">Continue with ChatGPT</span>
      </button>
      <p v-if="auth.activeAccount.value" class="chatgpt-signin-hint">继续使用 {{ auth.activeAccount.value.label }}</p>
      <p v-else class="chatgpt-signin-hint">需要支持订阅额度共享的 ChatGPT 计划。</p>
    </div>

    <p class="chatgpt-feedback" :class="{ 'sr-only': !feedback }" :data-state="auth.errorText.value ? 'error' : 'info'" role="status">{{ feedback }}</p>
    <button v-if="auth.canRetryRegistration.value" class="btn btn-ghost btn-sm chatgpt-retry" type="button" data-oai-siwc-button :disabled="locked" @click="auth.retryRegistration()">重试本次注册</button>

    <details v-if="accounts.length" class="chatgpt-accounts">
      <StudioDisclosureSummary>账号管理（{{ accounts.length }}）</StudioDisclosureSummary>
      <div class="chatgpt-accounts-body" data-disclosure-content>
        <ul class="chatgpt-account-list">
          <li v-for="account in accounts" :key="account.clientId" class="chatgpt-account-item" :data-active="account.active || undefined">
            <div class="chatgpt-account-info">
              <strong>{{ account.label }}</strong>
              <small>
                {{ account.active ? '当前使用 · ' : '' }}{{ account.planEnabled ? '订阅额度已授权' : account.hasSession ? '未开启额度权限' : '已退出登录' }}
              </small>
            </div>
            <div class="chatgpt-account-actions">
              <button
                v-if="!account.active && account.hasSession"
                class="btn btn-ghost btn-sm"
                type="button"
                :disabled="locked"
                @click="auth.selectAccount(account.clientId)"
              >切换</button>
              <button
                v-if="!account.hasSession"
                class="btn btn-ghost btn-sm"
                type="button"
                data-oai-siwc-button
                :data-oai-siwc-button-client="account.clientId"
                :disabled="locked"
                @click="auth.reauthorizeAccount(account.clientId)"
              >继续登录</button>
              <button
                v-else
                class="btn btn-ghost btn-sm"
                type="button"
                data-oai-siwc-button
                :data-oai-siwc-button-client="account.clientId"
                :disabled="locked"
                @click="auth.requestPlanConsent(account.clientId)"
              >{{ account.planEnabled ? '重新授权' : '开启额度' }}</button>
              <button
                v-if="account.hasSession"
                class="btn btn-quiet btn-sm"
                type="button"
                :disabled="locked"
                @click="auth.signOut(account.clientId)"
              >退出</button>
              <button
                class="btn btn-quiet btn-sm"
                type="button"
                :aria-label="`移除账号 ${account.label}`"
                :disabled="locked"
                @click="auth.removeAccount(account.clientId)"
              >移除</button>
            </div>
          </li>
        </ul>
        <div class="chatgpt-account-footer">
          <button class="btn btn-ghost btn-sm" type="button" data-oai-siwc-button :disabled="locked" @click="auth.startSignIn()">
            <ArchiveIcon name="plus" />添加其他 ChatGPT 账号
          </button>
          <a class="chatgpt-usage-link" :href="CHATGPT_USAGE_SETTINGS_URL" target="_blank" rel="noopener noreferrer" aria-label="在 ChatGPT 设置中管理应用限额，在新窗口打开">
            ChatGPT 用量与限额设置
          </a>
        </div>
      </div>
    </details>

    <p class="chatgpt-policy-note">
      额度与 ChatGPT 网页端等应用共享，且受 OpenAI 使用条款与内容策略约束；仅限本机自用，不会共享给远程访客。
    </p>

    <Teleport to="body">
      <dialog
        ref="welcomeDialog"
        class="chatgpt-welcome-dialog"
        :aria-labelledby="welcomeTitleId"
        @cancel.prevent="closeWelcome"
        @close="onWelcomeClosed"
        @click="onWelcomeBackdrop"
      >
        <div class="chatgpt-welcome-card">
          <h3 :id="welcomeTitleId">正在使用你的 ChatGPT 订阅额度</h3>
          <p>绘遇中符合条件的对话请求将使用你现有的 ChatGPT 订阅计划额度，不会产生额外 API Key 费用。你可以随时在 ChatGPT 设置中查看或调整本应用的用量限额。</p>
          <form method="dialog" class="chatgpt-welcome-actions" @submit.prevent="closeWelcome">
            <a class="btn btn-ghost btn-sm" :href="CHATGPT_USAGE_SETTINGS_URL" target="_blank" rel="noopener noreferrer">管理用量</a>
            <button class="btn btn-primary" type="submit" value="confirm" autofocus>知道了</button>
          </form>
        </div>
      </dialog>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue'
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ChatModelPicker from '@/components/ChatModelPicker.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import { isBackdropClick, useFluidDialog } from '@/composables/useFluidDialog'
import { CHATGPT_USAGE_SETTINGS_URL, type ChatGptAuthController } from '@/composables/chat/useChatGptAuth'

const props = defineProps<{
  auth: ChatGptAuthController
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'switch-api'): void
}>()

const welcomeTitleId = useId()
const welcomeDialog = ref<HTMLDialogElement | null>(null)
const welcomeMotion = useFluidDialog(welcomeDialog)

const accounts = computed(() => props.auth.status.value?.accounts ?? [])
const locked = computed(() => Boolean(props.busy || props.auth.acting.value || props.auth.authPending.value))
const feedback = computed(() => props.auth.errorText.value || props.auth.noticeText.value)
const modelOptions = computed(() => props.auth.models.value.map(({ slug, displayName }) => ({ value: slug, label: displayName })))

watch(() => props.auth.welcomeOpen.value, async open => {
  if (!open) {
    if (welcomeDialog.value?.open) welcomeMotion.close()
    return
  }
  await nextTick()
  if (props.auth.welcomeOpen.value) welcomeMotion.open()
}, { immediate: true })

function closeWelcome() {
  welcomeMotion.close(() => {
    void props.auth.confirmWelcome()
  })
}

function onWelcomeClosed() {
  if (welcomeDialog.value) welcomeDialog.value.returnValue = ''
  if (props.auth.welcomeOpen.value) void props.auth.confirmWelcome()
}

function onWelcomeBackdrop(event: MouseEvent) {
  if (isBackdropClick(event, welcomeDialog.value)) closeWelcome()
}

onMounted(() => {
  void props.auth.refreshStatus(true)
})
</script>

<style scoped>
.chatgpt-settings {
  display: grid;
  gap: var(--s-3);
  width: 100%;
  min-inline-size: 0;
  padding: var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--bg-surface);
}
.chatgpt-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-2);
  flex-wrap: wrap;
}
.chatgpt-title {
  display: grid;
  min-inline-size: 0;
}
.chatgpt-title strong {
  color: var(--text-primary);
  font-size: var(--fs-label);
}
.chatgpt-title small {
  color: var(--text-secondary);
  font-size: var(--fs-label-xs);
}
.chatgpt-storage-note {
  display: inline-flex;
  align-items: center;
  gap: var(--s-1);
  color: var(--text-secondary);
  font-size: var(--fs-label-xs);
}
.chatgpt-policy-note,
.chatgpt-signin-hint {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--fs-label-xs);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.chatgpt-retry { justify-self: start; }
.chatgpt-signin-box {
  display: grid;
  gap: var(--s-2);
  justify-items: start;
}
.chatgpt-continue-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--s-2);
  min-block-size: var(--control-height);
  padding: var(--s-2) var(--s-4);
  border: 1px solid var(--border-strong, var(--border-soft));
  border-radius: var(--r-md);
  background: var(--text-primary);
  color: var(--bg-base);
  font-weight: 600;
}
.chatgpt-continue-btn:hover:not(:disabled) {
  background: var(--accent);
  color: var(--text-inverse);
  border-color: transparent;
}
.chatgpt-continue-btn:disabled {
  background: var(--bg-elevated);
  color: var(--text-disabled);
  border-color: var(--border-soft);
}
.chatgpt-pending,
.chatgpt-callout {
  display: grid;
  gap: var(--s-2);
  padding: var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--bg-elevated);
  font-size: var(--fs-label-sm);
}
.chatgpt-pending p,
.chatgpt-callout p {
  margin: 0;
  color: var(--text-primary);
  line-height: 1.55;
}
.chatgpt-callout[data-state='warning'] {
  border-color: var(--warning-border, var(--border-soft));
}
.chatgpt-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
}
.chatgpt-plan-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--bg-elevated);
}
.chatgpt-plan-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--s-2);
  min-inline-size: 0;
}
.chatgpt-plan-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--s-1);
  color: var(--text-primary);
  font-size: var(--fs-label-xs);
  font-weight: 600;
}
.chatgpt-account-name {
  color: var(--text-secondary);
  font-size: var(--fs-label-xs);
  overflow-wrap: anywhere;
}
.chatgpt-usage-link {
  color: var(--character-ink, var(--accent));
  font-size: var(--fs-label-xs);
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.chatgpt-model-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--s-2);
  align-items: end;
}
.chatgpt-field {
  display: grid;
  gap: var(--s-1);
  min-inline-size: 0;
}
.chatgpt-field > span {
  color: var(--text-secondary);
  font-size: var(--fs-label-xs);
  font-weight: 600;
}
.chatgpt-refresh-btn {
  white-space: nowrap;
}
.chatgpt-feedback {
  margin: 0;
  font-size: var(--fs-label-xs);
  line-height: 1.55;
}
.chatgpt-feedback[data-state='error'] {
  color: var(--danger-text);
}
.chatgpt-feedback[data-state='info'] {
  color: var(--text-secondary);
}
.chatgpt-accounts {
  min-inline-size: 0;
  color: var(--text-secondary);
  font-size: var(--fs-label-sm);
}
.chatgpt-accounts-body {
  display: grid;
  gap: var(--s-2);
  padding-top: var(--s-2);
}
.chatgpt-account-list {
  display: grid;
  gap: var(--s-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.chatgpt-account-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--bg-base);
}
.chatgpt-account-item[data-active='true'] {
  border-color: var(--accent);
}
.chatgpt-account-info {
  display: grid;
  min-inline-size: 0;
}
.chatgpt-account-info strong {
  color: var(--text-primary);
  font-size: var(--fs-label-sm);
  overflow-wrap: anywhere;
}
.chatgpt-account-info small {
  color: var(--text-secondary);
  font-size: var(--fs-label-xs);
}
.chatgpt-account-actions,
.chatgpt-account-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--s-2);
}
.chatgpt-account-footer {
  justify-content: space-between;
}

.chatgpt-welcome-dialog {
  max-width: min(420px, calc(100vw - var(--s-6)));
  padding: 0;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: var(--shadow-lg);
}
.chatgpt-welcome-dialog:modal {
  overscroll-behavior: contain;
}
.chatgpt-welcome-dialog::backdrop {
  overflow: hidden;
  overscroll-behavior: contain;
  background: var(--art-scrim);
}
.chatgpt-welcome-card {
  display: grid;
  gap: var(--s-3);
  padding: var(--s-5);
}
.chatgpt-welcome-card h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--fs-title-sm);
  line-height: 1.35;
}
.chatgpt-welcome-card p {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  line-height: 1.65;
}
.chatgpt-welcome-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--s-2);
  padding-top: var(--s-2);
}
</style>
