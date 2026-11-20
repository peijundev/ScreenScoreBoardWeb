// WS 客户端：指数退避重连 + 全量状态回调 + op 请求 Promise 化
// 移植自 public/shared.js 的 connectWS
import type { RuntimeSnapshot, Snapshot } from './types';
import type { OpName } from './ops.generated';

export type ConnStatus = 'connecting' | 'connected';

export type SendOp = (op: OpName, payload?: Record<string, unknown>) => Promise<unknown>;

export interface Connection {
  sendOp: SendOp;
  close: () => void;
}

export interface ConnectOptions {
  /** 4401 会话失效 / 4403 权限变化时回调；调用后不再自动重连 */
  onAuthLost?: (reason: 'expired' | 'forbidden') => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface StateMessage {
  type: 'state';
  data: Snapshot;
  runtime?: RuntimeSnapshot | null;
}

interface AckMessage {
  type: 'ack';
  reqId: string | null;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function connectWS(
  onState: (snapshot: Snapshot, runtime: RuntimeSnapshot | null) => void,
  onStatus?: (status: ConnStatus) => void,
  options: ConnectOptions = {},
): Connection {
  let delay = 1000;
  let ws: WebSocket | null = null;
  let reqSeq = 0;
  let closedByUser = false;
  const pending = new Map<string, Pending>();

  function connect(): void {
    if (closedByUser) return;
    onStatus?.('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');

    ws.onopen = () => {
      delay = 1000;
      onStatus?.('connected');
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let msg: StateMessage | AckMessage;
      try {
        msg = JSON.parse(ev.data) as StateMessage | AckMessage;
      } catch {
        return;
      }
      if (msg.type === 'state') {
        onState(msg.data, msg.runtime ?? null);
        return;
      }
      if (msg.type === 'ack' && msg.reqId != null) {
        const p = pending.get(msg.reqId);
        if (!p) return;
        pending.delete(msg.reqId);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || '操作失败'));
      }
    };
    ws.onclose = (ev: CloseEvent) => {
      for (const p of pending.values()) p.reject(new Error('连接已断开'));
      pending.clear();
      if (closedByUser) return;
      if (ev.code === 4401 || ev.code === 4403) {
        closedByUser = true;
        options.onAuthLost?.(ev.code === 4401 ? 'expired' : 'forbidden');
        return;
      }
      onStatus?.('connecting');
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15000);
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }

  function sendOp(op: OpName, payload?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('未连接到服务器'));
        return;
      }
      const reqId = 'r' + ++reqSeq + '_' + Math.random().toString(36).slice(2, 8);
      pending.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({ type: 'op', reqId, op, payload: payload ?? {} }));
    });
  }

  connect();

  return {
    sendOp,
    close: () => {
      closedByUser = true;
      ws?.close();
    },
  };
}
