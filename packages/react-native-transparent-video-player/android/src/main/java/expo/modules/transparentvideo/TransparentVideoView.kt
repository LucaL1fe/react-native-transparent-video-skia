package expo.modules.transparentvideo

import android.content.Context
import android.util.Log
import android.view.Surface
import androidx.media3.common.AudioAttributes
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import com.alphamovie.lib.GLTextureView

class TransparentVideoView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onVideoEnd by EventDispatcher()
  private val onFirstFrame by EventDispatcher()

  private val renderer = TransparentVideoRenderer()
  private val textureView = GLTextureView(context).apply {
    // Order matters: EGL configuration must precede setRenderer.
    setEGLContextClientVersion(2)
    // RGBA8888 — the EGL surface needs a real alpha channel for transparency.
    setEGLConfigChooser(8, 8, 8, 8, 16, 0)
    isOpaque = false
    setPreserveEGLContextOnPause(true)
  }

  private var player: ExoPlayer? = null
  private var surface: Surface? = null
  private var sourceUri: String? = null

  var loop: Boolean = true
    set(value) {
      field = value
      player?.repeatMode = if (value) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
    }

  var paused: Boolean = false
    set(value) {
      field = value
      player?.playWhenReady = !value
    }

  init {
    renderer.onRequestRender = { textureView.requestRender() }
    // Fires on the GL thread on every EGL (re)creation — including view
    // reattach after RN detached us. Re-bind the fresh Surface each time.
    renderer.onSurfaceReady = { s ->
      post {
        surface?.release()
        surface = s
        attachSurfaceAndMaybePrepare()
      }
    }
    textureView.setRenderer(renderer)
    textureView.renderMode = GLTextureView.RENDERMODE_WHEN_DIRTY
    addView(textureView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun setSource(uri: String?) {
    sourceUri = uri
    attachSurfaceAndMaybePrepare()
  }

  // Staged by the replayNonce prop setter; evaluated in commitProps() after
  // the whole prop batch (including sourceUri) has been applied.
  var pendingReplayNonce: Int? = null
  private var committedReplayNonce: Int? = null
  private var hasCommittedNonce = false

  // Called from OnViewDidUpdateProps after every prop batch.
  fun commitProps() {
    val nonce = pendingReplayNonce
    // The first committed nonce is the mount value, not a replay request.
    val nonceChanged = hasCommittedNonce && nonce != committedReplayNonce
    committedReplayNonce = nonce
    hasCommittedNonce = true
    if (nonceChanged) {
      replay()
    }
  }

  // Restart the CURRENT clip from frame 0 (replayNonce prop changed). Only
  // acts when the loaded media matches sourceUri — if a source change landed
  // in the same prop batch, setSource's prepare() handles playback.
  private fun replay() {
    val p = player ?: return
    val loaded = p.currentMediaItem?.localConfiguration?.uri?.toString() ?: return
    if (loaded == sourceUri) {
      p.seekTo(0)
      p.playWhenReady = !paused
    }
  }

  // Main thread only — ExoPlayer is single-threaded by contract.
  private fun attachSurfaceAndMaybePrepare() {
    val uri = sourceUri ?: return
    val p = player ?: ExoPlayer.Builder(context).build().also { built ->
      // Silent transparent clips must never take audio focus or duck music.
      built.setAudioAttributes(AudioAttributes.DEFAULT, false)
      built.volume = 0f
      built.addListener(object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
          if (playbackState == Player.STATE_ENDED) {
            onVideoEnd(mapOf())
          }
        }

        // Fires after every prepare() — i.e. once per source, including
        // runtime source switches — when the first frame hits the surface.
        override fun onRenderedFirstFrame() {
          onFirstFrame(mapOf())
        }

        // Log only — recovery happens in attachSurfaceAndMaybePrepare(),
        // which re-prepares an IDLE player on the next surface rebind.
        // Auto-prepare() here could loop on a persistent decoder failure.
        override fun onPlayerError(error: PlaybackException) {
          Log.e("TransparentVideo", "ExoPlayer error (state=${player?.playbackState})", error)
        }
      })
      player = built
    }
    surface?.let { p.setVideoSurface(it) }
    p.repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
    if (p.currentMediaItem?.localConfiguration?.uri?.toString() != uri) {
      p.setMediaItem(MediaItem.fromUri(uri))
      p.prepare()
    } else if (p.playbackState == Player.STATE_IDLE) {
      // Player errored (decoder killed by a surface abandoned mid-decode,
      // OEM codec reclaim while covered, ...) but kept its media item —
      // re-prepare on the surface rebind. STATE_ENDED is deliberately left
      // alone so finished non-looping clips keep holding their last frame.
      p.prepare()
    }
    p.playWhenReady = !paused
  }

  // Called when react-native-screens (or any parent) detaches us while a
  // covering screen is shown. Children (GLTextureView) detach before this
  // runs, so the GL thread is already gone — but the decoder SurfaceTexture
  // is only released later, by the NEXT onSurfaceCreated on reattach.
  // Detach the player from it now and stop decoding into a surface nobody
  // consumes; otherwise MediaCodec races the GL-thread release on reattach
  // and dies (0xffffffed on Qualcomm), stranding the player in IDLE.
  // Only player.playWhenReady is touched (not the `paused` prop field):
  // reattach recreates EGL → onSurfaceReady → attachSurfaceAndMaybePrepare()
  // restores playWhenReady = !paused.
  override fun onDetachedFromWindow() {
    player?.clearVideoSurface()
    player?.playWhenReady = false
    super.onDetachedFromWindow()
  }

  // Called from OnViewDestroys (main thread) when RN destroys the view for
  // good. NOT called on mere detach — the player intentionally survives
  // detach/reattach cycles (lists, tab switches); only the EGL surface is
  // recreated, and onSurfaceReady re-binds it.
  fun release() {
    player?.clearVideoSurface()
    player?.release()
    player = null
    surface?.release()
    surface = null
    renderer.release()
  }
}
