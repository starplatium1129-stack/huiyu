const { invoke, call, inChatTool } = require('../../cloud')
const media = require('../../media')
const session = require('../../session')

const PAGE = '/card/pages/ask/index'
const COVER = '/card/cover.png'

function linkFrom(options) {
  if (!options || !options.id) return null
  return { id: String(options.id).slice(0, 160), shareKey: String(options.shareKey || '').slice(0, 160) }
}

function currentTheme() {
  return (wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()).theme || 'light'
}

function notice(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback
}

Page({
  data: {
    screen: 'opening', theme: 'light', top: 26, barHeight: 44, canGoBack: false, chatTool: false,
    text: '', code: '', draftPath: '', hasPhoto: false, uncertain: false, busy: false, picking: false,
    feedback: '', focusQuestion: false, focusCode: false, question: null, answerPath: '', answerShareable: false, imageBusy: false, imageError: '',
  },

  onLoad(options) {
    this.epoch = 0
    this.link = linkFrom(options)
    this.entrySignature = null
    this.group = ''
    this.live = true
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const menu = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null
    const top = win.statusBarHeight || 20
    const barHeight = menu && menu.height && menu.top >= top ? (menu.top - top) * 2 + menu.height : 44
    this.setData({ top, barHeight, theme: currentTheme(), canGoBack: getCurrentPages().length > 1, chatTool: inChatTool() })
    this.themeChanged = result => this.setData({ theme: result.theme })
    if (wx.onThemeChange) wx.onThemeChange(this.themeChanged)
    if (!this.data.chatTool) wx.showShareMenu({ withShareTicket: true })
  },

  onShow() {
    this.visible = true
    if (wx.getEnterOptionsSync) {
      const entry = wx.getEnterOptionsSync()
      if ('/' + entry.path === PAGE) {
        const ref = linkFrom(entry.query)
        const signature = ref ? ref.id + '/' + ref.shareKey : ''
        if (this.entrySignature !== null && signature !== this.entrySignature) this.link = ref
        this.entrySignature = signature
      }
    }
    this.opening = this.openGroup()
  },

  onHide() {
    this.visible = false
    this.pause()
    if (this.group && this.record && this.data.screen === 'ask') {
      try { session.save(this.group, this.record) } catch { /* Submitting checks storage explicitly. */ }
    }
  },

  onUnload() {
    this.live = false
    this.visible = false
    this.pause()
    media.dropFile(this.data.draftPath)
    media.dropFile(this.data.answerPath)
    if (wx.offThemeChange) wx.offThemeChange(this.themeChanged)
  },

  pause() {
    this.epoch++
    clearTimeout(this.timer)
  },

  current(epoch) {
    return this.live && this.visible && this.epoch === epoch
  },

  request(epoch, action, data = {}) {
    return call(action, data, () => this.current(epoch))
  },

  async openGroup() {
    this.pause()
    const epoch = this.epoch
    this.active = null
    this.setData({ screen: 'opening', busy: false, picking: Boolean(this.picker), imageBusy: false, feedback: '', focusCode: false, focusQuestion: false, chatTool: inChatTool() })
    try {
      const response = await this.request(epoch, 'open')
      if (!this.current(epoch)) return
      if (response.groupKey !== this.group) {
        media.dropFile(this.data.draftPath)
        media.dropFile(this.data.answerPath)
        this.group = response.groupKey
        this.record = session.restore(this.group)
        this.cachedImageId = ''
        this.setData({ draftPath: '', answerPath: '', question: null, code: '' })
      }
      if (response.groupState !== 'ready') {
        this.setData({ screen: response.groupState === 'unbound' ? 'bind' : 'other' })
        return
      }
      this.active = this.link || (this.record.id ? { id: this.record.id } : null)
      if (this.active) {
        this.setData({ screen: 'result', question: null })
        await this.readAnswer()
      } else await this.showDraft(epoch)
    } catch (error) {
      if (this.current(epoch)) this.setData({ screen: 'unavailable', feedback: notice(error, '暂时无法打开群卡片，请稍后重试。') })
    }
  },

  retryOpen() {
    this.opening = this.openGroup()
  },

  home() {
    wx.reLaunch({ url: '/pages/home/index?choose=1' })
  },

  back() {
    wx.navigateBack()
  },

  inputCode(event) {
    this.setData({ code: event.detail.value, feedback: '', focusCode: false })
  },

  async bindGroup() {
    if (this.data.busy) return
    const bindCode = this.data.code.trim()
    if (!bindCode) {
      this.setData({ focusCode: true, feedback: '请输入 Muse 私聊里的绑定码。' })
      return
    }
    const epoch = this.epoch
    this.setData({ busy: true, feedback: '' })
    try {
      await this.request(epoch, 'bind', { bindCode })
      if (!this.current(epoch)) return
      this.setData({ code: '' })
      this.opening = this.openGroup()
    } catch (error) {
      if (this.current(epoch)) this.setData({ busy: false, feedback: notice(error, '绑定失败，请重新获取绑定码。') })
    }
  },

  async showDraft(epoch) {
    const record = this.record
    this.setData({ screen: 'ask', busy: false, question: null, text: record.text, hasPhoto: Boolean(record.image), uncertain: Boolean(record.clientKey), imageError: '', focusQuestion: false })
    if (record.image && !this.data.draftPath) {
      try {
        const path = await media.localImage(record.image)
        if (this.current(epoch) && this.record === record && record.image) this.setData({ draftPath: path })
        else media.dropFile(path)
      } catch (error) {
        if (this.current(epoch)) this.setData({ feedback: notice(error, '草稿图片暂时无法预览，可以重新选择。') })
      }
    }
  },

  inputText(event) {
    if (!this.record || this.data.busy || this.record.clientKey) return
    this.record.text = event.detail.value
    this.setData({ text: this.record.text, feedback: '', focusQuestion: false })
  },

  async selectPhoto() {
    if (this.picker || this.data.busy || this.data.uncertain) return
    const group = this.group
    const record = this.record
    this.picker = true
    this.setData({ picking: true, feedback: '' })
    try {
      const selected = await media.choosePhoto()
      if (this.opening) await this.opening
      if (!this.live || this.group !== group || this.record !== record) return
      const image = await media.preparePhoto(selected, this)
      if (!this.live || this.group !== group || this.record !== record || record.clientKey) return
      const path = await media.localImage(image)
      if (!this.live || this.group !== group || this.record !== record || record.clientKey) {
        media.dropFile(path)
        return
      }
      record.image = image
      media.dropFile(this.data.draftPath)
      this.setData({ draftPath: path, hasPhoto: true })
      session.save(group, record)
    } catch (error) {
      if (this.live && this.group === group && !/cancel/i.test(error.errMsg || '')) {
        this.setData({ feedback: notice(error, '无法读取选中的图片，请重选 JPEG 或 PNG。') })
      }
    } finally {
      this.picker = false
      if (this.live) this.setData({ picking: false })
    }
  },

  removePhoto() {
    if (this.data.busy || this.data.picking || this.data.uncertain) return
    this.record.image = null
    media.dropFile(this.data.draftPath)
    this.setData({ draftPath: '', hasPhoto: false, feedback: '' })
  },

  async ask() {
    if (this.data.busy || this.data.picking || this.data.screen !== 'ask') return
    const record = this.record
    if (!record.text.trim() && !record.image) {
      this.setData({ feedback: '写下问题，或选一张图片。', focusQuestion: true })
      return
    }
    const epoch = this.epoch
    this.setData({ busy: true, feedback: '', focusQuestion: false })
    try {
      if (!record.clientKey) {
        const { randomValues } = await invoke(wx.getRandomValues, { length: 16 })
        if (!this.current(epoch)) return
        record.clientKey = Array.from(new Uint8Array(randomValues), byte => ('0' + byte.toString(16)).slice(-2)).join('')
        record.expiresAt = Date.now() + 86400000
      }
      // Save the exact payload and key before the first write. An interrupted
      // upload or unknown ask response can then be retried without a second task.
      session.save(this.group, record)
      const request = (action, data) => this.request(epoch, action, data)
      const data = { clientKey: record.clientKey, text: record.text.trim() }
      if (record.image) data.image = await media.stagePhoto(record.image, record.clientKey, request)
      const { question } = await request('ask', data)
      if (!this.current(epoch)) return
      this.record = { ...session.empty(), id: question.id, expiresAt: question.expiresAt }
      // If storage is full, the previously persisted idempotent draft still recovers this task.
      try { session.save(this.group, this.record) } catch { /* The accepted answer remains usable in this page. */ }
      this.active = { id: question.id }
      media.dropFile(this.data.draftPath)
      this.setData({ busy: false, draftPath: '', hasPhoto: false, text: '', uncertain: false, screen: 'result' })
      await this.presentAnswer(epoch, question)
    } catch (error) {
      if (this.current(epoch)) this.setData({ busy: false, uncertain: Boolean(this.record.clientKey), feedback: notice(error, '提交未确认，可用原内容重试。') })
    }
  },

  async readAnswer() {
    const epoch = this.epoch
    if (!this.active || !this.current(epoch) || this.reading === epoch) return
    this.reading = epoch
    clearTimeout(this.timer)
    try {
      const result = await this.request(epoch, 'read', this.active)
      if (this.current(epoch)) await this.presentAnswer(epoch, result.question)
    } catch (error) {
      if (this.current(epoch)) {
        this.setData({ feedback: notice(error, '暂时无法读取回答，请重试。') })
        const question = this.data.question
        if (question && ['pending', 'processing'].includes(question.state) && question.expiresAt > Date.now()) this.timer = setTimeout(() => this.readAnswer(), 15000)
      }
    } finally {
      if (this.reading === epoch) this.reading = null
    }
  },

  async presentAnswer(epoch, question) {
    if (this.cachedImageId !== question.id || !question.answerImage) {
      media.dropFile(this.data.answerPath)
      this.cachedImageId = ''
      this.setData({ answerPath: '', imageError: '' })
    }
    const shareKey = question.shareKey || (this.active && this.active.shareKey)
    this.setData({ question, screen: 'result', feedback: '', answerShareable: Boolean(shareKey && question.state === 'answered') })
    if (['pending', 'processing'].includes(question.state)) {
      const left = question.expiresAt - Date.now()
      if (left <= 0) this.setData({ feedback: '提问已过期，可以重新提问。' })
      else this.timer = setTimeout(() => this.readAnswer(), Math.min(6500, left + 50))
      return
    }
    if (question.answerImage && (this.cachedImageId !== question.id || !this.data.answerPath)) {
      this.setData({ imageBusy: true, imageError: '' })
      try {
        const path = await media.readAnswerImage(question.answerImage, this.active, (action, data) => this.request(epoch, action, data))
        if (!this.current(epoch)) { media.dropFile(path); return }
        media.dropFile(this.data.answerPath)
        this.cachedImageId = question.id
        this.setData({ answerPath: path })
      } catch (error) {
        if (this.current(epoch)) this.setData({ imageError: notice(error, '图片加载失败，请重新读取。') })
      } finally {
        if (this.current(epoch)) this.setData({ imageBusy: false })
      }
    }
  },

  async newQuestion() {
    this.pause()
    const epoch = this.epoch
    const wasShared = Boolean(this.link)
    this.link = null
    this.active = null
    this.cachedImageId = ''
    media.dropFile(this.data.answerPath)
    this.setData({ answerPath: '', imageError: '', feedback: '', imageBusy: false, busy: false })
    if (wasShared && this.record.id) {
      this.active = { id: this.record.id }
      this.setData({ screen: 'result', question: null })
      await this.readAnswer()
      return
    }
    if (!wasShared) {
      media.dropFile(this.data.draftPath)
      this.record = session.empty()
      this.setData({ draftPath: '' })
      try { session.save(this.group, this.record) } catch (error) { this.setData({ feedback: error.message }) }
    }
    await this.showDraft(epoch)
  },

  shareData() {
    const q = this.data.question
    if (!q || !this.data.answerShareable) return { title: '问 Muse', path: PAGE, imageUrl: COVER }
    const key = q.shareKey || this.active.shareKey
    const path = PAGE + '?id=' + encodeURIComponent(q.id) + '&shareKey=' + encodeURIComponent(key)
    return { title: '查看 Muse 的回答', path, imageUrl: COVER }
  },

  onShareAppMessage() {
    return this.shareData()
  },

  shareCard() {
    wx.shareAppMessageToGroup({
      ...this.shareData(),
      fail: err => { if (!/cancel/i.test(err.errMsg)) this.setData({ feedback: '微信没有发出卡片，请重试。' }) },
    })
  },

  copyAnswer() {
    const q = this.data.question
    if (q && q.answerText) wx.setClipboardData({ data: q.answerText })
  },

  previewImage() {
    const path = this.data.answerPath || this.data.draftPath
    if (path) wx.previewImage({ current: path, urls: [path] })
  },

  sharePicture() {
    const path = this.data.answerPath
    if (!path) return
    const fail = err => {
      if (this.live && !/cancel/i.test(err.errMsg || '')) this.setData({ imageError: '微信未能分享图片。可点开图片，长按后选择发送。' })
    }
    if (this.data.chatTool && wx.shareImageToGroup) wx.shareImageToGroup({ imagePath: path, entrancePath: this.shareData().path, fail })
    else if (wx.showShareImageMenu) wx.showShareImageMenu({ path, entrancePath: this.shareData().path, fail })
    else wx.previewImage({ current: path, urls: [path], showmenu: true, fail })
  },
})
