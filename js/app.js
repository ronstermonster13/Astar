/* Astar: A level revision app. Plain JS, no build step; progress saved in localStorage. */

// ---------- Utilities ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAY = 86400000;
const todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
function hash(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

// ---------- State ----------
const STORE_KEY = "astar-v1";
const DEFAULT_STATE = () => ({
  settings: {
    // Year 12 internal exams (these feed UCAS predicted grades). Placeholder: set real dates in Settings.
    exams: { eng: "2027-06-07", his: "2027-06-07", bio: "2027-06-07", re: "2027-06-07" },
    newPerDay: 20, focus: 25, brk: 5, blurtMins: 7, stopNewDays: 14,
    // Daily study budgets (minutes) on top of homework; restDay 0=Sun … 6=Sat
    schoolMins: 45, weekendMins: 90, holidayMins: 120, restDay: 5,
    syncUrl: "", // Google Apps Script web app link for Classroom sync
    extraSubjects: [], // keys of EXTRA_SUBJECTS switched on
  },
  // Enfield council dates for 2026–27 (Christmas & May half term are typical, unconfirmed): check Latymer's calendar
  holidays: [
    ["2026-10-26", "2026-10-30", "Autumn half term"],
    ["2026-12-21", "2027-01-01", "Christmas holidays"],
    ["2027-02-15", "2027-02-19", "February half term"],
    ["2027-03-26", "2027-04-09", "Easter holidays"],
    ["2027-05-31", "2027-06-04", "May half term"],
  ],
  plan: {}, dayType: {}, covered: {}, homework: [], events: [], taught: {}, sync: { last: 0, status: "" },
  srs: {}, custom: [], suspended: {}, log: {},
  calib: { 1: { n: 0, ok: 0 }, 2: { n: 0, ok: 0 }, 3: { n: 0, ok: 0 } },
  rag: {}, blurts: [], customBlurts: [], practice: [], papers: [],
  nea: {
    eng: { words: 0, min: 2500, max: 3500, deadline: "", notes: "", done: {} },
    his: { words: 0, min: 3000, max: 3500, deadline: "", notes: "", done: {} },
  },
  timeline: {}, reflections: [],
  notes: [], noteDraft: null, noteLast: "",
});
let S = load();
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw), base = DEFAULT_STATE();
      const st = { ...base, ...saved, settings: { ...base.settings, ...saved.settings, exams: { ...base.settings.exams, ...(saved.settings || {}).exams } } };
      // v0.1.0 used 17 May 2027 as a placeholder; move untouched placeholders to the Year 12 exam default
      for (const k in st.settings.exams) if (st.settings.exams[k] === "2027-05-17") st.settings.exams[k] = base.settings.exams[k];
      return st;
    }
  } catch (e) { console.warn("Could not load saved progress", e); }
  return DEFAULT_STATE();
}
// Subjects you might switch to (Settings → Subjects you might switch to) join Flashcards, Topics, Blurt and Timed practice when ticked
for (const k of S.settings.extraSubjects || []) if (EXTRA_SUBJECTS[k]) SUBJECTS[k] = EXTRA_SUBJECTS[k];
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { console.warn("Could not save", e); } }
function logToday(field, n = 1) { const k = todayKey(); S.log[k] = S.log[k] || {}; S.log[k][field] = (S.log[k][field] || 0) + n; }

// ---------- Cards & scheduling (SM-2 with exam-aware interval cap) ----------
function allCards() {
  const built = CARDS.map(([s, t, f, b, sub, src]) => ({ id: "c" + hash(s + "|" + f), s, t, f, b, sub: sub || "General", src: src || "", custom: false })).filter((c) => SUBJECTS[c.s]);
  return built.concat(noteCards(), S.custom.map((c) => ({ ...c, sub: c.sub || (c.id.startsWith("u") && /recall the key point/.test(c.f) ? "Missed in blurts" : "My cards"), custom: true }))).filter((c) => !S.suspended[c.id]);
}
// 📄 past-paper question, 🖥 from your class slides, ✍️ from your checked lesson notes; plain spec cards get no icon
const srcIcon = (src) => !src || /spec$/.test(src) ? "" : /^Class slides/.test(src) ? "🖥 " : /^My notes/.test(src) ? "✍️ " : "📄 ";
const isNew = (c) => !S.srs[c.id];
const isDue = (c, now = Date.now()) => S.srs[c.id] && S.srs[c.id].due <= now;
function daysToExam(s) {
  const d = S.settings.exams[s]; if (!d) return null;
  return Math.ceil((new Date(d + "T09:00").getTime() - Date.now()) / DAY);
}
function maxInterval(s) {
  const d = daysToExam(s);
  if (d === null || d <= 0) return 365;
  return Math.max(1, Math.floor(d * 0.15));
}
function newAllowed(s) {
  const d = daysToExam(s);
  return !(d !== null && d > 0 && d <= S.settings.stopNewDays);
}
// Once you tick any "covered in class" topic for a subject, new cards only come from covered topics
function hasCoverage(s) { return SUBJECTS[s].topics.some((t) => S.covered[s + "|" + t] === true); }
function isCovered(c) {
  if (c.note) return true; // you wrote a note on it in a lesson, so it has been taught
  if (!hasCoverage(c.s) || !SUBJECTS[c.s].topics.includes(c.t)) return true;
  return S.covered[c.s + "|" + c.t] === true;
}
// Which spec topics a piece of text (a Classroom post) is about
function matchTopics(s, text) {
  const t = " " + (text || "").toLowerCase() + " ";
  return Object.entries(TOPIC_KEYWORDS[s] || {}).filter(([, kws]) => kws.some((kw) => kw.length <= 4 ? new RegExp(`\\b${kw}\\b`).test(t) : / i+$/.test(kw) ? new RegExp(`${kw}\\b`).test(t) : t.includes(kw))).map(([topic]) => topic);
}
// Topic to focus on for a subject: taught recently in class first, then weak (red/amber) covered topics
function focusTopic(s, n, k) {
  const recent = Object.entries(S.taught).filter(([key, v]) => key.startsWith(s + "|") && v.date >= addDays(k, -21) && S.covered[key] !== false)
    .sort((a, b) => b[1].date.localeCompare(a[1].date)).map(([key, v]) => ({ t: key.slice(s.length + 1), why: v.title }));
  if (recent.length) return recent[n % Math.min(recent.length, 3)];
  const weak = SUBJECTS[s].topics.filter((t) => S.covered[s + "|" + t] === true && (S.rag[s + "|" + t] || 0) <= 2);
  if (weak.length) return { t: weak[n % weak.length] };
  return null;
}
function newLeftToday() { return Math.max(0, S.settings.newPerDay - ((S.log[todayKey()] || {}).new || 0)); }

// rating: 1 again, 2 hard, 3 good, 4 easy
function schedule(card, rating) {
  const now = Date.now();
  const r = S.srs[card.id] || { ef: 2.5, ivl: 0, reps: 0, lapses: 0, due: now };
  const q = [0, 1, 3, 4, 5][rating];
  // Ease only changes for graduated cards; first-time learning mistakes shouldn't penalise a card forever
  if (r.reps > 0) r.ef = Math.max(1.3, r.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  if (rating === 1) {
    if (r.reps > 0) r.lapses++;
    r.reps = 0; r.ivl = 0; r.due = now + 10 * 60000;
  } else {
    if (r.reps === 0) r.ivl = rating === 4 ? 4 : 1;
    else if (r.reps === 1) r.ivl = rating === 2 ? 3 : rating === 3 ? 6 : 8;
    else r.ivl = Math.round(r.ivl * (rating === 2 ? 1.2 : rating === 3 ? r.ef : r.ef * 1.3));
    r.ivl = Math.min(Math.max(1, r.ivl), maxInterval(card.s));
    r.reps++;
    r.due = startOfDay(now) + r.ivl * DAY;
  }
  r.last = now;
  S.srs[card.id] = r;
}

function buildQueue({ subjects, topic, mode }) {
  const cards = allCards().filter((c) => subjects.includes(c.s) && (!topic || c.t === topic));
  const due = cards.filter((c) => isDue(c));
  let budget = newLeftToday();
  const fresh = [];
  // Cards from your own lesson notes come first: they're what you've just been taught
  for (const c of cards.filter((x) => x.note).concat(cards.filter((x) => !x.note))) {
    if (budget <= 0) break;
    if (isNew(c) && newAllowed(c.s) && isCovered(c)) { fresh.push(c); budget--; }
  }
  // Mixed = interleave everything; blocked = keep topic order (for first learning a topic)
  return mode === "blocked" ? due.concat(fresh) : shuffle(due.concat(fresh));
}

// ---------- Router ----------
const routes = { home, planner, review, blurt, practice, papers, topics, timeline, coursework, cards: cardsView, notes, science, settings };
function render() {
  const [name, ...rest] = (location.hash.slice(1) || "home").split("/");
  const fn = routes[name] || home;
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + name));
  stopViewTimers();
  $("#view").innerHTML = "";
  fn($("#view"), rest.map(decodeURIComponent));
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", render);

let viewTimers = [];
function stopViewTimers() { viewTimers.forEach(clearInterval); viewTimers = []; }
function countdown(seconds, onTick, onDone) {
  let left = seconds; onTick(left);
  const id = setInterval(() => { left--; onTick(left); if (left <= 0) { clearInterval(id); onDone && onDone(); } }, 1000);
  viewTimers.push(id);
  return () => clearInterval(id);
}

const subjOptions = (sel) => Object.entries(SUBJECTS).map(([k, v]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${v.name}</option>`).join("");

// ---------- Planner (realistic daily plan, editable) ----------
const SUBJ_KEYS = Object.keys(SUBJECTS);
// The daily plan and mixed review stick to the subjects you take now; ones you might switch to are studied from their own page
const PLAN_KEYS = SUBJ_KEYS.filter((k) => !EXTRA_SUBJECTS[k]);
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const parseKey = (k) => new Date(k + "T12:00");
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return todayKey(d); };
function examKey() { return PLAN_KEYS.map((s) => S.settings.exams[s]).filter(Boolean).sort()[0] || null; }
function holidayOn(k) { return (S.holidays || []).find(([a, b]) => k >= a && k <= b); }
function dayType(k) {
  if (S.dayType[k]) return S.dayType[k];
  if (["12-24", "12-25", "12-26", "01-01"].includes(k.slice(5))) return "rest";
  if (holidayOn(k)) return "holiday";
  const dow = parseKey(k).getDay();
  if (dow === +S.settings.restDay) return "rest";
  return dow === 0 || dow === 6 ? "weekend" : "school";
}
function phaseOn(k) {
  const ex = examKey(); if (!ex) return { key: "build", name: "Build & consolidate" };
  const days = Math.round((parseKey(ex) - parseKey(k)) / DAY);
  if (days < 0) return { key: "after", name: "After exams: keep it ticking over", days };
  if (days <= 21) return { key: "exam", name: "Exam prep: past papers & review only", days };
  if (days <= 56) return { key: "practise", name: "Exam practice: timed answers", days };
  return { key: "build", name: "Build & consolidate: learn it as you go", days };
}
function weakestBlurt(s) {
  const opts = BLURTS.concat(S.customBlurts).filter((b) => b.s === s);
  return opts.map((b) => ({ b, sc: lastBlurtScore(b) })).sort((x, y) => x.sc - y.sc)[0]?.b;
}
function suggestDay(k) {
  const type = dayType(k), ph = phaseOn(k), budget = Math.round({ school: S.settings.schoolMins, weekend: S.settings.weekendMins, holiday: S.settings.holidayMins, rest: 0 }[type] * (ph.key === "exam" ? 4 / 3 : 1) / 5) * 5;
  const n = Math.round(parseKey(k) / DAY); // day number, drives the subject rotation
  const tasks = [];
  const add = (text, mins, s, href) => tasks.push({ id: hash(k + text + tasks.length), text, mins, s, href, done: false });
  if (type === "rest" || ph.key === "after" && type !== "holiday") {
    add(type === "rest" ? "Rest day. Optional: 10 min of due flashcards to keep your streak" : "Keep it ticking over: 10 min of due flashcards", 10, null, "#review/mixed");
    return tasks;
  }
  const review = Math.min(20, budget);
  add("Flashcards: all due cards, mixed subjects", review, null, "#review/mixed");
  const hwLoad = S.homework.filter((h) => !h.done && hwDay(h) === k).reduce((a, h) => a + h.mins, 0);
  const busy = hwLoad + evMins(k); // homework plus your own activities
  let left = (busy >= 120 ? review : Math.max(review, budget - Math.round(busy / 10) * 5)) - review, slot = 0; // very busy day = just flashcards
  // Long weekend/holiday sessions in the run-up: a full timed paper
  const fullS = PLAN_KEYS[n % PLAN_KEYS.length], fullP = SUBJECTS[fullS].papers[n % 2];
  if ((ph.key === "practise" || ph.key === "exam") && type !== "school" && left >= fullP.mins) {
    const s = fullS, p = fullP;
    add(`Full timed paper: ${SUBJECTS[s].short} – ${p.name}. Mark it with the mark scheme`, p.mins, s, "#practice/" + s);
    left -= p.mins;
  }
  // Coursework block on weekends/holidays when a deadline is set
  const nea = ["eng", "his"].find((s) => S.nea[s].deadline && S.nea[s].deadline >= k);
  if (nea && type !== "school" && left >= 25) { add(`Coursework: ${SUBJECTS[nea].short} NEA. Next milestone`, 25, nea, "#coursework"); left -= 25; }
  const menus = {
    build: ["blurt", "cards", "plan", "blurt", "his-timeline"],
    practise: ["timed", "blurt", "plan", "timed", "paperq"],
    exam: ["timed", "paperq", "blurt", "timed"],
    after: ["blurt", "cards"],
  };
  while (left >= 20) {
    const s = PLAN_KEYS[(n * 2 + slot) % PLAN_KEYS.length], v = SUBJECTS[s], menu = menus[ph.key];
    let kind = menu[(n + slot) % menu.length];
    if (kind === "his-timeline" && s !== "his") kind = "cards";
    if (kind === "timed" && left < v.papers.find((x) => x.mins <= 60 && x.marks).mins) kind = "plan"; // don't squeeze a timed answer
    const mins = Math.min(25, left);
    const f = focusTopic(s, n + slot, k), tn = f ? f.t.replace(/^(Phil|Ethics|DCT|Russia|Eng Rev|NEA): |^\d+\. /, "") : null;
    const why = f && f.why ? ` · from class: "${f.why.slice(0, 40)}"` : "";
    if (kind === "blurt") {
      const b = f ? BLURTS.concat(S.customBlurts).find((x) => x.s === s && (BLURT_TOPIC[x.t] === f.t || x.t === f.t)) : weakestBlurt(s);
      if (b) add(`Blurt: ${b.t} (${v.short})${why}`, mins, s, "#blurt/" + encodeURIComponent(b.t));
      else if (f) add(`${v.short}: blurt ${tn} from memory on paper, then check your notes${why}`, mins, s, "#blurt");
      else { const w = weakestBlurt(s); w ? add(`Blurt: ${w.t} (${v.short})`, mins, s, "#blurt/" + encodeURIComponent(w.t)) : add(`Blurt this week's ${v.short} lesson topic from memory, then check your notes`, mins, s, "#blurt"); }
    } else if (kind === "cards") {
      const fresh = f && allCards().some((c) => c.s === s && c.t === f.t && isNew(c));
      if (fresh) add(`${v.short}: learn the ${tn} flashcards${why}`, mins, s, "#review/topic:" + encodeURIComponent(s + "|" + f.t));
      else add(`${v.short}: turn your ${f ? tn : "this week's"} class notes into 10 question cards${why}`, mins, s, "#cards");
    } else if (kind === "plan") {
      const q = f && v.questions.find((x) => matchTopics(s, x).includes(f.t));
      add(q ? `${v.short}: 10-minute essay plan for "${q.slice(0, 70)}${q.length > 70 ? "…" : ""}"` : `${v.short}: 10-minute essay plan ×2 against the clock${f ? ` (${tn})` : ""}`, mins, s, "#practice/" + s);
    }
    else if (kind === "timed") { const p = v.papers.find((x) => x.mins <= 60 && x.marks); add(`${v.short}: one timed answer (${p.name}, ${p.mins} min)`, p.mins, s, "#practice/" + s); }
    else if (kind === "paperq") add(`${v.short}: past-paper questions on ${f ? tn : "your weakest topic"}; log marks`, mins, s, "#papers");
    else if (kind === "his-timeline") add("History: timeline round ×3 (Russia + English Revolution)", Math.min(15, left), s, "#timeline");
    left -= tasks[tasks.length - 1].mins; slot++;
  }
  return tasks;
}
// Past days and today are saved once shown, so the plan stays stable; future days update as your settings change
function getDay(k, persist = k <= todayKey()) {
  if (S.plan[k]) return S.plan[k];
  const tasks = suggestDay(k);
  if (persist) { S.plan[k] = tasks; save(); }
  return tasks;
}
function editDay(k, fn) { S.plan[k] = getDay(k, false).map((t) => ({ ...t })); fn(S.plan[k]); save(); }

