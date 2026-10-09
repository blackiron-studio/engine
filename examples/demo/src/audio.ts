import type { AudioEngine } from "@blackiron-studio/engine/audio";

const MINOR = [0, 2, 3, 5, 7, 8, 10];

export function defineAudio(audio: AudioEngine): void {
  audio.defineSfx("collect", { wave: "sine", freq: 880, freqEnd: 1480, duration: 0.09, release: 0.16, volume: 0.35 });
  audio.defineSfx("hurt", { wave: "square", freq: 220, freqEnd: 70, duration: 0.18, release: 0.2, volume: 0.35, lowpass: 1200 });
  audio.defineSfx("hit", { wave: "noise", freq: 600, freqEnd: 120, duration: 0.12, release: 0.15, volume: 0.25, lowpass: 900 });
  audio.defineSfx("wisp", { wave: "triangle", freq: 520, freqEnd: 780, duration: 0.25, attack: 0.08, release: 0.3, volume: 0.18, vibrato: 12, vibratoRate: 7 });
  audio.defineSfx("click", { wave: "square", freq: 660, duration: 0.03, release: 0.05, volume: 0.2 });
  audio.defineSfx("over", { wave: "sawtooth", freq: 330, freqEnd: 55, duration: 0.7, release: 0.5, volume: 0.3, lowpass: 800 });
  audio.defineSfx("start", { wave: "triangle", freq: 440, freqEnd: 880, duration: 0.12, release: 0.25, volume: 0.3, repeat: 2, repeatGap: 0.04 });

  audio.defineMood("title", { tempo: 68, root: 220, scale: MINOR, wave: "sine", density: 0.28, pad: true, bass: true, volume: 0.3, lowpass: 1600, seed: 3 });
  audio.defineMood("night", { tempo: 88, root: 220, scale: MINOR, wave: "triangle", density: 0.42, pad: true, bass: true, volume: 0.32, lowpass: 2000, seed: 9 });
}
