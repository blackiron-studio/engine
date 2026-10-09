//! The audio kernel: a software synthesiser and mixer that renders the engine's sound
//! effects, generative music and samples to PCM. Hosts pull from it on their audio thread
//! (an AVAudioSourceNode on Apple platforms, an AudioWorklet on the web) while the script
//! pushes commands from the main thread through a lock-free ring. It reproduces what the
//! 0.3 Web Audio graph did (exponential envelopes and sweeps, a low-pass biquad, vibrato,
//! looped noise) so every platform sounds the same.

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub const CMD_VOICE: u32 = 1;
pub const CMD_SAMPLE: u32 = 2;
pub const CMD_BUS: u32 = 3;
pub const CMD_MUTE: u32 = 4;
pub const CMD_STOP: u32 = 5;
/// Fade a bus to a level over some seconds: [6, bus, target, seconds].
pub const CMD_FADE: u32 = 6;
/// Release every voice on a bus over some seconds: [7, bus, seconds].
pub const CMD_STOP_BUS: u32 = 7;
/// Bus effects: [8, bus, lowpass_hz, reverb_mix, reverb_size, echo_seconds, echo_feedback, echo_mix].
pub const CMD_BUS_FX: u32 = 8;
/// Play an opened stream: [9, at, bus, id, volume, pitch, pan, loop].
pub const CMD_STREAM: u32 = 9;
/// Largest encoded file a stream holds.
const MAX_STREAM_BYTES: usize = 64 << 20;
const MAX_ECHO_SECONDS: f64 = 2.0;
pub const BUS_COUNT: usize = 3;

pub const WAVE_SINE: u32 = 0;
pub const WAVE_SQUARE: u32 = 1;
pub const WAVE_SAW: u32 = 2;
pub const WAVE_TRIANGLE: u32 = 3;
pub const WAVE_NOISE: u32 = 4;

pub const SCRATCH_WORDS: usize = 8192;
pub const OUT_FRAMES: usize = 4096;
pub const CHANNELS: usize = 2;
const RING_SLOTS: usize = 512;
const CMD_WORDS: usize = 16;
const NOISE_LEN: usize = 48000;
const MIN_GAIN: f64 = 0.0001;
const CONTROL_RATE: usize = 8;

#[derive(Clone, Copy)]
struct Cmd {
    words: [f32; CMD_WORDS],
    len: u32,
}

/// Single-producer, single-consumer ring of commands. The script thread writes, the audio
/// thread reads; each slot is touched by one side at a time.
struct Ring {
    slots: UnsafeCell<Vec<Cmd>>,
    head: AtomicUsize,
    tail: AtomicUsize,
}

unsafe impl Sync for Ring {}
unsafe impl Send for Ring {}

impl Ring {
    fn new() -> Ring {
        Ring { slots: UnsafeCell::new(vec![Cmd { words: [0.0; CMD_WORDS], len: 0 }; RING_SLOTS]), head: AtomicUsize::new(0), tail: AtomicUsize::new(0) }
    }

    fn push(&self, words: &[f32]) -> bool {
        let head = self.head.load(Ordering::Relaxed);
        let tail = self.tail.load(Ordering::Acquire);
        if head - tail >= RING_SLOTS {
            return false;
        }
        let n = words.len().min(CMD_WORDS);
        let slots = unsafe { &mut *self.slots.get() };
        let slot = &mut slots[head % RING_SLOTS];
        slot.words[..n].copy_from_slice(&words[..n]);
        slot.len = n as u32;
        self.head.store(head + 1, Ordering::Release);
        true
    }

    fn pop(&self) -> Option<Cmd> {
        let tail = self.tail.load(Ordering::Relaxed);
        let head = self.head.load(Ordering::Acquire);
        if tail == head {
            return None;
        }
        let slots = unsafe { &*self.slots.get() };
        let cmd = slots[tail % RING_SLOTS];
        self.tail.store(tail + 1, Ordering::Release);
        Some(cmd)
    }
}

#[derive(Clone)]
enum Source {
    Osc(u32),
    Noise,
    Sample(Arc<Vec<f32>>),
    /// A streamed track by id; one voice at a time reads it.
    Stream(usize),
}

/// RBJ biquad in transposed direct form II.
#[derive(Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn lowpass(fc: f64, sr: f64) -> Biquad {
        let w0 = 2.0 * std::f64::consts::PI * fc.min(sr * 0.45) / sr;
        let alpha = w0.sin() / 2.0;
        let cos = w0.cos();
        let a0 = 1.0 + alpha;
        Biquad { b0: (1.0 - cos) / 2.0 / a0, b1: (1.0 - cos) / a0, b2: (1.0 - cos) / 2.0 / a0, a1: -2.0 * cos / a0, a2: (1.0 - alpha) / a0, z1: 0.0, z2: 0.0 }
    }

    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// A feedback comb with a one-pole damp in the loop, as in Freeverb.
struct Comb {
    buf: Vec<f32>,
    idx: usize,
    feedback: f32,
    damp: f32,
    store: f32,
}

impl Comb {
    fn process(&mut self, x: f32) -> f32 {
        let out = self.buf[self.idx];
        self.store = out * (1.0 - self.damp) + self.store * self.damp;
        self.buf[self.idx] = x + self.store * self.feedback;
        self.idx = (self.idx + 1) % self.buf.len();
        out
    }
}

struct Allpass {
    buf: Vec<f32>,
    idx: usize,
}

impl Allpass {
    fn process(&mut self, x: f32) -> f32 {
        let b = self.buf[self.idx];
        let out = b - x;
        self.buf[self.idx] = x + b * 0.5;
        self.idx = (self.idx + 1) % self.buf.len();
        out
    }
}

/// Schroeder reverb: four combs in parallel into two allpasses, per channel.
struct Reverb {
    combs: Vec<Comb>,
    allpasses: Vec<Allpass>,
    mix: f32,
}

impl Reverb {
    fn new(sr: f64, size: f64, mix: f64) -> Reverb {
        let k = sr / 44100.0;
        let size = size.clamp(0.0, 1.0);
        let feedback = (0.72 + 0.26 * size) as f32;
        let mut combs = Vec::new();
        let mut allpasses = Vec::new();
        for ch in 0..CHANNELS {
            let spread = (ch * 23) as f64;
            for len in [1116.0, 1188.0, 1277.0, 1356.0] {
                let n = (((len + spread) * k * (0.6 + 0.6 * size)) as usize).max(8);
                combs.push(Comb { buf: vec![0.0; n], idx: 0, feedback, damp: 0.2, store: 0.0 });
            }
            for len in [556.0, 441.0] {
                let n = (((len + spread) * k) as usize).max(8);
                allpasses.push(Allpass { buf: vec![0.0; n], idx: 0 });
            }
        }
        Reverb { combs, allpasses, mix: mix.clamp(0.0, 1.0) as f32 }
    }

