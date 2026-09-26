/**
 * 运行环境判定 —— 本机直连语义的唯一来源。
 *
 * 「本机」= localhost / 127.0.0.1 / [::1] 直连（非隧道分享链接）。
 * 消费方：成人内容传输层授权（useChatConversation → /api/desktop-tools）、
 * 访客引导、场景页成人内容默认值。此前该判断以内联正则/数组形式散落 4 处，
 * 现统一到这里。
 */

import { ELECTRON_UI_ORIGIN } from '../../services/desktopOrigins.ts'

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]', 'tauri.localhost'] as const

export function isLocalStudioHost(hostname?: string): boolean {
  if (hostname === undefined) {
    if (typeof window === 'undefined') return false
    if (window.location.origin === ELECTRON_UI_ORIGIN) return true
    if (!['http:', 'https:', 'tauri:'].includes(window.location.protocol)) return false
    hostname = window.location.hostname
  }
  // 桌面桥对象和包含 tauri 的公网域名都不能授予本机权限。
  // Windows WebView 使用 http(s)://tauri.localhost，其他桌面端使用 tauri://localhost。
  return (LOCAL_HOSTNAMES as readonly string[]).includes(hostname.toLowerCase())
}
