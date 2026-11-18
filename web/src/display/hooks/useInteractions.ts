import { useEffect, type RefObject } from 'react';
import type { Layout, Settings } from '../../shared/types';
import { projectOp } from '../../shared/store';
import { clamp, round2 } from '../lib/core';

const MIN_W = 8;
const MIN_H = 6;

interface DragState {
  type: 'card' | 'member';
  el: HTMLElement;
  kind?: string;
  id?: string;
  personId?: string;
  mode: 'move' | 'resize';
  host: HTMLElement;
  rect: DOMRect;
  startX: number;
  startY: number;
  x: number;
  y: number;
  w: number;
  h: number;
  threshold: number;
  linesX: number[];
  linesY: number[];
  guideV: HTMLElement;
  guideH: HTMLElement;
  pointerId: number;
}

interface TitleDrag {
  header: HTMLElement;
  dx: number;
  dy: number;
  pointerId: number;
}

function readPctRect(el: HTMLElement): Layout {
  return {
    x: parseFloat(el.style.left) || 0,
    y: parseFloat(el.style.top) || 0,
    w: parseFloat(el.style.width) || 0,
    h: parseFloat(el.style.height) || 0,
  };
}

function axisLines(rects: Layout[], axis: 'x' | 'y'): number[] {
  const lines = [0, 50, 100];
  for (const r of rects) {
    if (axis === 'x') lines.push(r.x, r.x + r.w / 2, r.x + r.w);
    else lines.push(r.y, r.y + r.h / 2, r.y + r.h);
  }
  return lines;
}

function findSnap(edges: number[], lines: number[], threshold: number): { diff: number; line: number } | null {
  let best: { diff: number; line: number } | null = null;
  for (const line of lines) {
    for (const edge of edges) {
      const diff = line - edge;
      if (Math.abs(diff) <= threshold && (!best || Math.abs(diff) < Math.abs(best.diff))) {
        best = { diff, line };
      }
    }
  }
  return best;
}

function setGuide(el: HTMLElement, side: 'left' | 'top', pct: number | null): void {
  if (pct == null) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.style[side] = pct + '%';
}

function createGuide(host: HTMLElement, cls: string): HTMLElement {
  const div = document.createElement('div');
  div.className = cls;
  host.appendChild(div);
  return div;
}

interface Options {
  boardRef: RefObject<HTMLElement | null>;
  titleRef: RefObject<HTMLElement | null>;
  settings: Settings | undefined;
  editable: boolean;
  inPreview: boolean;
  projectId: string;
}

