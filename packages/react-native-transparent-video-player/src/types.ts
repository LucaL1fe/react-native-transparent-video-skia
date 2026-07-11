import type { StyleProp, ViewStyle } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

/**
 * Props of the internal per-platform view implementation. Both
 * TransparentVideoView.tsx (iOS/web, Skia) and
 * TransparentVideoView.android.tsx (native ExoPlayer + OpenGL) must satisfy
 * this exact signature so TypeScript checks them interchangeably.
 */
export interface ImplProps {
  /** Already-resolved playable URI (file:// or http(s)), or null while resolving. */
  uri: string | null;
  width: number;
  height: number;
  loop: boolean;
  paused: SharedValue<boolean> | boolean;
  style?: StyleProp<ViewStyle>;
  /** Fires when a non-looping video finishes. Currently Android-only. */
  onEnd?: () => void;
}
