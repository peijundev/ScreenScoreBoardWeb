import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { projectOf, useAppStore } from '../shared/store';
import type { Settings } from '../shared/types';
import type { ThemeV2 } from '../shared/theme';
import type { Item } from './lib/core';
import {
  applyAppearance,
  applyAutoAvatarSizes,
  assignRanks,
  buildItems,
  interruptSpotlights,
  playScoreSound,
  prefersReducedMotion,
  rollNumber,
  spawnConfetti,
  spawnHighlight,
  spawnSpotlight,
} from './lib/core';
import {
  interruptSpotlightParallel,
  playSpotlightParallel,
  resetSpotlightParallel,
} from './lib/spotlight';
import Board, { LeaderboardView, WelcomeView } from './components/Board';
import ThemeCanvas from './theme/ThemeCanvas';
import ThemeScriptLayer from './theme/ThemeScriptLayer';
import { Clock, Countdown, Marquee } from './components/Overlays';
import { useInteractions } from './hooks/useInteractions';
import { getAuthStatus } from '../shared/auth';

const params = new URLSearchParams(location.search);
const projectParam = params.get('project');
const viewParam = params.get('view');
const isEdit = params.get('edit') === '1';
const inPreviewFrame = window.parent !== window;
// 卡片很多时跳过 FLIP（逐卡读布局会明显拖低帧率）
const FLIP_MAX_ITEMS = 300;
const themeSpecCache = new Map<string, ThemeV2>();

function itemScore(it: Item): number {
  return it.kind === 'person' && it.person ? it.person.score : it.members.reduce((s, m) => s + m.score, 0);
}

