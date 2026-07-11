# react-native-transparent-video-skia

> ⭐ **If this project helps you, a star would make my day** — it keeps the project going and helps others find it!

**Transparent (alpha-channel) video for React Native — as a plain H.264 MP4 that plays on every iOS and Android hardware decoder.**

No codec-alpha support needed, no giant animated WebP/GIF files, no per-frame CPU decoding. A ~70-line Skia component plays an "alpha-packed" MP4 and recombines color + alpha on the GPU.

## Quick start

**1. Pack your video** — any video with an alpha channel (e.g. ProRes 4444), any resolution (ffmpeg required, see below):

```bash
npx pack-alpha-video hero-4444.mov
# → hero-packed.mp4
```

**2. Install:**

```bash
npx expo install react-native-transparent-video-skia @shopify/react-native-skia react-native-reanimated
```

**3. Play it:**

```tsx
import { TransparentVideo } from 'react-native-transparent-video-skia';

<TransparentVideo
  source={require('./assets/hero-packed.mp4')}
  width={300}
  height={300}
/>
```

That's it — the video renders with real transparency over whatever is behind it.

> **Export tip:** deliver **ProRes 4444 with the alpha channel enabled** from your editor or motion tool, at display resolution (e.g. 900×900), 24–30 fps. Every professional tool can do this.

## The `pack-alpha-video` CLI

```bash
npx pack-alpha-video <input-with-alpha> [more inputs ...] [options]
```

| Option | Default | What it does |
|---|---|---|
| `--fps <n>` | `24` | Output frame rate. 24 looks perfectly smooth for animations; 30+ only adds file size. |
| `--scale <percent>` | `100` | Resize to a percentage of the source size (e.g. `--scale 50` halves width and height). |
| `--quality <0-100>` | `75` | Output quality in percent. 75 ≈ visually lossless; lower = smaller file. |
| `-o, --out-dir <dir>` | cwd | Where to write `<name>-packed.mp4`. |
| `--width <px>` | — | Alternative to `--scale`: resize to an exact pixel width (keeps aspect ratio). |
| `--size <WxH>` | — | Force an exact output frame (e.g. `--size 900x900`) from **any** aspect ratio: content is scaled to fit and the remainder is padded with **transparent** pixels — never stretched. |
| `--crf <n>` | — | Advanced: raw x264 CRF value, overrides `--quality`. |

**Supported inputs** — any video with a real alpha channel, at any resolution (odd dimensions are handled automatically):

- **ProRes 4444** `.mov` with alpha channel (recommended — every editor/motion tool exports this)
- **VP9 / VP8** `.webm` with alpha
- `.mov`/`.mkv`/`.avi` with an alpha-capable codec: **PNG, QuickTime Animation (QTRLE), FFV1, Ut Video**
- Files *without* alpha (plain H.264/HEVC exports) are rejected with a clear message — note that HEVC-with-alpha is not supported; use ProRes 4444 or VP9 WebM instead.

**Requirements:** Node.js and ffmpeg in your PATH — works on **Windows, macOS and Linux**
(macOS: `brew install ffmpeg` · Windows: `winget install ffmpeg` · Linux: `sudo apt install ffmpeg`).

## Why this beats GIF and animated WebP

Real measurement — the same 900×900 transparent character animation, exported three ways:

| Format | Size |
|---|---|
| Animated WebP | **11 MB** |
| AVIF | **5.2 MB** |
| **Alpha-packed MP4 (this)** | **1.1 MB** ✅ |

Category by category:

| | Alpha-packed MP4 + Skia | GIF | Animated WebP | APNG | Lottie | HEVC/VP9 codec-alpha |
|---|---|---|---|---|---|---|
| **File size** | ✅ Inter-frame H.264 compression (10× smaller than WebP above) | ❌ Huge | ❌ Mostly per-frame, large | ❌ Largest | ✅ Tiny — but vector-only | ✅ Small |
| **Color + alpha** | ✅ 24-bit color, 8-bit alpha | ❌ 256 colors, 1-bit alpha | ✅ | ✅ | ✅ | ✅ |
| **Decode cost / battery** | ✅ Hardware video decoder + GPU shader | ❌ CPU | ❌ CPU, expensive at large sizes | ❌ CPU | ⚠ CPU (JS/native render) | ✅ Hardware (when supported) |
| **Memory** | ✅ Streams frames | ❌ Frame caches | ❌ Frame caches | ❌ Frame caches | ✅ | ✅ |
| **Device compatibility** | ✅ Plain H.264 — every iOS/Android hardware decoder ever shipped | ✅ | ✅ | ✅ | ✅ | ❌ Codec/vendor-dependent (HEVC-alpha ≈ Apple-only, VP9-alpha ≈ no iOS hardware) |
| **Rendered from real footage / 3D / hand animation** | ✅ Any video source | ✅ | ✅ | ✅ | ❌ Vector animations only | ✅ |
| **Playback control** | ✅ `paused` accepts a Reanimated `SharedValue` | ❌ | ❌ | ❌ | ✅ | ✅ |

**Honest trade-offs:** you add `@shopify/react-native-skia` + `react-native-reanimated` as dependencies, your asset needs a one-time packing step, and it's not a drop-in `<Image>` replacement.

## How it works

The packed MP4 is a completely normal H.264 video, **twice as tall** as your animation:

```
┌──────────────┐
│  color (RGB) │  ← premultiplied color, top half
├──────────────┤
│  alpha matte │  ← alpha channel as grayscale, bottom half
└──────────────┘
```

At render time a Skia runtime shader samples the color from the top half and the alpha from the bottom half of the same frame and recombines them on the GPU:

```glsl
half4 main(float2 xy) {
  half3 rgb = video.eval(xy).rgb;
  half  a   = video.eval(float2(xy.x, xy.y + halfH)).r;
  return half4(rgb, a);
}
```

Because the transport is plain `yuv420p` H.264, the OS hardware decoder does all the heavy lifting — transparency support is never the codec's problem. The color is premultiplied by alpha during packing so bilinear sampling never produces dark edge fringes.

## API

### `<TransparentVideo />`

| Prop | Type | Description |
|---|---|---|
| `source` | `number \| string` | `require(...)` of a packed MP4, or a URI string. Asset modules resolve via `expo-asset` when installed, otherwise via `Image.resolveAssetSource` (bare RN). |
| `width` | `number` | Display width. |
| `height` | `number` | Display height (= half the packed video's pixel height). |
| `loop` | `boolean` | Loop playback (default `true`). Set `false` for one-shot animations. |
| `paused` | `boolean \| SharedValue<boolean>` | Pause playback; accepts a Reanimated shared value for UI-thread control. |
| `style` | `StyleProp<ViewStyle>` | Extra styles for the canvas. |

## License

[MIT](LICENSE)
