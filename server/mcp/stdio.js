'use strict';
// stdio MCP：作为 REST 客户端连接已运行的计分板服务，不启动第二实例
const readline = require('readline');
const { handleMessage } = require('./protocol');
const { callToolRemote, authHeaders } = require('./tools');

function baseUrl() {
  return process.env.SCOREBOARD_URL || 'http://127.0.0.1:3000';
}

async function getData(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...authHeaders() } });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { /* ignore */ }
  if (!res.ok) throw new Error(parsed && parsed.error ? parsed.error.message : `HTTP ${res.status}`);
  return parsed ? parsed.data : null;
}

async function readRemoteResource(uri) {
  const root = baseUrl().replace(/\/$/, '') + '/api/v1';
  if (uri === 'scoreboard://state') return getData(root + '/state');
  if (uri === 'scoreboard://health') return getData(root + '/health');
  const project = /^scoreboard:\/\/project\/([^/]+)$/.exec(uri);
  if (project) return getData(root + '/projects/' + encodeURIComponent(project[1]));
  const theme = /^scoreboard:\/\/theme\/([^/]+)$/.exec(uri);
  if (theme) return getData(root + '/themes/' + encodeURIComponent(theme[1]));
  const draft = /^scoreboard:\/\/theme-draft\/([^/]+)$/.exec(uri);
  if (draft) return getData(root + '/projects/' + encodeURIComponent(draft[1]) + '/theme-draft');
  throw new Error('未知资源: ' + uri);
}

function startStdio(io = { input: process.stdin, output: process.stdout }) {
  const rl = readline.createInterface({ input: io.input, terminal: false });
  process.stderr.write(`[screenscoreboard-mcp] 连接 ${baseUrl()}\n`);
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (_) {
      io.output.write(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32700, message: 'JSON 解析失败' },
      }) + '\n');
      return;
    }
    void handleMessage(message, {
      callTool: (name, args) => callToolRemote(baseUrl(), name, args),
      readResource: readRemoteResource,
    }).then((result) => {
      if (result) io.output.write(JSON.stringify(result) + '\n');
    }).catch((error) => {
      io.output.write(JSON.stringify({
        jsonrpc: '2.0',
        id: message && message.id != null ? message.id : null,
        error: { code: -32603, message: error.message || '内部错误' },
      }) + '\n');
    });
  });
  return rl;
}

module.exports = { startStdio, baseUrl, readRemoteResource };
