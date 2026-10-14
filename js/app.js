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
  },
  // Enfield council dates for 2026–27 (Christmas & May half term are typical, unconfirmed): check Latymer's calendar
  holidays: [
    ["2026-10-26", "2026-10-30", "Autumn half term"],
    ["2026-12-21", "2027-01-01", "Christmas holidays"],
    ["2027-02-15", "2027-02-19", "February half term"],
    ["2027-03-26", "2027-04-09", "Easter holidays"],
    ["2027-05-31", "2027-06-04", "May half term"],
  ],
  plan: {}, dayType: {}, covered: {}, homework: [],
  srs: {}, custom: [], suspended: {}, log: {},
  calib: { 1: { n: 0, ok: 0 }, 2: { n: 0, ok: 0 }, 3: { n: 0, ok: 0 } },
  rag: {}, blurts: [], customBlurts: [], practice: [], papers: [],
  nea: {
    eng: { words: 0, min: 2500, max: 3500, deadline: "", notes: "", done: {} },
    his: { words: 0, min: 3000, max: 3500, deadline: "", notes: "", done: {} },
  },
  timeline: {}, reflections: [],
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
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { console.warn("Could not save", e); } }
function logToday(field, n = 1) { const k = todayKey(); S.log[k] = S.log[k] || {}; S.log[k][field] = (S.log[k][field] || 0) + n; }

// ---------- Cards & scheduling (SM-2 with exam-aware interval cap) ----------
function allCards() {
  const built = CARDS.map(([s, t, f, b]) => ({ id: "c" + hash(s + "|" + f), s, t, f, b, custom: false }));
  return built.concat(S.custom.map((c) => ({ ...c, custom: true }))).filter((c) => !S.suspended[c.id]);
}
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
function hasCoverage(s) { return SUBJECTS[s].topics.some((t) => S.covered[s + "|" + t]); }
function isCovered(c) {
  if (!hasCoverage(c.s) || !SUBJECTS[c.s].topics.includes(c.t)) return true;
  return !!S.covered[c.s + "|" + c.t];
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
  for (const c of cards) {
    if (budget <= 0) break;
    if (isNew(c) && newAllowed(c.s) && isCovered(c)) { fresh.push(c); budget--; }
  }
  // Mixed = interleave everything; blocked = keep topic order (for first learning a topic)
  return mode === "blocked" ? due.concat(fresh) : shuffle(due.concat(fresh));
}

