// Sound effects from oscillator envelopes, samples, and a generative music sequencer
// driven by "moods". The sound itself is rendered by the kernel synthesiser behind an
// AudioBackend, so a game sounds the same in a browser and in a native host. Without a
// backend everything is a no-op.

import { Rng } from "../core/rng.ts";
import { AUDIO_CMD, type AudioBackend, type AudioBus, type Wave, voiceWords } from "./backend.ts";

export type { Wave } from "./backend.ts";

export interface SfxSpec {
  wave?: Wave;
  /** Start frequency in Hz. */
  freq: number;
  /** End frequency; sweeps exponentially when set. */
  freqEnd?: number;
  duration?: number;
  attack?: number;
  /** Release tail after the sustain portion. */
  release?: number;
  volume?: number;
  /** Low-pass cutoff in Hz. */
  lowpass?: number;
  /** Vibrato depth in Hz and rate in Hz. */
  vibrato?: number;
  vibratoRate?: number;
  /** Play the note this many times in a row. */
  repeat?: number;
  repeatGap?: number;
}

export interface MoodSpec {
  tempo: number;
  /** Root frequency in Hz. */
  root: number;
  /** Scale as semitone offsets from the root, e.g. [0, 2, 3, 5, 7, 8, 10] for minor. */
  scale: number[];
  wave?: Wave;
  bassWave?: Wave;
  /** Chance per eighth-note step that the melody plays. */
  density?: number;
  bass?: boolean;
  /** Sustained chord under each bar. */
  pad?: boolean;
  volume?: number;
  lowpass?: number;
  seed?: number;
  /** Kick on the downbeats, snare on the backbeats, a soft hat on every step. */
  drums?: boolean;
  /** Chord roots as scale degrees, one per bar; default [0, 5, 3, 4]. */
  progression?: number[];
  /** Chord tones on the off steps, rising. */
  arp?: boolean;
  /** Extra weight on the kick and bass, 0 to 1. */
  drive?: number;
}

export interface PlayOptions {
  volume?: number;
  /** Frequency multiplier. */
  pitch?: number;
  /** -1 left to 1 right; overrides the position. */
  pan?: number;
  /** World position: panned and attenuated relative to `audio.listener`. */
  x?: number;
  y?: number;
  /** Loop a sample until `stop`. */
  loop?: boolean;
}

export interface MoodOptions {
  /** Seconds to crossfade from the mood or music that is playing. */
  crossfade?: number;
}

export interface MusicOptions extends MoodOptions {
  volume?: number;
  loop?: boolean;
}

/** Where sounds are heard from, for positional playback. */
/** Effects on a bus, applied after its voices are mixed. */
export interface BusEffects {
  /** Low-pass cutoff in Hz; muffles a bus (a pause menu, being underwater). */
  lowpass?: number;
  /** Schroeder reverb: `mix` 0 to 1, `size` 0 (a room) to 1 (a hall). */
  reverb?: { mix: number; size?: number };
  /** A delay line: `time` in seconds, `feedback` 0 to 0.95, `mix` 0 to 1. */
  echo?: { time: number; feedback?: number; mix?: number };
}

export interface Listener {
  x: number;
  y: number;
  /** Distance at which a sound is inaudible; panning reaches full left or right at half of it. */
  range: number;
}

export class AudioEngine {
  private readonly sfx = new Map<string, SfxSpec>();
  private readonly moods = new Map<string, MoodSpec>();
  private readonly sampleIds = new Map<string, number>();
  private nextSampleId = 0;
  /** Streamed tracks by name; they share the id space with samples but live in the kernel's stream table. */
  private readonly streamIds = new Map<string, number>();
  private moodName: string | null = null;
  private mood: MoodSpec | null = null;
  private moodRng = new Rng(1);
  private schedulerId: ReturnType<typeof setInterval> | null = null;
  private nextStep = 0;
  private stepIndex = 0;
  private _muted = false;
  private _sfxVolume = 0.8;
  private _musicVolume = 0.5;
  private musicBus: 1 | 2 = 1;
  private musicSample: number | null = null;
  private readonly effects: { sfx: BusEffects | null; music: BusEffects | null } = { sfx: null, music: null };
  /** Set this from the scene (the camera's centre, usually) for positional sounds. */
  listener: Listener = { x: 0, y: 0, range: 1200 };

