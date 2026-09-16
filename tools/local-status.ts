/* ============================================================
   绫季绘境 — 本机工坊状态
   所有页面只负责展示；服务探测与状态文案统一维护在这里。
   ============================================================ */
(function () {
  'use strict';
  const currentScript = document.currentScript;
  if (!(currentScript instanceof HTMLScriptElement)) return;
  let studioRoot = new URL('../', currentScript.src).pathname;

  let SERVICE_DEFS = [
    { id:'draw', label:'绘图', detail:'SD WebUI', icon:'◇' },
    { id:'chat', label:'对话', detail:'Ollama', icon:'◌' },
    { id:'voice', label:'语音', detail:'GPT-SoVITS', icon:'⌁' }
  ] as const;
  type ServiceId = typeof SERVICE_DEFS[number]['id'];
  let state = {
    gateway:false,
    services:{
      draw:{ online:false, label:'正在检测' },
      chat:{ online:false, label:'正在检测' },
      voice:{ online:false, label:'正在检测' }
    }
  };
  let refreshTimer = 0;

  function fetchJson(url: string, timeout?: number): Promise<unknown> {
    let controller = new AbortController();
    let timer = window.setTimeout(function () { controller.abort(); }, timeout || 2200);
    return fetch(url, { cache:'no-store', signal:controller.signal })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .finally(function () { window.clearTimeout(timer); });
  }

  function statusMarkup() {
    return SERVICE_DEFS.map(function (service) {
      let current = state.services[service.id];
      return '<div class="local-service" data-service="' + service.id + '" data-state="' + (current.online ? 'online' : 'sleep') + '">' +
        '<span class="local-service-icon" aria-hidden="true">' + service.icon + '</span>' +
        '<span><strong>' + service.label + '</strong><small>' + service.detail + '</small></span>' +
        '<em>' + current.label + '</em>' +
      '</div>';
    }).join('');
  }

  function render() {
    let host = document.querySelector('.local-status');
    if (!host) return;
    let panel = host.querySelector('.local-status-panel');
    if (panel) {
      let rows = panel.querySelector('.local-status-services');
      if (rows) rows.innerHTML = statusMarkup();
      let summary = panel.querySelector('.local-status-summary');
      let onlineCount = SERVICE_DEFS.filter(function (service) { return state.services[service.id].online; }).length;
      if (summary) {
        summary.textContent = state.gateway
          ? (onlineCount ? onlineCount + ' 项服务已就绪；其余会在需要时唤醒。' : '网关在线，生成服务目前都在休眠。')
          : '本机网关没有响应，请从控制台重新启动。';
      }
    }
    let trigger = host.querySelector<HTMLButtonElement>('.local-status-trigger');
    if (trigger) {
      let count = SERVICE_DEFS.filter(function (service) { return state.services[service.id].online; }).length;
      trigger.dataset.state = state.gateway ? (count ? 'online' : 'idle') : 'offline';
      const copy = trigger.querySelector('.local-status-copy');
      if (copy) copy.textContent = state.gateway ? '本机 ' + count + '/3' : '本机离线';
      trigger.title = state.gateway ? count + ' 项创作服务已就绪' : '本机网关未连接';
    }
  }

  function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  }

  function normalizeResult(result: PromiseSettledResult<unknown>, id: ServiceId) {
    if (result.status !== 'fulfilled') return { online:false, label:'未启动' };
    let data = record(result.value);
    if (id === 'draw') return { online:true, label:'可绘制' };
    if (id === 'chat') {
      return data.online && Array.isArray(data.models) && data.models.length
        ? { online:true, label:'已连接' }
        : { online:false, label:'未启动' };
    }
    return data.online
      ? { online:true, label:data.activeVoice ? '声线已热身' : '可配音' }
      : { online:false, label:'未启动' };
  }

  function refresh() {
    const host = document.querySelector('.local-status');
    if (!host) return Promise.resolve();
    host.classList.add('checking');
    return Promise.allSettled([
      fetchJson('/api/health', 1600),
      fetchJson('/sdapi/v1/options', 1800),
      fetchJson('/api/chat-status', 2200),
      fetchJson('/api/tts-status', 2200)
    ]).then(function (results) {
      state.gateway = results[0].status === 'fulfilled' && record(results[0].value).ok === true;
      state.services.draw = normalizeResult(results[1], 'draw');
      state.services.chat = normalizeResult(results[2], 'chat');
      state.services.voice = normalizeResult(results[3], 'voice');
      render();
    }).finally(function () {
      host.classList.remove('checking');
    });
  }

  function init() {
    let nav = document.querySelector('.nav-links');
    if (!nav || nav.querySelector('.local-status')) return;
    let d = studioRoot;
    let host = document.createElement('div');
    host.className = 'local-status';
    host.innerHTML =
      '<button class="local-status-trigger" type="button" aria-expanded="false" aria-controls="localStatusPanel">' +
        '<span class="local-status-led" aria-hidden="true"></span>' +
        '<span class="local-status-copy">本机检测</span>' +
      '</button>' +
      '<section class="local-status-panel" id="localStatusPanel" hidden aria-label="本机创作服务状态">' +
        '<div class="local-status-head"><span>LOCAL ATELIER</span><button type="button" class="local-status-refresh" aria-label="刷新本机服务状态" title="刷新">↻</button></div>' +
        '<p class="local-status-summary">正在确认本机创作服务…</p>' +
        '<div class="local-status-services">' + statusMarkup() + '</div>' +
        '<div class="local-status-actions">' +
          '<a href="' + d + 'prompt-builder">开始绘制</a>' +
          '<a href="' + d + 'control">打开控制台</a>' +
        '</div>' +
      '</section>';
    let more = nav.querySelector('.nav-more');
    if (more) more.insertAdjacentElement('afterend', host);
    else nav.appendChild(host);

    const trigger = host.querySelector<HTMLButtonElement>('.local-status-trigger');
    const panel = host.querySelector<HTMLElement>('.local-status-panel');
    if (!trigger || !panel) return;
    const close = () => {
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    };
    trigger.addEventListener('click', function () {
      let opening = panel.hidden;
      panel.hidden = !opening;
      trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if (opening) refresh();
    });
    host.querySelector('.local-status-refresh')?.addEventListener('click', refresh);
    document.addEventListener('click', function (event) {
      if (!panel.hidden && event.target instanceof Node && !host.contains(event.target)) close();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !panel.hidden) {
        close();
        trigger.focus();
      }
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh();
    });
    refresh();
    refreshTimer = window.setInterval(refresh, 60000);
    window.addEventListener('pagehide', function () { window.clearInterval(refreshTimer); }, { once:true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  (window as Window & { AICLocalStatus?: { refresh: () => Promise<void> } }).AICLocalStatus = { refresh:refresh };
})();
