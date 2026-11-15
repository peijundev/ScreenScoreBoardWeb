'use strict';
// WebSocket：连接管理、op 分发、全量广播、心跳
const { WebSocketServer } = require('ws');
const { state, applyOp, save, OpError } = require('./state');
const runtime = require('./runtime');

const MAX_MSG = 64 * 1024;
let broadcastImpl = null;

function attachWSS(server) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG });

  function stateMessage() {
    return JSON.stringify({ type: 'state', data: state, runtime: runtime.getRuntimeSnapshot() });
  }

  function broadcast() {
    const msg = stateMessage();
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(msg);
    }
  }

  broadcastImpl = broadcast;
  runtime.setBroadcaster(broadcast);

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // 连接即发全量状态 + 运行态
    ws.send(stateMessage());

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) {
        return ws.send(JSON.stringify({ type: 'ack', reqId: null, ok: false, error: '消息不是合法 JSON' }));
      }
      if (!msg || msg.type !== 'op' || typeof msg.op !== 'string') {
        return ws.send(JSON.stringify({ type: 'ack', reqId: msg && msg.reqId || null, ok: false, error: '消息格式非法' }));
      }
      try {
        const result = applyOp(msg.op, msg.payload);
        save();
        broadcast();
        ws.send(JSON.stringify({ type: 'ack', reqId: msg.reqId || null, ok: true, result }));
      } catch (e) {
        const errText = e instanceof OpError ? e.message : '服务器内部错误';
        if (!(e instanceof OpError)) console.error('[wss] op 处理异常:', e);
        ws.send(JSON.stringify({ type: 'ack', reqId: msg.reqId || null, ok: false, error: errText }));
      }
    });
  });

  // 心跳：30s ping，无 pong 即终止
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  wss.on('close', () => clearInterval(interval));

  return wss;
}

function broadcastState() {
  if (broadcastImpl) broadcastImpl();
}

module.exports = { attachWSS, broadcastState };
