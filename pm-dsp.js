(function PM_DSP(sampleRate, AudioWorkletProcessor, registerProcessor) {
const SR = sampleRate;
const TAU = Math.PI * 2;
const NV = 10;
const TBL = 4096;
const SINE = new Float32Array(TBL + 1);
for (let i = 0; i <= TBL; i++) SINE[i] = Math.sin(TAU * i / TBL);
function tsin(ph) { const x = ph * TBL; const i = x | 0; return SINE[i] + (SINE[i + 1] - SINE[i]) * (x - i); }
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
let seed = 22222;
function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; }
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

// Simper/Cytomic state-variable filter. k = 1/Q.
class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.a1 = 1; this.a2 = 0; this.a3 = 0; this.k = 1; this.bp = 0; }
  set(fc, k) {
    fc = clamp(fc, 20, SR * 0.45);
    const g = Math.tan(Math.PI * fc / SR);
    this.k = k; this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  tick(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    this.bp = v1;
    return v2;
  }
  reset() { this.ic1 = 0; this.ic2 = 0; this.bp = 0; }
}

class Delay {
  constructor(n) { this.b = new Float32Array(n); this.n = n; this.w = 0; }
  write(x) { this.b[this.w] = x; if (++this.w === this.n) this.w = 0; }
  // Sample written d samples ago (d >= 1), linear interpolation.
  read(d) {
    let r = this.w - d; while (r < 0) r += this.n;
    const i = r | 0; const f = r - i;
    const a = this.b[i]; const j = i + 1 === this.n ? 0 : i + 1;
    return a + (this.b[j] - a) * f;
  }
  readInt(d) { let r = this.w - d; if (r < 0) r += this.n; return this.b[r]; }
  clear() { this.b.fill(0); this.w = 0; }
}

// Vowels ordered dark to bright: U O A E I. [freq, dB, bandwidth] per formant.
const VOWELS = [
  [[325, 0, 50], [700, -16, 60], [2700, -35, 170], [3800, -40, 180]],
  [[450, 0, 70], [800, -11, 80], [2830, -22, 100], [3800, -22, 130]],
  [[800, 0, 80], [1150, -6, 90], [2900, -32, 120], [3900, -20, 130]],
  [[400, 0, 60], [1700, -14, 90], [2600, -18, 100], [3200, -28, 120]],
  [[290, 0, 50], [2100, -12, 90], [2950, -26, 100], [3900, -26, 120]]
];

