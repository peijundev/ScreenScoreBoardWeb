import { useEffect, useMemo, useState, type JSX } from 'react';
import Toolbar from './components/Toolbar';
import PreviewPanel from './components/PreviewPanel';
import PeoplePanel from './components/PeoplePanel';
import TeamsPanel from './components/TeamsPanel';
import SettingsDialog from './components/SettingsDialog';
import FeaturesDialog from './components/FeaturesDialog';
import ThemeEditorDialog from './components/ThemeEditorDialog';
import Toasts from './components/Toasts';
import { projectOf, projectsOf, useAppStore } from '../shared/store';

type DialogKind = 'settings' | 'features' | 'theme' | null;

export default function App(): JSX.Element {
  const snapshot = useAppStore((s) => s.snapshot);
  const connected = useAppStore((s) => s.connected);
  const projects = useMemo(() => projectsOf(snapshot), [snapshot]);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [projectId, setProjectId] = useState<string | null>(
    () => new URLSearchParams(location.search).get('project'),
  );
  const project = projectOf(snapshot, projectId);

  useEffect(() => {
    if (!project) return;
    if (project.id !== projectId) setProjectId(project.id);
    const url = new URL(location.href);
    if (url.searchParams.get('project') !== project.id) {
      url.searchParams.set('project', project.id);
      history.replaceState(null, '', url);
    }
  }, [project, projectId]);

  return (
    <>
      <Toolbar
        project={project}
        projects={projects}
        connected={connected}
        onSelectProject={setProjectId}
        onOpenSettings={() => setDialog('settings')}
        onOpenFeatures={() => setDialog('features')}
        onOpenTheme={() => setDialog('theme')}
      />
      <Toasts />

      {!project ? (
        <p style={{ padding: 20, color: 'var(--text-dim)' }}>正在连接服务器…</p>
      ) : (
        <main className="panels">
          <PreviewPanel project={project} />
          <PeoplePanel project={project} />
          <TeamsPanel project={project} />
        </main>
      )}

      {project && dialog === 'settings' && (
        <SettingsDialog project={project} onClose={() => setDialog(null)} />
      )}
      {project && dialog === 'features' && (
        <FeaturesDialog project={project} onClose={() => setDialog(null)} />
      )}
      {project && dialog === 'theme' && (
        <ThemeEditorDialog project={project} onClose={() => setDialog(null)} />
      )}
    </>
  );
}
