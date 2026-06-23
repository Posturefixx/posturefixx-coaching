// coaching-engine.js
// A small web service that turns a chiropractor's weekly numbers into a short,
// supportive coaching message — rules decide WHAT to say, Claude writes HOW it's said.
//
// You can run this BY ITSELF first (before PracticeHub is connected) to see the
// tone: deploy it, set ANTHROPIC_API_KEY, and open the /preview link in a browser.
// No terminal, no coding — just visit the URL.

import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-6"; // tone matters here. Cheaper option: "claude-haiku-4-5-20251001"

// ── PRACTICEHUB: one account PER CLINIC ──────────────────────────────────────
// Base URLs are public (no secret). Keys live in Render env vars — never here.
// Set in Render → Environment:  PHUB_<CLINIC>_KEY  for each clinic, and one
// shared  PHUB_APP_DETAILS  (e.g. "posturefixx-coaching=dr.alexanderyu@gmail.com").
const CLINICS = {
  Amstelveen: { base: "https://amstelveenposturefixx.neptune.practicehub.io/api", key: process.env.PHUB_AMSTELVEEN_KEY },
  Utrecht:    { base: "https://posturefixx.neptune.practicehub.io/api",           key: process.env.PHUB_UTRECHT_KEY },
  Rotterdam:  { base: "https://rotterdamposturefixx.neptune.practicehub.io/api",  key: process.env.PHUB_ROTTERDAM_KEY },
  Bussum:     { base: "https://posturefixxbussum.neptune.practicehub.io/api",     key: process.env.PHUB_BUSSUM_KEY },
};
const APP_DETAILS = process.env.PHUB_APP_DETAILS || "posturefixx-coaching=dr.alexanderyu@gmail.com";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Races a promise against a timeout so a slow upstream never hangs the request.
function withTimeout(promise, ms, label){
  return Promise.race([promise, new Promise((_,rej)=>setTimeout(()=>rej(new Error((label||"operation")+" timed out after "+ms+"ms")), ms))]);
}

// Generic GET against one clinic's PracticeHub. Retries on 429 (rate limit).
async function phub(clinicName, path, params = {}, attempt = 0) {
  const c = CLINICS[clinicName];
  if (!c) throw new Error(`unknown clinic "${clinicName}"`);
  if (!c.key) throw new Error(`no API key set for ${clinicName} (add PHUB_${clinicName.toUpperCase()}_KEY in Render)`);
  const qs = new URLSearchParams(params).toString();
  const url = `${c.base}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      "x-practicehub-key": c.key,
      "x-app-details": APP_DETAILS,
      "Accept": "application/json",
    },
  });
  if (res.status === 429 && attempt < 5) {
    const retryAfter = parseInt(res.headers.get("retry-after")) || 0;
    const wait = retryAfter ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 8000); // backoff: 1s,2s,4s,8s
    await sleep(wait);
    return phub(clinicName, path, params, attempt + 1);
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`${clinicName} ${path} → HTTP ${res.status}: ${body.slice(0, 300)}`);
  try { return JSON.parse(body); } catch { throw new Error(`${clinicName} ${path} returned non-JSON: ${body.slice(0, 200)}`); }
}

// Last N days as a PracticeHub "between:" filter on the appointment start field.
function lastDaysRange(days = 14) {
  const end = new Date();
  const start = new Date(Date.now() - days * 864e5);
  const f = (d) => d.toISOString().slice(0, 19).replace("T", " ");
  return `between:${f(start)},${f(end)}`;
}

// Pull ALL pages of a list endpoint — big pages, one at a time, gentle pace.
async function phubAll(clinic, path, params = {}) {
  let page = 1, all = [], pageLen = null, guard = 0;
  while (guard++ < 200) {
    const r = await phub(clinic, path, { ...params, page, page_size: 200 });
    const rows = r.data || r || [];
    if (pageLen === null) pageLen = rows.length; // effective page size (API may cap below 200)
    all = all.concat(rows);
    if (rows.length === 0 || rows.length < pageLen) break; // last page
    page++;
    await sleep(350); // stay under the rate limit
  }
  return all;
}

// Map practitioner_id → "First Last" for a clinic.
async function practitionerMap(clinic) {
  const ps = await phubAll(clinic, "/practitioners", { active: "eq:1" });
  const m = {};
  for (const p of ps) m[p.id] = `${p.first_name} ${p.last_name}`.trim();
  return m;
}

// Like practitionerMap but includes INACTIVE practitioners too, so ex-chiros
// (Nick, Holly, Courtney, Maria…) still resolve to a name in historical data.
async function allPractitionerMap(clinic) {
  const m = {};
  for (const flt of [{ active: "eq:1" }, { active: "eq:0" }]) {
    try {
      const ps = await phubAll(clinic, "/practitioners", flt);
      for (const p of ps) m[p.id] = (`${p.first_name || ""} ${p.last_name || ""}`.trim()) || `#${p.id}`;
    } catch (e) { /* one filter may not be supported; keep what we have */ }
  }
  return m;
}
function monthsAgoRange(months) {
  const s = new Date(); s.setMonth(s.getMonth() - months); s.setDate(1); s.setHours(0,0,0,0);
  const f = d => d.toISOString().slice(0,19).replace("T"," ");
  return `between:${f(s)},${f(new Date())}`;
}
const _earnCache = {};

// ── APPOINTMENT-TYPE CLASSIFICATION (edit these rules in plain English) ──────
// Matched on the TYPE NAME, so it works across all four clinics even though
// their type ID numbers differ. Tweak the words below any time.
const isPhone   = (n) => /telefon|telephone/i.test(n);                 // phone advice, not a visit
const isIntake  = (n) => /intake|new patient|nieuwe pati/i.test(n) && !isPhone(n);
const notAVisit = (n) =>                                               // exclude from the visit count
  isPhone(n) ||
  /afzeg|gemiste afspraak|no.?show/i.test(n) ||   // Afzegging binnen 24h / missed
  /evaluatie/i.test(n) ||                          // Evaluatie
  /\brof\b|report of findings/i.test(n) ||         // ROF 1 / ROF 2 / Report of Findings
  /progress report/i.test(n);                      // Progress Report

// ── THE KPI LAYER — turn raw appointments into per-chiro numbers ─────────────
// Rules learned from the live data:
//  • status "processed" = a real visit; "cancelled"/"missed"/"pending" don't count.
//  • de-duplicate by appointment id (same slot can appear twice, e.g. a cancel).
//  • exclude non-treatment types above. PVA = qualifying visits ÷ intakes.
async function computeKpis(clinic, days = 30) {
  // Sequential (not parallel) — a burst of simultaneous calls is what trips the rate limit.
  const names = await practitionerMap(clinic);
  const types = await phubAll(clinic, "/appointment_types", {}).catch(() => []);
  const appts = await phubAll(clinic, "/appointments", { start: lastDaysRange(days) });

  // classify every type once
  const typeName = {}, intakeIds = new Set(), excludedIds = new Set();
  for (const t of types) {
    typeName[t.id] = t.name || "";
    if (isIntake(t.name || "")) intakeIds.add(t.id);
    if (notAVisit(t.name || "")) excludedIds.add(t.id);
  }

  // de-dupe by id, keep the non-cancelled version if both exist
  const byId = new Map();
  for (const a of appts) {
    const prev = byId.get(a.id);
    const cancelled = a.status === "cancelled" || a.cancelDate;
    if (!prev || (prev.cancelled && !cancelled)) byId.set(a.id, { ...a, cancelled });
  }

  const statusTally = {};
  const per = {};
  for (const a of byId.values()) {
    statusTally[a.status || "?"] = (statusTally[a.status || "?"] || 0) + 1;
    if (a.cancelled || a.status !== "processed") continue;  // only completed visits
    if (excludedIds.has(a.appointment_type_id)) continue;   // skip ROF / evaluatie / afzeg / phone
    const pid = a.practitioner_id;
    (per[pid] ||= { name: names[pid] || `#${pid}`, visits: 0, patients: new Set(), intakes: 0 });
    per[pid].visits++;
    per[pid].patients.add(a.patient_id);
    if (intakeIds.has(a.appointment_type_id)) per[pid].intakes++;
  }

  const rows = Object.entries(per).map(([pid, k]) => ({
    practitionerId: pid, name: k.name,
    visits: k.visits, uniquePatients: k.patients.size, intakes: k.intakes,
    pva: k.intakes ? +(k.visits / k.intakes).toFixed(1) : 0,  // visits per new patient
  })).sort((a, b) => b.visits - a.visits);

  return {
    clinic, days, rows, statusTally,
    appointmentTypes: types.map(t => ({ id: t.id, name: t.name })),
    intakeNames: [...intakeIds].map(id => typeName[id]),
    excludedNames: [...excludedIds].map(id => typeName[id]),
  };
}

// ── Simple password gate (these pages show patient data) ─────────────────────
// Set DASHBOARD_PASSWORD in Render to lock the pages. Any username works.
function gate(req, res, next) {
  const pw = process.env.DASHBOARD_PASSWORD;   // owner (Alex)
  const mpw = process.env.MANAGER_PASSWORD;     // manager (Renata) — her own login
  if (!pw && !mpw) return next(); // none set yet → open, but you'll see a reminder on the page
  const hdr = req.headers.authorization || "";
  const got = Buffer.from(hdr.split(" ")[1] || "", "base64").toString().split(":")[1];
  if (pw && got === pw)   { req.role = "owner";   return next(); }
  if (mpw && got === mpw) { req.role = "manager"; return next(); }
  res.set("WWW-Authenticate", 'Basic realm="Posturefixx"').status(401).send("Password required");
}

// ── YOUR COACHING VOICE ──────────────────────────────────────────────────────
// This is the personality + rules of the message. Edit the wording any time —
// it's plain English, not code. This is what keeps messages on-brand.
const VOICE = `
You write short coaching texts to chiropractors at Posturefixx, a Dutch chiro group.
You are their warm, encouraging clinic owner — never a manager reading off a scoreboard.

Hard rules for every message:
- Lead with a genuine win from their numbers. Always start positive.
- Name at most ONE focus for the week, with ONE concrete action. Never a list of problems.
- Use the Acknowledge–Align–Assure shape: acknowledge their effort, align it to the
  goal (keeping patients on full care plans), assure them they can do it.
- Frame retention as nervous-system retraining (doorplannen = pre-scheduling the full
  care plan at the report of findings), not as "sell more visits".
- 45–75 words. Warm, plain, first-name. WhatsApp tone. No bullet points, no emoji.
- Never shame, never compare them to other chiros, never imply they're failing.
`.trim();

// ── RULES LAYER — decide what to flag from the numbers ───────────────────────
// kpi = { name, clinic, pva, pvaTarget, doorplannenPct, rebookingPct,
//         conversionPct, visits, visitTarget, pvaDeltaWoW }
function evaluateSignals(kpi) {
  const wins = [];
  const focuses = [];
  if (kpi.pvaDeltaWoW > 0) wins.push(`PVA up to ${kpi.pva.toFixed(1)} (rising week-on-week)`);
  if (kpi.doorplannenPct >= 85) wins.push(`doorplannen at ${Math.round(kpi.doorplannenPct)}% of new intakes`);
  if (kpi.conversionPct >= 40) wins.push(`${Math.round(kpi.conversionPct)}% of intakes starting care`);
  if (kpi.visits >= kpi.visitTarget) wins.push(`hit the weekly visit target (${kpi.visits})`);

  if (kpi.doorplannenPct < 85) focuses.push(`only ${Math.round(kpi.doorplannenPct)}% of new intakes were pre-scheduled into a full plan — catch the rest at report of findings`);
  else if (kpi.pva < kpi.pvaTarget) focuses.push(`PVA is ${kpi.pva.toFixed(1)} vs a target of ${kpi.pvaTarget} — keep reinforcing the full care plan`);
  else if (kpi.rebookingPct < 90) focuses.push(`${Math.round(kpi.rebookingPct)}% of patients left with their next visit booked — aim to book every patient before they leave the room`);
  else if (kpi.visits < kpi.visitTarget) focuses.push(`visits (${kpi.visits}) came in under the weekly target — a reactivation call list could refill it`);

  if (wins.length === 0) wins.push(`showing up and doing the work this week`); // never start empty
  return { wins, focus: focuses[0] || `keep doing exactly what you're doing` };
}

// ── DRAFT — let Claude write the actual message ──────────────────────────────
async function draftMessage(kpi) {
  if (!kpi || kpi.pva == null || kpi.doorplannenPct == null) {
    return { ok: false, reason: "incomplete data — not drafting" }; // guardrail: never message off bad data
  }
  const { wins, focus } = evaluateSignals(kpi);
  const userPrompt =
    `Chiropractor: ${kpi.name} (${kpi.clinic}).\n` +
    `Wins to celebrate: ${wins.join("; ")}.\n` +
    `The single focus for this week: ${focus}.\n` +
    `Write the coaching text now.`;

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: VOICE,
    messages: [{ role: "user", content: userPrompt }],
  });
  const text = res.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
  return { ok: true, name: kpi.name, clinic: kpi.clinic, message: text, wins, focus };
}

// ── CHIROPRACTORS — who gets coached, their phone, and which clinics they cover ─
// Phone numbers are kept in Render env vars (PHONE_<NAME>), not in the code.
// "smsClinic" picks which GHL sub-account sends the SMS.
const CHIROS = [
  { n: "Myles",   clinics: ["Amstelveen"],            phone: process.env.PHONE_MYLES,   smsClinic: "Amstelveen" },
  { n: "Lara",    clinics: ["Amstelveen", "Bussum"],  phone: process.env.PHONE_LARA,    smsClinic: "Bussum" },
  { n: "Matthew", clinics: ["Utrecht", "Bussum"],     phone: process.env.PHONE_MATTHEW, smsClinic: "Utrecht" },
  { n: "Alex",    clinics: ["Rotterdam"],             phone: process.env.PHONE_ALEX,    smsClinic: "Rotterdam" },
];

// GHL credentials per clinic (falls back to a single shared GHL_TOKEN / GHL_LOCATION).
function ghlFor(clinic) {
  const C = clinic.toUpperCase();
  return {
    token: process.env[`GHL_TOKEN_${C}`] || process.env.GHL_TOKEN,
    location: process.env[`GHL_LOCATION_${C}`] || process.env.GHL_LOCATION,
  };
}

// ── SEND SMS via GHL: upsert the contact by phone, then send the message ──────
async function sendSms(clinic, phone, name, text, scheduledTimestamp) {
  const { token, location } = ghlFor(clinic);
  if (!token || !location) throw new Error(`no GHL token/location for ${clinic} (set GHL_TOKEN_${clinic.toUpperCase()} & GHL_LOCATION_${clinic.toUpperCase()})`);
  const headers = { Authorization: `Bearer ${token}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" };

  // 1) upsert contact → get contactId
  const up = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
    method: "POST", headers,
    body: JSON.stringify({ locationId: location, phone, name }),
  });
  const upBody = await up.json();
  if (!up.ok) throw new Error(`GHL upsert failed (${up.status}): ${JSON.stringify(upBody).slice(0, 200)}`);
  const contactId = upBody.contact?.id || upBody.id;
  if (!contactId) throw new Error(`GHL upsert returned no contactId`);

  // 2) send the SMS
  const payload = { type: "SMS", contactId, message: text };
  if (scheduledTimestamp && scheduledTimestamp > Date.now()) payload.scheduledTimestamp = scheduledTimestamp; // GHL schedules it
  const send = await fetch("https://services.leadconnectorhq.com/conversations/messages", {
    method: "POST", headers,
    body: JSON.stringify(payload),
  });
  const sendBody = await send.json();
  if (!send.ok) throw new Error(`GHL send failed (${send.status}): ${JSON.stringify(sendBody).slice(0, 200)}`);
  return { contactId, ...sendBody };
}

// ── Pull each chiro's REAL current numbers from PracticeHub (across their clinics) ─
async function chiroBaselines(days = 30) {
  const clinics = [...new Set(CHIROS.flatMap(c => c.clinics))];
  const byClinic = {};
  for (const c of clinics) byClinic[c] = await computeKpis(c, days); // sequential = rate-limit safe
  return CHIROS.map(ch => {
    let visits = 0, intakes = 0;
    for (const c of ch.clinics)
      for (const r of byClinic[c].rows)
        if (r.name.toLowerCase().includes(ch.n.toLowerCase())) { visits += r.visits; intakes += r.intakes; }
    return { ...ch, visits, intakes, pva: intakes ? +(visits / intakes).toFixed(1) : 0 };
  });
}

// ── Turn a revenue target into each chiro's visit + PVA goal ──────────────────
const PRICE_PER_VISIT = 59;
function chiroGoals(target, baselines) {
  const sumV = baselines.reduce((s, b) => s + b.visits, 0) || 1;
  const reqMonthlyVisits = (target / 12) / PRICE_PER_VISIT;
  const scale = reqMonthlyVisits / sumV;
  return baselines.map(b => {
    const goalV = b.visits * scale;
    return { ...b, goalWeekly: Math.round(goalV / 4.33), goalPva: b.intakes ? +(goalV / b.intakes).toFixed(1) : 0,
             nowWeekly: Math.round(b.visits / 4.33) };
  });
}

// ── Draft one chiro's message toward their goal, in your voice ────────────────
async function draftCoaching(g) {
  const prompt =
    `Chiropractor: ${g.n}. This month so far: ~${g.nowWeekly} visits/week, PVA ${g.pva}.\n` +
    `Their goal for the week ahead: about ${g.goalWeekly} visits, lifting PVA toward ${g.goalPva}.\n` +
    `Write a short, warm SMS encouraging them toward that goal.`;
  const fallback = `Hi ${g.n}! You're around ${g.nowWeekly} visits/week with a PVA of ${g.pva} \u2014 nice work. This week let's aim for ~${g.goalWeekly} and nudge that PVA toward ${g.goalPva}. Small steady steps; I'm here if you want to talk it through. \ud83d\udcaa`;
  try {
    const res = await withTimeout(
      anthropic.messages.create({ model: MODEL, max_tokens: 250, system: VOICE, messages: [{ role: "user", content: prompt }] }),
      12000, "draft for " + g.n);
    const txt = res.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    return txt || fallback;
  } catch (e) { console.error("[draftCoaching]", g.n, e.message); return fallback; }
}

// ── Sample data so you can SEE it working before PracticeHub is wired ────────
const SAMPLE = [
  { name: "Matthew", clinic: "Utrecht", pva: 9.8, pvaTarget: 10, doorplannenPct: 78, rebookingPct: 88, conversionPct: 33, visits: 261, visitTarget: 290, pvaDeltaWoW: 0.4 },
  { name: "Lara", clinic: "Amstelveen", pva: 10.6, pvaTarget: 10, doorplannenPct: 92, rebookingPct: 95, conversionPct: 46, visits: 402, visitTarget: 380, pvaDeltaWoW: 0.2 },
];

// ── Web endpoints — everything is a URL you can open, no terminal ────────────
const app = express();
app.use(express.json());

// little reminder banner shown until you set DASHBOARD_PASSWORD
const lockNote = () => process.env.DASHBOARD_PASSWORD ? "" :
  `<div style="background:#fff3cd;border:1px solid #ffe69c;padding:10px 14px;border-radius:8px;margin-bottom:16px">
   ⚠️ These pages show patient data and have <b>no password</b> yet. Add <b>DASHBOARD_PASSWORD</b> in Render to lock them.</div>`;

// Open this in a browser to preview tone (drafts only, sends nothing):
app.get("/preview", gate, async (_req, res) => {
  try {
    const drafts = [];
    for (const k of SAMPLE) drafts.push(await draftMessage(k));
    const html = drafts.map(d => d.ok
      ? `<div style="border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0;font-family:sans-serif">
           <b>${d.name} · ${d.clinic}</b>
           <p style="white-space:pre-wrap;line-height:1.5">${d.message}</p>
           <small style="color:#888">focus: ${d.focus}</small></div>`
      : `<div>skipped: ${d.reason}</div>`).join("");
    res.send(`<body style="max-width:640px;margin:40px auto;font-family:sans-serif"><h2>Coaching preview</h2>${html}</body>`);
  } catch (e) { res.status(500).send("Error: " + e.message + " — is ANTHROPIC_API_KEY set?"); }
});

// Later: POST real KPIs here to draft (still no send) — your dashboard/approval screen calls this:
// ── SMS TEST — sends ONE real SMS so you can verify delivery (default: Alex) ──
// e.g. /sms-test?to=Alex
app.get("/sms-test", gate, async (req, res) => {
  const who = req.query.to || "Alex";
  const ch = CHIROS.find(c => c.n.toLowerCase() === who.toLowerCase());
  if (!ch) return res.status(400).send(`unknown chiro "${who}"`);
  if (!ch.phone) return res.status(400).send(`no phone set for ${ch.n} (add PHONE_${ch.n.toUpperCase()} in Render)`);
  try {
    await sendSms(ch.smsClinic, ch.phone, ch.n, `Test from Posturefixx coaching — if you got this, SMS is working. (you can ignore this)`);
    res.send(`<body style="font-family:sans-serif;max-width:600px;margin:40px auto"><h2>✅ Test SMS sent to ${ch.n}</h2><p>via the ${ch.smsClinic} GHL sub-account. Check the phone.</p></body>`);
  } catch (e) {
    res.status(500).send(`<body style="font-family:sans-serif;max-width:600px;margin:40px auto"><h2>❌ SMS failed</h2><pre style="background:#f4f4f4;padding:16px;border-radius:8px;white-space:pre-wrap">${e.message}</pre></body>`);
  }
});

// ── COACH — draft real messages toward a revenue target (NO send) ─────────────
// e.g. /coach?target=1100000
app.get("/coach", gate, async (req, res) => {
  const target = Math.max(700000, Math.min(1500000, parseInt(req.query.target) || 1100000));
  try {
    const goals = chiroGoals(target, await chiroBaselines(30));
    const cards = await Promise.all(goals.map(async (g) => {
      const msg = await draftCoaching(g);
      return `<div style="border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0">
        <b>${g.n}</b> — now ~${g.nowWeekly}/wk · PVA ${g.pva} → goal ~${g.goalWeekly}/wk · PVA ${g.goalPva}
        <p style="white-space:pre-wrap;line-height:1.5;margin:10px 0 0">${msg}</p>
        <small style="color:#888">→ ${g.phone || "no phone set"} via ${g.smsClinic}</small></div>`;
    }));
    res.send(`<body style="font-family:sans-serif;max-width:680px;margin:40px auto">${lockNote()}
      <h2>Coaching drafts — target €${(target/1e6).toFixed(2)}M</h2>
      ${cards.join("")}
      <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-top:8px">
        <form id="coachForm" method="POST" action="/coach/send?target=${target}"></form>
        <div style="margin-bottom:12px"><label style="font-size:14px">Schedule for: <input type="datetime-local" id="whenInput" style="padding:6px 8px;border:1px solid #d1d5db;border-radius:7px;font-size:14px"></label> <span style="color:#94a3b8;font-size:12px">your local (Amsterdam) time</span></div>
        <button type="button" onclick="doSchedule()" style="border:none;background:#2563EB;color:#fff;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;cursor:pointer">Schedule SMS to all four</button>
        <button type="button" onclick="doNow()" style="border:1px solid #d1d5db;background:#fff;color:#16202E;font-size:14px;padding:12px 18px;border-radius:8px;cursor:pointer;margin-left:8px">or send now</button>
      </div>
      <script>
        (function(){var d=new Date();d.setDate(d.getDate()+1);d.setHours(9,0,0,0);var p=function(n){return String(n).padStart(2,"0");};var el=document.getElementById("whenInput");if(el)el.value=d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+"T"+p(d.getHours())+":"+p(d.getMinutes());})();
        function doNow(){if(!confirm("Send these SMS to all four chiros RIGHT NOW?"))return;var f=document.getElementById("coachForm");f.action="/coach/send?target=${target}";f.submit();}
        function doSchedule(){var v=document.getElementById("whenInput").value;if(!v){alert("Pick a date and time first.");return;}var ts=new Date(v).getTime();if(isNaN(ts)||ts<Date.now()+60000){alert("Pick a time at least a minute in the future.");return;}if(!confirm("Schedule these SMS for "+new Date(ts).toLocaleString()+"?"))return;var f=document.getElementById("coachForm");f.action="/coach/send?target=${target}&when="+ts;f.submit();}
      </script>
      <p style="color:#888;margin-top:10px">Targets: <a href="?target=1000000">€1.0M</a> · <a href="?target=1100000">€1.1M</a> · <a href="?target=1200000">€1.2M</a></p>
    </body>`);
  } catch (e) { res.status(500).send(`<pre style="white-space:pre-wrap">Error: ${e.message}</pre>`); }
});

// ── COACH SEND — drafts again and actually sends via SMS ──────────────────────
app.post("/coach/send", gate, async (req, res) => {
  const target = parseInt(req.query.target) || 1100000;
  const when = parseInt(req.query.when) || null;
  try {
    const goals = chiroGoals(target, await chiroBaselines(30));
    const results = await Promise.all(goals.map(async (g) => {
      if (!g.phone) return `${g.n}: skipped (no phone)`;
      try {
        const msg = await draftCoaching(g);
        await sendSms(g.smsClinic, g.phone, g.n, msg, when);
        return `${g.n}: ${when ? "scheduled" : "sent"} ✅`;
      } catch (e) { return `${g.n}: failed — ${e.message}`; }
    }));
    const head = when ? `Scheduled for ${new Date(when).toLocaleString("en-GB",{timeZone:"Europe/Amsterdam"})} (Amsterdam time)` : "Sent now";
    res.send(`<body style="font-family:sans-serif;max-width:600px;margin:40px auto"><h2>${head}</h2><p>${results.join("<br>")}</p><p style="color:#888;font-size:13px;margin-top:14px">Scheduled messages are held by GHL and go out at the chosen time \u2014 you can see/cancel them in your GHL conversation.</p><p><a href="/coach">\u2190 back</a></p></body>`);
  } catch (e) { res.status(500).send(`<pre style="white-space:pre-wrap">Error: ${e.message}</pre>`); }
});

// ── CONNECTION TEST — open in a browser to prove PracticeHub is reachable ────
// e.g. /phub-test?clinic=Rotterdam   (defaults to Rotterdam)
app.get("/phub-test", gate, async (req, res) => {
  const clinic = req.query.clinic || "Rotterdam";
  try {
    // 1) who are the practitioners at this clinic (maps practitioner_id → name)
    const pracRaw = await phub(clinic, "/practitioners", { active: "eq:1" });
    const pracs = (pracRaw.data || pracRaw || []).map(p => `#${p.id} ${p.first_name} ${p.last_name}`);

    // 2) appointments in the last 14 days
    const apptRaw = await phub(clinic, "/appointments", { start: lastDaysRange(14) });
    const appts = apptRaw.data || apptRaw || [];
    const sample = appts.slice(0, 8).map(a =>
      `<tr><td>${(a.start || "").slice(0,16)}</td><td>#${a.practitioner_id}</td><td>#${a.patient_id}</td><td>${a.status || ""}</td><td>${a.cancelDate ? "cancelled" : ""}</td></tr>`
    ).join("");

    res.send(`<body style="max-width:720px;margin:40px auto;font-family:sans-serif">
      <h2>✅ Connected to ${clinic}</h2>
      <p><b>${pracs.length}</b> active practitioners · <b>${appts.length}</b> appointments in the last 14 days.</p>
      <h3>Practitioners</h3><p>${pracs.join("<br>") || "none"}</p>
      <h3>Recent appointments (first 8)</h3>
      <table border="1" cellpadding="6" style="border-collapse:collapse">
        <tr><th>start</th><th>practitioner</th><th>patient</th><th>status</th><th></th></tr>${sample}</table>
      <p style="color:#888;margin-top:20px">Switch clinic: <a href="?clinic=Amstelveen">Amstelveen</a> · <a href="?clinic=Utrecht">Utrecht</a> · <a href="?clinic=Rotterdam">Rotterdam</a> · <a href="?clinic=Bussum">Bussum</a></p>
    </body>`);
  } catch (e) {
    res.status(500).send(`<body style="max-width:720px;margin:40px auto;font-family:sans-serif">
      <h2>❌ ${clinic} not connected yet</h2>
      <pre style="background:#f4f4f4;padding:16px;border-radius:8px;white-space:pre-wrap">${e.message}</pre>
      <p style="color:#888">Usually means the key for this clinic isn't set in Render yet, or has a typo. Add <b>PHUB_${clinic.toUpperCase()}_KEY</b> and <b>PHUB_APP_DETAILS</b> in the Environment tab, then redeploy.</p>
      <p>Try another: <a href="?clinic=Amstelveen">Amstelveen</a> · <a href="?clinic=Utrecht">Utrecht</a> · <a href="?clinic=Rotterdam">Rotterdam</a> · <a href="?clinic=Bussum">Bussum</a></p>
    </body>`);
  }
});

// ── REAL KPIs — per-chiro numbers straight from PracticeHub ──────────────────
// e.g. /kpi?clinic=Amstelveen&days=30
app.get("/kpi", gate, async (req, res) => {
  const clinic = req.query.clinic || "Amstelveen";
  const days = Math.max(1, Math.min(120, parseInt(req.query.days) || 30));
  try {
    const k = await computeKpis(clinic, days);
    const rows = k.rows.map(r =>
      `<tr><td>${r.name}</td><td style="text-align:right">${r.visits}</td><td style="text-align:right">${r.intakes}</td>
       <td style="text-align:right"><b>${r.pva}</b></td><td style="text-align:right">${r.uniquePatients}</td></tr>`).join("");
    const status = Object.entries(k.statusTally).map(([s, n]) => `${s}: ${n}`).join(" · ");
    res.send(`<body style="max-width:760px;margin:40px auto;font-family:sans-serif">${lockNote()}
      <h2>${clinic} — last ${days} days</h2>
      <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
        <tr style="background:#f4f4f4"><th align="left">Chiropractor</th><th>Visits</th><th>Intakes</th><th>PVA</th><th>Patients</th></tr>
        ${rows || `<tr><td colspan="5">no qualifying visits in range</td></tr>`}
      </table>
      <p style="color:#555;margin-top:10px"><b>PVA</b> = qualifying visits ÷ intakes (avg visits per new patient). Only <b>processed</b> visits; cancelled, missed, pending, and duplicates removed.</p>
      <p style="color:#555"><b>Excluded from visits:</b> ${k.excludedNames.join(", ") || "none"}.</p>
      <p style="color:#555"><b>Counted as intakes:</b> ${k.intakeNames.join(", ") || "none"}.</p>
      <p style="color:#888">Status mix: ${status}</p>
      <details style="margin-top:10px;color:#888"><summary>All appointment types at this clinic</summary><p>${k.appointmentTypes.map(t => `#${t.id} ${t.name}`).join("<br>")}</p></details>
      <p style="color:#888;margin-top:16px">Switch: <a href="?clinic=Amstelveen&days=${days}">Amstelveen</a> · <a href="?clinic=Utrecht&days=${days}">Utrecht</a> · <a href="?clinic=Rotterdam&days=${days}">Rotterdam</a> · <a href="?clinic=Bussum&days=${days}">Bussum</a>
      &nbsp;|&nbsp; range: <a href="?clinic=${clinic}&days=7">7d</a> · <a href="?clinic=${clinic}&days=30">30d</a> · <a href="?clinic=${clinic}&days=90">90d</a></p>
    </body>`);
  } catch (e) {
    res.status(500).send(`<body style="max-width:760px;margin:40px auto;font-family:sans-serif"><h2>Couldn't build KPIs for ${clinic}</h2><pre style="background:#f4f4f4;padding:16px;border-radius:8px;white-space:pre-wrap">${e.message}</pre></body>`);
  }
});

// ── PLAN DATA — one PracticeHub pull, returns each chiro's real numbers as JSON ─
const PLAN_DAYS = { Myles: 3.5, Lara: 3.5, Matthew: 4, Alex: 3 }; // days worked/week
const MAX_PER_DAY = 45;   // a chiro can realistically see ~40-50/day — change here anytime

app.get("/plan/data", gate, async (_req, res) => {
  try {
    const base = await chiroBaselines(30);
    res.json({
      price: PRICE_PER_VISIT,
      maxPerDay: MAX_PER_DAY,
      chiros: base.map(b => ({
        n: b.n, clinics: b.clinics, visits: b.visits, intakes: b.intakes,
        pva: b.pva, nowWeekly: Math.round(b.visits / 4.33),
        days: PLAN_DAYS[b.n] || 3.5,
        phone: !!b.phone, smsClinic: b.smsClinic,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Embedded P&L (bank-derived, operating basis) + 2026 monthly revenue for the trajectory
const PL = {"Amstelveen": {"2025": {"rev": 336619, "op": 92859, "exp": {"Personnel \u00b7 staff": 46691, "Other/Misc": 46449, "Personnel \u00b7 contractor chiro": 42924, "Marketing": 34786, "Rent": 33958, "Bank/Payment fees": 15741, "Travel/Transport": 6274, "Accounting/Professional": 5716, "Supplies/Retail": 4738, "Insurance": 3662, "Software/SaaS": 2711}, "below": {"Intercompany/Owner": 59519, "Tax": 10513, "Financing/Loan repay": 15496, "Internal \u00b7 transfer/loan in": -1432}}, "2026": {"rev": 167304, "op": 46401, "exp": {"Personnel \u00b7 staff": 34567, "Personnel \u00b7 contractor chiro": 18697, "Rent": 14821, "Marketing": 12676, "Other/Misc": 10575, "Accounting/Professional": 8295, "Bank/Payment fees": 7815, "Supplies/Retail": 5795, "Travel/Transport": 4865, "Insurance": 1567, "Software/SaaS": 1224}, "below": {"Financing/Loan repay": 6825, "Intercompany/Owner": 19500, "Internal \u00b7 transfer/loan in": -286, "Tax": 12123}}}, "Utrecht": {"2025": {"rev": 230704, "op": 45155, "exp": {"Personnel \u00b7 contractor chiro": 63660, "Personnel \u00b7 staff": 52861, "Marketing": 20327, "Other/Misc": 15133, "Bank/Payment fees": 13054, "Accounting/Professional": 9229, "Rent": 3944, "Supplies/Retail": 3538, "Software/SaaS": 1450, "Travel/Transport": 1305, "Insurance": 699, "Energy/Utilities": 210}, "below": {"Tax": 16855, "Financing/Loan repay": 629, "Intercompany/Owner": 31954}}, "2026": {"rev": 108567, "op": 17336, "exp": {"Personnel \u00b7 staff": 37926, "Personnel \u00b7 contractor chiro": 22782, "Marketing": 8966, "Bank/Payment fees": 6664, "Accounting/Professional": 6448, "Other/Misc": 4429, "Rent": 1294, "Supplies/Retail": 1020, "Travel/Transport": 667, "Software/SaaS": 646, "Insurance": 305}, "below": {"Financing/Loan repay": 358, "Tax": 11447, "Intercompany/Owner": 1500}}}, "Bussum": {"2025": {"rev": 167853, "op": 55260, "exp": {"Personnel \u00b7 contractor chiro": 38246, "Personnel \u00b7 staff": 25666, "Marketing": 15233, "Bank/Payment fees": 10135, "Accounting/Professional": 6676, "Other/Misc": 5143, "Energy/Utilities": 3596, "Travel/Transport": 3011, "Rent": 2377, "Supplies/Retail": 1494, "Software/SaaS": 785, "Insurance": 231}, "below": {"Financing/Loan repay": 37979, "Tax": 10596, "Intercompany/Owner": 3555, "Internal \u00b7 transfer/loan in": -1000}}, "2026": {"rev": 69072, "op": 26883, "exp": {"Personnel \u00b7 staff": 11068, "Personnel \u00b7 contractor chiro": 10622, "Marketing": 6110, "Bank/Payment fees": 4452, "Accounting/Professional": 3151, "Other/Misc": 2200, "Travel/Transport": 2099, "Energy/Utilities": 1581, "Software/SaaS": 364, "Insurance": 231, "Rent": 200}, "below": {"Financing/Loan repay": 12290, "Tax": 5255, "Intercompany/Owner": 7500}}}, "Rotterdam": {"2025": {"rev": 32828, "op": -18862, "exp": {"Supplies/Retail": 22514, "Personnel \u00b7 staff": 12921, "Rent": 7154, "Other/Misc": 5271, "Marketing": 2295, "Accounting/Professional": 862, "Software/SaaS": 495}, "below": {"Tax": 3994, "Financing/Loan repay": 1030, "Intercompany/Owner": 1150, "Internal \u00b7 transfer/loan in": -25320}}, "2026": {"rev": 79551, "op": 34444, "exp": {"Personnel \u00b7 staff": 12899, "Marketing": 10246, "Rent": 8821, "Other/Misc": 5905, "Accounting/Professional": 3842, "Supplies/Retail": 2327, "Bank/Payment fees": 422, "Software/SaaS": 214}, "below": {"Financing/Loan repay": 2527, "Intercompany/Owner": 14900, "Tax": 4947}}}, "Holding": {"2025": {"rev": 161243, "op": 94981, "exp": {"Personnel \u00b7 contractor chiro": 28680, "Supplies/Retail": 16734, "Other/Misc": 10478, "Accounting/Professional": 4037, "Marketing": 2622, "Travel/Transport": 1432, "Rent": 1431, "Bank/Payment fees": 772}, "below": {"Intercompany/Owner": 48010, "Tax": 18904, "Financing/Loan repay": 27488}}, "2026": {"rev": 107336, "op": 51569, "exp": {"Personnel \u00b7 contractor chiro": 37736, "Other/Misc": 10678, "Personnel \u00b7 staff": 4229, "Accounting/Professional": 1516, "Travel/Transport": 1120, "Rent": 250}, "below": {"Tax": 14895, "Intercompany/Owner": 20339, "Financing/Loan repay": 4883}}}};
const PL_ORDER = ["Amstelveen", "Utrecht", "Bussum", "Rotterdam", "Holding"];
const PL_LABEL = {"Holding": "Notable (holding)"};
const DATA_ASOF = "Jun 2026";
const MONTHLY_2026 = [71488, 65154, 80199, 75479, 78357];
const PACE = MONTHLY_2026.reduce((a,b)=>a+b,0)/MONTHLY_2026.length;

app.get("/plan", gate, (req, res) => {
  const role = req.role || "owner";
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Posturefixx — Plan</title>
<style>
  :root{--ink:#16202E;--mut:#6B7686;--line:#E5E9F0;--blue:#2563EB;--ok:#16A34A;--str:#D97706;--over:#DC2626;--bg:#F7F9FC}
  *{box-sizing:border-box} body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg);margin:0;padding:28px 16px;line-height:1.5}
  .wrap{max-width:780px;margin:0 auto} h1{font-size:22px;margin:0 0 2px} .sub{color:var(--mut);margin:0 0 18px;font-size:14px}
  .tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:18px}
  .tab{padding:8px 14px;border:1px solid var(--line);background:#fff;border-radius:999px;cursor:pointer;font-size:13px;font-weight:600;color:var(--mut)}
  .tab.on{background:var(--ink);color:#fff;border-color:var(--ink)}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}
  .advice{background:linear-gradient(180deg,#fff,#FBFCFE);border:1px solid var(--line);border-left:4px solid var(--blue)}
  .advice h3{margin:0 0 10px;font-size:15px} .advice ul{margin:0;padding:0;list-style:none}
  .advice li{padding:8px 0;border-bottom:1px solid var(--line);font-size:14px;display:flex;gap:10px}
  .advice li:last-child{border-bottom:none} .advice .ic{flex:none;width:20px;text-align:center}
  .slider-row{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px}
  .target{font-size:30px;font-weight:700} input[type=range]{width:100%;accent-color:var(--blue);height:6px}
  .ticks{display:flex;justify-content:space-between;color:var(--mut);font-size:12px;margin-top:4px}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:8px}
  .stat{background:var(--bg);border-radius:10px;padding:12px} .stat .v{font-size:20px;font-weight:700} .stat .l{color:var(--mut);font-size:12px}
  table{width:100%;border-collapse:collapse;font-size:14px} th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line)}
  th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.03em} td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  .tag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600}
  .tag.ok{background:#DCFCE7;color:var(--ok)} .tag.stretch{background:#FEF3C7;color:var(--str)} .tag.over{background:#FEE2E2;color:var(--over)}
  .arrow{color:var(--mut)} .btn{display:inline-block;border:none;background:var(--blue);color:#fff;font-size:15px;font-weight:600;padding:13px 22px;border-radius:10px;cursor:pointer;text-decoration:none}
  .legend{color:var(--mut);font-size:12.5px;margin-top:10px;line-height:1.6} .legend b{color:var(--ink)}
  .err{color:var(--over);font-size:14px} .loading{color:var(--mut)}
  .pl-op{font-weight:700} .pl-op td{border-top:2px solid var(--ink)} .memo td{color:var(--mut);font-size:13px} .pos{color:var(--ok)} .neg{color:var(--over)}
  svg text{font-family:inherit}
</style></head><body><div class="wrap">
  <h1>Posturefixx — Plan</h1>
  <p class="sub">${role==="manager"?"Manager view · ":""}Live PracticeHub numbers and bank-derived P&amp;L · figures as of ${DATA_ASOF}.</p>
  <div class="tabs" id="tabs"></div>

  <section data-tab="Plan">
    <div class="card advice">
      <h3>What to focus on</h3>
      <ul id="advice"><li><span class="ic">⏳</span><span>Reading your numbers…</span></li></ul>
    </div>
    <div class="card">
      <div class="slider-row"><div>Yearly revenue target</div><div class="target" id="tgt">€1.10M</div></div>
      <input type="range" id="slider" min="700000" max="1500000" step="25000" value="1100000">
      <div class="ticks"><span>€0.70M</span><span>€1.10M</span><span>€1.50M</span></div>
      <div class="stats">
        <div class="stat"><div class="v" id="s-pace">–</div><div class="l">on current pace (yr)</div></div>
        <div class="stat"><div class="v" id="s-need">–</div><div class="l">visits / month needed</div></div>
        <div class="stat"><div class="v" id="s-gap">–</div><div class="l">monthly visit gap</div></div>
      </div>
    </div>
    <div class="card">
      <b>Revenue trajectory</b>
      <p class="sub" style="margin:4px 0 6px">Solid = where this year lands if you hold your current pace. Dashed = the path to the target on the slider.</p>
      <svg id="traj" viewBox="0 0 700 260" width="100%"></svg>
    </div>
    <div class="card">
      <b>Per-chiropractor goals</b><div class="err" id="err"></div>
      <table id="tbl"><thead><tr><th>Chiro</th><th class="num">Now /day</th><th class="num">Goal /day</th><th class="num">Days</th><th class="num">PVA → goal</th><th>Load</th></tr></thead>
        <tbody><tr><td colspan="6" class="loading">Loading live PracticeHub numbers… (first load ~30s on the free tier)</td></tr></tbody></table>
      <div class="bars" id="bars"></div>
      <div class="legend">
        <b>How to read it:</b> these are visits <b>per working day</b>. A chiro can comfortably see up to ~<b>${MAX_PER_DAY}/day</b> (the <b style="color:var(--over)">red line</b>),
        so capacity is rarely the limit — most of your team sits well under it. That means the constraint on growth isn't your chiros' capacity,
        it's <b>filling their days</b> (more intakes converting to care + better retention). <span class="tag over">Over</span> only shows if a goal would push someone past a realistic full day.
      </div>
    </div>
    <div class="card">
      <b>Push coaching to the team</b>
      <p class="sub" style="margin:6px 0 14px">Opens the review screen at your chosen target — you see each drafted message and confirm before anything sends.</p>
      <a class="btn" id="send" href="/coach">Review &amp; send via SMS →</a>
    </div>
  </section>

  <div id="pl-tabs"></div>
  <p class="sub">Pages: <a href="/plan">/plan</a> · <a href="/revenue">/revenue</a> · <a href="/marketing">/marketing</a> · <a href="/waste">/waste</a> · <a href="/pva">/pva</a> · <a href="/ca">/ca</a> · <a href="/goals">/goals</a> · <a href="/coach">/coach</a></p>
</div>
<script>
  var PL={"Amstelveen": {"2025": {"rev": 336619, "op": 92859, "exp": {"Personnel \u00b7 staff": 46691, "Other/Misc": 46449, "Personnel \u00b7 contractor chiro": 42924, "Marketing": 34786, "Rent": 33958, "Bank/Payment fees": 15741, "Travel/Transport": 6274, "Accounting/Professional": 5716, "Supplies/Retail": 4738, "Insurance": 3662, "Software/SaaS": 2711}, "below": {"Intercompany/Owner": 59519, "Tax": 10513, "Financing/Loan repay": 15496, "Internal \u00b7 transfer/loan in": -1432}}, "2026": {"rev": 167304, "op": 46401, "exp": {"Personnel \u00b7 staff": 34567, "Personnel \u00b7 contractor chiro": 18697, "Rent": 14821, "Marketing": 12676, "Other/Misc": 10575, "Accounting/Professional": 8295, "Bank/Payment fees": 7815, "Supplies/Retail": 5795, "Travel/Transport": 4865, "Insurance": 1567, "Software/SaaS": 1224}, "below": {"Financing/Loan repay": 6825, "Intercompany/Owner": 19500, "Internal \u00b7 transfer/loan in": -286, "Tax": 12123}}}, "Utrecht": {"2025": {"rev": 230704, "op": 45155, "exp": {"Personnel \u00b7 contractor chiro": 63660, "Personnel \u00b7 staff": 52861, "Marketing": 20327, "Other/Misc": 15133, "Bank/Payment fees": 13054, "Accounting/Professional": 9229, "Rent": 3944, "Supplies/Retail": 3538, "Software/SaaS": 1450, "Travel/Transport": 1305, "Insurance": 699, "Energy/Utilities": 210}, "below": {"Tax": 16855, "Financing/Loan repay": 629, "Intercompany/Owner": 31954}}, "2026": {"rev": 108567, "op": 17336, "exp": {"Personnel \u00b7 staff": 37926, "Personnel \u00b7 contractor chiro": 22782, "Marketing": 8966, "Bank/Payment fees": 6664, "Accounting/Professional": 6448, "Other/Misc": 4429, "Rent": 1294, "Supplies/Retail": 1020, "Travel/Transport": 667, "Software/SaaS": 646, "Insurance": 305}, "below": {"Financing/Loan repay": 358, "Tax": 11447, "Intercompany/Owner": 1500}}}, "Bussum": {"2025": {"rev": 167853, "op": 55260, "exp": {"Personnel \u00b7 contractor chiro": 38246, "Personnel \u00b7 staff": 25666, "Marketing": 15233, "Bank/Payment fees": 10135, "Accounting/Professional": 6676, "Other/Misc": 5143, "Energy/Utilities": 3596, "Travel/Transport": 3011, "Rent": 2377, "Supplies/Retail": 1494, "Software/SaaS": 785, "Insurance": 231}, "below": {"Financing/Loan repay": 37979, "Tax": 10596, "Intercompany/Owner": 3555, "Internal \u00b7 transfer/loan in": -1000}}, "2026": {"rev": 69072, "op": 26883, "exp": {"Personnel \u00b7 staff": 11068, "Personnel \u00b7 contractor chiro": 10622, "Marketing": 6110, "Bank/Payment fees": 4452, "Accounting/Professional": 3151, "Other/Misc": 2200, "Travel/Transport": 2099, "Energy/Utilities": 1581, "Software/SaaS": 364, "Insurance": 231, "Rent": 200}, "below": {"Financing/Loan repay": 12290, "Tax": 5255, "Intercompany/Owner": 7500}}}, "Rotterdam": {"2025": {"rev": 32828, "op": -18862, "exp": {"Supplies/Retail": 22514, "Personnel \u00b7 staff": 12921, "Rent": 7154, "Other/Misc": 5271, "Marketing": 2295, "Accounting/Professional": 862, "Software/SaaS": 495}, "below": {"Tax": 3994, "Financing/Loan repay": 1030, "Intercompany/Owner": 1150, "Internal \u00b7 transfer/loan in": -25320}}, "2026": {"rev": 79551, "op": 34444, "exp": {"Personnel \u00b7 staff": 12899, "Marketing": 10246, "Rent": 8821, "Other/Misc": 5905, "Accounting/Professional": 3842, "Supplies/Retail": 2327, "Bank/Payment fees": 422, "Software/SaaS": 214}, "below": {"Financing/Loan repay": 2527, "Intercompany/Owner": 14900, "Tax": 4947}}}, "Holding": {"2025": {"rev": 161243, "op": 94981, "exp": {"Personnel \u00b7 contractor chiro": 28680, "Supplies/Retail": 16734, "Other/Misc": 10478, "Accounting/Professional": 4037, "Marketing": 2622, "Travel/Transport": 1432, "Rent": 1431, "Bank/Payment fees": 772}, "below": {"Intercompany/Owner": 48010, "Tax": 18904, "Financing/Loan repay": 27488}}, "2026": {"rev": 107336, "op": 51569, "exp": {"Personnel \u00b7 contractor chiro": 37736, "Other/Misc": 10678, "Personnel \u00b7 staff": 4229, "Accounting/Professional": 1516, "Travel/Transport": 1120, "Rent": 250}, "below": {"Tax": 14895, "Intercompany/Owner": 20339, "Financing/Loan repay": 4883}}}}, ORDER=["Amstelveen", "Utrecht", "Bussum", "Rotterdam", "Holding"], LABEL={"Holding": "Notable (holding)"}, MONTHLY=[71488, 65154, 80199, 75479, 78357], PACE=74135.4, ASOF="Jun 2026";
  var PL_SPEND={"Utrecht":{"2021":{"Owner / intercompany":24661,"Supplies/equipment":19072,"Marketing":18515,"Rent":14792,"Personnel \u00b7 payroll":12235,"Other":7394,"Tax":6373,"Chiro wages":3798,"Card & fees":3535,"Accounting / legal":2760,"Groceries":628,"Insurance":466,"Software/SaaS":136},"2022":{"Owner / intercompany":67121,"Chiro wages":35200,"Marketing":29203,"Rent":23162,"Personnel \u00b7 payroll":21667,"Other":14736,"Card & fees":13960,"Tax":10887,"Supplies/equipment":3280,"Insurance":1522,"Groceries":1238,"Accounting / legal":578,"Travel/parking":5},"2023":{"Chiro wages":128845,"Owner / intercompany":44255,"Personnel \u00b7 payroll":27817,"Marketing":19904,"Card & fees":19636,"Other":19011,"Tax":16539,"Supplies/equipment":8462,"Rent":5891,"Travel/parking":3328,"CA wages":2508,"Insurance":2315,"Groceries":1308,"Accounting / legal":774,"Software/SaaS":258},"2024":{"Chiro wages":141446,"Personnel \u00b7 payroll":23870,"Marketing":21285,"Card & fees":19688,"Tax":18843,"CA wages":18731,"Owner / intercompany":16495,"Other":10506,"Accounting / legal":3947,"Insurance":3830,"Travel/parking":1936,"Supplies/equipment":1710,"Software/SaaS":1510,"Groceries":578,"Energy/utilities":420},"2025":{"Chiro wages":80950,"Owner / intercompany":41277,"CA wages":24651,"Marketing":18261,"Tax":16601,"Card & fees":16153,"Personnel \u00b7 payroll":12817,"Accounting / legal":8808,"Other":7427,"Energy/utilities":1750,"Software/SaaS":1480,"Supplies/equipment":1272,"Travel/parking":1234,"Groceries":1209,"Insurance":1097},"2026":{"Chiro wages":49097,"CA wages":12781,"Tax":11168,"Marketing":7926,"Card & fees":7438,"Accounting / legal":6128,"Other":4638,"Owner / intercompany":1720,"Energy/utilities":1114,"Software/SaaS":636,"Insurance":625,"Groceries":595,"Travel/parking":466,"Supplies/equipment":291}},"Bussum":{"2022":{"Owner / intercompany":39662,"Rent":27083,"Financing/loans":17102,"Supplies/equipment":11589,"Card & fees":10475,"Other":9131,"Personnel \u00b7 payroll":9111,"Chiro wages":7850,"Marketing":6367,"Tax":5986,"Travel/parking":2731,"Groceries":565,"Accounting / legal":457,"Insurance":234,"Software/SaaS":85},"2023":{"Chiro wages":31890,"Rent":26997,"Personnel \u00b7 payroll":18848,"Financing/loans":16161,"Tax":15401,"Owner / intercompany":14084,"Card & fees":11132,"Marketing":10904,"CA wages":8863,"Other":4919,"Energy/utilities":1820,"Travel/parking":1307,"Accounting / legal":942,"Supplies/equipment":810,"Insurance":809,"Groceries":446,"Software/SaaS":57},"2024":{"Card & fees":28328,"Rent":27397,"Owner / intercompany":26293,"Chiro wages":22331,"CA wages":17393,"Marketing":11734,"Tax":9436,"Other":7238,"Accounting / legal":3619,"Energy/utilities":3207,"Travel/parking":2135,"Supplies/equipment":1844,"Personnel \u00b7 payroll":1523,"Software/SaaS":693,"Insurance":623,"Groceries":362},"2025":{"Chiro wages":39628,"Rent":28332,"Card & fees":23514,"CA wages":21156,"Marketing":13033,"Tax":10596,"Personnel \u00b7 payroll":6710,"Accounting / legal":4996,"Owner / intercompany":4947,"Other":4388,"Energy/utilities":3533,"Travel/parking":2333,"Software/SaaS":717,"Insurance":388,"Supplies/equipment":388,"Groceries":63},"2026":{"CA wages":12308,"Rent":12080,"Chiro wages":10622,"Owner / intercompany":7500,"Card & fees":5977,"Marketing":4870,"Tax":3995,"Other":3079,"Accounting / legal":3023,"Energy/utilities":1489,"Travel/parking":1482,"Software/SaaS":364,"Insurance":359,"Groceries":48,"Supplies/equipment":35}},"Amstelveen":{"2023":{"Supplies/equipment":31744,"Owner / intercompany":22376,"Chiro wages":21651,"Other":15248,"Marketing":13283,"Financing/loans":7291,"Personnel \u00b7 payroll":6543,"Card & fees":2948,"Tax":1537,"Travel/parking":1218,"Accounting / legal":849,"CA wages":545,"Groceries":537,"Software/SaaS":51},"2024":{"Chiro wages":55391,"Owner / intercompany":47415,"Supplies/equipment":35335,"Marketing":27979,"Card & fees":24441,"Personnel \u00b7 payroll":13927,"CA wages":12976,"Other":11948,"Tax":9258,"Accounting / legal":4794,"Travel/parking":3197,"Software/SaaS":1879,"Groceries":960},"2025":{"Chiro wages":73173,"Owner / intercompany":61623,"Supplies/equipment":33521,"Marketing":33460,"Card & fees":32979,"CA wages":26788,"Personnel \u00b7 payroll":15724,"Other":13877,"Tax":13083,"Rent":6440,"Travel/parking":6029,"Accounting / legal":5692,"Insurance":3654,"Software/SaaS":2661,"Groceries":584},"2026":{"Chiro wages":44986,"CA wages":22205,"Owner / intercompany":19995,"Card & fees":16328,"Marketing":12208,"Tax":12123,"Other":8631,"Supplies/equipment":8348,"Accounting / legal":6795,"Travel/parking":4460,"Insurance":1567,"Software/SaaS":1224,"Rent":425,"Groceries":249}},"Rotterdam":{"2025":{"Supplies/equipment":22346,"CA wages":13521,"Rent":7154,"Marketing":4074,"Tax":3994,"Other":3661,"Owner / intercompany":1901,"Card & fees":469,"Insurance":423,"Software/SaaS":243,"Groceries":72,"Travel/parking":4},"2026":{"Owner / intercompany":16135,"CA wages":14139,"Marketing":9107,"Rent":8621,"Tax":4947,"Other":4905,"Supplies/equipment":3079,"Accounting / legal":2584,"Card & fees":1943,"Insurance":1137,"Groceries":470,"Software/SaaS":214,"Energy/utilities":168,"Travel/parking":30}},"Holding":{"2020":{"Accounting / legal":1923,"Supplies/equipment":1424,"Other":1262,"Card & fees":102,"Tax":68},"2021":{"Chiro wages":4375,"Rent":4235,"Other":4113,"Supplies/equipment":1171,"Owner / intercompany":1100,"Accounting / legal":460,"Card & fees":214,"Tax":53},"2022":{"Owner / intercompany":28609,"Chiro wages":17033,"Marketing":13923,"Tax":13117,"Accounting / legal":8081,"Other":5947,"Supplies/equipment":2457,"Card & fees":435},"2023":{"Owner / intercompany":30853,"Chiro wages":29625,"Accounting / legal":18301,"Tax":14469,"Marketing":13534,"Other":5662,"Card & fees":2167,"Supplies/equipment":2149,"Software/SaaS":25},"2024":{"Owner / intercompany":42861,"Tax":25396,"Chiro wages":13269,"Marketing":11764,"Accounting / legal":10657,"Other":6104,"CA wages":2400,"Financing/loans":1995,"Card & fees":599,"Supplies/equipment":367},"2025":{"Owner / intercompany":74442,"Chiro wages":30180,"Tax":18988,"Supplies/equipment":18304,"Other":7584,"Card & fees":5037,"Marketing":2622,"Financing/loans":2395,"Accounting / legal":1079,"Travel/parking":35},"2026":{"Chiro wages":37736,"Owner / intercompany":20339,"Tax":14895,"Other":10337,"Card & fees":5679,"Coaching/training":4229,"Financing/loans":998,"Marketing":801,"Accounting / legal":756,"Travel/parking":115}}}; var CC={"Chiro wages":"#2563eb","CA wages":"#0891b2","Personnel \u00b7 payroll":"#7c3aed","Marketing":"#16a34a","Coaching/training":"#0ea5e9","Rent":"#ea580c","Supplies/equipment":"#db2777","Owner / intercompany":"#94a3b8","Tax":"#dc2626","Accounting / legal":"#0d9488","Energy/utilities":"#ca8a04","Card & fees":"#9333ea","Financing/loans":"#be123c","Software/SaaS":"#475569","Travel/parking":"#a16207","Insurance":"#65a30d","Groceries":"#f59e0b","Other":"#cbd5e1"};
  var DATA=null;
  var fmtM=function(n){return "€"+(n/1e6).toFixed(2)+"M"};
  var eur=function(n){return (n<0?"-":"")+"€"+Math.abs(Math.round(n)).toLocaleString("en-US")};

  var tabNames=["Plan"].concat(ORDER.map(function(e){return LABEL[e]||e}));
  var tabsEl=document.getElementById("tabs");
  function show(name){
    Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"),function(s){s.style.display=(s.getAttribute("data-tab")===name)?"":"none"});
    Array.prototype.forEach.call(tabsEl.children,function(b){b.className="tab"+(b.textContent===name?" on":"")});
    if(name==="Plan") drawTraj();
  }
  tabNames.forEach(function(name){var b=document.createElement("div");b.className="tab";b.textContent=name;b.onclick=function(){show(name)};tabsEl.appendChild(b);});

  // ---- P&L tabs ----
  function spendBlock(clinic){
    var yrs=Object.keys(PL_SPEND[clinic]||{}).sort();
    if(!yrs.length) return "";
    var btns=yrs.map(function(y){return "<button data-clinic='"+clinic+"' data-year='"+y+"' onclick='drawSpend(&quot;"+clinic+"&quot;,&quot;"+y+"&quot;)' style='padding:5px 10px;margin:0 6px 6px 0;border:1px solid #e5e7eb;background:#fff;border-radius:6px;font-size:12px;cursor:pointer;color:#6B7686'>"+y+(y==="2026"?" YTD":"")+"</button>";}).join("");
    return "<div class='card'><b>Spend by category</b> <span class='sub' style='font-size:12px'>\u00b7 pick a year \u2014 history runs from "+yrs[0]+" \u00b7 hover a bar for the figure</span>"+
      "<div style='margin:10px 0 4px'>"+btns+"</div><div id='spend-"+clinic+"'></div></div>";
  }
  function drawSpend(clinic,year){
    var exp=(PL_SPEND[clinic]||{})[year]||{};
    var cats=Object.keys(exp).sort(function(a,b){return exp[b]-exp[a];});
    var max=cats.length?exp[cats[0]]:1, rowH=30, padL=160, W=720, barMax=W-padL-90, H=cats.length*rowH+10, g="";
    cats.forEach(function(c,i){ var yt=i*rowH+6, v=exp[c], w=v/max*barMax;
      g+="<text x='"+(padL-8)+"' y='"+(yt+14)+"' text-anchor='end' font-size='11' fill='#16202E'>"+c+"</text>";
      g+="<rect x='"+padL+"' y='"+yt+"' width='"+w+"' height='16' rx='3' fill='"+(CC[c]||'#2563EB')+"'><title>"+c+": "+eur(v)+"</title></rect>";
      g+="<text x='"+(padL+w+6)+"' y='"+(yt+14)+"' font-size='10' fill='#64748b'>"+eur(v)+"</text>"; });
    var el=document.getElementById("spend-"+clinic);
    if(el) el.innerHTML = cats.length? ("<svg viewBox='0 0 "+W+" "+H+"' width='100%'>"+g+"</svg>") : "<p class='sub'>No spend recorded for "+year+".</p>";
    Array.prototype.forEach.call(document.querySelectorAll("button[data-clinic='"+clinic+"']"),function(b){
      var on=b.getAttribute("data-year")===year;
      b.style.background=on?"#2563EB":"#fff"; b.style.color=on?"#fff":"#6B7686"; b.style.borderColor=on?"#2563EB":"#e5e7eb"; });
  }

  var plWrap=document.getElementById("pl-tabs");
  ORDER.forEach(function(e){
    var d=PL[e], sec=document.createElement("section"); sec.setAttribute("data-tab",LABEL[e]||e); sec.style.display="none";
    function col(y){
      var p=d[y]; if(!p) return "";
      var rows="<tr><td>Revenue</td><td class='num'><b>"+eur(p.rev)+"</b></td></tr>";
      Object.keys(p.exp).forEach(function(k){ rows+="<tr><td style='padding-left:16px;color:var(--mut)'>"+k+"</td><td class='num'>"+eur(-p.exp[k])+"</td></tr>"; });
      rows+="<tr class='pl-op'><td>Operating profit</td><td class='num "+(p.op>=0?"pos":"neg")+"'>"+eur(p.op)+"</td></tr>";
      var below=Object.keys(p.below||{});
      if(below.length){ rows+="<tr class='memo'><td colspan='2' style='padding-top:10px'><i>Below the line (not in operating profit):</i></td></tr>";
        below.forEach(function(k){ rows+="<tr class='memo'><td style='padding-left:16px'>"+k+"</td><td class='num'>"+eur(-p.below[k])+"</td></tr>"; }); }
      return "<div class='card' style='flex:1;min-width:280px'><b>"+y+(y==="2026"?" (YTD)":"")+"</b><table style='margin-top:8px'>"+rows+"</table></div>";
    }
    sec.innerHTML="<h2 style='font-size:18px;margin:4px 0 2px'>"+(LABEL[e]||e)+" — P&L</h2>"+
      "<p class='sub'>Operating basis from your bank data (as of "+ASOF+"). Excludes owner draws, tax and loan repayments (shown below the line). "+(e==="Holding"?"Note: Notable's revenue is mostly intra-group management fees + table sales, so don't add it to the clinics.":"")+"</p>"+
      spendBlock(e)+
      "<div style='display:flex;gap:14px;flex-wrap:wrap'>"+col("2026")+col("2025")+"</div>";
    plWrap.appendChild(sec);
  });
  ORDER.forEach(function(e){ var ys=Object.keys(PL_SPEND[e]||{}).sort(); if(ys.length) drawSpend(e, ys[ys.length-1]); });

  // ---- trajectory ----
  function drawTraj(){
    var target=+document.getElementById("slider").value, W=700,H=260,padL=54,padR=16,padT=14,padB=28,n=12;
    var actual=MONTHLY.slice();
    var curCum=[],t=0; for(var m=0;m<n;m++){ t+=(m<actual.length?actual[m]:PACE); curCum.push(t); }
    var tgtCum=[],s=0,tm=target/12; for(var m=0;m<n;m++){ s+=tm; tgtCum.push(s); }
    var maxY=Math.max(curCum[n-1],tgtCum[n-1])*1.05;
    var x=function(i){return padL+(W-padL-padR)*i/(n-1)}, y=function(v){return H-padB-(H-padT-padB)*v/maxY};
    var path=function(arr){return arr.map(function(v,i){return (i?"L":"M")+x(i).toFixed(1)+" "+y(v).toFixed(1)}).join(" ")};
    var MN=["J","F","M","A","M","J","J","A","S","O","N","D"],g="";
    for(var k=0;k<=4;k++){ var gv=maxY*k/4,gy=y(gv); g+="<line x1='"+padL+"' y1='"+gy+"' x2='"+(W-padR)+"' y2='"+gy+"' stroke='#EEF1F5'/>"+
      "<text x='"+(padL-8)+"' y='"+(gy+4)+"' text-anchor='end' font-size='11' fill='#9AA4B2'>€"+Math.round(gv/1000)+"k</text>"; }
    for(var i=0;i<n;i++){ g+="<text x='"+x(i)+"' y='"+(H-8)+"' text-anchor='middle' font-size='11' fill='#9AA4B2'>"+MN[i]+"</text>"; }
    var solid=curCum.slice(0,actual.length), off=actual.length-1, proj=curCum.slice(off);
    g+="<path d='"+("M"+x(0)+" "+y(curCum[0])+" "+solid.map(function(v,i){return "L"+x(i).toFixed(1)+" "+y(v).toFixed(1)}).join(" "))+"' fill='none' stroke='#16202E' stroke-width='2.5'/>";
    g+="<path d='"+proj.map(function(v,i){var ii=i+off;return (i?"L":"M")+x(ii).toFixed(1)+" "+y(v).toFixed(1)}).join(" ")+"' fill='none' stroke='#16202E' stroke-width='2' stroke-dasharray='2 4' opacity='.5'/>";
    g+="<path d='"+path(tgtCum)+"' fill='none' stroke='#2563EB' stroke-width='2' stroke-dasharray='6 5'/>";
    g+="<text x='"+(W-padR)+"' y='"+(y(curCum[n-1])-6)+"' text-anchor='end' font-size='12' font-weight='700' fill='#16202E'>pace "+fmtM(curCum[n-1])+"</text>";
    g+="<text x='"+(W-padR)+"' y='"+(y(tgtCum[n-1])-6)+"' text-anchor='end' font-size='12' font-weight='700' fill='#2563EB'>target "+fmtM(tgtCum[n-1])+"</text>";
    document.getElementById("traj").innerHTML=g;
  }

  // ---- advice (rules-based, from P&L + live chiros + trajectory) ----
  function buildAdvice(target){
    var out=[];
    var paceYr=PACE*12, gapYr=target-paceYr;
    if(gapYr>15000) out.push(["📈","On current pace you'll land near <b>"+fmtM(paceYr)+"</b>. Your <b>"+fmtM(target)+"</b> target needs about <b>"+Math.round((gapYr/12)/59)+" more visits/month</b> — push it through retention, not just new intakes."]);
    else out.push(["✅","You're tracking at <b>"+fmtM(paceYr)+"</b> — at or above the <b>"+fmtM(target)+"</b> target. Hold the line; protect retention so it sticks."]);
    // thinnest-margin clinic (exclude Holding)
    var worst=null;
    ORDER.forEach(function(e){ if(e==="Holding")return; var p=PL[e]&&PL[e]["2026"]; if(!p||p.rev<=0)return; var m=p.op/p.rev; if(!worst||m<worst.m) worst={e:e,m:m,p:p}; });
    if(worst){ var topCost=Object.keys(worst.p.exp)[0]; out.push(["🩺","<b>"+worst.e+"</b> is your thinnest margin (<b>"+Math.round(worst.m*100)+"%</b> operating). Its biggest cost is "+topCost+". This is the clinic to fix first — coverage and conversion, not more ad spend."]); }
    // live chiro signals
    if(DATA){
      var low=DATA.chiros.slice().sort(function(a,b){return a.pva-b.pva})[0];
      if(low) out.push(["🔁","Lowest retention is <b>"+low.n+"</b> (PVA <b>"+low.pva+"</b>) at "+low.clinics.join(" + ")+". Lifting that one number is the cheapest growth you have — every point is free visits."]);
      var sumV=DATA.chiros.reduce(function(s,b){return s+b.visits},0)||1, need=(target/12)/DATA.price, scale=need/sumV;
      var anyOver=DATA.chiros.some(function(b){return (b.visits*scale/4.33)/b.days > 0.9*DATA.maxPerDay;});
      if(anyOver) out.push(["⚠️","At this target someone is pushed past a realistic full day — add a chiropractor (Amstelveen is the likeliest spot) rather than overloading."]);
      else out.push(["🟢","Your team has headroom — these goals sit well under a full day. The job is <b>filling the days</b>: intake→care conversion (the CA track) and retention."]);
    }
    return out;
  }
  function renderAdvice(target){
    var ul=document.getElementById("advice"); if(!ul) return;
    ul.innerHTML=buildAdvice(target).map(function(a){return "<li><span class='ic'>"+a[0]+"</span><span>"+a[1]+"</span></li>"}).join("");
  }

  // ---- slider recompute ----
  function recompute(){
    document.getElementById("tgt").textContent=fmtM(+slider.value);
    document.getElementById("send").href="/coach?target="+slider.value;
    document.getElementById("s-pace").textContent=fmtM(PACE*12);
    drawTraj(); renderAdvice(+slider.value);
    if(!DATA) return;
    var target=+slider.value, MAX=DATA.maxPerDay;
    var sumV=DATA.chiros.reduce(function(s,b){return s+b.visits},0)||1, needMonthly=(target/12)/DATA.price, scale=needMonthly/sumV;
    document.getElementById("s-need").textContent=Math.round(needMonthly);
    var gap=Math.round(needMonthly-sumV); document.getElementById("s-gap").textContent=(gap>=0?"+":"")+gap;
    var rows="",bars="";
    DATA.chiros.forEach(function(b){
      var goalWeekly=b.visits*scale/4.33, nowDay=b.nowWeekly/b.days, goalDay=goalWeekly/b.days;
      var goalPva=b.intakes?(b.visits*scale/b.intakes):0;
      var load="ok",lab="OK"; if(goalDay>0.9*MAX){load="over";lab="Over"} else if(goalDay>0.7*MAX){load="stretch";lab="Stretch"}
      rows+="<tr><td><b>"+b.n+"</b><br><span class='arrow' style='font-size:12px'>"+b.clinics.join(" + ")+"</span></td>"+
            "<td class='num'>"+nowDay.toFixed(0)+"</td><td class='num'><b>"+goalDay.toFixed(0)+"</b></td><td class='num'>"+b.days+"</td>"+
            "<td class='num'>"+b.pva+" <span class='arrow'>→</span> "+goalPva.toFixed(1)+"</td><td><span class='tag "+load+"'>"+lab+"</span></td></tr>";
      var pN=nowDay/MAX*100,pG=goalDay/MAX*100;
      bars+="<div style='display:flex;align-items:center;gap:10px;margin:7px 0'><div style='width:64px;font-size:13px;font-weight:600'>"+b.n+"</div>"+
            "<div style='flex:1;background:var(--bg);border-radius:6px;position:relative;height:22px'>"+
            "<div style='position:absolute;left:0;top:0;height:100%;border-radius:6px;background:#BFD3FF;width:"+Math.min(100,pN)+"%'></div>"+
            "<div style='position:absolute;left:0;top:0;height:100%;border-radius:6px;background:#2563EB;opacity:.85;width:"+Math.min(100,pG)+"%'></div>"+
            "<div style='position:absolute;top:-3px;height:28px;width:2px;background:#DC2626;left:100%'></div></div>"+
            "<div style='width:54px;font-size:11px;color:var(--mut);text-align:right'>of ~"+MAX+"</div></div>";
    });
    document.querySelector("#tbl tbody").innerHTML=rows; document.getElementById("bars").innerHTML=bars;
  }
  var slider=document.getElementById("slider"); slider.addEventListener("input",recompute);
  show("Plan"); recompute();
  fetch("/plan/data").then(function(r){return r.json()}).then(function(d){
    if(d.error){document.getElementById("err").textContent="PracticeHub error: "+d.error;document.querySelector("#tbl tbody").innerHTML="";return;}
    DATA=d; recompute();
  }).catch(function(e){document.getElementById("err").textContent="Could not load: "+e});
</script></body></html>`);
});

// ============================================================
// CA DASHBOARD — Renata's view (added to coaching-engine.js)
// ============================================================

// Doorplannen tracker (Google Sheet, link-shared, no auth needed)
const DOORPLANNEN_SHEET = "1foXa-E8AGFKnqXZG2vt_-RBOK8oANah7xvLy8uexCCU";
const INTAKE_TABS = {
  Amstelveen: "Intakes Amstelveen",
  Bussum:     "Intakes Bussum",
  Rotterdam:  "Intakes Rotterdam",
  Utrecht:    "Intakes Utrecht",
};

// CA roster — name + which env var holds their phone
const CAS = [
  { name: "Csabi",     phoneVar: "PHONE_CSABA" },
  { name: "Samantha",  phoneVar: "PHONE_SAMANTHA" },
  { name: "Dolly",     phoneVar: "PHONE_DOLLY" },
  { name: "Vivian",    phoneVar: "PHONE_VIVIAN" },
  { name: "Anne",      phoneVar: "PHONE_ANNE" },
  { name: "Alexandra", phoneVar: "PHONE_ALEXANDRA" },
  { name: "Archana",   phoneVar: "PHONE_ARCHANA" },
  { name: "Renata",    phoneVar: "PHONE_RENATA" },
  { name: "Szandi",    phoneVar: "PHONE_SZANDI" },
];

function caPhone(name) {
  const ca = CAS.find(c => c.name === name);
  return ca ? process.env[ca.phoneVar] : null;
}

// Normalize how names appear in the sheet (Sam → Samantha, etc.)
function normalizeCA(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const map = {
    csabi: "Csabi", csaba: "Csabi",
    samantha: "Samantha", sam: "Samantha",
    dolly: "Dolly",
    vivian: "Vivian",
    anne: "Anne",
    alexandra: "Alexandra",
    archana: "Archana",
    renata: "Renata",  // Renata herself sometimes takes intakes
    szandi: "Szandi",  // Utrecht CA
  };
  return map[s] || String(raw).trim();
}

// ---------- Sheet fetching & CSV parsing ----------
async function fetchSheetCSV(sheetId, tabName) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheet fetch failed (${res.status}) for tab "${tabName}"`);
  return res.text();
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuote = true; }
      else if (c === ',') { row.push(field); field = ""; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== '\r') { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Each Intakes tab has stacked "blocks" — one per week — each starting with a
// header row containing Name / CA / Appointments / Package / Meta / Chiro / Notes.
function parseIntakesCSV(csvText, clinic) {
  const rows = parseCSV(csvText);
  const intakes = [];
  let cols = null, currentWeek = null;
  for (const r of rows) {
    if (!r || !r.length) continue;
    const cells = r.map(c => (c || "").trim());
    const nonEmpty = cells.filter(Boolean);
    // Week divider row, e.g. "Week 24" sitting above that week's intakes
    const wk = cells.find(c => /^week\s*\d+/i.test(c));
    if (wk && nonEmpty.length <= 2) { currentWeek = wk.replace(/\s+/g, " ").trim(); continue; }
    // Detect header row
    const hasName = cells.some(c => c === "Name");
    const hasCA = cells.some(c => c === "CA");
    const hasAppt = cells.some(c => c === "Appointments");
    if (hasName && hasCA && hasAppt) { cols = cells; continue; }
    if (!cols) continue;
    // Build the row object
    const obj = { _clinic: clinic, _week: currentWeek || "Unlabelled" };
    cols.forEach((h, idx) => { if (h) obj[h] = cells[idx] || ""; });
    // Allow a per-row Week/Date column to override the divider
    if (obj.Week && /week\s*\d+/i.test(obj.Week)) obj._week = obj.Week.replace(/\s+/g, " ").trim();
    // Only count rows that have BOTH a name and a CA assigned
    if (obj.Name && obj.CA && obj.Name !== "Name") {
      obj.CA = normalizeCA(obj.CA);
      intakes.push(obj);
    }
  }
  return intakes;
}

async function loadAllIntakes() {
  const all = [];
  const errors = [];
  for (const [clinic, tab] of Object.entries(INTAKE_TABS)) {
    try {
      const csv = await fetchSheetCSV(DOORPLANNEN_SHEET, tab);
      const items = parseIntakesCSV(csv, clinic);
      all.push(...items);
    } catch (e) {
      errors.push(`${clinic}: ${e.message}`);
    }
  }
  return { intakes: all, errors };
}

// ---------- Per-CA stats ----------
function computeCAStats(intakes) {
  const stats = {};
  for (const i of intakes) {
    const name = i.CA;
    if (!name) continue;
    if (!stats[name]) {
      stats[name] = {
        name, intakes: 0, packages: 0, totalAppts: 0,
        doorplannen: 0, meta: 0, byClinic: {},
      };
    }
    const s = stats[name];
    s.intakes++;
    const apts = parseInt(i.Appointments, 10);
    const aptsNum = isNaN(apts) ? 0 : apts;
    s.totalAppts += aptsNum;
    if (aptsNum >= 3) s.doorplannen++;
    if ((i.Package || "").toLowerCase() === "yes") s.packages++;
    if ((i.Meta || "").toLowerCase() === "yes") s.meta++;
    const cl = i._clinic || "Unknown";
    if (!s.byClinic[cl]) s.byClinic[cl] = { intakes: 0, packages: 0, doorplannen: 0, meta: 0, totalAppts: 0 };
    s.byClinic[cl].intakes++;
    s.byClinic[cl].totalAppts += aptsNum;
    if (aptsNum >= 3) s.byClinic[cl].doorplannen++;
    if ((i.Package || "").toLowerCase() === "yes") s.byClinic[cl].packages++;
    if ((i.Meta || "").toLowerCase() === "yes") s.byClinic[cl].meta++;
  }
  // Compute percentages
  for (const name in stats) {
    const s = stats[name];
    s.doorplannenPct = s.intakes ? (s.doorplannen / s.intakes) * 100 : 0;
    s.packagePct    = s.intakes ? (s.packages / s.intakes) * 100 : 0;
    s.metaPct       = s.intakes ? (s.meta / s.intakes) * 100 : 0;
    s.avgAppts      = s.intakes ? s.totalAppts / s.intakes : 0;
  }
  return stats;
}

// ---------- CA coaching voice ----------
const CA_VOICE = `
You are writing as Alex Yu, owner of Posturefixx, sending a short WhatsApp coaching note to a Clinic Assistant. Tone: warm, direct, specific, like a manager who notices effort and cares about the person.
Structure: 1) acknowledge what they're doing 2) one concrete observation about their numbers 3) one specific suggestion they can act on this week.
Hard rules: maximum 4 sentences. No emojis. No motivational fluff. The CA's main job is converting intakes into care packages and getting patients to book the full first month (doorplannen = 3+ appointments at intake). They've already role-played the package script with Renata, so you can refer back to the script naturally.
`;

function caEvaluateSignals(s) {
  const out = [];
  if (s.doorplannenPct < 50 && s.intakes >= 3) {
    out.push({ w: 3, text: `Doorplannen at ${Math.round(s.doorplannenPct)}% — below the 50% target. Focus on confidently booking the full first month at intake.` });
  } else if (s.doorplannenPct >= 70) {
    out.push({ w: 0, text: `Strong doorplannen at ${Math.round(s.doorplannenPct)}% — keep that energy.` });
  }
  if (s.packagePct < 30 && s.intakes >= 3) {
    out.push({ w: 2, text: `Package conversion is ${Math.round(s.packagePct)}%. The package script you role-played with Renata is the right tool here — walk through the value plan, then offer the package as the natural next step.` });
  }
  if (s.avgAppts < 3 && s.intakes >= 3) {
    out.push({ w: 1, text: `Average visits per intake is ${s.avgAppts.toFixed(1)}. Try the "send the schedule when they book a lot of appointments" reminder Samantha flagged in the team meeting.` });
  }
  if (s.intakes < 3) {
    out.push({ w: 1, text: `Only ${s.intakes} intake${s.intakes === 1 ? "" : "s"} in this period — not enough to draw conclusions yet. Stay consistent with the script.` });
  }
  out.sort((a, b) => b.w - a.w);
  return out.slice(0, 2);
}

async function draftCACoaching(name, s) {
  const signals = caEvaluateSignals(s);
  const clinicLines = Object.entries(s.byClinic)
    .map(([cl, d]) => `  ${cl}: ${d.intakes} intakes, ${d.doorplannen} doorplannen, ${d.packages} packages`)
    .join("\n");
  const prompt = `Coach ${name} based on this performance period:
- Total intakes: ${s.intakes}
- Doorplannen (3+ appts at intake): ${s.doorplannen} of ${s.intakes} = ${Math.round(s.doorplannenPct)}%
- Package conversion: ${s.packages} of ${s.intakes} = ${Math.round(s.packagePct)}%
- Average appointments: ${s.avgAppts.toFixed(1)}
- Meta source rate: ${Math.round(s.metaPct)}%
Per clinic:
${clinicLines}

What to address (most important first):
${signals.map(x => "- " + x.text).join("\n")}

Write one WhatsApp message to ${name} in Alex's voice (max 4 sentences).`;
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: CA_VOICE,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content.map(c => c.text || "").join("").trim();
}

// ---------- Routes ----------
app.get("/ca/data", gate, async (_req, res) => {
  try {
    const { intakes, errors } = await loadAllIntakes();
    const stats = computeCAStats(intakes);
    const ordered = Object.values(stats).sort((a, b) => b.intakes - a.intakes);
    res.json({ ok: true, totalIntakes: intakes.length, perCA: ordered, errors });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/ca", gate, async (_req, res) => {
  let data;
  try {
    const { intakes, errors } = await loadAllIntakes();
    const slim = intakes
      .filter(i => i.Name)
      .map(i => ({
        name: i.Name, ca: i.CA || "—", clinic: i._clinic || "—",
        week: i._week || "Unlabelled", chiro: i.Chiro || "—",
        appts: parseInt(i.Appointments, 10) || 0,
        package: (i.Package || "").toLowerCase() === "yes",
        meta: (i.Meta || "").toLowerCase() === "yes",
      }));
    data = {
      ok: true,
      totalIntakes: slim.length,
      intakes: slim,
      roster: CAS.map(c => c.name),
      errors,
    };
  } catch (e) {
    data = { ok: false, error: e.message, perCA: [], totalIntakes: 0, errors: [] };
  }
  res.send(renderCAPage(data));
});

app.get("/ca/coach", gate, async (req, res) => {
  const target = req.query.target;
  if (!target) return res.status(400).send("Add ?target=Csabi (or any CA name)");
  try {
    const { intakes } = await loadAllIntakes();
    const stats = computeCAStats(intakes);
    const s = stats[target];
    if (!s) return res.status(404).send(`No intake data found for "${target}"`);
    const draft = await draftCACoaching(target, s);
    const phone = caPhone(target);
    res.send(renderCACoachPage(target, s, draft, phone));
  } catch (e) {
    res.status(500).send("Error: " + e.message);
  }
});

app.post("/ca/coach/send", gate, async (req, res) => {
  try {
    const { target, text } = req.body || {};
    if (!target || !text) return res.status(400).json({ ok: false, error: "Missing target or text" });
    const phone = caPhone(target);
    if (!phone) return res.status(400).json({ ok: false, error: `No phone configured for ${target}. Set ${CAS.find(c => c.name === target)?.phoneVar || ""} in Render.` });
    // Send via the Rotterdam GHL sub-account (same path the chiro coach uses)
    const result = await sendSms("Rotterdam", phone, target, text);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- HTML rendering ----------
function pctBar(pct, color) {
  const w = Math.max(0, Math.min(100, pct));
  return `<div style="background:#eee;border-radius:6px;overflow:hidden;height:8px;width:120px;display:inline-block;vertical-align:middle"><div style="background:${color};height:100%;width:${w}%"></div></div>`;
}

function caClinicLabel(c){return c;}
// ── PATIENT-LEVEL CORRELATION (PracticeHub ⇄ doorplannen sheet) ──────────────
function normName(s){
  return String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z\s]/g," ").replace(/\s+/g," ").trim();
}
// tokens for a looser match (handles word-order / middle names / typos in one token)
function nameTokens(s){ return normName(s).split(" ").filter(Boolean); }
function namesMatch(a,b){
  var na=normName(a), nb=normName(b);
  if(!na||!nb) return false;
  if(na===nb) return true;
  var ta=nameTokens(a), tb=nameTokens(b);
  if(ta.length<1||tb.length<1) return false;
  // match if first+last token both shared, or all of the shorter set is contained
  var setA={}; ta.forEach(function(t){setA[t]=1;});
  var shared=tb.filter(function(t){return setA[t];}).length;
  var need=Math.min(ta.length,tb.length);
  return shared>=Math.min(2,need) && shared>=need-1;
}

// Pull per-patient records from one clinic's PracticeHub.
async function phubPatientRecords(clinic, months){
  var types = await phubAll(clinic, "/appointment_types", {}).catch(function(){return [];});
  var intakeIds = new Set(); var excluded = new Set();
  for(var i=0;i<types.length;i++){var t=types[i]; if(isIntake(t.name||"")) intakeIds.add(t.id); if(notAVisit(t.name||"")) excluded.add(t.id);}
  var appts = await phubAll(clinic, "/appointments", { start: monthsAgoRange(months) });
  var patients = await phubAll(clinic, "/patients", {}).catch(function(){return [];});
  var pname = {};
  for(var j=0;j<patients.length;j++){var p=patients[j];
    pname[p.id] = ((p.first_name||"")+" "+(p.last_name||"")).trim() || p.name || p.full_name || p.fullName || ("#"+p.id);}
  var per = {};
  for(var k=0;k<appts.length;k++){
    var a=appts[k]; var pid=a.patient_id; if(pid==null) continue;
    if(!per[pid]) per[pid]={patientId:pid, name:pname[pid]||("#"+pid), clinic:clinic, booked:0, serviced:0, intakeDate:null, earliest:null, practitionerId:a.practitioner_id};
    var rec=per[pid];
    var cancelled = a.status==="cancelled" || a.cancelDate;
    if(!cancelled){ rec.booked++; if(a.status==="processed" && !excluded.has(a.appointment_type_id)) rec.serviced++; }
    var d=(a.start||"").slice(0,10);
    if(d){
      if(intakeIds.has(a.appointment_type_id)){ if(!rec.intakeDate || d<rec.intakeDate) rec.intakeDate=d; }
      if(!rec.earliest || d<rec.earliest) rec.earliest=d;
    }
  }
  return Object.keys(per).map(function(id){var r=per[id]; if(!r.intakeDate) r.intakeDate=r.earliest; return r;});
}

// Pure correlation engine — testable without any network.
function correlate(sheetIntakes, phubByClinic){
  var phubAll_=[];
  Object.keys(phubByClinic).forEach(function(cl){ (phubByClinic[cl]||[]).forEach(function(r){ phubAll_.push(Object.assign({clinic:cl}, r)); }); });
  // group PHub patients by normalized name → detect cross-location
  var byKey={};
  phubAll_.forEach(function(r){ var k=normName(r.name); if(!k)return; (byKey[k]=byKey[k]||[]).push(r); });
  var multi = Object.keys(byKey).map(function(k){
    var recs=byKey[k]; var clinics=Array.from(new Set(recs.map(function(r){return r.clinic;})));
    return { name:recs[0].name, clinics:clinics, recs:recs,
      totalBooked:recs.reduce(function(a,r){return a+(r.booked||0);},0),
      totalServiced:recs.reduce(function(a,r){return a+(r.serviced||0);},0),
      intakeDate:recs.map(function(r){return r.intakeDate;}).filter(Boolean).sort()[0]||null };
  }).filter(function(x){return x.clinics.length>1;});

  // reconcile each sheet intake against PHub
  var reconciled = sheetIntakes.map(function(si){
    var matches = phubAll_.filter(function(r){ return namesMatch(r.name, si.name); });
    var clinics = Array.from(new Set(matches.map(function(m){return m.clinic;})));
    return {
      name:si.name, ca:si.ca, clinic:si.clinic, week:si.week, sheetAppts:si.appts,
      found: matches.length>0,
      phubBooked: matches.reduce(function(a,m){return a+(m.booked||0);},0),
      phubServiced: matches.reduce(function(a,m){return a+(m.serviced||0);},0),
      intakeDate: matches.map(function(m){return m.intakeDate;}).filter(Boolean).sort()[0]||null,
      matchClinics: clinics, multiLocation: clinics.length>1,
      phubName: matches.length && normName(matches[0].name)!==normName(si.name) ? matches[0].name : null
    };
  });

  // PHub patients with no sheet row (missing intakes the other direction)
  var missingInSheet = Object.keys(byKey).filter(function(k){
    return !sheetIntakes.some(function(si){ return namesMatch(si.name, byKey[k][0].name); });
  }).map(function(k){
    var recs=byKey[k]; var clinics=Array.from(new Set(recs.map(function(r){return r.clinic;})));
    return { name:recs[0].name, clinics:clinics,
      booked:recs.reduce(function(a,r){return a+(r.booked||0);},0),
      serviced:recs.reduce(function(a,r){return a+(r.serviced||0);},0),
      intakeDate:recs.map(function(r){return r.intakeDate;}).filter(Boolean).sort()[0]||null };
  });

  return { reconciled:reconciled, multi:multi, missingInSheet:missingInSheet };
}

function reconcileDemo(){
  return {
    Amstelveen:[
      {name:"Vincent Graafland",booked:5,serviced:3,intakeDate:"2026-05-15",practitionerId:1},
      {name:"Coen Nikken",booked:13,serviced:11,intakeDate:"2026-05-02",practitionerId:1},
      {name:"Albert Poutsma",booked:6,serviced:6,intakeDate:"2026-05-20",practitionerId:2}],
    Utrecht:[
      {name:"Vincent Graafland",booked:2,serviced:2,intakeDate:"2026-06-01",practitionerId:3},
      {name:"Marcel Schmeets",booked:7,serviced:5,intakeDate:"2026-05-28",practitionerId:3}],
    Rotterdam:[
      {name:"Jeff Fortuin",booked:7,serviced:6,intakeDate:"2026-05-10",practitionerId:4},
      {name:"Sandra Nieuwenhuis",booked:4,serviced:4,intakeDate:"2026-05-18",practitionerId:4}]
  };
}
function reconcileDemoSheet(){
  return [
    {name:"Vincent Graafland",ca:"Anne",clinic:"Amstelveen",week:"Week 20",appts:3},
    {name:"Coen Nikken",ca:"Vivian",clinic:"Amstelveen",week:"Week 19",appts:13},
    {name:"Albert Poutsma",ca:"Archana",clinic:"Amstelveen",week:"Week 21",appts:6},
    {name:"Marcel Schmeets",ca:"Anne",clinic:"Utrecht",week:"Week 22",appts:7},
    {name:"Jeff Fortuin",ca:"Renata",clinic:"Rotterdam",week:"Week 20",appts:7},
    {name:"Tahir Chotkan",ca:"Anne",clinic:"Rotterdam",week:"Week 23",appts:0}
  ];
}

app.get("/reconcile", gate, async (req, res) => {
  var months = Math.max(1, Math.min(24, parseInt(req.query.months,10) || 3));
  var demo = req.query.demo === "1";
  try {
    var sheetIntakes, phubByClinic, errors = [];
    if (demo) {
      phubByClinic = reconcileDemo();
      sheetIntakes = reconcileDemoSheet();
    } else {
      var loaded = await loadAllIntakes();
      errors = loaded.errors || [];
      sheetIntakes = loaded.intakes.filter(i=>i.Name).map(i=>({name:i.Name, ca:i.CA||"—", clinic:i._clinic||"—", week:i._week||"Unlabelled", appts:parseInt(i.Appointments,10)||0}));
      phubByClinic = {};
      for (const clinic of Object.keys(CLINICS)) {
        try { phubByClinic[clinic] = await phubPatientRecords(clinic, months); }
        catch (e) { errors.push(clinic + ": " + e.message); phubByClinic[clinic] = []; }
      }
    }
    var result = correlate(sheetIntakes, phubByClinic);
    res.send(renderReconcile(result, { months, demo, errors, totalSheet: sheetIntakes.length }));
  } catch (e) {
    res.status(500).send("Reconcile error: " + e.message);
  }
});

function renderReconcile(result, meta){
  var R=result.reconciled, M=result.multi, MIS=result.missingInSheet;
  var matched=R.filter(function(r){return r.found;});
  var notFound=R.filter(function(r){return !r.found;});
  var multiCount=M.length;
  var totSheet=R.reduce(function(a,r){return a+(r.sheetAppts||0);},0);
  var totPhub=matched.reduce(function(a,r){return a+(r.phubServiced||0);},0);
  var chartData = matched.map(function(r){return {name:r.name, sheet:r.sheetAppts||0, phub:r.phubServiced||0, booked:r.phubBooked||0};});
  var errBlock=(meta.errors&&meta.errors.length)?("<div style='background:#fef3c7;padding:10px;border-radius:6px;margin:0 0 14px;font-size:12px;color:#92400e'>Some sources couldn\u2019t load: "+meta.errors.join(" \u00b7 ")+"</div>"):"";

  function dateCell(d){return d?("<span style='font-variant-numeric:tabular-nums'>"+d+"</span>"):"<span style='color:#bbb'>\u2014</span>";}
  function cmp(sheet,phub){
    var diff=phub-sheet; var col=diff===0?"#16a34a":(diff>0?"#2563eb":"#dc2626");
    return "<span style='color:"+col+";font-size:11px'>"+(diff>0?"+":"")+diff+"</span>";
  }
  var multiRows=M.map(function(m){
    var per=m.recs.map(function(r){return r.clinic+": "+(r.serviced||0)+"/"+(r.booked||0);}).join(" \u00b7 ");
    var ca="\u2014"; for(var i=0;i<R.length;i++){ if(R[i].found && normName(R[i].name)===normName(m.name)){ ca=R[i].ca; break; } }
    return "<tr><td style='font-weight:600'>"+m.name+" <span class='pill multi'>multi-location</span></td>"
      +"<td>"+m.clinics.join(", ")+"</td><td style='font-size:12px;color:#555'>"+per+"</td>"
      +"<td style='text-align:right'>"+m.totalServiced+"/"+m.totalBooked+"</td><td>"+dateCell(m.intakeDate)+"</td><td>"+ca+"</td></tr>";
  }).join("");
  var rows=R.slice().sort(function(a,b){return (b.found?1:0)-(a.found?1:0) || (b.multiLocation?1:0)-(a.multiLocation?1:0);}).map(function(r){
    var status = !r.found ? "<span class='pill bad'>not in PracticeHub</span>"
      : (r.multiLocation ? "<span class='pill multi'>multi-location</span>" : "<span class='pill ok'>matched</span>");
    var nmeNote = r.phubName ? (" <span style='color:#888;font-size:11px'>(PH: "+r.phubName+")</span>") : "";
    return "<tr"+(r.multiLocation?" style='background:#fff7ed'":(!r.found?" style='background:#fef2f2'":""))+">"
      +"<td style='font-weight:600'>"+r.name+nmeNote+"</td>"
      +"<td>"+r.ca+"</td><td>"+r.clinic+(r.matchClinics&&r.matchClinics.length?" <span style='color:#888;font-size:11px'>\u2192 "+r.matchClinics.join(", ")+"</span>":"")+"</td>"
      +"<td>"+dateCell(r.intakeDate)+"</td>"
      +"<td style='text-align:right'>"+(r.sheetAppts||0)+"</td>"
      +"<td style='text-align:right'>"+(r.found?(r.phubServiced+"/"+r.phubBooked):"\u2014")+" "+(r.found?cmp(r.sheetAppts||0,r.phubServiced||0):"")+"</td>"
      +"<td>"+status+"</td></tr>";
  }).join("");
  var misRows=MIS.map(function(m){
    return "<tr><td style='font-weight:600'>"+m.name+"</td><td>"+m.clinics.join(", ")+"</td><td>"+dateCell(m.intakeDate)+"</td><td style='text-align:right'>"+m.serviced+"/"+m.booked+"</td></tr>";
  }).join("");

  var css="body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:1180px;margin:24px auto;padding:0 16px;color:#16202E}"
   +"h1{margin:0 0 4px;font-size:22px}h2{font-size:16px;margin:26px 0 4px}.sub{color:#666;font-size:13px;margin-bottom:16px}"
   +".stat-row{display:flex;gap:14px;margin:14px 0 6px;flex-wrap:wrap}.stat{background:#f8fafc;padding:13px 17px;border-radius:10px;min-width:120px}"
   +".stat-val{font-size:23px;font-weight:700}.stat-lbl{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.5px}"
   +"table{border-collapse:collapse;width:100%;font-size:13.5px;margin-top:8px}th{text-align:left;padding:9px 8px;border-bottom:2px solid #e5e7eb;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#555}"
   +"td{padding:9px 8px;border-bottom:1px solid #f1f5f9;vertical-align:middle}"
   +".pill{display:inline-block;font-size:10px;padding:1px 8px;border-radius:999px;vertical-align:middle}"
   +".pill.ok{background:#ecfdf5;color:#16a34a}.pill.multi{background:#fff7ed;color:#c2410c}.pill.bad{background:#fef2f2;color:#dc2626}"
   +".controls{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px}.controls label{font-size:11px;color:#666;display:block;margin-bottom:3px}"
   +"input{padding:7px 9px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;width:80px}.btn{background:#2563eb;color:#fff;border:none;padding:9px 16px;border-radius:8px;font-size:14px;cursor:pointer;text-decoration:none}"
   +".note{background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 14px;font-size:12.5px;color:#1e40af;margin:14px 0}";

  return "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
   +"<title>Reconcile \u2014 PracticeHub \u22c4 sheet</title><script src='https://cdn.jsdelivr.net/npm/chart.js@4'></script>"
   +"<style>"+css+"</style></head><body>"
   +"<h1>Patient reconciliation</h1>"
   +"<div class='sub'>Every intake from the sheet matched by name to PracticeHub \u2014 cross-location patients flagged, intake dates pulled, and appointments compared (PracticeHub vs sheet)."+(meta.demo?" <b>Demo data.</b>":"")+"</div>"
   +errBlock
   +"<div class='controls'>"
   +"<form method='get' action='/reconcile' style='display:flex;gap:10px;align-items:flex-end'>"
   +"<div><label>Months back</label><input type='number' name='months' value='"+meta.months+"' min='1' max='24'></div>"
   +"<button class='btn' type='submit'>Pull from PracticeHub</button></form>"
   +"<a class='btn' style='background:#64748b' href='/reconcile?demo=1'>Demo</a>"
   +"</div>"
   +"<div class='note'>This page reads patient names from PracticeHub (<code>/patients</code>) to match across the four separate clinic accounts and against the sheet. Name matches are best-effort (accents, word order, one-token typos handled) \u2014 rows where the PracticeHub name differs show it as <i>(PH: \u2026)</i> so you can eyeball it.</div>"
   +"<div class='stat-row'>"
   +"<div class='stat'><div class='stat-val'>"+meta.totalSheet+"</div><div class='stat-lbl'>Sheet intakes</div></div>"
   +"<div class='stat'><div class='stat-val'>"+matched.length+"</div><div class='stat-lbl'>Matched in PH</div></div>"
   +"<div class='stat'><div class='stat-val'>"+notFound.length+"</div><div class='stat-lbl'>Not in PH</div></div>"
   +"<div class='stat'><div class='stat-val'>"+multiCount+"</div><div class='stat-lbl'>Multi-location</div></div>"
   +"<div class='stat'><div class='stat-val'>"+totPhub+" / "+totSheet+"</div><div class='stat-lbl'>PH serviced / sheet appts</div></div>"
   +"</div>"
   +"<h2>PracticeHub vs sheet \u2014 appointments per patient</h2><div class='sub'>One line for PracticeHub (serviced), one for the sheet. Gaps show where the sheet and the system disagree.</div>"
   +"<div style='height:340px'><canvas id='cmp'></canvas></div>"
   +(M.length?("<h2>Cross-location patients \u2014 special</h2><div class='sub'>Same person booked at more than one clinic. Serviced/booked shown per location, with the CA who took the intake.</div>"
      +"<table><thead><tr><th>Patient</th><th>Locations</th><th>Per location (serviced/booked)</th><th style='text-align:right'>Total</th><th>Intake date</th><th>CA</th></tr></thead><tbody>"+multiRows+"</tbody></table>"):"")
   +"<h2>All sheet intakes \u00d7 PracticeHub</h2><div class='sub'>Intake date is the date of the intake appointment in PracticeHub. Appts column = PracticeHub serviced/booked, with the difference vs the sheet.</div>"
   +"<table><thead><tr><th>Patient</th><th>CA</th><th>Sheet clinic</th><th>Intake date</th><th style='text-align:right'>Sheet appts</th><th style='text-align:right'>PH serv/booked</th><th>Status</th></tr></thead><tbody>"+(rows||"<tr><td colspan='7' style='text-align:center;padding:30px;color:#888'>No intakes</td></tr>")+"</tbody></table>"
   +(MIS.length?("<h2>In PracticeHub, not in the sheet ("+MIS.length+")</h2><div class='sub'>Patients with appointments in PracticeHub whose intake isn\u2019t logged on the sheet \u2014 the missing intakes.</div>"
      +"<table><thead><tr><th>Patient</th><th>Clinic(s)</th><th>Intake date</th><th style='text-align:right'>Serviced/booked</th></tr></thead><tbody>"+misRows+"</tbody></table>"):"")
   +"<div style='margin-top:24px;font-size:12px;color:#888'>Pages: <a href='/ca'>/ca</a> \u00b7 <a href='/plan'>/plan</a> \u00b7 <a href='/'>home</a></div>"
   +"<script>var CD="+JSON.stringify(chartData)+";"
   +"(function(){if(typeof Chart==='undefined'||!CD.length)return;"
   +"new Chart(document.getElementById('cmp'),{type:'line',data:{labels:CD.map(function(d){return d.name;}),"
   +"datasets:[{label:'PracticeHub (serviced)',data:CD.map(function(d){return d.phub;}),borderColor:'#2563eb',backgroundColor:'#2563eb',tension:.2},"
   +"{label:'Sheet (appointments)',data:CD.map(function(d){return d.sheet;}),borderColor:'#16a34a',backgroundColor:'#16a34a',tension:.2}]},"
   +"options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top'}},scales:{y:{beginAtZero:true,title:{display:true,text:'appointments'}}}}});})();</script>"
   +"</body></html>";
}

function renderCAPage(data){
  var payload = {
    intakes: data.intakes||[],
    roster: data.roster||[],
    clinics: ["Amstelveen","Bussum","Rotterdam","Utrecht"],
    phones: (data.roster||[]).reduce(function(o,n){o[n]=!!caPhone(n);return o;},{})
  };
  var errBlock = (data.errors && data.errors.length) ? ("<div style='background:#fef3c7;padding:10px;border-radius:6px;margin-bottom:14px;font-size:12px;color:#92400e'>Some sheets could not load: "+data.errors.join(" \u00b7 ")+"</div>") : "";
  var CA_CSS = "body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:1200px;margin:24px auto;padding:0 16px;color:#16202E}"
    + "h1{margin:0 0 4px;font-size:22px}.sub{color:#666;font-size:13px;margin-bottom:14px}"
    + ".legend{display:flex;gap:16px;flex-wrap:wrap;background:#f8fafc;border:1px solid #eef2f7;border-radius:10px;padding:11px 14px;margin-bottom:16px;font-size:12px;color:#475569}"
    + ".legend b{color:#16202E}"
    + ".filterlabel{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;margin:0 4px 6px 2px}"
    + ".filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}"
    + ".fbtn{border:1px solid #d1d5db;background:#fff;color:#334155;padding:7px 13px;border-radius:999px;font-size:13px;cursor:pointer}"
    + ".fbtn.on{background:#16202E;color:#fff;border-color:#16202E}"
    + ".stat-row{display:flex;gap:14px;margin-bottom:16px;flex-wrap:wrap}.stat{background:#f8fafc;padding:14px 18px;border-radius:10px;min-width:120px}"
    + ".stat-val{font-size:24px;font-weight:700}.stat-lbl{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.5px}"
    + "table{border-collapse:collapse;width:100%;font-size:14px}th{text-align:left;padding:10px 8px;border-bottom:2px solid #e5e7eb;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:#555}"
    + "td{padding:10px 8px;border-bottom:1px solid #f1f5f9;vertical-align:middle}"
    + ".barwrap{background:#eee;border-radius:6px;overflow:hidden;height:8px;width:120px;display:inline-block;vertical-align:middle}.barfill{height:100%}"
    + ".muted{color:#9aa3af}.coachbtn{background:#16202E;color:#fff;padding:6px 10px;border-radius:6px;text-decoration:none;font-size:12px}"
    + ".sec{margin-top:30px}.sec h2{font-size:16px;margin:0 0 4px}.sec .sub{margin-bottom:12px}"
    + ".pill{display:inline-block;font-size:10px;padding:1px 7px;border-radius:999px;margin-left:5px;vertical-align:middle}"
    + ".pill.meta{background:#eff6ff;color:#2563eb}.pill.pkg{background:#ecfdf5;color:#16a34a}"
    + ".twocol{display:flex;gap:22px;flex-wrap:wrap}.twocol>div{flex:1;min-width:320px}"
    + ".hint{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 14px;font-size:12.5px;color:#92400e;margin-bottom:16px}";
  return "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
    + "<title>CA Performance \u2014 Posturefixx</title>"
    + "<script src='https://cdn.jsdelivr.net/npm/chart.js@4'></script>"
    + "<style>"+CA_CSS+"</style></head><body>"
    + "<h1>CA Performance</h1><div class='sub'>From the \u201cimplementing the new script\u201d doorplannen sheet. Filter by clinic and week; switch table / chart.</div>"
    + errBlock
    + "<div class='legend'>"
    + "<span><b>Doorplannen %</b> \u2014 share of this CA\u2019s intakes that booked <b>3+ appointments</b> (planned the full first month)</span>"
    + "<span><b>Package %</b> \u2014 share of intakes that <b>took a care package</b></span>"
    + "<span><b>Meta %</b> \u2014 share of intakes whose <b>lead came from Meta/Facebook ads</b> (lead-source mix, not a performance score)</span>"
    + "<span><b>Avg appts</b> \u2014 average appointments booked per intake</span>"
    + "</div>"
    + "<div id='weekhint'></div>"
    + "<div class='filterlabel'>Clinic</div><div id='filters' class='filters'></div>"
    + "<div class='filterlabel'>Week</div><div id='weekfilters' class='filters'></div>"
    + "<div id='cards' class='stat-row'></div>"
    + "<div id='viewtoggle' class='filters'></div>"
    + "<div id='main'></div>"
    + "<div id='lists' class='sec'></div>"
    + "<div style='margin-top:24px;font-size:12px;color:#888'>Tip: open <a href='/plan'>/plan</a> for the chiropractor dashboard · <a href='/reconcile'>/reconcile</a> to match these intakes against PracticeHub (cross-location patients, intake dates, appts vs sheet).</div>"
    + "<script>var DATA="+JSON.stringify(payload)+";("+caClient.toString()+")();</script>"
    + "</body></html>";
}
function caClient(){
  var SEL={clinic:'all',week:'all',view:'table',chart:'bar'};
  var CHART=null;
  function $(id){return document.getElementById(id);}
  function weekNum(w){var m=(w||'').match(/\d+/);return m?parseInt(m[0],10):9999;}
  function allWeeks(){
    var w={}; DATA.intakes.forEach(function(i){w[i.week]=1;});
    var arr=Object.keys(w);
    arr.sort(function(a,b){return weekNum(a)-weekNum(b);});
    return arr;
  }
  function filtered(){
    return DATA.intakes.filter(function(i){
      return (SEL.clinic==='all'||i.clinic===SEL.clinic)&&(SEL.week==='all'||i.week===SEL.week);
    });
  }
  function statsRows(){
    var items=filtered();
    var map={}; DATA.roster.forEach(function(n){map[n]={name:n,intakes:0,door:0,pkg:0,meta:0,appts:0,byClinic:{}};});
    items.forEach(function(i){
      var m=map[i.ca]; if(!m){m=map[i.ca]={name:i.ca,intakes:0,door:0,pkg:0,meta:0,appts:0,byClinic:{}};}
      m.intakes++; m.appts+=i.appts; if(i.appts>=3)m.door++; if(i.package)m.pkg++; if(i.meta)m.meta++;
      if(!m.byClinic[i.clinic])m.byClinic[i.clinic]=0; m.byClinic[i.clinic]++;
    });
    var out=Object.keys(map).map(function(n){var m=map[n];return {name:n,intakes:m.intakes,door:m.door,pkg:m.pkg,meta:m.meta,appts:m.appts,byClinic:m.byClinic,
      doorPct:m.intakes?m.door/m.intakes*100:0,pkgPct:m.intakes?m.pkg/m.intakes*100:0,metaPct:m.intakes?m.meta/m.intakes*100:0,avgAppts:m.intakes?m.appts/m.intakes:0};});
    out.sort(function(a,b){return b.intakes-a.intakes;});
    return out;
  }
  function bar(pct,color){var w=Math.max(0,Math.min(100,pct));return "<div class='barwrap'><div class='barfill' style='width:"+w+"%;background:"+color+"'></div></div>";}
  function renderWeekHint(){
    var ws=allWeeks();
    if(ws.length===1&&ws[0]==='Unlabelled'){
      $('weekhint').innerHTML="<div class='hint'>No weekly split yet \u2014 to get a per-week view, put a <b>\u201cWeek 24\u201d</b> row directly above that week\u2019s intakes in the sheet (same as your Week 23\u201326 layout). Everything below it is then tagged to that week automatically.</div>";
    } else { $('weekhint').innerHTML=""; }
  }
  function renderFilters(){
    var opts=[['all','All clinics']].concat(DATA.clinics.map(function(c){return [c,c];}));
    $('filters').innerHTML=opts.map(function(o){return "<button class='fbtn"+(SEL.clinic===o[0]?' on':'')+"' data-clinic='"+o[0]+"'>"+o[1]+"</button>";}).join('');
    Array.prototype.forEach.call($('filters').querySelectorAll('button'),function(b){b.addEventListener('click',function(){SEL.clinic=b.getAttribute('data-clinic');render();});});
    var ws=allWeeks();
    var wopts=[['all','All weeks']].concat(ws.map(function(w){return [w,w];}));
    $('weekfilters').innerHTML=wopts.map(function(o){return "<button class='fbtn"+(SEL.week===o[0]?' on':'')+"' data-week='"+o[0]+"'>"+o[1]+"</button>";}).join('');
    Array.prototype.forEach.call($('weekfilters').querySelectorAll('button'),function(b){b.addEventListener('click',function(){SEL.week=b.getAttribute('data-week');render();});});
  }
  function renderCards(){
    var rows=statsRows(); var intk=0,door=0,pkg=0;
    rows.forEach(function(r){intk+=r.intakes;door+=r.door;pkg+=r.pkg;});
    var dP=intk?Math.round(door/intk*100):0, pP=intk?Math.round(pkg/intk*100):0;
    var notP=intk-door;
    $('cards').innerHTML=
      "<div class='stat'><div class='stat-val'>"+intk+"</div><div class='stat-lbl'>Intakes seen</div></div>"
     +"<div class='stat'><div class='stat-val'>"+door+"</div><div class='stat-lbl'>Planned through</div></div>"
     +"<div class='stat'><div class='stat-val'>"+notP+"</div><div class='stat-lbl'>Not planned through</div></div>"
     +"<div class='stat'><div class='stat-val'>"+dP+"%</div><div class='stat-lbl'>Avg doorplannen</div></div>"
     +"<div class='stat'><div class='stat-val'>"+pP+"%</div><div class='stat-lbl'>Avg package</div></div>";
  }
  function renderViewToggle(){
    var h="<button class='fbtn"+(SEL.view==='table'?' on':'')+"' data-v='table'>Table</button>"
         +"<button class='fbtn"+(SEL.view==='chart'?' on':'')+"' data-v='chart'>Chart</button>";
    if(SEL.view==='chart'){
      h+="<span style='width:14px'></span>"
       +"<button class='fbtn"+(SEL.chart==='bar'?' on':'')+"' data-c='bar'>Bar</button>"
       +"<button class='fbtn"+(SEL.chart==='line'?' on':'')+"' data-c='line'>Line</button>";
    }
    $('viewtoggle').innerHTML=h;
    Array.prototype.forEach.call($('viewtoggle').querySelectorAll('[data-v]'),function(b){b.addEventListener('click',function(){SEL.view=b.getAttribute('data-v');render();});});
    Array.prototype.forEach.call($('viewtoggle').querySelectorAll('[data-c]'),function(b){b.addEventListener('click',function(){SEL.chart=b.getAttribute('data-c');render();});});
  }
  function renderTable(){
    var rows=statsRows();
    var body=rows.map(function(r){
      var zero=r.intakes===0;
      var clinicBreak=SEL.clinic==='all'?Object.keys(r.byClinic).map(function(cl){return cl+': '+r.byClinic[cl];}).join(' \u00b7 '):'';
      var noPhone=DATA.phones[r.name]===false?" <span style='color:#c00;font-size:11px'>(no phone)</span>":"";
      return "<tr"+(zero?" class='muted'":"")+">"
        +"<td style='font-weight:600'>"+r.name+noPhone+"</td>"
        +"<td style='text-align:right'>"+r.intakes+"</td>"
        +"<td style='text-align:right'>"+r.door+"</td>"
        +"<td style='text-align:right'>"+(r.intakes-r.door)+"</td>"
        +"<td>"+bar(r.doorPct,'#2563eb')+" <span style='margin-left:6px'>"+Math.round(r.doorPct)+"%</span></td>"
        +"<td>"+bar(r.pkgPct,'#16a34a')+" <span style='margin-left:6px'>"+Math.round(r.pkgPct)+"%</span> <span style='color:#888;font-size:11px'>("+r.pkg+"/"+r.intakes+")</span></td>"
        +"<td style='text-align:right'>"+r.avgAppts.toFixed(1)+"</td>"
        +"<td style='text-align:right'>"+Math.round(r.metaPct)+"%</td>"
        +"<td style='font-size:12px;color:#555'>"+clinicBreak+"</td>"
        +"<td><a class='coachbtn' href='/ca/coach?target="+encodeURIComponent(r.name)+"'>Coach</a></td></tr>";
    }).join('');
    $('main').innerHTML="<table><thead><tr><th>CA</th><th style='text-align:right'>Intakes</th><th style='text-align:right'>Planned</th><th style='text-align:right'>Not</th><th>Doorplannen %</th><th>Package %</th><th style='text-align:right'>Avg appts</th><th style='text-align:right'>Meta %</th><th>By clinic</th><th></th></tr></thead><tbody>"+(body||"<tr><td colspan='10' style='text-align:center;padding:40px;color:#888'>No intake data</td></tr>")+"</tbody></table>";
  }
  function renderChart(){
    $('main').innerHTML="<div style='height:380px'><canvas id='cachart'></canvas></div>";
    var rows=statsRows().filter(function(r){return r.intakes>0;});
    var labels=rows.map(function(r){return r.name;});
    var ds=[{label:'Doorplannen %',data:rows.map(function(r){return Math.round(r.doorPct);}),backgroundColor:'#2563eb',borderColor:'#2563eb'},
            {label:'Package %',data:rows.map(function(r){return Math.round(r.pkgPct);}),backgroundColor:'#16a34a',borderColor:'#16a34a'}];
    if(CHART){CHART.destroy();CHART=null;}
    if(typeof Chart==='undefined'){$('main').innerHTML+="<div style='color:#888;font-size:12px'>Chart library still loading\u2026 switch to Table.</div>";return;}
    CHART=new Chart(document.getElementById('cachart'),{type:SEL.chart,data:{labels:labels,datasets:ds},
      options:{responsive:true,maintainAspectRatio:false,scales:{y:{beginAtZero:true,max:100,ticks:{callback:function(v){return v+'%';}}}},plugins:{legend:{position:'top'}}}});
  }
  function clientRow(c){
    return "<tr><td style='font-weight:600'>"+c.name+(c.meta?"<span class='pill meta'>Meta</span>":"")+(c.package?"<span class='pill pkg'>package</span>":"")+"</td>"
      +"<td>"+c.ca+"</td><td>"+c.clinic+"</td><td>"+c.chiro+"</td><td style='text-align:right'>"+c.appts+"</td></tr>";
  }
  function listTable(items){
    items=items.slice().sort(function(a,b){return (a.ca+a.clinic).localeCompare(b.ca+b.clinic)|| a.appts-b.appts;});
    return "<table><thead><tr><th>Client</th><th>CA</th><th>Clinic</th><th>Chiro</th><th style='text-align:right'>Appts</th></tr></thead><tbody>"
      +(items.map(clientRow).join('')||"<tr><td colspan='5' style='text-align:center;padding:24px;color:#888'>None</td></tr>")+"</tbody></table>";
  }
  function renderLists(){
    var items=filtered();
    var planned=items.filter(function(i){return i.appts>=3;});
    var notp=items.filter(function(i){return i.appts<3;});
    var scope=(SEL.clinic==='all'?'All clinics':SEL.clinic)+(SEL.week==='all'?'':' \u00b7 '+SEL.week);
    $('lists').innerHTML=
      "<div class='twocol'>"
      +"<div><h2>Not planned through ("+notp.length+")</h2><div class='sub'>Fewer than 3 appointments \u2014 the follow-up list. "+scope+".</div>"+listTable(notp)+"</div>"
      +"<div><h2>Planned through ("+planned.length+")</h2><div class='sub'>3+ appointments booked. "+scope+".</div>"+listTable(planned)+"</div>"
      +"</div>";
  }
  function render(){renderWeekHint();renderFilters();renderCards();renderViewToggle();if(SEL.view==='chart')renderChart();else renderTable();renderLists();}
  render();
}

function renderCACoachPage(name, s, draft, phone) {
  const phoneBlock = phone
    ? `<div style="font-size:12px;color:#666;margin-bottom:8px">Will send to: <code>${phone}</code> via Rotterdam GHL sub-account</div>`
    : `<div style="background:#fee2e2;padding:10px;border-radius:6px;color:#991b1b;font-size:13px;margin-bottom:12px">No phone number configured for ${name}. Set <code>${CAS.find(c => c.name === name)?.phoneVar || ""}</code> in Render env vars before sending.</div>`;
  const safeName = name.replace(/'/g, "\\'");
  const safeDraft = draft.replace(/</g, "&lt;");
  return `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Coach ${name}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 760px; margin: 24px auto; padding: 0 16px; color: #16202E; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 20px; }
  .box { background: #f8fafc; padding: 14px 18px; border-radius: 10px; margin-bottom: 16px; }
  .num { display: inline-block; margin-right: 18px; font-size: 13px; }
  .num b { font-size: 18px; display: block; }
  textarea { width: 100%; min-height: 160px; font-family: inherit; font-size: 15px; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; box-sizing: border-box; }
  button { background: #16202E; color: #fff; border: 0; padding: 12px 24px; border-radius: 8px; font-size: 15px; cursor: pointer; margin-top: 8px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  a { color: #2563eb; }
</style></head><body>
<a href="/ca">← Back to CA dashboard</a>
<h1>Coach ${name}</h1>
<div class="sub">Drafted by Claude · Edit before sending</div>
<div class="box">
  <span class="num"><b>${s.intakes}</b>intakes</span>
  <span class="num"><b>${Math.round(s.doorplannenPct)}%</b>doorplannen</span>
  <span class="num"><b>${Math.round(s.packagePct)}%</b>package conv.</span>
  <span class="num"><b>${s.avgAppts.toFixed(1)}</b>avg appts</span>
</div>
${phoneBlock}
<textarea id="msg">${safeDraft}</textarea>
<button id="send" ${phone ? "" : "disabled"}>Send via WhatsApp/SMS</button>
<div id="result" style="margin-top:14px;font-size:13px"></div>
<script>
  document.getElementById('send').addEventListener('click', async () => {
    const btn = document.getElementById('send');
    const result = document.getElementById('result');
    btn.disabled = true; btn.textContent = 'Sending...';
    try {
      const r = await fetch('/ca/coach/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: '${safeName}', text: document.getElementById('msg').value }),
      });
      const j = await r.json();
      if (j.ok) {
        result.innerHTML = '<span style="color:#16a34a">✓ Sent to ${safeName}</span>';
        btn.textContent = 'Sent';
      } else {
        result.innerHTML = '<span style="color:#c00">Error: ' + (j.error || 'unknown') + '</span>';
        btn.disabled = false; btn.textContent = 'Try again';
      }
    } catch (e) {
      result.innerHTML = '<span style="color:#c00">Network error: ' + e.message + '</span>';
      btn.disabled = false; btn.textContent = 'Try again';
    }
  });
</script>
</body></html>`;
}



// ============================================================================
//  /pva — PVA & earnings dashboard (manager-gated). Added module.
// ============================================================================
// ── Config ──────────────────────────────────────────────────────────────────
const PVA_SHEET_2026 = "1_oZ1Y3IizjZdQ5MwPZm--WgbEyNQ0-JlNKEys_wbJJU"; // PVA + earnings
const PVA_SHEET_2025 = "1xRJ1vRT1GREkwDGuabo8w-Gquny0PY5rgxNaGZz7WmA"; // YoY (PVA only)

// gviz fetches ONE tab at a time, BY NAME. Your data lives on tabs named after
// the year ("2026" holds both the PVA matrix AND the earnings table; "2025"
// holds the PVA matrix). Both are fetched through the same proven fetchSheetCSV
// path that /ca uses. Override via Render env vars only if you rename the tabs.
const PVA_TABS_2026 = (process.env.PVA_TABS_2026 || "2026").split(",").map(s => s.trim());
const PVA_TABS_2025 = (process.env.PVA_TABS_2025 || "2025").split(",").map(s => s.trim());

// PVA colour thresholds (the brief): green ≥10, amber 7–10, red <7.
const PVA_GREEN = 10, PVA_AMBER = 7;
const C_GREEN = "#16a34a", C_AMBER = "#f59e0b", C_RED = "#dc2626", C_INK = "#16202E", C_MUT = "#94a3b8";
const pvaColor = (v) => v == null ? C_MUT : v >= PVA_GREEN ? C_GREEN : v >= PVA_AMBER ? C_AMBER : C_RED;

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ── Robust number parsing ────────────────────────────────────────────────────
// The sheets mix en-US (8.68, €8,620.00) and Dutch (11,41) formats, plus
// "#DIV/0!", "-", "\-" and blanks. This coerces all of them to a number|null.
function pvaNum(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/[€\s]/g, "");
  if (!s || s === "-" || s === "\\-" || /^#/.test(s)) return null; // blank / placeholder / #DIV/0!
  const hasDot = s.includes("."), hasComma = s.includes(",");
  if (hasDot && hasComma) s = s.replace(/,/g, "");          // 8,620.00 → 8620.00 (comma = thousands)
  else if (hasComma)      s = s.replace(",", ".");          // 11,41    → 11.41   (comma = decimal)
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// ── Chiro-location identity ──────────────────────────────────────────────────
// Maps the many header spellings ("Alex (Amstel)", "alex bussum", "Alex Rdam",
// "Lara Amstelveen", "Matt Bussum", "Myles") onto one canonical key + label.
const LOC_TOKENS = [
  [/amstel/i,            "Amstelveen"],
  [/bussum/i,            "Bussum"],
  [/utrecht|\bu\b/i,     "Utrecht"],
  [/rdam|rotterdam|r.?dam/i, "Rotterdam"],
];
// Bare names with no location in the header → assume their home clinic.
const BARE_LOC = { Myles: "Amstelveen", Annefloor: "Amstelveen", Nick: "Bussum", Holly: "Amstelveen", Courtney: "Amstelveen", Matthew: "Utrecht" };

function parseChiroLoc(header) {
  if (!header) return null;
  const h = String(header).trim();
  if (!h || /^(month|average|avg|total|intake|all totals|operational|difference|weekly)/i.test(h)) return null;
  if (/intake/i.test(h)) return null; // skip the interleaved intake columns
  const chiroM = h.match(/^([A-Za-z]+)/);
  if (!chiroM) return null;
  const chiro = chiroM[1][0].toUpperCase() + chiroM[1].slice(1).toLowerCase();
  let loc = null;
  for (const [re, name] of LOC_TOKENS) if (re.test(h.slice(chiro.length))) { loc = name; break; }
  if (!loc) loc = BARE_LOC[chiro] || null;
  if (!loc) return null;
  return { chiro, loc, key: `${chiro}·${loc}`, label: `${chiro} · ${loc}` };
}

// ── Block-aware table extraction ─────────────────────────────────────────────
// Scans ALL rows (across whatever tabs we fetched) and pulls out:
//   • PVA matrix   — a "Month" header whose other columns are chiro-locations
//   • Earnings     — a "month" header that also contains "operational expense"
function findTables(rows) {
  const monthIdx = (cells) => cells.findIndex(c => /^month$/i.test((c||"").trim()));
  let pvaHeader = null, earnHeader = null;
  const pva = {}, earn = {};

  // locate header rows
  const headers = [];
  rows.forEach((r, i) => {
    const cells = (r||[]).map(c => (c||"").trim());
    if (monthIdx(cells) === 0) headers.push({ i, cells });
  });
  for (const hd of headers) {
    const isEarn = hd.cells.some(c => /operational expense|all totals/i.test(c));
    if (isEarn && !earnHeader) earnHeader = hd;
    else if (!isEarn && !pvaHeader) pvaHeader = hd;
  }

  const readBlock = (hd, store, asMoney) => {
    if (!hd) return;
    const colMap = {}; // colIndex → key
    hd.cells.forEach((c, idx) => {
      if (idx === 0) return;
      const cl = parseChiroLoc(c);
      if (cl) { colMap[idx] = cl; store._labels = (store._labels||{}); store._labels[cl.key] = cl.label; }
    });
    for (let r = hd.i + 1; r < rows.length; r++) {
      const cells = (rows[r]||[]).map(c => (c||"").trim());
      const mIdx = MONTHS.findIndex(m => new RegExp("^"+m, "i").test(cells[0]||""));
      if ((cells[0]||"") === "" && cells.slice(1).every(c => c === "")) continue;
      if (mIdx < 0) { if (/^month$/i.test(cells[0]||"")) break; else continue; }
      for (const [idx, cl] of Object.entries(colMap)) {
        const v = pvaNum(cells[idx]);
        if (v == null) continue;
        (store[cl.key] ||= Array(12).fill(null))[mIdx] = v;
      }
    }
  };
  readBlock(pvaHeader, pva, false);
  readBlock(earnHeader, earn, true);
  return { pva, earn, found: { pva: !!pvaHeader, earn: !!earnHeader } };
}

// ── Weekly visits table ──────────────────────────────────────────────────────
// Pulls the "weekly visit avg" block (weeks 1-53, one column per chiro-location)
// from the same CSV, keyed the same way as the PVA matrix.
function parseWeekly(rows) {
  let wi = -1;
  for (let i=0;i<rows.length;i++){ const c0=((rows[i]||[])[0]||"").trim().toLowerCase(); if(c0.startsWith("weekly visit")){wi=i;break;} }
  if (wi<0) return {};
  const hd=(rows[wi]||[]).map(c=>(c||"").trim()), colMap={};
  hd.forEach((c,idx)=>{ if(idx===0)return; const cl=parseChiroLoc(c); if(cl) colMap[idx]=cl.key; });
  const wk={};
  for (let r=wi+1;r<rows.length;r++){
    const cells=(rows[r]||[]).map(c=>(c||"").trim());
    const wn=parseInt(cells[0],10);
    if (isNaN(wn)) break;
    if (wn<1||wn>53) continue;
    for (const idx in colMap){ const key=colMap[idx]; const v=pvaNum(cells[idx]); (wk[key]||(wk[key]=Array(53).fill(null)))[wn-1]=v; }
  }
  if (wk["Matthew·Bussum"] && !wk["Matt·Bussum"]) wk["Matt·Bussum"]=wk["Matthew·Bussum"];
  return wk;
}

// ── Per-practitioner monthly revenue (the € table at the bottom of the PVA sheet) ─
function parseMonthlyRev(rows, year) {
  let ri=-1;
  for (let i=0;i<rows.length;i++){ const r=rows[i]||[]; if((r[0]||"").trim().toLowerCase()==="month" && r.join(",").toLowerCase().includes("operational expense")){ri=i;break;} }
  if (ri<0) return {};
  const hdr=(rows[ri]||[]).map(c=>(c||"").trim().toLowerCase()), ix=n=>hdr.indexOf(n);
  const cAlex=ix("alex total"),cLA=ix("lara amstelveen"),cLB=ix("lara bussum"),cMy=ix("total myles"),cAn=ix("annefloor"),cMU=ix("matthew u"),cMB=ix("matthew b");
  const MON={january:"01",jan:"01",february:"02",feb:"02",march:"03",mar:"03",april:"04",apr:"04",may:"05",june:"06",july:"07",jul:"07",august:"08",aug:"08",september:"09",sept:"09",october:"10",oct:"10",november:"11",nov:"11",december:"12",dec:"12"};
  const E=s=>{ if(s==null)return 0; let t=String(s).replace(/\u20ac/g,"").trim(); if(!t||t[0]==="#")return 0; const neg=t[0]==="-"; t=t.replace(/^-/,"").replace(/,/g,""); const v=parseFloat(t); return isNaN(v)?0:(neg?-v:v); };
  const out={};
  for (let r=ri+1;r<rows.length;r++){ const row=rows[r]||[]; const mn=(row[0]||"").trim().toLowerCase(); if(!MON[mn])continue;
    const g=c=>(c>=0&&c<row.length)?E(row[c]):0;
    const o={Alex:Math.round(g(cAlex)),LaraA:Math.round(g(cLA)),LaraB:Math.round(g(cLB)),Myles:Math.round(g(cMy)),Annefloor:Math.round(g(cAn)),Matthew:Math.round(g(cMU)+g(cMB))};
    if(o.Alex+o.LaraA+o.LaraB+o.Myles+o.Annefloor+o.Matthew>0) out[year+"-"+MON[mn]]=o; }
  return out;
}

// ── Load + shape everything ──────────────────────────────────────────────────
async function loadTabs(sheetId, tabs) {
  const out = [];
  // The export endpoint returns the ENTIRE first tab — including tables that sit
  // BELOW blank rows (your earnings table). gviz tends to stop at the first blank
  // gap, which is why the top PVA matrix loaded but the earnings table came back
  // empty. Your data is on the first tab of each sheet (2026 / 2025), so we read
  // the whole thing here and only fall back to gviz-by-name if export is blocked.
  try {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`);
    if (r.ok) {
      const csv = await r.text();
      if (/Month/i.test(csv)) { out.push(...parseCSV(csv)); return out; }
    }
  } catch (e) { out._err = (out._err || []); out._err.push(`export: ${e.message}`); }
  const list = (tabs && tabs.length && tabs.some(t => t)) ? tabs : [""];
  for (const t of list) {
    try {
      const csv = t
        ? await fetchSheetCSV(sheetId, t)
        : await (await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv`)).text();
      out.push(...parseCSV(csv));
    } catch (e) { out._err = (out._err || []); out._err.push(`${t || "first tab"}: ${e.message}`); }
  }
  return out;
}

async function loadPvaData() {
  const errors = [];
  const rows26 = await loadTabs(PVA_SHEET_2026, PVA_TABS_2026);
  const rows25 = await loadTabs(PVA_SHEET_2025, PVA_TABS_2025);
  if (rows26._err) errors.push(...rows26._err.map(e => `2026 ${e}`));
  if (rows25._err) errors.push(...rows25._err.map(e => `2025 ${e}`));

  const t26 = findTables(rows26);
  const t25 = findTables(rows25);

  const labels = { ...(t26.pva._labels||{}), ...(t26.earn._labels||{}), ...(t25.pva._labels||{}) };
  delete t26.pva._labels; delete t26.earn._labels; delete t25.pva._labels; delete t25.earn._labels;

  const keys = [...new Set([...Object.keys(t26.pva), ...Object.keys(t25.pva), ...Object.keys(t26.earn)])].sort();

  const pva = {}, earn = {};
  for (const k of keys) {
    pva[k]  = { 2025: t25.pva[k] || Array(12).fill(null), 2026: t26.pva[k] || Array(12).fill(null) };
    earn[k] = { 2025: t25.earn[k] || Array(12).fill(null), 2026: t26.earn[k] || Array(12).fill(null) };
  }
  const weekly = parseWeekly(rows26);
  const monthlyRev = { ...parseMonthlyRev(rows25, "2025"), ...parseMonthlyRev(rows26, "2026") };
  return { keys, labels, pva, earn, weekly, monthlyRev, errors, found: { y2026: t26.found, y2025: t25.found } };
}

// ── Live current-month PVA from PracticeHub (per chiro-location) ──────────────
async function livePvaByChiroLoc() {
  const dayOfMonth = new Date().getDate(); // "this month so far"
  const clinics = [...new Set(CHIROS.flatMap(c => c.clinics))];
  const live = {}; const errors = [];
  for (const clinic of clinics) {
    try {
      const k = await computeKpis(clinic, Math.max(1, dayOfMonth));
      for (const row of k.rows) {
        const ch = CHIROS.find(c => row.name.toLowerCase().includes(c.n.toLowerCase()) && c.clinics.includes(clinic));
        if (!ch) continue;
        live[`${ch.n}·${clinic}`] = { pva: row.pva, visits: row.visits, intakes: row.intakes };
      }
    } catch (e) { errors.push(`${clinic}: ${e.message}`); }
  }
  return { live, errors, days: dayOfMonth };
}

// ── tiny SVG chart helpers (hand-rolled, no library) ─────────────────────────
const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;");
function ytdAvg(arr) { const v = (arr||[]).filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; }

function svgBars(items, live) { // items: [{label, key, val2026, val2025}]
  const W=Math.max(560, items.length*78+80), H=300, P={l:42,r:16,t:16,b:78};
  const max=Math.max(12, ...items.map(i=>Math.max(i.val2026||0,i.val2025||0,(live[i.key]||{}).pva||0)))*1.1;
  const bw=(W-P.l-P.r)/items.length, y=v=>H-P.b-(v/max)*(H-P.t-P.b);
  let g="";
  for (const t of [0,5,10,15,20].filter(t=>t<=max)) g+=`<line x1="${P.l}" x2="${W-P.r}" y1="${y(t)}" y2="${y(t)}" stroke="#eef2f7"/><text x="${P.l-6}" y="${y(t)+4}" text-anchor="end" font-size="10" fill="${C_MUT}">${t}</text>`;
  // threshold guides
  g+=`<line x1="${P.l}" x2="${W-P.r}" y1="${y(PVA_GREEN)}" y2="${y(PVA_GREEN)}" stroke="${C_GREEN}" stroke-dasharray="3 3" opacity=".5"/>`;
  items.forEach((it,i)=>{
    const x=P.l+i*bw, cw=bw*0.5, cx=x+bw/2;
    if (it.val2026!=null){ g+=`<rect x="${cx-cw/2}" y="${y(it.val2026)}" width="${cw}" height="${H-P.b-y(it.val2026)}" rx="3" fill="${pvaColor(it.val2026)}"><title>${esc(it.label)} 2026 YTD: ${it.val2026.toFixed(1)}</title></rect>`; }
    if (it.val2025!=null){ g+=`<line x1="${cx-cw/2-2}" x2="${cx+cw/2+2}" y1="${y(it.val2025)}" y2="${y(it.val2025)}" stroke="${C_INK}" stroke-width="2"><title>${esc(it.label)} 2025 avg: ${it.val2025.toFixed(1)}</title></line>`; }
    const lv=(live[it.key]||{}).pva;
    if (lv!=null){ g+=`<circle cx="${cx}" cy="${y(lv)}" r="3.5" fill="#fff" stroke="${C_INK}" stroke-width="2"><title>${esc(it.label)} live now: ${lv.toFixed(1)}</title></circle>`; }
    const [c,l]=it.label.split(" · ");
    g+=`<text x="${cx}" y="${H-P.b+14}" text-anchor="end" font-size="10" fill="${C_INK}" transform="rotate(-40 ${cx} ${H-P.b+14})">${esc(c)} ${esc(l[0])}${esc(l.slice(1,3))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${g}</svg>
    <div class="legend"><b>Bars</b> = 2026 YTD avg PVA · <b>black tick</b> = 2025 full-year avg (YoY) · <b>hollow dot</b> = live this month. Green ≥${PVA_GREEN}, amber ${PVA_AMBER}–${PVA_GREEN}, red &lt;${PVA_AMBER}.</div>`;
}

function svgLines(keys, labels, pva) {
  const W=720,H=320,P={l:34,r:120,t:14,b:28};
  const max=Math.max(15, ...keys.flatMap(k=>(pva[k][2026]||[]).filter(v=>v!=null)))*1.1;
  const x=m=>P.l+(m/11)*(W-P.l-P.r), y=v=>H-P.b-(v/max)*(H-P.t-P.b);
  const palette=["#2563eb","#16a34a","#dc2626","#9333ea","#0891b2","#ea580c","#65a30d","#db2777","#475569","#ca8a04"];
  let g="";
  for (const t of [0,5,10,15].filter(t=>t<=max)) g+=`<line x1="${P.l}" x2="${W-P.r}" y1="${y(t)}" y2="${y(t)}" stroke="#eef2f7"/><text x="${P.l-6}" y="${y(t)+4}" text-anchor="end" font-size="10" fill="${C_MUT}">${t}</text>`;
  MONTHS.forEach((m,i)=>g+=`<text x="${x(i)}" y="${H-8}" text-anchor="middle" font-size="9" fill="${C_MUT}">${m}</text>`);
  g+=`<line x1="${P.l}" x2="${W-P.r}" y1="${y(PVA_GREEN)}" y2="${y(PVA_GREEN)}" stroke="${C_GREEN}" stroke-dasharray="3 3" opacity=".4"/>`;
  keys.forEach((k,ki)=>{
    const col=palette[ki%palette.length]; const pts=[];
    (pva[k][2026]||[]).forEach((v,m)=>{ if(v!=null) pts.push(`${x(m)},${y(v)}`); });
    if(pts.length) g+=`<polyline points="${pts.join(" ")}" fill="none" stroke="${col}" stroke-width="2"/>`;
    (pva[k][2026]||[]).forEach((v,m)=>{ if(v!=null) g+=`<circle cx="${x(m)}" cy="${y(v)}" r="2.5" fill="${col}"><title>${esc(labels[k])} ${MONTHS[m]}: ${v.toFixed(1)}</title></circle>`; });
    g+=`<text x="${W-P.r+6}" y="${14+ki*15}" font-size="10" fill="${col}">${esc(labels[k])}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${g}</svg><div class="legend">2026 monthly PVA per chiro-location. Hover a point for the value.</div>`;
}

function svgScatter(keys, labels, pva, earn) {
  const pts=[];
  for (const k of keys) for (let m=0;m<12;m++){ const p=pva[k][2026]?.[m], e=earn[k][2026]?.[m]; if(p!=null&&e!=null) pts.push({k,m,p,e}); }
  const W=720,H=320,P={l:60,r:16,t:14,b:40};
  if(!pts.length) return `<div class="legend">No paired PVA + earnings points yet. This lights up once monthly earnings exist alongside PVA (currently 2026 Jan–May; add a 2025 earnings tab for YoY points).</div>`;
  const maxP=Math.max(15,...pts.map(p=>p.p))*1.1, maxE=Math.max(...pts.map(p=>p.e))*1.1;
  const x=v=>P.l+(v/maxP)*(W-P.l-P.r), y=v=>H-P.b-(v/maxE)*(H-P.t-P.b);
  let g="";
  for (const t of [0,5,10,15].filter(t=>t<=maxP)) g+=`<text x="${x(t)}" y="${H-P.b+16}" text-anchor="middle" font-size="10" fill="${C_MUT}">${t}</text><line x1="${x(t)}" x2="${x(t)}" y1="${P.t}" y2="${H-P.b}" stroke="#f4f7fb"/>`;
  for (let e=0;e<=maxE;e+=5000) g+=`<text x="${P.l-8}" y="${y(e)+3}" text-anchor="end" font-size="9" fill="${C_MUT}">€${(e/1000)|0}k</text><line x1="${P.l}" x2="${W-P.r}" y1="${y(e)}" y2="${y(e)}" stroke="#f4f7fb"/>`;
  g+=`<line x1="${x(PVA_GREEN)}" x2="${x(PVA_GREEN)}" y1="${P.t}" y2="${H-P.b}" stroke="${C_GREEN}" stroke-dasharray="3 3" opacity=".5"/>`;
  for (const p of pts) g+=`<circle cx="${x(p.p)}" cy="${y(p.e)}" r="4" fill="${pvaColor(p.p)}" opacity=".8"><title>${esc(labels[p.k])} ${MONTHS[p.m]} · PVA ${p.p.toFixed(1)} · €${Math.round(p.e).toLocaleString("en-US")}</title></circle>`;
  g+=`<text x="${(W)/2}" y="${H-4}" text-anchor="middle" font-size="10" fill="${C_MUT}">PVA →</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${g}</svg><div class="legend">Each dot = one chiro-location in one month: PVA (x) vs euros brought in (y), coloured by PVA band.</div>`;
}

// ── Page ─────────────────────────────────────────────────────────────────────
function renderPvaPage(d, debug) {
  const items = d.keys
    .map(k => ({ key:k, label:d.labels[k]||k, val2026: ytdAvg(d.pva[k][2026]), val2025: ytdAvg(d.pva[k][2025]) }))
    .filter(it => it.val2026 != null || it.val2025 != null)
    .sort((a,b) => (b.val2026||0) - (a.val2026||0));
  const liveKeys = d.keys.filter(k => (d.pva[k][2026]||[]).some(v=>v!=null));
  const earnTotalByChiro = {};
  for (const k of d.keys) { const [chiro]=k.split("·"); const sum=(d.earn[k][2026]||[]).filter(v=>v!=null).reduce((a,b)=>a+b,0); if(sum) earnTotalByChiro[chiro]=(earnTotalByChiro[chiro]||0)+sum; }
  const earnRows = Object.entries(earnTotalByChiro).sort((a,b)=>b[1]-a[1])
    .map(([c,v])=>`<tr><td>${esc(c)}</td><td class="num">€${Math.round(v).toLocaleString("en-US")}</td></tr>`).join("") || `<tr><td colspan="2" style="color:#888">No 2026 earnings parsed yet</td></tr>`;

  const err = d.errors.length ? `<div class="warn">Some data couldn't load: ${d.errors.map(esc).join(" · ")}</div>` : "";
  const foundNote = (!d.found.y2026.pva || !d.found.y2026.earn)
    ? `<div class="warn">Heads up: ${!d.found.y2026.pva?"PVA matrix":""}${(!d.found.y2026.pva&&!d.found.y2026.earn)?" and ":""}${!d.found.y2026.earn?"earnings table":""} not found in the 2026 tab(s). Set <code>PVA_TABS_2026</code> in Render to the right tab name(s), or open <a href="/pva?debug=1">/pva?debug=1</a>.</div>` : "";

  const debugBlock = debug ? `<pre class="dbg">${esc(JSON.stringify({
    keysFound: d.keys, labels: d.labels, found: d.found, errors: d.errors,
    sample: d.keys.slice(0,3).reduce((o,k)=>(o[k]={pva:d.pva[k],earn:d.earn[k]},o),{})
  }, null, 2))}</pre>` : "";

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>PVA — Posturefixx</title>
<style>
 :root{--ink:#16202E;--mut:#64748b;--blue:#2563EB;--line:#e5e7eb}
 body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:840px;margin:24px auto;padding:0 16px;color:var(--ink)}
 h1{font-size:22px;margin:0 0 2px} .sub{color:var(--mut);font-size:13px;margin-bottom:18px}
 .tabs{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
 .tab{padding:8px 14px;border-radius:8px;background:#f1f5f9;cursor:pointer;font-size:13px;font-weight:600}
 .tab.on{background:var(--ink);color:#fff}
 .card{border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
 .card b{font-size:14px} table{border-collapse:collapse;width:100%;font-size:14px;margin-top:8px}
 td{padding:8px;border-bottom:1px solid #f1f5f9} .num{text-align:right;font-variant-numeric:tabular-nums}
 .legend{color:var(--mut);font-size:12px;margin-top:10px;line-height:1.5}
 .warn{background:#fef3c7;color:#92400e;padding:10px 12px;border-radius:8px;font-size:12.5px;margin-bottom:14px}
 .dbg{background:#0f172a;color:#cbd5e1;padding:14px;border-radius:8px;font-size:11px;overflow:auto;max-height:420px}
 svg text{font-family:inherit} a{color:var(--blue)} code{background:#f1f5f9;padding:1px 5px;border-radius:4px}
</style></head><body>
 <h1>PVA & earnings</h1>
 <div class="sub">Historical from the PVA sheets · live this-month from PracticeHub · manager view</div>
 ${err}${foundNote}
 <div class="tabs" id="tabs"></div>
 <section data-tab="YTD PVA"><div class="card"><b>YTD PVA per chiro-location</b><div id="bars">${svgBars(items, {})}</div></div></section>
 <section data-tab="Month-to-month" style="display:none"><div class="card"><b>Monthly PVA — 2026</b>${svgLines(liveKeys, d.labels, d.pva)}</div></section>
 <section data-tab="PVA vs earnings" style="display:none"><div class="card"><b>PVA vs monthly earnings</b>${svgScatter(d.keys, d.labels, d.pva, d.earn)}</div>
   <div class="card"><b>2026 earnings by chiropractor (all locations)</b><table><tbody>${earnRows}</tbody></table>
   <div class="legend">Per-location split and 2025 figures appear here once a 2025 earnings tab exists.</div></div></section>
 <section data-tab="By chiropractor" style="display:none">
   <div id="chirobtns" style="margin-bottom:10px"></div>
   <div class="card"><div id="chirochart"></div><div class="legend">2026 monthly PVA for the selected chiropractor \u00b7 grey dashed = their 2025 average \u00b7 green = the 10 target.</div></div>
   <div class="card"><div id="chiroweek"></div><div class="legend">Weekly visits (weeks 1\u201353) from your PVA sheet \u2014 the coaching view. Blue dashed = their average week.</div></div>
   <div id="chirohi" class="advice">Pick a chiropractor above for their highlights.</div>
 </section>
 ${debugBlock}
 <p class="sub">Pages: <a href="/plan">/plan</a> · <a href="/revenue">/revenue</a> · <a href="/marketing">/marketing</a> · <a href="/waste">/waste</a> · <a href="/pva">/pva</a> · <a href="/ca">/ca</a> · <a href="/coach">/coach</a></p>
 <script>
  var tabs=["YTD PVA","Month-to-month","PVA vs earnings","By chiropractor"],el=document.getElementById("tabs");
  function show(n){Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"),function(s){s.style.display=s.getAttribute("data-tab")===n?"":"none"});Array.prototype.forEach.call(el.children,function(b){b.className="tab"+(b.textContent===n?" on":"")})}
  tabs.forEach(function(n){var b=document.createElement("div");b.className="tab";b.textContent=n;b.onclick=function(){show(n)};el.appendChild(b)});show(tabs[0]);
  var MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var PVAB=${JSON.stringify(d.keys.reduce(function(o,k){o[k]={label:(d.labels[k]||k),m:(d.pva[k]&&d.pva[k][2026])||[],a25:ytdAvg(d.pva[k]&&d.pva[k][2025])};return o;},{}))};
  var WEEKLY=${JSON.stringify(d.weekly||{})};
  var PNEED={Alex:79,Lara:63,Myles:52,Matthew:68,Annefloor:13};
  function chiroHi(key){
    var d2=PVAB[key], arr=d2.m||[], vals=[]; arr.forEach(function(v,i){if(v!=null)vals.push({m:i,v:v});});
    if(!vals.length) return "<b>"+d2.label+"</b> \u2014 no 2026 PVA recorded yet.";
    var ytd=vals.reduce(function(a,o){return a+o.v;},0)/vals.length, hi=vals[0], lo=vals[0];
    vals.forEach(function(o){if(o.v>hi.v)hi=o;if(o.v<lo.v)lo=o;});
    var good=[],bad=[];
    if(ytd>=10) good.push("YTD PVA "+ytd.toFixed(1)+" \u2014 green zone, retention strong");
    else if(ytd>=7) good.push("YTD PVA "+ytd.toFixed(1)+" \u2014 amber, holding");
    else bad.push("YTD PVA "+ytd.toFixed(1)+" \u2014 red zone, retention needs work");
    if(d2.a25!=null){ if(ytd>d2.a25+0.5) good.push("up from "+d2.a25.toFixed(1)+" in 2025"); else if(ytd<d2.a25-0.5) bad.push("down from "+d2.a25.toFixed(1)+" vs 2025"); }
    good.push("best month "+MN[hi.m]+" ("+hi.v.toFixed(1)+")");
    if(lo.v<7) bad.push("dipped to "+lo.v.toFixed(1)+" in "+MN[lo.m]);
    if(vals.length>=3){var f=vals[0].v,l=vals[vals.length-1].v; if(l>f+1)good.push("trending up"); else if(l<f-1)bad.push("trending down");}
    return "<b>"+d2.label+"</b><br><b style='color:#15803d'>\u2714 Good:</b> "+(good.join("; ")||"\u2014")+"<br><b style='color:#b91c1c'>\u26a0 To improve:</b> "+(bad.join("; ")||"on track \u2014 keep it up");
  }
  function drawChiro(key){
    var d2=PVAB[key]; if(!d2)return; var arr=d2.m||[];
    var W=720,H=300,pL=40,pR=16,pT=14,pB=26, max=12; arr.forEach(function(v){if(v!=null&&v>max)max=v;}); max*=1.1;
    var x=function(i){return pL+(i/11)*(W-pL-pR);}, y=function(v){return H-pB-(v/max)*(H-pT-pB);}, g="";
    [0,5,10,15].forEach(function(t){if(t<=max){g+="<line x1='"+pL+"' x2='"+(W-pR)+"' y1='"+y(t)+"' y2='"+y(t)+"' stroke='#eef2f7'/><text x='"+(pL-6)+"' y='"+(y(t)+4)+"' text-anchor='end' font-size='10' fill='#94a3b8'>"+t+"</text>";}});
    g+="<line x1='"+pL+"' x2='"+(W-pR)+"' y1='"+y(10)+"' y2='"+y(10)+"' stroke='#16a34a' stroke-dasharray='3 3' opacity='.5'/>";
    if(d2.a25!=null)g+="<line x1='"+pL+"' x2='"+(W-pR)+"' y1='"+y(d2.a25)+"' y2='"+y(d2.a25)+"' stroke='#94a3b8' stroke-dasharray='5 4'/>";
    MN.forEach(function(m,i){g+="<text x='"+x(i)+"' y='"+(H-8)+"' text-anchor='middle' font-size='9' fill='#94a3b8'>"+m+"</text>";});
    var pts=[]; arr.forEach(function(v,i){if(v!=null)pts.push(x(i)+","+y(v));});
    if(pts.length>1)g+="<polyline points='"+pts.join(" ")+"' fill='none' stroke='#2563eb' stroke-width='2.5'/>";
    arr.forEach(function(v,i){if(v!=null)g+="<circle cx='"+x(i)+"' cy='"+y(v)+"' r='3' fill='#2563eb'><title>"+MN[i]+": "+v.toFixed(1)+"</title></circle>";});
    document.getElementById("chirochart").innerHTML="<svg viewBox='0 0 "+W+" "+H+"' width='100%'>"+g+"</svg>";
    document.getElementById("chirohi").innerHTML=chiroHi(key); drawChiroWeek(key);
    Array.prototype.forEach.call(document.querySelectorAll("button[data-ck]"),function(b){var on=b.getAttribute("data-ck")===key;b.style.background=on?"#16202E":"#fff";b.style.color=on?"#fff":"#6B7686";b.style.borderColor=on?"#16202E":"#e5e7eb";});
  }
  function drawChiroWeek(key){
    var arr=(WEEKLY[key]||[]), vals=[]; arr.forEach(function(v,i){if(v!=null)vals.push({w:i+1,v:v});});
    var el=document.getElementById("chiroweek"); if(!el)return;
    if(!vals.length){el.innerHTML="<div style='color:#94a3b8;font-size:13px;padding:6px'>No weekly visits recorded yet for "+((PVAB[key]||{}).label||key)+".</div>";return;}
    var W=720,H=240,pL=32,pR=12,pT=12,pB=22, max=Math.max.apply(null,vals.map(function(o){return o.v;}))*1.12||1;
    var n=vals.length, gap=(W-pL-pR)/n, bw=gap*0.7, avg=vals.reduce(function(a,o){return a+o.v;},0)/vals.length, g="";
    [0,Math.round(max/2),Math.round(max)].forEach(function(t){var y=H-pB-(t/max)*(H-pT-pB);g+="<line x1='"+pL+"' x2='"+(W-pR)+"' y1='"+y+"' y2='"+y+"' stroke='#eef2f7'/><text x='"+(pL-5)+"' y='"+(y+3)+"' text-anchor='end' font-size='9' fill='#94a3b8'>"+t+"</text>";});
    var ay=H-pB-(avg/max)*(H-pT-pB); g+="<line x1='"+pL+"' x2='"+(W-pR)+"' y1='"+ay+"' y2='"+ay+"' stroke='#2563eb' stroke-dasharray='4 3' opacity='.55'/><text x='"+(W-pR)+"' y='"+(ay-3)+"' text-anchor='end' font-size='9' fill='#2563eb'>avg "+avg.toFixed(0)+"</text>";
    vals.forEach(function(o,i){var x=pL+i*gap+(gap-bw)/2, h=(o.v/max)*(H-pT-pB), y=H-pB-h; g+="<rect x='"+x+"' y='"+y+"' width='"+bw+"' height='"+h+"' rx='1' fill='#2563eb'><title>Week "+o.w+": "+o.v+" visits</title></rect>"; if(o.w%5===0||i===0){g+="<text x='"+(x+bw/2)+"' y='"+(H-8)+"' text-anchor='middle' font-size='8' fill='#94a3b8'>"+o.w+"</text>";}});
    el.innerHTML="<b style='font-size:13px'>Weekly visits \u00b7 "+((PVAB[key]||{}).label||key)+"</b><svg viewBox='0 0 "+W+" "+H+"' width='100%' style='margin-top:6px'>"+g+"</svg>";
    var chiro=key.split(String.fromCharCode(183))[0], actual=0;
    Object.keys(WEEKLY).forEach(function(k){if(k.split(String.fromCharCode(183))[0]===chiro){var vv=(WEEKLY[k]||[]).filter(function(x){return x!=null;}); if(vv.length)actual+=vv.reduce(function(a,b){return a+b;},0)/vv.length;}});
    var need=PNEED[chiro];
    if(need){var gap=need-actual, ok=gap<=3; el.innerHTML+="<div style='margin-top:8px;padding:9px 11px;border-radius:8px;background:"+(ok?'#dcfce7':'#fef3c7')+";color:"+(ok?'#166534':'#92400e')+";font-size:13px'><b>"+chiro+"</b> across their clinics is averaging <b>~"+Math.round(actual)+" visits/wk</b> \u2014 needs <b>~"+need+"/wk</b> to clear your 10% profit target, so "+(ok?"<b>on track</b>":"<b>~"+Math.round(gap)+" short/wk</b> (the coaching gap)")+".</div>";}
  }
  var ckeys=Object.keys(PVAB).sort(), cb=document.getElementById("chirobtns");
  ckeys.forEach(function(k){var b=document.createElement("button");b.textContent=PVAB[k].label;b.setAttribute("data-ck",k);b.style.cssText="padding:5px 10px;margin:0 6px 6px 0;border:1px solid #e5e7eb;background:#fff;border-radius:6px;font-size:12px;cursor:pointer;color:#6B7686";b.onclick=function(){drawChiro(k);};cb.appendChild(b);});
  if(ckeys.length) drawChiro(ckeys[0]);
  // pull live this-month PVA and overlay onto the bars
  fetch("/pva/live.json").then(function(r){return r.json()}).then(function(j){
    if(!j||!j.live)return; var box=document.getElementById("bars");
    box.insertAdjacentHTML("afterbegin","<div class='legend'>Live this month ("+j.days+" days in): "+Object.keys(j.live).map(function(k){return k.replace('·',' ')+" "+(j.live[k].pva||0).toFixed(1)}).join(" · ")+"</div>");
  }).catch(function(){});
 </script>
</body></html>`;
}

// ── Routes (manager-gated via your existing gate) ────────────────────────────
app.get("/pva", gate, async (req, res) => {
  try {
    const data = await loadPvaData();
    res.send(renderPvaPage(data, req.query.debug === "1"));
  } catch (e) { res.status(500).send(`<pre style="white-space:pre-wrap;font-family:sans-serif;max-width:680px;margin:40px auto">PVA page error: ${e.message}</pre>`); }
});

app.get("/pva/live.json", gate, async (_req, res) => {
  try { res.json(await livePvaByChiroLoc()); }
  catch (e) { res.json({ live: {}, errors: [e.message] }); }
});


// ============================================================================
//  /coach/cron — the automated coaching engine. Point an external scheduler at
//  this DAILY at 09:00 Amsterdam time:  /coach/cron?key=SECRET&until=YYYY-MM-DD
//  It decides what to do from the weekday (Amsterdam):
//    Sun & Wed  -> texts YOU a preview of what goes out the next morning
//    Mon & Thu  -> sends the coaching SMS to the chiros
//    other days -> does nothing
//  Stops automatically after the until date (or COACH_UNTIL env). Set OWNER_PHONE
//  (and optionally OWNER_SMS_CLINIC, default Amstelveen) so previews reach you.
// ============================================================================
const APP_URL = process.env.APP_URL || "https://posturefixx-coaching.onrender.com";
async function notifyOwner(text) {
  const phone = process.env.OWNER_PHONE || process.env.PHONE_ALEX;
  const clinic = process.env.OWNER_SMS_CLINIC || "Amstelveen";
  if (!phone) throw new Error("no OWNER_PHONE set (add it in Render so previews can reach you)");
  return sendSms(clinic, phone, "Alex", text);
}
// ============================================================================
//  GOALS + BRUTTO PAY — per-chiro targets (annual €, visits/day, or PVA),
//  projected live from PracticeHub. Shows BOTH what they bring into the clinic
//  (gross services) AND their Brutto pay (real contract: base + holiday +
//  threshold/commission). Goal can be a "brought-in" target OR a "brutto" (take-
//  home) target. Biweekly goal-aware coaching SMS. Contracts summarised at /contracts.
// ============================================================================
// === CHIRO GOALS START (edit these — paste the whole file to deploy) ===
// type: "brought_in" = the € they bill the clinic | "brutto" = the € they get paid
const CHIRO_GOALS = {
  Myles:     { annual: 120000, pva: 12,   perDay: null, cadence: 2, type: "brutto" },
  Lara:      { annual: null,   pva: null, perDay: null, cadence: 2, type: "brought_in" },
  Matthew:   { annual: null,   pva: null, perDay: null, cadence: 2, type: "brought_in" },
  Alex:      { annual: null,   pva: null, perDay: null, cadence: 2, type: "brought_in" },
  Annefloor: { annual: null,   pva: null, perDay: null, cadence: 2, type: "brought_in" },
};
// === CHIRO GOALS END ===
const GOALS_SHEET = process.env.GOALS_SHEET || "";

// === PAY STRUCTURES START (real contracts where on file; others = best-known est.) ===
// All figures GROSS (brutto). monthlyRev = collected services that month (€).
const PAY = {
  // Matthew — VERIFIED from permanent contract (19 Jan 2026).
  Matthew: { kind:"employee", base:4551, holidayPct:0.08, bonusFromMonth:5, threshold:16500,
    tiers:[{over:16500,pct:0.40},{over:21500,pct:0.45},{over:26500,pct:0.50}], verified:true,
    note:"Contract on file. Base €4,551/mo + 8% holiday. Bonus from May 2026; threshold €16,500/mo (shortfall carries within the quarter); marginal 40% / 45% / 50% on revenue above €16.5k / €21.5k / €26.5k." },
  // Myles — employee since Apr 2026. ESTIMATE (employee contract not on file).
  Myles: { kind:"employee", base:5688, holidayPct:0.08, bonusFromMonth:1, threshold:17500,
    tiers:[{over:17500,pct:0.45},{over:22500,pct:0.50},{over:27500,pct:0.55}], verified:false,
    note:"ESTIMATE — employee contract not on file. Base ~€5,688/mo + 8% holiday; threshold €17,500/mo; commission ~45/50/55%. (2025 contractor tiers were 40/45/55% over €5k/€10k/€15k.) Share the contract to lock this in." },
  // Lara — commission only, tiered per location. ESTIMATE.
  Lara: { kind:"commission", locations:2, perLocTiers:[{upTo:5000,pct:0.375},{upTo:10000,pct:0.425},{upTo:1e9,pct:0.45}], verified:false,
    note:"ESTIMATE — commission only, tiered per location: 37.5% first €5k / 42.5% €5–10k / 45% above (Amstelveen & Bussum counted separately). Confirm with contract." },
  // Annefloor — 45% flat. ESTIMATE.
  Annefloor: { kind:"commission", flatPct:0.45, verified:false,
    note:"ESTIMATE — 45% of collected invoices. Confirm with contract." },
  // Alex — owner.
  Alex: { kind:"owner", verified:true, note:"Owner — paid via the holding company (management fee), no clinic salary." },
};
function marginalTiers(tiers, R){ let b=0; for(let i=0;i<tiers.length;i++){ const lo=tiers[i].over, hi=(i+1<tiers.length)?tiers[i+1].over:Infinity; if(R>lo) b+=(Math.min(R,hi)-lo)*tiers[i].pct; } return b; }
function laraBrutto(R, locs){ const n=locs||1, per=R/n; let payPer=0, prev=0; for(const t of [{upTo:5000,pct:0.375},{upTo:10000,pct:0.425},{upTo:1e9,pct:0.45}]){ if(per>prev) payPer+=(Math.min(per,t.upTo)-prev)*t.pct; prev=t.upTo; } return payPer*n; }
// Brutto pay for a given month's collected revenue R. monthNum 1-12 (for bonus start).
function bruttoMonthly(name, R, monthNum){
  const p=PAY[name]; if(!p) return { base:0, commission:0, holiday:0, total:0, note:"No pay structure on file.", verified:false };
  if(p.kind==="owner") return { base:0, commission:0, holiday:0, total:0, owner:true, note:p.note, verified:p.verified };
  if(p.kind==="commission"){ const comm = p.flatPct!=null ? R*p.flatPct : laraBrutto(R, p.locations); return { base:0, commission:comm, holiday:0, total:comm, note:p.note, verified:p.verified }; }
  // employee
  const base=p.base, holiday=base*(p.holidayPct||0);
  const bonusActive = !p.bonusFromMonth || !monthNum || monthNum>=p.bonusFromMonth;
  const comm = bonusActive ? marginalTiers(p.tiers, R) : 0;
  return { base, commission:comm, holiday, total:base+holiday+comm, note:p.note, verified:p.verified };
}
// Inverse: monthly collected revenue needed to reach a target monthly brutto.
function revForBrutto(name, targetMonthlyBrutto, monthNum){
  let lo=0, hi=100000; for(let i=0;i<44;i++){ const mid=(lo+hi)/2; if(bruttoMonthly(name,mid,monthNum).total < targetMonthlyBrutto) lo=mid; else hi=mid; } return (lo+hi)/2;
}
// === PAY STRUCTURES END ===

function parseGoalsCSV(csv){
  const rows = parseCSV(csv); if(!rows.length) return {};
  const hdr = rows[0].map(c=>(c||"").trim().toLowerCase());
  const ix = n => hdr.findIndex(h=>h.replace(/[^a-z]/g,"").includes(n));
  const ci=ix("chiro"), ca=ix("annual"), cp=ix("pva"), cv=(ix("visitsperday")>=0?ix("visitsperday"):ix("perday")), cc=ix("cadence"), ct=ix("type");
  const num = s => { const v=parseFloat(String(s||"").replace(/[^0-9.]/g,"")); return Number.isFinite(v)?v:null; };
  const out={};
  for(let r=1;r<rows.length;r++){ const cells=rows[r]||[]; const name=(cells[ci]||"").trim(); if(!name) continue;
    out[name]={ annual:ca>=0?num(cells[ca]):null, pva:cp>=0?num(cells[cp]):null, perDay:cv>=0?num(cells[cv]):null, cadence:cc>=0?(num(cells[cc])||2):2, type:(ct>=0&&/brut/i.test(cells[ct]||""))?"brutto":"brought_in" }; }
  return out;
}
async function loadGoals(){
  if(GOALS_SHEET){ try{ const r=await fetch(`https://docs.google.com/spreadsheets/d/${GOALS_SHEET}/export?format=csv`); if(r.ok){ const g=parseGoalsCSV(await r.text()); if(Object.keys(g).length) return { goals:g, source:"sheet" }; } }catch(e){} }
  return { goals: CHIRO_GOALS, source:"baked" };
}

// Live projection for one chiro. b={n,visits,intakes,pva}. Shows brought-in AND brutto.
function goalProgress(b, g, days){
  const name=b.n, P=PRICE_PER_VISIT, wkDays=days||3.5, mNum=(new Date()).getMonth()+1;
  const visits30=b.visits||0, weekNow=visits30/4.33, perDayNow=weekNow/wkDays;
  const monthRev=visits30*P, annualRun=monthRev*12;
  const bm=bruttoMonthly(name, monthRev, mNum);
  const bruttoMonthNow=bm.total, bruttoAnnualNow=bruttoMonthNow*12;
  const type = (g.type==="brutto") ? "brutto" : "brought_in";
  let annualGoal = g.annual!=null ? g.annual : (g.perDay ? g.perDay*wkDays*4.33*P*12 : null);
  let weekNeeded=null, perDayNeeded=null, revNeededMonth=null, broughtInGoal=null, bruttoGoal=null;
  const hasGoal = !!(annualGoal || g.perDay);
  if(annualGoal!=null){
    if(type==="brutto"){ bruttoGoal=annualGoal; revNeededMonth=revForBrutto(name, annualGoal/12, mNum); broughtInGoal=revNeededMonth*12; }
    else { broughtInGoal=annualGoal; revNeededMonth=annualGoal/12; bruttoGoal=bruttoMonthly(name, revNeededMonth, mNum).total*12; }
    const monthVisitsNeeded=revNeededMonth/P; weekNeeded=monthVisitsNeeded/4.33; perDayNeeded=weekNeeded/wkDays;
  } else if(g.perDay){ perDayNeeded=g.perDay; weekNeeded=g.perDay*wkDays; revNeededMonth=weekNeeded*4.33*P; broughtInGoal=revNeededMonth*12; bruttoGoal=bruttoMonthly(name, revNeededMonth, mNum).total*12; }
  const gapWeek = weekNeeded!=null ? (weekNeeded-weekNow) : null;
  let pct=null;
  if(type==="brutto" && bruttoGoal) pct=bruttoAnnualNow/bruttoGoal;
  else if(annualGoal) pct=annualRun/annualGoal;
  else if(g.perDay) pct=perDayNow/g.perDay;
  return { hasGoal, type, visits30, weekNow, perDayNow, monthRev, annualRun,
    bruttoMonthNow, bruttoAnnualNow, bruttoBase:bm.base, bruttoComm:bm.commission, bruttoHoliday:bm.holiday, owner:!!bm.owner,
    annualGoal, broughtInGoal, bruttoGoal, weekNeeded, perDayNeeded, revNeededMonth, gapWeek,
    pvaNow:b.pva, pvaTarget:g.pva||null, intakes:b.intakes, cadence:g.cadence||2, pct,
    payNote:bm.note, payVerified:bm.verified };
}

async function draftGoalCoaching(name, p){
  const unit = p.type==="brutto" ? "take-home (brutto)" : "brought into the clinic";
  const goalLine = p.bruttoGoal&&p.type==="brutto" ? `Their goal is to earn \u20ac${Math.round(p.bruttoGoal).toLocaleString("en-US")} brutto for the year (right now their pace is \u20ac${Math.round(p.bruttoAnnualNow).toLocaleString("en-US")} brutto).`
    : (p.broughtInGoal ? `Their goal is \u20ac${Math.round(p.broughtInGoal).toLocaleString("en-US")} ${unit} for the year (pace \u20ac${Math.round(p.annualRun).toLocaleString("en-US")}).` : "No euro goal set.");
  const need = p.weekNeeded!=null ? `To hit it they need ~${Math.round(p.weekNeeded)} visits/week; right now ~${Math.round(p.weekNow)}/week (${p.gapWeek>0.5?Math.round(p.gapWeek)+" short":"on track or ahead"}).` : "";
  const pvaLine = p.pvaTarget ? `PVA is ${p.pvaNow} vs target ${p.pvaTarget}.` : `PVA is ${p.pvaNow}.`;
  const focus = (p.pvaTarget && p.pvaNow!=null && p.pvaNow<p.pvaTarget) ? "retention — pre-booking the full care plan at the report of findings (doorplannen)" : "filling the schedule — converting more intakes to care and reactivation";
  const prompt = `Biweekly goal check-in for ${name}.\n${goalLine}\n${need}\n${pvaLine}\nFocus for the next two weeks: ${focus}.\nWrite the SMS now: name their goal, celebrate where they are, give ONE concrete action.`;
  const fallback = `Hi ${name}! Two-week check-in. ${p.type==="brutto"&&p.bruttoGoal?`Goal: \u20ac${Math.round(p.bruttoGoal).toLocaleString("en-US")} brutto for the year`:p.broughtInGoal?`Goal: \u20ac${Math.round(p.broughtInGoal).toLocaleString("en-US")} for the year`:"Goal check-in"}. You're ~${Math.round(p.weekNow)} visits/week${p.weekNeeded!=null?`, aiming for ~${Math.round(p.weekNeeded)}`:""} \u2014 ${p.gapWeek>0.5?`about ${Math.round(p.gapWeek)} to find`:"right on pace"}. ${p.pvaTarget&&p.pvaNow!=null&&p.pvaNow<p.pvaTarget?`Let's lift PVA toward ${p.pvaTarget} by booking the full plan at every report of findings.`:"Keep the schedule full and retention tight."} I'm with you on this.`;
  try{ const r=await withTimeout(anthropic.messages.create({model:MODEL,max_tokens:250,system:VOICE,messages:[{role:"user",content:prompt}]}),12000,"goal "+name); const t=r.content.filter(x=>x.type==="text").map(x=>x.text).join("").trim(); return t||fallback; }
  catch(e){ return fallback; }
}

app.get("/goals/data", gate, async (_req,res)=>{
  try{ const { goals, source }=await loadGoals(); const base=await chiroBaselines(30);
    const chiros=base.map(b=>{ const g=goals[b.n]||{}; const days=PLAN_DAYS[b.n]||3.5; return { n:b.n, clinics:b.clinics, days, phone:!!b.phone, goal:g, ...goalProgress(b,g,days) }; });
    res.json({ source, price:PRICE_PER_VISIT, chiros });
  }catch(e){ res.json({ error:e.message }); }
});

// Live recompute for one edited card (no PracticeHub re-pull — client passes its known 30d numbers)
app.post("/goals/recalc", gate, (req,res)=>{
  try{ const { name, visits30, pva, intakes, days, annual, pva_target, perDay, type }=req.body||{};
    const b={ n:name, visits:Number(visits30)||0, pva:(pva==null?null:Number(pva)), intakes:Number(intakes)||0 };
    const g={ annual:(annual==null||annual===""?null:Number(annual)), pva:(pva_target==null||pva_target===""?null:Number(pva_target)), perDay:(perDay==null||perDay===""?null:Number(perDay)), type:(type==="brutto"?"brutto":"brought_in") };
    res.json({ ok:true, ...goalProgress(b, g, Number(days)||3.5), goal:g });
  }catch(e){ res.json({ ok:false, error:e.message }); }
});

app.get("/goals/draft", gate, async (req,res)=>{
  try{ const name=req.query.name; const { goals }=await loadGoals(); const base=await chiroBaselines(30); const b=base.find(x=>x.n.toLowerCase()===String(name||"").toLowerCase());
    if(!b) return res.json({ ok:false, error:"unknown chiro" });
    const g=goals[b.n]||{}, days=PLAN_DAYS[b.n]||3.5, prog=goalProgress(b,g,days);
    if(!prog.hasGoal) return res.json({ ok:false, error:"no goal set for "+b.n });
    res.json({ ok:true, name:b.n, message:await draftGoalCoaching(b.n,prog), phone:!!b.phone });
  }catch(e){ res.json({ ok:false, error:e.message }); }
});

app.post("/goals/send", gate, async (req,res)=>{
  try{ const { target, text }=req.body||{}; const { goals }=await loadGoals(); const base=await chiroBaselines(30);
    const list=(target==="all")?base:base.filter(b=>b.n.toLowerCase()===String(target||"").toLowerCase());
    if(!list.length) return res.json({ ok:false, error:"unknown chiro" });
    const results=await Promise.all(list.map(async b=>{ const g=goals[b.n]||{}, days=PLAN_DAYS[b.n]||3.5, prog=goalProgress(b,g,days);
      if(!prog.hasGoal) return `${b.n}: skipped (no goal)`; if(!b.phone) return `${b.n}: skipped (no phone)`;
      try{ const msg=(text&&target!=="all")?text:await draftGoalCoaching(b.n,prog); await sendSms(b.smsClinic,b.phone,b.n,msg); return `${b.n}: sent`; }catch(e){ return `${b.n}: failed — ${e.message}`; } }));
    res.json({ ok:true, results });
  }catch(e){ res.json({ ok:false, error:e.message }); }
});

function isoWeek(d){ const t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())); const day=t.getUTCDay()||7; t.setUTCDate(t.getUTCDate()+4-day); const ys=new Date(Date.UTC(t.getUTCFullYear(),0,1)); return Math.ceil((((t-ys)/86400000)+1)/7); }
app.get("/goals/cron", async (req,res)=>{
  const secret=process.env.CRON_SECRET; if(!secret||req.query.key!==secret) return res.status(403).json({ ok:false, error:"forbidden" });
  try{ const ams=new Date(new Date().toLocaleString("en-US",{timeZone:"Europe/Amsterdam"})); const dow=ams.getDay();
    const { goals }=await loadGoals(); const base=await chiroBaselines(30);
    const withGoal=base.map(b=>({b,prog:goalProgress(b,goals[b.n]||{},PLAN_DAYS[b.n]||3.5)})).filter(x=>x.prog.hasGoal);
    if(dow===0){ const tom=new Date(ams.getTime()+86400000); if(isoWeek(tom)%2!==0) return res.json({ ok:true, action:"nothing (next week odd)" });
      const lines=await Promise.all(withGoal.map(async x=>{ const m=x.b.phone?await draftGoalCoaching(x.b.n,x.prog):"(no phone)"; return `- ${x.b.n}: ${m}`; }));
      await notifyOwner(`Biweekly goal check-ins go out tomorrow (Mon 9:00):\n\n${lines.join("\n\n")}\n\nReview: ${APP_URL}/goals`).catch(()=>{});
      return res.json({ ok:true, action:"preview-sent", chiros:withGoal.length }); }
    if(dow===1){ if(isoWeek(ams)%2!==0) return res.json({ ok:true, action:"nothing (odd week)" });
      const results=await Promise.all(withGoal.map(async x=>{ if(!x.b.phone) return `${x.b.n}: skipped (no phone)`; try{ const m=await draftGoalCoaching(x.b.n,x.prog); await sendSms(x.b.smsClinic,x.b.phone,x.b.n,m); return `${x.b.n}: sent`; }catch(e){ return `${x.b.n}: failed — ${e.message}`; } }));
      return res.json({ ok:true, action:"sent", results }); }
    return res.json({ ok:true, action:"nothing today" });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

// ---- /contracts : plain-language summary of every pay deal, for goal-setting ----
app.get("/contracts", gate, (_req,res)=>{
  const rows = Object.keys(PAY).map(name=>{ const p=PAY[name]; let deal="";
    if(p.kind==="owner") deal="Owner — paid via holding (management fee), no clinic salary.";
    else if(p.kind==="commission") deal = p.flatPct!=null ? (Math.round(p.flatPct*100)+"% of collected invoices") : ("Per-location tiers: 37.5% first \u20ac5k / 42.5% \u20ac5–10k / 45% above (each clinic separately)");
    else deal = "Base \u20ac"+p.base.toLocaleString("en-US")+"/mo + "+Math.round((p.holidayPct||0)*100)+"% holiday; threshold \u20ac"+p.threshold.toLocaleString("en-US")+"/mo, then "+p.tiers.map(t=>Math.round(t.pct*100)+"% >\u20ac"+(t.over/1000)+"k").join(" / ");
    return { name, kind:p.kind, deal, note:p.note, verified:p.verified }; });
  const exChiros = [
    { name:"Nick Bunger", note:"Former chiropractor. Paid by invoice (bank history). Rolling ~\u20ac15k threshold model." },
    { name:"Holly Schonberger", note:"Former chiropractor. ~\u20ac4,200 fixed (bank history)." },
    { name:"Courtney Rokowski", note:"Former chiropractor. Paid by invoice (bank history)." },
    { name:"Maria Feiler", note:"Former chiropractor. Paid by invoice (bank history)." },
  ];
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Contracts — Posturefixx</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:880px;margin:26px auto;padding:0 16px;color:#16202E}
h1{font-size:23px;margin:0 0 2px}.sub{color:#64748b;font-size:13px;margin:0 0 16px}
.card{border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;margin-bottom:12px}
.nm{font-weight:700;font-size:16px}.deal{margin:6px 0;font-size:14px}.note{color:#64748b;font-size:12.5px;line-height:1.5}
.tag{display:inline-block;font-size:10px;padding:1px 8px;border-radius:999px;margin-left:6px;vertical-align:middle}
.tag.ok{background:#ecfdf5;color:#16a34a}.tag.est{background:#fef3c7;color:#b45309}
h2{font-size:15px;margin:20px 0 8px}a{color:#2563EB}</style></head><body>
<h1>Contracts &amp; pay structures</h1>
<div class="sub">What each person earns, used to turn goals into Brutto pay. <span class="tag ok">on file</span> = from a signed contract; <span class="tag est">estimate</span> = reconstructed from sheets/history — share the contract and I'll lock it in exactly.</div>
${rows.map(r=>`<div class="card"><span class="nm">${r.name}</span>${r.verified?'<span class="tag ok">on file</span>':'<span class="tag est">estimate</span>'}<div class="deal">${r.deal}</div><div class="note">${r.note}</div></div>`).join("")}
<h2>Former chiropractors</h2>
${exChiros.map(r=>`<div class="card"><span class="nm">${r.name}</span><div class="note">${r.note}</div></div>`).join("")}
<h2>Chiropractic assistants</h2>
<div class="card"><div class="note">CAs (Renata, Csabi, Vivian, Archana, Dolly, Samantha, Lina, Anne, Szandi) are paid as wages — see each clinic's expense sheet (CA cost column). No individual CA contracts are filed in Drive yet; add them to the Chiropractors folder and I'll summarise each here.</div></div>
<p class="sub"><a href="/goals">\u2190 back to Goals</a> \u00b7 <a href="/profit">/profit</a> \u00b7 <a href="/">home</a></p>
</body></html>`);
});

app.get("/goals", gate, (_req,res)=>{
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Goals — Posturefixx</title>
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:920px;margin:26px auto;padding:0 16px;color:#16202E}
 h1{font-size:23px;margin:0 0 2px}.sub{color:#64748b;font-size:13px;margin:0 0 16px}
 .card{border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin-bottom:14px}
 .gname{font-size:16px;font-weight:700}.gclin{color:#94a3b8;font-size:12px;font-weight:400}
 .row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin:10px 0}
 .row label{font-size:11px;color:#64748b;display:block;margin-bottom:3px}
 .row input,.row select{border:1px solid #d1d5db;border-radius:8px;padding:7px 9px;font-size:14px}
 .row input{width:110px}
 .prog{background:#f1f5f9;border-radius:8px;height:14px;overflow:hidden;margin:8px 0 4px}.prog>div{height:100%;border-radius:8px}
 .twocol{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0}
 .box{flex:1;min-width:200px;border:1px solid #eef2f7;border-radius:10px;padding:10px 12px}
 .box .lbl{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.03em}
 .box .big{font-size:18px;font-weight:700;margin-top:2px}
 .box .det{font-size:12px;color:#64748b;margin-top:3px}
 .clinicbox{background:#f8fafc}.bruttobox{background:#f0fdf4;border-color:#dcfce7}
 .need{font-size:13px;color:#475569;margin-top:4px}
 .btn{border:none;background:#2563EB;color:#fff;font-size:13px;font-weight:600;padding:8px 14px;border-radius:8px;cursor:pointer}
 .btn.alt{background:#fff;color:#16202E;border:1px solid #d1d5db}.btn.send{background:#16a34a}
 textarea{width:100%;min-height:90px;border:1px solid #d1d5db;border-radius:8px;padding:10px;font-size:14px;font-family:inherit;box-sizing:border-box;margin-top:8px;display:none}
 .res{font-size:12px;margin-top:6px}
 .tag{display:inline-block;font-size:10px;padding:1px 8px;border-radius:999px;margin-left:6px;vertical-align:middle}
 .tag.ok{background:#ecfdf5;color:#16a34a}.tag.behind{background:#fef3c7;color:#b45309}.tag.none{background:#f1f5f9;color:#94a3b8}.tag.est{background:#fff7ed;color:#c2410c}
 .save{background:#0f172a;color:#cbd5e1;border-radius:10px;padding:12px;font-size:11.5px;white-space:pre;overflow:auto;display:none;margin-top:8px}
 a{color:#2563EB}
</style></head><body>
<h1>Goals &amp; biweekly check-ins</h1>
<div class="sub">Set a target per chiropractor. Pick whether the number is what they <b>bring into the clinic</b> or their <b>Brutto take-home</b>. The system projects both from live PracticeHub and the fortnightly SMS coaches toward their number. <span id="src"></span> \u00b7 <a href="/contracts">see contracts \u2192</a></div>
<div id="cards"><div class="card">Loading live numbers from PracticeHub…</div></div>
<div class="card"><b>Save your goals</b>
  <div class="sub" style="margin:4px 0 8px">After editing above, generate the block and paste it over the <code>CHIRO GOALS</code> section in your file, then deploy. Or set <code>GOALS_SHEET</code> in Render to edit in Google Sheets with no redeploy.</div>
  <button class="btn alt" onclick="genSave()">Generate goals to paste</button><div id="savebox" class="save"></div></div>
<div class="card"><b>Automate it</b><div class="sub" style="margin:4px 0 0">Point your scheduler at <code>/goals/cron?key=YOUR_CRON_SECRET</code> daily at 09:00. Previews to you the Sunday before, sends to each chiro on the Monday of every <b>even</b> ISO week.</div></div>
<p class="sub">Pages: <a href="/">home</a> \u00b7 <a href="/plan">/plan</a> \u00b7 <a href="/profit">/profit</a> \u00b7 <a href="/pva">/pva</a> \u00b7 <a href="/contracts">/contracts</a> \u00b7 <a href="/coach">/coach</a></p>
<script>
var DATA=null;
function eur(n){return "\u20ac"+Math.round(n||0).toLocaleString("en-US");}
function tagFor(c){ if(!c.hasGoal) return "<span class='tag none'>no goal set</span>"; if(c.pct==null) return ""; return c.pct>=0.98?"<span class='tag ok'>on pace</span>":"<span class='tag behind'>"+Math.round(c.pct*100)+"% of pace</span>"; }
function card(c){
  var g=c.goal||{};
  var isOwner=c.owner;
  var bruttoDetail = isOwner ? "via holding" : (eur(c.bruttoBase*12)+" base + "+eur(c.bruttoComm*12)+" comm"+(c.bruttoHoliday?" + "+eur(c.bruttoHoliday*12)+" holiday":""));
  var pct=Math.max(0,Math.min(1,c.pct||0)); var barCol=pct>=0.98?"#16a34a":pct>=0.7?"#f59e0b":"#dc2626";
  var goalIsBrutto = (g.type==="brutto");
  var needLine="";
  if(c.hasGoal && c.weekNeeded!=null){
    if(goalIsBrutto) needLine = "To earn "+eur(c.bruttoGoal)+" brutto/yr, needs ~"+eur(c.broughtInGoal)+" brought in \u2192 <b>~"+Math.round(c.weekNeeded)+" visits/wk</b> (\u2248"+(c.perDayNeeded||0).toFixed(0)+"/day) \u2014 "+(c.gapWeek>0.5?"<b style='color:#b45309'>~"+Math.round(c.gapWeek)+"/wk to find</b>":"<b style='color:#16a34a'>on track</b>");
    else needLine = "Needs <b>~"+Math.round(c.weekNeeded)+" visits/wk</b> (\u2248"+(c.perDayNeeded||0).toFixed(0)+"/day) \u2014 "+(c.gapWeek>0.5?"<b style='color:#b45309'>~"+Math.round(c.gapWeek)+"/wk to find</b>":"<b style='color:#16a34a'>on track</b>");
  }
  var pvaLine="PVA <b>"+(c.pvaNow!=null?c.pvaNow:"\u2014")+"</b>"+(c.pvaTarget?(" / target "+c.pvaTarget):"")+" \u00b7 intakes "+(c.intakes||0)+" (30d)";
  return "<div class='card' data-name='"+c.n+"' data-v='"+c.visits30+"' data-pva='"+(c.pvaNow==null?'':c.pvaNow)+"' data-int='"+(c.intakes||0)+"' data-days='"+c.days+"'>"
    +"<div class='gname'>"+c.n+" <span class='gclin'>"+(c.clinics||[]).join(" + ")+"</span>"+tagFor(c)+(c.payVerified?"":" <span class='tag est'>pay = estimate</span>")+(c.phone?"":" <span class='gclin' style='color:#dc2626'>(no phone)</span>")+"</div>"
    +"<div class='twocol'>"
    +"<div class='box clinicbox'><div class='lbl'>Brings into clinic (pace)</div><div class='big'>"+eur(c.annualRun)+"/yr</div><div class='det'>~"+Math.round(c.weekNow)+" visits/wk \u00b7 "+eur(c.monthRev)+"/mo</div></div>"
    +"<div class='box bruttobox'><div class='lbl'>Brutto pay (pace)</div><div class='big'>"+(isOwner?"\u2014":eur(c.bruttoAnnualNow)+"/yr")+"</div><div class='det'>"+bruttoDetail+"</div></div>"
    +"</div>"
    +"<div class='row'>"
    +"<div><label>Goal is</label><select data-f='type'><option value='brought_in'"+(goalIsBrutto?"":" selected")+">\u20ac brought into clinic</option><option value='brutto'"+(goalIsBrutto?" selected":"")+">\u20ac brutto take-home</option></select></div>"
    +"<div><label>Yearly \u20ac target</label><input type='number' data-f='annual' value='"+(g.annual!=null?g.annual:"")+"' placeholder='120000'></div>"
    +"<div><label>PVA target</label><input type='number' step='0.1' data-f='pva' value='"+(g.pva!=null?g.pva:"")+"' placeholder='12'></div>"
    +"<div><label>Visits/day</label><input type='number' step='0.1' data-f='perDay' value='"+(g.perDay!=null?g.perDay:"")+"' placeholder='opt'></div>"
    +"<button class='btn alt' data-act='update'>Update projection</button>"
    +"</div>"
    +(c.hasGoal?("<div class='prog'><div style='width:"+(pct*100).toFixed(0)+"%;background:"+barCol+"'></div></div>"):"<div class='need'>No goal yet — add one to project and coach toward it.</div>")
    +(needLine?("<div class='need'>"+needLine+"</div>"):"")
    +"<div class='need'>"+pvaLine+"</div>"
    +"<div style='margin-top:10px'><button class='btn' data-act='preview'>Preview SMS</button> <button class='btn send' data-act='send'>Send check-in</button></div>"
    +"<textarea data-ta='1'></textarea><div class='res' data-res='1'></div></div>";
}
function render(){
  if(!DATA) return;
  document.getElementById("src").textContent = DATA.source==="sheet" ? "Goals read live from your Goals sheet." : "Goals read from the file.";
  document.getElementById("cards").innerHTML = DATA.chiros.map(card).join("") + "<div style='text-align:right'><button class='btn send' id='sendall'>Send check-in to everyone with a goal</button></div>";
}
function cardEl(name){ return document.querySelector("[data-name='"+name+"']"); }
function readGoal(el){ var o={}; el.querySelectorAll("[data-f]").forEach(function(i){ var k=i.getAttribute("data-f"); o[k]= (i.tagName==="SELECT")?i.value:(i.value.trim()===""?null:parseFloat(i.value)); }); return o; }
function update(name){
  var el=cardEl(name), g=readGoal(el);
  var body={ name:name, visits30:el.getAttribute("data-v"), pva:el.getAttribute("data-pva"), intakes:el.getAttribute("data-int"), days:el.getAttribute("data-days"), annual:g.annual, pva_target:g.pva, perDay:g.perDay, type:g.type };
  fetch("/goals/recalc",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(j){
    if(!j.ok) return; var c=DATA.chiros.find(function(x){return x.n===name;}); var keep=c.clinics, ph=c.phone; Object.assign(c,j); c.clinics=keep; c.phone=ph; c.goal={annual:g.annual,pva:g.pva,perDay:g.perDay,type:g.type,cadence:(c.goal&&c.goal.cadence)||2}; render(); });
}
function preview(name){ var el=cardEl(name), ta=el.querySelector("[data-ta]"), res=el.querySelector("[data-res]"); res.textContent="Drafting…";
  fetch("/goals/draft?name="+encodeURIComponent(name)).then(function(r){return r.json();}).then(function(j){ if(j.ok){ta.style.display="block";ta.value=j.message;res.textContent="";}else{res.innerHTML="<span style='color:#b45309'>"+(j.error||"could not draft")+"</span>";} }).catch(function(e){res.innerHTML="<span style='color:#dc2626'>"+e+"</span>";}); }
function sendOne(name){ var el=cardEl(name), ta=el.querySelector("[data-ta]"), res=el.querySelector("[data-res]"); var text=ta.style.display==="block"?ta.value:null;
  if(!confirm("Send the goal check-in to "+name+" now?"))return; res.textContent="Sending…";
  fetch("/goals/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({target:name,text:text})}).then(function(r){return r.json();}).then(function(j){ res.innerHTML=j.ok?"<span style='color:#16a34a'>"+j.results.join("; ")+"</span>":"<span style='color:#dc2626'>"+(j.error||"failed")+"</span>"; }).catch(function(e){res.innerHTML="<span style='color:#dc2626'>"+e+"</span>";}); }
function sendAll(){ if(!confirm("Send a goal check-in to every chiro who has a goal set?"))return;
  fetch("/goals/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({target:"all"})}).then(function(r){return r.json();}).then(function(j){ alert(j.ok?("Done:\\n"+j.results.join("\\n")):("Error: "+(j.error||"failed"))); }).catch(function(e){alert("Error: "+e);}); }
function genSave(){ var lines=DATA.chiros.map(function(c){ var g=c.goal||{}; return "  "+c.n+": { annual: "+(g.annual!=null?g.annual:"null")+", pva: "+(g.pva!=null?g.pva:"null")+", perDay: "+(g.perDay!=null?g.perDay:"null")+", cadence: "+((g.cadence)||2)+", type: \\""+((g.type==="brutto")?"brutto":"brought_in")+"\\" },"; });
  var block="const CHIRO_GOALS = {\\n"+lines.join("\\n")+"\\n};"; var el=document.getElementById("savebox"); el.style.display="block"; el.textContent=block; }
document.addEventListener("click",function(e){ var b=e.target.closest("[data-act]"); if(b){ var card=b.closest("[data-name]"); var name=card.getAttribute("data-name"); var a=b.getAttribute("data-act"); if(a==="update")update(name); else if(a==="preview")preview(name); else if(a==="send")sendOne(name); } if(e.target.id==="sendall")sendAll(); });
fetch("/goals/data").then(function(r){return r.json();}).then(function(d){ if(d.error){document.getElementById("cards").innerHTML="<div class='card' style='color:#dc2626'>Couldn't load PracticeHub: "+d.error+"</div>";return;} DATA=d; render(); }).catch(function(e){document.getElementById("cards").innerHTML="<div class='card' style='color:#dc2626'>Load error: "+e+"</div>";});
</script></body></html>`);
});
// ============================================================================
//  META LEADS — lead-quality funnel from the per-clinic "facebook/instagram
//  65 euro intake" sheets. Each lead: date → answered phone (booked / didn't
//  book / call back) → paid intake (showed up) → started care → cancelled.
//  Aggregated by clinic × year × month to compare lead quality across clinics.
//  Live-reads each clinic sheet via gviz CSV (sheets must be link-shared "view").
// ============================================================================
// === META LEAD SHEETS START (add the other two once shared, with their gid) ===
const META_LEAD_SHEETS = {
  Utrecht:   { id:"1Ewa8X-TtxyiYOQmP8RR_8OmSF_h4NnTzgrCJL8mPAKY", gids:["93042368"] },
  Rotterdam: { id:"1ssmloK-0IUuoWo0zKMtRV18M5gijNssTo1HBIyUDx2c", gids:["93042368"] },
  // Amstelveen: { id:"PASTE_ID", gids:["93042368"] },   // share the sheet "anyone with link → viewer", then fill id
  // Bussum:     { id:"PASTE_ID", gids:["93042368"] },
};
// === META LEAD SHEETS END ===

function mlTruthy(v){ const s=String(v||"").trim().toLowerCase(); if(!s) return false; if(["no","n","0","-","false","x"].includes(s)) return false; return true; }
function mlMonthKey(v){ const s=String(v||"").trim(); const m=s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/); if(!m) return null; let mo=parseInt(m[1],10), yr=parseInt(m[3],10); if(yr<100) yr+=2000; if(mo<1||mo>12||yr<2019||yr>2035) return null; return yr+"-"+String(mo).padStart(2,"0"); }
function mlFindCol(header){ const H=header.map(h=>String(h||"").toLowerCase().replace(/\s+/g," ").trim());
  const find=(...names)=>{ for(const nm of names){ const i=H.findIndex(h=>h.includes(nm)); if(i>=0) return i; } return -1; };
  return { date:find("datum","date"), name:find("name","naam"), status:find("answered phone","answered","status"),
    paid:find("paid intake","paid","came","showed","intake done"), care:find("started care","start care","care"),
    cancel:find("cancel"), first:find("1st contact","first contact"), second:find("2nd contact","second contact") };
}
function mlClassify(status){ const s=String(status||"").toLowerCase();
  const booked=/made appointment|made appt|booked|afspraak gemaakt/.test(s);
  const declined=/didn.?t book|didnt book|not interested|geen interesse/.test(s);
  const callback=/call again|call back|callback|text message|whatsapp|no - |niet opgenomen|terugbellen/.test(s) && !booked;
  const reached=booked||declined; // we actually spoke to them
  return { booked, declined, callback, reached, hasStatus:!!s };
}
function mlAggregateRows(rows){
  // find header row
  let hr=-1, cols=null;
  for(let i=0;i<Math.min(rows.length,25);i++){ const c=mlFindCol(rows[i]); if(c.status>=0 && (c.date>=0||c.name>=0)){ hr=i; cols=c; break; } }
  if(hr<0) return { months:{}, totals:blankAgg(), parsed:0 };
  const months={}; let parsed=0;
  for(let r=hr+1;r<rows.length;r++){ const row=rows[r]||[]; const mk=cols.date>=0?mlMonthKey(row[cols.date]):null; if(!mk) continue;
    const nm=cols.name>=0?String(row[cols.name]||"").trim():""; const status=cols.status>=0?row[cols.status]:"";
    if(!nm && !String(status||"").trim()) continue; // skip empty
    const cl=mlClassify(status);
    const paid=cols.paid>=0?mlTruthy(row[cols.paid]):false;
    const care=cols.care>=0?mlTruthy(row[cols.care]):false;
    const cancelled=cols.cancel>=0?mlTruthy(row[cols.cancel]):false;
    parsed++;
    const a = months[mk] || (months[mk]=blankAgg());
    a.leads++; if(cl.reached)a.reached++; if(cl.booked)a.booked++; if(cl.declined)a.declined++; if(cl.callback)a.callback++;
    if(paid)a.paid++; if(care)a.care++; if(cancelled)a.cancelled++;
  }
  return { months, totals:sumAggs(Object.values(months)), parsed };
}
function blankAgg(){ return { leads:0, reached:0, booked:0, declined:0, callback:0, paid:0, care:0, cancelled:0 }; }
function sumAggs(list){ const t=blankAgg(); list.forEach(a=>{ for(const k in t) t[k]+=a[k]||0; }); return t; }

async function mlFetchClinic(id, gids){ const rowsAll=[];
  for(const gid of (gids&&gids.length?gids:[""])){
    const url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv${gid?("&gid="+gid):""}`;
    try{ const r=await fetch(url); if(!r.ok) continue; const csv=await r.text(); const rows=parseCSV(csv); rowsAll.push(...rows); }catch(e){}
  }
  return rowsAll;
}

function mlDemo(){
  const clinics={}; const mk=(y,m)=>y+"-"+String(m).padStart(2,"0");
  const seed={ Amstelveen:[120,0.42,0.78,0.46], Utrecht:[95,0.38,0.72,0.40], Rotterdam:[150,0.30,0.62,0.30], Bussum:[70,0.40,0.75,0.44] };
  Object.keys(seed).forEach(c=>{ const [base,book,show,care]=seed[c]; const months={};
    for(let y=2024;y<=2026;y++){ for(let m=1;m<=(y===2026?6:12);m++){ const leads=Math.round(base/12*(0.7+Math.random()*0.6));
      const booked=Math.round(leads*book*(0.85+Math.random()*0.3)); const reached=Math.round(booked*1.4);
      const paid=Math.round(booked*show); const ca=Math.round(paid*care); months[mk(y,m)]={leads,reached,booked,declined:reached-booked,callback:leads-reached,paid,care:ca,cancelled:Math.round(paid*0.08)}; } }
    clinics[c]={ months, totals:sumAggs(Object.values(months)) }; });
  return clinics;
}

app.get("/meta-leads/data", gate, async (req,res)=>{
  try{
    if(req.query.demo==="1") return res.json({ demo:true, clinics:mlDemo(), configured:["Amstelveen","Utrecht","Rotterdam","Bussum"], missing:[] });
    const clinics={}, missing=[], errors={};
    for(const name of Object.keys(META_LEAD_SHEETS)){ const cfg=META_LEAD_SHEETS[name];
      const rows=await mlFetchClinic(cfg.id, cfg.gids);
      if(!rows.length){ errors[name]="could not read sheet (is it shared 'anyone with link → viewer'?)"; clinics[name]={months:{},totals:blankAgg(),parsed:0}; continue; }
      clinics[name]=mlAggregateRows(rows);
    }
    ["Amstelveen","Bussum"].forEach(c=>{ if(!META_LEAD_SHEETS[c]) missing.push(c); });
    res.json({ clinics, configured:Object.keys(META_LEAD_SHEETS), missing, errors });
  }catch(e){ res.json({ error:e.message }); }
});

app.get("/meta-leads", gate, (req,res)=>{
  const demo = req.query.demo==="1" ? "?demo=1" : "";
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meta lead quality — Posturefixx</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#16202E}
 h1{font-size:23px;margin:0 0 2px}.sub{color:#64748b;font-size:13px;margin:0 0 14px}
 .controls{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
 select{border:1px solid #d1d5db;border-radius:8px;padding:7px 10px;font-size:14px}
 .rank{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
 .rankpill{border:1px solid #e5e7eb;border-radius:12px;padding:10px 14px;min-width:150px;flex:1}
 .rankpill .pos{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em}
 .rankpill .cl{font-size:15px;font-weight:700;margin-top:2px}
 .rankpill .q{font-size:22px;font-weight:800;margin-top:4px}
 .rankpill .v{font-size:11.5px;color:#64748b;margin-top:2px}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
 @media(max-width:720px){.grid{grid-template-columns:1fr}}
 .card{border:1px solid #e5e7eb;border-radius:14px;padding:16px}
 .cname{font-size:16px;font-weight:700;margin-bottom:2px}.cnote{font-size:11.5px;color:#94a3b8;margin-bottom:10px}
 .stage{margin:7px 0}
 .stage .lab{display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px}
 .stage .lab b{font-weight:700}.stage .lab span{color:#64748b}
 .bar{background:#f1f5f9;border-radius:6px;height:18px;overflow:hidden}
 .bar>div{height:100%;border-radius:6px;display:flex;align-items:center;justify-content:flex-end;padding-right:6px;color:#fff;font-size:10.5px;font-weight:600}
 .head{display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid #f1f5f9;margin-top:10px;padding-top:8px}
 .head .big{font-size:20px;font-weight:800}.head .lbl{font-size:11px;color:#94a3b8}
 .warn{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px 12px;font-size:12.5px;color:#92400e;margin-bottom:14px}
 .chartwrap{border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin-top:16px}
 a{color:#2563EB}
</style></head><body>
<h1>Meta lead quality</h1>
<div class="sub">Every Facebook/Instagram lead, by clinic: did we reach them, did they <b>book</b>, did they <b>show up</b> (paid intake), did they <b>start care</b>. This is where you see which clinic gets better leads — and where leads leak out of the funnel. ${demo?"<b>(demo data)</b>":""}</div>
<div class="controls">
 <label>Year <select id="yearSel"></select></label>
 <label>Trend clinic <select id="trendSel"></select></label>
 <span class="sub" style="margin:0"><a href="/marketing">\u2190 marketing</a> \u00b7 <a href="/">home</a></span>
</div>
<div id="warn"></div>
<div id="rank" class="rank"></div>
<div id="grid" class="grid"></div>
<div class="chartwrap"><canvas id="trend" height="120"></canvas></div>
<script>
var RAW=null, CH=null;
var STAGES=[{k:'leads',label:'Leads',col:'#94a3b8'},{k:'reached',label:'Reached on phone',col:'#60a5fa'},{k:'booked',label:'Booked appointment',col:'#2563eb'},{k:'paid',label:'Showed up (paid intake)',col:'#0ea5e9'},{k:'care',label:'Started care',col:'#16a34a'}];
function pct(n,d){ return d>0?Math.round(100*n/d)+'%':'\u2014'; }
function sumMonths(months, yr){ var t={leads:0,reached:0,booked:0,declined:0,callback:0,paid:0,care:0,cancelled:0};
  Object.keys(months||{}).forEach(function(mk){ if(yr==='all'||mk.slice(0,4)===yr){ var a=months[mk]; for(var k in t) t[k]+=a[k]||0; } }); return t; }
function clinicAgg(yr){ var out={}; Object.keys(RAW.clinics).forEach(function(c){ out[c]=sumMonths(RAW.clinics[c].months, yr); }); return out; }
function yearsPresent(){ var s={}; Object.keys(RAW.clinics).forEach(function(c){ Object.keys(RAW.clinics[c].months||{}).forEach(function(mk){ s[mk.slice(0,4)]=1; }); }); return Object.keys(s).sort(); }
function leadToCare(a){ return a.care>0?a.care/a.leads:(a.booked>0?a.booked/a.leads:0); }
function hasShowData(a){ return (a.paid+a.care)>0; }
function render(){
  var yr=document.getElementById('yearSel').value;
  var agg=clinicAgg(yr);
  var clinics=Object.keys(agg).filter(function(c){return agg[c].leads>0;});
  // ranking by lead->care (or booked rate if no show data), volume shown
  var ranked=clinics.slice().sort(function(a,b){ return leadToCare(agg[b])-leadToCare(agg[a]); });
  document.getElementById('rank').innerHTML = ranked.map(function(c,i){ var a=agg[c]; var metric=hasShowData(a)?pct(a.care,a.leads):pct(a.booked,a.leads); var ml=hasShowData(a)?'lead \u2192 care':'lead \u2192 booked';
    return "<div class='rankpill'><div class='pos'>#"+(i+1)+" \u00b7 "+ml+"</div><div class='cl'>"+c+"</div><div class='q'>"+metric+"</div><div class='v'>"+a.leads+" leads \u00b7 "+a.booked+" booked"+(hasShowData(a)?(" \u00b7 "+a.care+" started"):"")+"</div></div>"; }).join("") || "<div class='sub'>No leads for "+yr+".</div>";
  document.getElementById('grid').innerHTML = ranked.map(function(c){ var a=agg[c]; var max=a.leads||1;
    var noShow=!hasShowData(a);
    var stages=STAGES.filter(function(s){ return !(noShow && (s.k==='paid'||s.k==='care')); });
    var rows=stages.map(function(s){ var v=a[s.k]||0; var w=Math.max(2,Math.round(100*v/max));
      return "<div class='stage'><div class='lab'><b>"+s.label+"</b><span>"+v+" \u00b7 "+pct(v,a.leads)+" of leads</span></div><div class='bar'><div style='width:"+w+"%;background:"+s.col+"'>"+(w>14?v:"")+"</div></div></div>"; }).join("");
    var headMetric=noShow?pct(a.booked,a.leads):pct(a.care,a.leads); var headLbl=noShow?"booked rate (no show/care data yet)":"lead \u2192 care";
    return "<div class='card'><div class='cname'>"+c+"</div><div class='cnote'>"+(noShow?"booking data only \u2014 paid-intake / started-care columns empty for this clinic":"full funnel")+"</div>"+rows
      +"<div class='head'><div><div class='lbl'>Booked of reached</div><div class='big'>"+pct(a.booked,a.reached)+"</div></div>"
      +(noShow?"":"<div><div class='lbl'>Showed of booked</div><div class='big'>"+pct(a.paid,a.booked)+"</div></div><div><div class='lbl'>Care of showed</div><div class='big'>"+pct(a.care,a.paid)+"</div></div>")
      +"<div><div class='lbl'>"+headLbl+"</div><div class='big' style='color:#16a34a'>"+headMetric+"</div></div></div></div>"; }).join("");
  drawTrend(yr);
}
function drawTrend(yr){
  var c=document.getElementById('trendSel').value;
  var clinicsList = c==='all'?Object.keys(RAW.clinics):[c];
  // build month axis
  var mset={}; clinicsList.forEach(function(cl){ Object.keys(RAW.clinics[cl].months||{}).forEach(function(mk){ if(yr==='all'||mk.slice(0,4)===yr) mset[mk]=1; }); });
  var labels=Object.keys(mset).sort();
  function series(key){ return labels.map(function(mk){ var s=0; clinicsList.forEach(function(cl){ var a=(RAW.clinics[cl].months||{})[mk]; if(a) s+=a[key]||0; }); return s; }); }
  if(CH) CH.destroy();
  if(!labels.length){ return; }
  CH=new Chart(document.getElementById('trend'),{type:'line',data:{labels:labels,datasets:[
    {label:'Leads',data:series('leads'),borderColor:'#94a3b8',backgroundColor:'transparent',tension:.3},
    {label:'Booked',data:series('booked'),borderColor:'#2563eb',backgroundColor:'transparent',tension:.3},
    {label:'Started care',data:series('care'),borderColor:'#16a34a',backgroundColor:'transparent',tension:.3}
  ]},options:{plugins:{title:{display:true,text:'Monthly Meta leads \u2192 booked \u2192 started care'+(c==='all'?' (all clinics)':' \u2014 '+c)}},scales:{y:{beginAtZero:true}}}});
}
fetch("/meta-leads/data"+${JSON.stringify(demo)}).then(function(r){return r.json();}).then(function(d){
  if(d.error){ document.getElementById('grid').innerHTML="<div class='card' style='color:#dc2626'>Couldn't load: "+d.error+"</div>"; return; }
  RAW=d;
  var warn=""; if(d.missing&&d.missing.length) warn+="Not wired yet: <b>"+d.missing.join(", ")+"</b> \u2014 share those two sheets ('anyone with link \u2192 viewer') and send me the IDs. ";
  if(d.errors&&Object.keys(d.errors).length) warn+="Couldn't read: "+Object.keys(d.errors).map(function(k){return k+" ("+d.errors[k]+")";}).join("; ")+". ";
  document.getElementById('warn').innerHTML = warn?("<div class='warn'>"+warn+"</div>"):"";
  var yrs=yearsPresent(); var ys=document.getElementById('yearSel'); ys.innerHTML="<option value='all'>All years</option>"+yrs.map(function(y){return "<option value='"+y+"'>"+y+"</option>";}).join(""); if(yrs.length) ys.value=yrs[yrs.length-1];
  var ts=document.getElementById('trendSel'); ts.innerHTML="<option value='all'>All clinics</option>"+Object.keys(RAW.clinics).map(function(c){return "<option value='"+c+"'>"+c+"</option>";}).join("");
  ys.addEventListener('change',render); ts.addEventListener('change',function(){drawTrend(document.getElementById('yearSel').value);});
  render();
}).catch(function(e){ document.getElementById('grid').innerHTML="<div class='card' style='color:#dc2626'>Load error: "+e+"</div>"; });
</script></body></html>`);
});

// ============================================================================
//  TABLES — Syntropy chiropractic-table sales: units, your fee, by region, and
//  a signup timeline of when chiropractors buy. Reads the Sales sheet live via
//  gviz CSV (sheet must be link-shared "viewer"). Fysiotech order log (historical
//  chiro-series fulfillment) can be wired as a second source once shared.
// ============================================================================
// === TABLE SHEETS START ===
const TABLE_SHEETS = {
  syntropySales: { id:"12hHpbLJ-csueNxGTNTXDfekVZTwnufcEmAWwGpJB52g", gid:"0" },
  // fysiotechOrders: { id:"1IV3vYnyWa39WBO1ejuqUN8W02D4MYM47swPbRr_T85U", gid:"" }, // historical chiro-series log
};
const USD_EUR = 0.92; // approx, for blending $ and € retail into one figure
// === TABLE SHEETS END ===

function tblYM(s){ s=String(s||"").trim(); if(!s) return null;
  const mon={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const mn=s.match(/([a-z]{3,9})\.?\s+\d{1,2},?\s*(\d{4})/i); if(mn){ const k=mn[1].slice(0,3).toLowerCase(); if(mon[k]) return mn[2]+"-"+String(mon[k]).padStart(2,"0"); }
  const sl=s.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/); if(sl){ let d=+sl[1],mo=+sl[2],y=+sl[3]; if(y<100)y+=2000; if(mo>12&&d<=12){ const t=mo; mo=d; d=t; } if(mo<1||mo>12||y<2019||y>2035) return null; return y+"-"+String(mo).padStart(2,"0"); }
  return null;
}
function tblMoney(s){ s=String(s||"").trim(); if(!s) return {v:0,cur:null}; const cur=/\$/.test(s)?"USD":(/€/.test(s)?"EUR":null);
  let n=s.replace(/[^0-9.,]/g,""); if(!n) return {v:0,cur:cur};
  if(/,\d{2}$/.test(n) && n.indexOf(".")>-1 && n.lastIndexOf(",")>n.lastIndexOf(".")){ n=n.replace(/\./g,"").replace(",","."); }
  else { n=n.replace(/,/g,""); }
  const v=parseFloat(n); return {v:isFinite(v)?v:0, cur:cur};
}
function tblRegion(country){ const c=String(country||"").toLowerCase();
  if(/\bus\b|usa|united states|america/.test(c)) return "USA";
  if(/netherland|german|sweden|finland|\buk\b|united kingdom|spain|france|europe|\bnl\b/.test(c)) return "Europe";
  if(/australia|new zealand/.test(c)) return "Oceania";
  if(/singapore|asia|china|japan|hong kong|malaysia/.test(c)) return "Asia";
  return country ? country.trim().replace(/\b\w/g,m=>m.toUpperCase()) : "Other";
}
function tblFind(header){ const H=header.map(h=>String(h||"").toLowerCase().replace(/\s+/g," ").trim());
  const f=(...n)=>{ for(const nm of n){ const i=H.findIndex(h=>h.includes(nm)); if(i>=0) return i; } return -1; };
  let dateCol=f("date"); if(dateCol<0) dateCol=0; // first col holds the timestamp, header is blank
  return { date:dateCol, country:f("country"), name:f("name"), units:f("number of tables","tables","quantity","pieces"),
    retail:f("retail total","retail"), alex:f("alex fee","alex"), syn:f("syntropy fee","syntropy") };
}
function tblParseSales(rows){
  let hr=-1, c=null;
  for(let i=0;i<Math.min(rows.length,12);i++){ const cc=tblFind(rows[i]); if(cc.units>=0 && (cc.alex>=0||cc.retail>=0)){ hr=i; c=cc; break; } }
  if(hr<0) return { orders:[], parsed:0 };
  const orders=[];
  for(let r=hr+1;r<rows.length;r++){ const row=rows[r]||[]; const ym=tblYM(row[c.date]); if(!ym) continue;
    const name=c.name>=0?String(row[c.name]||"").trim():""; if(!name && !row[c.units]) continue;
    if(/new payment line/i.test(row.join(" "))) continue;
    const uraw=c.units>=0?String(row[c.units]||"").trim():""; const units=parseInt(uraw.replace(/[^0-9]/g,""),10);
    const noSale=/no sale|waiting/i.test(row.join(" "));
    const sold=Number.isFinite(units)&&units>0&&!noSale;
    const ret=c.retail>=0?tblMoney(row[c.retail]):{v:0,cur:null};
    const retailEUR= ret.cur==="USD" ? ret.v*USD_EUR : ret.v;
    const alex=c.alex>=0?tblMoney(row[c.alex]).v:0;
    const syn=c.syn>=0?tblMoney(row[c.syn]).v:0;
    orders.push({ ym, date:String(row[c.date]||"").trim(), name, country:c.country>=0?String(row[c.country]||"").trim():"", region:tblRegion(row[c.country]),
      units:sold?units:0, sold, pending:noSale||(!sold&&!Number.isFinite(units)), retail:ret.v, retailCur:ret.cur, retailEUR, alex, syn });
  }
  return { orders, parsed:orders.length };
}
function tblAggregate(orders){
  const byMonth={}, byRegion={}, byYear={}; let units=0, alexTot=0, synTot=0, retEUR=0, sold=0, pending=0;
  orders.forEach(o=>{ if(o.sold){ units+=o.units; alexTot+=o.alex; synTot+=o.syn; retEUR+=o.retailEUR; sold++;
      (byMonth[o.ym]=byMonth[o.ym]||{units:0,alex:0})&&0; byMonth[o.ym].units+=o.units; byMonth[o.ym].alex+=o.alex;
      const y=o.ym.slice(0,4); byYear[y]=(byYear[y]||0)+o.units;
      const rg=o.region||"Other"; (byRegion[rg]=byRegion[rg]||{units:0,alex:0,retEUR:0}); byRegion[rg].units+=o.units; byRegion[rg].alex+=o.alex; byRegion[rg].retEUR+=o.retailEUR;
    } else { pending++; } });
  return { totals:{ orders:orders.length, soldOrders:sold, pending, units, alexTot, synTot, retEUR }, byMonth, byRegion, byYear };
}

function tblDemo(){
  const regions=[["USA",0.55],["Europe",0.25],["Asia",0.12],["Oceania",0.08]];
  const orders=[]; const names=["Flow Chiro","Above Down","Wellbalanced","NaprapatFix","G3 Chiro","Highlands","Family Wellness","Kairos","MyoLab","FysioDN"];
  for(let y=2025;y<=2026;y++){ for(let m=(y===2025?9:1);m<=(y===2026?6:12);m++){ const n=1+Math.floor(Math.random()*4);
    for(let k=0;k<n;k++){ const rg=regions[Math.floor(Math.random()*regions.length)][0]; const u=1+Math.floor(Math.random()*3);
      const isEU=rg==="Europe"; const alex=isEU?1075*u:1000*u; const retEUR=(isEU?6995:8995*USD_EUR)*u;
      orders.push({ym:y+"-"+String(m).padStart(2,"0"),date:y+"-"+m,name:names[Math.floor(Math.random()*names.length)],country:rg,region:rg,units:u,sold:true,pending:false,retail:retEUR,retailCur:"EUR",retailEUR:retEUR,alex,syn:isEU?3050*u:0}); } } }
  return orders;
}

async function tblFetch(id, gid){ const url=`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv${gid?("&gid="+gid):""}`;
  try{ const r=await fetch(url); if(!r.ok) return null; return parseCSV(await r.text()); }catch(e){ return null; } }

app.get("/tables/data", gate, async (req,res)=>{
  try{
    if(req.query.demo==="1"){ const orders=tblDemo(); return res.json({ demo:true, ...tblAggregate(orders), orders:orders.slice(-30).reverse() }); }
    const cfg=TABLE_SHEETS.syntropySales; const rows=await tblFetch(cfg.id, cfg.gid);
    if(!rows){ return res.json({ error:"could not read the Sales sheet \u2014 is it shared 'anyone with link \u2192 viewer'?" }); }
    const { orders }=tblParseSales(rows);
    res.json({ ...tblAggregate(orders), orders:orders.slice().reverse().slice(0,40), usdEur:USD_EUR });
  }catch(e){ res.json({ error:e.message }); }
});

app.get("/tables", gate, (req,res)=>{
  const demo = req.query.demo==="1" ? "?demo=1" : "";
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Table sales — Posturefixx</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#16202E}
 h1{font-size:23px;margin:0 0 2px}.sub{color:#64748b;font-size:13px;margin:0 0 14px}
 .kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
 .kpi{flex:1;min-width:150px;border:1px solid #e5e7eb;border-radius:12px;padding:14px}
 .kpi .v{font-size:24px;font-weight:800}.kpi .l{font-size:11.5px;color:#64748b;margin-top:2px}
 .card{border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin-bottom:14px}
 .card h3{margin:0 0 10px;font-size:15px}
 .rg{display:flex;align-items:center;gap:10px;margin:6px 0}
 .rg .nm{width:90px;font-size:13px;font-weight:600}
 .rg .bar{flex:1;background:#f1f5f9;border-radius:6px;height:18px;overflow:hidden}
 .rg .bar>div{height:100%;background:#2563eb;border-radius:6px}
 .rg .vl{width:150px;text-align:right;font-size:12px;color:#475569}
 table{border-collapse:collapse;width:100%;font-size:12.5px}td,th{padding:7px 6px;border-bottom:1px solid #f4f6f9;text-align:right}th{color:#64748b;font-size:10.5px;text-transform:uppercase}td:first-child,th:first-child,td:nth-child(2),th:nth-child(2){text-align:left}
 .pill{font-size:10px;padding:1px 7px;border-radius:999px}.pill.sold{background:#ecfdf5;color:#16a34a}.pill.pend{background:#fef3c7;color:#b45309}
 .warn{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px 12px;font-size:12.5px;color:#92400e;margin-bottom:14px}
 a{color:#2563EB}
</style></head><body>
<h1>Chiropractic table sales</h1>
<div class="sub">Syntropy tables sold to chiropractors worldwide: units, <b>your fee</b>, where the buyers are, and when they sign up. ${demo?"<b>(demo data)</b>":""}</div>
<div id="warn"></div>
<div class="kpis" id="kpis"></div>
<div class="card"><h3>When chiropractors buy (units per month)</h3><canvas id="timeline" height="110"></canvas></div>
<div class="card"><h3>By region \u2014 who's buying</h3><div id="regions"></div></div>
<div class="card"><h3>Recent orders</h3><div style="overflow-x:auto"><table id="orders"><thead><tr><th>Date</th><th>Customer</th><th>Country</th><th>Units</th><th>Retail</th><th>Your fee</th><th>Status</th></tr></thead><tbody></tbody></table></div></div>
<p class="sub">Pages: <a href="/">home</a> \u00b7 <a href="/profit">/profit</a> \u00b7 <a href="/revenue">/revenue</a></p>
<script>
function eur(n){return "\u20ac"+Math.round(n||0).toLocaleString("en-US");}
function render(d){
  if(d.error){ document.getElementById("kpis").innerHTML="<div class='kpi' style='color:#dc2626'>"+d.error+"</div>"; return; }
  var t=d.totals;
  document.getElementById("kpis").innerHTML=[
    ["v","<div class='v'>"+t.units+"</div><div class='l'>tables sold</div>"],
    ["v","<div class='v'>"+eur(t.alexTot)+"</div><div class='l'>your fee (total)</div>"],
    ["v","<div class='v'>"+t.soldOrders+"</div><div class='l'>paid orders"+(t.pending?(" \u00b7 "+t.pending+" pending"):"")+"</div>"],
    ["v","<div class='v'>"+eur(t.retEUR)+"</div><div class='l'>retail value (\u20ac-equiv)</div>"]
  ].map(function(x){return "<div class='kpi'>"+x[1]+"</div>";}).join("");
  // regions
  var rg=d.byRegion||{}; var keys=Object.keys(rg).sort(function(a,b){return rg[b].units-rg[a].units;});
  var max=keys.reduce(function(m,k){return Math.max(m,rg[k].units);},1);
  document.getElementById("regions").innerHTML=keys.map(function(k){var r=rg[k];return "<div class='rg'><div class='nm'>"+k+"</div><div class='bar'><div style='width:"+(100*r.units/max)+"%'></div></div><div class='vl'>"+r.units+" tables \u00b7 "+eur(r.alex)+" fee</div></div>";}).join("")||"<div class='sub'>No region data.</div>";
  // orders
  document.querySelector("#orders tbody").innerHTML=(d.orders||[]).map(function(o){return "<tr><td>"+o.date+"</td><td>"+o.name+"</td><td>"+(o.country||"")+"</td><td>"+(o.sold?o.units:"\u2014")+"</td><td>"+(o.retail?((o.retailCur==="USD"?"$":"\u20ac")+Math.round(o.retail).toLocaleString("en-US")):"\u2014")+"</td><td>"+(o.alex?eur(o.alex):"\u2014")+"</td><td><span class='pill "+(o.sold?"sold":"pend")+"'>"+(o.sold?"paid":"pending")+"</span></td></tr>";}).join("");
  // timeline
  var bm=d.byMonth||{}; var labels=Object.keys(bm).sort(); var units=labels.map(function(k){return bm[k].units;}); var cum=[],run=0; units.forEach(function(u){run+=u;cum.push(run);});
  new Chart(document.getElementById("timeline"),{data:{labels:labels,datasets:[
    {type:"bar",label:"Tables sold",data:units,backgroundColor:"#2563eb",yAxisID:"y"},
    {type:"line",label:"Cumulative",data:cum,borderColor:"#16a34a",backgroundColor:"transparent",tension:.3,yAxisID:"y1"}
  ]},options:{scales:{y:{beginAtZero:true,position:"left",title:{display:true,text:"per month"}},y1:{beginAtZero:true,position:"right",grid:{drawOnChartArea:false},title:{display:true,text:"cumulative"}}}}});
}
fetch("/tables/data"+${JSON.stringify(demo)}).then(function(r){return r.json();}).then(function(d){
  if(!d.error){ var w=""; if(!${JSON.stringify(!!demo)}) w="Reading the Sales sheet live. The <b>Fysiotech order log</b> (historical chiro-series tables + serial numbers/shipping) isn't wired yet \u2014 say the word and I'll add it as a second view. Retail blends $ at ~"+(d.usdEur||0.92)+" \u20ac/$."; if(w) document.getElementById("warn").innerHTML="<div class='warn'>"+w+"</div>"; }
  render(d);
}).catch(function(e){ document.getElementById("kpis").innerHTML="<div class='kpi' style='color:#dc2626'>Load error: "+e+"</div>"; });
</script></body></html>`);
});

app.get("/coach/cron", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.query.key !== secret) return res.status(403).json({ ok: false, error: "forbidden" });
  const target = parseInt(process.env.COACH_TARGET) || parseInt(req.query.target) || 1100000;
  const until = (req.query.until || process.env.COACH_UNTIL || "").trim();
  try {
    const ams = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Amsterdam" }));
    const dow = ams.getDay(); // 0=Sun .. 6=Sat
    const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dow];

    // Campaign window: stop after `until`
    if (until) {
      const end = new Date(until + "T23:59:59+02:00");
      if (!isNaN(end.getTime()) && ams > end) {
        await notifyOwner(`Posturefixx auto-coaching ended on ${until}. To keep it going, set a later end date on the scheduler URL (until=YYYY-MM-DD) or COACH_UNTIL in Render.`).catch(()=>{});
        return res.json({ ok: true, action: "campaign-ended", until });
      }
    }

    // PREVIEW day: Sunday (for Monday) or Wednesday (for Thursday)
    if (dow === 0 || dow === 3) {
      const sendDay = dow === 0 ? "Monday" : "Thursday";
      const goals = chiroGoals(target, await chiroBaselines(30));
      const lines = await Promise.all(goals.map(async g => {
        const msg = g.phone ? await draftCoaching(g) : "(no phone set - will be skipped)";
        return `- ${g.n} (to ${g.smsClinic}): ${msg}`;
      }));
      const body = `Coaching preview - these go out ${sendDay} 9:00 to your chiros:\n\n${lines.join("\n\n")}\n\nReview or adjust: ${APP_URL}/coach${until ? `\nAuto-send runs until ${until}.` : ""}\n(Final versions use ${sendDay}'s latest numbers.)`;
      await notifyOwner(body);
      console.log("[coach/cron] preview sent for", sendDay);
      return res.json({ ok: true, action: "preview-sent", for: sendDay });
    }

    // SEND day: Monday & Thursday
    if (dow === 1 || dow === 4) {
      const goals = chiroGoals(target, await chiroBaselines(30));
      const results = await Promise.all(goals.map(async g => {
        if (!g.phone) return `${g.n}: skipped (no phone)`;
        try { const msg = await draftCoaching(g); await sendSms(g.smsClinic, g.phone, g.n, msg); return `${g.n}: sent`; }
        catch (e) { return `${g.n}: failed - ${e.message}`; }
      }));
      console.log("[coach/cron]", dayName, results.join(" | "));
      return res.json({ ok: true, action: "sent", day: dayName, results });
    }

    return res.json({ ok: true, action: "nothing-today", day: dayName });
  } catch (e) {
    console.error("[coach/cron] error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ============================================================================
//  /revenue — per-clinic monthly revenue. Pick a single year (clean read + an
//  auto summary of highs/lows/standout months) or "All" to overlay every year.
//  Real cash-in from the MT940 bank exports; matches the /plan P&L basis.
// ============================================================================
const BANK_REV = {"Bussum":{"2026":[10229,6989,14352,16379,12939,null,null,null,null,null,null,null],"2025":[14733,10220,15685,14648,12459,12181,15666,14123,14817,14471,14525,15325],"2024":[13930,8318,8724,20207,15907,13612,19508,12283,14032,12646,12755,11248],"2023":[18590,14369,11717,15348,13801,11995,16861,11472,12167,15929,9613,10129],"2022":[null,0,70,3927,10156,11381,13009,17288,16518,13651,12357,11433]},"Rotterdam":{"2026":[13594,13651,16057,14333,13113,null,null,null,null,null,null,null],"2025":[null,null,null,null,null,null,25000,3550,6801,7098,8580,7118]},"Utrecht":{"2026":[21701,14351,18680,20538,22353,null,null,null,null,null,null,null],"2025":[20981,18072,22391,19586,18933,19250,18303,20430,20793,18721,20609,12634],"2024":[30110,24482,20532,22944,22996,21128,22877,22367,24941,22673,27035,23430],"2023":[30891,23347,25682,21796,30444,24480,21241,21363,20749,26169,24960,23607],"2022":[20045,22950,15434,14606,17695,16722,19143,24110,19190,20018,19040,23192],"2021":[null,null,33101,440,5017,7796,8253,10030,14635,9789,11265,15978]},"Amstelveen":{"2026":[31536,29530,31635,28562,28879,null,null,null,null,null,null,null],"2025":[28112,23654,33273,28117,28306,25771,27801,27464,28169,29066,30926,27392],"2024":[16579,15677,17043,22228,19165,17491,21251,24405,22823,23881,28582,22726],"2023":[null,null,null,null,46767,194,2040,11708,15628,22915,16029,15209]},"Holding":{"2026":[19116,14513,22905,10608,38304,null,null,null,null,null,null,null],"2025":[10463,10532,14123,4407,17906,48590,8036,5303,6484,7679,15550,12172],"2024":[15909,4850,5200,9797,11403,7409,19130,9695,8309,8704,7822,7922],"2023":[18007,8551,7315,8046,21123,8887,6464,4850,3784,16292,3990,9313],"2022":[1002,6475,3405,4286,7678,9186,4046,9894,6864,7307,16883,12479],"2021":[962,7333,0,5198,827,121,0,949,363,0,0,302],"2020":[null,null,null,null,null,null,1000,464,283,121,0,368]}};
const REV_ORDER = ["Amstelveen","Utrecht","Bussum","Rotterdam","Holding"];
const YEAR_COLOR = {2020:"#cbd5e1",2021:"#94a3b8",2022:"#64748b",2023:"#0891b2",2024:"#7c3aed",2025:"#16a34a",2026:"#2563eb"};
function projectYear(arr){
  const pts=arr.map((v,i)=>[i,v]).filter(p=>p[1]!=null);
  if(pts.length<3) return Array(12).fill(null);
  const n=pts.length,sx=pts.reduce((a,p)=>a+p[0],0),sy=pts.reduce((a,p)=>a+p[1],0);
  const sxy=pts.reduce((a,p)=>a+p[0]*p[1],0),sxx=pts.reduce((a,p)=>a+p[0]*p[0],0);
  const m=(n*sxy-sx*sy)/(n*sxx-sx*sx),b=(sy-m*sx)/n,last=pts[pts.length-1][0];
  return Array.from({length:12},(_,i)=> i>last?Math.max(0,Math.round(m*i+b)):null);
}

app.get("/revenue", gate, async (_req,res)=>{ try {
  const fmt=n=>"\u20ac"+Math.round(n||0).toLocaleString("en-US");
  const sum=a=>a.filter(v=>v!=null).reduce((x,y)=>x+y,0);
  const panels=REV_ORDER.map(c=>{
    const years=Object.keys(BANK_REV[c]||{}).sort();
    const yt={}; years.forEach(y=>yt[y]=sum(BANK_REV[c][y]));
    const last=years.filter(y=>y!=="2026").pop(), prev=years.filter(y=>y!=="2026"&&y<last).pop();
    const yoy=(last&&prev)?((yt[last]/yt[prev]-1)*100):null;
    let projFull=null; if(BANK_REV[c]["2026"]){ const done=sum(BANK_REV[c]["2026"]); projFull=done+sum(projectYear(BANK_REV[c]["2026"])); }
    const arrow=yoy==null?"":(yoy>=5?"\u25b2":yoy<=-5?"\u25bc":"\u25ac");
    const btns=["All"].concat(years).map(s=>`<button data-rv="${c}" data-sel="${s}" onclick='drawRev("${c}","${s}")' style="padding:5px 11px;margin:0 6px 6px 0;border:1px solid #e5e7eb;background:#fff;border-radius:6px;font-size:12px;cursor:pointer;color:#6B7686">${s==="All"?"All (overlay)":s+(s==="2026"?" YTD":"")}</button>`).join("");
    return `<section data-clinic="${c}" style="display:${c===REV_ORDER[0]?"":"none"}">
      <div class="kpis">
        <div class="kpi"><b>${fmt(yt[last])}</b><span>${last} revenue</span></div>
        <div class="kpi"><b>${yoy==null?"\u2014":(yoy>=0?"+":"")+yoy.toFixed(0)+"%"}</b><span>${prev||""}\u2192${last||""} YoY ${arrow}</span></div>
        <div class="kpi"><b>${projFull?fmt(projFull):"\u2014"}</b><span>2026 projected</span></div>
      </div>
      <div style="margin:4px 0">${btns}</div>
      <div class="card"><div id="rv-${c}"></div><div class="legend">Each line is one calendar year (cash-in). 2026 dashed = projected to year-end. Hover a point for the month.</div></div>
      <div id="rs-${c}" class="advice">Pick a single year above for a summary, or All to compare every year.</div>
    </section>`;
  }).join("");
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revenue by clinic \u2014 Posturefixx</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:880px;margin:24px auto;padding:0 16px;color:#16202E}
h1{font-size:22px;margin:0 0 2px}.sub{color:#64748b;font-size:13px;margin-bottom:18px}
.tabs{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}.tab{padding:8px 14px;border-radius:8px;background:#f1f5f9;cursor:pointer;font-size:13px;font-weight:600}.tab.on{background:#16202E;color:#fff}
.card{border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:14px}.legend{font-size:12px;color:#64748b;margin-top:10px;line-height:1.5}
.advice{background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;padding:12px 14px;border-radius:10px;font-size:13.5px;line-height:1.6;margin-bottom:16px}
.kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}.kpi{flex:1;min-width:150px;border:1px solid #e5e7eb;border-radius:10px;padding:12px}.kpi b{font-size:20px;display:block}.kpi span{font-size:12px;color:#64748b}
a{color:#2563EB}</style></head><body>
<h1>Revenue by clinic \u2014 year over year</h1><div class="sub">Real cash-in from your MT940 bank exports \u00b7 matches the /plan P&L</div>
<div class="tabs" id="tabs"></div>${panels}
<p class="sub">Pages: <a href="/plan">/plan</a> \u00b7 <a href="/revenue">/revenue</a> \u00b7 <a href="/marketing">/marketing</a> \u00b7 <a href="/waste">/waste</a> \u00b7 <a href="/pva">/pva</a> \u00b7 <a href="/ca">/ca</a> \u00b7 <a href="/coach">/coach</a></p>
<script>
var BR={"Bussum":{"2026":[10229,6989,14352,16379,12939,null,null,null,null,null,null,null],"2025":[14733,10220,15685,14648,12459,12181,15666,14123,14817,14471,14525,15325],"2024":[13930,8318,8724,20207,15907,13612,19508,12283,14032,12646,12755,11248],"2023":[18590,14369,11717,15348,13801,11995,16861,11472,12167,15929,9613,10129],"2022":[null,0,70,3927,10156,11381,13009,17288,16518,13651,12357,11433]},"Rotterdam":{"2026":[13594,13651,16057,14333,13113,null,null,null,null,null,null,null],"2025":[null,null,null,null,null,null,25000,3550,6801,7098,8580,7118]},"Utrecht":{"2026":[21701,14351,18680,20538,22353,null,null,null,null,null,null,null],"2025":[20981,18072,22391,19586,18933,19250,18303,20430,20793,18721,20609,12634],"2024":[30110,24482,20532,22944,22996,21128,22877,22367,24941,22673,27035,23430],"2023":[30891,23347,25682,21796,30444,24480,21241,21363,20749,26169,24960,23607],"2022":[20045,22950,15434,14606,17695,16722,19143,24110,19190,20018,19040,23192],"2021":[null,null,33101,440,5017,7796,8253,10030,14635,9789,11265,15978]},"Amstelveen":{"2026":[31536,29530,31635,28562,28879,null,null,null,null,null,null,null],"2025":[28112,23654,33273,28117,28306,25771,27801,27464,28169,29066,30926,27392],"2024":[16579,15677,17043,22228,19165,17491,21251,24405,22823,23881,28582,22726],"2023":[null,null,null,null,46767,194,2040,11708,15628,22915,16029,15209]},"Holding":{"2026":[19116,14513,22905,10608,38304,null,null,null,null,null,null,null],"2025":[10463,10532,14123,4407,17906,48590,8036,5303,6484,7679,15550,12172],"2024":[15909,4850,5200,9797,11403,7409,19130,9695,8309,8704,7822,7922],"2023":[18007,8551,7315,8046,21123,8887,6464,4850,3784,16292,3990,9313],"2022":[1002,6475,3405,4286,7678,9186,4046,9894,6864,7307,16883,12479],"2021":[962,7333,0,5198,827,121,0,949,363,0,0,302],"2020":[null,null,null,null,null,null,1000,464,283,121,0,368]}};
var YC={2020:"#cbd5e1",2021:"#94a3b8",2022:"#64748b",2023:"#0891b2",2024:"#7c3aed",2025:"#16a34a",2026:"#2563eb"};
var MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
var eur=function(n){return "\u20ac"+Math.round(n||0).toLocaleString("en-US");};
function projC(arr){var pts=[];arr.forEach(function(v,i){if(v!=null)pts.push([i,v]);});if(pts.length<3)return null;
  var n=pts.length,sx=0,sy=0,sxy=0,sxx=0;pts.forEach(function(p){sx+=p[0];sy+=p[1];sxy+=p[0]*p[1];sxx+=p[0]*p[0];});
  var m=(n*sxy-sx*sy)/(n*sxx-sx*sx),b=(sy-m*sx)/n,last=pts[pts.length-1][0];
  return MN.map(function(_,i){return i>last?Math.max(0,Math.round(m*i+b)):null;});}
function drawRev(clinic,sel){
  var yd=BR[clinic]||{}, allY=Object.keys(yd).sort(), single=sel!=="All", years=single?[sel]:allY;
  var W=720,H=360,pL=54,pR=70,pT=14,pB=28;
  var proj=(years.indexOf("2026")>=0&&yd["2026"])?projC(yd["2026"]):null;
  var vals=[1]; years.forEach(function(y){(yd[y]||[]).forEach(function(v){if(v!=null)vals.push(v);});}); if(proj)proj.forEach(function(v){if(v!=null)vals.push(v);});
  var max=Math.max.apply(null,vals)*1.12;
  var x=function(i){return pL+(i/11)*(W-pL-pR);}, y=function(v){return H-pB-(v/max)*(H-pT-pB);};
  var step=max>40000?10000:max>20000?5000:2000, g="";
  for(var t=0;t<=max;t+=step){g+="<line x1='"+pL+"' x2='"+(W-pR)+"' y1='"+y(t)+"' y2='"+y(t)+"' stroke='#eef2f7'/><text x='"+(pL-8)+"' y='"+(y(t)+4)+"' text-anchor='end' font-size='10' fill='#94a3b8'>\u20ac"+((t/1000)|0)+"k</text>";}
  MN.forEach(function(m,i){g+="<text x='"+x(i)+"' y='"+(H-10)+"' text-anchor='middle' font-size='10' fill='#94a3b8'>"+m+"</text>";});
  var li=0;
  years.forEach(function(yr){var col=YC[yr]||"#475569",emph=(single||yr==="2026"),arr=yd[yr]||[],pts=[];
    arr.forEach(function(v,i){if(v!=null)pts.push(x(i)+","+y(v));});
    if(pts.length>1)g+="<polyline points='"+pts.join(" ")+"' fill='none' stroke='"+col+"' stroke-width='"+(emph?3:1.8)+"'/>";
    arr.forEach(function(v,i){if(v!=null)g+="<circle cx='"+x(i)+"' cy='"+y(v)+"' r='"+(emph?3:2)+"' fill='"+col+"'><title>"+MN[i]+" "+yr+": "+eur(v)+"</title></circle>";});
    g+="<text x='"+(W-pR+8)+"' y='"+(20+li*15)+"' font-size='11' fill='"+col+"' font-weight='"+(emph?700:400)+"'>"+yr+"</text>";li++;});
  if(proj){var a=yd["2026"],lastA=-1;a.forEach(function(v,i){if(v!=null)lastA=i;});var pb=proj.slice();if(lastA>=0)pb[lastA]=a[lastA];
    var pp=[];pb.forEach(function(v,i){if(v!=null)pp.push(x(i)+","+y(v));});if(pp.length>1)g+="<polyline points='"+pp.join(" ")+"' fill='none' stroke='#2563eb' stroke-width='2' stroke-dasharray='5 4'/>";
    g+="<text x='"+(W-pR+8)+"' y='"+(20+li*15)+"' font-size='10' fill='#2563eb'>2026 proj</text>";}
  document.getElementById("rv-"+clinic).innerHTML="<svg viewBox='0 0 "+W+" "+H+"' width='100%'>"+g+"</svg>";
  Array.prototype.forEach.call(document.querySelectorAll("button[data-rv='"+clinic+"']"),function(b){var on=b.getAttribute("data-sel")===sel;b.style.background=on?"#16202E":"#fff";b.style.color=on?"#fff":"#6B7686";b.style.borderColor=on?"#16202E":"#e5e7eb";});
  var se=document.getElementById("rs-"+clinic);
  if(se) se.innerHTML = single ? revSummary(clinic,sel) : "Comparing every year. Pick a single year above for a clean read and a summary of its highs, lows and standout months.";
}
function revSummary(clinic,year){
  var arr=(BR[clinic]||{})[year]||[], vals=[]; arr.forEach(function(v,i){if(v!=null)vals.push({m:i,v:v});});
  if(!vals.length) return "No data for "+year+".";
  var total=vals.reduce(function(a,o){return a+o.v;},0), avg=total/vals.length, hi=vals[0], lo=vals[0];
  vals.forEach(function(o){if(o.v>hi.v)hi=o;if(o.v<lo.v)lo=o;});
  var good=[], bad=[];
  good.push("best month <b>"+MN[hi.m]+"</b> ("+eur(hi.v)+")");
  bad.push("weakest <b>"+MN[lo.m]+"</b> ("+eur(lo.v)+")");
  var prevArr=(BR[clinic]||{})[(+year-1)+""];
  if(prevArr){var cn=0,pn=0;arr.forEach(function(v,i){if(v!=null&&prevArr[i]!=null){cn+=v;pn+=prevArr[i];}});
    if(pn>0){var ch=(cn/pn-1)*100, lk=vals.length<12?" (like-for-like months)":""; (ch>=3?good:ch<=-3?bad:good).push((ch>=0?"up ":"down ")+Math.abs(ch).toFixed(0)+"% vs "+(year-1)+lk);}}
  var strong=vals.filter(function(o){return o.v>1.2*avg;}).map(function(o){return MN[o.m];});
  var weak=vals.filter(function(o){return o.v<0.75*avg;}).map(function(o){return MN[o.m];});
  if(strong.length) good.push("standout: "+strong.join(", "));
  if(weak.length) bad.push("dipped in "+weak.join(", "));
  if(vals.length>=8){var h1=[],h2=[];arr.forEach(function(v,i){if(v!=null){(i<6?h1:h2).push(v);} });
    if(h1.length&&h2.length){var a1=h1.reduce(function(a,b){return a+b;},0)/h1.length,a2=h2.reduce(function(a,b){return a+b;},0)/h2.length;
      if(a2>a1*1.08)good.push("second half stronger");else if(a2<a1*0.92)bad.push("second half softened");}}
  return "<b>"+clinic+" "+year+(vals.length<12?" (YTD)":"")+" \u2014 "+eur(total)+"</b>"+
    "<br><b style='color:#15803d'>\u2714 Good:</b> "+good.join("; ")+
    "<br><b style='color:#b91c1c'>\u26a0 Watch:</b> "+bad.join("; ");
}
var cs=["Amstelveen","Utrecht","Bussum","Rotterdam","Holding"],el=document.getElementById("tabs");
function show(c){Array.prototype.forEach.call(document.querySelectorAll("[data-clinic]"),function(s){s.style.display=s.getAttribute("data-clinic")===c?"":"none"});Array.prototype.forEach.call(el.children,function(b){b.className="tab"+(b.textContent===c?" on":"")})}
cs.forEach(function(c){var b=document.createElement("div");b.className="tab";b.textContent=c;b.onclick=function(){show(c)};el.appendChild(b)});
cs.forEach(function(c){drawRev(c,"All");});
show("Amstelveen");
</script>
</body></html>`);
} catch(e){ res.status(500).send("revenue error: "+e.message); } });

// ============================================================================
//  /marketing — PER CLINIC: monthly ad spend (Google / Meta / Organic) with a
//  year selector, plus cost-per-lead by channel. "Compare" overlays clinics.
//  Google + Meta = ad spend to the platforms; Organic = Shoet agency/social.
// ============================================================================
const MKTG_CLINIC = {"Utrecht":{"Google":{"2026":4641,"2025":10111,"2024":9770,"2023":8460,"2022":13872,"2021":5447},"Meta":{"2026":1040,"2025":2801,"2024":7176,"2023":8984,"2022":6608,"2021":1937},"Shoet":{"2026":681,"2025":4568,"2024":4217,"2023":641}},"Bussum":{"Google":{"2026":1585,"2025":5368,"2024":8489,"2023":5294,"2022":3599},"Meta":{"2026":1240,"2025":2450,"2024":2600,"2023":5035,"2022":908},"Shoet":{"2026":681,"2025":4568,"2024":2565,"2023":321}},"Amstelveen":{"Google":{"2026":4051,"2025":13997,"2024":13026,"2023":3233},"Meta":{"2026":5340,"2025":13695,"2024":10230,"2023":4631},"Shoet":{"2026":681,"2025":4568,"2024":2886,"2023":2716}},"Rotterdam":{"Google":{"2026":1721,"2025":630},"Meta":{"2026":5240,"2025":1665},"Shoet":{"2026":1001}},"Group":{"Meta":{"2024":4159},"Shoet":{"2025":27622,"2024":1565,"2023":302}}};
const MKTG_CLINIC_M = {"Utrecht":{"Google":{"2026":[790,806,886,971,944,null,null,null,null,null,null,null],"2025":[752,822,821,766,838,868,888,869,875,913,900,799],"2024":[766,646,778,990,1011,841,703,654,724,923,951,782],"2023":[996,298,962,265,889,522,314,998,1135,631,742,709],"2022":[1000,2000,1500,1500,1343,1399,1619,758,1020,694,752,288],"2021":[null,null,null,null,250,700,1000,500,500,1000,497,1000]},"Meta":{"2026":[200,200,null,200,null,null,null,null,null,null,null,null],"2025":[200,200,200,200,200,200,200,200,300,340,361,200],"2024":[1212,830,1239,1114,485,949,346,200,200,200,200,200],"2023":[656,366,434,228,131,34,1307,1230,1391,1141,1181,885],"2022":[218,244,330,573,817,516,452,702,492,530,678,1054],"2021":[null,null,null,50,11,11,279,260,279,207,394,445]},"Organic":{"2026":[null,681,null,null,null,null,null,null,null,null,null,null],"2025":[null,null,null,1210,605,null,null,333,605,1210,605,null],"2024":[1331,null,321,321,641,641,null,321,321,null,321,null],"2023":[null,null,null,null,null,null,null,null,null,null,321,321]}},"Bussum":{"Google":{"2026":[266,287,261,266,287,null,null,null,null,null,null,null],"2025":[705,740,105,393,768,102,403,424,420,452,456,401],"2024":[340,370,390,810,813,886,818,784,819,862,876,721],"2023":[1080,813,116,566,494,330,199,205,150,337,584,420],"2022":[null,null,null,250,832,378,224,161,245,317,1037,157]},"Meta":{"2026":[200,200,200,400,null,null,null,null,null,null,null,null],"2025":[200,200,200,200,200,200,200,350,300,null,200,200],"2024":[200,200,200,200,200,200,200,200,200,400,200,200],"2023":[780,374,452,486,775,308,1040,821,null,null,null,null],"2022":[null,null,null,null,1,null,null,null,null,null,null,907]},"Organic":{"2026":[null,681,null,null,null,null,null,null,null,null,null,null],"2025":[null,null,null,605,1210,null,333,null,605,1210,605,null],"2024":[321,321,321,321,null,321,321,null,321,null,321,null],"2023":[null,null,null,null,null,null,null,null,null,null,321,null]}},"Amstelveen":{"Google":{"2026":[773,864,709,683,730,null,null,null,null,null,null,null],"2025":[1255,1331,1191,1222,1204,822,1632,1280,1364,869,1018,809],"2024":[831,761,880,1574,967,1068,661,717,1573,1352,1356,1285],"2023":[null,null,null,null,null,null,null,457,226,964,808,778]},"Meta":{"2026":[900,1000,850,1150,700,null,null,null,null,null,null,null],"2025":[750,1200,1600,1300,1325,1300,1250,600,1450,1220,1050,650],"2024":[1050,300,700,1250,1280,800,700,850,600,950,1050,700],"2023":[null,null,null,null,null,null,200,581,1100,1350,800,600]},"Organic":{"2026":[null,681,null,null,null,null,null,null,null,null,null,null],"2025":[null,null,null,1210,605,null,333,null,605,1210,605,null],"2024":[null,321,641,321,321,null,321,321,641,null,null,null],"2023":[null,null,null,null,null,null,null,null,726,484,null,1506]}},"Rotterdam":{"Google":{"2026":[244,242,305,281,349,null,null,null,null,null,null,null],"2025":[null,null,null,null,null,null,null,null,60,46,213,311]},"Meta":{"2026":[500,900,900,1250,850,null,null,null,null,null,null,null],"2025":[null,null,null,null,null,null,null,null,null,340,650,675]},"Organic":{"2026":[321,681,null,null,null,null,null,null,null,null,null,null]}}};
const MKTG_CPL = {"Utrecht":{"Google":{"spend":4397,"leads":111,"cpl":40},"Meta":{"spend":600,"leads":54,"cpl":11},"Organic":{"spend":681,"leads":58,"cpl":12}},"Bussum":{"Google":{"spend":1367,"leads":71,"cpl":19},"Meta":{"spend":1000,"leads":32,"cpl":31},"Organic":{"spend":681,"leads":24,"cpl":28}},"Amstelveen":{"Google":{"spend":3759,"leads":144,"cpl":26},"Meta":{"spend":4600,"leads":97,"cpl":47},"Organic":{"spend":681,"leads":58,"cpl":12}},"Rotterdam":{"Google":{"spend":1421,"leads":103,"cpl":14},"Meta":{"spend":4400,"leads":117,"cpl":38},"Organic":{"spend":1002,"leads":null,"cpl":null}}};
const MKTG_LEADS_M = {"Utrecht":{"Google":{"intakes":[28,25,20,17,21],"care":[6,5,5,2,5]},"Meta":{"intakes":[15,9,18,8,4],"care":[1,2,1,1,0]}},"Bussum":{"Google":{"intakes":[13,11,17,11,19],"care":[1,0,4,2,5]},"Meta":{"intakes":[2,4,15,5,6],"care":[0,0,2,1,1]}},"Amstelveen":{"Google":{"intakes":[32,34,29,21,28],"care":[8,11,10,8,13]},"Meta":{"intakes":[30,10,30,17,10],"care":[10,2,4,4,4]}},"Rotterdam":{"Google":{"intakes":[21,21,17,20,24],"care":[5,5,5,3,5]},"Meta":{"intakes":[27,16,31,25,18],"care":[4,4,2,3,2]}}};
const MKTG_FUNNEL = {"Utrecht":{"Google":{"intakes":111,"care":23},"Meta":{"intakes":54,"care":5}},"Bussum":{"Google":{"intakes":71,"care":12},"Meta":{"intakes":32,"care":4}},"Amstelveen":{"Google":{"intakes":144,"care":50},"Meta":{"intakes":97,"care":24}},"Rotterdam":{"Google":{"intakes":103,"care":23},"Meta":{"intakes":117,"care":15}}};
const MKTG_CLINICS = ["Utrecht","Bussum","Amstelveen","Rotterdam"];
const CLINIC_COLOR = {Utrecht:"#7c3aed",Bussum:"#0891b2",Amstelveen:"#2563eb",Rotterdam:"#ea580c"};

function mktgYears(){ const s=new Set(); Object.values(MKTG_CLINIC).forEach(ch=>Object.values(ch).forEach(yr=>Object.keys(yr).forEach(y=>s.add(y)))); return [...s].sort(); }
function clinicYears(c){ const s=new Set(); Object.values(MKTG_CLINIC_M[c]||{}).forEach(yr=>Object.keys(yr).forEach(y=>s.add(y))); return [...s].sort(); }

function svgYearLines(series, years){
  const W=720,H=320,P={l:52,r:118,t:14,b:28};
  const vals=[].concat(...series.map(s=>years.map(y=>s.pts[y]||0)),1);
  const max=Math.max(...vals)*1.12, n=years.length;
  const x=i=>P.l+(n<2?(W-P.l-P.r)/2:(i/(n-1))*(W-P.l-P.r)), y=v=>H-P.b-(v/max)*(H-P.t-P.b);
  const step=max>40000?10000:max>20000?5000:max>8000?2000:1000;
  let g="";
  for(let t=0;t<=max;t+=step) g+='<line x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+y(t)+'" y2="'+y(t)+'" stroke="#eef2f7"/><text x="'+(P.l-8)+'" y="'+(y(t)+4)+'" text-anchor="end" font-size="10" fill="#94a3b8">\u20ac'+((t/1000)|0)+'k</text>';
  years.forEach((yr,i)=>g+='<text x="'+x(i)+'" y="'+(H-10)+'" text-anchor="middle" font-size="10" fill="#94a3b8">'+yr+'</text>');
  series.forEach((s,si)=>{
    const pts=years.map((yr,i)=>s.pts[yr]!=null?(x(i)+","+y(s.pts[yr])):null).filter(Boolean);
    if(pts.length>1) g+='<polyline points="'+pts.join(" ")+'" fill="none" stroke="'+s.color+'" stroke-width="2.5"/>';
    years.forEach((yr,i)=>{ if(s.pts[yr]!=null) g+='<circle cx="'+x(i)+'" cy="'+y(s.pts[yr])+'" r="3" fill="'+s.color+'"><title>'+s.label+" "+yr+": \u20ac"+s.pts[yr].toLocaleString("en-US")+'</title></circle>'; });
    g+='<text x="'+(W-P.r+8)+'" y="'+(20+si*15)+'" font-size="11" fill="'+s.color+'">'+s.label+'</text>';
  });
  return '<svg viewBox="0 0 '+W+' '+H+'" width="100%">'+g+'</svg>';
}

app.get("/marketing", gate, async (_req,res)=>{ try {
  const fmt=n=>"\u20ac"+Math.round(n||0).toLocaleString("en-US");
  const years=mktgYears();
  const adSpend=(c,y)=>(((MKTG_CLINIC[c]||{}).Google||{})[y]||0)+(((MKTG_CLINIC[c]||{}).Meta||{})[y]||0);
  const cmpSeries=MKTG_CLINICS.map(c=>({label:c,color:CLINIC_COLOR[c],pts:Object.fromEntries(years.map(y=>[y,adSpend(c,y)]).filter(p=>p[1]))}));
  const comparePanel=`<section data-clinic="Compare">
    <div class="advice">Each line is one clinic's <b>ad spend</b> (Google + Meta) by year. Amstelveen scaled hard into 2025; Utrecht's spend fell with its revenue. Open a clinic tab for month-by-month detail and cost per lead.</div>
    <div class="card"><b>Ad spend by clinic \u2014 all years</b>${svgYearLines(cmpSeries, years)}<div class="legend">Hover any point for the figure. 2026 is year-to-date.</div></div></section>`;

  const clinicPanels=MKTG_CLINICS.map(c=>{
    const ys=clinicYears(c), last=ys[ys.length-1];
    const adS=adSpend(c,last), agency=((MKTG_CLINIC[c]||{}).Shoet||{})[last]||0;
    const ybtns=ys.map(y=>`<button data-mm="${c}" data-year="${y}" onclick='drawMktgMonth("${c}","${y}")' style="padding:5px 10px;margin:0 6px 6px 0;border:1px solid #e5e7eb;background:#fff;border-radius:6px;font-size:12px;cursor:pointer;color:#6B7686">${y}${y==="2026"?" YTD":""}</button>`).join("");
    const cp=MKTG_CPL[c]||{};
    const cplRow=(n,d)=> d&&d.cpl?`<tr><td>${n}</td><td class="num">${d.leads}</td><td class="num"><b>\u20ac${d.cpl}</b></td><td class="num">${fmt(d.spend)}</td></tr>`:(d?`<tr><td>${n}</td><td class="num">${d.leads||"\u2014"}</td><td class="num">\u2014</td><td class="num">${fmt(d.spend)}</td></tr>`:"");
    const cplCard=`<div class="card" style="background:#f8fafc"><b>Cost per lead \u2014 2026 (Jan\u2013May)</b>
      <table style="margin-top:6px"><thead><tr><th style="text-align:left">Channel</th><th>Leads</th><th>Cost/lead</th><th>Spend</th></tr></thead>
      <tbody>${cplRow("Google",cp.Google)}${cplRow("Meta",cp.Meta)}${cplRow("Organic",cp.Organic)}</tbody></table>
      <div class="legend">Cheapest cost-per-lead isn't the whole story \u2014 see the funnel below for which leads actually become patients.</div></div>`;
    const lm=MKTG_LEADS_M[c]; const MO=["Jan","Feb","Mar","Apr","May"];
    const funnel=lm?`<div class="card"><b>Lead quality by month \u2014 2026</b>
      <table style="margin-top:6px"><thead><tr><th style="text-align:left">Month</th><th>Google in</th><th>\u2192care</th><th>conv</th><th>Meta in</th><th>\u2192care</th><th>conv</th></tr></thead>
      <tbody>${MO.map((m,i)=>{const gi=lm.Google.intakes[i],gc=lm.Google.care[i],mi=lm.Meta.intakes[i],mc=lm.Meta.care[i];return `<tr><td style="text-align:left">${m}</td><td class="num">${gi}</td><td class="num">${gc}</td><td class="num">${gi?Math.round(100*gc/gi)+"%":"\u2014"}</td><td class="num">${mi}</td><td class="num">${mc}</td><td class="num">${mi?Math.round(100*mc/mi)+"%":"\u2014"}</td></tr>`;}).join("")}</tbody></table>
      <div class="legend">Per month, by channel: intakes \u2192 started care and the conversion. Google converts better than Meta nearly every month. 2022\u20132025 monthly leads fill in once those marketing sheets are added.</div></div>`:"";
    return `<section data-clinic="${c}" style="display:none">
      <div class="kpis">
        <div class="kpi"><b>${fmt(adS)}</b><span>${last} ad spend (Google+Meta)</span></div>
        <div class="kpi"><b>${fmt(agency)}</b><span>${last} agency/organic (Shoet)</span></div>
        <div class="kpi"><b>${fmt(adS+agency)}</b><span>${last} total marketing</span></div>
      </div>
      <div class="card"><b>${c} \u2014 monthly ad spend</b>
        <div style="margin:10px 0 4px">${ybtns}</div><div id="mm-${c}"></div>
        <div class="legend">Blue = Google, purple = Meta, grey = Organic (Shoet). Pick a year. Hover a point for the figure.</div></div>
      ${cplCard}${funnel}</section>`;
  }).join("");

  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Marketing by clinic \u2014 Posturefixx</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:880px;margin:24px auto;padding:0 16px;color:#16202E}
h1{font-size:22px;margin:0 0 2px}.sub{color:#64748b;font-size:13px;margin-bottom:18px}
.tabs{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}.tab{padding:8px 14px;border-radius:8px;background:#f1f5f9;cursor:pointer;font-size:13px;font-weight:600}.tab.on{background:#16202E;color:#fff}
.card{border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:16px}.legend{font-size:12px;color:#64748b;margin-top:10px;line-height:1.5}
.advice{background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;padding:12px 14px;border-radius:10px;font-size:13.5px;line-height:1.55;margin-bottom:14px}
.kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}.kpi{flex:1;min-width:150px;border:1px solid #e5e7eb;border-radius:10px;padding:12px}.kpi b{font-size:20px;display:block}.kpi span{font-size:12px;color:#64748b}
table{border-collapse:collapse;width:100%;font-size:13px}td{padding:7px 8px;border-bottom:1px solid #f1f5f9}.num{text-align:right;font-variant-numeric:tabular-nums}th{text-align:right;font-size:12px;color:#64748b;padding:8px}
a{color:#2563EB}</style></head><body>
<h1>Marketing by clinic</h1><div class="sub">Monthly ad spend (Google / Meta / Organic) per clinic \u00b7 cost per lead \u00b7 from bank payments \u00b7 <a href="/meta-leads" style="font-weight:600">Meta lead quality \u2192</a></div>
<div class="tabs" id="tabs"></div>${comparePanel}${clinicPanels}
<p class="sub">Pages: <a href="/plan">/plan</a> \u00b7 <a href="/revenue">/revenue</a> \u00b7 <a href="/marketing">/marketing</a> \u00b7 <a href="/waste">/waste</a> \u00b7 <a href="/pva">/pva</a> \u00b7 <a href="/ca">/ca</a> \u00b7 <a href="/coach">/coach</a></p>
<script>
var MM={"Utrecht":{"Google":{"2026":[790,806,886,971,944,null,null,null,null,null,null,null],"2025":[752,822,821,766,838,868,888,869,875,913,900,799],"2024":[766,646,778,990,1011,841,703,654,724,923,951,782],"2023":[996,298,962,265,889,522,314,998,1135,631,742,709],"2022":[1000,2000,1500,1500,1343,1399,1619,758,1020,694,752,288],"2021":[null,null,null,null,250,700,1000,500,500,1000,497,1000]},"Meta":{"2026":[200,200,null,200,null,null,null,null,null,null,null,null],"2025":[200,200,200,200,200,200,200,200,300,340,361,200],"2024":[1212,830,1239,1114,485,949,346,200,200,200,200,200],"2023":[656,366,434,228,131,34,1307,1230,1391,1141,1181,885],"2022":[218,244,330,573,817,516,452,702,492,530,678,1054],"2021":[null,null,null,50,11,11,279,260,279,207,394,445]},"Organic":{"2026":[null,681,null,null,null,null,null,null,null,null,null,null],"2025":[null,null,null,1210,605,null,null,333,605,1210,605,null],"2024":[1331,null,321,321,641,641,null,321,321,null,321,null],"2023":[null,null,null,null,null,null,null,null,null,null,321,321]}},"Bussum":{"Google":{"2026":[266,287,261,266,287,null,null,null,null,null,null,null],"2025":[705,740,105,393,768,102,403,424,420,452,456,401],"2024":[340,370,390,810,813,886,818,784,819,862,876,721],"2023":[1080,813,116,566,494,330,199,205,150,337,584,420],"2022":[null,null,null,250,832,378,224,161,245,317,1037,157]},"Meta":{"2026":[200,200,200,400,null,null,null,null,null,null,null,null],"2025":[200,200,200,200,200,200,200,350,300,null,200,200],"2024":[200,200,200,200,200,200,200,200,200,400,200,200],"2023":[780,374,452,486,775,308,1040,821,null,null,null,null],"2022":[null,null,null,null,1,null,null,null,null,null,null,907]},"Organic":{"2026":[null,681,null,null,null,null,null,null,null,null,null,null],"2025":[null,null,null,605,1210,null,333,null,605,1210,605,null],"2024":[321,321,321,321,null,321,321,null,321,null,321,null],"2023":[null,null,null,null,null,null,null,null,null,null,321,null]}},"Amstelveen":{"Google":{"2026":[773,864,709,683,730,null,null,null,null,null,null,null],"2025":[1255,1331,1191,1222,1204,822,1632,1280,1364,869,1018,809],"2024":[831,761,880,1574,967,1068,661,717,1573,1352,1356,1285],"2023":[null,null,null,null,null,null,null,457,226,964,808,778]},"Meta":{"2026":[900,1000,850,1150,700,null,null,null,null,null,null,null],"2025":[750,1200,1600,1300,1325,1300,1250,600,1450,1220,1050,650],"2024":[1050,300,700,1250,1280,800,700,850,600,950,1050,700],"2023":[null,null,null,null,null,null,200,581,1100,1350,800,600]},"Organic":{"2026":[null,681,null,null,null,null,null,null,null,null,null,null],"2025":[null,null,null,1210,605,null,333,null,605,1210,605,null],"2024":[null,321,641,321,321,null,321,321,641,null,null,null],"2023":[null,null,null,null,null,null,null,null,726,484,null,1506]}},"Rotterdam":{"Google":{"2026":[244,242,305,281,349,null,null,null,null,null,null,null],"2025":[null,null,null,null,null,null,null,null,60,46,213,311]},"Meta":{"2026":[500,900,900,1250,850,null,null,null,null,null,null,null],"2025":[null,null,null,null,null,null,null,null,null,340,650,675]},"Organic":{"2026":[321,681,null,null,null,null,null,null,null,null,null,null]}}};
var cs=["Compare","Utrecht","Bussum","Amstelveen","Rotterdam"],el=document.getElementById("tabs");
function show(c){Array.prototype.forEach.call(document.querySelectorAll("[data-clinic]"),function(s){s.style.display=s.getAttribute("data-clinic")===c?"":"none"});Array.prototype.forEach.call(el.children,function(b){b.className="tab"+(b.textContent===c?" on":"")})}
cs.forEach(function(c){var b=document.createElement("div");b.className="tab";b.textContent=c;b.onclick=function(){show(c)};el.appendChild(b)});
function drawMktgMonth(clinic,year){
  var chans=[["Google","#2563eb"],["Meta","#7c3aed"],["Organic","#94a3b8"]];
  var W=720,H=290,pL=46,pR=92,pT=12,pB=24, MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var series=chans.map(function(cc){return {name:cc[0],color:cc[1],arr:((MM[clinic]||{})[cc[0]]||{})[year]||[]};});
  var max=1; series.forEach(function(s){s.arr.forEach(function(v){if(v!=null&&v>max)max=v;});}); max*=1.15;
  var x=function(i){return pL+(i/11)*(W-pL-pR);}, y=function(v){return H-pB-(v/max)*(H-pT-pB);};
  var step=max>4000?1000:max>2000?500:max>800?200:100, g="";
  for(var t=0;t<=max;t+=step){g+="<line x1='"+pL+"' x2='"+(W-pR)+"' y1='"+y(t)+"' y2='"+y(t)+"' stroke='#eef2f7'/><text x='"+(pL-6)+"' y='"+(y(t)+4)+"' text-anchor='end' font-size='10' fill='#94a3b8'>\u20ac"+t+"</text>";}
  MN.forEach(function(mn,i){g+="<text x='"+x(i)+"' y='"+(H-8)+"' text-anchor='middle' font-size='9' fill='#94a3b8'>"+mn+"</text>";});
  series.forEach(function(s,si){
    var pts=[]; s.arr.forEach(function(v,i){if(v!=null)pts.push(x(i)+","+y(v));});
    if(pts.length>1) g+="<polyline points='"+pts.join(" ")+"' fill='none' stroke='"+s.color+"' stroke-width='2.5'/>";
    s.arr.forEach(function(v,i){if(v!=null)g+="<circle cx='"+x(i)+"' cy='"+y(v)+"' r='2.6' fill='"+s.color+"'><title>"+s.name+" "+MN[i]+": \u20ac"+v.toLocaleString("en-US")+"</title></circle>";});
    g+="<text x='"+(W-pR+8)+"' y='"+(18+si*15)+"' font-size='11' fill='"+s.color+"'>"+s.name+"</text>";
  });
  var el2=document.getElementById("mm-"+clinic);
  if(el2) el2.innerHTML="<svg viewBox='0 0 "+W+" "+H+"' width='100%'>"+g+"</svg>";
  Array.prototype.forEach.call(document.querySelectorAll("button[data-mm='"+clinic+"']"),function(b){
    var on=b.getAttribute("data-year")===year; b.style.background=on?"#2563EB":"#fff"; b.style.color=on?"#fff":"#6B7686"; b.style.borderColor=on?"#2563EB":"#e5e7eb";
  });
}
["Utrecht","Bussum","Amstelveen","Rotterdam"].forEach(function(c){var ys=Object.keys((MM[c]||{}).Google||(MM[c]||{}).Meta||{}).sort(); if(ys.length) drawMktgMonth(c, ys[ys.length-1]);});
show("Compare");
</script>
</body></html>`);
} catch(e){ res.status(500).send("marketing error: "+e.message); } });

// ============================================================================
//  /waste — spend drill-down: pick location + year, see every category by month,
//  click a category for live advice (cut / hold / move). From MT940 bank debits.
// ============================================================================
const WASTE_FULL = {"Utrecht":{"2021":{"Other (suppliers, fees, misc)":[null,null,13945,13564,5063,3192,3221,3437,3589,4885,4931,7163],"Rent":[null,null,null,null,1982,1830,1830,1830,1830,1830,1830,1830],"Groceries":[null,null,null,39,147,92,112,96,93,96,167,210],"Restaurants":[null,null,null,36,36,38,69,37,81,32,94,182],"Marketing":[null,null,null,50,261,711,1279,760,779,1207,891,1445],"Alcohol":[null,null,null,null,null,null,null,null,36,68,27,48],"Tax/gov":[null,null,null,null,170,429,448,448,413,1734,1734,641],"Software/SaaS":[null,null,null,101,72,36,36,37,52,52,52,52],"Contractor chiros":[null,null,null,null,null,1065,3079,3211,3411,3000,2000,4622],"Insurance":[null,null,null,null,null,null,96,74,74,null,148,74]},"2022":{"Contractor chiros":[151,null,null,50,50,50,300,450,150,7143,45,9360],"Other (suppliers, fees, misc)":[8889,20716,6844,6725,9055,11827,8541,14705,12092,7178,4987,5954],"Marketing":[1218,2244,1830,2073,2159,1915,2071,1460,1513,1224,1430,1342],"Groceries":[214,117,204,167,182,163,173,216,125,102,125,116],"Fuel":[null,null,null,null,null,null,null,null,null,null,null,82],"Intercompany/Owner":[null,null,null,null,null,null,null,null,45,2406,5637,9317],"Rent":[1830,1830,1830,1964,1964,1964,1964,1964,1964,1964,1964,1964],"Alcohol":[52,20,null,39,57,56,59,22,null,null,3,102],"Tax/gov":[1529,2079,1331,1337,439,460,460,499,484,572,578,392],"Software/SaaS":[52,52,52,52,52,52,54,54,54,54,54,54],"Restaurants":[125,130,147,103,74,83,92,100,202,186,88,68],"Insurance":[113,204,146,146,313,84,84,97,84,84,84,84],"Personnel":[null,1789,2872,3361,2103,null,null,null,null,null,null,null],"Travel/Parking":[null,null,4,2,null,null,null,null,null,null,null,null]},"2023":{"Contractor chiros":[4890,6904,3848,5606,10255,7581,9562,7180,1891,10228,7350,19474],"Other (suppliers, fees, misc)":[9098,6111,2791,9580,15301,12025,9306,6971,7257,5721,6858,7406],"Marketing":[1652,664,1396,493,1019,556,1621,2228,2526,1772,2243,1915],"Tax/gov":[1309,2048,1001,779,729,675,768,657,787,768,692,1566],"Personnel":[1903,1206,3037,1190,1190,1190,2790,1190,null,1190,1190,2218],"Intercompany/Owner":[7250,5803,5565,5956,4718,4396,2518,1450,1607,1440,450,2200],"Groceries":[108,149,257,150,202,310,267,204,76,94,75,230],"Travel/Parking":[null,null,null,455,301,605,309,396,418,111,229,204],"Software/SaaS":[54,54,54,54,54,54,58,158,58,58,58,58],"Alcohol":[null,212,null,null,null,null,null,34,null,162,null,87],"Insurance":[85,290,153,153,153,153,153,190,465,197,161,161],"Restaurants":[70,186,108,250,308,179,65,218,null,72,68,null],"Rent":[1964,null,3927,null,null,null,null,null,null,null,null,null]},"2024":{"Contractor chiros":[4200,6215,15900,8700,1500,12900,8700,8055,5515,4850,9295,14465],"Other (suppliers, fees, misc)":[11772,6942,7396,9991,7994,7451,5369,9698,12935,9634,9489,7297],"Marketing":[3109,1276,2137,2224,1937,2232,849,975,1045,923,1271,782],"Intercompany/Owner":[3945,2350,1350,null,null,null,null,null,1000,2350,2460,2910],"Groceries":[62,60,27,38,51,162,14,23,12,84,60,124],"Tax/gov":[1239,1150,1182,1120,1222,1441,2386,1641,1281,1198,1370,1228],"Travel/Parking":[138,205,128,123,149,131,110,112,120,117,122,111],"Software/SaaS":[146,111,111,111,111,111,113,113,113,114,114,107],"Insurance":[203,336,221,261,221,459,774,316,null,716,322,null],"Personnel":[null,4175,3922,null,2289,2289,4792,null,null,1250,100,null],"Restaurants":[113,22,131,73,135,86,null,41,null,null,null,null],"Alcohol":[41,null,null,null,null,null,null,null,null,null,null,null]},"2025":{"Other (suppliers, fees, misc)":[11938,5078,9547,9930,5007,10370,8052,9865,11796,6193,12309,10222],"Alcohol":[null,null,null,null,null,78,null,null,null,null,238,36],"Contractor chiros":[4500,12900,5262,3000,3000,4108,4822,1500,4500,null,1736,3120],"Marketing":[752,822,821,1976,1443,868,888,1202,1580,2263,1666,799],"Tax/gov":[1144,1378,1516,1262,2467,1262,1262,954,1164,999,1028,1082],"Travel/Parking":[158,91,96,98,74,211,101,170,8,56,82,90],"Software/SaaS":[109,109,109,109,109,109,109,109,109,111,111,109],"Groceries":[48,71,101,107,87,109,192,168,86,115,171,124],"Intercompany/Owner":[1350,200,1500,1500,4500,1926,1500,4750,4300,3950,3000,1500],"Restaurants":[null,34,null,null,60,null,null,70,98,null,null,null],"Personnel":[100,4294,null,null,4242,2376,null,null,null,null,null,null],"Insurance":[44,null,null,44,22,null,null,null,null,null,null,null]},"2026":{"Alcohol":[null,null,null,null,null,68,null,null,null,null,null,null],"Groceries":[137,120,146,104,90,79,null,null,null,null,null,null],"Other (suppliers, fees, misc)":[11040,14108,13672,15120,15993,6355,null,null,null,null,null,null],"Travel/Parking":[87,100,57,100,50,73,null,null,null,null,null,null],"Software/SaaS":[91,91,91,91,91,104,null,null,null,null,null,null],"Marketing":[790,1487,886,971,944,244,null,null,null,null,null,null],"Contractor chiros":[4115,null,1317,1493,850,392,null,null,null,null,null,null],"Tax/gov":[1245,2342,1478,null,4768,1528,null,null,null,null,null,null],"Intercompany/Owner":[null,null,500,720,500,null,null,null,null,null,null,null]}},"Bussum":{"2022":{"Contractor chiros":[null,null,null,null,null,null,null,null,null,3442,null,4312],"Other (suppliers, fees, misc)":[null,16981,6181,12865,8445,6724,4296,15155,10240,6655,6203,7058],"Travel/Parking":[null,null,172,null,142,285,364,298,277,310,136,353],"Marketing":[null,null,null,250,833,378,224,161,245,317,1037,1064],"Groceries":[null,null,null,82,118,181,96,106,71,64,93,123],"Intercompany/Owner":[null,8500,null,600,null,null,1500,null,null,1406,4234,3511],"Tax/gov":[null,null,null,null,149,373,null,518,566,395,598,392],"Software/SaaS":[null,null,null,null,93,121,36,36,36,51,53,53],"Personnel":[null,null,null,null,642,1198,1467,908,843,2167,null,1000],"Restaurants":[null,null,11,136,37,79,25,74,3,null,6,null],"Alcohol":[null,null,null,null,7,32,null,null,null,null,null,null],"Insurance":[null,null,null,null,null,234,null,null,null,null,null,null]},"2023":{"Other (suppliers, fees, misc)":[7371,6478,5721,6075,4588,7891,5167,6095,9237,7211,6974,8499],"Groceries":[89,74,73,65,78,58,64,73,72,117,172,55],"Tax/gov":[null,1040,1006,1529,1515,1018,1207,65,2367,947,65,914],"Travel/Parking":[348,272,318,null,null,null,null,null,null,13,53,61],"Marketing":[1860,1187,568,1052,1269,637,1239,1026,150,337,904,420],"Software/SaaS":[53,53,53,53,53,53,57,57,57,57,57,57],"Contractor chiros":[4550,6299,500,2050,1750,1750,4670,2050,995,2836,2250,378],"Insurance":[null,null,131,276,50,null,100,50,50,50,50,50],"Personnel":[1949,766,766,2256,2177,1099,2474,1866,null,null,766,null],"Intercompany/Owner":[2525,2000,1750,2090,null,541,1612,1683,442,1290,100,null],"Restaurants":[null,null,null,5,null,null,null,null,null,null,null,null]},"2024":{"Other (suppliers, fees, misc)":[9037,9377,7618,9841,7362,8502,11180,10395,10498,7241,8185,8843],"Marketing":[660,691,710,1131,813,1207,1139,784,1140,1062,1197,721],"Tax/gov":[65,192,65,419,249,328,65,809,957,957,714,999],"Travel/Parking":[73,84,106,199,232,197,60,215,182,142,226,206],"Software/SaaS":[57,57,57,57,57,57,49,69,59,59,59,59],"Contractor chiros":[null,null,null,null,null,null,null,300,1900,null,1927,1900],"Groceries":[18,17,22,61,63,25,24,113,4,7,6,null],"Personnel":[481,null,300,null,null,null,null,null,null,2142,null,null],"Intercompany/Owner":[786,500,null,3000,2200,4350,10452,2500,1800,705,null,null],"Restaurants":[null,null,null,16,46,41,null,56,null,null,null,null],"Insurance":[51,51,51,null,231,239,null,null,null,null,null,null]},"2025":{"Other (suppliers, fees, misc)":[9172,4596,10430,8579,3141,10836,9903,7583,6088,8848,6889,6924],"Contractor chiros":[1900,1900,3400,3400,5300,null,3522,3400,5300,1500,3400,6606],"Tax/gov":[1141,727,727,727,889,662,662,724,889,683,665,566],"Travel/Parking":[142,54,130,356,296,222,294,286,98,190,197,108],"Marketing":[705,740,105,998,1978,102,735,574,1125,1662,1061,401],"Software/SaaS":[59,59,59,59,59,59,61,61,61,61,61,61],"Intercompany/Owner":[200,110,null,null,null,1282,null,1400,900,1000,55,null],"Groceries":[17,null,null,11,null,null,null,null,null,15,20,null],"Insurance":[null,null,null,null,null,231,null,null,null,null,null,null],"Personnel":[null,2442,null,null,2084,null,null,null,null,null,null,null]},"2026":{"Other (suppliers, fees, misc)":[7153,7045,8415,8172,4847,5150,null,null,null,null,null,null],"Travel/Parking":[200,203,255,237,215,372,null,null,null,null,null,null],"Insurance":[null,null,null,null,null,231,null,null,null,null,null,null],"Contractor chiros":[null,1957,1068,2781,2759,2057,null,null,null,null,null,null],"Marketing":[266,968,261,266,287,219,null,null,null,null,null,null],"Software/SaaS":[61,61,61,61,61,61,null,null,null,null,null,null],"Tax/gov":[618,922,727,922,749,null,null,null,null,null,null,null],"Intercompany/Owner":[1000,null,500,3000,3000,null,null,null,null,null,null,null],"Groceries":[null,null,null,23,25,null,null,null,null,null,null,null]}},"Amstelveen":{"2023":{"Marketing":[null,null,null,null,null,null,200,1038,2052,2798,1608,2884],"Other (suppliers, fees, misc)":[null,null,null,null,18032,19236,1765,3316,6935,7304,7412,8195],"Groceries":[null,null,null,null,null,null,null,95,94,168,140,63],"Personnel":[null,null,null,null,null,null,null,null,709,1628,null,4205],"Intercompany/Owner":[null,null,null,null,8484,null,1084,1717,1901,1809,null,3200],"Contractor chiros":[null,null,null,null,null,null,null,null,750,440,3432,750],"Travel/Parking":[null,null,null,null,null,null,null,null,null,249,463,505],"Software/SaaS":[null,null,null,null,null,null,null,null,null,82,51,51],"Rent":[null,null,null,null,null,null,null,2346,null,2346,2346,2346],"Tax/gov":[null,null,null,null,null,null,null,null,154,560,690,null],"Restaurants":[null,null,null,null,null,null,null,33,46,104,null,null]},"2024":{"Software/SaaS":[51,51,51,51,160,228,186,207,195,197,197,258],"Marketing":[1681,1382,2221,3144,2568,1868,1682,1888,2814,2302,2406,1985],"Other (suppliers, fees, misc)":[5391,4391,6364,8943,5896,13108,11825,13544,16185,15278,12767,13548],"Intercompany/Owner":[2250,1500,3850,2300,2500,500,2000,4500,5500,5600,5515,6250],"Tax/gov":[562,1490,751,622,620,606,4612,732,856,832,769,806],"Groceries":[67,65,64,155,44,50,37,95,158,112,74,62],"Travel/Parking":[276,329,289,307,287,208,226,252,261,298,237,228],"Contractor chiros":[null,165,322,null,null,null,null,null,1900,1900,null,1900],"Restaurants":[null,null,null,24,null,46,null,null,null,18,null,null],"Personnel":[2909,3340,2790,null,2712,null,2676,null,null,null,null,null],"Rent":[2346,2346,2346,2346,2346,2346,null,null,null,null,null,null]},"2025":{"Intercompany/Owner":[8500,4889,4770,4110,14500,null,3675,4135,6376,4003,3500,3000],"Travel/Parking":[128,293,310,340,295,283,313,701,838,844,806,969],"Groceries":[90,44,27,18,58,26,79,21,24,26,103,74],"Software/SaaS":[197,197,197,197,219,220,221,221,271,224,227,224],"Other (suppliers, fees, misc)":[17052,8617,15565,7583,11949,12195,15712,13423,11569,13734,11118,11325],"Contractor chiros":[2080,2062,3565,3490,4156,4096,5300,2182,3400,3400,5034,4570],"Marketing":[2005,2331,2591,3532,2934,1922,3014,1680,3219,3099,2473,1259],"Tax/gov":[856,null,1324,537,1451,896,676,896,1667,551,2599,1630],"Alcohol":[null,null,null,null,null,null,null,null,null,null,null,99],"Insurance":[1125,null,null,98,290,106,1332,185,288,null,null,230],"Personnel":[null,3814,464,2516,2516,157,null,2264,null,null,null,null],"Rent":[null,null,150,null,4293,716,1431,null,null,null,null,null],"Restaurants":[67,null,15,null,null,null,30,null,null,null,null,null]},"2026":{"Other (suppliers, fees, misc)":[15765,14512,17726,21137,18148,4675,null,null,null,null,null,null],"Travel/Parking":[646,796,883,925,639,626,null,null,null,null,null,null],"Insurance":[177,null,241,265,413,471,null,null,null,null,null,null],"Software/SaaS":[224,303,240,215,130,111,null,null,null,null,null,null],"Contractor chiros":[2170,3181,2561,3640,4729,2419,null,null,null,null,null,null],"Marketing":[1473,2344,1359,1633,1430,592,null,null,null,null,null,null],"Groceries":[38,31,93,41,46,null,null,null,null,null,null,null],"Intercompany/Owner":[5500,6000,2055,2330,4055,null,null,null,null,null,null,null],"Tax/gov":[2187,2262,2995,797,3882,null,null,null,null,null,null,null],"Rent":[null,null,425,null,null,null,null,null,null,null,null,null],"Restaurants":[null,null,5,null,null,null,null,null,null,null,null,null]}},"Rotterdam":{"2025":{"Other (suppliers, fees, misc)":[null,null,null,null,null,null,4871,21079,1461,3621,4396,4304],"Tax/gov":[null,null,null,null,null,null,null,null,1020,null,2202,772],"Software/SaaS":[null,null,null,null,null,null,61,36,36,199,36,36],"Marketing":[null,null,null,null,null,null,null,null,60,186,663,786],"Rent":[null,null,null,null,null,null,null,1431,1431,1431,1431,1430],"Groceries":[null,null,null,null,null,null,9,7,27,42,12,12],"Travel/Parking":[null,null,null,null,null,null,null,null,null,null,4,null],"Intercompany/Owner":[null,null,null,null,null,null,376,526,null,null,1000,null],"Personnel":[null,null,null,null,null,null,null,null,2870,null,null,null]},"2026":{"Other (suppliers, fees, misc)":[4122,4234,6069,8531,4038,3192,null,null,null,null,null,null],"Groceries":[58,53,111,122,119,33,null,null,null,null,null,null],"Marketing":[864,1622,1005,1131,1199,900,null,null,null,null,null,null],"Travel/Parking":[null,null,24,null,null,6,null,null,null,null,null,null],"Rent":[1430,1430,2865,null,2862,34,null,null,null,null,null,null],"Intercompany/Owner":[1235,2000,3000,4000,5900,null,null,null,null,null,null,null],"Tax/gov":[1004,994,856,1099,994,null,null,null,null,null,null,null],"Software/SaaS":[36,36,36,53,53,null,null,null,null,null,null,null],"Alcohol":[null,null,null,110,null,null,null,null,null,null,null,null],"Restaurants":[13,null,null,4,null,null,null,null,null,null,null,null]}},"Holding":{"2020":{"Other (suppliers, fees, misc)":[null,null,null,null,null,null,1435,51,10,408,942,1865],"Tax/gov":[null,null,null,null,null,null,null,null,null,null,null,68]},"2021":{"Other (suppliers, fees, misc)":[497,2969,12,1365,560,135,126,10,10,169,11,93],"Tax/gov":[null,null,null,null,null,null,null,null,null,53,null,null],"Contractor chiros":[null,null,null,4375,null,null,null,1000,null,null,null,null],"Intercompany/Owner":[null,null,100,null,null,null,null,null,null,null,null,null],"Rent":[null,4235,null,null,null,null,null,null,null,null,null,null]},"2022":{"Other (suppliers, fees, misc)":[199,2699,3166,1091,1629,3320,3544,2110,1734,2442,9707,12274],"Tax/gov":[null,null,null,null,1323,1294,1294,5582,906,906,906,906],"Contractor chiros":[null,5000,241,null,3511,2990,null,null,null,null,5291,null],"Personnel":[null,null,null,null,1500,2688,500,2000,4422,4149,null,null],"Restaurants":[null,null,null,null,null,8,null,null,null,null,null,null],"Intercompany/Owner":[null,null,null,270,null,null,null,null,null,null,null,null]},"2023":{"Other (suppliers, fees, misc)":[11154,7384,6638,3772,8939,3223,5261,3272,2884,4937,498,3909],"Tax/gov":[906,922,922,922,1668,922,1990,922,922,922,1192,2259],"Contractor chiros":[6177,null,null,null,7926,2780,null,null,null,9356,null,3022],"Personnel":[null,null,null,3400,null,3432,null,550,null,null,3432,null],"Marketing":[null,null,null,null,null,null,302,null,null,null,null,null],"Software/SaaS":[null,null,null,null,null,null,25,null,null,null,null,null],"Restaurants":[41,null,null,null,null,null,null,null,null,null,null,null]},"2024":{"Other (suppliers, fees, misc)":[5825,3405,1669,5424,6244,4526,8726,6650,7402,6832,6465,5692],"Tax/gov":[2223,1527,1491,1491,1527,1543,8026,1527,1491,1532,1527,1491],"Restaurants":[null,null,null,39,null,null,102,28,46,null,null,null],"Marketing":[null,null,null,null,1226,1339,1500,1500,159,null,null,null],"Contractor chiros":[7948,null,null,2718,2603,null,null,null,null,null,null,null],"Personnel":[null,null,1950,null,null,null,null,null,null,null,null,null]},"2025":{"Other (suppliers, fees, misc)":[5901,4319,6354,3806,13806,14274,6072,3736,4687,3617,7336,7136],"Tax/gov":[2982,1470,1434,1434,3941,null,397,1514,1434,1434,1476,1472],"Contractor chiros":[1500,3040,5519,null,null,6815,2785,null,null,2600,4616,4305],"Travel/Parking":[null,null,null,null,null,null,null,null,35,null,null,null],"Intercompany/Owner":[1,null,null,null,null,null,26431,null,320,null,null,null],"Restaurants":[null,null,46,null,null,null,null,null,null,null,null,null],"Marketing":[807,1815,null,null,null,null,null,null,null,null,null,null]},"2026":{"Other (suppliers, fees, misc)":[2889,8415,6861,13340,6611,4981,null,null,null,null,null,null],"Tax/gov":[1434,5378,1592,3198,1475,1818,null,null,null,null,null,null],"Contractor chiros":[8971,190,6010,2811,19754,null,null,null,null,null,null,null],"Travel/Parking":[null,23,null,null,92,null,null,null,null,null,null,null],"Restaurants":[null,null,null,42,null,null,null,null,null,null,null,null]}},"All":{"2020":{"Other (suppliers, fees, misc)":[null,null,null,null,null,null,1435,51,10,408,942,1865],"Tax/gov":[null,null,null,null,null,null,null,null,null,null,null,68]},"2021":{"Other (suppliers, fees, misc)":[497,2969,13957,14929,5623,3327,3347,3447,3599,5054,4942,7257],"Rent":[null,4235,null,null,1982,1830,1830,1830,1830,1830,1830,1830],"Groceries":[null,null,null,39,147,92,112,96,93,96,167,210],"Restaurants":[null,null,null,36,36,38,69,37,81,32,94,182],"Marketing":[null,null,null,50,261,711,1279,760,779,1207,891,1445],"Alcohol":[null,null,null,null,null,null,null,null,36,68,27,48],"Tax/gov":[null,null,null,null,170,429,448,448,413,1787,1734,641],"Software/SaaS":[null,null,null,101,72,36,36,37,52,52,52,52],"Contractor chiros":[null,null,null,4375,null,1065,3079,4211,3411,3000,2000,4622],"Insurance":[null,null,null,null,null,null,96,74,74,null,148,74],"Intercompany/Owner":[null,null,100,null,null,null,null,null,null,null,null,null]},"2022":{"Contractor chiros":[151,5000,241,50,3561,3040,300,450,150,10586,5336,13671],"Other (suppliers, fees, misc)":[9088,40396,16191,20682,19129,21872,16381,31970,24066,16275,20897,25287],"Marketing":[1218,2244,1830,2323,2992,2293,2295,1621,1757,1540,2468,2406],"Groceries":[214,117,204,249,299,344,270,322,195,166,217,239],"Fuel":[null,null,null,null,null,null,null,null,null,null,null,82],"Intercompany/Owner":[null,8500,null,870,null,null,1500,null,45,3813,9871,12829],"Rent":[1830,1830,1830,1964,1964,1964,1964,1964,1964,1964,1964,1964],"Alcohol":[52,20,null,39,64,88,59,22,null,null,3,102],"Tax/gov":[1529,2079,1331,1337,1911,2127,1754,6599,1956,1873,2082,1690],"Software/SaaS":[52,52,52,52,145,173,91,91,91,105,108,108],"Restaurants":[125,130,158,239,112,170,117,175,205,186,94,68],"Insurance":[113,204,146,146,313,318,84,97,84,84,84,84],"Personnel":[null,1789,2872,3361,4246,3885,1967,2908,5265,6315,null,1000],"Travel/Parking":[null,null,176,2,142,285,364,298,277,310,136,353]},"2023":{"Contractor chiros":[15616,13203,4348,7656,19932,12111,14232,9230,3636,22861,13032,23624],"Other (suppliers, fees, misc)":[27623,19974,15150,19427,46860,42375,21499,19653,26312,25173,21743,28009],"Marketing":[3512,1851,1964,1545,2288,1193,3363,4292,4729,4907,4755,5219],"Tax/gov":[2215,4010,2929,3230,3912,2615,3965,1644,4230,3197,2639,4739],"Personnel":[3852,1972,3803,6846,3367,5721,5264,3606,709,2818,5387,6423],"Intercompany/Owner":[9775,7803,7315,8046,13202,4937,5214,4850,3949,4539,550,5400],"Groceries":[197,223,330,215,280,368,330,372,242,379,386,347],"Travel/Parking":[348,272,318,455,301,605,309,396,418,373,746,770],"Software/SaaS":[108,108,108,108,108,108,139,214,114,196,166,166],"Alcohol":[null,212,null,null,null,null,null,34,null,162,null,87],"Insurance":[85,290,284,430,204,153,254,240,515,248,211,211],"Restaurants":[111,186,108,255,308,179,65,251,46,177,68,null],"Rent":[1964,null,3927,null,null,null,null,2346,null,2346,2346,2346]},"2024":{"Contractor chiros":[12148,6380,16222,11418,4103,12900,8700,8355,9315,6750,11222,18265],"Other (suppliers, fees, misc)":[32025,24116,23047,34200,27495,33587,37100,40287,47020,38986,36906,35380],"Marketing":[5450,3349,5069,6499,6544,6645,5169,5147,5158,4288,4874,3488],"Intercompany/Owner":[6981,4350,5200,5300,4700,4850,12452,7000,8300,8655,7975,9160],"Groceries":[147,142,113,253,158,237,75,232,174,203,140,186],"Tax/gov":[4089,4359,3489,3652,3618,3918,15089,4709,4585,4519,4380,4524],"Travel/Parking":[487,617,523,629,668,536,396,579,563,556,584,545],"Software/SaaS":[254,219,219,219,327,395,348,389,367,370,370,424],"Insurance":[254,387,272,261,452,698,774,316,null,716,322,null],"Personnel":[3390,7515,8962,null,5001,2289,7468,null,null,3392,100,null],"Restaurants":[113,22,131,151,181,173,102,126,46,18,null,null],"Alcohol":[41,null,null,null,null,null,null,null,null,null,null,null],"Rent":[2346,2346,2346,2346,2346,2346,null,null,null,null,null,null]},"2025":{"Other (suppliers, fees, misc)":[44064,22610,41896,29897,33902,47675,44609,55687,35600,36013,42048,39911],"Alcohol":[null,null,null,null,null,78,null,null,null,null,238,135],"Contractor chiros":[9980,19902,17746,9890,12456,15019,16430,7082,13200,7500,14786,18601],"Marketing":[4269,5708,3517,6506,6355,2891,4638,3456,5984,7211,5863,3245],"Tax/gov":[6123,3575,5001,3960,8748,2820,2997,4088,6174,3667,7970,5522],"Travel/Parking":[428,438,537,794,664,716,708,1157,978,1090,1089,1167],"Software/SaaS":[365,365,365,365,387,388,452,427,478,595,434,430],"Groceries":[154,114,128,136,145,136,280,196,136,198,306,210],"Intercompany/Owner":[10051,5199,6270,5610,19000,3208,31982,10811,11896,8953,7555,4500],"Restaurants":[67,34,61,null,60,null,30,70,98,null,null,null],"Personnel":[100,10551,464,2516,8842,2533,null,2264,2870,null,null,null],"Insurance":[1169,null,null,142,312,338,1332,185,288,null,null,230],"Rent":[null,null,150,null,4293,716,1431,1431,1431,1431,1431,1430]},"2026":{"Alcohol":[null,null,null,110,null,68,null,null,null,null,null,null],"Groceries":[232,204,349,290,280,113,null,null,null,null,null,null],"Other (suppliers, fees, misc)":[40969,48313,52745,66301,49636,24353,null,null,null,null,null,null],"Travel/Parking":[934,1122,1219,1262,995,1078,null,null,null,null,null,null],"Software/SaaS":[411,491,428,419,334,276,null,null,null,null,null,null],"Marketing":[3393,6422,3510,4002,3860,1955,null,null,null,null,null,null],"Contractor chiros":[15256,5328,10956,10725,28092,4868,null,null,null,null,null,null],"Tax/gov":[6488,11898,7648,6016,11868,3346,null,null,null,null,null,null],"Intercompany/Owner":[7735,8000,6055,10050,13455,null,null,null,null,null,null,null],"Insurance":[177,null,241,265,413,702,null,null,null,null,null,null],"Rent":[1430,1430,3290,null,2862,34,null,null,null,null,null,null],"Restaurants":[13,null,5,46,null,null,null,null,null,null,null,null]}}};
const WASTE_LOCS = ["All","Utrecht","Bussum","Amstelveen","Rotterdam","Holding"];

app.get("/waste", gate, (_req,res)=>{ try {
  const sections = WASTE_LOCS.map((loc,idx)=>{
    const yrs=Object.keys(WASTE_FULL[loc]||{}).sort();
    if(!yrs.length) return "";
    const ybtns=yrs.map(y=>`<button data-wy="${loc}" data-year="${y}" onclick='drawWaste("${loc}","${y}")' style="padding:5px 10px;margin:0 6px 6px 0;border:1px solid #e5e7eb;background:#fff;border-radius:6px;font-size:12px;cursor:pointer;color:#6B7686">${y}${y==="2026"?" YTD":""}</button>`).join("");
    return `<section data-loc="${loc}" style="display:${idx===0?"":"none"}">
      <div style="margin:6px 0 4px">${ybtns}</div>
      <div class="card" style="overflow-x:auto"><div id="wt-${loc}"></div></div>
      <div id="wa-${loc}" class="advice">Click any category row to see live advice for it.</div>
    </section>`;
  }).join("");

  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spend drill-down \u2014 Posturefixx</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:1080px;margin:24px auto;padding:0 16px;color:#16202E}
h1{font-size:22px;margin:0 0 2px}.sub{color:#64748b;font-size:13px;margin-bottom:18px}
.tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}.tab{padding:8px 14px;border-radius:8px;background:#f1f5f9;cursor:pointer;font-size:13px;font-weight:600}.tab.on{background:#16202E;color:#fff}
.card{border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin-bottom:14px}
.advice{background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;padding:12px 14px;border-radius:10px;font-size:13.5px;line-height:1.55;margin-bottom:16px}
table{border-collapse:collapse;width:100%;font-size:12px;white-space:nowrap}td,th{padding:6px 8px;border-bottom:1px solid #f1f5f9}.num{text-align:right;font-variant-numeric:tabular-nums}th{color:#64748b;font-size:11px;text-align:right}
tbody tr:hover{background:#f8fafc}a{color:#2563EB}</style></head><body>
<h1>Where the money goes \u2014 drill-down</h1><div class="sub">Pick a location and year, read it month by month, click a category for advice \u00b7 from your MT940 bank debits</div>
<div class="tabs" id="tabs"></div><div style="margin:0 0 12px"><button id="wtoggle" onclick="toggleWMode()" style="padding:6px 12px;border:1px solid #e5e7eb;background:#fff;border-radius:7px;font-size:12px;cursor:pointer;color:#16202E">Show % of spend</button> <span style="color:#94a3b8;font-size:12px">\u2014 flip the table between euros and each category\u2019s share of the month/year</span></div>${sections}
<p class="sub">Pages: <a href="/plan">/plan</a> \u00b7 <a href="/revenue">/revenue</a> \u00b7 <a href="/marketing">/marketing</a> \u00b7 <a href="/waste">/waste</a> \u00b7 <a href="/pva">/pva</a> \u00b7 <a href="/ca">/ca</a> \u00b7 <a href="/coach">/coach</a></p>
<script>
var WF={"Utrecht":{"2021":{"Card & fees":[null,null,160,660,28,200,28,68,188,313,963,927],"Accounting / legal":[null,null,null,1332,182,31,31,226,null,61,61,836],"Supplies/equipment":[null,null,12630,4450,95,139,296,52,120,1095,8,187],"Other":[null,null,1155,610,561,406,549,737,836,1122,483,935],"Chiro wages":[null,null,null,267,133,198,133,133,333,133,133,2333],"Rent":[null,null,null,null,1982,1830,1830,1830,1830,1830,1830,1830],"Owner / intercompany":[null,null,null,4375,null,1000,3079,3211,3393,3000,2000,4604],"Groceries":[null,null,null,15,86,44,65,44,45,47,120,163],"Marketing":[null,null,null,1983,2320,1654,2156,1645,1648,2091,2757,2262],"Personnel \u00b7 payroll":[null,null,null,null,2101,1425,1425,1425,1425,1425,1584,1425],"Tax":[null,null,null,null,208,465,484,485,465,1786,1786,693],"Insurance":[null,null,null,null,null,null,96,74,74,null,148,74],"Software/SaaS":[null,null,null,101,35,null,null,null,null,null,null,null]},"2022":{"Chiro wages":[284,3133,633,133,633,3133,1933,7583,2517,7401,null,7814],"Other":[984,1159,1034,983,1231,815,995,1331,1512,1732,700,2259],"Marketing":[2743,3902,3940,3502,2585,2265,2421,2040,1513,1224,1726,1342],"Card & fees":[702,1087,649,1091,933,1707,972,623,1762,509,2135,1790],"Groceries":[167,69,151,119,134,113,113,151,66,52,45,59],"Supplies/equipment":[87,293,115,427,null,118,422,461,702,166,58,432],"Owner / intercompany":[4036,12218,3800,4757,5957,4379,2816,3000,4245,5371,5682,10862],"Rent":[1830,1830,1830,1964,1964,1964,1964,1964,1964,1964,1964,1964],"Accounting / legal":[null,170,125,31,31,31,31,31,31,null,63,31],"Personnel \u00b7 payroll":[1647,2977,1442,1465,2167,1525,1525,1724,1771,1775,1897,1752],"Tax":[1581,2140,1392,1398,500,521,523,562,547,635,641,446],"Insurance":[113,204,146,146,313,84,84,97,84,84,84,84],"Travel/parking":[null,null,4,2,null,null,null,null,null,null,null,null]},"2023":{"Chiro wages":[4844,6604,3864,7856,20964,9831,11836,9565,6086,14335,9600,23459],"Other":[2512,2632,1161,3229,1255,1601,3217,551,489,228,809,1327],"Marketing":[1953,664,1587,1008,1097,759,2066,2261,2526,1772,2296,1915],"Supplies/equipment":[448,256,229,190,777,4652,1359,143,29,22,66,292],"Tax":[3090,2293,1242,1144,1006,916,1012,901,1056,1096,961,1821],"Card & fees":[2451,1594,700,1747,2526,1300,1848,2087,1102,1379,1513,1388],"Personnel \u00b7 payroll":[3650,3056,3037,2768,1190,3127,2790,3057,null,1190,1735,2218],"Owner / intercompany":[7295,6110,6015,5956,4818,4396,2518,1450,1607,1440,450,2200],"Groceries":[91,96,123,88,133,239,209,140,18,34,14,125],"Travel/parking":[null,null,50,455,301,740,399,420,418,111,229,204],"Software/SaaS":[null,null,10,10,10,10,10,110,10,10,10,68],"Accounting / legal":[null,33,null,61,null,null,null,null,null,null,340,340],"Insurance":[85,290,153,153,153,153,153,190,465,197,161,161],"CA wages":[null,null,40,null,null,null,null,null,1279,null,1190,null],"Rent":[1964,null,3927,null,null,null,null,null,null,null,null,null]},"2024":{"Chiro wages":[7210,8465,18150,13064,3822,15468,11022,12410,13992,7825,13549,16471],"Other":[2002,1511,1091,490,1053,763,481,297,407,1670,437,304],"Supplies/equipment":[341,318,492,40,5,5,105,5,5,215,46,133],"Marketing":[3205,2151,3256,2224,1937,2232,849,975,1045,923,1384,1103],"Owner / intercompany":[3945,2350,1350,null,null,null,55,55,1000,2370,2460,2910],"Card & fees":[1987,1150,2044,2044,1963,1419,1559,1908,988,1522,1605,1499],"Groceries":[47,49,16,27,40,151,3,12,1,73,49,110],"Tax":[1467,1452,1436,1398,1433,1382,2573,1852,1492,1385,1557,1415],"CA wages":[2489,200,279,2489,200,200,200,2549,2489,2660,2489,2489],"Accounting / legal":[359,359,null,359,359,359,359,359,359,359,359,359],"Travel/parking":[138,205,128,123,223,301,211,112,120,141,122,111],"Software/SaaS":[157,122,122,122,122,122,124,124,124,125,125,121],"Insurance":[203,336,221,261,221,459,774,316,null,716,322,null],"Personnel \u00b7 payroll":[1000,4175,3922,null,4230,4401,4792,null,null,1250,100,null],"Energy/utilities":[420,null,null,null,null,null,null,null,null,null,null,null]},"2025":{"Supplies/equipment":[129,192,105,63,12,379,24,5,120,60,71,112],"Other":[686,358,553,567,462,2040,683,306,503,3,1170,96],"Card & fees":[1406,1341,1484,1737,1333,1892,1194,1115,1167,1228,1105,1150],"Chiro wages":[11050,15222,6338,5844,4049,8979,3659,3376,9175,1521,7942,3798],"Marketing":[1073,1199,1201,2297,1725,1188,888,1420,1900,2263,1986,1119],"Tax":[1502,1607,1491,1491,2696,1271,1271,963,1173,1008,1037,1091],"CA wages":[2489,200,2576,2576,200,486,3157,2748,2680,2379,2576,2584],"Travel/parking":[158,91,96,98,74,211,101,170,8,56,82,90],"Accounting / legal":[null,null,null,null,null,null,1974,1843,551,679,573,3188],"Software/SaaS":[123,123,123,123,123,123,123,123,123,124,124,125],"Groceries":[34,57,87,93,73,95,178,154,72,101,157,108],"Energy/utilities":[null,null,null,null,null,220,220,262,262,262,262,262],"Insurance":[44,null,null,44,22,232,132,53,106,53,53,359],"Owner / intercompany":[1350,293,3093,3093,6000,1926,3322,6250,5800,3950,3200,3000],"Personnel \u00b7 payroll":[100,4294,1805,null,4242,2376,null,null,null,null,null,null]},"2026":{"Other":[1555,1645,624,471,97,246,null,null,null,null,null,null],"Groceries":[121,104,130,88,74,79,null,null,null,null,null,null],"Card & fees":[1121,1031,1125,1191,1355,1615,null,null,null,null,null,null],"Travel/parking":[87,100,57,100,50,73,null,null,null,null,null,null],"Software/SaaS":[106,106,106,106,106,104,null,null,null,null,null,null],"Supplies/equipment":[94,32,5,53,5,102,null,null,null,null,null,null],"Accounting / legal":[989,459,478,2943,586,675,null,null,null,null,null,null],"Marketing":[1110,1808,1206,1973,1265,564,null,null,null,null,null,null],"Energy/utilities":[42,248,206,206,206,206,null,null,null,null,null,null],"Tax":[1254,2351,1240,9,4777,1537,null,null,null,null,null,null],"Insurance":[53,53,53,53,53,359,null,null,null,null,null,null],"CA wages":[2598,2595,1920,2834,2395,440,null,null,null,null,null,null],"Chiro wages":[8374,7715,10497,7852,11816,2844,null,null,null,null,null,null],"Owner / intercompany":[null,null,500,720,500,null,null,null,null,null,null,null]}},"Bussum":{"2022":{"Chiro wages":[null,null,null,16,null,null,9,36,null,3460,18,4312],"Other":[null,1313,57,461,1728,1161,210,443,386,1114,507,1752],"Travel/parking":[null,22,329,6,262,393,364,298,277,292,136,353],"Marketing":[null,null,null,401,1183,728,574,741,245,317,1115,1064],"Rent":[null,8333,null,2083,2083,2083,null,4167,2083,2083,2083,2083],"Tax":[null,null,null,null,1787,489,131,676,908,624,783,588],"Groceries":[null,null,null,56,111,101,48,68,30,20,47,84],"Owner / intercompany":[null,13850,2332,600,183,948,2730,6630,2664,1981,4234,3511],"Card & fees":[null,28,1962,220,398,305,680,988,2355,1187,1227,1126],"Personnel \u00b7 payroll":[null,null,null,null,642,1198,1467,908,843,2167,504,1382],"Supplies/equipment":[null,341,100,8512,488,152,241,726,918,null,17,95],"Financing/loans":[null,1594,1586,1578,1570,1562,1555,1547,1539,1531,1524,1516],"Accounting / legal":[null,null,null,null,31,166,null,31,31,31,166,null],"Software/SaaS":[null,null,null,null,null,85,null,null,null,null,null,null],"Insurance":[null,null,null,null,null,234,null,null,null,null,null,null]},"2023":{"Rent":[2083,2083,2283,2283,2283,2283,2283,2283,2283,2283,2283,2283],"Groceries":[50,36,34,27,39,20,25,35,33,78,53,16],"Card & fees":[962,728,426,584,601,1398,347,665,945,955,880,2642],"Tax":[181,1310,1229,1654,1177,1711,1777,515,2857,1321,439,1231],"Other":[658,608,130,87,651,1107,203,399,81,217,587,191],"Accounting / legal":[231,null,null,31,null,null,null,null,null,null,340,340],"CA wages":[null,null,null,null,null,766,null,532,3827,1590,1479,668],"Travel/parking":[348,272,318,null,null,6,101,135,null,13,53,61],"Energy/utilities":[null,null,null,null,null,260,260,260,260,260,260,260],"Chiro wages":[4500,6299,500,2050,1750,1750,4677,2050,995,2855,2250,2214],"Marketing":[1860,1187,568,1052,1269,637,1239,1026,150,337,1158,420],"Software/SaaS":[null,null,null,null,null,null,null,null,null,null,null,57],"Insurance":[null,null,131,276,50,null,100,50,50,50,50,50],"Supplies/equipment":[562,null,null,null,6,null,30,13,null,171,28,null],"Owner / intercompany":[2575,2000,1750,2090,null,541,1612,1683,442,1290,100,null],"Financing/loans":[1508,1500,1492,1485,1477,1469,1461,1454,1446,1438,1430,null],"Personnel \u00b7 payroll":[3227,2146,2025,3834,2177,1099,2474,1866,null,null,null,null]},"2024":{"Rent":[2283,2283,2283,2283,2283,2283,2283,2283,2283,2283,2283,2283],"Marketing":[660,691,710,1131,813,1207,1139,784,1140,1221,1197,1042],"Card & fees":[2726,3151,2387,2440,1716,1477,1763,2291,2359,2899,2313,2807],"CA wages":[700,200,200,200,200,1200,2570,2571,2571,1842,2497,2642],"Tax":[382,509,382,725,255,660,397,1148,1311,1289,1046,1331],"Other":[545,281,334,2172,651,544,1301,245,408,417,141,198],"Travel/parking":[73,84,106,199,232,205,77,414,164,149,226,206],"Energy/utilities":[260,260,260,260,347,260,260,260,260,260,260,260],"Software/SaaS":[57,57,57,57,57,57,49,69,59,59,59,59],"Chiro wages":[1616,1836,1836,1836,1836,1836,1836,2136,3736,null,1927,1900],"Accounting / legal":[428,359,null,359,321,359,359,359,359,359,359,null],"Groceries":[18,17,22,61,63,25,24,113,4,7,6,null],"Personnel \u00b7 payroll":[70,653,300,null,null,null,null,null,null,500,null,null],"Owner / intercompany":[786,500,null,3000,2200,4350,10452,2500,1800,705,null,null],"Supplies/equipment":[573,38,null,null,48,245,459,69,87,325,null,null],"Insurance":[51,51,51,null,231,239,null,null,null,null,null,null]},"2025":{"Other":[206,291,16,784,115,1513,723,28,474,74,140,25],"Rent":[2283,null,4660,2377,null,4753,2377,2377,null,4753,2377,2377],"Chiro wages":[1900,1900,3400,3400,5300,null,3522,3400,5300,1500,3400,6606],"Card & fees":[3128,3192,2458,2223,2153,1827,1894,1903,2162,858,619,1097],"Tax":[1473,1059,1059,1058,1019,673,673,735,900,694,676,577],"CA wages":[2642,200,200,2284,200,2384,2118,2120,2409,2189,2227,2183],"Travel/parking":[142,54,130,356,296,222,282,275,80,190,197,108],"Accounting / legal":[null,null,null,null,null,null,2028,816,389,623,570,570],"Energy/utilities":[260,260,260,260,260,319,319,319,319,319,319,319],"Marketing":[1025,1061,426,1319,2260,102,1056,574,1445,1662,1382,722],"Software/SaaS":[59,59,59,59,59,59,61,61,61,61,61,61],"Insurance":[null,null,null,null,null,260,21,21,21,21,21,21],"Owner / intercompany":[200,110,null,null,null,1282,null,1400,900,1000,55,null],"Supplies/equipment":[null,null,null,null,null,null,104,null,null,null,284,null],"Groceries":[17,null,null,11,null,null,null,null,null,15,20,null],"Personnel \u00b7 payroll":[null,2442,2184,null,2084,null,null,null,null,null,null,null]},"2026":{"Card & fees":[978,831,660,925,1522,1062,null,null,null,null,null,null],"Travel/parking":[200,203,255,237,215,372,null,null,null,null,null,null],"Insurance":[21,21,21,21,21,253,null,null,null,null,null,null],"Accounting / legal":[582,459,459,548,488,488,null,null,null,null,null,null],"Chiro wages":[null,1957,1068,2781,2759,2057,null,null,null,null,null,null],"Marketing":[587,1288,581,1267,607,540,null,null,null,null,null,null],"Energy/utilities":[319,319,319,319,null,213,null,null,null,null,null,null],"CA wages":[2421,2421,2421,2645,2161,240,null,null,null,null,null,null],"Software/SaaS":[61,61,61,61,61,61,null,null,null,null,null,null],"Other":[88,286,1762,271,322,350,null,null,null,null,null,null],"Tax":[629,933,738,922,761,12,null,null,null,null,null,null],"Rent":[2377,2377,2442,2442,null,2442,null,null,null,null,null,null],"Owner / intercompany":[1000,null,500,3000,3000,null,null,null,null,null,null,null],"Groceries":[null,null,null,23,25,null,null,null,null,null,null,null],"Supplies/equipment":[35,null,null,null,null,null,null,null,null,null,null,null]}},"Amstelveen":{"2023":{"Marketing":[null,null,null,null,null,62,200,1254,2255,3093,2448,3971],"Other":[null,null,null,null,946,1355,39,1592,4336,2696,1886,2399],"Groceries":[null,null,null,null,null,null,null,93,91,151,140,63],"Personnel \u00b7 payroll":[null,null,null,null,null,null,null,null,709,1628,null,4205],"Card & fees":[null,null,null,null,657,33,null,201,75,201,124,1656],"Owner / intercompany":[null,null,null,null,8484,null,1084,1717,2651,1809,3432,3200],"Supplies/equipment":[null,null,null,null,7314,16557,503,125,1158,2966,2970,153],"Chiro wages":[null,null,null,null,9115,null,null,2346,null,2849,2346,4993],"Accounting / legal":[null,null,null,null,null,null,null,null,null,null,392,457],"CA wages":[null,null,null,null,null,null,null,null,null,null,null,545],"Travel/parking":[null,null,null,null,null,null,null,null,null,249,463,505],"Software/SaaS":[null,null,null,null,null,null,null,null,null,null,null,51],"Tax":[null,null,null,null,null,null,null,null,154,642,741,null],"Financing/loans":[null,null,null,null,null,1230,1224,1218,1212,1206,1200,null]},"2024":{"Software/SaaS":[51,51,51,51,160,228,186,216,204,206,206,267],"Marketing":[1681,1382,2600,3144,2568,1868,1809,1947,2955,2539,2859,2627],"Card & fees":[1285,1657,1295,1946,2153,1777,3500,2182,2936,2175,1399,2135],"Owner / intercompany":[2250,2000,3850,2300,2500,500,6000,4500,6150,5600,5515,6250],"CA wages":[832,200,200,783,200,837,783,1908,1670,1596,1869,2098],"Supplies/equipment":[241,null,185,2269,507,7484,2655,3762,5403,5037,3729,4062],"Tax":[562,1490,751,622,620,606,612,732,856,832,769,806],"Accounting / legal":[557,457,null,457,457,457,null,382,417,417,417,775],"Other":[865,243,2470,1676,742,762,526,1009,727,883,614,1432],"Groceries":[62,62,64,155,44,50,37,95,158,112,59,62],"Travel/parking":[276,329,289,307,287,208,226,252,261,298,237,228],"Chiro wages":[3963,4348,4505,4182,4182,4182,4232,4232,6132,6843,4291,4296],"Personnel \u00b7 payroll":[2909,2840,2790,null,2712,null,2676,null,null,null,null,null]},"2025":{"Owner / intercompany":[8500,4889,4935,4110,14500,null,3675,4135,6376,4003,3500,3000],"Travel/parking":[128,274,310,340,295,283,241,701,838,844,806,969],"Groceries":[90,44,27,18,58,26,75,21,24,26,103,74],"Software/SaaS":[206,206,206,206,228,220,221,221,271,224,227,224],"Supplies/equipment":[7851,2939,3889,103,2679,4451,5256,4593,132,510,310,806],"Other":[1381,359,717,2014,572,606,2416,1288,1151,449,858,2064],"Card & fees":[2491,2373,3133,2785,2447,4864,2246,2586,2487,2440,2660,2467],"Chiro wages":[4627,4458,8418,5962,6628,4096,7910,4723,8441,5941,7400,4570],"Marketing":[2747,2690,2937,3532,3412,1922,3402,1680,3540,3225,2794,1580],"Tax":[856,null,1324,537,1451,896,676,896,1667,551,2599,1630],"CA wages":[2098,200,700,200,1058,2430,1048,1122,1622,7092,4027,5190],"Insurance":[1125,null,null,98,290,106,1332,185,288,null,null,230],"Accounting / legal":[null,null,null,null,null,null,1856,1293,814,576,576,576],"Personnel \u00b7 payroll":[null,3814,2380,2516,4749,null,null,2264,null,null,null,null],"Rent":[null,null,null,null,4293,716,1431,null,null,null,null,null]},"2026":{"Other":[773,652,2395,3553,883,375,null,null,null,null,null,null],"Card & fees":[3213,2739,2975,2300,2576,2526,null,null,null,null,null,null],"Travel/parking":[646,796,883,870,639,626,null,null,null,null,null,null],"Insurance":[177,null,241,265,413,471,null,null,null,null,null,null],"Software/SaaS":[224,303,240,215,130,111,null,null,null,null,null,null],"Accounting / legal":[1373,459,2703,972,682,607,null,null,null,null,null,null],"Chiro wages":[4536,7913,8227,7881,14010,2419,null,null,null,null,null,null],"Supplies/equipment":[2721,65,49,4798,435,281,null,null,null,null,null,null],"Marketing":[2026,2891,1680,2822,1751,1038,null,null,null,null,null,null],"CA wages":[4766,5319,3623,4085,3971,440,null,null,null,null,null,null],"Groceries":[38,31,93,41,46,null,null,null,null,null,null,null],"Owner / intercompany":[5500,6000,2055,2385,4055,null,null,null,null,null,null,null],"Tax":[2187,2262,2995,797,3882,null,null,null,null,null,null,null],"Rent":[null,null,425,null,null,null,null,null,null,null,null,null]}},"Rotterdam":{"2025":{"Marketing":[null,null,null,null,null,null,null,null,60,186,1852,1976],"Tax":[null,null,null,null,null,null,null,null,1020,null,2202,772],"Card & fees":[null,null,null,null,null,null,null,null,57,345,51,16],"Software/SaaS":[null,null,null,null,null,null,61,36,36,36,36,36],"CA wages":[null,null,null,null,null,null,null,2576,2870,2799,2527,2749],"Other":[null,null,null,null,null,null,1169,44,1250,643,395,160],"Rent":[null,null,null,null,null,null,null,1431,1431,1431,1431,1430],"Groceries":[null,null,null,null,null,null,9,null,14,26,12,12],"Insurance":[null,null,null,null,null,null,null,null,null,null,234,189],"Travel/parking":[null,null,null,null,null,null,null,null,null,null,4,null],"Owner / intercompany":[null,null,null,null,null,null,376,526,null,null,1000,null],"Supplies/equipment":[null,null,null,null,null,null,3702,18466,166,13,null,null]},"2026":{"Other":[418,918,1582,557,492,939,null,null,null,null,null,null],"Card & fees":[45,78,143,189,69,1420,null,null,null,null,null,null],"Groceries":[58,45,102,113,119,33,null,null,null,null,null,null],"Marketing":[864,1943,1427,2133,1520,1220,null,null,null,null,null,null],"Travel/parking":[null,null,24,null,null,6,null,null,null,null,null,null],"Supplies/equipment":[698,93,814,1198,263,12,null,null,null,null,null,null],"Accounting / legal":[null,null,null,2525,30,30,null,null,null,null,null,null],"CA wages":[2785,2643,2885,2953,2633,240,null,null,null,null,null,null],"Rent":[1430,1430,2865,null,2862,34,null,null,null,null,null,null],"Insurance":[189,189,189,189,189,189,null,null,null,null,null,null],"Energy/utilities":[null,null,42,42,42,42,null,null,null,null,null,null],"Owner / intercompany":[1235,2000,3000,4000,5900,null,null,null,null,null,null,null],"Tax":[1004,994,856,1099,994,null,null,null,null,null,null,null],"Software/SaaS":[36,36,36,53,53,null,null,null,null,null,null,null]}},"Holding":{"2020":{"Accounting / legal":[null,null,null,null,null,null,null,null,null,115,932,876],"Card & fees":[null,null,null,null,null,null,11,51,10,10,11,10],"Tax":[null,null,null,null,null,null,null,null,null,null,null,68],"Other":[null,null,null,null,null,null,null,null,null,283,null,979],"Supplies/equipment":[null,null,null,null,null,null,1424,null,null,null,null,null]},"2021":{"Card & fees":[12,11,12,10,12,11,11,10,10,11,11,93],"Tax":[null,null,null,null,null,null,null,null,null,53,null,null],"Accounting / legal":[115,null,null,null,115,null,115,null,null,115,null,null],"Other":[370,1787,null,1355,434,124,null,null,null,43,null,null],"Owner / intercompany":[null,null,100,null,null,null,null,1000,null,null,null,null],"Chiro wages":[null,null,null,4375,null,null,null,null,null,null,null,null],"Rent":[null,4235,null,null,null,null,null,null,null,null,null,null],"Supplies/equipment":[null,1171,null,null,null,null,null,null,null,null,null,null]},"2022":{"Other":[76,700,1737,null,200,54,null,null,434,null,357,2390],"Owner / intercompany":[null,null,null,270,1500,2688,2460,3674,4422,4149,6298,3149],"Card & fees":[11,214,13,16,21,24,23,22,22,23,23,24],"Accounting / legal":[null,117,null,null,331,2217,871,208,31,63,211,4031],"Tax":[null,null,null,null,1323,1294,1294,5582,906,906,906,906],"Marketing":[112,842,734,381,1077,1035,690,null,1246,2307,2818,2680],"Chiro wages":[null,5000,241,null,3511,2990,null,null,null,null,5291,null],"Supplies/equipment":[null,825,682,694,null,null,null,206,null,50,null,null]},"2023":{"Card & fees":[402,71,183,658,313,209,24,25,67,54,54,108],"Owner / intercompany":[3432,3432,3432,3400,3432,3432,null,550,500,2382,3432,3432],"Tax":[906,922,922,922,1668,922,1990,922,922,922,1192,2259],"Accounting / legal":[4582,1438,985,1696,1711,304,2506,1717,1377,1377,304,304],"Other":[91,329,544,55,1117,1093,1312,513,402,null,140,65],"Chiro wages":[6177,null,null,null,7926,2780,null,null,null,9719,null,3022],"Marketing":[2689,2115,1494,1363,1438,1337,811,1016,508,762,null,null],"Supplies/equipment":[null,null,null,null,929,279,911,null,31,null,null,null],"Software/SaaS":[null,null,null,null,null,null,25,null,null,null,null,null]},"2024":{"Owner / intercompany":[3432,3016,2300,4230,3265,3265,3265,3265,5265,4530,3265,3765],"Tax":[2223,1527,1491,1491,1527,1543,8026,1527,1491,1532,1527,1491],"Card & fees":[76,25,22,260,25,26,25,28,28,28,28,28],"Accounting / legal":[1229,null,631,386,359,321,4239,970,321,321,321,1560],"Financing/loans":[null,null,200,200,200,200,200,200,200,200,200,200],"Other":[1088,20,466,388,1796,115,500,105,125,244,1118,140],"Supplies/equipment":[null,344,null,null,null,null,null,null,null,null,23,null],"Marketing":[null,null,null,null,1226,1339,1500,3010,1669,1510,1510,null],"CA wages":[null,null,null,null,600,600,600,600,null,null,null,null],"Chiro wages":[7948,null,null,2718,2603,null,null,null,null,null,null,null]},"2025":{"Card & fees":[326,577,418,289,285,471,29,31,32,31,1278,1272],"Owner / intercompany":[4766,3265,5179,3265,3265,5000,30756,2300,4145,2025,5151,5325],"Other":[462,60,481,53,57,1571,657,1205,630,1361,707,340],"Tax":[2982,1470,1434,1434,3941,null,397,1514,1434,1434,1476,1472],"Financing/loans":[200,200,200,200,200,200,200,200,200,200,200,200],"Chiro wages":[1500,3040,5519,null,null,5815,2785,null,null,2600,4616,4305],"Travel/parking":[null,null,null,null,null,null,null,null,35,null,null,null],"Accounting / legal":[null,218,null,null,null,null,861,null,null,null,null,null],"Supplies/equipment":[149,null,123,null,10000,8032,null,null,null,null,null,null],"Marketing":[807,1815,null,null,null,null,null,null,null,null,null,null]},"2026":{"Other":[1118,305,324,2999,1461,4130,null,null,null,null,null,null],"Marketing":[203,null,null,null,null,598,null,null,null,null,null,null],"Accounting / legal":[null,null,null,252,252,252,null,null,null,null,null,null],"Tax":[1434,5378,1592,3198,1475,1818,null,null,null,null,null,null],"Chiro wages":[8971,190,6010,2811,19754,null,null,null,null,null,null,null],"Card & fees":[43,1260,1883,1249,1244,null,null,null,null,null,null,null],"Travel/parking":[null,23,null,null,92,null,null,null,null,null,null,null],"Owner / intercompany":[1325,6651,4455,4455,3455,null,null,null,null,null,null,null],"Financing/loans":[200,200,200,200,200,null,null,null,null,null,null,null],"Coaching/training":[null,null,null,4229,null,null,null,null,null,null,null,null]}},"All":{"2020":{"Accounting / legal":[null,null,null,null,null,null,null,null,null,115,932,876],"Card & fees":[null,null,null,null,null,null,11,51,10,10,11,10],"Tax":[null,null,null,null,null,null,null,null,null,null,null,68],"Other":[null,null,null,null,null,null,null,null,null,283,null,979],"Supplies/equipment":[null,null,null,null,null,null,1424,null,null,null,null,null]},"2021":{"Card & fees":[12,11,173,670,40,211,39,78,198,324,973,1021],"Accounting / legal":[115,null,null,1332,297,31,146,226,null,176,61,836],"Supplies/equipment":[null,1171,12630,4450,95,139,296,52,120,1095,8,187],"Other":[370,1787,1155,1965,995,530,549,737,836,1166,483,935],"Chiro wages":[null,null,null,4641,133,198,133,133,333,133,133,2333],"Rent":[null,4235,null,null,1982,1830,1830,1830,1830,1830,1830,1830],"Owner / intercompany":[null,null,100,4375,null,1000,3079,4211,3393,3000,2000,4604],"Groceries":[null,null,null,15,86,44,65,44,45,47,120,163],"Marketing":[null,null,null,1983,2320,1654,2156,1645,1648,2091,2757,2262],"Personnel \u00b7 payroll":[null,null,null,null,2101,1425,1425,1425,1425,1425,1584,1425],"Tax":[null,null,null,null,208,465,484,485,465,1839,1786,693],"Insurance":[null,null,null,null,null,null,96,74,74,null,148,74],"Software/SaaS":[null,null,null,101,35,null,null,null,null,null,null,null]},"2022":{"Chiro wages":[284,8133,874,149,4145,6123,1942,7619,2517,10861,5309,12126],"Other":[1060,3172,2828,1443,3159,2030,1206,1774,2332,2845,1564,6401],"Marketing":[2855,4744,4674,4285,4845,4027,3684,2781,3003,3848,5660,5086],"Card & fees":[713,1329,2624,1327,1352,2035,1675,1633,4139,1718,3385,2940],"Groceries":[167,69,151,176,245,214,161,219,96,72,92,143],"Supplies/equipment":[87,1459,896,9634,488,270,663,1392,1620,216,75,527],"Owner / intercompany":[4036,26068,6131,5627,7639,8014,8006,13304,11331,11501,16213,17522],"Rent":[1830,10163,1830,4047,4047,4047,1964,6130,4047,4047,4047,4047],"Accounting / legal":[null,288,125,31,394,2414,902,271,94,94,440,4063],"Personnel \u00b7 payroll":[1647,2977,1442,1465,2810,2723,2992,2632,2614,3941,2401,3133],"Tax":[1581,2140,1392,1398,3610,2304,1948,6820,2361,2165,2330,1940],"Insurance":[113,204,146,146,313,318,84,97,84,84,84,84],"Travel/parking":[null,22,333,8,262,393,364,298,277,292,136,353],"Financing/loans":[null,1594,1586,1578,1570,1562,1555,1547,1539,1531,1524,1516],"Software/SaaS":[null,null,null,null,null,85,null,null,null,null,null,null]},"2023":{"Chiro wages":[15522,12903,4364,9906,39756,14361,16513,13961,7081,29758,14196,33689],"Other":[3261,3569,1835,3370,3969,5155,4770,3055,5308,3141,3422,3983],"Marketing":[6502,3965,3649,3423,3804,2795,4316,5557,5439,5965,5902,6307],"Supplies/equipment":[1010,256,229,190,9025,21488,2802,281,1218,3158,3063,445],"Tax":[4177,4525,3393,3721,3851,3549,4779,2338,4988,3980,3333,5311],"Card & fees":[3814,2393,1309,2989,4097,2940,2219,2978,2189,2588,2571,5796],"Personnel \u00b7 payroll":[6877,5203,5062,6602,3367,4227,5264,4923,709,2818,1735,6423],"Owner / intercompany":[13302,11542,11196,11446,16734,8369,5214,5400,5199,6921,7413,8832],"Groceries":[141,131,157,115,172,258,234,268,142,263,207,203],"Travel/parking":[348,272,368,455,301,746,500,554,418,373,746,770],"Software/SaaS":[null,null,10,10,10,10,35,110,10,10,10,176],"Accounting / legal":[4813,1471,985,1788,1711,304,2506,1717,1377,1377,1377,1442],"Insurance":[85,290,284,430,204,153,254,240,515,248,211,211],"CA wages":[null,null,40,null,null,766,null,532,5106,1590,2669,1213],"Rent":[4047,2083,6210,2283,2283,2283,2283,2283,2283,2283,2283,2283],"Energy/utilities":[null,null,null,null,null,260,260,260,260,260,260,260],"Financing/loans":[1508,1500,1492,1485,1477,2699,2685,2672,2658,2644,2631,null]},"2024":{"Chiro wages":[20737,14648,24491,21801,12444,21486,17090,18778,23860,14668,19767,22667],"Other":[4500,2055,4361,4725,4242,2183,2809,1656,1666,3214,2310,2074],"Supplies/equipment":[1154,699,677,2309,560,7734,3219,3836,5495,5577,3798,4195],"Marketing":[5546,4224,6566,6499,6544,6645,5297,6717,6809,6194,6950,4771],"Owner / intercompany":[10413,7866,7500,9530,7965,8115,19772,10320,14215,13205,11240,12925],"Card & fees":[6074,5983,5748,6691,5857,4699,6846,6408,6310,6624,5346,6469],"Groceries":[127,129,102,242,147,226,64,221,163,192,114,172],"Tax":[4634,4978,4060,4236,3835,4191,11608,5260,5151,5038,4899,5043],"CA wages":[4020,600,679,3472,1200,2837,4153,7628,6729,6099,6855,7229],"Accounting / legal":[2573,1175,631,1561,1496,1496,4956,2070,1455,1455,1455,2694],"Travel/parking":[487,617,523,629,743,714,515,778,545,588,584,545],"Software/SaaS":[265,230,230,230,338,406,359,409,387,390,390,447],"Insurance":[254,387,272,261,452,698,774,316,null,716,322,null],"Personnel \u00b7 payroll":[3980,7667,7012,null,6943,4401,7468,null,null,1750,100,null],"Energy/utilities":[680,260,260,260,347,260,260,260,260,260,260,260],"Rent":[2283,2283,2283,2283,2283,2283,2283,2283,2283,2283,2283,2283],"Financing/loans":[null,null,200,200,200,200,200,200,200,200,200,200]},"2025":{"Supplies/equipment":[8130,3131,4117,166,12691,12863,9086,23064,419,582,665,918],"Other":[2735,1068,1766,3417,1207,5730,5647,2871,4010,2530,3272,2685],"Card & fees":[7352,7483,7493,7034,6218,9054,5362,5635,5904,4902,5713,6002],"Chiro wages":[19076,24620,23675,15205,15976,18889,17876,11499,22916,11562,23358,19279],"Marketing":[5652,6765,4565,7147,7397,3212,5346,3674,6946,7336,8015,5397],"Tax":[6813,4136,5308,4520,9107,2840,3017,4108,6194,3687,7990,5542],"CA wages":[7229,600,3476,5060,1458,5300,6323,8566,9580,14459,11358,12706],"Travel/parking":[428,419,537,794,664,716,625,1146,961,1090,1089,1167],"Accounting / legal":[null,218,null,null,null,null,6719,3952,1754,1878,1720,4335],"Software/SaaS":[388,388,388,388,410,402,466,441,492,446,448,446],"Groceries":[140,100,114,122,131,122,262,175,109,168,292,194],"Energy/utilities":[260,260,260,260,260,539,539,581,581,581,581,581],"Insurance":[1169,null,null,142,312,598,1485,259,416,75,308,799],"Owner / intercompany":[14816,8557,13207,10468,23765,8208,38130,14611,17221,10978,12906,11325],"Personnel \u00b7 payroll":[100,10551,6369,2516,11075,2376,null,2264,null,null,null,null],"Rent":[2283,null,4660,2377,4293,5469,3808,3808,1431,6184,3808,3807],"Financing/loans":[200,200,200,200,200,200,200,200,200,200,200,200]},"2026":{"Other":[3952,3806,6686,7851,3254,6040,null,null,null,null,null,null],"Groceries":[216,180,324,264,264,113,null,null,null,null,null,null],"Card & fees":[5399,5939,6786,5853,6766,6623,null,null,null,null,null,null],"Travel/parking":[934,1122,1219,1207,995,1078,null,null,null,null,null,null],"Software/SaaS":[427,507,444,435,350,276,null,null,null,null,null,null],"Supplies/equipment":[3548,191,868,6049,703,395,null,null,null,null,null,null],"Accounting / legal":[2944,1376,3639,7239,2037,2051,null,null,null,null,null,null],"Marketing":[4791,7930,4894,8194,5143,3961,null,null,null,null,null,null],"Energy/utilities":[361,567,567,567,248,461,null,null,null,null,null,null],"Tax":[6508,11918,7421,6025,11889,3367,null,null,null,null,null,null],"Insurance":[442,264,505,529,677,1271,null,null,null,null,null,null],"CA wages":[12570,12978,10849,12517,11160,1360,null,null,null,null,null,null],"Chiro wages":[21881,17774,25802,21325,48339,7320,null,null,null,null,null,null],"Owner / intercompany":[9061,14651,10510,14560,16910,null,null,null,null,null,null,null],"Rent":[3807,3807,5732,2442,2862,2477,null,null,null,null,null,null],"Financing/loans":[200,200,200,200,200,null,null,null,null,null,null,null],"Coaching/training":[null,null,null,4229,null,null,null,null,null,null,null,null]}}}; var CC={"Chiro wages":"#2563eb","CA wages":"#0891b2","Personnel \u00b7 payroll":"#7c3aed","Marketing":"#16a34a","Coaching/training":"#0ea5e9","Rent":"#ea580c","Supplies/equipment":"#db2777","Owner / intercompany":"#94a3b8","Tax":"#dc2626","Accounting / legal":"#0d9488","Energy/utilities":"#ca8a04","Card & fees":"#9333ea","Financing/loans":"#be123c","Software/SaaS":"#475569","Travel/parking":"#a16207","Insurance":"#65a30d","Groceries":"#f59e0b","Other":"#cbd5e1"};
var MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
var ADV={
 "Marketing":"Your growth lever \u2014 not a cost to cut. Google brings patients at \u20ac111 vs Meta \u20ac267, so the move is shift budget toward Google and fix Meta\u2019s intake\u2192care conversion before spending more.",
 "Other (suppliers, fees, misc)":"Biggest, least-visible bucket: contractor payouts, suppliers and card-processor fees. This is where real margin hides \u2014 itemise the top counterparties before touching anything else.",
 "Contractor chiros":"Scales with revenue, so judge it per visit. A contractor with low PVA (poor retention) is your most expensive seat \u2014 coach the PVA up rather than cutting the chair.",
 "Tax/gov":"Largely fixed. The only lever is cash-flow: set aside ~20\u201325% of revenue each month so it never lands as a lump.",
 "Personnel":"Aim to keep staff under ~35% of clinic revenue. If it\u2019s higher, the fix is filling their days (more intake\u2192care conversion), not cutting people.",
 "Rent":"Fixed cost \u2014 only lever is renegotiating at renewal or sub-letting unused hours/rooms.",
 "Software/SaaS":"Easy win: audit for tools you no longer use. Small, but pure savings with no downside.",
 "Travel/Parking":"Minor \u2014 not worth chasing. Keep an eye only if it suddenly jumps.",
 "Intercompany/Owner":"Internal money movement between your BVs (and owner draws) \u2014 not a real operating cost. Ignore it for margin decisions.",
 "Insurance":"Review once a year for overlap and over-cover; otherwise leave it.",
 "Groceries":"Tiny and mostly clinic supplies \u2014 cutting it changes nothing. Move it off the business card for clean books.",
 "Restaurants":"Tiny and already shrinking \u2014 not a lever. Move off the business card if you want tidy books.",
 "Alcohol":"Rounding error. Not worth a second thought beyond keeping the books clean.",
 "Fuel":"Rounding error \u2014 ignore.",
 "_default":"Review the top counterparties in this category to see if any single supplier is worth renegotiating."
};
var eur=function(n){return "\u20ac"+Math.round(n||0).toLocaleString("en-US");};
var sum=function(a){return (a||[]).reduce(function(x,y){return x+(y||0);},0);};
var WMODE="eur", WYEAR={};
function drawWaste(loc,year){
  var yobj=(WF[loc]||{})[year]||{};
  var cats=Object.keys(yobj).sort(function(a,b){return sum(yobj[b])-sum(yobj[a]);});
  WYEAR[loc]=year;
  var mTot=[0,0,0,0,0,0,0,0,0,0,0,0], yTot=0, pct=(WMODE==="pct");
  cats.forEach(function(c){var ar=yobj[c]; ar.forEach(function(v,i){if(v!=null)mTot[i]+=v;}); yTot+=sum(ar);});
  function fmtCell(v,colTot){ if(v==null)return "\u00b7"; return pct?(colTot>0?Math.round(100*v/colTot)+"%":"\u00b7"):eur(v); }
  var h="<table><thead><tr><th style='text-align:left'>Category</th>";
  MN.forEach(function(m){h+="<th>"+m+"</th>";}); h+="<th>Total</th></tr></thead><tbody>";
  cats.forEach(function(c){
    var arr=yobj[c];
    h+="<tr style='cursor:pointer' onclick='advise(&quot;"+loc+"&quot;,&quot;"+year+"&quot;,&quot;"+c+"&quot;)'><td style='text-align:left'><span style='display:inline-block;width:9px;height:9px;border-radius:2px;background:"+(CC[c]||'#cbd5e1')+";margin-right:6px;vertical-align:middle'></span>"+c+"</td>";
    arr.forEach(function(v,i){h+="<td class='num'>"+fmtCell(v,mTot[i])+"</td>";});
    h+="<td class='num'><b>"+(pct?(yTot>0?Math.round(100*sum(arr)/yTot)+"%":"\u00b7"):eur(sum(arr)))+"</b></td></tr>";
  });
  h+="</tbody></table>";
  var el=document.getElementById("wt-"+loc); if(el) el.innerHTML=h;
  Array.prototype.forEach.call(document.querySelectorAll("button[data-wy='"+loc+"']"),function(b){var on=b.getAttribute("data-year")===year;b.style.background=on?"#2563EB":"#fff";b.style.color=on?"#fff":"#6B7686";b.style.borderColor=on?"#2563EB":"#e5e7eb";});
  var ae=document.getElementById("wa-"+loc); if(ae) ae.innerHTML="Click any category row to see live advice for it.";
}
function toggleWMode(){WMODE=(WMODE==="eur")?"pct":"eur"; var b=document.getElementById("wtoggle"); if(b)b.textContent=(WMODE==="eur")?"Show % of spend":"Show \u20ac amounts"; Object.keys(WYEAR).forEach(function(loc){drawWaste(loc,WYEAR[loc]);});}
function advise(loc,year,cat){
  var arr=((WF[loc]||{})[year]||{})[cat]||[];
  var vals=arr.filter(function(v){return v!=null;});
  var total=sum(arr), avg=vals.length?total/vals.length:0;
  var peak=-1,peakI=-1; arr.forEach(function(v,i){if(v!=null&&v>peak){peak=v;peakI=i;}});
  var yobj=(WF[loc]||{})[year]||{}, ytot=0; Object.keys(yobj).forEach(function(c){ytot+=sum(yobj[c]);});
  var share=ytot?Math.round(100*total/ytot):0;
  var base=ADV[cat]||ADV._default;
  var flag="";
  if(avg>0 && peak>2*avg) flag=" <b>\u26a0 Spike:</b> "+MN[peakI]+" hit "+eur(peak)+" vs ~"+eur(avg)+"/mo typical \u2014 worth a look.";
  var el=document.getElementById("wa-"+loc);
  if(el) el.innerHTML="<b>"+cat+" \u00b7 "+loc+" "+year+"</b> \u2014 "+eur(total)+" ("+share+"% of this year\u2019s spend)<br>"+base+flag;
}
var locs=["All","Utrecht","Bussum","Amstelveen","Rotterdam","Holding"],el=document.getElementById("tabs");
function show(c){Array.prototype.forEach.call(document.querySelectorAll("[data-loc]"),function(s){s.style.display=s.getAttribute("data-loc")===c?"":"none"});Array.prototype.forEach.call(el.children,function(b){b.className="tab"+(b.textContent===c?" on":"")})}
locs.forEach(function(c){if(!WF[c])return; var b=document.createElement("div");b.className="tab";b.textContent=c;b.onclick=function(){show(c)};el.appendChild(b)});
locs.forEach(function(c){var ys=Object.keys(WF[c]||{}).sort(); if(ys.length) drawWaste(c, ys[ys.length-1]);});
show("All");
</script>
</body></html>`);
} catch(e){ res.status(500).send("waste error: "+e.message); } });

// ============================================================================
//  /profit — per-chiro profitability with each chiro's REAL pay structure.
//  Pay is calculated from revenue (Annefloor 45%; Lara tiered per location;
//  Myles/Matthew base salary + threshold commission). Slider = profit target
//  on top of paying everyone and your draw.
// ============================================================================
app.get("/profit", gate, (_req,res)=>{ try {
  const DEF=[
    {id:"Alex", revs:[["all clinics",23220]], base:0, note:"Owner \u2014 draws via the holding, no wage taken here."},
    {id:"Lara", revs:[["Amstelveen",7842],["Bussum",5628]], base:0, note:"37.5% on the first \u20ac5k, 42.5% \u20ac5\u201310k, 45% above \u2014 each location worked out separately, not combined."},
    {id:"Myles", revs:[["Amstelveen",13064]], base:5688, note:"Employee since Apr 2026. \u20ac5,688 gross base (\u00d7 employer factor). Bonus threshold \u20ac16,500 for the first 3 months (Apr\u2013Jun), then \u20ac17,500; 45% / 50% / 55% on revenue above it. A monthly shortfall rolls onto next month\u2019s threshold."},
    {id:"Matthew", revs:[["Utrecht + Bussum",14872]], base:4551, note:"Contract on file. Employee since Jan 2026; bonus threshold (\u20ac16,500) activates May 2026. \u20ac4,551 gross base + 8% holiday (\u00d7 employer factor here); marginal 40% / 45% / 50% on revenue above \u20ac16.5k / \u20ac21.5k / \u20ac26.5k. Shortfall rolls forward within the quarter."},
    {id:"Annefloor", revs:[["Amstelveen",1679]], base:0, note:"45% of paid invoices."},
  ];
  const row=ch=>`<tr>
    <td style="text-align:left;font-weight:600">${ch.id}${ch.base?`<div style="font-weight:400;color:#64748b;font-size:11px">\u20ac${ch.base.toLocaleString("en-US")} base</div>`:""}</td>
    <td class="num">${ch.revs.map((r,i)=>`<div style="margin:2px 0;white-space:nowrap"><span style="color:#94a3b8;font-size:11px">${r[0]}</span> <input type="number" id="rev-${ch.id}-${i}" value="${r[1]}" style="width:82px;text-align:right;border:1px solid #d1d5db;border-radius:6px;padding:3px 6px;font-size:12px"></div>`).join("")}</td>
    <td class="num" id="pay-${ch.id}" style="font-weight:600"></td>
    <td class="num" id="rate-${ch.id}" style="color:#64748b;font-size:12px"></td>
    <td class="num" id="cost-${ch.id}"></td>
    <td class="num" id="fee-${ch.id}"></td>
    <td class="num" id="profit-${ch.id}" style="font-weight:600"></td>
    <td class="num" id="margin-${ch.id}" style="font-weight:600"></td></tr>`;
  const notes=DEF.map(d=>`<li><b>${d.id}:</b> ${d.note}</li>`).join("");
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Profit per chiro \u2014 Posturefixx</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:1000px;margin:26px auto;padding:0 16px;color:#16202E}
h1{font-size:23px;margin:0 0 2px}.sub{color:#64748b;font-size:13px;margin:0 0 16px}
.card{border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin-bottom:14px}
.controls{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
.controls label{font-size:12px;color:#64748b;display:block;margin-bottom:4px}
.controls input[type=number]{width:104px;border:1px solid #d1d5db;border-radius:8px;padding:7px 9px;font-size:14px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:9px 7px;border-bottom:1px solid #f1f5f9}.num{text-align:right;font-variant-numeric:tabular-nums}
th{color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.02em;text-align:right}th:first-child{text-align:left}
.sum{display:flex;gap:14px;flex-wrap:wrap;margin-top:6px}.sum>div{flex:1;min-width:140px;border:1px solid #e5e7eb;border-radius:10px;padding:12px}.sum b{font-size:20px;display:block}.sum span{font-size:12px;color:#64748b}
.legend{color:#64748b;font-size:12px;margin-top:10px;line-height:1.6}ul{margin:8px 0 0;padding-left:18px;color:#475569;font-size:12.5px;line-height:1.7}a{color:#2563EB}
.tip{border-bottom:1px dotted #94a3b8;cursor:help}.sum .tip{border:none}.sum>div{cursor:help}
.flowrow{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:6px 0;border-bottom:1px solid #f6f8fb}
.flowrow .dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:8px;vertical-align:middle}
.flowrow .pc{color:#94a3b8;font-size:11.5px;margin-left:8px}</style></head><body>
<h1>Profit per chiropractor</h1><div class="sub">Pay is calculated from each chiro's real deal. <b>Profit is company-level</b> \u2014 what's left after paying everyone, all running costs, and your draw. The per-chiro columns split the shared costs by revenue so you can see each one's contribution. <span style="color:#94a3b8">Hover any column header for the exact calculation.</span></div>
<div class="card">
  <div class="controls">
    <div><label>Month (recorded)</label><select id="monthSel" style="padding:7px 9px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;min-width:130px"></select></div>
    <div><label>Employer costs (gross \u2192 total, \u00d7)</label><input type="number" step="0.01" id="factor" value="1.27"></div>
    <div style="flex:1;min-width:330px"><label>Other running costs \u20ac/mo \u2014 <b id="ohTot">\u20ac38,000</b> <span style="color:#94a3b8;font-weight:400">(editable; from your expense sheets)</span></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:3px">
        <span style="font-size:11px;color:#64748b">Rent<br><input type="number" id="costRent" value="9600" style="width:78px"></span>
        <span style="font-size:11px;color:#64748b">CA wages<br><input type="number" id="costCA" value="8000" style="width:78px"></span>
        <span style="font-size:11px;color:#64748b">Marketing<br><input type="number" id="costMkt" value="10000" style="width:78px"></span>
        <span style="font-size:11px;color:#64748b">Software<br><input type="number" id="costSw" value="2400" style="width:70px"></span>
        <span style="font-size:11px;color:#64748b">Other<br><input type="number" id="costOther" value="8000" style="width:78px"></span>
      </div>
    </div>
    <div><label>Your draw \u20ac/mo</label><input type="number" id="draw" value="6000"></div>
    <div style="flex:1;min-width:220px"><label>Target profit on top: <b id="targetLbl">10%</b></label><input type="range" id="target" min="0" max="30" value="10" style="width:100%"></div>
  </div>
  <table>
    <thead><tr><th>Chiro</th>
      <th><span class="tip" title="The services revenue this chiro bills the clinic per month. Edit it to model a different month.">Brings in /mo</span></th>
      <th><span class="tip" title="What this chiro is paid (gross/brutto) under their own contract \u2014 base + holiday + commission, or their %.">Pay</span></th>
      <th><span class="tip" title="Pay divided by what they bring in. How much of every euro they generate goes to their own pay.">Effective %</span></th>
      <th><span class="tip" title="Their share of the other running costs (rent, CAs, ads, software). Split by revenue: running costs \u00d7 (their revenue \u00f7 total revenue).">Cost share</span></th>
      <th><span class="tip" title="Their share of your \u20ac/mo draw, split the same way by revenue.">Your-fee share</span></th>
      <th><span class="tip" title="Their revenue minus their pay, minus their cost share, minus their fee share. What this chiro contributes to company profit.">Profit</span></th>
      <th><span class="tip" title="That profit divided by their revenue. Green = at/above target, amber = positive but below target, red = losing money.">Margin</span></th></tr></thead>
    <tbody>${DEF.map(row).join("")}</tbody>
  </table>
  <div class="legend"><b>Pay</b> is computed live from each structure below \u2014 change a chiro's revenue and watch their pay (and the commission tiers) move. <b>Cost share / fee share</b> split the other running costs and your draw across chiros by revenue. Employer factor turns Myles' & Matthew's gross base into real cost.</div>
  <ul>${notes}</ul>
</div>
<div class="card">
  <b style="font-size:15px">All clinics together</b>
  <div class="sum">
    <div title="Total services revenue billed across all clinics this month."><b id="cR"></b><span>brought in /mo</span></div>
    <div title="Sum of every chiro's pay (gross/brutto) under their contracts."><b id="cPay"></b><span>total chiro pay</span></div>
    <div title="Revenue minus all chiro pay, minus all other running costs, minus your draw. This is the company's profit."><b id="cP"></b><span>profit after pay, costs & your draw</span></div>
    <div title="Company profit divided by revenue."><b id="cM"></b><span>margin</span></div>
    <div title="Whether revenue minus pay and costs leaves enough to cover your full draw."><b id="salCov"></b><span>your draw</span></div>
    <div title="How much you'd need to lift revenue (same cost base) to reach your target margin."><b id="cNeed"></b><span>revenue lift to hit target</span></div>
  </div>
  <div class="legend">Because Myles and Matthew carry a fixed base salary, growth helps more than it looks: as their revenue rises past their thresholds, the base gets diluted and commission only takes a slice of the extra \u2014 so each step up in revenue drops more to profit. That's why the slider's "revenue lift" isn't linear.</div>
</div>
<div class="card">
  <b style="font-size:15px">Where the money goes</b>
  <div class="sub" style="margin:4px 0 10px">Every euro brought in this month and where it ends up. The green slice at the end is the company profit \u2014 that's what the margin measures.</div>
  <div id="flowBar" style="display:flex;height:28px;border-radius:8px;overflow:hidden;margin-bottom:12px;background:#f1f5f9"></div>
  <div id="flowRows"></div>
</div>
<p class="sub">Pages: <a href="/">home</a> \u00b7 <a href="/scorecard">/scorecard</a> \u00b7 <a href="/plan">/plan</a> \u00b7 <a href="/revenue">/revenue</a> \u00b7 <a href="/pva">/pva</a> \u00b7 <a href="/ca">/ca</a></p>
<script>
var DEF=[{id:"Alex",n:1},{id:"Lara",n:2},{id:"Myles",n:1},{id:"Matthew",n:1},{id:"Annefloor",n:1}];
function eur(n){return "\u20ac"+Math.round(n||0).toLocaleString("en-US");}
function laraTier(r){return 0.375*Math.min(r,5000)+0.425*Math.max(0,Math.min(r,10000)-5000)+0.45*Math.max(0,r-10000);}
function factor(){return +document.getElementById("factor").value||1.27;}
function curMonth(){var s=document.getElementById("monthSel");return (s&&s.value)?s.value:"2026-05";}
var EMP={
  Myles:{base:5688,startLabel:"Apr 2026",thr:function(ym){return ym<"2026-04"?null:(ym<="2026-06"?16500:17500);},
         comm:function(rev,T){return 0.45*Math.max(0,Math.min(rev,T+5000)-T)+0.50*Math.max(0,Math.min(rev,T+12500)-(T+5000))+0.55*Math.max(0,rev-(T+12500));}},
  Matthew:{base:4551,startLabel:"May 2026",thr:function(ym){return ym<"2026-05"?null:16500;},
           comm:function(rev,T){return 0.40*Math.max(0,Math.min(rev,T+5000)-T)+0.45*Math.max(0,Math.min(rev,T+10000)-(T+5000))+0.50*Math.max(0,rev-(T+10000));}}
};
function chiroMonthRev(id,m){var r=PROFIT_REV[m];if(!r)return 0;return id==="Myles"?(r.Myles||0):(id==="Matthew"?(r.Matthew||0):0);}
function accThreshold(id,ym){var cfg=EMP[id];if(!cfg)return{active:false};var baseT=cfg.thr(ym);if(baseT==null)return{active:false,start:cfg.startLabel};
  var prior=Object.keys(PROFIT_REV).sort().filter(function(m){return m<ym&&cfg.thr(m)!=null;});var deficit=0;
  prior.forEach(function(m){var T=cfg.thr(m)+deficit;var rev=chiroMonthRev(id,m);deficit=(rev>=T)?0:(T-rev);});
  return{active:true,baseT:baseT,carried:deficit,T:baseT+deficit};}
function payOf(id,revs){
  if(id==="Alex")return 0;
  if(id==="Annefloor")return 0.45*revs[0];
  if(id==="Lara")return laraTier(revs[0])+laraTier(revs[1]);
  if(id==="Myles"||id==="Matthew"){var cfg=EMP[id],base=cfg.base*factor(),acc=accThreshold(id,curMonth());var bonus=(acc.active&&revs[0]>=acc.T)?cfg.comm(revs[0],acc.T):0;return base+bonus;}
  return 0;
}
function revsOf(d){var a=[];for(var i=0;i<d.n;i++)a.push(+document.getElementById("rev-"+d.id+"-"+i).value||0);return a;}
function payDetail(id,revs){var f=factor();
  if(id==="Alex")return "Owner \u2014 no wage taken here";
  if(id==="Annefloor")return "45% of "+eur(revs[0])+" = "+eur(0.45*revs[0]);
  if(id==="Lara")return "Amstelveen "+eur(laraTier(revs[0]))+" + Bussum "+eur(laraTier(revs[1]))+"  (37.5/42.5/45% tiers, each site on its own)";
  if(id==="Myles"||id==="Matthew"){var cfg=EMP[id],b=cfg.base*f,acc=accThreshold(id,curMonth());
    if(!acc.active) return eur(cfg.base)+" base \u00d7"+f+" = "+eur(b)+" (bonus starts "+acc.start+")";
    var c=(revs[0]>=acc.T)?cfg.comm(revs[0],acc.T):0;
    return eur(cfg.base)+" base \u00d7"+f+" = "+eur(b)+(c>0?" + "+eur(c)+" bonus (over \u20ac"+Math.round(acc.T)+")":" + \u20ac0 bonus (need \u20ac"+Math.round(acc.T)+", billed \u20ac"+Math.round(revs[0])+")");}
  return "";}
function set(id,v){var e=document.getElementById(id);if(e)e.textContent=v;}
function recompute(){
  var costLines=[["Rent","costRent","#8b5cf6"],["CA wages","costCA","#0ea5e9"],["Marketing","costMkt","#f59e0b"],["Software","costSw","#14b8a6"],["Other","costOther","#94a3b8"]];
  var O=costLines.reduce(function(s,c){return s+(+document.getElementById(c[1]).value||0);},0);
  var draw=+document.getElementById("draw").value||0, target=(+document.getElementById("target").value||0)/100;
  set("ohTot","\u20ac"+Math.round(O).toLocaleString("en-US"));
  set("targetLbl",(target*100).toFixed(0)+"%");
  var R=0,totalPay=0,data={};
  DEF.forEach(function(d){var revs=revsOf(d),rev=revs.reduce(function(a,b){return a+b;},0),pay=payOf(d.id,revs); data[d.id]={rev:rev,pay:pay,revs:revs}; R+=rev; totalPay+=pay;});
  DEF.forEach(function(d){var x=data[d.id], Hi=R?O*x.rev/R:0, Si=R?draw*x.rev/R:0, profit=x.rev-x.pay-Hi-Si, margin=x.rev?profit/x.rev:0;
    var pe=document.getElementById("pay-"+d.id); if(pe){ if(d.id==="Myles"||d.id==="Matthew"){ var cfg=EMP[d.id], bc=cfg.base*factor(), cm=x.pay-bc, acc=accThreshold(d.id,curMonth()); var sub; if(!acc.active){ sub="base "+eur(bc)+" \u00b7 bonus starts "+acc.start; } else { var thrTxt=acc.carried>0?("threshold "+eur(acc.T)+" = "+eur(acc.baseT)+" + "+eur(acc.carried)+" carried"):("threshold "+eur(acc.T)); sub="base "+eur(bc)+(cm>0.5?" + bonus "+eur(cm):", no bonus")+" \u00b7 "+thrTxt; } pe.innerHTML=eur(x.pay)+"<div style='font-weight:400;color:#94a3b8;font-size:10.5px'>"+sub+"</div>"; } else { pe.textContent=eur(x.pay); } pe.title=payDetail(d.id,x.revs); pe.style.cursor="help"; } set("rate-"+d.id,x.rev?Math.round(100*x.pay/x.rev)+"%":"\u2014"); set("cost-"+d.id,eur(Hi)); set("fee-"+d.id,eur(Si)); set("profit-"+d.id,eur(profit));
    var mc=document.getElementById("margin-"+d.id); if(mc){mc.textContent=(margin*100).toFixed(0)+"%"; mc.style.color=margin>=target?"#16a34a":margin>=0?"#f59e0b":"#dc2626";}});
  var profitTot=R-totalPay-O-draw, marginTot=R?profitTot/R:0, covered=(R-totalPay-O)>=draw;
  set("cR",eur(R)); set("cPay",eur(totalPay)); set("cP",eur(profitTot));
  var cm=document.getElementById("cM"); if(cm){cm.textContent=(marginTot*100).toFixed(0)+"%"; cm.style.color=marginTot>=target?"#16a34a":marginTot>=0?"#f59e0b":"#dc2626";}
  var scov=document.getElementById("salCov"); if(scov){scov.textContent=covered?"\u2714 covered":"\u2717 not yet"; scov.style.color=covered?"#16a34a":"#dc2626";}
  var need=null;
  for(var s=1;s<=4;s+=0.01){ var Rs=0,Ps=0; DEF.forEach(function(d){var revs=revsOf(d).map(function(v){return v*s;}); Rs+=revs.reduce(function(a,b){return a+b;},0); Ps+=payOf(d.id,revs);}); if(Rs&&(Rs-Ps-O-draw)/Rs>=target){need=s;break;} }
  var rn=document.getElementById("cNeed"); if(rn){ if(marginTot>=target) rn.textContent="\u2714 already there"; else if(need) rn.textContent="+"+Math.round((need-1)*100)+"%  (\u2248"+eur(R*(need-1))+"/mo)"; else rn.textContent="raise prices/cut costs"; }
  // where the money goes
  var comps=[{label:"Chiro pay",val:totalPay,col:"#2563eb"}];
  costLines.forEach(function(c){comps.push({label:c[0],val:(+document.getElementById(c[1]).value||0),col:c[2]});});
  comps.push({label:"Your draw",val:draw,col:"#475569"});
  var costSum=comps.reduce(function(s,c){return s+c.val;},0);
  var profitPos=Math.max(0,R-costSum);
  var bar=document.getElementById("flowBar"), rows=document.getElementById("flowRows");
  if(bar&&rows){
    var segs=comps.concat(profitTot>=0?[{label:"Profit",val:profitPos,col:"#16a34a"}]:[]);
    bar.innerHTML=segs.filter(function(s){return s.val>0;}).map(function(s){var w=R?(100*s.val/R):0;return "<div title='"+s.label+": "+eur(s.val)+" ("+(R?Math.round(100*s.val/R):0)+"%)' style='width:"+w+"%;background:"+s.col+"'></div>";}).join("");
    var rowsHtml=comps.map(function(c){return "<div class='flowrow'><div><span class='dot' style='background:"+c.col+"'></span>"+c.label+"</div><div>"+eur(c.val)+"<span class='pc'>"+(R?Math.round(100*c.val/R):0)+"% of revenue</span></div></div>";}).join("");
    rowsHtml+="<div class='flowrow' style='border-bottom:none;font-weight:700'><div><span class='dot' style='background:"+(profitTot>=0?"#16a34a":"#dc2626")+"'></span>Company profit</div><div style='color:"+(profitTot>=0?"#16a34a":"#dc2626")+"'>"+eur(profitTot)+"<span class='pc'>"+(marginTot*100).toFixed(0)+"% margin</span></div></div>";
    rows.innerHTML="<div class='flowrow' style='font-weight:700'><div>Brought in</div><div>"+eur(R)+"<span class='pc'>100%</span></div></div>"+rowsHtml;
  }
}
var PROFIT_REV={"2026-01":{"Alex":33658,"LaraA":8370,"LaraB":5405,"Myles":7685,"Annefloor":2765,"Matthew":5335},"2026-02":{"Alex":23765,"LaraA":6625,"LaraB":2860,"Myles":10065,"Annefloor":0,"Matthew":14895},"2026-03":{"Alex":30875,"LaraA":9425,"LaraB":7265,"Myles":10845,"Annefloor":2005,"Matthew":20413},"2026-04":{"Alex":13660,"LaraA":8385,"LaraB":7210,"Myles":18430,"Annefloor":1465,"Matthew":15830},"2026-05":{"Alex":14140,"LaraA":6405,"LaraB":5400,"Myles":18295,"Annefloor":2160,"Matthew":17888}};
function monthLabel(k){var p=k.split("-");var mn=["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];return (mn[+p[1]]||p[1])+" "+p[0];}
function buildMonths(){var sel=document.getElementById("monthSel");if(!sel)return;var keys=Object.keys(PROFIT_REV).sort().reverse();sel.innerHTML=keys.map(function(k){return "<option value='"+k+"'>"+monthLabel(k)+"</option>";}).join("");}
function loadMonth(k){var r=PROFIT_REV[k];if(!r)return;var map={"rev-Alex-0":r.Alex,"rev-Lara-0":r.LaraA,"rev-Lara-1":r.LaraB,"rev-Myles-0":r.Myles,"rev-Matthew-0":r.Matthew,"rev-Annefloor-0":r.Annefloor};Object.keys(map).forEach(function(id){var e=document.getElementById(id);if(e&&map[id]!=null)e.value=map[id];});recompute();}
document.querySelectorAll("input").forEach(function(el){el.addEventListener("input",recompute);});
buildMonths();
var msel=document.getElementById("monthSel");
if(msel){msel.addEventListener("change",function(){loadMonth(this.value);});}
var firstKey=Object.keys(PROFIT_REV).sort().reverse()[0];
if(firstKey){if(msel)msel.value=firstKey;loadMonth(firstKey);}else{recompute();}
fetch("/profit/rev.json").then(function(r){return r.json();}).then(function(live){if(live&&Object.keys(live).length){Object.assign(PROFIT_REV,live);buildMonths();var cur=msel?msel.value:null;var k=(cur&&PROFIT_REV[cur])?cur:Object.keys(PROFIT_REV).sort().reverse()[0];if(msel)msel.value=k;loadMonth(k);}}).catch(function(){});
</script>
</body></html>`);
} catch(e){ res.status(500).send("profit error: "+e.message); } });

// live per-practitioner monthly revenue from the PVA sheet (refreshes the /profit month picker)
app.get("/profit/rev.json", gate, async (_req, res) => {
  try { const d = await loadPvaData(); res.json(d.monthlyRev || {}); }
  catch (e) { res.json({}); }
});

// ── Per-practitioner monthly EARNINGS history, estimated from PracticeHub visits ─
// One clinic per call (keeps each request bounded). Earnings = completed visits ×
// PRICE_PER_VISIT. Includes ex-chiros via allPractitionerMap. Cached 1h in memory.
app.get("/practitioner-earnings.json", gate, async (req, res) => {
  try {
    const clinic = req.query.clinic || "Amstelveen";
    const months = Math.max(1, Math.min(parseInt(req.query.months) || 6, 36));
    const ck = clinic + "|" + months;
    if (_earnCache[ck] && Date.now() - _earnCache[ck].t < 3600000) return res.json(_earnCache[ck].v);
    const names = await allPractitionerMap(clinic);
    const types = await phubAll(clinic, "/appointment_types", {}).catch(() => []);
    const excluded = new Set(); for (const t of types) if (notAVisit(t.name || "")) excluded.add(t.id);
    const appts = await phubAll(clinic, "/appointments", { start: monthsAgoRange(months) });
    const byId = new Map();
    for (const a of appts) { const c = a.status === "cancelled" || a.cancelDate; const p = byId.get(a.id); if (!p || (p.cancelled && !c)) byId.set(a.id, { ...a, cancelled: c }); }
    const per = {};
    for (const a of byId.values()) {
      if (a.cancelled || a.status !== "processed") continue;
      if (excluded.has(a.appointment_type_id)) continue;
      const ym = (a.start || "").slice(0, 7); if (!/^\d{4}-\d{2}$/.test(ym)) continue;
      const pid = a.practitioner_id;
      (per[pid] || (per[pid] = { name: names[pid] || `#${pid}`, m: {} })).m[ym] = (per[pid].m[ym] || 0) + 1;
    }
    const data = Object.values(per).map(v => ({ name: v.name, rev: Object.fromEntries(Object.entries(v.m).map(([m, vis]) => [m, vis * PRICE_PER_VISIT])) }));
    const v = { clinic, months, price: PRICE_PER_VISIT, appointments: appts.length, data };
    _earnCache[ck] = { t: Date.now(), v };
    res.json(v);
  } catch (e) { res.json({ error: e.message, clinic: req.query.clinic || "Amstelveen" }); }
});

// ── Page: per-practitioner monthly earnings history (incl. ex-chiros) ─────────
app.get("/practitioner-earnings", gate, (_req, res) => {
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Practitioner earnings history</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:1100px;margin:26px auto;padding:0 16px;color:#16202E}
h1{font-size:23px;margin:0 0 2px}.sub{color:#64748b;font-size:13px;margin:0 0 16px}
.card{border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin-bottom:14px;overflow-x:auto}
.controls{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px}
.controls label{font-size:12px;color:#64748b;display:block;margin-bottom:4px}.controls input{width:90px;border:1px solid #d1d5db;border-radius:8px;padding:7px 9px;font-size:14px}
button{padding:9px 16px;border:none;background:#2563EB;color:#fff;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
table{border-collapse:collapse;font-size:12.5px;white-space:nowrap}td,th{padding:7px 9px;border-bottom:1px solid #f1f5f9}.num{text-align:right;font-variant-numeric:tabular-nums}th{color:#64748b;font-size:11px;text-align:right}th:first-child,td:first-child{text-align:left}
.ex{color:#b45309;font-size:10px;border:1px solid #fcd34d;background:#fffbeb;border-radius:4px;padding:1px 5px;margin-left:6px}
.warn{background:#fef3c7;color:#92400e;padding:10px 12px;border-radius:8px;font-size:12.5px;margin-bottom:12px}a{color:#2563EB}</style></head><body>
<h1>Practitioner earnings history</h1><div class="sub">Estimated from PracticeHub completed visits \u00d7 \u20ac${PRICE_PER_VISIT}. Pull as far back as PracticeHub serves \u2014 ex-chiros included. The \u201cPay + brought-in\u201d view shows actual euros paid to <b>every</b> chiro (bank for those who invoice by name, the holding for Alex, the books for Lara &amp; Annefloor) and, below it, what each brought in. A PVA history view shows past performance incl. Nick, Holly &amp; Courtney.</div>
<div class="warn">This is an <b>estimate</b> (visits \u00d7 price), not exact euros, and it reads live from PracticeHub per clinic \u2014 a deep pull can take a moment. Increase \u201cmonths back\u201d until older months stop appearing; that\u2019s as far as the API will serve.</div>
<div class="controls">
  <div><label>Months back</label><input type="number" id="hmonths" value="6" min="1" max="36"></div>
  <button onclick="loadHistory()">Pull from PracticeHub</button>
  <div><label>View month</label><select id="monthFocus" onchange="rerender()" style="padding:7px 9px;border:1px solid #d1d5db;border-radius:8px;font-size:14px"><option value="all">All months (table)</option><option value="bank">Pay + brought-in (per chiro)</option><option value="pva">PVA history (sheets)</option></select></div>
  <span id="status" style="color:#64748b;font-size:13px"></span>
</div>
<div class="card"><div id="tbl">Set months back and click Pull.</div></div>
<p class="sub">Pages: <a href="/">home</a> \u00b7 <a href="/profit">/profit</a> \u00b7 <a href="/pva">/pva</a> \u00b7 <a href="/scorecard">/scorecard</a></p>
<script>
var CLINICS=["Amstelveen","Utrecht","Bussum","Rotterdam"];
var CURRENT=["alex","lara","myles","matthew","annefloor"];
var BYNAME={}, MONTHS=[], PULLING=false, BROUGHT_ERR="";
function eur(n){return "€"+Math.round(n||0).toLocaleString("en-US");}
function exTag(n){var f=(n.split(" ")[0]||"").toLowerCase();return CURRENT.indexOf(f)<0?"<span class='ex'>ex</span>":"";}
function laraTier(r){return 0.375*Math.min(r,5000)+0.425*Math.max(0,Math.min(r,10000)-5000)+0.45*Math.max(0,r-10000);}
function nickThreshold(name,beforeMonth){var d=0;MONTHS.filter(function(m){return m<beforeMonth;}).forEach(function(m){var rev=(BYNAME[name]&&BYNAME[name][m])||0;var T=15000+d;d=(rev>=T)?0:(T-rev);});return 15000+d;}
var BANK_PAY={"Nick Bunger":{"2022-10":10540.5,"2022-12":12126.12,"2023-01":4994.5,"2023-02":4253.3,"2023-04":6606.25,"2023-05":4555.25,"2023-06":5130.65,"2023-07":10032.5,"2023-08":3250.0,"2023-09":2391.0,"2023-10":8588.8,"2023-11":4500.0,"2023-12":10630.0,"2024-02":6145.0,"2024-03":7822.5,"2024-04":4500.0,"2024-05":1500.0,"2024-06":4500.0,"2024-07":4500.0,"2024-08":4500.0,"2024-09":4815.0,"2024-11":5095.0,"2024-12":6065.0,"2025-01":4500.0,"2025-02":4500.0,"2025-03":4500.0,"2025-04":4500.0,"2025-05":4500.0,"2025-06":6034.0,"2025-07":6322.5,"2025-08":3000.0,"2025-09":6000.0,"2025-10":3000.0,"2025-11":4500.0,"2025-12":4500.0},"Holly Schonberger":{"2023-01":4200.0,"2023-02":8650.0,"2023-03":4325.2,"2023-04":1050.0,"2023-05":7350.0,"2023-06":4200.0,"2023-07":4200.0,"2023-08":4200.0,"2023-10":4200.0,"2023-11":5100.0,"2023-12":8472.0,"2024-01":4200.0,"2024-03":8400.0,"2024-04":4200.0,"2024-06":8400.0,"2024-08":3500.0,"2024-09":4200.0,"2024-11":4200.0,"2024-12":8400.0,"2025-02":8400.0,"2025-03":2261.54},"Courtney Rokowski":{"2024-07":925.0,"2024-08":1258.0,"2024-09":2401.0,"2024-10":1339.0,"2024-11":1295.63,"2024-12":1900.5,"2025-01":5167.38,"2025-02":2933.0,"2025-03":3700.38,"2025-05":2357.0,"2025-06":2398.0,"2025-07":2247.0,"2025-08":2217.0},"Maria Feiler":{"2023-12":3672.0,"2024-01":3232.8,"2024-02":3672.0,"2024-03":3672.0,"2024-04":3672.0,"2024-05":3672.0,"2024-06":3672.0,"2024-07":3672.0,"2024-08":3672.0,"2024-09":3672.0},"Matthew Horgan":{"2026-02":2850.75,"2026-03":4570.69,"2026-04":4604.52,"2026-05":4094.16},"Myles Drakes":{"2026-04":4241.04,"2026-05":4548.86}};
Object.assign(BANK_PAY,{"Alex Yu (holding)":{"2023-01":3431.65,"2023-02":3431.65,"2023-03":3431.65,"2023-04":3400.0,"2023-05":3431.65,"2023-06":3431.65,"2023-08":550.0,"2023-09":500.0,"2023-10":2381.65,"2023-11":3431.65,"2023-12":3431.65,"2024-01":3431.65,"2024-02":3016.3,"2024-03":2300.0,"2024-04":4229.66,"2024-05":3264.82,"2024-06":3264.82,"2024-07":3264.82,"2024-08":3264.82,"2024-09":5264.82,"2024-10":4529.64,"2024-11":3264.82,"2024-12":3764.82,"2025-01":4764.82,"2025-02":3264.84,"2025-03":5179.46,"2025-04":3264.82,"2025-05":3264.82,"2025-06":4000.0,"2025-07":4325.28,"2025-08":2300.0,"2025-09":3825.28,"2025-10":2025.28,"2025-11":5150.56,"2025-12":5325.28,"2026-01":1325.28,"2026-02":6650.56,"2026-03":4454.51,"2026-04":4454.51,"2026-05":3454.51},"Lara (books)":{"2024-09":1900,"2024-10":1900,"2024-11":1900,"2024-12":1900,"2025-01":2080,"2025-02":2062,"2025-03":1900,"2025-04":1900,"2025-05":2656,"2025-06":1900,"2025-07":3800,"2025-08":682,"2025-09":1900,"2025-10":1900,"2025-11":3534,"2025-12":2950,"2026-01":2170,"2026-02":3181,"2026-03":2561,"2026-04":3575,"2026-05":3229,"2026-06":2419},"Annefloor (books)":{"2026-01":4115.25,"2026-03":1317.05,"2026-04":1492.7,"2026-05":849.98}});
var PVA_HISTORY={"Nick":{"2025-01":8.913,"2025-02":12.066,"2025-03":11.26,"2025-04":16.3,"2025-05":12.6,"2025-06":9.5,"2025-07":10.5,"2025-08":11.0,"2025-09":13.41,"2025-10":20.2,"2025-11":12.6},"Holly":{"2025-01":8.611,"2025-02":13.09,"2025-03":12.2},"Courtney":{"2025-01":7.0,"2025-02":8.285,"2025-03":8.47,"2025-04":8.9,"2025-05":9.7,"2025-06":5.9,"2025-07":11.11},"Myles":{"2025-08":3.1,"2025-09":10.06,"2025-10":8.9,"2025-11":8.0,"2025-12":7.8},"Annefloor":{"2025-12":8.5}};
function bankKey(name){var n=name.toLowerCase();if(n.indexOf("bunger")>=0)return "Nick Bunger";if(n.indexOf("schonberger")>=0)return "Holly Schonberger";if(n.indexOf("rokowski")>=0||n.indexOf("rakowski")>=0)return "Courtney Rokowski";if(n.indexOf("feiler")>=0||n.indexOf("frier")>=0||n.indexOf("align")>=0||n==="maria"||n.indexOf("maria ")>=0)return "Maria Feiler";if(n.indexOf("horgan")>=0||n==="matthew"||n.indexOf("matthew ")>=0)return "Matthew Horgan";if(n.indexOf("drakes")>=0||n==="myles"||n.indexOf("myles ")>=0)return "Myles Drakes";return null;}
function bankPay(name,month){var k=bankKey(name);return (k&&BANK_PAY[k]&&BANK_PAY[k][month]!=null)?BANK_PAY[k][month]:null;}
function renderBankHistory(){
  if(!Object.keys(BYNAME).length && !PULLING && !BROUGHT_ERR){ PULLING=true; loadHistory(); }
  var people=Object.keys(BANK_PAY), set={};
  people.forEach(function(p){Object.keys(BANK_PAY[p]).forEach(function(m){set[m]=1;});});
  var ms=Object.keys(set).sort();
  var h="<div style='font-weight:700;font-size:14px;margin:2px 0 8px'>What each chiro was paid \u2014 real money out</div>";
  h+="<table><thead><tr><th>Practitioner</th>";ms.forEach(function(m){h+="<th>"+m+"</th>";});h+="<th>Total</th></tr></thead><tbody>";
  people.forEach(function(p){h+="<tr><td>"+p+exTag(p)+"</td>";var tot=0;ms.forEach(function(m){var v=BANK_PAY[p][m]||0;tot+=v;h+="<td class='num'>"+(v?eur(v):"\u00b7")+"</td>";});h+="<td class='num'><b>"+eur(tot)+"</b></td></tr>";});
  h+="</tbody></table>";
  h+="<div style='color:#94a3b8;font-size:11.5px;margin-top:8px'>Real euros out: <b>bank statements</b> for those who invoiced by name (Nick, Holly, Courtney, Maria, Matthew, Myles), the <b>holding</b> for Alex\u2019s salary, and the <b>expense books</b> for Lara &amp; Annefloor (payroll). Lara is Amstelveen-allocated; her Bussum share can be added.</div>";
  h+=renderBroughtInBox();
  h+=renderNetBox();
  document.getElementById("tbl").innerHTML=h;
}
// Map a PracticeHub name to its pay record (bank, holding or books)
function payKey(name){
  var k=bankKey(name); if(k) return k;
  var f=(name.split(" ")[0]||"").toLowerCase();
  if(f==="alex") return "Alex Yu (holding)";
  if(f==="lara") return "Lara (books)";
  if(f==="annefloor") return "Annefloor (books)";
  return null;
}
// Net to the clinic = what they brought in (services) minus what we paid them,
// summed over exactly the months we pulled (like-for-like).
function renderNetBox(){
  var names=Object.keys(BYNAME);
  if(!names.length) return "";
  var monthsSet={}; names.forEach(function(n){Object.keys(BYNAME[n]).forEach(function(m){monthsSet[m]=1;});});
  var ms=Object.keys(monthsSet);
  var rows=names.map(function(n){
    var inSum=0; ms.forEach(function(m){inSum+=BYNAME[n][m]||0;});
    var pk=payKey(n), paidSum=0, hasPay=false;
    if(pk&&BANK_PAY[pk]){ ms.forEach(function(m){ if(BANK_PAY[pk][m]!=null){ paidSum+=BANK_PAY[pk][m]; hasPay=true; } }); }
    return {name:n, brought:inSum, paid:paidSum, hasPay:hasPay, net:inSum-paidSum};
  }).filter(function(r){return r.brought>0;}).sort(function(a,b){return b.net-a.net;});
  if(!rows.length) return "";
  var h="<div style='font-weight:700;font-size:14px;margin:26px 0 8px'>Net to the clinic \u2014 brought in minus paid <span style='font-weight:400;color:#94a3b8;font-size:12px'>(same months as pulled above)</span></div>";
  h+="<table><thead><tr><th>Practitioner</th><th>Brought in</th><th>Paid out</th><th>Net to clinic</th></tr></thead><tbody>";
  rows.forEach(function(r){
    var paidTxt=r.hasPay?eur(r.paid):"<span style='color:#cbd5e1'>no pay on file</span>";
    var netTxt=r.hasPay?("<b style='color:"+(r.net>=0?"#16a34a":"#dc2626")+"'>"+eur(r.net)+"</b>"):"\u2014";
    h+="<tr><td>"+r.name+exTag(r.name)+"</td><td class='num'>"+eur(r.brought)+"</td><td class='num'>"+paidTxt+"</td><td class='num'>"+netTxt+"</td></tr>";
  });
  h+="</tbody></table>";
  h+="<div style='color:#94a3b8;font-size:11.5px;margin-top:8px'>What each chiropractor actually contributes: services brought in (visits \u00d7 \u20ac${PRICE_PER_VISIT}) minus their pay, over the same window. Green = net positive to the clinic. This is gross of rent, CAs and other shared costs \u2014 it\u2019s the per-chiro margin before overhead, not final profit.</div>";
  return h;
}
function renderBroughtInBox(){
  var names=Object.keys(BYNAME);
  if(!names.length){
    if(BROUGHT_ERR) return "<div style='margin-top:22px;padding:14px;border:1px dashed #fca5a5;border-radius:12px;color:#b91c1c;font-size:13px'>Couldn\u2019t load what each chiro brought in from PracticeHub: "+BROUGHT_ERR+". Click <b>Pull from PracticeHub</b> to retry.</div>";
    return "<div style='margin-top:22px;padding:14px;border:1px dashed #d1d5db;border-radius:12px;color:#64748b;font-size:13px'>\u23f3 Loading what each chiro brought in from PracticeHub\u2026 (a deep pull across all four clinics can take a moment \u2014 it fills in here automatically).</div>";
  }
  var set={}; names.forEach(function(n){Object.keys(BYNAME[n]).forEach(function(m){set[m]=1;});});
  var ms=Object.keys(set).sort();
  var sorted=names.sort(function(a,b){var ta=0,tb=0;ms.forEach(function(m){ta+=BYNAME[a][m]||0;tb+=BYNAME[b][m]||0;});return tb-ta;});
  var h="<div style='font-weight:700;font-size:14px;margin:26px 0 8px'>What each chiro brought in \u2014 services (estimated)</div>";
  h+="<table><thead><tr><th>Practitioner</th>";ms.forEach(function(m){h+="<th>"+m+"</th>";});h+="<th>Total</th></tr></thead><tbody>";
  sorted.forEach(function(n){h+="<tr><td>"+n+exTag(n)+"</td>";var tot=0;ms.forEach(function(m){var v=BYNAME[n][m]||0;tot+=v;h+="<td class='num'>"+(v?eur(v):"\u00b7")+"</td>";});h+="<td class='num'><b>"+eur(tot)+"</b></td></tr>";});
  h+="</tbody></table>";
  h+="<div style='color:#94a3b8;font-size:11.5px;margin-top:8px'>Estimated from PracticeHub completed visits \u00d7 \u20ac${PRICE_PER_VISIT}. Increase \u201cmonths back\u201d to extend.</div>";
  return h;
}
function compFor(name,month){var bp=bankPay(name,month);if(bp!=null)return {pay:bp,note:"actual paid (bank)"};var first=(name.split(" ")[0]||"").toLowerCase();var rev=(BYNAME[name]&&BYNAME[name][month])||0;
  if(first==="holly")return {pay:4200,note:"€4,200 fixed"};
  if(first==="nick"){var T=nickThreshold(name,month);var bonus=rev>=T?0.50*(rev-T):0;return {pay:4500+bonus,note:"€4,500 base + 50% over "+eur(T)+(T>15000?" (incl. carried shortfall)":"")};}
  if(first==="lara")return {pay:laraTier(rev),note:"37.5/42.5/45% tiers (approx, on total)"};
  return null;}
function loadHistory(){
  var months=+document.getElementById("hmonths").value||6;
  BROUGHT_ERR="";
  var byName={}, monthsSet={}, errs=[]; var i=0;
  function finish(){
    BYNAME=byName; MONTHS=Object.keys(monthsSet).sort(); PULLING=false;
    var names=Object.keys(byName);
    var sel=document.getElementById("monthFocus");
    if(!names.length){
      BROUGHT_ERR = errs.length ? errs.join("; ") : "PracticeHub returned no visits for this range";
      if(sel && sel.value==="bank"){ renderBankHistory(); }
      else { document.getElementById("tbl").innerHTML="No data returned. "+(errs.length?("Errors: "+errs.join("; ")):"PracticeHub may not serve that range, or keys aren’t set."); }
      document.getElementById("status").textContent=errs.length?(errs.length+" clinic error(s)"):"no data";
      return;
    }
    BROUGHT_ERR="";
    var keep=sel.value;
    sel.innerHTML="<option value='all'>All months (table)</option><option value='bank'>Pay + brought-in (per chiro)</option><option value='pva'>PVA history (sheets)</option>"+MONTHS.slice().reverse().map(function(m){return "<option value='"+m+"'>"+m+"</option>";}).join("");
    if(keep){var has=Array.prototype.some.call(sel.options,function(o){return o.value===keep;}); if(has)sel.value=keep;}
    document.getElementById("status").textContent=names.length+" practitioners · "+MONTHS.length+" months"+(errs.length?(" · "+errs.length+" clinic error(s)"):"");
    rerender();
  }
  function next(){
    if(i>=CLINICS.length){finish();return;}
    var c=CLINICS[i++];
    document.getElementById("status").textContent="Pulling "+c+"… ("+i+"/"+CLINICS.length+")";
    fetch("/practitioner-earnings.json?clinic="+c+"&months="+months).then(function(r){return r.json();}).then(function(j){
      if(j&&j.error){errs.push(c+": "+j.error);}
      if(j&&j.data){j.data.forEach(function(p){var k=p.name;if(!byName[k])byName[k]={};Object.keys(p.rev).forEach(function(m){byName[k][m]=(byName[k][m]||0)+p.rev[m];monthsSet[m]=1;});});}
      next();
    }).catch(function(e){errs.push(c+": fetch failed");next();});
  }
  next();
}
function renderPvaHistory(){
  var people=Object.keys(PVA_HISTORY), set={};
  people.forEach(function(p){Object.keys(PVA_HISTORY[p]).forEach(function(m){set[m]=1;});});
  var ms=Object.keys(set).sort();
  if(!ms.length){document.getElementById("tbl").innerHTML="No PVA history available.";return;}
  var h="<table><thead><tr><th>Practitioner</th>"; ms.forEach(function(m){h+="<th>"+m+"</th>";}); h+="<th>Avg</th></tr></thead><tbody>";
  people.sort().forEach(function(p){
    h+="<tr><td>"+p+exTag(p)+"</td>"; var sum=0,n=0;
    ms.forEach(function(m){var v=PVA_HISTORY[p][m]; if(v!=null){sum+=v;n++;h+="<td class='num'>"+v.toFixed(1)+"</td>";} else h+="<td class='num'>·</td>";});
    h+="<td class='num'><b>"+(n?(sum/n).toFixed(1):"·")+"</b></td></tr>";
  });
  h+="</tbody></table>";
  document.getElementById("tbl").innerHTML=h+"<div style='color:#94a3b8;font-size:11.5px;margin-top:8px'>Monthly PVA (patient-visit-average) from your PVA sheets \u2014 2025, including chiros who have left. Higher = patients staying in care longer. This view is from the sheets, so it works without pulling PracticeHub.</div>";
}
function rerender(){var f=document.getElementById("monthFocus").value; if(f==="all")renderAll(); else if(f==="bank")renderBankHistory(); else if(f==="pva")renderPvaHistory(); else renderMonth(f);}
function renderAll(){
  var ms=MONTHS, names=Object.keys(BYNAME).sort(function(a,b){var ta=0,tb=0;ms.forEach(function(m){ta+=BYNAME[a][m]||0;tb+=BYNAME[b][m]||0;});return tb-ta;});
  var h="<table><thead><tr><th>Practitioner</th>"; ms.forEach(function(m){h+="<th>"+m+"</th>";}); h+="<th>Total</th></tr></thead><tbody>";
  names.forEach(function(n){h+="<tr><td>"+n+exTag(n)+"</td>";var tot=0;ms.forEach(function(m){var v=BYNAME[n][m]||0;tot+=v;h+="<td class='num'>"+(v?eur(v):"·")+"</td>";});h+="<td class='num'><b>"+eur(tot)+"</b></td></tr>";});
  h+="</tbody></table>"; document.getElementById("tbl").innerHTML=h;
}
function renderMonth(m){
  var names=Object.keys(BYNAME).filter(function(n){return (BYNAME[n][m]||0)>0;}).sort(function(a,b){return (BYNAME[b][m]||0)-(BYNAME[a][m]||0);});
  if(!names.length){document.getElementById("tbl").innerHTML="No recorded visits for "+m+".";return;}
  var h="<table><thead><tr><th>Practitioner</th><th>Brought in</th><th>Pay</th><th>Kept</th><th>Structure</th></tr></thead><tbody>";
  names.forEach(function(n){var rev=BYNAME[n][m]||0,c=compFor(n,m);var payTxt=c?eur(c.pay):"—",keptTxt=c?eur(rev-c.pay):"—",note=c?c.note:"no pay structure on file";
    h+="<tr><td>"+n+exTag(n)+"</td><td class='num'>"+eur(rev)+"</td><td class='num'>"+payTxt+"</td><td class='num'>"+keptTxt+"</td><td style='color:#64748b;font-size:11.5px'>"+note+"</td></tr>";});
  h+="</tbody></table>";
  document.getElementById("tbl").innerHTML=h+"<div style='color:#94a3b8;font-size:11.5px;margin-top:8px'>Brought-in is estimated (visits × €${PRICE_PER_VISIT}). Pay applies each chiro’s structure to that estimate — Holly fixed, Nick a rolling €15k threshold, Lara tiered. Courtney has no structure on file.</div>";
}
</script></body></html>`);
});

// ============================================================================
//  /scorecard — the systems-vs-growth view: revenue, PVA (retention),
//  CA script adherence (doorplannen/package) and lead conversion, per clinic.
// ============================================================================
app.get("/scorecard", gate, async (_req,res)=>{ try {
  const fmt=n=>"\u20ac"+Math.round(n||0).toLocaleString("en-US");
  const sum=a=>(a||[]).filter(v=>v!=null).reduce((x,y)=>x+y,0);
  const clinics=["Amstelveen","Utrecht","Bussum","Rotterdam"];
  const rev={};
  for(const c of clinics){ const y=BANK_REV[c]||{}, ys=Object.keys(y).sort();
    const last=ys.filter(x=>x!=="2026").pop(), prev=ys.filter(x=>x!=="2026"&&x<last).pop();
    const yoy=(last&&prev)?((sum(y[last])/sum(y[prev])-1)*100):null;
    let proj=null; if(y["2026"]) proj=sum(y["2026"])+sum(projectYear(y["2026"]));
    rev[c]={last,total:sum(y[last]),yoy,proj}; }
  let pvaBy={}, pvaErr=null;
  try{ const pd=await loadPvaData(); for(const k of pd.keys){ const loc=(k.split("\u00b7")[1]||"").trim(); const v=ytdAvg(pd.pva[k][2026]); if(v!=null){(pvaBy[loc]||(pvaBy[loc]=[])).push(v);} } }catch(e){pvaErr=e.message;}
  const pvaAvg=c=>{const a=pvaBy[c]; return a&&a.length?a.reduce((x,y)=>x+y,0)/a.length:null;};
  let caBy={}, caErr=null;
  try{ const r=await loadAllIntakes(); for(const i of (r.intakes||[])){ const cl=i._clinic, o=caBy[cl]||(caBy[cl]={n:0,door:0,pkg:0}); o.n++; const ap=parseInt(i.Appointments,10); if(!isNaN(ap)&&ap>=3)o.door++; if((i.Package||"").toLowerCase()==="yes")o.pkg++; } }catch(e){caErr=e.message;}
  const mkConv=c=>{const m=MKTG_FUNNEL[c]; if(!m)return null; const i=m.Google.intakes+m.Meta.intakes, ca=m.Google.care+m.Meta.care; return i?ca/i:null;};
  const zc=v=>v==null?"#94a3b8":v>=10?"#16a34a":v>=7?"#f59e0b":"#dc2626";
  const pc=(v,t)=>v==null?"#94a3b8":v>=t?"#16a34a":v>=t*0.7?"#f59e0b":"#dc2626";
  const rows=clinics.map(c=>{
    const r=rev[c], pv=pvaAvg(c), ca=caBy[c], door=ca&&ca.n?100*ca.door/ca.n:null, pkg=ca&&ca.n?100*ca.pkg/ca.n:null, conv=mkConv(c);
    return `<tr>
      <td style="text-align:left;font-weight:600">${c}</td>
      <td class="num">${fmt(r.total)}</td>
      <td class="num" style="color:${r.yoy==null?'#94a3b8':r.yoy>=0?'#16a34a':'#dc2626'};font-weight:600">${r.yoy==null?'\u2014':(r.yoy>=0?'+':'')+r.yoy.toFixed(0)+'%'}</td>
      <td class="num">${r.proj?fmt(r.proj):'\u2014'}</td>
      <td class="num" style="color:${zc(pv)};font-weight:600">${pv==null?'\u2014':pv.toFixed(1)}</td>
      <td class="num" style="color:${pc(door,50)}">${door==null?'\u2014':Math.round(door)+'%'}</td>
      <td class="num" style="color:${pc(pkg,30)}">${pkg==null?'\u2014':Math.round(pkg)+'%'}</td>
      <td class="num">${conv==null?'\u2014':Math.round(conv*100)+'%'}</td>
    </tr>`;
  }).join("");
  const note=(pvaErr||caErr)?`<div class="warn">Some live data didn't load (${[pvaErr&&"PVA",caErr&&"CA intakes"].filter(Boolean).join(" & ")}) \u2014 those columns show \u2014. Make sure the PVA &amp; doorplannen sheets are shared "anyone with the link can view".</div>`:"";
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scorecard \u2014 Posturefixx</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:920px;margin:26px auto;padding:0 16px;color:#16202E}
h1{font-size:23px;margin:0 0 2px}.sub{color:#64748b;font-size:13px;margin:0 0 16px}
.card{border:1px solid #e5e7eb;border-radius:14px;padding:18px;margin-bottom:14px}
.warn{background:#fef3c7;color:#92400e;padding:10px 12px;border-radius:8px;font-size:12.5px;margin-bottom:14px}
table{border-collapse:collapse;width:100%;font-size:13.5px}td,th{padding:10px 8px;border-bottom:1px solid #f1f5f9}.num{text-align:right;font-variant-numeric:tabular-nums}
th{color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.03em;text-align:right}th:first-child{text-align:left}
.legend{color:#64748b;font-size:12px;margin-top:12px;line-height:1.6}a{color:#2563EB}</style></head><body>
<h1>Per-clinic scorecard</h1><div class="sub">Do the clinics following the systems grow the fastest? Revenue from the bank \u00b7 PVA &amp; intakes live \u00b7 lead conversion from the 2026 funnel.</div>
${note}
<div class="card"><table>
<thead><tr><th>Clinic</th><th>2025 rev</th><th>YoY</th><th>2026 proj</th><th>Avg PVA</th><th>Doorplannen</th><th>Package</th><th>Lead\u2192care</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="legend"><b>How to read it left\u2192right:</b> the money (revenue, growth, projection), then the behaviours that drive it \u2014 <b>PVA</b> (retention; green \u226510, red &lt;7), <b>Doorplannen</b> (CAs pre-booking the full first month; target 50%+), <b>Package</b> (care-plan conversion; target 30%+), and <b>Lead\u2192care</b> (ad leads that become patients). Read each row across: strong behaviours on the right should show up as growth on the left. Where they don't, that's your coaching priority.</div></div>
<p class="sub">Pages: <a href="/">home</a> \u00b7 <a href="/plan">/plan</a> \u00b7 <a href="/revenue">/revenue</a> \u00b7 <a href="/marketing">/marketing</a> \u00b7 <a href="/waste">/waste</a> \u00b7 <a href="/pva">/pva</a> \u00b7 <a href="/ca">/ca</a></p>
</body></html>`);
} catch(e){ res.status(500).send("scorecard error: "+e.message); } });

// ============================================================================
//  / — control center: one launchpad linking every tool, grouped by job.
// ============================================================================
app.get("/", gate, (_req,res)=>{
  const card=(href,title,desc)=>`<a href="${href}" style="display:block;border:1px solid #e5e7eb;border-radius:12px;padding:15px;text-decoration:none;color:#16202E;background:#fff"><b style="font-size:15px">${title}</b><div style="color:#64748b;font-size:12.5px;margin-top:4px;line-height:1.45">${desc}</div></a>`;
  const grid=(cards)=>`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin:8px 0 22px">${cards.join("")}</div>`;
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Posturefixx \u2014 control center</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:980px;margin:28px auto;padding:0 16px;color:#16202E;background:#F7F9FC}
h1{font-size:24px;margin:0 0 2px}.sub{color:#64748b;font-size:14px;margin:0 0 22px}h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;margin:18px 0 2px}</style></head><body>
<h1>Posturefixx \u2014 control center</h1>
<p class="sub">Coach the team, pull the numbers automatically, watch the behaviours move the money.</p>
<h3>Start here</h3><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin:8px 0 22px"><a href="/scorecard" style="display:block;border:1px solid #2563EB;border-radius:12px;padding:15px;text-decoration:none;color:#16202E;background:#eff6ff"><b style="font-size:15px">\u2b50 Per-clinic scorecard</b><div style="color:#1e3a8a;font-size:12.5px;margin-top:4px;line-height:1.45">Revenue, PVA, CA script adherence and lead conversion side by side \u2014 does following the systems show up as growth?</div></a></div><h3>Coach the team</h3>${grid([
  card("/plan","Plan &amp; goals","Revenue-target slider, per-chiro visit/PVA goals from live PracticeHub, P&amp;L + spend-by-category per clinic."),
  card("/goals","\u2b50 Goals &amp; check-ins","Set each chiro a yearly \u20ac / visits-day / PVA target; project it live from PracticeHub and auto-send a biweekly goal SMS."),
  card("/contracts","Contracts &amp; pay","Plain-language summary of each chiro's deal (base, holiday, threshold, commission) \u2014 what feeds the Brutto pay calc."),
  card("/meta-leads","\u2b50 Meta lead quality","Every FB/IG lead by clinic: reached \u2192 booked \u2192 showed up \u2192 started care. See which clinic gets better leads and where they leak."),
  card("/tables","\ud83e\ude91 Table sales","Syntropy tables sold worldwide: units, your fee, by region, and a timeline of when chiropractors sign up to buy."),
  
  card("/coach","Coach the chiros","Drafts a warm SMS to each chiropractor toward your target. You review before it sends."),
  card("/pva","PVA / retention","Retention per chiropractor, month by month, with good/improve highlights for each."),
  card("/ca","CA dashboard (Renata)","Script-adherence tracker: doorplannen %, package conversion and avg appts per CA, with coaching drafts.")
])}
<h3>The money</h3>${grid([
  card("/practitioner-earnings","Earnings history","Per-practitioner monthly earnings pulled from PracticeHub, as far back as it serves \u2014 includes chiros who have left."),
  card("/profit","\u2b50 Profit per chiro","What each chiro brings in vs pay, costs and your draw \u2014 with a target slider and the \u20ac6k floor."),
  card("/revenue","Revenue by clinic","Per-clinic revenue, pick a year for a clean read + auto summary, or overlay all years."),
  card("/waste","Spend drill-down","Every category by month, per location and year, click a line for cut/hold/move advice.")
])}
<h3>Marketing &amp; leads</h3>${grid([
  card("/marketing","Marketing by clinic","Monthly ad spend (Google/Meta/Organic) per clinic, cost per lead, and lead quality by month.")
])}
<h3>Checks &amp; automation</h3>${grid([
  card("/kpi?clinic=Amstelveen","Raw KPIs","Per-chiro numbers straight from PracticeHub (swap the clinic in the link)."),
  card("/phub-test?clinic=Rotterdam","Connection test","Confirm a clinic's PracticeHub link is live."),
  card("/sms-test?to=Alex","SMS test","Send one test text to verify delivery."),
  card("#","Auto-coach (needs setup)","Add a CRON_SECRET in Render, then have a scheduler call /coach/cron?key=YOUR_SECRET on Mon &amp; Thu. The placeholder returns \u2018forbidden\u2019 by design \u2014 that\u2019s the lock working.")
])}
<p class="sub" style="margin-top:18px">Tip: bookmark this page \u2014 it links to everything. First open each session asks for the login (manager password for Renata, owner password for you).</p>
</body></html>`);
});

// Safety net: a single bad request should never take the whole site down (502).
// Log it and keep serving every other page.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", (e && e.message) || e));
process.on("uncaughtException",  (e) => console.error("uncaughtException:",  (e && e.message) || e));

app.listen(process.env.PORT || 3000, () => console.log("coaching-engine up — /plan (chiros) & /ca (CAs)"));