const MAXM = 8;
class Voice {
  constructor() {
    this.active = false; this.gate = false; this.id = null; this.ord = 0;
    this.f1 = new SVF(); this.f2 = new SVF();
    this.fb = [new SVF(), new SVF(), new SVF(), new SVF()];
    this.body1 = new SVF(); this.body2 = new SVF();
    this.ph = new Float64Array(17);
    this.pa = new Float64Array(17);
    this.rn = new Float64Array(17);
    this.my1 = new Float64Array(MAXM); this.my2 = new Float64Array(MAXM);
    this.mb1 = new Float64Array(MAXM); this.mb2 = new Float64Array(MAXM);
    this.mgi = new Float64Array(MAXM); this.mgn = new Float64Array(MAXM);
    this.d1 = new Delay(4096); this.d2 = new Delay(4096);
  }
  start(id, note, vel, z, y, ord) {
    this.active = true; this.gate = true; this.id = id; this.ord = ord;
    this.note = note; this.vel = vel;
    this.z = z; this.zT = z; this.y = y; this.yT = y; this.bend = 0; this.bendT = 0;
    this.t = 0; this.rel = 1; this.amp = 0; this.lfo = Math.random();
    this.bow = 0; this.rub = 0; this.sf = 0; this.x1 = 0; this.nlp = 0; this.nlp2 = 0;
    this.f1.reset(); this.f2.reset(); for (const f of this.fb) f.reset();
    this.body1.reset(); this.body2.reset();
    for (let k = 0; k < 17; k++) { this.ph[k] = Math.random(); this.pa[k] = 0; this.rn[k] = Math.random() * 2 - 1; }
    this.my1.fill(0); this.my2.fill(0);
    this.d1.clear(); this.d2.clear();
  }
  render(out, n, P, M) {
    const aS = 1 - Math.exp(-n / (0.012 * SR));
    this.z += (this.zT - this.z) * aS;
    this.y += (this.yT - this.y) * aS;
    this.bend += (this.bendT - this.bend) * aS;
    const zE = Math.pow(clamp(this.z, 0, 1), M.sensExp);
    const y = clamp(this.y, 0, 1);
    this.lfo += P.vibRate * n / SR; if (this.lfo > 1) this.lfo -= 1;
    const vib = (P.vibBase + P.vibZ * zE) * M.vibMul * Math.sin(TAU * this.lfo);
    const semis = this.note + this.bend + vib;
    const f = 440 * Math.pow(2, (semis - 69) / 12);
    const t0 = this.t;
    this.t += n;
    const vel = this.vel;
    const strikeEnv = Math.exp(-(t0 / SR) / P.strikeDecay);
    if (!this.gate) {
      this.rel *= Math.exp(-n / (P.release * M.relMul * SR));
      if (this.rel < 1e-4) this.active = false;
    }
    const tone = M.toneOct;
    const eng = P.engine;

    if (eng === 'analog' || eng === 'formant' || eng === 'additive') {
      const att = P.attack > 0 ? Math.min(1, this.t / (P.attack * SR)) : 1;
      const sus = P.hold * (0.4 + 0.6 * vel) + P.press * zE;
      const ampN = att * (vel * P.strike * strikeEnv + sus) * this.rel * P.gain;
      const a0 = this.amp, da = (ampN - a0) / n;
      this.amp = ampN;

      if (eng === 'analog') {
        const dt1 = f / SR, dt2 = dt1 * Math.pow(2, P.detune / 1200), dts = dt1 * 0.5;
        const oct = P.cutZ * zE + P.cutY * (y - 0.5) * 2 + P.cutVel * vel + P.cutStrike * vel * strikeEnv
          + tone + P.keyTrack * (semis - 60) / 12;
        const fc = P.cutoff * Math.pow(2, oct);
        const k = 2 - 2 * clamp(P.res, 0, 0.97);
        this.f1.set(fc, k); this.f2.set(fc, 2 - (2 - k) * 0.5);
        let p1 = this.ph[0], p2 = this.ph[1], ps = this.ph[2];
        const mix2 = P.osc2, sub = P.sub, nz = P.noise, drive = P.drive, poles4 = P.poles === 4;
        for (let i = 0; i < n; i++) {
          p1 += dt1; if (p1 >= 1) p1 -= 1;
          p2 += dt2; if (p2 >= 1) p2 -= 1;
          ps += dts; if (ps >= 1) ps -= 1;
          let x = (2 * p1 - 1 - blep(p1, dt1)) * (1 - mix2) + (2 * p2 - 1 - blep(p2, dt2)) * mix2;
          if (sub) {
            let q = ps < 0.5 ? 1 : -1;
            q += blep(ps, dts);
            let pp = ps + 0.5; if (pp >= 1) pp -= 1;
            q -= blep(pp, dts);
            x += q * sub;
          }
          if (nz) x += rnd() * nz;
          x = this.f1.tick(x);
          if (poles4) x = this.f2.tick(x);
          if (drive > 0) x = Math.tanh(x * (1 + drive)) / (1 + drive * 0.5);
          out[i] += x * (a0 + da * i);
        }
        this.ph[0] = p1; this.ph[1] = p2; this.ph[2] = ps;
      } else if (eng === 'formant') {
        const pos = clamp(P.vowel + P.vowelY * (y - 0.5) * 2 + P.vowelZ * zE, 0, 3.999);
        const i0 = pos | 0, fr = pos - i0;
        const A = VOWELS[i0], B = VOWELS[i0 + 1];
        const shift = Math.pow(2, tone * 0.15);
        const g = [0, 0, 0, 0];
        for (let j = 0; j < 4; j++) {
          const F = (A[j][0] + (B[j][0] - A[j][0]) * fr) * shift;
          const dB = A[j][1] + (B[j][1] - A[j][1]) * fr;
          const bw = A[j][2] + (B[j][2] - A[j][2]) * fr;
          this.fb[j].set(F, bw / F);
          g[j] = Math.pow(10, dB / 20) * this.fb[j].k;
        }
        const dt1 = f / SR, dt2 = dt1 * Math.pow(2, P.detune / 1200);
        const mix2 = P.osc2, br = P.breath * (0.2 + zE);
        const f0 = this.fb[0], fb1 = this.fb[1], fb2 = this.fb[2], fb3 = this.fb[3];
        let p1 = this.ph[0], p2 = this.ph[1];
        for (let i = 0; i < n; i++) {
          p1 += dt1; if (p1 >= 1) p1 -= 1;
          p2 += dt2; if (p2 >= 1) p2 -= 1;
          const x = (2 * p1 - 1 - blep(p1, dt1)) * (1 - mix2) + (2 * p2 - 1 - blep(p2, dt2)) * mix2 + rnd() * br;
          f0.tick(x); fb1.tick(x); fb2.tick(x); fb3.tick(x);
          const s = g[0] * f0.bp + g[1] * fb1.bp + g[2] * fb2.bp + g[3] * fb3.bp;
          out[i] += s * (a0 + da * i);
        }
        this.ph[0] = p1; this.ph[1] = p2;
      } else {
        // Sine bank: 16 partials, spectral tilt follows press.
        const Bk = P.stretch * 1e-4;
        const tilt = Math.max(0.2, P.tilt0 + (P.tilt1 - P.tilt0) * zE - tone * 0.35 - P.tiltStrike * vel * strikeEnv);
        const odd = clamp(P.oddY * y, 0, 1);
        const at = this.at || (this.at = new Float64Array(17));
        const dd = this.dd || (this.dd = new Float64Array(17));
        let sumsq = 0;
        for (let k = 1; k <= 16; k++) {
          const fk = f * k * Math.sqrt(1 + Bk * k * k) * (1 + P.spread * this.rn[k]);
          let a = 0;
          if (fk < SR * 0.45) a = Math.pow(k, -tilt) * ((k & 1) === 0 ? 1 - odd : 1);
          at[k] = a; dd[k] = fk / SR; sumsq += a * a;
        }
        const norm = sumsq > 0 ? 0.6 / Math.sqrt(sumsq) : 0;
        for (let k = 1; k <= 16; k++) {
          let a = this.pa[k];
          const target = at[k] * norm * ampN;
          const st = (target - a) / n;
          let ph = this.ph[k];
          const d = dd[k];
          if (a === 0 && target === 0) { ph += d * n; ph -= Math.floor(ph); this.ph[k] = ph; continue; }
          for (let i = 0; i < n; i++) {
            out[i] += a * tsin(ph);
            a += st; ph += d; if (ph >= 1) ph -= 1;
          }
          this.pa[k] = target; this.ph[k] = ph;
        }
      }
      return;
    }

    if (eng === 'modal') {
      const R = P.ratios, G = P.gains, nm = Math.min(R.length, MAXM);
      const hard = clamp(P.hard + P.hardVel * (vel - 0.5) + tone * 0.15, 0, 1);
      for (let j = 0; j < nm; j++) {
        const fj = f * R[j];
        if (fj >= SR * 0.45) { this.mgi[j] = 0; this.mgn[j] = 0; this.mb1[j] = 0; this.mb2[j] = 0; continue; }
        let T60 = P.decay * Math.pow(R[j] / R[0], -P.damp) * (1 + P.decayZ * zE);
        if (!this.gate) T60 = Math.min(T60, P.release * M.relMul);
        const r = Math.exp(-6.9 / (T60 * SR));
        const w = TAU * fj / SR, sw = Math.sin(w);
        this.mb1[j] = 2 * r * Math.cos(w); this.mb2[j] = -r * r;
        this.mgi[j] = sw * G[j];
        this.mgn[j] = sw * Math.sqrt(1 - r * r) * G[j];
      }
      const rubT = this.gate ? P.rub * zE + P.rubHold * (0.4 + 0.6 * vel) : 0;
      const r0 = this.rub, dr = (rubT - r0) / n; this.rub = rubT;
      const fcN = 300 * Math.pow(2, y * 5 + tone);
      const c = 1 - Math.exp(-TAU * Math.min(fcN, SR * 0.4) / SR);
      const len = (0.0005 + 0.006 * (1 - hard)) * SR;
      const pk = vel * P.strike * 2 / len;
      const gain = this.rel * P.gain;
      const b1 = this.mb1, b2 = this.mb2, gi = this.mgi, gn = this.mgn, y1 = this.my1, y2 = this.my2;
      for (let i = 0; i < n; i++) {
        const tt = t0 + i;
        const e = tt < len ? pk * (0.5 - 0.5 * Math.cos(TAU * tt / len)) : 0;
        this.nlp += c * (rnd() - this.nlp);
        const ex = this.nlp * (r0 + dr * i) * 6;
        let s = 0;
        for (let j = 0; j < nm; j++) {
          const v = b1[j] * y1[j] + b2[j] * y2[j] + gi[j] * e + gn[j] * ex;
          y2[j] = y1[j]; y1[j] = v; s += v;
        }
        out[i] += s * gain;
      }
      return;
    }

    if (eng === 'bowed') {
      const pole = clamp(P.pole - tone * 0.06, 0.3, 0.92);
      // Subtract the loop filter's phase delay at the fundamental so the string stays in tune.
      const w0 = TAU * f / SR;
      const tau0 = Math.atan2(pole * Math.sin(w0), 1 - pole * Math.cos(w0)) / w0;
      const total = Math.max(4, SR / f - tau0);
      const bl = total * P.beta, nl = total - bl;
      const bowT = this.gate ? clamp(P.hold * (0.4 + 0.6 * vel) + P.press * zE + P.strike * vel * strikeEnv, 0, 1) : 0;
      const tau = this.gate ? P.attack : P.release * M.relMul * 0.3;
      const b0 = this.bow;
      this.bow += (bowT - this.bow) * (1 - Math.exp(-n / (Math.max(tau, 0.002) * SR)));
      const db = (this.bow - b0) / n;
      const press = clamp(P.bowP + P.bowPY * (y - 0.5) * 2 + P.bowPZ * zE, 0.02, 0.98);
      const slope = 5 - 4 * press;
      this.body1.set(280 * Math.pow(2, tone * 0.2), 0.5);
      this.body2.set(460 * Math.pow(2, tone * 0.2), 0.4);
      // The bowed model loses level going up the neck; lift high notes back toward the low ones.
      const gain = this.rel * P.gain * Math.pow(2, clamp((semis - 48) / 24, -1, 2));
      let sf = this.sf;
      for (let i = 0; i < n; i++) {
        const bv = (b0 + db * i) * 0.25;
        const bo = this.d2.read(bl), no = this.d1.read(nl);
        sf = (1 - pole) * 0.95 * bo + pole * sf;
        const bridgeRefl = -sf, nutRefl = -no;
        const dv = bv - (bridgeRefl + nutRefl);
        let bt = Math.abs(dv * slope) + 0.75;
        bt = 1 / (bt * bt * bt * bt);
        if (bt > 0.98) bt = 0.98; else if (bt < 0.01) bt = 0.01;
        const nv = bv > 1e-6 ? dv * bt : 0;
        this.d1.write(bridgeRefl + nv);
        this.d2.write(nutRefl + nv);
        this.body1.tick(bo); this.body2.tick(bo);
        out[i] += (0.35 * bo + this.body1.bp * 0.8 + this.body2.bp * 0.6) * gain;
      }
      this.sf = sf;
      return;
    }

    if (eng === 'pluck') {
      const bright = clamp(P.bright + P.brightY * (y - 0.5) * 2 + P.brightZ * zE + tone * 0.25, 0, 1);
      const s = 0.5 - 0.45 * bright;
      const N = Math.max(2, SR / f - s);
      const T60 = this.gate ? P.decay * (1 + P.decayZ * zE) : P.relDecay * M.relMul;
      const fb = Math.exp(-6.9 / (f * T60));
      const burst = SR / f;
      const c = 0.12 + 0.85 * clamp(vel * 0.8 + bright * 0.3, 0, 1);
      const eb = this.gate ? P.ebow * zE * 0.2 : 0;
      const gain = this.rel * P.gain;
      let x1 = this.x1, nlp = this.nlp;
      for (let i = 0; i < n; i++) {
        let e = 0;
        if (t0 + i < burst) { nlp += c * (rnd() - nlp); e = nlp * vel * P.strike; }
        if (eb) e += rnd() * eb;
        const o = this.d1.read(N);
        const fil = (1 - s) * o + s * x1; x1 = o;
        this.d1.write(Math.tanh(fil * fb + e));
        out[i] += o * gain;
      }
      this.x1 = x1; this.nlp = nlp;
      return;
    }
  }
}

