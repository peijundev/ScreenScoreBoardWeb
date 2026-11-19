import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// Node 24 原生类型剥离：直接加载真实源码，避免复制一份会腐烂的常量。
const { SANDBOX_HTML, SANDBOX_WORKER_CODE } = await import(
  '../web/src/display/theme/sandbox-source.ts'
);
const { safeScriptEntry, sanitizeThemeScriptCommands } = await import(
  '../web/src/display/theme/script.ts'
);

function runWorker(data) {
  const messages = [];
  const self = { postMessage: (message) => messages.push(message) };
  const context = vm.createContext({ self, console });
  vm.runInContext(SANDBOX_WORKER_CODE, context);
  self.onmessage({ data });
  return messages;
}

test('Worker 能执行 drawTheme 并返回指令', () => {
  const messages = runWorker({
    type: 'run',
    id: 'r1',
    entry: 'drawTheme',
    ctx: { people: [{ name: '甲' }] },
    source: 'function drawTheme(ctx) { return [{ op: "rect", x: 1, y: 2, w: 3, h: 4, fill: "#ffffff" }, { op: "text", x: 0, y: 0, text: ctx.people[0].name }]; }',
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ok, true);
  assert.equal(messages[0].id, 'r1');
  assert.equal(messages[0].commands.length, 2);
  assert.equal(messages[0].commands[0].op, 'rect');
  assert.equal(messages[0].commands[1].text, '甲');
});

test('Worker 捕获语法错误并返回失败结果', () => {
  const messages = runWorker({
    type: 'run',
    id: 'r2',
    entry: 'drawTheme',
    ctx: {},
    source: 'function drawTheme(ctx) {',
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ok, false);
  assert.match(messages[0].error, /Unexpected|unexpected|Invalid|invalid/);
});

test('沙箱 HTML 关闭网络并允许 blob Worker', () => {
  assert.match(SANDBOX_HTML, /default-src 'none'/);
  assert.match(SANDBOX_HTML, /connect-src 'none'/);
  assert.match(SANDBOX_HTML, /worker-src blob:/);
  assert.match(SANDBOX_HTML, /form-action 'none'/);
  assert.match(SANDBOX_HTML, /base-uri 'none'/);
});

test('绘制指令白名单会丢弃未知 op、非法颜色与路径', () => {
  const commands = sanitizeThemeScriptCommands([
    { op: 'rect', x: 1, y: 2, w: 3, h: 4, fill: 'url(javascript:alert(1))' },
    { op: 'circle', x: 1, y: 1 },
    { op: 'path', d: 'M0 0 javascript:alert(1)', fill: '#ffffff' },
    { op: 'text', x: 0, y: 0, text: '<img src=x onerror=alert(1)>', size: 1e9, color: '#ffffff' },
  ]);
  assert.equal(commands.length, 2);
  assert.equal(commands[0].op, 'rect');
  assert.equal(commands[0].fill, '#ffffff');
  assert.equal(commands[1].op, 'text');
  assert.equal(commands[1].size, 500);
  assert.equal(commands[1].text, '<img src=x onerror=alert(1)>');
});

test('入口函数名必须是安全标识符', () => {
  assert.equal(safeScriptEntry('drawTheme'), 'drawTheme');
  assert.equal(safeScriptEntry('x; alert(1)'), 'drawTheme');
  assert.equal(safeScriptEntry('123bad'), 'drawTheme');
});

test('指令数量与坐标会被限制', () => {
  const input = Array.from({ length: 300 }, () => ({ op: 'rect', x: 1e30, y: 0, w: 1e30, h: 10 }));
  const commands = sanitizeThemeScriptCommands(input);
  assert.equal(commands.length, 200);
  assert.equal(commands[0].x, 100000);
  assert.equal(commands[0].w, 100000);
});
