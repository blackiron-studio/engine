// What the AudioEngine talks to: a kernel synthesiser rendered on the host's audio thread.
// Commands are short float arrays; `time()` is the audio clock they are scheduled against.

export type Wave = "sine" | "square" | "sawtooth" | "triangle" | "noise";

export const AUDIO_CMD = { VOICE: 1, SAMPLE: 2, BUS: 3, MUTE: 4, STOP: 5, FADE: 6, STOP_BUS: 7, BUS_FX: 8, STREAM: 9 } as const;
export const WAVE_ID: Record<Wave, number> = { sine: 0, square: 1, sawtooth: 2, triangle: 3, noise: 4 };

/** 0 is the sound-effect bus; 1 and 2 are the two music buses that crossfade into each other. */
export type AudioBus = 0 | 1 | 2;

export interface VoiceParams {
  wave: Wave;
  freq: number;
  freqEnd?: number;
  duration: number;
  attack: number;
  release: number;
  volume: number;
  lowpass?: number;
  vibrato?: number;
  vibratoRate?: number;
  pitch: number;
  /** -1 left to 1 right. */
  pan?: number;
}

export interface AudioBackend {
  readonly kind: "worklet" | "native";
  /** Whether output is running; on the web this needs a user gesture first. */
  readonly unlocked: boolean;
  unlock(): void;
  /** Seconds on the audio clock. */
  time(): number;
  command(words: ArrayLike<number>): void;
  /** Decode an encoded file (WAV, MP3, OGG where the platform supports it) into sample `id`. */
  loadSample(id: number, bytes: ArrayBuffer): Promise<boolean>;
  /**
   * Hand an encoded file to the kernel's streaming decoder as stream `id`: it is decoded a
   * packet at a time while it plays. False when this backend has no codecs (the engine then
   * falls back to a whole sample).
   */
  loadStream?(id: number, bytes: ArrayBuffer): Promise<boolean>;
  closeStream?(id: number): void;
  destroy(): void;
}

export function voiceWords(p: VoiceParams, at: number, bus: AudioBus): number[] {
  return [AUDIO_CMD.VOICE, at, bus, WAVE_ID[p.wave], p.freq, p.freqEnd ?? 0, p.duration, p.attack, p.release, p.volume, p.lowpass ?? 0, p.vibrato ?? 0, p.vibratoRate ?? 0, p.pitch, p.pan ?? 0];
}
