import { useEffect, useState } from 'react';
import { Image } from 'react-native';

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
export function useResolvedUri(source: number | string): string | null {
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
