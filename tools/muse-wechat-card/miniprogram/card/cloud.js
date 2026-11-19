const { envId } = require('./env')

let initialized = false

function invoke(api, options = {}) {
  return new Promise((resolve, reject) => api({ ...options, success: resolve, fail: reject }))
}

function inChatTool() {
  return typeof wx.getApiCategory === 'function' && wx.getApiCategory() === 'chatTool'
}

async function call(action, data, current) {
  if (!wx.cloud) throw new Error('当前微信版本不支持云开发，请更新微信后再打开。')
  if (!initialized) {
    wx.cloud.init(envId ? { env: envId } : {})
    initialized = true
  }
  const info = inChatTool() ? wx.getChatToolInfo : wx.getGroupEnterInfo
  if (typeof info !== 'function') throw new Error('当前微信版本无法识别群，请更新微信。')
  let cloudID
  try {
    const group = await invoke(info, inChatTool() ? {} : { needGroupOpenID: true })
    cloudID = group.cloudID
  } catch (err) {
    if (err.errCode === 65206) throw new Error('你已离开这个群。请在已加入的群内打开提问卡片。')
    throw new Error('请从普通微信群里的卡片打开，或回到首页选择群聊。')
  }
  if (!cloudID) throw new Error('微信未返回群凭据，请从群里重开，并确认云开发已启用。')
  if (!current()) throw new Error('页面已切换')
  let result
  try {
    const reply = await wx.cloud.callFunction({ name: 'museCard', data: { ...data, action, groupCloudId: cloudID } })
    result = reply.result
  } catch {
    throw new Error('暂时连不上群卡片服务，请检查网络后重试。')
  }
  if (!result || !result.ok) {
    const error = new Error(result && typeof result.error === 'string' ? result.error : '群卡片服务没有返回有效结果。')
    error.code = result && result.code
    throw error
  }
  return result
}

module.exports = { invoke, call, inChatTool }
