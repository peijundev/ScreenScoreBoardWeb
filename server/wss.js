'use strict';
// WebSocket：连接管理、op 分发、合并广播、背压、心跳
const { WebSocketServer, WebSocket } = require('ws');
const { applyOp, save, OpError, publicState } = require('./state');
const runtime = require('./runtime');
const { config } = require('./config');
const { logger } = require('./logger');

const MAX_MSG = 64 * 1024;
let broadcastImpl = null;
let activeWss = null;

function attachWSS(server, opts = {}) {
  const log = opts.log || logger.child({ scope: 'wss' });
  const cfg = config.broadcast;

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_MSG,
    perMessageDeflate: cfg.permessageDeflate
      ? { threshold: cfg.deflateThreshold, zlibDeflateOptions: { level: 6 } }
      : false,
  });

  function stateMessage() {
    // 主题库/草稿可能很大，且显示端不需要；热状态广播只带项目与轻量引用
    return JSON.stringify({ type: 'state', data: publicState(), runtime: runtime.getRuntimeSnapshot() });
  }

  function safeSend(ws, payload) {
    try {
      ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    } catch (e) {
      log.warn('发送失败', { error: e.message });
    }
  }

  // ---- 合并广播：窗口内的多次变更只序列化/发送一次 ----
  let pending = false;
  let timer = null;
  let lastMessageBytes = 0;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    pending = false;
    if (wss.clients.size === 0) return;
    const msg = stateMessage();
    lastMessageBytes = msg.length;
    let sent = 0;
    let skipped = 0;
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // 背压：积压过多说明客户端消费不过来，跳过本次（下次全量会补齐）
      if (client.bufferedAmount > cfg.maxBufferedBytes) {
        skipped += 1;
        continue;
      }
      try {
        client.send(msg);
        sent += 1;
      } catch (e) {
        log.warn('广播发送失败', { error: e.message });
      }
    }
    if (skipped) log.warn('背压跳过客户端', { skipped, sent });
  }

  function broadcast() {
    if (cfg.coalesceMs <= 0) {
      pending = true;
      flush();
      return;
    }
    pending = true;
    if (timer) return;
    // 大状态（如 2000 人）一次布局成本高，自动放宽合并窗口，优先流畅度
    const windowMs = lastMessageBytes > cfg.largeBytes ? cfg.largeCoalesceMs : cfg.coalesceMs;
    timer = setTimeout(flush, windowMs);
    if (timer.unref) timer.unref();
  }

  broadcastImpl = broadcast;
  runtime.setBroadcaster(broadcast);

  wss.on('connection', (/** @type {any} */ ws, req) => {
    // Origin 校验：浏览器跨站 WS 默认拒绝；原生客户端（无 Origin）放行
    const origin = req.headers.origin;
    if (origin) {
      let allowed = false;
      try {
        const parsed = new URL(origin);
        allowed = parsed.host === req.headers.host ||
          cfg.allowedOrigins.includes(origin) ||
          cfg.allowedOrigins.includes(parsed.host);
      } catch (_) {}
      if (!allowed) {
        log.warn('Origin 被拒绝', { origin, host: req.headers.host });
        try { ws.close(1008, 'origin not allowed'); } catch (_) {}
        return;
      }
    }

    if (wss.clients.size > cfg.maxConnections) {
      log.warn('连接数超限，拒绝新连接', { max: cfg.maxConnections });
      try { ws.close(1013, 'too many connections'); } catch (_) {}
      return;
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', (e) => log.warn('客户端错误', { error: e.message }));

    // 连接即发全量状态 + 运行态
    safeSend(ws, stateMessage());

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return safeSend(ws, { type: 'ack', reqId: null, ok: false, error: '消息不是合法 JSON' });
      }
      if (!msg || msg.type !== 'op' || typeof msg.op !== 'string') {
        return safeSend(ws, {
          type: 'ack',
          reqId: (msg && msg.reqId) || null,
          ok: false,
          error: '消息格式非法',
        });
      }

      const started = process.hrtime.bigint();
      try {
        const result = applyOp(msg.op, msg.payload);
        save();
        broadcast();
        safeSend(ws, { type: 'ack', reqId: msg.reqId || null, ok: true, result });
      } catch (e) {
        const errText = e instanceof OpError ? e.message : '服务器内部错误';
        if (!(e instanceof OpError)) log.error('op 处理异常', { op: msg.op, error: e.message, stack: e.stack });
        safeSend(ws, { type: 'ack', reqId: msg.reqId || null, ok: false, error: errText });
      } finally {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        if (ms > config.slowOpMs) {
          log.warn('慢 op', { op: msg.op, ms: Math.round(ms * 100) / 100 });
        }
      }
    });
  });

  // 心跳：30s ping，无 pong 即终止
  const interval = setInterval(() => {
    for (const client of wss.clients) {
      const socket = /** @type {any} */ (client);
      if (!socket.isAlive) {
        try { socket.terminate(); } catch (_) {}
        continue;
      }
      socket.isAlive = false;
      try { socket.ping(); } catch (_) {}
    }
  }, 30000);
  if (interval.unref) interval.unref();

  wss.on('close', () => {
    clearInterval(interval);
    if (timer) clearTimeout(timer);
    timer = null;
  });
  wss.on('error', (e) => log.error('服务端错误', { error: e.message }));

  activeWss = wss;
  return wss;
}

function broadcastState() {
  if (broadcastImpl) broadcastImpl();
}

function clientCount() {
  return activeWss ? activeWss.clients.size : 0;
}

module.exports = { attachWSS, broadcastState, clientCount };
