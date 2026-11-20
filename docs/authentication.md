# 鉴权与远程部署

本版本内置账号、角色、会话与 API 令牌。服务端是最终权限边界，管理端隐藏按钮只是体验优化。

## 角色

| 角色 | 能力 |
|---|---|
| `admin` 管理员 | 全部功能：项目/人员/团队、设置、主题、布局、资源库、导入导出备份、用户/会话/令牌 |
| `operator` 操作员 | 记分、撤销记分（不含重置分数、倒计时、设置、布局、主题、资源库、项目管理） |
| `viewer` 只读 | 登录后可查看管理端与 REST 读接口，不能执行任何 op |
| 匿名 | 显示端公开只读：接收 WS 快照、读取 `/api/state` 与主题详情；不能写 |

显示端 `?edit=1` 的布局编辑需要管理员登录；普通投屏（不带 `edit=1`）不受影响。匿名 WS 快照包含全部项目数据，这是公开显示端的既有语义。

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

Electron 每次启动先显示模式选择页：

- **本地模式**：内嵌服务端，只绑定 `127.0.0.1`，关闭鉴权（原行为）。
- **远程模式**：
  - 管理端填写：远程服务器根地址、账号、密码。Electron 调用远程 `/api/v1/auth/login` 登录，把会话 Cookie 写入 Electron 默认会话，再加载远程 `/admin`。
  - 显示端填写：完整显示端网址。显示端窗口是无标签页、无地址栏的浏览器，直接加载该网址；显示端仍是公开只读。
  - 只保存服务器地址、账号、显示端网址，**不保存密码**；密码只用于本次登录。
  - 非本机服务器地址必须 HTTPS；显示端网址允许 HTTP。
  - 自签证书需要先让系统/Electron 信任；登录请求由 Node 发出，必要时通过 `NODE_EXTRA_CA_CERTS` 指向自签 CA。
- 运行中切换：管理端顶栏「切换模式」按钮（手机端在「更多」里）或应用菜单「服务器 → 退出到欢迎页（切换模式）…」（`Ctrl/Cmd+Shift+M`）。当前管理/显示窗口会关闭，回到欢迎页重新选择；本地服务端会保留复用，不会丢数据。
- 环境变量可预填启动页：`SCOREBOARD_MODE=remote`、`SCOREBOARD_REMOTE_URL`、`SCOREBOARD_USERNAME`、`SCOREBOARD_DISPLAY_URL`。
- 登录 Cookie 存在 Electron 默认会话中，重启后仍保持登录，直到服务端会话过期或登出；启动页仍会要求输入密码以完成本次远程连接。
