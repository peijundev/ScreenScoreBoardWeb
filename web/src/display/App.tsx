import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { projectOf, useAppStore } from '../shared/store';
import type { Item } from './lib/core';
import {
  applyAppearance,
  applyAutoAvatarSizes,
  assignRanks,
  buildItems,
  playScoreSound,
  prefersReducedMotion,
  rollNumber,
  spawnConfetti,
  spawnHighlight,
  spawnSpotlight,
} from './lib/core';
import Board, { LeaderboardView, WelcomeView } from './components/Board';
import { Clock, Countdown, Marquee } from './components/Overlays';
import { useInteractions } from './hooks/useInteractions';

const params = new URLSearchParams(location.search);
const projectParam = params.get('project');
const viewParam = params.get('view');
const isEdit = params.get('edit') === '1';
const inPreviewFrame = window.parent !== window;

function itemScore(it: Item): number {
  return it.kind === 'person' && it.person ? it.person.score : it.members.reduce((s, m) => s + m.score, 0);
}

export default function App(): JSX.Element {
  const snapshot = useAppStore((s) => s.snapshot);
  const runtime = useAppStore((s) => s.runtime);
  const [projectId] = useState<string | null>(projectParam);
  const project = projectOf(snapshot, projectId);
  const settings = project?.settings;

  const boardRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const prevScores = useRef<Record<string, number>>({});
  const prevRanks = useRef<Record<string, number>>({});
  const prevProject = useRef<string | null>(null);
  const prevRects = useRef(new Map<string, DOMRect>());
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [runtimeReceivedAt] = useState(() => Date.now());

  useEffect(() => {
    document.body.classList.toggle('edit-mode', isEdit);
    document.body.classList.toggle('preview-embed', inPreviewFrame);
  }, []);

  useLayoutEffect(() => {
    if (settings) applyAppearance(settings);
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

  const items = useMemo(() => (project ? buildItems(project, project.settings) : []), [project]);
  const ranked = Boolean(settings && settings.sortBy === 'score' && settings.sortOrder === 'desc');
  const tieMode = settings?.featureRankTies ? String(settings.rankTieMode) : 'none';
  const ranks = useMemo(
    () => (ranked ? assignRanks(items.map(itemScore), tieMode) : items.map(() => null)),
    [items, ranked, tieMode],
  );
  const free = settings?.layoutMode === 'free';
  const editable = isEdit && free;

  useInteractions({
    boardRef,
    titleRef,
    settings,
    editable,
    inPreview: inPreviewFrame,
    projectId: project?.id ?? '',
  });

  // FLIP 排序动画 + 自动头像尺寸
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board || !settings) return;
    const next = new Map<string, DOMRect>();
    board.querySelectorAll<HTMLElement>('.card[data-kind]').forEach((el) => {
      const key = (el.dataset.kind || '') + ':' + (el.dataset.id || '');
      const rect = el.getBoundingClientRect();
      next.set(key, rect);
      const old = prevRects.current.get(key);
      if (old && settings.sortAnimation && settings.displayStyle !== 'xianxia' && !free && !prefersReducedMotion()) {
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
  });

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
    if (settings.rankChangeAnimation && ranked && settings.displayStyle !== 'xianxia' && !prefersReducedMotion()) {
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
      const changed = Object.values(project.people).filter((p) => {
        const d = deltas.get(p.id);
        return d && !(settings.scoreEffectOnlyPositive && d < 0);
      });
      const p = changed[0];
      if (p) {
        const memberEl = board.querySelector<HTMLElement>('.member[data-person="' + p.id + '"]');
        const personEl =
          memberEl || board.querySelector<HTMLElement>('.card[data-kind="person"][data-id="' + p.id + '"]');
        const teamEl = p.teamId
          ? board.querySelector<HTMLElement>('.card[data-kind="team"][data-id="' + p.teamId + '"]')
          : null;
        const els: HTMLElement[] = [];
        if (scope === 'team') {
          if (teamEl) els.push(teamEl);
          else if (personEl) els.push(personEl);
        } else if (scope === 'person_team') {
          if (memberEl && teamEl) els.push(memberEl, teamEl);
          else if (personEl) els.push(personEl);
          else if (teamEl) els.push(teamEl);
        } else {
          if (memberEl) els.push(memberEl);
          else if (personEl) els.push(personEl);
          else if (teamEl) els.push(teamEl);
        }
        if (els.length) spawnSpotlight(board, els, settings, deltas.get(p.id));
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
  const connected = useAppStore.getState().connected;
  const offsetMs = runtime?.serverNow ? runtime.serverNow - runtimeReceivedAt : 0;

  return (
    <>
      <header className="topbar">
        <h1 id="board-title" ref={titleRef}>
          {settings.title}
        </h1>
        <span className="edit-hint">拖动卡片移动位置，右下角调整大小</span>
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
