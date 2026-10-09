//! Audio output: a cpal stream on the platform's default device pulling mono PCM from the
//! kernel synthesiser, interleaved to however many channels the device wants.

use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use blackiron_kernel::audio::Audio;

pub struct AudioOut {
    _stream: cpal::Stream,
    pub audio: Arc<Mutex<Audio>>,
    pub sample_rate: u32,
}

pub fn start() -> Option<AudioOut> {
    let host = cpal::default_host();
    let device = host.default_output_device()?;
    let supported = device.default_output_config().ok()?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let audio = Arc::new(Mutex::new(Audio::new(sample_rate, 64)));
    let config: cpal::StreamConfig = supported.config();
    let shared = audio.clone();
    let err = |e| log::warn!("audio stream: {e}");
    // The kernel renders interleaved stereo; spread it over the device's channels.
    let mut stereo = vec![0.0f32; 8192 * 2];
    let mut position = 0.0f64;
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => device
            .build_output_stream(
                &config,
                move |out: &mut [f32], _| {
                    let frames = out.len() / channels.max(1);
                    if stereo.len() < frames * 2 {
                        stereo.resize(frames * 2, 0.0);
                    }
                    if let Ok(mut a) = shared.lock() {
                        a.render_into(position, &mut stereo[..frames * 2]);
                    }
                    position += frames as f64;
                    for i in 0..frames {
                        let (l, r) = (stereo[i * 2], stereo[i * 2 + 1]);
                        for c in 0..channels {
                            out[i * channels + c] = match (channels, c) {
                                (1, _) => (l + r) * 0.5,
                                (_, 0) => l,
                                (_, 1) => r,
                                _ => 0.0,
                            };
                        }
                    }
                },
                err,
                None,
            )
            .ok()?,
        cpal::SampleFormat::I16 => device
            .build_output_stream(
                &config,
                move |out: &mut [i16], _| {
                    let frames = out.len() / channels.max(1);
                    if stereo.len() < frames * 2 {
                        stereo.resize(frames * 2, 0.0);
                    }
                    if let Ok(mut a) = shared.lock() {
                        a.render_into(position, &mut stereo[..frames * 2]);
                    }
                    position += frames as f64;
                    for i in 0..frames {
                        let (l, r) = (stereo[i * 2], stereo[i * 2 + 1]);
                        for c in 0..channels {
                            let v = match (channels, c) {
                                (1, _) => (l + r) * 0.5,
                                (_, 0) => l,
                                (_, 1) => r,
                                _ => 0.0,
                            };
                            out[i * channels + c] = (v.clamp(-1.0, 1.0) * 32767.0) as i16;
                        }
                    }
                },
                err,
                None,
            )
            .ok()?,
        other => {
            log::warn!("audio: unsupported sample format {other:?}");
            return None;
        }
    };
    stream.play().ok()?;
    log::info!("audio: {sample_rate} Hz, {channels} channels");
    Some(AudioOut { _stream: stream, audio, sample_rate })
}

/// Decode an audio file (WAV, OGG Vorbis, MP3, FLAC, AAC) to mono at `rate` and load it into
/// the kernel as sample `id`.
pub fn load_sample(audio: &Mutex<Audio>, rate: u32, id: i32, bytes: &[u8]) -> bool {
    let Some((mono, file_rate)) = decode(bytes) else { return false };
    let ratio = file_rate as f64 / rate as f64;
    let out_frames = ((mono.len() as f64) / ratio) as usize;
    let mut out = Vec::with_capacity(out_frames);
    for i in 0..out_frames {
        let pos = i as f64 * ratio;
        let k = pos as usize;
        let frac = (pos - k as f64) as f32;
        let a = mono.get(k).copied().unwrap_or(0.0);
        let b = mono.get(k + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    let Ok(mut a) = audio.lock() else { return false };
    if !a.sample_begin(id, out.len()) {
        return false;
    }
    let cap = a.scratch_mut().len();
    let mut offset = 0;
    while offset < out.len() {
        let n = cap.min(out.len() - offset);
        a.scratch_mut()[..n].copy_from_slice(&out[offset..offset + n]);
        a.sample_write(id, offset, n);
        offset += n;
    }
    true
}

/// Mono samples and their rate, through symphonia.
fn decode(bytes: &[u8]) -> Option<(Vec<f32>, u32)> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    let source = MediaSourceStream::new(Box::new(std::io::Cursor::new(bytes.to_vec())), Default::default());
    let probed = symphonia::default::get_probe().format(&Hint::new(), source, &FormatOptions::default(), &MetadataOptions::default()).ok()?;
    let mut format = probed.format;
    let track = format.default_track()?;
    let track_id = track.id;
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(1).max(1);
    let rate = track.codec_params.sample_rate.unwrap_or(44100);
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default()).ok()?;
    let mut mono: Vec<f32> = Vec::new();
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(_) => break,
        };
        if buf.is_none() {
            buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec()));
        }
        let b = buf.as_mut().unwrap();
        b.copy_interleaved_ref(decoded);
        for frame in b.samples().chunks(channels) {
            mono.push(frame.iter().sum::<f32>() / channels as f32);
        }
    }
    if mono.is_empty() {
        return None;
    }
    Some((mono, rate))
}