// ---------- Homework (quick-add + Google Calendar / Classroom .ics import) ----------
function guessSubject(text) {
  const t = (text || "").toLowerCase();
  if (/\b(eng|english|lit|literature)\b/.test(t)) return "eng";
  if (/\b(hist|history)\b/.test(t)) return "his";
  if (/\b(bio|biology)\b/.test(t)) return "bio";
  if (/\b(re|rs|religio\w*|philosophy|ethics|theology)\b/.test(t)) return "re";
  return null;
}
// Default: do it the day before it's due, skipping rest days, never before today
function hwDay(h) {
  const today = todayKey();
  if (h.doOn) return h.doOn < today && !h.done ? today : h.doOn;
  if (h.due <= today) return today;
  let k = addDays(h.due, -1);
  while (k > today && (dayType(k) === "rest" || evMins(k) >= 120)) k = addDays(k, -1); // skip rest days and busy days
  return k < today ? today : k;
}
// Your own commitments (clubs, sport, job…): weekly or one-off. Busy days get lighter revision, and homework avoids them.
function eventsOn(k) {
  const dow = parseKey(k).getDay(), term = !holidayOn(k);
  return S.events.filter((e) => e.kind === "once" ? e.date === k : e.dows.includes(dow) && (term || !e.termOnly) && (!e.from || k >= e.from) && (!e.until || k <= e.until)).sort((a, b) => (a.start || "").localeCompare(b.start || ""));
}
const evMins = (k) => eventsOn(k).reduce((a, e) => a + (+e.mins || 0), 0);
const endTime = (e) => { if (!e.start) return ""; const [h, m] = e.start.split(":").map(Number), t = h * 60 + m + (+e.mins || 0); return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };
const hwOn = (k) => S.homework.filter((h) => (h.done ? h.doneOn === k : hwDay(h) === k));
function parseICS(text, fallbackName) {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const cal = (lines.find((l) => l.startsWith("X-WR-CALNAME:")) || "").slice(13) || fallbackName;
  const out = []; let ev = null;
  const unesc = (v) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") ev = {};
    else if (l === "END:VEVENT") { if (ev && ev.title && ev.due) out.push(ev); ev = null; }
    else if (ev) {
      const i = l.indexOf(":"); if (i < 0) continue;
      const key = l.slice(0, i).split(";")[0], val = l.slice(i + 1);
      if (key === "SUMMARY") ev.title = unesc(val);
      else if (key === "UID") ev.uid = val;
      else if (key === "DESCRIPTION") ev.desc = unesc(val).slice(0, 300);
      else if (key === "DTSTART" || (key === "DUE" && !ev.due)) {
        const m = val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
        if (m) {
          const d = m[4] ? (m[7] ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5])) : new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5])) : new Date(+m[1], m[2] - 1, +m[3], 12);
          ev.due = todayKey(d);
        }
      }
    }
  }
  return out.map((e) => ({ ...e, cal }));
}
function importICS(files, done) {
  Promise.all([...files].map((f) => f.text().then((t) => parseICS(t, f.name.replace(/\.ics$/i, ""))))).then((lists) => {
    const from = addDays(todayKey(), -7);
    let added = 0, skipped = 0;
    lists.flat().forEach((e) => {
      if (e.due < from) { skipped++; return; }
      const uid = e.uid || hash(e.title + e.due);
      if (S.homework.some((h) => h.uid === uid)) { skipped++; return; }
      S.homework.push({ id: hash(uid), uid, title: e.title, s: guessSubject(e.cal + " " + e.title), due: e.due, mins: 45, done: false, src: e.cal, note: e.desc || "" });
      added++;
    });
    save(); done(added, skipped);
  });
}
// Classroom sync: pulls homework from your Apps Script link when the app opens (at most every 10 min)
let syncing = false;
function syncClassroom(force) {
  const url = S.settings.syncUrl;
  if (!url || syncing || (!force && Date.now() - S.sync.last < 10 * 60000)) return Promise.resolve(false);
  syncing = true;
  return fetch(url).catch(() => {
    throw new Error("couldn't reach Google. Check you're online, and that the deployment's Who has access is set to Anyone");
  }).then((r) => r.text()).then((text) => {
    let data;
    try { data = JSON.parse(text); } catch {
      throw new Error(/<html|<!doctype/i.test(text)
        ? "Google sent a sign-in page instead of your homework. In Apps Script go to Deploy → Manage deployments → ✏️ and set Who has access to Anyone"
        : "the link didn't return homework data. Make sure you pasted the Web app URL (ending /exec)");
    }
    if (data.error) throw new Error("the script hit an error: " + data.error);
    let added = 0, ticked = 0;
    (data.items || []).forEach((it) => {
      const uid = "gc-" + it.id, h = S.homework.find((x) => x.uid === uid);
      if (!h) {
        if (it.done && it.due < todayKey()) return; // already handed in: nothing to plan
        S.homework.push({ id: hash(uid), uid, title: it.title, s: guessSubject(it.course + " " + it.title), due: it.due, mins: 45, done: !!it.done, doneOn: it.done ? todayKey() : null, src: it.course, link: it.link, auto: true });
        added++;
      } else {
        h.title = it.title; h.due = it.due; h.link = it.link; h.src = it.course;
        if (it.done && !h.done) { h.done = true; h.doneOn = todayKey(); ticked++; }
      }
    });
    let newTopics = 0;
    (data.taught || []).concat((data.items || []).map((it) => ({ course: it.course, title: it.title, text: "", topic: "", date: it.due }))).forEach((p) => {
      const subj = guessSubject(p.course) || guessSubject(p.title);
      if (!subj) return;
      matchTopics(subj, [p.topic, p.title, p.text].join(" ")).forEach((t) => {
        const key = subj + "|" + t, prev = S.taught[key];
        if (!prev || p.date > prev.date) S.taught[key] = { date: p.date, title: p.title };
        if (S.covered[key] === undefined) { S.covered[key] = true; newTopics++; }
      });
    });
    const noStatus = (data.warnings || []).filter((w) => /hand-in/.test(w)).length;
    const unreadable = (data.warnings || []).filter((w) => /could not read/.test(w)).map((w) => w.split(":")[0]);
    S.sync = { last: Date.now(), warnings: data.warnings || [], courses: data.courses || null, status: `Synced ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · ${(data.items || []).length} assignment${(data.items || []).length === 1 ? "" : "s"} found${!(data.items || []).length ? " (see Settings → Google Classroom sync for why)" : ""}${unreadable.length ? ` · couldn't read ${unreadable.join(", ")}` : ""}${added ? ` · ${added} new` : ""}${newTopics ? ` · ${newTopics} topic${newTopics > 1 ? "s" : ""} marked as covered` : ""}${ticked ? ` · ${ticked} handed in` : ""}${noStatus ? ` · tick off by hand for ${noStatus} class${noStatus > 1 ? "es" : ""} (school hides hand-in status)` : ""}`, ok: true };
    save(); return added + ticked > 0;
  }).catch((e) => {
    S.sync = { last: Date.now(), status: "Sync failed: " + (e.message || e) + ".", ok: false };
    save(); return true;
  }).finally(() => { syncing = false; });
}
function afterSync(changed) { if (changed !== false && /^#?(home|planner)?(\/|$)/.test(location.hash)) render(); }

function hwTable(list) {
  const today = todayKey();
  if (!list.length) return `<p class="muted" style="margin:.3rem 0">No homework here. 🎉</p>`;
  return `<table><tr><th>Homework</th><th>Due</th><th>Do on</th><th>Min</th><th></th></tr>${list.map((h) => `<tr data-hwrow="${h.id}" style="${h.done ? "opacity:.55" : ""}">
      <td><label style="display:flex;gap:.5rem;margin:0;color:var(--ink);font-size:.95rem"><input type="checkbox" data-hw="${h.id}" style="width:auto" ${h.done ? "checked" : ""}>
        <span>${h.auto ? "🔄 " : ""}${h.s ? `<span class="pill" style="background:${SUBJECTS[h.s].colour};color:#fff">${SUBJECTS[h.s].short}</span> ` : `<select data-hwf="s" style="width:auto;padding:.1rem;font-size:.8rem"><option value="">Subject?</option>${SUBJ_KEYS.map((s) => `<option value="${s}">${SUBJECTS[s].short}</option>`).join("")}</select> `}${h.link ? `<a href="${esc(h.link)}" target="_blank" rel="noopener">${esc(h.title)}</a>` : esc(h.title)}${h.src ? `<span class="small muted"> · ${esc(h.src)}</span>` : ""}</span></label></td>
      <td class="small" style="${h.due < today && !h.done ? "color:var(--bad);font-weight:600" : ""}">${parseKey(h.due).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}${h.due < today && !h.done ? " (late)" : ""}</td>
      <td><input type="date" data-hwf="doOn" value="${hwDay(h)}" style="padding:.2rem;width:auto" ${h.done ? "disabled" : ""}></td>
      <td><input type="number" data-hwf="mins" value="${h.mins}" min="5" step="5" style="padding:.2rem;width:4.2rem"></td>
      <td><button class="small" data-hwdel="${h.id}" style="padding:.1rem .5rem" title="Delete">×</button></td></tr>`).join("")}</table>`;
}
function addHomeworkPanel() {
  return `<h2>Add homework</h2><div class="card">
    <div class="row">
      <input id="hwT" placeholder="Homework, e.g. History essay on Witte" style="flex:3;min-width:200px">
      <select id="hwS" style="width:auto"><option value="">Subject</option>${SUBJ_KEYS.map((s) => `<option value="${s}">${SUBJECTS[s].short}</option>`).join("")}</select>
      <input id="hwD" type="date" style="width:auto" title="Due date">
      <input id="hwM" type="number" value="45" min="5" step="5" style="width:4.5rem" title="Minutes">
      <button class="primary" id="hwAdd">Add</button>
    </div>
    <details style="margin-top:.8rem"><summary><b>Import from a Google Calendar export</b> (backup if sync isn't working)</summary>
      <ol class="small" style="line-height:1.8">
        <li>Classroom puts every assignment with a due date into Google Calendar, one calendar per class.</li>
        <li>On a computer, open <a href="https://calendar.google.com/calendar/r/settings/export" target="_blank" rel="noopener">Google Calendar → Settings → Import &amp; export → Export</a>, signed in with your school account.</li>
        <li>It downloads a .zip. Double-click it to unzip, and you get one <b>.ics</b> file per class.</li>
        <li>Choose all the .ics files below. Anything already imported is skipped.</li>
      </ol>
      <label class="btn" style="color:var(--ink);font-size:1rem">Choose .ics files<input type="file" id="hwIcs" accept=".ics,text/calendar" multiple hidden></label> <span id="hwMsg" class="small muted"></span>
    </details>
  </div>`;
}
function wireHomework(el, redraw) {
  const find = (id) => S.homework.find((h) => h.id === id);
  el.querySelectorAll("[data-hw]").forEach((cb) => cb.onchange = () => { const h = find(cb.dataset.hw); h.done = cb.checked; h.doneOn = cb.checked ? todayKey() : null; if (cb.checked) logToday("homework"); save(); redraw(); });
  el.querySelectorAll("[data-hwdel]").forEach((b) => b.onclick = () => { if (confirm("Delete this homework?")) { S.homework = S.homework.filter((h) => h.id !== b.dataset.hwdel); save(); redraw(); } });
  el.querySelectorAll("[data-hwrow] [data-hwf]").forEach((i) => i.onchange = () => {
    const h = find(i.closest("[data-hwrow]").dataset.hwrow), f = i.dataset.hwf;
    h[f] = f === "mins" ? +i.value || 30 : i.value || null; save(); redraw();
  });
  const add = $("#hwAdd", el);
  if (add) add.onclick = () => {
    const title = $("#hwT").value.trim(), due = $("#hwD").value;
    if (!title || !due) return alert("Add a title and a due date.");
    S.homework.push({ id: hash(title + due + Date.now()), title, s: $("#hwS").value || null, due, mins: +$("#hwM").value || 45, done: false });
    save(); redraw();
  };
  const sn = $("#syncNow", el);
  if (sn) sn.onclick = () => { sn.disabled = true; sn.textContent = "Syncing…"; syncClassroom(true).then(() => redraw()); };
  const ics = $("#hwIcs", el);
  if (ics) ics.onchange = () => importICS(ics.files, (a, sk) => { redraw(); const m = $("#hwMsg"); if (m) m.textContent = `Imported ${a} homework item(s)${sk ? `, skipped ${sk} (already added or more than a week old)` : ""}.`; });
}

const syncLine = () => S.settings.syncUrl
  ? `<div class="row spread small card" style="padding:.5rem .8rem;margin-bottom:.8rem"><span style="color:${S.sync.ok === false ? "var(--bad)" : "var(--muted)"}">🔄 Google Classroom: ${esc(S.sync.status || "not synced yet")}</span><button class="small" id="syncNow" style="padding:.2rem .6rem">Sync now</button></div>`
  : `<p class="small muted">🔄 <a href="#settings">Set up Google Classroom sync</a> to add homework automatically.</p>`;

// Planner = month calendar. Click a day to see and edit that day's plan and homework underneath.
let selDay = null;
function planner(el, [a, b]) {
  const today = todayKey();
  if (a === "cal") a = b; // old #planner/cal/YYYY-MM links
  if (/^\d{4}-\d{2}-\d{2}$/.test(a || "")) { selDay = a; a = a.slice(0, 7); }
  const month = /^\d{4}-\d{2}$/.test(a || "") ? a : (selDay || today).slice(0, 7);
  if (!selDay || selDay.slice(0, 7) !== month) selDay = month === today.slice(0, 7) ? today : month + "-01";
  const first = parseKey(month + "-01");
  const gridStart = addDays(month + "-01", -((first.getDay() + 6) % 7));
  const prev = new Date(first); prev.setMonth(prev.getMonth() - 1);
  const next = new Date(first); next.setMonth(next.getMonth() + 1);
  const ym = (d) => todayKey(d).slice(0, 7);
  const exams = new Set(SUBJ_KEYS.map((s) => S.settings.exams[s]).filter(Boolean));
  const ex = examKey(), ph = phaseOn(today);
  const cells = [...Array(42)].map((_, i) => {
    const k = addDays(gridStart, i), inMonth = k.slice(0, 7) === month, type = dayType(k), hol = holidayOn(k);
    const due = S.homework.filter((h) => h.due === k).sort((x, y) => x.done - y.done);
    const todo = hwOn(k).filter((h) => !h.done && h.due !== k);
    const dayTasks = getDay(k, false), plan = dayTasks.reduce((t, x) => t + x.mins, 0), evs = eventsOn(k);
    const cls = ["cal-cell", inMonth ? "" : "out", k === today ? "today" : "", k === selDay ? "sel" : "", type === "rest" ? "rest" : "", hol || type === "holiday" ? "hol" : ""].join(" ");
    return `<div class="${cls}" data-sel="${k}" title="${esc(hol ? hol[2] : type)}">
      <div class="cal-top"><span class="cal-num">${parseKey(k).getDate()}</span>${exams.has(k) ? `<span class="cal-exam">Exams</span>` : ""}</div>
      ${due.map((h) => `<span class="cal-hw ${h.done ? "done" : h.due < today ? "late" : ""}" style="--c:${h.s ? SUBJECTS[h.s].colour : "#64748b"}" title="${esc((h.s ? SUBJECTS[h.s].short + ": " : "") + h.title)}${h.done ? " (done)" : ""}">${h.done ? "✓ " : ""}${esc(h.title)}</span>`).join("")}
      ${evs.map((e) => `<span class="cal-ev" title="${esc(e.title)}">⏰ ${e.start ? e.start + " " : ""}${esc(e.title)}</span>`).join("")}
      ${todo.length ? `<span class="cal-do">📝 do ${todo.map((h) => esc(h.title)).join(", ")}</span>` : ""}
      ${inMonth && (k >= today || S.plan[k]) ? dayTasks.filter((t) => !/^Flashcards: all due/.test(t.text)).map((t) => `<span class="cal-task ${t.done ? "done" : ""}" style="--c:${t.s ? SUBJECTS[t.s].colour : "#64748b"}" title="${esc(t.text)}">${esc(t.text.replace(/^(English|History|Biology|RS): /, ""))}</span>`).join("") : ""}
      ${plan && inMonth && k >= today ? `<span class="cal-plan">${type === "rest" ? "rest" : plan + "m revision"}</span>` : ""}
    </div>`;
  }).join("");
  const monthHw = S.homework.filter((h) => h.due.slice(0, 7) === month).sort((x, y) => x.due.localeCompare(y.due) || x.done - y.done);
  const selDue = S.homework.filter((h) => h.due === selDay);
  el.innerHTML = `<h1>Planner</h1>
    <p class="muted small">${ex ? `Year 12 exams: <b>${parseKey(ex).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</b> (${Math.max(0, ph.days)} days) · ` : ""}Phase: <b>${ph.name}</b> · <a href="#settings">study times &amp; holidays</a></p>
    ${syncLine()}
    <div class="row spread" style="margin-bottom:.6rem">
      <a class="btn" href="#planner/${ym(prev)}">← ${prev.toLocaleDateString("en-GB", { month: "short" })}</a>
      <b style="font-size:1.15rem">${first.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</b>
      <span class="row"><a class="btn" href="#planner/${today}">Today</a><a class="btn" href="#planner/${ym(next)}">${next.toLocaleDateString("en-GB", { month: "short" })} →</a></span>
    </div>
    <div class="cal">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="cal-head">${d}</div>`).join("")}${cells}</div>
    <p class="small muted">Boxes are homework on its <b>due</b> date (✓ done, red = late). "📝 do" is when you're planned to do it, ⏰ are your activities, and the coloured lines are your revision tasks (every day also starts with flashcards). Shaded days are holidays. <b>Tap a day</b> to see, tick off and edit its plan below.</p>
    <div id="dayPanel">
      ${dayCard(selDay, selDay === today)}
      ${selDue.length ? `<h2>Due ${selDay === today ? "today" : parseKey(selDay).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}</h2><div class="card">${hwTable(selDue)}</div>` : ""}
    </div>
    <h2>All homework in ${first.toLocaleDateString("en-GB", { month: "long" })} (${monthHw.filter((h) => !h.done).length} to do)</h2>
    <div class="card">${hwTable(monthHw)}</div>
    ${addHomeworkPanel()}
    ${activitiesPanel()}`;
  const redraw = () => planner(el, [selDay]);
  el.querySelectorAll("[data-sel]").forEach((c) => c.onclick = () => {
    selDay = c.dataset.sel;
    if (selDay.slice(0, 7) !== month) location.hash = "planner/" + selDay; else { redraw(); $("#dayPanel").scrollIntoView({ behavior: "smooth", block: "start" }); }
  });
  wireDays(el, redraw);
  wireHomework(el, redraw);
  wireActivities(el, redraw);
}

function activitiesPanel() {
  const days = [1, 2, 3, 4, 5, 6, 0];
  const describe = (e) => e.kind === "once" ? parseKey(e.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "Every " + e.dows.map((d) => DOW[d]).join(", ") + (e.termOnly ? " (term time)" : "");
  return `<h2>My activities</h2><div class="card">
    <p class="small muted" style="margin-top:0">Add things you do outside lessons: sport, music, clubs, a job, plans with friends. Busy days get less revision (2 hours or more of activities and homework = flashcards only), and homework is planned for a quieter day before it's due.</p>
    ${S.events.length ? `<table>${S.events.map((e) => `<tr><td><b>${esc(e.title)}</b></td><td class="small">${describe(e)}</td><td class="small">${e.start ? `${e.start}–${endTime(e)}` : ""} · ${e.mins} min</td><td><button class="small" data-evdel="${e.id}" style="padding:.1rem .5rem" title="Delete">×</button></td></tr>`).join("")}</table>` : ""}
    <div class="row" style="margin-top:.8rem">
      <input id="evT" placeholder="e.g. Football training" style="flex:2;min-width:160px">
      <select id="evK" style="width:auto"><option value="weekly">Every week</option><option value="once">One-off</option></select>
      <input id="evStart" type="time" value="16:00" style="width:auto" title="Start time">
      <input id="evM" type="number" value="90" min="10" step="5" style="width:5rem" title="Minutes (include travel)">
    </div>
    <div class="row small" id="evDays" style="margin-top:.5rem">${days.map((d) => `<label style="display:flex;gap:.25rem;align-items:center;margin:0;color:var(--ink)"><input type="checkbox" value="${d}" style="width:auto">${DOW[d]}</label>`).join("")}
      <label style="display:flex;gap:.25rem;align-items:center;margin:0 0 0 .8rem;color:var(--ink)"><input type="checkbox" id="evTerm" checked style="width:auto">term time only</label></div>
    <div class="row small" id="evDateRow" style="margin-top:.5rem;display:none"><span>Date</span><input id="evDate" type="date" value="${selDay || todayKey()}" style="width:auto"></div>
    <button class="primary" id="evAdd" style="margin-top:.6rem">Add activity</button> <span class="small muted">Include travel time in the minutes.</span>
  </div>`;
}
function wireActivities(el, redraw) {
  const k = $("#evK", el); if (!k) return;
  k.onchange = () => { const once = k.value === "once"; $("#evDays").style.display = once ? "none" : "flex"; $("#evDateRow").style.display = once ? "flex" : "none"; };
  $("#evAdd", el).onclick = () => {
    const title = $("#evT").value.trim(), kind = k.value;
    const dows = [...el.querySelectorAll("#evDays input[value]:checked")].map((x) => +x.value);
    if (!title) return alert("Give the activity a name.");
    if (kind === "weekly" && !dows.length) return alert("Pick at least one day.");
    if (kind === "once" && !$("#evDate").value) return alert("Pick a date.");
    S.events.push({ id: hash(title + Date.now()), title, kind, dows, from: todayKey(), date: $("#evDate").value, start: $("#evStart").value, mins: +$("#evM").value || 60, termOnly: $("#evTerm").checked });
    save(); redraw();
  };
  el.querySelectorAll("[data-evdel]").forEach((b) => b.onclick = () => { if (confirm("Delete this activity?")) { S.events = S.events.filter((e) => e.id !== b.dataset.evdel); save(); redraw(); } });
}

function dayCard(k, isToday) {
  const tasks = getDay(k), type = dayType(k), hol = holidayOn(k), hw = hwOn(k);
  const mins = tasks.reduce((a, t) => a + t.mins, 0), hwMins = hw.reduce((a, h) => a + h.mins, 0);
  const past = k < todayKey();
  return `<div class="card day" style="margin:.6rem 0;${isToday ? "border:2px solid var(--accent)" : ""}${past ? ";opacity:.75" : ""}" data-day="${k}">
    <div class="row spread"><b>${isToday ? "Today · " : ""}${parseKey(k).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}</b>
      <span class="row small"><span class="muted">${mins} min revision${hwMins ? ` + ${hwMins} min homework` : ""}${evMins(k) ? ` + ${evMins(k)} min activities` : ""}${hol ? " · " + esc(hol[2]) : ""}</span>
      <select data-type style="width:auto;padding:.2rem">${["school", "weekend", "holiday", "rest"].map((t) => `<option ${t === type ? "selected" : ""}>${t}</option>`).join("")}</select></span></div>
    ${eventsOn(k).map((e) => `<div class="small" style="margin:.3rem 0">⏰ <b>${esc(e.title)}</b> ${e.start ? `${e.start}–${endTime(e)}` : ""} <span class="muted">(${e.mins} min)</span></div>`).join("")}
    ${hw.length ? `<div class="checklist" style="border-bottom:1px dashed var(--line);padding-bottom:.3rem">${hw.map((h) => `<label><input type="checkbox" data-hwday="${h.id}" ${h.done ? "checked" : ""}><span style="${h.done ? "text-decoration:line-through;color:var(--muted)" : ""}">📝 <b>Homework:</b> ${h.s ? `<span class="pill" style="background:${SUBJECTS[h.s].colour};color:#fff">${SUBJECTS[h.s].short}</span> ` : ""}${esc(h.title)} <span class="small ${h.due < todayKey() && !h.done ? "" : "muted"}" style="${h.due < todayKey() && !h.done ? "color:var(--bad)" : ""}">due ${h.due === k ? "today" : parseKey(h.due).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })} · ${h.mins}m</span></span></label>`).join("")}</div>` : ""}
    <div class="checklist">${tasks.map((t) => `<label style="justify-content:space-between"><span style="display:flex;gap:.6rem"><input type="checkbox" data-t="${t.id}" ${t.done ? "checked" : ""}><span style="${t.done ? "text-decoration:line-through;color:var(--muted)" : ""}">${t.s ? `<span class="pill" style="background:${SUBJECTS[t.s].colour};color:#fff">${SUBJECTS[t.s].short}</span> ` : ""}${t.href ? `<a href="${t.href}">${esc(t.text)}</a>` : esc(t.text)} <span class="muted small">${t.mins}m</span></span></span><button class="small" data-x="${t.id}" title="Remove" style="padding:.1rem .5rem">×</button></label>`).join("") || `<p class="muted small">Nothing planned.</p>`}</div>
    <div class="row" style="margin-top:.5rem">
      <input data-add placeholder="Add a task, e.g. Finish Hamlet essay" style="flex:3;min-width:180px">
      <input data-mins type="number" value="25" min="5" step="5" style="width:5rem">
      <select data-s style="width:auto"><option value="">General</option>${SUBJ_KEYS.map((s) => `<option value="${s}">${SUBJECTS[s].short}</option>`).join("")}</select>
      <button data-addbtn>Add</button>
      ${S.plan[k] ? `<button data-reset class="small" title="Throw away edits and use the suggested plan">Reset</button>` : ""}
    </div></div>`;
}
function wireDays(el, redraw) {
  el.querySelectorAll("[data-day]").forEach((card) => {
    const k = card.dataset.day;
    card.querySelectorAll("[data-hwday]").forEach((cb) => cb.onchange = () => { const h = S.homework.find((x) => x.id === cb.dataset.hwday); h.done = cb.checked; h.doneOn = cb.checked ? todayKey() : null; if (cb.checked) logToday("homework"); save(); redraw(); });
    card.querySelectorAll("[data-t]").forEach((cb) => cb.onchange = () => { editDay(k, (ts) => { ts.find((t) => t.id === cb.dataset.t).done = cb.checked; }); if (cb.checked && k === todayKey()) logToday("tasks"); redraw(); });
    card.querySelectorAll("[data-x]").forEach((b) => b.onclick = (e) => { e.preventDefault(); editDay(k, (ts) => ts.splice(ts.findIndex((t) => t.id === b.dataset.x), 1)); redraw(); });
    const addTask = () => {
      const text = card.querySelector("[data-add]").value.trim(); if (!text) return;
      editDay(k, (ts) => ts.push({ id: hash(k + text + Date.now()), text, mins: +card.querySelector("[data-mins]").value || 25, s: card.querySelector("[data-s]").value || null, href: null, done: false, mine: true }));
      redraw();
    };
    card.querySelector("[data-addbtn]").onclick = addTask;
    card.querySelector("[data-add]").onkeydown = (e) => { if (e.key === "Enter") addTask(); };
    card.querySelector("[data-type]").onchange = (e) => {
      S.dayType[k] = e.target.value;
      // Re-suggest for the new day type but keep tasks you added yourself
      const mine = (S.plan[k] || []).filter((t) => t.mine);
      delete S.plan[k]; S.plan[k] = suggestDay(k).concat(mine); save(); redraw();
    };
    const r = card.querySelector("[data-reset]");
    if (r) r.onclick = () => { if (confirm("Reset this day to the suggested plan? Your own tasks and ticks for this day will be removed.")) { delete S.plan[k]; delete S.dayType[k]; save(); redraw(); } };
  });
}

// ---------- Today ----------
function streak() {
  let n = 0, d = new Date();
  if (!S.log[todayKey(d)]) d.setDate(d.getDate() - 1);
  while (S.log[todayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function calibration() {
  const c = S.calib, sure = c[3];
  return { sureAcc: sure.n ? Math.round((sure.ok / sure.n) * 100) : null, total: c[1].n + c[2].n + c[3].n };
}
function home(el) {
  const cards = allCards();
  const dueAll = cards.filter((c) => isDue(c)).length;
  const newAvail = Math.min(newLeftToday(), cards.filter((c) => isNew(c) && newAllowed(c.s) && isCovered(c)).length);
  const next = Object.keys(SUBJECTS).map((s) => [s, daysToExam(s)]).filter(([, d]) => d !== null && d > 0).sort((a, b) => a[1] - b[1])[0];
  const cal = calibration();
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const unrated = Object.entries(SUBJECTS).reduce((n, [s, v]) => n + v.topics.filter((t) => !S.rag[s + "|" + t]).length, 0);
  const weekAgo = Date.now() - 7 * DAY;
  const needReflect = !S.reflections.some((r) => r.date > weekAgo);

  el.innerHTML = `
    <h1>${greet} 👋</h1>
    <p class="muted">${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}${next ? ` · <b>${next[1]} days</b> until your first ${SUBJECTS[next[0]].short} exam` : ""}</p>
    <div class="grid">
      <div class="card"><div class="stat">${dueAll}</div><div class="muted">cards due</div></div>
      <div class="card"><div class="stat">${newAvail}</div><div class="muted">new cards today</div></div>
      <div class="card"><div class="stat">${streak()}🔥</div><div class="muted">day streak</div></div>
      <div class="card"><div class="stat">${cal.sureAcc === null ? "–" : cal.sureAcc + "%"}</div><div class="muted">right when "sure"${cal.sureAcc !== null && cal.sureAcc < 80 ? ' · <span style="color:var(--bad)">overconfident</span>' : ""}</div></div>
    </div>

    <h2>Today's plan <a class="small" href="#planner" style="font-weight:400">open calendar →</a></h2>
    <p class="small muted" style="margin-top:0">${phaseOn(todayKey()).name} · Use the <b>⏱ Focus</b> timer for each block (${S.settings.focus} min on, ${S.settings.brk} off).${unrated ? ` · <a href="#topics">${unrated} topics</a> not rated or ticked as covered yet` : ""}</p>
    <div id="todayPlan">${dayCard(todayKey(), true)}</div>

    <h2>Subjects</h2>
    <div class="grid">${Object.entries(SUBJECTS).map(([s, v]) => {
      const sc = cards.filter((c) => c.s === s);
      const due = sc.filter((c) => isDue(c)).length;
      const learned = sc.filter((c) => !isNew(c)).length;
      const reds = v.topics.filter((t) => S.rag[s + "|" + t] === 1).length;
      const d = daysToExam(s);
      return `<div class="card subj" style="--c:${v.colour}">
        <b>${v.name}</b> <span class="pill">${v.board}</span>
        <div class="muted small" style="margin:.4rem 0">${due} due · ${learned}/${sc.length} cards started · ${reds} red topics${d > 0 ? ` · ${d} days to exam` : ""}</div>
        <div class="progress"><div style="width:${sc.length ? (learned / sc.length) * 100 : 0}%;background:${v.colour}"></div></div>
        <div class="row" style="margin-top:.7rem"><a class="btn" href="#review/${s}">Review</a><a class="btn" href="#practice/${s}">Practise</a></div>
      </div>`;
    }).join("")}</div>

    ${needReflect ? `
    <h2>Weekly reflection</h2>
    <div class="card">
      <p class="muted small" style="margin-top:0">Planning, checking and reviewing how you learn is one of the strongest ways to improve (EEF: +7 months). Two minutes, once a week.</p>
      <label>What went well this week? What do you keep getting wrong?</label><textarea id="r1"></textarea>
      <label>What will you change next week?</label><textarea id="r2"></textarea>
      <button class="primary" id="saveReflect" style="margin-top:.6rem">Save reflection</button>
    </div>` : ""}
  `;
  const redrawToday = () => { $("#todayPlan").innerHTML = dayCard(todayKey(), true); wireDays($("#todayPlan"), redrawToday); };
  wireDays($("#todayPlan", el), redrawToday);
  const btn = $("#saveReflect", el);
  if (btn) btn.onclick = () => { S.reflections.push({ date: Date.now(), well: $("#r1").value, change: $("#r2").value }); logToday("reflect"); save(); render(); };
}

// ---------- Review ----------
// Rough automatic check of a typed answer: how many of the answer's key words did you include?
const STOP = new Set("about above after again also although among another because been before being below between both but called cannot could does doing down during each either every from further have having here into itself just more most much must neither only other over same should since some such than that their them then there these they this those through under until upon very were what when where which while whom whose will with within without would your".split(" "));
function keyWords(text) {
  return [...new Set((text || "").toLowerCase().replace(/[‘’']/g, "").split(/[^a-z0-9à-ÿ⁺⁻₂]+/).filter((w) => (w.length >= 4 || /\d/.test(w)) && !STOP.has(w)).map((w) => w.slice(0, 6)))];
}
function checkAnswer(typed, answer, question = "") {
  // Words already in the question (e.g. the visible half of a quote) and bracketed extras don't count
  const given = new Set(keyWords(question));
  let keys = keyWords(answer.replace(/\([^)]*\)/g, " ")).filter((k) => !given.has(k));
  if (!keys.length) keys = keyWords(answer);
  if (!typed.trim() || !keys.length) return null;
  const mine = new Set(keyWords(typed)), hit = keys.filter((k) => mine.has(k));
  const score = hit.length / keys.length;
  return { score, verdict: score >= 0.5 ? "right" : score >= 0.2 ? "partly" : "wrong", hit: hit.length, total: keys.length };
}

function cardCounts(list) {
  return { n: list.length, due: list.filter((c) => isDue(c)).length, fresh: list.filter(isNew).length };
}
function countLabel({ n, due, fresh }) {
  return `${n} card${n === 1 ? "" : "s"}${due ? ` · <b style="color:var(--accent)">${due} due</b>` : ""}${fresh ? ` · ${fresh} new` : ""}`;
}
function review(el, [scope]) {
  if (!scope) {
    const all = allCards();
    const statusDot = (c) => !S.srs[c.id] ? `<span class="dot" title="New"></span>` : isDue(c) ? `<span class="dot due" title="Due"></span>` : `<span class="dot ok" title="Next review in ${Math.ceil((S.srs[c.id].due - Date.now()) / DAY)} days"></span>`;
    el.innerHTML = `<h1>Flashcards</h1>
      <p class="muted">Answer before you see the answer. Mixed review shuffles topics together, which helps you tell them apart. Or open a topic below and study one subtopic at a time.</p>
      <div class="grid">
        <a class="card" href="#review/mixed" style="text-decoration:none;color:inherit"><b>🔀 Mixed: ${PLAN_KEYS.length < SUBJ_KEYS.length ? "your current subjects" : "all subjects"}</b><div class="muted small">${all.filter((c) => PLAN_KEYS.includes(c.s) && isDue(c)).length} due</div></a>
        ${Object.entries(SUBJECTS).map(([s, v]) => `<a class="card subj" style="--c:${v.colour};text-decoration:none;color:inherit" href="#review/${s}"><b>${v.name}${EXTRA_SUBJECTS[s] ? " 🔭" : ""}</b><div class="muted small">${all.filter((c) => c.s === s && isDue(c)).length} due · mixed</div></a>`).join("")}
      </div>
      <p class="small muted" style="margin-top:1rem"><span class="dot"></span> new <span class="dot due"></span> due <span class="dot ok"></span> learnt, next review scheduled. Tap a question to see its answer.</p>
      ${Object.entries(SUBJECTS).map(([s, v]) => {
        const sc = all.filter((c) => c.s === s);
        const topicsInOrder = [...new Set(v.topics.filter((t) => sc.some((c) => c.t === t)).concat(sc.map((c) => c.t)))];
        return `<h2 style="border-left:5px solid ${v.colour};padding-left:.5rem">${v.name} <span class="small muted" style="font-weight:400">${countLabel(cardCounts(sc))}</span></h2>
        ${topicsInOrder.map((t) => {
          const tc = sc.filter((c) => c.t === t);
          // Spec order: numbered headings (3.4.1, RP2, C1, 1855–94…) sort naturally; others keep card order
          const numbered = (x) => /^(\d|RP\d|C\d)/.test(x);
          const subs = [...new Set(tc.map((c) => c.sub))].sort((a, b) => numbered(a) && numbered(b) ? a.localeCompare(b, "en", { numeric: true }) : 0);
          return `<details class="tree"><summary><span class="tree-name">${esc(t)}</span><span class="small muted">${countLabel(cardCounts(tc))}</span><a class="btn small" href="#review/topic:${encodeURIComponent(s + "|" + t)}">Study</a></summary>
            ${subs.map((sub) => {
              const cc = tc.filter((c) => c.sub === sub);
              return `<details class="tree sub"><summary><span class="tree-name">${esc(sub)}</span><span class="small muted">${countLabel(cardCounts(cc))}</span><a class="btn small" href="#review/sub:${encodeURIComponent([s, t, sub].join("|"))}">Study</a></summary>
                <ul class="qlist">${cc.map((c) => `<li><details><summary>${statusDot(c)}${srcIcon(c.src)}${esc(c.f)}</summary><div class="small qa">${esc(c.b)}${c.src ? `<div class="muted" style="margin-top:.3rem">Source: ${esc(c.src)}</div>` : ""}</div></details></li>`).join("")}</ul></details>`;
            }).join("")}</details>`;
        }).join("")}`;
      }).join("")}`;
    return;
  }
  let queue, label, practice = false;
  if (scope === "mixed") { queue = buildQueue({ subjects: PLAN_KEYS, mode: "mixed" }); label = "Mixed review"; }
  else if (scope.startsWith("topic:") || scope.startsWith("sub:")) {
    // You picked this topic/subtopic: its due cards plus all its new ones, in order
    const [s, t, sub] = scope.slice(scope.indexOf(":") + 1).split("|");
    const set = allCards().filter((c) => c.s === s && c.t === t && (!sub || c.sub === sub));
    queue = set.filter((c) => isDue(c)).concat(set.filter(isNew));
    label = sub ? `${t} › ${sub}` : t;
    if (!queue.length && set.length) { queue = shuffle(set); practice = true; }
  } else { queue = buildQueue({ subjects: [scope], mode: "mixed" }); label = SUBJECTS[scope] ? SUBJECTS[scope].name : scope; }
  runSession(el, queue, { label, practice });
}

function runSession(el, queue, { label = "", practice = false } = {}) {
  const total = queue.length, missed = [];
  let done = 0, correct = 0, conf = 0, streakRight = 0;
  if (!total) {
    el.innerHTML = `<div class="card flash"><h1>All caught up ✅</h1><p>Nothing is due here. Spacing works because you wait, so come back tomorrow. Meanwhile try a <a href="#blurt">blurt</a> or <a href="#practice">timed practice</a>.</p></div>`;
    return;
  }
  const showCard = () => {
    if (!queue.length) {
      save();
      const pc = Math.round((correct / Math.max(1, done)) * 100);
      el.innerHTML = `<div class="card flash fx-in"><h1>Session complete ${pc >= 80 ? "🎉" : pc >= 50 ? "👍" : "💪"}</h1>
        <div class="ring" style="--p:${pc}"><span>${pc}%</span></div>
        <p style="text-align:center">${done} answers · ${correct} right first time or after a retry</p>
        ${missed.length ? `<h2>Worth another look</h2><ul class="qlist">${[...new Map(missed.map((c) => [c.id, c])).values()].map((c) => `<li><details><summary>${esc(c.f)}</summary><div class="small qa">${esc(c.b)}</div></details></li>`).join("")}</ul>` : ""}
        <p class="muted small">${practice ? "Practice round: your review schedule wasn't changed." : "Sleep helps you keep what you've just learned. Your next reviews are scheduled automatically."}</p>
        <div class="row"><a class="btn primary" href="#review">Back to flashcards</a><a class="btn" href="#home">Today</a></div></div>`;
      return;
    }
    const c = queue[0], v = SUBJECTS[c.s], fresh = isNew(c);
    conf = 0;
    el.innerHTML = `<div class="flash">
      <div class="row spread small muted"><span><span class="pill" style="background:${v.colour};color:#fff">${v.short}</span> ${esc(c.t)} › ${esc(c.sub)} ${fresh ? '<span class="pill">new</span>' : ""}${practice ? ' <span class="pill">practice</span>' : ""}</span><span>${streakRight >= 3 ? `🔥 ${streakRight} in a row · ` : ""}${queue.length} left</span></div>
      <div class="progress" style="margin:.5rem 0"><div style="width:${(done / (done + queue.length)) * 100}%"></div></div>
      <div class="card fcard fx-in" id="fcard">
        ${c.src ? `<div class="small src">${srcIcon(c.src) || "📘 "}${esc(c.src)}</div>` : ""}
        <div class="front">${esc(c.f)}</div>
        <textarea id="attempt" placeholder="Type your answer. The app checks it against the key words in the answer."></textarea>
        <label>How confident are you?</label>
        <div class="row" id="confRow"><button data-c="1">🤷 Guess</button><button data-c="2">🤔 Unsure</button><button data-c="3">💪 Sure</button></div>
        <div style="margin-top:1rem"><button class="primary" id="reveal" disabled>Show answer</button></div>
        <div id="answer"></div>
        <div class="fx-mark" id="fxMark" aria-hidden="true"></div>
      </div>
      <p class="muted small" style="text-align:center">Keys: 1–3 confidence · space to reveal · 1–4 to rate</p>
    </div>`;
    el.querySelectorAll("#confRow button").forEach((b) => b.onclick = () => {
      if ($("#answer").innerHTML) return; // confidence is locked once the answer is showing
      conf = +b.dataset.c;
      el.querySelectorAll("#confRow button").forEach((x) => x.classList.toggle("sel", x === b));
      $("#reveal").disabled = false;
    });
    $("#reveal").onclick = reveal;
    $("#attempt").focus();
  };
  const reveal = () => {
    if (!conf || $("#answer").innerHTML) return;
    const c = queue[0], typed = $("#attempt").value, chk = checkAnswer(typed, c.b, c.f);
    $("#reveal").remove();
    $("#attempt").readOnly = true;
    const explain = Math.random() < 0.2 ? `<p class="small muted">💭 <b>Explain why:</b> before rating, say why this is true or link it to another topic (self-explanation).</p>` : "";
    const badge = chk ? `<div class="verdict ${chk.verdict}">${chk.verdict === "right" ? "✓ Looks right" : chk.verdict === "partly" ? "≈ Partly there" : "✗ Doesn't match the answer"} <span class="small">· ${chk.hit}/${chk.total} key words</span></div>` : "";
    $("#answer").innerHTML = `${badge}<div class="back flip-in">${esc(c.b)}</div>${explain}
      <p class="small muted" style="margin:.2rem 0 .4rem">${chk ? "The check only compares key words, so you have the final say. " : ""}Were you right? Be honest. That decides when you'll see it again.</p>
      <div class="row"><button class="again" data-r="1">✗ 1 · Wrong</button><button class="hard" data-r="2">2 · Hard</button><button class="good" data-r="3">✓ 3 · Right</button><button class="easy" data-r="4">4 · Easy</button></div>`;
    if (chk) { const sug = { right: 3, partly: 2, wrong: 1 }[chk.verdict]; el.querySelector(`[data-r="${sug}"]`).classList.add("suggest"); }
    el.querySelectorAll("[data-r]").forEach((b) => b.onclick = () => rate(+b.dataset.r));
  };
  // Big tick or cross, then move on
  const celebrate = (ok, then) => {
    const card = $("#fcard"), mark = $("#fxMark");
    el.querySelectorAll("[data-r]").forEach((b) => b.disabled = true);
    card.classList.add(ok ? "fx-right" : "fx-wrong");
    mark.textContent = ok ? "✓" : "✗";
    mark.className = "fx-mark show " + (ok ? "right" : "wrong");
    const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(then, reduce ? 350 : ok ? 650 : 800);
  };
  const rate = (rating) => {
    const c = queue.shift();
    const wasNew = isNew(c);
    // Low confidence + "easy" is probably a lucky guess, so schedule it as "good"
    if (conf < 3 && rating === 4) rating = 3;
    const ok = rating > 1;
    S.calib[conf].n++; if (ok) S.calib[conf].ok++;
    if (!practice) { schedule(c, rating); if (wasNew && rating > 1) logToday("new"); }
    logToday("reviews"); done++; if (ok) { correct++; streakRight++; } else { streakRight = 0; missed.push(c); }
    if (!ok) queue.splice(Math.min(queue.length, 3), 0, c); // see it again soon this session
    save();
    celebrate(ok, () => {
      if (!ok && conf === 3) {
        // Hypercorrection: confident errors are the most fixable, so make the correction stick
        $("#fcard").insertAdjacentHTML("beforeend", `<div class="alert"><b>Confident but wrong. This one is worth fixing.</b><br>Read the answer again carefully. It will come back in a few cards.<div style="margin-top:.5rem"><button id="cont">Continue</button></div></div>`);
        $("#cont").onclick = showCard; $("#cont").focus();
      } else showCard();
    });
  };
  el.onkeydown = null;
  document.onkeydown = (e) => {
    if (!location.hash.startsWith("#review/") || e.target.tagName === "TEXTAREA" && !e.target.readOnly && e.key !== "Escape") return;
    const answerShown = $("#answer") && $("#answer").innerHTML;
    if (!answerShown && ["1", "2", "3"].includes(e.key)) { const b = el.querySelector(`#confRow [data-c="${e.key}"]`); b && b.click(); }
    else if (!answerShown && e.key === " ") { e.preventDefault(); $("#reveal") && $("#reveal").click(); }
    else if (answerShown && ["1", "2", "3", "4"].includes(e.key)) { const b = el.querySelector(`[data-r="${e.key}"]`); b && !b.disabled && b.click(); }
  };
  showCard();
}

// ---------- Blurt ----------
function lastBlurtScore(b) {
  const runs = S.blurts.filter((x) => x.t === b.t);
  if (!runs.length) return -1;
  const r = runs[runs.length - 1];
  return r.score / r.total;
}
function blurt(el, [title]) {
  const all = BLURTS.concat(S.customBlurts);
  const b = title && all.find((x) => x.t === title);
  if (!b) {
    el.innerHTML = `<h1>Blurt</h1>
      <p class="muted">Write down everything you know about a topic from memory, then check it against the key points. Any points you missed become flashcards.</p>
      ${Object.entries(SUBJECTS).map(([s, v]) => `<h2>${v.name}</h2><div class="grid">${all.filter((x) => x.s === s).map((x) => {
        const sc = lastBlurtScore(x);
        return `<a class="card subj" style="--c:${v.colour};text-decoration:none;color:inherit" href="#blurt/${encodeURIComponent(x.t)}"><b>${esc(x.t)}</b><div class="muted small">${x.points.length} points · ${sc < 0 ? "not tried" : "last " + Math.round(sc * 100) + "%"}</div></a>`;
      }).join("")}</div>`).join("")}
      <h2>Add your own blurt topic</h2>
      <div class="card">
        <label>Subject</label><select id="bs">${subjOptions()}</select>
        <label>Topic title</label><input id="bt">
        <label>Key points (one per line)</label><textarea id="bp"></textarea>
        <button class="primary" id="addB" style="margin-top:.6rem">Add topic</button>
      </div>`;
    $("#addB", el).onclick = () => {
      const t = $("#bt").value.trim(), points = $("#bp").value.split("\n").map((x) => x.trim()).filter(Boolean);
      if (!t || !points.length) return alert("Add a title and at least one point.");
      if (all.some((x) => x.t === t)) return alert("A topic with that title already exists.");
      S.customBlurts.push({ s: $("#bs").value, t, points }); save(); render();
    };
    return;
  }
  el.innerHTML = `<div class="flash"><h1>Blurt: ${esc(b.t)}</h1>
    <p class="muted">${SUBJECTS[b.s].name}. Write down everything you can remember: facts, keywords, quotes, scholars, dates. No notes.</p>
    <div class="big-timer" id="bt">${fmtTime(S.settings.blurtMins * 60)}</div>
    <textarea id="dump" style="min-height:16rem" placeholder="Start writing…"></textarea>
    <div class="row" style="margin-top:.6rem"><button class="primary" id="check">I'm done, check it</button></div>
    <div id="res"></div></div>`;
  const stop = countdown(S.settings.blurtMins * 60, (s) => { $("#bt").textContent = fmtTime(s); }, () => { $("#bt").textContent = "Time!"; });
  $("#dump").focus();
  $("#check").onclick = () => {
    stop(); $("#check").remove(); $("#dump").readOnly = true;
    $("#res").innerHTML = `<h2>Tick the points you got</h2><div class="card checklist">${b.points.map((p, i) => `<label><input type="checkbox" data-i="${i}"> ${esc(p)}</label>`).join("")}</div>
      <button class="primary" id="score" style="margin-top:.6rem">Save &amp; make cards from what I missed</button>`;
    $("#score").onclick = () => {
      const boxes = [...el.querySelectorAll(".checklist input")];
      const missed = boxes.filter((x) => !x.checked).map((x) => b.points[+x.dataset.i]);
      const got = boxes.length - missed.length;
      S.blurts.push({ t: b.t, s: b.s, date: Date.now(), score: got, total: boxes.length });
      let added = 0;
      missed.forEach((p) => {
        const id = "u" + hash(b.s + "|" + b.t + "|" + p);
        if (!S.custom.some((c) => c.id === id)) {
          const hint = p.split(" ").slice(0, 3).join(" ");
          S.custom.push({ id, s: b.s, t: b.t, f: `${b.t}: recall the key point beginning "${hint}…"`, b: p }); added++;
        }
      });
      logToday("blurts"); save();
      $("#res").innerHTML = `<div class="card ${got / boxes.length >= 0.7 ? "ok" : ""}" style="margin-top:1rem"><b>${got}/${boxes.length} recalled.</b> ${added ? `${added} new card(s) added for the points you missed. They'll come up in review.` : ""}<div class="row" style="margin-top:.6rem"><a class="btn" href="#blurt">Another topic</a><a class="btn primary" href="#review/${b.s}">Review ${SUBJECTS[b.s].short}</a></div></div>`;
    };
  };
}

// ---------- Timed practice ----------
const PLAN_TEMPLATES = {
  eng: "Thesis (my argument in one sentence):\n\nPara 1 – point / quote / method (AO2) / context (AO3):\nPara 2 –\nPara 3 –\nCritic or alternative reading (AO5):\nComparison link (AO4, if a comparison question):\nConclusion / judgement:",
  his: "Judgement (answer the question in one line):\n\nFactor 1 – evidence – how far it supports the view:\nFactor 2 –\nFactor 3 –\nCounter-argument:\nHistorians / interpretation (AO3, if extract Q):\nSubstantiated conclusion:",
  bio: "Topics I'll link (aim for 4–5 areas of the spec):\n1.\n2.\n3.\n4.\n5.\nKey terms to use precisely:\nExamples beyond the spec:",
  re: "Thesis / line of argument:\n\nAO1: key scholars and terms:\nArgument 1 + evaluation:\nCounter-argument + response:\nArgument 2 + evaluation:\nJudgement that follows from the essay:",
};
function practice(el, [s]) {
  s = SUBJECTS[s] ? s : "eng";
  const v = SUBJECTS[s];
  const hist = S.practice.filter((p) => p.s === s);
  const aoAvg = v.aos.map(([ao]) => { const xs = hist.map((p) => p.ao && p.ao[ao]).filter((x) => x != null); return [ao, xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null]; });
  el.innerHTML = `<h1>Timed practice</h1>
    <p class="muted">Practise at real exam timing, then mark yourself against the assessment objectives.</p>
    <div class="row">${Object.entries(SUBJECTS).map(([k, x]) => `<a class="btn ${k === s ? "primary" : ""}" href="#practice/${k}">${x.short}</a>`).join("")}</div>
    <div class="card" style="margin-top:1rem">
      <label>Format (${v.board})</label><select id="paper">${v.papers.map((p, i) => `<option value="${i}">${esc(p.name)} · ${p.mins} min${p.marks ? ` · ${p.marks} marks` : ""}</option>`).join("")}</select>
      <label>Question</label><select id="qsel"><option value="">Random from the bank</option>${v.questions.map((q, i) => `<option value="${i}">${esc(q)}</option>`).join("")}<option value="own">My own question / past paper question…</option></select>
      <input id="ownq" placeholder="Paste your question" style="display:none;margin-top:.4rem">
      <button class="primary" id="start" style="margin-top:.8rem">Start the clock</button>
    </div>
    <h2>Your AO profile (${v.short})</h2>
    <div class="card">${hist.length ? aoAvg.map(([ao, avg]) => `<div class="bar"><span style="width:3rem">${ao}</span><div class="track"><div class="fill" style="width:${avg == null ? 0 : (avg / 5) * 100}%;background:${v.colour}"></div></div><span style="width:3rem">${avg == null ? "–" : avg.toFixed(1)}/5</span></div>`).join("") + `<p class="small muted">Your lowest bar is what to work on next.</p>` : `<p class="muted">No attempts yet.</p>`}</div>
    <h2>History</h2>
    ${hist.length ? `<table><tr><th>Date</th><th>Question</th><th>Mark</th></tr>${hist.slice().reverse().map((p) => `<tr><td>${new Date(p.date).toLocaleDateString("en-GB")}</td><td>${esc(p.q)}${p.improve ? `<div class="small muted">Next time: ${esc(p.improve)}</div>` : ""}</td><td>${p.total ? `${p.mark}/${p.total}` : "plan"}</td></tr>`).join("")}</table>` : `<p class="muted">Nothing yet.</p>`}`;
  $("#qsel", el).onchange = (e) => { $("#ownq").style.display = e.target.value === "own" ? "block" : "none"; };
  $("#start", el).onclick = () => {
    const p = v.papers[+$("#paper").value];
    const sel = $("#qsel").value;
    const q = sel === "own" ? $("#ownq").value.trim() || "My own question" : sel === "" ? pick(v.questions) : v.questions[+sel];
    runPractice(el, s, p, q);
  };
}
function runPractice(el, s, p, q) {
  const v = SUBJECTS[s], started = Date.now();
  el.innerHTML = `<h1>${esc(p.name)}</h1>
    <div class="card"><b>${esc(q)}</b></div>
    <div class="big-timer" id="clock">${fmtTime(p.mins * 60)}</div>
    <p class="muted small" style="text-align:center">${p.marks ? `About ${(p.mins / p.marks).toFixed(1)} min per mark. ` : ""}Plan first. Write your essay on paper or below.</p>
    <textarea id="work" style="min-height:22rem">${PLAN_TEMPLATES[s]}</textarea>
    <button class="primary" id="fin" style="margin-top:.6rem">Finish &amp; self-mark</button>
    <div id="mark"></div>`;
  const stop = countdown(p.mins * 60, (t) => { $("#clock").textContent = fmtTime(t); }, () => { $("#clock").textContent = "Time's up ✋"; $("#clock").style.color = "var(--bad)"; });
  $("#fin").onclick = () => {
    stop(); $("#fin").remove();
    $("#mark").innerHTML = `<h2>Self-mark</h2><div class="card">
      <p class="small muted" style="margin-top:0">Rate how well your answer hit each assessment objective (0 = not at all, 5 = top band). Use the mark scheme or level descriptors if you have them.</p>
      ${v.aos.map(([ao, desc]) => `<label>${ao}: ${esc(desc)}</label><input type="range" min="0" max="5" value="3" data-ao="${ao}">`).join("")}
      ${p.marks ? `<label>Mark (out of ${p.marks})</label><input type="number" id="mk" min="0" max="${p.marks}">` : ""}
      <label>One thing to do better next time</label><input id="imp">
      <button class="primary" id="savep" style="margin-top:.8rem">Save</button></div>`;
    $("#savep").onclick = () => {
      const ao = {}; el.querySelectorAll("[data-ao]").forEach((r) => ao[r.dataset.ao] = +r.value);
      S.practice.push({ s, paper: p.name, q, date: Date.now(), mins: Math.round((Date.now() - started) / 60000), ao, mark: p.marks ? +($("#mk").value || 0) : null, total: p.marks || null, improve: $("#imp").value, work: $("#work").value });
      logToday("practice"); save(); location.hash = "practice/" + s; render();
    };
  };
}

// ---------- Past papers ----------
function papers(el) {
  el.innerHTML = `<h1>Past papers</h1>
    <p class="muted">Log every past paper. Each lost mark is a gap in what you know, so turn it into a card.</p>
    <div class="card">
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
        <div><label>Subject</label><select id="ps">${subjOptions()}</select></div>
        <div><label>Paper (e.g. "June 2023 P1")</label><input id="pn"></div>
        <div><label>Mark</label><input id="pm" type="number" min="0"></div>
        <div><label>Out of</label><input id="pt" type="number" min="1"></div>
      </div>
      <label>Where did I lose marks?</label><textarea id="pl" style="min-height:4rem"></textarea>
      <button class="primary" id="addp" style="margin-top:.6rem">Log paper</button>
    </div>
    ${Object.entries(SUBJECTS).map(([s, v]) => {
      const ps = S.papers.filter((p) => p.s === s);
      if (!ps.length) return "";
      return `<h2>${v.name}</h2>${ps.map((p) => { const pc = Math.round((p.mark / p.total) * 100); return `<div class="bar"><span style="width:9rem" class="small">${esc(p.name)}</span><div class="track"><div class="fill" style="width:${pc}%;background:${v.colour}"></div></div><span style="width:5rem">${p.mark}/${p.total} (${pc}%)</span></div>${p.lost ? `<div class="small muted" style="margin:0 0 .5rem 9.5rem">${esc(p.lost)}</div>` : ""}`; }).join("")}`;
    }).join("")}
    <h2>Quick card from a lost mark</h2>
    <div class="card">
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"><div><label>Subject</label><select id="qs">${subjOptions()}</select></div><div><label>Topic</label><input id="qt" placeholder="e.g. 3. Exchange with the environment"></div></div>
      <label>Question</label><input id="qf"><label>Mark-scheme answer</label><textarea id="qb" style="min-height:4rem"></textarea>
      <button id="addq" style="margin-top:.6rem">Add card</button> <span id="qmsg" class="small muted"></span>
    </div>`;
  $("#addp", el).onclick = () => {
    const mark = +$("#pm").value, total = +$("#pt").value, name = $("#pn").value.trim();
    if (!name || !total || mark > total) return alert("Fill in the paper name, mark and total.");
    S.papers.push({ s: $("#ps").value, name, mark, total, lost: $("#pl").value.trim(), date: Date.now() });
    logToday("papers"); save(); render();
  };
  $("#addq", el).onclick = () => { if (addCustomCard($("#qs").value, $("#qt").value, $("#qf").value, $("#qb").value)) { $("#qf").value = $("#qb").value = ""; $("#qmsg").textContent = "Added ✓"; } };
}
function addCustomCard(s, t, f, b, sub) {
  f = f.trim(); b = b.trim(); t = t.trim() || "My cards"; sub = (sub || "").trim() || "My cards";
  if (!f || !b) { alert("Fill in both the question and the answer."); return false; }
  S.custom.push({ id: "u" + hash(s + "|" + f + Date.now()), s, t, f, b, sub }); save(); return true;
}

// ---------- Topics (RAG) ----------
const RAG = ["Not rated", "🔴 Red", "🟠 Amber", "🟢 Green"];
function topics(el) {
  el.innerHTML = `<h1>Topic tracker</h1>
    <p class="muted">Topics are ticked automatically when Google Classroom shows you've been taught them (📚). Tick any others you've done in class, or untick ones that aren't right; Classroom won't re-tick them. As soon as you tick one for a subject, new flashcards for that subject only come from covered topics, so you aren't tested on things you haven't learned yet. Then rate each topic red, amber or green, honestly. A blurt or past question will show whether "green" really is green.</p>
    ${Object.entries(SUBJECTS).map(([s, v]) => {
      const counts = [0, 0, 0, 0]; v.topics.forEach((t) => counts[S.rag[s + "|" + t] || 0]++);
      return `<h2>${v.name} <span class="pill">${v.board}</span></h2>
      <div class="small muted">🔴 ${counts[1]} · 🟠 ${counts[2]} · 🟢 ${counts[3]} · unrated ${counts[0]}</div>
      <div class="card" style="margin-top:.5rem">${v.topics.map((t) => { const r = S.rag[s + "|" + t] || 0; return `<div class="rag"><label style="display:flex;gap:.5rem;align-items:center;margin:0;color:var(--ink);font-size:1rem"><input type="checkbox" style="width:auto" data-cov="${esc(s + "|" + t)}" ${S.covered[s + "|" + t] === true ? "checked" : ""}><span>${esc(t)}${S.taught[s + "|" + t] ? `<span class="small muted" style="display:block">📚 Classroom ${parseKey(S.taught[s + "|" + t].date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}: ${esc(S.taught[s + "|" + t].title.slice(0, 60))}</span>` : ""}</span></label><button class="rag-${r}" data-k="${esc(s + "|" + t)}">${RAG[r]}</button></div>`; }).join("")}</div>`;
    }).join("")}`;
  el.querySelectorAll("[data-k]").forEach((b) => b.onclick = () => {
    const k = b.dataset.k, r = ((S.rag[k] || 0) % 3) + 1;
    S.rag[k] = r; save(); b.className = "rag-" + r; b.textContent = RAG[r];
  });
  el.querySelectorAll("[data-cov]").forEach((c) => c.onchange = () => { S.covered[c.dataset.cov] = c.checked; save(); });
}

// ---------- Timeline (History) ----------
function timeline(el, [period]) {
  const periods = Object.keys(TIMELINE);
  if (!period || !TIMELINE[period]) {
    el.innerHTML = `<h1>Timeline trainer</h1><p class="muted">Chronology is the backbone of AQA History essays. Tap the events in date order.</p>
      <div class="grid">${periods.map((p) => `<a class="card subj" style="--c:${SUBJECTS.his.colour};text-decoration:none;color:inherit" href="#timeline/${encodeURIComponent(p)}"><b>${p}</b><div class="muted small">${TIMELINE[p].length} events${S.timeline[p] ? ` · best ${S.timeline[p]}/6` : ""}</div></a>`).join("")}</div>
      ${periods.map((p) => `<h2>${p}</h2><table>${TIMELINE[p].map(([y, e]) => `<tr><td style="width:4rem"><b>${y}</b></td><td>${esc(e)}</td></tr>`).join("")}</table>`).join("")}`;
    return;
  }
  // Choose 6 events with distinct years
  const pool = shuffle(TIMELINE[period]), round = [], years = new Set();
  for (const ev of pool) { if (!years.has(ev[0])) { years.add(ev[0]); round.push(ev); } if (round.length === 6) break; }
  const order = [];
  el.innerHTML = `<h1>${period}</h1><p class="muted">Tap the events from <b>earliest</b> to <b>latest</b>.</p><div id="tl">${round.map((ev, i) => `<div class="tl-item" data-i="${i}"><span>${esc(ev[1])}</span><span class="yr muted"></span></div>`).join("")}</div><div id="tlres"></div>`;
  el.querySelectorAll(".tl-item").forEach((d) => d.onclick = () => {
    if (d.classList.contains("picked")) return;
    d.classList.add("picked"); order.push(+d.dataset.i);
    d.querySelector(".yr").textContent = "#" + order.length;
    if (order.length === round.length) {
      const sorted = round.map((e, i) => [e[0], i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      let score = 0;
      order.forEach((idx, pos) => { const ok = sorted[pos] === idx; if (ok) score++; const node = el.querySelector(`[data-i="${idx}"]`); node.classList.remove("picked"); node.classList.add(ok ? "right" : "wrong"); });
      el.querySelectorAll(".tl-item").forEach((n) => { const ev = round[+n.dataset.i]; n.querySelector(".yr").innerHTML = `<b>${ev[0]}</b>`; });
      S.timeline[period] = Math.max(S.timeline[period] || 0, score); logToday("timeline"); save();
      $("#tlres").innerHTML = `<div class="card" style="margin-top:1rem"><b>${score}/6 in the right position.</b> Correct order: ${sorted.map((i) => `${round[i][0]}`).join(" → ")}<div class="row" style="margin-top:.6rem"><button class="primary" id="again">Another round</button><a class="btn" href="#timeline">All events</a></div></div>`;
      $("#again").onclick = render;
    }
  });
}

// ---------- Coursework (NEA) ----------
const MILESTONES = ["Question / texts agreed with teacher", "Primary reading & annotation done", "Critics / historians gathered", "Detailed plan", "First draft", "Teacher feedback received", "Second draft", "Referencing & bibliography", "Final proofread & submitted"];
function coursework(el) {
  const block = (k, title, sub) => {
    const n = S.nea[k], pc = Math.min(100, (n.words / n.max) * 100), ms = MILESTONES.filter((_, i) => n.done[i]).length;
    const days = n.deadline ? Math.ceil((new Date(n.deadline).getTime() - Date.now()) / DAY) : null;
    return `<h2>${title}</h2><div class="card subj" style="--c:${SUBJECTS[k].colour}">
      <div class="muted small">${sub}${days !== null ? ` · <b>${days} days</b> to deadline` : ""}</div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
        <div><label>Current word count</label><input type="number" data-n="${k}" data-f="words" value="${n.words}"></div>
        <div><label>Deadline</label><input type="date" data-n="${k}" data-f="deadline" value="${n.deadline}"></div>
      </div>
      <div class="bar" style="margin-top:.6rem"><span class="small" style="width:5rem">Words</span><div class="track"><div class="fill" style="width:${pc}%;background:${n.words >= n.min ? "var(--good)" : SUBJECTS[k].colour}"></div></div><span class="small">${n.words}/${n.min}–${n.max}</span></div>
      <div class="bar"><span class="small" style="width:5rem">Milestones</span><div class="track"><div class="fill" style="width:${(ms / MILESTONES.length) * 100}%;background:${SUBJECTS[k].colour}"></div></div><span class="small">${ms}/${MILESTONES.length}</span></div>
      <div class="checklist" style="margin-top:.6rem">${MILESTONES.map((m, i) => `<label><input type="checkbox" data-m="${k}" data-i="${i}" ${n.done[i] ? "checked" : ""}> ${m}</label>`).join("")}</div>
      <label>Notes, sources, feedback</label><textarea data-n="${k}" data-f="notes">${esc(n.notes)}</textarea>
    </div>`;
  };
  el.innerHTML = `<h1>Coursework</h1><p class="muted">Track both NEAs. Check the titles, texts and deadlines with your teachers.</p>
    ${block("eng", "English Literature: Prose Study (Component 4)", "Comparative essay, 2,500–3,500 words, 20% of the A level")}
    ${block("his", "History: Historical Investigation (Component 3)", "Ireland & Britain 1798–1921 · 3,000–3,500 words · 20%")}`;
  el.querySelectorAll("[data-n]").forEach((i) => i.onchange = () => { const v = i.dataset.f === "words" ? +i.value || 0 : i.value; S.nea[i.dataset.n][i.dataset.f] = v; save(); if (i.dataset.f !== "notes") render(); });
  el.querySelectorAll("[data-m]").forEach((i) => i.onchange = () => { S.nea[i.dataset.m].done[i.dataset.i] = i.checked; save(); render(); });
}

// ---------- Cards browser ----------
function cardsView(el) {
  const draw = () => {
    const s = $("#fs").value, q = $("#fq").value.toLowerCase();
    const list = allCards().filter((c) => (!s || c.s === s) && (!q || (c.f + c.b + c.t).toLowerCase().includes(q)));
    $("#list").innerHTML = `<p class="small muted">${list.length} cards</p><table><tr><th>Card</th><th>Status</th><th></th></tr>${list.slice(0, 300).map((c) => {
      const r = S.srs[c.id];
      const status = !r ? "new" : r.due <= Date.now() ? "due" : `in ${Math.ceil((r.due - Date.now()) / DAY)}d`;
      return `<tr><td><span class="pill" style="background:${SUBJECTS[c.s].colour};color:#fff">${SUBJECTS[c.s].short}</span> <span class="small muted">${esc(c.t)} › ${esc(c.sub)}</span><div><b>${esc(c.f)}</b></div><div class="small">${esc(c.b)}</div></td><td class="small">${status}</td><td><button class="small" data-del="${c.id}" title="${c.custom ? "Delete" : "Hide"}">${c.custom ? "Delete" : "Hide"}</button></td></tr>`;
    }).join("")}</table>`;
    $("#list").querySelectorAll("[data-del]").forEach((b) => b.onclick = () => {
      const id = b.dataset.del;
      if (!confirm("Remove this card from your reviews?")) return;
      if (S.custom.some((c) => c.id === id)) S.custom = S.custom.filter((c) => c.id !== id); else S.suspended[id] = true;
      delete S.srs[id]; save(); draw();
    });
  };
  el.innerHTML = `<h1>Cards</h1>
    <div class="card"><h2 style="margin-top:0">Add a card</h2>
      <p class="small muted" style="margin-top:0">Good cards ask one specific question. Make quotation cards short (3–6 words) and tag them by theme in the topic.</p>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"><div><label>Subject</label><select id="as">${subjOptions()}</select></div><div><label>Topic</label><input id="at" list="topicList"></div><div><label>Subtopic</label><input id="asub" placeholder="e.g. Enzymes"></div></div>
      <datalist id="topicList">${[...new Set(Object.values(SUBJECTS).flatMap((v) => v.topics))].map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
      <label>Question (front)</label><input id="af"><label>Answer (back)</label><textarea id="ab" style="min-height:4rem"></textarea>
      <button class="primary" id="add" style="margin-top:.6rem">Add card</button> <span id="amsg" class="small muted"></span>
    </div>
    <h2>Browse</h2>
    <div class="row"><select id="fs" style="max-width:220px"><option value="">All subjects</option>${subjOptions("")}</select><input id="fq" placeholder="Search…" style="max-width:300px"></div>
    <div id="list"></div>
    ${Object.keys(S.suspended).length ? `<p><button id="unhide">Restore ${Object.keys(S.suspended).length} hidden card(s)</button></p>` : ""}`;
  $("#add", el).onclick = () => { if (addCustomCard($("#as").value, $("#at").value, $("#af").value, $("#ab").value, $("#asub").value)) { $("#af").value = $("#ab").value = ""; $("#amsg").textContent = "Added ✓"; draw(); } };
  $("#fs", el).onchange = draw; $("#fq", el).oninput = draw;
  const u = $("#unhide", el); if (u) u.onclick = () => { S.suspended = {}; save(); render(); };
  draw();
}

// ---------- Lesson notes ----------
// Notes are saved in the browser. js/notes-checked.js holds Claude's check of each note, matched by note id and a hash of its
// text, so editing a note sends it back for checking. Only checked cards reach your reviews. See CLAUDE.md for the check itself.
const myNotes = () => S.notes.filter((n) => SUBJECTS[n.s]);
function noteCheck(n) { const c = NOTES_CHECKED[n.id]; return c && c.hash === hash(n.text) ? c : null; }
const noteDate = (k) => parseKey(k).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
function noteCards() {
  return myNotes().flatMap((n) => {
    const c = noteCheck(n);
    return !c ? [] : c.cards.map(([f, b, sub]) => ({ id: "n" + hash(n.id + "|" + f), s: n.s, t: n.t, f, b, sub: sub || "My lesson notes", src: `My notes: ${n.title}, ${noteDate(n.date)}`, note: true, custom: false }));
  });
}
// Instant first-draft cards from how a note is written. Claude's check replaces these with proper ones.
function draftCards(text) {
  const out = [], seen = new Set();
  const add = (f, b) => { const k = f.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push([f, b]); } };
  const lines = text.split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, "").trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const wordCount = (x) => x.trim().split(/\s+/).length;
    if (/\?$/.test(l)) { if (lines[i + 1] && !/\?$/.test(lines[i + 1])) add(l, lines[++i]); continue; } // question, answer on the next line
    let m = l.match(/^(.{2,60}?)\s*(?::|=|→|->|\s[-–—]\s)\s*(.{3,})$/); // Term: meaning
    if (m && wordCount(m[1]) <= 7) { add(/^\d{4}s?$/.test(m[1]) ? `What happened in ${m[1]}?` : `What is meant by "${m[1]}"?`, m[2]); continue; }
    m = l.match(/^([^,.;]{2,50}?)\s+(is|are|was|were)\s+(.{5,})$/i); // X is Y
    if (m && wordCount(m[1]) <= 6 && !/^(it|this|that|these|those|he|she|they|there|we|you|i)\b/i.test(m[1])) { add(`What ${m[2].toLowerCase()} ${m[1].replace(/^(The|A|An)\b/, (a) => a.toLowerCase())}?`, l); continue; }
    m = l.match(/\b(1\d{3}|20\d\d)\b/); // a line with a year in it
    if (m && wordCount(l) >= 4) add(`What happened in ${m[1]}?`, l);
  }
  return out;
}
// Displays a note: "# heading", "- bullet" and "Term: meaning" lines get formatted; the rest are paragraphs
function noteHtml(text) {
  let html = "", inList = false;
  const term = (l) => { const m = l.match(/^([^:]{2,60}):\s+(.+)$/); return m ? `<b>${esc(m[1])}:</b> ${esc(m[2])}` : esc(l); };
  for (const raw of text.split("\n")) {
    const l = raw.trim(), b = l.match(/^(?:[-*•–]|\d+[.)])\s+(.*)$/);
    if (b && !inList) { html += "<ul>"; inList = true; }
    if (!b && inList) { html += "</ul>"; inList = false; }
    if (b) html += `<li>${term(b[1])}</li>`;
    else if (/^#/.test(l)) html += `<h3>${esc(l.replace(/^#+\s*/, ""))}</h3>`;
    else if (l) html += `<p>${term(l)}</p>`;
  }
  return html + (inList ? "</ul>" : "");
}
function noteStatus(n) {
  const c = noteCheck(n); if (!c) return `<span class="pill note-wait">⏳ Waiting for check</span>`;
  const wrong = c.issues.filter((i) => i.type === "wrong").length, unsure = c.issues.length - wrong;
  return `<span class="pill note-ok">✓ Checked</span>${wrong ? ` <span class="pill note-wrong">${wrong} corrected</span>` : ""}${unsure ? ` <span class="pill note-wait">${unsure} to ask about</span>` : ""}`;
}
const cardList = (cards) => cards.length ? `<ul class="qlist">${cards.map(([f, b]) => `<li><details><summary>${esc(f)}</summary><div class="small qa">${esc(b)}</div></details></li>`).join("")}</ul>` : `<p class="small muted">None yet.</p>`;
function noteBody(n) {
  const c = noteCheck(n);
  return `<div class="note-body">
    ${c && c.issues.length ? c.issues.map((i) => `<div class="alert small ${i.type === "wrong" ? "" : "unsure"}">${i.type === "wrong" ? `<b>Corrected.</b> You wrote "${esc(i.you)}". <b>${esc(i.fix)}</b>` : `<b>Ask your teacher.</b> "${esc(i.you)}". ${esc(i.fix)}`}${i.why ? ` <span>${esc(i.why)}</span>` : ""}</div>`).join("") : ""}
    ${c && c.summary ? `<p class="small muted">${esc(c.summary)}</p>` : ""}
    <div class="note-text">${noteHtml(c ? c.text : n.text)}</div>
    ${c && c.text !== n.text ? `<details class="small"><summary>What you originally wrote</summary><div class="qa">${esc(n.text)}</div></details>` : ""}
    <h3>${c ? `Flashcards in your reviews (${c.cards.length})` : `Draft flashcards (${draftCards(n.text).length}), not in your reviews until checked`}</h3>
    ${cardList(c ? c.cards : draftCards(n.text))}
    <div class="row" style="margin-top:.6rem"><a class="btn small" href="#notes/edit/${esc(n.id)}">Edit</a><button class="small" data-note-del="${esc(n.id)}">Delete</button></div>
  </div>`;
}
let noteMsg = "";
function notes(el, [mode, id]) {
  if (mode === "new" || mode === "edit") return noteEditor(el, mode === "edit" ? id : null);
  const waiting = myNotes().filter((n) => !noteCheck(n));
  el.innerHTML = `<div class="row spread"><h1>Notes</h1><a class="btn primary" href="#notes/new">＋ New note</a></div>
    <p class="muted">Write up what you cover in lessons. Each note becomes draft flashcards straight away. Once Claude has checked a note, the corrected version appears here and its cards join your reviews.</p>
    ${noteMsg ? `<div class="alert ok small">${esc(noteMsg)}</div>` : ""}
    ${waiting.length ? `<div class="card" style="margin-bottom:1rem"><b>${waiting.length} note${waiting.length === 1 ? "" : "s"} waiting for a check</b>
      <p class="small muted" style="margin:.3rem 0 .6rem">This saves them to a file in your Downloads. Then tell Claude "check my notes" and reload this page when it's done. Nothing is uploaded by the app.</p>
      <button id="sendNotes">Save notes for checking</button> <span id="sendMsg" class="small"></span></div>` : ""}
    ${S.notes.length ? `<input id="noteQ" placeholder="Search your notes…" style="max-width:320px">` : ""}
    <div id="noteTree"></div>`;
  noteMsg = "";
  const draw = (q = "") => {
    q = q.toLowerCase();
    const shown = myNotes().filter((n) => !q || (n.title + " " + n.t + " " + n.text + " " + ((noteCheck(n) || {}).text || "")).toLowerCase().includes(q));
    const tree = $("#noteTree", el);
    tree.innerHTML = !S.notes.length ? `<div class="card"><p style="margin:0">No notes yet. Add one in your next lesson.</p></div>`
      : !shown.length ? `<p class="muted">No notes match that.</p>`
      : Object.entries(SUBJECTS).map(([s, v]) => {
        const sn = shown.filter((n) => n.s === s); if (!sn.length) return "";
        const ts = [...new Set(v.topics.concat(sn.map((n) => n.t)))].filter((t) => sn.some((n) => n.t === t));
        return `<h2 style="border-left:5px solid ${v.colour};padding-left:.5rem">${v.name} <span class="small muted" style="font-weight:400">${sn.length} note${sn.length === 1 ? "" : "s"}</span></h2>
          ${ts.map((t) => { const tn = sn.filter((n) => n.t === t).sort((a, b) => a.date.localeCompare(b.date));
            return `<details class="tree" ${q ? "open" : ""}><summary><span class="tree-name">${esc(t)}</span><span class="small muted">${tn.length}</span></summary>
              ${tn.map((n) => `<details class="tree sub" ${q ? "open" : ""}><summary><span class="tree-name">${esc(n.title)}<span class="small muted" style="font-weight:400"> · ${noteDate(n.date)}</span></span>${noteStatus(n)}</summary>${noteBody(n)}</details>`).join("")}</details>`; }).join("")}`;
      }).join("");
    tree.querySelectorAll("[data-note-del]").forEach((b) => b.onclick = () => {
      if (!confirm("Delete this note and its flashcards?")) return;
      S.notes = S.notes.filter((n) => n.id !== b.dataset.noteDel); save(); render();
    });
  };
  draw();
  const q = $("#noteQ", el); if (q) q.oninput = () => draw(q.value);
  const send = $("#sendNotes", el);
  if (send) send.onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: "astar-notes", exported: todayKey(), notes: waiting.map((n) => ({ id: n.id, hash: hash(n.text), subject: SUBJECTS[n.s].name, board: SUBJECTS[n.s].board, topic: n.t, title: n.title, date: n.date, text: n.text })) }, null, 1)], { type: "application/json" }));
    a.download = `astar-notes-${todayKey()}.json`; a.click();
    const m = $("#sendMsg", el); m.textContent = `Saved ${waiting.length} to your Downloads. Now tell Claude "check my notes".`; m.style.color = "var(--good)";
  };
}
function noteEditor(el, id) {
  const editing = id ? S.notes.find((n) => n.id === id) : null;
  if (id && !editing) { location.hash = "#notes"; return; }
  const draftFits = S.noteDraft && S.noteDraft.id === (id || null);
  const d = draftFits ? S.noteDraft : editing ? { ...editing } : { s: S.noteLast && SUBJECTS[S.noteLast] ? S.noteLast : PLAN_KEYS[0], t: "", title: "", date: todayKey(), text: "" };
  const topicOptions = (s, sel) => {
    const list = SUBJECTS[s].topics.concat(sel && !SUBJECTS[s].topics.includes(sel) ? [sel] : []);
    return `<option value="">Work it out from my note</option>` + list.map((t) => `<option value="${esc(t)}" ${t === sel ? "selected" : ""}>${esc(t)}</option>`).join("");
  };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  el.innerHTML = `<h1>${editing ? "Edit note" : "New note"}</h1>
    ${draftFits && d.text ? `<p class="small muted">Carried on from your unsaved note.</p>` : ""}
    ${editing && noteCheck(editing) ? `<div class="alert unsure small">This note has been checked. If you change its text, its cards leave your reviews until it's checked again.</div>` : ""}
    <div class="card">
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr))">
        <div><label for="ns">Subject</label><select id="ns">${subjOptions(d.s)}</select></div>
        <div><label for="nt">Topic</label><select id="nt">${topicOptions(d.s, d.t)}</select></div>
        <div><label for="nd">Lesson date</label><input id="nd" type="date" value="${esc(d.date)}"></div>
      </div>
      <label for="nh">Lesson title (optional)</label><input id="nh" value="${esc(d.title)}" placeholder="e.g. Enzyme inhibition">
      <div class="row spread" style="margin-top:.6rem"><label for="nx" style="margin:0">Your notes</label>${SR ? `<button id="dictate" class="small" type="button">🎙 Dictate</button>` : ""}</div>
      <textarea id="nx" class="note-input" style="margin-top:.3rem" placeholder="Term: what it means&#10;- A key point&#10;In 1861 Alexander II emancipated the serfs">${esc(d.text)}</textarea>
      <p class="small muted" style="margin:.4rem 0"><span id="draftCount"></span> Lines like "Term: meaning" and "X is Y" make the best draft cards. Claude writes cards for everything else when it checks the note.</p>
      <div class="row"><button class="primary" id="saveNote">Save note</button><a class="btn" href="#notes" id="cancelNote">Cancel</a> <span id="noteErr" class="small" style="color:var(--bad)"></span></div>
    </div>`;
  const persist = () => { S.noteDraft = { id: id || null, s: $("#ns", el).value, t: $("#nt", el).value, title: $("#nh", el).value, date: $("#nd", el).value, text: $("#nx", el).value }; save(); };
  const count = () => { const n = draftCards($("#nx", el).value).length; $("#draftCount", el).textContent = `${n} draft card${n === 1 ? "" : "s"} so far.`; };
  count();
  $("#ns", el).onchange = () => { $("#nt", el).innerHTML = topicOptions($("#ns", el).value, ""); persist(); };
  ["#nt", "#nd", "#nh"].forEach((x) => { $(x, el).onchange = persist; });
  $("#nx", el).oninput = () => { persist(); count(); };
  $("#cancelNote", el).onclick = () => { S.noteDraft = null; save(); };
  $("#saveNote", el).onclick = () => {
    const s = $("#ns", el).value, text = $("#nx", el).value.trim(), title = $("#nh", el).value.trim(), date = $("#nd", el).value || todayKey();
    if (!text) { $("#noteErr", el).textContent = "Write something first."; return; }
    const t = $("#nt", el).value || matchTopics(s, title + " " + text)[0] || "Other notes";
    const finalTitle = title || text.split("\n")[0].replace(/^[-*•#\s]+/, "").slice(0, 50);
    if (editing) Object.assign(editing, { s, t, title: finalTitle, date, text });
    else S.notes.push({ id: "n" + hash(text + Date.now() + Math.random()), s, t, title: finalTitle, date, text, added: Date.now() });
    S.noteDraft = null; S.noteLast = s; save();
    noteMsg = `Saved under ${SUBJECTS[s].short} › ${t}. It has ${draftCards(text).length} draft cards, waiting for a check.`;
    location.hash = "#notes";
  };
  // Dictation uses the browser's own speech recognition, where it has it (Chrome sends the audio to Google to transcribe)
  const dict = $("#dictate", el);
  if (dict) {
    let rec = null, on = false;
    const stop = () => { on = false; if (rec) rec.stop(); dict.textContent = "🎙 Dictate"; window.removeEventListener("hashchange", stop); };
    dict.onclick = () => {
      if (on) return stop();
      rec = new SR(); rec.lang = "en-GB"; rec.continuous = true; rec.interimResults = false;
      rec.onresult = (e) => {
        const box = $("#nx", el); let said = "";
        for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) said += e.results[i][0].transcript;
        said = said.trim(); if (!said) return;
        box.value += (box.value && !box.value.endsWith("\n") ? "\n" : "") + said; persist(); count();
      };
      rec.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") { stop(); $("#noteErr", el).textContent = e.error === "not-allowed" ? "Astar isn't allowed to use the microphone. Allow it in your browser's site settings." : "Dictation stopped: " + e.error; } };
      rec.onend = () => { if (on) rec.start(); }; // browsers stop listening after a silence
      on = true; rec.start(); dict.textContent = "⏹ Stop dictating";
      window.addEventListener("hashchange", stop);
    };
  }
}

// ---------- Science ----------
function science(el) {
  const col = { Strong: "var(--good)", Moderate: "var(--warn)", Emerging: "var(--muted)", Low: "var(--bad)" };
  el.innerHTML = `<h1>Why it works</h1>
    <p class="muted">Every feature in Astar is based on research into how memory works. This shows the evidence behind each one and where it appears in the app.</p>
    ${SCIENCE.map(([name, ev, what, how]) => `<div class="card" style="margin:.7rem 0"><div class="row spread"><b>${name}</b><span class="pill" style="color:${col[ev]}">Evidence: ${ev}</span></div><p style="margin:.4rem 0">${what}</p><p class="small muted" style="margin:0">In Astar: ${how}</p></div>`).join("")}
    <h2>Your exam boards</h2>
    <div class="card">${Object.values(SUBJECTS).map((v) => `<div><b>${v.name}</b>: ${v.board}</div>`).join("")}<p class="small muted">Confirmed from Latymer's department pages${PLAN_KEYS.length < SUBJ_KEYS.length ? "; 🔭 subjects are ones you might switch to (see Settings)" : ""}. Check set texts, options and dates with your teachers.</p></div>
    <p class="small muted">Key sources: Dunlosky et al. (2013) <i>Improving Students' Learning With Effective Learning Techniques</i>; EEF Teaching &amp; Learning Toolkit; Cepeda et al. (2008); Rohrer et al. (2014); Butterfield &amp; Metcalfe (2001); Biwer et al. (2023); The Learning Scientists.</p>`;
}

// ---------- Settings ----------
function settings(el) {
  const st = S.settings;
  el.innerHTML = `<h1>Settings</h1>
    <div class="card"><h2 style="margin-top:0">Year 12 exam dates</h2>
      <p class="small muted" style="margin-top:0">Your end-of-Year 12 exams, which feed into your UCAS predicted grades. Put in the date of each subject's first paper (7 June 2027 is only a placeholder). Next year, change these to your A level dates. Review gaps shrink as the exam gets closer, and new cards stop ${st.stopNewDays} days before it so you can consolidate.</p>
      ${Object.entries(SUBJECTS).map(([s, v]) => `<label>${v.name}</label><input type="date" data-exam="${s}" value="${st.exams[s] || ""}">`).join("")}
    </div>
    <div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Subjects you might switch to 🔭</h2>
      <p class="small muted" style="margin-top:0">Tick a subject to add its flashcards, topics, blurts and timed practice. They stay out of your daily plan and the mixed review, so your current subjects aren't squeezed. Study them from their own card on the Flashcards page.</p>
      ${Object.entries(EXTRA_SUBJECTS).map(([k, v]) => `<label style="display:flex;gap:.5rem;align-items:center;font-weight:400"><input type="checkbox" data-extra="${k}" ${(st.extraSubjects || []).includes(k) ? "checked" : ""} style="width:auto"> <span><b>${v.name}</b> <span class="small muted">${v.board} · ${CARDS.filter((c) => c[0] === k).length} cards</span></span></label>`).join("")}
      ${EXTRA_NOTE ? `<p class="small muted">${EXTRA_NOTE}</p>` : ""}
    </div>
    <div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Planner</h2>
      <p class="small muted" style="margin-top:0">Revision time on top of homework. Year 12 is a marathon, not a sprint: steady daily sessions beat cramming. In the last 3 weeks before exams these go up by about a third.</p>
      <label>Minutes on a school day</label><input type="number" min="0" max="300" step="5" data-set="schoolMins" value="${st.schoolMins}">
      <label>Minutes on a weekend day</label><input type="number" min="0" max="480" step="5" data-set="weekendMins" value="${st.weekendMins}">
      <label>Minutes on a holiday day</label><input type="number" min="0" max="480" step="5" data-set="holidayMins" value="${st.holidayMins}">
      <label>Weekly rest day</label><select data-set="restDay">${DOW.map((d, i) => `<option value="${i}" ${i === +st.restDay ? "selected" : ""}>${d}</option>`).join("")}<option value="7" ${+st.restDay === 7 ? "selected" : ""}>No rest day</option></select>
      <label>School holidays (one per line: start end name). These are Enfield council's 2026–27 dates; check them against Latymer's calendar.</label>
      <textarea id="hols">${esc((S.holidays || []).map((h) => h.join(" ")).join("\n"))}</textarea>
      <button id="saveHols" style="margin-top:.5rem">Save holidays</button> <span id="holMsg" class="small muted"></span>
    </div>
    <div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Google Classroom sync</h2>
      <p class="small muted" style="margin-top:0">One-time setup, about 5 minutes. Afterwards, every time you open Astar it adds new Classroom homework to your planner and ticks off anything you've handed in. Keep your link private: anyone with it could see your homework titles and due dates.</p>
      <ol class="small" style="line-height:1.8">
        <li>Go to <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com</a>, signed in with your <b>school</b> Google account. A new project opens. Name it <b>Astar sync</b>.</li>
        <li>Delete what's in the editor, then <button class="small" id="copyScript" style="padding:.1rem .5rem">Copy the script</button> and paste it in. Press ⌘S to save.</li>
        <li>Click the ⚙︎ <b>Project Settings</b> cog on the left and tick <b>Show "appsscript.json" manifest file in editor</b>. Go back to the editor (&lt;&gt;), open <b>appsscript.json</b>, replace everything in it with <button class="small" id="copyManifest" style="padding:.1rem .5rem">Copy the settings file</button>, and save. This asks Google only for <i>student</i> permissions, which fixes "The caller does not have permission".</li>
        <li>Open <b>Code.gs</b>, pick <b>test</b> in the function menu at the top and click <b>Run</b>. Allow the permissions it asks for. (If you get "Google hasn't verified this app", click Advanced → Go to Astar sync. It's your own script.) The log lists each class and how many assignments it found.</li>
        <li>Deploy: <b>Deploy → New deployment</b> → ⚙︎ → <b>Web app</b>, with <i>Execute as</i>: <b>Me</b> and <i>Who has access</i>: <b>Anyone</b>. Copy the <b>Web app URL</b>. <i>Already deployed?</i> Use <b>Deploy → Manage deployments → ✏️ → Version: New version → Deploy</b> instead. Your link stays the same.</li>
        <li>Paste the URL below and click <b>Save &amp; test</b>.</li>
      </ol>
      <div class="row"><input id="syncUrl" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(st.syncUrl)}" style="flex:1;min-width:220px"><button class="primary" id="syncSave">Save &amp; test</button></div>
      <p id="syncMsg" class="small ${S.sync.ok === false ? "" : "muted"}" style="${S.sync.ok === false ? "color:var(--bad)" : ""}">${esc(S.sync.status)}</p>
      ${S.sync.courses ? `<details ${S.sync.ok && !S.sync.courses.some((c) => c.upcoming) ? "open" : ""}><summary class="small"><b>Last sync details</b>: what your script could see</summary><table class="small">${S.sync.courses.map((c) => `<tr><td>${esc(c.name)}</td><td style="${c.error ? "color:var(--bad)" : ""}">${c.error ? "Blocked: " + esc(c.error) : `${c.assignments} assignments · ${c.upcoming} due recently or upcoming`}</td></tr>`).join("")}</table>
        ${S.sync.courses.length && S.sync.courses.every((c) => c.error) ? `<p class="small" style="color:var(--bad)">Every class is blocked. Do step 3 (the settings file), then Run <b>test</b> again and allow the new permissions, then redeploy as a <b>New version</b>.</p>` : ""}</details>` : ""}
      <details style="margin:.6rem 0"><summary><b>Export class slides for Claude</b> (to make flashcards from your lessons)</summary>
        <ol class="small" style="line-height:1.8">
          <li>Update the script and settings file in Apps Script (steps 2–3 above), save, then pick <b>testSlides</b> and click <b>Run</b>. Allow the Google Drive access it asks for. It reads the slides your teachers attach, and converts PowerPoints, Word docs and PDFs using a temporary copy that is deleted immediately. The log says how many it could read.</li>
          <li>Deploy a <b>New version</b> (Deploy → Manage deployments → ✏️).</li>
          <li>Click the button below. It saves a file called <code>astar-slides-….json</code> to your Downloads folder. Nothing is uploaded anywhere.</li>
          <li>Tell Claude "I've exported my slides". Claude reads the file on your Mac and makes flashcards only for what's on your spec.</li>
        </ol>
        <button id="exportSlides" ${st.syncUrl ? "" : "disabled"}>Export slides</button> <span id="slidesMsg" class="small muted">${st.syncUrl ? "This can take a minute or two." : "Set up sync first."}</span>
      </details>
      <p class="small muted">If Run says Classroom or Apps Script is disabled, or "Anyone" isn't offered under <i>Who has access</i>, your school has blocked it. Use the calendar import or quick-add on the Planner page instead.</p>
    </div>
    <div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Study</h2>
      <label>New cards per day</label><input type="number" min="0" max="200" data-set="newPerDay" value="${st.newPerDay}">
      <label>Focus minutes</label><input type="number" min="5" max="90" data-set="focus" value="${st.focus}">
      <label>Break minutes</label><input type="number" min="1" max="30" data-set="brk" value="${st.brk}">
      <label>Blurt minutes</label><input type="number" min="2" max="30" data-set="blurtMins" value="${st.blurtMins}">
      <label>Stop new cards this many days before an exam</label><input type="number" min="0" max="60" data-set="stopNewDays" value="${st.stopNewDays}">
    </div>
    <div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Backup</h2>
      <p class="small muted" style="margin-top:0">Your progress is saved in this browser only. Export a backup now and then, or to move to another device.</p>
      <div class="row"><button id="exp">Export backup</button><label class="btn" style="margin:0;color:var(--ink);font-size:1rem">Import backup<input type="file" id="imp" accept="application/json" hidden></label><button id="reset" class="again">Reset everything</button></div>
    </div>`;
  el.querySelectorAll("[data-extra]").forEach((i) => i.onchange = () => {
    const on = new Set(st.extraSubjects || []); i.checked ? on.add(i.dataset.extra) : on.delete(i.dataset.extra);
    st.extraSubjects = [...on]; save(); location.reload(); // subjects are set up when the app starts
  });
  el.querySelectorAll("[data-exam]").forEach((i) => i.onchange = () => { st.exams[i.dataset.exam] = i.value; save(); });
  el.querySelectorAll("[data-set]").forEach((i) => i.onchange = () => { st[i.dataset.set] = Math.max(0, +i.value || 0); save(); });
  $("#exportSlides", el).onclick = (e) => {
    const b = e.target, msg = $("#slidesMsg");
    b.disabled = true; msg.textContent = "Reading your class slides… (about 3 minutes per part)"; msg.style.color = "";
    const base = st.syncUrl + (st.syncUrl.includes("?") ? "&" : "?") + "slides=1";
    // The script stops before Google's 6-minute limit and says where to carry on (next), so keep asking until it's done
    // A part that times out or drops is retried up to 3 times, so the export can run unattended
    const getPart = (start, acc, tries = 0) => fetch(base + "&start=" + start).then((r) => r.text()).then((t) => {
      const d = JSON.parse(t);
      if (d.error) throw new Error(d.error);
      return d;
    }).catch((err) => {
      if (tries >= 3) { if (acc) return { retried: { ...acc, partial: true } }; throw err; } // keep the parts already read
      msg.textContent = `That part timed out. Trying again (${tries + 1} of 3)…`;
      return new Promise((ok) => setTimeout(ok, 20000)).then(() => getPart(start, acc, tries + 1)).then((all) => ({ retried: all }));
    }).then((d) => {
      if (d.retried) return d.retried;
      if (!d.files) return d;
      const all = acc ? { ...d, files: acc.files.concat(d.files), skipped: acc.skipped.concat(d.skipped || []) } : d;
      if (d.next == null || d.next <= start) return all;
      msg.textContent = `Read ${all.files.length} files so far. Reading the next part… (about 3 minutes)`;
      return getPart(d.next, all);
    });
    getPart(0).then((data) => {
      if (!data.files) throw new Error("your web app is still running the old script. In Apps Script: paste the latest script and settings file, Run testSlides, then Deploy → Manage deployments → ✏️ → Version: New version → Deploy");
      if (!data.files.length) {
        const reasons = {}; (data.skipped || []).forEach((x) => { const r = (x.reason || "").replace(/\s*[(:].*$/, ""); reasons[r] = (reasons[r] || 0) + 1; });
        const summary = Object.entries(reasons).map(([r, n]) => `${n} × ${r}`).join("; ");
        throw new Error(data.skipped && data.skipped.length ? `found ${data.skipped.length} attached files but couldn't read any (${summary}). Google's reason for the first one: "${data.skipped[0].reason}". Send Claude a screenshot of this` : `no slides, docs or PDFs are attached to Classroom posts from the last 120 days in your ${data.courses} classes`);
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
      a.download = `astar-slides-${todayKey()}.json`; a.click();
      msg.textContent = `Saved ${data.files.length} files to your Downloads${data.partial ? " (stopped early: Google kept timing out, so export again later for the rest)" : ""}${data.skipped && data.skipped.length ? ` (${data.skipped.length} couldn't be read)` : ""}. Now tell Claude.`; msg.style.color = "var(--good)";
    }).catch((err) => { msg.textContent = "Export failed: " + (/failed to fetch|load failed|networkerror/i.test(err.message || err) ? "Google cut the connection. Usually the script ran past Google's 6-minute limit, or the web app is running an old version. Check the homework sync still works, then deploy a New version and try again" : (err.message || err) + ". If it mentions sign-in or HTML, deploy a New version first") + "."; msg.style.color = "var(--bad)"; }).finally(() => { b.disabled = false; });
  };
  $("#copyManifest", el).onclick = (e) => {
    navigator.clipboard.writeText(CLASSROOM_MANIFEST).then(() => { e.target.textContent = "Copied ✓"; }, () => alert("Couldn't copy. Open js/classroom-script.js in the Astar folder and copy CLASSROOM_MANIFEST."));
  };
  $("#copyScript", el).onclick = (e) => {
    navigator.clipboard.writeText(CLASSROOM_SCRIPT).then(() => { e.target.textContent = "Copied ✓"; }, () => alert("Couldn't copy. Open js/classroom-script.js in the Astar folder and copy the part between the backticks."));
  };
  $("#syncSave", el).onclick = () => {
    const u = $("#syncUrl").value.trim();
    if (u && !/^https:\/\/script\.google(usercontent)?\.com\//.test(u)) return ($("#syncMsg").textContent = "That doesn't look like an Apps Script web app link (it should start https://script.google.com/).");
    st.syncUrl = u; S.sync = { last: 0, status: "" }; save();
    if (!u) return ($("#syncMsg").textContent = "Sync turned off.");
    $("#syncMsg").textContent = "Testing…";
    syncClassroom(true).then(() => { const m = $("#syncMsg"); if (m) { m.textContent = S.sync.status; m.style.color = S.sync.ok ? "var(--good)" : "var(--bad)"; } });
  };
  $("#saveHols", el).onclick = () => {
    const rows = $("#hols").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s*(.*)$/));
    if (rows.some((r) => !r)) return ($("#holMsg").textContent = "Each line needs: YYYY-MM-DD YYYY-MM-DD name");
    S.holidays = rows.map((r) => [r[1], r[2], r[3] || "Holiday"]); save(); $("#holMsg").textContent = "Saved ✓";
  };
  $("#exp", el).onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(S, null, 1)], { type: "application/json" }));
    a.download = `astar-backup-${todayKey()}.json`; a.click();
  };
  $("#imp", el).onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then((t) => { try { const d = JSON.parse(t); if (!d.srs || !d.settings) throw 0; localStorage.setItem(STORE_KEY, t); S = load(); alert("Backup restored."); render(); } catch { alert("That doesn't look like an Astar backup."); } });
  };
  $("#reset", el).onclick = () => { if (confirm("Delete ALL progress? This cannot be undone.")) { S = DEFAULT_STATE(); save(); render(); } };
}

// ---------- Focus timer (global) ----------
const T = { mode: "idle", left: 0, id: null, rounds: 0 };
function tickTimer() {
  T.left--;
  if (T.mode === "focus" && T.left % 60 === 0) { logToday("focusMins"); save(); }
  if (T.left <= 0) {
    if (T.mode === "focus") { T.rounds++; T.mode = "break"; T.left = (T.rounds % 4 === 0 ? 15 : S.settings.brk) * 60; beep("Focus block done. Take a break: stand up, drink water, look away from the screen."); }
    else { T.mode = "focus"; T.left = S.settings.focus * 60; beep("Break over. Back to it."); }
  }
  drawTimer();
}
function drawTimer() {
  const b = $("#timerBtn");
  b.className = "timer-btn" + (T.mode === "focus" && T.id ? " running" : T.mode === "break" ? " break" : "");
  $("#timerLabel").textContent = T.mode === "idle" ? "Focus" : `${T.mode === "break" ? "Break " : ""}${fmtTime(T.left)}${T.id ? "" : " ⏸"}`;
}
function beep(msg) {
  try { const ctx = new AudioContext(), o = ctx.createOscillator(); o.connect(ctx.destination); o.frequency.value = 660; o.start(); o.stop(ctx.currentTime + 0.4); } catch {}
  if ("Notification" in window && Notification.permission === "granted") new Notification("Astar", { body: msg });
}
$("#timerBtn").onclick = () => {
  if (T.mode === "idle") {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    T.mode = "focus"; T.left = S.settings.focus * 60; T.id = setInterval(tickTimer, 1000);
  } else if (T.id) { clearInterval(T.id); T.id = null; if (confirm("Timer paused. Reset it? (Cancel keeps it paused; tap again to resume.)")) { T.mode = "idle"; T.rounds = 0; } }
  else T.id = setInterval(tickTimer, 1000);
  drawTimer();
};

// ---------- Sleep nudge ----------
function nudge() {
  const d = new Date(), m = d.getHours() * 60 + d.getMinutes(), late = m >= 22 * 60 + 30 || m < 5 * 60;
  const n = $("#nudge"); n.hidden = !late;
  if (late) n.textContent = "🌙 It's late. Sleep is when memories consolidate. Do a quick review of due cards, skip new material, and go to bed.";
}

nudge(); setInterval(nudge, 5 * 60000);
syncClassroom().then(afterSync);
window.addEventListener("focus", () => syncClassroom().then(afterSync));
drawTimer();
render();
