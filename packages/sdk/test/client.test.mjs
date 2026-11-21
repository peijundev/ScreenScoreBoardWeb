import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ScreenScoreBoardClient,
  ScreenScoreBoardError,
} from '../dist/esm/index.js';

function jsonResponse(body, options = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (Array.isArray(options.headers)) {
    for (const [key, value] of options.headers) headers.append(key, value);
  } else if (options.headers) {
    new Headers(options.headers).forEach((value, key) => headers.append(key, value));
  }
  return new Response(body === null ? null : JSON.stringify(body), {
    status: options.status || 200,
    headers,
  });
}

function mockFetch(handler) {
  return async (input, init) => {
    const url = String(input);
    const request = {
      url,
      method: String(init?.method || 'GET').toUpperCase(),
      headers: new Headers(init?.headers || {}),
      body: init?.body,
    };
    return handler(request, init);
  };
}

test('Bearer 认证、路径编码、查询参数与响应解包', async () => {
  const calls = [];
  const client = new ScreenScoreBoardClient({
    baseUrl: 'https://score.example.com/base/',
    token: 'ssb_test',
    fetch: mockFetch(async (request) => {
      calls.push(request);
      return jsonResponse({ data: { ok: true }, meta: { requestId: 'r_1' } });
    }),
  });

  const result = await client.people.addScore('pr 1', 'p/1', 5);
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://score.example.com/base/api/v1/projects/pr%201/people/p%2F1/score/add',
  );
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer ssb_test');
  assert.equal(calls[0].headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body), { delta: 5 });

  await client.people.list('pr_1', { q: '张', limit: 20 });
  const listUrl = new URL(calls[1].url);
  assert.equal(listUrl.searchParams.get('q'), '张');
  assert.equal(listUrl.searchParams.get('limit'), '20');
});

test('API 错误映射为 ScreenScoreBoardError', async () => {
  const client = new ScreenScoreBoardClient({
    baseUrl: 'https://score.example.com',
    token: 'ssb_test',
    fetch: mockFetch(async () => jsonResponse({
      error: { code: 'FEATURE_DISABLED', message: '该功能未开启', details: { key: 'featureSpotlightTrigger' } },
      meta: { requestId: 'r_2' },
    }, { status: 403 })),
  });

  await assert.rejects(
    () => client.spotlight.person('pr_1', 'p_1'),
    (error) => {
      assert.ok(error instanceof ScreenScoreBoardError);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'FEATURE_DISABLED');
      assert.equal(error.requestId, 'r_2');
      assert.deepEqual(error.details, { key: 'featureSpotlightTrigger' });
      return true;
    },
  );
});

test('Node 账号密码登录：捕获 Cookie 并自动附带 CSRF', async () => {
  const calls = [];
  const client = new ScreenScoreBoardClient({
    baseUrl: 'https://score.example.com',
    username: 'admin',
    password: 'secret-pass',
    fetch: mockFetch(async (request) => {
      calls.push(request);
      if (request.url.endsWith('/auth/login')) {
        return jsonResponse({ data: { user: { id: 'u1', username: 'admin', role: 'admin' } } }, {
          headers: [
            ['set-cookie', 'ssb_session=sess-1; Path=/; HttpOnly'],
            ['set-cookie', 'ssb_csrf=csrf-1; Path=/'],
          ],
        });
      }
      return jsonResponse({ data: { score: 3 } });
    }),
  });

  const user = await client.login();
  assert.equal(user.username, 'admin');
  assert.match(client.getSession().cookie, /ssb_session=sess-1/);
  assert.equal(client.getSession().csrfToken, 'csrf-1');

  await client.people.addScore('pr_1', 'p_1', 3);
  const scoreCall = calls.at(-1);
  assert.equal(scoreCall.headers.get('cookie'), 'ssb_session=sess-1; ssb_csrf=csrf-1');
  assert.equal(scoreCall.headers.get('x-csrf-token'), 'csrf-1');
  assert.equal(scoreCall.headers.get('authorization'), null);
});

