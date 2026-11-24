<template>
  <section id="control-companion-channels" class="panel-card qq-settings" aria-labelledby="qq-settings-title">
    <header class="qq-heading">
      <h2 id="qq-settings-title" class="panel-heading"><ArchiveIcon name="chat" />手机聊天 · QQ</h2>
      <div class="qq-heading-meta">
        <span v-if="loaded" class="qq-status" role="status">{{ summaryLabel }}</span>
        <button
          v-if="loaded && bots.length > 0 && !creating"
          class="btn btn-ghost btn-sm"
          type="button"
          :disabled="busy || bots.length >= 16"
          @click="startCreate"
        >
          <ArchiveIcon name="plus" />添加机器人
        </button>
      </div>
    </header>
    <p v-if="!workspace" class="field-help">连接 QQ 前，请在绘遇桌面版启用本机工作区。</p>
    <template v-else>
      <div v-if="bots.length > 0" class="qq-bot-list" role="group" aria-label="已配置的 QQ 机器人">
        <button
          v-for="bot in bots"
          :key="bot.id"
          type="button"
          class="qq-bot-chip"
          :data-selected="(!creating && selectedId === bot.id) || undefined"
          :aria-pressed="!creating && selectedId === bot.id"
          :disabled="busy"
          @click="selectBot(bot.id)"
        >
          <span class="qq-bot-chip-title">{{ botTitle(bot) }}</span>
          <span class="qq-bot-chip-meta">{{ phaseLabel(bot) }}</span>
          <ArchiveIcon name="success" class="qq-bot-chip-check" />
        </button>
      </div>

      <form v-if="loaded" class="qq-form" aria-labelledby="qq-settings-title" novalidate @submit.prevent="save">
        <section class="qq-form-section" aria-labelledby="qq-connection-title">
          <header class="qq-heading">
            <h3 id="qq-connection-title">{{ creating ? '新机器人' : '机器人连接' }}</h3>
            <div class="qq-actions">
              <ToggleSwitch v-model="enabled" :disabled="busy || !loaded">启用机器人</ToggleSwitch>
              <button v-if="creating && bots.length" class="btn btn-quiet btn-sm" type="button" :disabled="busy" @click="cancelCreate">取消新增</button>
            </div>
          </header>
          <div class="qq-fields">
            <div class="qq-field">
              <label class="field-label" for="qq-character">绑定角色卡</label>
              <StudioSelect
                id="qq-character"
                v-model="character"
                label="绑定角色卡"
                :groups="characterGroups"
                searchable
                search-placeholder="搜索角色名或角色 ID…"
                empty-text="没有找到匹配的角色卡"
              >
                <template #value>{{ selectedCharacterName }}</template>
              </StudioSelect>
            </div>
            <div class="qq-field">
              <label class="field-label" for="qq-bot-name">机器人备注</label>
              <input id="qq-bot-name" v-model.trim="botName" name="qq-bot-name" class="input"
                maxlength="40" autocomplete="off" placeholder="留空使用角色名" />
            </div>
          </div>
          <details class="qq-disclosure" :open="!activeBot || undefined">
            <StudioDisclosureSummary>
              <span>连接凭据</span>
              <small v-if="savedSecret" class="qq-disclosure-value">已保存</small>
            </StudioDisclosureSummary>
            <div class="qq-fields qq-disclosure-body" data-disclosure-content>
              <div class="qq-field">
                <label class="field-label" for="qq-app-id">AppID</label>
                <input
                  id="qq-app-id"
                  ref="idField"
                  v-model.trim="appId"
                  name="qq-app-id"
                  class="input input-mono"
                  inputmode="numeric"
                  maxlength="24"
                  required
                  autocomplete="off"
                  :aria-invalid="Boolean(idError)"
                  :aria-describedby="idError ? 'qq-id-error' : undefined"
                />
                <p v-if="idError" id="qq-id-error" class="qq-error field-help">{{ idError }}</p>
              </div>
              <div class="qq-field">
                <label class="field-label" for="qq-app-secret">AppSecret</label>
                <input
                  id="qq-app-secret"
                  ref="secretField"
                  v-model.trim="secret"
                  name="qq-app-secret"
                  class="input input-mono"
                  type="password"
                  maxlength="512"
                  autocomplete="off"
                  :required="!savedSecret"
                  :aria-invalid="Boolean(secretError)"
                  :aria-describedby="secretError ? 'qq-secret-error' : savedSecret ? 'qq-secret-help' : undefined"
                />
                <p v-if="secretError" id="qq-secret-error" class="qq-error field-help">{{ secretError }}</p>
                <p v-else-if="savedSecret" id="qq-secret-help" class="field-help">留空沿用已保存的密钥。</p>
              </div>
            </div>
          </details>

          <details class="qq-disclosure">
            <StudioDisclosureSummary>
              <span>角色关系</span>
              <small class="qq-disclosure-value">{{ ownerBondOptions.find(option => option.value === ownerBond)?.label }}</small>
            </StudioDisclosureSummary>
            <div class="qq-disclosure-body" data-disclosure-content>
              <fieldset class="qq-field" :aria-describedby="ownerBond !== 'default' ? 'qq-owner-bond-help' : undefined">
                <legend class="sr-only">亲密度</legend>
                <div class="qq-radio-group">
                  <span v-for="option in ownerBondOptions" :key="option.value" class="qq-radio-option">
                    <input
                      :id="`qq-bond-${option.value}`"
                      v-model="ownerBond"
                      type="radio"
                      name="qq-owner-bond"
                      :value="option.value"
                      :disabled="busy || !loaded"
                    />
                    <label :for="`qq-bond-${option.value}`">{{ option.label }}</label>
                  </span>
                </div>
                <template v-if="ownerBond !== 'default'">
                  <p id="qq-owner-bond-help" class="field-help">仅对已认主的你生效。</p>
                  <div class="qq-fields">
                    <div class="qq-field">
                      <label class="field-label" for="qq-owner-call-name">对我的称呼（可选）</label>
                      <input
                        id="qq-owner-call-name"
                        v-model.trim="ownerCallName"
                        name="qq-owner-call-name"
                        class="input"
                        maxlength="40"
                        autocomplete="off"
                        placeholder="留空由角色决定"
                      />
                    </div>
                    <div class="qq-field">
                      <label class="field-label" for="qq-owner-note">对我的关系补充（可选）</label>
                      <input
                        id="qq-owner-note"
                        v-model.trim="ownerNote"
                        name="qq-owner-note"
                        class="input"
                        maxlength="200"
                        autocomplete="off"
                        placeholder="例如：相识多年的搭档"
                      />
                    </div>
                  </div>
                </template>
              </fieldset>
            </div>
          </details>
        </section>

        <section class="qq-form-section" aria-labelledby="qq-reply-title">
          <h3 id="qq-reply-title">聊天与工具</h3>
          <fieldset class="qq-field" :aria-describedby="chatProviderHelp ? 'qq-chat-provider-help' : undefined">
            <legend class="field-label">聊天模型</legend>
            <div class="qq-radio-group">
              <span v-for="option in chatProviderOptions" :key="option.value" class="qq-radio-option">
                <input
                  :id="`qq-provider-${option.value}`"
                  v-model="chatProvider"
                  type="radio"
                  name="qq-chat-provider"
                  :value="option.value"
                  :disabled="busy || !loaded"
                />
                <label :for="`qq-provider-${option.value}`">{{ option.label }}</label>
              </span>
            </div>
            <div v-if="chatProviderHelp || (usesChatGpt && chatGptNotice)" class="qq-field-notes">
              <div v-if="usesChatGpt && chatGptNotice" class="qq-service-status" :class="{ 'qq-error': chatGptNeedsAttention }" role="status">
                <ArchiveIcon :name="chatGptNeedsAttention ? 'warning' : 'success'" />
                <span>{{ chatGptNotice }}</span>
                <RouterLink v-if="chatGptNeedsAttention" class="qq-inline-link" to="/chat">打开角色房间</RouterLink>
              </div>
              <p v-if="chatProviderHelp" id="qq-chat-provider-help" class="field-help">{{ chatProviderHelp }}</p>
            </div>
          </fieldset>

          <div class="qq-fields qq-form-row">
            <fieldset class="qq-field" :aria-describedby="drawing || groupDrawing ? 'qq-drawing-help' : undefined">
              <legend class="field-label">本机绘图</legend>
              <div class="qq-actions">
                <ToggleSwitch v-model="drawing" label="私聊绘图" :disabled="busy || !loaded">私聊</ToggleSwitch>
                <ToggleSwitch v-model="groupDrawing" label="已绑定的群聊绘图" :disabled="busy || !loaded">已绑定群聊</ToggleSwitch>
              </div>
              <p v-if="drawing || groupDrawing" id="qq-drawing-help" class="field-help">{{ drawingHelp }}</p>
            </fieldset>
            <fieldset v-if="!groupMuse" class="qq-field">
              <legend class="field-label">群聊互动</legend>
              <ToggleSwitch v-model="groupNaturalReplies" :disabled="busy || !loaded" aria-describedby="qq-natural-replies-help">在群里自然接话</ToggleSwitch>
              <p id="qq-natural-replies-help" class="field-help">需群主授权读取全部群消息。</p>
            </fieldset>
          </div>

          <fieldset class="qq-field" :aria-describedby="voiceMode !== 'off' ? 'qq-voice-help' : undefined">
            <legend class="field-label">语音回复</legend>
            <div class="qq-radio-group">
              <span v-for="option in voiceModeOptions" :key="option.value" class="qq-radio-option">
                <input
                  :id="`qq-voice-${option.value}`"
                  v-model="voiceMode"
                  type="radio"
                  name="qq-voice-mode"
                  :value="option.value"
                  :disabled="busy || !loaded"
                />
                <label :for="`qq-voice-${option.value}`">{{ option.label }}</label>
              </span>
            </div>
            <div v-if="voiceMode !== 'off'" class="qq-fields qq-voice-extras">
              <div class="qq-field">
                <label class="field-label" for="qq-voice-profile">声线</label>
                <StudioSelect
                  id="qq-voice-profile"
                  v-model="voiceProfile"
                  label="声线"
                  :options="voiceProfileOptions"
                />
              </div>
              <ToggleSwitch v-model="groupVoice" :disabled="busy || !loaded">已绑定群聊发语音</ToggleSwitch>
            </div>
            <div v-if="voiceMode !== 'off'" class="qq-field-notes">
              <div v-if="voiceNotice" class="qq-service-status" :class="{ 'qq-error': voiceNeedsAttention }" role="status">
                <ArchiveIcon :name="voiceNeedsAttention ? 'warning' : 'success'" />
                <span>{{ voiceNotice }}</span>
                <RouterLink v-if="voiceNeedsAttention" class="qq-inline-link" to="/control?section=control-voice">打开语音设置</RouterLink>
              </div>
              <p id="qq-voice-help" class="field-help">私聊可发送 <code>/语音</code> 或直接请求语音。</p>
            </div>
          </fieldset>
        </section>

        <details v-if="showMuseDisclosure" class="qq-disclosure" :open="groupMuse || privateMuse || undefined">
          <StudioDisclosureSummary>Muse 协作</StudioDisclosureSummary>
          <div class="qq-disclosure-body" data-disclosure-content>
            <div class="qq-actions">
              <ToggleSwitch v-model="privateMuse">主人私聊</ToggleSwitch>
              <ToggleSwitch v-model="groupMuse" aria-describedby="qq-muse-help">已绑定的群聊</ToggleSwitch>
            </div>
            <p id="qq-muse-help" class="field-help">对应会话交由 Muse 回复。</p>
            <div v-if="groupMuse" class="qq-field">
              <label class="field-label" for="qq-muse-context">群聊前文</label>
              <StudioSelect id="qq-muse-context" v-model="museContextLimit" label="群聊前文" :options="contextOptions" />
            </div>
            <ToggleSwitch v-if="groupMuse" v-model="groupMuseAll">也接收没有 @ 机器人的群消息</ToggleSwitch>
            <ToggleSwitch v-if="groupMuse || privateMuse" v-model="museProactive">允许 Muse 主动发消息</ToggleSwitch>
            <p v-if="activeBot?.groupMuseStatus" class="field-help" role="status">{{ museStatusLabels[activeBot.groupMuseStatus] }}</p>
          </div>
        </details>

        <div class="qq-actions qq-form-footer">
          <button class="btn btn-primary btn-sm" type="submit" :disabled="busy || !loaded">
            {{ busy ? '处理中…' : creating ? '添加并连接' : '保存连接' }}
          </button>
          <button
            v-if="activeBot"
            class="btn btn-ghost btn-sm"
            type="button"
            :disabled="busy || !activeBot.enabled"
            @click="pair"
          >
            {{ activeBot.paired ? '重新绑定主人' : '生成主人口令' }}
          </button>
          <template v-if="activeBot">
            <button
              v-if="!confirmDelete"
              class="btn btn-quiet btn-sm"
              type="button"
              :disabled="busy"
              @click="confirmDelete = true"
            >
              删除机器人
            </button>
            <span v-else class="qq-delete-confirm" role="group" aria-label="确认删除机器人">
              <span class="field-help">确认删除？</span>
              <button class="btn btn-ghost btn-sm qq-danger-btn" type="button" :disabled="busy" @click="removeBot">确认删除</button>
              <button class="btn btn-quiet btn-sm" type="button" :disabled="busy" @click="confirmDelete = false">取消</button>
            </span>
          </template>
        </div>
        <p v-if="activeBot?.detail" class="field-help" role="status">{{ activeBot.detail }}</p>
      </form>
      <p v-else-if="!feedback" class="field-help" role="status">正在读取 QQ 设置…</p>

      <div v-if="pairCommand" class="qq-pair">
        <p class="field-help">请由主人在 QQ 私聊中发送命令。口令 5 分钟内有效。</p>
        <code>{{ pairCommand }}</code>
        <StudioCopyButton class="btn btn-ghost btn-sm" label="复制绑定命令" :content-key="pairCommand" :action="() => copyWithFeedback(pairCommand)" />
      </div>

      <section v-if="activeBot?.friends" class="qq-groups" aria-labelledby="qq-friends-title">
        <header class="qq-heading">
          <h3 id="qq-friends-title" ref="friendHeading" tabindex="-1">私聊好友白名单</h3>
          <span class="qq-status" role="status">{{ activeBot.friends.length ? `已绑定 ${activeBot.friends.length} 位好友` : '未绑定好友' }}</span>
        </header>
        <form class="qq-group-form" aria-labelledby="qq-friends-title" @submit.prevent="pairFriend">
          <div class="qq-field">
            <label class="field-label" for="qq-friend-name">好友备注（可选）</label>
            <input id="qq-friend-name" v-model.trim="friendLabel" name="label" class="input" maxlength="40" autocomplete="off" />
          </div>
          <button class="btn btn-ghost btn-sm" type="submit" :disabled="busy || !activeBot.enabled">生成好友口令</button>
        </form>
        <div v-if="friendPairCommand" class="qq-pair">
          <p class="field-help">请好友在 QQ 私聊中发送命令。口令 5 分钟内有效，可使用一次。</p>
          <code>{{ friendPairCommand }}</code>
          <StudioCopyButton class="btn btn-ghost btn-sm" label="复制好友绑定命令" :content-key="friendPairCommand" :action="() => copyWithFeedback(friendPairCommand)" />
        </div>
        <ul v-if="activeBot.friends.length" class="qq-group-list" aria-label="已绑定的私聊好友">
          <li v-for="friend in activeBot.friends" :key="friend.id">
            <span>{{ friend.label }}</span>
            <button class="btn btn-ghost btn-sm" type="button" :aria-label="`移除好友 ${friend.label}`" :disabled="busy" @click="removeFriend(friend.id)">移除好友</button>
          </li>
        </ul>
      </section>

      <section v-if="activeBot" class="qq-groups" aria-labelledby="qq-groups-title">
        <header class="qq-heading">
          <h3 id="qq-groups-title" ref="groupHeading" tabindex="-1">QQ 群聊（{{ botTitle(activeBot) }}）</h3>
          <span class="qq-status" role="status">{{ activeBot.groups.length ? `已绑定 ${activeBot.groups.length} 个群` : '未绑定群' }}</span>
        </header>
        <p v-if="!activeBot.groups.length" class="field-help">先将机器人加入要绑定的群。</p>
        <form class="qq-group-form" aria-labelledby="qq-groups-title" @submit.prevent="pairGroup">
          <div class="qq-field">
            <label class="field-label" for="qq-group-name">群备注（可选）</label>
            <input id="qq-group-name" v-model.trim="groupLabel" name="label" class="input" maxlength="40" />
          </div>
          <button class="btn btn-ghost btn-sm" type="submit" :disabled="busy || !activeBot.enabled">生成群口令</button>
        </form>
        <div v-if="groupPairCommand" class="qq-pair">
          <p class="field-help">在目标群 @ 机器人并发送命令。口令 5 分钟内有效。</p>
          <code>{{ groupPairCommand }}</code>
          <StudioCopyButton class="btn btn-ghost btn-sm" label="复制群绑定命令" :content-key="groupPairCommand" :action="() => copyWithFeedback(groupPairCommand)" />
        </div>
        <ul v-if="activeBot.groups.length" class="qq-group-list" aria-label="已绑定的 QQ 群">
          <li v-for="group in activeBot.groups" :key="group.id">
            <span class="qq-group-meta">
              <span>{{ group.label }}</span>
              <small v-if="group.ownerBound" class="qq-group-badge">已认主</small>
              <small v-else-if="ownerBond !== 'default'" class="qq-group-badge">待认主 · 在群里重发绑定命令</small>
            </span>
            <button class="btn btn-ghost btn-sm" type="button" :aria-label="`解除绑定：${group.label}`" :disabled="busy" @click="removeGroup(group.id)">解除绑定</button>
          </li>
        </ul>
      </section>

      <p v-if="feedback" class="qq-error field-help" role="alert">{{ feedback }}</p>
      <div class="qq-actions">
        <a class="btn btn-ghost btn-sm" href="https://q.qq.com/qqbot/" target="_blank" rel="noopener noreferrer">打开 QQ 机器人开放平台 <ArchiveIcon name="chevron-down" /></a>
        <button v-if="!loaded && feedback" class="btn btn-ghost btn-sm" type="button" @click="refresh">重新读取</button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import ArchiveIcon from '@/components/visual/ArchiveIcon.vue'
