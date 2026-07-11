import {
  Canvas,
  Fill,
  ImageShader,
  Shader,
  Skia,
  useVideo,
} from '@shopify/react-native-skia';
import React, { useEffect, useState } from 'react';
import { runOnJS, useAnimatedReaction } from 'react-native-reanimated';

import type { ImplProps } from './types';

// Recombines an alpha-packed frame: color sampled from the top half,
// alpha from the same x in the bottom half. The packed video is encoded
// with PREMULTIPLIED color (see the pack-alpha-video premultiply step), so
// the rgb passes through as-is — multiplying again here would darken edges.
const compiledEffect = Skia.RuntimeEffect.Make(`
uniform shader video;
uniform float halfH;

half4 main(float2 xy) {
  half3 rgb = video.eval(xy).rgb;
  half  a   = video.eval(float2(xy.x, xy.y + halfH)).r;
  return half4(rgb, a);
}
`);

if (!compiledEffect) {
  throw new Error('TransparentVideo: failed to compile alpha-unpack shader');
}
const unpackAlphaEffect = compiledEffect;

/**
 * iOS/web implementation: Skia canvas + RuntimeEffect unpack shader.
 * (Android uses the native ExoPlayer + OpenGL view instead — see
 * TransparentVideoView.android.tsx.)
 */
export function TransparentVideoView({
  uri,
  width,
  height,
  loop,
  paused,
  style,
}: ImplProps) {
  const { currentFrame } = useVideo(uri, { looping: loop, paused });

  // Until the first frame arrives, the Fill would be painted with Skia's
  // default paint — opaque black — flashing a black rectangle on mount.
  // Gate it on first-frame readiness instead; an empty Canvas is transparent.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(false), [uri]);
  useAnimatedReaction(
    () => currentFrame.value !== null,
    (hasFrame, prev) => {
      if (hasFrame && !prev) runOnJS(setReady)(true);
    },
    [currentFrame]
  );

  return (
    <Canvas style={[{ width, height }, style]}>
      {ready ? (
        <Fill>
          <Shader source={unpackAlphaEffect} uniforms={{ halfH: height }}>
            <ImageShader
              image={currentFrame}
              fit="fill"
              rect={{ x: 0, y: 0, width, height: height * 2 }}
            />
          </Shader>
        </Fill>
      ) : null}
    </Canvas>
  );
}
