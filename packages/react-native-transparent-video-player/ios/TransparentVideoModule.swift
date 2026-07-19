import ExpoModulesCore

public class TransparentVideoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TransparentVideo")

    View(TransparentVideoView.self) {
      // onError currently fires only on Android (decoder failures, with
      // bounded auto-retry); registered on iOS so the prop is valid there.
      Events("onVideoEnd", "onFirstFrame", "onError")

      // Prop setters only STAGE values; side effects run in commitProps()
      // (OnViewDidUpdateProps) so replayNonce is always evaluated after
      // sourceUri regardless of the order props are applied within a batch.
      Prop("sourceUri") { (view: TransparentVideoView, uri: String?) in
        view.pendingSourceUri = uri
      }

      Prop("loop") { (view: TransparentVideoView, loop: Bool) in
        view.loop = loop
      }

      Prop("paused") { (view: TransparentVideoView, paused: Bool) in
        view.paused = paused
      }

      Prop("replayNonce") { (view: TransparentVideoView, nonce: Int?) in
        view.pendingReplayNonce = nonce
      }

      OnViewDidUpdateProps { (view: TransparentVideoView) in
        view.commitProps()
      }
    }
  }
}