    fn process(&mut self, ch: usize, x: f32) -> f32 {
        let mut wet = 0.0;
        for c in &mut self.combs[ch * 4..ch * 4 + 4] {
            wet += c.process(x * 0.25);
        }
        for a in &mut self.allpasses[ch * 2..ch * 2 + 2] {
            wet = a.process(wet);
        }
        x * (1.0 - self.mix * 0.5) + wet * self.mix * 0.7
    }
}

/// A stereo delay line with feedback.
struct Echo {
    buf: Vec<f32>,
    write: usize,
    delay: usize,
    feedback: f32,
    mix: f32,
}

impl Echo {
    fn new(sr: f64, seconds: f64, feedback: f64, mix: f64) -> Echo {
        let frames = (sr * MAX_ECHO_SECONDS) as usize;
        let delay = ((seconds.clamp(0.001, MAX_ECHO_SECONDS) * sr) as usize).max(1).min(frames - 1);
        Echo { buf: vec![0.0; frames * CHANNELS], write: 0, delay, feedback: feedback.clamp(0.0, 0.95) as f32, mix: mix.clamp(0.0, 1.0) as f32 }
    }

    fn process(&mut self, ch: usize, x: f32) -> f32 {
        let frames = self.buf.len() / CHANNELS;
        let read = ((self.write + frames - self.delay) % frames) * CHANNELS + ch;
        let d = self.buf[read];
        self.buf[self.write * CHANNELS + ch] = x + d * self.feedback;
        if ch == CHANNELS - 1 {
            self.write = (self.write + 1) % frames;
        }
        x + d * self.mix
    }
}

/// Effects on one bus, applied after its voices are mixed.
#[derive(Default)]
struct BusFx {
    lowpass: Option<[Biquad; CHANNELS]>,
    reverb: Option<Reverb>,
    echo: Option<Echo>,
}

impl BusFx {
    fn active(&self) -> bool {
        self.lowpass.is_some() || self.reverb.is_some() || self.echo.is_some()
    }

    fn process(&mut self, buf: &mut [f32]) {
        if !self.active() {
            return;
        }
        for frame in buf.chunks_mut(CHANNELS) {
            for (ch, s) in frame.iter_mut().enumerate() {
                let mut x = *s;
                if let Some(lp) = &mut self.lowpass {
                    x = lp[ch].process(x as f64) as f32;
                }
                if let Some(e) = &mut self.echo {
                    x = e.process(ch, x);
                }
                if let Some(r) = &mut self.reverb {
                    x = r.process(ch, x);
                }
                *s = x;
            }
        }
    }
}

struct Voice {
    source: Source,
    bus: usize,
    start: f64,
    f0: f64,
    f1: f64,
    sweep: f64,
    attack: f64,
    duration: f64,
    release: f64,
    volume: f64,
    pitch: f64,
    vibrato: f64,
    vib_rate: f64,
    phase: f64,
    pos: f64,
    // Low-pass biquad; `lp` false means bypass.
    lp: bool,
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
    gain: f64,
    freq: f64,
    born: u64,
    pan_l: f64,
    pan_r: f64,
    looping: bool,
    /// Release started by CMD_STOP_BUS: (frame it began, seconds).
    fade: Option<(f64, f64)>,
    /// Stream reading: the two frames straddling the play head, the fraction between them,
    /// and how many stream frames advance per output frame (file rate over ours, times pitch).
    s_cur: (f32, f32),
    s_next: (f32, f32),
    s_frac: f64,
    s_ratio: f64,
}

pub struct Audio {
    sample_rate: f64,
    ring: Ring,
    scratch: Vec<f32>,
    out: Vec<f32>,
    voices: Vec<Option<Voice>>,
    pending: Vec<Cmd>,
    samples: Mutex<Vec<Option<Arc<Vec<f32>>>>>,
    noise: Vec<f32>,
    bus: [f64; BUS_COUNT],
    bus_target: [f64; BUS_COUNT],
    bus_rate: [f64; BUS_COUNT],
    fx: Vec<BusFx>,
    bus_buf: Vec<f32>,
    /// Streamed tracks by id, and the encoded bytes arriving for one before it opens.
    streams: Vec<Option<crate::stream::Stream>>,
    stream_bytes: Vec<Option<Vec<u8>>>,
    master_target: f64,
    master: f64,
    rendered: AtomicU64,
    peak: AtomicU64,
    active: AtomicUsize,
    serial: u64,
}

impl Audio {
    pub fn new(sample_rate: u32, max_voices: usize) -> Audio {
        let mut rng = crate::Rng::new(99);
        let noise: Vec<f32> = (0..NOISE_LEN).map(|_| (rng.next() * 2.0 - 1.0) as f32).collect();
        let mut voices = Vec::with_capacity(max_voices.max(8));
        for _ in 0..max_voices.max(8) {
            voices.push(None);
        }
        Audio {
            sample_rate: sample_rate.max(8000) as f64,
            ring: Ring::new(),
            scratch: vec![0.0; SCRATCH_WORDS],
            out: vec![0.0; OUT_FRAMES * CHANNELS],
            voices,
            pending: Vec::new(),
            samples: Mutex::new(Vec::new()),
            noise,
            bus: [0.8, 0.5, 0.5],
            bus_target: [0.8, 0.5, 0.5],
            bus_rate: [0.0; BUS_COUNT],
            fx: (0..BUS_COUNT).map(|_| BusFx::default()).collect(),
            bus_buf: vec![0.0; BUS_COUNT * OUT_FRAMES * CHANNELS],
            streams: Vec::new(),
            stream_bytes: Vec::new(),
            master_target: 1.0,
            master: 1.0,
            rendered: AtomicU64::new(0),
            peak: AtomicU64::new(0),
            active: AtomicUsize::new(0),
            serial: 0,
        }
    }

    pub fn scratch_mut(&mut self) -> &mut [f32] {
        &mut self.scratch
    }

    pub fn out(&self) -> &[f32] {
        &self.out
    }

    /// Script thread: queue a command from the first `words` of the scratch buffer.
    pub fn command(&self, words: usize) -> bool {
        let n = words.min(CMD_WORDS).min(self.scratch.len());
        self.ring.push(&self.scratch[..n])
    }

