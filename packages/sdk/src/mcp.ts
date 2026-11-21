import { McpError, McpToolError, ScreenScoreBoardError } from './errors.js';
import type { HttpClient } from './http.js';
import type {
  McpContent,
  McpInitializeResult,
  McpResource,
  McpTool,
  McpToolResult,
} from './types.js';
import { SDK_VERSION } from './version.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpClientOptions {
  protocolVersion?: string;
  clientInfo?: {
    name: string;
    version: string;
    [key: string]: unknown;
  };
  sessionId?: string;
}

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse<T> {
  jsonrpc?: string;
  id?: string | number | null;
  result?: T;
  error?: JsonRpcError;
}

interface ToolCallWireResult {
  content?: McpContent[];
  isError?: boolean;
}

interface ResourceReadWireResult {
  contents?: Array<{
    uri?: string;
    mimeType?: string;
    text?: string;
    [key: string]: unknown;
  }>;
}

function parseToolResult<T>(raw: ToolCallWireResult): McpToolResult<T> {
  const content = Array.isArray(raw.content) ? raw.content : [];
  const text = content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n');
  let data: T | null = null;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch (_) {
      data = text as unknown as T;
    }
  }
  return {
    content,
    isError: Boolean(raw.isError),
    text,
    data,
    raw,
  };
}

/**
 * MCP HTTP 客户端（Streamable HTTP 的 JSON 子集）。
 * 自动完成 initialize 并在后续请求回传 Mcp-Session-Id。
 */
export class McpClient {
  private readonly http: HttpClient;
  private readonly options: McpClientOptions;
  private nextId = 1;
  private sessionId?: string;
  private initPromise: Promise<McpInitializeResult> | null = null;
  private initializedResult: McpInitializeResult | null = null;

  constructor(http: HttpClient, options: McpClientOptions = {}) {
    this.http = http;
    this.options = options;
    this.sessionId = options.sessionId;
  }

  get initialized(): boolean {
    return this.initializedResult !== null;
  }

  get serverInfo(): McpInitializeResult['serverInfo'] | null {
    return this.initializedResult?.serverInfo || null;
  }

  get protocolVersion(): string | null {
    return this.initializedResult?.protocolVersion || null;
  }

  async initialize(force = false): Promise<McpInitializeResult> {
    if (!force && this.initializedResult) return this.initializedResult;
    if (!force && this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const { result, response } = await this.send<McpInitializeResult>(
        'initialize',
        {
          protocolVersion: this.options.protocolVersion || MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: this.options.clientInfo || {
            name: '@peijundev/screenscoreboard-sdk',
            version: SDK_VERSION,
          },
        },
      );
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) this.sessionId = sessionId;
      this.initializedResult = result;
      try {
        await this.notify('notifications/initialized');
      } catch (_) {
        // 初始化结果已经可用，通知失败不阻塞后续工具调用
      }
      return result;
    })().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  async ping(options: McpCallOptions = {}): Promise<Record<string, unknown>> {
    const { result } = await this.send<Record<string, unknown>>('ping', undefined, options);
    return result;
  }

  async listTools(options: McpCallOptions = {}): Promise<McpTool[]> {
    await this.initialize();
    const result = await this.request<{ tools: McpTool[] }>('tools/list', {}, options);
    return result.tools || [];
  }

  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
    options: McpCallOptions = {},
  ): Promise<McpToolResult<T>> {
    await this.initialize();
    const result = await this.request<ToolCallWireResult>(
      'tools/call',
      { name, arguments: args },
      options,
    );
    return parseToolResult<T>(result);
  }

  /** 与 callTool 相同，但 isError=true 时抛出 McpToolError，方便 AI 循环直接 catch。 */
  async callToolOrThrow<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
    options: McpCallOptions = {},
  ): Promise<T | null> {
    const result = await this.callTool<T>(name, args, options);
    if (result.isError) {
      throw new McpToolError(name, result.text || 'MCP 工具执行失败', result.content);
    }
    return result.data;
  }

  async listResources(options: McpCallOptions = {}): Promise<McpResource[]> {
    await this.initialize();
    const result = await this.request<{ resources: McpResource[] }>(
      'resources/list',
      {},
      options,
    );
    return result.resources || [];
  }

  /** 读取只读 resource；text 是 JSON 时自动解析，否则返回原文本。 */
  async readResource<T = unknown>(uri: string, options: McpCallOptions = {}): Promise<T | null> {
    const result = await this.request<ResourceReadWireResult>(
      'resources/read',
      { uri },
      options,
    );
    const first = result.contents?.[0];
    if (!first) return null;
    if (typeof first.text === 'string') {
      try {
        return JSON.parse(first.text) as T;
      } catch (_) {
        return first.text as unknown as T;
      }
    }
    return first as unknown as T;
  }

  async readResourceRaw(
    uri: string,
    options: McpCallOptions = {},
  ): Promise<ResourceReadWireResult> {
    return this.request<ResourceReadWireResult>('resources/read', { uri }, options);
  }

  /** 发送任意 JSON-RPC 方法（高级用法）。 */
  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: McpCallOptions = {},
  ): Promise<T> {
    if (method !== 'initialize') await this.initialize();
    const { result } = await this.send<T>(method, params, options);
    return result;
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.http.mcpRequest(
      { jsonrpc: '2.0', method, params },
      { sessionId: this.sessionId },
    );
  }

  private async send<T>(
    method: string,
    params?: Record<string, unknown>,
    options: McpCallOptions = {},
  ): Promise<{ result: T; response: Response }> {
    const id = this.nextId++;
    const { json, response } = await this.http.mcpRequest(
      {
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      },
      {
        sessionId: this.sessionId,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
    );
    if (Array.isArray(json)) {
      const match = json.find((item) => item && item.id === id) || json[0];
      return this.unwrap<T>(match, json, response);
    }
    return this.unwrap<T>(json, json, response);
  }

  private unwrap<T>(
    message: unknown,
    body: unknown,
    response: Response,
  ): { result: T; response: Response } {
    if (!message || typeof message !== 'object') {
      throw new ScreenScoreBoardError('MCP 返回了空响应', {
        code: 'MCP_INVALID_RESPONSE',
        status: response.status,
        body,
      });
    }
    const rpc = message as JsonRpcResponse<T>;
    if (rpc.error) {
      throw new McpError(rpc.error.message || 'MCP 调用失败', rpc.error.code, rpc.error.data);
    }
    if (rpc.result === undefined) {
      throw new ScreenScoreBoardError('MCP 响应缺少 result', {
        code: 'MCP_INVALID_RESPONSE',
        status: response.status,
        body,
      });
    }
    return { result: rpc.result, response };
  }
}