import ToggleSwitch from '@/components/visual/ToggleSwitch.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import StudioCopyButton from '@/components/ui/StudioCopyButton.vue'
import StudioDisclosureSummary from '@/components/ui/StudioDisclosureSummary.vue'
import { copyWithFeedback } from '@/composables/useCopyFeedback'
import {
  chatProviderOptions, contextOptions, museStatusLabels, ownerBondOptions, phaseLabel, voiceModeOptions,
} from './companion-qq/qqSettingsPresentation'
import { useQqBotSettings } from './companion-qq/useQqBotSettings'

const props = defineProps<{ active: boolean }>()
const {
  workspace, loaded, bots, selectedId, creating, confirmDelete, busy, feedback, activeBot, summaryLabel,
  botName, appId, secret, character, ownerBond, ownerCallName, ownerNote, chatProvider,
  voiceMode, groupVoice, voiceProfile, voiceProfileOptions, enabled, drawing, groupDrawing, groupNaturalReplies, groupLabel,
  groupMuse, privateMuse, groupMuseAll, museContextLimit, museProactive, showMuseDisclosure,
  groupHeading, friendHeading, idField, secretField, savedSecret, idError, secretError, pairCommand, groupPairCommand,
  friendLabel, friendPairCommand,
  botTitle, characterGroups, selectedCharacterName,
  usesChatGpt, chatProviderHelp, chatGptNeedsAttention, chatGptNotice, drawingHelp, voiceNeedsAttention, voiceNotice,
  selectBot, startCreate, cancelCreate, refresh, save, removeBot, pair, pairGroup, removeGroup, pairFriend, removeFriend,
} = useQqBotSettings(() => props.active)
</script>

