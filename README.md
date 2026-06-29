# Peptide Dose Planner

A local, single-user tool for planning peptide reconstitution and injection
schedules. Pick a peptide, enter the vial amount and dose phases, and it works
out how much bacteriostatic water to add, the syringe units per shot, how long a
vial lasts, and a dated injection schedule across one or more peptides.

> **Planning tool only.** Suggested doses are generic starting points, not
> medical advice. Verify dose, concentration, route, storage, and beyond-use
> dates with a qualified clinician or pharmacist.

## Requirements

- Node.js **22.5+** (uses the built-in `node:sqlite` and `node:test` — no npm
  dependencies, no build step).

## Run

```sh
npm start
```

Then open <http://127.0.0.1:4173/>. The port can be overridden with `PORT`.

## Data

Your plan is autosaved to a single SQLite database at `data/shots.sqlite`. This
is the only place your data lives — it is gitignored and never overwritten by the
dev/test tooling (which uses `SHOTS_DATA_DIR`).

- **Back it up** from the app: **Export** (top bar) downloads a JSON snapshot;
  **Import** restores one. Or just copy the file:

  ```sh
  cp data/shots.sqlite ~/peptide-backup-$(date +%F).sqlite
  ```

- The schedule tab can **Export to calendar** (`.ics`) and the reconstitution tab
  can **Print card** for a single-vial reference.

## AI peptide lookup (optional)

For peptides not in the built-in library, the app can fetch typical dosing from
DeepSeek. Copy `.env.example` to `.env` and set `DEEPSEEK_API_KEY`. Without a key,
everything else works; only the "Look up dosing with AI" button is disabled.

## Scripts

```sh
npm start   # run the server
npm test    # run the unit tests (calc engine + state migrations)
npm run check  # syntax-check the server
```

## Project layout

```
server.js                 Static file + JSON API server, SQLite persistence
index.html / styles.css   App shell and styling
src/
  calc.js        Pure dose/water/schedule engine (no DOM)
  format.js      Number and date helpers
  peptides.js    Built-in peptide library + lookup
  state.js       Data model, defaults, save/load + version migration
  persistence.js Debounced autosave against the API
  render.js      All DOM rendering
  exporters.js   JSON backup + .ics calendar generation
  main.js        Entry point: owns state, wires events
test/            node:test suites for calc and state
```

The frontend is plain ES modules loaded directly by the browser (`<script
type="module">`) — there is nothing to compile.
