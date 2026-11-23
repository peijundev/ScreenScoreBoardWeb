import { useRef, useState, type JSX } from 'react';
import type { Project } from '../../shared/types';
import type { AuthUser } from '../../shared/auth';
import { authFetch, useAuthStore } from '../../shared/auth';
import { useAppStore } from '../../shared/store';
import { toast } from '../../shared/ui';
import AdminThemePicker from './AdminThemePicker';

interface Props {
  projects: Project[];
  user: AuthUser | null;
  authEnabled: boolean;
  openAccess: boolean;
  isAdmin: boolean;
  onSelectProject: (id: string) => void;
  onOpenAccount: () => void;
  onOpenStorage: () => void;
}

type Busy = 'create' | 'import' | null;
type Notice = { type: 'ok' | 'error'; text: string };

/** 零项目时的欢迎页：新建/导入项目、整库导入、主题与账号入口。 */
export default function WelcomeScreen({
  projects,
  user,
  authEnabled,
  openAccess,
  isAdmin,
  onSelectProject,
  onOpenAccount,
  onOpenStorage,
}: Props): JSX.Element {
  const sendOp = useAppStore((s) => s.sendOp);
  const logout = useAuthStore((s) => s.logout);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  async function createProject(): Promise<void> {
    if (busy) return;
    const value = name.trim() || '新项目';
    setBusy('create');
    setNotice(null);
    try {
      const result = await sendOp('addProject', { name: value }) as { projectId?: string };
      setName('');
      setNotice({ type: 'ok', text: `项目「${value}」已创建` });
      if (result?.projectId) onSelectProject(result.projectId);
    } catch (err) {
      setNotice({ type: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function importProject(): Promise<void> {
    const file = importFileRef.current?.files?.[0];
    if (!file || busy) return;
    setBusy('import');
    setNotice(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        throw new Error('文件不是有效的项目 JSON');
      }
      const res = await authFetch('/api/v1/projects/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const payload = await res.json().catch(() => ({})) as {
        data?: { projectId?: string; name?: string };
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(payload?.error?.message || '项目导入失败');
      const id = payload?.data?.projectId;
      setNotice({ type: 'ok', text: `项目「${payload?.data?.name || '导入项目'}」已导入` });
      if (id) onSelectProject(id);
    } catch (err) {
      setNotice({ type: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
      if (importFileRef.current) importFileRef.current.value = '';
    }
  }

  return (
    <div className="welcome-screen">
      <div className="welcome-brand">
        <div className="welcome-logo" aria-hidden="true">▦</div>
        <h1>ScreenScoreBoard</h1>
        <p>计分板管理端</p>
        <span className="hint">还没有项目，先创建一个开始使用。</span>
      </div>

      <div className="welcome-grid">
        <section className="welcome-card">
          <h2>开始</h2>
          {isAdmin ? (
            <div className="welcome-actions">
              <form
                className="welcome-create"
                onSubmit={(e) => { e.preventDefault(); void createProject(); }}
              >
                <input
                  type="text"
                  maxLength={30}
                  placeholder="新项目名称"
                  aria-label="新项目名称"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <button className="btn primary" type="submit" disabled={busy !== null}>
                  {busy === 'create' ? '创建中…' : '新建项目'}
                </button>
              </form>
              <button
                className="welcome-action"
                type="button"
                disabled={busy !== null}
                onClick={() => importFileRef.current?.click()}
              >
                <span>导入项目…</span>
                <span className="hint">从项目导出 JSON 创建新项目</span>
              </button>
              <input
                ref={importFileRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={() => { void importProject(); }}
              />
              <button
                className="welcome-action"
                type="button"
                disabled={busy !== null}
                onClick={onOpenStorage}
              >
                <span>整库导入…</span>
                <span className="hint">从存储后端导出的 JSON / SQLite / TXT 恢复</span>
              </button>
              <a className="welcome-action" href="/display-v2" target="_blank" rel="noreferrer">
                <span>打开显示端</span>
                <span className="hint">当前无项目时显示等待画面</span>
              </a>
            </div>
          ) : (
            <p className="hint">暂无项目，请联系管理员创建或导入项目。</p>
          )}
        </section>

        <section className="welcome-card">
          <h2>最近项目</h2>
          {projects.length === 0 ? (
            <p className="hint">还没有项目</p>
          ) : (
            <ul className="welcome-recent-list">
              {projects.slice(0, 8).map((project) => (
                <li key={project.id}>
                  <button
                    className="welcome-recent-item"
                    type="button"
                    onClick={() => onSelectProject(project.id)}
                  >
                    {project.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {notice && (
        <div className={'welcome-notice ' + notice.type} role="status">{notice.text}</div>
      )}

      <footer className="welcome-footer">
        <AdminThemePicker wide />
        {authEnabled && user && !openAccess && (
          <div className="welcome-account">
            <span className="hint">
              {user.username} · {user.role === 'admin' ? '管理员' : user.role === 'operator' ? '操作员' : user.role === 'member' ? '队员' : '只读'}
            </span>
            <button className="btn small" type="button" onClick={onOpenAccount}>
              账号与安全
            </button>
            <button
              className="btn small danger"
              type="button"
              onClick={() => { void logout().catch((err: Error) => toast(err.message)); }}
            >
              退出登录
            </button>
          </div>
        )}
        {openAccess && <span className="hint">开放模式：所有访问者拥有管理员权限</span>}
        {!authEnabled && <span className="hint">本机模式（未启用鉴权）</span>}
      </footer>
    </div>
  );
}