  constructor(readonly backend: AudioBackend | null = null) {}

  get available(): boolean {
    return this.backend !== null;
  }

  get unlocked(): boolean {
    return this.backend?.unlocked ?? false;
  }

  get muted(): boolean {
    return this._muted;
  }

  get sfxVolume(): number {
    return this._sfxVolume;
  }

  set sfxVolume(v: number) {
    this._sfxVolume = v;
    this.pushBus();
  }

  get musicVolume(): number {
    return this._musicVolume;
  }

  set musicVolume(v: number) {
    this._musicVolume = v;
    this.pushBus();
  }

  private _masterVolume = 1;
  private _paused = false;

  /** Scales both buses; the settings shell drives it. */
  get masterVolume(): number {
    return this._masterVolume;
  }

  set masterVolume(v: number) {
    this._masterVolume = Math.max(0, Math.min(1, v));
    this.pushBus();
  }

  get paused(): boolean {
    return this._paused;
  }

  /** A pause menu's sound: effects silent, music ducked; `resume` restores both. */
  pause(): void {
    this._paused = true;
    this.pushBus();
  }

  resume(): void {
    this._paused = false;
    this.pushBus();
  }

  /** Start output. On the web this must come from a user gesture; the App calls it on the first input. */
  unlock(): void {
    if (!this.backend) return;
    const was = this.backend.unlocked;
    this.backend.unlock();
    if (!was) {
      this.pushBus();
      this.backend.command([AUDIO_CMD.MUTE, this._muted ? 1 : 0]);
      for (const bus of ["sfx", "music"] as const) if (this.effects[bus]) this.pushEffects(bus);
    }
    if (this.mood && this.schedulerId === null) this.startScheduler();
  }

  /**
   * Set (or clear with null) the effects on the sound-effect bus or the music buses. Applied at
   * once when the backend runs, and again when it unlocks.
   */
  setEffects(bus: "sfx" | "music", fx: BusEffects | null): void {
    this.effects[bus] = fx;
    if (this.backend?.unlocked) this.pushEffects(bus);
  }

  getEffects(bus: "sfx" | "music"): BusEffects | null {
    return this.effects[bus];
  }

  private pushEffects(bus: "sfx" | "music"): void {
    const fx = this.effects[bus];
    const words = (b: number) => [AUDIO_CMD.BUS_FX, b, fx?.lowpass ?? 0, fx?.reverb?.mix ?? 0, fx?.reverb?.size ?? 0.5, fx?.echo?.time ?? 0, fx?.echo?.feedback ?? 0.35, fx?.echo?.mix ?? 0.5];
    if (bus === "sfx") this.backend?.command(words(0));
    else {
      this.backend?.command(words(1));
      this.backend?.command(words(2));
    }
  }

  private pushBus(): void {
    const m = this._masterVolume;
    this.backend?.command([AUDIO_CMD.BUS, this._sfxVolume * m * (this._paused ? 0 : 1), this._musicVolume * m * (this._paused ? 0.35 : 1)]);
  }

  setMuted(m: boolean): void {
    this._muted = m;
    this.backend?.command([AUDIO_CMD.MUTE, m ? 1 : 0]);
  }

  toggleMuted(): boolean {
    this.setMuted(!this._muted);
    return this._muted;
  }

  // --- Sound effects ------------------------------------------------------------

  defineSfx(name: string, spec: SfxSpec): void {
    this.sfx.set(name, spec);
  }

  /** Decode an encoded audio file into a playable sample. */
  async loadSample(name: string, bytes: ArrayBuffer): Promise<boolean> {
    if (!this.backend) return false;
    const id = this.sampleIds.get(name) ?? this.nextSampleId++;
    const ok = await this.backend.loadSample(id, bytes);
    if (ok) this.sampleIds.set(name, id);
    return ok;
  }