const REV_BASE = [1031, 1327, 1523, 1733, 1949, 2179, 2411, 2689];
class FX {
  constructor() {
    const dmax = Math.ceil(SR * 1.6);
    this.dL = new Delay(dmax); this.dR = new Delay(dmax); this.lpL = 0; this.lpR = 0;
    this.lines = REV_BASE.map(l => new Delay(Math.ceil(l * SR / 48000 * 1.6) + 8));
    this.len = new Int32Array(8); this.g = new Float64Array(8); this.lp = new Float64Array(8);
    this.o = new Float64Array(8);
    this.set(0.6, 3, 0.35);
  }
  set(size, t60, damp) {
    for (let j = 0; j < 8; j++) {
      const l = Math.round(REV_BASE[j] * SR / 48000 * (0.5 + size));
      this.len[j] = l; this.g[j] = Math.pow(10, -3 * l / (Math.max(t60, 0.2) * SR));
    }
    this.damp = 1 - clamp(damp, 0, 0.95);
  }
  process(L, R, n, revMix, dlyMix, dlyT, dlyFb) {
    const o = this.o, lines = this.lines, len = this.len, g = this.g, lp = this.lp, dc = this.damp;
    const T = clamp(dlyT * SR, 1, this.dL.n - 2);
    const doRev = revMix > 0.0005, doDly = dlyMix > 0.0005;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      const m = (l + r) * 0.5;
      let wl = 0, wr = 0;
      if (doDly) {
        const yl = this.dL.read(T), yr = this.dR.read(T);
        this.lpL += 0.45 * (yr - this.lpL); this.lpR += 0.45 * (yl - this.lpR);
        this.dL.write(m + this.lpL * dlyFb);
        this.dR.write(this.lpR * dlyFb);
        wl += yl * dlyMix; wr += yr * dlyMix;
      }
      if (doRev) {
        for (let j = 0; j < 8; j++) { lp[j] += dc * (lines[j].readInt(len[j]) - lp[j]); o[j] = lp[j] * g[j]; }
        // 8-point Hadamard, normalised.
        let a0 = o[0] + o[1], a1 = o[0] - o[1], a2 = o[2] + o[3], a3 = o[2] - o[3];
        let a4 = o[4] + o[5], a5 = o[4] - o[5], a6 = o[6] + o[7], a7 = o[6] - o[7];
        let c0 = a0 + a2, c1 = a1 + a3, c2 = a0 - a2, c3 = a1 - a3;
        let c4 = a4 + a6, c5 = a5 + a7, c6 = a4 - a6, c7 = a5 - a7;
        const h = 0.35355339;
        const inj = m * 0.35;
        lines[0].write((c0 + c4) * h + inj); lines[1].write((c1 + c5) * h - inj);
        lines[2].write((c2 + c6) * h + inj); lines[3].write((c3 + c7) * h - inj);
        lines[4].write((c0 - c4) * h + inj); lines[5].write((c1 - c5) * h - inj);
        lines[6].write((c2 - c6) * h + inj); lines[7].write((c3 - c7) * h - inj);
        wl += (o[0] + o[2] + o[4] + o[6]) * 0.3 * revMix;
        wr += (o[1] + o[3] + o[5] + o[7]) * 0.3 * revMix;
      }
      L[i] = l + wl; R[i] = r + wr;
    }
  }
}

