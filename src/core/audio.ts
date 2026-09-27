/**
 * 音效播放。
 *
 * 浏览器的音频上下文要求先有用户交互才能出声，因此这里先建好上下文并解码，
 * 首次点击或按键时再恢复播放。音效放在 `public/assets/kenney/audio/`，
 * 由 `tools/sync-assets.ts` 同步，来源为 Kenney（CC0）。
 *
 * 静音选择记在 localStorage，刷新后保持。
 */

import { createLogger, LOG_NS } from './log';

const log = createLogger(LOG_NS.app);

/** 素材根路径，相对文档地址。 */
const BASE = 'assets/kenney/audio/';

/** 需要预加载的音效；键名与调用处一致。 */
const SOUND_NAMES = [
  'step-1',
  'step-2',
  'step-3',
  'step-4',
  'hit-heavy',
  'hit-light',
  'hit-metal',
  'hit-wood',
  'mining',
  'body-fall',
  'slice',
  'chop',
  'coins',
  'potion',
  'book',
  'door-open',
  'door-close',
  'descend',
  'level-up',
  'click',
  'select',
  'confirm',
  'error',
  'open',
  'close',
] as const;

export type SfxName = (typeof SOUND_NAMES)[number];

/** 存储键：静音开关。 */
const MUTE_KEY = 'nethack3d.muted';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buffers = new Map<SfxName, AudioBuffer>();
let muted = false;
let loading: Promise<void> | null = null;
let stepIndex = 0;

/** 读取上次的静音设置。 */
function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 创建音频上下文并预加载音效。
 *
 * 上下文可能处于 suspended 状态，这没关系：解码在挂起时同样可行，
 * 首次用户交互时调用 `resumeAudio()` 恢复。
 */
export function initAudio(): void {
  if (ctx || loading) return;
  muted = readMuted();
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    log.warn('浏览器不支持 WebAudio，音效关闭');
    return;
  }
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.55;
  master.connect(ctx.destination);

  loading = Promise.all(
    SOUND_NAMES.map(async (name) => {
      try {
        const res = await fetch(`${BASE}${name}.ogg`);
        const data = await res.arrayBuffer();
        const buffer = await ctx!.decodeAudioData(data);
        buffers.set(name, buffer);
      } catch (error) {
        log.warn('音效加载失败', { name, error: String(error) });
      }
    }),
  ).then(() => {
    log.info('音效已加载', { count: buffers.size, muted });
  });
}

/** 首次交互时恢复播放。 */
export function resumeAudio(): void {
  if (!ctx || ctx.state !== 'suspended') return;
  void ctx.resume().then(() => log.debug('音频上下文已恢复'));
}

/** 静音开关。 */
export function setMuted(value: boolean): void {
  muted = value;
  if (master) master.gain.value = muted ? 0 : 0.55;
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    // 存储不可用时仅本次生效。
  }
}

export function isMuted(): boolean {
  return muted;
}

/** 是否已经准备好可以出声。 */
export function audioReady(): boolean {
  return !!ctx && buffers.size > 0;
}

/** 已加载的音效数量。 */
export function loadedSoundCount(): number {
  return buffers.size;
}

/**
 * 播放一个音效。
 *
 * `rate` 用于给同一种音效做音高变化，避免连续触发时听感机械。
 */
export function playSfx(
  name: SfxName,
  { rate = 1, gain = 1 }: { rate?: number; gain?: number } = {},
): void {
  if (!ctx || !master || muted) return;
  const buffer = buffers.get(name);
  if (!buffer) return;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  const volume = ctx.createGain();
  volume.gain.value = gain;
  source.connect(volume);
  volume.connect(master);
  source.start();
}

/** 脚步：四个变体轮换，并随机微调音高。 */
export function playFootstep(): void {
  stepIndex = (stepIndex + 1) % 4;
  playSfx(`step-${stepIndex + 1}` as SfxName, { rate: 0.95 + Math.random() * 0.1, gain: 0.5 });
}

/** 把音频状态暴露到控制台，便于排查与自动化检查。 */
export function installAudioConsoleApi(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { __nethack3dAudio: unknown }).__nethack3dAudio = {
    ready: audioReady,
    count: loadedSoundCount,
    muted: isMuted,
    setMuted,
    play: playSfx,
  };
}
