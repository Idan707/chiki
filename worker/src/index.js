// Chiki Worker: run the conversation, screen every reply before it is spoken,
// and store deliberately tiny progress.
import { DurableObject } from 'cloudflare:workers';
import {
  progressEvent, progressSnapshot, recordProgress, verifyElevenLabsSignature,
} from './progress.mjs';
import { adventureFor } from './adventure.mjs';
import { missingSessionSecrets, parseDailyCap } from './session.mjs';
import { Resampler, TurnDetector, toInt16 } from './audio.mjs';
import {
  RETRY_LINE, TEXT_MODEL, TTS_MODEL, appendTurn, readTopic, screenReply, speechRequest,
  splitForSpeech, systemPrompt, topicRequest, turnRequest,
} from './talk.mjs';
import { bytesToBase64, generate, synthesize } from './gemini.mjs';

const TICKET_TTL_MS = 60_000;      // a ticket is for one tap, taken once
const SPEAK_FRAME = 8192;          // bytes per outbound audio frame, ~256ms
const MAX_SESSION_MS = 300_000;    // mirrors the agent cap; idle time is money

// KV can't do this: its read cache serves stale counts for ~60s, so a burst
// blows straight past the cap. One DO instance = strongly consistent counter.
export class SessionCounter extends DurableObject {
  async bump(day, cap, now) {
    const s = (await this.ctx.storage.get('s')) || {};
    const used = s.day === day ? s.used : 0;
    if (used >= cap) return { allowed: false };
    await this.ctx.storage.put('s', { ...s, day, used: used + 1, lastSeen: now });
    // latestTopic reflects what was actually explored (webhook-fed); lastTheme is what
    // we last offered, and stands in until the first post-call webhook lands.
    const progress = await this.ctx.storage.get('progress');
    return {
      allowed: true,
      previousSeen: s.lastSeen || 0,
      used: used + 1,
      lastTheme: s.lastTheme || '',
      latestTopic: progress?.latest_topic || '',
    };
  }

  async rememberTheme(themeId) {
    const s = (await this.ctx.storage.get('s')) || {};
    if (s.lastTheme === themeId) return;
    await this.ctx.storage.put('s', { ...s, lastTheme: themeId });
  }

  async progress(now) {
    return progressSnapshot(await this.ctx.storage.get('progress'), now);
  }

  async recordProgress(conversationId, timestamp, topics) {
    const previous = await this.ctx.storage.get('progress');
    const result = recordProgress(previous, conversationId, timestamp, topics);
    if (!result.duplicate) await this.ctx.storage.put('progress', result.state);
    return { changed: result.changed, duplicate: result.duplicate, revision: result.state.revision || 0 };
  }

  // --- conversation ------------------------------------------------------

  async mintTicket(adventure, progressEnabled, now) {
    const ticket = crypto.randomUUID();
    await this.ctx.storage.put(`t:${ticket}`,
      { adventure, progressEnabled, expires: now + TICKET_TTL_MS });
    return ticket;
  }

  /** Upgrade to a WebSocket and run one conversation. */
  async fetch(request) {
    const url = new URL(request.url);
    const ticket = url.searchParams.get('t') || '';
    const record = ticket ? await this.ctx.storage.get(`t:${ticket}`) : null;
    // Single use: the ticket is spent whether or not it turns out to be valid.
    if (ticket) await this.ctx.storage.delete(`t:${ticket}`);
    if (!record || record.expires < Date.now()) {
      return new Response('bad ticket', { status: 401 });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    // Without this the runtime hands binary frames over as Blob, whose
    // byteLength is undefined - every frame silently becomes an empty buffer
    // and the child is never heard.
    server.binaryType = 'arraybuffer';
    this.ctx.waitUntil(this.#converse(server, record.adventure,
                                      record.progressEnabled !== false));
    return new Response(null, { status: 101, webSocket: client });
  }

  async #converse(ws, adventure, progressEnabled) {
    const env = this.env;
    const child = {
      name: env.CHILD_NAME || '', age: env.CHILD_AGE || '5',
      form: env.CHILD_GRAMMATICAL_FORM || 'masculine',
    };
    const system = systemPrompt(child, adventure);
    const detector = new TurnDetector();
    const id = crypto.randomUUID();
    // History lives only for this session and is never written to storage.
    let history = [];
    let odd = new Uint8Array(0);      // carried half-sample between frames
    let busy = true;      // ignore device audio until the greeting is done
    const deadline = Date.now() + MAX_SESSION_MS;

