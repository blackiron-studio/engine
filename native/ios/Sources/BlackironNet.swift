import Foundation
import JavaScriptCore

/// Sockets and HTTP requests for the engine's `platform.net`, on URLSession. The engine's
/// `HostNet` starts them with `netOpen` / `netRequest`; everything that happens comes back
/// through `__blackiron.net(id, kind, data, code)` on the main thread, where the JavaScript
/// context lives.
final class BlackironNet: NSObject, URLSessionWebSocketDelegate {
    private weak var context: JSContext?
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
    private var sockets: [Int: URLSessionWebSocketTask] = [:]
    private var ids: [Int: Int] = [:]

    init(context: JSContext) {
        self.context = context
    }

    private func deliver(_ id: Int, _ kind: String, _ data: String, _ code: Int) {
        guard let bridge = context?.objectForKeyedSubscript("__blackiron"), !bridge.isUndefined else { return }
        bridge.invokeMethod("net", withArguments: [id, kind, data, code])
    }

    // MARK: Sockets

    func open(_ id: Int, _ url: String) {
        guard let target = URL(string: url), let scheme = target.scheme, scheme == "ws" || scheme == "wss" else {
            DispatchQueue.main.async { self.deliver(id, "error", "bad URL", 1006) }
            return
        }
        let task = session.webSocketTask(with: target)
        sockets[id] = task
        ids[task.taskIdentifier] = id
        task.resume()
        receive(id, task)
    }

    private func receive(_ id: Int, _ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.sockets[id] === task else { return }
                switch result {
                case .success(.string(let text)):
                    self.deliver(id, "text", text, 0)
                    self.receive(id, task)
                case .success(.data(let data)):
                    self.deliver(id, "binary", data.base64EncodedString(), 0)
                    self.receive(id, task)
                case .success:
                    self.receive(id, task)
                case .failure(let error):
                    // A close frame arrives through the delegate first; anything else is a drop.
                    self.forget(id)
                    self.deliver(id, "error", error.localizedDescription, 1006)
                }
            }
        }
    }

    private func forget(_ id: Int) {
        if let task = sockets.removeValue(forKey: id) { ids.removeValue(forKey: task.taskIdentifier) }
    }

    func send(_ id: Int, _ data: String, _ binary: Bool) {
        guard let task = sockets[id] else { return }
        let message: URLSessionWebSocketTask.Message = binary ? .data(Data(base64Encoded: data) ?? Data()) : .string(data)
        task.send(message) { [weak self] error in
            guard let error else { return }
            DispatchQueue.main.async {
                guard let self, self.sockets[id] === task else { return }
                self.forget(id)
                self.deliver(id, "error", error.localizedDescription, 1006)
            }
        }
    }

    /// The script has already let go of the socket: no event follows a close it asked for.
    func close(_ id: Int, _ code: Int, _ reason: String) {
        guard let task = sockets[id] else { return }
        forget(id)
        task.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: reason.data(using: .utf8))
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard let id = ids[webSocketTask.taskIdentifier] else { return }
        deliver(id, "open", "", 0)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard let id = ids[webSocketTask.taskIdentifier] else { return }
        forget(id)
        deliver(id, "close", reason.flatMap { String(data: $0, encoding: .utf8) } ?? "", closeCode.rawValue)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        // A socket that never connected, or dropped without a close frame.
        guard let id = ids[task.taskIdentifier] else { return }
        forget(id)
        deliver(id, "error", error?.localizedDescription ?? "connection lost", 1006)
    }

    // MARK: HTTP

    func request(_ id: Int, _ json: String) {
        guard let spec = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any],
              let text = spec["url"] as? String, let url = URL(string: text) else {
            DispatchQueue.main.async { self.deliver(id, "error", "bad request", 0) }
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = spec["method"] as? String ?? "GET"
        req.timeoutInterval = ((spec["timeoutMs"] as? Double) ?? 15000) / 1000
        req.cachePolicy = .reloadIgnoringLocalCacheData
        for (name, value) in spec["headers"] as? [String: String] ?? [:] { req.setValue(value, forHTTPHeaderField: name) }
        if let body = spec["body"] as? String { req.httpBody = Data(body.utf8) }
        // Its own session: the socket delegate above must not see request tasks.
        URLSession.shared.dataTask(with: req) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                guard let http = response as? HTTPURLResponse else {
                    let timedOut = (error as? URLError)?.code == .timedOut
                    self.deliver(id, "error", timedOut ? "timeout" : (error?.localizedDescription ?? "no response"), 0)
                    return
                }
                var headers: [String: String] = [:]
                for (name, value) in http.allHeaderFields { headers[String(describing: name).lowercased()] = String(describing: value) }
                let body = String(decoding: data ?? Data(), as: UTF8.self)
                let answer = (try? JSONSerialization.data(withJSONObject: ["headers": headers, "body": body])).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
                self.deliver(id, "response", answer, http.statusCode)
            }
        }.resume()
    }
}
