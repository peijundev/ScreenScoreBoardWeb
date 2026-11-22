import { memo, useMemo, useRef, useState, type ChangeEvent, type JSX } from 'react';
import type { Person, Project, Team } from '../../shared/types';
import { avatarURL, uploadAvatar } from '../../shared/api';
import { projectOp } from '../../shared/store';
import { quickPresets, scoreClass, toast } from '../../shared/ui';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { confirm, prompt } from './dialogs';

function contrastText(hex: string): string {
  const value = hex.replace('#', '');
  if (value.length !== 6) return '#fff';
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return '#fff';
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#111' : '#fff';
}

interface Props {
  project: Project;
  canScore: boolean;
  isAdmin: boolean;
  onOpenBatch: () => void;
}

export default function PeoplePanel({ project, canScore, isAdmin, onOpenBatch }: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const settings = project.settings;
  const presets = useMemo(() => quickPresets(settings), [settings]);
  const isSmall = useMediaQuery('(max-width: 860px)');
  const mobile = isSmall && settings.featureMobileAdmin !== false;

  const allPeople = useMemo(
    () => Object.values(project.people).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [project.people],
  );
  const teams = useMemo(
    () => Object.values(project.teams).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [project.teams],
  );

  const q = query.trim().toLowerCase();
  const people = q
    ? allPeople.filter((p) => {
        const team = p.teamId ? project.teams[p.teamId] : null;
        return p.name.toLowerCase().includes(q) || Boolean(team?.name.toLowerCase().includes(q));
      })
    : allPeople;

  async function onAdd(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    try {
      let uploaded: string | null = null;
      const file = avatarInput.current?.files?.[0];
      if (file) uploaded = await uploadAvatar(file);
      await projectOp(project.id, 'addPerson', { name: value, avatar: uploaded });
      setName('');
      setAvatar(null);
      if (avatarInput.current) avatarInput.current.value = '';
    } catch (err) {
      toast((err as Error).message);
    }
  }

  function onPickAvatar(e: ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    uploadAvatar(file)
      .then((path) => setAvatar(path))
      .catch((err: Error) => toast(err.message));
  }

  return (
    <section className="panel">
      <h2>人员</h2>
      {settings.featureSearch !== false && (
        <div className="panel-subbar">
          <input
            type="text"
            placeholder="搜索姓名 / 团队"
            aria-label="搜索人员"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      <div className="panel-subbar">
        {isAdmin && settings.featureBatchAdd !== false && (
          <button className="btn small" type="button" onClick={onOpenBatch}>
            批量添加
          </button>
        )}
        {isAdmin && settings.featureResetScores !== false && (
          <button
            className="btn small danger"
            type="button"
            onClick={() => {
              void (async () => {
                const ok = await confirm({
                  title: '重置本局分数',
                  message: '确定把本局所有人员分数清零？',
                  confirmText: '清零',
                  danger: true,
                });
                if (!ok) return;
                projectOp(project.id, 'resetScores')
                  .then((res) => toast('已重置 ' + ((res as { count?: number }).count ?? 0) + ' 人'))
                  .catch((err: Error) => toast(err.message));
              })();
            }}
          >
            重置本局分数
          </button>
        )}
        <span className="hint">
          {q ? people.length + ' / ' + allPeople.length + ' 人' : allPeople.length + ' 人'}
        </span>
      </div>

      {isAdmin && (
        <form className="add-form" onSubmit={onAdd}>
          <img
            className="avatar-preview"
            src={avatarURL({ name: name || '?', avatar })}
            alt="头像预览"
          />
          <input
            type="text"
            maxLength={20}
            placeholder="姓名"
            aria-label="姓名"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label className="file-btn">
            选择头像
            <input
              ref={avatarInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={onPickAvatar}
            />
          </label>
          <button type="submit" className="btn primary">
            添加
          </button>
        </form>
      )}

      <div className="people-list">
        {allPeople.length === 0 && (
          <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>暂无人员，先添加一个吧</p>
        )}
        {allPeople.length > 0 && people.length === 0 && (
          <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>没有匹配的人员</p>
        )}
        {people.map((p) => (
          <PersonRow
            key={p.id}
            projectId={project.id}
            person={p}
            teams={teams}
            index={allPeople.indexOf(p)}
            canUp={allPeople.indexOf(p) > 0}
            canDown={allPeople.indexOf(p) < allPeople.length - 1}
            presets={presets}
            quickScore={Boolean(settings.featureQuickScore)}
            avatarEdit={settings.featureAvatarEdit !== false}
            spotlightTrigger={settings.featureSpotlightTrigger !== false}
            mobile={mobile}
            canScore={canScore}
            isAdmin={isAdmin}
            isCaptain={Boolean(p.teamId && project.teams[p.teamId]?.captainId === p.id)}
            captainEnabled={settings.featureTeamCaptain !== false}
            captainLabel={settings.teamCaptainLabel || '队长'}
            captainColor={settings.teamCaptainColor || ''}
          />
        ))}
      </div>
    </section>
  );
}

interface RowProps {
  projectId: string;
  person: Person;
  teams: Team[];
  index: number;
  canUp: boolean;
  canDown: boolean;
  presets: number[];
  quickScore: boolean;
  avatarEdit: boolean;
  spotlightTrigger: boolean;
  mobile: boolean;
  canScore: boolean;
  isAdmin: boolean;
  isCaptain: boolean;
  captainEnabled: boolean;
  captainLabel: string;
  captainColor: string;
}

function PersonRowBase({
  projectId,
  person,
  teams,
  canUp,
  canDown,
  presets,
  quickScore,
  avatarEdit,
  spotlightTrigger,
  mobile,
  canScore,
  isAdmin,
  isCaptain,
  captainEnabled,
  captainLabel,
  captainColor,
}: RowProps): JSX.Element {
  const [delta, setDelta] = useState('1');

  function addScore(n: number): void {
    if (!Number.isFinite(n) || n === 0) return;
    projectOp(projectId, 'addScore', { personId: person.id, delta: n }).catch((err: Error) =>
      toast(err.message),
    );
  }

  function readDelta(): number | null {
    const n = Math.round(Number(delta));
    if (!Number.isFinite(n) || n === 0) return null;
    return Math.max(-10000, Math.min(10000, n));
  }

  async function rename(): Promise<void> {
    const name = await prompt({
      title: '修改姓名',
      label: '最多 20 字',
      defaultValue: person.name,
    });
    if (name == null) return;
    const value = name.trim();
    if (!value || value === person.name) return;
    projectOp(projectId, 'renamePerson', { personId: person.id, name: value }).catch((err: Error) =>
      toast(err.message),
    );
  }

  async function editBio(): Promise<void> {
    const text = await prompt({
      title: '人员简介',
      label: '最多 60 字，留空清除',
      defaultValue: person.bio || '',
      multiline: true,
      allowEmpty: true,
    });
    if (text == null) return;
    projectOp(projectId, 'setBio', { kind: 'person', id: person.id, bio: text }).catch((err: Error) =>
      toast(err.message),
    );
  }

  function uploadCardImage(file: File): void {
    uploadAvatar(file)
      .then((path) => projectOp(projectId, 'setCardImage', { kind: 'person', id: person.id, image: path }))
      .catch((err: Error) => toast(err.message));
  }

  function uploadRowAvatar(file: File): void {
    uploadAvatar(file)
      .then((path) => projectOp(projectId, 'setAvatar', { kind: 'person', id: person.id, avatar: path }))
      .catch((err: Error) => toast(err.message));
  }

  return (
    <div className="person-row" data-id={person.id}>
      {isAdmin && (
        <span className="move-btns">
          <button
            className="btn small move-up"
            title="上移"
            disabled={!canUp}
            onClick={() => projectOp(projectId, 'movePerson', { personId: person.id, direction: 'up' })}
          >
            ↑
          </button>
          <button
            className="btn small move-down"
            title="下移"
            disabled={!canDown}
            onClick={() => projectOp(projectId, 'movePerson', { personId: person.id, direction: 'down' })}
          >
            ↓
          </button>
        </span>
      )}
      <img src={avatarURL(person, 48)} alt="" />

      {isAdmin && avatarEdit && (
        <>
          <label className="btn small file-mini" title="更换头像">
            头像
            <input
              type="file"
              className="avatar-change-input"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadRowAvatar(f);
                e.target.value = '';
              }}
            />
          </label>
          {person.avatar && (
            <button
              className="btn small avatar-clear"
              onClick={() =>
                projectOp(projectId, 'setAvatar', { kind: 'person', id: person.id, avatar: null }).catch(
                  (err: Error) => toast(err.message),
                )
              }
            >
              默认
            </button>
          )}
        </>
      )}

      <span
        className="p-name"
        title={person.name}
        style={isCaptain && captainEnabled && captainColor ? { color: captainColor } : undefined}
      >
        {person.name}
        {isCaptain && captainEnabled && (
          <span
            className="captain-badge captain-badge-inline"
            style={
              captainColor
                ? { background: captainColor, color: contrastText(captainColor) }
                : undefined
            }
          >
            {captainLabel}
          </span>
        )}
      </span>
      {isAdmin && (
        <>
          <button className="btn small" type="button" title="修改姓名" onClick={() => { void rename(); }}>
            改名
          </button>
          <button
            className="btn small bio-btn"
            type="button"
            title={person.bio ? '简介：' + person.bio : '设置简介'}
            onClick={() => { void editBio(); }}
          >
            简介
          </button>
          {captainEnabled && person.teamId && (
            <button
              className={'btn small captain-btn' + (isCaptain ? ' primary' : '')}
              type="button"
              title={isCaptain ? '取消队长' : '设为队长（仅限本团队成员）'}
              onClick={() => {
                projectOp(projectId, 'setTeamCaptain', {
                  teamId: person.teamId,
                  personId: isCaptain ? null : person.id,
                }).catch((err: Error) => toast(err.message));
              }}
            >
              {isCaptain ? '取消队长' : '队长'}
            </button>
          )}
        </>
      )}
      <span className={'p-score ' + scoreClass(person.score)}>{person.score}</span>

      {canScore && quickScore && (mobile ? (
        <span className="remote-pad">
          <button className="remote-btn remote-plus" type="button" onClick={() => addScore(1)}>
            +1
          </button>
          <button className="remote-btn remote-minus" type="button" onClick={() => addScore(-1)}>
            −1
          </button>
        </span>
      ) : (
        <span className="quick-scores">
          {presets.map((v) => (
            <button key={v} className="btn small quick-score" data-delta={v} onClick={() => addScore(v)}>
              {v > 0 ? '+' : ''}
              {v}
            </button>
          ))}
        </span>
      ))}

      {canScore && spotlightTrigger && (
        <button
          className="btn small spotlight-trigger"
          type="button"
          title="在大屏居中突显，不改变分数"
          onClick={() =>
            projectOp(projectId, 'triggerSpotlight', {
              targetType: 'person',
              targetId: person.id,
            }).catch((err: Error) => toast(err.message))
          }
        >
          突显
        </button>
      )}

      {canScore && (!mobile || !quickScore) && (
        <span className="score-ctl">
          <input
            type="number"
            className="delta-input"
            value={delta}
            step={1}
            onChange={(e) => setDelta(e.target.value)}
          />
          <button
            className="btn small score-plus"
            onClick={() => {
              const d = readDelta();
              if (d != null) addScore(d);
            }}
          >
            +分
          </button>
          <button
            className="btn small score-minus"
            onClick={() => {
              const d = readDelta();
              if (d != null) addScore(-d);
            }}
          >
            −分
          </button>
        </span>
      )}

      {isAdmin && (
        <>
          <select
            className="team-select"
            value={person.teamId ?? ''}
            onChange={(e) =>
              projectOp(projectId, 'assignTeam', { personId: person.id, teamId: e.target.value || null }).catch(
                (err: Error) => toast(err.message),
              )
            }
          >
            <option value="">无团队</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <label className="btn small file-mini" title="卡片背景图（也用于团队内小卡片）">
            卡面
            <input
              type="file"
              className="card-img-input"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadCardImage(f);
                e.target.value = '';
              }}
            />
          </label>
          {person.cardImage && (
            <button
              className="btn small card-img-clear"
              onClick={() =>
                projectOp(projectId, 'setCardImage', { kind: 'person', id: person.id, image: null }).catch(
                  (err: Error) => toast(err.message),
                )
              }
            >
              清卡面
            </button>
          )}

          <button
            className="btn small danger person-del"
            onClick={() => {
              void (async () => {
                const ok = await confirm({
                  title: '删除人员',
                  message: '确定删除「' + person.name + '」？',
                  confirmText: '删除',
                  danger: true,
                });
                if (!ok) return;
                projectOp(projectId, 'removePerson', { personId: person.id }).catch((err: Error) =>
                  toast(err.message),
                );
              })();
            }}
          >
            删除
          </button>
        </>
      )}
    </div>
  );
}

const PersonRow = memo(PersonRowBase);
