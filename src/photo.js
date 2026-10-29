// Photo booth: a spoken "3, 2, 1" over a rising X-ray charge-up whine, then a clunk and a flash,
// and two pictures of the same instant: the people as the camera sees them, and as an X-ray.

export class PhotoBooth {
  // capture() must return { plain: canvas, xray: canvas } for the current instant.
  constructor({ audio, sounds, capture }) {
    this.audio = audio; // an unlocked AudioContext (or null)
    this.sounds = sounds; // optional recorded sounds (countdown, shutter) that replace the built-in ones
    this.capture = capture;
    this.busy = false;
    this.urls = [];
    document.getElementById('closePhotos').addEventListener('click', () => this.close());
    document.getElementById('savePhotos').addEventListener('click', () => this.save());
  }

  // Call from the button's click handler: speech on iOS must start inside a tap.
  async run() {
    if (this.busy) return;
    this.busy = true;
    document.body.classList.add('shooting');
    const countdown = document.getElementById('countdown');
    countdown.hidden = false;
    const recorded = this.sounds?.play('countdown');
    if (!recorded) this.chargeUp(3);
    for (const n of [3, 2, 1]) {
      countdown.textContent = n;
      if (!recorded) {
        this.say(String(n));
        this.beep(n === 1 ? 1320 : 880);
      }
      await wait(1000);
    }
    countdown.hidden = true;
    const shot = this.capture();
    if (!this.sounds?.play('shutter')) this.zap();
    const flash = document.getElementById('flash');
    flash.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => flash.classList.remove('on')));
    await this.show(shot);
    document.body.classList.remove('shooting');
    this.busy = false;
  }

  say(text) {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.1;
    u.pitch = 0.7; // a lower, machine-like voice
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  beep(freq) {
    const ctx = this.audio;
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.15);
  }

  // The tube warming up: a sawtooth whine rising in pitch with a fast tremolo.
  chargeUp(seconds) {
    const ctx = this.audio;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(120, t0);
    o.frequency.exponentialRampToValueAtTime(1800, t0 + seconds);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 28;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.03;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.06, t0 + seconds * 0.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
    lfo.connect(lfoGain).connect(g.gain);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2500;
    o.connect(lp).connect(g).connect(ctx.destination);
    o.start(t0);
    lfo.start(t0);
    o.stop(t0 + seconds);
    lfo.stop(t0 + seconds);
  }

  // Exposure: a low thump, a burst of filtered static and a high zap.
  zap() {
    const ctx = this.audio;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(140, t0);
    thump.frequency.exponentialRampToValueAtTime(40, t0 + 0.25);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.6, t0);
    tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
    thump.connect(tg).connect(ctx.destination);
    thump.start(t0);
    thump.stop(t0 + 0.3);

    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3000;
    bp.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.value = 0.5;
    noise.connect(bp).connect(ng).connect(ctx.destination);
    noise.start(t0);

    const zz = ctx.createOscillator();
    zz.type = 'square';
    zz.frequency.setValueAtTime(2400, t0);
    zz.frequency.exponentialRampToValueAtTime(600, t0 + 0.2);
    const zg = ctx.createGain();
    zg.gain.setValueAtTime(0.12, t0);
    zg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    zz.connect(zg).connect(ctx.destination);
    zz.start(t0);
    zz.stop(t0 + 0.2);
  }

  async show({ plain, xray }) {
    this.close();
    const [a, b] = await Promise.all([toBlob(plain), toBlob(xray)]);
    this.blobs = [a, b];
    this.urls = [URL.createObjectURL(a), URL.createObjectURL(b)];
    document.getElementById('photoPlain').src = this.urls[0];
    document.getElementById('photoXray').src = this.urls[1];
    document.getElementById('photos').hidden = false;
    // Close by itself after 20 s so the costume never gets stuck on the photos.
    this.autoClose = setTimeout(() => this.close(), 20000);
  }

  close() {
    clearTimeout(this.autoClose);
    document.getElementById('photos').hidden = true;
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
  }

  // iPad: the share sheet (Save Image puts them in Photos). Mac: two downloads.
  async save() {
    if (!this.blobs) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const files = [new File([this.blobs[0]], `xray-${stamp}-photo.jpg`, { type: 'image/jpeg' }), new File([this.blobs[1]], `xray-${stamp}-xray.jpg`, { type: 'image/jpeg' })];
    if (navigator.canShare?.({ files })) {
      try { await navigator.share({ files }); return; } catch (err) { if (err.name === 'AbortError') return; }
    }
    files.forEach((f, i) => {
      const a = document.createElement('a');
      a.href = this.urls[i];
      a.download = f.name;
      a.click();
    });
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const toBlob = (canvas) => new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
