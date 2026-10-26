import ExpoModulesCore
import ARKit

public class ArkitModule: Module, ARSessionDelegate {
  private let session = ARSession()
  private var running = false

  public func definition() -> ModuleDefinition {
    Name("MarionetteArKit")
    Events("onPose", "onTracking")
    Function("isSupported") { ARWorldTrackingConfiguration.isSupported }
    AsyncFunction("start") { (promise: Promise) in
      guard ARWorldTrackingConfiguration.isSupported else { promise.reject("ARKitUnavailable", "ARWorldTrackingConfiguration is not supported on this iPhone"); return }
      let configuration = ARWorldTrackingConfiguration()
      configuration.worldAlignment = .gravity
      configuration.isAutoFocusEnabled = true
      self.session.delegate = self
      self.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
      self.running = true
      promise.resolve(nil)
    }
    AsyncFunction("stop") { (promise: Promise) in
      self.session.pause(); self.running = false; promise.resolve(nil)
    }
  }

  public func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard running else { return }
    let t = frame.camera.transform
    var matrix = [Double](); matrix.reserveCapacity(16)
    for column in 0..<4 { for row in 0..<4 { matrix.append(Double(t[column][row])) } }
    let state: String
    switch frame.camera.trackingState { case .normal: state = "normal"; case .limited: state = "limited"; case .notAvailable: state = "unavailable" }
    sendEvent("onPose", ["transform": matrix, "trackingState": state, "timestamp": frame.timestamp])
    sendEvent("onTracking", ["state": state])
  }
}
