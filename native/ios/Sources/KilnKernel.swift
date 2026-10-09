import JavaScriptCore
import KilnKernel

/// The compiled kernel as the engine sees it: the same surface as the TypeScript `Kernel`
/// interface. Buffers are typed arrays over the kernel's own memory, so the script writes
/// its command stream straight into native memory and `run` expands it in place.
@objc protocol KilnKernelExports: JSExport {
    var kind: String { get }
    var maxQuads: Int { get }
    var stream: JSValue { get }
    var scratch: JSValue { get }
    var vertices: JSValue { get }
    var commands: JSValue { get }
    var stats: JSValue { get }
    func setWhite(_ u: Double, _ v: Double)
    func run(_ length: Int)
    func createBatch(_ capacity: Int) -> Int
    func batchData(_ id: Int) -> JSValue
    func setBatchCount(_ id: Int, _ count: Int)
    func destroyBatch(_ id: Int)
    func createEmitter(_ words: Int) -> Int
    func burst(_ id: Int, _ n: Int, _ x: Double, _ y: Double)
    func emitterCount(_ id: Int) -> Int
    func clearEmitter(_ id: Int)
    func destroyEmitter(_ id: Int)
    func createNodes(_ capacity: Int) -> Int
    func nodesData(_ id: Int) -> JSValue
    func allocNode(_ id: Int) -> Int
    func freeNode(_ id: Int, _ index: Int)
    func clearNodes(_ id: Int)
    func nodeCount(_ id: Int) -> Int
    func nodesHigh(_ id: Int) -> Int
    func stepNodes(_ id: Int, _ dt: Double)
    func configureNodes(_ id: Int, _ gx: Double, _ gy: Double, _ damping: Double, _ mode: Int, _ bx: Double, _ by: Double, _ bw: Double, _ bh: Double, _ gz: Double, _ floor: Int)
    func createBatch3(_ capacity: Int) -> Int
    func batch3Data(_ id: Int) -> JSValue
    func setBatch3Count(_ id: Int, _ count: Int)
    func destroyBatch3(_ id: Int)
    func setShadow(_ w: Double, _ h: Double, _ ox: Double, _ oy: Double, _ u0: Double, _ v0: Double, _ u1: Double, _ v1: Double)
    func setNodeFrames(_ id: Int, _ words: Int)
    func applyNodeTransforms(_ id: Int, _ words: Int) -> Int
    func destroyNodes(_ id: Int)
    func destroy()
}

@objc final class KilnKernelBridge: NSObject, KilnKernelExports {
    static let statCount = 8
    let handle: OpaquePointer
    let kind = "native"
    let maxQuads: Int
    let stream: JSValue
    let scratch: JSValue
    let vertices: JSValue
    let commands: JSValue
    let stats: JSValue
    private let context: JSContext
    private var batchCapacities: [Int: Int] = [:]
    private var batch3Capacities: [Int: Int] = [:]

    init(context: JSContext, maxQuads: Int = 32768, streamWords: Int = 1 << 18) {
        self.context = context
        self.maxQuads = maxQuads
        handle = kiln_new(UInt32(maxQuads), UInt32(streamWords))!
        stream = KilnKernelBridge.view(kiln_stream(handle), count: Int(kiln_stream_words(handle)), kJSTypedArrayTypeFloat32Array, 4, context)
        scratch = KilnKernelBridge.view(kiln_scratch(handle), count: Int(kiln_scratch_words(handle)), kJSTypedArrayTypeFloat32Array, 4, context)
        vertices = KilnKernelBridge.view(UnsafeMutableRawPointer(mutating: kiln_vertices(handle)), count: Int(kiln_vertex_cap(handle)) * 10, kJSTypedArrayTypeFloat32Array, 4, context)
        commands = KilnKernelBridge.view(UnsafeMutableRawPointer(mutating: kiln_commands(handle)), count: Int(kiln_command_cap(handle)), kJSTypedArrayTypeUint32Array, 4, context)
        stats = KilnKernelBridge.view(UnsafeMutableRawPointer(mutating: kiln_stats(handle)), count: KilnKernelBridge.statCount, kJSTypedArrayTypeUint32Array, 4, context)
        super.init()
    }

    /// A typed array that aliases kernel memory. The kernel owns it, so the deallocator is a no-op.
    private static func view(_ ptr: UnsafeMutableRawPointer?, count: Int, _ type: JSTypedArrayType, _ elementSize: Int, _ context: JSContext) -> JSValue {
        guard let ptr, count > 0 else { return JSValue(undefinedIn: context) }
        var exception: JSValueRef?
        let ref = JSObjectMakeTypedArrayWithBytesNoCopy(context.jsGlobalContextRef, type, ptr, count * elementSize, { _, _ in }, nil, &exception)
        return JSValue(jsValueRef: ref, in: context)
    }

    var vertexPointer: UnsafeRawPointer { UnsafeRawPointer(kiln_vertices(handle)!) }
    var commandPointer: UnsafePointer<UInt32> { kiln_commands(handle)! }

    func setWhite(_ u: Double, _ v: Double) { kiln_set_white(handle, Float(u), Float(v)) }
    func run(_ length: Int) { kiln_run(handle, UInt32(max(0, length))) }