    /// Seconds of audio rendered so far, the clock commands are scheduled against.
    pub fn time(&self) -> f64 {
        self.rendered.load(Ordering::Acquire) as f64 / self.sample_rate
    }

    pub fn peak(&self) -> f32 {
        f32::from_bits(self.peak.load(Ordering::Relaxed) as u32)
    }

    pub fn active(&self) -> usize {
        self.active.load(Ordering::Relaxed)
    }

    /// Script thread: allocate sample `id` with `frames` mono frames of silence.
    pub fn sample_begin(&self, id: i32, frames: usize) -> bool {
        if id < 0 {
            return false;
        }
        let Ok(mut table) = self.samples.lock() else { return false };
        let id = id as usize;
        if table.len() <= id {
            table.resize(id + 1, None);
        }
        table[id] = Some(Arc::new(vec![0.0; frames]));
        true
    }

    /// Script thread: copy `words` floats from the scratch buffer into sample `id` at `offset`.
    pub fn sample_write(&self, id: i32, offset: usize, words: usize) -> bool {
        let Ok(mut table) = self.samples.lock() else { return false };
        let Some(Some(sample)) = table.get_mut(id as usize) else { return false };
        // Samples are only shared with voices once playing; while loading we hold the sole reference.
        let Some(data) = Arc::get_mut(sample) else { return false };
        let n = words.min(self.scratch.len());
        if offset + n > data.len() {
            return false;
        }
        data[offset..offset + n].copy_from_slice(&self.scratch[..n]);
        true
    }

    // --- Audio thread ------------------------------------------------------------------

    /// Start receiving an encoded file for stream `id`; `len` bytes follow through `stream_write`.
    pub fn stream_begin(&mut self, id: i32, len: usize) -> bool {
        if id < 0 || id > 4096 || len == 0 || len > MAX_STREAM_BYTES {
            return false;
        }
        let id = id as usize;
        if self.stream_bytes.len() <= id {
            self.stream_bytes.resize_with(id + 1, || None);
        }
        self.stream_bytes[id] = Some(Vec::with_capacity(len));
        true
    }

    /// Append encoded bytes to a stream being received.
    pub fn stream_write_bytes(&mut self, id: i32, bytes: &[u8]) -> bool {
        let Some(Some(buf)) = self.stream_bytes.get_mut(id as usize) else { return false };
        if buf.len() + bytes.len() > MAX_STREAM_BYTES {
            return false;
        }
        buf.extend_from_slice(bytes);
        true
    }

    /// Append `n` bytes read from the scratch buffer (its words viewed as bytes).
    pub fn stream_write(&mut self, id: i32, n: usize) -> bool {
        let cap = self.scratch.len() * 4;
        let n = n.min(cap);
        let bytes: Vec<u8> = unsafe { std::slice::from_raw_parts(self.scratch.as_ptr() as *const u8, n) }.to_vec();
        self.stream_write_bytes(id, &bytes)
    }

    /// Open the received bytes as a stream; returns its sample rate, 0 when no codec handles it.
    pub fn stream_open(&mut self, id: i32) -> u32 {
        let Some(slot) = self.stream_bytes.get_mut(id as usize) else { return 0 };
        let Some(bytes) = slot.take() else { return 0 };
        let Some(stream) = crate::stream::Stream::open(bytes) else { return 0 };
        let rate = stream.rate;
        let id = id as usize;
        if self.streams.len() <= id {
            self.streams.resize_with(id + 1, || None);
        }
        self.streams[id] = Some(stream);
        rate
    }

    /// Drop a stream and silence any voice reading it.
    pub fn stream_close(&mut self, id: i32) {
        if let Some(slot) = self.streams.get_mut(id as usize) {
            *slot = None;
        }
        for v in &mut self.voices {
            if matches!(v, Some(Voice { source: Source::Stream(i), .. }) if *i == id as usize) {
                *v = None;
            }
        }
    }

    /// Frames a stream holds decoded, for tests of the memory bound.
    pub fn stream_buffered(&self, id: i32) -> usize {
        self.streams.get(id as usize).and_then(|s| s.as_ref()).map(|s| s.buffered()).unwrap_or(0)
    }

    /// How many times a stream has looped.
    pub fn stream_loops(&self, id: i32) -> u32 {
        self.streams.get(id as usize).and_then(|s| s.as_ref()).map(|s| s.loops).unwrap_or(0)
    }