test('CSRF_FAILED 时刷新状态并重试一次', async () => {
  let scoreAttempts = 0;
  const client = new ScreenScoreBoardClient({
    baseUrl: 'https://score.example.com',
    username: 'admin',
    password: 'secret-pass',
    fetch: mockFetch(async (request) => {
      if (request.url.endsWith('/auth/login')) {
        return jsonResponse({ data: { user: { id: 'u1', username: 'admin', role: 'admin' } } }, {
          headers: [
            ['set-cookie', 'ssb_session=sess-1; Path=/; HttpOnly'],
            ['set-cookie', 'ssb_csrf=old-csrf; Path=/'],
          ],
        });
      }
      if (request.url.endsWith('/auth/status')) {
        return jsonResponse({ data: { authenticated: true } }, {
          headers: [['set-cookie', 'ssb_csrf=new-csrf; Path=/']],
        });
      }
      scoreAttempts += 1;
      if (scoreAttempts === 1) {
        return jsonResponse({
          error: { code: 'CSRF_FAILED', message: 'CSRF 校验失败' },
        }, { status: 403 });
      }
      assert.equal(request.headers.get('x-csrf-token'), 'new-csrf');
      return jsonResponse({ data: { score: 1 } });
    }),
  });

  await client.login();
  const result = await client.people.addScore('pr_1', 'p_1', 1);
  assert.deepEqual(result, { score: 1 });
  assert.equal(scoreAttempts, 2);
});

test('401 时使用保存的账号密码重新登录并重试', async () => {
  let logins = 0;
  let writes = 0;
  const client = new ScreenScoreBoardClient({
    baseUrl: 'https://score.example.com',
    username: 'admin',
    password: 'secret-pass',
    fetch: mockFetch(async (request) => {
      if (request.url.endsWith('/auth/login')) {
        logins += 1;
        return jsonResponse({ data: { user: { id: 'u1', username: 'admin', role: 'admin' } } }, {
          headers: [
            ['set-cookie', `ssb_session=sess-${logins}; Path=/; HttpOnly`],
            ['set-cookie', `ssb_csrf=csrf-${logins}; Path=/`],
          ],
        });
      }
      writes += 1;
      if (writes === 1) {
        return jsonResponse({ error: { code: 'UNAUTHORIZED', message: '请先登录' } }, { status: 401 });
      }
      return jsonResponse({ data: { score: 2 } });
    }),
  });

  await client.login();
  const result = await client.people.addScore('pr_1', 'p_1', 2);
  assert.deepEqual(result, { score: 2 });
  assert.equal(logins, 2);
  assert.equal(writes, 2);
});

test('请求超时映射为 TIMEOUT', async () => {
  const client = new ScreenScoreBoardClient({
    baseUrl: 'https://score.example.com',
    token: 'ssb_test',
    timeoutMs: 10,
    fetch: (input, init) => new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  await assert.rejects(
    () => client.system.health(),
    (error) => error instanceof ScreenScoreBoardError && error.code === 'TIMEOUT',
  );
});

test('raw JSON 端点与文本导出', async () => {
  const client = new ScreenScoreBoardClient({
    baseUrl: 'https://score.example.com',
    token: 'ssb_test',
    fetch: mockFetch(async (request) => {
      if (request.url.includes('/openapi.json')) {
        return jsonResponse({ openapi: '3.1.0', paths: {} });
      }
      return new Response('name,score\r\n张三,3\r\n', {
        status: 200,
        headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      });
    }),
  });

  const openapi = await client.system.openapi();
  assert.equal(openapi.openapi, '3.1.0');
  const csv = await client.data.exportScoresCsv('pr_1');
  assert.match(csv, /张三,3/);
});

test('setSession 可恢复已有 Cookie 会话', async () => {
  const calls = [];
  const client = new ScreenScoreBoardClient({
    baseUrl: 'https://score.example.com',
    cookie: 'ssb_session=saved-session; ssb_csrf=saved-csrf',
    fetch: mockFetch(async (request) => {
      calls.push(request);
      return jsonResponse({ data: { ok: true } });
    }),
  });

  await client.settings.update('pr_1', { accent: '#123456' });
  assert.equal(calls[0].headers.get('cookie'), 'ssb_session=saved-session; ssb_csrf=saved-csrf');
  assert.equal(calls[0].headers.get('x-csrf-token'), 'saved-csrf');
});
