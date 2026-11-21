// External data source: Hebcal.com (Jewish calendar API) - https://www.hebcal.com/home/developer-apis
// No API key is needed and the API sends `Access-Control-Allow-Origin: *`, so the browser calls it
// directly and the data is live (unlike Airtable, whose token must stay server-side).
// Responses are cached in localStorage for 12 hours to stay polite to the free service.
'use strict';
(function () {
  const API = 'https://www.hebcal.com';
  const HORIZON_DAYS = 150;
  const CACHE_KEY = 'bakery-logistics:hebcal:v1';
  const TTL = 12 * 3600e3;

  // Candle-lighting times depend on location, so each site is queried by its coordinates.
  const SITES = [
    { id: 'CW', lat: 32.0158, lon: 34.7874 },  // Holon production center
    { id: 'FLO', lat: 32.0570, lon: 34.7690 }, // Tel Aviv, Florentin
    { id: 'DIZ', lat: 32.0790, lon: 34.7740 }, // Tel Aviv, Dizengoff
    { id: 'RG', lat: 32.0823, lon: 34.8106 },  // Ramat Gan
    { id: 'HRZ', lat: 32.1624, lon: 34.8447 }, // Herzliya
  ];

  // What each holiday means for a bakery. First match wins; holidays without a rule are not shown.
  // kind: closed | demand | early | info
  const RULES = [
    { re: /^Chanukah/, group: 'חנוכה', kind: 'demand', label: 'ביקוש גבוה', action: 'להגדיל ייצור סופגניות, להזמין מראש שמן, ריבה וקמח, ולתגבר את קו הבוקר.' },
    { re: /^Purim$/, kind: 'demand', label: 'ביקוש גבוה', action: 'להוסיף אוזני המן ומארזי משלוח מנות, ולהגדיל את מלאי קופסאות העוגה.' },
    { re: /^Erev Rosh Hashana/, kind: 'demand', label: 'ביקוש גבוה', action: 'חלות עגולות ועוגות דבש. קו בוקר מוגדל וסגירה מוקדמת.' },
    { re: /^Erev (Yom Kippur|Sukkot|Pesach|Shavuot)/, kind: 'early', label: 'ערב חג', action: 'קו בוקר מוגדל, סגירה מוקדמת, בלי קו צהריים.' },
    { re: /^Pesach/, group: 'פסח', kind: 'closed', label: 'סגור · ללא חמץ', action: 'לרוקן את מלאי הקמח והשמרים בסניפים לפני החג. אין ייצור לחם.' },
    { re: /^Shavuot/, kind: 'demand', label: 'מוצרי חלב', action: 'להגדיל ייצור בורקס גבינה ועוגות גבינה, ומלאי גבינת שמנת.' },
    { re: /^(Rosh Hashana|Yom Kippur|Sukkot I$|Shmini Atzeret|Simchat Torah|Yom HaAtzma)/, kind: 'closed', label: 'סגור', action: 'הסניפים סגורים: לבטל משלוחים ולהקטין ייצור ביום שלפני.' },
    { re: /^Tu BiShvat/, kind: 'info', label: 'מכירה עונתית', action: 'עוגות פירות יבשים ותמרים.' },
    { subcat: 'fast', kind: 'info', label: 'יום צום', action: 'פחות מכירות בבוקר ועלייה אחרי השקיעה: להקטין את ייצור מאפי הבוקר.' },
  ];

  const pad = n => String(n).padStart(2, '0');
  const localISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Hebcal HTTP ${res.status}`);
    return res.json();
  }
  function readCache(today) {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return c && c.today === today && Date.now() - c.at < TTL ? c : null;
    } catch { return null; }
  }
  function writeCache(value) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)); } catch { /* storage blocked */ } }

  const ruleFor = item => RULES.find(r => (r.re && r.re.test(item.title)) || (r.subcat && item.subcat === r.subcat));

  // Turn Hebcal items into bakery events; consecutive days of one holiday (8 days of Chanukah) become one event.
  function buildEvents(items, today) {
    const events = [];
    for (const item of items) {
      const rule = ruleFor(item);
      if (!rule) continue;
      const date = item.date.slice(0, 10);
      const last = events[events.length - 1];
      if (rule.group && last && last.group === rule.group && daysBetween(last.end, date) <= 1) { last.end = date; continue; }
      events.push({ group: rule.group || null, title: rule.group || item.hebrew, start: date, end: date,
                    kind: rule.kind, label: rule.label, action: rule.action, inDays: daysBetween(today, date) });
    }
    return events;
  }

  async function load() {
    const now = new Date(), today = localISO(now);
    const cached = readCache(today);
    if (cached) return { ...cached.data, cached: true };
    const end = localISO(new Date(now.getTime() + HORIZON_DAYS * 864e5));
    const holidaysUrl = `${API}/hebcal?v=1&cfg=json&maj=on&min=on&mod=on&nx=off&ss=off&mf=on&c=off&s=off&i=on&lg=s&start=${today}&end=${end}`;
    const [holidays, ...shabbat] = await Promise.all([
      getJson(holidaysUrl),
      ...SITES.map(s => getJson(`${API}/shabbat?cfg=json&latitude=${s.lat}&longitude=${s.lon}&tzid=Asia/Jerusalem&lg=s`)),
    ]);
    const data = {
      fetchedAt: now.toISOString(), today,
      events: buildEvents(holidays.items || [], today),
      shabbat: SITES.map((s, i) => {
        const items = shabbat[i].items || [];
        const candles = items.find(x => x.category === 'candles'), havdalah = items.find(x => x.category === 'havdalah');
        const parasha = items.find(x => x.category === 'parashat');
        return { id: s.id, candles: candles?.date || null, havdalah: havdalah?.date || null, parasha: parasha?.hebrew || null };
      }),
    };
    writeCache({ today, at: Date.now(), data });
    return { ...data, cached: false };
  }

  window.Calendar = { load, RULES };
})();
