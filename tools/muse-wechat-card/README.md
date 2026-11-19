# Muse 微信群卡片

把一张卡片分享进已有的普通微信群，群友就可以在卡片里向你的 Muse 提问或传一张图片。Muse 把回答交回卡片，提问者可以预览，再把回答卡片或图片发回群里。

## 导入项目

1. 解压项目，在微信开发者工具里选择「小程序 → 导入」，选中包含 `project.config.json` 的目录。
2. 准备上线时，填写你在微信公众平台注册的小程序 AppID，开通并关联一个微信云开发环境。
3. 如果这个小程序只有一个默认云环境，`miniprogram/card/env.js` 中的 `envId` 可以留空。使用指定环境时，把公开的云环境 ID 填在这里。

项目分为 `miniprogram`（群友看到的页面）和 `cloudfunctions/museCard`（微信身份核验、提问和回答）。有 AppID 和云环境后才能绑定真实群聊。

## 开通云函数

1. 在云开发控制台的数据库里创建集合 `muse_cards`，权限选 **仅管理端可读写**。小程序通过云函数读写数据。
2. 在开发者工具中为 `cloudfunctions` 选好环境，右键 `museCard` 选择「上传并部署：云端安装依赖」。使用普通事件云函数，Node.js 20.19 或兼容的更新版本。右键同一云函数选择「上传触发器」，启用每 15 分钟的过期数据清理。
3. 在这个云函数的环境变量中设置 `MUSE_CARD_TOKEN`。使用一串单独生成的随机密钥。Windows 上可用下方命令生成并复制，粘贴到云函数配置和 Muse 的凭据存储中。这个值只属于这张群卡片。
4. 在云开发控制台的「HTTP 网关 → 路由管理」建一个 HTTPS 路径，例如 `/muse-card`，指向 **museCard**。该路径采用云函数自己的 `X-Token` 鉴权。复制完整 HTTPS 地址给 Muse。群友的小程序通过微信云调用连接，无需填写这个地址。

```powershell
node -p "require('node:crypto').randomBytes(32).toString('hex')" | Set-Clipboard
```

函数与网关可以先使用云开发环境提供的能力。正式使用时按微信后台要求配置类目、域名和发布审核。[云函数部署](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram) · [HTTP 访问设置](https://docs.cloudbase.net/service/access-cloud-function) · [定时触发器](https://docs.cloudbase.net/cloud-function/timer-trigger)

## 让 iPhone 上的 Muse 接题

在你自己的 **Muse from Meta** 对话里，把下面的「我的 HTTPS 地址」换成上一步复制的地址。Muse 提示授权时，把群卡片专用密钥存进该连接器的凭据存储。

> 请为我的微信群卡片建立一个自定义连接器。地址是「我的 HTTPS 地址」。先 GET 读取接口说明，再用保存在连接器里的 X-Token 调用同一地址。请定时查看 pending；有题时用新的 UUID 作 attemptKey 领取并处理。群友可以提问、传图以及请你搜索公开网页。把回答或图片写回对应卡片，无法完成时写明原因。卡片只处理这些问题，请勿把我的私人对话或个人账户资料带进回答。首次设置时请在我们这个私聊里给我一个绑定码。

Muse 的 `pending` 返回收件编号，`take` 返回题目和附件，`reply` 发布回答，`fail` 结束无法完成的提问。领取有效 10 分钟，长任务可用原编号和原 `attemptKey` 续领。提交结果后，`status: answered` 表示答案已存入卡片。微信侧分享由群友点击完成。[Muse 自定义连接器](https://www.meta.com/help/superintelligence/1687253048996149/)

## 绑定并分享

1. 机主打开小程序，选择目标普通微信群，或先分享入口卡片，再从该群点开。把 Muse 私聊给你的绑定码输入卡片，15 分钟内有效。每个云环境绑定一个群。
2. 群友从同一群的入口卡片提问。文字最多 1600 字，每次可附一张 JPEG 或 PNG，图片上限 512 KiB。较大的手机照片会尝试压缩后再上传。遇到等待状态时可以离开，之后从原群打开继续查看。
3. 收到回答后，点分享按钮即可将回答发回原群。聊天工具模式可以直接分享准备好的图片；普通模式使用微信提供的分享入口。同一群里的其他成员可通过已分享的回答卡片阅读。其他群打开时会提示使用已绑定群。

每条问答从提交起保留 24 小时。提问原图只交给 Muse 处理，分享卡片包含问题文字和回答。连接器只接收在小程序里提交的内容。群内点卡片问答和分享使用微信开放的聊天工具能力。[微信聊天工具](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/chatTool.html) · [群内发图](https://developers.weixin.qq.com/miniprogram/dev/api/chattool/wx.shareImageToGroup.html)