    const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* closed */ } };
    const bye = (why) => { send({ t: 'bye', why }); try { ws.close(1000, why); } catch { /* closed */ } };

    ws.addEventListener('close', () => { detector.reset(); history = []; });
    ws.addEventListener('error', () => { history = []; });

    // Attach before the first await. Frames that arrive while the socket has no
    // message listener are dropped, and synthesizing the greeting takes seconds
    // - long enough to silently swallow the child's first words.
    ws.addEventListener('message', async (event) => {
      if (typeof event.data === 'string') return;       // device sends no control
      if (Date.now() > deadline) return bye('time');
      // While Chiki is answering, the device is not listening; ignore late frames
      // rather than queueing a turn nobody is waiting for.
      if (busy) return;
      if (!(event.data instanceof ArrayBuffer)) {
        console.log(`[chiki] unexpected frame type ${event.data?.constructor?.name}`);
        return;
      }

      const joined = new Uint8Array(odd.length + event.data.byteLength);
      joined.set(odd, 0);
      joined.set(new Uint8Array(event.data), odd.length);
      const usable = joined.length - (joined.length % 2);
      odd = joined.subarray(usable);
      if (detector.push(toInt16(joined.buffer.slice(0, usable))) !== 'end') return;

      busy = true;
      try {
        const utterance = detector.take();
        send({ t: 'thinking' });
        const reply = await this.#answer(system, history, utterance);
        history = appendTurn(history, 'child', '(audio)');
        history = appendTurn(history, 'agent', reply.speak);
        await this.#say(ws, reply.speak, { blocked: reply.blocked });
        // Host tests pass progress=0 and must never touch the map. This runs
        // after the child has been answered, so it costs them nothing.
        if (progressEnabled && !reply.blocked) {
          this.ctx.waitUntil(this.#noteTopic(id, history));
        }
      } catch (e) {
        console.log(`[chiki] turn failed: ${e} ${e.detail || ''}`);
        // Recoverable: say something ordinary and keep the floor open rather
        // than hanging up on a child who did nothing wrong.
        await this.#say(ws, RETRY_LINE, { blocked: false });
      } finally {
        busy = false;
      }
    });

    send({ t: 'ready', id });
    await this.#say(ws, adventure.opening_line, { first: true });
    history = appendTurn(history, 'agent', adventure.opening_line);
    busy = false;                          // the child has the floor now
  }

  /** Second call, off the reply path: an enum id or nothing. */
  async #noteTopic(id, history) {
    try {
      const res = await generate(this.env.GEMINI_API_KEY, TEXT_MODEL, topicRequest(history));
      const topic = readTopic(res);
      if (topic) await this.recordProgress(id, Date.now(), [topic]);
    } catch (e) {
      console.log(`[chiki] topic extraction failed: ${e}`);
    }
  }

  async #answer(system, history, utterance) {
    const t0 = Date.now();
    const body = turnRequest({
      system, history,
      audio: bytesToBase64(new Uint8Array(utterance.buffer, 0, utterance.byteLength)),
    });
    const response = await generate(this.env.GEMINI_API_KEY, TEXT_MODEL, body);
    console.log(`[chiki] answer ${Date.now() - t0}ms finish=${response?.candidates?.[0]?.finishReason}`
      + ` thoughts=${response?.usageMetadata?.thoughtsTokenCount || 0}`);
    const screened = screenReply(response);
    if (screened.blocked) console.log(`[chiki] reply blocked: ${screened.reason}`);
    return screened;
  }

  /**
   * Synthesize, resample to the codec's 16 kHz, and stream it out.
   *
   * Synthesis is the slowest stage and scales with length, so the opening
   * sentence is synthesized and sent on its own while the rest is still being
   * generated. The child hears Chiki start talking seconds sooner.
   */
  async #say(ws, text, { blocked = false, first = false } = {}) {
    const chunks = splitForSpeech(text);
    ws.send(JSON.stringify({ t: 'speaking', text, blocked, first }));
    for (const chunk of chunks) {
      const t0 = Date.now();
      let audio;
      try {
        audio = await synthesize(this.env.GEMINI_API_KEY, TTS_MODEL, speechRequest(chunk));
      } catch (e) {
        console.log(`[chiki] tts failed: ${e} ${e.detail || ''}`);
        break;
      }
      console.log(`[chiki] tts ${Date.now() - t0}ms for ${chunk.length} chars`);
      const pcm = new Resampler(audio.rate).push(new Int16Array(audio.pcm));
      const bytes = new Uint8Array(pcm.buffer, 0, pcm.byteLength);
      for (let i = 0; i < bytes.length; i += SPEAK_FRAME) {
        try { ws.send(bytes.subarray(i, i + SPEAK_FRAME)); } catch { return; }
      }
    }
    try { ws.send(JSON.stringify({ t: 'done' })); } catch { /* closed */ }
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

async function upstreamFail(stage, res) {
  const detail = (await res.text().catch(() => '')).slice(0, 500);
  console.log(`[kidbot] ${stage} failed: ${res.status} ${detail}`);
  return json({ error: 'upstream unavailable' }, 502);
}

