# REST API v1

完整的 HTTP 管理接口，覆盖项目、人员、团队、分数、设置、运行态、主题库、主题子资源、主题草稿、导入导出、上传、备份与低层 `op` 逃生通道。

> **安全提示：本版本已启用鉴权。** 公开读取仅限健康检查、版本、全量状态与主题详情；其余读接口至少需要 `viewer`，写接口按角色限制。Cookie 写请求需要 `X-CSRF-Token`，自动化建议使用 API 令牌。详见 [authentication.md](authentication.md)。

- 基地址：`http://<host>:<port>/api/v1`
- 内容类型：除上传/下载外均为 `application/json; charset=utf-8`
- 实时同步：写操作经唯一写入口 `applyOp` 落库，并通过现有 WebSocket `/ws` 广播新状态（唯一例外是 `POST /projects/import`：它需要先清洗导入数据并重映射资产，完成后同样落盘并广播）
- 机器可读契约：`GET /api/v1/openapi.json`（OpenAPI 3.1）

## 响应格式

成功：

```json
{
  "data": { "id": "pr_xxx" },
  "meta": { "requestId": "r_xxx", "revision": 3 }
}
```

失败：

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "人员不存在",
    "details": {}
  },
  "meta": { "requestId": "r_xxx" }
}
```

`meta.revision` 只在主题、主题草稿等带乐观并发的资源上出现。`meta.requestId` 可用于对照服务端日志。

## 状态码

| 状态 | 含义 |
|---|---|
| 200 / 201 / 204 | 成功 / 已创建 / 无内容 |
| 400 | 参数或 `op` 非法（`OpError`） |
| 403 | 功能被设置关闭（`FEATURE_DISABLED`）或浏览器 Origin 不被允许（`ORIGIN_NOT_ALLOWED`） |
| 404 | 项目 / 人员 / 团队 / 主题 / 图层 / 节点不存在 |
| 409 | revision 冲突（`CONFLICT`），`details.currentRevision` 为当前值 |
| 413 | 请求体超限 |
| 422 | 设置或主题设置含未知键（`details.unknownKeys`） |
| 428 | 主题写操作缺少 revision（`PRECONDITION_REQUIRED`） |
| 500 | 未预期内部错误 |

## 乐观并发（主题与草稿）

主题库、主题子资源和项目主题草稿都是多端可能同时编辑的资源。

- 写操作必须带 `If-Match: "<revision>"` 或查询参数 `?revision=<n>`；
- 缺少 → `428`；版本落后 → `409`，响应 `details.currentRevision` 给出服务端当前版本；
- 成功后响应头与 `meta.revision` 返回新版本；
- 子资源 `PATCH` 表示**整段替换**该子资源；单个图层、节点、控件请用 `PUT` / `DELETE` 子路径，避免覆盖他人修改。

```bash
curl -X PATCH http://localhost:3000/api/v1/themes/th_x/layers \
  -H 'Content-Type: application/json' \
  -H 'If-Match: "2"' \
  -d '{"layers":[{"name":"背景","nodes":[]}]}'
# → 200, meta.revision = 3
```

草稿首次保存不需要 revision；已有草稿后必须带，否则 `428`。

## 鉴权

| 方法 | 路径 | 访问 | 说明 |
|---|---|---|---|
| GET | `/auth/status` | 公开 | 登录状态、初始化状态；已登录时会补发 `ssb_csrf` |
| POST | `/auth/setup` | 公开（仅零用户 + 直接 loopback） | 创建首个管理员并登录 |
| POST | `/auth/login` | 公开 | `{ username, password, remember }` |
| POST | `/auth/logout` | 公开 | 吊销当前会话并清 Cookie |
| GET | `/auth/me` | 登录 | 当前用户 |
| POST | `/auth/password` | 登录 | 修改自己的密码 |
| GET | `/auth/sessions` | 登录 | 自己的会话；admin 可 `?userId=` |
| DELETE | `/auth/sessions/:id` | 登录 | 吊销会话 |
| POST | `/auth/logout-all` | 登录 | 退出其他设备 |
| GET/POST | `/auth/tokens` | 登录 | 自己的令牌（创建时明文只返回一次） |
| DELETE | `/auth/tokens/:id` | 登录 | 吊销令牌 |
| GET/POST | `/auth/users` | admin | 用户列表 / 创建用户 |
| PATCH/DELETE | `/auth/users/:id` | admin | 更新（角色/显示名/停用）或删除 |
| POST | `/auth/users/:id/password` | admin | 重置密码并吊销该用户全部会话/令牌 |
| GET | `/auth/users/:id/sessions` | admin | 用户会话 |
| DELETE | `/auth/users/:id/sessions/:sessionId` | admin | 吊销用户会话 |
| GET/POST | `/auth/users/:id/tokens` | admin | 用户令牌 |
| DELETE | `/auth/users/:id/tokens/:tokenId` | admin | 吊销用户令牌 |

- 会话 Cookie：`ssb_session`，HttpOnly、`SameSite=Lax`、`Path=/`；CSRF Cookie：`ssb_csrf`（JS 可读）。
- 非 GET 的 Cookie 请求需要 `X-CSRF-Token`；`Authorization: Bearer ssb_...` 豁免。
- 公开读：`/health`、`/version`、`/state`、`/themes/:themeId`。
- 其余 GET 至少需要 `viewer`；写操作默认需要 `admin`；记分相关写接口允许 `operator`。
- `/mcp` 仅管理员。

## 端点

路径均相对于 `/api/v1`。`:param` 为路径参数。

### 元信息

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康状态（无需鉴权，供探活） |
| GET | `/version` | 名称与版本 |
| GET | `/state` | 全量热状态（项目、人员、团队、分数、设置、主题摘要） |
| GET | `/runtime` | 全部项目的撤销栈、分数日志、倒计时 |
| GET | `/endpoints` | 发现 REST 与 MCP 端点 |
| GET | `/openapi.json` | OpenAPI 3.1 文档 |

### 项目

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects` | 列出全部项目 |
| POST | `/projects` | 新建项目，body `{ "name": "名称" }` |
| GET | `/projects/:projectId` | 项目详情与设置 |
| PATCH | `/projects/:projectId` | 重命名，body `{ "name": "新名称" }` |
| DELETE | `/projects/:projectId` | 删除项目（至少保留一个） |

