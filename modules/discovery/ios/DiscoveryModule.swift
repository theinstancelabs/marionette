import ExpoModulesCore
import Network

/// One advertised gateway: its Bonjour endpoint and TXT record, and the IPv4 address and port it resolved to.
private struct Service {
  let name: String
  let endpoint: NWEndpoint
  var txt: [String: String]
  var host: String?
  var port: Int?
  var resolver: NWConnection?
}

/// Finds Marionette gateways on the local network. A gateway advertises `_marionette._tcp` with the TXT record
/// `{ id, name, v, auth }`. A Bonjour endpoint is a service name, not an address, and the app's WebSocket needs an
/// address, so each service is resolved with a short-lived TCP connection to it: once it is ready, its path's
/// remote endpoint is the gateway's IPv4 address and port, and the connection is closed again.
///
/// JS calls `start()` and `stop()`, and gets `onChange` with `{ status, gateways }` whenever the list changes:
/// `status` is `browsing`, `denied` (Local Network access is off) or `unavailable`, and `gateways` is
/// `[{ id, name, host, port, auth }]`, sorted by name, one per gateway id. Everything runs on the main queue.
public class DiscoveryModule: Module {
  private static let serviceType = "_marionette._tcp"
  // The DNS-SD error iOS reports while Local Network access is off for the app (kDNSServiceErr_PolicyDenied).
  private static let policyDenied: Int32 = -65570
  private var browser: NWBrowser?
  private var services: [String: Service] = [:]
  private var status = "browsing"

  public func definition() -> ModuleDefinition {
    Name("MarionetteDiscovery")
    Events("onChange")
    Function("start") { DispatchQueue.main.async { self.start() } }
    Function("stop") { DispatchQueue.main.async { self.stop() } }
    OnDestroy { DispatchQueue.main.async { self.stop() } }
  }

  private func start() {
    guard browser == nil else { emit(); return }
    let parameters = NWParameters()
    // Gateways are on the Wi-Fi network, not reachable over AWDL peer-to-peer links.
    parameters.includePeerToPeer = false
    let browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil), using: parameters)
    browser.stateUpdateHandler = { [weak self, weak browser] state in
      guard let self, let browser, self.browser === browser else { return }
      switch state {
      case .ready: self.status = "browsing"
      case .waiting(let error): self.status = Self.isDenied(error) ? "denied" : "unavailable"
      case .failed(let error):
        self.status = Self.isDenied(error) ? "denied" : "unavailable"
        // A failed browser never recovers; the next start() makes a new one.
        browser.cancel(); self.browser = nil
      default: return
      }
      self.emit()
    }
    browser.browseResultsChangedHandler = { [weak self, weak browser] results, _ in
      guard let self, let browser, self.browser === browser else { return }
      self.update(results)
    }
    self.browser = browser
    status = "browsing"
    browser.start(queue: .main)
  }

  private func stop() {
    browser?.cancel(); browser = nil
    for service in services.values { service.resolver?.cancel() }
    services = [:]
  }

  private static func isDenied(_ error: NWError) -> Bool {
    if case .dns(let code) = error { return code == policyDenied }
    return false
  }

  private func update(_ results: Set<NWBrowser.Result>) {
    var present = Set<String>()
    for result in results {
      guard case let .service(name, type, domain, _) = result.endpoint else { continue }
      let key = "\(name).\(type).\(domain)"
      present.insert(key)
      var txt: [String: String] = [:]
      if case let .bonjour(record) = result.metadata { txt = record.dictionary }
      if services[key] != nil { services[key]?.txt = txt; continue }
      services[key] = Service(name: name, endpoint: result.endpoint, txt: txt)
      resolve(key)
    }
    for key in services.keys where !present.contains(key) {
      services[key]?.resolver?.cancel()
      services.removeValue(forKey: key)
    }
    emit()
  }

  private func resolve(_ key: String) {
    guard browser != nil, let service = services[key], service.resolver == nil else { return }
    let tcp = NWProtocolTCP.Options()
    tcp.connectionTimeout = 5
    let parameters = NWParameters(tls: nil, tcp: tcp)
    // The WebSocket is given an IPv4 address: IPv6 link-local addresses need a scope the URL can't carry.
    if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
    parameters.includePeerToPeer = false
    let connection = NWConnection(to: service.endpoint, using: parameters)
    services[key]?.resolver = connection
    connection.stateUpdateHandler = { [weak self, weak connection] state in
      guard let self, let connection, self.services[key]?.resolver === connection else { return }
      switch state {
      case .ready:
        if case let .hostPort(host, port)? = connection.currentPath?.remoteEndpoint, case let .ipv4(address) = host {
          self.services[key]?.host = address.rawValue.map { String($0) }.joined(separator: ".")
          self.services[key]?.port = Int(port.rawValue)
        }
        self.finishResolving(key, retry: self.services[key]?.host == nil)
      case .waiting, .failed: self.finishResolving(key, retry: true)
      default: break
      }
    }
    connection.start(queue: .main)
    // Resolution can also stall before TCP starts (no address yet); give up and try again.
    DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self, weak connection] in
      guard let self, let connection, self.services[key]?.resolver === connection else { return }
      self.finishResolving(key, retry: true)
    }
  }

  private func finishResolving(_ key: String, retry: Bool) {
    services[key]?.resolver?.cancel()
    services[key]?.resolver = nil
    emit()
    guard retry else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
      guard let self, self.services[key]?.host == nil else { return }
      self.resolve(key)
    }
  }

  private func emit() {
    var byId: [String: [String: Any]] = [:]
    for service in services.values {
      guard let host = service.host, let port = service.port else { continue }
      let id = service.txt["id"].flatMap { $0.isEmpty ? nil : $0 } ?? service.name
      let name = service.txt["name"].flatMap { $0.isEmpty ? nil : $0 } ?? service.name
      byId[id] = ["id": id, "name": name, "host": host, "port": port, "auth": service.txt["auth"] == "1"]
    }
    let gateways = byId.values.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    sendEvent("onChange", ["status": status, "gateways": gateways])
  }
}
