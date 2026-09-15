/**
 * 共享数据的唯一加载口。
 *
 * 存在的理由：审计发现 `scenes.json`（~892KB / gzip ~230KB / 实测 301 条，勿在注释固化条数）被 7 处
 * 独立 fetch，用 4 种不同 cache key —— 其中 SceneManagerView 用
 * `?v=' + Date.now()`，保证每次进页面都全量重传。同时这个为"单例缓存"而建的
 * store 有 0 个消费者。
 *
 * 现在所有视图都走这里：一次网络请求，一份内存副本，一个版本号。
 *
 * 2026-09-05 审计修复（P1-01/P1-02）：
 *  - 元数据区分必需（characters/popular/blueprints，失败必须可见且不得标记完成）
 *    与可选（失败保留旧数据、单列 metaFailedFiles），逐资源缓存成功结果，重试只补失败项；
 *  - 进行中请求按目标键去重（full/core/各角色分片），不同目标的并发加载各自成行；
 *    旧响应返回时若"当前展示目标"已切换或已有更新的同键工作，一律不得回写视图。
 */

export interface SceneRecord {
  id: string
  [key: string]: unknown
}

export interface Scene {
  id: string; title: string; story?: string; prompt?: string; tags?: string[]; visualDescription?: string
  char?: string; category?: string; season?: string; series?: string
  rating?: string; mature?: boolean; lora?: string; time?: string; timeOfDay?: string
  lighting?: string; camera?: string; negative?: string
  location?: string; weather?: string; emotion?: string
  recommendedSize?: string; animaCaption?: string
  usage?: string[]; [k: string]: unknown
}

export type { SceneBlueprint } from './sceneBlueprint'
export type { SceneDraft, SceneRating, SceneChangeSet, SceneSaveResult } from './api'