/** 自由布局拖拽/缩放/吸附 + 标题自由拖动（移植自 display.js） */
export function useInteractions({ boardRef, titleRef, settings, editable, inPreview, projectId }: Options): void {
  useEffect(() => {
    const board = boardRef.current;
    if (!board || !settings) return;

    let drag: DragState | null = null;
    let titleDrag: TitleDrag | null = null;
    let parentDoc: Document | null = null;

    function listenParent(): void {
      if (parentDoc || window.parent === window) return;
      try {
        parentDoc = window.parent.document;
        parentDoc.addEventListener('pointerup', endAll, true);
        parentDoc.addEventListener('pointercancel', endAll, true);
      } catch {
        parentDoc = null;
      }
    }
    function unlistenParent(): void {
      if (!parentDoc) return;
      try {
        parentDoc.removeEventListener('pointerup', endAll, true);
        parentDoc.removeEventListener('pointercancel', endAll, true);
      } catch {
        // ignore
      }
      parentDoc = null;
    }

    function onPointerDown(e: PointerEvent): void {
      if (!editable || !board || settings?.layoutMode !== 'free') return;
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const card = target.closest<HTMLElement>('.card[data-kind]');
      if (!card || !board.contains(card)) return;
      e.preventDefault();

      const memberEl = target.closest<HTMLElement>('.member[data-person]');
      const mode: 'move' | 'resize' = target.closest('.resize-handle') ? 'resize' : 'move';

      if (memberEl) {
        const area = memberEl.closest<HTMLElement>('.team-members');
        if (!area) return;
        const others = Array.from(area.querySelectorAll<HTMLElement>('.member[data-person]'))
          .filter((el) => el !== memberEl)
          .map(readPctRect);
        drag = {
          type: 'member',
          el: memberEl,
          personId: memberEl.dataset.person,
          mode,
          host: area,
          rect: area.getBoundingClientRect(),
          startX: e.clientX,
          startY: e.clientY,
          x: parseFloat(memberEl.style.left) || 0,
          y: parseFloat(memberEl.style.top) || 0,
          w: parseFloat(memberEl.style.width) || 30,
          h: parseFloat(memberEl.style.height) || 30,
          threshold: 2.2,
          linesX: axisLines(others, 'x'),
          linesY: axisLines(others, 'y'),
          guideV: createGuide(area, 'guide-v'),
          guideH: createGuide(area, 'guide-h'),
          pointerId: e.pointerId,
        };
      } else {
        const others = Array.from(board.querySelectorAll<HTMLElement>('.card[data-kind]'))
          .filter((el) => el !== card)
          .map(readPctRect);
        drag = {
          type: 'card',
          el: card,
          kind: card.dataset.kind,
          id: card.dataset.id,
          mode,
          host: board,
          rect: board.getBoundingClientRect(),
          startX: e.clientX,
          startY: e.clientY,
          x: parseFloat(card.style.left) || 0,
          y: parseFloat(card.style.top) || 0,
          w: parseFloat(card.style.width) || 22,
          h: parseFloat(card.style.height) || 14,
          threshold: 1.4,
          linesX: axisLines(others, 'x'),
          linesY: axisLines(others, 'y'),
          guideV: createGuide(board, 'guide-v'),
          guideH: createGuide(board, 'guide-h'),
          pointerId: e.pointerId,
        };
      }
      drag.el.classList.add('dragging');
      try {
        drag.el.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      listenParent();
    }

    function onPointerMove(e: PointerEvent): void {
      if (drag) {
        e.preventDefault();
        const { rect, startX, startY, mode, el } = drag;
        const dx = ((e.clientX - startX) / rect.width) * 100;
        const dy = ((e.clientY - startY) / rect.height) * 100;
        let x = drag.x;
        let y = drag.y;
        let w = drag.w;
        let h = drag.h;
        if (mode === 'move') {
          let tx = drag.x + dx;
          let ty = drag.y + dy;
          const sx = findSnap([tx, tx + drag.w / 2, tx + drag.w], drag.linesX, drag.threshold);
          const sy = findSnap([ty, ty + drag.h / 2, ty + drag.h], drag.linesY, drag.threshold);
          if (sx) tx += sx.diff;
          if (sy) ty += sy.diff;
          x = clamp(tx, -100, 200);
          y = clamp(ty, -100, 200);
          setGuide(drag.guideV, 'left', sx ? sx.line : null);
          setGuide(drag.guideH, 'top', sy ? sy.line : null);
        } else {
          const sx = findSnap([drag.x + drag.w + dx], drag.linesX, drag.threshold);
          const sy = findSnap([drag.y + drag.h + dy], drag.linesY, drag.threshold);
          w = clamp(drag.w + dx + (sx ? sx.diff : 0), MIN_W, 200);
          h = clamp(drag.h + dy + (sy ? sy.diff : 0), MIN_H, 200);
          setGuide(drag.guideV, 'left', sx ? sx.line : null);
          setGuide(drag.guideH, 'top', sy ? sy.line : null);
        }
        el.style.left = round2(x) + '%';
        el.style.top = round2(y) + '%';
        el.style.width = round2(w) + '%';
        el.style.height = round2(h) + '%';
        return;
      }
      if (titleDrag) {
        e.preventDefault();
        const x = clamp(((e.clientX - titleDrag.dx) / window.innerWidth) * 100, 2, 98);
        const y = clamp(((e.clientY - titleDrag.dy) / window.innerHeight) * 100, 2, 98);
        document.documentElement.style.setProperty('--title-x', round2(x) + '%');
        document.documentElement.style.setProperty('--title-y', round2(y) + '%');
      }
    }

    function finishCard(): void {
      if (!drag) return;
      const d = drag;
      const layout: Layout = {
        x: round2(parseFloat(d.el.style.left) || 0),
        y: round2(parseFloat(d.el.style.top) || 0),
        w: round2(parseFloat(d.el.style.width) || MIN_W),
        h: round2(parseFloat(d.el.style.height) || MIN_H),
      };
      d.guideV.remove();
      d.guideH.remove();
      d.el.classList.remove('dragging');
      drag = null;
      unlistenParent();
      if (d.type === 'member') {
        projectOp(projectId, 'setMemberLayout', { personId: d.personId, layout }).catch(() => {});
      } else {
        projectOp(projectId, 'setLayout', { kind: d.kind, id: d.id, layout }).catch(() => {});
      }
    }

    function finishTitle(): void {
      if (!titleDrag) return;
      const x = round2(parseFloat(document.documentElement.style.getPropertyValue('--title-x')) || 50);
      const y = round2(parseFloat(document.documentElement.style.getPropertyValue('--title-y')) || 8);
      titleDrag.header.classList.remove('dragging');
      titleDrag = null;
      unlistenParent();
      projectOp(projectId, 'updateSettings', { patch: { titleX: x, titleY: y } }).catch(() => {});
    }

    function endAll(): void {
      finishTitle();
      finishCard();
      unlistenParent();
    }

    function onTitleDown(e: PointerEvent): void {
      if (!settings?.titleFree) return;
      if (!editable && !inPreview) return;
      const target = e.target as HTMLElement;
      const header = target.closest<HTMLElement>('.topbar');
      if (!header) return;
      if (target.closest('a, button, input, select')) return;
      e.preventDefault();
      const rect = header.getBoundingClientRect();
      titleDrag = {
        header,
        dx: e.clientX - (rect.left + rect.width / 2),
        dy: e.clientY - (rect.top + rect.height / 2),
        pointerId: e.pointerId,
      };
      header.classList.add('dragging');
      try {
        header.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      listenParent();
    }

    board.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerdown', onTitleDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endAll);
    window.addEventListener('pointercancel', endAll);
    window.addEventListener('blur', endAll);
    document.addEventListener('pointerleave', endAll);
    const onVisibility = (): void => {
      if (document.hidden) endAll();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      board.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerdown', onTitleDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endAll);
      window.removeEventListener('pointercancel', endAll);
      window.removeEventListener('blur', endAll);
      document.removeEventListener('pointerleave', endAll);
      document.removeEventListener('visibilitychange', onVisibility);
      unlistenParent();
    };
  }, [boardRef, titleRef, settings, editable, inPreview, projectId]);
}