### 人员

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/:projectId/people` | 列表，支持 `?q=`、`?teamId=` |
| POST | `/projects/:projectId/people` | 新增，body `{ "name", "teamId?", "bio?" }` |
| POST | `/projects/:projectId/people/batch` | 批量新增，body `{ "names": ["甲","乙"] }`，自动去重 |
| GET | `/projects/:projectId/people/:personId` | 单个人人员 |
| PATCH | `/projects/:projectId/people/:personId` | 改姓名/头像/简介/团队 |
| DELETE | `/projects/:projectId/people/:personId` | 删除人员 |
| POST | `/projects/:projectId/people/:personId/move` | 上移/下移，body `{ "direction": "up" \| "down" }` |
| PUT | `.../people/:personId/bio` | 设置简介，body `{ "bio": "…" }` |
| PUT | `.../people/:personId/avatar` | 设置头像，body `{ "avatar": "url" \| null }` |
| PUT | `.../people/:personId/card-image` | 设置卡面，body `{ "cardImage": "url" \| null }` |
| PUT | `.../people/:personId/team` | 设置团队，body `{ "teamId": "tm_x" \| null }` |
| PUT | `.../people/:personId/layout` | 设置自由布局，body `{ "layout": {…} \| null }` |
| PUT | `.../people/:personId/member-layout` | 设置成员小卡布局，body `{ "layout": {…} \| null }` |

### 团队

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/:projectId/teams` | 团队列表（含成员与总分） |
| POST | `/projects/:projectId/teams` | 新增，body `{ "name", "bio?" }` |
| GET | `/projects/:projectId/teams/:teamId` | 团队与成员 |
| PATCH | `/projects/:projectId/teams/:teamId` | 改名称/头像/简介 |
| DELETE | `/projects/:projectId/teams/:teamId` | 删除团队（成员自动移出） |
| POST | `/projects/:projectId/teams/:teamId/move` | 上移/下移，body `{ "direction": "up" \| "down" }` |
| PUT | `.../teams/:teamId/bio` | 设置简介 |
| PUT | `.../teams/:teamId/avatar` | 设置头像 |
| PUT | `.../teams/:teamId/card-image` | 设置卡面 |
| PUT | `.../teams/:teamId/layout` | 设置团队自由布局 |

### 分数与运行态

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/projects/:projectId/people/:personId/score/add` | 加减分，body `{ "delta": 5 }`；body 可省略 `projectId`/`personId` |
| POST | `/projects/:projectId/people/:personId/score/set` | 直接设分，body `{ "score": 10 }` |
| POST | `/projects/:projectId/teams/:teamId/score/add` | 团队全员加减分，body `{ "delta": 2 }` |
| POST | `/projects/:projectId/scores/reset` | 重置本局全部分数 |
| GET | `/projects/:projectId/runtime` | 撤销栈、分数日志、倒计时 |
| POST | `/projects/:projectId/runtime/undo` | 撤销最近一步记分 |
| POST | `/projects/:projectId/runtime/undo-to` | 连续撤销直到只剩 `keep` 条，body `{ "keep": 0 }` |
| POST | `/projects/:projectId/runtime/countdown/start` | 启动倒计时 |
| POST | `/projects/:projectId/runtime/countdown/pause` | 暂停 |
| POST | `/projects/:projectId/runtime/countdown/resume` | 继续 |
| POST | `/projects/:projectId/runtime/countdown/reset` | 重置 |

### 设置与布局

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/:projectId/settings` | 全部设置 |
| PATCH | `/projects/:projectId/settings` | 批量修改，body `{ "patch": { "accent": "#112233" } }`；未知键 `422` |
| POST | `/projects/:projectId/layout/reset` | 清空全部人员/团队自由布局 |

