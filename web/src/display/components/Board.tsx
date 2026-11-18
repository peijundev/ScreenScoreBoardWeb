import { memo, type CSSProperties, type JSX, type RefObject } from 'react';
import type { Layout, Person, Project, Settings, Team } from '../../shared/types';
import { avatarURL } from '../../shared/api';
import {
  fxInfo,
  leaderboardEntries,
  memberFallbackLayouts,
  scoreClass,
  shelfLayouts,
  type Item,
} from '../lib/core';

interface BoardProps {
  project: Project;
  settings: Settings;
  items: Item[];
  ranks: Array<number | null>;
  deltas: Map<string, number>;
  free: boolean;
  editable: boolean;
  boardRef: RefObject<HTMLElement | null>;
}

function cardStyle(entity: Person | Team, layout: Layout | null): CSSProperties {
  const style: Record<string, string> = {};
  if (layout) {
    style.left = layout.x + '%';
    style.top = layout.y + '%';
    style.width = layout.w + '%';
    style.height = layout.h + '%';
  }
  if (entity.cardImage) style['--card-img'] = "url('/" + entity.cardImage + "')";
  return style as CSSProperties;
}

function rankHTML(rank: number | null): JSX.Element | null {
  if (rank == null) return null;
  return <span className="rank">{rank}</span>;
}

function barHTML(score: number, maxAbs: number): JSX.Element {
  const pct = Math.min(100, Math.round((Math.abs(score) / maxAbs) * 100));
  return (
    <span
      className={'score-bar' + (score < 0 ? ' score-bar-neg' : '') + (score === 0 ? ' score-bar-zero' : '')}
      style={{ width: pct + '%' }}
    />
  );
}

function Board({
  settings,
  items,
  ranks,
  deltas,
  free,
  editable,
  boardRef,
}: BoardProps): JSX.Element {
  const maxAbs = Math.max(1, ...items.map((it) => itemScore(it)));
  const fallback = free ? shelfLayouts(items) : [];

  return (
    <main id="board" className={'board' + (free ? ' free' : '')} ref={boardRef as RefObject<HTMLElement>}>
      {items.length === 0 && <div className="empty-tip">暂无数据，请在管理端添加人员</div>}
      {items.map((it, i) => {
        if (it.kind === 'person' && it.person) {
          return (
            <PersonCardMemo
              key={'p:' + it.person.id}
              person={it.person}
              settings={settings}
              layout={free ? it.person.layout || fallback[i] : null}
              delta={deltas.get(it.person.id)}
              rank={ranks[i]}
              maxAbs={maxAbs}
              editable={editable && free}
            />
          );
        }
        if (it.team) {
          return (
            <TeamCardMemo
              key={'t:' + it.team.id}
              team={it.team}
              members={it.members}
              settings={settings}
              layout={free ? it.team.layout || fallback[i] : null}
              deltas={deltas}
              rank={ranks[i]}
              maxAbs={maxAbs}
              editable={editable && free}
              free={free}
            />
          );
        }
        return null;
      })}
    </main>
  );
}

const BoardMemo = memo(Board);
export default BoardMemo;

function itemScore(it: Item): number {
  return it.kind === 'person' && it.person ? it.person.score : it.members.reduce((s, m) => s + m.score, 0);
}

function PersonCard({
  person,
  settings,
  layout,
  delta,
  rank,
  maxAbs,
  editable,
}: {
  person: Person;
  settings: Settings;
  layout: Layout | null;
  delta: number | undefined;
  rank: number | null;
  maxAbs: number;
  editable: boolean;
}): JSX.Element {
  const fx = fxInfo(settings, delta);
  const cls =
    'card person-card av-' +
    String(settings.avatarPosition ?? 'left') +
    (person.cardImage ? ' has-card-image' : '');
  return (
    <div
      className={cls}
      data-kind="person"
      data-id={person.id}
      style={cardStyle(person, layout)}
    >
      {rankHTML(rank)}
      <img src={avatarURL(person)} alt="" />
      <div className="p-body">
        <div className="person-name">{person.name}</div>
        {settings.featureBio && person.bio && (
          <div className="person-bio">{person.bio}</div>
        )}
      </div>
      <div className={'score person-score ' + scoreClass(person.score) + fx.cls}>
        {fx.badge && (
          <span className="fx-delta" style={{ color: fx.badge.color }}>
            {fx.badge.text}
          </span>
        )}
        <span className="score-num" data-person-score={person.id}>
          {person.score}
        </span>
      </div>
      {barHTML(person.score, maxAbs)}
      {editable && <span className="resize-handle" data-handle />}
    </div>
  );
}

