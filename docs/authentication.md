# 鉴权与远程部署

本版本内置账号、角色、会话与 API 令牌。服务端是最终权限边界，管理端隐藏按钮只是体验优化。

运行环境要求 **Node 24+**（`engines.node: ">=24"`）。systemd 部署的宿主机需要自行安装 Node 24+；Docker 镜像默认使用 `node:24-bookworm-slim`，可用 `--build-arg NODE_VERSION=24.22.1` 固定小版本。

## Electron 本机模式与局域网共享

Electron 启动器的「本地模式」默认只监听 `127.0.0.1`，不启用登录。需要在局域网共享时：

1. 在启动器本地模式中勾选「启用登录（局域网共享）」，再进入本地模式。
2. 内置服务端会改为监听 `0.0.0.0` 并启用账号鉴权；Electron 窗口仍通过 `127.0.0.1` 访问。
3. 首次启用时先在本窗口完成管理员初始化（网页初始化只允许直接 loopback），其他设备打开 `http://本机IP:端口/admin` 登录。
4. 局域网管理端/显示端地址可在 Electron 菜单「帮助 → 关于」中查看；启动器启动后也会显示局域网管理端地址。
5. 修改该开关后需要退出并重新启动应用才能生效（监听地址与鉴权在服务端启动时固定）。

默认保持「仅本机、无需登录」；启用后请配合可信局域网、防火墙或 VPN 使用，不要在不可信网络直接暴露。

## 角色

| 角色 | 能力 |
|---|---|
| `admin` 管理员 | 全部功能：项目/人员/团队、设置、主题、布局、资源库、导入导出备份、用户/会话/令牌 |
| `operator` 操作员 | 记分、撤销记分、手动突显（不含重置分数、倒计时、设置、布局、主题、资源库、项目管理） |
| `member` 队员 | 账号必须绑定一个项目与该项目中的一名人员；只能执行管理员为**该账号**配置的人员菜单按钮（加分/加票、突显），不能直接调用记分、突显、撤销或改设置 |
| `viewer` 只读 | 登录后可查看管理端与 REST 读接口，不能执行任何 op |
| 匿名 | 显示端公开只读：接收 WS 快照、读取 `/api/state` 与主题详情；不能写 |

队员按钮的服务端边界：队员端只发送 `memberAction { projectId, buttonId }`，动作类型、目标人员/团队、分值与突显时长全部来自当前项目设置里**该账号对应的 `memberMenus` 条目**；客户端额外字段会被忽略。服务端同时校验队员账号的 `memberProjectId` 必须等于请求项目，账号不能跨项目执行菜单。管理员/操作员按角色阈值也可以调用该 op，但他们本来就有等价权限。`POST /api/v1/projects/:projectId/member-action` 是队员可用的 REST 入口。

队员账号绑定字段为 `memberProjectId` / `memberPersonId`，创建队员时必须同时提供，且人员必须存在于该项目；角色不再是队员时会自动清空绑定。

抢答模式：`buzzStart` / `buzzEnd` 仅管理员可执行；队员只能调用 `buzzPress`，服务端按账号绑定的项目、人员和菜单校验，并且只有第一个有效请求获胜。抢答进行中 `memberAction` 会被拒绝，结束后恢复。

> 回滚提示：旧版本服务端不认识 `member` 角色，含队员账号的 `auth.json` 会导致启动失败。回滚旧版本前，必须先用新版本把队员改成 `viewer`/`operator`，或从备份恢复 `auth.json`。

显示端 `?edit=1` 的布局编辑需要管理员登录；普通投屏（不带 `edit=1`）不受影响。匿名 WS 快照包含全部项目数据，这是公开显示端的既有语义。

## 开放访问（不使用登录系统）

部署模式下，管理员可以在管理端 **账号与安全 → 访问控制** 中关闭登录系统。关闭后：

- `/admin`、REST API、WebSocket 写操作与 MCP 都**不再需要登录**，所有访问者自动获得管理员权限。
- 显示端行为不变，仍然公开只读。
- `/api/v1/auth/status` 返回 `authEnabled: true, openAccess: true, requireLogin: false`，用户为虚拟的「开放模式」管理员。
- 设置写入 `DATA_DIR/auth.json` 的 `settings.requireLogin`，重启后保留。

安全边界：

- **任何能访问端口的人都能改分数、设置、用户和令牌。** 仅建议用于可信局域网、临时活动或 VPN 内部署。
- 公网部署请使用 HTTPS、反向代理访问控制或防火墙限制来源。
- 必须先有至少一个启用中的管理员，服务端才允许关闭登录；避免重新启用后无人可登录。
- 重新启用登录后，开放模式建立的 WebSocket 连接会立即关闭（4401），需要重新认证；已有会话 Cookie 仍然有效。
- 开放模式下任何访问者都可以重新启用登录（因为都按管理员处理），这是该模式的固有语义。

API：

```bash
curl -H "Authorization: Bearer ssb_xxx" http://127.0.0.1:3000/api/v1/auth/access

curl -X PATCH http://127.0.0.1:3000/api/v1/auth/access \
  -H "Authorization: Bearer ssb_xxx" \
  -H 'Content-Type: application/json' \
  -d '{"requireLogin": false}'
```

