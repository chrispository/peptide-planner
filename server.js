import { createServer } from "node:http";
import { readFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
// Load a local .env (gitignored) if present. No-op when the file is missing.
try {
  process.loadEnvFile(path.join(rootDir, ".env"));
} catch {
  // .env is optional.
}

// PEPTIDE_PLANNER_DATA_DIR lets testing/dev point at a throwaway location so the
// real saved planner in ./data is never touched. SHOTS_DATA_DIR is kept as a
// legacy fallback for existing installs.
const dataDir = process.env.PEPTIDE_PLANNER_DATA_DIR
  ? path.resolve(process.env.PEPTIDE_PLANNER_DATA_DIR)
  : process.env.SHOTS_DATA_DIR
    ? path.resolve(process.env.SHOTS_DATA_DIR)
    : path.join(rootDir, "data");
const dbPath = path.join(dataDir, "peptide-planner.sqlite");
const legacyDbPath = path.join(dataDir, "shots.sqlite");
const port = Number(process.env.PORT || 4173);
// HOST controls which interface the server binds to. Defaults to loopback for
// local use; set HOST=0.0.0.0 to expose it (e.g. inside a container on a homelab).
const host = process.env.HOST || "127.0.0.1";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(dbPath) && existsSync(legacyDbPath)) {
    await rename(legacyDbPath, dbPath);
  }
}

function openDatabase() {
  const db = new DatabaseSync(dbPath, {
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });

  db.exec("DROP TABLE IF EXISTS settings;");

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

  db.exec("PRAGMA user_version = 1;");

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

  // v2+ stores an array of plans; v1 stored a single plan under `fields`.
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

// ---- Planner state --------------------------------------------------------

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

  server.listen(port, host, () => {
    console.log(`Peptide planner running at http://${host}:${port}/`);
    console.log(`SQLite database: ${dbPath}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
