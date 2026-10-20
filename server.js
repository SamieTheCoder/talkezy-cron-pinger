/**
 * Self-hosted cron pinger.
 *
 * Fires a POST to TARGET_URL on a schedule (default every minute) with the
 * x-cron-secret header, records every run (status, duration, parsed response),
 * and serves a small web GUI with analytics + a "Run now" button.
 *
 * Secrets: CRON_SECRET and GUI_TOKEN are read from env and NEVER rendered in
 * the GUI or the JSON API. Run history is persisted to a JSON file so it
 * survives restarts (bounded ring buffer).
 *
 * Env:
 *   TARGET_URL   required  e.g. https://talkezy.in/api/automations/cron
 *   CRON_SECRET  required  value sent as the x-cron-secret header
 *   SCHEDULE     optional  cron expression, default "* * * * *" (every minute)
 *   PORT         optional  default 3000
 *   GUI_TOKEN    optional  if set, the dashboard + API require ?token= or
 *                          an Authorization: Bearer <token> header
 *   HISTORY_MAX  optional  runs kept in history, default 500
 *   TIMEOUT_MS   optional  per-request timeout, default 55000
 *   DATA_DIR     optional  where to persist history, default /data then cwd
 */
import express from "express";
import cron from "node-cron";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";

const TARGET_URL = process.env.TARGET_URL ?? "";
const CRON_SECRET = process.env.CRON_SECRET ?? "";
const SCHEDULE = process.env.SCHEDULE ?? "* * * * *";
const PORT = Number(process.env.PORT ?? 3000);
const GUI_TOKEN = process.env.GUI_TOKEN ?? "";
const HISTORY_MAX = Number(process.env.HISTORY_MAX ?? 500);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 55000);

// Persist history where it survives restarts. Prefer a mounted /data volume.
function pickDataDir() {
  const candidates = [process.env.DATA_DIR, "/data", process.cwd()].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      /* try next */
    }
  }
  return process.cwd();
}
const DATA_FILE = path.join(pickDataDir(), "cron-history.json");

if (!TARGET_URL) console.warn("[cron-pinger] TARGET_URL is not set — runs will fail until configured.");
if (!CRON_SECRET) console.warn("[cron-pinger] CRON_SECRET is not set — the target may reject calls.");

/** @type {{ at: string; ok: boolean; status: number|null; durationMs: number; trigger: string; processed: object|null; error: string|null }[]} */
let history = [];
try {
  if (fs.existsSync(DATA_FILE)) history = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) ?? [];
} catch {
  history = [];
}
let running = false;
let lastStartedAt = null;

function persist() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(history.slice(-HISTORY_MAX)));
  } catch (e) {
    console.warn("[cron-pinger] could not persist history:", e?.message ?? e);
  }
}

