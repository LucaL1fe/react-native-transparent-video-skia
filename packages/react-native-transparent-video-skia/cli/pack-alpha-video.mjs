#!/usr/bin/env node
/**
 * pack-alpha-video — convert any video with an alpha channel (DaVinci ProRes
 * 4444 exports, VP9/VP8 WebM, PNG/QTRLE/FFV1/Ut Video in .mov/.mkv/.avi)
 * into an "alpha-packed" MP4 for <TransparentVideo>.
 *
 * The trick: the output MP4 is a completely normal H.264 video, twice as tall
 * as the source. Top half = the color image (premultiplied), bottom half = the
 * alpha channel repainted as a grayscale matte. At render time a Skia shader
 * recombines the halves into a transparent image on the GPU. No codec alpha
 * support needed → plays on every iOS/Android hardware decoder.
 *
 * Works on Windows, macOS and Linux; needs ffmpeg + ffprobe in PATH.
 *
 * Usage:
 *   npx pack-alpha-video <input.mov> [more.webm ...] [options]
 *
 * Options:
 *   -o, --out-dir <dir>    output directory                       (default: cwd)
 *       --fps <n>          frame rate of the packed output        (default: 24)
 *       --quality <0-100>  quality in percent, 75 ≈ visually lossless (default: 75)
 *       --scale <percent>  resize to this % of the source size    (default: 100)
 *       --width <px>       or: resize to exact width, keeps aspect
 *       --size <WxH>       or: exact output frame from any aspect ratio —
 *                          scales to fit and pads with TRANSPARENT pixels
 *       --crf <n>          advanced: raw x264 CRF, overrides --quality
 *
 * Output: <out-dir>/<name>-packed.mp4 (a trailing "-4444" is stripped from
 * the name). Prints the <TransparentVideo> line to paste into your app.
 *
 * DaVinci export settings for the input file:
 *   Deliver → QuickTime, Codec "Apple ProRes 4444", ✅ Export Alpha,
 *   resolution = display size (e.g. 900×900), 24–30 fps.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

function run(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8' }).trim();
}

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

// ---- args -------------------------------------------------------------------
let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      'out-dir': { type: 'string', short: 'o', default: process.cwd() },
      fps: { type: 'string', default: '24' },
      quality: { type: 'string', default: '75' },
      scale: { type: 'string', default: '' },
      width: { type: 'string', default: '' },
      size: { type: 'string', default: '' },
      crf: { type: 'string', default: '' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (e) {
  fail(e.message);
}
const { values, positionals: inputs } = parsed;

if (values.help || inputs.length === 0) {
  console.log(
    `Usage: pack-alpha-video <input-with-alpha> [...] [options]
  -o, --out-dir <dir>    output directory                    (default: cwd)
      --fps <n>          output frame rate                   (default: 24)
      --quality <0-100>  quality %, 75 ≈ visually lossless   (default: 75)
      --scale <percent>  resize to % of source size          (default: 100)
      --width <px>       or: exact output width, keeps aspect
      --size <WxH>       or: exact frame (e.g. 900x900) — fits + transparent padding
      --crf <n>          advanced: raw x264 CRF, overrides --quality`
  );
  process.exit(values.help ? 0 : 1);
}

const OUT_DIR = path.resolve(values['out-dir']);
const FPS = values.fps;

// Quality percentage → x264 CRF. 100% → 14 (near lossless), 75% → 18
// (visually lossless, the recommended default), 0% → 30 (small but rough).
const quality = Math.min(100, Math.max(0, Number(values.quality)));
if (Number.isNaN(quality)) fail(`--quality must be a number 0-100, got: ${values.quality}`);
const CRF = values.crf !== '' ? values.crf : String(Math.round(30 - quality * 0.16));

const scalePct = values.scale !== '' ? Number(values.scale) : 100;
if (Number.isNaN(scalePct) || scalePct <= 0 || scalePct > 400) {
  fail(`--scale must be a percentage between 1 and 400, got: ${values.scale}`);
}

let sizeW = 0;
let sizeH = 0;
if (values.size !== '') {
  const m = values.size.match(/^(\d+)x(\d+)$/i);
  if (!m) fail(`--size must look like 900x900, got: ${values.size}`);
  sizeW = 2 * Math.round(Number(m[1]) / 2);
  sizeH = 2 * Math.round(Number(m[2]) / 2);
}

// ---- preflight ------------------------------------------------------------
try {
  run('ffmpeg', ['-version']);
} catch {
  fail(
    'ffmpeg not found — install it first:\n' +
      '  macOS:   brew install ffmpeg\n' +
      '  Windows: winget install ffmpeg\n' +
      '  Linux:   sudo apt install ffmpeg'
  );
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- convert each input ---------------------------------------------------
for (const input of inputs) {
  if (!fs.existsSync(input)) fail(`input not found: ${input}`);

  // Verify the source actually carries alpha. Most codecs signal it in
  // pix_fmt; VP8/VP9 WebM signals it via the alpha_mode container tag (their
  // pix_fmt reads yuv420p even when alpha is present).
  const probe = JSON.parse(
    run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt:stream_tags=alpha_mode',
      '-of', 'json', input,
    ])
  );
  const stream = probe.streams?.[0] ?? {};
  const pixFmt = stream.pix_fmt ?? '';
  const codec = stream.codec_name ?? '';
  const vpxAlpha = ['vp8', 'vp9'].includes(codec) && stream.tags?.alpha_mode === '1';
  if (!pixFmt.includes('a') && !vpxAlpha) {
    fail(
      `${path.basename(input)} has no alpha channel (codec: ${codec}, pix_fmt: ${pixFmt}).\n` +
      '  From DaVinci: Deliver → QuickTime + ProRes 4444 + ✅ Export Alpha.\n' +
      '  (Plain H.264/HEVC exports have no alpha; HEVC-with-alpha is not supported — use ProRes 4444 or VP9 WebM.)'
    );
  }

  // Strip a "4444" token anywhere in the name: raccoon-4444-idle → raccoon-idle
  const name = path
    .basename(input, path.extname(input))
    .replace(/(^|-)4444(?=-|$)/g, '$1')
    .replace(/--+/g, '-')
    .replace(/^-|-$/g, '');
  const outFile = path.join(OUT_DIR, `${name}-packed.mp4`);

  // Resize stage (runs in rgba so padding can be transparent):
  //  --size:  scale to fit the exact frame, pad the rest with TRANSPARENT
  //           pixels (alpha 0) — never stretches, works for any aspect ratio
  //  --width: exact width, height follows aspect
  //  --scale: percentage of source
  //  default: no-op even-ing pass (yuv420p + vstack need even dimensions)
  const resize = sizeW
    ? `scale=${sizeW}:${sizeH}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${sizeW}:${sizeH}:(ow-iw)/2:(oh-ih)/2:color=black@0,`
    : values.width
      ? `scale=${values.width}:-2,`
      : scalePct !== 100
        ? `scale=trunc(iw*${scalePct / 100}/2)*2:-2,`
        : 'scale=trunc(iw/2)*2:-2,';

  // fps → resize → premultiply color by alpha (kills edge fringe when the
  // shader samples with bilinear filtering) → split → alphaextract paints the
  // alpha as grayscale → vstack glues color above matte into one tall frame.
  const filter =
    `[0:v]fps=${FPS},format=rgba,${resize}premultiply=inplace=1,format=rgba,` +
    `split[c][a];[a]alphaextract[m];[c][m]vstack`;

  console.log(
    `→ packing ${path.basename(input)} (${codec}/${pixFmt || 'alpha_mode=1'}, ${FPS} fps, quality ${quality}% = crf ${CRF})...`
  );
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    // The native vp8/vp9 decoders ignore alpha; the libvpx ones decode it.
    ...(vpxAlpha ? ['-c:v', codec === 'vp8' ? 'libvpx' : 'libvpx-vp9'] : []),
    '-i', input,
    '-filter_complex', filter,
    '-c:v', 'libx264', '-crf', CRF, '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-an',
    outFile,
  ], { stdio: 'inherit' });

  const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);
  console.log(`✔ ${outFile}  (${mb} MB)`);
  console.log(
    `  use it:  <TransparentVideo source={require('./${path.basename(outFile)}')} width={...} height={...} />\n`
  );
}
