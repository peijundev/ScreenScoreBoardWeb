import { useState, type JSX } from 'react';
import { useAuthStore } from '../../shared/auth';

export default function LoginPage({ authLost }: { authLost: boolean }): JSX.Element {
  const login = useAuthStore((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await login(username.trim(), password, remember);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={(e) => { void submit(e); }}>
        <div className="auth-brand">ScreenScoreBoard</div>
        <h1>管理员登录</h1>
        <p className="hint">登录后即可记分、管理项目与显示端。</p>
        {authLost && <div className="auth-notice">登录已失效，请重新登录。</div>}
        <label className="auth-field">
          <span>用户名</span>
          <input
            id="login-username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </label>
        <label className="auth-field">
          <span>密码</span>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="auth-check">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          记住我（30 天）
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button className="btn primary auth-submit login-submit" type="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
        <p className="hint auth-foot">
          忘记密码请联系部署者；本机首次使用请在本机打开管理端完成初始化。
        </p>
      </form>
    </div>
  );
}
