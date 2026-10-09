import AVFoundation
import JavaScriptCore
import BlackironKernel

/// The kernel synthesiser on an AVAudioEngine. The engine's script writes commands into
/// `scratch` and calls `command`; the render block on the audio thread pulls stereo PCM
/// from the kernel, which mixes voices and samples with the same DSP as the web build.
@objc protocol BlackironAudioExports: JSExport {
    var scratch: JSValue { get }
    func unlock()
    func time() -> Double
    func command(_ words: Int)
    func loadSample(_ id: Int, _ bytes: JSValue) -> Bool
    func loadStream(_ id: Int, _ bytes: JSValue) -> Int
    func closeStream(_ id: Int)
    func peak() -> Double
}

// The source-node closure retains this owner until its last callback has returned.
// Every FFI access uses one lock, avoiding overlapping Rust &mut Audio references.
private final class BlackironAudioState {
    let handle: OpaquePointer
    let lock = NSLock()
    let capacity = 8192
    let output: UnsafeMutablePointer<Float>
    init(rate: Double) {
        handle = blackiron_audio_new(UInt32(rate), 64)!
        output = .allocate(capacity: capacity * 2)
        output.initialize(repeating: 0, count: capacity * 2)
    }
    deinit {
        output.deinitialize(count: capacity * 2)
        output.deallocate()
        blackiron_audio_free(handle)
    }
}

@objc final class BlackironAudio: NSObject, BlackironAudioExports {
    private let state: BlackironAudioState
    private var handle: OpaquePointer { state.handle }
    private let engine = AVAudioEngine()
    private let context: JSContext
    private let sampleRate: Double
    private var started = false
    let scratch: JSValue

