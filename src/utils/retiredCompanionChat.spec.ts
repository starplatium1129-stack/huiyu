import { afterEach, expect, it } from 'vitest'
import { preserveRetiredCompanionChat } from './retiredCompanionChat'
import { RETIRED_COMPANION_CHAT_KEY } from './storageKeys'
afterEach(() => localStorage.clear())
it('retains removed model history and draft without collecting API settings', () => {
  const history = [{ role: 'user', content: '保留这条记录' }]
  preserveRetiredCompanionChat({ histories: { raiden_shogun: history }, settings: { drafts: { raiden_shogun: '草稿' }, apiKey: 'private' } })
  expect(JSON.parse(localStorage.getItem(RETIRED_COMPANION_CHAT_KEY)!)).toEqual({ raiden_shogun: { history, draft: '草稿' } })
  preserveRetiredCompanionChat({ histories: { nene: [] } })
  expect(localStorage.getItem(RETIRED_COMPANION_CHAT_KEY)).not.toContain('private')
})
