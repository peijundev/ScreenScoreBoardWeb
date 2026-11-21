import { useEffect, useMemo, useState, type JSX } from 'react';
import Toolbar from './components/Toolbar';
import PreviewPanel from './components/PreviewPanel';
import PeoplePanel from './components/PeoplePanel';
import TeamsPanel from './components/TeamsPanel';
import SettingsDialog from './components/SettingsDialog';
import FeaturesDialog from './components/FeaturesDialog';
import AssetLibraryDialog from './components/AssetLibraryDialog';
import ThemeEditorDialog from './components/ThemeEditorDialog';
import ThemeStudioDialog from './theme/studio/ThemeStudioDialog';
import AccountDialog from './components/AccountDialog';
import MobileNav, { type MobileTab } from './components/MobileNav';
import { DialogHost } from './components/dialogs';
import Toasts from './components/Toasts';
import { useMediaQuery } from './hooks/useMediaQuery';
import { projectOf, projectsOf, useAppStore } from '../shared/store';
import { useAuthStore } from '../shared/auth';

type DialogKind = 'settings' | 'features' | 'assets' | 'theme' | 'studio' | 'account' | null;

export default function App(): JSX.Element {
  const snapshot = useAppStore((s) => s.snapshot);
  const connected = useAppStore((s) => s.connected);
  const authStatus = useAuthStore((s) => s.status);
  const user = authStatus?.user ?? null;
  const authEnabled = authStatus?.authEnabled !== false;
  const openAccess = authStatus?.openAccess === true;
  const role = user?.role ?? 'viewer';
  const isAdmin = role === 'admin';
  const canScore = role === 'admin' || role === 'operator';
  const projects = useMemo(() => projectsOf(snapshot), [snapshot]);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [projectId, setProjectId] = useState<string | null>(
    () => new URLSearchParams(location.search).get('project'),
  );
  const [mobileTab, setMobileTab] = useState<MobileTab>('people');
  const project = projectOf(snapshot, projectId);
  const isSmall = useMediaQuery('(max-width: 860px)');
  const mobile = isSmall && project?.settings.featureMobileAdmin !== false;

  const touchTarget = project?.settings.adminTouchTargetSize ?? 44;
  useEffect(() => {
    document.documentElement.style.setProperty('--touch-target', touchTarget + 'px');
    document.body.dataset.adminLayout = mobile ? 'mobile' : 'desktop';
  }, [touchTarget, mobile]);

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
      {!mobile && (
        <Toolbar
          project={project}
          projects={projects}
          connected={connected}
          user={user}
          authEnabled={authEnabled}
          openAccess={openAccess}
          isAdmin={isAdmin}
          canScore={canScore}
          onSelectProject={setProjectId}
          onOpenSettings={() => setDialog('settings')}
          onOpenFeatures={() => setDialog('features')}
          onOpenAssets={() => setDialog('assets')}
          onOpenTheme={() => setDialog('theme')}
          onOpenStudio={() => setDialog('studio')}
          onOpenAccount={() => setDialog('account')}
        />
      )}
      <Toasts />

      {!project ? (
        <p style={{ padding: 20, color: 'var(--text-dim)' }}>正在连接服务器…</p>
      ) : mobile ? (
        <>
          <MobileNav
            project={project}
            projects={projects}
            connected={connected}
            user={user}
            authEnabled={authEnabled}
            openAccess={openAccess}
            isAdmin={isAdmin}
            canScore={canScore}
            tab={mobileTab}
            onTab={setMobileTab}
            onSelectProject={setProjectId}
            onOpenSettings={() => setDialog('settings')}
            onOpenFeatures={() => setDialog('features')}
            onOpenAssets={() => setDialog('assets')}
            onOpenTheme={() => setDialog('theme')}
            onOpenStudio={() => setDialog('studio')}
            onOpenAccount={() => setDialog('account')}
          />
          {/* 三个面板常驻挂载、仅隐藏，避免切 tab 丢失输入与预览状态 */}
          <div className={'mobile-panel' + (mobileTab === 'preview' ? '' : ' is-hidden')}>
            <PreviewPanel project={project} isAdmin={isAdmin} />
          </div>
          <div className={'mobile-panel' + (mobileTab === 'people' ? '' : ' is-hidden')}>
            <PeoplePanel project={project} canScore={canScore} isAdmin={isAdmin} />
          </div>
          <div className={'mobile-panel' + (mobileTab === 'teams' ? '' : ' is-hidden')}>
            <TeamsPanel project={project} canScore={canScore} isAdmin={isAdmin} />
          </div>
        </>
      ) : (
        <main className="panels">
          <PreviewPanel project={project} isAdmin={isAdmin} />
          <PeoplePanel project={project} canScore={canScore} isAdmin={isAdmin} />
          <TeamsPanel project={project} canScore={canScore} isAdmin={isAdmin} />
        </main>
      )}

      {project && isAdmin && dialog === 'settings' && (
        <SettingsDialog project={project} onClose={() => setDialog(null)} />
      )}
      {project && isAdmin && dialog === 'features' && (
        <FeaturesDialog project={project} onClose={() => setDialog(null)} />
      )}
      {project && isAdmin && dialog === 'assets' && (
        <AssetLibraryDialog onClose={() => setDialog(null)} />
      )}
      {project && isAdmin && dialog === 'theme' && (
        <ThemeEditorDialog project={project} onClose={() => setDialog(null)} />
      )}
      {project && isAdmin && dialog === 'studio' && (
        <ThemeStudioDialog project={project} onClose={() => setDialog(null)} />
      )}
      {authEnabled && dialog === 'account' && (
        <AccountDialog onClose={() => setDialog(null)} />
      )}
      <DialogHost />
    </>
  );
}
