import { memo, type CSSProperties, type JSX, type RefObject } from 'react';
import type { Layout, Person, Project, Settings, Team } from '../../shared/types';
import type { ThemeV2, ThemeWidget } from '../../shared/theme';
import { WidgetView, type WidgetContext } from '../theme/widgets';
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
  theme?: ThemeV2 | null;
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

function widgetFor(theme: ThemeV2 | null | undefined, surface: string, slot: string): ThemeWidget | undefined {
  return theme?.widgets.find((w) => w.surface === surface && w.slot === slot && w.visible !== false);
}

function slotOr(
  theme: ThemeV2 | null | undefined,
  surface: string,
  slot: string,
  ctx: WidgetContext,
  fallback: JSX.Element | null,
): JSX.Element | null {
  const widget = widgetFor(theme, surface, slot);
  return widget ? <WidgetView widget={widget} ctx={ctx} /> : fallback;
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
  project,
  settings,
  items,
  ranks,
  deltas,
  free,
  editable,
  boardRef,
  theme,
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
              project={project}
              theme={theme}
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
              project={project}
              theme={theme}
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

/** 队长标签字号：auto 跟随姓名大小，custom 使用固定 px。 */
function captainFontSize(settings: Settings, inMember: boolean): string | number {
  if (settings.teamCaptainSizeMode === 'auto') {
    return inMember
      ? 'calc((var(--name-size) - 4px) * var(--member-scale) * var(--font-scale, 1))'
      : 'calc(var(--name-size) * var(--font-scale, 1))';
  }
  const size = Number(settings.teamCaptainSize) || 12;
  return inMember ? Math.max(8, Math.round(size * 0.8)) : size;
}

/** 根据背景色亮度选择黑/白文字，保证队长标签可读。 */
function contrastText(hex: string): string {
  const value = hex.replace('#', '');
  if (value.length !== 6) return '#fff';
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return '#fff';
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 160 ? '#111' : '#fff';
}

function PersonCard({
  person,
  project,
  theme,
  settings,
  layout,
  delta,
  rank,
  maxAbs,
  editable,
}: {
  person: Person;
  project: Project;
  theme?: ThemeV2 | null;
  settings: Settings;
  layout: Layout | null;
  delta: number | undefined;
  rank: number | null;
  maxAbs: number;
  editable: boolean;
}): JSX.Element {
  const fx = fxInfo(settings, delta);
  const team = person.teamId ? project.teams[person.teamId] : null;
  const isCaptain = Boolean(team && team.captainId === person.id);
  const showCaptain = isCaptain && settings.featureTeamCaptain !== false;
  const captainColor = showCaptain ? String(settings.teamCaptainColor || '') : '';
  const cls =
    'card person-card av-' +
    String(settings.avatarPosition ?? 'left') +
    (person.cardImage ? ' has-card-image' : '');
  const ctx: WidgetContext = {
    project, settings, entity: person, entityKind: 'person', rank, total: 0,
    maxAbs, memberCount: 0, countdown: null, now: Date.now(),
  };
  return (
    <div
      className={cls}
      data-kind="person"
      data-id={person.id}
      style={cardStyle(person, layout)}
    >
      {slotOr(theme, 'card', 'rank', ctx, rankHTML(rank))}
      {slotOr(theme, 'card', 'avatar', ctx, <img src={avatarURL(person)} alt="" />)}
      <div className="p-body">
        <div
          className="person-name-row"
          style={captainColor ? { color: captainColor } : undefined}
        >
          {slotOr(theme, 'card', 'name', ctx, <div className="person-name">{person.name}</div>)}
          {showCaptain && (
            <span
              className="captain-badge"
              style={{
                fontSize: captainFontSize(settings, false),
                ...(captainColor
                  ? { background: captainColor, color: contrastText(captainColor) }
                  : {}),
              }}
            >
              {settings.teamCaptainLabel || '队长'}
            </span>
          )}
        </div>
        {settings.featureBio ? slotOr(theme, 'card', 'bio', ctx, person.bio ? (
          <div className="person-bio">{person.bio}</div>
        ) : null) : null}
      </div>
      {slotOr(theme, 'card', 'score', ctx, (
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
      ))}
      {slotOr(theme, 'card', 'bar', ctx, barHTML(person.score, maxAbs))}
      {widgetFor(theme, 'card', 'extra') && (
        <WidgetView widget={widgetFor(theme, 'card', 'extra')!} ctx={ctx} />
      )}
      {editable && <span className="resize-handle" data-handle />}
    </div>
  );
}

function TeamCard({
  team,
  members,
  project,
  theme,
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
  project: Project;
  theme?: ThemeV2 | null;
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
  const ctx: WidgetContext = {
    project, settings, entity: team, entityKind: 'team', rank, total,
    maxAbs, memberCount: members.length, countdown: null, now: Date.now(),
  };

  return (
    <div
      className={'card team-card' + (team.cardImage ? ' has-card-image' : '')}
      data-kind="team"
      data-id={team.id}
      style={cardStyle(team, layout)}
    >
      {slotOr(theme, 'teamCard', 'rank', ctx, rankHTML(rank))}
      <div className={'team-head av-' + String(settings.avatarPosition ?? 'left')}>
        {slotOr(theme, 'teamCard', 'avatar', ctx, <img src={avatarURL(team, 64)} alt="" />)}
        {slotOr(theme, 'teamCard', 'teamName', ctx, <div className="team-name">{team.name}</div>)}
        {settings.showTeamTotal ? slotOr(theme, 'teamCard', 'teamTotal', ctx, (
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
        )) : null}
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
            project={project}
            theme={theme}
            settings={settings}
            delta={deltas.get(m.id)}
            layout={free ? m.memberLayout || fallback[i] : null}
            maxAbs={maxAbs}
            editable={editable}
          />
        ))}
      </div>
      {slotOr(theme, 'teamCard', 'bar', ctx, barHTML(total, maxAbs))}
      {widgetFor(theme, 'teamCard', 'extra') && (
        <WidgetView widget={widgetFor(theme, 'teamCard', 'extra')!} ctx={ctx} />
      )}
      {editable && <span className="resize-handle" data-handle />}
    </div>
  );
}

