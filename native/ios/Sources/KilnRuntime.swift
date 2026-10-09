import KilnKernel
import CoreText
import JavaScriptCore
import QuartzCore
import UIKit

/// Host log lines go to the unified log, so they show in Console.app and `log show`.
func kilnLog(_ message: String) {
    NSLog("%@", message)
}

/// What the engine's `NativePlatform` and `NativeRenderer` call. Method names map to the
/// JavaScript names because every parameter is unlabelled.
@objc protocol KilnHostExports: JSExport {
    func now() -> Double
    func log(_ level: String, _ message: String)
    func storageGet(_ key: String) -> JSValue
    func storageSet(_ key: String, _ value: String)
    func storageRemove(_ key: String)
    func loadBytes(_ path: String) -> JSValue
    func loadText(_ path: String) -> JSValue
    func loadImage(_ path: String) -> JSValue
    func decodeImage(_ bytes: JSValue) -> JSValue
    func uploadTexture(_ slot: Int, _ width: Int, _ height: Int, _ rgba: JSValue)
    func submit3D(_ packet: String)
    func physics3D(_ command: String) -> String
    func rendererDiagnostics() -> JSValue
    func submit(_ post: JSValue, _ vertexCount: Int, _ commandCount: Int)
    var kernel: KilnKernelBridge { get }
    var audio: KilnAudio { get }
    func haptic(_ kind: String)
    func announce(_ text: String)
    func createPhysics(_ pixelsPerMeter: Double) -> KilnPhysicsBridge
    func showKeyboard(_ visible: Bool)
    var deterministic: Bool { get set }
    func rasterizeGlyph(_ family: String, _ size: Int, _ weight: Int, _ style: String, _ ch: String) -> JSValue
    var screen: [String: Any] { get set }
}

/// The host object installed as `globalThis.__kilnHost`.
@objc final class KilnHost: NSObject, KilnHostExports {
    private let context: JSContext
    private let renderer: KilnRenderer
    private let start = CACurrentMediaTime()
    /// A synthetic clock in milliseconds (screenshot runs); nil means real time.
    var clock: Double?
    private let defaults = UserDefaults.standard
    var screen: [String: Any] = ["width": 0, "height": 0, "scale": 1, "insets": [0, 0, 0, 0]]
    /// True under the synthetic clock of a screenshot run, so unseeded games stay reproducible.
    var deterministic = false
    /// Frame data captured by the last `submit`, rendered after the script returns.
    var frame: KilnRenderer.Frame?
    /// The compiled kernel the engine's renderer streams into.
    let kernel: KilnKernelBridge
    /// The kernel synthesiser on the device's audio output.
    let audio: KilnAudio
    private lazy var impactLight = UIImpactFeedbackGenerator(style: .light)
    private lazy var impactMedium = UIImpactFeedbackGenerator(style: .medium)
    private lazy var impactHeavy = UIImpactFeedbackGenerator(style: .heavy)
    private lazy var notify = UINotificationFeedbackGenerator()
    private lazy var selection = UISelectionFeedbackGenerator()

    init(context: JSContext, renderer: KilnRenderer) {
        self.context = context
        self.renderer = renderer
        kernel = KilnKernelBridge(context: context)
        audio = KilnAudio(context: context)
        KilnHost.registerBundledFonts()
    }

    /// The view that owns the on-screen keyboard; set by the runtime.
    weak var keyboardView: UIView?

    func createPhysics(_ pixelsPerMeter: Double) -> KilnPhysicsBridge {
        KilnPhysicsBridge(context: context, pixelsPerMeter: pixelsPerMeter)
    }

    func showKeyboard(_ visible: Bool) {
        guard let v = keyboardView else { return }
        if visible { v.becomeFirstResponder() } else { v.resignFirstResponder() }
    }

    func haptic(_ kind: String) {
        switch kind {
        case "medium": impactMedium.impactOccurred()
        case "heavy": impactHeavy.impactOccurred()
        case "selection": selection.selectionChanged()
        case "success": notify.notificationOccurred(.success)
        case "warning": notify.notificationOccurred(.warning)
        case "error": notify.notificationOccurred(.error)
        default: impactLight.impactOccurred()
        }
    }

