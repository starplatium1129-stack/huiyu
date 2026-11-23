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
      <p class="field-help">支持添加多个 QQ 机器人，分别绑定项目内的不同角色卡，各自独立连接、对话，并可按需调用本机绘图与语音。</p>

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
        </button>
        <span v-if="creating" class="qq-bot-chip qq-bot-chip-draft" data-selected="true">
          <span class="qq-bot-chip-title">新机器人</span>
          <span class="qq-bot-chip-meta">待保存</span>
        </span>
      </div>

      <form class="qq-form" aria-labelledby="qq-settings-title" novalidate @submit.prevent="save">
        <div v-if="creating && bots.length > 0" class="qq-draft-bar">
          <span class="field-label">正在添加新的 QQ 机器人</span>
          <button class="btn btn-quiet btn-sm" type="button" :disabled="busy" @click="cancelCreate">返回已有机器人</button>
        </div>

        <div class="qq-field">
          <label class="field-label" for="qq-bot-name">机器人备注（可选）</label>
          <input
            id="qq-bot-name"
            v-model.trim="botName"
            name="qq-bot-name"
            class="input"
            maxlength="40"
            autocomplete="off"
            placeholder="例如：宁宁私聊号、夏目群聊号（留空则显示角色名）"
          />
        </div>

        <div class="qq-fields">
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
            <p v-else-if="savedSecret" id="qq-secret-help" class="field-help">已保存在这台电脑，留空可继续沿用。</p>
          </div>
        </div>

        <div class="qq-field">
          <label class="field-label" for="qq-character">绑定角色卡</label>
          <StudioSelect
            id="qq-character"
            v-model="character"
            label="QQ 机器人绑定角色卡"
            :groups="characterGroups"
            searchable
            search-placeholder="搜索角色名或角色 ID…"
            empty-text="没有找到匹配的角色卡"
            aria-describedby="qq-character-help"
          >
            <template #value>{{ selectedCharacterName }}</template>
          </StudioSelect>
          <p id="qq-character-help" class="field-help">{{ characterHelp }}</p>
        </div>

        <fieldset class="qq-drawing-permissions qq-field" aria-describedby="qq-owner-bond-help">
          <legend class="field-label">对我的认主与亲密度</legend>
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
          <p id="qq-owner-bond-help" class="field-help">{{ ownerBondHelp }}</p>
          <div v-if="ownerBond !== 'default'" class="qq-fields">
            <div class="qq-field">
              <label class="field-label" for="qq-owner-call-name">对我的称呼（可选）</label>
              <input
                id="qq-owner-call-name"
                v-model.trim="ownerCallName"
                name="qq-owner-call-name"
                class="input"
                maxlength="40"
                autocomplete="off"
                placeholder="例如：主人、徒弟、哥哥（留空则按角色自然称呼）"
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
                placeholder="例如：我是她最信赖的亲传弟子兼恋人，私下可以撒娇"
              />
            </div>
          </div>
        </fieldset>

        <fieldset class="qq-drawing-permissions qq-field" aria-describedby="qq-chat-provider-help">
          <legend class="field-label">聊天模型来源</legend>
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
          <p id="qq-chat-provider-help" class="field-help">{{ chatProviderHelp }}</p>
          <p v-if="usesChatGpt && chatGptNotice" class="field-help" :class="{ 'qq-error': chatGptNeedsAttention }" role="status">
            {{ chatGptNotice }}
            <RouterLink v-if="chatGptNeedsAttention" class="qq-inline-link" to="/chat">前往角色房间设置</RouterLink>
          </p>
        </fieldset>

        <ToggleSwitch v-model="enabled" label="启用这个 QQ 机器人">启用这个 QQ 机器人</ToggleSwitch>

        <fieldset class="qq-drawing-permissions qq-field">
          <legend class="field-label">允许本机绘图</legend>
          <div class="qq-actions">
            <ToggleSwitch v-model="drawing" label="允许 QQ 私聊绘图">私聊</ToggleSwitch>
            <ToggleSwitch v-model="groupDrawing" label="允许已绑定的 QQ 群绘图">已绑定的群聊</ToggleSwitch>
          </div>
          <p v-if="drawing || groupDrawing" class="field-help">{{ drawingHelp }}</p>
        </fieldset>

        <fieldset class="qq-drawing-permissions qq-field" aria-describedby="qq-voice-help">
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
          <p id="qq-voice-help" class="field-help">{{ voiceHelp }}</p>
          <div v-if="voiceMode !== 'off'" class="qq-voice-extras">
            <div class="qq-field">
              <label class="field-label" for="qq-voice-profile">语音声线</label>
              <StudioSelect
                id="qq-voice-profile"
                v-model="voiceProfile"
                label="QQ 机器人语音声线"
                :options="voiceProfileOptions"
              />
            </div>
            <ToggleSwitch v-model="groupVoice" label="允许已绑定的 QQ 群发语音">允许已绑定的群聊发语音</ToggleSwitch>
          </div>
          <p v-if="voiceMode !== 'off' && voiceNotice" class="field-help" :class="{ 'qq-error': voiceNeedsAttention }" role="status">
            {{ voiceNotice }}
            <RouterLink v-if="voiceNeedsAttention" class="qq-inline-link" to="/control?section=control-voice">前往语音设置</RouterLink>
          </p>
        </fieldset>

        <fieldset v-if="!groupMuse" class="qq-drawing-permissions qq-field">
          <legend class="field-label">群聊互动</legend>
          <ToggleSwitch v-model="groupNaturalReplies" :disabled="busy || !loaded" aria-describedby="qq-natural-replies-help">在群里自然接话</ToggleSwitch>
          <p id="qq-natural-replies-help" class="field-help">群主在 QQ 允许获取全部群消息后，机器人会参考已绑定群的近期消息，偶尔接自己相关或有话可聊的话题。</p>
        </fieldset>

        <details v-if="showMuseDisclosure" class="qq-advanced" :open="groupMuse || privateMuse || undefined">
          <StudioDisclosureSummary>高级：Muse 协作接管（兼容旧配置）</StudioDisclosureSummary>
          <div class="qq-advanced-body" data-disclosure-content>
            <div class="qq-actions">
              <ToggleSwitch v-model="privateMuse">已绑定的私聊</ToggleSwitch>
              <ToggleSwitch v-model="groupMuse" aria-describedby="qq-muse-help">已绑定的群聊</ToggleSwitch>
            </div>
            <p id="qq-muse-help" class="field-help">开启后，对应会话将转交给 Muse 而不是上面选中的角色卡与聊天模型。</p>
            <div v-if="groupMuse" class="qq-field">
              <label class="field-label" for="qq-muse-context">每条消息附带的群聊前文</label>
              <StudioSelect id="qq-muse-context" v-model="museContextLimit" label="每条消息附带的群聊前文" :options="contextOptions" />
            </div>
            <ToggleSwitch v-if="groupMuse" v-model="groupMuseAll">也接收没有 @ 机器人的群消息</ToggleSwitch>
            <ToggleSwitch v-if="groupMuse || privateMuse" v-model="museProactive">允许 Muse 主动发消息</ToggleSwitch>
            <p v-if="activeBot?.groupMuseStatus" class="field-help" role="status">{{ museStatusLabels[activeBot.groupMuseStatus] }}</p>
          </div>
        </details>

        <div class="qq-actions">
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
            {{ activeBot.paired ? '重新绑定私聊' : '生成私聊口令' }}
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

      <div v-if="pairCommand" class="qq-pair">
        <p class="field-help">在手机 QQ 打开与这个机器人的私聊，把整条命令发给它。口令 5 分钟内有效。</p>
        <code>{{ pairCommand }}</code>
        <StudioCopyButton class="btn btn-ghost btn-sm" label="复制绑定命令" :content-key="pairCommand" :action="() => copyWithFeedback(pairCommand)" />
      </div>

      <section v-if="activeBot" class="qq-groups" aria-labelledby="qq-groups-title">
        <header class="qq-heading">
          <h3 id="qq-groups-title" ref="groupHeading" tabindex="-1">QQ 群聊（{{ botTitle(activeBot) }}）</h3>
          <span class="qq-status" role="status">{{ activeBot.groups.length ? `已绑定 ${activeBot.groups.length} 个群` : '未绑定群' }}</span>
        </header>
        <p class="field-help">先把有群聊权限的机器人加进目标群。绑定后，群成员 @ 机器人就能互动。</p>
        <form class="qq-group-form" aria-labelledby="qq-groups-title" @submit.prevent="pairGroup">
          <div class="qq-field">
            <label class="field-label" for="qq-group-name">群备注（可选）</label>
            <input id="qq-group-name" v-model.trim="groupLabel" name="label" class="input" maxlength="40" />
          </div>
          <button class="btn btn-ghost btn-sm" type="submit" :disabled="busy || !activeBot.enabled">生成群口令</button>
        </form>
        <div v-if="groupPairCommand" class="qq-pair">
          <p class="field-help">在目标群里先 @ 机器人，再发送这条命令。口令 5 分钟内有效。</p>
          <code>{{ groupPairCommand }}</code>
          <StudioCopyButton class="btn btn-ghost btn-sm" label="复制群绑定命令" :content-key="groupPairCommand" :action="() => copyWithFeedback(groupPairCommand)" />
        </div>
        <ul v-if="activeBot.groups.length" class="qq-group-list" aria-label="已绑定的 QQ 群">
          <li v-for="group in activeBot.groups" :key="group.id">
            <span class="qq-group-meta">
              <span>{{ group.label }}</span>
              <small v-if="group.ownerBound" class="qq-group-badge">已认主</small>
              <small v-else-if="ownerBond !== 'default'" class="qq-group-badge">待认主（在群里重发一次 /绑定群 口令即可识别你）</small>
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
  botName, appId, secret, character, ownerBond, ownerBondHelp, ownerCallName, ownerNote, chatProvider,
  voiceMode, groupVoice, voiceProfile, voiceProfileOptions, enabled, drawing, groupDrawing, groupNaturalReplies, groupLabel,
  groupMuse, privateMuse, groupMuseAll, museContextLimit, museProactive, showMuseDisclosure,
  groupHeading, idField, secretField, savedSecret, idError, secretError, pairCommand, groupPairCommand,
  botTitle, characterGroups, characterHelp, selectedCharacterName,
  usesChatGpt, chatProviderHelp, chatGptNeedsAttention, chatGptNotice, drawingHelp, voiceHelp, voiceNeedsAttention, voiceNotice,
  selectBot, startCreate, cancelCreate, refresh, save, removeBot, pair, pairGroup, removeGroup,
} = useQqBotSettings(() => props.active)
</script>

