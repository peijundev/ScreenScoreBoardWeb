# ScreenScoreBoard SDK

ScreenScoreBoard 的 TypeScript / JavaScript SDK，一套代码同时接入 **REST API v1** 与 **MCP**，适合 Node 服务、浏览器管理页、AI Agent、自动化脚本和第三方应用。

- 零运行时依赖，Node 24+ / 现代浏览器
- 支持 `Authorization: Bearer` API 令牌与账号密码会话（自动维护 Cookie / CSRF）
- 完整的 REST 资源封装：项目、人员、团队、分数、手动突显、设置、运行态、主题、草稿、资源库、备份
- MCP 客户端：`initialize`、`tools/list`、`tools/call`、`resources/list`、`resources/read`
- 统一错误类型、请求超时、`AbortSignal`、自定义 `fetch`
- ESM + CommonJS 双格式，自带 TypeScript 类型

> 本包是客户端 SDK，不包含计分板服务端。请先部署 ScreenScoreBoard。

## 安装

```bash
npm install @peijundev/screenscoreboard-sdk
# 或 pnpm add @peijundev/screenscoreboard-sdk
# 或 yarn add @peijundev/screenscoreboard-sdk
```

## 快速开始

推荐使用 API 令牌。先以管理员登录创建令牌（明文只返回一次）：

```ts
import { ScreenScoreBoardClient } from '@peijundev/screenscoreboard-sdk';

const admin = new ScreenScoreBoardClient({
  baseUrl: 'https://score.example.com',
  username: 'admin',
  password: process.env.SCOREBOARD_ADMIN_PASSWORD!,
});

await admin.login();
const created = await admin.auth.tokens.create({ name: 'ai-agent' });
console.log(created.token); // ssb_xxx，只显示这一次
```

之后 AI / 自动化客户端只需要令牌：

```ts
const client = new ScreenScoreBoardClient({
  baseUrl: 'https://score.example.com',
  token: process.env.SCOREBOARD_TOKEN!,
});

const projects = await client.projects.list();
const projectId = projects[0].id;

const person = await client.people.add(projectId, { name: '张三' });
await client.people.addScore(projectId, person.id, 5);

// 纯突显：不加分，只让大屏居中放大张三
await client.spotlight.person(projectId, person.id, 2200);

const state = await client.system.state();
console.log(state.projects[projectId].people[person.id].score); // 5
```

## 认证方式

### 1. API 令牌（推荐）

```ts
const client = new ScreenScoreBoardClient({
  baseUrl: 'https://score.example.com',
  token: 'ssb_xxx',
});
```

- 不需要 CSRF，适合服务端、AI Agent、CI、MCP。
- 令牌权限等于所属用户角色。MCP 需要管理员令牌。
- 令牌只在创建时返回明文，请放入环境变量或密钥管理，不要提交到仓库。

### 2. 账号密码会话

```ts
const client = new ScreenScoreBoardClient({
  baseUrl: 'https://score.example.com',
  username: 'operator',
  password: 'operator-password',
  remember: true,
});

await client.login();
await client.people.addScore(projectId, personId, 1);
```

Node 下 SDK 会从登录响应捕获 `ssb_session` 与 `ssb_csrf`，后续写请求自动带 Cookie 与 `X-CSRF-Token`。会话过期时会用保存的账号密码自动重登一次。

### 3. 恢复已有会话

```ts
const client = new ScreenScoreBoardClient({
  baseUrl,
  cookie: process.env.SCOREBOARD_COOKIE, // ssb_session=...; ssb_csrf=...
});

// 或者
client.setSession({ cookie, csrfToken });
```

浏览器里 HttpOnly 的 `ssb_session` 由浏览器自动管理，SDK 会从 `document.cookie` 读取 `ssb_csrf`。

`auth.users.*`、为其他用户创建/吊销令牌等管理操作需要管理员；`auth.tokens.*` 与 `auth.sessions.*` 默认操作自己的账号。

