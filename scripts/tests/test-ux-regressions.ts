'use strict';

/**
 * UX 审计修复的回归门禁（2026-08-30）
 *
 * 存在的理由：docs/archive/audits/ux-audit-2026-08-30.html 里 9 条 P0 有 6 条属于「写完没接上 /
 * 接反了」的单点缺陷——改一行就修好，也改一行就能退回。这类缺陷不会让任何类型
 * 检查或单测失败，只会在用户手里安静地复发。本文件把这些修复固化成断言，
 * 防的是「以后重构时顺手改回去」。
 *
 * 判定方式是源码级模式匹配（与审计取证同口径），不加载运行时。断言失败信息
 * 都写清了「为什么这条不能改」，便于正当重构时按意图更新断言，而不是照着
 * 报错瞎改代码。
 *
 * 用法: node scripts/tests/test-ux-regressions.js
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert') = require('node:assert');

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: any) {
  const owners: any = {
    'src/views/GalleryView.vue': ['src/composables/gallery/useGalleryWorkspace.ts', 'src/composables/gallery/galleryMutations.ts', 'src/composables/gallery/useGalleryFilters.ts'],
    'src/views/SceneExplorerView.vue': ['src/composables/scene/useSceneExplorerWorkspace.ts'],
  };
  return [relPath, ...(owners[relPath] || [])].map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
}

/**
 * 去掉注释后再匹配，避免把解释性文字里的示例代码算进去。
 *
 * 逐字符扫描而不是正则，是因为模板里常有 accept="image/星号" 这类属性：正则
 * 会把那个斜杠星号当成块注释起点，一路吞到下一个真正的注释结束标记，于是
 * 两者之间的整段模板都被删掉，依赖它的断言静默失效——DirectorStagePanel 就
 * 踩过这个坑（4 处 title 断言一度全部匹配不到）。引号内一律不参与注释识别。
 *
 * 注意：本文件的注释里不要连写斜杠星号或星号斜杠——那会提前闭合注释块，
 * 正是下面这个函数要处理的那类问题。
 */
function stripComments(source: any) {
  let out = ''
  let i = 0
  let quote = null // 当前所处的字符串引号
  let inLine = false
  let inBlock = false
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch }
      i += 1
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i += 2 }
      else {
        // 保留换行，避免把被注释掉的多行挤成一行（行号与上下文都会失真）
        if (ch === '\n') out += ch
        i += 1
      }
      continue
    }
    if (quote) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 2; continue }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === '\'' || ch === '`') { quote = ch; out += ch; i += 1; continue }
    if (ch === '/' && next === '/') { inLine = true; i += 2; continue }
    if (ch === '/' && next === '*') { inBlock = true; i += 2; continue }
    out += ch
    i += 1
  }
  return out
}

/**
 * 取出某个具名函数的函数体（大括号配对）。
 *
 * 这类断言必须落在具体函数里才算数：比如 `styleLoraId: ''` 在 applyModel 里
 * 是正确行为（用户真的换了底模，风格 LoRA 本来就该重置），全文件级匹配会把
 * 正常的写法也判成回潮。
 */
function extractFunction(source: any, name: any) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return '';
}

