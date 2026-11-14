// 端到端验证：HTTP / 上传 / WS 同步 / 多项目 / 持久化 / SQLite 存储 / 旧数据迁移
// 运行: npm run verify
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 3456;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sb-verify-'));

let passed = 0, failed = 0;
let currentServer = null;
process.on('exit', () => { try { currentServer && currentServer.kill('SIGKILL'); } catch (_) {} });

function assert(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

// 1×1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function startServer(extraEnv = {}) {
  // 用运行测试的同一个 Node，避免多版本 Node 下原生模块 ABI 不一致
  const proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  currentServer = proc;
  return proc;
}

async function waitServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + '/api/state');
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务启动超时');
}

async function stopServer(proc) {
  proc.kill('SIGTERM');
  await new Promise((r) => proc.once('exit', r));
}

function wsClient(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const client = {
    ws, name, states: [], acks: new Map(), seq: 0,
    ready: new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    waitState(pred, since = 0, timeout = 3000) {
      return new Promise((resolve, reject) => {
        for (let i = since; i < client.states.length; i++) {
          if (pred(client.states[i])) return resolve(client.states[i]);
        }
        const t = setTimeout(() => reject(new Error(`${name}: 等待状态超时`)), timeout);
        client._waiters.push({ pred, resolve: (s) => { clearTimeout(t); resolve(s); } });
      });
    },
    _waiters: [],
    sendOp(op, payload) {
      return new Promise((resolve, reject) => {
        const reqId = `v${++client.seq}`;
        client.acks.set(reqId, { resolve, reject });
        ws.send(JSON.stringify({ type: 'op', reqId, op, payload }));
      });
    },
  };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'state') {
      client.states.push(msg.data);
      client._waiters = client._waiters.filter((w) => {
        if (w.pred(msg.data)) { w.resolve(msg.data); return false; }
        return true;
      });
    } else if (msg.type === 'ack') {
      const a = client.acks.get(msg.reqId);
      if (a) {
        client.acks.delete(msg.reqId);
        msg.ok ? a.resolve(msg) : a.reject(new Error(msg.error));
      }
    }
  });
  return client;
}

async function getState() {
  return (await fetch(BASE + '/api/state')).json();
}

