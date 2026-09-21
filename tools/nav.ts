/* ============================================================
   绫季绘境 — 统一导航(Scene-first)
   理念:隐藏 Prompt/Preset/Director-flow 等内部概念,
   用户只看到创作流:Scene → Character → Style → LoRA

   用法:导航位放空壳 <nav class="nav"><div class="nav-inner"><div class="nav-brand">…</div><div class="nav-links"></div></div></nav>
   每个页面 <body> 加 data-nav="当前项"(scene / director / showcase / gallery / character / style / lora / docs)
   路径层级自动推断(根目录 / tools/ / docs/ 自动回退 ../)
   ============================================================ */
(function () {
  'use strict';
  const currentScript = document.currentScript;
  if (!(currentScript instanceof HTMLScriptElement)) return;
  let studioRoot = new URL('../', currentScript.src).pathname;

  // 用户可见的导航项(创作流,概念已折叠)
  // Create = 全站最大入口,Director 为内部实现名,对用户隐身
  let PRIMARY_NAV = [
    { id:'scene',     label:'灵感',           href:'scene-explorer', icon:'🌸' },
    { id:'director',  label:'绘制',           href:'prompt-builder', icon:'✦' },
    { id:'chat',      label:'房间',           href:'chat',           icon:'☕' },
    { id:'showcase',  label:'参考画册',       href:'showcase',       icon:'🖼' },
    { id:'gallery',   label:'我的作品',       href:'gallery',        icon:'🎞' }
  ];
  let SECONDARY_NAV = [
    { id:'guide',      label:'新手教程',       href:'docs/getting-started.html',  icon:'🧭' },
    { id:'character', label:'角色档案',       href:'character',                 icon:'👤' },
    { id:'style',     label:'画风',           href:'style',                     icon:'🎨' },
    { id:'lora',      label:'模型',           href:'lora',                      icon:'🧪' },
    { id:'manager',   label:'场景管理',       href:'scene-manager',             icon:'🎬' },
    { id:'docs',      label:'手册',           href:'docs/index.html',           icon:'📖' }
  ];

  function depth(){ return studioRoot; }

  function brandLink(){ let d=depth(); return d + 'index.html'; }

  function loadLocalStatus(depthPrefix: string) {
    if (document.querySelector('script[data-local-status]')) return;
    let script = document.createElement('script');
    script.src = depthPrefix + 'tools/local-status.js?v=2';
    script.defer = true;
    script.dataset.localStatus = 'true';
    document.head.appendChild(script);
  }

  // .nav-logo 由文档导航统一注入，避免各页面重复内联尺寸。
  function ensureLogoStyle() {
    if (document.querySelector('style[data-nav-style]')) return;
    let style = document.createElement('style');
    style.dataset.navStyle = 'true';
    style.textContent = '.nav-logo{height:32px;width:auto}.nav-logo-light{display:none}[data-theme="light"] .nav-logo-dark{display:none}[data-theme="light"] .nav-logo-light{display:inline}';
    document.head.appendChild(style);
  }

  function render(){
    const host = document.querySelector('.nav-links');
    if (!host) return;
    ensureLogoStyle();
    let d = depth();
    let brand = document.querySelector<HTMLElement>('.nav-brand');
    if (brand) {
      brand.setAttribute('role', 'link');
      brand.tabIndex = 0;
      brand.innerHTML = '<img class="nav-logo nav-logo-dark" src="' + d + 'assets/logo.svg" alt="" aria-hidden="true"><img class="nav-logo nav-logo-light" src="' + d + 'assets/logo-light.svg" alt="" aria-hidden="true"><span class="sr-only">绘遇 HUIYU</span>';
      brand.onclick = function(){ window.location.href = brandLink(); };
      brand.onkeydown = function(e){ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.location.href = brandLink(); } };
    }
    let current = document.body.getAttribute('data-nav');
    document.title = document.title.replace(/AI[ -]CG Studio|绫季绘境/gi, '绘遇 HUIYU');
    document.querySelectorAll('.footer p').forEach(function(paragraph){
      if (/AI[ -]CG Studio/i.test(paragraph.textContent)) paragraph.textContent = paragraph.textContent.replace(/AI[ -]CG Studio/gi, '绫季绘境');
    });
    let primary = PRIMARY_NAV.map(function (item) {
      let cls = (item.id === current) ? ' class="active"' : '';
      return '<a' + cls + ' href="' + d + item.href + '">' + item.label + '</a>';
    }).join('');
    let secondaryActive = SECONDARY_NAV.some(function(item){ return item.id === current; });
    let secondary = SECONDARY_NAV.map(function(item) {
      let cls = (item.id === current) ? ' class="active"' : '';
      return '<a' + cls + ' href="' + d + item.href + '"><span>' + item.label + '</span></a>';
    }).join('');
    host.innerHTML = primary +
      '<details class="nav-more"' + (secondaryActive ? ' data-active="true"' : '') + '>' +
        '<summary aria-label="打开更多页面">更多<span class="nav-more-chevron">⌄</span></summary>' +
        '<div class="nav-more-menu">' + secondary + '</div>' +
      '</details>';
    loadLocalStatus(d);

    let inner = host.closest('.nav-inner');
    if (inner && !inner.querySelector('.nav-menu-toggle')) {
      let toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'nav-menu-toggle';
      toggle.setAttribute('aria-label', '打开导航菜单');
      toggle.setAttribute('aria-expanded', 'false');
      const menuIcon = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.5 Q12 6.2 19.5 6.5 M4.5 12 H19.5 M4.5 17.5 Q12 17.8 19.5 17.5"/></svg>';
      const closeIcon = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 6.5 Q12 12.2 17.5 17.5 M17.5 6.5 Q12 11.8 6.5 17.5"/></svg>';
      toggle.innerHTML = menuIcon;
      toggle.addEventListener('click', function(){
        let open = host.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
        toggle.innerHTML = open ? closeIcon : menuIcon;
      });
      inner.appendChild(toggle);
      host.addEventListener('click', function(e){
        if (!(e.target instanceof Element) || !e.target.closest('a')) return;
        host.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', '打开导航菜单');
        toggle.innerHTML = menuIcon;
      });
      document.addEventListener('click', function(e){
        let more = host.querySelector<HTMLDetailsElement>('.nav-more');
        if (more && more.open && e.target instanceof Node && !more.contains(e.target)) more.open = false;
      });
      document.addEventListener('keydown', function(e){
        const more = host.querySelector<HTMLDetailsElement>('.nav-more');
        if (e.key === 'Escape' && more?.open) {
          more.open = false;
          more.querySelector('summary')?.focus();
          return;
        }
        if (e.key === 'Escape' && host.classList.contains('open')) {
          host.classList.remove('open');
          toggle.setAttribute('aria-expanded', 'false');
          toggle.setAttribute('aria-label', '打开导航菜单');
          toggle.innerHTML = menuIcon;
          toggle.focus();
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
  (window as Window & { __navRender?: () => void }).__navRender = render;
})();
