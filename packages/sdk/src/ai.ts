import type { McpInputSchema, McpTool } from './types.js';

export interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: McpInputSchema;
  };
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: McpInputSchema;
}

/** 把 MCP tools/list 的结果转成 OpenAI Chat Completions / Responses 的 function tools。 */
export function toOpenAITools(tools: McpTool[]): OpenAIFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/** 把 MCP tools/list 的结果转成 Anthropic Messages API 的 tools。 */
export function toAnthropicTools(tools: McpTool[]): AnthropicTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}