<style scoped>
.qq-settings,.qq-form,.qq-form-section,.qq-field,.qq-pair,.qq-groups,.qq-disclosure-body { display:grid; gap:var(--s-2); min-inline-size:0; }
.qq-settings { gap:var(--s-3); }
.qq-heading,.qq-heading-meta,.qq-actions,.qq-delete-confirm { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); }
.qq-heading { justify-content:space-between; }
.qq-heading h2 { margin:0; display:flex; align-items:center; gap:var(--s-2); }
.qq-actions .archive-icon,.qq-heading .archive-icon,.qq-service-status .archive-icon,.qq-bot-chip-check { inline-size:1em; block-size:1em; flex:none; }
.qq-status { color:var(--text-secondary); font-size:var(--fs-label); }
.qq-bot-list { display:flex; flex-wrap:wrap; gap:var(--s-2); }
.qq-bot-chip { display:inline-flex; align-items:center; gap:var(--s-2); min-block-size:var(--control-height-sm); padding:var(--s-1) var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-elevated); color:var(--text-primary); font-size:var(--fs-label-sm); cursor:pointer; }
.qq-bot-chip[data-selected='true'] { border-color:var(--accent); box-shadow:var(--selection-shadow); }
.qq-bot-chip:disabled,.qq-bot-chip:disabled .qq-bot-chip-meta { color:var(--text-disabled); cursor:not-allowed; }
.qq-bot-chip:not([data-selected]) .qq-bot-chip-check { visibility:hidden; }
.qq-bot-chip:focus-visible,.qq-disclosure > summary:focus-visible { outline:2px solid var(--focus-color); outline-offset:2px; }
.qq-bot-chip-title { font-weight:600; }
.qq-bot-chip-meta { color:var(--text-secondary); font-size:var(--fs-label-xs); }
.qq-form { align-items:start; gap:var(--s-3); }
.qq-form-section { gap:var(--s-3); padding-block-start:var(--s-3); border-block-start:1px solid var(--border-soft); }
.qq-form-section h3,.qq-groups h3 { margin:0; font-size:var(--fs-body); }
.qq-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr)); gap:var(--s-3) var(--s-4); align-items:start; }
.qq-form-row { padding-block:var(--s-3); border-block:1px solid var(--border-soft); }
.qq-voice-extras { align-items:end; }
.qq-field { align-content:start; }
.qq-field :is(.input,.studio-select-wrapper) { min-inline-size:0; }
.qq-field .input { inline-size:100%; }
.qq-field .input[aria-invalid='true'] { border-color:var(--danger-text); }
.qq-field .toggle-switch,.qq-heading .toggle-switch { justify-self:start; font-size:var(--fs-label-sm); }
.qq-settings .qq-error,.qq-danger-btn { color:var(--danger-text); }
.qq-settings .field-help { margin:0; overflow-wrap:anywhere; }
.qq-pair { justify-items:start; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-elevated); }
.qq-pair code { color:var(--text-primary); overflow-wrap:anywhere; }
.qq-form fieldset,.qq-group-list { min-inline-size:0; padding:0; margin:0; border:0; }
.qq-field legend { margin-block-end:var(--s-1); }
.qq-radio-group { display:flex; flex-wrap:wrap; gap:var(--s-1) var(--s-4); }
.qq-radio-option { display:inline-flex; align-items:center; gap:var(--s-2); min-inline-size:0; }
.qq-radio-option label { display:flex; align-items:center; min-block-size:var(--control-height-sm); color:var(--text-primary); font-size:var(--fs-label-sm); cursor:pointer; }
.qq-radio-option input:disabled + label { color:var(--text-disabled); cursor:not-allowed; }
.qq-field-notes,.qq-service-status { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s-1) var(--s-2); }
.qq-field-notes { gap:var(--s-1) var(--s-4); }
.qq-service-status { font-size:var(--fs-label-xs); color:var(--text-secondary); overflow-wrap:anywhere; }
.qq-service-status:not(.qq-error) .archive-icon { color:var(--success-text); }
.qq-inline-link { color:var(--accent); text-decoration:underline; text-underline-offset:3px; margin-inline-start:var(--s-1); }
.qq-disclosure { min-inline-size:0; border-block-start:1px solid var(--border-soft); color:var(--text-primary); font-size:var(--fs-label-sm); }
.qq-disclosure-value { margin-inline-start:auto; font-size:var(--fs-label-xs); color:var(--text-secondary); }
.qq-disclosure :deep(.qq-disclosure-value + .studio-disclosure-chevron) { margin-inline-start:0; }
.qq-disclosure-body { padding-block:var(--s-1) var(--s-2); }
.qq-form-footer { padding-block-start:var(--s-3); border-block-start:1px solid var(--border-soft); }
.qq-groups { padding-block-start:var(--s-3); border-block-start:1px solid var(--border-soft); }
.qq-group-form { display:flex; align-items:end; flex-wrap:wrap; gap:var(--s-2); }
.qq-group-form .qq-field { flex:1 1 12rem; }
.qq-group-list { display:grid; gap:var(--s-1); list-style:none; }
.qq-group-list li { display:flex; justify-content:space-between; align-items:center; gap:var(--s-2); padding-block:var(--s-1); border-block-end:1px solid var(--border-soft); }
.qq-group-meta { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); min-inline-size:0; }
.qq-group-badge { color:var(--text-secondary); font-size:var(--fs-label-xs); }
.qq-group-list li span { min-inline-size:0; overflow-wrap:anywhere; }
.qq-group-list li button { flex-shrink:0; }
@media (pointer:coarse) {
  .qq-bot-chip,.qq-radio-option label,.qq-disclosure > summary { min-block-size:44px; }
}
</style>
