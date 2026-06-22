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

// Generic GET against one clinic's PracticeHub. Retries on 429 (rate limit).
async function phub(clinicName, path, params = {}, attempt = 0) {
  const c = CLINICS[clinicName];
  if (!c) throw new Error(`unknown clinic "${clinicName}"`);
  if (!c.key) throw new Error(`no API key set for ${clinicName} (add PHUB_${clinicName.toUpperCase()}_KEY in Render)`);
  const qs = new URLSearchParams(params).toString();
  const url = `${c.base}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, {
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
async function sendSms(clinic, phone, name, text) {
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
  const send = await fetch("https://services.leadconnectorhq.com/conversations/messages", {
    method: "POST", headers,
    body: JSON.stringify({ type: "SMS", contactId, message: text }),
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
  const res = await anthropic.messages.create({ model: MODEL, max_tokens: 250, system: VOICE,
    messages: [{ role: "user", content: prompt }] });
  return res.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
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
    const cards = [];
    for (const g of goals) {
      const msg = await draftCoaching(g);
      cards.push(`<div style="border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0">
        <b>${g.n}</b> — now ~${g.nowWeekly}/wk · PVA ${g.pva} → goal ~${g.goalWeekly}/wk · PVA ${g.goalPva}
        <p style="white-space:pre-wrap;line-height:1.5;margin:10px 0 0">${msg}</p>
        <small style="color:#888">→ ${g.phone || "no phone set"} via ${g.smsClinic}</small></div>`);
    }
    res.send(`<body style="font-family:sans-serif;max-width:680px;margin:40px auto">${lockNote()}
      <h2>Coaching drafts — target €${(target/1e6).toFixed(2)}M</h2>
      ${cards.join("")}
      <form method="POST" action="/coach/send?target=${target}" onsubmit="return confirm('Send these SMS to all four chiros?')">
        <button style="border:none;background:#2563EB;color:#fff;font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px;cursor:pointer">Approve &amp; send all by SMS</button>
      </form>
      <p style="color:#888;margin-top:10px">Targets: <a href="?target=1000000">€1.0M</a> · <a href="?target=1100000">€1.1M</a> · <a href="?target=1200000">€1.2M</a></p>
    </body>`);
  } catch (e) { res.status(500).send(`<pre style="white-space:pre-wrap">Error: ${e.message}</pre>`); }
});

// ── COACH SEND — drafts again and actually sends via SMS ──────────────────────
app.post("/coach/send", gate, async (req, res) => {
  const target = parseInt(req.query.target) || 1100000;
  try {
    const goals = chiroGoals(target, await chiroBaselines(30));
    const results = [];
    for (const g of goals) {
      if (!g.phone) { results.push(`${g.n}: skipped (no phone)`); continue; }
      try {
        const msg = await draftCoaching(g);
        await sendSms(g.smsClinic, g.phone, g.n, msg);
        results.push(`${g.n}: sent ✅`);
      } catch (e) { results.push(`${g.n}: failed — ${e.message}`); }
    }
    res.send(`<body style="font-family:sans-serif;max-width:600px;margin:40px auto"><h2>Send results</h2><p>${results.join("<br>")}</p></body>`);
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
  <p class="sub">Pages: <a href="/plan">/plan</a> · <a href="/revenue">/revenue</a> · <a href="/marketing">/marketing</a> · <a href="/waste">/waste</a> · <a href="/pva">/pva</a> · <a href="/ca">/ca</a> · <a href="/coach">/coach</a></p>
</div>
<script>
  var PL={"Amstelveen": {"2025": {"rev": 336619, "op": 92859, "exp": {"Personnel \u00b7 staff": 46691, "Other/Misc": 46449, "Personnel \u00b7 contractor chiro": 42924, "Marketing": 34786, "Rent": 33958, "Bank/Payment fees": 15741, "Travel/Transport": 6274, "Accounting/Professional": 5716, "Supplies/Retail": 4738, "Insurance": 3662, "Software/SaaS": 2711}, "below": {"Intercompany/Owner": 59519, "Tax": 10513, "Financing/Loan repay": 15496, "Internal \u00b7 transfer/loan in": -1432}}, "2026": {"rev": 167304, "op": 46401, "exp": {"Personnel \u00b7 staff": 34567, "Personnel \u00b7 contractor chiro": 18697, "Rent": 14821, "Marketing": 12676, "Other/Misc": 10575, "Accounting/Professional": 8295, "Bank/Payment fees": 7815, "Supplies/Retail": 5795, "Travel/Transport": 4865, "Insurance": 1567, "Software/SaaS": 1224}, "below": {"Financing/Loan repay": 6825, "Intercompany/Owner": 19500, "Internal \u00b7 transfer/loan in": -286, "Tax": 12123}}}, "Utrecht": {"2025": {"rev": 230704, "op": 45155, "exp": {"Personnel \u00b7 contractor chiro": 63660, "Personnel \u00b7 staff": 52861, "Marketing": 20327, "Other/Misc": 15133, "Bank/Payment fees": 13054, "Accounting/Professional": 9229, "Rent": 3944, "Supplies/Retail": 3538, "Software/SaaS": 1450, "Travel/Transport": 1305, "Insurance": 699, "Energy/Utilities": 210}, "below": {"Tax": 16855, "Financing/Loan repay": 629, "Intercompany/Owner": 31954}}, "2026": {"rev": 108567, "op": 17336, "exp": {"Personnel \u00b7 staff": 37926, "Personnel \u00b7 contractor chiro": 22782, "Marketing": 8966, "Bank/Payment fees": 6664, "Accounting/Professional": 6448, "Other/Misc": 4429, "Rent": 1294, "Supplies/Retail": 1020, "Travel/Transport": 667, "Software/SaaS": 646, "Insurance": 305}, "below": {"Financing/Loan repay": 358, "Tax": 11447, "Intercompany/Owner": 1500}}}, "Bussum": {"2025": {"rev": 167853, "op": 55260, "exp": {"Personnel \u00b7 contractor chiro": 38246, "Personnel \u00b7 staff": 25666, "Marketing": 15233, "Bank/Payment fees": 10135, "Accounting/Professional": 6676, "Other/Misc": 5143, "Energy/Utilities": 3596, "Travel/Transport": 3011, "Rent": 2377, "Supplies/Retail": 1494, "Software/SaaS": 785, "Insurance": 231}, "below": {"Financing/Loan repay": 37979, "Tax": 10596, "Intercompany/Owner": 3555, "Internal \u00b7 transfer/loan in": -1000}}, "2026": {"rev": 69072, "op": 26883, "exp": {"Personnel \u00b7 staff": 11068, "Personnel \u00b7 contractor chiro": 10622, "Marketing": 6110, "Bank/Payment fees": 4452, "Accounting/Professional": 3151, "Other/Misc": 2200, "Travel/Transport": 2099, "Energy/Utilities": 1581, "Software/SaaS": 364, "Insurance": 231, "Rent": 200}, "below": {"Financing/Loan repay": 12290, "Tax": 5255, "Intercompany/Owner": 7500}}}, "Rotterdam": {"2025": {"rev": 32828, "op": -18862, "exp": {"Supplies/Retail": 22514, "Personnel \u00b7 staff": 12921, "Rent": 7154, "Other/Misc": 5271, "Marketing": 2295, "Accounting/Professional": 862, "Software/SaaS": 495}, "below": {"Tax": 3994, "Financing/Loan repay": 1030, "Intercompany/Owner": 1150, "Internal \u00b7 transfer/loan in": -25320}}, "2026": {"rev": 79551, "op": 34444, "exp": {"Personnel \u00b7 staff": 12899, "Marketing": 10246, "Rent": 8821, "Other/Misc": 5905, "Accounting/Professional": 3842, "Supplies/Retail": 2327, "Bank/Payment fees": 422, "Software/SaaS": 214}, "below": {"Financing/Loan repay": 2527, "Intercompany/Owner": 14900, "Tax": 4947}}}, "Holding": {"2025": {"rev": 161243, "op": 94981, "exp": {"Personnel \u00b7 contractor chiro": 28680, "Supplies/Retail": 16734, "Other/Misc": 10478, "Accounting/Professional": 4037, "Marketing": 2622, "Travel/Transport": 1432, "Rent": 1431, "Bank/Payment fees": 772}, "below": {"Intercompany/Owner": 48010, "Tax": 18904, "Financing/Loan repay": 27488}}, "2026": {"rev": 107336, "op": 51569, "exp": {"Personnel \u00b7 contractor chiro": 37736, "Other/Misc": 10678, "Personnel \u00b7 staff": 4229, "Accounting/Professional": 1516, "Travel/Transport": 1120, "Rent": 250}, "below": {"Tax": 14895, "Intercompany/Owner": 20339, "Financing/Loan repay": 4883}}}}, ORDER=["Amstelveen", "Utrecht", "Bussum", "Rotterdam", "Holding"], LABEL={"Holding": "Notable (holding)"}, MONTHLY=[71488, 65154, 80199, 75479, 78357], PACE=74135.4, ASOF="Jun 2026";
  var PL_SPEND={"Utrecht":{"2021":{"Owner / intercompany":24661,"Other":17115,"Supplies/equipment":16035,"Chiro wages":15874,"Rent":14792,"Software/SaaS":8206,"Marketing":7384,"Tax":6017,"Accounting":1429,"Card & fees":1340,"Groceries":1047,"Insurance":466},"2022":{"Owner / intercompany":67121,"Chiro wages":54143,"Other":33848,"Rent":23162,"Marketing":20480,"Tax":10160,"Software/SaaS":4790,"Supplies/equipment":2212,"Card & fees":1998,"Groceries":1810,"Insurance":1522,"Personnel \u00b7 payroll":642,"Accounting":578,"Energy/utilities":87,"Travel/parking":5},"2023":{"Chiro wages":139500,"Owner / intercompany":44255,"Other":40611,"Personnel \u00b7 payroll":18293,"Marketing":18086,"Tax":11779,"Supplies/equipment":6557,"Rent":5891,"Energy/utilities":3797,"Travel/parking":3028,"Insurance":2315,"Groceries":2041,"Card & fees":1832,"CA wages":1319,"Accounting":774,"Software/SaaS":773},"2024":{"Chiro wages":139960,"Other":41705,"Personnel \u00b7 payroll":18816,"Marketing":18762,"CA wages":16443,"Owner / intercompany":16420,"Tax":16212,"Accounting":3947,"Insurance":3830,"Energy/utilities":2477,"Travel/parking":1565,"Card & fees":1400,"Software/SaaS":1375,"Supplies/equipment":1171,"Groceries":713},"2025":{"Chiro wages":82756,"Owner / intercompany":41277,"Other":30512,"CA wages":24651,"Tax":15264,"Marketing":15079,"Personnel \u00b7 payroll":11012,"Accounting":6193,"Energy/utilities":3087,"Groceries":1379,"Software/SaaS":1310,"Travel/parking":1234,"Card & fees":629,"Supplies/equipment":495,"Insurance":109},"2026":{"Chiro wages":49097,"Other":17487,"CA wages":12781,"Tax":11114,"Marketing":5321,"Accounting":3762,"Owner / intercompany":1720,"Energy/utilities":1168,"Groceries":675,"Software/SaaS":556,"Travel/parking":466,"Card & fees":358,"Supplies/equipment":116}},"Bussum":{"2022":{"Other":58579,"Owner / intercompany":39662,"Supplies/equipment":10508,"Rent":8333,"Personnel \u00b7 payroll":8224,"Chiro wages":7833,"Marketing":4508,"Tax":2991,"Travel/parking":2319,"Energy/utilities":2007,"Groceries":895,"CA wages":886,"Software/SaaS":710,"Accounting":457,"Card & fees":282,"Insurance":234},"2023":{"Other":57144,"Chiro wages":33442,"Personnel \u00b7 payroll":14119,"Owner / intercompany":14084,"CA wages":12013,"Tax":11673,"Marketing":10649,"Energy/utilities":4879,"Card & fees":1858,"Travel/parking":1065,"Groceries":987,"Accounting":942,"Software/SaaS":913,"Supplies/equipment":810,"Insurance":809},"2024":{"Other":47134,"Owner / intercompany":26293,"Chiro wages":22331,"Card & fees":16895,"CA wages":16404,"Marketing":11254,"Energy/utilities":6661,"Tax":5819,"Accounting":3619,"Personnel \u00b7 payroll":2923,"Travel/parking":1904,"Supplies/equipment":1241,"Software/SaaS":693,"Insurance":623,"Groceries":362},"2025":{"Other":43859,"Chiro wages":39628,"CA wages":23340,"Card & fees":10741,"Marketing":10186,"Tax":9062,"Accounting":4996,"Energy/utilities":4952,"Owner / intercompany":4947,"Rent":4753,"Personnel \u00b7 payroll":4526,"Travel/parking":2333,"Software/SaaS":717,"Supplies/equipment":388,"Insurance":231,"Groceries":63},"2026":{"CA wages":12308,"Rent":12080,"Other":11636,"Chiro wages":10622,"Owner / intercompany":7500,"Tax":3938,"Accounting":3023,"Marketing":2266,"Energy/utilities":1489,"Travel/parking":1482,"Software/SaaS":364,"Insurance":231,"Card & fees":210,"Groceries":48,"Supplies/equipment":35}},"Amstelveen":{"2023":{"Other":30136,"Supplies/equipment":28506,"Owner / intercompany":22376,"Chiro wages":21603,"Marketing":10581,"Personnel \u00b7 payroll":6543,"Tax":1404,"Card & fees":1338,"Travel/parking":1218,"Accounting":849,"CA wages":545,"Groceries":537,"Software/SaaS":184},"2024":{"Chiro wages":55391,"Owner / intercompany":47415,"Other":31723,"Supplies/equipment":28795,"Marketing":25942,"Card & fees":14414,"Personnel \u00b7 payroll":13927,"CA wages":11851,"Tax":9258,"Accounting":4794,"Travel/parking":3197,"Software/SaaS":1834,"Groceries":960},"2025":{"Chiro wages":70673,"Owner / intercompany":61623,"Other":45554,"Supplies/equipment":35737,"Marketing":30060,"CA wages":21871,"Card & fees":13867,"Tax":13083,"Personnel \u00b7 payroll":11732,"Rent":6440,"Travel/parking":6101,"Accounting":5692,"Insurance":3654,"Software/SaaS":2616,"Groceries":584},"2026":{"Other":54082,"Chiro wages":32896,"Owner / intercompany":19995,"Tax":12123,"Marketing":8832,"CA wages":6853,"Card & fees":6825,"Supplies/equipment":5463,"Accounting":4550,"Travel/parking":4460,"Insurance":1567,"Software/SaaS":1224,"Rent":425,"Groceries":249}},"Rotterdam":{"2025":{"Supplies/equipment":22346,"CA wages":10652,"Rent":7154,"Other":6654,"Tax":3994,"Personnel \u00b7 payroll":2870,"Owner / intercompany":1901,"Marketing":1695,"Card & fees":278,"Software/SaaS":243,"Groceries":72,"Travel/parking":4},"2026":{"Owner / intercompany":16135,"CA wages":14139,"Other":11345,"Rent":8621,"Marketing":6722,"Tax":4947,"Accounting":2584,"Card & fees":1292,"Supplies/equipment":813,"Groceries":470,"Software/SaaS":214,"Energy/utilities":168,"Travel/parking":30}},"Holding":{"2020":{"Other":2201,"Supplies/equipment":1424,"Accounting":1047,"Tax":68,"Card & fees":40},"2021":{"Chiro wages":4375,"Other":4244,"Rent":4235,"Supplies/equipment":1171,"Owner / intercompany":1100,"Accounting":460,"Card & fees":84,"Tax":53},"2022":{"Owner / intercompany":28609,"Chiro wages":17033,"Other":14974,"Tax":13117,"Software/SaaS":7702,"Accounting":7241,"Supplies/equipment":723,"Card & fees":203},"2023":{"Owner / intercompany":30853,"Chiro wages":29625,"Accounting":17376,"Tax":14469,"Other":14293,"Software/SaaS":9517,"Supplies/equipment":350,"Marketing":302},"2024":{"Owner / intercompany":42861,"Tax":25396,"Other":21817,"Chiro wages":13269,"Marketing":5724,"Accounting":3945,"CA wages":2400},"2025":{"Owner / intercompany":74442,"Chiro wages":30180,"Tax":18988,"Supplies/equipment":16448,"Other":14384,"Marketing":2622,"Card & fees":2488,"Accounting":1079,"Travel/parking":35},"2026":{"Chiro wages":37736,"Owner / intercompany":20339,"Other":17160,"Tax":14895,"Card & fees":4883,"Accounting":756,"Travel/parking":115}}}; var CC={"Chiro wages":"#2563eb","CA wages":"#0891b2","Personnel \u00b7 payroll":"#7c3aed","Marketing":"#16a34a","Rent":"#ea580c","Supplies/equipment":"#db2777","Owner / intercompany":"#94a3b8","Tax":"#dc2626","Accounting":"#0d9488","Energy/utilities":"#ca8a04","Card & fees":"#9333ea","Software/SaaS":"#475569","Travel/parking":"#a16207","Insurance":"#65a30d","Groceries":"#f59e0b","Other":"#cbd5e1"};
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
  let cols = null;
  for (const r of rows) {
    if (!r || !r.length) continue;
    const cells = r.map(c => (c || "").trim());
    // Detect header row
    const hasName = cells.some(c => c === "Name");
    const hasCA = cells.some(c => c === "CA");
    const hasAppt = cells.some(c => c === "Appointments");
    if (hasName && hasCA && hasAppt) {
      cols = cells;
      continue;
    }
    if (!cols) continue;
    // Build the row object
    const obj = { _clinic: clinic };
    cols.forEach((h, idx) => { if (h) obj[h] = cells[idx] || ""; });
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
    if (!s.byClinic[cl]) s.byClinic[cl] = { intakes: 0, packages: 0, doorplannen: 0 };
    s.byClinic[cl].intakes++;
    if (aptsNum >= 3) s.byClinic[cl].doorplannen++;
    if ((i.Package || "").toLowerCase() === "yes") s.byClinic[cl].packages++;
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
    const stats = computeCAStats(intakes);
    data = {
      ok: true,
      totalIntakes: intakes.length,
      perCA: Object.values(stats).sort((a, b) => b.intakes - a.intakes),
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

function renderCAPage(data) {
  const rows = (data.perCA || []).map(s => {
    const clinicBreak = Object.entries(s.byClinic)
      .map(([cl, d]) => `${cl}: ${d.intakes}`)
      .join(" · ");
    const phoneSet = !!caPhone(s.name);
    return `
      <tr>
        <td style="font-weight:600">${s.name}${phoneSet ? "" : ' <span style="color:#c00;font-size:11px">(no phone)</span>'}</td>
        <td style="text-align:right">${s.intakes}</td>
        <td>${pctBar(s.doorplannenPct, "#2563eb")} <span style="margin-left:6px">${Math.round(s.doorplannenPct)}%</span> <span style="color:#888;font-size:11px">(${s.doorplannen}/${s.intakes})</span></td>
        <td>${pctBar(s.packagePct, "#16a34a")} <span style="margin-left:6px">${Math.round(s.packagePct)}%</span> <span style="color:#888;font-size:11px">(${s.packages}/${s.intakes})</span></td>
        <td style="text-align:right">${s.avgAppts.toFixed(1)}</td>
        <td style="text-align:right">${Math.round(s.metaPct)}%</td>
        <td style="font-size:12px;color:#555">${clinicBreak}</td>
        <td><a href="/ca/coach?target=${encodeURIComponent(s.name)}" style="background:#16202E;color:#fff;padding:6px 10px;border-radius:6px;text-decoration:none;font-size:12px">Coach ${s.name}</a></td>
      </tr>`;
  }).join("");

  const total = data.totalIntakes || 0;
  const overall = (data.perCA || []).reduce((a, s) => {
    a.intakes += s.intakes; a.doorplannen += s.doorplannen; a.packages += s.packages;
    return a;
  }, { intakes: 0, doorplannen: 0, packages: 0 });
  const overallDoor = overall.intakes ? Math.round((overall.doorplannen / overall.intakes) * 100) : 0;
  const overallPkg  = overall.intakes ? Math.round((overall.packages / overall.intakes) * 100) : 0;

  const errBlock = (data.errors && data.errors.length) ? `<div style="background:#fef3c7;padding:10px;border-radius:6px;margin-bottom:14px;font-size:12px;color:#92400e">Some sheets couldn't load: ${data.errors.join(" · ")}</div>` : "";

  return `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CA Performance — Posturefixx</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 1200px; margin: 24px auto; padding: 0 16px; color: #16202E; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 20px; }
  .stat-row { display: flex; gap: 14px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat { background: #f8fafc; padding: 14px 18px; border-radius: 10px; min-width: 130px; }
  .stat-val { font-size: 24px; font-weight: 700; }
  .stat-lbl { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th { text-align: left; padding: 10px 8px; border-bottom: 2px solid #e5e7eb; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; color: #555; }
  td { padding: 10px 8px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
</style></head><body>
<h1>CA Performance</h1>
<div class="sub">From doorplannen sheet · Intakes across all 4 clinics</div>
${errBlock}
<div class="stat-row">
  <div class="stat"><div class="stat-val">${total}</div><div class="stat-lbl">Total intakes</div></div>
  <div class="stat"><div class="stat-val">${overallDoor}%</div><div class="stat-lbl">Avg doorplannen</div></div>
  <div class="stat"><div class="stat-val">${overallPkg}%</div><div class="stat-lbl">Avg package conv.</div></div>
</div>
<table>
  <thead><tr>
    <th>CA</th><th style="text-align:right">Intakes</th>
    <th>Doorplannen %</th><th>Package %</th>
    <th style="text-align:right">Avg appts</th><th style="text-align:right">Meta %</th>
    <th>By clinic</th><th></th>
  </tr></thead>
  <tbody>${rows || '<tr><td colspan="8" style="text-align:center;padding:40px;color:#888">No intake data loaded</td></tr>'}</tbody>
</table>
<div style="margin-top:24px;font-size:12px;color:#888">Tip: open <a href="/plan">/plan</a> for the chiropractor coaching dashboard.</div>
</body></html>`;
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
const BARE_LOC = { Myles: "Amstelveen", Annefloor: "Amstelveen", Nick: "Bussum", Holly: "Amstelveen", Courtney: "Amstelveen" };

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
  return { keys, labels, pva, earn, errors, found: { y2026: t26.found, y2025: t25.found } };
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
    document.getElementById("chirohi").innerHTML=chiroHi(key);
    Array.prototype.forEach.call(document.querySelectorAll("button[data-ck]"),function(b){var on=b.getAttribute("data-ck")===key;b.style.background=on?"#16202E":"#fff";b.style.color=on?"#fff":"#6B7686";b.style.borderColor=on?"#16202E":"#e5e7eb";});
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
//  /coach/cron — scheduled team coaching send (Mon & Thu 9am via an external
//  scheduler). NOT browser-gated: protected by a secret token instead, so an
//  automated caller can trigger it. Set CRON_SECRET in Render. Optionally set
//  COACH_TARGET (yearly revenue target) to steer the goals; defaults to 1.1M.
//  This sends straight out — there is NO human review step on scheduled sends.
// ============================================================================
app.get("/coach/cron", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.query.key !== secret) return res.status(403).json({ ok: false, error: "forbidden" });
  const target = parseInt(process.env.COACH_TARGET) || parseInt(req.query.target) || 1100000;
  try {
    const goals = chiroGoals(target, await chiroBaselines(30));
    const results = [];
    for (const g of goals) {
      if (!g.phone) { results.push(`${g.n}: skipped (no phone)`); continue; }
      try {
        const msg = await draftCoaching(g);
        await sendSms(g.smsClinic, g.phone, g.n, msg);
        results.push(`${g.n}: sent`);
      } catch (e) { results.push(`${g.n}: failed — ${e.message}`); }
    }
    console.log("[coach/cron]", new Date().toISOString(), "·", results.join(" | "));
    res.json({ ok: true, at: new Date().toISOString(), target, results });
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
<h1>Marketing by clinic</h1><div class="sub">Monthly ad spend (Google / Meta / Organic) per clinic \u00b7 cost per lead \u00b7 from bank payments</div>
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
<div class="tabs" id="tabs"></div>${sections}
<p class="sub">Pages: <a href="/plan">/plan</a> \u00b7 <a href="/revenue">/revenue</a> \u00b7 <a href="/marketing">/marketing</a> \u00b7 <a href="/waste">/waste</a> \u00b7 <a href="/pva">/pva</a> \u00b7 <a href="/ca">/ca</a> \u00b7 <a href="/coach">/coach</a></p>
<script>
var WF={"Utrecht":{"2021":{"Card & fees":[null,null,160,54,null,null,null,null,null,null,435,691],"Accounting":[null,null,null,null,182,31,31,226,null,61,61,836],"Supplies/equipment":[null,null,11722,3757,95,28,29,52,120,81,8,143],"Other":[null,null,2063,5148,591,797,855,825,1028,2469,2172,1167],"Chiro wages":[null,null,null,267,2234,1623,1558,1558,1758,1558,1558,3758],"Rent":[null,null,null,null,1982,1830,1830,1830,1830,1830,1830,1830],"Owner / intercompany":[null,null,null,4375,null,1000,3079,3211,3393,3000,2000,4604],"Groceries":[null,null,null,39,147,92,112,92,93,94,167,210],"Marketing":[null,null,null,50,261,711,1279,760,779,1207,891,1445],"Tax":[null,null,null,null,170,429,448,448,413,1734,1734,641],"Software/SaaS":[null,null,null,101,2069,853,853,854,869,869,869,869],"Insurance":[null,null,null,null,null,null,96,74,74,null,148,74]},"2022":{"Chiro wages":[1707,4556,2075,1599,2158,4658,3458,9308,4288,8873,1897,9566],"Other":[2565,4302,2706,2388,2477,1935,2214,2196,3830,2386,2926,3924],"Marketing":[1218,2244,1830,2073,2159,1915,2071,1460,1513,1224,1430,1342],"Card & fees":[32,189,17,81,65,965,59,72,76,133,192,116],"Groceries":[214,117,198,167,182,160,160,199,114,100,93,107],"Owner / intercompany":[4036,12218,3800,4757,5957,4379,2816,3000,4245,5371,5682,10862],"Rent":[1830,1830,1830,1964,1964,1964,1964,1964,1964,1964,1964,1964],"Supplies/equipment":[60,177,103,379,null,42,419,450,21,144,24,393],"Accounting":[null,170,125,31,31,31,31,31,31,null,63,31],"Tax":[1529,2079,1331,1337,439,460,460,499,484,572,578,392],"Software/SaaS":[869,1087,1087,1087,52,52,54,284,54,54,54,54],"Insurance":[113,204,146,146,313,84,84,97,84,84,84,84],"Energy/utilities":[null,9,9,9,9,9,9,9,9,9,9,null],"Personnel \u00b7 payroll":[null,null,null,null,642,null,null,null,null,null,null,null],"Travel/parking":[null,null,4,2,null,null,null,null,null,null,null,null]},"2023":{"Chiro wages":[6591,8454,3848,9434,20945,11768,11812,11432,6086,14335,11335,23459],"Other":[4845,4257,1990,5571,4437,3248,6071,2539,1477,1533,1986,2658],"Marketing":[1652,664,1396,493,1019,556,1621,2228,2526,1772,2243,1915],"Tax":[1309,2048,1001,779,729,675,768,657,787,768,692,1566],"Energy/utilities":[1727,191,187,187,187,187,187,187,187,187,187,200],"Personnel \u00b7 payroll":[1903,1206,3037,1190,1190,1190,2790,1190,null,1190,1190,2218],"Owner / intercompany":[7295,6110,6015,5956,4818,4396,2518,1450,1607,1440,450,2200],"Groceries":[91,143,241,146,191,296,267,198,76,91,72,230],"Travel/parking":[null,null,null,455,301,605,309,396,418,111,229,204],"Card & fees":[462,53,25,null,125,81,137,126,94,113,432,184],"Software/SaaS":[54,54,54,54,54,54,58,158,58,58,58,58],"Accounting":[null,33,null,61,null,null,null,null,null,null,340,340],"Supplies/equipment":[404,125,223,187,81,4515,726,125,26,19,null,126],"Insurance":[85,290,153,153,153,153,153,190,465,197,161,161],"CA wages":[null,null,40,null,null,null,null,null,1279,null,null,null],"Rent":[1964,null,3927,null,null,null,null,null,null,null,null,null]},"2024":{"Chiro wages":[8210,8465,18150,13045,5764,17580,11022,10088,9792,7825,13549,16471],"Other":[3914,3547,4141,2530,2999,2320,2165,6808,5586,3414,2110,2171],"Marketing":[3109,1276,2137,2224,1937,2232,849,975,1045,923,1271,782],"Owner / intercompany":[3945,2350,1350,null,null,null,null,55,1000,2350,2460,2910],"Groceries":[58,60,27,38,51,162,14,23,12,84,60,124],"Tax":[1239,1150,1182,1120,1222,1195,2386,1641,1281,1198,1370,1228],"CA wages":[2489,200,279,2489,200,200,200,261,2489,2660,2489,2489],"Accounting":[359,359,null,359,359,359,359,359,359,359,359,359],"Travel/parking":[138,205,128,123,149,131,110,112,120,117,122,111],"Software/SaaS":[146,111,111,111,111,111,113,113,113,114,114,107],"Card & fees":[441,231,184,119,121,37,37,36,38,38,50,67],"Energy/utilities":[420,187,187,187,187,187,187,187,187,187,187,187],"Supplies/equipment":[299,190,487,35,null,null,100,null,null,null,41,19],"Insurance":[203,336,221,261,221,459,774,316,null,716,322,null],"Personnel \u00b7 payroll":[null,4175,3922,null,2289,2289,4792,null,null,1250,100,null]},"2025":{"Other":[2462,2218,2387,2618,2027,4687,1973,1660,2097,1274,2614,4494],"Chiro wages":[11050,15222,8143,5844,4049,8979,3659,3376,9175,1521,7942,3798],"Marketing":[752,822,821,1976,1443,868,888,1202,1580,2263,1666,799],"Tax":[1144,1378,1262,1262,2467,1262,1262,954,1164,999,1028,1082],"CA wages":[2489,200,2576,2576,200,486,3157,2748,2680,2379,2576,2584],"Travel/parking":[158,91,96,98,74,211,101,170,8,56,82,90],"Software/SaaS":[109,109,109,109,109,109,109,109,109,111,111,109],"Accounting":[null,null,null,null,null,null,1974,1843,551,679,573,573],"Groceries":[48,71,101,107,87,109,192,168,86,115,171,124],"Card & fees":[47,49,58,69,56,54,54,37,32,70,41,62],"Supplies/equipment":[33,null,76,null,7,123,6,null,88,null,66,96],"Energy/utilities":[358,229,229,229,229,229,229,271,271,271,271,271],"Owner / intercompany":[1350,293,3093,3093,6000,1926,3322,6250,5800,3950,3200,3000],"Personnel \u00b7 payroll":[100,4294,null,null,4242,2376,null,null,null,null,null,null],"Insurance":[44,null,null,44,22,null,null,null,null,null,null,null]},"2026":{"Other":[3213,2986,2079,4878,1751,2580,null,null,null,null,null,null],"Groceries":[137,120,146,104,90,79,null,null,null,null,null,null],"Travel/parking":[87,100,57,100,50,73,null,null,null,null,null,null],"Software/SaaS":[91,91,91,91,91,104,null,null,null,null,null,null],"Accounting":[786,459,478,779,586,675,null,null,null,null,null,null],"Card & fees":[45,70,48,55,80,62,null,null,null,null,null,null],"Energy/utilities":[51,257,215,215,215,215,null,null,null,null,null,null],"Marketing":[790,1487,886,971,944,244,null,null,null,null,null,null],"CA wages":[2598,2595,1920,2834,2395,440,null,null,null,null,null,null],"Chiro wages":[8374,7715,10497,7852,11816,2844,null,null,null,null,null,null],"Tax":[1245,2342,1231,null,4768,1528,null,null,null,null,null,null],"Owner / intercompany":[null,null,500,720,500,null,null,null,null,null,null,null],"Supplies/equipment":[89,27,null,null,null,null,null,null,null,null,null,null]}},"Bussum":{"2022":{"Chiro wages":[null,null,null,16,null,null,9,36,null,3460,null,4312],"Other":[null,3297,3697,4500,6267,5506,2785,7327,7215,5988,5463,6533],"Travel/parking":[null,null,172,null,142,285,364,298,277,292,136,353],"Marketing":[null,null,null,250,833,378,224,161,245,317,1037,1064],"Groceries":[null,null,null,78,111,178,87,106,69,59,85,123],"Owner / intercompany":[null,13850,2332,600,183,948,2730,6630,2664,1981,4234,3511],"Tax":[null,null,null,null,149,373,null,518,566,395,598,392],"CA wages":[null,null,null,null,null,null,null,null,null,null,504,382],"Energy/utilities":[null,null,null,null,1545,66,66,66,66,66,66,66],"Supplies/equipment":[null,null,100,8491,437,152,241,726,268,null,17,77],"Software/SaaS":[null,null,null,null,93,121,36,266,36,51,53,53],"Personnel \u00b7 payroll":[null,null,null,null,642,1198,1467,908,843,2167,null,1000],"Accounting":[null,null,null,null,31,166,null,31,31,31,166,null],"Card & fees":[null,null,64,null,34,null,null,184,null,null,null,null],"Insurance":[null,null,null,null,null,234,null,null,null,null,null,null],"Rent":[null,8333,null,null,null,null,null,null,null,null,null,null]},"2023":{"Other":[5234,4869,4396,4405,4582,6236,4375,4908,4767,4890,5082,3400],"Groceries":[89,74,73,65,78,58,64,73,72,117,169,55],"Tax":[null,1040,1006,1529,1515,1018,1207,65,2367,947,65,914],"Accounting":[231,null,null,31,null,null,null,null,null,null,340,340],"CA wages":[1278,1380,1259,null,null,766,null,532,3827,1590,713,668],"Travel/parking":[348,272,318,null,null,null,null,null,null,13,53,61],"Energy/utilities":[66,66,66,66,null,889,762,642,642,560,560,560],"Chiro wages":[4500,6299,500,3628,1750,1750,4670,2050,995,2836,2250,2214],"Card & fees":[null,164,null,null,null,null,null,null,null,null,null,1695],"Marketing":[1860,1187,568,1052,1269,637,1239,1026,150,337,904,420],"Software/SaaS":[53,53,53,53,53,53,57,57,57,57,311,57],"Insurance":[null,null,131,276,50,null,100,50,50,50,50,50],"Supplies/equipment":[562,null,null,null,6,null,30,13,null,171,28,null],"Personnel \u00b7 payroll":[1949,766,766,2256,2177,1099,2474,1866,null,null,766,null],"Owner / intercompany":[2575,2000,1750,2090,null,541,1612,1683,442,1290,100,null]},"2024":{"Other":[3749,4211,3601,5488,3248,2922,4429,3649,3792,4407,3383,4255],"Marketing":[660,691,710,1131,813,1207,1139,784,1140,1062,1197,721],"CA wages":[700,853,200,200,200,1200,2570,2571,2571,200,2497,2642],"Tax":[65,192,65,419,249,328,65,809,957,957,714,999],"Travel/parking":[73,84,106,199,232,197,60,215,164,142,226,206],"Energy/utilities":[560,560,560,560,347,582,582,582,582,582,582,582],"Card & fees":[1441,1559,1421,1414,1408,1400,1393,1386,1377,1369,1364,1364],"Software/SaaS":[57,57,57,57,57,57,49,69,59,59,59,59],"Chiro wages":[1616,1836,1836,1836,1836,1836,1836,2136,3736,null,1927,1900],"Accounting":[428,359,null,359,321,359,359,359,359,359,359,null],"Groceries":[18,17,22,61,63,25,24,113,4,7,6,null],"Personnel \u00b7 payroll":[481,null,300,null,null,null,null,null,null,2142,null,null],"Owner / intercompany":[786,500,null,3000,2200,4350,10452,2500,1800,705,null,null],"Supplies/equipment":[543,null,null,null,48,245,12,69,null,325,null,null],"Insurance":[51,51,51,null,231,239,null,null,null,null,null,null]},"2025":{"Other":[4598,2469,6128,4368,1216,8090,4035,3038,1714,3322,3457,1423],"Rent":[null,null,null,null,null,null,null,null,null,2377,null,2377],"Chiro wages":[1900,1900,3400,3400,5300,null,3522,3400,5300,1500,3400,6606],"Tax":[1141,727,727,727,889,662,662,724,889,683,665,566],"CA wages":[2642,200,2384,2284,200,2384,2118,2120,2409,2189,2227,2183],"Travel/parking":[142,54,130,356,296,222,282,275,80,190,197,108],"Accounting":[null,null,null,null,null,null,2028,816,389,623,570,570],"Energy/utilities":[582,582,582,582,390,319,319,319,319,319,319,319],"Marketing":[705,740,105,998,1978,102,735,574,1125,1662,1061,401],"Card & fees":[1350,1345,1336,1345,1334,43,1311,1301,1275,18,32,53],"Software/SaaS":[59,59,59,59,59,59,61,61,61,61,61,61],"Owner / intercompany":[200,110,null,null,null,1282,null,1400,900,1000,55,null],"Supplies/equipment":[null,null,null,null,null,null,104,null,null,null,284,null],"Groceries":[17,null,null,11,null,null,null,null,null,15,20,null],"Insurance":[null,null,null,null,null,231,null,null,null,null,null,null],"Personnel \u00b7 payroll":[null,2442,null,null,2084,null,null,null,null,null,null,null]},"2026":{"Other":[1381,1437,2738,2186,2164,1729,null,null,null,null,null,null],"Travel/parking":[200,203,255,237,215,372,null,null,null,null,null,null],"Insurance":[null,null,null,null,null,231,null,null,null,null,null,null],"Accounting":[582,459,459,548,488,488,null,null,null,null,null,null],"Chiro wages":[null,1957,1068,2781,2759,2057,null,null,null,null,null,null],"Energy/utilities":[319,319,319,319,null,213,null,null,null,null,null,null],"Marketing":[266,968,261,266,287,219,null,null,null,null,null,null],"CA wages":[2421,2421,2421,2645,2161,240,null,null,null,null,null,null],"Software/SaaS":[61,61,61,61,61,61,null,null,null,null,null,null],"Card & fees":[38,33,36,33,34,37,null,null,null,null,null,null],"Rent":[2377,2377,2442,2442,null,2442,null,null,null,null,null,null],"Tax":[618,922,727,922,749,null,null,null,null,null,null,null],"Owner / intercompany":[1000,null,500,3000,3000,null,null,null,null,null,null,null],"Groceries":[null,null,null,23,25,null,null,null,null,null,null,null],"Supplies/equipment":[35,null,null,null,null,null,null,null,null,null,null,null]}},"Amstelveen":{"2023":{"Marketing":[null,null,null,null,null,null,200,1038,2052,2798,1608,2884],"Other":[null,null,null,null,2489,4823,1396,3244,5879,4397,4003,3904],"Groceries":[null,null,null,null,null,null,null,93,91,151,140,63],"Personnel \u00b7 payroll":[null,null,null,null,null,null,null,null,709,1628,null,4205],"Owner / intercompany":[null,null,null,null,8484,null,1084,1717,2651,1809,3432,3200],"Supplies/equipment":[null,null,null,null,6427,14413,369,108,1101,2966,2970,153],"Chiro wages":[null,null,null,null,9115,null,null,2346,null,2802,2346,4993],"Card & fees":[null,null,null,null,null,null,null,null,3,48,47,1239],"Accounting":[null,null,null,null,null,null,null,null,null,null,392,457],"CA wages":[null,null,null,null,null,null,null,null,null,null,null,545],"Travel/parking":[null,null,null,null,null,null,null,null,null,249,463,505],"Software/SaaS":[null,null,null,null,null,null,null,null,null,82,51,51],"Tax":[null,null,null,null,null,null,null,null,154,560,690,null]},"2024":{"Software/SaaS":[51,51,51,51,160,228,186,207,195,197,197,258],"Marketing":[1681,1382,2221,3144,2568,1868,1682,1888,2814,2302,2406,1985],"Other":[925,683,2968,2408,2015,1785,3476,5561,3360,3767,1680,3095],"Owner / intercompany":[2250,2000,3850,2300,2500,500,6000,4500,6150,5600,5515,6250],"CA wages":[832,200,200,783,200,837,783,783,1670,1596,1869,2098],"Supplies/equipment":[241,null,145,2269,181,7035,2137,1394,4664,3385,3341,4002],"Tax":[562,1490,751,622,620,606,612,732,856,832,769,806],"Accounting":[557,457,null,457,457,457,null,382,417,417,417,775],"Card & fees":[1226,1217,1215,1214,1207,1203,1196,1191,1192,1189,1182,1182],"Groceries":[62,62,64,155,44,50,37,95,158,112,59,62],"Travel/parking":[276,329,289,307,287,208,226,252,261,298,237,228],"Chiro wages":[3963,4348,4505,4182,4182,4182,4232,4232,6132,6843,4291,4296],"Personnel \u00b7 payroll":[2909,2840,2790,null,2712,null,2676,null,null,null,null,null]},"2025":{"Owner / intercompany":[8500,4889,4935,4110,14500,null,3675,4135,6376,4003,3500,3000],"Travel/parking":[128,274,310,340,295,283,313,701,838,844,806,969],"Groceries":[90,44,27,18,58,26,75,21,24,26,103,74],"Software/SaaS":[197,197,197,197,219,220,221,221,271,224,227,224],"Supplies/equipment":[7262,2939,5649,103,4912,4451,4611,4593,132,null,310,774],"Other":[4052,1940,3192,3610,3200,4303,4466,2743,5339,3883,3762,5064],"Chiro wages":[4627,4458,8418,5962,6628,4096,7910,4723,5941,5941,7400,4570],"Marketing":[2005,2331,2591,3532,2934,1922,3014,1680,3219,3099,2473,1259],"Tax":[856,null,1324,537,1451,896,676,896,1667,551,2599,1630],"CA wages":[2098,200,700,200,200,2273,1048,1122,1622,5567,3004,3836],"Insurance":[1125,null,null,98,290,106,1332,185,288,null,null,230],"Card & fees":[1161,1160,1171,1198,1165,1168,1155,1131,1120,1166,1101,1174],"Accounting":[null,null,null,null,null,null,1856,1293,814,576,576,576],"Personnel \u00b7 payroll":[null,3814,464,2516,2516,157,null,2264,null,null,null,null],"Rent":[null,null,null,null,4293,716,1431,null,null,null,null,null]},"2026":{"Other":[5159,6964,13163,16087,10464,2245,null,null,null,null,null,null],"Card & fees":[1157,1166,1148,1133,1118,1102,null,null,null,null,null,null],"Travel/parking":[646,796,883,870,639,626,null,null,null,null,null,null],"Insurance":[177,null,241,265,413,471,null,null,null,null,null,null],"Software/SaaS":[224,303,240,215,130,111,null,null,null,null,null,null],"Accounting":[1373,459,459,972,682,607,null,null,null,null,null,null],"Chiro wages":[4536,7913,4927,3640,9461,2419,null,null,null,null,null,null],"Supplies/equipment":[2721,65,49,1913,435,281,null,null,null,null,null,null],"Marketing":[1473,2344,1359,1633,1430,592,null,null,null,null,null,null],"CA wages":[2989,1127,547,1033,717,440,null,null,null,null,null,null],"Groceries":[38,31,93,41,46,null,null,null,null,null,null,null],"Owner / intercompany":[5500,6000,2055,2385,4055,null,null,null,null,null,null,null],"Tax":[2187,2262,2995,797,3882,null,null,null,null,null,null,null],"Rent":[null,null,425,null,null,null,null,null,null,null,null,null]}},"Rotterdam":{"2025":{"Other":[null,null,null,null,null,null,1169,44,1308,723,1855,1555],"Tax":[null,null,null,null,null,null,null,null,1020,null,2202,772],"Software/SaaS":[null,null,null,null,null,null,61,36,36,36,36,36],"CA wages":[null,null,null,null,null,null,null,2576,null,2799,2527,2749],"Marketing":[null,null,null,null,null,null,null,null,60,186,663,786],"Rent":[null,null,null,null,null,null,null,1431,1431,1431,1431,1430],"Groceries":[null,null,null,null,null,null,9,null,14,26,12,12],"Travel/parking":[null,null,null,null,null,null,null,null,null,null,4,null],"Card & fees":[null,null,null,null,null,null,null,null,null,264,14,null],"Owner / intercompany":[null,null,null,null,null,null,376,526,null,null,1000,null],"Supplies/equipment":[null,null,null,null,null,null,3702,18466,166,13,null,null],"Personnel \u00b7 payroll":[null,null,null,null,null,null,null,null,2870,null,null,null]},"2026":{"Other":[652,1493,3128,3120,1305,1648,null,null,null,null,null,null],"Groceries":[58,45,102,113,119,33,null,null,null,null,null,null],"Marketing":[864,1622,1005,1131,1199,900,null,null,null,null,null,null],"Travel/parking":[null,null,24,null,null,6,null,null,null,null,null,null],"Card & fees":[null,29,14,14,14,1220,null,null,null,null,null,null],"Supplies/equipment":[698,78,10,null,14,12,null,null,null,null,null,null],"Accounting":[null,null,null,2525,30,30,null,null,null,null,null,null],"CA wages":[2785,2643,2885,2953,2633,240,null,null,null,null,null,null],"Rent":[1430,1430,2865,null,2862,34,null,null,null,null,null,null],"Energy/utilities":[null,null,42,42,42,42,null,null,null,null,null,null],"Owner / intercompany":[1235,2000,3000,4000,5900,null,null,null,null,null,null,null],"Tax":[1004,994,856,1099,994,null,null,null,null,null,null,null],"Software/SaaS":[36,36,36,53,53,null,null,null,null,null,null,null]}},"Holding":{"2020":{"Other":[null,null,null,null,null,null,11,11,10,293,11,1865],"Tax":[null,null,null,null,null,null,null,null,null,null,null,68],"Accounting":[null,null,null,null,null,null,null,null,null,115,932,null],"Card & fees":[null,null,null,null,null,null,null,40,null,null,null,null],"Supplies/equipment":[null,null,null,null,null,null,1424,null,null,null,null,null]},"2021":{"Card & fees":[null,null,null,null,null,null,null,null,null,null,null,84],"Other":[382,1798,12,1365,445,135,11,10,10,54,11,10],"Tax":[null,null,null,null,null,null,null,null,null,53,null,null],"Accounting":[115,null,null,null,115,null,115,null,null,115,null,null],"Owner / intercompany":[null,null,100,null,null,null,null,1000,null,null,null,null],"Chiro wages":[null,null,null,4375,null,null,null,null,null,null,null,null],"Rent":[null,4235,null,null,null,null,null,null,null,null,null,null],"Supplies/equipment":[null,1171,null,null,null,null,null,null,null,null,null,null]},"2022":{"Other":[199,2379,2699,1091,263,77,862,22,1243,835,1704,3600],"Owner / intercompany":[null,null,null,270,1500,2688,2460,3674,4422,4149,6298,3149],"Accounting":[null,117,null,null,331,2217,31,208,31,63,211,4031],"Tax":[null,null,null,null,1323,1294,1294,5582,906,906,906,906],"Software/SaaS":[null,null,null,null,1035,1035,690,null,460,1494,1494,1494],"Chiro wages":[null,5000,241,null,3511,2990,null,null,null,null,5291,null],"Supplies/equipment":[null,null,467,null,null,null,null,206,null,50,null,null],"Card & fees":[null,203,null,null,null,null,null,null,null,null,null,null]},"2023":{"Other":[1688,1595,728,2311,3035,1302,2207,538,469,54,194,173],"Owner / intercompany":[3432,3432,3432,3400,3432,3432,null,550,500,2382,3432,3432],"Tax":[906,922,922,922,1668,922,1990,922,922,922,1192,2259],"Accounting":[4582,1438,985,771,1711,304,2506,1717,1377,1377,304,304],"Chiro wages":[6177,null,null,null,7926,2780,null,null,null,9719,null,3022],"Software/SaaS":[1494,920,1494,690,762,1337,533,1016,508,762,null,null],"Supplies/equipment":[null,null,null,null,null,279,40,null,31,null,null,null],"Marketing":[null,null,null,null,null,null,302,null,null,null,null,null]},"2024":{"Owner / intercompany":[3432,3016,2300,4230,3265,3265,3265,3265,5265,4530,3265,3765],"Tax":[2223,1527,1491,1491,1527,1543,8026,1527,1491,1532,1527,1491],"Other":[2072,389,688,847,2020,340,4642,2492,1862,1981,2879,1606],"Accounting":[321,null,631,386,359,321,321,321,321,321,321,321],"Marketing":[null,null,null,null,1226,1339,1500,1500,159,null,null,null],"CA wages":[null,null,null,null,600,600,600,600,null,null,null,null],"Chiro wages":[7948,null,null,2718,2603,null,null,null,null,null,null,null]},"2025":{"Other":[987,836,1221,541,541,3975,886,1436,862,1592,938,570],"Owner / intercompany":[4766,3265,5179,3265,3265,5000,30756,2300,4145,2025,5151,5325],"Tax":[2982,1470,1434,1434,3941,null,397,1514,1434,1434,1476,1472],"Card & fees":[null,null,null,null,null,null,null,null,null,null,1247,1241],"Chiro wages":[1500,3040,5519,null,null,5815,2785,null,null,2600,4616,4305],"Travel/parking":[null,null,null,null,null,null,null,null,35,null,null,null],"Accounting":[null,218,null,null,null,null,861,null,null,null,null,null],"Supplies/equipment":[149,null,null,null,10000,6299,null,null,null,null,null,null],"Marketing":[807,1815,null,null,null,null,null,null,null,null,null,null]},"2026":{"Other":[1563,535,1183,7458,1692,4728,null,null,null,null,null,null],"Accounting":[null,null,null,252,252,252,null,null,null,null,null,null],"Tax":[1434,5378,1592,3198,1475,1818,null,null,null,null,null,null],"Chiro wages":[8971,190,6010,2811,19754,null,null,null,null,null,null,null],"Travel/parking":[null,23,null,null,92,null,null,null,null,null,null,null],"Owner / intercompany":[1325,6651,4455,4455,3455,null,null,null,null,null,null,null],"Card & fees":[null,1230,1224,1218,1212,null,null,null,null,null,null,null]}},"All":{"2020":{"Other":[null,null,null,null,null,null,11,11,10,293,11,1865],"Tax":[null,null,null,null,null,null,null,null,null,null,null,68],"Accounting":[null,null,null,null,null,null,null,null,null,115,932,null],"Card & fees":[null,null,null,null,null,null,null,40,null,null,null,null],"Supplies/equipment":[null,null,null,null,null,null,1424,null,null,null,null,null]},"2021":{"Card & fees":[null,null,160,54,null,null,null,null,null,null,435,774],"Accounting":[115,null,null,null,297,31,146,226,null,176,61,836],"Supplies/equipment":[null,1171,11722,3757,95,28,29,52,120,81,8,143],"Other":[382,1798,2075,6513,1036,932,866,836,1038,2524,2182,1177],"Chiro wages":[null,null,null,4641,2234,1623,1558,1558,1758,1558,1558,3758],"Rent":[null,4235,null,null,1982,1830,1830,1830,1830,1830,1830,1830],"Owner / intercompany":[null,null,100,4375,null,1000,3079,4211,3393,3000,2000,4604],"Groceries":[null,null,null,39,147,92,112,92,93,94,167,210],"Marketing":[null,null,null,50,261,711,1279,760,779,1207,891,1445],"Tax":[null,null,null,null,170,429,448,448,413,1787,1734,641],"Software/SaaS":[null,null,null,101,2069,853,853,854,869,869,869,869],"Insurance":[null,null,null,null,null,null,96,74,74,null,148,74]},"2022":{"Chiro wages":[1707,9556,2316,1614,5670,7648,3467,9343,4288,12333,7188,13878],"Other":[2764,9978,9102,7979,9007,7519,5861,9544,12289,9209,10093,14057],"Marketing":[1218,2244,1830,2323,2992,2293,2295,1621,1757,1540,2468,2406],"Card & fees":[32,392,81,81,98,965,59,256,76,133,192,116],"Groceries":[214,117,198,245,293,339,247,305,182,158,178,229],"Owner / intercompany":[4036,26068,6131,5627,7639,8014,8006,13304,11331,11501,16213,17522],"Rent":[1830,10163,1830,1964,1964,1964,1964,1964,1964,1964,1964,1964],"Supplies/equipment":[60,177,669,8870,437,193,660,1382,289,194,41,470],"Accounting":[null,288,125,31,394,2414,63,271,94,94,440,4063],"Tax":[1529,2079,1331,1337,1911,2127,1754,6599,1956,1873,2082,1690],"Software/SaaS":[869,1087,1087,1087,1180,1208,780,550,550,1600,1602,1602],"Insurance":[113,204,146,146,313,318,84,97,84,84,84,84],"Energy/utilities":[null,9,9,9,1554,75,75,75,75,75,75,66],"Personnel \u00b7 payroll":[null,null,null,null,1284,1198,1467,908,843,2167,null,1000],"Travel/parking":[null,null,176,2,142,285,364,298,277,292,136,353],"CA wages":[null,null,null,null,null,null,null,null,null,null,504,382]},"2023":{"Chiro wages":[17268,14754,4348,13062,39737,16298,16482,15828,7081,29692,15931,33689],"Other":[11767,10720,7114,12288,14543,15609,14049,11228,12592,10874,11264,10136],"Marketing":[3512,1851,1964,1545,2288,1193,3363,4292,4729,4907,4755,5219],"Tax":[2215,4010,2929,3230,3912,2615,3965,1644,4230,3197,2639,4739],"Energy/utilities":[1793,257,253,253,187,1076,949,829,829,747,747,760],"Personnel \u00b7 payroll":[3852,1972,3803,3446,3367,2289,5264,3056,709,2818,1956,6423],"Owner / intercompany":[13302,11542,11196,11446,16734,8369,5214,5400,5199,6921,7413,8832],"Groceries":[180,218,314,211,269,355,330,364,239,359,380,347],"Travel/parking":[348,272,318,455,301,605,309,396,418,373,746,770],"Card & fees":[462,216,25,null,125,81,137,126,97,161,479,3117],"Software/SaaS":[1602,1027,1602,797,870,1445,648,1231,623,958,420,166],"Accounting":[4813,1471,985,863,1711,304,2506,1717,1377,1377,1377,1442],"Supplies/equipment":[966,125,223,187,6514,19207,1165,246,1158,3155,2998,278],"Insurance":[85,290,284,430,204,153,254,240,515,248,211,211],"CA wages":[1278,1380,1299,null,null,766,null,532,5106,1590,713,1213],"Rent":[1964,null,3927,null,null,null,null,null,null,null,null,null]},"2024":{"Chiro wages":[21737,14648,24491,21782,14385,23599,17090,16456,19660,14668,19767,22667],"Other":[10660,8830,11398,11273,10282,7367,14712,18510,14599,13570,10052,11127],"Marketing":[5450,3349,5069,6499,6544,6645,5169,5147,5158,4288,4874,3488],"Owner / intercompany":[10413,7866,7500,9530,7965,8115,19717,10320,14215,13185,11240,12925],"Groceries":[138,140,113,253,158,237,75,232,174,203,125,186],"Tax":[4089,4359,3489,3652,3618,3672,11089,4709,4585,4519,4380,4524],"CA wages":[4020,1253,679,3472,1200,2837,4153,4215,6729,4457,6855,7229],"Accounting":[1665,1175,631,1561,1496,1496,1039,1421,1455,1455,1455,1455],"Travel/parking":[487,617,523,629,668,536,396,579,545,556,584,545],"Software/SaaS":[254,219,219,219,327,395,348,389,367,370,370,424],"Card & fees":[3108,3008,2820,2747,2735,2640,2626,2613,2607,2596,2597,2613],"Energy/utilities":[980,747,747,747,534,769,769,769,769,769,769,769],"Supplies/equipment":[1082,190,632,2304,229,7280,2249,1463,4664,3709,3383,4021],"Insurance":[254,387,272,261,452,698,774,316,null,716,322,null],"Personnel \u00b7 payroll":[3390,7015,7012,null,5001,2289,7468,null,null,3392,100,null]},"2025":{"Other":[12100,7464,12928,11138,6984,21054,12529,8921,11320,10795,12626,13105],"Chiro wages":[19076,24620,25480,15205,15976,18889,17876,11499,20416,11562,23358,19279],"Marketing":[4269,5708,3517,6506,6355,2891,4638,3456,5984,7211,5863,3245],"Tax":[6123,3575,4747,3960,8748,2820,2997,4088,6174,3667,7970,5522],"CA wages":[7229,600,5660,5060,600,5143,6323,8566,6711,12934,10334,11353],"Travel/parking":[428,419,537,794,664,716,697,1146,961,1090,1089,1167],"Software/SaaS":[365,365,365,365,387,388,452,427,478,432,434,430],"Accounting":[null,218,null,null,null,null,6719,3952,1754,1878,1720,1720],"Groceries":[154,114,128,136,145,136,276,189,123,182,306,210],"Card & fees":[2557,2554,2565,2611,2554,1264,2520,2470,2426,1519,2434,2530],"Supplies/equipment":[7444,2939,5726,103,14919,10873,8423,23059,387,13,660,870],"Energy/utilities":[940,811,811,811,619,548,548,590,590,590,590,590],"Owner / intercompany":[14816,8557,13207,10468,23765,8208,38130,14611,17221,10978,12906,11325],"Personnel \u00b7 payroll":[100,10551,464,2516,8842,2533,null,2264,2870,null,null,null],"Insurance":[1169,null,null,142,312,338,1332,185,288,null,null,230],"Rent":[null,null,null,null,4293,716,1431,1431,1431,3808,1431,3807]},"2026":{"Other":[11968,13415,22291,33730,17377,12930,null,null,null,null,null,null],"Groceries":[232,196,340,280,280,113,null,null,null,null,null,null],"Travel/parking":[934,1122,1219,1207,995,1078,null,null,null,null,null,null],"Software/SaaS":[411,491,428,419,334,276,null,null,null,null,null,null],"Accounting":[2741,1376,1395,5075,2037,2051,null,null,null,null,null,null],"Card & fees":[1240,2526,2470,2453,2458,2421,null,null,null,null,null,null],"Energy/utilities":[370,576,576,576,257,470,null,null,null,null,null,null],"Marketing":[3393,6422,3510,4002,3860,1955,null,null,null,null,null,null],"CA wages":[10793,8786,7773,9465,7906,1360,null,null,null,null,null,null],"Chiro wages":[21881,17774,22502,17084,43790,7320,null,null,null,null,null,null],"Tax":[6488,11898,7401,6016,11868,3346,null,null,null,null,null,null],"Owner / intercompany":[9061,14651,10510,14560,16910,null,null,null,null,null,null,null],"Supplies/equipment":[3543,170,59,1913,449,293,null,null,null,null,null,null],"Insurance":[177,null,241,265,413,702,null,null,null,null,null,null],"Rent":[3807,3807,5732,2442,2862,2477,null,null,null,null,null,null]}}}; var CC={"Chiro wages":"#2563eb","CA wages":"#0891b2","Personnel \u00b7 payroll":"#7c3aed","Marketing":"#16a34a","Rent":"#ea580c","Supplies/equipment":"#db2777","Owner / intercompany":"#94a3b8","Tax":"#dc2626","Accounting":"#0d9488","Energy/utilities":"#ca8a04","Card & fees":"#9333ea","Software/SaaS":"#475569","Travel/parking":"#a16207","Insurance":"#65a30d","Groceries":"#f59e0b","Other":"#cbd5e1"};
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
function drawWaste(loc,year){
  var yobj=(WF[loc]||{})[year]||{};
  var cats=Object.keys(yobj).sort(function(a,b){return sum(yobj[b])-sum(yobj[a]);});
  var h="<table><thead><tr><th style='text-align:left'>Category</th>";
  MN.forEach(function(m){h+="<th>"+m+"</th>";}); h+="<th>Total</th></tr></thead><tbody>";
  cats.forEach(function(c){
    var arr=yobj[c];
    h+="<tr style='cursor:pointer' onclick='advise(&quot;"+loc+"&quot;,&quot;"+year+"&quot;,&quot;"+c+"&quot;)'><td style='text-align:left'><span style='display:inline-block;width:9px;height:9px;border-radius:2px;background:"+(CC[c]||'#cbd5e1')+";margin-right:6px;vertical-align:middle'></span>"+c+"</td>";
    arr.forEach(function(v){h+="<td class='num'>"+(v!=null?eur(v):"\u00b7")+"</td>";});
    h+="<td class='num'><b>"+eur(sum(arr))+"</b></td></tr>";
  });
  h+="</tbody></table>";
  var el=document.getElementById("wt-"+loc); if(el) el.innerHTML=h;
  Array.prototype.forEach.call(document.querySelectorAll("button[data-wy='"+loc+"']"),function(b){var on=b.getAttribute("data-year")===year;b.style.background=on?"#2563EB":"#fff";b.style.color=on?"#fff":"#6B7686";b.style.borderColor=on?"#2563EB":"#e5e7eb";});
  var ae=document.getElementById("wa-"+loc); if(ae) ae.innerHTML="Click any category row to see live advice for it.";
}
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
  card("/coach","Coach the chiros","Drafts a warm SMS to each chiropractor toward your target. You review before it sends."),
  card("/pva","PVA / retention","Retention per chiropractor, month by month, with good/improve highlights for each."),
  card("/ca","CA dashboard (Renata)","Script-adherence tracker: doorplannen %, package conversion and avg appts per CA, with coaching drafts.")
])}
<h3>The money</h3>${grid([
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
  card("/coach/cron?key=YOUR_CRON_SECRET","Auto-coach","Endpoint a scheduler hits to send team coaching twice a week.")
])}
<p class="sub" style="margin-top:18px">Tip: bookmark this page \u2014 it links to everything. First open each session asks for the login (manager password for Renata, owner password for you).</p>
</body></html>`);
});

// Safety net: a single bad request should never take the whole site down (502).
// Log it and keep serving every other page.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", (e && e.message) || e));
process.on("uncaughtException",  (e) => console.error("uncaughtException:",  (e && e.message) || e));

app.listen(process.env.PORT || 3000, () => console.log("coaching-engine up — /plan (chiros) & /ca (CAs)"));
