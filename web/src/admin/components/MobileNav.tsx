import { useEffect, useState, type JSX } from 'react';
import type { Project } from '../../shared/types';
import { useAppStore } from '../../shared/store';
import { toast } from '../../shared/ui';
import { confirm, prompt } from './dialogs';

export type MobileTab = 'preview' | 'people' | 'teams' | 'theme' | 'more';

const TABS: Array<[MobileTab, string]> = [
  ['preview', '预览'],
  ['people', '人员'],
  ['teams', '团队'],
  ['theme', '主题'],
  ['more', '更多'],
];

interface Props {
  project: Project | null;
  projects: Project[];
  connected: boolean;
  tab: MobileTab;
  onTab: (tab: MobileTab) => void;
  onSelectProject: (id: string) => void;
  onOpenSettings: () => void;
  onOpenFeatures: () => void;
  onOpenAssets: () => void;
  onOpenTheme: () => void;
  onOpenStudio: () => void;
}

export default function MobileNav({
  project,
  projects,
  connected,
  tab,
  onTab,
  onSelectProject,
  onOpenSettings,
  onOpenFeatures,
  onOpenAssets,
  onOpenTheme,
  onOpenStudio,
}: Props): JSX.Element {
  const sendOp = useAppStore((s) => s.sendOp);
  const undoCount = useAppStore((s) => (project ? (s.runtime?.undoCounts[project.id] ?? 0) : 0));
  const [adminTheme, setAdminTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem('admin-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    document.body.dataset.theme = adminTheme;
  }, [adminTheme]);

  async function addProject(): Promise<void> {
    const name = await prompt({ title: '新建项目', label: '每个项目是一个独立积分榜', defaultValue: '新项目' });
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

  function toggleAdminTheme(): void {
    const next = adminTheme === 'light' ? 'dark' : 'light';
    setAdminTheme(next);
    document.body.dataset.theme = next;
    try {
      localStorage.setItem('admin-theme', next);
    } catch {
      // ignore
    }
  }

  return (
    <>
      <header className="mobile-topbar">
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
        <button
          className="btn small"
          type="button"
          disabled={!project || undoCount === 0 || project.settings.featureUndo === false}
          onClick={() => {
            if (!project) return;
            sendOp('undoScore', { projectId: project.id }).catch((err: Error) => toast(err.message));
          }}
        >
          撤销
        </button>
        <span
          className={'dot' + (connected ? '' : ' connecting')}
          title={connected ? '已连接' : '连接中…'}
        />
      </header>

      <div className="mobile-content">
        {tab === 'theme' && (
          <section className="mobile-card">
            <h2>主题与外观</h2>
            <button className="btn mobile-wide" type="button" onClick={onOpenSettings}>
              排版设置
            </button>
            <button className="btn mobile-wide" type="button" onClick={onOpenTheme}>
              主题编辑器
            </button>
            <button className="btn mobile-wide" type="button" onClick={onOpenStudio}>
              主题工作室
            </button>
            <button className="btn mobile-wide" type="button" onClick={onOpenFeatures}>
              功能开关与数据
            </button>
          </section>
        )}

        {tab === 'more' && (
          <section className="mobile-card">
            <h2>项目</h2>
            <button className="btn mobile-wide" type="button" onClick={() => void addProject()}>
              新建项目
            </button>
            <button className="btn mobile-wide" type="button" disabled={!project} onClick={() => void renameProject()}>
              重命名当前项目
            </button>
            <button className="btn mobile-wide danger" type="button" disabled={!project} onClick={() => void deleteProject()}>
              删除当前项目
            </button>
            <h2>控制台</h2>
            <button className="btn mobile-wide" type="button" onClick={onOpenFeatures}>
              数据导入 / 导出 / 备份
            </button>
            <button className="btn mobile-wide" type="button" onClick={onOpenAssets} disabled={!project}>
              资源库
            </button>
            <button className="btn mobile-wide" type="button" onClick={toggleAdminTheme}>
              管理端主题：{adminTheme === 'light' ? '浅色' : '深色'}
            </button>
            <a
              className="btn mobile-wide open-display"
              href={project ? '/display-v2?project=' + encodeURIComponent(project.id) : '/display-v2'}
              target="_blank"
              rel="noreferrer"
            >
              打开显示端
            </a>
          </section>
        )}
      </div>

      <nav className="mobile-tabbar">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={'mobile-tab' + (tab === value ? ' active' : '')}
            onClick={() => onTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>
    </>
  );
}
