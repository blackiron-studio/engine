import Metal
import QuartzCore
import KilnKernel

/// The kernel's wgpu renderer drawing into this view's CAMetalLayer. Swift only forwards
/// textures and frames; the shaders, targets, bloom and composite live in the kernel, the
/// same code the desktop and Android hosts run.
final class KilnRenderer {
    /// One frame as the kernel left it: pointers into kernel memory, valid until the next run.
    struct Frame {
        var vertices: UnsafeRawPointer
        var vertexCount: Int
        var commands: UnsafePointer<UInt32>
        var commandCount: Int
        var post: [Float]
    }

    private let handle: OpaquePointer

    init?(layer: CAMetalLayer, drawableSize: CGSize) {
        let ptr = Unmanaged.passUnretained(layer).toOpaque()
        guard let h = kiln_render_new_metal_layer(ptr, UInt32(max(1, drawableSize.width)), UInt32(max(1, drawableSize.height)), 32768) else { return nil }
        handle = h
    }

    func resize(width: Int, height: Int) {
        kiln_render_resize(handle, UInt32(max(1, width)), UInt32(max(1, height)))
    }

    func uploadTexture(slot: Int, width: Int, height: Int, bytes: UnsafeRawPointer) {
        kiln_render_upload_texture(handle, UInt32(slot), UInt32(width), UInt32(height), bytes.assumingMemoryBound(to: UInt8.self))
    }

    func meshResources() -> [String: Double] {
        ["geometries": Double(kiln_render_mesh_resource(handle, 0)), "textures": Double(kiln_render_mesh_resource(handle, 1)), "meshBytes": Double(kiln_render_mesh_resource(handle, 2))]
    }

    func submit3D(_ packet: String) -> Bool {
        let bytes = Array(packet.utf8)
        return bytes.withUnsafeBufferPointer { kiln_render_mesh(handle, $0.baseAddress, UInt32($0.count)) != 0 }
    }

    /// Present a frame; with `capture` the image is read back for `takeCapture`.
    @discardableResult
    func render(_ f: Frame, capture: Bool = false) -> Bool {
        f.post.withUnsafeBufferPointer { p in
            kiln_render_frame(handle, f.vertices.assumingMemoryBound(to: Float.self), UInt32(f.vertexCount), f.commands, UInt32(f.commandCount), p.baseAddress, UInt32(p.count), capture ? 1 : 0) != 0
        }
    }

    /// The last captured frame as tightly packed RGBA.
    func takeCapture() -> (width: Int, height: Int, rgba: Data)? {
        var w: UInt32 = 0
        var h: UInt32 = 0
        let bytes = kiln_render_capture_size(handle, &w, &h)
        guard bytes > 0 else { return nil }
        var data = Data(count: Int(bytes))
        data.withUnsafeMutableBytes { buf in
            _ = kiln_render_capture_read(handle, buf.baseAddress!.assumingMemoryBound(to: UInt8.self), bytes)
        }
        return (Int(w), Int(h), data)
    }

    deinit { kiln_render_free(handle) }
}
