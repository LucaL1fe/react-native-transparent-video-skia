package expo.modules.transparentvideo

import android.content.Context
import android.view.Surface
import androidx.media3.common.AudioAttributes
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import com.alphamovie.lib.GLTextureView

class TransparentVideoView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onVideoEnd by EventDispatcher()

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
      })
      player = built
    }
    surface?.let { p.setVideoSurface(it) }
    p.repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
    if (p.currentMediaItem?.localConfiguration?.uri?.toString() != uri) {
      p.setMediaItem(MediaItem.fromUri(uri))
      p.prepare()
    }
    p.playWhenReady = !paused
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
