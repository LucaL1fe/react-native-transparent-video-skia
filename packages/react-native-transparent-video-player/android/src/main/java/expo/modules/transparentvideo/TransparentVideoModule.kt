package expo.modules.transparentvideo

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TransparentVideoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TransparentVideo")

    View(TransparentVideoView::class) {
      Events("onVideoEnd", "onFirstFrame", "onError")

      Prop("sourceUri") { view: TransparentVideoView, uri: String? ->
        view.setSource(uri)
      }

      Prop("loop") { view: TransparentVideoView, loop: Boolean ->
        view.loop = loop
      }

      Prop("paused") { view: TransparentVideoView, paused: Boolean ->
        view.paused = paused
      }

      // Only STAGES the nonce; the replay side effect runs in commitProps()
      // (OnViewDidUpdateProps) so it is always evaluated after sourceUri
      // regardless of the order props are applied within a batch — a replay
      // must never seek an outgoing clip.
      Prop("replayNonce") { view: TransparentVideoView, nonce: Int? ->
        view.pendingReplayNonce = nonce
      }

      OnViewDidUpdateProps { view: TransparentVideoView ->
        view.commitProps()
      }

      OnViewDestroys { view: TransparentVideoView ->
        view.release()
      }
    }
  }
}