async function main() {
  let server = startServer();
  await waitServer();
  console.log('HTTP 路由与状态:');

  let r = await fetch(BASE + '/display');
  assert(r.ok && (await r.text()).includes('display.js'), 'GET /display 返回页面');
  r = await fetch(BASE + '/admin');
  assert(r.ok && (await r.text()).includes('admin.js'), 'GET /admin 返回页面');
  r = await fetch(BASE + '/');
  assert(r.status === 200, 'GET / 重定向后可访问');
  const st0 = await getState();
  const projectId = Object.keys(st0.projects || {})[0];
  assert(Boolean(projectId), '默认创建一个项目');
  assert(st0.projects[projectId].settings.title === '计分板', '项目默认设置正确');
  r = await fetch(BASE + '/../etc/passwd');
  assert(r.status === 400 || r.status === 404, '路径穿越被拒绝');
  r = await fetch(BASE + '/shared.js');
  assert(r.ok && (await r.text()).includes('connectWS'), '静态资源可访问');

  console.log('头像上传:');
  r = await fetch(BASE + '/api/avatar', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG });
  const up = await r.json();
  assert(r.ok && /^avatars\/[0-9a-f]+\.png$/.test(up.path), '上传合法 PNG 返回 path');
  r = await fetch(BASE + '/' + up.path);
  assert(r.ok && Buffer.from(await r.arrayBuffer()).equals(PNG), '上传头像可取回且一致');
  r = await fetch(BASE + '/api/avatar', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.alloc(3 * 1024 * 1024) });
  assert(r.status === 413, '3MB 上传返回 413');
  r = await fetch(BASE + '/api/avatar', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('nope') });
  assert(r.status === 415, '伪造图片返回 415');

  console.log('自定义音效上传:');
  const WAV = Buffer.alloc(64);
  WAV.write('RIFF', 0, 'ascii');
  WAV.writeUInt32LE(56, 4);
  WAV.write('WAVE', 8, 'ascii');
  WAV.write('fmt ', 12, 'ascii');
  r = await fetch(BASE + '/api/sound', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: WAV });
  const soundUp = await r.json();
  assert(r.ok && /^sounds\/[0-9a-f]+\.wav$/.test(soundUp.path), '上传 WAV 音效返回 path');
  r = await fetch(BASE + '/' + soundUp.path);
  assert(r.ok && Buffer.from(await r.arrayBuffer()).equals(WAV), '音效文件可取回且一致');
  r = await fetch(BASE + '/api/sound', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.from('not audio') });
  assert(r.status === 415, '伪造音频返回 415');

  console.log('WebSocket 同步:');
  const viewer = wsClient('viewer');
  const admin = wsClient('admin');
  await Promise.all([viewer.ready, admin.ready]);
  await viewer.waitState((s) => s.projects && s.projects[projectId]);
  assert(viewer.states.length >= 1, 'viewer 连接即收到初始状态');
  const P = (st) => st.projects[projectId];
  const adminOp = (op, payload) => admin.sendOp(op, Object.assign({ projectId }, payload || {}));

  const ack1 = await adminOp('addPerson', { name: '张三', avatar: up.path });
  const pid = ack1.result.personId;
  let s = await viewer.waitState((st) => P(st) && P(st).people[pid]);
  assert(s.projects[projectId].people[pid].name === '张三', 'viewer 实时收到新人员');
  await adminOp('addScore', { personId: pid, delta: 10 });
  s = await viewer.waitState((st) => P(st) && P(st).people[pid] && P(st).people[pid].score === 10);
  assert(true, 'viewer 实时收到加分 (+10)');
  await adminOp('addScore', { personId: pid, delta: -3 });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].score === 7);
  assert(true, 'viewer 实时收到减分 (−3 → 7)');

  const ack2 = await adminOp('addTeam', { name: '红队' });
  const tid = ack2.result.teamId;
  await adminOp('assignTeam', { personId: pid, teamId: tid });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].teamId === tid);
  assert(P(s).teams[tid].name === '红队', 'viewer 实时收到建队与移入');

  await adminOp('updateSettings', { patch: { columns: 6, theme: 'light', title: '决赛计分板' } });
  s = await viewer.waitState((st) => P(st).settings.columns === 6);
  assert(s.projects[projectId].settings.theme === 'light', 'viewer 实时收到排版变更');

  await adminOp('updateSettings', {
    patch: { bgType: 'image', bgImage: up.path, bgColor: '#203040', cardBg: '#101820', cardRadius: 18 },
  });
  s = await viewer.waitState((st) => P(st).settings.cardRadius === 18);
  assert(s.projects[projectId].settings.bgImage === up.path, 'viewer 实时收到背景图设置');

  await adminOp('updateSettings', { patch: { layoutMode: 'free', memberScale: 1.4 } });
  s = await viewer.waitState((st) => P(st).settings.layoutMode === 'free');
  assert(s.projects[projectId].settings.memberScale === 1.4, '自由布局/成员缩放同步');

  await adminOp('setCardImage', { kind: 'person', id: pid, image: up.path });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].cardImage === up.path);
  assert(true, '个人卡面图同步');
  await adminOp('setCardImage', { kind: 'person', id: pid, image: null });
  await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].cardImage === null);
  assert(true, '卡面图可移除');

  await adminOp('setLayout', { kind: 'person', id: pid, layout: { x: 5, y: 6, w: 24, h: 15 } });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].layout && P(st).people[pid].layout.x === 5);
  assert(s.projects[projectId].people[pid].layout.w === 24, '卡片位置/大小同步');
  await adminOp('setLayout', { kind: 'person', id: pid, layout: { x: -20, y: 200, w: 1, h: 1 } });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].layout && P(st).people[pid].layout.w === 8);
  assert(P(s).people[pid].layout.x === 0 && P(s).people[pid].layout.y === 94, '越界坐标被收拢');

  await adminOp('setMemberLayout', { personId: pid, layout: { x: 2, y: 3, w: 20, h: 21 } });
  s = await viewer.waitState((st) => P(st).people[pid] && P(st).people[pid].memberLayout);
  assert(P(s).people[pid].memberLayout.w === 20, '成员小卡片布局同步');

  await adminOp('updateSettings', { patch: { avatarPosition: 'top', avatarSizeMode: 'manual', avatarSize: 96 } });
  s = await viewer.waitState((st) => P(st).settings.avatarPosition === 'top');
  assert(P(s).settings.avatarSize === 96, '头像位置/大小同步');

  await adminOp('updateSettings', {
    patch: {
      cardStyle: 'neon', glassBlur: 18, glassOpacity: 0.4,
      scoreEffect: 'confetti', scoreEffectDuration: 1200, scoreEffectColor: '#ff8800',
      scoreEffectOnlyPositive: true, soundEnabled: true, soundVolume: 0.6,
    },
  });
  s = await viewer.waitState((st) => P(st).settings.cardStyle === 'neon');
  assert(P(s).settings.scoreEffect === 'confetti' && P(s).settings.soundVolume === 0.6, '卡片样式/特效/音效同步');

  await adminOp('updateSettings', { patch: { displayStyle: 'seewo' } });
  s = await viewer.waitState((st) => P(st).settings.displayStyle === 'seewo');
  assert(true, '显示风格同步');
  await adminOp('updateSettings', { patch: { displayStyle: 'poster' } }).catch((e) => {
    assert(/显示风格/.test(e.message), '非法显示风格被拒绝');
  });

  await adminOp('updateSettings', {
    patch: { scoreEffect: 'spotlight', spotlightScope: 'person_team', customSound: soundUp.path },
  });
  s = await viewer.waitState((st) => P(st).settings.scoreEffect === 'spotlight');
  assert(P(s).settings.customSound === soundUp.path && P(s).settings.spotlightScope === 'person_team',
    '居中突显特效/突显范围/自定义音效同步');
  await adminOp('updateSettings', { patch: { customSound: '../../etc/passwd' } }).catch((e) => {
    assert(/音效文件路径/.test(e.message), '非法音效路径被拒绝');
  });
  await adminOp('updateSettings', { patch: { spotlightScope: 'team_only' } }).catch((e) => {
    assert(/突显范围/.test(e.message), '非法突显范围被拒绝');
  });

  // 非法参数
  await adminOp('updateSettings', { patch: { columns: 99 } }).catch((e) => assert(/列数/.test(e.message), '排版参数越界被拒绝'));
  await adminOp('updateSettings', { patch: { cardStyle: 'hologram' } }).catch((e) => assert(/卡片样式/.test(e.message), '非法卡片样式被拒绝'));
  await adminOp('updateSettings', { patch: { scoreEffect: 'sparkle' } }).catch((e) => assert(/特效类型/.test(e.message), '非法特效类型被拒绝'));
  await adminOp('updateSettings', { patch: { soundVolume: 2 } }).catch((e) => assert(/音量/.test(e.message), '音效音量越界被拒绝'));

  // 广播收敛
  const countBefore = viewer.states.length;
  await adminOp('addScore', { personId: 'p_nope', delta: 1 }).catch((e) => assert(e.message === '人员不存在', '非法 op 返回错误'));
  await new Promise((r) => setTimeout(r, 300));
  assert(viewer.states.length === countBefore, '非法 op 不触发广播');
  await admin.sendOp('addPerson', { name: '无项目' }).catch((e) => assert(/项目不存在/.test(e.message), '缺少 projectId 被拒绝'));

  console.log('多项目:');
  const ackP2 = await admin.sendOp('addProject', { name: '第二项目' });
  const projectId2 = ackP2.result.projectId;
  s = await viewer.waitState((st) => st.projects[projectId2]);
  assert(s.projects[projectId2].name === '第二项目' && Object.keys(s.projects).length === 2, '新建项目并同步');
  const p2ack = await admin.sendOp('addPerson', { projectId: projectId2, name: '李四' });
  s = await viewer.waitState((st) => st.projects[projectId2] && st.projects[projectId2].people[p2ack.result.personId]);
  assert(!Object.keys(s.projects[projectId].people).includes(p2ack.result.personId), '两个项目数据互相隔离');
  await admin.sendOp('renameProject', { projectId: projectId2, name: '冠军组' });
  s = await viewer.waitState((st) => st.projects[projectId2] && st.projects[projectId2].name === '冠军组');
  assert(true, '项目可重命名');
  await admin.sendOp('deleteProject', { projectId: projectId2 });
  s = await viewer.waitState((st) => !st.projects[projectId2]);
  assert(Object.keys(s.projects).length === 1, '项目可删除');
  await admin.sendOp('deleteProject', { projectId }).catch((e) => assert(/至少保留/.test(e.message), '最后一个项目不可删除'));
  await adminOp('updateSettings', { patch: { columns: 5 } });
  await viewer.waitState((st) => P(st).settings.columns === 5);

  console.log('持久化（JSON）:');
  viewer.ws.close(); admin.ws.close();
  await stopServer(server);
  server = startServer();
  await waitServer();
  const restored = await getState();
  const rp = restored.projects[projectId];
  assert(rp && rp.people[pid] && rp.people[pid].score === 7, '重启后人员与分数恢复');
  assert(rp.people[pid].layout.x === 0 && rp.people[pid].layout.w === 8 &&
    rp.people[pid].memberLayout.w === 20, '重启后卡片布局恢复');
  assert(rp.settings.cardStyle === 'neon' && rp.settings.columns === 5 && rp.settings.avatarSize === 96, '重启后外观设置恢复');
  assert(rp.settings.displayStyle === 'seewo', '重启后显示风格恢复');
  assert(rp.settings.scoreEffect === 'spotlight' && rp.settings.customSound === soundUp.path &&
    rp.settings.spotlightScope === 'person_team', '重启后居中突显/突显范围/自定义音效恢复');
  assert(Object.keys(restored.projects).length === 1, '重启后项目列表恢复');

  console.log('存储后端（SQLite）:');
  await stopServer(server);
  const sqliteEnv = { STORAGE: 'sqlite', SQLITE_FILE: path.join(DATA_DIR, 'scoreboard-test.db') };
  server = startServer(sqliteEnv);
  await waitServer();
  let sqlState = await getState();
  const sqlProjectId = Object.keys(sqlState.projects)[0];
  assert(Boolean(sqlProjectId), 'SQLite 后端启动并初始化');
  const sqlClient = wsClient('sqlite-admin');
  await sqlClient.ready;
  await sqlClient.waitState((st) => st.projects && st.projects[sqlProjectId]);
  const sqlAck = await sqlClient.sendOp('addPerson', { projectId: sqlProjectId, name: '持久化测试' });
  const sqlPid = sqlAck.result.personId;
  await new Promise((r) => setTimeout(r, 300)); // 等防抖写盘
  sqlClient.ws.close();
  await stopServer(server);
  server = startServer(sqliteEnv);
  await waitServer();
  sqlState = await getState();
  assert(sqlState.projects[sqlProjectId] && sqlState.projects[sqlProjectId].people[sqlPid], 'SQLite 重启后数据恢复');
  await stopServer(server);

  console.log('旧版数据迁移:');
  const legacyDir = mkdtempSync(path.join(tmpdir(), 'sb-legacy-'));
  writeFileSync(path.join(legacyDir, 'state.json'), JSON.stringify({
    version: 1,
    people: { p_legacy: { id: 'p_legacy', name: '旧成员', score: 3, teamId: null, createdAt: 1, avatar: null } },
    teams: {},
    settings: { title: '旧积分榜' },
  }));
  server = startServer({ DATA_DIR: legacyDir });
  await waitServer();
  const legacyState = await getState();
  const legacyProjects = Object.values(legacyState.projects);
  assert(legacyProjects.length === 1 && legacyProjects[0].name === '默认项目', '旧数据包装为默认项目');
  assert(legacyProjects[0].people.p_legacy && legacyProjects[0].people.p_legacy.score === 3, '旧人员数据保留');
  assert(legacyProjects[0].settings.title === '旧积分榜' && legacyProjects[0].settings.scoreEffect, '旧设置保留并补全新字段');
  await stopServer(server);

  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(legacyDir, { recursive: true, force: true });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('验证脚本异常:', e); process.exit(1); });
