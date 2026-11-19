import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import type {
  CountdownRuntime, Person, Project, Settings, Team,
} from '../../shared/types';
import type { ThemeWidget } from '../../shared/theme';
import { avatarURL } from '../../shared/api';
import { scoreClass } from '../lib/core';

export interface WidgetContext {
  project: Project;
  settings: Settings;
  entity: Person | Team | null;
  entityKind: 'person' | 'team' | null;
  rank: number | null;
  total: number;
  maxAbs: number;
  memberCount: number;
  countdown: CountdownRuntime | null;
  now: number;
}

function safeColor(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^(#[0-9a-fA-F]{3,8}|transparent|none|[a-zA-Z]+)$/.test(v) ? v : fallback;
}

function safeNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function styleOf(widget: ThemeWidget): CSSProperties {
  const p = widget.props || {};
  const align = p.align === 'left' || p.align === 'right' ? p.align : 'center';
  return {
    fontSize: safeNum(p.fontSize, 1, 400, 0) || undefined,
    fontWeight: safeNum(p.fontWeight, 100, 900, 0) || undefined,
    color: safeColor(p.color, 'inherit'),
    textAlign: align,
    background: p.background ? safeColor(p.background, 'transparent') : undefined,
    padding: p.padding ? safeNum(p.padding, 0, 200, 0) + 'px' : undefined,
    borderRadius: p.radius ? safeNum(p.radius, 0, 400, 0) + 'px' : undefined,
    opacity: p.opacity != null ? safeNum(p.opacity, 0, 1, 1) : undefined,
  };
}

function scoreOf(ctx: WidgetContext): number {
  if (ctx.entityKind === 'team') return ctx.total;
  return ctx.entity ? (ctx.entity as Person).score : 0;
}

function bindValue(widget: ThemeWidget, ctx: WidgetContext): unknown {
  const b = widget.bind?.value;
  if (typeof b !== 'string' || !b) return undefined;
  switch (b) {
    case 'project.title': return ctx.project.settings.title || ctx.project.name;
    case 'project.name': return ctx.project.name;
    case 'self.name': return ctx.entity?.name ?? '';
    case 'self.score': return scoreOf(ctx);
    case 'self.bio': return ctx.entity?.bio ?? '';
    case 'self.avatar': return ctx.entity ? avatarURL(ctx.entity) : '';
    case 'team.name': return ctx.entityKind === 'team' ? ctx.entity?.name ?? '' : '';
    case 'team.total': return ctx.total;
    case 'rank': return ctx.rank ?? '';
    case 'memberCount': return ctx.memberCount;
    case 'countdown.remaining': return ctx.countdown?.remainingMs ?? 0;
    default: return undefined;
  }
}

function textValue(widget: ThemeWidget, ctx: WidgetContext, fallback = ''): string {
  const bound = bindValue(widget, ctx);
  if (bound != null && bound !== '') return String(bound);
  const p = widget.props || {};
  return p.text != null ? String(p.text) : fallback;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function ClockWidget({ widget, now }: { widget: ThemeWidget; now: number }): JSX.Element {
  const d = new Date(now);
  const p = widget.props || {};
  const text = p.showSeconds === false
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return <div className="sdk-widget sdk-clock" style={styleOf(widget)}>{text}</div>;
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

function imageSource(widget: ThemeWidget, ctx: WidgetContext): string {
  const bound = bindValue(widget, ctx);
  const raw = (typeof bound === 'string' && bound) ? bound : String(widget.props?.src || '');
  if (!raw) return '';
  if (/^avatars\/[\w.-]+$/.test(raw)) return '/' + raw;
  if (/^\/media\/[\w./-]+$/.test(raw)) return raw;
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,/.test(raw)) return raw;
  return '';
}

export function WidgetView({ widget, ctx }: { widget: ThemeWidget; ctx: WidgetContext }): JSX.Element | null {
  const now = useNow(widget.type === 'clock');
  if (widget.visible === false) return null;
  const style = styleOf(widget);
  const value = bindValue(widget, ctx);

  switch (widget.type) {
    case 'title':
      return <div className="sdk-widget sdk-title" style={style}>{textValue(widget, ctx, ctx.project.settings.title)}</div>;
    case 'text':
      return <div className="sdk-widget sdk-text" style={style}>{textValue(widget, ctx)}</div>;
    case 'score': {
      const n = Number(value ?? scoreOf(ctx));
      return (
        <span className={'score sdk-score ' + scoreClass(n)} style={style}>
          <span className="score-num" data-person-score={ctx.entityKind === 'person' ? ctx.entity?.id : undefined}
            data-team-score={ctx.entityKind === 'team' ? ctx.entity?.id : undefined}>
            {n}
          </span>
        </span>
      );
    }
    case 'rank':
      return (
        <span className="rank sdk-rank" style={style}>
          {value != null && value !== '' ? String(value) : (ctx.rank ?? '')}
        </span>
      );
    case 'avatar': {
      const src = imageSource(widget, ctx);
      return src ? <img className="sdk-avatar" src={src} alt="" style={style} /> : null;
    }
    case 'image': {
      const src = imageSource(widget, ctx);
      return src ? <img className="sdk-image" src={src} alt="" style={{ ...style, objectFit: 'contain' }} /> : null;
    }
    case 'name':
      return <div className="sdk-name" style={style}>{textValue(widget, ctx, ctx.entity?.name ?? '')}</div>;
    case 'bio':
      return <div className="sdk-bio" style={style}>{textValue(widget, ctx, ctx.entity?.bio ?? '')}</div>;
    case 'teamName':
      return <div className="sdk-team-name" style={style}>{ctx.entityKind === 'team' ? ctx.entity?.name ?? '' : ''}</div>;
    case 'memberCount':
      return <div className="sdk-member-count" style={style}>{ctx.memberCount}</div>;
    case 'progress': {
      const n = Number(value ?? scoreOf(ctx));
      const pct = Math.min(100, Math.max(0, Math.round((Math.abs(n) / Math.max(1, ctx.maxAbs)) * 100)));
      return (
        <div className="sdk-progress" style={style}>
          <span className={'score-bar' + (n < 0 ? ' score-bar-neg' : '')} style={{ width: pct + '%' }} />
        </div>
      );
    }
    case 'clock':
      return <ClockWidget widget={widget} now={now || ctx.now} />;
    case 'countdown': {
      const ms = ctx.countdown?.remainingMs ?? 0;
      return <div className="sdk-widget sdk-countdown" style={style}>{formatDuration(ms)}</div>;
    }
    default:
      return null;
  }
}