/** Fire one POST to the target and record the result. */
async function runOnce(trigger) {
  if (running) return { skipped: true, reason: "a run is already in progress" };
  running = true;
  lastStartedAt = new Date().toISOString();
  const started = Date.now();
  const entry = { at: lastStartedAt, ok: false, status: null, durationMs: 0, trigger, processed: null, error: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(TARGET_URL, {
      method: "POST",
      headers: { "x-cron-secret": CRON_SECRET, "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    entry.status = res.status;
    entry.ok = res.ok;
    const text = await res.text().catch(() => "");
    try {
      const json = JSON.parse(text);
      // Keep the useful summary only (processed counts), never echo secrets.
      entry.processed = json?.processed ?? json?.ok ?? null;
      if (!res.ok) entry.error = (json?.error ?? json?.message ?? text ?? "").toString().slice(0, 300);
    } catch {
      if (!res.ok) entry.error = text.slice(0, 300);
    }
  } catch (e) {
    entry.error = (e?.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : e?.message ?? String(e)).slice(0, 300);
  } finally {
    clearTimeout(timer);
    entry.durationMs = Date.now() - started;
    history.push(entry);
    if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
    persist();
    running = false;
  }
  return entry;
}

// ---- Scheduler ----
if (cron.validate(SCHEDULE)) {
  cron.schedule(SCHEDULE, () => {
    runOnce("schedule").catch((e) => console.warn("[cron-pinger] run error:", e?.message ?? e));
  });
  console.log(`[cron-pinger] scheduled "${SCHEDULE}" → POST ${TARGET_URL || "(unset)"}`);
} else {
  console.error(`[cron-pinger] invalid SCHEDULE "${SCHEDULE}" — scheduler NOT started.`);
}

// ---- Stats ----
function stats() {
  const total = history.length;
  const ok = history.filter((h) => h.ok).length;
  const last24 = history.filter((h) => Date.now() - new Date(h.at).getTime() < 24 * 3600 * 1000);
  const avgMs = total ? Math.round(history.reduce((n, h) => n + h.durationMs, 0) / total) : 0;
  const last = history[history.length - 1] ?? null;
  return {
    total,
    ok,
    failed: total - ok,
    successRate: total ? Math.round((ok / total) * 100) : null,
    runs24h: last24.length,
    ok24h: last24.filter((h) => h.ok).length,
    avgMs,
    last,
    running,
    lastStartedAt,
    schedule: SCHEDULE,
    target: TARGET_URL,
  };
}

// ---- Web GUI + API ----
const app = express();
app.disable("x-powered-by");

// Optional auth gate for the dashboard + API (not /healthz).
function authed(req) {
  if (!GUI_TOKEN) return true;
  const header = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const got = (req.query.token ?? header ?? "").toString();
  const a = Buffer.from(got);
  const b = Buffer.from(GUI_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get("/healthz", (_req, res) => res.json({ ok: true, schedule: SCHEDULE, hasTarget: Boolean(TARGET_URL) }));

app.get("/api/stats", (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  res.json({ stats: stats(), history: history.slice(-100).reverse() });
});

app.post("/api/run", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const r = await runOnce("manual");
  res.json(r);
});

app.get("/", (req, res) => {
  if (!authed(req)) {
    res.status(401).type("html").send(`<!doctype html><meta charset=utf8><body style="font:16px system-ui;background:#0b0d10;color:#e6e8eb;padding:40px">
      <h2>Cron pinger</h2><p>Add <code>?token=YOUR_GUI_TOKEN</code> to the URL to view the dashboard.</p></body>`);
    return;
  }
  res.type("html").send(PAGE(GUI_TOKEN ? (req.query.token ?? "") : ""));
});

app.listen(PORT, () => console.log(`[cron-pinger] GUI on :${PORT}`));

// ---- GUI (single file, no build step) ----
function PAGE(token) {
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Cron pinger</title>
<style>
  :root{--bg:#0b0d10;--card:#14171c;--line:#232830;--text:#e6e8eb;--muted:#8b93a1;--ok:#30a46c;--bad:#e5484d;--accent:#208aef}
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
  .wrap{max-width:960px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:var(--muted);font-size:13px;word-break:break-all;margin-bottom:20px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
  .k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.4px}
  .v{font-size:24px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums}
  .row{display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap}
  button{background:var(--accent);color:#fff;border:0;border-radius:10px;padding:10px 16px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);font-size:13px;white-space:nowrap}
  th{color:var(--muted);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.4px}
  tr:last-child td{border-bottom:0}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700}
  .pill.ok{background:rgba(48,164,108,.18);color:var(--ok)} .pill.bad{background:rgba(229,72,77,.18);color:var(--bad)}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
  .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted)}
</style></head>
<body><div class="wrap">
  <h1>Cron pinger</h1>
  <div class="sub" id="target">—</div>
  <div class="grid" id="stats"></div>
  <div class="row">
    <button id="run">Run now</button>
    <span class="mono" id="state"></span>
  </div>
  <table><thead><tr><th>Time</th><th>Status</th><th>Trigger</th><th>Duration</th><th>Processed / Error</th></tr></thead>
  <tbody id="rows"><tr><td colspan="5" class="mono">loading…</td></tr></tbody></table>
</div>
<script>
const Q=${JSON.stringify(q)};
const fmt=t=>new Date(t).toLocaleString();
async function load(){
  const r=await fetch('/api/stats'+Q); if(!r.ok){document.getElementById('rows').innerHTML='<tr><td colspan=5>unauthorized</td></tr>';return;}
  const {stats:s,history:h}=await r.json();
  document.getElementById('target').textContent='POST '+s.target+'  ·  schedule "'+s.schedule+'"';
  const cards=[
    ['Success rate', s.successRate==null?'—':s.successRate+'%'],
    ['Runs (24h)', s.runs24h+' · '+s.ok24h+' ok'],
    ['Total runs', s.total],
    ['Failed', s.failed],
    ['Avg duration', s.avgMs+' ms'],
    ['Last run', s.last?fmt(s.last.at):'—'],
  ];
  document.getElementById('stats').innerHTML=cards.map(c=>'<div class="card"><div class="k">'+c[0]+'</div><div class="v">'+c[1]+'</div></div>').join('');
  document.getElementById('state').textContent=s.running?'a run is in progress…':'idle';
  document.getElementById('rows').innerHTML = h.length? h.map(e=>{
    const pill=e.ok?'<span class="pill ok">'+(e.status??'OK')+'</span>':'<span class="pill bad">'+(e.status??'ERR')+'</span>';
    const info=e.error?('<span style="color:var(--bad)">'+esc(e.error)+'</span>'):('<span class="mono">'+esc(JSON.stringify(e.processed))+'</span>');
    return '<tr><td>'+fmt(e.at)+'</td><td>'+pill+'</td><td class="mono">'+e.trigger+'</td><td>'+e.durationMs+' ms</td><td>'+info+'</td></tr>';
  }).join(''):'<tr><td colspan=5 class="mono">no runs yet</td></tr>';
}
function esc(s){return (s??'').toString().replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
document.getElementById('run').onclick=async()=>{
  const b=document.getElementById('run');b.disabled=true;b.textContent='Running…';
  try{await fetch('/api/run'+Q,{method:'POST'});}catch{} finally{b.disabled=false;b.textContent='Run now';load();}
};
load(); setInterval(load,5000);
</script></body></html>`;
}
