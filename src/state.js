// The app's data model and (de)serialization. One `store` holds shared prefs and
// the list of peptide plans; the rest of the app reads it and calls these
// helpers to mutate it. Tiers keep both calendar weeks and shot counts:
// weekly schedules edit weeks, interval schedules edit count.

import { dateInputValue } from "./format.js";

export const STATE_VERSION = 6;

export const DEFAULT_PREFS = {
  previewCount: 8,
  maxUnits: 50,
  idealUnits: 25,
  bacWindowDays: 35,
  manualBacOpenDates: [],
};

let planSeq = 0;
function uid() {
  planSeq += 1;
  return `plan-${Date.now().toString(36)}-${planSeq}`;
}

export function num(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createPlan(overrides = {}) {
  return {
    id: uid(),
    peptideName: "NAD+",
    vialMg: 500,
    startDate: dateInputValue(new Date()),
    scheduleMode: "weekly",
    shotsPerWeek: 2,
    everyDays: 3,
    flexibleDose: false,
    flexibleDosePct: 10,
    waterMlOverride: null, // null = use the auto-recommended volume
    tiers: [
      {
        type: "dose",
        weeks: 2.5,
        count: 5,
        doseMg: 100,
        scheduleMode: "weekly",
        shotsPerWeek: 2,
        everyDays: 3,
        flexibleDose: false,
        flexibleDosePct: 10,
      },
    ],
    ...overrides,
  };
}

function tierDosesPerWeek(tier) {
  if (tier.scheduleMode === "interval") {
    return 7 / Math.max(1, num(tier.everyDays, 1));
  }
  return Math.max(0.1, num(tier.shotsPerWeek, 1));
}

// Coerce arbitrary tier input into { type, weeks, count, doseMg }. Older saves
// may only have weeks or only have count; initialize the missing side from cadence.
function normalizeTiers(tiers, plan) {
  const list = (Array.isArray(tiers) ? tiers : [])
    .map((tier) => {
      const type = tier.type === "off" ? "off" : "dose";
      const scheduleMode =
        tier.scheduleMode === "interval" ? "interval" : plan.scheduleMode === "interval" ? "interval" : "weekly";
      const shotsPerWeek = Math.max(0.1, num(tier.shotsPerWeek, plan.shotsPerWeek || 2));
      const everyDays = Math.max(1, num(tier.everyDays, plan.everyDays || 3));
      const cadence = { scheduleMode, shotsPerWeek, everyDays };
      const doseMg = type === "off" ? 0 : Math.max(0.001, num(tier.doseMg, 1));
      const hasWeeks = Number.isFinite(num(tier.weeks, NaN));
      const hasCount = Number.isFinite(num(tier.count, NaN));
      const count = hasCount
        ? Math.max(1, Math.round(num(tier.count, 1)))
        : Math.max(1, Math.round(num(tier.weeks, 1) * tierDosesPerWeek(cadence)));
      const weeks = hasWeeks
        ? Math.max(0.5, num(tier.weeks))
        : Math.max(0.5, count / tierDosesPerWeek(cadence));
      const flexibleDose =
        typeof tier.flexibleDose === "boolean" ? tier.flexibleDose : Boolean(plan.flexibleDose);
      const flexibleDosePct = Math.min(
        100,
        Math.max(1, num(tier.flexibleDosePct, plan.flexibleDosePct ?? 10)),
      );
      return { type, weeks, count, doseMg, ...cadence, flexibleDose, flexibleDosePct };
    });
  return list.length ? list : createPlan().tiers;
}

export function createStore() {
  const plans = [createPlan()];
  return {
    version: STATE_VERSION,
    prefs: { ...DEFAULT_PREFS },
    plans,
    activePlanId: plans[0].id,
    activeTab: "reconstitution",
  };
}

function normalizeManualBacOpenDates(value) {
  const dates = Array.isArray(value) ? value : [];
  return [...new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(String(date))))].sort();
}

function normalizePrefs(rawPrefs = {}) {
  return {
    previewCount: num(rawPrefs.previewCount, DEFAULT_PREFS.previewCount),
    maxUnits: num(rawPrefs.maxUnits, DEFAULT_PREFS.maxUnits),
    idealUnits: num(rawPrefs.idealUnits, DEFAULT_PREFS.idealUnits),
    bacWindowDays: num(rawPrefs.bacWindowDays, DEFAULT_PREFS.bacWindowDays),
    manualBacOpenDates: normalizeManualBacOpenDates(rawPrefs.manualBacOpenDates),
  };
}

export function getActivePlan(store) {
  return store.plans.find((plan) => plan.id === store.activePlanId) || store.plans[0];
}

// The persisted shape. Runtime-only UI state is intentionally left out.
export function serialize(store) {
  return {
    version: STATE_VERSION,
    activePlanId: store.activePlanId,
    activeTab: store.activeTab,
    prefs: store.prefs,
    plans: store.plans,
  };
}

// Load a saved payload into `store`, migrating older versions. Returns true when
// something usable was applied.
export function hydrate(store, payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  // v1: a single plan stored under `fields` + top-level `tiers`/`scheduleMode`.
  if (![2, 3, 4, 5, 6].includes(payload.version) && payload.fields) {
    const f = payload.fields;
    store.prefs = normalizePrefs(f);
    const plan = createPlan({
      peptideName: f.peptideName || "NAD+",
      vialMg: num(f.vialMg, 500),
      startDate: f.startDate || dateInputValue(new Date()),
      scheduleMode: payload.scheduleMode === "interval" ? "interval" : "weekly",
      shotsPerWeek: num(f.shotsPerWeek, 2),
      everyDays: num(f.everyDays, 3),
    });
    plan.tiers = normalizeTiers(payload.tiers, plan);
    store.plans = [plan];
    store.activePlanId = plan.id;
    store.activeTab = "reconstitution";
    return true;
  }

  // v2/v3/v4/v5: array of plans + shared prefs. normalizeTiers fills whichever
  // side of the hybrid tier duration is missing.
  if (!Array.isArray(payload.plans) || payload.plans.length === 0) {
    return false;
  }

  store.prefs = normalizePrefs(payload.prefs);
  store.plans = payload.plans.map((raw) => {
    const plan = { ...createPlan(), ...raw, id: raw.id || uid() };
    plan.tiers = normalizeTiers(raw.tiers, plan);
    const override = num(raw.waterMlOverride, NaN);
    plan.waterMlOverride = Number.isFinite(override) && override > 0 ? clamp(override, 0.1, 20) : null;
    return plan;
  });
  store.activePlanId = store.plans.some((plan) => plan.id === payload.activePlanId)
    ? payload.activePlanId
    : store.plans[0].id;
  store.activeTab = payload.activeTab === "schedule" ? "schedule" : "reconstitution";
  return true;
}