  hasSample(name: string): boolean {
    return this.sampleIds.has(name);
  }

  /**
   * Load a music track for streaming: the kernel keeps the encoded file and decodes it while
   * it plays, so a track costs its compressed size, not its decoded length. Backends without
   * codecs decode it whole instead, so `playMusic(name)` works either way; `isStreamed(name)`
   * says which happened.
   */
  async loadMusic(name: string, bytes: ArrayBuffer): Promise<boolean> {
    const b = this.backend;
    if (!b) return false;
    const id = this.streamIds.get(name) ?? this.sampleIds.get(name) ?? this.nextSampleId++;
    if (b.loadStream && (await b.loadStream(id, bytes))) {
      this.streamIds.set(name, id);
      this.sampleIds.delete(name);
      return true;
    }
    const ok = await b.loadSample(id, bytes);
    if (ok) this.sampleIds.set(name, id);
    return ok;
  }

  isStreamed(name: string): boolean {
    return this.streamIds.has(name);
  }

  /** Drop a streamed track's file from the kernel. */
  unloadMusic(name: string): void {
    const id = this.streamIds.get(name);
    if (id === undefined) return;
    this.backend?.closeStream?.(id);
    this.streamIds.delete(name);
    if (this.musicSample === id) this.musicSample = null;
  }

  /** Pan and attenuation for a position relative to the listener. */
  private spatial(opts: PlayOptions): { pan: number; gain: number } {
    if (opts.pan !== undefined) return { pan: Math.max(-1, Math.min(1, opts.pan)), gain: 1 };
    if (opts.x === undefined || opts.y === undefined) return { pan: 0, gain: 1 };
    const l = this.listener;
    const dx = opts.x - l.x;
    const dy = opts.y - l.y;
    const dist = Math.hypot(dx, dy);
    const gain = Math.max(0, 1 - dist / Math.max(1, l.range));
    const pan = Math.max(-1, Math.min(1, dx / Math.max(1, l.range / 2)));
    return { pan, gain: gain * gain };
  }

  play(name: string, opts: PlayOptions = {}): void {
    const b = this.backend;
    if (!b || !b.unlocked) return;
    const { pan, gain } = this.spatial(opts);
    if (gain <= 0) return;
    const sample = this.sampleIds.get(name);
    if (sample !== undefined) {
      b.command([AUDIO_CMD.SAMPLE, 0, 0, sample, (opts.volume ?? 1) * gain, opts.pitch ?? 1, pan, opts.loop ? 1 : 0]);
      return;
    }
    const spec = this.sfx.get(name);
    if (!spec) {
      console.warn(`[kiln] sfx "${name}" is not defined`);
      return;
    }
    const repeat = Math.max(1, spec.repeat ?? 1);
    const gap = spec.repeatGap ?? 0.05;
    const now = b.time();
    for (let i = 0; i < repeat; i++) this.voice(spec, 0, i === 0 ? 0 : now + i * ((spec.duration ?? 0.1) + gap), { ...opts, pan, volume: (opts.volume ?? 1) * gain });
  }

  /** Stop every sound on the effect bus, or on the music buses, with an optional fade. */
  stop(what: "sfx" | "music" | "all" = "all", fade = 0.05): void {
    const b = this.backend;
    if (!b) return;
    if (what !== "music") b.command([AUDIO_CMD.STOP_BUS, 0, fade]);
    if (what !== "sfx") {
      b.command([AUDIO_CMD.STOP_BUS, 1, fade]);
      b.command([AUDIO_CMD.STOP_BUS, 2, fade]);
    }
  }