const CHECKS = [
  {
    id: 'P0-5 出图队列必须持久化',
    file: 'src/utils/storageKeys.ts',
    why: '队列只活在视图作用域时，切页或刷新就整组蒸发且没有任何解释。',
    assert(source: any) {
      return /SD_QUEUE_SNAPSHOT_KEY/.test(source);
    },
  },
  {
    id: 'P0-6 高清修复不得默认开启',
    file: 'data/presets.json',
    why: '默认开 hires_fix 又不在默认模式暴露开关，等于每次出图都悄悄多跑一个二阶段，'
      + '用户看不到开关、也无从知道为什么慢。',
    assert(source: any) {
      const parsed = JSON.parse(source);
      // 注意取值在 model_profiles 而非 presets：promptModelProfile.ts 的
      // set('hiresFix', profile.hires_fix) 读的是底模档，且 promptPolicy 对
      // 任何未匹配的 checkpoint 都会回落到 list[0]——这一档就是事实默认值。
      const profiles = Array.isArray(parsed.model_profiles)
        ? parsed.model_profiles
        : Object.values(parsed.model_profiles || {});
      if (!profiles.length) return false;
      // 任何底模档都不该默认开启二阶段：它把分钟级任务再拉长一截，而默认模式
      // 里连开关都看不见（开关外层 v-if 要求 expert 模式）。
      return !profiles.some((profile: any) => profile && profile.hires_fix === true);
    },
  },
  {
    id: 'P0-7 作品册必须在 KeepAlive 激活时刷新',
    file: 'src/views/GalleryView.vue',
    why: '保存成功却在作品册里看不到刚存的图，用户会判定「保存失败」并重复保存或重画。',
    assert(source: any) {
      const code = stripComments(source);
      return /onActivated\s*\(/.test(code);
    },
  },
  {
    id: 'P0-9 出图进度必须可空（不得兜成 0）',
    file: 'src/composables/generation/useSDGenerate.ts',
    why: '后端给不出进度时兜成 0 会被读成「卡在 0%」。可空才能让 UI 走 indeterminate，'
      + '同时守住「不做匀速假增量」这条诚实纪律。',
    assert(source: any) {
      const code = stripComments(source);
      return /ref<number\s*\|\s*null>\(null\)/.test(code);
    },
  },
  {
    id: 'P1 桌宠容器高度下限不得超出视口',
    file: 'src/assets/css/companion.css',
    why: '死值 min-height 在宽扁窗（如 700x500）里超过视口高度，而两层 overflow:hidden '
      + '会把底部对话条永久裁掉，既不能输入也关不掉窗。',
    assert(source: any) {
      return /min-height:\s*min\(\s*560px\s*,\s*100dvh\s*\)/.test(source);
    },
  },
  {
    id: 'P2 反推必须支持粘贴图片',
    file: 'src/components/director/DirectorStagePanel.vue',
    why: '本地反推此前只能走文件选择器，而真要用的那一刻，图往往已经在剪贴板里'
      + '（刚截的图、从参考站复制的），多一趟「打开对话框找文件」纯属多余。'
      + '监听器要挂在可聚焦的元素上——浏览器只把 paste 派发给焦点元素。',
    assert(source: any) {
      const code = stripComments(source);
      return /@paste="onInterrogatePaste"/.test(code) && /function onInterrogatePaste/.test(code);
    },
  },
  {
    id: 'P2 响应式断点不得出现档外值',
    file: 'src/assets/css/design-system.css',
    why: '断点档位是 480 / 600 / 768 / 900 / 1000 / 1200 / 1380 / 2560（见本文件 '
      + '--bp-*）。440 / 700 / 760 这类档外值会让界面在相邻两档之外自己再跳一次，'
      + '出问题的时候极难定位是哪条规则生效。'
      + '注意别误伤：max-width:760px 作为布局宽度或 img sizes 是正常用法，'
      + '只有跟在 @media / matchMedia 后面的才是断点。',
    assert() {
      const offenders: any = [];
      const walk = (dir: any) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') walk(path.join(dir, entry.name));
            continue;
          }
          if (!/\.(css|vue)$/.test(entry.name)) continue;
          const file = path.join(dir, entry.name);
          const code = stripComments(fs.readFileSync(file, 'utf8'));
          const hit = code.match(/(?:@media|matchMedia\()[^{]*?(?:max|min)-width:\s*(440|700|760)px/);
          if (hit) offenders.push(`${path.relative(ROOT, file)} → ${hit[0].trim()}`);
        }
      };
      walk(path.join(ROOT, 'src'));
      if (offenders.length) {
        console.log('      档外断点：' + offenders.join(' | '));
        return false;
      }
      return true;
    },
  },
  {
    id: 'P1 Live2D 路由也必须预热',
    file: 'src/router/index.ts',
    why: '进出 Live2D 页要整页刷新（CSP 需要 unsafe-eval），刷新后浏览器得重新取'
      + '一遍 chunk。预热过的会命中 HTTP 缓存，这是「/chat 是全程最慢一步」里'
      + '最容易修的一半——以 LIVE2D_PATHS 为由跳过预热，等于把最需要预热的那条路'
      + '恰好排除掉。（整页刷新本身是 CSP 设计的必然代价，不要为了快而删掉它。）',
    assert(source: any) {
      const code = stripComments(source);
      return !/if\s*\(\s*LIVE2D_PATHS\.has\(path\)\s*\)\s*return/.test(code);
    },
  },
  {
    id: 'P1 作品册筛选状态必须进 URL（且只在挂载时恢复）',
    file: 'src/views/GalleryView.vue',
    why: '刷新页面或存成书签后筛选条件归零，等于白筛一次。但恢复只应在挂载时做：'
      + '本页被 KeepAlive 缓存，从 Remix 回来时 URL 是干净的 /gallery，在 '
      + 'onActivated 里照着它恢复反而会清掉用户当前的筛选，比不做更糟。'
      + '写回必须走 replace（不污染后退栈）。',
    assert(source: any) {
      const code = stripComments(source);
      const sync = stripComments(extractFunction(source, 'syncFiltersToQuery'));
      if (!sync) return false;
      const calls = code.match(/restoreFiltersFromQuery\(\)/g) || [];
      return /router\.replace/.test(sync) && /setTimeout/.test(sync) && calls.length >= 1;
    },
  },
  {
    id: 'P1 CFG / Steps 必须可精确输入',
    file: 'src/components/GenerationParamsPanel.vue',
    why: '原先 CFG 只有 8 档、Steps 只有 6 档下拉，想跑 CFG 6.5 做 A/B 对比做不到；'
      + '而同项目的 AnimaQuickPanel 早就是 number + min/max/step，两条出图路体验割裂。'
      + '改成 select 会立刻退回「只能挑预设值」。',
    assert(source: any) {
      const code = stripComments(source);
      const cfg = code.match(/<(input|select)\b[^>]*params\.cfg[^>]*>/);
      const steps = code.match(/<(input|select)\b[^>]*params\.steps[^>]*>/);
      if (!cfg || !steps) return false;
      const isNumberInput = (tag: any) => tag[1] === 'input' && /type="number"/.test(tag[0]);
      // 自由输入带来了「被清空 / 填 999」的可能，必须有夹取与回退
      return isNumberInput(cfg) && isNumberInput(steps) && /function normalize\(/.test(code);
    },
  },
  {
    id: 'P1 Anima 表单控件必须有关联标签',
    file: 'src/components/AnimaQuickPanel.vue',
    why: 'Steps / CFG / 尺寸此前只是裸 <span>，读屏播报「编辑框 数字」，听不出这一格'
      + '是什么。必须用 label[for] 关联控件 id；id 还要用 useId 生成——硬编码 id 在'
      + '面板多实例时会重复，反而让标签指向错的控件。',
    assert(source: any) {
      const code = stripComments(source);
      return /useId/.test(code) && /:for="idOf\(/.test(code) && /:id="idOf\(/.test(code);
    },
  },
  {
    id: 'P1 页面中文名不得一名多词',
    file: 'src/components/AppNav.vue',
    why: '同一页面曾同时叫导航「色调脚本」、h1「色彩情绪」、hero「色彩剧本」——'
      + '按其中任何一个名字在全局搜索里都可能搜不到它。导航、页面标题必须同一个名字。',
    assert(source: any) {
      const nav = stripComments(source).match(/id:\s*'color-script',\s*label:\s*'([^']+)'/);
      if (!nav) return false;
      const page = stripComments(read('src/views/ColorScriptView.vue'))
        .match(/<h1[^>]*>\s*([^<]+?)\s*<\/h1>/);
      if (!page) return false;
      return nav[1] === page[1];
    },
  },
  {
    id: 'P1 首次引导必须覆盖本机用户',
    file: 'src/components/GuestGuide.vue',
    why: '展示条件原为 (isNonLocal || forcedGuest)，而本项目单人本机部署，'
      + 'isNonLocal 恒为假——主人自己永远看不到引导，docs/ 在应用内也没有入口。',
    assert(source: any) {
      const code = stripComments(source);
      // 不得再拿「非本机」当作展示前提
      return !/isNonLocal/.test(code);
    },
  },
  {
    id: 'P1 出图按钮必须有提交前可见校验',
    file: 'src/components/director/GenerationActionBar.vue',
    why: '原先唯一的校验发生在点击之后，用户只有 2.5 秒读一句「请先选择场景或填写故事」。'
      + '条件不满足时必须禁用按钮、并把原因常驻在按钮旁——只禁用不说明，用户会以为软件坏了。',
    assert(source: any) {
      const code = stripComments(source);
      return /blockedReason/.test(code) && /:disabled="[^"]*blockedReason/.test(code);
    },
  },
  {
    id: 'P1 首页场景卡不得静默启动生成',
    file: 'src/views/HomeView.vue',
    why: '点场景卡的意图是「用这个场景开始」，不是「立刻出图」。带上 &generate=1 '
      + '会在落地瞬间启动一次分钟级任务，既没预览也没确认，用户只能干等或者'
      + '手忙脚乱地取消。只有「调整后生成 / 画这个场景」这类写明动作的按钮才该带它。',
    assert(source: any) {
      // 先剥 HTML 注释：注释里会复述这个参数名，不剥会把解释文字误判成代码
      const code = stripComments(source).replace(/<!--[\s\S]*?-->/g, '');
      return !/prompt-builder\?[^`'"\s]*generate=1/.test(code);
    },
  },
  {
    id: 'P1 全局搜索必须有可见入口',
    file: 'src/components/AppNav.vue',
    why: '搜索覆盖 15 个页面 + 场景 + 作品，是本项目最强的捷径，但只有 '
      + 'Ctrl/Cmd+K 与 `/` 两个键盘入口时，纯鼠标流用户永远发现不了它。'
      + '导航里必须有一个点得着的按钮。',
    assert(source: any) {
      const code = stripComments(source);
      return /openGlobalSearch/.test(code) && /nav-search/.test(code);
    },
  },
];

test('UX 审计修复不回潮', () => {
  const failures = [];
  const missing = [];

  for (const check of CHECKS) {
    let source;
    try {
      source = read(check.file);
    } catch (e) {
      missing.push(`${check.id} — 找不到文件 ${check.file}`);
      continue;
    }
    let ok = false;
    try {
      ok = check.assert(source);
    } catch (e) {
      ok = false;
    }
    if (!ok) failures.push(`${check.id}\n      文件 ${check.file}\n      原因 ${check.why}`);
  }

  console.log(`  UX 回归断言 ${CHECKS.length} 条，失败 ${failures.length} 条，缺文件 ${missing.length} 条`);
  for (const line of missing) console.log('    MISSING ' + line);
  for (const line of failures) console.log('    FAIL ' + line);

  assert.deepEqual(missing, [], '断言引用的文件不存在（路径可能已重构）');
  assert.deepEqual(failures, [], 'UX 审计的修复被改回去了');
});
