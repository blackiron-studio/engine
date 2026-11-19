import AuthenticationServices
import JavaScriptCore
import UIKit

/// Sign in with Apple for the engine's `identity.link("apple")` and `signInWith("apple")`.
/// The sheet yields an identity token the game's backend must verify; the answer goes back
/// as JSON through `__blackiron.signIn(id, json)`. Offered only when the export set
/// `ios.signInWithApple`, which adds the entitlement.
final class BlackironSignIn: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private weak var context: JSContext?
    private var pending: Int?
    private var controller: ASAuthorizationController?

    init(context: JSContext) {
        self.context = context
    }

    static var enabled: Bool { Bundle.main.object(forInfoDictionaryKey: "BlackironSignInWithApple") as? Bool == true }

    static func providersJSON() -> String { enabled ? "[\"apple\"]" : "[]" }

    func request(_ id: Int, _ provider: String) {
        DispatchQueue.main.async {
            guard provider == "apple", BlackironSignIn.enabled else { return self.deliver(id, ["error": "unavailable"]) }
            // One sheet at a time: a second request while one is up fails rather than stacking.
            guard self.pending == nil else { return self.deliver(id, ["error": "failed"]) }
            self.pending = id
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.fullName]
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            controller.performRequests()
        }
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first.map { ASPresentationAnchor(windowScene: $0) } ?? ASPresentationAnchor()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let id = finish() else { return }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let data = credential.identityToken, let token = String(data: data, encoding: .utf8) else {
            return deliver(id, ["error": "failed"])
        }
        var answer: [String: Any] = ["token": token]
        // Apple gives the name only on the first authorization for this app.
        if let name = credential.fullName.map({ PersonNameComponentsFormatter().string(from: $0) }), !name.isEmpty { answer["name"] = name }
        deliver(id, answer)
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let id = finish() else { return }
        let cancelled = (error as? ASAuthorizationError)?.code == .canceled
        deliver(id, ["error": cancelled ? "cancelled" : "failed"])
    }

    private func finish() -> Int? {
        let id = pending
        pending = nil
        controller = nil
        return id
    }

    private func deliver(_ id: Int, _ answer: [String: Any]) {
        guard let bridge = context?.objectForKeyedSubscript("__blackiron"), !bridge.isUndefined else { return }
        let json = (try? JSONSerialization.data(withJSONObject: answer)).map { String(decoding: $0, as: UTF8.self) } ?? "{\"error\":\"failed\"}"
        bridge.invokeMethod("signIn", withArguments: [id, json])
    }
}
