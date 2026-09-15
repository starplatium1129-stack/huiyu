/* ============================================================
   绫季绘境 · Theme Manager
   PDD §6.3 / §6.13 — 暖白(#FAF7F2) + 夜(#17171C) 双主题

   用法: 任意目录的页面加一行:
     <script src="<相对根路径>/tools/theme.js" data-theme-manager></script>
   自动推断根路径 + 注入导航 toggle,无需每个页面调 init()。

   状态:
     - localStorage key: `aics_theme` (dark|light)
     - documentElement attribute: data-theme
     - CSS: [data-theme="light"] 覆写 design-system.css tokens
   ============================================================ */
(function () {
  'use strict';

  var STORAGE_KEY = 'aics_theme';
  var DEFAULT_THEME = 'dark';

  function getTheme() {
    try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME; } catch (e) { return DEFAULT_THEME; }
  }

  function applyTheme(theme: string) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  /* ---------- toggle 按钮 ---------- */

  function renderIcon(btn: HTMLElement) {
    var t = getTheme();
    btn.innerHTML = t === 'dark'
      ? '<span class="theme-toggle-icon">🌙</span>'
      : '<span class="theme-toggle-icon">☀️</span>';
  }

  function buildToggle() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.setAttribute('aria-label', '切换主题');
    btn.addEventListener('click', function () {
      var cur = getTheme();
      var next = cur === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
      applyTheme(next);
      renderIcon(btn);
    });
    return btn;
  }

  function injectToggle() {
    var host = document.querySelector('.nav-links') || document.querySelector('.nav-inner');
    if (!host || document.querySelector('.theme-toggle')) return;
    const toggle = buildToggle();
    host.appendChild(toggle);
    renderIcon(toggle);
  }

  /* ---------- 初始化 ---------- */

  function init() {
    applyTheme(getTheme());
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectToggle);
    } else {
      injectToggle();
    }
  }

  init();
})();
