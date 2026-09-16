# HUIYU 完整代码审计报告

版本：1.7.1
项目：绘遇 HUIYU

## 审计说明

本报告只记录已通过代码、项目结构或现有文档确认的问题。

审计原则：

- 不记录未经验证的猜测
- 每个问题关联文件范围
- 优先处理影响架构稳定性的事项

---

# 1. 架构总览

HUIYU 当前包含：

- Vue 3 + Vite 前端
- Express 本地网关
- Stable Diffusion / ComfyUI 接入
- AI 视频链路
- Live2D 系统
- 语音系统
- Tauri 桌面端

项目已经具备完整产品形态，但核心模块仍存在职责集中问题。

---

# 2. 后端审计

## HUIYU-ARCH-001

## server.ts 职责集中

文件：

```
server.ts
```

发现：

入口负责：

- Express 初始化
- middleware 注册
- security
- static resource
- router 注册
- tunnel
- compression
- 多个业务服务初始化

问题：

启动层承担业务组装职责。

风险：

- 修改影响范围大
- 新功能继续增加复杂度

建议：

拆分：

```
server/
 app.ts
 bootstrap.ts
 middleware/
```

验收：

server.ts 只负责启动。

---

# HUIYU-ARCH-002

## generation 路由职责过重

文件：

```
routes/generation.ts
```

发现：

同一文件包含：

- HTTP 处理
- 参数验证
- LoRA 管理
- 模型资源检查
- Prompt 清理
- Comfy 资源判断
- 错误处理

问题：

业务层和基础设施层耦合。

建议：

拆分：

```
routes/generation/
 controller.ts
 service.ts
 validator.ts
 resource-manager.ts
```

---

# 3. 前端审计

## HUIYU-FE-001

## Router 业务集中

文件：

```
src/router/index.ts
```

发现：

集中注册大量页面：

- studio
- gallery
- character
- video
- chat
- companion
- control

同时包含 Live2D CSP reload 逻辑。

问题：

路由层承担业务生命周期控制。

建议：

拆：

```
src/router/routes/
 studio.ts
 character.ts
 gallery.ts
 system.ts
```

---

# 4. AI 架构

## HUIYU-AI-001

## 多模型调用需要统一 Provider 层

当前支持多个生成后端。

建议统一：

```
services/providers/
 provider.ts
 stable-diffusion.ts
 comfyui.ts
```

接口：

```
generate()
status()
healthCheck()
cancel()
```

---

# 5. 数据层

## HUIYU-DATA-001

## 内容数据需要 Schema 校验

涉及：

- Scene
- Character
- Blueprint
- Prompt

建议增加：

```
schemas/
```

统一验证版本和字段。

---

# 6. 优先级列表

## P0

- server 入口拆分
- generation 模块拆分
- 配置统一

## P1

- Provider 抽象
- Router 模块化
- 数据 Schema

## P2

- 性能优化
- 历史记录系统
- Prompt 版本管理

---

# 7. 后续审计计划

继续检查：

- services 全量调用链
- stores 状态管理
- components 复杂度
- data 文件结构
- 测试覆盖率
- 构建产物

本报告持续更新。
