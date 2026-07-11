import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

const BASE = import.meta.env.BASE_URL;

export interface Engine {
  ffmpeg: FFmpeg;
  mt: boolean;
}

export async function loadFFmpeg(): Promise<Engine> {
  const mt = typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated;
  const dir = mt ? `${BASE}ffmpeg/core-mt` : `${BASE}ffmpeg/core-st`;
  const ffmpeg = new FFmpeg();
  // Core files are copied from node_modules into the site at build time, so
  // they are same-origin — no toBlobURL CDN workaround needed.
  await ffmpeg.load({
    coreURL: `${dir}/ffmpeg-core.js`,
    wasmURL: `${dir}/ffmpeg-core.wasm`,
    ...(mt ? { workerURL: `${dir}/ffmpeg-core.worker.js` } : {}),
  });
  // Debug handle for the browser console / automated tests.
  (globalThis as Record<string, unknown>).__ffmpeg = ffmpeg;
  return { ffmpeg, mt };
}

export interface ProbeResult {
  pixFmt: string;
  codec: string;
  width: number;
  height: number;
  duration: number;
  hasAlpha: boolean;
  vp9Alpha: boolean;
}

// Mirrors the pack-alpha-video CLI's ffprobe preflight, plus WebM alpha_mode
// detection (VP8/VP9 alpha is a container tag, not part of pix_fmt).
// Implemented by parsing `ffmpeg -i` log output rather than ffmpeg.ffprobe():
// running ffprobe on the shared core instance leaves it in a state where the
// next exec() aborts (observed with @ffmpeg/core-mt 0.12.10).
export async function probe(ffmpeg: FFmpeg, inName: string): Promise<ProbeResult> {
  const logs: string[] = [];
  const onLog = ({ message }: { message: string }) => logs.push(message);
  ffmpeg.on('log', onLog);
  try {
    // Exits non-zero ("At least one output file must be specified") — the
    // stream metadata we need is in the log output.
    await ffmpeg.exec(['-hide_banner', '-i', inName]);
  } catch {
    /* expected */
  } finally {
    ffmpeg.off('log', onLog);
  }
  const text = logs.join('\n');

  const stream = text.match(
    /Stream #\d+:\d+.*?: Video: (\w+)[^,]*, ([a-z0-9]+)[^,(]*(?:\([^)]*\))?, (\d+)x(\d+)/
  );
  const dur = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const codec = stream?.[1] ?? '';
  const pixFmt = stream?.[2] ?? '';
  const vp9Alpha = ['vp8', 'vp9'].includes(codec) && /alpha_mode\s*:\s*1/.test(text);
  return {
    pixFmt,
    codec,
    width: stream ? Number(stream[3]) : 0,
    height: stream ? Number(stream[4]) : 0,
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
    hasAlpha: pixFmt.includes('a') || vp9Alpha,
    vp9Alpha,
  };
}

export interface PackOptions {
  fps: number;
  crf: number;
  /** Downscale to this width (keeps aspect, even dimensions). Omit for source width. */
  width?: number;
}

export class NoAlphaError extends Error {}

export async function writeInput(ffmpeg: FFmpeg, file: File): Promise<string> {
  const dot = file.name.lastIndexOf('.');
  const inName = 'input' + (dot >= 0 ? file.name.slice(dot) : '.mov');
  await ffmpeg.writeFile(inName, await fetchFile(file));
  return inName;
}

// The MT core's pthread pool is sized to navigator.hardwareConcurrency. With
// ffmpeg's defaults every stage (decoder, filter graph, x264) asks for ~cores
// threads each — the pool is exhausted and thread creation blocks forever
// (x264 alone wants 1.5×cores). Budget explicit per-stage thread counts that
// fit the pool together. Harmless on the single-threaded core.
function threadBudget(): { decode: number; filter: number; encode: number } {
  const pool = Math.max(2, (navigator.hardwareConcurrency || 4) - 2);
  const encode = Math.min(4, Math.max(1, Math.floor(pool / 2)));
  const decode = Math.min(4, Math.max(1, Math.floor(pool / 4)));
  const filter = Math.min(2, Math.max(1, pool - encode - decode));
  return { decode, filter, encode };
}

export async function pack(
  ffmpeg: FFmpeg,
  inName: string,
  probed: ProbeResult,
  opts: PackOptions,
  onProgress: (ratio: number) => void
): Promise<Uint8Array> {
  // Exact filter chain from the pack-alpha-video CLI: premultiply color by
  // alpha (kills edge fringe under bilinear sampling), then stack the color
  // frame on top of the alpha matte into one double-height H.264 frame.
  const scale = opts.width ? `scale=${opts.width}:-2,` : '';
  const filter =
    `[0:v]fps=${opts.fps},${scale}format=rgba,premultiply=inplace=1,format=rgba,` +
    `split[c][a];[a]alphaextract[m];[c][m]vstack`;

  const onProg = ({ progress }: { progress: number }) => {
    if (Number.isFinite(progress)) onProgress(Math.min(1, Math.max(0, progress)));
  };
  // Fallback: the progress event is officially experimental — also derive
  // progress from "time=HH:MM:SS.xx" log lines against the probed duration.
  const onLog = ({ message }: { message: string }) => {
    const m = message.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m && probed.duration > 0) {
      const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      onProgress(Math.min(1, t / probed.duration));
    }
  };
  ffmpeg.on('progress', onProg);
  ffmpeg.on('log', onLog);
  const threads = threadBudget();
  try {
    const code = await ffmpeg.exec([
      '-y',
      '-filter_complex_threads', String(threads.filter),
      '-threads', String(threads.decode),
      // The native vp9 decoder ignores alpha; libvpx-vp9 (before -i) decodes it.
      ...(probed.vp9Alpha ? ['-c:v', probed.codec === 'vp8' ? 'libvpx' : 'libvpx-vp9'] : []),
      '-i', inName,
      '-filter_complex', filter,
      '-c:v', 'libx264', '-threads', String(threads.encode),
      '-crf', String(opts.crf), '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-an',
      'out.mp4',
    ]);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    return (await ffmpeg.readFile('out.mp4')) as Uint8Array;
  } finally {
    ffmpeg.off('progress', onProg);
    ffmpeg.off('log', onLog);
    await cleanup(ffmpeg, [inName, 'out.mp4']);
  }
}

export async function cleanup(ffmpeg: FFmpeg, names: string[]): Promise<void> {
  for (const n of names) {
    try {
      await ffmpeg.deleteFile(n);
    } catch {
      /* file may not exist */
    }
  }
}