<style scoped>
.qq-settings,.qq-form,.qq-field,.qq-pair,.qq-groups,.qq-advanced-body { display:grid; gap:var(--s-2); min-inline-size:0; }
.qq-settings { gap:var(--s-3); }
.qq-heading,.qq-heading-meta,.qq-actions,.qq-draft-bar,.qq-delete-confirm { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); }
.qq-heading,.qq-draft-bar { justify-content:space-between; }
.qq-heading h2 { margin:0; display:flex; align-items:center; gap:var(--s-2); }
.qq-actions .archive-icon,.qq-heading .archive-icon,.qq-heading-meta .archive-icon { inline-size:1em; block-size:1em; }
.qq-status { color:var(--text-secondary); font-size:var(--fs-label); }
.qq-bot-list { display:flex; flex-wrap:wrap; gap:var(--s-2); }
.qq-bot-chip { display:inline-flex; align-items:center; gap:var(--s-2); min-block-size:var(--control-height-sm); padding:var(--s-1) var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-elevated); color:var(--text-primary); font-size:var(--fs-label-sm); cursor:pointer; }
.qq-bot-chip[data-selected='true'] { border-color:var(--accent); background:var(--bg-surface); }
.qq-bot-chip:disabled { color:var(--text-disabled); cursor:not-allowed; }
.qq-bot-chip-draft { cursor:default; }
.qq-bot-chip-title { font-weight:600; }
.qq-bot-chip-meta { color:var(--text-secondary); font-size:var(--fs-label-xs); }
.qq-fields,.qq-voice-extras { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr)); gap:var(--s-3); align-items:end; }
.qq-form { align-items:start; }
.qq-field { align-content:start; }
.qq-field .input { inline-size:100%; }
.qq-field .input[aria-invalid='true'] { border-color:var(--danger-text); }
.qq-settings .qq-error,.qq-danger-btn { color:var(--danger-text); }
.qq-settings .field-help { margin:0; overflow-wrap:anywhere; }
.qq-pair { justify-items:start; padding:var(--s-3); border:1px solid var(--border-soft); border-radius:var(--r-md); background:var(--bg-elevated); }
.qq-pair code { color:var(--text-primary); overflow-wrap:anywhere; }
.qq-drawing-permissions,.qq-group-list { min-inline-size:0; padding:0; margin:0; border:0; }
.qq-radio-group { display:flex; flex-wrap:wrap; gap:var(--s-2) var(--s-4); }
.qq-radio-option { display:inline-flex; align-items:center; gap:var(--s-2); min-inline-size:0; }
.qq-radio-option label { color:var(--text-primary); font-size:var(--fs-label-sm); cursor:pointer; }
.qq-radio-option input:disabled + label { color:var(--text-disabled); cursor:not-allowed; }
.qq-inline-link { color:var(--accent); text-decoration:underline; text-underline-offset:3px; margin-inline-start:var(--s-1); }
.qq-advanced { min-inline-size:0; color:var(--text-secondary); font-size:var(--fs-label-sm); }
.qq-advanced-body { padding-block-start:var(--s-2); }
.qq-groups { padding-block-start:var(--s-3); border-block-start:1px solid var(--border-soft); }
.qq-groups h3 { margin:0; font-size:var(--fs-body); }
.qq-group-form { display:flex; align-items:end; flex-wrap:wrap; gap:var(--s-2); }
.qq-group-form .qq-field { flex:1 1 12rem; }
.qq-group-list { display:grid; gap:var(--s-1); list-style:none; }
.qq-group-list li { display:flex; justify-content:space-between; align-items:center; gap:var(--s-2); padding-block:var(--s-1); border-block-end:1px solid var(--border-soft); }
.qq-group-meta { display:flex; align-items:center; flex-wrap:wrap; gap:var(--s-2); min-inline-size:0; }
.qq-group-badge { color:var(--text-secondary); font-size:var(--fs-label-xs); }
.qq-group-list li span { min-inline-size:0; overflow-wrap:anywhere; }
.qq-group-list li button { flex-shrink:0; }
</style>