    /// Read text through VoiceOver when it is on; a no-op otherwise.
    func announce(_ text: String) {
        guard UIAccessibility.isVoiceOverRunning else { return }
        DispatchQueue.main.async { UIAccessibility.post(notification: .announcement, argument: text) }
    }

    func now() -> Double { clock ?? (CACurrentMediaTime() - start) * 1000 }

    func log(_ level: String, _ message: String) { kilnLog("[kiln:\(level)] \(message)") }

    func storageGet(_ key: String) -> JSValue {
        if let s = defaults.string(forKey: "kiln." + key) { return JSValue(object: s, in: context) }
        return JSValue(nullIn: context)
    }

    func storageSet(_ key: String, _ value: String) { defaults.set(value, forKey: "kiln." + key) }
    func storageRemove(_ key: String) { defaults.removeObject(forKey: "kiln." + key) }

    private func resourceURL(_ path: String) -> URL? {
        guard let base = Bundle.main.resourceURL else { return nil }
        let direct = base.appendingPathComponent("Kiln").appendingPathComponent(path)
        if FileManager.default.fileExists(atPath: direct.path) { return direct }
        let flat = base.appendingPathComponent(path)
        return FileManager.default.fileExists(atPath: flat.path) ? flat : nil
    }

    func loadBytes(_ path: String) -> JSValue {
        guard let url = resourceURL(path), let data = try? Data(contentsOf: url) else { return JSValue(nullIn: context) }
        return KilnHost.uint8Array(data, in: context)
    }

    func loadText(_ path: String) -> JSValue {
        guard let url = resourceURL(path), let text = try? String(contentsOf: url, encoding: .utf8) else { return JSValue(nullIn: context) }
        return JSValue(object: text, in: context)
    }

    func loadImage(_ path: String) -> JSValue {
        guard let url = resourceURL(path), let data = try? Data(contentsOf: url) else { return JSValue(nullIn: context) }
        return decodedImage(data)
    }

    func decodeImage(_ bytes: JSValue) -> JSValue {
        guard let (ptr, count) = KilnHost.typedArrayBytes(bytes, in: context) else { return JSValue(nullIn: context) }
        guard count > 0 && count <= 64 * 1024 * 1024 else { return JSValue(nullIn: context) }
        return decodedImage(Data(bytes: ptr, count: count))
    }

    private func decodedImage(_ data: Data) -> JSValue {
        guard let image = UIImage(data: data), let cg = image.cgImage else { return JSValue(nullIn: context) }
        let w = cg.width
        let h = cg.height
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        let space = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(data: &bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return JSValue(nullIn: context) }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        // Un-premultiply so the engine sees straight alpha like the web path.
        var i = 0
        while i < bytes.count {
            let a = Int(bytes[i + 3])
            if a > 0 && a < 255 {
                bytes[i] = UInt8(min(255, Int(bytes[i]) * 255 / a))
                bytes[i + 1] = UInt8(min(255, Int(bytes[i + 1]) * 255 / a))
                bytes[i + 2] = UInt8(min(255, Int(bytes[i + 2]) * 255 / a))
            }
            i += 4
        }
        let out = JSValue(newObjectIn: context)!
        out.setObject(w, forKeyedSubscript: "width" as NSString)
        out.setObject(h, forKeyedSubscript: "height" as NSString)
        out.setObject(KilnHost.uint8Array(Data(bytes), in: context), forKeyedSubscript: "data" as NSString)
        return out
    }

    func uploadTexture(_ slot: Int, _ width: Int, _ height: Int, _ rgba: JSValue) {
        guard let (ptr, len) = KilnHost.typedArrayBytes(rgba, in: context), len >= width * height * 4 else { return }
        renderer.uploadTexture(slot: slot, width: width, height: height, bytes: ptr)
    }