export default function App(): JSX.Element {
  const snapshot = useAppStore((s) => s.snapshot);
  const runtime = useAppStore((s) => s.runtime);
  const connected = useAppStore((s) => s.connected);
  const [projectId] = useState<string | null>(projectParam);
  const project = projectOf(snapshot, projectId);
  const [previewTheme, setPreviewTheme] = useState<ThemeV2 | null>(null);
  const baseSettings = project?.settings;
  const settings = useMemo<Settings | undefined>(() => {
    if (!baseSettings) return undefined;
    if (!previewTheme) return baseSettings;
    return {
      ...baseSettings,
      ...previewTheme.settings,
      displayStyle: previewTheme.meta.baseStyle,
    } as Settings;
  }, [baseSettings, previewTheme]);
  const [appliedTheme, setAppliedTheme] = useState<ThemeV2 | null>(null);

  useEffect(() => {
    const id = project?.themeId || null;
    const revision = Number(project?.themeRevision) || 0;
    if (!id) {
      setAppliedTheme(null);
      return;
    }
    const key = id + ':' + revision;
    const cached = themeSpecCache.get(key);
    if (cached) {
      setAppliedTheme(cached);
      return;
    }
    let cancelled = false;
    fetch('/api/themes/' + encodeURIComponent(id))
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { theme?: ThemeV2 } | null) => {
        if (cancelled) return;
        const t = data?.theme || null;
        if (t) themeSpecCache.set(key, t);
        setAppliedTheme(t);
      })
      .catch(() => {
        if (!cancelled) setAppliedTheme(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.themeId, project?.themeRevision]);

  const boardRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const prevScores = useRef<Record<string, number>>({});
  const prevRanks = useRef<Record<string, number>>({});
  const prevProject = useRef<string | null>(null);
  const prevRects = useRef(new Map<string, DOMRect>());
  const prevOrderKey = useRef('');
  const offsetMs = useMemo(
    () => (runtime?.serverNow ? runtime.serverNow - Date.now() : 0),
    [runtime],
  );
  const [carouselIndex, setCarouselIndex] = useState(0);
  const lastAppearance = useRef('');
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    document.body.classList.toggle('preview-embed', inPreviewFrame);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('edit-mode', canEdit);
  }, [canEdit]);

  useEffect(() => {
    const lost = (): void => setCanEdit(false);
    window.addEventListener('ssb:auth-lost', lost);
    return () => window.removeEventListener('ssb:auth-lost', lost);
  }, []);

  useEffect(() => {
    if (!isEdit) return;
    let alive = true;
    void getAuthStatus()
      .then((status) => {
        if (alive) setCanEdit(status.user?.role === 'admin');
      })
      .catch(() => {
        if (alive) setCanEdit(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (!settings) return;
    // 设置对象未变化时跳过整页 CSS 变量/theme 写入
    const signature = JSON.stringify(settings);
    if (signature === lastAppearance.current) return;
    lastAppearance.current = signature;
    applyAppearance(settings);
  }, [settings]);

  // 本次快照带来的分数变化
  const deltas = useMemo(() => {
    const map = new Map<string, number>();
    if (!project) return map;
    if (prevProject.current !== project.id) {
      prevProject.current = project.id;
      prevScores.current = {};
    }
    for (const p of Object.values(project.people)) {
      const prev = prevScores.current[p.id];
      if (prev !== undefined && prev !== p.score) map.set(p.id, p.score - prev);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  const items = useMemo(() => (project ? buildItems(project, settings ?? project.settings) : []), [project, settings]);
  const ranked = Boolean(settings && settings.sortBy === 'score' && settings.sortOrder === 'desc');
  const tieMode = settings?.featureRankTies ? String(settings.rankTieMode) : 'none';
  const ranks = useMemo(
    () => (ranked ? assignRanks(items.map(itemScore), tieMode) : items.map(() => null)),
    [items, ranked, tieMode],
  );
  const free = settings?.layoutMode === 'free';
  const editable = isEdit && free && canEdit;
  const orderKey = useMemo(
    () => items.map((it) => it.kind + ':' + (it.person?.id ?? it.team?.id)).join('|'),
    [items],
  );

  useInteractions({
    boardRef,
    titleRef,
    settings,
    editable,
    inPreview: inPreviewFrame && canEdit,
    projectId: project?.id ?? '',
  });

  // FLIP 排序动画 + 自动头像尺寸
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board || !settings) return;

    // 只在「按分数排序 + 卡片顺序真的变化」时读布局，避免每次广播都强制 reflow
    const canFlip = settings.sortAnimation && settings.displayStyle !== 'xianxia' &&
      settings.sortBy === 'score' && items.length <= FLIP_MAX_ITEMS && !free && !prefersReducedMotion();
    if (!canFlip) {
      prevRects.current = new Map();
      prevOrderKey.current = orderKey;
      applyAutoAvatarSizes(board, settings);
      return;
    }
    if (prevOrderKey.current === orderKey) return;
    prevOrderKey.current = orderKey;

    const next = new Map<string, DOMRect>();
    board.querySelectorAll<HTMLElement>('.card[data-kind]').forEach((el) => {
      const key = (el.dataset.kind || '') + ':' + (el.dataset.id || '');
      const rect = el.getBoundingClientRect();
      next.set(key, rect);
      const old = prevRects.current.get(key);
      if (old) {
        const dx = old.left - rect.left;
        const dy = old.top - rect.top;
        if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
          el.animate(
            [
              { transform: 'translate(' + Math.round(dx) + 'px,' + Math.round(dy) + 'px)' },
              { transform: 'translate(0,0)' },
            ],
            { duration: 420, easing: 'cubic-bezier(0.25,0.8,0.25,1)' },
          );
        }
      }
    });
    prevRects.current = next;
    applyAutoAvatarSizes(board, settings);
  }, [orderKey, settings, free, items.length]);

  useEffect(() => {
    function onResize(): void {
      if (settings) applyAutoAvatarSizes(boardRef.current, settings);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [settings]);

  // 分数变化：音效 / 彩带 / 突显 / 聚光灯 / 滚动数字 / 名次动画
  useEffect(() => {
    if (!project || !settings) return;
    const board = boardRef.current;
    if (!board) return;

    // 名次升降动画
    if (settings.rankChangeAnimation && settings.displayStyle !== 'xianxia' && ranked && !prefersReducedMotion()) {
      items.forEach((it, i) => {
        const id = it.kind === 'person' && it.person ? it.person.id : it.team?.id;
        const rank = ranks[i];
        if (!id || rank == null) return;
        const prev = prevRanks.current[id];
        if (prev != null && rank !== prev) {
          const el = board.querySelector<HTMLElement>(
            '.card[data-kind="' + it.kind + '"][data-id="' + id + '"]',
          );
          if (el) el.classList.add(rank < prev ? 'rank-up' : 'rank-down');
        }
        prevRanks.current[id] = rank;
      });
    } else if (!ranked) {
      prevRanks.current = {};
    }

    const totalDelta = Array.from(deltas.values()).reduce((a, b) => a + b, 0);
    if (totalDelta !== 0) playScoreSound(totalDelta, settings);

    if (settings.displayStyle !== 'xianxia' && settings.scoreEffect === 'confetti') {
      const colors = [
        settings.scoreEffectColor || settings.accent,
        '#6fbf7b', '#e06c75', '#e8a33d', '#4f8cff', '#ffffff',
      ];
      for (const it of items) {
        const d =
          it.kind === 'person' && it.person
            ? deltas.get(it.person.id)
            : it.members.reduce((sum, m) => sum + (deltas.get(m.id) || 0), 0);
        if (!d || (settings.scoreEffectOnlyPositive && d < 0)) continue;
        const id = it.kind === 'person' && it.person ? it.person.id : it.team?.id;
        const el = board.querySelector<HTMLElement>('[data-kind="' + it.kind + '"][data-id="' + id + '"]');
        if (el) spawnConfetti(el, colors, settings.scoreEffectDuration);
      }
    }

    if (settings.displayStyle !== 'xianxia' && settings.scoreEffect === 'spotlight') {
      const scope = String(settings.spotlightScope || 'person');
      const mode = String(settings.spotlightPlayMode || 'queue');
      const changed = Object.values(project.people).filter((p) => {
        const d = deltas.get(p.id);
        return d && !(settings.scoreEffectOnlyPositive && d < 0);
      });
      const spotlightElsFor = (p: { id: string; teamId: string | null }): HTMLElement[] => {
        const memberEl = board.querySelector<HTMLElement>('.member[data-person="' + p.id + '"]');
        const personEl =
          memberEl ||
          board.querySelector<HTMLElement>('.card[data-kind="person"][data-id="' + p.id + '"]');
        const teamEl = p.teamId
          ? board.querySelector<HTMLElement>('.card[data-kind="team"][data-id="' + p.teamId + '"]')
          : null;
        if (scope === 'team') {
          if (teamEl) return [teamEl];
          return personEl ? [personEl] : [];
        }
        if (scope === 'person_team') {
          if (memberEl && teamEl) return [memberEl, teamEl];
          if (personEl) return [personEl];
          return teamEl ? [teamEl] : [];
        }
        if (memberEl) return [memberEl];
        if (personEl) return [personEl];
        return teamEl ? [teamEl] : [];
      };
      // 并列模式：同一次刷新的多人变化一起并列；队列/打断模式保持原行为（只播第一个人）
      const list = mode === 'parallel' ? changed : changed.slice(0, 1);
      const targets = list
        .map((p) => ({ key: p.id, els: spotlightElsFor(p), delta: deltas.get(p.id) }))
        .filter((t) => t.els.length > 0);
      if (targets.length) {
        if (mode === 'parallel' && !prefersReducedMotion()) {
          playSpotlightParallel(board, targets, settings);
        } else {
          if (mode === 'interrupt') {
            const fade = Number(settings.spotlightInterruptFade);
            const fadeMs = Number.isFinite(fade) ? fade : 150;
            interruptSpotlights(fadeMs);
            interruptSpotlightParallel(fadeMs);
          }
          spawnSpotlight(board, targets[0].els, settings, targets[0].delta);
        }
      }
    }

    if (settings.displayStyle !== 'xianxia' && settings.scoreEffect === 'highlight') {
      const changed = Object.values(project.people).filter((p) => {
        const d = deltas.get(p.id);
        return d && !(settings.scoreEffectOnlyPositive && d < 0);
      });
      const els: HTMLElement[] = [];
      for (const p of changed) {
        const el =
          board.querySelector<HTMLElement>('.member[data-person="' + p.id + '"]') ||
          board.querySelector<HTMLElement>('.card[data-kind="person"][data-id="' + p.id + '"]');
        if (el) els.push(el);
      }
      if (els.length && !prefersReducedMotion()) spawnHighlight(els, settings);
    }

    if (settings.scoreRolling && settings.displayStyle !== 'xianxia' && !prefersReducedMotion()) {
      for (const [personId, delta] of deltas) {
        if (!delta) continue;
        const el = board.querySelector<HTMLElement>('.score-num[data-person-score="' + personId + '"]');
        if (el) rollNumber(el, Number(el.textContent) - delta, Number(el.textContent));
      }
    }

    const people = Object.values(project.people);
    prevScores.current = Object.fromEntries(people.map((p) => [p.id, p.score]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  // 轮播
  const carouselActive =
    viewParam == null &&
    Boolean(settings?.featureCarousel) &&
    Array.isArray(settings?.carouselViews) &&
    (settings?.carouselViews as string[]).length > 1;
  useEffect(() => {
    if (!carouselActive || !settings) return;
    const interval = (Number(settings.carouselIntervalSec) || 15) * 1000;
    const id = window.setInterval(() => setCarouselIndex((i) => i + 1), interval);
    return () => window.clearInterval(id);
  }, [carouselActive, settings]);

  // 背景音乐
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !settings) return;
    if (settings.bgmEnabled && settings.bgmFile) {
      const src = '/' + String(settings.bgmFile);
      if (audio.getAttribute('src') !== src) audio.src = src;
      audio.loop = settings.bgmLoop !== false;
      audio.volume = Math.max(0, Math.min(1, Number(settings.bgmVolume)));
      void audio.play().catch(() => {});
    } else {
      audio.pause();
      audio.removeAttribute('src');
    }
  }, [settings?.bgmEnabled, settings?.bgmFile, settings?.bgmLoop, settings?.bgmVolume, settings]);

  useEffect(() => {
    function unlock(): void {
      const audio = audioRef.current;
      const s = useAppStore.getState().snapshot;
      const p = projectOf(s, projectParam);
      if (audio && p?.settings.bgmEnabled && p.settings.bgmFile) void audio.play().catch(() => {});
    }
    document.addEventListener('pointerdown', unlock, { once: true });
    return () => document.removeEventListener('pointerdown', unlock);
  }, []);

  // 管理端主题工作室：草稿预览（只覆盖渲染，不写服务端）
  useEffect(() => {
    function onMessage(e: MessageEvent): void {
      if (e.origin !== location.origin) return;
      if (!e.data || e.data.type !== 'theme-preview') return;
      const t = e.data.theme;
      setPreviewTheme(t && typeof t === 'object' ? (t as ThemeV2) : null);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // 管理端预览：突显效果
  useEffect(() => {
    function onMessage(e: MessageEvent): void {
      if (e.origin !== location.origin) return;
      if (!e.data || e.data.type !== 'preview-spotlight') return;
      const board = boardRef.current;
      if (!board || !settings || settings.displayStyle === 'xianxia') return;
      const scope = String(settings.spotlightScope || 'person');
      const teamCard = board.querySelector<HTMLElement>('.card[data-kind="team"]');
      const memberEl = board.querySelector<HTMLElement>('.member[data-person]');
      const personCard = board.querySelector<HTMLElement>('.card[data-kind="person"]');
      let els: HTMLElement[] = [];
      if (scope === 'team') {
        els = teamCard ? [teamCard] : personCard ? [personCard] : memberEl ? [memberEl] : [];
      } else if (scope === 'person_team') {
        if (memberEl && teamCard) els = [memberEl, teamCard];
        else if (personCard) els = [personCard];
        else if (teamCard) els = [teamCard];
      } else {
        if (memberEl) els = [memberEl];
        else if (personCard) els = [personCard];
        else if (teamCard) els = [teamCard];
      }
      if (els.length) spawnSpotlight(board, els, settings);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [settings]);

  // 切换项目/卸载时清掉正在播放的并列会话，避免残留卡片
  useEffect(() => {
    resetSpotlightParallel();
    return () => resetSpotlightParallel();
  }, [project?.id]);

  if (!project || !settings) {
    return <div className="empty-tip">连接中…</div>;
  }

  const carouselViews = (settings.carouselViews as string[] | undefined) ?? [];
  const effectiveView = carouselActive
    ? carouselViews[carouselIndex % Math.max(1, carouselViews.length)]
    : String(settings.displayView || 'cards');
  const showLeaderboard =
    viewParam === 'leaderboard' || (viewParam == null && effectiveView === 'leaderboard' && settings.featureLeaderboard);
  const showWelcome =
    viewParam === 'welcome' || (viewParam == null && effectiveView === 'welcome' && settings.featureWelcome);

  return (
    <>
      <ThemeCanvas
        theme={previewTheme ?? appliedTheme}
        project={project}
        settings={settings}
        countdown={runtime?.countdowns?.[project.id] ?? null}
      />
      <ThemeScriptLayer
        theme={previewTheme ?? appliedTheme}
        project={project}
        settings={settings}
        runtime={runtime}
      />
      <header className="topbar">
        <h1 id="board-title" ref={titleRef}>
          {settings.title}
        </h1>
        {canEdit && <span className="edit-hint">拖动卡片移动位置，右下角调整大小</span>}
        {isEdit && !canEdit && <span className="edit-hint">编辑需要管理员登录</span>}
        <span id="conn-dot" className={'dot' + (connected ? '' : ' connecting')} title={connected ? '已连接' : '重连中…'} />
      </header>

      {showWelcome ? (
        <WelcomeView settings={settings} />
      ) : showLeaderboard ? (
        <LeaderboardView project={project} settings={settings} />
      ) : (
        <Board
          project={project}
          settings={settings}
          items={items}
          ranks={ranks}
          deltas={deltas}
          free={free}
          editable={editable}
          boardRef={boardRef}
          theme={previewTheme ?? appliedTheme}
        />
      )}

      <Clock settings={settings} />
      <Countdown
        settings={settings}
        countdown={project ? (runtime?.countdowns?.[project.id] ?? null) : null}
        offsetMs={offsetMs}
      />
      <Marquee settings={settings} />
      <audio ref={audioRef} loop preload="auto" />
    </>
  );
}
