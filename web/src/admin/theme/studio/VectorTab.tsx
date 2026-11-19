import { useEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import type { ThemeLayer, ThemeNode, ThemePoint, ThemeV2 } from '../../../shared/theme';
import { ThemeNodeShape } from '../../../shared/theme-render';

type Tool = 'select' | 'pen' | 'rect' | 'ellipse' | 'line' | 'text';
type ShapeTool = 'rect' | 'ellipse' | 'line' | 'text';
type Selection = { layerId: string; nodeId: string } | null;
type Pt = { x: number; y: number };
type Drag =
  | { mode: 'move'; start: Pt; origin: ThemeNode; layerId: string }
  | { mode: 'resize'; start: Pt; origin: ThemeNode; corner: string; layerId: string }
  | { mode: 'rotate'; origin: ThemeNode; center: Pt; startAngle: number; layerId: string }
  | { mode: 'pen-handle'; layerId: string; nodeId: string; index: number; start: Pt; originPoint: ThemePoint }
  | { mode: 'anchor'; layerId: string; nodeId: string; index: number; start: Pt; originPoint: ThemePoint }
  | { mode: 'handle'; layerId: string; nodeId: string; index: number; kind: 'in' | 'out'; originPoint: ThemePoint }
  | {
      mode: 'create'; tool: ShapeTool; start: Pt; current: Pt;
      startClient: Pt; currentClient: Pt; shift: boolean;
    };

const HANDLE = 10;
const SNAP = 8;

function rid(prefix: string): string {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}

function defaults(type: ShapeTool, x: number, y: number): ThemeNode {
  const base: ThemeNode = {
    id: rid('nd'), type: 'rect',
    x: Math.round(x), y: Math.round(y), w: 240, h: 140, radius: 12, rotation: 0, opacity: 1,
    fill: '#e8a33d', fillOpacity: 1, stroke: 'none', strokeWidth: 0,
    points: [], closed: false, text: '', fontSize: 48, fontFamily: 'system', fontWeight: 700,
    fontStyle: 'normal', textAlign: 'center', src: '', name: '', visible: true, locked: false,
  };
  if (type === 'rect') return { ...base, type: 'rect', w: 240, h: 140, radius: 16 };
  if (type === 'ellipse') return { ...base, type: 'ellipse', w: 180, h: 180, radius: 0 };
  if (type === 'line') return { ...base, type: 'line', w: 260, h: 0, fill: 'none', stroke: '#e8a33d', strokeWidth: 4 };
  return { ...base, type: 'text', w: 360, h: 80, text: '标题文字', fontSize: 56, fill: '#ffffff' };
}

function nodeBounds(node: ThemeNode): { x: number; y: number; w: number; h: number } {
  if (node.type === 'path' && node.points.length) {
    const xs = node.points.map((p) => node.x + p.x);
    const ys = node.points.map((p) => node.y + p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  // 线段用起点 + 有符号宽高表达方向，包围盒需要归一化
  if (node.type === 'line') {
    return {
      x: Math.min(node.x, node.x + node.w),
      y: Math.min(node.y, node.y + node.h),
      w: Math.abs(node.w),
      h: Math.abs(node.h),
    };
  }
  return { x: node.x, y: node.y, w: node.w, h: node.h };
}

function boundsOf(layer: ThemeLayer): ThemeNode[] {
  return layer.nodes;
}

export default function VectorTab({
  theme,
  onChange,
}: {
  theme: ThemeV2;
  onChange: (next: ThemeV2) => void;
}): JSX.Element {
  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<Selection>(null);
  const [layerId, setLayerId] = useState<string | null>(theme.layers[0]?.id ?? null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // 创建中的拖动同时保存在 ref 里，保证 pointerup 总能拿到最新外框
  const createRef = useRef<Extract<Drag, { mode: 'create' }> | null>(null);
  const [pen, setPen] = useState<{ layerId: string; nodeId: string } | null>(null);
  const [penHover, setPenHover] = useState<{ x: number; y: number } | null>(null);
  const [pointIndex, setPointIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [showGrid, setShowGrid] = useState(true);
  const [undo, setUndo] = useState<ThemeV2[]>([]);
  const [redo, setRedo] = useState<ThemeV2[]>([]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const historyBase = useRef<string>('');

  useEffect(() => {
    if (historyBase.current !== theme.meta.id) {
      historyBase.current = theme.meta.id;
      setUndo([]);
      setRedo([]);
      setSelection(null);
      setLayerId(theme.layers[0]?.id ?? null);
      setPen(null);
      setPointIndex(null);
    }
  }, [theme.meta.id, theme.layers]);

  useEffect(() => {
    if (tool !== 'pen') {
      setPen(null);
      setPenHover(null);
    }
  }, [tool]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      if (pen) {
        setPen(null);
        setDrag(null);
        setTool('select');
      }
      if (createRef.current) {
        createRef.current = null;
        setDrag(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pen]);

  useEffect(() => {
    if (layerId && !theme.layers.some((l) => l.id === layerId)) {
      setLayerId(theme.layers[0]?.id ?? null);
      setSelection(null);
    }
  }, [theme.layers, layerId]);

  const activeLayer = useMemo(
    () => theme.layers.find((l) => l.id === layerId) ?? theme.layers[0] ?? null,
    [theme.layers, layerId],
  );
  const selectedNode = useMemo(() => {
    if (!selection) return null;
    const layer = theme.layers.find((l) => l.id === selection.layerId);
    return layer?.nodes.find((n) => n.id === selection.nodeId) ?? null;
  }, [theme.layers, selection]);

  function record(): void {
    setUndo((u) => [...u.slice(-49), theme]);
    setRedo([]);
  }

  function commit(next: ThemeV2, remember = true): void {
    if (remember) record();
    onChange(next);
  }

  function doUndo(): void {
    if (!undo.length) return;
    const prev = undo[undo.length - 1];
    setUndo((u) => u.slice(0, -1));
    setRedo((r) => [theme, ...r].slice(0, 50));
    onChange(prev);
  }

  function doRedo(): void {
    if (!redo.length) return;
    const next = redo[0];
    setRedo((r) => r.slice(1));
    setUndo((u) => [...u, theme].slice(-50));
    onChange(next);
  }

  function mapLayer(id: string, fn: (layer: ThemeLayer) => ThemeLayer): ThemeV2 {
    return { ...theme, layers: theme.layers.map((l) => (l.id === id ? fn(l) : l)) };
  }

  function updateNode(id: string, nodeId: string, patch: Partial<ThemeNode>, remember = false): void {
    if (remember) record();
    onChange(mapLayer(id, (layer) => ({
      ...layer,
      nodes: layer.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
    })));
  }

  function addLayer(): void {
    const layer: ThemeLayer = {
      id: rid('ly'), name: '图层 ' + (theme.layers.length + 1),
      visible: true, locked: false, opacity: 1, blendMode: 'normal',
      x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, nodes: [],
    };
    commit({ ...theme, layers: [...theme.layers, layer] });
    setLayerId(layer.id);
  }

  function removeLayer(id: string): void {
    if (theme.layers.length <= 1) return;
    commit({ ...theme, layers: theme.layers.filter((l) => l.id !== id) });
  }

  function moveLayer(id: string, dir: -1 | 1): void {
    const index = theme.layers.findIndex((l) => l.id === id);
    const target = index + dir;
    if (index < 0 || target < 0 || target >= theme.layers.length) return;
    const layers = [...theme.layers];
    [layers[index], layers[target]] = [layers[target], layers[index]];
    commit({ ...theme, layers });
  }

  function insertNode(node: ThemeNode): void {
    let targetLayer = activeLayer;
    let layers = theme.layers;
    if (!targetLayer) {
      targetLayer = {
        id: rid('ly'), name: '图层 1', visible: true, locked: false, opacity: 1,
        blendMode: 'normal', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, nodes: [],
      };
      layers = [...layers, targetLayer];
    }
    const next = {
      ...theme,
      layers: layers.map((l) => (l.id === targetLayer!.id ? { ...l, nodes: [...l.nodes, node] } : l)),
    };
    commit(next);
    setLayerId(targetLayer.id);
    setSelection({ layerId: targetLayer.id, nodeId: node.id });
    setTool('select');
  }

  /** 单击（没有拖动）时按默认尺寸以落点为中心创建 */
  function defaultNodeAt(toolType: ShapeTool, pt: Pt): ThemeNode {
    const node = defaults(toolType, pt.x, pt.y);
    node.x = Math.round(pt.x - node.w / 2);
    node.y = Math.round(pt.y - node.h / 2);
    return node;
  }

  /** 拖动创建：起点到终点定义外框；Shift 约束为正方形/正圆/45° 线段 */
  function draggedNode(toolType: ShapeTool, start: Pt, raw: Pt, shift: boolean): ThemeNode {
    let end = raw;
    if (shift) {
      const dx = raw.x - start.x;
      const dy = raw.y - start.y;
      if (toolType === 'line') {
        const len = Math.hypot(dx, dy);
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        end = { x: start.x + Math.cos(angle) * len, y: start.y + Math.sin(angle) * len };
      } else {
        const size = Math.max(Math.abs(dx), Math.abs(dy));
        end = { x: start.x + (dx < 0 ? -size : size), y: start.y + (dy < 0 ? -size : size) };
      }
    }
    if (toolType === 'line') {
      const node = defaults('line', 0, 0);
      node.x = Math.round(start.x);
      node.y = Math.round(start.y);
      node.w = Math.round(end.x - start.x);
      node.h = Math.round(end.y - start.y);
      return node;
    }
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const node = defaults(toolType, x, y);
    node.x = Math.round(x);
    node.y = Math.round(y);
    if (toolType === 'text') {
      node.w = Math.max(80, Math.round(Math.abs(end.x - start.x)));
      node.h = Math.max(48, Math.round(Math.abs(end.y - start.y)));
    } else {
      node.w = Math.max(4, Math.round(Math.abs(end.x - start.x)));
      node.h = Math.max(4, Math.round(Math.abs(end.y - start.y)));
    }
    return node;
  }

  function ensureLayer(): { layer: ThemeLayer; layers: ThemeLayer[] } {
    if (activeLayer) return { layer: activeLayer, layers: theme.layers };
    const layer: ThemeLayer = {
      id: rid('ly'), name: '路径', visible: true, locked: false, opacity: 1,
      blendMode: 'normal', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, nodes: [],
    };
    setLayerId(layer.id);
    return { layer, layers: [...theme.layers, layer] };
  }

  function startPen(e: ReactPointerEvent<SVGSVGElement>): void {
    const pt = toCanvas(e);
    if (!pen) {
      const { layer, layers } = ensureLayer();
      const point: ThemePoint = {
        x: pt.x, y: pt.y, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, mode: 'smooth',
      };
      const node: ThemeNode = {
        ...defaults('line', 0, 0),
        id: rid('nd'), type: 'path', x: 0, y: 0, w: 0, h: 0,
        fill: 'none', stroke: '#4ea1ff', strokeWidth: 3, closed: false, points: [point],
      };
      commit({
        ...theme,
        layers: layers.map((l) => (l.id === layer.id ? { ...l, nodes: [...l.nodes, node] } : l)),
      });
      setLayerId(layer.id);
      setSelection({ layerId: layer.id, nodeId: node.id });
      setPointIndex(0);
      setPen({ layerId: layer.id, nodeId: node.id });
      setDrag({
        mode: 'pen-handle', layerId: layer.id, nodeId: node.id, index: 0,
        start: pt, originPoint: point,
      });
      return;
    }
    const layer = theme.layers.find((l) => l.id === pen.layerId);
    const node = layer?.nodes.find((n) => n.id === pen.nodeId);
    if (!layer || !node) {
      setPen(null);
      return;
    }
    const point: ThemePoint = {
      x: pt.x, y: pt.y, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, mode: 'smooth',
    };
    const index = node.points.length;
    commit(mapLayer(pen.layerId, (l) => ({
      ...l,
      nodes: l.nodes.map((n) => (n.id === pen.nodeId ? { ...n, points: [...n.points, point] } : n)),
    })));
    setPointIndex(index);
    setDrag({
      mode: 'pen-handle', layerId: pen.layerId, nodeId: pen.nodeId, index,
      start: pt, originPoint: point,
    });
  }

  function finishPen(): void {
    setPen(null);
    setDrag(null);
    setPenHover(null);
    setTool('select');
  }

  function updatePoints(
    layerIdValue: string,
    nodeId: string,
    fn: (points: ThemePoint[]) => ThemePoint[],
  ): void {
    onChange(mapLayer(layerIdValue, (layer) => ({
      ...layer,
      nodes: layer.nodes.map((n) => (n.id === nodeId ? { ...n, points: fn(n.points) } : n)),
    })));
  }

  function startPointDrag(e: ReactPointerEvent, layerIdValue: string, node: ThemeNode, index: number): void {
    const pt = toCanvas(e as ReactPointerEvent<SVGSVGElement>);
    record();
    setPointIndex(index);
    setDrag({
      mode: 'anchor', layerId: layerIdValue, nodeId: node.id, index,
      start: pt, originPoint: { ...node.points[index], in: { ...node.points[index].in }, out: { ...node.points[index].out } },
    });
    e.stopPropagation();
    e.preventDefault();
  }

  function startHandleDrag(
    e: ReactPointerEvent,
    layerIdValue: string,
    node: ThemeNode,
    index: number,
    kind: 'in' | 'out',
  ): void {
    const point = node.points[index];
    record();
    setPointIndex(index);
    setDrag({
      mode: 'handle', layerId: layerIdValue, nodeId: node.id, index, kind,
      originPoint: { ...point, in: { ...point.in }, out: { ...point.out } },
    });
    e.stopPropagation();
    e.preventDefault();
  }

  function appendPoint(): void {
    if (!selectedNode || selectedNode.type !== 'path') return;
    const pts = selectedNode.points;
    const last = pts[pts.length - 1] || { x: 0, y: 0, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, mode: 'smooth' };
    const point: ThemePoint = {
      x: last.x + 80, y: last.y + 40, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, mode: 'smooth',
    };
    if (!selection) return;
    updateNode(selection.layerId, selection.nodeId, { points: [...pts, point] }, true);
    setPointIndex(pts.length);
  }

  function removePoint(): void {
    if (!selection || !selectedNode || selectedNode.type !== 'path' || pointIndex == null) return;
    if (selectedNode.points.length <= 1) return;
    const pts = selectedNode.points.filter((_, i) => i !== pointIndex);
    updateNode(selection.layerId, selection.nodeId, { points: pts }, true);
    setPointIndex(Math.max(0, Math.min(pointIndex, pts.length - 1)));
  }

  function toggleClosed(): void {
    if (!selection || !selectedNode || selectedNode.type !== 'path') return;
    updateNode(selection.layerId, selection.nodeId, { closed: !selectedNode.closed }, true);
  }

  function toCanvas(e: ReactPointerEvent<SVGSVGElement>): { x: number; y: number } {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * theme.canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * theme.canvas.height,
    };
  }

  function snapMove(node: ThemeNode, dx: number, dy: number): { dx: number; dy: number } {
    const b = nodeBounds(node);
    const targetsX: number[] = [0, theme.canvas.width / 2, theme.canvas.width];
    const targetsY: number[] = [0, theme.canvas.height / 2, theme.canvas.height];
    for (const layer of theme.layers) {
      for (const other of boundsOf(layer)) {
        if (other.id === node.id) continue;
        const ob = nodeBounds(other);
        targetsX.push(ob.x, ob.x + ob.w / 2, ob.x + ob.w);
        targetsY.push(ob.y, ob.y + ob.h / 2, ob.y + ob.h);
      }
    }
    const edgesX = [b.x + dx, b.x + b.w / 2 + dx, b.x + b.w + dx];
    const edgesY = [b.y + dy, b.y + b.h / 2 + dy, b.y + b.h + dy];
    let bestX = SNAP + 1;
    let bestY = SNAP + 1;
    for (const target of targetsX) {
      for (let i = 0; i < edgesX.length; i += 1) {
        const delta = target - edgesX[i];
        if (Math.abs(delta) < Math.abs(bestX)) bestX = delta;
      }
    }
    for (const target of targetsY) {
      for (let i = 0; i < edgesY.length; i += 1) {
        const delta = target - edgesY[i];
        if (Math.abs(delta) < Math.abs(bestY)) bestY = delta;
      }
    }
    return {
      dx: dx + (Math.abs(bestX) <= SNAP ? bestX : 0),
      dy: dy + (Math.abs(bestY) <= SNAP ? bestY : 0),
    };
  }

  function onSvgPointerDown(e: ReactPointerEvent<SVGSVGElement>): void {
    if (e.button !== 0) return;
    if (tool === 'pen') {
      startPen(e);
      e.preventDefault();
      return;
    }
    if (tool !== 'select') {
      const pt = toCanvas(e);
      setSelection(null);
      setPointIndex(null);
      const create: Extract<Drag, { mode: 'create' }> = {
        mode: 'create', tool: tool as ShapeTool, start: pt, current: pt,
        startClient: { x: e.clientX, y: e.clientY },
        currentClient: { x: e.clientX, y: e.clientY },
        shift: e.shiftKey,
      };
      createRef.current = create;
      setDrag(create);
      // 捕获指针，拖出画布也能继续编辑与松手
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 部分环境不支持指针捕获，忽略即可 */
      }
      e.preventDefault();
      return;
    }
    if (e.target === svgRef.current) {
      setSelection(null);
      setPointIndex(null);
    }
  }

  function startMove(e: ReactPointerEvent, layer: ThemeLayer, node: ThemeNode): void {
    // 非选择工具下不在节点上拖动，让事件冒泡给画布继续绘制
    if (tool !== 'select') return;
    if (layer.locked || node.locked) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const start = {
      x: ((e.clientX - rect.left) / rect.width) * theme.canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * theme.canvas.height,
    };
    record();
    setSelection({ layerId: layer.id, nodeId: node.id });
    setDrag({ mode: 'move', start, origin: { ...node }, layerId: layer.id });
    e.stopPropagation();
    e.preventDefault();
  }

  function startResize(e: ReactPointerEvent, layerIdValue: string, node: ThemeNode, corner: string): void {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const start = {
      x: ((e.clientX - rect.left) / rect.width) * theme.canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * theme.canvas.height,
    };
    record();
    setDrag({ mode: 'resize', start, origin: { ...node }, corner, layerId: layerIdValue });
    e.stopPropagation();
    e.preventDefault();
  }

  function startRotate(e: ReactPointerEvent, layerIdValue: string, node: ThemeNode): void {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const center = { x: node.x + node.w / 2, y: node.y + node.h / 2 };
    const pt = {
      x: ((e.clientX - rect.left) / rect.width) * theme.canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * theme.canvas.height,
    };
    record();
    setDrag({
      mode: 'rotate', origin: { ...node }, center,
      startAngle: Math.atan2(pt.y - center.y, pt.x - center.x),
      layerId: layerIdValue,
    });
    e.stopPropagation();
    e.preventDefault();
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>): void {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const pt = {
      x: ((e.clientX - rect.left) / rect.width) * theme.canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * theme.canvas.height,
    };
    if (tool === 'pen' && pen) setPenHover(pt);
    if (!drag) return;
    if (drag.mode === 'create') {
      const next: Extract<Drag, { mode: 'create' }> = {
        ...drag,
        current: pt,
        currentClient: { x: e.clientX, y: e.clientY },
        shift: e.shiftKey,
      };
      createRef.current = next;
      setDrag(next);
      return;
    }
    if (drag.mode === 'pen-handle' || drag.mode === 'anchor' || drag.mode === 'handle') {
      updatePoints(drag.layerId, drag.nodeId, (points) => points.map((p, i) => {
        if (i !== drag.index) return p;
        if (drag.mode === 'anchor') {
          return {
            ...p,
            x: Math.round(drag.originPoint.x + pt.x - drag.start.x),
            y: Math.round(drag.originPoint.y + pt.y - drag.start.y),
          };
        }
        if (drag.mode === 'pen-handle') {
          const dx = pt.x - drag.originPoint.x;
          const dy = pt.y - drag.originPoint.y;
          if (Math.hypot(dx, dy) < 2) return { ...p, in: { x: 0, y: 0 }, out: { x: 0, y: 0 } };
          return {
            ...p,
            out: { x: Math.round(dx), y: Math.round(dy) },
            in: { x: Math.round(-dx), y: Math.round(-dy) },
          };
        }
        const owner = theme.layers.find((l) => l.id === drag.layerId)?.nodes.find((n) => n.id === drag.nodeId);
        const nx = owner?.x ?? 0;
        const ny = owner?.y ?? 0;
        const handle = { x: Math.round(pt.x - (nx + p.x)), y: Math.round(pt.y - (ny + p.y)) };
        if (drag.kind === 'out') {
          return { ...p, out: handle, in: p.mode === 'smooth' ? { x: -handle.x, y: -handle.y } : p.in };
        }
        return { ...p, in: handle, out: p.mode === 'smooth' ? { x: -handle.x, y: -handle.y } : p.out };
      }));
      return;
    }
    const node = drag.origin;
    if (drag.mode === 'move') {
      let dx = Math.round(pt.x - drag.start.x);
      let dy = Math.round(pt.y - drag.start.y);
      if (!e.shiftKey) ({ dx, dy } = snapMove(node, dx, dy));
      updateNode(drag.layerId, node.id, { x: node.x + dx, y: node.y + dy });
      return;
    }
    if (drag.mode === 'resize') {
      const ob = nodeBounds(node);
      let x = ob.x;
      let y = ob.y;
      let w = ob.w;
      let h = ob.h;
      const dx = pt.x - drag.start.x;
      const dy = pt.y - drag.start.y;
      if (drag.corner.includes('e')) w = Math.max(10, ob.w + dx);
      if (drag.corner.includes('s')) h = Math.max(10, ob.h + dy);
      if (drag.corner.includes('w')) { w = Math.max(10, ob.w - dx); x = ob.x + (ob.w - w); }
      if (drag.corner.includes('n')) { h = Math.max(10, ob.h - dy); y = ob.y + (ob.h - h); }
      if (node.type === 'line') {
        // 线段用起点 + 有符号宽高，按包围盒比例同时移动两个端点
        const rx0 = ob.w ? (node.x - ob.x) / ob.w : 0.5;
        const ry0 = ob.h ? (node.y - ob.y) / ob.h : 0.5;
        const rx1 = ob.w ? (node.x + node.w - ob.x) / ob.w : 0.5;
        const ry1 = ob.h ? (node.y + node.h - ob.y) / ob.h : 0.5;
        updateNode(drag.layerId, node.id, {
          x: Math.round(x + rx0 * w), y: Math.round(y + ry0 * h),
          w: Math.round((rx1 - rx0) * w), h: Math.round((ry1 - ry0) * h),
        });
        return;
      }
      updateNode(drag.layerId, node.id, {
        x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h),
      });
      return;
    }
    const angle = Math.atan2(pt.y - drag.center.y, pt.x - drag.center.x);
    const deg = Math.round(node.rotation + ((angle - drag.startAngle) * 180) / Math.PI);
    updateNode(drag.layerId, node.id, { rotation: deg });
  }

  function endDrag(): void {
    const active = createRef.current;
    createRef.current = null;
    setDrag(null);
    if (!active) return;
    const moved = Math.hypot(
      active.currentClient.x - active.startClient.x,
      active.currentClient.y - active.startClient.y,
    );
    // 小于 4px 视为单击，使用默认尺寸；否则用拖动外框创建
    const node = moved < 4
      ? defaultNodeAt(active.tool, active.start)
      : draggedNode(active.tool, active.start, active.current, active.shift);
    insertNode(node);
  }

  function cancelDrag(): void {
    createRef.current = null;
    setDrag(null);
  }

  function removeSelectedNode(): void {
    if (!selection) return;
    const next = mapLayer(selection.layerId, (layer) => ({
      ...layer,
      nodes: layer.nodes.filter((n) => n.id !== selection.nodeId),
    }));
    commit(next);
    setSelection(null);
  }

  function patchSelected(patch: Partial<ThemeNode>): void {
    if (!selection) return;
    updateNode(selection.layerId, selection.nodeId, patch, true);
  }

  const b = selectedNode ? nodeBounds(selectedNode) : null;
  const selectedLayer = selection ? theme.layers.find((l) => l.id === selection.layerId) ?? null : null;

  return (
    <div className="vector-editor">
      <aside className="vector-side">
        <div className="vector-toolbar">
          {(['select', 'pen', 'rect', 'ellipse', 'line', 'text'] as Tool[]).map((t) => (
            <button
              key={t}
              type="button"
              className={'btn small' + (tool === t ? ' active' : '')}
              title={t === 'ellipse' ? '圆 / 椭圆（拖动绘制，Shift 约束为正圆）' : t}
              onClick={() => {
                setTool(t);
                if (t !== 'select') {
                  setSelection(null);
                  setPointIndex(null);
                }
              }}
            >
              {t === 'select' ? '选择' : t === 'pen' ? '钢笔' : t === 'rect' ? '矩形' : t === 'ellipse' ? '圆' : t === 'line' ? '线' : '文字'}
            </button>
          ))}
          {pen && (
            <button className="btn small" type="button" onClick={finishPen}>完成路径</button>
          )}
        </div>
        <div className="vector-toolbar">
          <button className="btn small" type="button" onClick={doUndo} disabled={!undo.length}>撤销</button>
          <button className="btn small" type="button" onClick={doRedo} disabled={!redo.length}>重做</button>
          <button className="btn small" type="button" onClick={() => setShowGrid((v) => !v)}>
            {showGrid ? '隐藏网格' : '显示网格'}
          </button>
        </div>
        <div className="vector-toolbar">
          <button className="btn small" type="button" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>−</button>
          <span className="hint">{Math.round(zoom * 100)}%</span>
          <button className="btn small" type="button" onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>+</button>
        </div>
        <div className="vector-section-head">
          <strong>图层</strong>
          <button className="btn small" type="button" onClick={addLayer}>新增</button>
        </div>
        <div className="vector-layers">
          {[...theme.layers].reverse().map((layer) => (
            <div
              key={layer.id}
              className={'vector-layer' + (layer.id === activeLayer?.id ? ' active' : '')}
              onClick={() => { setLayerId(layer.id); setSelection(null); }}
            >
              <button
                type="button"
                className="vector-eye"
                title={layer.visible === false ? '显示' : '隐藏'}
                onClick={(e) => {
                  e.stopPropagation();
                  commit(mapLayer(layer.id, (l) => ({ ...l, visible: l.visible === false })));
                }}
              >
                {layer.visible === false ? '○' : '●'}
              </button>
              <span>{layer.name}</span>
              <button
                type="button"
                className="vector-eye"
                title={layer.locked ? '解锁' : '锁定'}
                onClick={(e) => {
                  e.stopPropagation();
                  commit(mapLayer(layer.id, (l) => ({ ...l, locked: !l.locked })));
                }}
              >
                {layer.locked ? '锁' : '开'}
              </button>
              <button className="vector-eye" type="button" onClick={(e) => { e.stopPropagation(); moveLayer(layer.id, 1); }}>↑</button>
              <button className="vector-eye" type="button" onClick={(e) => { e.stopPropagation(); moveLayer(layer.id, -1); }}>↓</button>
              <button className="vector-eye" type="button" onClick={(e) => { e.stopPropagation(); removeLayer(layer.id); }}>×</button>
            </div>
          ))}
        </div>
        {activeLayer && (
          <>
            <div className="vector-section-head"><strong>节点</strong></div>
            <div className="vector-layers">
              {activeLayer.nodes.map((node) => (
                <div
                  key={node.id}
                  className={'vector-layer' + (selection?.nodeId === node.id ? ' active' : '')}
                  onClick={() => { setSelection({ layerId: activeLayer.id, nodeId: node.id }); setPointIndex(null); }}
                >
                  <span>{node.type} · {node.id.slice(-4)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>

      <div className="vector-stage-wrap">
        <div
          className="vector-stage"
          style={{ width: (zoom * 100) + '%', aspectRatio: theme.canvas.width + ' / ' + theme.canvas.height }}
        >
          <svg
            ref={svgRef}
            viewBox={'0 0 ' + theme.canvas.width + ' ' + theme.canvas.height}
            preserveAspectRatio="xMidYMid meet"
            style={{ cursor: tool === 'select' ? 'default' : 'crosshair' }}
            onPointerDown={onSvgPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={cancelDrag}
          >
            <rect
              x={0} y={0} width={theme.canvas.width} height={theme.canvas.height}
              fill={theme.canvas.background.type === 'color' ? theme.canvas.background.color : '#10141c'}
            />
            {showGrid && (
              <g opacity={0.18} pointerEvents="none">
                {Array.from({ length: 25 }, (_, i) => (
                  <line key={'v' + i} x1={(i * theme.canvas.width) / 24} y1={0} x2={(i * theme.canvas.width) / 24} y2={theme.canvas.height} stroke="#ffffff" strokeWidth={1} />
                ))}
                {Array.from({ length: 15 }, (_, i) => (
                  <line key={'h' + i} x1={0} y1={(i * theme.canvas.height) / 14} x2={theme.canvas.width} y2={(i * theme.canvas.height) / 14} stroke="#ffffff" strokeWidth={1} />
                ))}
              </g>
            )}
            {theme.layers.map((layer) => {
              if (layer.visible === false) return null;
              return (
                <g key={layer.id} opacity={layer.opacity} transform={`translate(${layer.x} ${layer.y})`}>
                  {layer.nodes.map((node) => (
                    <g
                      key={node.id}
                      onPointerDown={(e) => startMove(e, layer, node)}
                      style={{ cursor: tool !== 'select' ? 'crosshair' : layer.locked || node.locked ? 'default' : 'move' }}
                    >
                      <ThemeNodeShape node={node} />
                      <rect
                        x={nodeBounds(node).x} y={nodeBounds(node).y}
                        width={Math.max(6, nodeBounds(node).w)} height={Math.max(6, nodeBounds(node).h)}
                        fill="transparent" pointerEvents="all"
                      />
                    </g>
                  ))}
                </g>
              );
            })}
            {drag?.mode === 'create' && (() => {
              const preview = draggedNode(drag.tool, drag.start, drag.current, drag.shift);
              return (
                <g pointerEvents="none" opacity={0.85}>
                  <ThemeNodeShape
                    node={{
                      ...preview,
                      fill: preview.type === 'line' ? 'none' : preview.fill,
                      fillOpacity: 0.35,
                      stroke: '#4ea1ff',
                      strokeWidth: Math.max(2, preview.strokeWidth),
                    }}
                  />
                  <rect
                    x={nodeBounds(preview).x} y={nodeBounds(preview).y}
                    width={Math.max(1, nodeBounds(preview).w)} height={Math.max(1, nodeBounds(preview).h)}
                    fill="none" stroke="#4ea1ff" strokeWidth={1} strokeDasharray="6 4"
                  />
                </g>
              );
            })()}
            {b && selectedNode && selectedLayer && (
              <g>
                <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke="#4ea1ff" strokeWidth={2} strokeDasharray="8 5" pointerEvents="none" />
                {([['nw', b.x, b.y], ['ne', b.x + b.w, b.y], ['sw', b.x, b.y + b.h], ['se', b.x + b.w, b.y + b.h]] as const).map(([corner, x, y]) => (
                  <rect
                    key={corner} x={x - HANDLE / 2} y={y - HANDLE / 2} width={HANDLE} height={HANDLE}
                    fill="#ffffff" stroke="#4ea1ff" strokeWidth={2} style={{ cursor: 'nwse-resize' }}
                    onPointerDown={(e) => startResize(e, selectedLayer.id, selectedNode, corner)}
                  />
                ))}
                <circle
                  cx={b.x + b.w / 2} cy={b.y - 28} r={HANDLE / 2 + 2}
                  fill="#4ea1ff" stroke="#ffffff" strokeWidth={2} style={{ cursor: 'grab' }}
                  onPointerDown={(e) => startRotate(e, selectedLayer.id, selectedNode)}
                />
                <line x1={b.x + b.w / 2} y1={b.y - 24} x2={b.x + b.w / 2} y2={b.y} stroke="#4ea1ff" strokeWidth={2} pointerEvents="none" />
              </g>
            )}
            {pen && penHover && (() => {
              const layer = theme.layers.find((l) => l.id === pen.layerId);
              const node = layer?.nodes.find((n) => n.id === pen.nodeId);
              const last = node?.points[node.points.length - 1];
              if (!last) return null;
              return (
                <line
                  x1={node!.x + last.x} y1={node!.y + last.y}
                  x2={penHover.x} y2={penHover.y}
                  stroke="#4ea1ff" strokeWidth={2} strokeDasharray="6 5" pointerEvents="none"
                />
              );
            })()}
            {selectedNode?.type === 'path' && selectedLayer && (
              <g>
                {selectedNode.points.map((point, index) => {
                  const ax = selectedNode.x + point.x;
                  const ay = selectedNode.y + point.y;
                  return (
                    <g key={'pt' + index}>
                      {pointIndex === index && point.mode === 'smooth' && (
                        <>
                          <line x1={ax} y1={ay} x2={selectedNode.x + point.x + point.in.x} y2={selectedNode.y + point.y + point.in.y} stroke="#ffcc66" strokeWidth={2} pointerEvents="none" />
                          <line x1={ax} y1={ay} x2={selectedNode.x + point.x + point.out.x} y2={selectedNode.y + point.y + point.out.y} stroke="#ffcc66" strokeWidth={2} pointerEvents="none" />
                          <circle cx={selectedNode.x + point.x + point.in.x} cy={selectedNode.y + point.y + point.in.y} r={5} fill="#ffcc66" stroke="#ffffff" strokeWidth={1}
                            onPointerDown={(e) => startHandleDrag(e, selectedLayer.id, selectedNode, index, 'in')} />
                          <circle cx={selectedNode.x + point.x + point.out.x} cy={selectedNode.y + point.y + point.out.y} r={5} fill="#ffcc66" stroke="#ffffff" strokeWidth={1}
                            onPointerDown={(e) => startHandleDrag(e, selectedLayer.id, selectedNode, index, 'out')} />
                        </>
                      )}
                      <circle cx={ax} cy={ay} r={7} fill={pointIndex === index ? '#ffcc66' : '#ffffff'} stroke="#4ea1ff" strokeWidth={2}
                        style={{ cursor: 'move' }}
                        onPointerDown={(e) => startPointDrag(e, selectedLayer.id, selectedNode, index)} />
                    </g>
                  );
                })}
              </g>
            )}
          </svg>
        </div>
      </div>

      <aside className="vector-side">
        <div className="vector-section-head"><strong>属性</strong></div>
        {selectedNode && selectedLayer ? (
          <div className="vector-props">
            <label>X<input type="number" value={selectedNode.x} onChange={(e) => patchSelected({ x: Number(e.target.value) })} /></label>
            <label>Y<input type="number" value={selectedNode.y} onChange={(e) => patchSelected({ y: Number(e.target.value) })} /></label>
            <label>宽<input type="number" value={selectedNode.w} onChange={(e) => patchSelected({ w: Math.max(0, Number(e.target.value)) })} /></label>
            <label>高<input type="number" value={selectedNode.h} onChange={(e) => patchSelected({ h: Math.max(0, Number(e.target.value)) })} /></label>
            <label>旋转<input type="number" value={selectedNode.rotation} onChange={(e) => patchSelected({ rotation: Number(e.target.value) })} /></label>
            <label>不透明度<input type="number" min={0} max={1} step={0.05} value={selectedNode.opacity} onChange={(e) => patchSelected({ opacity: Number(e.target.value) })} /></label>
            <label>填充<input value={selectedNode.fill} onChange={(e) => patchSelected({ fill: e.target.value })} /></label>
            <label>描边<input value={selectedNode.stroke} onChange={(e) => patchSelected({ stroke: e.target.value })} /></label>
            <label>描边宽<input type="number" min={0} value={selectedNode.strokeWidth} onChange={(e) => patchSelected({ strokeWidth: Number(e.target.value) })} /></label>
            {selectedNode.type === 'rect' && (
              <label>圆角<input type="number" min={0} value={selectedNode.radius} onChange={(e) => patchSelected({ radius: Number(e.target.value) })} /></label>
            )}
            {selectedNode.type === 'path' && (
              <>
                <p className="hint">路径点 {selectedNode.points.length} 个{selectedNode.closed ? '（闭合）' : ''}</p>
                <button className="btn small" type="button" onClick={appendPoint}>追加点</button>
                <button className="btn small" type="button" onClick={removePoint} disabled={pointIndex == null}>删除选中点</button>
                <button className="btn small" type="button" onClick={toggleClosed}>{selectedNode.closed ? '打开路径' : '闭合路径'}</button>
              </>
            )}
            {selectedNode.type === 'text' && (
              <>
                <label>文字<input value={selectedNode.text} onChange={(e) => patchSelected({ text: e.target.value })} /></label>
                <label>字号<input type="number" min={1} value={selectedNode.fontSize} onChange={(e) => patchSelected({ fontSize: Number(e.target.value) })} /></label>
                <label>对齐
                  <select value={selectedNode.textAlign} onChange={(e) => patchSelected({ textAlign: e.target.value as ThemeNode['textAlign'] })}>
                    <option value="left">左</option><option value="center">中</option><option value="right">右</option>
                  </select>
                </label>
              </>
            )}
            <button className="btn small danger" type="button" onClick={removeSelectedNode}>删除节点</button>
          </div>
        ) : (
          <div className="vector-props">
            <p className="hint">选择节点后可编辑属性。</p>
            <label>画布宽
              <input type="number" min={8} value={theme.canvas.width}
                onChange={(e) => commit({ ...theme, canvas: { ...theme.canvas, width: Math.max(8, Number(e.target.value)) } })} />
            </label>
            <label>画布高
              <input type="number" min={8} value={theme.canvas.height}
                onChange={(e) => commit({ ...theme, canvas: { ...theme.canvas, height: Math.max(8, Number(e.target.value)) } })} />
            </label>
            <label>背景色
              <input value={theme.canvas.background.color}
                onChange={(e) => commit({ ...theme, canvas: { ...theme.canvas, background: { ...theme.canvas.background, type: 'color', color: e.target.value } } })} />
            </label>
          </div>
        )}
      </aside>
    </div>
  );
}