    func rendererDiagnostics() -> JSValue {
        JSValue(object: renderer.meshResources(), in: context)
    }

    func physics3D(_ command: String) -> String {
        let bytes = Array(command.utf8)
        return bytes.withUnsafeBufferPointer {
            guard let result = kiln_physics3d_json($0.baseAddress, UInt32($0.count)) else { return "{\"error\":\"Native physics command rejected\"}" }
            return String(cString: result)
        }
    }

    func submit3D(_ packet: String) {
        if !renderer.submit3D(packet) { context.exception = JSValue(newErrorFromMessage: "Native mesh packet rejected", in: context) }
    }

    func submit(_ post: JSValue, _ vertexCount: Int, _ commandCount: Int) {
        guard let (pptr, plen) = KilnHost.typedArrayBytes(post, in: context) else { return }
        frame = KilnRenderer.Frame(
            vertices: kernel.vertexPointer,
            vertexCount: max(0, vertexCount),
            commands: kernel.commandPointer,
            commandCount: max(0, commandCount),
            post: Array(UnsafeBufferPointer(start: pptr.assumingMemoryBound(to: Float.self), count: plen / 4))
        )
    }

    func rasterizeGlyph(_ family: String, _ size: Int, _ weight: Int, _ style: String, _ ch: String) -> JSValue {
        let font = KilnHost.font(family: family, size: CGFloat(size), weight: weight, italic: style == "italic")
        let attributed = NSAttributedString(string: ch, attributes: [.font: font, .foregroundColor: UIColor.white])
        let line = CTLineCreateWithAttributedString(attributed)
        var ascent: CGFloat = 0
        var descent: CGFloat = 0
        let advance = CTLineGetTypographicBounds(line, &ascent, &descent, nil)
        let bounds = CTLineGetBoundsWithOptions(line, [.useGlyphPathBounds])
        let left = Int(floor(bounds.minX))
        let top = Int(floor(-bounds.maxY))
        let w = max(1, Int(ceil(bounds.maxX)) - left)
        let h = max(1, Int(ceil(-bounds.minY)) - top)
        var bytes = [UInt8](repeating: 0, count: w * h)
        if let ctx = CGContext(data: &bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue) {
            ctx.setAllowsAntialiasing(true)
            ctx.setShouldAntialias(true)
            ctx.setShouldSmoothFonts(false)
            // CoreGraphics draws with the origin at the bottom-left; place the baseline accordingly.
            ctx.textPosition = CGPoint(x: CGFloat(-left), y: CGFloat(h + top))
            CTLineDraw(line, ctx)
        }
        // A CoreGraphics bitmap context stores its first row at the top of the image, so the
        // bytes are already top-down as the engine expects; only the drawing origin is bottom-left.
        let out = JSValue(newObjectIn: context)!
        out.setObject(w, forKeyedSubscript: "w" as NSString)
        out.setObject(h, forKeyedSubscript: "h" as NSString)
        out.setObject(left, forKeyedSubscript: "left" as NSString)
        out.setObject(top, forKeyedSubscript: "top" as NSString)
        out.setObject(Double(advance), forKeyedSubscript: "advance" as NSString)
        out.setObject(Double(font.ascender), forKeyedSubscript: "ascent" as NSString)
        out.setObject(Double(-font.descender), forKeyedSubscript: "descent" as NSString)
        out.setObject(KilnHost.uint8Array(Data(bytes), in: context), forKeyedSubscript: "data" as NSString)
        return out
    }

    // MARK: - Helpers

    /// Fonts shipped under Kiln/fonts by `kiln export ios`, registered once at boot.
    private static var bundledFonts: [(family: String, weight: Double, italic: Bool, descriptor: CTFontDescriptor)] = []