    fn apply(&mut self, cmd: Cmd, position: f64) -> bool {
        let w = |k: usize| -> f64 { if (k as u32) < cmd.len { cmd.words[k] as f64 } else { 0.0 } };
        match w(0) as u32 {
            CMD_VOICE => {
                let wave = w(3) as u32;
                let source = if wave == WAVE_NOISE { Source::Noise } else { Source::Osc(wave.min(3)) };
                let pan = if cmd.len > 14 { w(14) } else { 0.0 };
                self.start_voice(source, w(1), w(2) as usize, w(4), w(5), w(6), w(7), w(8), w(9), w(10), w(11), w(12), w(13), pan, false, position);
                true
            }
            CMD_SAMPLE => {
                let id = w(3) as i32;
                let Ok(table) = self.samples.try_lock() else { return false };
                let Some(Some(sample)) = table.get(id as usize).cloned() else { return true };
                drop(table);
                let volume = w(4);
                let pitch = if w(5) > 0.0 { w(5) } else { 1.0 };
                let pan = if cmd.len > 6 { w(6) } else { 0.0 };
                let looping = cmd.len > 7 && w(7) != 0.0;
                self.start_voice(Source::Sample(sample), w(1), w(2) as usize, 0.0, 0.0, 0.0, 0.0, 0.0, volume, 0.0, 0.0, 0.0, pitch, pan, looping, position);
                true
            }
            CMD_BUS => {
                let sfx = w(1).clamp(0.0, 4.0);
                let music = w(2).clamp(0.0, 4.0);
                self.bus = [sfx, music, music];
                self.bus_target = self.bus;
                self.bus_rate = [0.0; BUS_COUNT];
                true
            }
            CMD_FADE => {
                let bus = (w(1) as usize).min(BUS_COUNT - 1);
                let target = w(2).clamp(0.0, 4.0);
                let seconds = w(3).max(0.0);
                self.bus_target[bus] = target;
                self.bus_rate[bus] = if seconds > 0.0 { (target - self.bus[bus]).abs() / (seconds * self.sample_rate) } else { f64::INFINITY };
                true
            }
            CMD_STOP_BUS => {
                let bus = (w(1) as usize).min(BUS_COUNT - 1);
                let seconds = w(2).max(0.0);
                for v in self.voices.iter_mut().flatten() {
                    if v.bus == bus && v.fade.is_none() {
                        v.fade = Some((position, seconds));
                    }
                }
                true
            }
            CMD_MUTE => {
                self.master_target = if w(1) != 0.0 { 0.0 } else { 1.0 };
                true
            }
            CMD_STREAM => {
                let id = w(3) as usize;
                let Some(Some(stream)) = self.streams.get_mut(id) else { return true };
                stream.rewind();
                let ratio = stream.rate as f64 / self.sample_rate;
                // One voice per stream: a replay stops the previous one.
                for v in &mut self.voices {
                    if matches!(v, Some(Voice { source: Source::Stream(i), .. }) if *i == id) {
                        *v = None;
                    }
                }
                let volume = w(4);
                let pitch = if w(5) > 0.0 { w(5) } else { 1.0 };
                let pan = if cmd.len > 6 { w(6) } else { 0.0 };
                let looping = cmd.len > 7 && w(7) != 0.0;
                self.start_voice(Source::Stream(id), w(1), w(2) as usize, 0.0, 0.0, 0.0, 0.0, 0.0, volume, 0.0, 0.0, 0.0, 1.0, pan, looping, position);
                let born = self.serial - 1;
                for v in self.voices.iter_mut().flatten() {
                    if v.born == born {
                        v.s_ratio = ratio * pitch;
                        v.s_frac = 1.0;
                    }
                }
                true
            }
            CMD_BUS_FX => {
                let bus = (w(1) as usize).min(BUS_COUNT - 1);
                let sr = self.sample_rate;
                let lowpass = w(2);
                let reverb_mix = w(3);
                let reverb_size = if cmd.len > 4 { w(4) } else { 0.5 };
                let echo_seconds = w(5);
                let echo_feedback = if cmd.len > 6 { w(6) } else { 0.35 };
                let echo_mix = if cmd.len > 7 { w(7) } else { 0.5 };
                let fx = &mut self.fx[bus];
                fx.lowpass = if lowpass > 0.0 && lowpass < sr * 0.45 { Some([Biquad::lowpass(lowpass, sr); CHANNELS]) } else { None };
                fx.reverb = if reverb_mix > 0.0 { Some(Reverb::new(sr, reverb_size, reverb_mix)) } else { None };
                fx.echo = if echo_seconds > 0.0 && echo_mix > 0.0 { Some(Echo::new(sr, echo_seconds, echo_feedback, echo_mix)) } else { None };
                true
            }
            CMD_STOP => {
                for v in &mut self.voices {
                    *v = None;
                }
                true
            }
            _ => true,
        }
    }

    fn start_voice(
        &mut self, source: Source, at: f64, bus: usize, freq: f64, freq_end: f64, duration: f64, attack: f64, release: f64,
        volume: f64, lowpass: f64, vibrato: f64, vib_rate: f64, pitch: f64, pan: f64, looping: bool, position: f64,
    ) {
        // Constant-power pan: -1 is left, 1 is right.
        let angle = (pan.clamp(-1.0, 1.0) + 1.0) * std::f64::consts::FRAC_PI_4;
        let sr = self.sample_rate;
        let pitch = if pitch > 0.0 { pitch } else { 1.0 };
        let is_sample = matches!(source, Source::Sample(_) | Source::Stream(_));
        let f0 = freq.max(0.0) * pitch;
        let f1 = if freq_end > 0.0 { (freq_end * pitch).max(1.0) } else { f0 };
        let attack = if is_sample { 0.0 } else { attack.max(0.0005) };
        let mut v = Voice {
            source,
            bus: bus.min(BUS_COUNT - 1),
            start: (at * sr).max(position),
            f0,
            f1,
            sweep: attack + duration.max(0.0),
            attack,
            duration: duration.max(0.0),
            release: release.max(0.001),
            volume: volume.max(0.0),
            pitch,
            vibrato,
            vib_rate: if vib_rate > 0.0 { vib_rate } else { 6.0 },
            phase: 0.0,
            pos: 0.0,
            lp: false,
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: 0.0,
            z2: 0.0,
            gain: 0.0,
            freq: f0,
            born: self.serial,
            pan_l: angle.cos(),
            pan_r: angle.sin(),
            looping,
            fade: None,
            s_cur: (0.0, 0.0),
            s_next: (0.0, 0.0),
            s_frac: 1.0,
            s_ratio: 1.0,
        };
        self.serial += 1;
        if lowpass > 0.0 && lowpass < sr * 0.45 {
            // RBJ low-pass, Q = 1.
            let w0 = 2.0 * std::f64::consts::PI * lowpass / sr;
            let alpha = w0.sin() / 2.0;
            let cos = w0.cos();
            let a0 = 1.0 + alpha;
            v.b0 = (1.0 - cos) / 2.0 / a0;
            v.b1 = (1.0 - cos) / a0;
            v.b2 = v.b0;
            v.a1 = -2.0 * cos / a0;
            v.a2 = (1.0 - alpha) / a0;
            v.lp = true;
        }
        let slot = match self.voices.iter().position(|s| s.is_none()) {
            Some(i) => i,
            None => {
                // Steal the oldest voice.
                let mut oldest = 0;
                let mut age = u64::MAX;
                for (i, s) in self.voices.iter().enumerate() {
                    if let Some(v) = s {
                        if v.born < age {
                            age = v.born;
                            oldest = i;
                        }
                    }
                }
                oldest
            }
        };
        self.voices[slot] = Some(v);
    }

    /// Render interleaved stereo for the block starting at absolute frame `position`; `out`
    /// holds two floats per frame.
    pub fn render_into(&mut self, position: f64, out: &mut [f32]) {
        let mut done = 0usize;
        for chunk in out.chunks_mut(OUT_FRAMES * CHANNELS) {
            self.render_block(position + done as f64, chunk);
            done += chunk.len() / CHANNELS;
        }
    }

