import { useState, type JSX } from 'react';
import { useAuthStore } from '../../shared/auth';

export default function SetupPage(): JSX.Element {
  const setup = useAuthStore((s) => s.setup);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    if (password.length < 8) {
      setError('密码至少 8 个字符');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await setup(username.trim(), password);
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
        <h1>首次初始化</h1>
        <p className="hint">
          创建第一个管理员账号。初始化完成后，这个页面会永久关闭。
        </p>
        <label className="auth-field">
          <span>管理员用户名</span>
          <input
            id="setup-username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </label>
        <label className="auth-field">
          <span>密码（至少 8 位）</span>
          <input
            id="setup-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="auth-field">
          <span>确认密码</span>
          <input
            id="setup-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button className="btn primary auth-submit setup-submit" type="submit" disabled={busy}>
          {busy ? '创建中…' : '创建管理员并进入'}
        </button>
      </form>
    </div>
  );
}