## 首次初始化

两种方式任选其一：

1. **环境变量**（推荐用于远程/容器）：

   ```bash
   ADMIN_USERNAME=admin ADMIN_PASSWORD='至少 8 位的强密码' npm start
   ```

   仅在没有任何用户时生效；已有用户时忽略，不会重置密码。

2. **本机向导**：未设置 `ADMIN_PASSWORD` 时，在服务器本机浏览器打开 `http://127.0.0.1:3000/admin`，按页面创建首个管理员。只接受直接 loopback 请求；带 `X-Forwarded-For` / `Forwarded` 或启用了 `TRUST_PROXY` 时网页初始化会被拒绝，必须使用环境变量。

初始化完成后 setup 永久关闭；最后一个启用中的管理员不能被停用、降级或删除。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | 首次初始化管理员用户名 |
| `ADMIN_PASSWORD` | 空 | 仅首次初始化使用 |
| `ADMIN_PASSWORD_FILE` | 空 | 从文件读取初始密码，优先于 `ADMIN_PASSWORD`；适合 systemd/Docker secret |
| `SESSION_TTL_HOURS` | `24` | 普通会话有效期 |
| `SESSION_REMEMBER_DAYS` | `30` | 「记住我」有效期 |
| `COOKIE_SECURE` | `auto` | `auto` / `true` / `false` |
| `TRUST_PROXY` | `0` | 置于 HTTPS 反向代理后设为 `1` |
| `ALLOWED_ORIGINS` | 空 | 额外允许的 Origin，逗号分隔 |
| `TLS_CERT_FILE` | 空 | Node 内置 HTTPS 证书 |
| `TLS_KEY_FILE` | 空 | Node 内置 HTTPS 私钥 |
| `TLS_PASSPHRASE` | 空 | 私钥口令 |
| `SCOREBOARD_TOKEN` | 空 | stdio MCP / 自动化客户端令牌 |

应用内**不做任何 WS/HTTP 限流**：没有失败计数、锁定、退避、验证码或 429。现有 body 上限、`WS_MAX_CONNECTIONS` 与 WS 背压属于容量保护。密码哈希（scrypt）的成本是密码学必需，不属于限流。

## Cookie 与 CSRF

- `ssb_session`：HttpOnly、`SameSite=Lax`、`Path=/`；HTTPS 下加 `Secure`；勾选「记住我」时有 `Max-Age`。
- `ssb_csrf`：非 HttpOnly，供页面读取后作为 `X-CSRF-Token` 发送；与会话里的 token 做恒时比较。
- Cookie 认证的非安全方法必须带 `X-CSRF-Token`；Bearer 认证豁免；登录、初始化、登出豁免但仍校验 Origin。
- 所有非 GET 请求校验 Origin/Referer；跨站 WebSocket 直接拒绝。
- 认证/用户/会话/令牌响应带 `Cache-Control: no-store`。

## API 摘要

公开：