function TeamCard({
  team,
  members,
  settings,
  layout,
  deltas,
  rank,
  maxAbs,
  editable,
  free,
}: {
  team: Team;
  members: Person[];
  settings: Settings;
  layout: Layout | null;
  deltas: Map<string, number>;
  rank: number | null;
  maxAbs: number;
  editable: boolean;
  free: boolean;
}): JSX.Element {
  const total = members.reduce((sum, m) => sum + m.score, 0);
  let teamDelta = 0;
  for (const m of members) {
    const d = deltas.get(m.id);
    if (d != null) teamDelta += d;
  }
  const fx = fxInfo(settings, teamDelta);
  const fallback = memberFallbackLayouts(members.length);

  return (
    <div
      className={'card team-card' + (team.cardImage ? ' has-card-image' : '')}
      data-kind="team"
      data-id={team.id}
      style={cardStyle(team, layout)}
    >
      {rankHTML(rank)}
      <div className={'team-head av-' + String(settings.avatarPosition ?? 'left')}>
        <img src={avatarURL(team, 64)} alt="" />
        <div className="team-name">{team.name}</div>
        {settings.showTeamTotal && (
          <div className={'score team-total' + fx.cls}>
            {fx.badge && (
              <span className="fx-delta" style={{ color: fx.badge.color }}>
                {fx.badge.text}
              </span>
            )}
            <span className="score-num" data-team-score={team.id}>
              {total}
            </span>
          </div>
        )}
      </div>
      {settings.featureBio && team.bio && (
        <div className="team-bio">{team.bio}</div>
      )}
      <div className={'team-members' + (free ? ' free' : '')}>
        {members.length === 0 && <div className="member-empty">暂无成员</div>}
        {members.map((m, i) => (
          <MemberChipMemo
            key={m.id}
            member={m}
            settings={settings}
            delta={deltas.get(m.id)}
            layout={free ? m.memberLayout || fallback[i] : null}
            editable={editable}
          />
        ))}
      </div>
      {barHTML(total, maxAbs)}
      {editable && <span className="resize-handle" data-handle />}
    </div>
  );
}

function MemberChip({
  member,
  settings,
  delta,
  layout,
  editable,
}: {
  member: Person;
  settings: Settings;
  delta: number | undefined;
  layout: Layout | null;
  editable: boolean;
}): JSX.Element {
  const fx = fxInfo(settings, delta);
  const style: Record<string, string> = {};
  if (layout) {
    style.left = layout.x + '%';
    style.top = layout.y + '%';
    style.width = layout.w + '%';
    style.height = layout.h + '%';
  }
  if (member.cardImage) style['--card-img'] = "url('/" + member.cardImage + "')";
  return (
    <div
      className={'member av-' + String(settings.avatarPosition ?? 'left') + (member.cardImage ? ' has-card-image' : '')}
      data-person={member.id}
      style={style as CSSProperties}
    >
      <img src={avatarURL(member, 48)} alt="" />
      <div className="m-body">
        <div className="member-name">{member.name}</div>
        {settings.featureBio && member.bio && (
          <div className="member-bio">{member.bio}</div>
        )}
        {settings.showMemberScore && (
          <div className={'score member-score ' + scoreClass(member.score) + fx.cls}>
            {fx.badge && (
              <span className="fx-delta" style={{ color: fx.badge.color }}>
                {fx.badge.text}
              </span>
            )}
            <span className="score-num" data-person-score={member.id}>
              {member.score}
            </span>
          </div>
        )}
      </div>
      {editable && <span className="resize-handle" data-handle />}
    </div>
  );
}

export function LeaderboardView({
  project,
  settings,
}: {
  project: Project;
  settings: Settings;
}): JSX.Element {
  const entries = leaderboardEntries(project, settings);
  const maxAbs = Math.max(1, ...entries.map((e) => Math.abs(e.score)));
  return (
    <main id="leaderboard" className="leaderboard" style={{ ['--lb-scale' as string]: settings.leaderboardScale }}>
      <header className="lb-header">
        <h2>{settings.title || '排行榜'}</h2>
      </header>
      {entries.map((e) => {
        const pct = Math.min(100, Math.round((Math.abs(e.score) / maxAbs) * 100));
        const rowClass =
          'lb-row' +
          (e.score < 0 ? ' lb-neg' : '') +
          (e.rank === 1 ? ' lb-top-1' : e.rank === 2 ? ' lb-top-2' : e.rank === 3 ? ' lb-top-3' : '');
        return (
          <div className={rowClass} key={e.kind + ':' + e.id}>
            <span className="lb-rank">{e.rank}</span>
            <img src={avatarURL({ name: e.name, avatar: e.avatar })} alt="" />
            <div className="lb-main">
              <div className="lb-name">
                {e.name}
                {e.kind === 'team' && <span className="lb-kind">团队</span>}
              </div>
              {e.teamName && <div className="lb-team">{e.teamName}</div>}
            </div>
            <span className={'score lb-score ' + scoreClass(e.score)}>
              <span className="score-num">{e.score}</span>
            </span>
            <span className="lb-bar" style={{ width: pct + '%' }} />
          </div>
        );
      })}
    </main>
  );
}

export function WelcomeView({ settings }: { settings: Settings }): JSX.Element {
  const image = settings.welcomeImage ? "url('/" + settings.welcomeImage + "')" : '';
  const bgColor = image ? '' : settings.welcomeBgColor || (settings.theme === 'light' ? '#ffffff' : '#12161c');
  return (
    <main
      id="welcome"
      className="welcome"
      style={{ backgroundImage: image, backgroundColor: bgColor }}
    >
      <div className="welcome-text">{settings.welcomeText || settings.title}</div>
    </main>
  );
}

const PersonCardMemo = memo(PersonCard);
const TeamCardMemo = memo(TeamCard);
const MemberChipMemo = memo(MemberChip);
