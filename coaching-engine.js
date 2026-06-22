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
  var PL_SPEND={"Utrecht":{"2021":{"Other (suppliers, fees, misc)":64826,"Contractor chiros":20388,"Rent":14792,"Marketing":7384,"Tax":6017,"Software/SaaS":492,"Insurance":466},"2022":{"Other (suppliers, fees, misc)":121309,"Rent":23162,"Marketing":20480,"Contractor chiros":17748,"Intercompany/Owner":17406,"Tax":10160,"Personnel":10125,"Insurance":1522,"Software/SaaS":640,"Travel/Parking":5},"2023":{"Other (suppliers, fees, misc)":102564,"Contractor chiros":94770,"Intercompany/Owner":43352,"Personnel":18293,"Marketing":18086,"Tax":11779,"Rent":5891,"Travel/Parking":3028,"Insurance":2315,"Software/SaaS":773},"2024":{"Other (suppliers, fees, misc)":107329,"Contractor chiros":100294,"Personnel":18816,"Marketing":18762,"Tax":16458,"Intercompany/Owner":16365,"Insurance":3830,"Travel/Parking":1565,"Software/SaaS":1375},"2025":{"Other (suppliers, fees, misc)":112300,"Contractor chiros":48449,"Intercompany/Owner":29976,"Tax":15518,"Marketing":15079,"Personnel":11012,"Software/SaaS":1310,"Travel/Parking":1234,"Insurance":109},"2026":{"Other (suppliers, fees, misc)":77030,"Tax":11361,"Contractor chiros":8167,"Marketing":5321,"Intercompany/Owner":1720,"Software/SaaS":556,"Travel/Parking":466}},"Bussum":{"2022":{"Other (suppliers, fees, misc)":102148,"Intercompany/Owner":19752,"Personnel":8224,"Contractor chiros":7754,"Marketing":4508,"Tax":2991,"Travel/Parking":2337,"Software/SaaS":480,"Insurance":234},"2023":{"Other (suppliers, fees, misc)":82302,"Contractor chiros":30078,"Personnel":14119,"Intercompany/Owner":14034,"Tax":11673,"Marketing":10649,"Travel/Parking":1065,"Insurance":809,"Software/SaaS":659},"2024":{"Other (suppliers, fees, misc)":108601,"Intercompany/Owner":26293,"Marketing":11254,"Contractor chiros":6027,"Tax":5819,"Personnel":2923,"Travel/Parking":1922,"Software/SaaS":693,"Insurance":623},"2025":{"Other (suppliers, fees, misc)":93052,"Contractor chiros":39628,"Marketing":10186,"Tax":9062,"Intercompany/Owner":4947,"Personnel":4526,"Travel/Parking":2373,"Software/SaaS":717,"Insurance":231},"2026":{"Other (suppliers, fees, misc)":40830,"Contractor chiros":10622,"Intercompany/Owner":7500,"Tax":3938,"Marketing":2266,"Travel/Parking":1482,"Software/SaaS":364,"Insurance":231}},"Amstelveen":{"2023":{"Other (suppliers, fees, misc)":72939,"Intercompany/Owner":18195,"Marketing":10581,"Rent":9386,"Personnel":6543,"Contractor chiros":5372,"Tax":1404,"Travel/Parking":1218,"Software/SaaS":184},"2024":{"Other (suppliers, fees, misc)":128311,"Intercompany/Owner":42265,"Marketing":25942,"Personnel":14427,"Rent":14079,"Tax":13258,"Contractor chiros":6188,"Travel/Parking":3197,"Software/SaaS":1834},"2025":{"Other (suppliers, fees, misc)":150641,"Intercompany/Owner":61458,"Contractor chiros":43334,"Marketing":30060,"Tax":13083,"Personnel":11732,"Rent":6590,"Travel/Parking":6120,"Insurance":3654,"Software/SaaS":2616},"2026":{"Other (suppliers, fees, misc)":92218,"Intercompany/Owner":19940,"Contractor chiros":18700,"Tax":12123,"Marketing":8832,"Travel/Parking":4515,"Insurance":1567,"Software/SaaS":1224,"Rent":425}},"Rotterdam":{"2025":{"Other (suppliers, fees, misc)":39840,"Rent":7154,"Tax":3994,"Personnel":2870,"Intercompany/Owner":1901,"Marketing":1695,"Software/SaaS":406,"Travel/Parking":4},"2026":{"Other (suppliers, fees, misc)":30811,"Intercompany/Owner":16135,"Rent":8621,"Marketing":6722,"Tax":4947,"Software/SaaS":214,"Travel/Parking":30}},"Holding":{"2020":{"Other (suppliers, fees, misc)":4711,"Tax":68},"2021":{"Other (suppliers, fees, misc)":5958,"Contractor chiros":5375,"Rent":4235,"Intercompany/Owner":100,"Tax":53},"2022":{"Other (suppliers, fees, misc)":43924,"Contractor chiros":17033,"Personnel":15258,"Tax":13117,"Intercompany/Owner":270},"2023":{"Other (suppliers, fees, misc)":61914,"Contractor chiros":29262,"Tax":14469,"Personnel":10813,"Marketing":302,"Software/SaaS":25},"2024":{"Other (suppliers, fees, misc)":69073,"Tax":25396,"Contractor chiros":13269,"Marketing":5724,"Personnel":1950},"2025":{"Other (suppliers, fees, misc)":81089,"Contractor chiros":31180,"Intercompany/Owner":26752,"Tax":18988,"Marketing":2622,"Travel/Parking":35},"2026":{"Other (suppliers, fees, misc)":43139,"Contractor chiros":37736,"Tax":14895,"Travel/Parking":115}}};
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
    var btns=yrs.map(function(y){return "<button data-clinic='"+clinic+"' data-year='"+y+"' onclick='drawSpend(\""+clinic+"\",\""+y+"\")' style='padding:5px 10px;margin:0 6px 6px 0;border:1px solid #e5e7eb;background:#fff;border-radius:6px;font-size:12px;cursor:pointer;color:#6B7686'>"+y+(y==="2026"?" YTD":"")+"</button>";}).join("");
    return "<div class='card'><b>Spend by category</b> <span class='sub' style='font-size:12px'>\u00b7 pick a year \u2014 history runs from "+yrs[0]+" \u00b7 hover a bar for the figure</span>"+
      "<div style='margin:10px 0 4px'>"+btns+"</div><div id='spend-"+clinic+"'></div></div>";
  }
  function drawSpend(clinic,year){
    var exp=(PL_SPEND[clinic]||{})[year]||{};
    var cats=Object.keys(exp).sort(function(a,b){return exp[b]-exp[a];});
    var max=cats.length?exp[cats[0]]:1, rowH=30, padL=160, W=720, barMax=W-padL-90, H=cats.length*rowH+10, g="";
    cats.forEach(function(c,i){ var yt=i*rowH+6, v=exp[c], w=v/max*barMax;
      g+="<text x='"+(padL-8)+"' y='"+(yt+14)+"' text-anchor='end' font-size='11' fill='#16202E'>"+c+"</text>";
      g+="<rect x='"+padL+"' y='"+yt+"' width='"+w+"' height='16' rx='3' fill='#2563EB'><title>"+c+": "+eur(v)+"</title></rect>";
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
 ${debugBlock}
 <p class="sub">Pages: <a href="/plan">/plan</a> · <a href="/revenue">/revenue</a> · <a href="/marketing">/marketing</a> · <a href="/waste">/waste</a> · <a href="/pva">/pva</a> · <a href="/ca">/ca</a> · <a href="/coach">/coach</a></p>
 <script>
  var tabs=["YTD PVA","Month-to-month","PVA vs earnings"],el=document.getElementById("tabs");
  function show(n){Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"),function(s){s.style.display=s.getAttribute("data-tab")===n?"":"none"});Array.prototype.forEach.call(el.children,function(b){b.className="tab"+(b.textContent===n?" on":"")})}
  tabs.forEach(function(n){var b=document.createElement("div");b.className="tab";b.textContent=n;b.onclick=function(){show(n)};el.appendChild(b)});show(tabs[0]);
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
//  /revenue — per-clinic revenue, YEAR OVER YEAR, from real MT940 bank data
//  One line per year (Jan..Dec) + 2026 projection. Figures are cash-in (credits),
//  same basis as the /plan P&L revenue. Baked from the bank exports (history is
//  static); re-provide newer MT940 files to extend 2026.
// ============================================================================
const BANK_REV = {"Bussum":{"2026":[10229,6989,14352,16379,12939,null,null,null,null,null,null,null],"2025":[14733,10220,15685,14648,12459,12181,15666,14123,14817,14471,14525,15325],"2024":[13930,8318,8724,20207,15907,13612,19508,12283,14032,12646,12755,11248],"2023":[18590,14369,11717,15348,13801,11995,16861,11472,12167,15929,9613,10129],"2022":[null,0,70,3927,10156,11381,13009,17288,16518,13651,12357,11433]},"Rotterdam":{"2026":[13594,13651,16057,14333,13113,null,null,null,null,null,null,null],"2025":[null,null,null,null,null,null,25000,3550,6801,7098,8580,7118]},"Utrecht":{"2026":[21701,14351,18680,20538,22353,null,null,null,null,null,null,null],"2025":[20981,18072,22391,19586,18933,19250,18303,20430,20793,18721,20609,12634],"2024":[30110,24482,20532,22944,22996,21128,22877,22367,24941,22673,27035,23430],"2023":[30891,23347,25682,21796,30444,24480,21241,21363,20749,26169,24960,23607],"2022":[20045,22950,15434,14606,17695,16722,19143,24110,19190,20018,19040,23192],"2021":[null,null,33101,440,5017,7796,8253,10030,14635,9789,11265,15978]},"Amstelveen":{"2026":[31536,29530,31635,28562,28879,null,null,null,null,null,null,null],"2025":[28112,23654,33273,28117,28306,25771,27801,27464,28169,29066,30926,27392],"2024":[16579,15677,17043,22228,19165,17491,21251,24405,22823,23881,28582,22726],"2023":[null,null,null,null,46767,194,2040,11708,15628,22915,16029,15209]},"Holding":{"2026":[19116,14513,22905,10608,38304,null,null,null,null,null,null,null],"2025":[10463,10532,14123,4407,17906,48590,8036,5303,6484,7679,15550,12172],"2024":[15909,4850,5200,9797,11403,7409,19130,9695,8309,8704,7822,7922],"2023":[18007,8551,7315,8046,21123,8887,6464,4850,3784,16292,3990,9313],"2022":[1002,6475,3405,4286,7678,9186,4046,9894,6864,7307,16883,12479],"2021":[962,7333,0,5198,827,121,0,949,363,0,0,302],"2020":[null,null,null,null,null,null,1000,464,283,121,0,368]}};
const REV_ORDER = ["Amstelveen","Utrecht","Bussum","Rotterdam","Holding"];
const YEAR_COLOR = {2020:"#cbd5e1",2021:"#94a3b8",2022:"#64748b",2023:"#0891b2",2024:"#7c3aed",2025:"#16a34a",2026:"#2563eb"};

function projectYear(arr){ // linear run-rate on filled months -> fill the rest (dashed)
  const pts=arr.map((v,i)=>[i,v]).filter(p=>p[1]!=null);
  if(pts.length<3) return Array(12).fill(null);
  const n=pts.length,sx=pts.reduce((a,p)=>a+p[0],0),sy=pts.reduce((a,p)=>a+p[1],0);
  const sxy=pts.reduce((a,p)=>a+p[0]*p[1],0),sxx=pts.reduce((a,p)=>a+p[0]*p[0],0);
  const m=(n*sxy-sx*sy)/(n*sxx-sx*sx),b=(sy-m*sx)/n,last=pts[pts.length-1][0];
  return Array.from({length:12},(_,i)=> i>last?Math.max(0,Math.round(m*i+b)):null);
}

function svgYears(years){
  const W=760,H=380,P={l:54,r:90,t:16,b:30};
  const proj2026 = years["2026"]?projectYear(years["2026"]):null;
  const vals=[].concat(...Object.values(years).map(a=>a.filter(v=>v!=null)), (proj2026||[]).filter(v=>v!=null),1);
  const max=Math.max(...vals)*1.12;
  const x=m=>P.l+(m/11)*(W-P.l-P.r), y=v=>H-P.b-(v/max)*(H-P.t-P.b);
  const step=max>40000?10000:max>20000?5000:2000;
  let g="";
  for(let t=0;t<=max;t+=step) g+=`<line x1="${P.l}" x2="${W-P.r}" y1="${y(t)}" y2="${y(t)}" stroke="#eef2f7"/><text x="${P.l-8}" y="${y(t)+4}" text-anchor="end" font-size="10" fill="#94a3b8">€${(t/1000)|0}k</text>`;
  MONTHS.forEach((m,i)=>g+=`<text x="${x(i)}" y="${H-10}" text-anchor="middle" font-size="9" fill="#94a3b8">${m}</text>`);
  const draw=(arr,color,dash,w)=>{ const pts=arr.map((v,i)=>v==null?null:`${x(i)},${y(v)}`).filter(Boolean);
    let s=pts.length>1?`<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="${w}"${dash?` stroke-dasharray="${dash}"`:""}/>`:"";
    arr.forEach((v,i)=>{ if(v!=null) s+=`<circle cx="${x(i)}" cy="${y(v)}" r="${w>2?2.6:2}" fill="${color}"><title>${MONTHS[i]} ${v!=null?'€'+v.toLocaleString('en-US'):''}</title></circle>`; }); return s; };
  const ys=Object.keys(years).sort();
  let li=0;
  for(const yr of ys){ const c=YEAR_COLOR[yr]||"#475569"; const emph=(yr==="2026"); g+=draw(years[yr],c,"",emph?3:1.8);
    g+=`<text x="${W-P.r+8}" y="${22+li*16}" font-size="11" fill="${c}" font-weight="${emph?700:400}">${yr}</text>`; li++; }
  if(proj2026){ const a=years["2026"]; const lastA=a.reduce((acc,v,i)=>v!=null?i:acc,-1); const pb=proj2026.slice(); if(lastA>=0)pb[lastA]=a[lastA];
    g+=draw(pb,"#2563eb","5 4",2); g+=`<text x="${W-P.r+8}" y="${22+li*16}" font-size="10" fill="#2563eb">2026 proj</text>`; }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${g}</svg>`;
}

app.get("/revenue", gate, async (_req,res)=>{ try {
  const fmt=n=>"€"+Math.round(n||0).toLocaleString("en-US");
  const sum=a=>a.filter(v=>v!=null).reduce((x,y)=>x+y,0);
  const panels=REV_ORDER.map(c=>{
    const years=BANK_REV[c]||{}; const ys=Object.keys(years).sort();
    const yearTot={}; ys.forEach(y=>yearTot[y]=sum(years[y]));
    const last=ys.filter(y=>y!=="2026").pop(), prev=ys.filter(y=>y!=="2026" && y<last).pop();
    const yoy = (last&&prev)? ((yearTot[last]/yearTot[prev]-1)*100):null;
    let projFull=null; if(years["2026"]){ const done=years["2026"].filter(v=>v!=null); const p=projectYear(years["2026"]); projFull=sum(done)+sum(p); }
    const arrow = yoy==null?"":(yoy>=5?"▲":yoy<=-5?"▼":"▬");
    return `<section data-clinic="${c}" style="display:${c===REV_ORDER[0]?"":"none"}">
      <div class="kpis">
        <div class="kpi"><b>${fmt(yearTot[last])}</b><span>${last} revenue</span></div>
        <div class="kpi"><b>${yoy==null?"—":(yoy>=0?"+":"")+yoy.toFixed(0)+"%"}</b><span>${prev||""}→${last||""} YoY ${arrow}</span></div>
        <div class="kpi"><b>${projFull?fmt(projFull):"—"}</b><span>2026 projected</span></div>
      </div>
      <div class="card">${svgYears(years)}<div class="legend">Each line is one calendar year (cash-in, P&L basis). 2026 solid = actual, dashed = projected to year-end. Hover a point for the month.</div></div>
    </section>`;
  }).join("");

  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revenue by clinic — Posturefixx</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#16202E}
h1{font-size:22px;margin:0 0 2px}.sub{color:#64748b;font-size:13px;margin-bottom:18px}
.tabs{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}.tab{padding:8px 14px;border-radius:8px;background:#f1f5f9;cursor:pointer;font-size:13px;font-weight:600}.tab.on{background:#16202E;color:#fff}
.card{border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:16px}.legend{font-size:12px;color:#64748b;margin-top:10px;line-height:1.5}
.kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}.kpi{flex:1;min-width:150px;border:1px solid #e5e7eb;border-radius:10px;padding:12px}.kpi b{font-size:20px;display:block}.kpi span{font-size:12px;color:#64748b}
a{color:#2563EB}</style></head><body>
<h1>Revenue by clinic — year over year</h1><div class="sub">Real figures from your MT940 bank exports · cash-in basis (matches the /plan P&L) · ${REV_ORDER.length} accounts since 2020</div>
<div class="tabs" id="tabs"></div>${panels}
<p class="sub">Pages: <a href="/plan">/plan</a> · <a href="/revenue">/revenue</a> · <a href="/marketing">/marketing</a> · <a href="/waste">/waste</a> · <a href="/pva">/pva</a> · <a href="/ca">/ca</a> · <a href="/coach">/coach</a></p>
<script>var cs=["Amstelveen","Utrecht","Bussum","Rotterdam","Holding"],el=document.getElementById("tabs");
function show(c){Array.prototype.forEach.call(document.querySelectorAll("[data-clinic]"),function(s){s.style.display=s.getAttribute("data-clinic")===c?"":"none"});Array.prototype.forEach.call(el.children,function(b){b.className="tab"+(b.textContent===c?" on":"")})}
cs.forEach(function(c){var b=document.createElement("div");b.className="tab";b.textContent=c;b.onclick=function(){show(c)};el.appendChild(b)});show(cs[0]);</script>
</body></html>`);
} catch(e){ res.status(500).send("revenue error: "+e.message); }
});

// ============================================================================
//  /marketing — PER CLINIC: monthly ad spend (Google / Meta / Organic) with a
//  year selector, plus cost-per-lead by channel. "Compare" overlays clinics.
//  Google + Meta = ad spend to the platforms; Organic = Shoet agency/social.
// ============================================================================
const MKTG_CLINIC = {"Utrecht":{"Google":{"2026":4641,"2025":10111,"2024":9770,"2023":8460,"2022":13872,"2021":5447},"Meta":{"2026":1040,"2025":2801,"2024":7176,"2023":8984,"2022":6608,"2021":1937},"Shoet":{"2026":681,"2025":4568,"2024":4217,"2023":641}},"Bussum":{"Google":{"2026":1585,"2025":5368,"2024":8489,"2023":5294,"2022":3599},"Meta":{"2026":1240,"2025":2450,"2024":2600,"2023":5035,"2022":908},"Shoet":{"2026":681,"2025":4568,"2024":2565,"2023":321}},"Amstelveen":{"Google":{"2026":4051,"2025":13997,"2024":13026,"2023":3233},"Meta":{"2026":5340,"2025":13695,"2024":10230,"2023":4631},"Shoet":{"2026":681,"2025":4568,"2024":2886,"2023":2716}},"Rotterdam":{"Google":{"2026":1721,"2025":630},"Meta":{"2026":5240,"2025":1665},"Shoet":{"2026":1001}},"Group":{"Meta":{"2024":4159},"Shoet":{"2025":27622,"2024":1565,"2023":302}}};
const MKTG_CLINIC_M = {"Utrecht":{"Google":{"2026":[790,806,886,971,944,null,null,null,null,null,null,null],"2025":[752,822,821,766,838,868,888,869,875,913,900,799],"2024":[766,646,778,990,1011,841,703,654,724,923,951,782],"2023":[996,298,962,265,889,522,314,998,1135,631,742,709],"2022":[1000,2000,1500,1500,1343,1399,1619,758,1020,694,752,288],"2021":[null,null,null,null,250,700,1000,500,500,1000,497,1000]},"Meta":{"2026":[200,200,null,200,null,null,null,null,null,null,null,null],"2025":[200,200,200,200,200,200,200,200,300,340,361,200],"2024":[1212,830,1239,1114,485,949,346,200,200,200,200,200],"2023":[656,366,434,228,131,34,1307,1230,1391,1141,1181,885],"2022":[218,244,330,573,817,516,452,702,492,530,678,1054],"2021":[null,null,null,50,11,11,279,260,279,207,394,445]},"Organic":{"2026":[null,681,null,null,null,null,null,null,null,null,null,null],"2025":[null,null,null,1210,605,null,null,333,605,1210,605,null],"2024":[1331,null,321,321,641,641,null,321,321,null,321,null],"2023":[null,null,null,null,null,null,null,null,null,null,321,321]}},"Bussum":{"Google":{"2026":[266,287,261,266,287,null,null,null,null,null,null,null],"2025":[705,740,105,393,768,102,403,424,420,452,456,401],"2024":[340,370,390,810,813,886,818,784,819,862,876,721],"2023":[1080,813,116,566,494,330,199,205,150,337,584,420],"2022":[null,null,null,250,832,378,224,161,245,317,1037,157]},"Meta":{"2026":[200,200,200,400,null,null,null,null,null,null,null,null],"2025":[200,200,200,200,200,200,200,350,300,null,200,200],"2024":[200,200,200,200,200,200,200,200,200,400,200,200],"2023":[780,374,452,486,775,308,1040,821,null,null,null,null],"2022":[null,null,null,null,1,null,null,null,null,null,null,907]},"Organic":{"2026":[null,681,null,null,null,null,null,null,null,null,null,null],"2025":[null,null,null,605,1210,null,333,null,605,1210,605,null],"2024":[321,321,321,321,null,321,321,null,321,null,321,null],"2023":[null,null,null,null,null,null,null,null,null,null,321,null]}},"Amstelveen":{"Google":{"2026":[773,864,709,683,730,null,null,null,null,null,null,null],"2025":[1255,1331,1191,1222,1204,822,1632,1280,1364,869,1018,809],"2024":[831,761,880,1574,967,1068,661,717,1573,1352,1356,1285],"2023":[null,null,null,null,null,null,null,457,226,964,808,778]},"Meta":{"2026":[900,1000,850,1150,700,null,null,null,null,null,null,null],"2025":[750,1200,1600,1300,1325,1300,1250,600,1450,1220,1050,650],"2024":[1050,300,700,1250,1280,800,700,850,600,950,1050,700],"2023":[null,null,null,null,null,null,200,581,1100,1350,800,600]},"Organic":{"2026":[null,681,null,null,null,null,null,null,null,null,null,null],"2025":[null,null,null,1210,605,null,333,null,605,1210,605,null],"2024":[null,321,641,321,321,null,321,321,641,null,null,null],"2023":[null,null,null,null,null,null,null,null,726,484,null,1506]}},"Rotterdam":{"Google":{"2026":[244,242,305,281,349,null,null,null,null,null,null,null],"2025":[null,null,null,null,null,null,null,null,60,46,213,311]},"Meta":{"2026":[500,900,900,1250,850,null,null,null,null,null,null,null],"2025":[null,null,null,null,null,null,null,null,null,340,650,675]},"Organic":{"2026":[321,681,null,null,null,null,null,null,null,null,null,null]}}};
const MKTG_CPL = {"Utrecht":{"Google":{"spend":4397,"leads":111,"cpl":40},"Meta":{"spend":600,"leads":54,"cpl":11},"Organic":{"spend":681,"leads":58,"cpl":12}},"Bussum":{"Google":{"spend":1367,"leads":71,"cpl":19},"Meta":{"spend":1000,"leads":32,"cpl":31},"Organic":{"spend":681,"leads":24,"cpl":28}},"Amstelveen":{"Google":{"spend":3759,"leads":144,"cpl":26},"Meta":{"spend":4600,"leads":97,"cpl":47},"Organic":{"spend":681,"leads":58,"cpl":12}},"Rotterdam":{"Google":{"spend":1421,"leads":103,"cpl":14},"Meta":{"spend":4400,"leads":117,"cpl":38},"Organic":{"spend":1002,"leads":null,"cpl":null}}};
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
    const f=MKTG_FUNNEL[c]||{};
    const fRow=(n,d)=> d?`<tr><td>${n}</td><td class="num">${d.intakes}</td><td class="num">${d.care}</td><td class="num">${(100*d.care/d.intakes).toFixed(0)}%</td></tr>`:"";
    const funnel=f.Google?`<div class="card"><b>Lead quality \u2014 2026</b>
      <table style="margin-top:6px"><thead><tr><th style="text-align:left">Channel</th><th>Intakes</th><th>Started care</th><th>Convert</th></tr></thead>
      <tbody>${fRow("Google",f.Google)}${fRow("Meta",f.Meta)}</tbody></table>
      <div class="legend">Google leads convert to care far better than Meta at every clinic \u2014 close the intake\u2192care gap before chasing cheaper leads.</div></div>`:"";
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
var WF={"Utrecht":{"2021":{"Other (suppliers, fees, misc)":[null,null,13945,13564,5063,3192,3221,3437,3589,4885,4931,7163],"Rent":[null,null,null,null,1982,1830,1830,1830,1830,1830,1830,1830],"Groceries":[null,null,null,39,147,92,112,96,93,96,167,210],"Restaurants":[null,null,null,36,36,38,69,37,81,32,94,182],"Marketing":[null,null,null,50,261,711,1279,760,779,1207,891,1445],"Alcohol":[null,null,null,null,null,null,null,null,36,68,27,48],"Tax/gov":[null,null,null,null,170,429,448,448,413,1734,1734,641],"Software/SaaS":[null,null,null,101,72,36,36,37,52,52,52,52],"Contractor chiros":[null,null,null,null,null,1065,3079,3211,3411,3000,2000,4622],"Insurance":[null,null,null,null,null,null,96,74,74,null,148,74]},"2022":{"Contractor chiros":[151,null,null,50,50,50,300,450,150,7143,45,9360],"Other (suppliers, fees, misc)":[8889,20716,6844,6725,9055,11827,8541,14705,12092,7178,4987,5954],"Marketing":[1218,2244,1830,2073,2159,1915,2071,1460,1513,1224,1430,1342],"Groceries":[214,117,204,167,182,163,173,216,125,102,125,116],"Fuel":[null,null,null,null,null,null,null,null,null,null,null,82],"Intercompany/Owner":[null,null,null,null,null,null,null,null,45,2406,5637,9317],"Rent":[1830,1830,1830,1964,1964,1964,1964,1964,1964,1964,1964,1964],"Alcohol":[52,20,null,39,57,56,59,22,null,null,3,102],"Tax/gov":[1529,2079,1331,1337,439,460,460,499,484,572,578,392],"Software/SaaS":[52,52,52,52,52,52,54,54,54,54,54,54],"Restaurants":[125,130,147,103,74,83,92,100,202,186,88,68],"Insurance":[113,204,146,146,313,84,84,97,84,84,84,84],"Personnel":[null,1789,2872,3361,2103,null,null,null,null,null,null,null],"Travel/Parking":[null,null,4,2,null,null,null,null,null,null,null,null]},"2023":{"Contractor chiros":[4890,6904,3848,5606,10255,7581,9562,7180,1891,10228,7350,19474],"Other (suppliers, fees, misc)":[9098,6111,2791,9580,15301,12025,9306,6971,7257,5721,6858,7406],"Marketing":[1652,664,1396,493,1019,556,1621,2228,2526,1772,2243,1915],"Tax/gov":[1309,2048,1001,779,729,675,768,657,787,768,692,1566],"Personnel":[1903,1206,3037,1190,1190,1190,2790,1190,null,1190,1190,2218],"Intercompany/Owner":[7250,5803,5565,5956,4718,4396,2518,1450,1607,1440,450,2200],"Groceries":[108,149,257,150,202,310,267,204,76,94,75,230],"Travel/Parking":[null,null,null,455,301,605,309,396,418,111,229,204],"Software/SaaS":[54,54,54,54,54,54,58,158,58,58,58,58],"Alcohol":[null,212,null,null,null,null,null,34,null,162,null,87],"Insurance":[85,290,153,153,153,153,153,190,465,197,161,161],"Restaurants":[70,186,108,250,308,179,65,218,null,72,68,null],"Rent":[1964,null,3927,null,null,null,null,null,null,null,null,null]},"2024":{"Contractor chiros":[4200,6215,15900,8700,1500,12900,8700,8055,5515,4850,9295,14465],"Other (suppliers, fees, misc)":[11772,6942,7396,9991,7994,7451,5369,9698,12935,9634,9489,7297],"Marketing":[3109,1276,2137,2224,1937,2232,849,975,1045,923,1271,782],"Intercompany/Owner":[3945,2350,1350,null,null,null,null,null,1000,2350,2460,2910],"Groceries":[62,60,27,38,51,162,14,23,12,84,60,124],"Tax/gov":[1239,1150,1182,1120,1222,1441,2386,1641,1281,1198,1370,1228],"Travel/Parking":[138,205,128,123,149,131,110,112,120,117,122,111],"Software/SaaS":[146,111,111,111,111,111,113,113,113,114,114,107],"Insurance":[203,336,221,261,221,459,774,316,null,716,322,null],"Personnel":[null,4175,3922,null,2289,2289,4792,null,null,1250,100,null],"Restaurants":[113,22,131,73,135,86,null,41,null,null,null,null],"Alcohol":[41,null,null,null,null,null,null,null,null,null,null,null]},"2025":{"Other (suppliers, fees, misc)":[11938,5078,9547,9930,5007,10370,8052,9865,11796,6193,12309,10222],"Alcohol":[null,null,null,null,null,78,null,null,null,null,238,36],"Contractor chiros":[4500,12900,5262,3000,3000,4108,4822,1500,4500,null,1736,3120],"Marketing":[752,822,821,1976,1443,868,888,1202,1580,2263,1666,799],"Tax/gov":[1144,1378,1516,1262,2467,1262,1262,954,1164,999,1028,1082],"Travel/Parking":[158,91,96,98,74,211,101,170,8,56,82,90],"Software/SaaS":[109,109,109,109,109,109,109,109,109,111,111,109],"Groceries":[48,71,101,107,87,109,192,168,86,115,171,124],"Intercompany/Owner":[1350,200,1500,1500,4500,1926,1500,4750,4300,3950,3000,1500],"Restaurants":[null,34,null,null,60,null,null,70,98,null,null,null],"Personnel":[100,4294,null,null,4242,2376,null,null,null,null,null,null],"Insurance":[44,null,null,44,22,null,null,null,null,null,null,null]},"2026":{"Alcohol":[null,null,null,null,null,68,null,null,null,null,null,null],"Groceries":[137,120,146,104,90,79,null,null,null,null,null,null],"Other (suppliers, fees, misc)":[11040,14108,13672,15120,15993,6355,null,null,null,null,null,null],"Travel/Parking":[87,100,57,100,50,73,null,null,null,null,null,null],"Software/SaaS":[91,91,91,91,91,104,null,null,null,null,null,null],"Marketing":[790,1487,886,971,944,244,null,null,null,null,null,null],"Contractor chiros":[4115,null,1317,1493,850,392,null,null,null,null,null,null],"Tax/gov":[1245,2342,1478,null,4768,1528,null,null,null,null,null,null],"Intercompany/Owner":[null,null,500,720,500,null,null,null,null,null,null,null]}},"Bussum":{"2022":{"Contractor chiros":[null,null,null,null,null,null,null,null,null,3442,null,4312],"Other (suppliers, fees, misc)":[null,16981,6181,12865,8445,6724,4296,15155,10240,6655,6203,7058],"Travel/Parking":[null,null,172,null,142,285,364,298,277,310,136,353],"Marketing":[null,null,null,250,833,378,224,161,245,317,1037,1064],"Groceries":[null,null,null,82,118,181,96,106,71,64,93,123],"Intercompany/Owner":[null,8500,null,600,null,null,1500,null,null,1406,4234,3511],"Tax/gov":[null,null,null,null,149,373,null,518,566,395,598,392],"Software/SaaS":[null,null,null,null,93,121,36,36,36,51,53,53],"Personnel":[null,null,null,null,642,1198,1467,908,843,2167,null,1000],"Restaurants":[null,null,11,136,37,79,25,74,3,null,6,null],"Alcohol":[null,null,null,null,7,32,null,null,null,null,null,null],"Insurance":[null,null,null,null,null,234,null,null,null,null,null,null]},"2023":{"Other (suppliers, fees, misc)":[7371,6478,5721,6075,4588,7891,5167,6095,9237,7211,6974,8499],"Groceries":[89,74,73,65,78,58,64,73,72,117,172,55],"Tax/gov":[null,1040,1006,1529,1515,1018,1207,65,2367,947,65,914],"Travel/Parking":[348,272,318,null,null,null,null,null,null,13,53,61],"Marketing":[1860,1187,568,1052,1269,637,1239,1026,150,337,904,420],"Software/SaaS":[53,53,53,53,53,53,57,57,57,57,57,57],"Contractor chiros":[4550,6299,500,2050,1750,1750,4670,2050,995,2836,2250,378],"Insurance":[null,null,131,276,50,null,100,50,50,50,50,50],"Personnel":[1949,766,766,2256,2177,1099,2474,1866,null,null,766,null],"Intercompany/Owner":[2525,2000,1750,2090,null,541,1612,1683,442,1290,100,null],"Restaurants":[null,null,null,5,null,null,null,null,null,null,null,null]},"2024":{"Other (suppliers, fees, misc)":[9037,9377,7618,9841,7362,8502,11180,10395,10498,7241,8185,8843],"Marketing":[660,691,710,1131,813,1207,1139,784,1140,1062,1197,721],"Tax/gov":[65,192,65,419,249,328,65,809,957,957,714,999],"Travel/Parking":[73,84,106,199,232,197,60,215,182,142,226,206],"Software/SaaS":[57,57,57,57,57,57,49,69,59,59,59,59],"Contractor chiros":[null,null,null,null,null,null,null,300,1900,null,1927,1900],"Groceries":[18,17,22,61,63,25,24,113,4,7,6,null],"Personnel":[481,null,300,null,null,null,null,null,null,2142,null,null],"Intercompany/Owner":[786,500,null,3000,2200,4350,10452,2500,1800,705,null,null],"Restaurants":[null,null,null,16,46,41,null,56,null,null,null,null],"Insurance":[51,51,51,null,231,239,null,null,null,null,null,null]},"2025":{"Other (suppliers, fees, misc)":[9172,4596,10430,8579,3141,10836,9903,7583,6088,8848,6889,6924],"Contractor chiros":[1900,1900,3400,3400,5300,null,3522,3400,5300,1500,3400,6606],"Tax/gov":[1141,727,727,727,889,662,662,724,889,683,665,566],"Travel/Parking":[142,54,130,356,296,222,294,286,98,190,197,108],"Marketing":[705,740,105,998,1978,102,735,574,1125,1662,1061,401],"Software/SaaS":[59,59,59,59,59,59,61,61,61,61,61,61],"Intercompany/Owner":[200,110,null,null,null,1282,null,1400,900,1000,55,null],"Groceries":[17,null,null,11,null,null,null,null,null,15,20,null],"Insurance":[null,null,null,null,null,231,null,null,null,null,null,null],"Personnel":[null,2442,null,null,2084,null,null,null,null,null,null,null]},"2026":{"Other (suppliers, fees, misc)":[7153,7045,8415,8172,4847,5150,null,null,null,null,null,null],"Travel/Parking":[200,203,255,237,215,372,null,null,null,null,null,null],"Insurance":[null,null,null,null,null,231,null,null,null,null,null,null],"Contractor chiros":[null,1957,1068,2781,2759,2057,null,null,null,null,null,null],"Marketing":[266,968,261,266,287,219,null,null,null,null,null,null],"Software/SaaS":[61,61,61,61,61,61,null,null,null,null,null,null],"Tax/gov":[618,922,727,922,749,null,null,null,null,null,null,null],"Intercompany/Owner":[1000,null,500,3000,3000,null,null,null,null,null,null,null],"Groceries":[null,null,null,23,25,null,null,null,null,null,null,null]}},"Amstelveen":{"2023":{"Marketing":[null,null,null,null,null,null,200,1038,2052,2798,1608,2884],"Other (suppliers, fees, misc)":[null,null,null,null,18032,19236,1765,3316,6935,7304,7412,8195],"Groceries":[null,null,null,null,null,null,null,95,94,168,140,63],"Personnel":[null,null,null,null,null,null,null,null,709,1628,null,4205],"Intercompany/Owner":[null,null,null,null,8484,null,1084,1717,1901,1809,null,3200],"Contractor chiros":[null,null,null,null,null,null,null,null,750,440,3432,750],"Travel/Parking":[null,null,null,null,null,null,null,null,null,249,463,505],"Software/SaaS":[null,null,null,null,null,null,null,null,null,82,51,51],"Rent":[null,null,null,null,null,null,null,2346,null,2346,2346,2346],"Tax/gov":[null,null,null,null,null,null,null,null,154,560,690,null],"Restaurants":[null,null,null,null,null,null,null,33,46,104,null,null]},"2024":{"Software/SaaS":[51,51,51,51,160,228,186,207,195,197,197,258],"Marketing":[1681,1382,2221,3144,2568,1868,1682,1888,2814,2302,2406,1985],"Other (suppliers, fees, misc)":[5391,4391,6364,8943,5896,13108,11825,13544,16185,15278,12767,13548],"Intercompany/Owner":[2250,1500,3850,2300,2500,500,2000,4500,5500,5600,5515,6250],"Tax/gov":[562,1490,751,622,620,606,4612,732,856,832,769,806],"Groceries":[67,65,64,155,44,50,37,95,158,112,74,62],"Travel/Parking":[276,329,289,307,287,208,226,252,261,298,237,228],"Contractor chiros":[null,165,322,null,null,null,null,null,1900,1900,null,1900],"Restaurants":[null,null,null,24,null,46,null,null,null,18,null,null],"Personnel":[2909,3340,2790,null,2712,null,2676,null,null,null,null,null],"Rent":[2346,2346,2346,2346,2346,2346,null,null,null,null,null,null]},"2025":{"Intercompany/Owner":[8500,4889,4770,4110,14500,null,3675,4135,6376,4003,3500,3000],"Travel/Parking":[128,293,310,340,295,283,313,701,838,844,806,969],"Groceries":[90,44,27,18,58,26,79,21,24,26,103,74],"Software/SaaS":[197,197,197,197,219,220,221,221,271,224,227,224],"Other (suppliers, fees, misc)":[17052,8617,15565,7583,11949,12195,15712,13423,11569,13734,11118,11325],"Contractor chiros":[2080,2062,3565,3490,4156,4096,5300,2182,3400,3400,5034,4570],"Marketing":[2005,2331,2591,3532,2934,1922,3014,1680,3219,3099,2473,1259],"Tax/gov":[856,null,1324,537,1451,896,676,896,1667,551,2599,1630],"Alcohol":[null,null,null,null,null,null,null,null,null,null,null,99],"Insurance":[1125,null,null,98,290,106,1332,185,288,null,null,230],"Personnel":[null,3814,464,2516,2516,157,null,2264,null,null,null,null],"Rent":[null,null,150,null,4293,716,1431,null,null,null,null,null],"Restaurants":[67,null,15,null,null,null,30,null,null,null,null,null]},"2026":{"Other (suppliers, fees, misc)":[15765,14512,17726,21137,18148,4675,null,null,null,null,null,null],"Travel/Parking":[646,796,883,925,639,626,null,null,null,null,null,null],"Insurance":[177,null,241,265,413,471,null,null,null,null,null,null],"Software/SaaS":[224,303,240,215,130,111,null,null,null,null,null,null],"Contractor chiros":[2170,3181,2561,3640,4729,2419,null,null,null,null,null,null],"Marketing":[1473,2344,1359,1633,1430,592,null,null,null,null,null,null],"Groceries":[38,31,93,41,46,null,null,null,null,null,null,null],"Intercompany/Owner":[5500,6000,2055,2330,4055,null,null,null,null,null,null,null],"Tax/gov":[2187,2262,2995,797,3882,null,null,null,null,null,null,null],"Rent":[null,null,425,null,null,null,null,null,null,null,null,null],"Restaurants":[null,null,5,null,null,null,null,null,null,null,null,null]}},"Rotterdam":{"2025":{"Other (suppliers, fees, misc)":[null,null,null,null,null,null,4871,21079,1461,3621,4396,4304],"Tax/gov":[null,null,null,null,null,null,null,null,1020,null,2202,772],"Software/SaaS":[null,null,null,null,null,null,61,36,36,199,36,36],"Marketing":[null,null,null,null,null,null,null,null,60,186,663,786],"Rent":[null,null,null,null,null,null,null,1431,1431,1431,1431,1430],"Groceries":[null,null,null,null,null,null,9,7,27,42,12,12],"Travel/Parking":[null,null,null,null,null,null,null,null,null,null,4,null],"Intercompany/Owner":[null,null,null,null,null,null,376,526,null,null,1000,null],"Personnel":[null,null,null,null,null,null,null,null,2870,null,null,null]},"2026":{"Other (suppliers, fees, misc)":[4122,4234,6069,8531,4038,3192,null,null,null,null,null,null],"Groceries":[58,53,111,122,119,33,null,null,null,null,null,null],"Marketing":[864,1622,1005,1131,1199,900,null,null,null,null,null,null],"Travel/Parking":[null,null,24,null,null,6,null,null,null,null,null,null],"Rent":[1430,1430,2865,null,2862,34,null,null,null,null,null,null],"Intercompany/Owner":[1235,2000,3000,4000,5900,null,null,null,null,null,null,null],"Tax/gov":[1004,994,856,1099,994,null,null,null,null,null,null,null],"Software/SaaS":[36,36,36,53,53,null,null,null,null,null,null,null],"Alcohol":[null,null,null,110,null,null,null,null,null,null,null,null],"Restaurants":[13,null,null,4,null,null,null,null,null,null,null,null]}},"Holding":{"2020":{"Other (suppliers, fees, misc)":[null,null,null,null,null,null,1435,51,10,408,942,1865],"Tax/gov":[null,null,null,null,null,null,null,null,null,null,null,68]},"2021":{"Other (suppliers, fees, misc)":[497,2969,12,1365,560,135,126,10,10,169,11,93],"Tax/gov":[null,null,null,null,null,null,null,null,null,53,null,null],"Contractor chiros":[null,null,null,4375,null,null,null,1000,null,null,null,null],"Intercompany/Owner":[null,null,100,null,null,null,null,null,null,null,null,null],"Rent":[null,4235,null,null,null,null,null,null,null,null,null,null]},"2022":{"Other (suppliers, fees, misc)":[199,2699,3166,1091,1629,3320,3544,2110,1734,2442,9707,12274],"Tax/gov":[null,null,null,null,1323,1294,1294,5582,906,906,906,906],"Contractor chiros":[null,5000,241,null,3511,2990,null,null,null,null,5291,null],"Personnel":[null,null,null,null,1500,2688,500,2000,4422,4149,null,null],"Restaurants":[null,null,null,null,null,8,null,null,null,null,null,null],"Intercompany/Owner":[null,null,null,270,null,null,null,null,null,null,null,null]},"2023":{"Other (suppliers, fees, misc)":[11154,7384,6638,3772,8939,3223,5261,3272,2884,4937,498,3909],"Tax/gov":[906,922,922,922,1668,922,1990,922,922,922,1192,2259],"Contractor chiros":[6177,null,null,null,7926,2780,null,null,null,9356,null,3022],"Personnel":[null,null,null,3400,null,3432,null,550,null,null,3432,null],"Marketing":[null,null,null,null,null,null,302,null,null,null,null,null],"Software/SaaS":[null,null,null,null,null,null,25,null,null,null,null,null],"Restaurants":[41,null,null,null,null,null,null,null,null,null,null,null]},"2024":{"Other (suppliers, fees, misc)":[5825,3405,1669,5424,6244,4526,8726,6650,7402,6832,6465,5692],"Tax/gov":[2223,1527,1491,1491,1527,1543,8026,1527,1491,1532,1527,1491],"Restaurants":[null,null,null,39,null,null,102,28,46,null,null,null],"Marketing":[null,null,null,null,1226,1339,1500,1500,159,null,null,null],"Contractor chiros":[7948,null,null,2718,2603,null,null,null,null,null,null,null],"Personnel":[null,null,1950,null,null,null,null,null,null,null,null,null]},"2025":{"Other (suppliers, fees, misc)":[5901,4319,6354,3806,13806,14274,6072,3736,4687,3617,7336,7136],"Tax/gov":[2982,1470,1434,1434,3941,null,397,1514,1434,1434,1476,1472],"Contractor chiros":[1500,3040,5519,null,null,6815,2785,null,null,2600,4616,4305],"Travel/Parking":[null,null,null,null,null,null,null,null,35,null,null,null],"Intercompany/Owner":[1,null,null,null,null,null,26431,null,320,null,null,null],"Restaurants":[null,null,46,null,null,null,null,null,null,null,null,null],"Marketing":[807,1815,null,null,null,null,null,null,null,null,null,null]},"2026":{"Other (suppliers, fees, misc)":[2889,8415,6861,13340,6611,4981,null,null,null,null,null,null],"Tax/gov":[1434,5378,1592,3198,1475,1818,null,null,null,null,null,null],"Contractor chiros":[8971,190,6010,2811,19754,null,null,null,null,null,null,null],"Travel/Parking":[null,23,null,null,92,null,null,null,null,null,null,null],"Restaurants":[null,null,null,42,null,null,null,null,null,null,null,null]}},"All":{"2020":{"Other (suppliers, fees, misc)":[null,null,null,null,null,null,1435,51,10,408,942,1865],"Tax/gov":[null,null,null,null,null,null,null,null,null,null,null,68]},"2021":{"Other (suppliers, fees, misc)":[497,2969,13957,14929,5623,3327,3347,3447,3599,5054,4942,7257],"Rent":[null,4235,null,null,1982,1830,1830,1830,1830,1830,1830,1830],"Groceries":[null,null,null,39,147,92,112,96,93,96,167,210],"Restaurants":[null,null,null,36,36,38,69,37,81,32,94,182],"Marketing":[null,null,null,50,261,711,1279,760,779,1207,891,1445],"Alcohol":[null,null,null,null,null,null,null,null,36,68,27,48],"Tax/gov":[null,null,null,null,170,429,448,448,413,1787,1734,641],"Software/SaaS":[null,null,null,101,72,36,36,37,52,52,52,52],"Contractor chiros":[null,null,null,4375,null,1065,3079,4211,3411,3000,2000,4622],"Insurance":[null,null,null,null,null,null,96,74,74,null,148,74],"Intercompany/Owner":[null,null,100,null,null,null,null,null,null,null,null,null]},"2022":{"Contractor chiros":[151,5000,241,50,3561,3040,300,450,150,10586,5336,13671],"Other (suppliers, fees, misc)":[9088,40396,16191,20682,19129,21872,16381,31970,24066,16275,20897,25287],"Marketing":[1218,2244,1830,2323,2992,2293,2295,1621,1757,1540,2468,2406],"Groceries":[214,117,204,249,299,344,270,322,195,166,217,239],"Fuel":[null,null,null,null,null,null,null,null,null,null,null,82],"Intercompany/Owner":[null,8500,null,870,null,null,1500,null,45,3813,9871,12829],"Rent":[1830,1830,1830,1964,1964,1964,1964,1964,1964,1964,1964,1964],"Alcohol":[52,20,null,39,64,88,59,22,null,null,3,102],"Tax/gov":[1529,2079,1331,1337,1911,2127,1754,6599,1956,1873,2082,1690],"Software/SaaS":[52,52,52,52,145,173,91,91,91,105,108,108],"Restaurants":[125,130,158,239,112,170,117,175,205,186,94,68],"Insurance":[113,204,146,146,313,318,84,97,84,84,84,84],"Personnel":[null,1789,2872,3361,4246,3885,1967,2908,5265,6315,null,1000],"Travel/Parking":[null,null,176,2,142,285,364,298,277,310,136,353]},"2023":{"Contractor chiros":[15616,13203,4348,7656,19932,12111,14232,9230,3636,22861,13032,23624],"Other (suppliers, fees, misc)":[27623,19974,15150,19427,46860,42375,21499,19653,26312,25173,21743,28009],"Marketing":[3512,1851,1964,1545,2288,1193,3363,4292,4729,4907,4755,5219],"Tax/gov":[2215,4010,2929,3230,3912,2615,3965,1644,4230,3197,2639,4739],"Personnel":[3852,1972,3803,6846,3367,5721,5264,3606,709,2818,5387,6423],"Intercompany/Owner":[9775,7803,7315,8046,13202,4937,5214,4850,3949,4539,550,5400],"Groceries":[197,223,330,215,280,368,330,372,242,379,386,347],"Travel/Parking":[348,272,318,455,301,605,309,396,418,373,746,770],"Software/SaaS":[108,108,108,108,108,108,139,214,114,196,166,166],"Alcohol":[null,212,null,null,null,null,null,34,null,162,null,87],"Insurance":[85,290,284,430,204,153,254,240,515,248,211,211],"Restaurants":[111,186,108,255,308,179,65,251,46,177,68,null],"Rent":[1964,null,3927,null,null,null,null,2346,null,2346,2346,2346]},"2024":{"Contractor chiros":[12148,6380,16222,11418,4103,12900,8700,8355,9315,6750,11222,18265],"Other (suppliers, fees, misc)":[32025,24116,23047,34200,27495,33587,37100,40287,47020,38986,36906,35380],"Marketing":[5450,3349,5069,6499,6544,6645,5169,5147,5158,4288,4874,3488],"Intercompany/Owner":[6981,4350,5200,5300,4700,4850,12452,7000,8300,8655,7975,9160],"Groceries":[147,142,113,253,158,237,75,232,174,203,140,186],"Tax/gov":[4089,4359,3489,3652,3618,3918,15089,4709,4585,4519,4380,4524],"Travel/Parking":[487,617,523,629,668,536,396,579,563,556,584,545],"Software/SaaS":[254,219,219,219,327,395,348,389,367,370,370,424],"Insurance":[254,387,272,261,452,698,774,316,null,716,322,null],"Personnel":[3390,7515,8962,null,5001,2289,7468,null,null,3392,100,null],"Restaurants":[113,22,131,151,181,173,102,126,46,18,null,null],"Alcohol":[41,null,null,null,null,null,null,null,null,null,null,null],"Rent":[2346,2346,2346,2346,2346,2346,null,null,null,null,null,null]},"2025":{"Other (suppliers, fees, misc)":[44064,22610,41896,29897,33902,47675,44609,55687,35600,36013,42048,39911],"Alcohol":[null,null,null,null,null,78,null,null,null,null,238,135],"Contractor chiros":[9980,19902,17746,9890,12456,15019,16430,7082,13200,7500,14786,18601],"Marketing":[4269,5708,3517,6506,6355,2891,4638,3456,5984,7211,5863,3245],"Tax/gov":[6123,3575,5001,3960,8748,2820,2997,4088,6174,3667,7970,5522],"Travel/Parking":[428,438,537,794,664,716,708,1157,978,1090,1089,1167],"Software/SaaS":[365,365,365,365,387,388,452,427,478,595,434,430],"Groceries":[154,114,128,136,145,136,280,196,136,198,306,210],"Intercompany/Owner":[10051,5199,6270,5610,19000,3208,31982,10811,11896,8953,7555,4500],"Restaurants":[67,34,61,null,60,null,30,70,98,null,null,null],"Personnel":[100,10551,464,2516,8842,2533,null,2264,2870,null,null,null],"Insurance":[1169,null,null,142,312,338,1332,185,288,null,null,230],"Rent":[null,null,150,null,4293,716,1431,1431,1431,1431,1431,1430]},"2026":{"Alcohol":[null,null,null,110,null,68,null,null,null,null,null,null],"Groceries":[232,204,349,290,280,113,null,null,null,null,null,null],"Other (suppliers, fees, misc)":[40969,48313,52745,66301,49636,24353,null,null,null,null,null,null],"Travel/Parking":[934,1122,1219,1262,995,1078,null,null,null,null,null,null],"Software/SaaS":[411,491,428,419,334,276,null,null,null,null,null,null],"Marketing":[3393,6422,3510,4002,3860,1955,null,null,null,null,null,null],"Contractor chiros":[15256,5328,10956,10725,28092,4868,null,null,null,null,null,null],"Tax/gov":[6488,11898,7648,6016,11868,3346,null,null,null,null,null,null],"Intercompany/Owner":[7735,8000,6055,10050,13455,null,null,null,null,null,null,null],"Insurance":[177,null,241,265,413,702,null,null,null,null,null,null],"Rent":[1430,1430,3290,null,2862,34,null,null,null,null,null,null],"Restaurants":[13,null,5,46,null,null,null,null,null,null,null,null]}}};
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
  var h="<table><thead><tr><th style=\"text-align:left\">Category</th>";
  MN.forEach(function(m){h+="<th>"+m+"</th>";}); h+="<th>Total</th></tr></thead><tbody>";
  cats.forEach(function(c){
    var arr=yobj[c];
    h+="<tr style=\"cursor:pointer\" onclick='advise(\""+loc+"\",\""+year+"\",\""+c+"\")'><td style=\"text-align:left\">"+c+"</td>";
    arr.forEach(function(v){h+="<td class=\"num\">"+(v!=null?eur(v):"\u00b7")+"</td>";});
    h+="<td class=\"num\"><b>"+eur(sum(arr))+"</b></td></tr>";
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

// Safety net: a single bad request should never take the whole site down (502).
// Log it and keep serving every other page.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", (e && e.message) || e));
process.on("uncaughtException",  (e) => console.error("uncaughtException:",  (e && e.message) || e));

app.listen(process.env.PORT || 3000, () => console.log("coaching-engine up — /plan (chiros) & /ca (CAs)"));