class PressureMatrix extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = []; for (let i = 0; i < NV; i++) this.voices.push(new Voice());
    this.P = null;
    this.M = { toneOct: 0, sensExp: 1, vibMul: 1, relMul: 1, rev: 0.3, dly: 0.1, master: 1 };
    this.fx = new FX();
    this.mono = new Float32Array(128);
    this.ord = 0; this.blocks = 0;
    this.port.onmessage = (e) => this.msg(e.data);
  }
  find(id) { for (const v of this.voices) if (v.active && v.id === id) return v; return null; }
  msg(d) {
    if (d.t === 'p') {
      this.P = d.p; this.fx.set(d.p.revSize, d.p.revT60, d.p.revDamp);
      for (const v of this.voices) v.active = false;
    } else if (d.t === 'm') {
      Object.assign(this.M, d.m);
    } else if (d.t === 'on') {
      if (!this.P) return;
      let v = this.find(d.id);
      if (!v) v = this.voices.find(x => !x.active);
      if (!v) {
        let best = null;
        for (const x of this.voices) if (!x.gate && (!best || x.ord < best.ord)) best = x;
        if (!best) for (const x of this.voices) if (!best || x.ord < best.ord) best = x;
        v = best;
      }
      v.start(d.id, d.note, d.vel, d.z || 0, d.y == null ? 0.5 : d.y, ++this.ord);
    } else if (d.t === 'off') {
      const v = this.find(d.id); if (v) { v.gate = false; v.id = null; }
    } else if (d.t === 'x') {
      const v = this.find(d.id);
      if (v) { if (d.z != null) v.zT = d.z; if (d.y != null) v.yT = d.y; if (d.b != null) v.bendT = d.b; }
    } else if (d.t === 'panic') {
      for (const v of this.voices) v.active = false;
    }
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    L.fill(0); if (R !== L) R.fill(0);
    if (!this.P) return true;
    if (this.mono.length !== n) this.mono = new Float32Array(n);
    const mono = this.mono;
    let count = 0;
    for (const v of this.voices) {
      if (!v.active) continue;
      count++;
      mono.fill(0);
      v.render(mono, n, this.P, this.M);
      const pan = 0.5 + clamp((v.note - 60) / 60, -0.3, 0.3);
      const gl = Math.cos(pan * Math.PI * 0.5), gr = Math.sin(pan * Math.PI * 0.5);
      for (let i = 0; i < n; i++) { const s = mono[i]; L[i] += s * gl; if (R !== L) R[i] += s * gr; }
    }
    const P = this.P, M = this.M;
    if (R !== L) this.fx.process(L, R, n, M.rev, M.dly, P.dlyTime, P.dlyFb);
    for (let i = 0; i < n; i++) {
      L[i] = Math.tanh(L[i] * M.master);
      if (R !== L) R[i] = Math.tanh(R[i] * M.master);
    }
    if (++this.blocks % 24 === 0) this.port.postMessage({ t: 'v', n: count });
    return true;
  }
}
registerProcessor('pressure-matrix', PressureMatrix);
})(sampleRate, AudioWorkletProcessor, registerProcessor);
