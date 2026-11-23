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
import StorageDialog from './components/StorageDialog';
import BatchAddDialog from './components/BatchAddDialog';
import MobileNav, { type MobileTab } from './components/MobileNav';
import MemberConsole from './components/MemberConsole';
import MemberMenuDialog from './components/MemberMenuDialog';
import WelcomeScreen from './components/WelcomeScreen';
import { DialogHost } from './components/dialogs';
import Toasts from './components/Toasts';
import { useMediaQuery } from './hooks/useMediaQuery';
import { projectOf, projectsOf, useAppStore } from '../shared/store';
import { useAuthStore } from '../shared/auth';

type DialogKind =
  | 'settings' | 'features' | 'assets' | 'theme' | 'studio' | 'account' | 'storage'
  | 'batchPeople' | 'batchTeams' | 'memberMenu';

export default function App(): JSX.Element {
  const snapshot = useAppStore((s) => s.snapshot);
  const connected = useAppStore((s) => s.connected);
  const authStatus = useAuthStore((s) => s.status);
  const user = authStatus?.user ?? null;
  const authEnabled = authStatus?.authEnabled !== false;
  const openAccess = authStatus?.openAccess === true;
  const role = user?.role ?? 'viewer';
  const isAdmin = role === 'admin';
  const isMember = role === 'member';
  const canScore = role === 'admin' || role === 'operator';
  const projects = useMemo(() => projectsOf(snapshot), [snapshot]);
  const [dialogs, setDialogs] = useState<DialogKind[]>([]);
  const [projectId, setProjectId] = useState<string | null>(
    () => new URLSearchParams(location.search).get('project'),
  );
  const [mobileTab, setMobileTab] = useState<MobileTab>('people');
  const boundProject = isMember && user?.memberProjectId
    ? (snapshot?.projects[user.memberProjectId] ?? null)
    : null;
  // 队员账号跟着绑定项目走，不允许回退到其它项目
  const project = isMember ? boundProject : projectOf(snapshot, projectId);
  const isSmall = useMediaQuery('(max-width: 860px)');
  const mobile = isSmall && project?.settings.featureMobileAdmin !== false;
  const memberMode = isMember && (project ? project.settings.featureMemberConsole !== false : true);

  function openDialog(kind: DialogKind): void {
    setDialogs((prev) => {
      if (mobile) return [kind];
      return prev.includes(kind) ? prev : [...prev, kind];
    });
  }

  function closeDialog(kind: DialogKind): void {
    setDialogs((prev) => prev.filter((item) => item !== kind));
  }

  useEffect(() => {
    if (!mobile) return;
    setDialogs((prev) => (prev.length > 1 ? [prev[prev.length - 1]] : prev));
  }, [mobile]);

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
      {!mobile && !memberMode && projects.length > 0 && (
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
          onOpenSettings={() => openDialog('settings')}
          onOpenFeatures={() => openDialog('features')}
          onOpenAssets={() => openDialog('assets')}
          onOpenTheme={() => openDialog('theme')}
          onOpenStudio={() => openDialog('studio')}
          onOpenAccount={() => openDialog('account')}
          onOpenStorage={() => openDialog('storage')}
          onOpenMemberMenu={() => openDialog('memberMenu')}
        />
      )}
      <Toasts />

      {!snapshot ? (
        <p style={{ padding: 20, color: 'var(--text-dim)' }}>正在连接服务器…</p>
      ) : memberMode ? (
        <MemberConsole
          project={project}
          connected={connected}
          user={user}
          authEnabled={authEnabled}
          openAccess={openAccess}
        />
      ) : projects.length === 0 ? (
        <WelcomeScreen
          projects={projects}
          user={user}
          authEnabled={authEnabled}
          openAccess={openAccess}
          isAdmin={isAdmin}
          onSelectProject={setProjectId}
          onOpenAccount={() => openDialog('account')}
          onOpenStorage={() => openDialog('storage')}
        />
      ) : !project ? (
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
            onOpenSettings={() => openDialog('settings')}
            onOpenFeatures={() => openDialog('features')}
            onOpenAssets={() => openDialog('assets')}
            onOpenTheme={() => openDialog('theme')}
            onOpenStudio={() => openDialog('studio')}
            onOpenAccount={() => openDialog('account')}
            onOpenStorage={() => openDialog('storage')}
            onOpenMemberMenu={() => openDialog('memberMenu')}
          />
          {/* 三个面板常驻挂载、仅隐藏，避免切 tab 丢失输入与预览状态 */}
          <div className={'mobile-panel' + (mobileTab === 'preview' ? '' : ' is-hidden')}>
            <PreviewPanel project={project} isAdmin={isAdmin} />
          </div>
          <div className={'mobile-panel' + (mobileTab === 'people' ? '' : ' is-hidden')}>
            <PeoplePanel
              project={project}
              canScore={canScore}
              isAdmin={isAdmin}
              onOpenBatch={() => openDialog('batchPeople')}
            />
          </div>
          <div className={'mobile-panel' + (mobileTab === 'teams' ? '' : ' is-hidden')}>
            <TeamsPanel
              project={project}
              canScore={canScore}
              isAdmin={isAdmin}
              onOpenBatch={() => openDialog('batchTeams')}
            />
          </div>
        </>
      ) : (
        <main className="panels">
          <PreviewPanel project={project} isAdmin={isAdmin} />
          <PeoplePanel
              project={project}
              canScore={canScore}
              isAdmin={isAdmin}
              onOpenBatch={() => openDialog('batchPeople')}
            />
          <TeamsPanel
              project={project}
              canScore={canScore}
              isAdmin={isAdmin}
              onOpenBatch={() => openDialog('batchTeams')}
            />
        </main>
      )}

      {project && isAdmin && dialogs.includes('batchPeople') && (
        <BatchAddDialog
          project={project}
          mode="people"
          onClose={() => closeDialog('batchPeople')}
        />
      )}
      {project && isAdmin && dialogs.includes('batchTeams') && (
        <BatchAddDialog
          project={project}
          mode="teams"
          onClose={() => closeDialog('batchTeams')}
        />
      )}
      {project && isAdmin && dialogs.includes('settings') && (
        <SettingsDialog project={project} onClose={() => closeDialog('settings')} />
      )}
      {project && isAdmin && dialogs.includes('features') && (
        <FeaturesDialog project={project} onClose={() => closeDialog('features')} />
      )}
      {project && isAdmin && dialogs.includes('assets') && (
        <AssetLibraryDialog onClose={() => closeDialog('assets')} />
      )}
      {project && isAdmin && dialogs.includes('theme') && (
        <ThemeEditorDialog project={project} onClose={() => closeDialog('theme')} />
      )}
      {project && isAdmin && dialogs.includes('studio') && (
        <ThemeStudioDialog project={project} onClose={() => closeDialog('studio')} />
      )}
      {authEnabled && dialogs.includes('account') && (
        <AccountDialog onClose={() => closeDialog('account')} />
      )}
      {isAdmin && dialogs.includes('storage') && (
        <StorageDialog onClose={() => closeDialog('storage')} />
      )}
      {project && isAdmin && dialogs.includes('memberMenu') && (
        <MemberMenuDialog project={project} onClose={() => closeDialog('memberMenu')} />
      )}
      <DialogHost />
    </>
  );
}
