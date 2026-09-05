// Chiki Worker: authorize direct conversations and store normalized progress.
import { DurableObject } from 'cloudflare:workers';
import {
  progressEvent, progressSnapshot, pruneProgress, recordProgress, verifyElevenLabsSignature,
} from './progress.mjs';
import { adventureFor } from './adventure.mjs';
import { missingSessionSecrets, parseDailyCap } from './session.mjs';

// KV can't do this: its read cache serves stale counts for ~60s, so a burst
// blows straight past the cap. One DO instance = strongly consistent counter.
export class SessionCounter extends DurableObject {
  async bump(day, cap, now) {
    const s = (await this.ctx.storage.get('s')) || {};
    const used = s.day === day ? s.used : 0;
    if (used >= cap) return { allowed: false };
    await this.ctx.storage.put('s', { ...s, day, used: used + 1, lastSeen: now });
    // Only a completed, substantive exchange can supply a remembered topic.
    const progress = await this.ctx.storage.get('progress');
    return {
      allowed: true,
      previousSeen: s.lastSeen || 0,
      used: used + 1,
      latestTopic: progress?.latest_topic || '',
    };
  }

  async progress(now) {
    return progressSnapshot(await this.ctx.storage.get('progress'), now);
  }

  async recordProgress(conversationId, timestamp, topics) {
    const previous = await this.ctx.storage.get('progress');
    const result = recordProgress(previous, conversationId, timestamp, topics, Date.now());
    if (!result.duplicate) await this.ctx.storage.put('progress', result.state);
    if (await this.ctx.storage.getAlarm() === null)
      await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
    return { changed: result.changed, duplicate: result.duplicate, revision: result.state.revision || 0 };
  }

  async alarm() {
    const state = pruneProgress(await this.ctx.storage.get('progress'), Date.now());
    await this.ctx.storage.put('progress', state);
    if (Object.keys(state.days).length || Object.keys(state.seen).length)
      await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
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
  // Upstream bodies can echo identifiers, prompts, or signed credentials.
  console.log(`[chiki] ${stage} failed: HTTP ${res.status}`);
  await res.body?.cancel();
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
    } catch {
      console.log('[chiki] request failed');
      return json({ error: 'internal' }, 500);
    }
  },
};

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/') return new Response('ok');

  if (request.method === 'POST' && url.pathname === '/webhooks/elevenlabs') {
    if (!env.ELEVEN_WEBHOOK_SECRET?.trim() || !env.ELEVEN_AGENT_ID?.trim()) {
      console.log('[chiki] webhook configuration missing');
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

    // This caps signed-URL issuance, not reuse or total billed minutes.
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const counter = env.COUNTER.get(env.COUNTER.idFromName('device'));
    const session = await counter.bump(day, cap, now);
    if (!session.allowed) return json({ error: 'daily cap' }, 429);

    const su = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(env.ELEVEN_AGENT_ID)}`,
      { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(8000) },
    );
    if (!su.ok) return upstreamFail('signed-url', su);
    const signedUrl = (await su.json()).signed_url;
    if (typeof signedUrl !== 'string' || !signedUrl.startsWith('wss://')) {
      console.log('[kidbot] signed-url response missing signed_url');
      return json({ error: 'upstream unavailable' }, 502);
    }
    const adventure = adventureFor(
      now, session.previousSeen, session.used, session.latestTopic,
    );
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
