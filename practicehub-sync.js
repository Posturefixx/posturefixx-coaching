// practicehub-sync.js — Render service: PracticeHub → stats → Google Sheet / JSON
// Drop into the same repo as your morning-briefing agent. Reuses the same Render
// env-var + Google auth patterns you already run.
//
// ── WHAT YOU MUST FILL IN ────────────────────────────────────────────────────
// I don't have PracticeHub's exact API spec, so the three TODO blocks below
// (base URL, auth header, endpoint paths + response field names) are placeholders.
// Paste me a sample PracticeHub response or the API docs and I'll finalise them.
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
import cron from "node-cron";
import { google } from "googleapis";

// ── Per-location config (matches your GHL_*_[LOCATION] convention) ────────────
const LOCATIONS = {
  Amstelveen: { phubKey: process.env.PRACTICEHUB_API_KEY_AMSTELVEEN, phubLoc: process.env.PRACTICEHUB_LOC_AMSTELVEEN },
  Rotterdam:  { phubKey: process.env.PRACTICEHUB_API_KEY_ROTTERDAM,  phubLoc: process.env.PRACTICEHUB_LOC_ROTTERDAM },
  Utrecht:    { phubKey: process.env.PRACTICEHUB_API_KEY_UTRECHT,    phubLoc: process.env.PRACTICEHUB_LOC_UTRECHT },
  Bussum:     { phubKey: process.env.PRACTICEHUB_API_KEY_BUSSUM,     phubLoc: process.env.PRACTICEHUB_LOC_BUSSUM },
};

// TODO 1 — base URL. Your notes say PracticeHub uses a "neptune" region host.
const PHUB_BASE = process.env.PRACTICEHUB_BASE || "https://neptune.practicehub.example/api/v1";

// ── PracticeHub fetch ────────────────────────────────────────────────────────
async function phub(path, { phubKey, phubLoc }) {
  const res = await fetch(`${PHUB_BASE}${path}`, {
    headers: {
      // TODO 2 — real auth scheme (bearer? x-api-key? basic?). Adjust this line.
      "Authorization": `Bearer ${phubKey}`,
      "X-Location-Id": phubLoc,
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`PracticeHub ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

// Pull the raw data needed for one location + month, then derive the 4 metrics.
async function fetchLocationMonth(loc, cfg, year, month) {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const to   = new Date(year, month, 0).toISOString().slice(0, 10); // last day of month

  // TODO 3 — replace these endpoint paths + the field names below with the real ones.
  const appts  = await phub(`/appointments?location=${cfg.phubLoc}&from=${from}&to=${to}`, cfg);
  const invs   = await phub(`/invoices?location=${cfg.phubLoc}&from=${from}&to=${to}`, cfg);
  const intakes= await phub(`/patients/new?location=${cfg.phubLoc}&from=${from}&to=${to}`, cfg);

  const visits   = appts.filter(a => a.status === "attended").length;            // ← field name?
  const turnover = invs.reduce((s, i) => s + Number(i.total || 0), 0);           // ← field name?
  const newCount = intakes.length;                                              // ← shape?
  const uniquePatients = new Set(appts.map(a => a.patientId)).size || 1;         // ← field name?
  const pva = +(visits / uniquePatients).toFixed(2);                            // visits per active patient

  return { location: loc, year, month, turnover, visits, pva, intakes: newCount };
}

async function fetchAll(year, month) {
  const out = [];
  for (const [loc, cfg] of Object.entries(LOCATIONS)) {
    if (!cfg.phubKey) { console.warn(`skip ${loc}: no key`); continue; }
    try { out.push(await fetchLocationMonth(loc, cfg, year, month)); }
    catch (e) { console.error(`${loc} failed:`, e.message); }
  }
  return out;
}

// ── OUTPUT A — write into your existing clinic-stats Google Sheet ─────────────
// Reuse the same service-account auth you use in the briefing agent.
async function writeToSheet(rows) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(Buffer.from(process.env.GOOGLE_SA_B64, "base64").toString()),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const SHEET_ID = "1niue34uiUIs14SfOK3KWbtAc1-QTO4CZM48fpTlKRdc"; // 2026 clinic stats
  const MONTH_ROW = { 1:2,2:3,3:4,4:5,5:6,6:7,7:8,8:9,9:10,10:11,11:12,12:13 };

  for (const r of rows) {
    const row = MONTH_ROW[r.month];
    // Map columns to each location's tab. Adjust ranges to your sheet's layout.
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${r.location} 2026!K${row}:N${row}`, // e.g. visits | PVA | turnover | intakes
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[r.visits, r.pva, r.turnover, r.intakes]] },
    });
  }
  console.log(`sheet updated: ${rows.length} locations`);
}

// ── OUTPUT B — serve JSON for a hosted dashboard to fetch ─────────────────────
let cache = { updated: null, rows: [] };
const app = express();
app.get("/api/stats", (req, res) => {
  if (req.get("x-api-key") !== process.env.DASHBOARD_KEY) return res.status(401).end();
  res.set("Access-Control-Allow-Origin", process.env.DASHBOARD_ORIGIN || "*");
  res.json(cache);
});

// ── Orchestration ────────────────────────────────────────────────────────────
async function sync() {
  const now = new Date();
  const rows = await fetchAll(now.getFullYear(), now.getMonth() + 1); // current month MTD
  cache = { updated: now.toISOString(), rows };
  await writeToSheet(rows);   // comment out if you only want Option B
}

cron.schedule("0 5 * * *", () => sync().catch(console.error)); // nightly 05:00
app.get("/sync-now", async (_, res) => { await sync(); res.json(cache); }); // manual trigger
app.listen(process.env.PORT || 3000, () => console.log("practicehub-sync up"));
