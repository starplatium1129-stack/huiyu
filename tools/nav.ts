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
  var studioRoot = new URL('../', currentScript.src).pathname;

  // 用户可见的导航项(创作流,概念已折叠)
  // Create = 全站最大入口,Director 为内部实现名,对用户隐身
  var PRIMARY_NAV = [
    { id:'scene',     label:'灵感',           href:'scene-explorer', icon:'🌸' },
    { id:'director',  label:'绘制',           href:'prompt-builder', icon:'✦' },
    { id:'chat',      label:'房间',           href:'chat',           icon:'☕' },
    { id:'showcase',  label:'参考画册',       href:'showcase',       icon:'🖼' },
    { id:'gallery',   label:'我的作品',       href:'gallery',        icon:'🎞' }
  ];
  var SECONDARY_NAV = [
    { id:'guide',      label:'新手教程',       href:'docs/getting-started.html',  icon:'🧭' },
    { id:'character', label:'角色档案',       href:'character',                 icon:'👤' },
    { id:'style',     label:'画风',           href:'style',                     icon:'🎨' },
    { id:'lora',      label:'模型',           href:'lora',                      icon:'🧪' },
    { id:'manager',   label:'场景管理',       href:'scene-manager',             icon:'🎬' },
    { id:'docs',      label:'手册',           href:'docs/index.html',           icon:'📖' }
  ];

  function depth(){ return studioRoot; }

  function brandLink(){ var d=depth(); return d + 'index.html'; }

  function loadLocalStatus(depthPrefix: string) {
    if (document.querySelector('script[data-local-status]')) return;
    var script = document.createElement('script');
    script.src = depthPrefix + 'tools/local-status.js?v=2';
    script.defer = true;
    script.dataset.localStatus = 'true';
    document.head.appendChild(script);
  }

  // .nav-logo 由文档导航统一注入，避免各页面重复内联尺寸。
  function ensureLogoStyle() {
    if (document.querySelector('style[data-nav-style]')) return;
    var style = document.createElement('style');
    style.dataset.navStyle = 'true';
    style.textContent = '.nav-logo{height:32px;width:auto}.nav-logo-light{display:none}[data-theme="light"] .nav-logo-dark{display:none}[data-theme="light"] .nav-logo-light{display:inline}';
    document.head.appendChild(style);
  }

  function render(){
    const host = document.querySelector('.nav-links');
    if (!host) return;
    ensureLogoStyle();
    var d = depth();
    var brand = document.querySelector<HTMLElement>('.nav-brand');
    if (brand) {
      brand.setAttribute('role', 'link');
      brand.tabIndex = 0;
      brand.innerHTML = '<img class="nav-logo nav-logo-dark" src="' + d + 'assets/logo.svg" alt="" aria-hidden="true"><img class="nav-logo nav-logo-light" src="' + d + 'assets/logo-light.svg" alt="" aria-hidden="true"><span class="sr-only">绘遇 HUIYU</span>';
      brand.onclick = function(){ window.location.href = brandLink(); };
      brand.onkeydown = function(e){ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.location.href = brandLink(); } };
    }
    var current = document.body.getAttribute('data-nav');
    document.title = document.title.replace(/AI[ -]CG Studio/gi, '绫季绘境');
    document.querySelectorAll('.footer p').forEach(function(paragraph){
      if (/AI[ -]CG Studio/i.test(paragraph.textContent)) paragraph.textContent = paragraph.textContent.replace(/AI[ -]CG Studio/gi, '绫季绘境');
    });
    var primary = PRIMARY_NAV.map(function (item) {
      var cls = (item.id === current) ? ' class="active"' : '';
      return '<a' + cls + ' href="' + d + item.href + '">' + item.icon + ' ' + item.label + '</a>';
    }).join('');
    var secondaryActive = SECONDARY_NAV.some(function(item){ return item.id === current; });
    var secondary = SECONDARY_NAV.map(function(item) {
      var cls = (item.id === current) ? ' class="active"' : '';
      return '<a' + cls + ' href="' + d + item.href + '">' + item.icon + '<span>' + item.label + '</span></a>';
    }).join('');
    host.innerHTML = primary +
      '<details class="nav-more"' + (secondaryActive ? ' data-active="true"' : '') + '>' +
        '<summary aria-label="打开更多页面">更多<span class="nav-more-chevron">⌄</span></summary>' +
        '<div class="nav-more-menu">' + secondary + '</div>' +
      '</details>';
    loadLocalStatus(d);

    var inner = host.closest('.nav-inner');
    if (inner && !inner.querySelector('.nav-menu-toggle')) {
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'nav-menu-toggle';
      toggle.setAttribute('aria-label', '打开导航菜单');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = '☰';
      toggle.addEventListener('click', function(){
        var open = host.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
        toggle.textContent = open ? '✕' : '☰';
      });
      inner.appendChild(toggle);
      host.addEventListener('click', function(e){
        if (!(e.target instanceof Element) || !e.target.closest('a')) return;
        host.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = '☰';
      });
      document.addEventListener('click', function(e){
        var more = host.querySelector<HTMLDetailsElement>('.nav-more');
        if (more && more.open && e.target instanceof Node && !more.contains(e.target)) more.open = false;
      });
      document.addEventListener('keydown', function(e){
        if (e.key === 'Escape' && host.classList.contains('open')) {
          host.classList.remove('open');
          toggle.setAttribute('aria-expanded', 'false');
          toggle.setAttribute('aria-label', '打开导航菜单');
          toggle.textContent = '☰';
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
  window.__navRender = render;
})();

interface Window { __navRender?: () => void }