    /// One block of at most OUT_FRAMES frames: voices into their bus, bus effects, then the sum.
    fn render_block(&mut self, position: f64, out: &mut [f32]) {
        let sr = self.sample_rate;
        let frames = out.len() / CHANNELS;
        let mut bus_buf = std::mem::take(&mut self.bus_buf);
        for s in bus_buf[..BUS_COUNT * frames * CHANNELS].iter_mut() {
            *s = 0.0;
        }

        // Drain commands; the ones that need a sample table lock wait for the next block.
        let mut deferred = Vec::new();
        for cmd in self.pending.drain(..) {
            deferred.push(cmd);
        }
        while let Some(cmd) = self.ring.pop() {
            deferred.push(cmd);
        }
        for cmd in deferred {
            if !self.apply(cmd, position) {
                self.pending.push(cmd);
            }
        }
        for s in out.iter_mut() {
            *s = 0.0;
        }
        // Bus levels ramp toward their targets; use the level at the start of the block.
        for b in 0..BUS_COUNT {
            let step = self.bus_rate[b] * frames as f64;
            let diff = self.bus_target[b] - self.bus[b];
            if diff.abs() <= step || !step.is_finite() {
                self.bus[b] = self.bus_target[b];
            } else {
                self.bus[b] += diff.signum() * step;
            }
        }
        // Streams decode ahead of what this block will read from them. Taken out of self so the
        // voice loop can borrow both; commands above have already seen them.
        let mut streams = std::mem::take(&mut self.streams);
        for v in self.voices.iter().flatten() {
            if let Source::Stream(id) = v.source {
                if let Some(Some(st)) = streams.get_mut(id) {
                    st.fill((frames as f64 * v.s_ratio) as usize + crate::stream::AHEAD_FRAMES, v.looping);
                }
            }
        }
        let bus = self.bus;
        let master_target = self.master_target;
        let mut master = self.master;
        let mut peak: f32 = 0.0;
        let noise = &self.noise;
        let mut active = 0;
        for slot in &mut self.voices {
            let Some(v) = slot else { continue };
            let mut alive = true;
            let mut i = 0;
            let bus_gain = bus[v.bus];
            let base = v.bus * frames * CHANNELS;
            let (pl, pr) = (v.pan_l, v.pan_r);
            while i < frames {
                let t = (position + i as f64 - v.start) / sr;
                if t < 0.0 {
                    // Not started yet; skip to the start within this block.
                    let skip = ((-t) * sr).ceil() as usize;
                    i += skip.max(1);
                    continue;
                }
                // Control-rate envelope and frequency, plus the bus release when stopping.
                let (mut gain, freq) = envelope(v, t);
                if gain < 0.0 {
                    alive = false;
                    break;
                }
                if let Some((from, seconds)) = v.fade {
                    let u = if seconds > 0.0 { ((position + i as f64 - from) / (seconds * sr)).clamp(0.0, 1.0) } else { 1.0 };
                    if u >= 1.0 {
                        alive = false;
                        break;
                    }
                    gain *= 1.0 - u;
                }
                v.gain = gain;
                v.freq = freq;
                let end = (i + CONTROL_RATE).min(frames);
                let source = v.source.clone();
                match &source {
                    Source::Osc(wave) => {
                        let inc = freq / sr;
                        for k in i..end {
                            let s = oscillator(*wave, v.phase, inc);
                            v.phase += inc;
                            if v.phase >= 1.0 {
                                v.phase -= 1.0;
                            }
                            let s = if v.lp { biquad(v, s) } else { s };
                            let m = s * gain * bus_gain;
                            bus_buf[base + k * 2] += (m * pl) as f32;
                            bus_buf[base + k * 2 + 1] += (m * pr) as f32;
                        }
                    }
                    Source::Noise => {
                        let rate = (freq / 1000.0).max(0.05);
                        for k in i..end {
                            let idx = v.pos as usize % NOISE_LEN;
                            let frac = v.pos - v.pos.floor();
                            let a = noise[idx] as f64;
                            let b = noise[(idx + 1) % NOISE_LEN] as f64;
                            let s = a + (b - a) * frac;
                            v.pos += rate;
                            if v.pos >= NOISE_LEN as f64 {
                                v.pos -= NOISE_LEN as f64;
                            }
                            let s = if v.lp { biquad(v, s) } else { s };
                            let m = s * gain * bus_gain;
                            bus_buf[base + k * 2] += (m * pl) as f32;
                            bus_buf[base + k * 2 + 1] += (m * pr) as f32;
                        }
                    }
                    Source::Stream(id) => {
                        let Some(Some(st)) = streams.get_mut(*id) else {
                            alive = false;
                            break;
                        };
                        let g = (gain * bus_gain) as f32;
                        for k in i..end {
                            while v.s_frac >= 1.0 {
                                v.s_cur = v.s_next;
                                match st.pop() {
                                    Some(f) => v.s_next = f,
                                    None => {
                                        if st.finished(v.looping) {
                                            alive = false;
                                        }
                                        v.s_next = (0.0, 0.0);
                                    }
                                }
                                v.s_frac -= 1.0;
                            }
                            if !alive {
                                break;
                            }
                            let t = v.s_frac as f32;
                            let l = v.s_cur.0 + (v.s_next.0 - v.s_cur.0) * t;
                            let r = v.s_cur.1 + (v.s_next.1 - v.s_cur.1) * t;
                            bus_buf[base + k * 2] += l * g * pl as f32;
                            bus_buf[base + k * 2 + 1] += r * g * pr as f32;
                            v.s_frac += v.s_ratio;
                        }
                        if !alive {
                            break;
                        }
                    }
                    Source::Sample(data) => {
                        let len = data.len();
                        for k in i..end {
                            let mut idx = v.pos as usize;
                            if idx + 1 >= len {
                                if v.looping && len > 1 {
                                    v.pos -= (len - 1) as f64;
                                    idx = v.pos as usize;
                                } else {
                                    alive = false;
                                    break;
                                }
                            }
                            let frac = v.pos - v.pos.floor();
                            let s = data[idx] as f64 + (data[idx + 1] as f64 - data[idx] as f64) * frac;
                            v.pos += v.pitch;
                            let m = s * v.volume * gain / v.volume.max(MIN_GAIN) * bus_gain;
                            bus_buf[base + k * 2] += (m * pl) as f32;
                            bus_buf[base + k * 2 + 1] += (m * pr) as f32;
                        }
                        if !alive {
                            break;
                        }
                    }
                }
                i = end;
            }
            if alive {
                active += 1;
            } else {
                *slot = None;
            }
        }
        self.streams = streams;
        // Bus effects, then every bus into the output.
        for b in 0..BUS_COUNT {
            let seg = &mut bus_buf[b * frames * CHANNELS..(b + 1) * frames * CHANNELS];
            self.fx[b].process(seg);
            for (o, s) in out.iter_mut().zip(seg.iter()) {
                *o += *s;
            }
        }
        self.bus_buf = bus_buf;
        // Master with a short ramp for mute and unmute, then a hard limit.
        let k = 1.0 - (-1.0 / (0.02 * sr)).exp();
        for f in 0..frames {
            master += (master_target - master) * k;
            for c in 0..CHANNELS {
                let s = &mut out[f * CHANNELS + c];
                let v = (*s as f64 * master).clamp(-1.0, 1.0) as f32;
                *s = v;
                let a = v.abs();
                if a > peak {
                    peak = a;
                }
            }
        }
        self.master = master;
        self.peak.store(peak.to_bits() as u64, Ordering::Relaxed);
        self.active.store(active, Ordering::Relaxed);
        self.rendered.store((position + frames as f64) as u64, Ordering::Release);
    }

