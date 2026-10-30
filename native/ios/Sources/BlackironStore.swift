import Foundation
import JavaScriptCore
import StoreKit

/// In-app purchases through StoreKit 2. The engine's `HostPurchases` sends requests with
/// `purchaseRequest(id, op, arg)`; answers go back as JSON through `__blackiron.purchase`
/// on the main thread, where the JavaScript context lives. Request id 0 carries entitlement
/// changes that arrive on their own (Ask to Buy approvals, refunds, other devices).
final class BlackironStore {
    private weak var context: JSContext?
    private var updates: Task<Void, Never>?
    /// Non-consumables currently owned, as last read from `Transaction.currentEntitlements`.
    private(set) var owned: [String] = []
    private let ownedKey = "blackiron.store.owned"

    init(context: JSContext) {
        self.context = context
        owned = UserDefaults.standard.stringArray(forKey: ownedKey) ?? []
        updates = Task.detached { [weak self] in
            for await result in Transaction.updates {
                if case .verified(let t) = result { await t.finish() }
                await self?.refreshEntitlements(notify: true)
            }
        }
        Task { await refreshEntitlements(notify: true) }
    }

    deinit { updates?.cancel() }

    func ownedJSON() -> String { BlackironStore.json(owned) }

    func request(_ id: Int, _ op: String, _ arg: String) {
        Task { @MainActor in
            let answer: [String: Any]
            switch op {
            case "products": answer = await products(arg)
            case "buy": answer = await buy(arg)
            case "restore": answer = await restore()
            default: answer = ["error": "unavailable"]
            }
            deliver(id, answer)
        }
    }

    @MainActor private func products(_ arg: String) async -> [String: Any] {
        let ids = (try? JSONSerialization.jsonObject(with: Data(arg.utf8))) as? [String] ?? []
        do {
            let list = try await Product.products(for: ids)
            return ["products": list.map { ["id": $0.id, "title": $0.displayName, "price": $0.displayPrice] }]
        } catch {
            return ["products": [], "error": "unavailable"]
        }
    }

    @MainActor private func buy(_ id: String) async -> [String: Any] {
        do {
            guard let product = try await Product.products(for: [id]).first else { return ["result": "unavailable"] }
            switch try await product.purchase() {
            case .success(let verification):
                guard case .verified(let t) = verification else { return ["result": "failed"] }
                await t.finish()
                await refreshEntitlements(notify: false)
                return ["result": "purchased", "owned": owned]
            case .pending: return ["result": "pending"]
            case .userCancelled: return ["result": "cancelled"]
            @unknown default: return ["result": "failed"]
            }
        } catch {
            blackironLog("[blackiron:store] purchase failed: \(error)")
            return ["result": "failed"]
        }
    }

    @MainActor private func restore() async -> [String: Any] {
        do {
            try await AppStore.sync()
        } catch {
            // A cancelled sign-in still leaves the entitlements StoreKit already has.
            blackironLog("[blackiron:store] sync failed: \(error)")
        }
        await refreshEntitlements(notify: false)
        return ["owned": owned]
    }

    private func refreshEntitlements(notify: Bool) async {
        var ids: [String] = []
        for await result in Transaction.currentEntitlements {
            if case .verified(let t) = result, t.revocationDate == nil { ids.append(t.productID) }
        }
        let list = ids.sorted()
        await MainActor.run {
            let changed = list != owned
            owned = list
            UserDefaults.standard.set(list, forKey: ownedKey)
            if notify && changed { deliver(0, ["owned": list]) }
        }
    }

    @MainActor private func deliver(_ id: Int, _ answer: [String: Any]) {
        guard let bridge = context?.objectForKeyedSubscript("__blackiron"), !bridge.isUndefined else { return }
        bridge.invokeMethod("purchase", withArguments: [id, BlackironStore.json(answer)])
    }

    private static func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}
