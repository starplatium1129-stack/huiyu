const askPage = '/card/pages/ask/index'

Page({
  data: { canChoose: false, choosing: false, error: '' },
  onLoad(options) {
    this.setData({ canChoose: typeof wx.openChatTool === 'function' })
    wx.showShareMenu({ withShareTicket: true })
    const entry = wx.getEnterOptionsSync ? wx.getEnterOptionsSync() : wx.getLaunchOptionsSync()
    if (options.choose !== '1' && (entry.chatType === 3 || [1008, 1044, 1158, 1160].includes(entry.scene))) {
      const query = options.id && options.shareKey
        ? '?id=' + encodeURIComponent(options.id) + '&shareKey=' + encodeURIComponent(options.shareKey)
        : ''
      wx.redirectTo({ url: askPage + query, fail: () => this.setData({ error: '未能打开群卡片，请重新选择群聊。' }) })
    }
  },
  chooseGroup() {
    if (this.data.choosing || !this.data.canChoose) return
    this.setData({ choosing: true, error: '' })
    wx.openChatTool({
      url: askPage,
      fail: error => {
        if (!/cancel/i.test(error.errMsg || '')) this.setData({ error: '未能打开选群窗口。可以把提问卡片发到群里，再从群里打开。' })
      },
      complete: () => this.setData({ choosing: false }),
    })
  },
  onShareAppMessage() {
    return { title: '问 Muse', path: askPage }
  },
})
