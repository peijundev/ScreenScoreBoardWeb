import { useEffect, useMemo, useState, type JSX } from 'react';
import type { Project, BuzzRuntime } from '../../shared/types';
import type { AuthUser } from '../../shared/auth';
import { listUsers } from '../../shared/auth';
import { uploadAvatar } from '../../shared/api';
import { projectOp } from '../../shared/store';
import { toast } from '../../shared/ui';
import {
  MEMBER_MENU_DEFAULTS,
  MEMBER_MENU_LIMIT,
  MEMBER_MENU_LAYOUT_DEFAULTS,
  type MemberMenuButton,
  type MemberMenuConfig,
} from '../../shared/member-menu';
import DialogShell from './DialogShell';
import NumberInput from './NumberInput';
import { MemberConsoleView } from './MemberConsole';

type MemberTab = 'ops' | 'more';

function targetNameOf(project: Project, button: MemberMenuButton): string {
  const entity = button.targetType === 'person'
    ? project.people[button.targetId]
    : project.teams[button.targetId];
  return entity?.name || '（目标已删除）';
}

function cloneMenu(menu: MemberMenuConfig): MemberMenuConfig {
  return {
    ...menu,
    buttons: menu.buttons.map((button) => ({ ...button })),
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function ButtonEditor({
  project,
  button,
  index,
  total,
  onChange,
  onMove,
  onRemove,
}: {
  project: Project;
  button: MemberMenuButton;
  index: number;
  total: number;
  onChange: (patch: Partial<MemberMenuButton>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}): JSX.Element {
  const people = Object.values(project.people)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const teams = Object.values(project.teams)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const options = button.targetType === 'person' ? people : teams;
  const targetMissing = !options.some((item) => item.id === button.targetId);
  const featureOff = button.action === 'score' && button.targetType === 'team'
    ? project.settings.featureTeamScore === false
    : button.action === 'spotlight'
      ? project.settings.featureSpotlightTrigger === false
      : false;

  return (
    <section className={'member-button-editor' + (button.enabled ? '' : ' is-disabled')}>
      <header className="member-button-head">
        <strong>按钮 {index + 1}</strong>
        <input
          type="text"
          maxLength={16}
          aria-label={'按钮文字 ' + (index + 1)}
          value={button.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
        <label className="member-check">
          <input
            type="checkbox"
            checked={button.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          启用
        </label>
        <label className="member-check" title="抢答期间该按钮是否可以作为抢答按钮">
          <input
            type="checkbox"
            checked={button.buzz}
            onChange={(e) => onChange({ buzz: e.target.checked })}
          />
          参与抢答
        </label>
        <button className="btn small" type="button" disabled={index === 0} onClick={() => onMove(-1)}>
          上移
        </button>
        <button className="btn small" type="button" disabled={index === total - 1} onClick={() => onMove(1)}>
          下移
        </button>
        <button className="btn small danger" type="button" onClick={onRemove}>
          删除
        </button>
      </header>

      <div className="member-field-grid">
        <label>
          动作
          <select
            value={button.action}
            onChange={(e) => onChange({ action: e.target.value as MemberMenuButton['action'] })}
          >
            <option value="score">加分 / 加票</option>
            <option value="spotlight">突显（不改分数）</option>
          </select>
        </label>
        <label>
          目标类型
          <select
            value={button.targetType}
            onChange={(e) => {
              const targetType = e.target.value as MemberMenuButton['targetType'];
              const next = targetType === 'person' ? people : teams;
              onChange({ targetType, targetId: next[0]?.id ?? '' });
            }}
          >
            <option value="person">人员</option>
            <option value="team">团队</option>
          </select>
        </label>
        <label className={targetMissing ? 'is-invalid' : ''}>
          目标
          <select
            value={button.targetId}
            onChange={(e) => onChange({ targetId: e.target.value })}
          >
            {targetMissing && <option value={button.targetId}>（目标已删除）</option>}
            {options.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        {button.action === 'score' ? (
          <label>
            分值
            <input
              type="number"
              min={-10000}
              max={10000}
              step={1}
              value={button.delta}
              onChange={(e) => onChange({ delta: Math.trunc(Number(e.target.value)) || 0 })}
            />
          </label>
        ) : (
          <label>
            突显时长（0=跟随设置）
            <input
              type="number"
              min={0}
              max={10000}
              step={100}
              value={button.durationMs}
              onChange={(e) => onChange({ durationMs: Number(e.target.value) || 0 })}
            />
          </label>
        )}
      </div>

      <div className="member-field-grid">
        <label>
          高度
          <span className="member-range-row">
            <input
              type="range"
              min={56}
              max={240}
              step={2}
              value={button.height}
              onChange={(e) => onChange({ height: Number(e.target.value) })}
            />
            <NumberInput
              className="member-number"
              min={56}
              max={240}
              step={2}
              value={button.height}
              onChange={(height) => onChange({ height })}
            />
            <span>px</span>
          </span>
        </label>
        <label>
          字号
          <span className="member-range-row">
            <input
              type="range"
              min={14}
              max={96}
              step={1}
              value={button.fontSize}
              onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
            />
            <NumberInput
              className="member-number"
              min={14}
              max={96}
              step={1}
              value={button.fontSize}
              onChange={(fontSize) => onChange({ fontSize })}
            />
            <span>px</span>
          </span>
        </label>
        <label>
          圆角
          <span className="member-range-row">
            <input
              type="range"
              min={0}
              max={48}
              step={1}
              value={button.radius}
              onChange={(e) => onChange({ radius: Number(e.target.value) })}
            />
            <NumberInput
              className="member-number"
              min={0}
              max={48}
              step={1}
              value={button.radius}
              onChange={(radius) => onChange({ radius })}
            />
            <span>px</span>
          </span>
        </label>
        <label>
          底色
          <input
            type="color"
            value={button.color}
            onChange={(e) => onChange({ color: e.target.value })}
          />
        </label>
        <label className="member-check">
          <input
            type="checkbox"
            checked={button.textColor === ''}
            onChange={(e) => onChange({ textColor: e.target.checked ? '' : '#ffffff' })}
          />
          自动文字色
        </label>
        <label>
          文字色
          <input
            type="color"
            value={button.textColor || '#ffffff'}
            disabled={button.textColor === ''}
            onChange={(e) => onChange({ textColor: e.target.value })}
          />
        </label>
      </div>

      <div className="member-image-row">
        <span>背景图</span>
        {button.image ? (
          <>
            <img className="member-image-preview" src={'/' + button.image} alt="按钮背景预览" />
            <button className="btn small" type="button" onClick={() => onChange({ image: '' })}>
              清除图片
            </button>
          </>
        ) : (
          <span className="hint">未设置（使用底色）</span>
        )}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          aria-label="上传按钮背景图"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            uploadAvatar(file)
              .then((image) => onChange({ image }))
              .catch((err: Error) => toast(err.message));
            e.target.value = '';
          }}
        />
      </div>

      {targetMissing && (
        <p className="member-warning">目标已被删除，队员点击该按钮会失败，请重新选择目标或删除按钮。</p>
      )}
      {featureOff && (
        <p className="member-warning">
          当前项目关闭了{button.action === 'spotlight' ? '手动 / API 突显' : '团队整体记分'}功能，队员点击该按钮会失败。
        </p>
      )}
    </section>
  );
}

export default function MemberMenuDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}): JSX.Element {
  const [users, setUsers] = useState<AuthUser[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MemberMenuConfig | null>(null);
  const [featureEnabled, setFeatureEnabled] = useState(project.settings.featureMemberConsole !== false);
  const [previewTab, setPreviewTab] = useState<MemberTab>('ops');
  const [busy, setBusy] = useState(false);
  const [buzzEnabled, setBuzzEnabled] = useState(project.settings.featureBuzzer === true);
  const [buzzTimerMode, setBuzzTimerMode] = useState<'prepare' | 'window'>(
    project.settings.buzzTimerMode === 'window' ? 'window' : 'prepare',
  );
  const [buzzDurationSec, setBuzzDurationSec] = useState(
    clampInt(project.settings.buzzDurationSec, 1, 3600, 10),
  );
  const [buzzTarget, setBuzzTarget] = useState<'self' | 'team'>(
    project.settings.buzzTarget === 'team' ? 'team' : 'self',
  );
  const [buzzScoreDelta, setBuzzScoreDelta] = useState(
    clampInt(project.settings.buzzScoreDelta, 0, 10000, 0),
  );
  const [buzzButtonMode, setBuzzButtonMode] = useState<'all' | 'marked'>(
    project.settings.buzzButtonMode === 'marked' ? 'marked' : 'all',
  );
  const [buzzRunButtonAction, setBuzzRunButtonAction] = useState(
    project.settings.buzzRunButtonAction === true,
  );
  const [buzzLoserHint, setBuzzLoserHint] = useState(
    project.settings.buzzLoserHint !== false,
  );
  const [buzzStopTimerOnWin, setBuzzStopTimerOnWin] = useState(
    project.settings.buzzStopTimerOnWin !== false,
  );
  const [buzzShowStartPrompt, setBuzzShowStartPrompt] = useState(
    project.settings.buzzShowStartPrompt !== false,
  );
  const [buzzPreview, setBuzzPreview] = useState<'off' | 'prepare' | 'open' | 'winner' | 'locked'>('off');

  useEffect(() => {
    let alive = true;
    listUsers()
      .then((list) => { if (alive) setUsers(list); })
      .catch((err: Error) => { if (alive) { setUsers([]); toast(err.message); } });
    return () => { alive = false; };
  }, []);

  const members = useMemo(
    () => (users || []).filter(
      (user) => user.role === 'member' && user.memberProjectId === project.id,
    ),
    [users, project.id],
  );
  const selected = members.find((user) => user.id === selectedId) ?? members[0] ?? null;
  const selectedPerson = selected?.memberPersonId
    ? project.people[selected.memberPersonId] ?? null
    : null;

  useEffect(() => {
    if (!selected) { setDraft(null); return; }
    const menus = Array.isArray(project.settings.memberMenus)
      ? project.settings.memberMenus
      : [];
    const existing = menus.find((menu) => menu.userId === selected.id);
    setDraft(existing
      ? cloneMenu(existing)
      : {
          userId: selected.id,
          ...MEMBER_MENU_LAYOUT_DEFAULTS,
          buttons: [],
        });
  }, [selected?.id, project.settings.memberMenus]);

  function updateButton(id: string, patch: Partial<MemberMenuButton>): void {
    setDraft((prev) => prev ? {
      ...prev,
      buttons: prev.buttons.map((button) => (button.id === id ? { ...button, ...patch } : button)),
    } : prev);
  }

  function addButton(): void {
    if (!draft) return;
    if (draft.buttons.length >= MEMBER_MENU_LIMIT) {
      toast(`每个队员最多配置 ${MEMBER_MENU_LIMIT} 个按钮`);
      return;
    }
    const people = Object.values(project.people);
    const teams = Object.values(project.teams);
    const targetType: MemberMenuButton['targetType'] = people.length ? 'person' : 'team';
    const targetId = targetType === 'person' ? people[0]?.id ?? '' : teams[0]?.id ?? '';
    setDraft({
      ...draft,
      buttons: [
        ...draft.buttons,
        {
          id: 'btn_' + Math.random().toString(36).slice(2, 10),
          label: '投票',
          ...MEMBER_MENU_DEFAULTS,
          targetType,
          targetId,
        },
      ],
    });
  }

  function moveButton(id: string, direction: -1 | 1): void {
    setDraft((prev) => {
      if (!prev) return prev;
      const index = prev.buttons.findIndex((button) => button.id === id);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= prev.buttons.length) return prev;
      const buttons = [...prev.buttons];
      [buttons[index], buttons[next]] = [buttons[next], buttons[index]];
      return { ...prev, buttons };
    });
  }

  function previewAction(button: MemberMenuButton): void {
    if (!selected) return;
    if (button.action === 'spotlight') {
      projectOp(project.id, 'triggerSpotlight', {
        targetType: button.targetType,
        targetId: button.targetId,
        durationMs: button.durationMs,
      })
        .then(() => toast('已触发预览突显（不改变分数）'))
        .catch((err: Error) => toast(err.message));
      return;
    }
    const delta = Number(button.delta) || 0;
    toast(`预览：${targetNameOf(project, button)} ${delta > 0 ? '+' : ''}${delta} 分（未写入）`);
  }

  async function save(): Promise<void> {
    if (busy) return;
    if (draft) {
      for (const button of draft.buttons) {
        if (!button.label.trim()) {
          toast('按钮文字不能为空');
          return;
        }
        const options = button.targetType === 'person'
          ? project.people
          : project.teams;
        if (!options[button.targetId]) {
          toast(`按钮「${button.label}」的目标已被删除，请重新选择`);
          return;
        }
        if (button.action === 'score' && (!Number.isInteger(button.delta) || button.delta === 0)) {
          toast(`按钮「${button.label}」的分值须为非 0 整数`);
          return;
        }
      }
    }
    const existing = Array.isArray(project.settings.memberMenus)
      ? project.settings.memberMenus
      : [];
    let menus = existing;
    if (draft && selected) {
      menus = existing
        .filter((menu) => menu.userId !== selected.id)
        .concat({
          ...draft,
          userId: selected.id,
          buttons: draft.buttons.map((button) => ({ ...button, label: button.label.trim() })),
        });
    }
    setBusy(true);
    try {
      await projectOp(project.id, 'updateSettings', {
        patch: {
          featureMemberConsole: featureEnabled,
          memberMenus: menus,
          featureBuzzer: buzzEnabled,
          buzzTimerMode,
          buzzDurationSec,
          buzzTarget,
          buzzScoreDelta,
          buzzButtonMode,
          buzzRunButtonAction,
          buzzLoserHint,
          buzzStopTimerOnWin,
          buzzShowStartPrompt,
        },
      });
      toast('人员菜单已保存');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const previewUser: AuthUser = selected
    ? { ...selected, role: 'member' }
    : {
        id: 'member-preview',
        username: '队员账号',
        displayName: '队员账号',
        role: 'member',
      };
  const selectedTeam = selectedPerson?.teamId
    ? project.teams[selectedPerson.teamId] ?? null
    : null;
  const previewBuzz = ((): BuzzRuntime | null => {
    if (buzzPreview === 'off') return null;
    const now = Date.now();
    const targetType = buzzTarget === 'team' && selectedTeam ? 'team' : 'person';
    const targetId = targetType === 'team' ? selectedTeam!.id : selectedPerson?.id ?? '';
    const targetName = targetType === 'team' ? selectedTeam!.name : selectedPerson?.name ?? '';
    const winner = selected
      ? {
          userId: selected.id,
          username: selected.username,
          personId: selectedPerson?.id ?? '',
          personName: selectedPerson?.name ?? selected.displayName ?? selected.username,
          teamId: selectedTeam?.id ?? null,
          teamName: selectedTeam?.name ?? '',
          targetType: targetType as 'person' | 'team',
          targetId,
          targetName,
          buttonId: draft?.buttons[0]?.id ?? '',
          at: now,
        }
      : null;
    const base: BuzzRuntime = {
      roundId: 1,
      mode: buzzTimerMode,
      phase: 'open',
      startedAt: now,
      endsAt: 0,
      durationMs: buzzDurationSec * 1000,
      winner: null,
    };
    if (buzzPreview === 'prepare') return { ...base, phase: 'prepare', endsAt: now + 15000 };
    if (buzzPreview === 'open') return base;
    if (buzzPreview === 'winner') return { ...base, winner };
    return { ...base, phase: 'locked', winner };
  })();

  return (
    <DialogShell
      title="人员功能菜单"
      storageKey="memberMenuDialog"
      defaultWidth={1280}
      defaultHeight={820}
      minWidth={760}
      minHeight={560}
      onClose={onClose}
    >
      <div className="member-menu-dialog">
        <div className="member-menu-toolbar">
          <label className="member-check">
            <input
              type="checkbox"
              checked={featureEnabled}
              onChange={(e) => setFeatureEnabled(e.target.checked)}
            />
            启用队员控制台
          </label>
          <span className="hint">每个队员单独配置；切换队员会丢弃未保存的修改</span>
          <button className="btn primary" type="button" disabled={busy} onClick={() => { void save(); }}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>

        <section className="member-buzz-settings" aria-disabled={!buzzEnabled}>
          <div className="member-buzz-settings-head">
            <h3>抢答模式</h3>
            <label className="member-check">
              <input
                type="checkbox"
                checked={buzzEnabled}
                onChange={(e) => setBuzzEnabled(e.target.checked)}
              />
              启用抢答（项目级）
            </label>
            <span className="hint">开始/结束按钮在「显示端预览」面板</span>
          </div>
          <div className="member-buzz-settings-grid">
            <label>
              计时器模式
              <select
                value={buzzTimerMode}
                disabled={!buzzEnabled}
                onChange={(e) => setBuzzTimerMode(e.target.value as 'prepare' | 'window')}
              >
                <option value="prepare">先准备倒计时，再开放抢答</option>
                <option value="window">倒计时期间抢答，到 0 停止</option>
              </select>
            </label>
            <label>
              倒计时时长（秒）
              <input
                type="number"
                min={1}
                max={3600}
                step={1}
                value={buzzDurationSec}
                disabled={!buzzEnabled}
                onChange={(e) => setBuzzDurationSec(clampInt(e.target.value, 1, 3600, 10))}
              />
            </label>
            <label>
              赢家突显目标
              <select
                value={buzzTarget}
                disabled={!buzzEnabled}
                onChange={(e) => setBuzzTarget(e.target.value as 'self' | 'team')}
              >
                <option value="self">绑定人员本人</option>
                <option value="team">绑定人员所属团队（无团队回退本人）</option>
              </select>
            </label>
            <label>
              抢到后加分（0=只突显）
              <input
                type="number"
                min={0}
                max={10000}
                step={1}
                value={buzzScoreDelta}
                disabled={!buzzEnabled}
                onChange={(e) => setBuzzScoreDelta(clampInt(e.target.value, 0, 10000, 0))}
              />
            </label>
            <label>
              可抢按钮范围
              <select
                value={buzzButtonMode}
                disabled={!buzzEnabled}
                onChange={(e) => setBuzzButtonMode(e.target.value as 'all' | 'marked')}
              >
                <option value="all">全部启用按钮</option>
                <option value="marked">仅勾选「参与抢答」的按钮</option>
              </select>
            </label>
            <label className="member-check">
              <input
                type="checkbox"
                checked={buzzRunButtonAction}
                disabled={!buzzEnabled}
                onChange={(e) => setBuzzRunButtonAction(e.target.checked)}
              />
              抢到后执行按钮原加分动作
            </label>
            <label className="member-check">
              <input
                type="checkbox"
                checked={buzzLoserHint}
                disabled={!buzzEnabled}
                onChange={(e) => setBuzzLoserHint(e.target.checked)}
              />
              输家提示已被抢答
            </label>
            <label className="member-check">
              <input
                type="checkbox"
                checked={buzzStopTimerOnWin}
                disabled={!buzzEnabled || buzzTimerMode !== 'window'}
                onChange={(e) => setBuzzStopTimerOnWin(e.target.checked)}
              />
              抢到后立即关闭计时器
            </label>
            <label className="member-check">
              <input
                type="checkbox"
                checked={buzzShowStartPrompt}
                disabled={!buzzEnabled || buzzTimerMode !== 'prepare'}
                onChange={(e) => setBuzzShowStartPrompt(e.target.checked)}
              />
              倒计时结束后显示「开始抢答」
            </label>
            <label>
              预览队员抢答状态
              <select
                value={buzzPreview}
                onChange={(e) => setBuzzPreview(e.target.value as typeof buzzPreview)}
              >
                <option value="off">正常</option>
                <option value="prepare">准备中</option>
                <option value="open">抢答中</option>
                <option value="winner">已抢答</option>
                <option value="locked">已结束</option>
              </select>
            </label>
          </div>
          {!project.settings.featureCountdown && (
            <p className="hint">项目倒计时当前关闭；抢答期间会临时显示计时器，外观仍按倒计时设置。</p>
          )}
          {buzzTimerMode === 'prepare' && (
            <p className="hint">准备倒计时结束后才开放抢答；计时器会自动关闭。</p>
          )}
          {buzzTimerMode === 'window' && !buzzStopTimerOnWin && (
            <p className="member-warning">抢到后不关闭计时器；若使用全屏倒计时，可能盖住锁定突显。</p>
          )}
          {buzzTarget === 'team' && (
            <p className="hint">赢家突显其所属团队；绑定人员没有团队时回退突显本人。</p>
          )}
          {buzzScoreDelta > 0 && (
            <p className="hint">抢到后给突显目标加 {buzzScoreDelta} 分。</p>
          )}
          {!project.settings.featureMemberConsole && (
            <p className="member-warning">队员控制台未启用，队员无法按按钮参与抢答。</p>
          )}
        </section>

        <div className="member-menu-layout">
          <aside className="member-menu-members">
            <h3>队员账号</h3>
            {users === null ? (
              <p className="hint">正在加载账号…</p>
            ) : members.length === 0 ? (
              <p className="hint">
                当前项目还没有绑定人员的队员账号。请先在「账号与安全 → 用户管理」创建队员并绑定项目与人员。
              </p>
            ) : (
              members.map((user) => {
                const person = user.memberPersonId ? project.people[user.memberPersonId] : null;
                const active = selected?.id === user.id;
                return (
                  <button
                    key={user.id}
                    type="button"
                    className={'member-menu-member' + (active ? ' active' : '')}
                    onClick={() => setSelectedId(user.id)}
                  >
                    <strong>{person?.name || user.displayName || user.username}</strong>
                    <span className="hint">
                      {user.username}
                      {person ? '' : ' · 绑定人员缺失'}
                    </span>
                  </button>
                );
              })
            )}
          </aside>

          <section className="member-menu-editor">
            {!selected || !draft ? (
              <p className="hint">选择一个队员账号后配置其按钮菜单。</p>
            ) : (
              <>
                <div className="member-menu-editor-head">
                  <h3>
                    {selectedPerson?.name || selected.username} 的按钮
                  </h3>
                  <label className="member-check">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                    />
                    启用该队员菜单
                  </label>
                  <label>
                    列数
                    <span className="member-range-row">
                      <input
                        type="range"
                        min={1}
                        max={4}
                        step={1}
                        value={draft.columns}
                        onChange={(e) => setDraft({ ...draft, columns: Number(e.target.value) })}
                      />
                      <NumberInput
                        className="member-number"
                        min={1}
                        max={4}
                        step={1}
                        value={draft.columns}
                        onChange={(columns) => setDraft({ ...draft, columns })}
                      />
                    </span>
                  </label>
                  <label>
                    间距
                    <span className="member-range-row">
                      <input
                        type="range"
                        min={0}
                        max={48}
                        step={2}
                        value={draft.gap}
                        onChange={(e) => setDraft({ ...draft, gap: Number(e.target.value) })}
                      />
                      <NumberInput
                        className="member-number"
                        min={0}
                        max={48}
                        step={2}
                        value={draft.gap}
                        onChange={(gap) => setDraft({ ...draft, gap })}
                      />
                      <span>px</span>
                    </span>
                  </label>
                  {draft.columns === 1 && draft.buttons.length === 1 && (
                    <label className="member-fill-mode" title="列数为 1 且只有一个按钮时，让按钮按屏幕可用区域自适应铺满">
                      铺满屏幕
                      <select
                        value={draft.fillMode}
                        onChange={(e) => setDraft({
                          ...draft,
                          fillMode: e.target.value as 'none' | 'adaptive',
                        })}
                      >
                        <option value="none">关闭</option>
                        <option value="adaptive">自适应（适配平板等不同屏幕）</option>
                      </select>
                    </label>
                  )}
                  <span className="hint">
                    {draft.buttons.length} / {MEMBER_MENU_LIMIT}
                  </span>
                  <button
                    className="btn small"
                    type="button"
                    disabled={draft.buttons.length >= MEMBER_MENU_LIMIT}
                    onClick={addButton}
                  >
                    添加按钮
                  </button>
                </div>
                {!selectedPerson && (
                  <p className="member-warning">
                    该账号绑定的人员已被删除，请先在用户管理中重新绑定。
                  </p>
                )}
                {draft.buttons.length === 0 ? (
                  <p className="hint">还没有按钮。添加后，该队员登录即可看到这些大按钮。</p>
                ) : (
                  draft.buttons.map((button, index) => (
                    <ButtonEditor
                      key={button.id}
                      project={project}
                      button={button}
                      index={index}
                      total={draft.buttons.length}
                      onChange={(patch) => updateButton(button.id, patch)}
                      onMove={(direction) => moveButton(button.id, direction)}
                      onRemove={() => setDraft({
                        ...draft,
                        buttons: draft.buttons.filter((item) => item.id !== button.id),
                      })}
                    />
                  ))
                )}
              </>
            )}
          </section>

          <aside className="member-menu-preview">
            <div className="member-menu-preview-head">
              <h3>队员端预览</h3>
              <span className="hint">与真实界面共用同一组件；加分预览不写入分数</span>
            </div>
            <div className="member-preview-frame">
              <MemberConsoleView
                projectName={project.name}
                memberName={selectedPerson?.name}
                menu={draft}
                connected
                user={previewUser}
                authEnabled
                openAccess={false}
                tab={previewTab}
                onTab={setPreviewTab}
                onAction={previewAction}
                onLogout={() => toast('预览模式不执行退出登录')}
                buzz={previewBuzz}
                buzzButtonMode={buzzButtonMode}
                serverOffsetMs={0}
                onBuzz={() => toast('预览模式不执行抢答')}
                preview
              />
            </div>
          </aside>
        </div>
      </div>
    </DialogShell>
  );
}
