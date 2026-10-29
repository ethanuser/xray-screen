// Optional sound slots. Drop an MP3 into media/sounds/ with one of these names and it is used;
// a slot with no file falls back to the built-in synthesised sound (or silence).
//   ambient.mp3   looped quietly the whole time (machine hum, creepy drone)
//   attract.mp3   when the attract mode starts ("come closer...", an evil laugh)
//   thumbsup.mp3  when a thumbs-up is spotted, before the countdown
//   countdown.mp3 replaces the spoken 3-2-1 (should last about 3 s)
//   shutter.mp3   the moment the photo is taken
//   gamestart.mp3 when the pose game starts
//   match.mp3     a pose matched in the game
//   fail.mp3      a pose not matched in time
export const SLOTS = ['ambient', 'attract', 'thumbsup', 'countdown', 'shutter', 'gamestart', 'match', 'fail'];

export class SoundBank {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.loops = {};
  }

  // ctx must be an AudioContext unlocked by a tap.
  async load(ctx) {
    this.ctx = ctx;
    if (!ctx) return;
    await Promise.all(SLOTS.map(async (slot) => {
      try {
        const res = await fetch(`media/sounds/${slot}.mp3`);
        if (res.ok) this.buffers[slot] = await ctx.decodeAudioData(await res.arrayBuffer());
      } catch { /* no file for this slot */ }
    }));
  }

  has(slot) { return Boolean(this.buffers[slot]); }

  // Plays a slot; returns false if there is no file for it, so callers can fall back.
  play(slot, { volume = 1, loop = false } = {}) {
    const buf = this.buffers[slot];
    if (!buf || !this.ctx) return false;
    if (loop && this.loops[slot]) return true;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    if (loop) this.loops[slot] = { src, gain: g };
    return true;
  }

  // Quiets a looping slot (e.g. the ambient hum during a jumpscare) without stopping it.
  setLoopVolume(slot, volume) {
    const l = this.loops[slot];
    if (l) l.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.05);
  }
}
