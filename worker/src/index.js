// Chiki Worker: authorize direct conversations and store normalized progress.
import { DurableObject } from 'cloudflare:workers';
import {
  TOPIC_IDS, progressEvent, progressSnapshot, recordProgress, verifyElevenLabsSignature,
} from './progress.mjs';
import { missingSessionSecrets, parseDailyCap } from './session.mjs';

// KV can't do this: its read cache serves stale counts for ~60s, so a burst
// blows straight past the cap. One DO instance = strongly consistent counter.
export class SessionCounter extends DurableObject {
  async bump(day, cap, now) {
    const s = (await this.ctx.storage.get('s')) || {};
    const used = s.day === day ? s.used : 0;
    if (used >= cap) return { allowed: false };
    await this.ctx.storage.put('s', { day, used: used + 1, lastSeen: now });
    return { allowed: true, previousSeen: s.lastSeen || 0 };
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
}
const DAY_MS = 86_400_000;
const ADVENTURE_IDS = TOPIC_IDS.slice(0, 10);
const ADVENTURES = [
  ['החלל', [
    'מצא שלושה דברים עגולים שנראים כמו כוכבי לכת.',
    'בנה טיל קטן מקוביות או מחפצים בטוחים.',
    'עם מבוגר, הביטו בשמיים אחרי החשכה ומצאו נקודת אור.',
    'בדוק איך הצל משתנה כשמזיזים פנס סביב כדור.',
    'קפוץ בעדינות ודמיין שכוח המשיכה חלש כמו בירח.',
    'שאל מבוגר איזו שאלה עדיין מסקרנת אותו על החלל.',
    'צייר בית שמתאים ליצור שחי בכוכב אחר.',
  ]],
  ['הג׳ונגל', [
    'מצא שלושה עלים שונים בלי לקטוף אותם.',
    'עם מבוגר, הקשב בחוץ לשלושה קולות של בעלי חיים.',
    'נסה לנוע כמו קוף, צפרדע ונמר.',
    'מצא בבית שלושה דגמים שנראים כמו פרווה או קשקשים.',
    'בנה מחסה קטן ובטוח לחיית צעצוע.',
    'שאל מבוגר איזו חיית בר הוא היה רוצה לפגוש.',
    'המצא חיית ג׳ונגל חדשה ותן לה שם.',
  ]],
  ['בלשים', [
    'בחר חפץ והסתכל עליו חצי דקה כדי למצוא פרט חדש.',
    'מצא בבית שלושה דברים שמתחילים באותו צבע.',
    'נסה לזהות חפץ בטוח רק לפי הצל שלו.',
    'הקשב בעיניים עצומות ונחש מאיפה מגיע כל קול.',
    'סדר שלושה חפצים ושנה דבר אחד כדי שמישהו יגלה מה השתנה.',
    'שאל מבוגר על תעלומה אמיתית שהוא פתר פעם.',
    'המצא תעלומה קטנה לצ׳יקי וחזור לספר את הרמזים.',
  ]],
  ['האוקיינוסים', [
    'מצא בבית שלושה דברים בצבעי ים.',
    'צייר יצור ימי שעוד לא קיים.',
    'עם מבוגר וקערת מים, בדוק שני חפצים שצפים או שוקעים.',
    'זוז כמו מדוזה, סרטן ודולפין.',
    'בנה צוללת קטנה מקוביות.',
    'שאל מבוגר מה היצור הכי מוזר שהוא מכיר בים.',
    'המצא דרך לעזור לשמור על הים נקי.',
  ]],
  ['הדינוזאורים', [
    'צעד בחדר ודמיין כמה צעדים היה עושה דינוזאור ענקי.',
    'בנה דינוזאור מקוביות ותן לו יכולת מפתיעה.',
    'מצא שלושה דברים שמזכירים שן, טופר או קשקש.',
    'צור עקבה של דינוזאור מבצק משחק או מציור.',
    'נחש אילו מאכלים בבית דינוזאור צמחוני היה בוחר.',
    'שאל מבוגר איזה דינוזאור הוא הכי אוהב ולמה.',
    'המצא דינוזאור חדש ותן לו שם מדעי מצחיק.',
  ]],
  ['ממציאים', [
    'בחר חפץ יומיומי והמצא לו שיפור אחד.',
    'בנה גשר קטן מקוביות ובדוק מה הוא יכול לשאת.',
    'עם מבוגר, מצא שני דברים שמגנט מושך ושניים שלא.',
    'מצא מכונה בבית ונחש מה כל חלק שלה עושה בלי לפתוח אותה.',
    'בנה כלי שמזיז כדור בלי לגעת בו ביד.',
    'שאל מבוגר איזו המצאה הוא היה רוצה שתהיה בעולם.',
    'צייר המצאה שעוזרת לבעלי חיים.',
  ]],
  ['גוף האדם', [
    'הרגש את הדופק לפני ואחרי עשר קפיצות עדינות.',
    'נסה לעמוד על רגל אחת וספור כמה שניות.',
    'עצום עיניים ונחש שלושה חפצים בטוחים לפי המגע.',
    'הקשב לנשימה שלך ונסה נשימה איטית אחת.',
    'בדוק אילו תנועות אפשר לעשות רק עם אצבע אחת.',
    'שאל מבוגר איזה חוש עוזר לו הכי הרבה ביום.',
    'צייר גיבור־על שכוחו הוא אחד מחמשת החושים.',
  ]],
  ['מצרים העתיקה', [
    'בנה פירמידה קטנה מקוביות.',
    'המצא ציור־סמל לשלוש מילים פשוטות.',
    'מצא בבית שלוש צורות משולשות.',
    'עטוף חיית צעצוע בנייר כמו אוצר עתיק, בלי דבק עליה.',
    'צייר מפה דמיונית של אוצר ליד הנילוס.',
    'שאל מבוגר מה הוא היה לוקח למסע במדבר.',
    'המצא חידה ששומר ספינקס יכול לשאול.',
  ]],
  ['עולם החרקים', [
    'עם מבוגר, חפש חרק בחוץ והסתכל בלי לגעת בו.',
    'זוז כמו נמלה, פרפר וחיפושית.',
    'מצא בבית שלושה דברים עם דוגמה סימטרית כמו כנפיים.',
    'בנה בית קטן לחרק דמיוני מקוביות.',
    'ספור כמה רגליים יש לשלושה צעצועי חיות שונים.',
    'שאל מבוגר איזה חרק הוא הכי מעניין לדעתו.',
    'המצא חרק חדש ותאר את כוח־העל שלו.',
  ]],
  ['מזג האוויר', [
    'הסתכל מהחלון ותאר את השמיים בשלוש מילים.',
    'הכין שבשבת נייר פשוטה יחד עם מבוגר.',
    'מצא בבית משהו חם, קר ובטמפרטורת החדר בלי לגעת בדבר מסוכן.',
    'הסתכל על צל במקום בטוח וחזור לבדוק אותו מאוחר יותר.',
    'הקשב לרוח ונסה לגלות במה היא מזיזה.',
    'שאל מבוגר מה מזג האוויר הכי מוזר שהוא זוכר.',
    'המצא תחזית מצחיקה לכוכב אחר.',
  ]],
];

function adventureFor(now, previousSeen) {
  const day = Math.floor(now / DAY_MS);
  const sundayWeek = Math.floor((day + 4) / 7);
  const dayOfWeek = (day + 4) % 7;
  const adventureIndex = sundayWeek % ADVENTURES.length;
  const [weeklyTheme, missions] = ADVENTURES[adventureIndex];
  const returnLine = !previousSeen
    ? 'היי! אני צ׳יקי, חבר ההרפתקאות שלך.'
    : now - previousSeen >= 7 * DAY_MS
      ? 'איזה כיף שחזרת! מה קרה בעולם מאז שדיברנו?'
      : 'היי! איזה כיף לשמוע אותך שוב.';
  return {
    weekly_theme: weeklyTheme,
    weekly_theme_id: ADVENTURE_IDS[adventureIndex],
    today_mission: missions[dayOfWeek],
    return_line: returnLine,
  };
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

    const su = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(env.ELEVEN_AGENT_ID)}`,
      { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } },
    );
    if (!su.ok) return upstreamFail('signed-url', su);
    const signedUrl = (await su.json()).signed_url;
    if (typeof signedUrl !== 'string' || !signedUrl) {
      console.log('[kidbot] signed-url response missing signed_url');
      return json({ error: 'upstream unavailable' }, 502);
    }
    return json({
      signed_url: signedUrl,
      dynamic_variables: {
        ...adventureFor(now, session.previousSeen),
        progress_enabled: url.searchParams.get('progress') !== '0',
      },
    });
  }

  return new Response('not found', { status: 404 });
}
