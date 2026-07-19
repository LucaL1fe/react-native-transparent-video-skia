import { requireNativeViewManager } from 'expo-modules-core';
import React, { useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { runOnJS, useAnimatedReaction } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

import type { ImplProps, TransparentVideoError } from './types';

interface NativeProps {
  sourceUri: string | null;
  loop: boolean;
  paused: boolean;
  replayNonce?: number;
  onVideoEnd?: () => void;
  onFirstFrame?: () => void;
  onError?: (event: { nativeEvent: TransparentVideoError }) => void;
  style?: StyleProp<ViewStyle>;
}

const NativeView = requireNativeViewManager<NativeProps>('TransparentVideo');

// The native view takes a plain boolean; bridge a Reanimated SharedValue
// (supported for API parity with the web Skia path) into React state.
function useResolvedPaused(paused: SharedValue<boolean> | boolean): boolean {
  const isShared = typeof paused === 'object' && paused !== null;
  const [fromShared, setFromShared] = useState(
    isShared ? (paused as SharedValue<boolean>).value : false
  );
  useAnimatedReaction(
    () => (isShared ? (paused as SharedValue<boolean>).value : false),
    (value, previous) => {
      if (isShared && value !== previous) runOnJS(setFromShared)(value);
    },
    [paused, isShared]
  );
  return isShared ? fromShared : (paused as boolean);
}

/**
 * Native implementation (iOS + Android), one JS wrapper for both:
 * - Android: ExoPlayer + OpenGL (samplerExternalOES). Skia's useVideo is NOT
 *   usable there — its HardwareBuffer importer cannot sample the YUV/vendor
 *   formats hardware decoders emit.
 * - iOS: AVPlayer + AVPlayerItemVideoOutput + Metal unpack shader. Replaced
 *   the Skia canvas path, whose JS-side frame-disposal heuristics
 *   intermittently flashed an opaque black frame on source switches.
 * Both native views hold the last presented frame across source swaps until
 * the new clip's first frame is decoded, so runtime switches are seamless.
 */
export function TransparentVideoView({
  uri,
  width,
  height,
  loop,
  paused,
  style,
  onEnd,
  onFirstFrame,
  playKey,
  onError,
}: ImplProps) {
  const pausedBool = useResolvedPaused(paused);

  return (
    <NativeView
      sourceUri={uri}
      loop={loop}
      paused={pausedBool}
      replayNonce={playKey}
      onVideoEnd={onEnd}
      onFirstFrame={onFirstFrame}
      onError={onError ? (e) => onError(e.nativeEvent) : undefined}
      style={[{ width, height }, style]}
    />
  );
}
