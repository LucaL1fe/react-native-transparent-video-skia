# Third-party notices

The Android implementation of this package contains code derived from the
following open-source projects:

## alpha-movie

- https://github.com/pavelsiamak/alpha-movie
- Copyright 2017 Pavel Semak (portions Copyright 2014 Google Inc.)
- License: Apache License, Version 2.0 — http://www.apache.org/licenses/LICENSE-2.0

`android/src/main/java/com/alphamovie/lib/GLTextureView.java` is vendored from
alpha-movie (itself derived from AOSP's GLSurfaceView), and
`TransparentVideoRenderer.kt` is derived from alpha-movie's `VideoRenderer`.
Original license headers are preserved in the files.

## react-native-transparent-video

- https://github.com/status-im/react-native-transparent-video
- Copyright (c) 2023 Brian Sztamfater
- License: MIT

The packed top-color/bottom-alpha external-OES fragment shader approach in
`TransparentVideoRenderer.kt` follows their packed-shader variant.