### 访问控制（部署模式）

管理员可以在运行时决定是否使用登录系统：

```ts
const access = await client.auth.getAccess();
console.log(access.requireLogin, access.openAccess, access.activeAdmins);

// 完全开放：所有访问者获得管理员权限（建议只在可信局域网/VPN）
await client.auth.updateAccess(false);

// 重新启用登录
await client.auth.updateAccess(true);
```

> 关闭登录系统等同于把管理员权限交给所有访问者。服务端要求至少保留一个启用中的管理员，并会把设置持久化到 `auth.json`。

### 4. 浏览器

```ts
const client = new ScreenScoreBoardClient({
  baseUrl: location.origin,
  // 默认 credentials: 'same-origin'
});

await client.auth.login('admin', 'password');
```

- 建议页面与计分板同源。
- 跨源浏览器应用请优先通过自己的后端代理调用，不要把管理员令牌直接放进前端代码。
- 需要跨源携带 Cookie 时设置 `credentials: 'include'`，并确保反向代理/服务端 CORS 允许凭据；默认服务端只允许同源或 `ALLOWED_ORIGINS`。

## REST API 示例

### 项目、人员、团队

```ts
const project = await client.projects.create('春季运动会');
const projectId = project.projectId;

const person = await client.people.add(projectId, { name: '李四', bio: '三年级' });
const team = await client.teams.add(projectId, { name: '红队' });
await client.people.setTeam(projectId, person.id, team.id);

await client.teams.addScore(projectId, team.id, 2); // 每位成员各 +2
const people = await client.people.list(projectId, { q: '李', limit: 20 });
```

### 分数、撤销与倒计时

```ts
await client.people.addScore(projectId, person.id, 10);
await client.people.setScore(projectId, person.id, 0);
await client.scores.reset(projectId);

const runtime = await client.runtime.get(projectId);
console.log(runtime.undoCount, runtime.scoreLogs);

await client.runtime.undo(projectId);
await client.runtime.undoTo(projectId, 2);

await client.runtime.countdown.start(projectId, 300);
await client.runtime.countdown.pause(projectId);
await client.runtime.countdown.resume(projectId);
await client.runtime.countdown.reset(projectId);
```

### 设置与手动突显

```ts
const settings = await client.settings.get(projectId);
await client.settings.update(projectId, {
  scoreEffect: 'spotlight',
  spotlightTheme: 'fly',
  spotlightTriggerDuration: 2000,
  featureSpotlightTrigger: true,
});

await client.spotlight.trigger(projectId, {
  targetType: 'team',
  targetId: team.id,
  durationMs: 1800,
});
```

### 主题（需要 revision）

主题、主题子资源和主题草稿使用乐观并发。先读取 `revision`，写回时传入：

```ts
const theme = await client.themes.get(themeId);
await client.themes.updateMeta(themeId, { name: '春季主题' }, theme.meta.revision);

const layers = await client.themes.getLayers(themeId);
await client.themes.putLayer(themeId, 'layer_1', layers[0], theme.meta.revision + 1);
```

草稿：

```ts
const draft = await client.themes.getDraft(projectId);
const saved = await client.themes.saveDraft(projectId, draft ?? theme, draft?.meta.revision);
await client.themes.applyDraft(projectId);
```

### 资源、导出与备份

```ts
const assets = await client.data.listAssets();
const uploaded = await client.data.uploadImage(pngBytes, { filename: 'logo.png' });

const exported = await client.data.exportProject(projectId, { assets: true });
const csv = await client.data.exportScoresCsv(projectId, 'people');

await client.data.runBackup();
const backups = await client.data.listBackups();
```

### 统一逃生通道

SDK 没有逐一封装的新端点，可以直接走 HTTP：

```ts
const endpoints = await client.request('GET', '/endpoints');
const result = await client.request('POST', '/projects/pr_x/ops', {
  body: { op: 'addScore', payload: { personId: 'p_x', delta: 1 } },
});
```