    init(context: JSContext) {
        self.context = context
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
        try? session.setActive(true)
        let hw = session.sampleRate
        sampleRate = hw >= 8000 ? hw : 48000
        state = BlackironAudioState(rate: sampleRate)
        var exception: JSValueRef?
        // JS owns its command staging area. It never writes kernel memory while audio renders.
        let ref = JSObjectMakeTypedArray(context.jsGlobalContextRef, kJSTypedArrayTypeFloat32Array, Int(blackiron_audio_scratch_words(state.handle)), &exception)
        scratch = JSValue(jsValueRef: ref, in: context)
        super.init()
        // The kernel renders interleaved stereo; the engine's buses want deinterleaved channels.
        let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2)!
        let audio = state
        var position: Double = 0
        let node = AVAudioSourceNode(format: format) { _, _, frameCount, list -> OSStatus in
            let buffers = UnsafeMutableAudioBufferListPointer(list)
            // Never wait on decoding or script work from the real-time callback.
            guard audio.lock.try() else {
                for buffer in buffers {
                    if let data = buffer.mData { memset(data, 0, Int(buffer.mDataByteSize)) }
                }
                position += Double(frameCount)
                return noErr
            }
            defer { audio.lock.unlock() }
            var offset = 0
            while offset < Int(frameCount) {
                let n = min(Int(frameCount) - offset, audio.capacity)
                blackiron_audio_render_into(audio.handle, position + Double(offset), audio.output, UInt32(n))
                if buffers.count >= 2, let l = buffers[0].mData?.assumingMemoryBound(to: Float.self), let r = buffers[1].mData?.assumingMemoryBound(to: Float.self) {
                    for i in 0..<n {
                        l[offset + i] = audio.output[i * 2]
                        r[offset + i] = audio.output[i * 2 + 1]
                    }
                } else if buffers.count > 0, let m = buffers[0].mData?.assumingMemoryBound(to: Float.self) {
                    for i in 0..<n { m[offset + i] = (audio.output[i * 2] + audio.output[i * 2 + 1]) * 0.5 }
                }
                offset += n
            }
            position += Double(frameCount)
            return noErr
        }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        engine.prepare()
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
    }

    deinit {
        engine.stop()
        NotificationCenter.default.removeObserver(self)
    }

    func unlock() {
        // Local simulator previews can opt out of opening an output stream without
        // changing the game's persisted audio settings or release behavior.
        if ProcessInfo.processInfo.environment["BLACKIRON_MUTE"] == "1" { return }
        guard !started else { return }
        do {
            try engine.start()
            started = true
            blackironLog("[blackiron] audio: \(Int(sampleRate)) Hz")
        } catch {
            blackironLog("[blackiron] audio failed to start: \(error)")
        }
    }

    @objc private func interrupted(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .ended {
            started = false
            unlock()
        }
    }

    func time() -> Double {
        state.lock.lock(); defer { state.lock.unlock() }
        return blackiron_audio_time(handle)
    }
    func command(_ words: Int) {
        guard let (source, bytes) = BlackironHost.typedArrayBytes(scratch, in: context) else { return }
        state.lock.lock(); defer { state.lock.unlock() }
        let count = min(max(0, words), bytes / 4, Int(blackiron_audio_scratch_words(handle)))
        if let target = blackiron_audio_scratch(handle) {
            UnsafeMutableRawPointer(target).copyMemory(from: source, byteCount: count * 4)
            _ = blackiron_audio_command(handle, UInt32(count))
        }
    }
    func peak() -> Double {
        state.lock.lock(); defer { state.lock.unlock() }
        return Double(blackiron_audio_peak(handle))
    }

    /// Decode a file with CoreAudio (WAV, AIFF, MP3, AAC, FLAC, CAF) to mono at the engine rate.
    func loadSample(_ id: Int, _ bytes: JSValue) -> Bool {
        guard let (ptr, len) = BlackironHost.typedArrayBytes(bytes, in: context) else { return false }
        let data = Data(bytes: ptr, count: len)
        let ext = BlackironAudio.sniff(data)
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("blackiron-sample-\(id).\(ext)")
        do { try data.write(to: tmp) } catch { return false }
        defer { try? FileManager.default.removeItem(at: tmp) }
        guard let file = try? AVAudioFile(forReading: tmp) else {
            blackironLog("[blackiron] could not decode sample \(id)")
            return false
        }
        let inFormat = file.processingFormat
        guard file.length > 0, let inBuf = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(file.length)) else { return false }
        do { try file.read(into: inBuf) } catch { return false }
        let outFormat = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
        var mono = inBuf
        if inFormat.sampleRate != sampleRate || inFormat.channelCount != 1 || inFormat.commonFormat != .pcmFormatFloat32 || inFormat.isInterleaved {
            guard let converter = AVAudioConverter(from: inFormat, to: outFormat) else { return false }
            let capacity = AVAudioFrameCount(Double(inBuf.frameLength) * sampleRate / inFormat.sampleRate) + 64
            guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return false }
            var consumed = false
            var error: NSError?
            converter.convert(to: out, error: &error) { _, status in
                if consumed {
                    status.pointee = .endOfStream
                    return nil
                }
                consumed = true
                status.pointee = .haveData
                return inBuf
            }
            if error != nil { return false }
            mono = out
        }
        guard let channels = mono.floatChannelData else { return false }
        let frames = Int(mono.frameLength)
        state.lock.lock(); defer { state.lock.unlock() }
        guard blackiron_audio_sample_begin(handle, Int32(id), UInt32(frames)) != 0, let scratchPtr = blackiron_audio_scratch(handle) else { return false }
        let cap = Int(blackiron_audio_scratch_words(handle))
        var offset = 0
        while offset < frames {
            let n = min(cap, frames - offset)
            scratchPtr.update(from: channels[0] + offset, count: n)
            _ = blackiron_audio_sample_write(handle, Int32(id), UInt32(offset), UInt32(n))
            offset += n
        }
        return true
    }

    /// Hand an encoded track to the kernel's streaming decoder; returns its rate, or 0.
    func loadStream(_ id: Int, _ bytes: JSValue) -> Int {
        guard let (ptr, len) = BlackironHost.typedArrayBytes(bytes, in: context), len > 0 else { return 0 }
        state.lock.lock(); defer { state.lock.unlock() }
        guard blackiron_audio_stream_begin(handle, Int32(id), UInt32(len)) != 0, let scratchPtr = blackiron_audio_scratch(handle) else { return 0 }
        let cap = Int(blackiron_audio_scratch_words(handle)) * 4
        let raw = UnsafeMutableRawPointer(scratchPtr)
        var offset = 0
        while offset < len {
            let n = min(cap, len - offset)
            raw.copyMemory(from: ptr.advanced(by: offset), byteCount: n)
            if blackiron_audio_stream_write(handle, Int32(id), UInt32(n)) == 0 { return 0 }
            offset += n
        }
        return Int(blackiron_audio_stream_open(handle, Int32(id)))
    }

    func closeStream(_ id: Int) {
        state.lock.lock(); defer { state.lock.unlock() }
        blackiron_audio_stream_close(handle, Int32(id))
    }

    private static func sniff(_ data: Data) -> String {
        let head = [UInt8](data.prefix(12))
        if head.count >= 4 {
            if head[0] == 0x52, head[1] == 0x49, head[2] == 0x46, head[3] == 0x46 { return "wav" }
            if head[0] == 0x46, head[1] == 0x4f, head[2] == 0x52, head[3] == 0x4d { return "aiff" }
            if head[0] == 0x66, head[1] == 0x4c, head[2] == 0x61, head[3] == 0x43 { return "flac" }
            if head[0] == 0x63, head[1] == 0x61, head[2] == 0x66, head[3] == 0x66 { return "caf" }
            if head[0] == 0x49, head[1] == 0x44, head[2] == 0x33 { return "mp3" }
            if head[0] == 0xff, (head[1] & 0xe0) == 0xe0 { return "mp3" }
        }
        if head.count >= 8, head[4] == 0x66, head[5] == 0x74, head[6] == 0x79, head[7] == 0x70 { return "m4a" }
        return "wav"
    }
}
