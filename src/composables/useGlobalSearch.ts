import { ref } from 'vue'

/**
 * 全局搜索的唤起契约（2026-08-30 UX 审计 P1）。
 *
 * 与 useConfirm / useToast 同构的模块级单例。之所以需要它：`<GlobalSearch/>`
 * 由 App.vue 挂在路由之外，而触发按钮在路由内的 AppNav 里，两者没有父子
 * 关系，也没有共同祖先可注入，需要一个不依赖组件树的唤起通道。
 *
 * 存在的理由：搜索覆盖 15 个页面 + 场景 + 作品，是本项目最强的捷径，但此前
 * 只有 Ctrl/Cmd+K 与 `/` 两个键盘入口——纯鼠标流用户永远用不上它。
 */

export type SearchOpenSource = 'keyboard' | 'pointer'

/**
 * 递增的请求序号，而不是布尔量。
 *
 * 布尔量表达不了「连点两次」：面板打开后再点按钮，布尔量仍是 true，宿主
 * watch 不到变化，界面毫无反应。序号每次调用都变，语义是「又请求了一次」。
 */
const openRequest = ref(0)
const closeRequest = ref(0)
const openSource = ref<SearchOpenSource>('keyboard')

/** 供任意组件调用：请求打开全局搜索面板。 */
export function openGlobalSearch(source: SearchOpenSource = 'pointer') {
  openSource.value = source
  openRequest.value += 1
}

/** Navigation releases search ownership before any asynchronous route preparation. */
export function closeGlobalSearch() { closeRequest.value++ }

/** 仅供 GlobalSearch 宿主组件读取与监听。 */
export function useGlobalSearchRequest() {
  return { openRequest, openSource, closeRequest }
}
