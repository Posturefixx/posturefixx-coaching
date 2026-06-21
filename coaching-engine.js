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

// Generic GET against one clinic's PracticeHub. Returns the parsed JSON.
async function phub(clinicName, path, params = {}) {
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

// Pull ALL pages of a list endpoint (PracticeHub caps pages ~100 rows).
async function phubAll(clinic, path, params = {}) {
  let page = 1, all = [], guard = 0;
  while (guard++ < 60) {
    const r = await phub(clinic, path, { ...params, page });
    const rows = r.data || r || [];
    all = all.concat(rows);
    if (rows.length < 100) break; // last page
    page++;
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

// ── THE KPI LAYER — turn raw appointments into per-chiro numbers ─────────────
// Rules learned from the live data:
//  • status "processed" = a real visit; "cancelled" (or a cancelDate) = not.
//  • de-duplicate by appointment id (same slot can appear twice, e.g. a cancel).
async function computeKpis(clinic, days = 30) {
  const [names, appts, types] = await Promise.all([
    practitionerMap(clinic),
    phubAll(clinic, "/appointments", { start: lastDaysRange(days) }),
    phubAll(clinic, "/appointment_types", {}).catch(() => []),
  ]);

  // identify which appointment types are "intakes" (new-patient visits) by name
  const intakeTypeIds = new Set(
    types.filter(t => /intake|nieuw|new|eerste|first/i.test(t.name || "")).map(t => t.id)
  );

  // de-dupe by id, keep the non-cancelled version if both exist
  const byId = new Map();
  for (const a of appts) {
    const prev = byId.get(a.id);
    const cancelled = a.status === "cancelled" || a.cancelDate;
    if (!prev || (prev.cancelled && !cancelled)) byId.set(a.id, { ...a, cancelled });
  }

  const statusTally = {};
  const per = {}; // practitioner_id → kpi accumulator
  for (const a of byId.values()) {
    statusTally[a.status || "?"] = (statusTally[a.status || "?"] || 0) + 1;
    if (a.cancelled || a.status !== "processed") continue; // only real visits count
    const pid = a.practitioner_id;
    (per[pid] ||= { name: names[pid] || `#${pid}`, visits: 0, patients: new Set(), intakes: 0 });
    per[pid].visits++;
    per[pid].patients.add(a.patient_id);
    if (intakeTypeIds.has(a.appointment_type_id)) per[pid].intakes++;
  }

  const rows = Object.entries(per).map(([pid, k]) => ({
    practitionerId: pid,
    name: k.name,
    visits: k.visits,
    uniquePatients: k.patients.size,
    pva: k.patients.size ? +(k.visits / k.patients.size).toFixed(2) : 0,
    intakes: k.intakes,
  })).sort((a, b) => b.visits - a.visits);

  return { clinic, days, rows, statusTally, intakeTypesFound: [...intakeTypeIds].length,
           appointmentTypes: types.map(t => ({ id: t.id, name: t.name })) };
}

// ── Simple password gate (these pages show patient data) ─────────────────────
// Set DASHBOARD_PASSWORD in Render to lock the pages. Any username works.
function gate(req, res, next) {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return next(); // not set yet → open, but you'll see a reminder on the page
  const hdr = req.headers.authorization || "";
  const got = Buffer.from(hdr.split(" ")[1] || "", "base64").toString().split(":")[1];
  if (got === pw) return next();
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

// ── SEND — via your GHL Rotterdam sub-account (only after you approve) ────────
async function sendViaGHL(toNumber, text) {
  const res = await fetch("https://services.leadconnectorhq.com/conversations/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GHL_API_KEY_ROTTERDAM}`,
      "Version": "2021-07-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "WhatsApp", // or "SMS"
      locationId: process.env.GHL_LOCATION_ID_ROTTERDAM,
      contactId: toNumber, // GHL needs a contactId — map chiro → contact once
      message: text,
    }),
  });
  if (!res.ok) throw new Error(`GHL send failed: ${res.status} ${await res.text()}`);
  return res.json();
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
app.post("/draft", async (req, res) => {
  const out = [];
  for (const k of req.body.chiros || []) out.push(await draftMessage(k));
  res.json(out);
});

// Later: POST approved messages here to actually send:
app.post("/send", async (req, res) => {
  try {
    const r = await sendViaGHL(req.body.contactId, req.body.message);
    res.json({ sent: true, r });
  } catch (e) { res.status(500).json({ sent: false, error: e.message }); }
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
      `<tr><td>${r.name}</td><td style="text-align:right">${r.visits}</td><td style="text-align:right">${r.uniquePatients}</td>
       <td style="text-align:right"><b>${r.pva}</b></td><td style="text-align:right">${r.intakes}</td></tr>`).join("");
    const status = Object.entries(k.statusTally).map(([s, n]) => `${s}: ${n}`).join(" · ");
    const intakeNote = k.intakeTypesFound
      ? `Intakes counted from ${k.intakeTypesFound} appointment type(s) detected by name.`
      : `⚠️ No "intake" appointment type auto-detected — tell me which type name = a new-patient intake and I'll wire it.`;
    const typeList = k.appointmentTypes.map(t => `#${t.id} ${t.name}`).join("<br>");
    res.send(`<body style="max-width:760px;margin:40px auto;font-family:sans-serif">${lockNote()}
      <h2>${clinic} — last ${days} days</h2>
      <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
        <tr style="background:#f4f4f4"><th align="left">Chiropractor</th><th>Visits</th><th>Patients</th><th>PVA</th><th>Intakes</th></tr>
        ${rows || `<tr><td colspan="5">no processed visits in range</td></tr>`}
      </table>
      <p style="color:#555;margin-top:10px"><b>PVA</b> = visits ÷ unique patients. Only <b>processed</b> visits counted; cancelled and duplicates removed.</p>
      <p style="color:#888">Status mix in range: ${status}</p>
      <p style="color:#888">${intakeNote}</p>
      <details style="margin-top:10px;color:#888"><summary>Appointment types at this clinic</summary><p>${typeList}</p></details>
      <p style="color:#888;margin-top:16px">Switch: <a href="?clinic=Amstelveen&days=${days}">Amstelveen</a> · <a href="?clinic=Utrecht&days=${days}">Utrecht</a> · <a href="?clinic=Rotterdam&days=${days}">Rotterdam</a> · <a href="?clinic=Bussum&days=${days}">Bussum</a>
      &nbsp;|&nbsp; range: <a href="?clinic=${clinic}&days=7">7d</a> · <a href="?clinic=${clinic}&days=30">30d</a> · <a href="?clinic=${clinic}&days=90">90d</a></p>
    </body>`);
  } catch (e) {
    res.status(500).send(`<body style="max-width:760px;margin:40px auto;font-family:sans-serif"><h2>Couldn't build KPIs for ${clinic}</h2><pre style="background:#f4f4f4;padding:16px;border-radius:8px;white-space:pre-wrap">${e.message}</pre></body>`);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("coaching-engine up — open /preview"));
