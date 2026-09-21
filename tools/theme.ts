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

  let STORAGE_KEY = 'aics_theme';
  let DEFAULT_THEME = 'dark';

  function getTheme() {
    try { return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : DEFAULT_THEME; } catch (e) { return DEFAULT_THEME; }
  }

  function applyTheme(theme: string) {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
  }

  /* ---------- toggle 按钮 ---------- */

  function renderIcon(btn: HTMLElement) {
    const dark = document.documentElement.dataset.theme === 'dark';
    // Same hand-drawn paths as ArchiveIcon statusDefs; classic document script.
    const paths = dark
      ? ['M16.2 12 A4.2 4.2 0 1 1 7.8 12 A4.2 4.2 0 1 1 16.2 12', 'M12 2.8 V4.2 M12 19.8 V21.2 M2.8 12 H4.2 M19.8 12 H21.2 M5.5 5.5 L6.5 6.5 M17.5 17.5 L18.5 18.5 M5.5 18.5 L6.5 17.5 M17.5 6.5 L18.5 5.5']
      : ['M19.8 14.2 A8.5 8.5 0 1 1 9.8 4.2 C7.4 7.8 8.6 12.6 12.4 14.5 Q16 16.5 19.8 14.2 Z'];
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths.map(d => '<path d="' + d + '"/>').join('') + '</svg>';
    btn.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
  }

  function buildToggle() {
    let btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.setAttribute('aria-label', '切换主题');
    btn.addEventListener('click', function () {
      let cur = document.documentElement.dataset.theme;
      let next = cur === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
      applyTheme(next);
      renderIcon(btn);
    });
    return btn;
  }

  function injectToggle() {
    let host = document.querySelector('.nav-links') || document.querySelector('.nav-inner');
    if (!host || document.querySelector('.theme-toggle')) return;
    const toggle = buildToggle();
    host.appendChild(toggle);
    renderIcon(toggle);
  }

  /* ---------- 初始化 ---------- */

  function init() {
    applyTheme(getTheme());
    window.addEventListener('storage', event => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      applyTheme(getTheme());
      const toggle = document.querySelector<HTMLElement>('.theme-toggle');
      if (toggle) renderIcon(toggle);
    });
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectToggle);
    } else {
      injectToggle();
    }
  }

  init();
})();
