/**
 * 主题脚本沙箱的静态源码。
 *
 * 这里刻意不依赖 React/DOM 类型，便于单元测试直接加载并验证 Worker 执行路径。
 * 用户源码永远只通过 postMessage 进入 Worker，不进入 iframe 的 window 上下文。
 */
export const SANDBOX_WORKER_CODE = `
(function () {
  'use strict';
  var post = self.postMessage.bind(self);
  try {
    self.Worker = undefined;
    self.importScripts = undefined;
    self.fetch = undefined;
    self.XMLHttpRequest = undefined;
    self.WebSocket = undefined;
    self.EventSource = undefined;
    self.indexedDB = undefined;
    self.caches = undefined;
    self.BroadcastChannel = undefined;
  } catch (_) {}
  self.onmessage = function (e) {
    var d = e.data || {};
    if (!d || d.type !== 'run') return;
    try {
      var fn = new Function('ctx', d.source + '\\n;return typeof ' + d.entry + ' === "function" ? ' + d.entry + '(ctx) : null;');
      post({ type: 'result', id: d.id, ok: true, commands: fn(d.ctx) });
    } catch (err) {
      post({
        type: 'result', id: d.id, ok: false,
        error: String((err && err.message) || err).slice(0, 400),
      });
    }
  };
})();
`;

export const SANDBOX_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; form-action 'none'; base-uri 'none'">
</head><body><script>
(function () {
  'use strict';
  var WORKER_CODE = ${JSON.stringify(SANDBOX_WORKER_CODE)};
  var worker = null;
  var current = null;
  var pending = null;
  var timer = 0;

  function send(message) { parent.postMessage(message, '*'); }

  function destroy() {
    if (timer) { clearTimeout(timer); timer = 0; }
    current = null;
    pending = null;
    if (worker) { worker.terminate(); worker = null; }
  }

  function fail(id, timeout, error) {
    destroy();
    send({
      type: 'theme-script-result', id: String(id), ok: false,
      timeout: Boolean(timeout), error: String(error || '').slice(0, 400),
    });
  }

  function ensureWorker() {
    if (worker) return worker;
    var url = URL.createObjectURL(new Blob([WORKER_CODE], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = function (event) {
      var d = event.data || {};
      if (!current || String(d.id) !== current.id) return;
      var id = current.id;
      current = null;
      if (timer) { clearTimeout(timer); timer = 0; }
      if (!d.ok) {
        send({ type: 'theme-script-result', id: id, ok: false, error: String(d.error || '脚本执行失败').slice(0, 400) });
      } else if (!Array.isArray(d.commands) || d.commands.length > 200) {
        send({ type: 'theme-script-result', id: id, ok: false, error: '指令数量超出上限' });
      } else {
        var encoded;
        try { encoded = JSON.stringify(d.commands); } catch (_) { encoded = null; }
        if (!encoded || encoded.length > 131072) {
          send({ type: 'theme-script-result', id: id, ok: false, error: '指令输出过大' });
        } else {
          send({ type: 'theme-script-result', id: id, ok: true, commands: d.commands });
        }
      }
      if (pending) {
        var next = pending;
        pending = null;
        begin(next);
      }
    };
    worker.onerror = function () {
      if (current) fail(current.id, false, '沙箱 Worker 异常');
    };
    return worker;
  }

  function begin(run) {
    if (!run || typeof run.source !== 'string' || typeof run.id !== 'string') return;
    if (current) { pending = run; return; }
    var entry = typeof run.entry === 'string' ? run.entry : 'drawTheme';
    if (!/^[A-Za-z_$][\\w$]{0,63}$/.test(entry)) entry = 'drawTheme';
    if (!run.source.trim()) {
      send({ type: 'theme-script-result', id: String(run.id), ok: false, error: '脚本为空' });
      return;
    }
    var timeout = Number(run.timeoutMs);
    timeout = Number.isFinite(timeout) ? Math.max(20, Math.min(500, timeout)) : 120;
    try {
      current = { id: String(run.id) };
      ensureWorker().postMessage({
        type: 'run', id: current.id, source: run.source, entry: entry, ctx: run.ctx,
      });
      timer = setTimeout(function () {
        if (current) fail(current.id, true, '脚本执行超时');
      }, timeout);
    } catch (_) {
      fail(run.id, false, '沙箱启动失败');
    }
  }

  self.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data || {};
    if (data.type === 'theme-script-run') begin(data);
  });
  self.addEventListener('unload', destroy);
})();
</script></body></html>`;
