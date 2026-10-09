import QuartzCore
import UIKit

/// Hosts the Metal-layer view and the script runtime. The view fills the screen; the engine
/// letterboxes its logical viewport inside it and is told the safe-area insets.
final class KilnViewController: UIViewController {
    private(set) var runtime: KilnRuntime?
    private var kilnView: KilnView!

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        kilnView = KilnView(frame: view.bounds)
        kilnView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(kilnView)
        let runtime = KilnRuntime(view: kilnView)
        kilnView.runtime = runtime
        self.runtime = runtime
        runtime.boot()
        runtime.start()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        runtime?.viewChanged(size: kilnView.bounds.size, scale: kilnView.contentScaleFactor, insets: view.safeAreaInsets)
    }
}

/// A view backed by a CAMetalLayer the kernel renders into. It forwards touches to the
/// runtime as pointer events in points, and acts as the text receiver for the keyboard.
final class KilnView: UIView, UIKeyInput {
    weak var runtime: KilnRuntime?

    override class var layerClass: AnyClass { CAMetalLayer.self }
    var metalLayer: CAMetalLayer { layer as! CAMetalLayer }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = true
        contentScaleFactor = UIScreen.main.nativeScale
        metalLayer.contentsScale = UIScreen.main.nativeScale
        metalLayer.isOpaque = true
    }

    /// The layer's size in pixels.
    var drawableSize: CGSize {
        CGSize(width: bounds.width * contentScaleFactor, height: bounds.height * contentScaleFactor)
    }

    required init(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func forward(_ touches: Set<UITouch>, _ kind: String) {
        for t in touches {
            let p = t.location(in: self)
            runtime?.pointer(kind: kind, id: t.hash, x: p.x, y: p.y)
        }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) { forward(touches, "down") }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) { forward(touches, "move") }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { forward(touches, "up") }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { forward(touches, "cancel") }

    // Hardware keyboards (iPad, simulator) drive the same action map as the web build.
    override var canBecomeFirstResponder: Bool { true }

    // UIKeyInput: the on-screen keyboard inserts text and deletes; Return becomes Enter.
    var hasText: Bool { true }
    var keyboardType: UIKeyboardType = .default
    var autocorrectionType: UITextAutocorrectionType = .no
    var returnKeyType: UIReturnKeyType = .done

    func insertText(_ text: String) {
        if text == "\n" {
            runtime?.key(code: "Enter", down: true)
            runtime?.key(code: "Enter", down: false)
        } else {
            runtime?.text(text)
        }
    }

    func deleteBackward() {
        runtime?.key(code: "Backspace", down: true)
        runtime?.key(code: "Backspace", down: false)
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        for p in presses {
            if let code = KilnRuntime.keyCode(for: p.key) { runtime?.key(code: code, down: true) }
            // Printable characters from a hardware keyboard also arrive as text while typing.
            if let key = p.key, isFirstResponder == false, key.characters.count == 1, let s = key.characters.unicodeScalars.first, s.value >= 32, !key.modifierFlags.contains(.command), !key.modifierFlags.contains(.control) {
                runtime?.text(key.characters)
            }
        }
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        for p in presses { if let code = KilnRuntime.keyCode(for: p.key) { runtime?.key(code: code, down: false) } }
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        pressesEnded(presses, with: event)
    }
}
