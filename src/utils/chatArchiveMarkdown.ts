import type { ChatArchive } from './chatArchive'
import type { ChatBranch } from '@/composables/chat/chatStorageTypes'
import { getCompanionCharacter } from './companionRegistry'

export function exportChatArchiveMarkdown(archive: ChatArchive, characterIds: string[], branches: (id: string) => Pick<ChatBranch, 'id' | 'name'>[]): string {
  const names = Object.fromEntries(characterIds.map(id => [id, getCompanionCharacter(id)?.name || id]))
  for (const char of characterIds) for (const branch of branches(char)) names[branch.id === 'main' ? char : `${char}::${branch.id}`] = `${getCompanionCharacter(char)?.name || char} · ${branch.name}`
  return chatArchiveToMarkdown(archive, names)
}

function chatArchiveToMarkdown(
  archive: ChatArchive,
  characterNames: Record<string, string>,
): string {
  const lines: string[] = ['# 角色聊天归档', '', '> 由 绘遇 导出 · 对话文本、回复备选与停止标记', '']
  for (const [characterId, messages] of Object.entries(archive.archived)) {
    const name = characterNames[characterId] || characterId
    lines.push(`## ${name}（${messages.length} 条）`, '')
    if (!messages.length) {
      lines.push('*暂无归档*', '')
      continue
    }
    for (const message of messages) {
      const speaker = message.role === 'user' ? '你' : name
      const suffix = message.stopped ? ' *(中断)*' : ''
      lines.push(`**${speaker}**${suffix}：${message.content}`, '')
      for (const variant of message.variants || []) if (variant.mid !== message.mid) lines.push(`> 备选${variant.stopped ? '（中断）' : ''}：${variant.content}`, '')
    }
  }
  return lines.join('\n').trimEnd() + '\n'
}
