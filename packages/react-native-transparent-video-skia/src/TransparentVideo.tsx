import {
  Canvas,
  Fill,
  ImageShader,
  Shader,
  Skia,
  useVideo,
} from '@shopify/react-native-skia';
import React, { useEffect, useState } from 'react';
import { Image } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

export interface TransparentVideoProps {
  /**
   * An alpha-packed video (color on the top half, grayscale matte on the
   * bottom half): either a bundled asset module (`require('./x-packed.mp4')`)
   * or a URI string (file:// or https://).
   */
  source: number | string;
  /** Display width. The packed video's own height is 2x its visible height. */
  width: number;
  /** Display height (half the packed video's pixel height). */
  height: number;
  /** Loop playback (default true). Set false for one-shot animations. */
  loop?: boolean;
  paused?: SharedValue<boolean> | boolean;
  style?: StyleProp<ViewStyle>;
}

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

// Minimal surface of expo-asset used below — typed locally so the package
// compiles without expo-asset installed (it is an optional peer).
interface ExpoAssetModule {
  Asset: {
    fromModule(module: number): {
      downloadAsync(): Promise<{ localUri: string | null; uri: string }>;
    };
  };
}

/**
 * Resolves an asset module to a playable URI. Prefers expo-asset when it is
 * installed (downloads the asset to the local filesystem, which the video
 * decoder needs in release builds); falls back to React Native's
 * Image.resolveAssetSource for bare RN apps without expo-asset.
 */
function useResolvedUri(source: number | string): string | null {
  const [uri, setUri] = useState<string | null>(
    typeof source === 'string' ? source : null
  );

  useEffect(() => {
    if (typeof source === 'string') {
      setUri(source);
      return;
    }
    let cancelled = false;

    let expoAsset: ExpoAssetModule | null = null;
    try {
      expoAsset = require('expo-asset') as ExpoAssetModule;
    } catch {
      expoAsset = null;
    }

    if (expoAsset) {
      expoAsset.Asset.fromModule(source)
        .downloadAsync()
        .then((asset) => {
          if (!cancelled) setUri(asset.localUri ?? asset.uri);
        })
        .catch((e: unknown) => {
          console.error('TransparentVideo: failed to resolve asset', e);
        });
    } else {
      const resolved = Image.resolveAssetSource(source);
      if (resolved?.uri) setUri(resolved.uri);
      else console.error('TransparentVideo: could not resolve asset module');
    }

    return () => {
      cancelled = true;
    };
  }, [source]);

  return uri;
}

export function TransparentVideo({
  source,
  width,
  height,
  loop = true,
  paused = false,
  style,
}: TransparentVideoProps) {
  const uri = useResolvedUri(source);

  const { currentFrame } = useVideo(uri, { looping: loop, paused });

  return (
    <Canvas style={[{ width, height }, style]}>
      <Fill>
        <Shader source={unpackAlphaEffect} uniforms={{ halfH: height }}>
          <ImageShader
            image={currentFrame}
            fit="fill"
            rect={{ x: 0, y: 0, width, height: height * 2 }}
          />
        </Shader>
      </Fill>
    </Canvas>
  );
}
