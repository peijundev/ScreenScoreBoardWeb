// 记分音效：内置合成预设 + 已导入音频文件播放。显示端与管理端试听共用。

export interface SoundPreset {
  id: string;
  name: string;
}

/** 内置音效预设；id 与服务端 VALIDATORS 的白名单保持一致 */
export const SOUND_PRESETS: readonly SoundPreset[] = [
  { id: 'default', name: '默认提示音' },
  { id: 'chime', name: '清脆铃声' },
  { id: 'rise', name: '上扬音' },
  { id: 'coin', name: '硬币声' },
  { id: 'drum', name: '鼓点' },
  { id: 'soft', name: '柔和低音' },
];

export const SOUND_PRESET_IDS: readonly string[] = SOUND_PRESETS.map((p) => p.id);

export function isSoundPresetId(id: unknown): id is string {
  return typeof id === 'string' && SOUND_PRESET_IDS.includes(id);
}

export function soundPresetName(id: string): string {
  return SOUND_PRESETS.find((p) => p.id === id)?.name ?? '默认提示音';
}

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  try {
    if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext();
    // 管理端试听由点击手势触发；resume 后照常调度音源，未解锁时静默失败即可
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

interface ToneOptions {
  type: OscillatorType;
  from: number;
  to?: number;
  at: number;
  dur: number;
  gain: number;
}

function tone(ctx: AudioContext, opts: ToneOptions): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const attack = Math.min(0.02, opts.dur / 4);
  osc.type = opts.type;
  osc.frequency.setValueAtTime(Math.max(1, opts.from), opts.at);
  if (opts.to && opts.to !== opts.from) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), opts.at + opts.dur);
  }
  gain.gain.setValueAtTime(0.0001, opts.at);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, opts.gain), opts.at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, opts.at + opts.dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(opts.at);
  osc.stop(opts.at + opts.dur + 0.02);
}

/**
 * 播放内置合成音效。
 * delta > 0 使用上扬音高，delta < 0 使用下坠音高。
 */
export function playPresetSound(id: string, delta: number, volume: number): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const vol = Math.max(0, Math.min(1, Number(volume) || 0)) * 0.25;
  if (vol <= 0) return;
  const t = ctx.currentTime + 0.005;
  const up = delta >= 0;

  switch (id) {
    case 'chime':
      tone(ctx, { type: 'triangle', from: up ? 1568 : 784, at: t, dur: 0.5, gain: vol * 0.9 });
      tone(ctx, { type: 'sine', from: up ? 2093 : 1046, at: t, dur: 0.45, gain: vol * 0.45 });
      break;
    case 'rise':
      if (up) {
        tone(ctx, { type: 'sine', from: 523, at: t, dur: 0.1, gain: vol });
        tone(ctx, { type: 'sine', from: 659, at: t + 0.1, dur: 0.1, gain: vol });
        tone(ctx, { type: 'sine', from: 784, at: t + 0.2, dur: 0.2, gain: vol });
      } else {
        tone(ctx, { type: 'sine', from: 523, at: t, dur: 0.1, gain: vol });
        tone(ctx, { type: 'sine', from: 392, at: t + 0.1, dur: 0.1, gain: vol });
        tone(ctx, { type: 'sine', from: 262, at: t + 0.2, dur: 0.24, gain: vol });
      }
      break;
    case 'coin':
      tone(ctx, { type: 'square', from: up ? 988 : 659, at: t, dur: 0.07, gain: vol * 0.45 });
      tone(ctx, { type: 'square', from: up ? 1319 : 523, at: t + 0.07, dur: 0.22, gain: vol * 0.45 });
      break;
    case 'drum':
      tone(ctx, { type: 'sine', from: up ? 150 : 120, to: 45, at: t, dur: 0.3, gain: vol });
      break;
    case 'soft':
      tone(ctx, { type: 'sine', from: up ? 523 : 392, at: t, dur: 0.6, gain: vol * 0.8 });
      tone(ctx, { type: 'sine', from: up ? 784 : 294, at: t + 0.02, dur: 0.5, gain: vol * 0.35 });
      break;
    default:
      if (up) {
        tone(ctx, { type: 'sine', from: 880, at: t, dur: 0.12, gain: vol });
        tone(ctx, { type: 'sine', from: 1318.5, at: t + 0.08, dur: 0.28, gain: vol });
      } else {
        tone(ctx, { type: 'sine', from: 320, to: 150, at: t, dur: 0.24, gain: vol });
      }
  }
}

/** 播放已导入的音频文件（sounds/xxx.mp3） */
export function playSoundFile(path: string, volume: number): void {
  const clean = String(path || '').replace(/^\/+/, '');
  if (!clean) return;
  try {
    const audio = new Audio('/' + clean);
    audio.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    void audio.play().catch(() => {});
  } catch {
    // ignore
  }
}
