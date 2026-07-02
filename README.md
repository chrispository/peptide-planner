# Peptide Dose Planner

Local peptide reconstitution and scheduling planner. Choose a peptide, enter vial
amounts and dose phases, then calculate BAC water volume, syringe units, vial
duration, and a combined injection schedule.

This is a planning utility, not medical advice. Verify dosing, concentration,
route, storage, and beyond-use dates with a qualified clinician or pharmacist.

## Run

Requires Node.js 22.5+.

```sh
npm start
```

Open `http://127.0.0.1:4173/`. Optional local overrides can go in `.env`:

```sh
PORT=4173
SHOTS_DATA_DIR=./data
```

## Data

The app autosaves one current planner snapshot to SQLite:

```txt
data/shots.sqlite
```

Use the gear menu to import/export JSON backups. The schedule page can export an
`.ics` calendar file, and the reconstitution page can print a vial card.

## Database Schema

Fresh databases use one app-owned table plus SQLite `user_version = 1`.

```sql
CREATE TABLE planner_snapshots (
  key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  peptide_name TEXT,
  vial_mg REAL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
```

Only the `current` key is used today. `payload_json` contains the full serialized
planner state; `peptide_name` and `vial_mg` are lightweight indexed-ready summary
fields for future list/history views. Obsolete settings tables from older local
builds are dropped on startup.

## Scripts

```sh
npm start      # run the local server
npm test       # run calc and state tests
npm run check  # syntax-check server.js
```

## Structure

```txt
server.js                 Static server and SQLite persistence API
index.html / styles.css   App shell and UI styling
src/calc.js               Pure dose, water, and schedule engine
src/peptides.js           Built-in peptide reference data
src/state.js              App state, defaults, migrations
src/render.js             DOM rendering
src/main.js               Event wiring and app lifecycle
src/persistence.js        Autosave/load client
src/exporters.js          JSON and calendar exports
test/                     node:test suites
```
