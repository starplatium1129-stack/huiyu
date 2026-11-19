const { mimeOf } = require('./media')

const key = group => 'huiyu-muse-card:' + group

function empty() {
  return { text: '', image: null, clientKey: '', id: '', expiresAt: Date.now() + 86400000 }
}

function restore(group) {
  let saved
  try { saved = wx.getStorageSync(key(group)) } catch { return empty() }
  if (!saved || !(saved.expiresAt > Date.now())) {
    if (saved) {
      try { wx.removeStorageSync(key(group)) } catch { /* Ignore unavailable storage on entry. */ }
    }
    return empty()
  }
  return {
    text: typeof saved.text === 'string' ? saved.text.slice(0, 1600) : '',
    image: saved.image && mimeOf(saved.image.data) === saved.image.mimeType ? saved.image : null,
    clientKey: typeof saved.clientKey === 'string' ? saved.clientKey : '',
    id: typeof saved.id === 'string' ? saved.id : '',
    expiresAt: saved.expiresAt,
  }
}

function save(group, record) {
  try { wx.setStorageSync(key(group), record) }
  catch { throw new Error('手机存储空间不足，暂时无法保存这次提问。') }
}

module.exports = { empty, restore, save }
