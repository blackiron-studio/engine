import JavaScriptCore
import KilnKernel

/// One physics world of the kernel, as the engine's `NativePhysicsWorld`: a scratch buffer
/// over kernel memory, one call, and the transforms and events of the last step.
@objc protocol KilnPhysicsExports: JSExport {
    var scratch: JSValue { get }
    func call(_ op: Int, _ words: Int) -> Int
    func transforms() -> JSValue
    func events() -> JSValue
    func destroy()
}

@objc final class KilnPhysicsBridge: NSObject, KilnPhysicsExports {
    private var handle: OpaquePointer?
    private let context: JSContext
    let scratch: JSValue

    init(context: JSContext, pixelsPerMeter: Double) {
        self.context = context
        let h = kiln_physics_new(Float(pixelsPerMeter))!
        handle = h
        var exception: JSValueRef?
        let ref = JSObjectMakeTypedArrayWithBytesNoCopy(context.jsGlobalContextRef, kJSTypedArrayTypeFloat32Array, kiln_physics_scratch(h), Int(kiln_physics_scratch_words(h)) * 4, { _, _ in }, nil, &exception)
        scratch = JSValue(jsValueRef: ref, in: context)
        super.init()
    }

    func call(_ op: Int, _ words: Int) -> Int {
        guard let handle else { return -1 }
        return Int(kiln_physics_call(handle, UInt32(max(0, op)), UInt32(max(0, words))))
    }

    /// Copies, because the kernel's buffers move as bodies are added.
    private func copyFloats(_ ptr: UnsafePointer<Float>?, count: Int) -> JSValue {
        guard let ptr, count > 0 else {
            return context.evaluateScript("new Float32Array(0)")
        }
        let bytes = count * 4
        let mem = UnsafeMutablePointer<UInt8>.allocate(capacity: bytes)
        mem.update(from: UnsafeRawPointer(ptr).assumingMemoryBound(to: UInt8.self), count: bytes)
        var exception: JSValueRef?
        let ref = JSObjectMakeTypedArrayWithBytesNoCopy(context.jsGlobalContextRef, kJSTypedArrayTypeFloat32Array, mem, bytes, { p, _ in p?.deallocate() }, nil, &exception)
        return JSValue(jsValueRef: ref, in: context)
    }

    func transforms() -> JSValue {
        guard let handle else { return copyFloats(nil, count: 0) }
        return copyFloats(kiln_physics_transforms(handle), count: Int(kiln_physics_transform_count(handle)) * 8)
    }

    func events() -> JSValue {
        guard let handle else { return copyFloats(nil, count: 0) }
        return copyFloats(kiln_physics_events(handle), count: Int(kiln_physics_event_count(handle)) * 4)
    }

    func destroy() {
        if let handle {
            kiln_physics_free(handle)
        }
        handle = nil
    }

    deinit { destroy() }
}
