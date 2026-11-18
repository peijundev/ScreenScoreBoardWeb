import { useMemo, useRef, useState, type ChangeEvent, type JSX } from 'react';
import type { Person, Project, Team } from '../../shared/types';
import { avatarURL, uploadAvatar } from '../../shared/api';
import { projectOp } from '../../shared/store';
import { quickPresets, scoreClass, toast } from '../../shared/ui';
import BatchAddDialog from './BatchAddDialog';

interface Props {
  project: Project;
}

export default function PeoplePanel({ project }: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const avatarInput = useRef<HTMLInputElement>(null);
  const settings = project.settings;

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
        {settings.featureBatchAdd !== false && (
          <button className="btn small" type="button" onClick={() => setBatchOpen(true)}>
            批量添加
          </button>
        )}
        {settings.featureResetScores !== false && (
          <button
            className="btn small danger"
            type="button"
            onClick={() => {
              if (!window.confirm('确定把本局所有人员分数清零？')) return;
              projectOp(project.id, 'resetScores')
                .then((res) => toast('已重置 ' + ((res as { count?: number }).count ?? 0) + ' 人'))
                .catch((err: Error) => toast(err.message));
            }}
          >
            重置本局分数
          </button>
        )}
        <span className="hint">
          {q ? people.length + ' / ' + allPeople.length + ' 人' : allPeople.length + ' 人'}
        </span>
      </div>

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
            project={project}
            person={p}
            teams={teams}
            index={allPeople.indexOf(p)}
            canUp={allPeople.indexOf(p) > 0}
            canDown={allPeople.indexOf(p) < allPeople.length - 1}
            presets={quickPresets(settings)}
            quickScore={Boolean(settings.featureQuickScore)}
            avatarEdit={settings.featureAvatarEdit !== false}
          />
        ))}
      </div>

      {batchOpen && <BatchAddDialog project={project} onClose={() => setBatchOpen(false)} />}
    </section>
  );
}

interface RowProps {
  project: Project;
  person: Person;
  teams: Team[];
  index: number;
  canUp: boolean;
  canDown: boolean;
  presets: number[];
  quickScore: boolean;
  avatarEdit: boolean;
}

function PersonRow({
  project,
  person,
  teams,
  canUp,
  canDown,
  presets,
  quickScore,
  avatarEdit,
}: RowProps): JSX.Element {
  const [delta, setDelta] = useState('1');

  function addScore(n: number): void {
    if (!Number.isFinite(n) || n === 0) return;
    projectOp(project.id, 'addScore', { personId: person.id, delta: n }).catch((err: Error) =>
      toast(err.message),
    );
  }

  function readDelta(): number | null {
    const n = Math.round(Number(delta));
    if (!Number.isFinite(n) || n === 0) return null;
    return Math.max(-10000, Math.min(10000, n));
  }

  function rename(): void {
    const name = window.prompt('修改姓名（最多 20 字）', person.name);
    if (name == null) return;
    const value = name.trim();
    if (!value || value === person.name) return;
    projectOp(project.id, 'renamePerson', { personId: person.id, name: value }).catch((err: Error) =>
      toast(err.message),
    );
  }

  function editBio(): void {
    const text = window.prompt('简介（最多 60 字，留空清除）', person.bio || '');
    if (text == null) return;
    projectOp(project.id, 'setBio', { kind: 'person', id: person.id, bio: text }).catch((err: Error) =>
      toast(err.message),
    );
  }

  function uploadCardImage(file: File): void {
    uploadAvatar(file)
      .then((path) => projectOp(project.id, 'setCardImage', { kind: 'person', id: person.id, image: path }))
      .catch((err: Error) => toast(err.message));
  }

  function uploadRowAvatar(file: File): void {
    uploadAvatar(file)
      .then((path) => projectOp(project.id, 'setAvatar', { kind: 'person', id: person.id, avatar: path }))
      .catch((err: Error) => toast(err.message));
  }

  return (
    <div className="person-row" data-id={person.id}>
      <span className="move-btns">
        <button
          className="btn small move-up"
          title="上移"
          disabled={!canUp}
          onClick={() => projectOp(project.id, 'movePerson', { personId: person.id, direction: 'up' })}
        >
          ↑
        </button>
        <button
          className="btn small move-down"
          title="下移"
          disabled={!canDown}
          onClick={() => projectOp(project.id, 'movePerson', { personId: person.id, direction: 'down' })}
        >
          ↓
        </button>
      </span>
      <img src={avatarURL(person, 48)} alt="" />

      {avatarEdit && (
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
                projectOp(project.id, 'setAvatar', { kind: 'person', id: person.id, avatar: null }).catch(
                  (err: Error) => toast(err.message),
                )
              }
            >
              默认
            </button>
          )}
        </>
      )}

      <span className="p-name editable" title="点击改名" onClick={rename}>
        {person.name}
      </span>
      <button
        className="btn small bio-btn"
        type="button"
        title={person.bio ? '简介：' + person.bio : '设置简介'}
        onClick={editBio}
      >
        简介
      </button>
      <span className={'p-score ' + scoreClass(person.score)}>{person.score}</span>

      {quickScore && (
        <span className="quick-scores">
          {presets.map((v) => (
            <button key={v} className="btn small quick-score" data-delta={v} onClick={() => addScore(v)}>
              {v > 0 ? '+' : ''}
              {v}
            </button>
          ))}
        </span>
      )}

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

      <select
        className="team-select"
        value={person.teamId ?? ''}
        onChange={(e) =>
          projectOp(project.id, 'assignTeam', { personId: person.id, teamId: e.target.value || null }).catch(
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
            projectOp(project.id, 'setCardImage', { kind: 'person', id: person.id, image: null }).catch(
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
          if (window.confirm('确定删除「' + person.name + '」？')) {
            projectOp(project.id, 'removePerson', { personId: person.id }).catch((err: Error) =>
              toast(err.message),
            );
          }
        }}
      >
        删除
      </button>
    </div>
  );
}
