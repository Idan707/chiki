// Google Cloud Text-to-Speech, authenticated with a service account.
//
// Cloud TTS rejects API keys, so this mints a signed JWT and exchanges it for
// an access token. Measured against Gemini TTS on the same Hebrew line it is
// 4-5x faster (0.7s vs ~4.5s for a short reply), which is the difference
// between a toy that answers and one a five-year-old gives up on. It also
// returns 16 kHz LINEAR16 directly, the rate the codec runs at, so nothing
// needs resampling.

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const TOKEN_TIMEOUT_MS = 10_000;
const SPEAK_TIMEOUT_MS = 15_000;

export const DEFAULT_VOICE = 'he-IL-Chirp3-HD-Achernar';
export const LANGUAGE = 'he-IL';
export const RATE = 16000;

/** WAV from Cloud TTS carries a 44-byte RIFF header before the samples. */
export const WAV_HEADER_BYTES = 44;

const enc = new TextEncoder();
let cachedToken = null;   // per isolate; a DO handles one conversation at a time

export function b64url(bytes) {
  const view = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
  let bin = '';
  for (let i = 0; i < view.length; i += 0x8000) {
    bin += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PEM private key -> DER bytes for crypto.subtle.importKey. */
export function pemToDer(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function parseServiceAccount(raw) {
  const sa = typeof raw === 'string' ? JSON.parse(raw) : raw;
  for (const field of ['client_email', 'private_key', 'token_uri']) {
    if (!sa?.[field]) throw new Error(`service account missing ${field}`);
  }
  return sa;
}

/** Cached until a minute before expiry; a mint costs a round trip. */
export async function accessToken(raw, now = Date.now()) {
  if (cachedToken && cachedToken.expires > now) return cachedToken.token;
  const sa = parseServiceAccount(raw);
  const iat = Math.floor(now / 1000);
  const signing = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}`
    + `.${b64url(JSON.stringify({
      iss: sa.client_email, scope: SCOPE, aud: sa.token_uri, iat, exp: iat + 3600,
    }))}`;

  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(signing));

  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signing}.${b64url(new Uint8Array(sig))}`,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`gcp token ${res.status}`);
    err.detail = (await res.text().catch(() => '')).slice(0, 200);
    throw err;
  }
  const data = await res.json();
  cachedToken = { token: data.access_token, expires: now + (data.expires_in - 60) * 1000 };
  return cachedToken.token;
}

export function speechBody(text, voice = DEFAULT_VOICE) {
  return {
    input: { text },
    voice: { languageCode: LANGUAGE, name: voice },
    // 16 kHz LINEAR16 is exactly what the ES8311 plays, so no resampling.
    audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: RATE },
  };
}

/** Synthesize Hebrew. Returns Int16Array of 16 kHz mono PCM, header stripped. */
export async function speak(raw, text, voice = DEFAULT_VOICE) {
  const token = await accessToken(raw);
  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(speechBody(text, voice)),
    signal: AbortSignal.timeout(SPEAK_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`gcp tts ${res.status}`);
    err.detail = (await res.text().catch(() => '')).slice(0, 200);
    throw err;
  }
  const { audioContent } = await res.json();
  if (!audioContent) throw new Error('gcp tts returned no audio');

  const bin = atob(audioContent);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = bytes.subarray(WAV_HEADER_BYTES);
  // Copy rather than view: the subarray is offset and Int16Array needs alignment.
  return new Int16Array(pcm.slice().buffer);
}

/** Test seam: forget the cached token. */
export function resetTokenCache() { cachedToken = null; }
