// Optional sounds. Each slot is filled, in order of preference, from a file picked on this device in
// the Sounds panel (stored in IndexedDB, never uploaded), then from media/sounds/<slot>.mp3 in the
// site, else the built-in synthesised sound (or silence).
//   attract      when the attract mode starts ("come closer...", an evil laugh)
//   thumbsup     when a thumbs-up is spotted, before the countdown
//   countdown    replaces the spoken 3-2-1 (should last about 3 s)
//   shutter      the moment the photo is taken
//   gamestart    when the pose game starts
//   match        a pose matched in the game
//   fail         a pose not matched in time
//   yoga         a yoga round starts (e.g. monk chanting)
//   yogamatch    a yoga pose is held (e.g. a gong)
// Each pose and move can also have its own sound (key from poseKey()), played when its round starts.
import { getSound } from './soundstore.js';

export const SLOTS = ['attract', 'thumbsup', 'countdown', 'shutter', 'gamestart', 'match', 'fail', 'yoga', 'yogamatch'];
export const SLOT_LABELS = {
  attract: 'Attract mode ("come closer")',
  thumbsup: 'Thumbs up spotted',
  countdown: 'Photo countdown (3 s)',
  shutter: 'Photo taken',
  gamestart: 'Pose game starts',
  match: 'Pose matched',
  fail: 'Too slow',
  yoga: 'Yoga round starts (chanting)',
  yogamatch: 'Yoga pose held (gong)',
};

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
    await Promise.all(SLOTS.map((slot) => this.loadKey(slot, `media/sounds/${slot}.mp3`)));
  }

  // Loads one sound by key: the device's own pick first, then the site's file if a URL is given.
  async loadKey(key, url = null) {
    if (!this.ctx || this.buffers[key] !== undefined) return;
    this.buffers[key] = null;
    try {
      const own = await getSound(key);
      let data = own ? await own.blob.arrayBuffer() : null;
      if (!data && url) {
        const res = await fetch(url);
        if (res.ok) data = await res.arrayBuffer();
      }
      if (data) this.buffers[key] = await this.ctx.decodeAudioData(data);
    } catch { /* no usable sound for this key */ }
  }

  // Forget a key so the next load picks up a newly chosen file.
  forget(key) { delete this.buffers[key]; }

  has(key) { return Boolean(this.buffers[key]); }

  // Plays a sound; returns a handle with stop(), or null if there is none (so callers can fall back).
  play(key, { volume = 1, loop = false } = {}) {
    const buf = this.buffers[key];
    if (!buf || !this.ctx) return null;
    if (loop && this.loops[key]) return this.loops[key];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    const handle = {
      src,
      gain: g,
      // Quick fade so a song clip doesn't cut off with a click.
      stop: () => {
        const t = this.ctx.currentTime;
        g.gain.setTargetAtTime(0, t, 0.08);
        try { src.stop(t + 0.4); } catch { /* already stopped */ }
      },
    };
    if (loop) this.loops[key] = handle;
    return handle;
  }

  // Changes a looping sound's volume without stopping it.
  setLoopVolume(key, volume) {
    const l = this.loops[key];
    if (l) l.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.05);
  }
}
