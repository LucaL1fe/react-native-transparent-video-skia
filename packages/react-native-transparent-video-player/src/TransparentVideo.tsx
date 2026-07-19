import React, { useRef } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import { TransparentVideoView } from './TransparentVideoView';
import { useResolvedUri } from './useResolvedUri';
import type { TransparentVideoError } from './types';

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
   * Fires when a non-looping video finishes playing. Native player event on
   * iOS and Android; never fires on web (Skia path) — time-based fallbacks
   * remain the caller's responsibility there.
   */
  onEnd?: () => void;
  /**
   * Fires when the view first has visible content: once per mount on iOS,
   * once per source prepare on Android.
   */
  onFirstFrame?: () => void;
  /**
   * Change this value (e.g. increment a counter) to restart the current
   * source from frame 0 — the way to replay a finished one-shot clip without
   * remounting. Changing `source` restarts playback by itself; while the
   * source is switching, the view keeps showing the previous video's last
   * frame until the new video's first frame is decoded, so runtime switches
   * are seamless.
   */
  playKey?: number;
  /**
   * Playback/decoder failure. Android only for now (ExoPlayer errors; the
   * native view auto-retries with backoff up to 3 times — `willRetry` is
   * false on the final, given-up attempt). Never fires on iOS or web.
   */
  onError?: (error: TransparentVideoError) => void;
}

/**
 * Plays an alpha-packed MP4 with real transparency.
 *
 * Platform split: iOS uses a native AVPlayer + Metal view, Android a native
 * ExoPlayer + OpenGL view (Metro resolves ./TransparentVideoView to the
 * .native implementation on both); web renders through Skia (RuntimeEffect
 * unpack shader, the base .tsx file).
 */
export function TransparentVideo({
  source,
  width,
  height,
  loop = true,
  paused = false,
  style,
  onEnd,
  onFirstFrame,
  playKey,
  onError,
}: TransparentVideoProps) {
  const { uri, forSource } = useResolvedUri(source);

  // playKey gating: `uri` resolves asynchronously, so right after a source
  // change there are renders where playKey has already changed while uri is
  // still the PREVIOUS clip's. Forwarding the new playKey then would restart
  // the outgoing video (every impl treats "playKey changed, uri unchanged"
  // as a replay request). Latch during render — not in an effect, which
  // would deliver the new playKey one commit AFTER the uri and re-trigger
  // the seek — so a uri change and its playKey always land in one commit.
  const gatedPlayKeyRef = useRef(playKey);
  if (forSource === source) {
    gatedPlayKeyRef.current = playKey;
  }

  return (
    <TransparentVideoView
      uri={uri}
      width={width}
      height={height}
      loop={loop}
      paused={paused}
      style={style}
      onEnd={onEnd}
      onFirstFrame={onFirstFrame}
      playKey={gatedPlayKeyRef.current}
      onError={onError}
    />
  );
}