也可以使用低层 op：

```ts
await client.ops.callProject(projectId, 'addScore', { personId: person.id, delta: 1 });
```

## MCP

```ts
const mcp = client.mcp;

const info = await mcp.initialize();
console.log(info.serverInfo, info.protocolVersion);

const tools = await mcp.listTools();
console.log(tools.map((tool) => tool.name));

const result = await mcp.callTool('trigger_spotlight', {
  projectId,
  targetType: 'person',
  targetId: person.id,
  durationMs: 1500,
});
console.log(result.isError, result.data);

// 需要错误直接抛出时
await mcp.callToolOrThrow('add_score', { projectId, personId: person.id, delta: 1 });

const state = await mcp.readResource('scoreboard://state');
```

`callTool` 会解析 MCP 的 `{ content, isError }`，并把 text 中的 JSON 自动解析到 `data`。`callToolOrThrow` 在 `isError=true` 时抛出 `McpToolError`。

### AI 工具调用

可以把 MCP 工具直接转换成 OpenAI / Anthropic 等工具定义：

```ts
import { toOpenAITools, toAnthropicTools } from '@peijundev/screenscoreboard-sdk';

const tools = await client.mcp.listTools();
const openaiTools = toOpenAITools(tools);
const anthropicTools = toAnthropicTools(tools);

// LLM 返回 tool call 后：
const output = await client.mcp.callTool(
  toolCall.function.name,
  JSON.parse(toolCall.function.arguments),
);
```

`toOpenAITools` / `toAnthropicTools` 只做纯数据转换，不绑定任何 AI SDK。

MCP 传输是 `POST /mcp`，需要管理员身份。建议为 AI 单独创建 API 令牌，不要复用管理员密码。

## 错误处理

所有 REST / 网络错误都是 `ScreenScoreBoardError`：

```ts
import { ScreenScoreBoardError, McpError, McpToolError } from '@peijundev/screenscoreboard-sdk';

try {
  await client.spotlight.person(projectId, personId);
} catch (error) {
  if (error instanceof ScreenScoreBoardError) {
    console.error(error.status, error.code, error.message, error.requestId, error.details);
    // 403 FEATURE_DISABLED：手动突显开关被关闭
    // 401 UNAUTHORIZED：令牌/会话失效
    // 409 CONFLICT：主题 revision 过期
  }
}
```

- `status`：HTTP 状态；网络错误为 `0`。
- `code`：服务端错误码，如 `FEATURE_DISABLED`、`CONFLICT`、`CSRF_FAILED`；网络错误为 `NETWORK_ERROR` / `TIMEOUT` / `ABORTED`。
- `requestId`：可对照服务端日志。
- `McpError` 带 `rpcCode`；`McpToolError` 带 `toolName` 与 `content`。

超时与取消：

```ts
await client.request('GET', '/state', { timeoutMs: 5000, signal: abortController.signal });
```

## 兼容性

- Node `>=24`（需要全局 `fetch`；更旧环境可通过 `fetch` 选项注入）。
- 浏览器：现代 Chromium / Firefox / Safari（不受 Node `engines` 限制）。
- 服务端：ScreenScoreBoard 1.6.1+；手动突显与访问控制需要该版本。
- 包同时提供 ESM 与 CommonJS，无运行时依赖。

## 开发与发布（本仓库维护者）

```bash
# 构建（输出 dist/esm + dist/cjs）
npm --prefix packages/sdk run build

# 单元测试 + 真实服务端集成测试
npm --prefix packages/sdk test

# 检查打包内容
npm pack ./packages/sdk --dry-run

# 发布（需要 npm 登录与 @peijundev scope 权限）
npm publish ./packages/sdk --access public
```

集成测试会在临时 `DATA_DIR` 启动一个真实服务端，验证登录、CSRF、记分、手动突显、API 令牌与 MCP 调用。发布到 npm 的包不包含测试与服务端。

## License

MIT