    pub fn render(&mut self, position: f64, frames: usize) {
        let n = frames.min(OUT_FRAMES);
        let mut out = std::mem::take(&mut self.out);
        self.render_into(position, &mut out[..n * CHANNELS]);
        self.out = out;
    }
}

/// Gain and frequency of a voice at `t` seconds after its start; gain -1 means finished.
fn envelope(v: &Voice, t: f64) -> (f64, f64) {
    if matches!(v.source, Source::Sample(_) | Source::Stream(_)) {
        return (v.volume.max(MIN_GAIN), 0.0);
    }
    let vol = v.volume.max(MIN_GAIN);
    let gain = if t < v.attack {
        MIN_GAIN * (vol / MIN_GAIN).powf(t / v.attack)
    } else if t < v.attack + v.duration {
        vol
    } else if t < v.attack + v.duration + v.release {
        vol * (MIN_GAIN / vol).powf((t - v.attack - v.duration) / v.release)
    } else {
        return (-1.0, 0.0);
    };
    let mut freq = if v.f1 != v.f0 && v.sweep > 0.0 && v.f0 > 0.0 {
        let u = (t / v.sweep).min(1.0);
        v.f0 * (v.f1 / v.f0).powf(u)
    } else {
        v.f0
    };
    if v.vibrato != 0.0 {
        freq += v.vibrato * (2.0 * std::f64::consts::PI * v.vib_rate * t).sin();
    }
    (if v.volume <= 0.0 { 0.0 } else { gain }, freq.max(0.0))
}

fn poly_blep(t: f64, dt: f64) -> f64 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

fn oscillator(wave: u32, phase: f64, inc: f64) -> f64 {
    match wave {
        WAVE_SINE => (2.0 * std::f64::consts::PI * phase).sin(),
        WAVE_SQUARE => {
            let mut s = if phase < 0.5 { 1.0 } else { -1.0 };
            s += poly_blep(phase, inc);
            s -= poly_blep((phase + 0.5) % 1.0, inc);
            s
        }
        WAVE_SAW => 2.0 * phase - 1.0 - poly_blep(phase, inc),
        _ => {
            let x = 2.0 * phase - 1.0;
            2.0 * x.abs() - 1.0
        }
    }
}

fn biquad(v: &mut Voice, x: f64) -> f64 {
    // Transposed direct form II.
    let y = v.b0 * x + v.z1;
    v.z1 = v.b1 * x - v.a1 * y + v.z2;
    v.z2 = v.b2 * x - v.a2 * y;
    y
}

// --- C ABI ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn blackiron_audio_new(sample_rate: u32, max_voices: u32) -> *mut Audio {
    Box::into_raw(Box::new(Audio::new(sample_rate, max_voices as usize)))
}

/// # Safety
/// `a` must come from `blackiron_audio_new` and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn blackiron_audio_free(a: *mut Audio) {
    if !a.is_null() {
        drop(Box::from_raw(a));
    }
}

macro_rules! with_audio {
    ($a:expr, $body:expr, $default:expr) => {{
        if $a.is_null() {
            $default
        } else {
            let a: &mut Audio = unsafe { &mut *$a };
            #[allow(clippy::redundant_closure_call)]
            ($body)(a)
        }
    }};
}

