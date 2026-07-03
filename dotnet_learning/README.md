# Peptide Dose Planner

Local peptide reconstitution and scheduling planner, rewritten as a .NET 9 / C#
solution. Choose a peptide, enter vial amounts and dose phases, then calculate
BAC water volume, syringe units, vial duration, and a combined injection
schedule.

This is a planning utility, not medical advice. Verify dosing, concentration,
route, storage, and beyond-use dates with a qualified clinician or pharmacist.

## Run

Requires the .NET 9 SDK.

```sh
cd dotnet_learning
dotnet run --project src/Shots.Web
```

Open `http://127.0.0.1:4173/`.

On Linux distributions that package the SDK and ASP.NET Core runtime separately,
install the ASP.NET Core runtime package too. You can also run self-contained:

```sh
cd dotnet_learning
dotnet run --project src/Shots.Web -r linux-x64 --self-contained
```

Optional local overrides can go in `.env` or your shell:

```sh
ASPNETCORE_URLS=http://127.0.0.1:4173
SHOTS_DATA_DIR=./data
```

## REST API

Alongside the Blazor UI, the app exposes a small JSON API over the same
single-user `current` snapshot, so changes made through either surface stay in
sync. All routes are under `/api`:

```txt
GET    /api/state                    full planner store
GET    /api/prefs                    preferences
PUT    /api/prefs                    update preferences (partial)
GET    /api/plans                    list plans (peptides)
POST   /api/plans                    add a plan
GET    /api/plans/{id}               one plan
PUT    /api/plans/{id}               update a plan (partial)
DELETE /api/plans/{id}               remove a plan (keeps at least one)
POST   /api/plans/{id}/activate      set the active plan
POST   /api/plans/{id}/tiers         add a dose/off tier
DELETE /api/plans/{id}/tiers/{index} remove a tier (keeps at least one)
GET    /api/plans/{id}/compute       full computed plan (water, vials, shots)
GET    /api/plans/{id}/schedule      injection list for one plan
GET    /api/schedule                 merged schedule across all plans
GET    /api/schedule.ics             merged schedule as a calendar download
GET    /api/peptides                 built-in peptide library
```

PUT bodies are partial: only the fields you send are changed. Every mutation is
clamped to valid ranges (the same normalization the UI applies) before saving.

```sh
curl -s localhost:4173/api/plans
curl -s -X POST localhost:4173/api/plans \
  -H 'content-type: application/json' \
  -d '{"peptideName":"Tirzepatide","vialMg":10,"shotsPerWeek":1}'
```

## Data

The app autosaves one current planner snapshot to SQLite:

```txt
src/Shots.Web/data/shots.sqlite
```

Set `SHOTS_DATA_DIR=./data` to store it at the repository root instead. Existing
JSON backups and the prior SQLite payload shape are migrated by the C# state
loader.

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
fields for future list/history views.

## Scripts

```sh
cd dotnet_learning
dotnet build Shots.sln  # build app and tests
dotnet test Shots.sln   # run domain regression tests
dotnet run --project src/Shots.Web
```

## Structure

```txt
Shots.sln                         .NET solution
src/Shots.Domain                  Pure dose, water, schedule, state, export logic
src/Shots.Web                     Blazor Web App and SQLite persistence
src/Shots.Web/wwwroot             CSS, icons, manifest, browser interop
tests/Shots.Domain.Tests          xUnit regression tests
```
