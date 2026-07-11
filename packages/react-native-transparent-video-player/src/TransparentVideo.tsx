import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import { TransparentVideoView } from './TransparentVideoView';
import { useResolvedUri } from './useResolvedUri';

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
  /**
   * Fires when a non-looping video finishes playing.
   * Currently Android-only (native player event); on iOS it never fires —
   * time-based fallbacks remain the caller's responsibility there.
   */
  onEnd?: () => void;
}

/**
 * Plays an alpha-packed MP4 with real transparency.
 *
 * Platform split: iOS/web render through Skia (RuntimeEffect unpack shader);
 * Android uses a native ExoPlayer + OpenGL view (Metro resolves
 * ./TransparentVideoView to the .android implementation there).
 */
export function TransparentVideo({
  source,
  width,
  height,
  loop = true,
  paused = false,
  style,
  onEnd,
}: TransparentVideoProps) {
  const uri = useResolvedUri(source);

  return (
    <TransparentVideoView
      uri={uri}
      width={width}
      height={height}
      loop={loop}
      paused={paused}
      style={style}
      onEnd={onEnd}
    />
  );
}