#[no_mangle]
pub extern "C" fn blackiron_audio_scratch(a: *mut Audio) -> *mut f32 {
    with_audio!(a, |a: &mut Audio| a.scratch.as_mut_ptr(), std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn blackiron_audio_scratch_words(a: *mut Audio) -> u32 {
    with_audio!(a, |a: &mut Audio| a.scratch.len() as u32, 0)
}

#[no_mangle]
pub extern "C" fn blackiron_audio_command(a: *mut Audio, words: u32) -> i32 {
    with_audio!(a, |a: &mut Audio| a.command(words as usize) as i32, 0)
}

#[no_mangle]
pub extern "C" fn blackiron_audio_sample_begin(a: *mut Audio, id: i32, frames: u32) -> i32 {
    with_audio!(a, |a: &mut Audio| a.sample_begin(id, frames as usize) as i32, 0)
}

#[no_mangle]
pub extern "C" fn blackiron_audio_sample_write(a: *mut Audio, id: i32, offset: u32, words: u32) -> i32 {
    with_audio!(a, |a: &mut Audio| a.sample_write(id, offset as usize, words as usize) as i32, 0)
}

#[no_mangle]
pub extern "C" fn blackiron_audio_stream_begin(a: *mut Audio, id: i32, len: u32) -> i32 {
    with_audio!(a, |a: &mut Audio| a.stream_begin(id, len as usize) as i32, 0)
}

/// Append `bytes` bytes from the scratch buffer (its words viewed as bytes) to a stream.
#[no_mangle]
pub extern "C" fn blackiron_audio_stream_write(a: *mut Audio, id: i32, bytes: u32) -> i32 {
    with_audio!(a, |a: &mut Audio| a.stream_write(id, bytes as usize) as i32, 0)
}

/// Open the received bytes; returns the sample rate, or 0 when no codec handles them.
#[no_mangle]
pub extern "C" fn blackiron_audio_stream_open(a: *mut Audio, id: i32) -> u32 {
    with_audio!(a, |a: &mut Audio| a.stream_open(id), 0)
}

#[no_mangle]
pub extern "C" fn blackiron_audio_stream_close(a: *mut Audio, id: i32) {
    with_audio!(a, |a: &mut Audio| a.stream_close(id), ())
}

#[no_mangle]
pub extern "C" fn blackiron_audio_time(a: *mut Audio) -> f64 {
    with_audio!(a, |a: &mut Audio| a.time(), 0.0)
}

#[no_mangle]
pub extern "C" fn blackiron_audio_peak(a: *mut Audio) -> f32 {
    with_audio!(a, |a: &mut Audio| a.peak(), 0.0)
}

#[no_mangle]
pub extern "C" fn blackiron_audio_active(a: *mut Audio) -> u32 {
    with_audio!(a, |a: &mut Audio| a.active() as u32, 0)
}

#[no_mangle]
pub extern "C" fn blackiron_audio_out(a: *mut Audio) -> *const f32 {
    with_audio!(a, |a: &mut Audio| a.out.as_ptr(), std::ptr::null())
}

#[no_mangle]
pub extern "C" fn blackiron_audio_render(a: *mut Audio, position: f64, frames: u32) {
    with_audio!(a, |a: &mut Audio| a.render(position, frames as usize), ())
}

/// # Safety
/// `out` must point to at least `frames * CHANNELS` floats (interleaved stereo).
/// The caller must serialize all calls using the same Audio handle, including scratch writes.
#[no_mangle]
pub unsafe extern "C" fn blackiron_audio_render_into(a: *mut Audio, position: f64, out: *mut f32, frames: u32) {
    if a.is_null() || out.is_null() {
        return;
    }
    let a = &mut *a;
    let slice = std::slice::from_raw_parts_mut(out, frames as usize * CHANNELS);
    a.render_into(position, slice);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_render_into_count_is_stereo_frames() {
        let mut audio = Audio::new(48000, 8);
        let mut output = vec![f32::NAN; 512 * CHANNELS + 2];
        unsafe { blackiron_audio_render_into(&mut audio, 0.0, output.as_mut_ptr(), 512); }
        assert!(output[..512 * CHANNELS].iter().all(|x| *x == 0.0));
        assert!(output[512 * CHANNELS..].iter().all(|x| x.is_nan()));
        assert!((audio.time() - 512.0 / 48000.0).abs() < 1e-9);
    }

    fn voice_cmd(a: &mut Audio, wave: u32, freq: f64, freq_end: f64, lowpass: f64) {
        let s = a.scratch_mut();
        let words = [CMD_VOICE as f32, 0.0, 0.0, wave as f32, freq as f32, freq_end as f32, 0.1, 0.005, 0.05, 0.5, lowpass as f32, 0.0, 0.0, 1.0];
        s[..words.len()].copy_from_slice(&words);
        assert!(a.command(words.len()));
    }

    #[test]
    fn a_voice_sounds_then_ends() {
        let mut a = Audio::new(48000, 8);
        voice_cmd(&mut a, WAVE_SQUARE, 440.0, 0.0, 0.0);
        let mut peak = 0.0f32;
        for block in 0..8 {
            a.render(block as f64 * 512.0, 512);
            peak = peak.max(a.peak());
        }
        // Centre pan splits the 0.5 volume square wave at cos(pi/4) per channel.
        assert!(peak > 0.2, "peak {peak}");
        assert_eq!(a.active(), 1);
        // 0.005 + 0.1 + 0.05 seconds is under 8000 frames; long after that the voice is gone.
        a.render(48000.0, 512);
        assert_eq!(a.active(), 0);
        assert!(a.peak() < 1e-3);
        assert!((a.time() - (48000.0 + 512.0) / 48000.0).abs() < 1e-9);
    }

    #[test]
    fn sweeps_noise_filters_and_samples_render() {
        let mut a = Audio::new(44100, 8);
        voice_cmd(&mut a, WAVE_NOISE, 600.0, 120.0, 900.0);
        voice_cmd(&mut a, WAVE_SINE, 880.0, 1480.0, 0.0);
        assert!(a.sample_begin(3, 1000));
        {
            let s = a.scratch_mut();
            for i in 0..1000 {
                s[i] = if i % 2 == 0 { 0.5 } else { -0.5 };
            }
        }
        assert!(a.sample_write(3, 0, 1000));
        let s = a.scratch_mut();
        let words = [CMD_SAMPLE as f32, 0.0, 0.0, 3.0, 1.0, 1.0];
        s[..words.len()].copy_from_slice(&words);
        assert!(a.command(words.len()));
        a.render(0.0, 256);
        assert_eq!(a.active(), 3);
        assert!(a.peak() > 0.1);
        // Mute ramps the master down to silence.
        let s = a.scratch_mut();
        s[0] = CMD_MUTE as f32;
        s[1] = 1.0;
        assert!(a.command(2));
        for b in 1..40 {
            a.render(b as f64 * 256.0, 256);
        }
        assert!(a.peak() < 1e-3);
    }

    #[test]
    fn panning_fades_and_looping_samples() {
        let mut a = Audio::new(48000, 8);
        // A hard-left square wave.
        let s = a.scratch_mut();
        let words = [CMD_VOICE as f32, 0.0, 0.0, WAVE_SQUARE as f32, 440.0, 0.0, 0.5, 0.005, 0.05, 0.5, 0.0, 0.0, 0.0, 1.0, -1.0];
        s[..words.len()].copy_from_slice(&words);
        assert!(a.command(words.len()));
        a.render(0.0, 512);
        let out = a.out();
        let left: f32 = out.iter().step_by(2).map(|v| v.abs()).sum();
        let right: f32 = out.iter().skip(1).step_by(2).map(|v| v.abs()).sum();
        assert!(left > 1.0 && right < 1e-3, "left {left} right {right}");
        // A looping one-frame-short sample keeps playing past its length.
        assert!(a.sample_begin(1, 100));
        {
            let s = a.scratch_mut();
            for i in 0..100 {
                s[i] = 0.25;
            }
        }
        assert!(a.sample_write(1, 0, 100));
        let s = a.scratch_mut();
        let words = [CMD_SAMPLE as f32, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 1.0];
        s[..words.len()].copy_from_slice(&words);
        assert!(a.command(words.len()));
        // The square wave is 0.555 s long; the looping sample outlives it.
        for b in 1..80 {
            a.render(b as f64 * 512.0, 512);
        }
        assert_eq!(a.active(), 1);
        // Stopping the music bus with a fade ends the voice after the fade.
        let s = a.scratch_mut();
        s[0] = CMD_STOP_BUS as f32;
        s[1] = 1.0;
        s[2] = 0.05;
        assert!(a.command(3));
        for b in 80..100 {
            a.render(b as f64 * 512.0, 512);
        }
        assert_eq!(a.active(), 0);
        // A bus fade reaches its target.
        let s = a.scratch_mut();
        s[0] = CMD_FADE as f32;
        s[1] = 2.0;
        s[2] = 0.0;
        s[3] = 0.01;
        assert!(a.command(4));
        a.render(100.0 * 512.0, 512);
        a.render(101.0 * 512.0, 512);
        assert!(a.bus[2] < 1e-6);
    }

    #[test]
    fn bus_effects_leave_a_tail_after_the_voice() {
        let mut a = Audio::new(48000, 8);
        {
            let s = a.scratch_mut();
            s[0] = CMD_BUS_FX as f32;
            s[1] = 0.0;
            s[2] = 0.0;
            s[3] = 0.0;
            s[4] = 0.5;
            s[5] = 0.1;
            s[6] = 0.5;
            s[7] = 0.8;
        }
        assert!(a.command(8));
        voice_cmd(&mut a, WAVE_SINE, 440.0, 0.0, 0.0);
        // The voice lasts 0.1 s plus release; render 0.05 s blocks and look for energy well after it ends.
        let block = 2400;
        let mut energy = Vec::new();
        for i in 0..12 {
            a.render(i as f64 * block as f64, block);
            let e: f32 = a.out()[..block * 2].iter().map(|v| v * v).sum();
            energy.push(e);
        }
        assert!(energy[0] > 0.0);
        // Between 0.25 s and 0.35 s only the echo remains, and it is audible.
        assert!(energy[6] > 1e-4, "echo tail missing: {:?}", energy);
        // A reverb on the music bus also rings after the source.
        {
            let s = a.scratch_mut();
            s[0] = CMD_BUS_FX as f32;
            s[1] = 1.0;
            s[2] = 0.0;
            s[3] = 0.6;
            s[4] = 0.8;
            s[5] = 0.0;
        }
        assert!(a.command(8));
        let mut b = Audio::new(48000, 8);
        {
            let s = b.scratch_mut();
            s[0] = CMD_BUS_FX as f32;
            s[1] = 0.0;
            s[2] = 0.0;
            s[3] = 0.6;
            s[4] = 0.8;
            s[5] = 0.0;
        }
        assert!(b.command(8));
        voice_cmd(&mut b, WAVE_SQUARE, 220.0, 0.0, 0.0);
        let mut tail = 0.0f32;
        for i in 0..12 {
            b.render(i as f64 * block as f64, block);
            if i == 8 {
                tail = b.out()[..block * 2].iter().map(|v| v.abs()).fold(0.0, f32::max);
            }
        }
        assert!(tail > 1e-4, "reverb tail missing: {tail}");
        // A low-pass on the bus keeps the output finite and quieter at the top end.
        let mut c = Audio::new(48000, 8);
        {
            let s = c.scratch_mut();
            s[0] = CMD_BUS_FX as f32;
            s[1] = 0.0;
            s[2] = 400.0;
        }
        assert!(c.command(8));
        voice_cmd(&mut c, WAVE_SQUARE, 3000.0, 0.0, 0.0);
        c.render(0.0, block);
        let peak = c.out()[..block * 2].iter().map(|v| v.abs()).fold(0.0, f32::max);
        assert!(peak.is_finite() && peak < 0.3, "lowpass peak {peak}");
    }

    /// A little stereo WAV: `seconds` of a 440 Hz tone at 22050 Hz, 16-bit.
    fn wav(seconds: f64) -> Vec<u8> {
        let rate = 22050u32;
        let frames = (rate as f64 * seconds) as usize;
        let data_len = (frames * 4) as u32;
        let mut out = Vec::with_capacity(44 + data_len as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * 4).to_le_bytes());
        out.extend_from_slice(&4u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..frames {
            let s = ((i as f64 / rate as f64 * 440.0 * std::f64::consts::TAU).sin() * 0.5 * 32767.0) as i16;
            out.extend_from_slice(&s.to_le_bytes());
            out.extend_from_slice(&s.to_le_bytes());
        }
        out
    }

    #[cfg(feature = "codecs")]
    #[test]
    fn a_stream_plays_from_a_small_buffer_and_loops_without_a_gap() {
        let mut a = Audio::new(48000, 8);
        let bytes = wav(0.5);
        assert!(a.stream_begin(0, bytes.len()));
        assert!(a.stream_write_bytes(0, &bytes));
        assert_eq!(a.stream_open(0), 22050);
        {
            let s = a.scratch_mut();
            let words = [CMD_STREAM as f32, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0];
            s[..words.len()].copy_from_slice(&words);
        }
        assert!(a.command(8));
        // Three seconds of playback: the half-second file loops six times.
        let block = 2400;
        let mut quiet_blocks = 0;
        let mut trace = Vec::new();
        for i in 0..60 {
            a.render(i as f64 * block as f64, block);
            let e: f32 = a.out()[..block * 2].iter().map(|v| v.abs()).fold(0.0, f32::max);
            trace.push((i, e, a.stream_buffered(0), a.stream_loops(0), a.active()));
            if e < 0.01 {
                quiet_blocks += 1;
            }
            assert!(a.stream_buffered(0) < crate::stream::AHEAD_FRAMES + 8192, "decoded ahead too far: {}", a.stream_buffered(0));
        }
        assert_eq!(quiet_blocks, 0, "silence at a loop seam: {trace:?}");
        assert!(a.stream_loops(0) >= 5, "looped {} times", a.stream_loops(0));
        assert_eq!(a.active(), 1);
        // Closing the stream ends its voice; an unopened id plays nothing.
        a.stream_close(0);
        a.render(60.0 * block as f64, block);
        assert_eq!(a.active(), 0);
        // A non-looping stream ends on its own.
        let bytes = wav(0.2);
        assert!(a.stream_begin(1, bytes.len()));
        assert!(a.stream_write_bytes(1, &bytes));
        assert!(a.stream_open(1) > 0);
        {
            let s = a.scratch_mut();
            let words = [CMD_STREAM as f32, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0];
            s[..words.len()].copy_from_slice(&words);
        }
        assert!(a.command(8));
        for i in 0..20 {
            a.render((100 + i) as f64 * block as f64, block);
        }
        assert_eq!(a.active(), 0);
        assert!(a.stream_open(7) == 0);
    }

    #[test]
    fn voices_wait_for_their_start_time() {
        let mut a = Audio::new(48000, 4);
        let s = a.scratch_mut();
        let words = [CMD_VOICE as f32, 1.0, 1.0, WAVE_TRIANGLE as f32, 220.0, 0.0, 0.2, 0.01, 0.1, 0.4, 0.0, 3.0, 5.0, 1.0];
        s[..words.len()].copy_from_slice(&words);
        assert!(a.command(words.len()));
        a.render(0.0, 512);
        assert!(a.peak() < 1e-6);
        a.render(48000.0, 512);
        assert!(a.peak() > 0.05);
    }
}
