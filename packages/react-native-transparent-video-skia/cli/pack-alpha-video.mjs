#!/usr/bin/env node
/**
 * pack-alpha-video — convert a video with an alpha channel (e.g. a DaVinci
 * ProRes 4444 export) into an "alpha-packed" MP4 for <TransparentVideo>.
 *
 * The trick: the output MP4 is a completely normal H.264 video, twice as tall
 * as the source. Top half = the color image (premultiplied), bottom half = the
 * alpha channel repainted as a grayscale matte. At render time a Skia shader
 * recombines the halves into a transparent image on the GPU. No codec alpha
 * support needed → plays on every iOS/Android hardware decoder.
 *
 * Usage:
 *   npx pack-alpha-video <input.mov> [more.mov ...] [options]
 *
 * Options:
 *   -o, --out-dir <dir>  output directory                    (default: cwd)
 *       --fps <n>        frame rate of the packed output     (default: 24)
 *       --crf <n>        H.264 quality, lower = better/bigger (default: 18)
 *       --width <px>     downscale to this width, keeps aspect (default: source width)
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
      crf: { type: 'string', default: '18' },
      width: { type: 'string', default: '' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (e) {
  fail(e.message);
}
const { values, positionals: inputs } = parsed;

if (values.help || inputs.length === 0) {
  console.log(
    'Usage: pack-alpha-video <input-with-alpha.mov> [...] [-o outDir] [--fps 24] [--crf 18] [--width 900]'
  );
  process.exit(values.help ? 0 : 1);
}

const OUT_DIR = path.resolve(values['out-dir']);
const FPS = values.fps;
const CRF = values.crf;
const WIDTH = values.width;

// ---- preflight ------------------------------------------------------------
try {
  run('ffmpeg', ['-version']);
} catch {
  fail('ffmpeg not found — install it first (macOS: brew install ffmpeg)');
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- convert each input ---------------------------------------------------
for (const input of inputs) {
  if (!fs.existsSync(input)) fail(`input not found: ${input}`);

  // Verify the source actually carries an alpha channel — a ProRes 422 or
  // H.264 export silently has none and would produce a solid black matte.
  const pixFmt = run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', input,
  ]);
  if (!pixFmt.includes('a')) {
    fail(
      `${path.basename(input)} has no alpha channel (pix_fmt: ${pixFmt}).\n` +
      '  Re-export from DaVinci: QuickTime + ProRes 4444 + ✅ Export Alpha.'
    );
  }

  const name = path.basename(input, path.extname(input)).replace(/-4444$/, '');
  const outFile = path.join(OUT_DIR, `${name}-packed.mp4`);

  // fps → premultiply color by alpha (kills edge fringe when the shader
  // samples with bilinear filtering) → split → alphaextract paints the alpha
  // as grayscale → vstack glues color above matte into one tall frame.
  const scale = WIDTH ? `scale=${WIDTH}:-2,` : '';
  const filter =
    `[0:v]fps=${FPS},${scale}format=rgba,premultiply=inplace=1,format=rgba,` +
    `split[c][a];[a]alphaextract[m];[c][m]vstack`;

  console.log(`→ packing ${path.basename(input)} (${pixFmt}, ${FPS}fps, crf ${CRF})...`);
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
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
