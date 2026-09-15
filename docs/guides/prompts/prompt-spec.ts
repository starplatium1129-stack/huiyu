/* ============================================================
   Prompt 规范 · 实时拼接演示控制器
   外部普通脚本 + 事件委托 (CSP 就绪,与 tools/ 页面同一约定)
   ============================================================ */
'use strict';

var MODULES = [
  { id:'q',  on:true, cls:'q',  label:'Quality',     text:'masterpiece, best quality, very aesthetic, absurdres' },
  { id:'c',  on:true, cls:'c',  label:'Character',   text:'1girl, solo, ayachi_nene, nene_school_uniform, white_hair, very_long_hair, low_twintails, purple_eyes, ahoge, hair_ribbon, school_uniform, blazer, yellow_bowtie, plaid_skirt, pleated_skirt, grey_skirt, black_thighhighs' },
  { id:'s',  on:true, cls:'s',  label:'Story',       text:'after school, school gate, waiting' },
  { id:'e',  on:true, cls:'e',  label:'Emotion',     text:'gentle smile, soft eyes, blush, looking at viewer' },
  // cls 是 design-system.css .prompt-code 里的语义别名,不要自造新颜色类
  { id:'a',  on:true, cls:'t',  label:'Camera',      text:'medium shot, looking back, over shoulder' },
  { id:'o',  on:true, cls:'x',  label:'Composition', text:'rule of thirds, by window, depth' },
  { id:'l',  on:true, cls:'l',  label:'Lighting',    text:'golden hour, backlit, soft shadows, warm atmosphere' },
  { id:'x',  on:true, cls:'m-d', label:'Extra',      text:'hair blowing, depth of field, cinematic lighting' },
  { id:'lo', on:true, cls:'lo', label:'LoRA',        text:'<lora:ayachi_nene_v18_wd14:0.85>' }
];

function escapeHtml(value: unknown) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderToggles() {
  var host = document.getElementById('toggles');
  if (!host) return;
  host.innerHTML = MODULES.map(function (m) {
    return '<button type="button" class="toggle' + (m.on ? ' on' : '') +
      '" data-id="' + m.id + '" aria-pressed="' + (m.on ? 'true' : 'false') + '">' +
      escapeHtml(m.label) + '</button>';
  }).join('');
}

function renderOutput() {
  var out = document.getElementById('output');
  if (!out) return;
  out.innerHTML = MODULES
    .filter(function (m) { return m.on; })
    .map(function (m) { return '<span class="' + m.cls + '">' + escapeHtml(m.text) + '</span>'; })
    .join(',\n');
}

function syncToggle(m: typeof MODULES[number]) {
  var el = document.querySelector('.toggle[data-id="' + m.id + '"]');
  if (!el) return;
  el.classList.toggle('on', m.on);
  el.setAttribute('aria-pressed', m.on ? 'true' : 'false');
}

function toggleModule(id: string | null) {
  var m = MODULES.find(function (item) { return item.id === id; });
  if (!m) return;
  m.on = !m.on;
  syncToggle(m);
  renderOutput();
}

function resetModules() {
  MODULES.forEach(function (m) {
    m.on = true;
    syncToggle(m);
  });
  renderOutput();
}

document.addEventListener('click', function (event) {
  if (!(event.target instanceof Element)) return;
  var action = event.target.closest('[data-action]');
  if (action && action.getAttribute('data-action') === 'reset-modules') {
    resetModules();
    return;
  }
  var toggle = event.target.closest('.toggle[data-id]');
  if (toggle) toggleModule(toggle.getAttribute('data-id'));
});

function init() {
  renderToggles();
  renderOutput();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