    static func registerBundledFonts() {
        guard let dir = Bundle.main.resourceURL?.appendingPathComponent("Kiln/fonts"),
              let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return }
        for url in files where ["ttf", "otf"].contains(url.pathExtension.lowercased()) {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor] else { continue }
            for d in descriptors {
                let family = (CTFontDescriptorCopyAttribute(d, kCTFontFamilyNameAttribute) as? String) ?? ""
                var weight = 0.0
                var italic = false
                if let traits = CTFontDescriptorCopyAttribute(d, kCTFontTraitsAttribute) as? [CFString: Any] {
                    weight = (traits[kCTFontWeightTrait] as? Double) ?? 0
                    if let symbolic = traits[kCTFontSymbolicTrait] as? UInt32 { italic = symbolic & CTFontSymbolicTraits.traitItalic.rawValue != 0 }
                }
                bundledFonts.append((family, weight, italic, d))
            }
        }
        if !bundledFonts.isEmpty { kilnLog("[kiln] fonts: \(Set(bundledFonts.map { $0.family }).sorted().joined(separator: ", "))") }
    }

    /// CSS weights onto CoreText's -1...1 weight trait.
    private static func appleWeight(_ css: Int) -> Double {
        switch css {
        case ..<150: return -0.8
        case ..<250: return -0.6
        case ..<350: return -0.4
        case ..<450: return 0
        case ..<550: return 0.23
        case ..<650: return 0.3
        case ..<750: return 0.4
        case ..<850: return 0.56
        default: return 0.62
        }
    }

    static func font(family: String, size: CGFloat, weight: Int, italic: Bool) -> UIFont {
        let target = appleWeight(weight)
        let candidates = bundledFonts.filter { $0.family.caseInsensitiveCompare(family) == .orderedSame }
        func score(_ f: (family: String, weight: Double, italic: Bool, descriptor: CTFontDescriptor)) -> Double { abs(f.weight - target) + (f.italic == italic ? 0 : 1) }
        if let best = candidates.min(by: { score($0) < score($1) }) {
            return UIFont(descriptor: best.descriptor as UIFontDescriptor, size: size)
        }
        let uiWeight: UIFont.Weight = weight >= 700 ? .bold : weight >= 600 ? .semibold : weight >= 500 ? .medium : .regular
        if family != "system-ui", let named = UIFont(name: family, size: size) {
            if weight >= 600, let bold = UIFontDescriptor(name: family, size: size).withSymbolicTraits(.traitBold) { return UIFont(descriptor: bold, size: size) }
            return named
        }
        var font = UIFont.systemFont(ofSize: size, weight: uiWeight)
        if italic, let d = font.fontDescriptor.withSymbolicTraits(.traitItalic) { font = UIFont(descriptor: d, size: size) }
        return font
    }

    static func uint8Array(_ data: Data, in context: JSContext) -> JSValue {
        let count = data.count
        let ptr = UnsafeMutablePointer<UInt8>.allocate(capacity: max(1, count))
        data.copyBytes(to: ptr, count: count)
        var exception: JSValueRef?
        let ref = JSObjectMakeTypedArrayWithBytesNoCopy(context.jsGlobalContextRef, kJSTypedArrayTypeUint8Array, ptr, count, { bytes, _ in bytes?.deallocate() }, nil, &exception)
        return JSValue(jsValueRef: ref, in: context)
    }

    static func typedArrayBytes(_ value: JSValue, in context: JSContext) -> (UnsafeMutableRawPointer, Int)? {
        var exception: JSValueRef?
        guard let ptr = JSObjectGetTypedArrayBytesPtr(context.jsGlobalContextRef, value.jsValueRef, &exception) else { return nil }
        let len = JSObjectGetTypedArrayByteLength(context.jsGlobalContextRef, value.jsValueRef, &exception)
        return (ptr, len)
    }
}

/// Owns the JavaScript context, boots the game, and drives frames from a display link.
final class KilnRuntime: NSObject {
    let context = JSContext()!
    let renderer: KilnRenderer
    let host: KilnHost
    private weak var view: KilnView?
    private var bridge: JSValue?
    private var gamepad: KilnGamepad?
    private var displayLink: CADisplayLink?
    private var lastSize = CGSize.zero
    private var lastInsets = UIEdgeInsets.zero
    private var scale: CGFloat = 1
    private var booted = false
    /// Snapshot requests from the environment (see `kiln verify`): frame to capture and file.
    private let snapshotFrame: Int?
    private let snapshotPath: String?
    private let fixedDt: Double?
    /// Scripted taps in logical units: x, y and the frame to press on.
    private let taps: [(Double, Double, Int)]
    private var frames = 0

