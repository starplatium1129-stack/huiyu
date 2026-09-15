/* ============================================================
   标签规范 · 标签词典控制器
   外部普通脚本 + 事件委托 (CSP 就绪,与 tools/ 页面同一约定)
   ============================================================ */
'use strict';

var TAGS = [
  // === 动作 ===
  { cat:'动作', cn:'站立', en:'standing', note:'默认姿态' },
  { cat:'动作', cn:'走路', en:'walking', note:'唯一标准' },
  { cat:'动作', cn:'跑步', en:'running', note:'' },
  { cat:'动作', cn:'坐姿', en:'sitting', note:'' },
  { cat:'动作', cn:'跪姿', en:'kneeling', note:'' },
  { cat:'动作', cn:'趴着', en:'lying on stomach', note:'' },
  { cat:'动作', cn:'躺着', en:'lying on back', note:'' },
  { cat:'动作', cn:'蹲下', en:'squatting', note:'' },
  { cat:'动作', cn:'靠着', en:'leaning against', note:'墙/栏杆/树' },
  { cat:'动作', cn:'牵手', en:'holding hands', note:'' },
  { cat:'动作', cn:'拥抱', en:'hugging', note:'' },
  { cat:'动作', cn:'回头', en:'looking back, over shoulder', note:'' },

  // === 情绪 ===
  { cat:'情绪', cn:'开心', en:'happy, bright smile, joyful expression', note:'不写 smile' },
  { cat:'情绪', cn:'害羞', en:'shy, blushing, looking away', note:'' },
  { cat:'情绪', cn:'恋爱', en:'in love, gentle smile, soft eyes, blush', note:'' },
  { cat:'情绪', cn:'期待', en:'expectant, hopeful, bright eyes', note:'' },
  { cat:'情绪', cn:'放松', en:'relaxed, gentle expression, calm', note:'' },
  { cat:'情绪', cn:'想念', en:'missing, longing look, distant gaze', note:'' },
  { cat:'情绪', cn:'委屈', en:'teary eyes, pout, vulnerable', note:'' },
  { cat:'情绪', cn:'撒娇', en:'pouting, playful, acting cute', note:'' },
  { cat:'情绪', cn:'认真', en:'serious, determined, focused', note:'' },
  { cat:'情绪', cn:'困倦', en:'sleepy, half-closed eyes, drowsy', note:'' },
  { cat:'情绪', cn:'惊讶', en:'surprised, wide eyes, shocked', note:'' },
  { cat:'情绪', cn:'平静', en:'calm, peaceful, serene', note:'' },

  // === 镜头 ===
  { cat:'镜头', cn:'近景', en:'close-up, upper face', note:'胸部以上' },
  { cat:'镜头', cn:'中景', en:'medium shot, waist up', note:'腰以上' },
  { cat:'镜头', cn:'远景', en:'wide shot, full body', note:'全身' },
  { cat:'镜头', cn:'特写', en:'close-up detail', note:'手部/眼睛细节' },
  { cat:'镜头', cn:'POV', en:'pov, first person view', note:'玩家视角' },
  { cat:'镜头', cn:'仰视', en:'low angle, looking up', note:'从下往上' },
  { cat:'镜头', cn:'俯视', en:'high angle, looking down', note:'从上往下' },
  { cat:'镜头', cn:'侧面', en:'side view, profile', note:'' },
  { cat:'镜头', cn:'回头', en:'looking back, over shoulder', note:'' },
  { cat:'镜头', cn:'自拍', en:'selfie, phone camera', note:'' },

  // === 构图 ===
  { cat:'构图', cn:'居中', en:'centered composition, symmetric', note:'' },
  { cat:'构图', cn:'三分法', en:'rule of thirds, off-center', note:'' },
  { cat:'构图', cn:'左构图', en:'left composition', note:'人物偏左' },
  { cat:'构图', cn:'右构图', en:'right composition', note:'人物偏右' },
  { cat:'构图', cn:'前景遮挡', en:'foreground framing, depth', note:'' },
  { cat:'构图', cn:'框架构图', en:'framed composition', note:'窗/门框' },
  { cat:'构图', cn:'窗边构图', en:'by window, against window', note:'' },

  // === 光照 ===
  { cat:'光照', cn:'夕阳', en:'golden hour, warm light, sunset glow', note:'放学/黄昏' },
  { cat:'光照', cn:'窗光', en:'window light, soft, diffused', note:'室内/安静' },
  { cat:'光照', cn:'逆光', en:'backlit, rim light, silhouette edge', note:'神秘/回忆' },
  { cat:'光照', cn:'月光', en:'moonlight, cool tones', note:'夜晚/孤独' },
  { cat:'光照', cn:'夜灯', en:'lantern light, warm glow', note:'夜晚温馨' },
  { cat:'光照', cn:'阴天柔光', en:'overcast, soft diffused light', note:'文艺/清新' },
  { cat:'光照', cn:'霓虹灯', en:'city night, colored lights', note:'现代/夜 (禁止 neon/neon lights)' },
  { cat:'光照', cn:'烛光', en:'candlelight, warm flickering', note:'温暖/浪漫' }
];

var ALL = '全部';
var activeCat = ALL;
var searchTerm = '';

function escapeHtml(value: unknown) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderTabs() {
  var host = document.getElementById('catTabs');
  if (!host) return;
  var cats = [ALL];
  TAGS.forEach(function (t) { if (cats.indexOf(t.cat) === -1) cats.push(t.cat); });
  host.innerHTML = cats.map(function (c) {
    return '<button type="button" class="cat-tab' + (c === activeCat ? ' active' : '') +
      '" data-cat="' + escapeHtml(c) + '" aria-pressed="' + (c === activeCat ? 'true' : 'false') + '">' +
      escapeHtml(c) + '</button>';
  }).join('');
}

function matches(tag: typeof TAGS[number]) {
  if (activeCat !== ALL && tag.cat !== activeCat) return false;
  if (!searchTerm) return true;
  return tag.cn.toLowerCase().indexOf(searchTerm) > -1
    || tag.en.toLowerCase().indexOf(searchTerm) > -1
    || tag.note.toLowerCase().indexOf(searchTerm) > -1;
}

function render() {
  var list = document.getElementById('tagList');
  var empty = document.getElementById('emptyResult');
  if (!list || !empty) return;

  var filtered = TAGS.filter(matches);
  if (filtered.length === 0) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.innerHTML = filtered.map(function (t) {
    return '<div class="tag-row">' +
      '<div class="tag-cn">' + escapeHtml(t.cn) + '</div>' +
      '<div class="tag-en">' + escapeHtml(t.en) + '</div>' +
      '<div class="tag-note">' + escapeHtml(t.note) + '</div>' +
      '</div>';
  }).join('');
}

function setCat(cat: string) {
  activeCat = cat;
  document.querySelectorAll('.cat-tab').forEach(function (tab) {
    var on = tab.getAttribute('data-cat') === cat;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  render();
}

document.addEventListener('click', function (event) {
  if (!(event.target instanceof Element)) return;
  var tab = event.target.closest('.cat-tab[data-cat]');
  const cat = tab?.getAttribute('data-cat');
  if (cat !== null && cat !== undefined) setCat(cat);
});

document.addEventListener('input', function (event) {
  if (!(event.target instanceof HTMLInputElement) || event.target.id !== 'search') return;
  searchTerm = event.target.value.trim().toLowerCase();
  render();
});

function init() {
  renderTabs();
  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
