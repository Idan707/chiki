export const TOPIC_IDS = [
  'space', 'jungle', 'detectives', 'oceans', 'dinosaurs', 'inventors',
  'human_body', 'ancient_egypt', 'insects', 'weather', 'other',
];

const TOPIC_SET = new Set(TOPIC_IDS);
const DAY_MS = 86_400_000;
const SEEN_MS = 2 * DAY_MS;

export function normalizeTopics(value) {
  if (value && typeof value === 'object')
    value = value.value ?? value.result ?? value.data_collection_result ?? '';
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(',').map((v) => v.trim()).filter((v) => TOPIC_SET.has(v)))].slice(0, 3);
}

export function hasSubstantiveExchange(transcript) {
  if (!Array.isArray(transcript)) return false;
  const greetings = new Set(['היי', 'הי', 'שלום', 'ביי', 'hello', 'hi', 'hey', 'bye']);
  const refusal = /לא (?:יכול|אוכל) לעזור|מבוגר אחראי|מצב חירום/;
  for (let i = 0; i < transcript.length; i++) {
    const user = transcript[i];
    const message = typeof user?.message === 'string' ? user.message.trim() : '';
    const plain = message.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (user?.role !== 'user' || plain.length < 4 || greetings.has(plain)) continue;
    if (transcript.slice(i + 1).some((turn) => turn?.role === 'agent' &&
      typeof turn.message === 'string' && turn.message.trim().length >= 20 && !refusal.test(turn.message)))
      return true;
  }
  return false;
}

export function progressEvent(event, agentId, nowMs = Date.now()) {
  const data = event?.data;
  if (!agentId || event?.type !== 'post_call_transcription' || data?.agent_id !== agentId ||
      data?.status !== 'done' || typeof data?.conversation_id !== 'string' ||
      !data.conversation_id || data.conversation_id.length > 128) return null;
  const dynamic = data.conversation_initiation_client_data?.dynamic_variables || {};
  if (dynamic.progress_enabled !== true && dynamic.progress_enabled !== 'true') return null;
  if (!hasSubstantiveExchange(data.transcript)) return null;
  const topics = normalizeTopics(data.analysis?.data_collection_results?.explored_topics);
  const timestampMs = Number(data.metadata?.start_time_unix_secs || event.event_timestamp) * 1000;
  return topics.length && Number.isSafeInteger(timestampMs) &&
    timestampMs > 0 && timestampMs >= nowMs - SEEN_MS && timestampMs <= nowMs + 300_000
    ? { conversationId: data.conversation_id, timestampMs, topics }
    : null;
}

export function jerusalemDay(timestampMs) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestampMs));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function dayNumber(key) {
  return Math.floor(Date.parse(`${key}T00:00:00Z`) / DAY_MS);
}

function dayKey(number) {
  return new Date(number * DAY_MS).toISOString().slice(0, 10);
}

export function pruneProgress(previous, nowMs) {
  const state = previous && typeof previous === 'object' ? structuredClone(previous) : {};
  state.days ||= {};
  state.seen ||= {};
  const today = jerusalemDay(nowMs);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const oldestDay = dayKey(dayNumber(today) - weekday - 11 * 7);
  for (const day of Object.keys(state.days)) {
    if (day < oldestDay) delete state.days[day];
  }
  for (const [id, seenAt] of Object.entries(state.seen)) {
    if (seenAt < nowMs - SEEN_MS) delete state.seen[id];
  }
  return state;
}

export function recordProgress(previous, conversationId, timestampMs, topics, nowMs = timestampMs) {
  const state = pruneProgress(previous, nowMs);
  state.revision ||= 0;
  state.days ||= {};
  state.lifetime_topics ||= [];
  state.lifetime_explorations ||= 0;
  state.seen ||= {};

  if (!conversationId || Object.hasOwn(state.seen, conversationId)) return { state, changed: false, duplicate: true };
  Object.defineProperty(state.seen, conversationId, {
    value: nowMs, enumerable: true, writable: true, configurable: true,
  });

  const valid = [...new Set(topics)].filter((topic) => TOPIC_SET.has(topic)).slice(0, 3);
  if (!valid.length) return { state, changed: false, duplicate: false };

  const key = jerusalemDay(timestampMs);
  const existing = new Set(state.days[key] || []);
  let changed = false;
  for (const topic of valid) {
    if (existing.has(topic)) continue;
    existing.add(topic);
    state.lifetime_explorations++;
    changed = true;
  }
  const latest = valid[valid.length - 1];
  if (state.latest_topic !== latest) changed = true;
  if (!changed) return { state, changed: false, duplicate: false };

  state.days[key] = [...existing];
  state.lifetime_topics = [...new Set([...state.lifetime_topics, ...valid])].filter((topic) => TOPIC_SET.has(topic));
  state.latest_topic = latest;
  state.revision++;
  return { state, changed: true, duplicate: false };
}

export function progressSnapshot(previous, timestampMs) {
  const state = previous || {};
  const today = jerusalemDay(timestampMs);
  const todayNumber = dayNumber(today);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const startNumber = todayNumber - weekday - 11 * 7;
  const days = Array.from({ length: 84 }, (_, i) =>
    Math.min(4, new Set(state.days?.[dayKey(startNumber + i)] || []).size));
  return {
    version: 1,
    revision: state.revision || 0,
    week_start: dayKey(startNumber),
    today_index: 77 + weekday,
    days,
    lifetime_topics: new Set(state.lifetime_topics || []).size,
    lifetime_explorations: state.lifetime_explorations || 0,
    latest_topic: TOPIC_SET.has(state.latest_topic) ? state.latest_topic : '',
  };
}

function hexBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g), (byte) => parseInt(byte, 16));
}

export async function verifyElevenLabsSignature(rawBody, signatureHeader, secret, nowMs = Date.now()) {
  if (!secret || !signatureHeader) return false;
  const fields = Object.fromEntries(signatureHeader.split(',').map((part) => part.trim().split('=', 2)));
  const timestamp = Number(fields.t);
  const signature = hexBytes(fields.v0 || '');
  if (!Number.isFinite(timestamp) || !signature || Math.abs(nowMs / 1000 - timestamp) > 300) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${timestamp}.${rawBody}`));
}