    init(view: KilnView) {
        self.view = view
        guard let r = KilnRenderer(layer: view.metalLayer, drawableSize: view.drawableSize) else {
            fatalError("Kiln: no GPU adapter for the Metal layer")
        }
        renderer = r
        host = KilnHost(context: context, renderer: renderer)
        let env = ProcessInfo.processInfo.environment
        snapshotFrame = env["KILN_SNAPSHOT_FRAME"].flatMap { Int($0) }
        snapshotPath = env["KILN_SNAPSHOT"]
        fixedDt = env["KILN_FIXED_DT"].flatMap { Double($0) }
        host.deterministic = fixedDt != nil
        taps = (env["KILN_TAPS"] ?? "").split(separator: ";").compactMap { spec in
            let parts = spec.split(separator: ":")
            guard parts.count == 2, let frame = Int(parts[1]) else { return nil }
            let xy = parts[0].split(separator: ",")
            guard xy.count == 2, let x = Double(xy[0]), let y = Double(xy[1]) else { return nil }
            return (x, y, frame)
        }
        super.init()
        // Safari's Web Inspector can attach to this context (Develop menu, the simulator or device).
        if #available(iOS 16.4, *) {
            context.isInspectable = true
            context.name = "Kiln"
        }
        host.keyboardView = view
        context.exceptionHandler = { _, exception in
            kilnLog("[kiln:js] \(exception?.toString() ?? "unknown error") \(exception?.objectForKeyedSubscript("stack")?.toString() ?? "")")
        }
        // A minimal console for the engine's own logging.
        let console = JSValue(newObjectIn: context)!
        for level in ["log", "info", "warn", "error", "debug"] {
            let fn: @convention(block) () -> Void = {
                let args = JSContext.currentArguments()?.map { ($0 as AnyObject).toString() ?? "" } ?? []
                kilnLog("[js:\(level)] \(args.joined(separator: " "))")
            }
            console.setObject(fn, forKeyedSubscript: level as NSString)
        }
        context.setObject(console, forKeyedSubscript: "console" as NSString)
        context.setObject(host, forKeyedSubscript: "__kilnHost" as NSString)
        let timers: @convention(block) (JSValue, Double) -> Int = { fn, ms in
            DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000) { fn.call(withArguments: []) }
            return 0
        }
        context.setObject(timers, forKeyedSubscript: "setTimeout" as NSString)
        let interval: @convention(block) (JSValue, Double) -> Int = { fn, ms in
            let t = Timer.scheduledTimer(withTimeInterval: max(0.001, ms / 1000), repeats: true) { _ in fn.call(withArguments: []) }
            RunLoop.main.add(t, forMode: .common)
            return 0
        }
        context.setObject(interval, forKeyedSubscript: "setInterval" as NSString)
        let clear: @convention(block) (Int) -> Void = { _ in }
        context.setObject(clear, forKeyedSubscript: "clearTimeout" as NSString)
        context.setObject(clear, forKeyedSubscript: "clearInterval" as NSString)
    }

    /// Load the game script and start it. The engine installs `__kiln` when ready.
    func boot() {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("Kiln/game.js"),
              let source = try? String(contentsOf: url, encoding: .utf8) else {
            kilnLog("[kiln] Kiln/game.js is missing from the bundle")
            return
        }
        pushScreen()
        context.evaluateScript(source, withSourceURL: url)
        context.evaluateScript("__kilnBoot().catch(e => console.error('boot failed', e && e.stack || e))")
        booted = true
        connectBridge()
        gamepad = KilnGamepad(runtime: self)
    }

    private func connectBridge() {
        guard bridge == nil, let b = context.objectForKeyedSubscript("__kiln"), !b.isUndefined else { return }
        bridge = b
        if let v = view { viewChanged(size: v.bounds.size, scale: v.contentScaleFactor, insets: lastInsets) }
    }

    private func pushScreen() {
        host.screen = ["width": Double(lastSize.width), "height": Double(lastSize.height), "scale": Double(scale), "insets": [Double(lastInsets.top), Double(lastInsets.right), Double(lastInsets.bottom), Double(lastInsets.left)]]
    }

    /// Drive frames from the display's refresh.
    func start() {
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    func viewChanged(size: CGSize, scale: CGFloat, insets: UIEdgeInsets) {
        lastSize = size
        lastInsets = insets
        self.scale = scale
        renderer.resize(width: Int(size.width * scale), height: Int(size.height * scale))
        pushScreen()
        bridge?.invokeMethod("resize", withArguments: [Double(size.width), Double(size.height), Double(scale), [Double(insets.top), Double(insets.right), Double(insets.bottom), Double(insets.left)]])
    }

    func pointer(kind: String, id: Int, x: CGFloat, y: CGFloat) {
        bridge?.invokeMethod("pointer", withArguments: [kind, id, Double(x), Double(y), "touch"])
    }

    func key(code: String, down: Bool) {
        bridge?.invokeMethod("key", withArguments: [code, down])
    }

    func text(_ text: String) {
        bridge?.invokeMethod("text", withArguments: [text])
    }

    func setVisible(_ visible: Bool) {
        bridge?.invokeMethod("visibility", withArguments: [visible])
    }

    // MARK: Frames

    @objc private func tick() {
        if bridge == nil {
            connectBridge()
            guard bridge != nil else { return }
        }
        host.frame = nil
        if let dt = fixedDt { host.clock = Double(frames) * dt }
        for (x, y, at) in taps {
            if frames == at { bridge?.invokeMethod("pointerLogical", withArguments: ["down", 1, x, y]) }
            if frames == at + 1 { bridge?.invokeMethod("pointerLogical", withArguments: ["up", 1, x, y]) }
        }
        bridge?.invokeMethod("frame", withArguments: [host.now()])
        guard let frame = host.frame else { return }
        let capture = snapshotFrame.map { frames == $0 } ?? false
        renderer.render(frame, capture: capture)
        frames += 1
        if capture, let path = snapshotPath, let shot = renderer.takeCapture() {
            KilnRuntime.writePNG(shot.rgba, width: shot.width, height: shot.height, to: path)
            kilnLog("[kiln] snapshot written to \(path)")
            if ProcessInfo.processInfo.environment["KILN_SNAPSHOT_EXIT"] == "1" { exit(0) }
        }
    }

    /// Encode tightly packed RGBA as PNG through CoreGraphics.
    static func writePNG(_ rgba: Data, width: Int, height: Int, to path: String) {
        guard let provider = CGDataProvider(data: rgba as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
              let png = UIImage(cgImage: image).pngData() else { return }
        try? png.write(to: URL(fileURLWithPath: path))
    }

    /// Map hardware key presses to the `KeyboardEvent.code` names the engine binds.
    static func keyCode(for key: UIKey?) -> String? {
        guard let key else { return nil }
        switch key.keyCode {
        case .keyboardUpArrow: return "ArrowUp"
        case .keyboardDownArrow: return "ArrowDown"
        case .keyboardLeftArrow: return "ArrowLeft"
        case .keyboardRightArrow: return "ArrowRight"
        case .keyboardSpacebar: return "Space"
        case .keyboardReturnOrEnter: return "Enter"
        case .keyboardEscape: return "Escape"
        default:
            let c = key.charactersIgnoringModifiers.uppercased()
            if c.count == 1, let s = c.unicodeScalars.first, CharacterSet.uppercaseLetters.contains(s) { return "Key\(c)" }
            if c.count == 1, let s = c.unicodeScalars.first, CharacterSet.decimalDigits.contains(s) { return "Digit\(c)" }
            return nil
        }
    }
}
