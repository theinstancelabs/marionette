import ExpoModulesCore
import ARKit
import AVFoundation

private final class ArkitSessionDelegate: NSObject, ARSessionDelegate {
  weak var owner: ArkitModule?

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    owner?.handle(frame: frame)
  }

  func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
    owner?.trackingChanged(camera.trackingState)
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    owner?.failed(error)
  }

  func sessionWasInterrupted(_ session: ARSession) {
    owner?.interrupted()
  }

  func sessionInterruptionEnded(_ session: ARSession) {
    owner?.interruptionEnded()
  }

  // Relocalization can resume in a different world origin. The module restarts
  // tracking after an interruption and reports a world reset instead.
  func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool {
    false
  }
}

public class ArkitModule: Module {
  private let session = ARSession()
  private var sessionDelegate: ArkitSessionDelegate?
  private var running = false
  // Every event carries the generation passed to start() so JS can drop
  // frames still queued from a previous run.
  private var generation = 0

  public func definition() -> ModuleDefinition {
    Name("MarionetteArKit")
    Events("onPose", "onTracking", "onError", "onWorldReset")
    Function("isSupported") { ARWorldTrackingConfiguration.isSupported }
    AsyncFunction("start") { (generation: Int, promise: Promise) in
      DispatchQueue.main.async {
        guard ARWorldTrackingConfiguration.isSupported else { promise.reject("ARKitUnavailable", "ARWorldTrackingConfiguration is not supported on this iPhone"); return }
        let camera = AVCaptureDevice.authorizationStatus(for: .video)
        guard camera != .denied && camera != .restricted else { promise.reject("CameraDenied", "Camera access is off for Marionette. Turn it on in Settings › Privacy & Security › Camera."); return }
        let delegate = self.sessionDelegate ?? ArkitSessionDelegate()
        delegate.owner = self
        self.sessionDelegate = delegate
        self.session.delegate = delegate
        self.session.delegateQueue = DispatchQueue.main
        self.generation = generation
        self.running = true
        self.runSession()
        promise.resolve(nil)
      }
    }
    AsyncFunction("stop") { (promise: Promise) in
      DispatchQueue.main.async {
        self.running = false
        self.session.pause()
        promise.resolve(nil)
      }
    }
    OnDestroy {
      DispatchQueue.main.async {
        self.running = false
        self.session.pause()
      }
    }
  }

  private func runSession() {
    let configuration = ARWorldTrackingConfiguration()
    configuration.worldAlignment = .gravity
    configuration.isAutoFocusEnabled = true
    session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
  }

  fileprivate func handle(frame: ARFrame) {
    guard running else { return }
    let t = frame.camera.transform
    var matrix = [Double](); matrix.reserveCapacity(16)
    for column in 0..<4 { for row in 0..<4 { matrix.append(Double(t[column][row])) } }
    let (state, _) = Self.describe(frame.camera.trackingState)
    sendEvent("onPose", ["generation": generation, "transform": matrix, "trackingState": state, "timestamp": frame.timestamp])
  }

  fileprivate func trackingChanged(_ trackingState: ARCamera.TrackingState) {
    guard running else { return }
    let (state, reason) = Self.describe(trackingState)
    sendEvent("onTracking", ["generation": generation, "state": state, "reason": reason])
  }

  fileprivate func failed(_ error: Error) {
    guard running else { return }
    running = false
    let code = (error as? ARError)?.code == .cameraUnauthorized ? "CameraDenied" : "SessionFailed"
    sendEvent("onError", ["generation": generation, "code": code, "message": error.localizedDescription])
  }

  fileprivate func interrupted() {
    guard running else { return }
    sendEvent("onTracking", ["generation": generation, "state": "unavailable", "reason": "interrupted"])
  }

  fileprivate func interruptionEnded() {
    guard running else { return }
    runSession()
    sendEvent("onWorldReset", ["generation": generation])
  }

  private static func describe(_ trackingState: ARCamera.TrackingState) -> (String, String) {
    switch trackingState {
    case .normal: return ("normal", "")
    case .notAvailable: return ("unavailable", "")
    case .limited(let reason):
      switch reason {
      case .initializing: return ("initializing", "initializing")
      case .relocalizing: return ("relocalizing", "relocalizing")
      case .excessiveMotion: return ("limited", "excessiveMotion")
      case .insufficientFeatures: return ("limited", "insufficientFeatures")
      @unknown default: return ("limited", "unknown")
      }
    }
  }
}