    func createBatch(_ capacity: Int) -> Int {
        let id = Int(kiln_batch_create(handle, UInt32(max(1, capacity))))
        batchCapacities[id] = max(1, capacity)
        return id
    }

    func batchData(_ id: Int) -> JSValue {
        guard let cap = batchCapacities[id], let ptr = kiln_batch_data(handle, Int32(id)) else { return JSValue(undefinedIn: context) }
        return KilnKernelBridge.view(UnsafeMutableRawPointer(ptr), count: cap * 8, kJSTypedArrayTypeFloat32Array, 4, context)
    }

    func setBatchCount(_ id: Int, _ count: Int) { kiln_batch_set_count(handle, Int32(id), UInt32(max(0, count))) }

    func destroyBatch(_ id: Int) {
        kiln_batch_destroy(handle, Int32(id))
        batchCapacities[id] = nil
    }

    func createEmitter(_ words: Int) -> Int { Int(kiln_emitter_create(handle, UInt32(max(0, words)))) }
    func burst(_ id: Int, _ n: Int, _ x: Double, _ y: Double) { kiln_emitter_burst(handle, Int32(id), UInt32(max(0, n)), Float(x), Float(y)) }
    func emitterCount(_ id: Int) -> Int { Int(kiln_emitter_count(handle, Int32(id))) }
    func clearEmitter(_ id: Int) { kiln_emitter_clear(handle, Int32(id)) }
    func destroyEmitter(_ id: Int) { kiln_emitter_destroy(handle, Int32(id)) }

    // Node tables alias kernel memory like the stream does; the script writes records in place.
    func createNodes(_ capacity: Int) -> Int { Int(kiln_nodes_create(handle, UInt32(max(1, capacity)))) }
    func nodesData(_ id: Int) -> JSValue {
        let cap = Int(kiln_nodes_capacity(handle, Int32(id)))
        guard cap > 0, let ptr = kiln_nodes_data(handle, Int32(id)) else { return JSValue(undefinedIn: context) }
        return KilnKernelBridge.view(UnsafeMutableRawPointer(ptr), count: cap * 32, kJSTypedArrayTypeFloat32Array, 4, context)
    }
    func allocNode(_ id: Int) -> Int { Int(kiln_nodes_alloc(handle, Int32(id))) }
    func freeNode(_ id: Int, _ index: Int) { kiln_nodes_free(handle, Int32(id), Int32(index)) }
    func clearNodes(_ id: Int) { kiln_nodes_clear(handle, Int32(id)) }
    func nodeCount(_ id: Int) -> Int { Int(kiln_nodes_count(handle, Int32(id))) }
    func nodesHigh(_ id: Int) -> Int { Int(kiln_nodes_high(handle, Int32(id))) }
    func stepNodes(_ id: Int, _ dt: Double) { kiln_nodes_step(handle, Int32(id), Float(dt)) }
    func configureNodes(_ id: Int, _ gx: Double, _ gy: Double, _ damping: Double, _ mode: Int, _ bx: Double, _ by: Double, _ bw: Double, _ bh: Double, _ gz: Double, _ floor: Int) {
        kiln_nodes_configure(handle, Int32(id), Float(gx), Float(gy), Float(damping), UInt32(max(0, mode)), Float(bx), Float(by), Float(bw), Float(bh), Float(gz), UInt32(max(0, floor)))
    }

    // World-space batches: instances in ground units the kernel projects and sorts.
    func createBatch3(_ capacity: Int) -> Int {
        let id = Int(kiln_batch3_create(handle, UInt32(max(1, capacity))))
        batch3Capacities[id] = max(1, capacity)
        return id
    }
    func batch3Data(_ id: Int) -> JSValue {
        guard let cap = batch3Capacities[id], let ptr = kiln_batch3_data(handle, Int32(id)) else { return JSValue(undefinedIn: context) }
        return KilnKernelBridge.view(UnsafeMutableRawPointer(ptr), count: cap * 14, kJSTypedArrayTypeFloat32Array, 4, context)
    }
    func setBatch3Count(_ id: Int, _ count: Int) { kiln_batch3_set_count(handle, Int32(id), UInt32(max(0, count))) }
    func destroyBatch3(_ id: Int) {
        kiln_batch3_destroy(handle, Int32(id))
        batch3Capacities[id] = nil
    }
    func setShadow(_ w: Double, _ h: Double, _ ox: Double, _ oy: Double, _ u0: Double, _ v0: Double, _ u1: Double, _ v1: Double) {
        kiln_set_shadow(handle, Float(w), Float(h), Float(ox), Float(oy), Float(u0), Float(v0), Float(u1), Float(v1))
    }
    func setNodeFrames(_ id: Int, _ words: Int) { kiln_nodes_set_frames(handle, Int32(id), UInt32(max(0, words))) }
    func applyNodeTransforms(_ id: Int, _ words: Int) -> Int { Int(kiln_nodes_apply_transforms(handle, Int32(id), UInt32(max(0, words)))) }
    func destroyNodes(_ id: Int) { kiln_nodes_destroy(handle, Int32(id)) }
    func destroy() {}

    deinit { kiln_free(handle) }
}
