//! Streaming music. The encoded file stays in memory (a few megabytes for a track) and
//! symphonia decodes it a packet at a time on the audio thread into a short queue, so a
//! track costs its compressed size plus a few thousand frames of PCM, not its decoded length.
//! Loops crossfade: the last frames of a pass are held back and blended into the first frames
//! of the next, so the seam has no click and no gap.

use std::collections::VecDeque;

/// Frames blended across a loop seam (about ten milliseconds at 48 kHz).
pub const XFADE_FRAMES: usize = 512;
/// Frames decoded ahead of what a block needs.
pub const AHEAD_FRAMES: usize = 4096;

#[cfg(feature = "codecs")]
mod inner {
    use super::{VecDeque, AHEAD_FRAMES, XFADE_FRAMES};
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{Decoder, DecoderOptions};
    use symphonia::core::errors::Error;
    use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    use symphonia::core::units::Time;

    pub struct Stream {
        format: Box<dyn FormatReader>,
        decoder: Box<dyn Decoder>,
        track_id: u32,
        pub rate: u32,
        channels: usize,
        buf: Option<SampleBuffer<f32>>,
        /// Decoded stereo frames ready to play.
        queue: VecDeque<(f32, f32)>,
        /// The newest frames, held back so the end of a pass can blend into the next.
        recent: VecDeque<(f32, f32)>,
        tail: Vec<(f32, f32)>,
        xfade_left: usize,
        eof: bool,
        /// How many times the stream restarted; the test reads it.
        pub loops: u32,
    }

    impl Stream {
        /// Probe and prepare a decoder; None when no codec handles the bytes.
        pub fn open(bytes: Vec<u8>) -> Option<Stream> {
            let source = MediaSourceStream::new(Box::new(std::io::Cursor::new(bytes)), Default::default());
            let probed = symphonia::default::get_probe().format(&Hint::new(), source, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default()).ok()?;
            let format = probed.format;
            let track = format.default_track()?;
            let track_id = track.id;
            let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(1).max(1);
            let rate = track.codec_params.sample_rate.unwrap_or(44100);
            let decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default()).ok()?;
            Some(Stream { format, decoder, track_id, rate, channels, buf: None, queue: VecDeque::new(), recent: VecDeque::new(), tail: Vec::new(), xfade_left: 0, eof: false, loops: 0 })
        }

        /// Decode until `n` frames wait in the queue or the track ends; a looping stream restarts.
        pub fn fill(&mut self, n: usize, looping: bool) {
            let n = n.max(AHEAD_FRAMES);
            while self.queue.len() < n {
                if self.eof {
                    if !looping || !self.restart() {
                        // Nothing more will come: let the held-back frames out.
                        self.flush_recent();
                        return;
                    }
                }
                if !self.decode_packet() {
                    self.eof = true;
                }
            }
        }

        fn decode_packet(&mut self) -> bool {
            loop {
                let packet = match self.format.next_packet() {
                    Ok(p) => p,
                    Err(_) => return false,
                };
                if packet.track_id() != self.track_id {
                    continue;
                }
                let decoded = match self.decoder.decode(&packet) {
                    Ok(d) => d,
                    Err(Error::DecodeError(_)) => continue,
                    Err(_) => return false,
                };
                if self.buf.is_none() {
                    self.buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec()));
                }
                let ch = self.channels;
                let frames: Vec<(f32, f32)> = {
                    let b = self.buf.as_mut().unwrap();
                    b.copy_interleaved_ref(decoded);
                    b.samples().chunks(ch).map(|f| if ch == 1 { (f[0], f[0]) } else { (f[0], f[1]) }).collect()
                };
                for (l, r) in frames {
                    self.push(l, r);
                }
                return true;
            }
        }

        fn push(&mut self, mut l: f32, mut r: f32) {
            if self.xfade_left > 0 {
                let i = XFADE_FRAMES - self.xfade_left;
                let t = i as f32 / XFADE_FRAMES as f32;
                if let Some(&(tl, tr)) = self.tail.get(i) {
                    l = l * t + tl * (1.0 - t);
                    r = r * t + tr * (1.0 - t);
                }
                self.xfade_left -= 1;
            }
            self.recent.push_back((l, r));
            if self.recent.len() > XFADE_FRAMES {
                if let Some(f) = self.recent.pop_front() {
                    self.queue.push_back(f);
                }
            }
        }

        fn flush_recent(&mut self) {
            while let Some(f) = self.recent.pop_front() {
                self.queue.push_back(f);
            }
        }

        /// Back to the start, keeping the held-back tail to blend into the new head.
        fn restart(&mut self) -> bool {
            if self.format.seek(SeekMode::Accurate, SeekTo::Time { time: Time::from(0u64), track_id: Some(self.track_id) }).is_err() {
                return false;
            }
            self.decoder.reset();
            self.eof = false;
            self.tail = self.recent.drain(..).collect();
            self.xfade_left = if self.tail.len() == XFADE_FRAMES { XFADE_FRAMES } else { 0 };
            self.loops += 1;
            true
        }

        /// Back to the start with nothing queued, for a fresh play.
        pub fn rewind(&mut self) {
            let _ = self.format.seek(SeekMode::Accurate, SeekTo::Time { time: Time::from(0u64), track_id: Some(self.track_id) });
            self.decoder.reset();
            self.queue.clear();
            self.recent.clear();
            self.tail.clear();
            self.xfade_left = 0;
            self.eof = false;
        }

        pub fn pop(&mut self) -> Option<(f32, f32)> {
            self.queue.pop_front()
        }

        pub fn buffered(&self) -> usize {
            self.queue.len() + self.recent.len()
        }

        /// True once a non-looping stream has played everything it holds.
        pub fn finished(&self, looping: bool) -> bool {
            self.eof && !looping && self.queue.is_empty() && self.recent.is_empty()
        }
    }
}

#[cfg(not(feature = "codecs"))]
mod inner {
    /// Without the `codecs` feature no stream opens; the engine falls back to whole samples.
    pub struct Stream {
        pub rate: u32,
        pub loops: u32,
    }

    impl Stream {
        pub fn open(_bytes: Vec<u8>) -> Option<Stream> {
            None
        }
        pub fn fill(&mut self, _n: usize, _looping: bool) {}
        pub fn rewind(&mut self) {}
        pub fn pop(&mut self) -> Option<(f32, f32)> {
            None
        }
        pub fn buffered(&self) -> usize {
            0
        }
        pub fn finished(&self, _looping: bool) -> bool {
            true
        }
    }
}

pub use inner::Stream;