  /** Queue one note. `at` is on the backend clock; 0 means now. */
  private voice(spec: SfxSpec, bus: AudioBus, at: number, opts: PlayOptions): void {
    this.backend?.command(
      voiceWords(
        {
          wave: spec.wave ?? "square",
          freq: spec.freq,
          freqEnd: spec.freqEnd,
          duration: spec.duration ?? 0.1,
          attack: spec.attack ?? 0.005,
          release: spec.release ?? 0.08,
          volume: (spec.volume ?? 0.5) * (opts.volume ?? 1),
          lowpass: spec.lowpass,
          vibrato: spec.vibrato,
          vibratoRate: spec.vibratoRate ?? 6,
          pitch: opts.pitch ?? 1,
          pan: opts.pan ?? 0,
        },
        at,
        bus,
      ),
    );
  }

  /** Move music to the other bus, fading the old one out and the new one in. */
  private crossfadeMusic(seconds: number): AudioBus {
    const b = this.backend;
    const from = this.musicBus;
    const to: 1 | 2 = from === 1 ? 2 : 1;
    if (b && seconds > 0) {
      b.command([AUDIO_CMD.FADE, from, 0, seconds]);
      b.command([AUDIO_CMD.STOP_BUS, from, seconds]);
      b.command([AUDIO_CMD.FADE, to, this._musicVolume, seconds]);
    } else if (b) {
      b.command([AUDIO_CMD.STOP_BUS, from, 0.05]);
      b.command([AUDIO_CMD.FADE, to, this._musicVolume, 0]);
    }
    this.musicBus = to;
    return to;
  }

  /** Play a loaded track (streamed or a sample) as music, looping, replacing whatever music plays. */
  playMusic(name: string, opts: MusicOptions = {}): void {
    const b = this.backend;
    const stream = this.streamIds.get(name);
    const sample = stream ?? this.sampleIds.get(name);
    if (!b || sample === undefined) return;
    this.setMood(null);
    const bus = this.crossfadeMusic(opts.crossfade ?? 0);
    this.musicSample = sample;
    b.command([stream !== undefined ? AUDIO_CMD.STREAM : AUDIO_CMD.SAMPLE, 0, bus, sample, opts.volume ?? 1, 1, 0, opts.loop === false ? 0 : 1]);
  }

  stopMusic(fade = 0.5): void {
    this.setMood(null);
    this.musicSample = null;
    this.backend?.command([AUDIO_CMD.STOP_BUS, 1, fade]);
    this.backend?.command([AUDIO_CMD.STOP_BUS, 2, fade]);
  }

  // --- Music -----------------------------------------------------------------------

  defineMood(name: string, spec: MoodSpec): void {
    this.moods.set(name, spec);
  }

  /** Switch the generative music to a mood, or stop it with null. */
  setMood(name: string | null, opts: MoodOptions = {}): void {
    if (name === this.moodName) return;
    const hadMusic = this.mood !== null || this.musicSample !== null;
    this.moodName = name;
    this.mood = name ? (this.moods.get(name) ?? null) : null;
    if (name && !this.mood) console.warn(`[kiln] mood "${name}" is not defined`);
    this.moodRng = new Rng(this.mood?.seed ?? 5);
    this.stepIndex = 0;
    if (hadMusic && this.backend) {
      if (this.mood) this.crossfadeMusic(opts.crossfade ?? 0);
      else {
        this.backend.command([AUDIO_CMD.STOP_BUS, this.musicBus, opts.crossfade ?? 0.3]);
        this.musicSample = null;
      }
    }
    if (this.mood) {
      this.musicSample = null;
      if (this.backend?.unlocked && this.schedulerId === null) this.startScheduler();
      else if (this.backend?.unlocked) this.nextStep = this.backend.time() + 0.05;
    } else this.stopScheduler();
  }

  get currentMood(): string | null {
    return this.moodName;
  }

  private startScheduler(): void {
    if (!this.backend) return;
    this.nextStep = this.backend.time() + 0.05;
    this.schedulerId = setInterval(() => this.schedule(), 25);
  }

  private stopScheduler(): void {
    if (this.schedulerId !== null) clearInterval(this.schedulerId);
    this.schedulerId = null;
  }

