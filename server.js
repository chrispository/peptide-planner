const { createServer } = require("node:http");
const { readFile, mkdir } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const rootDir = __dirname;
// SHOTS_DATA_DIR lets testing/dev point at a throwaway location so the real
// saved planner in ./data is never touched. Defaults to ./data.
const dataDir = process.env.SHOTS_DATA_DIR
  ? path.resolve(process.env.SHOTS_DATA_DIR)
  : path.join(rootDir, "data");
const dbPath = path.join(dataDir, "shots.sqlite");
const port = Number(process.env.PORT || 4173);

// Load a local .env (gitignored) if present so DEEPSEEK_API_KEY etc. are picked
// up without exporting them by hand. No-op when the file is missing.
try {
  process.loadEnvFile(path.join(rootDir, ".env"));
} catch {
  // .env is optional.
}

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_URL = process.env.DEEPSEEK_URL || "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

function openDatabase() {
  const db = new DatabaseSync(dbPath, {
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });

  db.exec(`
    CREATE TABLE IF NOT EXISTS planner_snapshots (
      key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      peptide_name TEXT,
      vial_mg REAL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
  `);

  return db;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

async function readRequestJson(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sanitizePlannerPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Planner payload must be an object.");
  }

  // v2 stores an array of plans; v1 stored a single plan under `fields`.
  const firstPlan = Array.isArray(payload.plans) ? payload.plans[0] : null;
  const source = firstPlan || payload.fields || {};

  const peptideName = String(source.peptideName || "").slice(0, 120);
  const vialMg = Number.parseFloat(source.vialMg);

  return {
    payload,
    peptideName,
    vialMg: Number.isFinite(vialMg) ? vialMg : null,
  };
}

const PEPTIDE_SYSTEM_PROMPT = `You are a reference for peptide reconstitution planning. Given a peptide name, return ONLY a JSON object with commonly-cited dosing used for planning. Use exactly this shape:
{
  "known": boolean,
  "commonVialsMg": number[],
  "doseStepsMg": number[],
  "defaultDoseMg": number,
  "schedule": { "mode": "weekly" | "interval", "shotsPerWeek": number, "everyDays": number },
  "titrating": boolean,
  "note": string
}
All amounts are in milligrams (mg); convert mcg to mg. doseStepsMg should be ascending typical per-dose amounts. Set schedule.mode to "weekly" with shotsPerWeek, or "interval" with everyDays. titrating is true when the dose is normally ramped up over time (e.g. GLP-1 agonists). note is one or two plain-text sentences. If you do not recognize the peptide or lack reliable dosing info, return {"known": false}. Output JSON only, no prose.`;

async function fetchPeptideInfo(name) {
  const response = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: PEPTIDE_SYSTEM_PROMPT },
        { role: "user", content: `Peptide: ${name}` },
      ],
      response_format: { type: "json_object" },
      stream: false,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`DeepSeek request failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

function toPositiveNumberArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(Number)
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .slice(0, 12);
}

function sanitizePeptideInfo(raw) {
  if (!raw || raw.known === false || typeof raw !== "object") {
    return null;
  }

  const doseStepsMg = toPositiveNumberArray(raw.doseStepsMg).sort((a, b) => a - b);
  const defaultDoseMg = Number(raw.defaultDoseMg);
  const hasDose = doseStepsMg.length > 0 || Number.isFinite(defaultDoseMg);
  if (!hasDose) {
    return null;
  }

  const mode = raw.schedule?.mode === "interval" ? "interval" : "weekly";
  const schedule = { mode };
  if (mode === "weekly") {
    schedule.shotsPerWeek = Number(raw.schedule?.shotsPerWeek) > 0 ? Number(raw.schedule.shotsPerWeek) : 1;
  } else {
    schedule.everyDays = Number(raw.schedule?.everyDays) > 0 ? Number(raw.schedule.everyDays) : 1;
  }

  const steps = doseStepsMg.length ? doseStepsMg : [defaultDoseMg];

  return {
    commonVialsMg: toPositiveNumberArray(raw.commonVialsMg),
    doseStepsMg: steps,
    defaultDoseMg: Number.isFinite(defaultDoseMg) ? defaultDoseMg : steps[0],
    schedule,
    titrating: Boolean(raw.titrating),
    note: String(raw.note || "").slice(0, 400),
  };
}

async function handlePeptideInfo(req, res, url) {
  if (req.method !== "GET") {
    sendError(res, 405, "Method not allowed.");
    return;
  }

  if (!DEEPSEEK_API_KEY) {
    sendError(res, 503, "AI lookup is not configured. Set DEEPSEEK_API_KEY in your environment or .env file.");
    return;
  }

  const name = (url.searchParams.get("name") || "").trim().slice(0, 80);
  if (!name) {
    sendError(res, 400, "Provide a peptide name.");
    return;
  }

  try {
    const info = sanitizePeptideInfo(await fetchPeptideInfo(name));
    if (!info) {
      sendJson(res, 200, { known: false, name });
      return;
    }
    sendJson(res, 200, { known: true, name, info });
  } catch (error) {
    sendError(res, 502, error.message || "AI lookup failed.");
  }
}

function getCurrentPlanner(db) {
  return db
    .prepare(
      `SELECT key, payload_json, peptide_name, vial_mg, updated_at, created_at
       FROM planner_snapshots
       WHERE key = ?`,
    )
    .get("current");
}

async function handleApi(req, res, db, url) {
  const pathname = url.pathname;

  if (pathname === "/api/peptide-info") {
    await handlePeptideInfo(req, res, url);
    return;
  }

  if (pathname !== "/api/planner/current") {
    sendError(res, 404, "API route not found.");
    return;
  }

  if (req.method === "GET") {
    const row = getCurrentPlanner(db);

    if (!row) {
      sendError(res, 404, "No saved planner yet.");
      return;
    }

    sendJson(res, 200, {
      key: row.key,
      payload: JSON.parse(row.payload_json),
      peptideName: row.peptide_name,
      vialMg: row.vial_mg,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
    });
    return;
  }

  if (req.method === "PUT") {
    const body = await readRequestJson(req);
    const { payload, peptideName, vialMg } = sanitizePlannerPayload(body);

    db.prepare(
      `INSERT INTO planner_snapshots (key, payload_json, peptide_name, vial_mg, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         payload_json = excluded.payload_json,
         peptide_name = excluded.peptide_name,
         vial_mg = excluded.vial_mg,
         updated_at = CURRENT_TIMESTAMP`,
    ).run("current", JSON.stringify(payload), peptideName, vialMg);

    const row = getCurrentPlanner(db);
    sendJson(res, 200, {
      ok: true,
      updatedAt: row.updated_at,
    });
    return;
  }

  sendError(res, 405, "Method not allowed.");
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(rootDir, requested));

  if (!filePath.startsWith(rootDir) || filePath.includes(`${path.sep}data${path.sep}`)) {
    sendError(res, 403, "Forbidden.");
    return;
  }

  if (!existsSync(filePath)) {
    sendError(res, 404, "File not found.");
    return;
  }

  const body = await readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream",
  });
  res.end(body);
}

async function main() {
  await ensureDataDir();
  const db = openDatabase();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, db, url);
        return;
      }

      await serveStatic(req, res, url.pathname);
    } catch (error) {
      sendError(res, 500, error.message || "Unexpected server error.");
    }
  });

  server.listen(port, () => {
    console.log(`Peptide planner running at http://127.0.0.1:${port}/`);
    console.log(`SQLite database: ${dbPath}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
