// 居中放大突显的「并列模式」会话：动态加入/替换/退场卡片，保持整体居中布局。
import type { Settings } from '../../shared/types';
import {
  clamp,
  cloneCard,
  effectDuration,
  hideOriginalCard,
  injectSpotDelta,
  prefersReducedMotion,
  showOriginalCard,
  spotlightSize,
} from './core';

export interface SpotlightTarget {
  /** 用于识别同一个人：再次加分时替换旧卡 */
  key: string;
  els: HTMLElement[];
  delta?: number;
  /** 手动/API 突显可覆盖本张卡片的总时长 */
  durationMs?: number;
}

interface SlotCard {
  el: HTMLElement;
  baseWidth: number;
  baseHeight: number;
}

interface Slot {
  key: string;
  els: HTMLElement[];
  group: HTMLElement;
  cards: SlotCard[];
  baseWidth: number;
  baseHeight: number;
  timer: number;
  durationMs?: number;
  leaving: boolean;
  fresh: boolean;
}

interface Session {
  overlay: HTMLElement;
  scrim: HTMLElement;
  slots: Slot[];
  transition: number;
  theme: string;
  squeezeCleanup: (() => void) | null;
  reduced: boolean;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const INNER_GAP = 12;
const SCRIM_FADE = 200;

let session: Session | null = null;

function themeDuration(s: Settings, override?: number): number {
  const n = Number(override);
  if (Number.isFinite(n) && n > 0) return clamp(n, 200, 10000);
  if ((s.spotlightTheme || 'pop') === 'pop') {
    return Math.max(1200, effectDuration(s) + 600);
  }
  return clamp(Number(s.spotlightReturnDuration) || 1600, 600, 6000);
}

function transitionOf(s: Settings): number {
  const n = Number(s.spotlightParallelTransition);
  return Number.isFinite(n) ? clamp(n, 0, 1500) : 300;
}

function ensureSession(s: Settings): Session {
  if (session) {
    session.transition = transitionOf(s);
    session.theme = String(s.spotlightTheme || 'pop');
    return session;
  }
  const overlay = document.createElement('div');
  overlay.className = 'spotlight-parallel-overlay';
  const scrim = document.createElement('div');
  scrim.className = 'spotlight-parallel-scrim';
  if (s.spotlightScrimEnabled === false) scrim.style.display = 'none';
  scrim.style.opacity = '0';
  overlay.appendChild(scrim);
  document.body.appendChild(overlay);
  scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SCRIM_FADE, fill: 'forwards' });
  session = {
    overlay,
    scrim,
    slots: [],
    transition: transitionOf(s),
    theme: String(s.spotlightTheme || 'pop'),
    squeezeCleanup: null,
    reduced: prefersReducedMotion(),
  };
  return session;
}

function buildSlot(target: SpotlightTarget, s: Settings): Slot | null {
  const visible = target.els.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!visible.length) return null;

  const group = document.createElement('div');
  group.className = 'spotlight-parallel-group';
  const cards: SlotCard[] = [];
  let width = 0;
  let height = 0;
  for (const el of visible) {
    const size = spotlightSize(el, s);
    const rect = el.getBoundingClientRect();
    const card = document.createElement('div');
    card.className = 'spotlight-parallel-card';
    card.style.width = size.width + 'px';
    card.style.height = size.height + 'px';
    const clone = cloneCard(el, s);
    injectSpotDelta(clone, target.delta, s);
    if (s.spotlightSizeMode === 'scale') {
      // 原卡片整体等比放大：保留原布局与宽高比，用缩放填满卡片框
      const ratio = rect.width ? size.width / rect.width : 1;
      clone.style.width = rect.width + 'px';
      clone.style.height = rect.height + 'px';
      clone.style.transform = 'scale(' + ratio + ')';
      clone.style.transformOrigin = 'top left';
      card.classList.add('spotlight-scaled');
    }
    card.appendChild(clone);
    group.appendChild(card);
    cards.push({ el: card, baseWidth: size.width, baseHeight: size.height });
    width += size.width;
    height = Math.max(height, size.height);
  }
  width += INNER_GAP * Math.max(0, cards.length - 1);

  // 初始占据原卡位置，随后由 layout 飞入居中。
  const first = visible[0].getBoundingClientRect();
  group.style.left = Math.round(first.left) + 'px';
  group.style.top = Math.round(first.top) + 'px';
  group.style.width = Math.round(first.width) + 'px';
  group.style.height = Math.round(first.height) + 'px';

  return {
    key: target.key,
    els: visible,
    group,
    cards,
    baseWidth: width,
    baseHeight: height,
    timer: 0,
    durationMs: target.durationMs,
    leaving: false,
    fresh: true,
  };
}

