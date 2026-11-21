import { useEffect, type JSX, type ReactNode } from 'react';
import { useAuthStore } from '../../shared/auth';
import { startConnection, stopConnection } from '../../shared/store';
import LoginPage from './LoginPage';
import SetupPage from './SetupPage';

/** 管理端启动门：加载 → 初始化 / 登录 → 已登录 */
export default function AuthGate({ children }: { children: ReactNode }): JSX.Element {
  const loading = useAuthStore((s) => s.loading);
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const authLost = useAuthStore((s) => s.authLost);
  const refresh = useAuthStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!status) return;
    if (status.authenticated) {
      startConnection({
        onAuthLost: () => useAuthStore.getState().markAuthLost(),
      });
    } else {
      stopConnection();
    }
  }, [status]);

  if (loading && !status) {
    return (
      <div className="auth-page">
        <div className="auth-card auth-loading">正在检查登录状态…</div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>无法连接服务器</h1>
          <p className="hint">{error || '请检查服务是否已启动。'}</p>
          <button className="btn primary auth-submit" type="button" onClick={() => { void refresh(); }}>
            重试
          </button>
        </div>
      </div>
    );
  }

  if (status.setupRequired) {
    if (status.setupAllowed) return <SetupPage />;
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-brand">ScreenScoreBoard</div>
          <h1>需要初始化管理员</h1>
          <p className="hint">
            尚未设置管理员密码。请在本机浏览器打开
            <code> http://127.0.0.1:3000/admin </code>
            完成初始化，或在服务器上设置 <code>ADMIN_PASSWORD</code> 后重启。
          </p>
          <p className="hint">
            公网或反向代理环境下不允许通过网页初始化，以免被陌生人抢先注册。
          </p>
        </div>
      </div>
    );
  }

  if (!status.authenticated) {
    return <LoginPage authLost={authLost} />;
  }

  return (
    <>
      {status.openAccess && (
        <div className="open-access-banner" role="status">
          开放模式：未启用登录，任何能访问本服务的人都拥有管理员权限
        </div>
      )}
      {children}
    </>
  );
}