// ---------- Router ----------
const routes = { home, planner, review, blurt, practice, papers, topics, timeline, coursework, cards: cardsView, science, settings };
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
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const parseKey = (k) => new Date(k + "T12:00");
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return todayKey(d); };
function examKey() { return SUBJ_KEYS.map((s) => S.settings.exams[s]).filter(Boolean).sort()[0] || null; }
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
  let left = (hwLoad >= 90 ? review : Math.max(review, budget - Math.round(hwLoad / 10) * 5)) - review, slot = 0; // big homework night = just flashcards
  // Long weekend/holiday sessions in the run-up: a full timed paper
  const fullS = SUBJ_KEYS[n % 4], fullP = SUBJECTS[fullS].papers[n % 2];
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
    const s = SUBJ_KEYS[(n * 2 + slot) % 4], v = SUBJECTS[s], menu = menus[ph.key];
    let kind = menu[(n + slot) % menu.length];
    if (kind === "his-timeline" && s !== "his") kind = "cards";
    if (kind === "timed" && left < v.papers.find((x) => x.mins <= 60 && x.marks).mins) kind = "plan"; // don't squeeze a timed answer
    const mins = Math.min(25, left);
    if (kind === "blurt") {
      const b = weakestBlurt(s);
      b ? add(`Blurt: ${b.t} (${v.short})`, mins, s, "#blurt/" + encodeURIComponent(b.t))
        : add(`Blurt this week's ${v.short} lesson topic from memory, then check your notes`, mins, s, "#blurt");
    } else if (kind === "cards") add(`${v.short}: turn this week's class notes into 10 question cards`, mins, s, "#cards");
    else if (kind === "plan") add(`${v.short}: 10-minute essay plan ×2 against the clock`, mins, s, "#practice/" + s);
    else if (kind === "timed") { const p = v.papers.find((x) => x.mins <= 60 && x.marks); add(`${v.short}: one timed answer (${p.name}, ${p.mins} min)`, p.mins, s, "#practice/" + s); }
    else if (kind === "paperq") add(`${v.short}: past-paper questions from your weakest topic; log marks`, mins, s, "#papers");
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
  while (k > today && dayType(k) === "rest") k = addDays(k, -1);
  return k < today ? today : k;
}
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
function homeworkPanel() {
  const today = todayKey();
  const list = S.homework.filter((h) => !h.done).sort((a, b) => a.due.localeCompare(b.due));
  const doneCount = S.homework.filter((h) => h.done).length;
  return `<h2>Homework</h2><div class="card">
    ${list.length ? `<table><tr><th>Homework</th><th>Due</th><th>Do on</th><th>Min</th><th></th></tr>${list.map((h) => `<tr data-hwrow="${h.id}">
      <td><label style="display:flex;gap:.5rem;margin:0;color:var(--ink);font-size:.95rem"><input type="checkbox" data-hw="${h.id}" style="width:auto">
        <span>${h.s ? `<span class="pill" style="background:${SUBJECTS[h.s].colour};color:#fff">${SUBJECTS[h.s].short}</span> ` : `<select data-hwf="s" style="width:auto;padding:.1rem;font-size:.8rem"><option value="">Subject?</option>${SUBJ_KEYS.map((s) => `<option value="${s}">${SUBJECTS[s].short}</option>`).join("")}</select> `}${esc(h.title)}${h.src ? `<span class="small muted"> · ${esc(h.src)}</span>` : ""}</span></label></td>
      <td class="small" style="${h.due < today ? "color:var(--bad);font-weight:600" : ""}">${parseKey(h.due).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}${h.due < today ? " (late)" : ""}</td>
      <td><input type="date" data-hwf="doOn" value="${hwDay(h)}" style="padding:.2rem;width:auto"></td>
      <td><input type="number" data-hwf="mins" value="${h.mins}" min="5" step="5" style="padding:.2rem;width:4.2rem"></td>
      <td><button class="small" data-hwdel="${h.id}" style="padding:.1rem .5rem" title="Delete">×</button></td></tr>`).join("")}</table>` : `<p class="muted" style="margin-top:0">No homework to do. 🎉</p>`}
    ${doneCount ? `<p class="small muted">${doneCount} done.</p>` : ""}
    <div class="row" style="margin-top:.8rem">
      <input id="hwT" placeholder="Homework, e.g. History essay on Witte" style="flex:3;min-width:200px">
      <select id="hwS" style="width:auto"><option value="">Subject</option>${SUBJ_KEYS.map((s) => `<option value="${s}">${SUBJECTS[s].short}</option>`).join("")}</select>
      <input id="hwD" type="date" style="width:auto" title="Due date">
      <input id="hwM" type="number" value="45" min="5" step="5" style="width:4.5rem" title="Minutes">
      <button class="primary" id="hwAdd">Add</button>
    </div>
    <details style="margin-top:.8rem"><summary><b>Import from Google Classroom</b> (via Google Calendar)</summary>
      <ol class="small" style="line-height:1.8">
        <li>Classroom puts every assignment with a due date into Google Calendar, one calendar per class.</li>
        <li>On a computer, open <a href="https://calendar.google.com/calendar/r/settings/export" target="_blank" rel="noopener">Google Calendar → Settings → Import &amp; export → Export</a>, signed in with your school account.</li>
        <li>It downloads a .zip. Double-click it to unzip, and you get one <b>.ics</b> file per class.</li>
        <li>Choose all the .ics files below. Classes are matched to subjects by name. Anything already imported is skipped, so you can re-import every week.</li>
      </ol>
      <label class="btn" style="color:var(--ink);font-size:1rem">Choose .ics files<input type="file" id="hwIcs" accept=".ics,text/calendar" multiple hidden></label> <span id="hwMsg" class="small muted"></span>
      <p class="small muted">If your school has blocked calendar export, use the quick-add form above instead. It takes about 10 seconds per piece of homework.</p>
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
  const ics = $("#hwIcs", el);
  if (ics) ics.onchange = () => importICS(ics.files, (a, sk) => { redraw(); const m = $("#hwMsg"); if (m) m.textContent = `Imported ${a} homework item(s)${sk ? `, skipped ${sk} (already added or more than a week old)` : ""}.`; });
}

function planner(el, [start]) {
  const today = todayKey();
  if (!start) { const d = parseKey(today); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); start = todayKey(d); }
  const days = [...Array(7)].map((_, i) => addDays(start, i));
  const ex = examKey(), ph = phaseOn(today);
  const weekMins = days.reduce((a, k) => a + getDay(k).reduce((x, t) => x + t.mins, 0), 0);
  const weekDone = days.reduce((a, k) => a + getDay(k).filter((t) => t.done).length, 0), weekAll = days.reduce((a, k) => a + getDay(k).length, 0);
  el.innerHTML = `<h1>Planner</h1>
    <p class="muted">${ex ? `Year 12 exams: <b>${parseKey(ex).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</b> (${Math.max(0, phaseOn(today).days)} days) · ` : ""}Phase: <b>${ph.name}</b></p>
    <p class="small muted">Plans fit around school and homework: ${S.settings.schoolMins} min on school days, ${S.settings.weekendMins} at weekends, ${S.settings.holidayMins} in holidays, with ${DOW[S.settings.restDay]} as your rest day. Change these in <a href="#settings">Settings</a>. Tick tasks off, delete ones that don't fit, and add your own.</p>
    <div class="row spread" style="margin:1rem 0">
      <a class="btn" href="#planner/${addDays(start, -7)}">← Prev</a>
      <span><b>Week of ${parseKey(start).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</b> · ${weekDone}/${weekAll} done · ${Math.round(weekMins / 60 * 10) / 10} h planned</span>
      <span class="row"><a class="btn" href="#planner">This week</a><a class="btn" href="#planner/${addDays(start, 7)}">Next →</a></span>
    </div>
    ${homeworkPanel()}
    <h2>Week</h2>
    ${days.map((k) => dayCard(k, k === today)).join("")}`;
  wireDays(el, () => planner(el, [start]));
  wireHomework(el, () => planner(el, [start]));
}
function dayCard(k, isToday) {
  const tasks = getDay(k), type = dayType(k), hol = holidayOn(k), hw = hwOn(k);
  const mins = tasks.reduce((a, t) => a + t.mins, 0), hwMins = hw.reduce((a, h) => a + h.mins, 0);
  const past = k < todayKey();
  return `<div class="card day" style="margin:.6rem 0;${isToday ? "border:2px solid var(--accent)" : ""}${past ? ";opacity:.75" : ""}" data-day="${k}">
    <div class="row spread"><b>${isToday ? "Today · " : ""}${parseKey(k).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}</b>
      <span class="row small"><span class="muted">${mins} min revision${hwMins ? ` + ${hwMins} min homework` : ""}${hol ? " · " + esc(hol[2]) : ""}</span>
      <select data-type style="width:auto;padding:.2rem">${["school", "weekend", "holiday", "rest"].map((t) => `<option ${t === type ? "selected" : ""}>${t}</option>`).join("")}</select></span></div>
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

    <h2>Today's plan <a class="small" href="#planner" style="font-weight:400">see the week →</a></h2>
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
function review(el, [scope]) {
  if (!scope) {
    el.innerHTML = `<h1>Review</h1>
      <p class="muted">Spaced retrieval practice. You answer before you see the answer. Mixed review shuffles topics together (interleaving).</p>
      <div class="grid">
        <a class="card" href="#review/mixed" style="text-decoration:none;color:inherit"><b>🔀 Mixed: all subjects</b><div class="muted small">${allCards().filter((c) => isDue(c)).length} due</div></a>
        ${Object.entries(SUBJECTS).map(([s, v]) => `<a class="card subj" style="--c:${v.colour};text-decoration:none;color:inherit" href="#review/${s}"><b>${v.name}</b><div class="muted small">${allCards().filter((c) => c.s === s && isDue(c)).length} due</div></a>`).join("")}
      </div>
      <h2>Learn one topic (blocked)</h2>
      <p class="muted small">Do a topic on its own the first time through, then switch to mixed review.</p>
      <div class="row"><select id="topicPick" style="max-width:420px">${Object.entries(SUBJECTS).map(([s, v]) => `<optgroup label="${v.name}">${[...new Set(allCards().filter((c) => c.s === s).map((c) => c.t))].map((t) => `<option value="${s}|${esc(t)}">${esc(t)}</option>`).join("")}</optgroup>`).join("")}</select>
      <button class="primary" id="goTopic">Start</button></div>`;
    $("#goTopic", el).onclick = () => { location.hash = "review/topic:" + encodeURIComponent($("#topicPick").value); };
    return;
  }
  let opts;
  if (scope === "mixed") opts = { subjects: Object.keys(SUBJECTS), mode: "mixed" };
  else if (scope.startsWith("topic:")) { const [s, t] = scope.slice(6).split("|"); opts = { subjects: [s], topic: t, mode: "blocked" }; }
  else opts = { subjects: [scope], mode: "mixed" };
  runSession(el, buildQueue(opts));
}

function runSession(el, queue) {
  const total = queue.length;
  let done = 0, correct = 0, conf = 0;
  if (!total) {
    el.innerHTML = `<div class="card flash"><h1>All caught up ✅</h1><p>Nothing is due here. Spacing works because you wait, so come back tomorrow. Meanwhile try a <a href="#blurt">blurt</a> or <a href="#practice">timed practice</a>.</p></div>`;
    return;
  }
  const showCard = () => {
    if (!queue.length) {
      save();
      el.innerHTML = `<div class="card flash"><h1>Session complete 🎉</h1><p>${done} reviews · ${Math.round((correct / Math.max(1, done)) * 100)}% recalled.</p><p class="muted">Sleep helps you keep what you've just learned. Next due cards are scheduled automatically.</p><a class="btn primary" href="#home">Back to today</a></div>`;
      return;
    }
    const c = queue[0], v = SUBJECTS[c.s], fresh = isNew(c);
    conf = 0;
    el.innerHTML = `<div class="flash">
      <div class="row spread small muted"><span><span class="pill" style="background:${v.colour};color:#fff">${v.short}</span> ${esc(c.t)} ${fresh ? '<span class="pill">new</span>' : ""}</span><span>${queue.length} left</span></div>
      <div class="progress" style="margin:.5rem 0"><div style="width:${(done / (done + queue.length)) * 100}%"></div></div>
      <div class="card">
        <div class="front">${esc(c.f)}</div>
        <textarea id="attempt" placeholder="Type or say your answer first (optional, but it makes you commit)"></textarea>
        <label>How confident are you?</label>
        <div class="row" id="confRow"><button data-c="1">🤷 Guess</button><button data-c="2">🤔 Unsure</button><button data-c="3">💪 Sure</button></div>
        <div style="margin-top:1rem"><button class="primary" id="reveal" disabled>Show answer</button></div>
        <div id="answer"></div>
      </div>
      <p class="muted small" style="text-align:center">Keys: 1–3 confidence · space to reveal · 1–4 to rate</p>
    </div>`;
    el.querySelectorAll("#confRow button").forEach((b) => b.onclick = () => {
      conf = +b.dataset.c;
      el.querySelectorAll("#confRow button").forEach((x) => x.classList.toggle("sel", x === b));
      $("#reveal").disabled = false;
    });
    $("#reveal").onclick = reveal;
    $("#attempt").focus();
  };
  const reveal = () => {
    if (!conf || $("#answer").innerHTML) return;
    const c = queue[0];
    $("#reveal").remove();
    const explain = Math.random() < 0.2 ? `<p class="small muted">💭 <b>Explain why:</b> before rating, say why this is true or link it to another topic (self-explanation).</p>` : "";
    $("#answer").innerHTML = `<div class="back">${esc(c.b)}</div>${explain}
      <div class="row"><button class="again" data-r="1">1 · Again</button><button class="hard" data-r="2">2 · Hard</button><button class="good" data-r="3">3 · Good</button><button class="easy" data-r="4">4 · Easy</button></div>`;
    el.querySelectorAll("[data-r]").forEach((b) => b.onclick = () => rate(+b.dataset.r));
  };
  const rate = (rating) => {
    const c = queue.shift();
    const wasNew = isNew(c);
    // Low confidence + "easy" is probably a lucky guess, so schedule it as "good"
    if (conf < 3 && rating === 4) rating = 3;
    const ok = rating > 1;
    S.calib[conf].n++; if (ok) S.calib[conf].ok++;
    schedule(c, rating);
    if (wasNew && rating > 1) logToday("new");
    logToday("reviews"); done++; if (ok) correct++;
    if (!ok) queue.splice(Math.min(queue.length, 3), 0, c); // see it again soon this session
    save();
    if (!ok && conf === 3) {
      // Hypercorrection: confident errors are the most fixable, so make the correction stick
      el.querySelector(".card").insertAdjacentHTML("beforeend", `<div class="alert"><b>Confident but wrong. This one is worth fixing.</b><br>Read the answer again carefully. It will come back in a few cards.<div style="margin-top:.5rem"><button id="cont">Continue</button></div></div>`);
      el.querySelectorAll("[data-r]").forEach((b) => b.disabled = true);
      $("#cont").onclick = showCard; $("#cont").focus();
    } else showCard();
  };
  el.onkeydown = null;
  document.onkeydown = (e) => {
    if (!location.hash.startsWith("#review/") || e.target.tagName === "TEXTAREA" && e.key !== "Escape") return;
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
function addCustomCard(s, t, f, b) {
  f = f.trim(); b = b.trim(); t = t.trim() || "My cards";
  if (!f || !b) { alert("Fill in both the question and the answer."); return false; }
  S.custom.push({ id: "u" + hash(s + "|" + f + Date.now()), s, t, f, b }); save(); return true;
}

// ---------- Topics (RAG) ----------
const RAG = ["Not rated", "🔴 Red", "🟠 Amber", "🟢 Green"];
function topics(el) {
  el.innerHTML = `<h1>Topic tracker</h1>
    <p class="muted">Tick <b>Covered</b> once you've been taught a topic in class. As soon as you tick one for a subject, new flashcards for that subject only come from covered topics, so you aren't tested on things you haven't learned yet. Then rate each topic red, amber or green, honestly. A blurt or past question will show whether "green" really is green.</p>
    ${Object.entries(SUBJECTS).map(([s, v]) => {
      const counts = [0, 0, 0, 0]; v.topics.forEach((t) => counts[S.rag[s + "|" + t] || 0]++);
      return `<h2>${v.name} <span class="pill">${v.board}</span></h2>
      <div class="small muted">🔴 ${counts[1]} · 🟠 ${counts[2]} · 🟢 ${counts[3]} · unrated ${counts[0]}</div>
      <div class="card" style="margin-top:.5rem">${v.topics.map((t) => { const r = S.rag[s + "|" + t] || 0; return `<div class="rag"><label style="display:flex;gap:.5rem;align-items:center;margin:0;color:var(--ink);font-size:1rem"><input type="checkbox" style="width:auto" data-cov="${esc(s + "|" + t)}" ${S.covered[s + "|" + t] ? "checked" : ""}>${esc(t)}</label><button class="rag-${r}" data-k="${esc(s + "|" + t)}">${RAG[r]}</button></div>`; }).join("")}</div>`;
    }).join("")}`;
  el.querySelectorAll("[data-k]").forEach((b) => b.onclick = () => {
    const k = b.dataset.k, r = ((S.rag[k] || 0) % 3) + 1;
    S.rag[k] = r; save(); b.className = "rag-" + r; b.textContent = RAG[r];
  });
  el.querySelectorAll("[data-cov]").forEach((c) => c.onchange = () => { if (c.checked) S.covered[c.dataset.cov] = true; else delete S.covered[c.dataset.cov]; save(); });
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
      return `<tr><td><span class="pill" style="background:${SUBJECTS[c.s].colour};color:#fff">${SUBJECTS[c.s].short}</span> <span class="small muted">${esc(c.t)}</span><div><b>${esc(c.f)}</b></div><div class="small">${esc(c.b)}</div></td><td class="small">${status}</td><td><button class="small" data-del="${c.id}" title="${c.custom ? "Delete" : "Hide"}">${c.custom ? "Delete" : "Hide"}</button></td></tr>`;
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
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"><div><label>Subject</label><select id="as">${subjOptions()}</select></div><div><label>Topic</label><input id="at" list="topicList"></div></div>
      <datalist id="topicList">${[...new Set(Object.values(SUBJECTS).flatMap((v) => v.topics))].map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
      <label>Question (front)</label><input id="af"><label>Answer (back)</label><textarea id="ab" style="min-height:4rem"></textarea>
      <button class="primary" id="add" style="margin-top:.6rem">Add card</button> <span id="amsg" class="small muted"></span>
    </div>
    <h2>Browse</h2>
    <div class="row"><select id="fs" style="max-width:220px"><option value="">All subjects</option>${subjOptions("")}</select><input id="fq" placeholder="Search…" style="max-width:300px"></div>
    <div id="list"></div>
    ${Object.keys(S.suspended).length ? `<p><button id="unhide">Restore ${Object.keys(S.suspended).length} hidden card(s)</button></p>` : ""}`;
  $("#add", el).onclick = () => { if (addCustomCard($("#as").value, $("#at").value, $("#af").value, $("#ab").value)) { $("#af").value = $("#ab").value = ""; $("#amsg").textContent = "Added ✓"; draw(); } };
  $("#fs", el).onchange = draw; $("#fq", el).oninput = draw;
  const u = $("#unhide", el); if (u) u.onclick = () => { S.suspended = {}; save(); render(); };
  draw();
}

// ---------- Science ----------
function science(el) {
  const col = { Strong: "var(--good)", Moderate: "var(--warn)", Emerging: "var(--muted)", Low: "var(--bad)" };
  el.innerHTML = `<h1>Why it works</h1>
    <p class="muted">Every feature in Astar is based on research into how memory works. This shows the evidence behind each one and where it appears in the app.</p>
    ${SCIENCE.map(([name, ev, what, how]) => `<div class="card" style="margin:.7rem 0"><div class="row spread"><b>${name}</b><span class="pill" style="color:${col[ev]}">Evidence: ${ev}</span></div><p style="margin:.4rem 0">${what}</p><p class="small muted" style="margin:0">In Astar: ${how}</p></div>`).join("")}
    <h2>Your exam boards</h2>
    <div class="card">${Object.values(SUBJECTS).map((v) => `<div><b>${v.name}</b>: ${v.board}</div>`).join("")}<p class="small muted">Confirmed from Latymer's department pages. Check set texts, options and dates with your teachers.</p></div>
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
  el.querySelectorAll("[data-exam]").forEach((i) => i.onchange = () => { st.exams[i.dataset.exam] = i.value; save(); });
  el.querySelectorAll("[data-set]").forEach((i) => i.onchange = () => { st[i.dataset.set] = Math.max(0, +i.value || 0); save(); });
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
drawTimer();
render();
