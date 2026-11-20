# MCP（Model Context Protocol）

计分板把全部 REST 管理能力暴露为 MCP 工具，供 Claude Desktop、Claude Code、自研 AI 客户端等直接操控项目、人员、分数、设置、主题与数据。

> **安全提示：MCP 需要管理员身份。** HTTP MCP 接受管理员 Cookie（需 CSRF）或 `Authorization: Bearer` API 令牌；stdio 形态通过 `SCOREBOARD_TOKEN` 携带令牌。建议为自动化单独创建令牌，不要复用管理员密码。详见 [authentication.md](authentication.md)。

- 协议版本：`2025-06-18`（手写 JSON-RPC 2.0 核心，不依赖官方 SDK 运行时）
- 两种传输：**stdio**（本机进程）与 **HTTP**（`POST /mcp`）
- 工具定义由 REST 路由表自动派生，两种传输的工具列表完全一致
- 常用工具提供显式 `inputSchema`；其余工具回退到 `{ path 参数, body, payload }` 通用结构

## 传输一：stdio

stdio 形态是一个**REST 客户端**：它不启动第二个服务实例，也不碰单实例锁，只通过 `SCOREBOARD_URL` 连接已经运行的计分板。

```bash
# 先启动计分板
npm start

# 另开终端验证（需要管理员 API 令牌）
SCOREBOARD_URL=http://127.0.0.1:3000 \
SCOREBOARD_TOKEN=ssb_xxx \
node bin/screenscoreboard-mcp.js
```

然后按行写入 JSON-RPC：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_health","arguments":{}}}
```

- `SCOREBOARD_URL` 默认 `http://127.0.0.1:3000`
- `SCOREBOARD_TOKEN` 为管理员 API 令牌；没有令牌时只能读取公开接口，写工具会失败
- 启动时先请求 `/api/v1/health`；服务未启动会在 stderr 明确报错并以非 0 退出
- 适合 Claude Desktop / Claude Code 等通过子进程拉起 MCP 的宿主

Claude Desktop 配置里同时设置 `SCOREBOARD_URL` 与 `SCOREBOARD_TOKEN`。

Claude Desktop 配置示例（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "screenscoreboard": {
      "command": "node",
      "args": ["/绝对路径/ScreenScoreBoardWeb/bin/screenscoreboard-mcp.js"],
      "env": { "SCOREBOARD_URL": "http://127.0.0.1:3000" }
    }
  }
}
```

Claude Code：

```bash
claude mcp add screenscoreboard \
  -e SCOREBOARD_URL=http://127.0.0.1:3000 \
  -- node /绝对路径/ScreenScoreBoardWeb/bin/screenscoreboard-mcp.js
```

## 传输二：HTTP

服务启动后直接使用：

```
POST http://<host>:3000/mcp
Content-Type: application/json
Authorization: Bearer ssb_xxx
```

- **仅管理员**：匿名 401，操作员/只读令牌 403
- 无状态：每个请求独立处理，可批量（JSON-RPC batch）
- `initialize` 响应会带 `Mcp-Session-Id` 响应头；当前实现不要求后续请求回传
- 通知（无 `id`）返回 `202 No Content`
- Origin 校验沿用 WebSocket 规则：无 `Origin` 放行；浏览器来源必须与 `Host` 同源或命中 `ALLOWED_ORIGINS`
- 使用 Cookie 时还必须带 `X-CSRF-Token`；自动化建议 Bearer

```bash
curl -s http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ssb_xxx' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

支持的方法：

| 方法 | 说明 |
|---|---|
| `initialize` | 协议协商，返回 serverInfo 与 capabilities |
| `ping` | 存活检查 |
| `tools/list` | 列出全部工具及 inputSchema |
| `tools/call` | 调用工具 |
| `resources/list` | 列出只读资源 |
| `resources/read` | 读取资源内容 |

## 工具

工具数量随 REST 路由增长（当前 **87** 个；以 `tools/list` 为准）。命名与资源对应，主要分组：

| 分组 | 代表工具 |
|---|---|
| 元信息 | `get_health`、`get_version`、`get_state`、`get_endpoints` |
| 项目 | `list_projects`、`create_project`、`get_project`、`rename_project`、`delete_project` |
| 人员 | `list_people`、`add_person`、`update_person`、`remove_person`、`move_person`、`set_person_*` |
| 团队 | `list_teams`、`add_team`、`update_team`、`remove_team`、`assign_team` |
| 分数 | `add_score`、`set_score`、`add_team_score`、`reset_scores` |
| 运行态 | `undo_score`、`undo_to`、`start_countdown`、`pause_countdown`、`resume_countdown`、`reset_countdown` |
| 设置/布局 | `get_settings`、`update_settings`、`reset_layout` |
| 主题 | `list_themes`、`get_theme`、`create_theme`、`duplicate_theme`、`rename_theme`、`apply_theme`、`delete_theme` |
| 主题子资源 | `update_theme_meta`、`update_theme_canvas`、`update_theme_layers`、`put_theme_layer`、`delete_theme_layer`、`put_theme_node`、`delete_theme_node`、`update_theme_widgets`、`update_theme_settings`、`update_theme_script` |
| 草稿 | `get_theme_draft`、`save_theme_draft`、`delete_theme_draft`、`apply_theme_draft` |
| 数据 | `import_project`、`list_assets`、`list_backups`、`run_backup`、`scan_orphans`、`cleanup_orphans` |
| 逃生通道 | `call_op`（payload 自带 `projectId`）、`call_project_op`（路径自动注入 `projectId`），均为低层白名单 `op` |

> 下载/上传类原始端点（`GET /projects/:id/export`、`GET /projects/:id/scores.csv`、`POST /assets/images`、`POST /assets/sounds`）不暴露为 MCP 工具：它们返回或接收原始字节，不适合作为文本工具参数。请直接用 REST。

约定：

- 路径参数与 body 字段放在 `arguments` 中，例如 `{ "projectId": "pr_x", "name": "张三" }`
- 起止服务端的写操作会走 `applyOp` 并广播 WebSocket，与大屏实时一致
- 删除/重置/清理类工具在描述中标注不可逆；`cleanup_orphans` 必须先显式传 `dryRun`
- 主题写工具同样遵循 revision：先用 `get_theme` 取 `meta.revision`，调用时传 `revision` 或 `If-Match` 等价参数；冲突返回错误而不是静默覆盖
- 失败结果使用 MCP 语义 `{ content: [...], isError: true }`，不会让整个 JSON-RPC 连接断开

## 只读 resources

| URI | 内容 |
|---|---|
| `scoreboard://state` | 全量热状态 |
| `scoreboard://health` | 健康状态 |
| `scoreboard://project/{id}` | 项目详情 |
| `scoreboard://theme/{id}` | 完整主题 |
| `scoreboard://theme-draft/{id}` | 项目主题草稿 |

## 调试

```bash
# 工具列表与数量
curl -s http://localhost:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'

# 直接加分
curl -s http://localhost:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add_score","arguments":{"projectId":"pr_x","personId":"p_1","delta":3}}}'
```

自动化测试：`npm run test:mcp`（HTTP 与 stdio 工具表一致性、实际加分、错误工具、resources）。