  private schedule(): void {
    const b = this.backend;
    const mood = this.mood;
    if (!b || !mood || !b.unlocked) return;
    const stepDur = 60 / mood.tempo / 2;
    const now = b.time();
    if (this.nextStep < now - 1) this.nextStep = now + 0.05;
    while (this.nextStep < now + 0.15) {
      this.playStep(this.stepIndex, this.nextStep, stepDur);
      this.nextStep += stepDur;
      this.stepIndex++;
    }
  }

  private playStep(step: number, at: number, stepDur: number): void {
    const mood = this.mood as MoodSpec;
    const r = this.moodRng;
    const vol = mood.volume ?? 0.35;
    const bar = Math.floor(step / 8);
    const inBar = step % 8;
    const semis = mood.scale;
    const freqOf = (degree: number, octave = 0) => mood.root * 2 ** ((semis[((degree % semis.length) + semis.length) % semis.length] + 12 * (octave + Math.floor(degree / semis.length))) / 12);
    const prog = mood.progression ?? [0, 5, 3, 4];
    const chordRoot = prog[bar % prog.length];
    const drive = mood.drive ?? 0.5;
    if (mood.drums) {
      if (inBar === 0 || inBar === 4 || (inBar === 7 && r.chance(0.25))) this.voice({ wave: "sine", freq: 130, freqEnd: 38, duration: 0.09, attack: 0.002, release: 0.08, volume: vol * (0.55 + drive * 0.4), lowpass: 400 }, this.musicBus, at, {});
      if (inBar === 2 || inBar === 6) this.voice({ wave: "noise", freq: 1800, freqEnd: 500, duration: 0.06, attack: 0.002, release: 0.09, volume: vol * 0.28, lowpass: 3200 }, this.musicBus, at, {});
      this.voice({ wave: "noise", freq: 7000, freqEnd: 5000, duration: 0.015, attack: 0.001, release: 0.02, volume: vol * (inBar % 2 ? 0.05 : 0.09), lowpass: 9000 }, this.musicBus, at, {});
    }
    if (mood.arp && inBar % 2 === 1) {
      const tone = [0, 2, 4, 7][Math.floor(inBar / 2) % 4];
      this.voice({ wave: mood.wave ?? "triangle", freq: freqOf(chordRoot + tone, 1), duration: stepDur * 0.9, attack: 0.01, release: 0.12, volume: vol * 0.22, lowpass: mood.lowpass ?? 2400 }, this.musicBus, at, {});
    }
    if ((mood.pad ?? true) && inBar === 0) {
      for (const d of [chordRoot, chordRoot + 2, chordRoot + 4]) {
        this.voice({ wave: "triangle", freq: freqOf(d, 0), duration: stepDur * 7.5, attack: 0.4, release: 0.6, volume: vol * 0.18, lowpass: mood.lowpass ?? 900 }, this.musicBus, at, {});
      }
    }
    if ((mood.bass ?? true) && (inBar === 0 || inBar === 4 || (inBar === 6 && r.chance(0.3)))) {
      this.voice({ wave: mood.bassWave ?? "triangle", freq: freqOf(chordRoot, -1), duration: stepDur * 1.5, attack: 0.01, release: 0.2, volume: vol * 0.5, lowpass: 600 }, this.musicBus, at, {});
    }
    if (r.chance(mood.density ?? 0.45)) {
      const degree = chordRoot + r.pick([0, 2, 4, 1, 3, 7, 9]);
      const octave = r.chance(0.25) ? 2 : 1;
      this.voice(
        { wave: mood.wave ?? "sine", freq: freqOf(degree, octave), duration: stepDur * r.pick([0.5, 0.9, 1.8]), attack: 0.02, release: 0.35, volume: vol * 0.4, lowpass: mood.lowpass ?? 2400, vibrato: 3, vibratoRate: 5 },
        this.musicBus,
        at + (r.chance(0.2) ? stepDur * 0.5 : 0),
        {},
      );
    }
  }

  destroy(): void {
    this.stopScheduler();
    this.backend?.command([AUDIO_CMD.STOP]);
    this.backend?.destroy();
  }
}
