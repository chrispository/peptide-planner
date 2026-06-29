// The app's data model and (de)serialization. One `store` holds shared prefs and
// the list of peptide plans; the rest of the app reads it and calls these
// helpers to mutate it. Tiers keep both calendar weeks and shot counts:
// weekly schedules edit weeks, interval schedules edit count.

import { dateInputValue } from "./format.js";
import { dosesPerWeek } from "./calc.js";

export const STATE_VERSION = 4;

export const DEFAULT_PREFS = {
  previewCount: 8,
  maxUnits: 70,
  idealUnits: 60,
  bacBottleMl: 30,
  bacWindowDays: 35,
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
    tiers: [{ weeks: 2.5, count: 5, doseMg: 100 }],
    ...overrides,
  };
}

// Coerce arbitrary tier input into { weeks, count, doseMg }. Older saves may
// only have weeks or only have count; initialize the missing side from cadence.
function normalizeTiers(tiers, plan) {
  const list = (Array.isArray(tiers) ? tiers : [])
    .map((tier) => {
      const doseMg = Math.max(0.001, num(tier.doseMg, 1));
      const hasWeeks = Number.isFinite(num(tier.weeks, NaN));
      const hasCount = Number.isFinite(num(tier.count, NaN));
      const count = hasCount
        ? Math.max(1, Math.round(num(tier.count, 1)))
        : Math.max(1, Math.round(num(tier.weeks, 1) * dosesPerWeek(plan)));
      const weeks = hasWeeks
        ? Math.max(0.5, num(tier.weeks))
        : Math.max(0.5, count / dosesPerWeek(plan));
      return { weeks, count, doseMg };
    });
  return list.length ? list : [{ weeks: 2.5, count: 5, doseMg: 100 }];
}

export function createStore() {
  const plans = [createPlan()];
  return {
    version: STATE_VERSION,
    prefs: { ...DEFAULT_PREFS },
    plans,
    activePlanId: plans[0].id,
    activeTab: "reconstitution",
    // Peptides fetched at runtime via AI lookup (not persisted).
    aiLibrary: {},
  };
}

export function getActivePlan(store) {
  return store.plans.find((plan) => plan.id === store.activePlanId) || store.plans[0];
}

// The persisted shape. aiLibrary is intentionally left out — it's a runtime cache.
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
  if (![2, 3, 4].includes(payload.version) && payload.fields) {
    const f = payload.fields;
    store.prefs = {
      previewCount: num(f.previewCount, DEFAULT_PREFS.previewCount),
      maxUnits: num(f.maxUnits, DEFAULT_PREFS.maxUnits),
      idealUnits: num(f.idealUnits, DEFAULT_PREFS.idealUnits),
      bacBottleMl: num(f.bacBottleMl, DEFAULT_PREFS.bacBottleMl),
      bacWindowDays: num(f.bacWindowDays, DEFAULT_PREFS.bacWindowDays),
    };
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

  // v2/v3/v4: array of plans + shared prefs. normalizeTiers fills whichever
  // side of the hybrid tier duration is missing.
  if (!Array.isArray(payload.plans) || payload.plans.length === 0) {
    return false;
  }

  store.prefs = { ...DEFAULT_PREFS, ...(payload.prefs || {}) };
  store.plans = payload.plans.map((raw) => {
    const plan = { ...createPlan(), ...raw, id: raw.id || uid() };
    plan.tiers = normalizeTiers(raw.tiers, plan);
    return plan;
  });
  store.activePlanId = store.plans.some((plan) => plan.id === payload.activePlanId)
    ? payload.activePlanId
    : store.plans[0].id;
  store.activeTab = payload.activeTab === "schedule" ? "schedule" : "reconstitution";
  return true;
}
