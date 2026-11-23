import { useEffect, useState, type JSX } from 'react';
import type { Project, BuzzRuntime, BuzzWinner } from '../../shared/types';
import type { AuthUser } from '../../shared/auth';
import { useAuthStore } from '../../shared/auth';
import { projectOp, useAppStore } from '../../shared/store';
import { toast } from '../../shared/ui';
import {
  memberButtonStyle,
  type MemberMenuButton,
  type MemberMenuConfig,
} from '../../shared/member-menu';
import AdminThemePicker from './AdminThemePicker';

type MemberTab = 'ops' | 'more';

const roleLabel: Record<string, string> = {
  admin: '管理员',
  operator: '操作员',
  member: '队员',
  viewer: '只读',
};

function targetLabel(project: Project, button: MemberMenuButton): string {
  const entity = button.targetType === 'person'
    ? project.people[button.targetId]
    : project.teams[button.targetId];
  return entity?.name || '（目标已删除）';
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function buzzRemainingSec(buzz: BuzzRuntime, now: number, offsetMs: number): number {
  if (!buzz.endsAt) return 0;
  return Math.max(0, Math.ceil((buzz.endsAt - (now + offsetMs)) / 1000));
}

function buzzBanner(
  buzz: BuzzRuntime,
  user: AuthUser | null,
  remaining: number,
): { title: string; hint: string } {
  const winner = buzz.winner;
  if (winner) {
    if (winner.userId === user?.id) {
      return { title: '你抢到了！', hint: '已在大屏锁定突显，等待管理员结束本轮' };
    }
    return {
      title: `已抢答：${winner.personName || winner.username || '其他队员'}`,
      hint: `大屏锁定突显 ${winner.targetName || ''}，等待管理员结束本轮`,
    };
  }
  if (buzz.phase === 'prepare') {
    return {
      title: '抢答准备中',
      hint: `倒计时结束后开放抢答${remaining > 0 ? ` · 剩余 ${remaining} 秒` : ''}`,
    };
  }
  if (buzz.phase === 'open') {
    return {
      title: '抢答开始！',
      hint: `第一个按下的队员获胜${buzz.endsAt ? ` · 剩余 ${remaining} 秒` : ''}`,
    };
  }
  return { title: '本轮无人抢答', hint: '等待管理员结束或重新开始本轮' };
}

export interface MemberConsoleViewProps {
  projectName: string;
  memberName?: string;
  menu: MemberMenuConfig | null;
  connected: boolean;
  user: AuthUser | null;
  authEnabled: boolean;
  openAccess: boolean;
  tab: MemberTab;
  onTab: (tab: MemberTab) => void;
  onAction: (button: MemberMenuButton) => void;
  pendingId?: string | null;
  preview?: boolean;
  notice?: string;
  onLogout?: () => void;
  buzz?: BuzzRuntime | null;
  buzzButtonMode?: 'all' | 'marked';
  buzzBusy?: boolean;
  serverOffsetMs?: number;
  onBuzz?: (button: MemberMenuButton) => void;
}

/** 队员界面的纯展示层：真实控制台与「人员功能菜单」预览共用，禁止各写一套。 */
export function MemberConsoleView({
  projectName,
  memberName,
  menu,
  connected,
  user,
  authEnabled,
  openAccess,
  tab,
  onTab,
  onAction,
  pendingId = null,
  preview = false,
  notice,
  onLogout,
  buzz = null,
  buzzButtonMode = 'all',
  buzzBusy = false,
  serverOffsetMs = 0,
  onBuzz,
}: MemberConsoleViewProps): JSX.Element {
  const buttons = menu && Array.isArray(menu.buttons) ? menu.buttons : [];
  const columns = Math.min(4, Math.max(1, Number(menu?.columns) || 2));
  const gap = Math.min(48, Math.max(0, Number(menu?.gap) || 0));
  const menuEnabled = menu ? menu.enabled !== false : false;
  const fillMode = Boolean(
    menu?.fillMode === 'adaptive' && columns === 1 && buttons.length === 1,
  );
  const emptyNotice = notice
    || (!menu
      ? '管理员尚未为你配置人员菜单'
      : !menuEnabled
        ? '管理员已停用你的人员菜单'
        : '管理员尚未为你配置操作按钮');
  const now = useNow(Boolean(buzz && buzz.endsAt));
  const remaining = buzz ? buzzRemainingSec(buzz, now, serverOffsetMs) : 0;
  const banner = buzz ? buzzBanner(buzz, user, remaining) : null;

  function eligible(button: MemberMenuButton): boolean {
    if (!buzz) return true;
    if (buzz.phase !== 'open' || buzz.winner) return false;
    if (!button.enabled) return false;
    if (buzzButtonMode === 'marked' && button.buzz !== true) return false;
    return true;
  }

  return (
    <div className={'member-console' + (preview ? ' is-preview' : '')}>
      <header className="member-topbar">
        <strong className="member-project">{projectName}</strong>
        {memberName && <span className="hint member-person-name">{memberName}</span>}
        <span
          className={'dot' + (connected || preview ? '' : ' connecting')}
          title={connected || preview ? '已连接' : '连接中…'}
        />
      </header>

      <div className={'member-content' + (fillMode ? ' is-fill' : '')}>
        {tab === 'ops' && (
          <>
            {banner && (
              <div
                className={
                  'member-buzz-banner' +
                  ' phase-' + buzz?.phase +
                  (buzz?.winner ? ' has-winner' : '')
                }
                role="status"
              >
                <strong>{banner.title}</strong>
                <span className="hint">{banner.hint}</span>
              </div>
            )}
            <h2 className="member-title">操作</h2>
            {!menu || !menuEnabled || buttons.length === 0 ? (
              <p className="member-empty">{emptyNotice}</p>
            ) : (
              <div
                className={'member-grid' + (fillMode ? ' is-fill' : '')}
                style={{
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  gap: `${gap}px`,
                }}
              >
                {buttons.map((button) => {
                  const busy = pendingId === button.id;
                  const buzzable = eligible(button);
                  const disabled = !button.enabled
                    || busy
                    || buzzBusy
                    || (!preview && !connected)
                    || (Boolean(buzz) && !buzzable);
                  return (
                    <button
                      key={button.id}
                      className={
                        'member-action' +
                        (button.enabled ? '' : ' is-disabled') +
                        (busy || (buzz && buzzBusy) ? ' is-busy' : '')
                      }
                      type="button"
                      style={fillMode
                        ? { ...memberButtonStyle(button), minHeight: 0, height: '100%' }
                        : memberButtonStyle(button)}
                      disabled={disabled}
                      title={
                        button.enabled
                          ? buzz && !buzzable
                            ? button.label + '（当前不可抢答）'
                            : button.label
                          : button.label + '（已停用）'
                      }
                      onClick={() => {
                        if (buzz) {
                          if (buzzable) onBuzz?.(button);
                          return;
                        }
                        onAction(button);
                      }}
                    >
                      <span className="member-action-label">{button.label}</span>
                      {(busy || (buzz && buzzBusy)) && (
                        <span className="member-action-busy">执行中…</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}

        {tab === 'more' && (
          <section className="member-more">
            <h2 className="member-title">更多</h2>
            <h2 className="member-title">界面主题</h2>
            <AdminThemePicker wide />
            <div className="member-account">
              <strong>{memberName || user?.displayName || user?.username || '队员'}</strong>
              <span className="hint">
                {user ? user.username + ' · ' + (roleLabel[user.role] || user.role) : '未登录'}
              </span>
            </div>
            {authEnabled && user && !openAccess && onLogout && (
              <button className="btn mobile-wide danger" type="button" onClick={onLogout}>
                退出登录
              </button>
            )}
            {openAccess && <p className="hint">开放模式：当前未启用登录</p>}
            {!authEnabled && <p className="hint">本机模式（未启用鉴权）</p>}
          </section>
        )}
      </div>

      <nav className="member-tabbar" role="tablist">
        {([
          ['ops', '操作'],
          ['more', '更多'],
        ] as Array<[MemberTab, string]>).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={'member-tab' + (tab === value ? ' active' : '')}
            onClick={() => onTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

export default function MemberConsole({
  project,
  connected,
  user,
  authEnabled,
  openAccess,
}: {
  project: Project | null;
  connected: boolean;
  user: AuthUser | null;
  authEnabled: boolean;
  openAccess: boolean;
}): JSX.Element {
  const [tab, setTab] = useState<MemberTab>('ops');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [buzzBusy, setBuzzBusy] = useState(false);
  const runtime = useAppStore((s) => s.runtime);
  const logout = useAuthStore((s) => s.logout);
  const menus: MemberMenuConfig[] = project && Array.isArray(project.settings.memberMenus)
    ? project.settings.memberMenus
    : [];
  const menu = user ? menus.find((item) => item.userId === user.id) ?? null : null;
  const person = project && user?.memberPersonId
    ? project.people[user.memberPersonId] ?? null
    : null;
  const buzz = project ? runtime?.buzz?.[project.id] ?? null : null;
  const serverOffsetMs = runtime?.serverNow ? runtime.serverNow - Date.now() : 0;
  const notice = !user?.memberProjectId
    ? '账号尚未绑定项目与人员，请联系管理员'
    : !project
      ? '绑定的项目不存在，请联系管理员重新绑定'
      : undefined;

  async function run(button: MemberMenuButton): Promise<void> {
    if (!project || pendingId) return;
    setPendingId(button.id);
    try {
      const result = await projectOp(project.id, 'memberAction', { buttonId: button.id }) as {
        action?: string;
        delta?: number;
      };
      const target = targetLabel(project, button);
      if (result?.action === 'score') {
        const delta = Number(result.delta) || 0;
        toast(`${target} ${delta > 0 ? '+' : ''}${delta} 分`);
      } else {
        toast(`已突显 ${target}`);
      }
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setPendingId(null);
    }
  }

  async function runBuzz(button: MemberMenuButton): Promise<void> {
    if (!project || buzzBusy) return;
    setBuzzBusy(true);
    try {
      const result = await projectOp(project.id, 'buzzPress', { buttonId: button.id }) as {
        won?: boolean;
        reason?: string;
        winner?: BuzzWinner | null;
      };
      if (result?.won) {
        toast('抢答成功！');
      } else if (result?.reason === 'taken') {
        if (project.settings.buzzLoserHint !== false) {
          toast(`已被 ${result.winner?.personName || '其他队员'} 抢答`);
        }
      } else if (result?.reason === 'prepare') {
        toast('计时结束后才能抢答');
      } else if (result?.reason === 'locked') {
        toast('本轮抢答已结束');
      } else if (result?.reason === 'inactive') {
        toast('抢答尚未开始');
      } else if (result?.reason === 'binding-missing') {
        toast('账号绑定的人员不存在，请联系管理员');
      } else if (result?.reason === 'no-menu' || result?.reason === 'no-button') {
        toast('管理员尚未为你配置可用的抢答按钮');
      } else if (result?.reason === 'not-buzz-button' || result?.reason === 'button-disabled') {
        toast('该按钮不参与本轮抢答');
      } else {
        toast('未能抢答');
      }
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBuzzBusy(false);
    }
  }

  return (
    <MemberConsoleView
      projectName={project?.name || '未绑定项目'}
      memberName={person?.name}
      menu={menu}
      connected={connected}
      user={user}
      authEnabled={authEnabled}
      openAccess={openAccess}
      tab={tab}
      onTab={setTab}
      onAction={(button) => { void run(button); }}
      pendingId={pendingId}
      notice={notice}
      onLogout={() => {
        void logout().catch((err: Error) => toast(err.message));
      }}
      buzz={buzz}
      buzzButtonMode={project?.settings.buzzButtonMode === 'marked' ? 'marked' : 'all'}
      buzzBusy={buzzBusy}
      serverOffsetMs={serverOffsetMs}
      onBuzz={(button) => { void runBuzz(button); }}
    />
  );
}
