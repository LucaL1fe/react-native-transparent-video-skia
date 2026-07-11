import './styles.css';
import type { Engine, ProbeResult } from './ffmpeg';
import { cleanup, loadFFmpeg, pack, probe, writeInput } from './ffmpeg';
import { startPreview, type Preview } from './preview';
import { buildSnippet } from './snippet';
import {
  el,
  estimateSize,
  evenWidth,
  formatBytes,
  formatDuration,
  hide,
  renderChips,
  show,
} from './ui';

const WARN_BYTES = 500 * 1024 * 1024;
const BLOCK_BYTES = 1.5 * 1024 * 1024 * 1024;

let enginePromise: Promise<Engine> | null = null;
let currentFile: File | null = null;
let currentInName: string | null = null;
let probed: ProbeResult | null = null;
let preview: Preview | null = null;
let downloadUrl: string | null = null;

// Settings state
let outWidth = 0;
let fps = 24;
let crf = 18;

function getEngine(): Promise<Engine> {
  if (!enginePromise) {
    el('engine-status').textContent = 'loading ffmpeg engine… (~32 MB, one-time)';
    enginePromise = loadFFmpeg()
      .then((engine) => {
        el('engine-status').textContent = engine.mt
          ? `ffmpeg ready (multithreaded, ${navigator.hardwareConcurrency ?? '?'} cores)`
          : 'ffmpeg ready (single-threaded fallback — conversions will be slower)';
        return engine;
      })
      .catch((e) => {
        enginePromise = null;
        showError(`Could not load the ffmpeg engine: ${message(e)}`);
        throw e;
      });
  }
  return enginePromise;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The npm package ships the same conversion as a cross-platform Node CLI
// (Windows/macOS/Linux, needs ffmpeg in PATH) — offered as the fallback
// whenever the in-browser conversion can't handle a file.
function localFallback(fileName: string): string {
  const flags =
    ` --fps ${fps} --crf ${crf}` + (probed && outWidth !== evenWidth(probed.width) ? ` --width ${outWidth}` : '');
  return (
    `\n\n💻 Local fallback (works on Windows, macOS and Linux — needs Node.js + ffmpeg):\n` +
    `npx pack-alpha-video "${fileName}"${flags}`
  );
}

function showError(text: string): void {
  const banner = el('error-banner');
  banner.textContent = text;
  show('error-banner');
}

function clearError(): void {
  hide('error-banner');
}

async function resetToDrop(): Promise<void> {
  preview?.stop();
  preview = null;
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
  }
  if (currentInName && enginePromise) {
    const name = currentInName;
    currentInName = null;
    try {
      const { ffmpeg } = await enginePromise;
      await cleanup(ffmpeg, [name]);
    } catch {
      /* engine may be gone */
    }
  }
  currentFile = null;
  probed = null;
  hide('settings-section', 'progress-section', 'result-section');
  show('drop-section');
}

// After a failed/aborted exec the wasm instance can be wedged — drop it and
// lazily create a fresh one on the next use.
async function recycleEngine(): Promise<void> {
  if (!enginePromise) return;
  try {
    const { ffmpeg } = await enginePromise;
    ffmpeg.terminate();
  } catch {
    /* already dead */
  }
  enginePromise = null;
  currentInName = null;
}

// ---- file intake ------------------------------------------------------------

async function onFile(file: File): Promise<void> {
  clearError();
  if (file.size > BLOCK_BYTES) {
    showError(
      `${file.name} is ${formatBytes(file.size)} — too large for in-browser conversion ` +
        `(wasm memory is capped at ~2 GB). Trim the clip or export at display resolution first.` +
        localFallback(file.name)
    );
    return;
  }

  currentFile = file;
  el('engine-status').textContent = 'reading file…';

  try {
    const { ffmpeg } = await getEngine();
    if (currentInName) await cleanup(ffmpeg, [currentInName]);
    currentInName = await writeInput(ffmpeg, file);
    probed = await probe(ffmpeg, currentInName);
  } catch (e) {
    showError(`Could not read ${file.name}: ${message(e)}`);
    await recycleEngine();
    await resetToDrop();
    return;
  }

  if (!probed.hasAlpha) {
    showError(
      `${file.name} has no alpha channel (pix_fmt: ${probed.pixFmt || 'unknown'}). ` +
        `Re-export from DaVinci: QuickTime + ProRes 4444 + ✅ Export Alpha. ` +
        `Note: HEVC-with-alpha .mov cannot be decoded here — use ProRes 4444 or VP9 WebM.`
    );
    await resetToDrop();
    return;
  }

  openSettings(file, probed);
}

function openSettings(file: File, p: ProbeResult): void {
  outWidth = evenWidth(p.width);
  el('file-title').textContent = file.name;
  const warn = file.size > WARN_BYTES ? ' — ⚠ large file, conversion may be slow or run out of memory' : '';
  el('file-meta').textContent =
    `${p.codec} · ${p.pixFmt} · ${p.width}×${p.height} · ${formatDuration(p.duration)} · ${formatBytes(file.size)}${warn}`;

  (el<HTMLInputElement>('width-input')).value = String(outWidth);
  (el<HTMLInputElement>('fps-input')).value = String(fps);
  (el<HTMLInputElement>('crf-input')).value = String(crf);
  el('crf-value').textContent = String(crf);

  renderSettings();
  hide('drop-section', 'result-section', 'progress-section');
  show('settings-section');
}