function MemberChip({
  member,
  project,
  theme,
  settings,
  delta,
  layout,
  maxAbs,
  editable,
}: {
  member: Person;
  project: Project;
  theme?: ThemeV2 | null;
  settings: Settings;
  delta: number | undefined;
  layout: Layout | null;
  maxAbs: number;
  editable: boolean;
}): JSX.Element {
  const fx = fxInfo(settings, delta);
  const team = member.teamId ? project.teams[member.teamId] : null;
  const isCaptain = Boolean(team && team.captainId === member.id);
  const showCaptain = isCaptain && settings.featureTeamCaptain !== false;
  const captainColor = showCaptain ? String(settings.teamCaptainColor || '') : '';
  const style: Record<string, string> = {};
  if (layout) {
    style.left = layout.x + '%';
    style.top = layout.y + '%';
    style.width = layout.w + '%';
    style.height = layout.h + '%';
  }
  if (member.cardImage) style['--card-img'] = "url('/" + member.cardImage + "')";
  const ctx: WidgetContext = {
    project, settings, entity: member, entityKind: 'person', rank: null, total: 0,
    maxAbs, memberCount: 0, countdown: null, now: Date.now(),
  };
  return (
    <div
      className={'member av-' + String(settings.avatarPosition ?? 'left') + (member.cardImage ? ' has-card-image' : '')}
      data-person={member.id}
      style={style as CSSProperties}
    >
      {slotOr(theme, 'memberChip', 'avatar', ctx, <img src={avatarURL(member, 48)} alt="" />)}
      <div className="m-body">
        <div
          className="member-name-row"
          style={captainColor ? { color: captainColor } : undefined}
        >
          {slotOr(theme, 'memberChip', 'name', ctx, <div className="member-name">{member.name}</div>)}
          {showCaptain && (
            <span
              className="captain-badge"
              style={{
                fontSize: captainFontSize(settings, true),
                ...(captainColor
                  ? { background: captainColor, color: contrastText(captainColor) }
                  : {}),
              }}
            >
              {settings.teamCaptainLabel || '队长'}
            </span>
          )}
        </div>
        {settings.featureBio ? slotOr(theme, 'memberChip', 'bio', ctx, member.bio ? (
          <div className="member-bio">{member.bio}</div>
        ) : null) : null}
        {settings.showMemberScore ? slotOr(theme, 'memberChip', 'score', ctx, (
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
        )) : null}
      </div>
      {widgetFor(theme, 'memberChip', 'extra') && (
        <WidgetView widget={widgetFor(theme, 'memberChip', 'extra')!} ctx={ctx} />
      )}
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
