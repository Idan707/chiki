// Turn detection and resampling. Pure and stateful-by-instance, with no
// `cloudflare:workers` import, so `node --test` can exercise them directly.
//
// The device streams 16 kHz mono PCM while it is listening and decides nothing;
// this module decides when the child has stopped talking. Keeping that here
// rather than in firmware means it can be retuned without reflashing a board
// that has no over-the-air update.

export const RATE = 16000;
const BYTES_PER_SAMPLE = 2;

/** Root-mean-square amplitude of signed 16-bit PCM, normalized to 0..1. */
export function rms(pcm) {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length) / 32768;
}

// A five-year-old trails off, mumbles, and pauses mid-thought to look at
// something. These defaults are deliberately patient: better to wait a beat too
// long than to cut a child off in the middle of a sentence.
export const TURN_DEFAULTS = {
  startLevel: 0.02,      // RMS that counts as "someone is talking"
  keepLevel: 0.012,      // lower bar to stay in speech; avoids chopping at dips
  minSpeechMs: 300,      // ignore a cough, a tap, a chair scrape
  hangoverMs: 1100,      // silence after speech before the turn is called
  maxUtteranceMs: 20000, // hard stop so one long ramble still gets an answer
  leadInMs: 300,         // audio kept from before the trigger, so no clipped onset
};

/**
 * Feed 16 kHz PCM chunks; get back what just happened.
 * Returns 'idle' | 'speech' | 'end'. On 'end', call `take()` for the utterance.
 */
export class TurnDetector {
  constructor(opts = {}) {
    this.o = { ...TURN_DEFAULTS, ...opts };
    this.reset();
  }

  reset() {
    this.buf = [];          // Int16Array chunks kept for the current utterance
    this.bufMs = 0;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.inSpeech = false;
  }

  /** @param {Int16Array} chunk */
  push(chunk) {
    const ms = (chunk.length / RATE) * 1000;
    const level = rms(chunk);
    const loud = level >= (this.inSpeech ? this.o.keepLevel : this.o.startLevel);

    this.buf.push(chunk);
    this.bufMs += ms;

    if (!this.inSpeech) {
      // Keep a short lead-in so the first phoneme is never clipped, but do not
      // let an idle device accumulate minutes of room tone.
      while (this.bufMs > this.o.leadInMs + ms && this.buf.length > 1) {
        const dropped = this.buf.shift();
        this.bufMs -= (dropped.length / RATE) * 1000;
      }
      if (loud) {
        this.speechMs += ms;
        if (this.speechMs >= this.o.minSpeechMs) {
          this.inSpeech = true;
          this.silenceMs = 0;
        }
      } else {
        this.speechMs = 0;
      }
      return this.inSpeech ? 'speech' : 'idle';
    }

    if (loud) {
      this.silenceMs = 0;
    } else {
      this.silenceMs += ms;
      if (this.silenceMs >= this.o.hangoverMs) return 'end';
    }
    if (this.bufMs >= this.o.maxUtteranceMs) return 'end';
    return 'speech';
  }

  /** The utterance so far, as one Int16Array. Resets the detector. */
  take() {
    const total = this.buf.reduce((n, c) => n + c.length, 0);
    const out = new Int16Array(total);
    let at = 0;
    for (const c of this.buf) { out.set(c, at); at += c.length; }
    this.reset();
    return out;
  }
}

/**
 * 24 kHz -> 16 kHz, the rate the synthesis comes back at versus the rate the
 * codec runs at.
 *
 * Dropping every third sample would be cheaper and wrong: it folds 8-12 kHz
 * back down into the audible band, and Hebrew sibilants (ש, ס, צ) carry real
 * energy there, so it would warble on exactly the sounds a child notices. Low-
 * pass first, then interpolate. Filter and phase state carry across chunks, so
 * streamed audio has no click at the seams.
 */
export class Resampler {
  constructor(from = 24000, to = RATE, taps = 47) {
    this.ratio = from / to;
    this.h = lowpass(0.45 / this.ratio, taps);  // cutoff below the new Nyquist
    this.half = (taps - 1) / 2;
    this.tail = new Float32Array(0);
    this.phase = 0;
    this.prev = null;      // last filtered sample, to interpolate across the seam
  }

  /** @param {Int16Array} pcm @returns {Int16Array} */
  push(pcm) {
    const joined = new Float32Array(this.tail.length + pcm.length);
    joined.set(this.tail, 0);
    for (let i = 0; i < pcm.length; i++) joined[this.tail.length + i] = pcm[i];

    const filtered = new Float32Array(Math.max(0, joined.length - this.h.length + 1));
    for (let i = 0; i < filtered.length; i++) {
      let acc = 0;
      for (let j = 0; j < this.h.length; j++) acc += joined[i + j] * this.h[j];
      filtered[i] = acc;
    }
    // Keep the filter's delay line for the next call.
    this.tail = joined.slice(Math.max(0, joined.length - (this.h.length - 1)));

    // Interpolation needs a sample on both sides, so the previous chunk's last
    // filtered sample leads this one. Without it the seam loses a sample every
    // chunk and the stream slowly drifts.
    let f = filtered;
    if (this.prev !== null) {
      f = new Float32Array(filtered.length + 1);
      f[0] = this.prev;
      f.set(filtered, 1);
    }
    if (f.length < 2) return new Int16Array(0);

    const out = [];
    let t = this.phase;
    while (t <= f.length - 1 - 1e-9) {
      const i = Math.floor(t);
      const v = f[i] + (f[i + 1] - f[i]) * (t - i);
      out.push(Math.max(-32768, Math.min(32767, Math.round(v))));
      t += this.ratio;
    }
    this.prev = f[f.length - 1];
    this.phase = t - (f.length - 1);
    return Int16Array.from(out);
  }
}

function lowpass(cutoff, taps) {
  const h = new Float32Array(taps);
  const half = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - half;
    const sinc = k === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k);
    const win = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));  // Hamming
    h[i] = sinc * win;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;   // unity gain at DC
  return h;
}

/** Bytes off the wire -> samples. Odd trailing byte is carried by the caller. */
export function toInt16(buffer) {
  const usable = buffer.byteLength - (buffer.byteLength % BYTES_PER_SAMPLE);
  return new Int16Array(buffer.slice(0, usable));
}
