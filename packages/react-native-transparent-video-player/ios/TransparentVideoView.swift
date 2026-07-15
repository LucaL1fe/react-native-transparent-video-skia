import AVFoundation
import ExpoModulesCore
import QuartzCore
import UIKit

// CADisplayLink retains its target; routing through a weak proxy lets the
// view deinit while the link is still scheduled (deinit then invalidates it).
private final class WeakDisplayLinkProxy: NSObject {
  weak var target: TransparentVideoView?

  @objc func tick(_ link: CADisplayLink) {
    target?.handleDisplayLinkTick(link)
  }
}

/**
 * iOS implementation: AVPlayer → AVPlayerItemVideoOutput → Metal unpack
 * shader → non-opaque CAMetalLayer (TransparentVideoRenderer).
 *
 * The never-blank invariant that makes source switches seamless: the layer is
 * only ever drawn when a NEW pixel buffer exists — never cleared without
 * drawing. `replaceCurrentItem` detaches the old item immediately, but the
 * last presented drawable simply stays on screen until the new item's first
 * frame is decoded and rendered. Seeks and end-of-stream hold the frame the
 * same way. (This mirrors the Android view, where the old SurfaceTexture
 * content persists until the new clip's first onFrameAvailable.)
 *
 * Prop side effects are staged and applied in commitProps() (called from
 * OnViewDidUpdateProps) so replayNonce is always evaluated AFTER sourceUri
 * within the same prop batch — a replay must never seek an outgoing clip.
 */
final class TransparentVideoView: ExpoView {
  let onVideoEnd = EventDispatcher()
  let onFirstFrame = EventDispatcher()

  // -- Props (staged by the module definition, applied in commitProps) --
  var pendingSourceUri: String?
  var pendingReplayNonce: Int?

  var loop: Bool = true {
    didSet {
      player?.actionAtItemEnd = loop ? .none : .pause
    }
  }

  var paused: Bool = false {
    didSet {
      guard oldValue != paused else { return }
      if paused {
        player?.pause()
      } else if !endedNonLooping {
        player?.play()
      }
      updateDisplayLinkState()
    }
  }

  // -- Playback state --
  private var player: AVPlayer?
  private var videoOutput: AVPlayerItemVideoOutput?
  private var loadedSourceUri: String?
  private var committedReplayNonce: Int?
  private var hasCommittedNonce = false
  /// True from setSource until the new item's first frame has been rendered.
  private var awaitingFirstFrame = false
  private var awaitingSince: CFTimeInterval = 0
  private var didNudgeStuckOutput = false
  /// A non-looping clip played to its end; hold the last frame, stop polling.
  private var endedNonLooping = false
  private var endObserver: NSObjectProtocol?

  // -- Rendering --
  private let renderer = TransparentVideoRenderer()
  private let metalLayer = CAMetalLayer()
  private var displayLink: CADisplayLink?
  private var isInBackground = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    metalLayer.pixelFormat = .bgra8Unorm
    metalLayer.isOpaque = false
    metalLayer.framebufferOnly = true
    metalLayer.device = TransparentVideoRenderer.device
    layer.addSublayer(metalLayer)

    // Selector-based observers are auto-unregistered on dealloc.
    NotificationCenter.default.addObserver(
      self, selector: #selector(handleDidEnterBackground),
      name: UIApplication.didEnterBackgroundNotification, object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(handleDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification, object: nil)
  }

  deinit {
    displayLink?.invalidate()
    if let endObserver {
      NotificationCenter.default.removeObserver(endObserver)
    }
    player?.pause()
    player?.replaceCurrentItem(with: nil)
    renderer.release()
  }

  // MARK: - Prop application

  /// Called from OnViewDidUpdateProps after every prop batch.
  func commitProps() {
    let sourceChanged = pendingSourceUri != loadedSourceUri
    if sourceChanged {
      setSource(pendingSourceUri)
    }

    let nonce = pendingReplayNonce
    // The first committed nonce is the mount value, not a replay request.
    let nonceChanged = hasCommittedNonce && nonce != committedReplayNonce
    committedReplayNonce = nonce
    hasCommittedNonce = true
    // A nonce arriving together with a source change is NOT a replay — the
    // new source starts from 0 by itself (same rule as the JS layer).
    if nonceChanged && !sourceChanged {
      replay()
    }
  }

  private func setSource(_ uri: String?) {
    loadedSourceUri = uri
    endedNonLooping = false

    guard let uri, let url = URL(string: uri) else {
      // Source cleared: stop playback but keep the last frame on screen
      // (matches Android, where the old surface content persists).
      videoOutput = nil
      awaitingFirstFrame = false
      player?.pause()
      player?.replaceCurrentItem(with: nil)
      updateDisplayLinkState()
      return
    }

    let item = AVPlayerItem(url: url)
    let output = AVPlayerItemVideoOutput(pixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferMetalCompatibilityKey as String: true,
    ])
    // Attach BEFORE the item becomes current — adding an output to an
    // already-playing item is the classic "hasNewPixelBuffer never true" trap.
    item.add(output)
    observeEnd(of: item)

