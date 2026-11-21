import test from 'node:test';
import assert from 'node:assert/strict';
import {
  McpError,
  McpToolError,
  ScreenScoreBoardClient,
  toAnthropicTools,
  toOpenAITools,
} from '../dist/esm/index.js';

function jsonResponse(body, options = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (Array.isArray(options.headers)) {
    for (const [key, value] of options.headers) headers.append(key, value);
  }
  return new Response(body === null ? null : JSON.stringify(body), {
    status: options.status || 200,
    headers,
  });
}

function rpcResult(id, result, extraHeaders = []) {
  return jsonResponse({ jsonrpc: '2.0', id, result }, { headers: extraHeaders });
}

test('MCP initialize、会话头、工具列表与工具调用', async () => {
  const messages = [];
  const client = new ScreenScoreBoardClient({
    baseUrl: 'https://score.example.com',
    token: 'ssb_admin',
    fetch: async (input, init) => {
      const message = JSON.parse(String(init.body));
      messages.push({ url: String(input), message, headers: new Headers(init.headers) });
      if (message.method === 'initialize') {
        return rpcResult(message.id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'screenscoreboard', version: '1.6.2' },
        }, [['Mcp-Session-Id', 'session-1']]);
      }
      if (message.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (message.method === 'tools/list') {
        return rpcResult(message.id, {
          tools: [{
            name: 'trigger_spotlight',
            description: '不改变分数，居中突显',
            inputSchema: { type: 'object', properties: { targetId: { type: 'string' } }, required: ['targetId'] },
          }],
        });
      }
      if (message.method === 'tools/call') {
        if (message.params.name === 'fail_tool') {
          return rpcResult(message.id, {
            content: [{ type: 'text', text: '工具失败原因' }],
            isError: true,
          });
        }
        return rpcResult(message.id, {
          content: [{ type: 'text', text: JSON.stringify({ seq: 3, targetId: 'p_1' }) }],
          isError: false,
        });
      }
      if (message.method === 'resources/read') {
        return rpcResult(message.id, {
          contents: [{ uri: message.params.uri, mimeType: 'application/json', text: '{"ok":true}' }],
        });
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: '方法不存在' },
      });
    },
  });

  const init = await client.mcp.initialize();
  assert.equal(init.serverInfo.name, 'screenscoreboard');
  assert.equal(client.mcp.protocolVersion, '2025-06-18');

  const tools = await client.mcp.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'trigger_spotlight');

  const toolCall = messages.find((item) => item.message.method === 'tools/list');
  assert.equal(toolCall.headers.get('mcp-session-id'), 'session-1');
  assert.equal(toolCall.headers.get('authorization'), 'Bearer ssb_admin');

  const result = await client.mcp.callTool('trigger_spotlight', { targetId: 'p_1' });
  assert.equal(result.isError, false);
  assert.deepEqual(result.data, { seq: 3, targetId: 'p_1' });

  const resource = await client.mcp.readResource('scoreboard://state');
  assert.deepEqual(resource, { ok: true });
});

test('MCP 工具定义可转换为 OpenAI / Anthropic 工具', () => {
  const tools = [{
    name: 'add_score',
    description: '加分',
    inputSchema: {
      type: 'object',
      properties: { delta: { type: 'number' } },
      required: ['delta'],
    },
  }];
  assert.deepEqual(toOpenAITools(tools), [{
    type: 'function',
    function: {
      name: 'add_score',
      description: '加分',
      parameters: tools[0].inputSchema,
    },
  }]);
  assert.deepEqual(toAnthropicTools(tools), [{
    name: 'add_score',
    description: '加分',
    input_schema: tools[0].inputSchema,
  }]);
});

test('MCP 工具错误与 JSON-RPC 错误', async () => {
  const client = new ScreenScoreBoardClient({
    baseUrl: 'https://score.example.com',
    token: 'ssb_admin',
    fetch: async (input, init) => {
      const message = JSON.parse(String(init.body));
      if (message.method === 'initialize') {
        return rpcResult(message.id, {
          protocolVersion: '2025-06-18',
          capabilities: {},
          serverInfo: { name: 'screenscoreboard', version: '1.6.2' },
        });
      }
      if (message.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (message.method === 'tools/call') {
        return rpcResult(message.id, {
          content: [{ type: 'text', text: '该功能未开启' }],
          isError: true,
        });
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: '方法不存在', data: { method: message.method } },
      });
    },
  });

  await assert.rejects(
    () => client.mcp.callToolOrThrow('fail_tool', {}),
    (error) => {
      assert.ok(error instanceof McpToolError);
      assert.equal(error.toolName, 'fail_tool');
      assert.equal(error.message, '该功能未开启');
      return true;
    },
  );

  await assert.rejects(
    () => client.mcp.request('bad/method'),
    (error) => {
      assert.ok(error instanceof McpError);
      assert.equal(error.rpcCode, -32601);
      assert.deepEqual(error.details, { method: 'bad/method' });
      return true;
    },
  );
});
