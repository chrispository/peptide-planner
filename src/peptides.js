// Built-in peptide reference. Every UI default (suggested doses, cadence, vial
// presets) is driven from this table, so adding a peptide here is all it takes.
// `doseStepsMg` is ascending typical per-dose amounts; all amounts are in mg.
export const PEPTIDE_LIBRARY = {
  "Tirzepatide": {
    commonVialsMg: [10, 15, 30, 60],
    doseStepsMg: [2.5, 5, 7.5, 10, 12.5, 15],
    defaultDoseMg: 2.5,
    schedule: { mode: "weekly", shotsPerWeek: 1 },
    flexibleDose: false,
    titrating: true,
    note: "GLP-1/GIP agonist. One injection per week, titrated up roughly every 4 weeks as tolerated.",
  },
  "Semaglutide": {
    commonVialsMg: [2, 5, 10],
    doseStepsMg: [0.25, 0.5, 1, 1.7, 2.4],
    defaultDoseMg: 0.25,
    schedule: { mode: "weekly", shotsPerWeek: 1 },
    flexibleDose: false,
    titrating: true,
    note: "GLP-1 agonist. One injection per week, titrated up monthly.",
  },
  "NAD+": {
    commonVialsMg: [100, 500, 1000],
    doseStepsMg: [50, 100],
    defaultDoseMg: 100,
    schedule: { mode: "weekly", shotsPerWeek: 2 },
    flexibleDose: true,
    titrating: false,
    note: "Commonly 50–100 mg, 1–3x per week. Start low to limit flushing.",
  },
  "BPC-157": {
    commonVialsMg: [5, 10],
    doseStepsMg: [0.25, 0.5],
    defaultDoseMg: 0.25,
    schedule: { mode: "interval", everyDays: 1 },
    flexibleDose: true,
    titrating: false,
    note: "Often 250–500 mcg once or twice daily through a healing cycle.",
  },
  "TB-500": {
    commonVialsMg: [5, 10],
    doseStepsMg: [1, 2, 2.5],
    defaultDoseMg: 2,
    schedule: { mode: "weekly", shotsPerWeek: 2 },
    flexibleDose: true,
    titrating: false,
    note: "Loading phase often 2–2.5 mg twice weekly.",
  },
};

export const PEPTIDE_NAMES = Object.keys(PEPTIDE_LIBRARY);

// Resolve a name (case-insensitive) against the built-in library first, then any
// peptides fetched at runtime via AI lookup. Returns null when unknown.
export function lookupPeptide(name, aiLibrary = {}) {
  const needle = String(name || "").trim().toLowerCase();
  if (!needle) {
    return null;
  }
  const libKey = PEPTIDE_NAMES.find((entry) => entry.toLowerCase() === needle);
  if (libKey) {
    return { name: libKey, source: "library", ...PEPTIDE_LIBRARY[libKey] };
  }
  const aiKey = Object.keys(aiLibrary).find((entry) => entry.toLowerCase() === needle);
  return aiKey ? { name: aiKey, source: "ai", ...aiLibrary[aiKey] } : null;
}