- `GET /api/v1/auth/status`
- `POST /api/v1/auth/setup`（仅零用户 + 直接 loopback）
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/health`、`GET /api/version`、`GET /api/state`
- `GET /api/v1/health`、`/api/v1/version`、`/api/v1/state`
- `GET /api/themes/:id`、`GET /api/v1/themes/:themeId`
- `/display`、`/avatars/*`、`/sounds/*`、静态资源

登录后可管理自己的密码/会话/令牌：

- `GET /api/v1/auth/me`
- `POST /api/v1/auth/password`
- `GET /api/v1/auth/sessions`、`DELETE /api/v1/auth/sessions/:id`、`POST /api/v1/auth/logout-all`
- `GET /api/v1/auth/tokens`、`POST /api/v1/auth/tokens`、`DELETE /api/v1/auth/tokens/:id`

仅管理员：

- `GET/POST /api/v1/auth/users`
- `PATCH/DELETE /api/v1/auth/users/:id`
- `POST /api/v1/auth/users/:id/password`
- `GET /api/v1/auth/users/:id/sessions`、`DELETE /api/v1/auth/users/:id/sessions/:sessionId`
- `GET/POST /api/v1/auth/users/:id/tokens`、`DELETE /api/v1/auth/users/:id/tokens/:tokenId`

其余 REST 路由默认 GET 需要 viewer、写操作需要 admin；记分相关写路由允许 operator。`/api/v1/ops` 与 `/projects/:id/ops` 在路由层允许 operator，但最终由 `applyOp` 按 op 复核，无法借逃生通道提权。HTTP `/mcp` 仅管理员（建议用 Bearer 令牌）。

## API 令牌

管理员或用户可在「账号与安全 → API 令牌」创建，明文只显示一次。使用：

```bash
curl -H "Authorization: Bearer ssb_xxx" http://127.0.0.1:3000/api/v1/state
```

stdio MCP：

```bash
SCOREBOARD_URL=https://score.example.com \
SCOREBOARD_TOKEN=ssb_xxx \
node bin/screenscoreboard-mcp.js
```

令牌权限等于所属用户角色；用户停用/删除/重置密码时自动吊销。令牌只存 SHA-256，不存明文。

## HTTPS 与反向代理

推荐让 Caddy/Nginx 终止 TLS，Node 只监听本机：

```bash
HOST=127.0.0.1 PORT=3000 TRUST_PROXY=1 COOKIE_SECURE=auto ADMIN_PASSWORD='...' npm start
```

Caddy：

```caddyfile
score.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Nginx：

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

要点：

- 反代必须保留原始 `Host`（或传 `X-Forwarded-Host`），否则 Origin 校验可能 403。
- `TRUST_PROXY=1` 时不要在公网直接暴露 Node 端口。
- 反代不传 `X-Forwarded-Proto` 时，直接设 `COOKIE_SECURE=true`。
- WebSocket 必须转发 `Upgrade` / `Connection`。

也可以让 Node 直接终止 TLS：

```bash
TLS_CERT_FILE=/etc/ssl/scoreboard/fullchain.pem \
TLS_KEY_FILE=/etc/ssl/scoreboard/privkey.pem \
ADMIN_PASSWORD='...' npm start
```

证书续期由部署者负责；反代方案通常更省心。

## 忘记密码

服务停止后在本机执行：

```bash
npm run auth:reset -- --username admin
```

或非交互：

```bash
AUTH_RESET_PASSWORD='新密码' DATA_DIR=/var/lib/screenscoreboard node bin/screenscoreboard-auth.js --username admin
```

systemd 安装目录下（服务用户无登录 shell，直接用 node）：

```bash
sudo systemctl stop screenscoreboard
sudo -u scoreboard env DATA_DIR=/var/lib/screenscoreboard node /opt/screenscoreboard/bin/screenscoreboard-auth.js --username admin
sudo systemctl start screenscoreboard
```

Docker：

```bash
docker compose stop scoreboard
docker compose run --rm -it scoreboard npm run auth:reset -- --username admin
docker compose start scoreboard
```

CLI 会检查 `DATA_DIR/scoreboard.lock`，服务仍在运行时会拒绝，避免内存状态覆盖文件。`auth.json` 损坏时服务启动失败，请从备份恢复；不要静默删除。

## 备份与多实例

- 必须备份：`DATA_DIR/auth.json`（账号与令牌哈希）。
- 可选备份：`DATA_DIR/sessions.json`（不恢复则所有人重新登录）。
- 项目数据备份（`state.json` / 数据库快照）不包含账号。
- 本期鉴权按单实例设计：`auth.json` / `sessions.json` 是本地文件，Postgres/MySQL 共享 state 时各实例的用户/会话不共享。需要多实例时请使用粘性会话或后续共享存储方案。

## Electron

Electron 每次启动先显示模式选择页，分为三个入口：

- **本地模式**：内嵌服务端，只绑定 `127.0.0.1`，关闭鉴权（原行为）。
- **远程管理模式**：
  - 填写：远程服务器根地址、账号、密码。Electron 调用远程 `/api/v1/auth/login` 登录，把会话 Cookie 写入 Electron 默认会话，再加载远程 `/admin`。
  - 管理端里的显示端窗口默认使用服务器根地址 + `/display`，不再单独填写显示端网址。
  - 只保存服务器地址与账号，**不保存密码**；密码只用于本次登录。屏幕模式上次填写的显示端网址会保留用于回填，但不会改变管理端显示端 URL。
  - 非本机服务器地址必须 HTTPS。
  - 自签证书需要先让系统/Electron 信任；登录请求由 Node 发出，必要时通过 `NODE_EXTRA_CA_CERTS` 指向自签 CA。
- **远程屏幕模式**：
  - 只需要填写完整显示端网址（任意 http/https 页面，不要求与服务器同源）。
  - 无标签页、无地址栏的浏览器窗口直接加载该网址；不需要登录，显示端仍是公开只读。
- 运行中切换：管理端顶栏「切换模式」按钮（手机端在「更多」里）或应用菜单「服务器 → 退出到欢迎页（切换模式）…」（`Ctrl/Cmd+Shift+M`）。远程屏幕模式使用同一个菜单。当前管理/显示窗口会关闭，回到欢迎页重新选择；本地服务端会保留复用，不会丢数据。
- 环境变量可预填启动页：
  - 远程管理：`SCOREBOARD_MODE=remote-admin`、`SCOREBOARD_REMOTE_URL`、`SCOREBOARD_USERNAME`；旧值 `SCOREBOARD_MODE=remote` 会自动迁移为管理模式。
  - 远程屏幕：`SCOREBOARD_MODE=remote-display`、`SCOREBOARD_DISPLAY_URL`。
- 登录 Cookie 存在 Electron 默认会话中，重启后仍保持登录，直到服务端会话过期或登出；管理模式的启动页仍会要求输入密码，屏幕模式不需要。
- 旧配置 `electron-config.json` 中的 `mode: "remote"` 会自动读取为远程管理模式。
