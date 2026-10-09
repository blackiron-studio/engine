import GameController

/// Game controllers through the GameController framework, delivered to the engine as the
/// key codes the web build reads from the Gamepad API: `GamepadA`, `GamepadDpadLeft`,
/// `GamepadLeftStickUp` and so on, so one action map covers both.
final class BlackironGamepad {
    private weak var runtime: BlackironRuntime?
    private var down: Set<String> = []
    private let deadzone: Float = 0.5

    init(runtime: BlackironRuntime) {
        self.runtime = runtime
        NotificationCenter.default.addObserver(forName: .GCControllerDidConnect, object: nil, queue: .main) { [weak self] note in
            if let controller = note.object as? GCController { self?.attach(controller) }
        }
        NotificationCenter.default.addObserver(forName: .GCControllerDidDisconnect, object: nil, queue: .main) { [weak self] _ in
            self?.releaseAll()
        }
        for controller in GCController.controllers() { attach(controller) }
        GCController.startWirelessControllerDiscovery(completionHandler: nil)
    }

    private func attach(_ controller: GCController) {
        guard let pad = controller.extendedGamepad else { return }
        pad.valueChangedHandler = { [weak self] pad, _ in self?.poll(pad) }
        blackironLog("[blackiron] controller: \(controller.vendorName ?? "unknown")")
    }

    private func poll(_ pad: GCExtendedGamepad) {
        var now: Set<String> = []
        let buttons: [(GCControllerButtonInput?, String)] = [
            (pad.buttonA, "A"), (pad.buttonB, "B"), (pad.buttonX, "X"), (pad.buttonY, "Y"),
            (pad.leftShoulder, "L1"), (pad.rightShoulder, "R1"), (pad.leftTrigger, "L2"), (pad.rightTrigger, "R2"),
            (pad.buttonOptions, "Select"), (pad.buttonMenu, "Start"), (pad.leftThumbstickButton, "L3"), (pad.rightThumbstickButton, "R3"),
            (pad.dpad.up, "DpadUp"), (pad.dpad.down, "DpadDown"), (pad.dpad.left, "DpadLeft"), (pad.dpad.right, "DpadRight"),
            (pad.buttonHome, "Home"),
        ]
        for (button, name) in buttons {
            guard let button else { continue }
            if button.isPressed || button.value > 0.5 { now.insert("Gamepad\(name)") }
        }
        stick(pad.leftThumbstick, "Left", into: &now)
        stick(pad.rightThumbstick, "Right", into: &now)
        for code in now where !down.contains(code) { runtime?.key(code: code, down: true) }
        for code in down where !now.contains(code) { runtime?.key(code: code, down: false) }
        down = now
    }

    /// GameController reports y up as positive; the web's Gamepad API and the engine use y down.
    private func stick(_ s: GCControllerDirectionPad, _ side: String, into set: inout Set<String>) {
        let x = s.xAxis.value
        let y = s.yAxis.value
        if x < -deadzone { set.insert("Gamepad\(side)StickLeft") }
        if x > deadzone { set.insert("Gamepad\(side)StickRight") }
        if y > deadzone { set.insert("Gamepad\(side)StickUp") }
        if y < -deadzone { set.insert("Gamepad\(side)StickDown") }
    }

    private func releaseAll() {
        for code in down { runtime?.key(code: code, down: false) }
        down.removeAll()
    }
}