    let player = ensurePlayer()
    player.actionAtItemEnd = loop ? .none : .pause
    videoOutput = output
    awaitingFirstFrame = true
    awaitingSince = CACurrentMediaTime()
    didNudgeStuckOutput = false
    player.replaceCurrentItem(with: item)
    if !paused {
      player.play()
    }
    updateDisplayLinkState()
  }

  /// Restart the CURRENT clip from frame 0 (replayNonce changed). The seek
  /// flushes the video output — no buffer vends for a tick or two — but the
  /// held last frame covers the gap.
  private func replay() {
    guard let player, player.currentItem != nil else { return }
    endedNonLooping = false
    player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
    if !paused {
      player.play()
    }
    updateDisplayLinkState()
  }

  private func ensurePlayer() -> AVPlayer {
    if let player { return player }
    let player = AVPlayer()
    // Silent mascot clips: never touch the shared AVAudioSession, never take
    // audio focus, never duck the user's music.
    player.isMuted = true
    // Local files (expo-asset downloads) — don't let AVFoundation buffer-wait.
    player.automaticallyWaitsToMinimizeStalling = false
    // A looping mascot must not keep the screen awake.
    player.preventsDisplaySleepDuringVideoPlayback = false
    self.player = player
    return player
  }

  private func observeEnd(of item: AVPlayerItem) {
    if let endObserver {
      NotificationCenter.default.removeObserver(endObserver)
    }
    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
    ) { [weak self] _ in
      self?.handlePlayedToEnd()
    }
  }

  private func handlePlayedToEnd() {
    if loop {
      // actionAtItemEnd == .none keeps the rate up; jump back to the start.
      // Zero tolerance: a coarse seek would visibly skip the loop seam.
      player?.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
    } else {
      endedNonLooping = true
      onVideoEnd([:])
      updateDisplayLinkState()
    }
  }

  // MARK: - Frame pump

  fileprivate func handleDisplayLinkTick(_ link: CADisplayLink) {
    guard let output = videoOutput else { return }
    let itemTime = output.itemTime(forHostTime: link.targetTimestamp)
    if output.hasNewPixelBuffer(forItemTime: itemTime) {
      if let pixelBuffer = output.copyPixelBuffer(forItemTime: itemTime, itemTimeForDisplay: nil) {
        renderer.render(pixelBuffer: pixelBuffer, into: metalLayer)
        if awaitingFirstFrame {
          awaitingFirstFrame = false
          onFirstFrame([:])
          updateDisplayLinkState()
        }
      }
    } else if awaitingFirstFrame,
              !didNudgeStuckOutput,
              CACurrentMediaTime() - awaitingSince > 1.5,
              player?.currentItem?.status == .readyToPlay {
      // Rare recovery: an output can stall after replaceCurrentItem / a flush
      // and never report a new buffer; a zero-tolerance seek re-primes it.
      didNudgeStuckOutput = true
      player?.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
    }
  }

  private func updateDisplayLinkState() {
    // Poll while we expect frames: a pending first frame (even when paused —
    // the output vends the poster frame at rate 0), or active playback.
    let shouldRun = videoOutput != nil && window != nil && !isInBackground
      && (awaitingFirstFrame || (!paused && !endedNonLooping))
    if shouldRun && displayLink == nil {
      let proxy = WeakDisplayLinkProxy()
      proxy.target = self
      let link = CADisplayLink(target: proxy, selector: #selector(WeakDisplayLinkProxy.tick(_:)))
      // Clips are 24 fps — don't poll at 120 Hz on ProMotion displays.
      link.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 60, preferred: 30)
      link.add(to: .main, forMode: .common)
      displayLink = link
    }
    displayLink?.isPaused = !shouldRun
  }

  // MARK: - Layout & lifecycle

  override func layoutSubviews() {
    super.layoutSubviews()
    let scale = window?.screen.scale ?? UIScreen.main.scale
    let newDrawableSize = CGSize(width: bounds.width * scale, height: bounds.height * scale)
    guard newDrawableSize.width > 0, newDrawableSize.height > 0 else { return }
    let sizeChanged = metalLayer.drawableSize != newDrawableSize
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    metalLayer.frame = bounds
    metalLayer.contentsScale = scale
    if sizeChanged {
      metalLayer.drawableSize = newDrawableSize
    }
    CATransaction.commit()
    if sizeChanged {
      // Resizing discards the layer's drawables — repaint the held frame.
      renderer.redrawLastFrame(into: metalLayer)
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      // Reattach (tab switch, list recycle, screen uncovered): drawables may
      // be gone.
      renderer.redrawLastFrame(into: metalLayer)
      // Mirror handleDidBecomeActive: AVFoundation can drop the rate of a
      // video-only item while we're off-window (e.g. react-native-screens
      // detaches us under a covering card); redrawing alone would leave the
      // clip frozen on its last frame.
      if !paused && !endedNonLooping {
        player?.play()
      }
    }
    updateDisplayLinkState()
  }

  @objc private func handleDidEnterBackground() {
    // Never render in background — Metal work there gets the process killed.
    isInBackground = true
    updateDisplayLinkState()
  }

  @objc private func handleDidBecomeActive() {
    isInBackground = false
    renderer.redrawLastFrame(into: metalLayer)
    // AVFoundation drops the rate of video-only items in background; resume.
    if !paused && !endedNonLooping {
      player?.play()
    }
    updateDisplayLinkState()
  }
}
