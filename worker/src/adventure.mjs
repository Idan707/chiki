// Curated weekly adventures and the per-session opening line. Pure module with no
// `cloudflare:workers` import so `node --test` can exercise it directly.
import { TOPIC_IDS } from './progress.mjs';

const DAY_MS = 86_400_000;
const ADVENTURE_IDS = TOPIC_IDS.slice(0, 10);
export const ADVENTURES = [
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

// A tap inside RESUME_MS is treated as an accidental end-and-retap: the child only
// wanted to keep talking, so the opener must not replay the whole pitch.
export const RESUME_MS = 3 * 60_000;
export const RETURN_SOON_MS = 12 * 60 * 60_000;

const THEME_NAMES = Object.fromEntries(ADVENTURE_IDS.map((id, i) => [id, ADVENTURES[i][0]]));

// '' for unknown ids, including 'other', so the opener never names a topic it cannot.
export function themeName(topicId) {
  return THEME_NAMES[topicId] || '';
}

export function sessionTier(now, previousSeen) {
  if (!previousSeen) return 'return_later';
  const elapsed = now - previousSeen;
  if (elapsed < RESUME_MS) return 'resume';
  if (elapsed < RETURN_SOON_MS) return 'return_soon';
  return 'return_later';
}

// The child's name is deliberately absent: the agent prompt already carries it, and
// leaving it out keeps child PII off the Worker entirely.
export function openingLine({ tier, lastTopicHe, altTheme, weeklyTheme, mission }) {
  if (tier === 'resume') return 'אני כאן. על מה נמשיך?';
  if (tier === 'return_soon') {
    return lastTopicHe
      ? `היי! רוצה להמשיך עם ${lastTopicHe}, או לנסות משהו אחר — ${altTheme}?`
      : `היי! על מה בא לך לדבר עכשיו — ${altTheme}, או משהו אחר שמסקרן אותך?`;
  }
  return lastTopicHe
    ? `היי! איזה כיף שחזרת. בפעם הקודמת חקרנו את ${lastTopicHe} — רוצה להמשיך משם, או לנסות את ${weeklyTheme}? יש לי רעיון קטן: ${mission}`
    : `היי! אני צ׳יקי, חבר ההרפתקאות שלך. נושא ההרפתקה שלנו השבוע הוא ${weeklyTheme}. יש לי רעיון קטן: ${mission} בא לך לנסות, או לספר לי מה מסקרן אותך היום?`;
}

export function adventureFor(now, previousSeen, sessionOrdinal = 0, lastTopicId = '') {
  const day = Math.floor(now / DAY_MS);
  const sundayWeek = Math.floor((day + 4) / 7);
  const dayOfWeek = (day + 4) % 7;
  const adventureIndex = sundayWeek % ADVENTURES.length;
  const [weeklyTheme, missions] = ADVENTURES[adventureIndex];
  const ordinal = Number.isInteger(sessionOrdinal) && sessionOrdinal > 0 ? sessionOrdinal : 0;

  // Rotate the mission per session so repeated taps in one day never sound identical.
  const mission = missions[(dayOfWeek + ordinal) % missions.length];

  // Offer an alternative that is neither this week's theme nor the one just explored.
  let altIndex = (adventureIndex + 1 + ordinal) % ADVENTURES.length;
  for (let i = 0; i < ADVENTURES.length &&
      (altIndex === adventureIndex || ADVENTURE_IDS[altIndex] === lastTopicId); i++) {
    altIndex = (altIndex + 1) % ADVENTURES.length;
  }

  const lastTopicHe = themeName(lastTopicId);
  return {
    weekly_theme: weeklyTheme,
    weekly_theme_id: ADVENTURE_IDS[adventureIndex],
    today_mission: mission,
    last_topic: lastTopicHe,
    opening_line: openingLine({
      tier: sessionTier(now, previousSeen),
      lastTopicHe,
      altTheme: ADVENTURES[altIndex][0],
      weeklyTheme,
      mission,
    }),
  };
}