function renderSettings(): void {
  const p = probed;
  if (!p) return;

  const presetFor = (pct: number) => evenWidth((p.width * pct) / 100);
  const heightFor = (w: number) => evenWidth((p.height / p.width) * w);
  renderChips(
    el('res-presets'),
    [100, 75, 50, 33].map((pct) => ({
      label: pct === 100 ? 'Original' : `${pct}%`,
      value: presetFor(pct),
      detail: `${presetFor(pct)}×${heightFor(presetFor(pct))}`,
    })),
    outWidth,
    (w) => {
      outWidth = w;
      (el<HTMLInputElement>('width-input')).value = String(w);
      renderSettings();
    }
  );

  renderChips(
    el('fps-presets'),
    [30, 24, 15].map((v) => ({ label: `${v} fps`, value: v, detail: v === 24 ? 'recommended' : undefined })),
    fps,
    (v) => {
      fps = v;
      (el<HTMLInputElement>('fps-input')).value = String(v);
      renderSettings();
    }
  );

  const est = estimateSize(outWidth, p.width, p.height, fps, crf, p.duration);
  el('size-estimate').textContent = est
    ? `Estimated output: ~${formatBytes(est)} (${outWidth}×${heightFor(outWidth)} display, packed frame is twice as tall)`
    : '';
}

// ---- convert ----------------------------------------------------------------

async function convert(): Promise<void> {
  const p = probed;
  const file = currentFile;
  const inName = currentInName;
  if (!p || !file || !inName) return;

  clearError();
  hide('settings-section');
  show('progress-section');
  const bar = el<HTMLProgressElement>('progress-bar');
  bar.value = 0;
  const started = performance.now();

  try {
    const engine = await getEngine();
    if (!engine.mt) show('st-note');
    const data = await pack(
      engine.ffmpeg,
      inName,
      p,
      { fps, crf, width: outWidth !== evenWidth(p.width) ? outWidth : undefined },
      (ratio) => {
        bar.value = ratio;
        const elapsed = (performance.now() - started) / 1000;
        el('progress-text').textContent =
          `${Math.round(ratio * 100)}% · ${formatDuration(elapsed)} elapsed`;
      }
    );
    currentInName = null; // pack() cleaned up MEMFS
    openResult(file, data);
  } catch (e) {
    showError(
      `Conversion failed: ${message(e)}. ` +
        `If this was a memory error, try a smaller width or a shorter clip.` +
        localFallback(file.name)
    );
    await recycleEngine();
    await resetToDrop();
  }
}

function openResult(file: File, data: Uint8Array): void {
  const base = file.name.replace(/\.[^.]+$/, '').replace(/-4444$/, '');
  const outName = `${base}-packed.mp4`;

  downloadUrl = URL.createObjectURL(new Blob([data.slice().buffer], { type: 'video/mp4' }));
  const dl = el<HTMLAnchorElement>('download-btn');
  dl.href = downloadUrl;
  dl.download = outName;

  const p = probed!;
  const displayW = outWidth;
  const displayH = evenWidth((p.height / p.width) * outWidth);
  el('result-meta').textContent = `${outName} · ${formatBytes(data.length)} · ${displayW}×${displayH} display size`;
  el('snippet').textContent = buildSnippet(outName, displayW, displayH);

  hide('progress-section', 'st-note');
  show('result-section');

  preview?.stop();
  try {
    preview = startPreview(el<HTMLCanvasElement>('preview-canvas'), data);
  } catch (e) {
    showError(message(e));
  }
}

// ---- wiring -----------------------------------------------------------------

function wire(): void {
  const dropZone = el('drop-zone');
  const fileInput = el<HTMLInputElement>('file-input');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) void onFile(fileInput.files[0]);
    fileInput.value = '';
  });
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragging');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragging');
    const file = e.dataTransfer?.files?.[0];
    if (file) void onFile(file);
  });

  el<HTMLInputElement>('width-input').addEventListener('change', (e) => {
    outWidth = evenWidth(Number((e.target as HTMLInputElement).value) || outWidth);
    (e.target as HTMLInputElement).value = String(outWidth);
    renderSettings();
  });
  el<HTMLInputElement>('fps-input').addEventListener('change', (e) => {
    fps = Math.min(60, Math.max(1, Number((e.target as HTMLInputElement).value) || fps));
    (e.target as HTMLInputElement).value = String(fps);
    renderSettings();
  });
  el<HTMLInputElement>('crf-input').addEventListener('input', (e) => {
    crf = Number((e.target as HTMLInputElement).value);
    el('crf-value').textContent = String(crf);
    renderSettings();
  });

  el('convert-btn').addEventListener('click', () => void convert());
  el('cancel-btn').addEventListener('click', () => void resetToDrop());
  el('again-btn').addEventListener('click', () => void resetToDrop());

  el('copy-snippet').addEventListener('click', () => {
    void navigator.clipboard.writeText(el('snippet').textContent ?? '');
    el('copy-snippet').textContent = 'Copied ✔';
    setTimeout(() => (el('copy-snippet').textContent = 'Copy snippet'), 1500);
  });

  el('bg-swatches').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    for (const b of el('bg-swatches').querySelectorAll('button')) b.classList.remove('active');
    btn.classList.add('active');
    const wrap = el('preview-wrap');
    const bg = btn.dataset.bg!;
    if (bg === 'checker') {
      wrap.classList.add('checkerboard');
      wrap.style.background = '';
    } else {
      wrap.classList.remove('checkerboard');
      wrap.style.background = bg;
    }
  });

  if (matchMedia('(pointer: coarse)').matches) {
    el('engine-status').textContent += ' · works best on desktop';
  }

  // Warm up the engine in the background so the first drop converts immediately.
  void getEngine().catch(() => {});
}

wire();
