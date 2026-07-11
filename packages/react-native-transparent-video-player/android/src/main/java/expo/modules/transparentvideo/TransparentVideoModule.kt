package expo.modules.transparentvideo

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TransparentVideoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TransparentVideo")

    View(TransparentVideoView::class) {
      Events("onVideoEnd")

      Prop("sourceUri") { view: TransparentVideoView, uri: String? ->
        view.setSource(uri)
      }

      Prop("loop") { view: TransparentVideoView, loop: Boolean ->
        view.loop = loop
      }

      Prop("paused") { view: TransparentVideoView, paused: Boolean ->
        view.paused = paused
      }

      OnViewDestroys { view: TransparentVideoView ->
        view.release()
      }
    }
  }
}