设置键与范围见 `GET /openapi.json` 或管理端「排版设置」。旧 WebSocket `updateSettings` 会静默忽略未知键；REST 会明确拒绝，便于原生客户端尽早发现拼写错误。

### 主题库

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/themes` | 主题摘要列表 |
| POST | `/themes` | 新建空主题，body `{ "name": "主题名" }` |
| GET | `/themes/:themeId` | 完整主题（含 revision） |
| PATCH | `/themes/:themeId` | 整体替换主题（需 revision） |
| DELETE | `/themes/:themeId` | 删除并解绑项目（需 revision） |
| POST | `/themes/:themeId/duplicate` | 复制 |
| POST | `/themes/:themeId/rename` | 重命名，body `{ "name": "新名" }`（需 revision） |
| POST | `/themes/import` | 导入主题文本/对象，返回新 ID |
| POST | `/themes/:themeId/apply` | 应用到项目，body `{ "projectId": "pr_x" }` |

### 主题子资源（全部需 revision）

| 方法 | 路径 | 语义 |
|---|---|---|
| GET / PATCH | `/themes/:themeId/meta` | 元数据；PATCH 整段替换 |
| GET / PATCH | `/themes/:themeId/canvas` | 画布；PATCH 整段替换 |
| GET / PATCH | `/themes/:themeId/layers` | 图层与节点；PATCH 整段替换 |
| GET / PUT / DELETE | `/themes/:themeId/layers/:layerId` | 单个图层 |
| PUT / DELETE | `/themes/:themeId/layers/:layerId/nodes/:nodeId` | 单个节点，body `{ "node": {…} }` |
| GET / PATCH | `/themes/:themeId/widgets` | 控件；PATCH 整段替换 |
| PUT / DELETE | `/themes/:themeId/widgets/:widgetId` | 单个控件，body `{ "widget": {…} }` |
| GET / PATCH | `/themes/:themeId/settings` | 视觉设置；未知键 `422` |
| GET / PATCH | `/themes/:themeId/script` | 沙箱绘制脚本 |

### 项目主题草稿

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/:projectId/theme-draft` | 读取草稿（可能为 `null`） |
| PATCH | `/projects/:projectId/theme-draft` | 保存草稿，body `{ "theme": {…} }`；已有草稿需 revision |
| DELETE | `/projects/:projectId/theme-draft` | 删除草稿 |
| POST | `/projects/:projectId/theme-draft/apply` | 发布到主题库并应用 |

### 导入导出、上传、备份

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects/:projectId/export` | 导出项目 JSON，`?assets=1` 内联资产 |
| POST | `/projects/import` | 导入项目，创建新项目 |
| GET | `/projects/:projectId/scores.csv` | 导出分数 CSV |
| POST | `/assets/images` | 上传图片：请求体为原始二进制，`Content-Type` 写图片类型 |
| POST | `/assets/sounds` | 上传音频：原始二进制 |
| GET | `/assets` | 列出已上传资产 |
| GET | `/backups` | 列出备份 |
| POST | `/backups/run` | 立即备份 |
| GET | `/orphans` | 扫描孤儿文件 |
| POST | `/orphans/cleanup` | 清理孤儿，body 必须显式 `{ "dryRun": true }` 或 `false` |

上传示例：

```bash
curl -X POST http://localhost:3000/api/v1/assets/images \
  -H 'Content-Type: image/png' \
  --data-binary @logo.png
```

### 低层逃生通道

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/ops` | body `{ "op": "addScore", "payload": {…} }` |
| POST | `/projects/:projectId/ops` | 同上，自动注入 `projectId` |

`op` 必须在 `server/ops.js` 的白名单中，参数校验与 WebSocket 完全一致。适合原生客户端在 REST 尚未封装新功能时过渡；常规开发优先用具名端点。

```bash
curl -X POST http://localhost:3000/api/v1/projects/pr_x/ops \
  -H 'Content-Type: application/json' \
  -d '{"op":"addScore","payload":{"personId":"p_1","delta":2}}'
```

## 兼容性

- 旧接口 `/api/*`（health/state/themes/version/backup 等）与 WebSocket `/ws` 完全保留；
- REST 只新增挂载，不改数据格式、存储后端或 Electron 启动方式；
- 除项目导入外，所有写操作都走 `applyOp`；REST 与大屏、管理端看到的是同一份实时状态。
- `If-Match: *` 按 HTTP 语义匹配任意当前版本；也支持 `W/"3"` 与 ETag 列表（取第一个）。
