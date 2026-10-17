/**
 * 本地存储写入失败的判定与文案（2026-08-30 UX 审计）。
 *
 * 项目里多处 `try { localStorage.setItem(...) } catch {}` 把写入失败静默吞掉：
 * 配额写满时界面一切正常、用户以为草稿已经保存，刷新即丢。这些 catch 不能
 * 什么都不做，至少要让失败可感知，并在配额场景下给出可操作的出口
 * （导出备份 / 清理空间）。
 */

/** 浏览器配额写满（Chrome/Firefox 的 QuotaExceededError 家谱命名不统一） */
function isQuotaError(error: unknown): boolean {
  if (!error) return false
  const name = (error as { name?: string } | null)?.name ?? ''
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true
  // Safari 私密浏览等场景给的是 code 22 / 1014，没有规范化的 name
  const code = (error as { code?: number } | null)?.code
  return code === 22 || code === 1014
}

/** 给用户的失败文案：配额满与「其他写失败」区分开，前者有明确补救动作 */
export function storageWriteMessage(error: unknown, subject = '草稿'): string {
  return isQuotaError(error)
    ? `本地空间已满，${subject}没能保存，建议先导出备份再清理旧数据`
    : `${subject}保存失败，这次改动刷新后可能不会保留`
}
