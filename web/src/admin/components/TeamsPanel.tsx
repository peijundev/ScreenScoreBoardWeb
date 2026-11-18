import { useMemo, useRef, useState, type ChangeEvent, type JSX } from 'react';
import type { Project, Team } from '../../shared/types';
import { avatarURL, uploadAvatar } from '../../shared/api';
import { projectOp } from '../../shared/store';
import { quickPresets, toast } from '../../shared/ui';

export default function TeamsPanel({ project }: { project: Project }): JSX.Element {
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);

  const allTeams = useMemo(
    () => Object.values(project.teams).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [project.teams],
  );
  const q = query.trim().toLowerCase();
  const teams = q ? allTeams.filter((t) => t.name.toLowerCase().includes(q)) : allTeams;

  async function onCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    try {
      let uploaded: string | null = null;
      const file = avatarInput.current?.files?.[0];
      if (file) uploaded = await uploadAvatar(file);
      await projectOp(project.id, 'addTeam', { name: value, avatar: uploaded });
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
      <h2>团队</h2>
      {project.settings.featureSearch !== false && (
        <div className="panel-subbar">
          <input
            type="text"
            placeholder="搜索团队"
            aria-label="搜索团队"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      <form className="add-form" onSubmit={onCreate}>
        <img className="avatar-preview" src={avatarURL({ name: name || '?', avatar })} alt="头像预览" />
        <input
          type="text"
          maxLength={20}
          placeholder="团队名"
          aria-label="团队名"
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
          创建
        </button>
      </form>

      <div className="teams-list">
        {allTeams.length === 0 && (
          <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>暂无团队</p>
        )}
        {allTeams.length > 0 && teams.length === 0 && (
          <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>没有匹配的团队</p>
        )}
        {teams.map((t) => (
          <TeamBlock
            key={t.id}
            project={project}
            team={t}
            index={allTeams.indexOf(t)}
            canUp={allTeams.indexOf(t) > 0}
            canDown={allTeams.indexOf(t) < allTeams.length - 1}
            presets={quickPresets(project.settings)}
            teamScore={Boolean(project.settings.featureTeamScore)}
            avatarEdit={project.settings.featureAvatarEdit !== false}
          />
        ))}
      </div>
    </section>
  );
}

interface BlockProps {
  project: Project;
  team: Team;
  index: number;
  canUp: boolean;
  canDown: boolean;
  presets: number[];
  teamScore: boolean;
  avatarEdit: boolean;
}

function TeamBlock({
  project,
  team,
  canUp,
  canDown,
  presets,
  teamScore,
  avatarEdit,
}: BlockProps): JSX.Element {
  const members = useMemo(
    () =>
      Object.values(project.people)
        .filter((p) => p.teamId === team.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [project.people, team.id],
  );
  const total = members.reduce((sum, m) => sum + m.score, 0);

  function addAll(delta: number): void {
    projectOp(project.id, 'addTeamScore', { teamId: team.id, delta }).catch((err: Error) =>
      toast(err.message),
    );
  }

  function rename(): void {
    const name = window.prompt('修改团队名（最多 20 字）', team.name);
    if (name == null) return;
    const value = name.trim();
    if (!value || value === team.name) return;
    projectOp(project.id, 'renameTeam', { teamId: team.id, name: value }).catch((err: Error) =>
      toast(err.message),
    );
  }

  function uploadCardImage(file: File): void {
    uploadAvatar(file)
      .then((path) => projectOp(project.id, 'setCardImage', { kind: 'team', id: team.id, image: path }))
      .catch((err: Error) => toast(err.message));
  }

  function uploadTeamAvatar(file: File): void {
    uploadAvatar(file)
      .then((path) => projectOp(project.id, 'setAvatar', { kind: 'team', id: team.id, avatar: path }))
      .catch((err: Error) => toast(err.message));
  }

  return (
    <div className="team-block" data-id={team.id}>
      <div className="team-top">
        <span className="move-btns">
          <button
            className="btn small move-up"
            title="上移"
            disabled={!canUp}
            onClick={() => projectOp(project.id, 'moveTeam', { teamId: team.id, direction: 'up' })}
          >
            ↑
          </button>
          <button
            className="btn small move-down"
            title="下移"
            disabled={!canDown}
            onClick={() => projectOp(project.id, 'moveTeam', { teamId: team.id, direction: 'down' })}
          >
            ↓
          </button>
        </span>
        <img src={avatarURL(team, 48)} alt="" />

        {avatarEdit && (
          <>
            <label className="btn small file-mini" title="更换团队头像">
              头像
              <input
                type="file"
                className="avatar-change-input"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadTeamAvatar(f);
                  e.target.value = '';
                }}
              />
            </label>
            {team.avatar && (
              <button
                className="btn small avatar-clear"
                onClick={() =>
                  projectOp(project.id, 'setAvatar', { kind: 'team', id: team.id, avatar: null }).catch(
                    (err: Error) => toast(err.message),
                  )
                }
              >
                默认
              </button>
            )}
          </>
        )}

        <span className="t-name editable" title="点击改名" onClick={rename}>
          {team.name}
        </span>
        <span className="t-total">{total} 分</span>

        {teamScore && (
          <span className="quick-scores">
            {presets.map((v) => (
              <button
                key={v}
                className="btn small team-quick"
                title={'每位成员 ' + (v > 0 ? '+' : '') + v}
                onClick={() => addAll(v)}
              >
                {v > 0 ? '+' : ''}
                {v}
              </button>
            ))}
          </span>
        )}

        <label className="btn small file-mini" title="团队卡片背景图">
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
        {team.cardImage && (
          <button
            className="btn small card-img-clear"
            onClick={() =>
              projectOp(project.id, 'setCardImage', { kind: 'team', id: team.id, image: null }).catch(
                (err: Error) => toast(err.message),
              )
            }
          >
            清卡面
          </button>
        )}

        <button
          className="btn small danger team-del"
          onClick={() => {
            if (window.confirm('确定删除团队「' + team.name + '」？成员会被移出但不会删除。')) {
              projectOp(project.id, 'removeTeam', { teamId: team.id }).catch((err: Error) =>
                toast(err.message),
              );
            }
          }}
        >
          删除团队
        </button>
      </div>

      <div className="chips">
        {members.length === 0 && (
          <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            暂无成员（在人员列表中选择团队加入）
          </span>
        )}
        {members.map((m) => (
          <span className="chip" key={m.id}>
            <img src={avatarURL(m, 24)} alt="" />
            {m.name}
            <span
              className="x"
              data-person={m.id}
              title="移出团队"
              onClick={() =>
                projectOp(project.id, 'assignTeam', { personId: m.id, teamId: null }).catch((err: Error) =>
                  toast(err.message),
                )
              }
            >
              ×
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
