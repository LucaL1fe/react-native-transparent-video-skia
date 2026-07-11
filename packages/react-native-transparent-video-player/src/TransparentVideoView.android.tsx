import { requireNativeViewManager } from 'expo-modules-core';
import React, { useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { runOnJS, useAnimatedReaction } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

import type { ImplProps } from './types';

interface NativeProps {
  sourceUri: string | null;
  loop: boolean;
  paused: boolean;
  onVideoEnd?: () => void;
  style?: StyleProp<ViewStyle>;
}

const NativeView = requireNativeViewManager<NativeProps>('TransparentVideo');

// The native view takes a plain boolean; bridge a Reanimated SharedValue
// (supported for API parity with the iOS Skia path) into React state.
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
 * Android implementation: native ExoPlayer + OpenGL (samplerExternalOES)
 * view. Skia's useVideo is NOT used on Android — its HardwareBuffer importer
 * cannot sample the YUV/vendor formats hardware decoders emit.
 */
export function TransparentVideoView({
  uri,
  width,
  height,
  loop,
  paused,
  style,
  onEnd,
}: ImplProps) {
  const pausedBool = useResolvedPaused(paused);

  return (
    <NativeView
      sourceUri={uri}
      loop={loop}
      paused={pausedBool}
      onVideoEnd={onEnd}
      style={[{ width, height }, style]}
    />
  );
}