function tokenOk(header, secret) {
  if (!secret) return false;
  const enc = new TextEncoder();
  const a = enc.encode(header || '');
  const b = enc.encode(`Bearer ${secret}`);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

async function boundedText(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      console.log(`[kidbot] unhandled: ${e}`);
      return json({ error: 'internal' }, 500);
    }
  },
};

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/') return new Response('ok');

  if (request.method === 'POST' && url.pathname === '/webhooks/elevenlabs') {
    if (!env.ELEVEN_WEBHOOK_SECRET) {
      console.log('[kidbot] ELEVEN_WEBHOOK_SECRET is missing');
      return json({ error: 'service unavailable' }, 503);
    }
    const raw = await boundedText(request, 2 * 1024 * 1024);
    if (raw === null) return json({ error: 'too large' }, 413);
    if (!await verifyElevenLabsSignature(
      raw, request.headers.get('ElevenLabs-Signature'), env.ELEVEN_WEBHOOK_SECRET))
      return json({ error: 'bad signature' }, 401);

    let event;
    try { event = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
    const progress = progressEvent(event, env.ELEVEN_AGENT_ID);
    if (!progress) return json({ status: 'ignored' }, 200);
    const counter = env.COUNTER.get(env.COUNTER.idFromName('device'));
    return json({ status: 'ok', ...await counter.recordProgress(
      progress.conversationId, progress.timestampMs, progress.topics) }, 200);
  }

  // The conversation socket. Authorization is the single-use ticket minted by
  // /session, which the Durable Object validates and spends; the bearer token
  // is not repeated here because a wss URL is all the device can carry.
  if (url.pathname === '/talk') {
    const counter = env.COUNTER.get(env.COUNTER.idFromName('device'));
    return counter.fetch(request);
  }

  if (request.method === 'GET' && url.pathname === '/progress') {
    if (!env.DEVICE_TOKEN) {
      console.log('[kidbot] DEVICE_TOKEN is missing');
      return json({ error: 'service unavailable' }, 503);
    }
    if (!tokenOk(request.headers.get('Authorization'), env.DEVICE_TOKEN))
      return json({ error: 'unauthorized' }, 401);
    const counter = env.COUNTER.get(env.COUNTER.idFromName('device'));
    return json(await counter.progress(Date.now()), 200);
  }

  if (request.method === 'GET' && url.pathname === '/session') {
    const missing = missingSessionSecrets(env);
    if (missing.length) {
      console.log(`[kidbot] session secrets missing: ${missing.join(',')}`);
      return json({ error: 'service unavailable' }, 503);
    }
    if (!tokenOk(request.headers.get('Authorization'), env.DEVICE_TOKEN))
      return json({ error: 'unauthorized' }, 401);

    const cap = parseDailyCap(env.SESSION_DAILY_CAP);
    if (cap === null) {
      console.log('[kidbot] SESSION_DAILY_CAP must be a positive integer');
      return json({ error: 'service unavailable' }, 503);
    }

    // The strongly consistent counter bounds minute drain if a token leaks.
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const counter = env.COUNTER.get(env.COUNTER.idFromName('device'));
    const session = await counter.bump(day, cap, now);
    if (!session.allowed) return json({ error: 'daily cap' }, 429);

    const adventure = adventureFor(
      now, session.previousSeen, session.used, session.latestTopic || session.lastTheme,
    );
    await counter.rememberTheme(adventure.weekly_theme_id);

    // v2 devices talk to us; older firmware still expects an ElevenLabs signed
    // URL. Both paths stay live until the new firmware is verified on hardware,
    // because there is no OTA and a bad deploy means a cable and a rebuild.
    let signedUrl;
    if (url.searchParams.get('v') === '2') {
      if (!env.GEMINI_API_KEY) {
        console.log('[chiki] GEMINI_API_KEY is missing');
        return json({ error: 'service unavailable' }, 503);
      }
      const ticket = await counter.mintTicket(
        adventure, url.searchParams.get('progress') !== '0', now);
      signedUrl = `wss://${url.host}/talk?t=${ticket}`;
    } else {
      const su = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(env.ELEVEN_AGENT_ID)}`,
        { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } },
      );
      if (!su.ok) return upstreamFail('signed-url', su);
      signedUrl = (await su.json()).signed_url;
      if (typeof signedUrl !== 'string' || !signedUrl) {
        console.log('[kidbot] signed-url response missing signed_url');
        return json({ error: 'upstream unavailable' }, 502);
      }
    }
    return json({
      signed_url: signedUrl,
      dynamic_variables: {
        ...adventure,
        progress_enabled: url.searchParams.get('progress') !== '0',
      },
    });
  }

  return new Response('not found', { status: 404 });
}