function applyBox(el: HTMLElement, box: Box): void {
  el.style.left = box.left + 'px';
  el.style.top = box.top + 'px';
  el.style.width = box.width + 'px';
  el.style.height = box.height + 'px';
}

function moveGroup(sess: Session, slot: Slot, target: Box, duration: number, fresh: boolean): void {
  const group = slot.group;
  const current = group.getBoundingClientRect();
  group.getAnimations().forEach((a) => a.cancel());
  applyBox(group, target);
  if (duration <= 0) return;

  const dx = current.left + current.width / 2 - (target.left + target.width / 2);
  const dy = current.top + current.height / 2 - (target.top + target.height / 2);
  const scale = target.width > 0 ? current.width / target.width : 1;

  let from: Keyframe;
  if (fresh && sess.theme === 'pop') {
    // 放大缩回：直接从居中位置放大淡入
    from = { transform: 'scale(0.72)', opacity: 0 };
  } else if (fresh && sess.theme === 'genie') {
    from = {
      transform: 'translate(' + dx + 'px,' + dy + 'px) scale(0.55,1.28) skewX(-10deg)',
      opacity: 0.35,
    };
  } else {
    from = { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + scale + ')', opacity: 1 };
  }
  group.animate([from, { transform: 'none', opacity: 1 }], {
    duration,
    easing: 'cubic-bezier(0.25, 0.8, 0.25, 1)',
  });
}

function layout(sess: Session, s: Settings): void {
  const live = sess.slots.filter((sl) => !sl.leaving);
  if (!live.length) return;
  const gap = clamp(Number(s.spotlightParallelGap) || 0, 0, 120);
  const maxWidth = Math.max(240, window.innerWidth * 0.92);

  const rawTotal =
    live.reduce((sum, sl) => sum + sl.baseWidth, 0) + gap * Math.max(0, live.length - 1);
  const scale = rawTotal > maxWidth ? maxWidth / rawTotal : 1;

  const widths = live.map((sl) => {
    let w = 0;
    sl.cards.forEach((card) => {
      card.el.style.width = Math.round(card.baseWidth * scale) + 'px';
      card.el.style.height = Math.round(card.baseHeight * scale) + 'px';
      w += Math.round(card.baseWidth * scale);
    });
    return w + INNER_GAP * Math.max(0, sl.cards.length - 1);
  });
  const heights = live.map((sl) =>
    Math.max(...sl.cards.map((card) => Math.round(card.baseHeight * scale))),
  );
  const totalWidth = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, live.length - 1);
  const maxHeight = Math.max(...heights);
  let x = Math.round((window.innerWidth - totalWidth) / 2);
  const top = Math.round((window.innerHeight - maxHeight) / 2);

  live.forEach((slot, i) => {
    const box: Box = { left: x, top, width: widths[i], height: heights[i] };
    moveGroup(sess, slot, box, sess.transition, slot.fresh);
    slot.fresh = false;
    x += widths[i] + gap;
  });
}

function releaseEls(els: HTMLElement[]): void {
  els.forEach((el) => showOriginalCard(el));
}

function maybeClose(sess: Session): void {
  if (sess.slots.length) return;
  if (session === sess) session = null;
  if (sess.squeezeCleanup) {
    sess.squeezeCleanup();
    sess.squeezeCleanup = null;
  }
  sess.scrim
    .animate([{ opacity: 1 }, { opacity: 0 }], { duration: SCRIM_FADE, fill: 'forwards' })
    .onfinish = () => sess.overlay.remove();
}

