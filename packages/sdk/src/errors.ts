import type { McpContent } from './types.js';

export interface ScreenScoreBoardErrorOptions {
  status?: number;
  code?: string;
  details?: unknown;
  requestId?: string;
  body?: unknown;
  cause?: unknown;
}

/** REST / 网络 / 鉴权错误的统一类型。status 为 0 表示请求没有拿到 HTTP 响应。 */
export class ScreenScoreBoardError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly body?: unknown;

  constructor(message: string, options: ScreenScoreBoardErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ScreenScoreBoardError';
    this.status = options.status ?? 0;
    this.code = options.code ?? 'UNKNOWN';
    this.details = options.details;
    this.requestId = options.requestId;
    this.body = options.body;
  }
}

export const ScoreboardError = ScreenScoreBoardError;
export type ScoreboardError = ScreenScoreBoardError;

export function isScreenScoreBoardError(value: unknown): value is ScreenScoreBoardError {
  return value instanceof ScreenScoreBoardError ||
    (Boolean(value) && (value as { name?: string }).name === 'ScreenScoreBoardError');
}

/** JSON-RPC 层错误（MCP 返回的 error 对象）。 */
export class McpError extends ScreenScoreBoardError {
  readonly rpcCode: number;

  constructor(message: string, rpcCode: number, data?: unknown, cause?: unknown) {
    super(message, {
      code: 'MCP_ERROR',
      status: 200,
      details: data,
      cause,
    });
    this.name = 'McpError';
    this.rpcCode = rpcCode;
  }
}

/** MCP tools/call 返回 isError=true 时由 callToolOrThrow 抛出。 */
export class McpToolError extends ScreenScoreBoardError {
  readonly toolName: string;
  readonly content: McpContent[];

  constructor(toolName: string, message: string, content: McpContent[] = []) {
    super(message, {
      code: 'MCP_TOOL_ERROR',
      status: 200,
      details: content,
    });
    this.name = 'McpToolError';
    this.toolName = toolName;
    this.content = content;
  }
}
