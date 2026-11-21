import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  changePassword,
  createToken,
  createUser,
  deleteUser,
  getAccessSettings,
  listSessions,
  listTokens,
  listUsers,
  logoutAll,
  resetUserPassword,
  revokeSession,
  revokeToken,
  updateAccessSettings,
  updateUser,
  useAuthStore,
  type AccessSettings,
  type AuthUser,
  type Role,
  type SessionInfo,
  type TokenInfo,
} from '../../shared/auth';
import { toast } from '../../shared/ui';
import DialogShell from './DialogShell';
import { confirm, prompt } from './dialogs';

type Tab = 'access' | 'password' | 'sessions' | 'tokens' | 'users';

const roleLabel: Record<Role, string> = {
  admin: '管理员',
  operator: '操作员',
  viewer: '只读',
};

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString();
}

export default function AccountDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const status = useAuthStore((s) => s.status);
  const me = status?.user ?? null;
  const isAdmin = me?.role === 'admin';
  const openAccess = status?.openAccess === true;
  const [tab, setTab] = useState<Tab>(openAccess ? 'access' : isAdmin ? 'users' : 'sessions');
  const [access, setAccess] = useState<AccessSettings | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [createdToken, setCreatedToken] = useState('');
  const [busy, setBusy] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [tokenName, setTokenName] = useState('自动化令牌');
  const [tokenDays, setTokenDays] = useState('0');
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState<Role>('operator');

  const loadUsers = useCallback(async (): Promise<void> => {
    if (!isAdmin) return;
    try {
      setUsers(await listUsers());
    } catch (err) {
      toast((err as Error).message);
    }
  }, [isAdmin]);

  const loadSessions = useCallback(async (): Promise<void> => {
    try {
      setSessions(await listSessions(selectedUserId || undefined));
    } catch (err) {
      toast((err as Error).message);
    }
  }, [selectedUserId]);

  const loadTokens = useCallback(async (): Promise<void> => {
    try {
      setTokens(await listTokens(selectedUserId || undefined));
    } catch (err) {
      toast((err as Error).message);
    }
  }, [selectedUserId]);

  const loadAccess = useCallback(async (): Promise<void> => {
    if (!isAdmin) return;
    try {
      setAccess(await getAccessSettings());
    } catch (err) {
      toast((err as Error).message);
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    if (openAccess && isAdmin) setTab('access');
  }, [openAccess, isAdmin]);

  useEffect(() => {
    if (tab === 'access') void loadAccess();
    if (tab === 'sessions') void loadSessions();
    if (tab === 'tokens') void loadTokens();
  }, [tab, loadAccess, loadSessions, loadTokens]);

  async function setLoginRequired(requireLogin: boolean): Promise<void> {
    if (!requireLogin) {
      const ok = await confirm({
        title: '关闭登录系统（开放模式）',
        message: '关闭后任何能访问本服务的人都会自动获得管理员权限，可以修改分数、设置、用户与令牌。仅建议在可信局域网 / VPN 使用。确定关闭？',
        confirmText: '仍然开放',
        danger: true,
      });
      if (!ok) return;
    }
    setAccessBusy(true);
    try {
      const next = await updateAccessSettings(requireLogin);
      setAccess(next);
      await useAuthStore.getState().refresh();
      // WS 在切换登录模式时会重连；延迟再刷新一次，避免关闭连接的竞态覆盖状态
      window.setTimeout(() => { void useAuthStore.getState().refresh(); }, 400);
      toast(requireLogin ? '已启用登录系统' : '已关闭登录系统，当前完全开放');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setAccessBusy(false);
    }
  }

  async function savePassword(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast('密码已修改，其他设备已退出');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function makeToken(): Promise<void> {
    setBusy(true);
    try {
      const days = Number(tokenDays);
      const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;
      const created = await createToken({
        name: tokenName.trim() || '令牌',
        expiresAt,
        userId: isAdmin && selectedUserId ? selectedUserId : undefined,
      });
      setCreatedToken(created.token);
      setTokenName('自动化令牌');
      await loadTokens();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addUser(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    try {
      await createUser({
        username: newUsername.trim(),
        password: newUserPassword,
        role: newUserRole,
        displayName: newDisplayName.trim() || newUsername.trim(),
      });
      setNewUsername('');
      setNewDisplayName('');
      setNewUserPassword('');
      await loadUsers();
      toast('用户已创建');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(user: AuthUser, role: Role): Promise<void> {
    try {
      await updateUser(user.id, { role });
      await loadUsers();
      toast('角色已更新');
    } catch (err) {
      toast((err as Error).message);
    }
  }

  async function toggleDisabled(user: AuthUser): Promise<void> {
    try {
      await updateUser(user.id, { disabled: !user.disabled });
      await loadUsers();
      toast(user.disabled ? '用户已启用' : '用户已停用');
    } catch (err) {
      toast((err as Error).message);
    }
  }

  async function resetPassword(user: AuthUser): Promise<void> {
    const value = await prompt({
      title: '重置密码',
      label: '为「' + user.username + '」设置新密码（至少 8 位）',
      defaultValue: '',
    });
    if (!value) return;
    try {
      await resetUserPassword(user.id, value);
      toast('密码已重置，该用户所有会话与令牌已失效');
    } catch (err) {
      toast((err as Error).message);
    }
  }

  async function removeUser(user: AuthUser): Promise<void> {
    const ok = await confirm({
      title: '删除用户',
      message: '确定删除「' + user.username + '」？其会话与令牌会一并失效。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteUser(user.id);
      await loadUsers();
      toast('用户已删除');
    } catch (err) {
      toast((err as Error).message);
    }
  }

  const adminCount = users.filter((u) => u.role === 'admin' && !u.disabled).length;

  return (
    <DialogShell
      title="账号与安全"
      storageKey="accountDialog"
      defaultWidth={820}
      defaultHeight={650}
      onClose={onClose}
    >
      <div className="account-dialog">
        <div className="account-tabs">
          {isAdmin && (
            <button className={tab === 'access' ? 'active' : ''} type="button" onClick={() => setTab('access')}>
              访问控制
            </button>
          )}
          {isAdmin && (
            <button className={tab === 'users' ? 'active' : ''} type="button" onClick={() => setTab('users')}>
              用户管理
            </button>
          )}
          {!openAccess && (
            <button className={tab === 'sessions' ? 'active' : ''} type="button" onClick={() => setTab('sessions')}>
              会话
            </button>
          )}
          {!openAccess && (
            <button className={tab === 'tokens' ? 'active' : ''} type="button" onClick={() => setTab('tokens')}>
              API 令牌
            </button>
          )}
          {!openAccess && (
            <button className={tab === 'password' ? 'active' : ''} type="button" onClick={() => setTab('password')}>
              修改密码
            </button>
          )}
        </div>

        {tab === 'access' && isAdmin && (
          <div className="account-panel">
            <div className={'account-access-card' + (openAccess ? ' is-open' : '')}>
              <h3>{openAccess ? '开放模式（无需登录）' : '登录系统已启用'}</h3>
              <p className="hint">
                {openAccess
                  ? '当前任何能访问本服务的人都会自动获得管理员权限。适合可信局域网、临时活动或 VPN 内部署。'
                  : '访问管理端、API 写操作与 MCP 需要登录；显示端仍然公开只读。'}
              </p>
              <div className="account-access-actions">
                <button
                  className={'btn ' + (openAccess ? 'primary' : 'danger')}
                  type="button"
                  disabled={accessBusy || (access?.activeAdmins ?? 1) === 0}
                  onClick={() => { void setLoginRequired(openAccess); }}
                >
                  {openAccess ? '启用登录系统' : '关闭登录系统（完全开放）'}
                </button>
                <span className="hint">
                  启用中的管理员：{access?.activeAdmins ?? '—'} 个
                </span>
              </div>
            </div>
            <p className="hint">
              关闭登录系统前至少需要一个启用中的管理员；设置会写入 <code>auth.json</code> 并在重启后保留。
              重新启用登录后，开放模式建立的 WebSocket 连接会立即要求重新认证。
            </p>
            <p className="hint">
              安全提示：开放模式等同于把管理员权限交给所有访问者。公网部署请使用 HTTPS、
              反向代理访问控制或防火墙限制来源；活动结束后及时重新启用登录。
            </p>
          </div>
        )}

        {tab === 'users' && isAdmin && (
          <div className="account-panel">
            <form className="account-form" onSubmit={(e) => { void addUser(e); }}>
              <h3>新建用户</h3>
              <div className="account-form-row">
                <input
                  placeholder="用户名"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                />
                <input
                  placeholder="显示名（可选）"
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                />
                <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value as Role)}>
                  <option value="operator">操作员</option>
                  <option value="viewer">只读</option>
                  <option value="admin">管理员</option>
                </select>
                <input
                  type="password"
                  placeholder="初始密码（至少 8 位）"
                  value={newUserPassword}
                  onChange={(e) => setNewUserPassword(e.target.value)}
                />
                <button className="btn primary" type="submit" disabled={busy}>
                  创建
                </button>
              </div>
            </form>

            <div className="account-list">
              {users.map((user) => {
                const self = user.id === me?.id;
                const lastAdmin = user.role === 'admin' && !user.disabled && adminCount <= 1;
                return (
                  <div className={'account-row' + (user.disabled ? ' is-disabled' : '')} key={user.id}>
                    <div className="account-row-main">
                      <strong>{user.username}</strong>
                      {self && <span className="tag">我</span>}
                      {user.disabled && <span className="tag danger">已停用</span>}
                      <span className="hint">{user.displayName}</span>
                      <span className="hint">最后登录：{formatTime(user.lastLoginAt)}</span>
                    </div>
                    <div className="account-row-actions">
                      <select
                        value={user.role}
                        disabled={self || lastAdmin}
                        onChange={(e) => { void changeRole(user, e.target.value as Role); }}
                      >
                        {(['admin', 'operator', 'viewer'] as Role[]).map((role) => (
                          <option key={role} value={role}>{roleLabel[role]}</option>
                        ))}
                      </select>
                      <button
                        className="btn small"
                        type="button"
                        disabled={self || lastAdmin}
                        onClick={() => { void toggleDisabled(user); }}
                      >
                        {user.disabled ? '启用' : '停用'}
                      </button>
                      <button className="btn small" type="button" onClick={() => { void resetPassword(user); }}>
                        重置密码
                      </button>
                      <button
                        className="btn small"
                        type="button"
                        onClick={() => { setSelectedUserId(user.id); setTab('sessions'); }}
                      >
                        会话
                      </button>
                      <button
                        className="btn small"
                        type="button"
                        onClick={() => { setSelectedUserId(user.id); setTab('tokens'); }}
                      >
                        令牌
                      </button>
                      <button
                        className="btn small danger"
                        type="button"
                        disabled={self || lastAdmin}
                        onClick={() => { void removeUser(user); }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!openAccess && tab === 'sessions' && (
          <div className="account-panel">
            {isAdmin && (
              <div className="account-toolbar">
                <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}>
                  <option value="">我的会话</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.username} 的会话</option>
                  ))}
                </select>
                <button className="btn small" type="button" onClick={() => { void loadSessions(); }}>
                  刷新
                </button>
                {!selectedUserId && (
                  <button
                    className="btn small danger"
                    type="button"
                    onClick={() => {
                      void (async () => {
                        const ok = await confirm({
                          title: '退出其他设备',
                          message: '吊销当前账号除本机外的全部会话？',
                          confirmText: '全部退出',
                          danger: true,
                        });
                        if (!ok) return;
                        try {
                          const count = await logoutAll();
                          await loadSessions();
                          toast('已吊销 ' + count + ' 个会话');
                        } catch (err) {
                          toast((err as Error).message);
                        }
                      })();
                    }}
                  >
                    退出其他设备
                  </button>
                )}
              </div>
            )}
            <div className="account-list">
              {sessions.length === 0 && <p className="hint">没有活动会话</p>}
              {sessions.map((session) => (
                <div className="account-row" key={session.id}>
                  <div className="account-row-main">
                    <strong>{session.ip || '未知 IP'}</strong>
                    {session.current && <span className="tag">当前</span>}
                    <span className="hint">{session.userAgent || '未知设备'}</span>
                    <span className="hint">登录：{formatTime(session.createdAt)}</span>
                    <span className="hint">最后活跃：{formatTime(session.lastSeenAt)}</span>
                  </div>
                  <div className="account-row-actions">
                    <button
                      className="btn small danger"
                      type="button"
                      disabled={session.current}
                      onClick={() => {
                        void (async () => {
                          try {
                            await revokeSession(session.id);
                            await loadSessions();
                            toast('会话已吊销');
                          } catch (err) {
                            toast((err as Error).message);
                          }
                        })();
                      }}
                    >
                      吊销
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!openAccess && tab === 'tokens' && (
          <div className="account-panel">
            <div className="account-toolbar">
              {isAdmin && (
                <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}>
                  <option value="">我的令牌</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.username} 的令牌</option>
                  ))}
                </select>
              )}
              <input
                placeholder="令牌名称"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
              />
              <input
                className="account-days"
                type="number"
                min={0}
                max={3650}
                value={tokenDays}
                onChange={(e) => setTokenDays(e.target.value)}
                title="有效天数，0 表示长期"
              />
              <button className="btn primary" type="button" disabled={busy} onClick={() => { void makeToken(); }}>
                创建令牌
              </button>
            </div>
            <p className="hint">令牌只显示一次；用于脚本/MCP 的 Authorization: Bearer。</p>
            {createdToken && (
              <div className="account-token-once">
                <code>{createdToken}</code>
                <button
                  className="btn small"
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(createdToken).then(
                      () => toast('已复制'),
                      () => toast('复制失败，请手动选择'),
                    );
                  }}
                >
                  复制
                </button>
                <button className="btn small" type="button" onClick={() => setCreatedToken('')}>
                  关闭
                </button>
              </div>
            )}
            <div className="account-list">
              {tokens.length === 0 && <p className="hint">还没有令牌</p>}
              {tokens.map((token) => (
                <div className="account-row" key={token.id}>
                  <div className="account-row-main">
                    <strong>{token.name}</strong>
                    <span className="hint">创建：{formatTime(token.createdAt)}</span>
                    <span className="hint">最后使用：{formatTime(token.lastUsedAt)}</span>
                    <span className="hint">过期：{token.expiresAt ? formatTime(token.expiresAt) : '长期'}</span>
                  </div>
                  <div className="account-row-actions">
                    <button
                      className="btn small danger"
                      type="button"
                      onClick={() => {
                        void (async () => {
                          const ok = await confirm({
                            title: '吊销令牌',
                            message: '吊销后使用该令牌的脚本/设备会立即失效。',
                            confirmText: '吊销',
                            danger: true,
                          });
                          if (!ok) return;
                          try {
                            await revokeToken(token.id);
                            await loadTokens();
                            toast('令牌已吊销');
                          } catch (err) {
                            toast((err as Error).message);
                          }
                        })();
                      }}
                    >
                      吊销
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!openAccess && tab === 'password' && (
          <form className="account-panel account-password" onSubmit={(e) => { void savePassword(e); }}>
            <h3>修改我的密码</h3>
            <label className="auth-field">
              <span>当前密码</span>
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </label>
            <label className="auth-field">
              <span>新密码（至少 8 位）</span>
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </label>
            <label className="auth-field">
              <span>确认新密码</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
            <button className="btn primary" type="submit" disabled={busy}>
              保存
            </button>
          </form>
        )}
      </div>
    </DialogShell>
  );
}
