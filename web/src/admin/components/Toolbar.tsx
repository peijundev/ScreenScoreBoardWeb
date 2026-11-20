import { useEffect, useRef, useState, type JSX } from 'react';
import type { Project } from '../../shared/types';
import { useAppStore } from '../../shared/store';
import { toast } from '../../shared/ui';
import { confirm, prompt } from './dialogs';
import SoundQuickMenu from './SoundQuickMenu';

interface Props {
  project: Project | null;
  projects: Project[];
  connected: boolean;
  onSelectProject: (id: string) => void;
  onOpenSettings: () => void;
  onOpenFeatures: () => void;
  onOpenAssets: () => void;
  onOpenTheme: () => void;
  onOpenStudio: () => void;
}

interface VersionInfo {
  version: string;
  finalForTechStack?: boolean;
  frontend?: 'react' | 'missing';
}

export default function Toolbar({
  project,
  projects,
  connected,
  onSelectProject,
  onOpenSettings,
  onOpenFeatures,
  onOpenAssets,
  onOpenTheme,
  onOpenStudio,
}: Props): JSX.Element {
  const sendOp = useAppStore((s) => s.sendOp);
  const undoCount = useAppStore((s) =>
    project ? (s.runtime?.undoCounts[project.id] ?? 0) : 0,
  );
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem('admin-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    fetch('/api/version')
      .then((r) => (r.ok ? r.json() : null))
      .then((info: VersionInfo | null) => setVersion(info))
      .catch(() => {});
  }, []);

  useEffect(() => {
    document.body.dataset.theme = theme;
    try {
      localStorage.setItem('admin-theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  async function addProject(): Promise<void> {
    const name = await prompt({
      title: '新建项目',
      label: '每个项目是一个独立积分榜',
      defaultValue: '新项目',
    });
    if (!name?.trim()) return;
    sendOp('addProject', { name: name.trim() })
      .then((res) => {
        const id = (res as { projectId?: string }).projectId;
        if (id) onSelectProject(id);
      })
      .catch((err: Error) => toast(err.message));
  }

  async function renameProject(): Promise<void> {
    if (!project) return;
    const name = await prompt({ title: '重命名项目', defaultValue: project.name });
    if (!name?.trim() || name.trim() === project.name) return;
    sendOp('renameProject', { projectId: project.id, name: name.trim() }).catch((err: Error) =>
      toast(err.message),
    );
  }

  async function deleteProject(): Promise<void> {
    if (!project) return;
    const ok = await confirm({
      title: '删除项目',
      message: '确定删除项目「' + project.name + '」？其中的人员与团队也会一并删除。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    sendOp('deleteProject', { projectId: project.id }).catch((err: Error) => toast(err.message));
  }

  return (
    <header className="topbar">
      <h1>管理控制台</h1>
      <select
        className="project-select"
        value={project?.id ?? ''}
        onChange={(e) => onSelectProject(e.target.value)}
        title="切换项目"
      >
        {projects.length === 0 && <option value="">（无项目）</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button className="btn small" type="button" onClick={() => { void addProject(); }}>
        新建项目
      </button>
      <button className="btn small" type="button" onClick={() => { void renameProject(); }} disabled={!project}>
        重命名
      </button>
      <button className="btn small danger" type="button" onClick={() => { void deleteProject(); }} disabled={!project}>
        删除项目
      </button>
      <button className="btn small" type="button" onClick={onOpenSettings} disabled={!project}>
        排版设置
      </button>
      <button className="btn small" type="button" onClick={onOpenTheme} disabled={!project}>
        主题编辑器
      </button>
      <button className="btn small" type="button" onClick={onOpenStudio} disabled={!project}>
        主题工作室
      </button>
      <button className="btn small" type="button" onClick={onOpenFeatures} disabled={!project}>
        功能
      </button>
      <button className="btn small" type="button" onClick={onOpenAssets} disabled={!project}>
        资源库
      </button>
      {project && <SoundQuickMenu project={project} />}
      <button
        className="btn small"
        type="button"
        title="撤销上一步记分"
        disabled={!project || undoCount === 0 || project.settings.featureUndo === false}
        onClick={() => {
          if (!project) return;
          sendOp('undoScore', { projectId: project.id }).catch((err: Error) => toast(err.message));
        }}
      >
        撤销记分
      </button>
      <span
        id="conn-dot"
        className={'dot' + (connected ? '' : ' connecting')}
        title={connected ? '已连接' : '连接中…'}
      />
      {version && (
        <span
          className="hint"
          style={{ color: 'var(--text-dim)', fontSize: 12 }}
          title={
            version.frontend === 'react'
              ? '当前使用 React 前端（public/v2）'
              : '未检测到 React 构建产物，请先执行 npm run build:web'
          }
        >
          v{version.version}
          {' · ' + (version.frontend === 'react' ? 'React' : '未构建')}
        </span>
      )}
      <button className="btn small" type="button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
        主题：{theme === 'light' ? '浅色' : '深色'}
      </button>
      <a
        className="open-display"
        href={project ? '/display-v2?project=' + encodeURIComponent(project.id) : '/display-v2'}
        target="_blank"
        rel="noreferrer"
      >
        打开显示端
      </a>
    </header>
  );
}
