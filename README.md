# react-native-transparent-video-skia

> ⭐ **If this project helps you, a star would make my day** — it keeps the project going and helps others find it!

**Transparent (alpha-channel) video for React Native — as a plain H.264 MP4 that plays on every iOS and Android hardware decoder.**

No codec-alpha support needed, no giant animated WebP/GIF files, no per-frame CPU decoding. A ~70-line Skia component plays an "alpha-packed" MP4 and recombines color + alpha on the GPU.

**🎬 Convert your video in the browser (nothing is uploaded):**
👉 **https://lucal1fe.github.io/react-native-transparent-video-skia/**

## Quick start

**1. Pack your video** — drag your alpha video (e.g. a DaVinci Resolve ProRes 4444 export) into the [browser converter](https://lucal1fe.github.io/react-native-transparent-video-skia/), or locally with ffmpeg installed:

```bash
npx pack-alpha-video hero-4444.mov --width 900 --fps 24
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

> **Exporting from DaVinci Resolve:** Deliver → QuickTime, Codec **Apple ProRes 4444**, ✅ **Export Alpha**, resolution = display size (e.g. 900×900), 24–30 fps.

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

**Honest trade-offs:** you add `@shopify/react-native-skia` + `react-native-reanimated` as dependencies, your asset needs a one-time packing step (that's what the converter is for), and it's not a drop-in `<Image>` replacement.

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
| `paused` | `boolean \| SharedValue<boolean>` | Pause playback; accepts a Reanimated shared value for UI-thread control. |
| `style` | `StyleProp<ViewStyle>` | Extra styles for the canvas. |

### `pack-alpha-video` CLI

```
npx pack-alpha-video <input-with-alpha.mov> [more ...] [options]
  -o, --out-dir <dir>   output directory        (default: cwd)
      --fps <n>         output frame rate       (default: 24 — smooth for animations, smaller than 30)
      --crf <n>         H.264 quality           (default: 18 = visually lossless, lower = better)
      --width <px>      downscale width, keeps aspect
```

Runs on **Windows, macOS and Linux** — needs Node.js and ffmpeg in your PATH (macOS: `brew install ffmpeg`, Windows: `winget install ffmpeg`, Linux: `apt install ffmpeg`). Or skip the install entirely and use the [browser converter](https://lucal1fe.github.io/react-native-transparent-video-skia/) — it runs the same ffmpeg pipeline via WebAssembly, entirely client-side. The CLI is the recommended fallback for very large files that exceed the browser's wasm memory limit.

## Repo layout

- [`packages/react-native-transparent-video-skia`](packages/react-native-transparent-video-skia) — the npm package (component + CLI)
- [`web/`](web) — the browser converter (Vite + ffmpeg.wasm), deployed to GitHub Pages

## License

Code in this repository is [MIT](LICENSE). The hosted converter ships a WebAssembly FFmpeg build with x264 enabled (GPL) — see the third-party notices in [LICENSE](LICENSE).
