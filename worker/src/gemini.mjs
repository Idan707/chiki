// Thin Gemini REST client. Isolated so the conversation logic in talk.mjs and
// the socket plumbing in index.js both stay testable without network mocking.
//
// The key travels in a header, never a query string, so it cannot land in an
// access log or a redirect.

const HOST = 'https://generativelanguage.googleapis.com/v1beta';

// Upstream can stop answering entirely rather than returning an error - a
// direct call was observed hanging 99s with no bytes. Without a deadline the
// socket hangs with it and the child is left staring at a silent toy.
export const ANSWER_TIMEOUT_MS = 15_000;
export const SPEECH_TIMEOUT_MS = 25_000;

async function call(key, model, method, body, timeoutMs) {
  let res;
  try {
    res = await fetch(`${HOST}/models/${model}:${method}`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = new Error(`gemini ${method} unreachable`);
    err.detail = String(e);
    err.timeout = true;
    throw err;
  }
  if (!res.ok) {
    // Detail goes to the server log only; callers surface something generic.
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const err = new Error(`gemini ${method} ${res.status}`);
    err.detail = detail;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** One conversational turn: audio in, text (and maybe a tool call) out. */
export function generate(key, model, body, timeoutMs = ANSWER_TIMEOUT_MS) {
  return call(key, model, 'generateContent', body, timeoutMs);
}

/**
 * Synthesize Hebrew. Returns { pcm: ArrayBuffer, rate } — Gemini answers at
 * 24 kHz, and the caller resamples to the 16 kHz the codec runs at.
 */
export async function synthesize(key, model, body) {
  const res = await call(key, model, 'generateContent', body, SPEECH_TIMEOUT_MS);
  const part = res?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) {
    const err = new Error('gemini tts returned no audio');
    err.detail = JSON.stringify(res).slice(0, 300);
    throw err;
  }
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1]) || 24000;
  return { pcm: base64ToBytes(part.inlineData.data).buffer, rate };
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const STEP = 0x8000;                      // avoid blowing the argument limit
  for (let i = 0; i < view.length; i += STEP) {
    bin += String.fromCharCode(...view.subarray(i, i + STEP));
  }
  return btoa(bin);
}