function leaveSlot(sess: Session, slot: Slot, s: Settings): void {
  if (slot.leaving) return;
  slot.leaving = true;
  window.clearTimeout(slot.timer);
  const finish = (): void => {
    if (session !== sess) return;
    slot.group.remove();
    sess.slots = sess.slots.filter((sl) => sl !== slot);
    releaseEls(slot.els);
    layout(sess, s);
    maybeClose(sess);
  };
  if (sess.transition > 0 && !sess.reduced) {
    const anim = slot.group.animate(
      [
        { opacity: 1, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(0.86)' },
      ],
      { duration: sess.transition, easing: 'ease', fill: 'forwards' },
    );
    anim.onfinish = finish;
  } else {
    finish();
  }
}

function applySqueeze(sess: Session, board: HTMLElement, skip: Set<HTMLElement>, s: Settings): void {
  if ((s.spotlightTheme || 'pop') !== 'squeeze' || sess.squeezeCleanup) return;
  const anims: Animation[] = [];
  const centerX = window.innerWidth / 2;
  const dur = Math.max(240, sess.transition);
  board.querySelectorAll<HTMLElement>('.card[data-kind], .member[data-person]').forEach((n) => {
    if (skip.has(n)) return;
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dir = r.left + r.width / 2 < centerX ? -1 : 1;
    const dist = Math.min(260, Math.max(70, Math.abs(centerX - (r.left + r.width / 2)) * 0.35));
    const away = 'translateX(' + Math.round(dir * dist) + 'px) scale(0.8)';
    anims.push(
      n.animate(
        [
          { transform: 'none', filter: 'blur(0px)', opacity: 1 },
          { transform: away, filter: 'blur(5px)', opacity: 0.5 },
        ],
        { duration: dur, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', fill: 'forwards' },
      ),
    );
  });
  sess.squeezeCleanup = () => {
    anims.forEach((a) => a.cancel());
  };
}

export function playSpotlightParallel(
  board: HTMLElement,
  targets: SpotlightTarget[],
  s: Settings,
): void {
  if (!targets.length) return;
  const sess = ensureSession(s);
  const max = clamp(Number(s.spotlightParallelMax) || 4, 1, 6);

  const skip = new Set<HTMLElement>();
  sess.slots.forEach((sl) => sl.els.forEach((el) => skip.add(el)));
  targets.forEach((t) => t.els.forEach((el) => skip.add(el)));
  applySqueeze(sess, board, skip, s);

  for (const target of targets) {
    // 同一个人再次加分：旧卡平滑退场，新卡加入。
    for (const old of sess.slots) {
      if (old.key === target.key && !old.leaving) leaveSlot(sess, old, s);
    }
    // 超过并列上限：换掉最早的那张。
    while (sess.slots.filter((sl) => !sl.leaving).length >= max) {
      const oldest = sess.slots.find((sl) => !sl.leaving);
      if (!oldest) break;
      leaveSlot(sess, oldest, s);
    }

    const slot = buildSlot(target, s);
    if (!slot) continue;
    sess.slots.push(slot);
    slot.els.forEach((el) => hideOriginalCard(el));
    sess.overlay.appendChild(slot.group);
    slot.timer = window.setTimeout(() => {
      leaveSlot(sess, slot, s);
    }, themeDuration(s, slot.durationMs) + sess.transition);
  }
  layout(sess, s);
  if (!sess.slots.length) maybeClose(sess);
}

/** 打断模式：淡出并关闭并列会话（恢复原卡与联动避开状态）。 */
export function interruptSpotlightParallel(fadeMs = 0): void {
  const sess = session;
  if (!sess) return;
  session = null;
  const dur = clamp(Number(fadeMs) || 0, 0, 2000);
  const els = sess.slots.flatMap((sl) => sl.els);
  sess.slots.forEach((sl) => window.clearTimeout(sl.timer));
  sess.slots = [];
  const finish = (): void => {
    if (sess.squeezeCleanup) {
      sess.squeezeCleanup();
      sess.squeezeCleanup = null;
    }
    releaseEls(els);
    sess.overlay.remove();
  };
  if (dur <= 0 || !sess.overlay.isConnected) {
    finish();
    return;
  }
  sess.overlay
    .animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur, easing: 'ease', fill: 'forwards' })
    .onfinish = finish;
}

/** 切换项目/卸载时立即重置，不播放动画。 */
export function resetSpotlightParallel(): void {
  const sess = session;
  if (!sess) return;
  session = null;
  if (sess.squeezeCleanup) sess.squeezeCleanup();
  sess.slots.forEach((sl) => {
    window.clearTimeout(sl.timer);
    releaseEls(sl.els);
  });
  sess.overlay.remove();
}
