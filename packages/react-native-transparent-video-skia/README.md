# react-native-transparent-video-skia

Transparent (alpha-channel) video for React Native — as a plain H.264 MP4 that plays on every iOS and Android hardware decoder.

```bash
npx expo install react-native-transparent-video-skia @shopify/react-native-skia react-native-reanimated
```

```tsx
import { TransparentVideo } from 'react-native-transparent-video-skia';

<TransparentVideo
  source={require('./assets/hero-packed.mp4')}
  width={300}
  height={300}
/>
```

Pack any video with an alpha channel (ProRes 4444, VP9 WebM, …) with the bundled cross-platform CLI (needs ffmpeg in PATH):

```bash
npx pack-alpha-video hero-4444.mov            # sensible defaults: 24 fps, quality 75%
npx pack-alpha-video hero-4444.mov --scale 50 --quality 60
```

Full docs, CLI options, format explanation, and the GIF/WebP comparison:
**https://github.com/LucaL1fe/react-native-transparent-video-skia**
