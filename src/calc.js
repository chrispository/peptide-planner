// The planning engine. Pure functions only — given a plan and shared prefs they
// return derived data (dose sequence, best water volume, dated shots). No DOM,
// no persistence. This is the part worth trusting, so keep it isolated.

import { addDays, parseStartDate } from "./format.js";

// A plan's cadence, expressed two ways:
//   intervalDays  – days between consecutive shots
//   dosesPerWeek  – how many shots fit in one calendar week
// Phases are entered in weeks, so dosesPerWeek converts weeks -> dose count.
export function intervalDays(plan) {
  if (plan.scheduleMode === "interval") {
    return Math.max(1, plan.everyDays);
  }
  return 7 / Math.max(0.1, plan.shotsPerWeek);
}

export function dosesPerWeek(plan) {
  if (plan.scheduleMode === "interval") {
    return 7 / Math.max(1, plan.everyDays);
  }
  return Math.max(0.1, plan.shotsPerWeek);
}

export function scheduleLabel(plan) {
  if (plan.scheduleMode === "interval") {
    return `every ${plan.everyDays} days`;
  }
  return `${plan.shotsPerWeek}x per week`;
}

// Number of individual doses a phase contains at the plan's current cadence.
export function tierDoseCount(tier, plan) {
  return Math.max(1, Math.round((tier.weeks || 0) * dosesPerWeek(plan)));
}

// Expand the phases into a flat list of doses, then walk it to see how many
// vials are needed and how far the first vial stretches (each vial is
// reconstituted identically).
export function buildDosePlan(plan) {
  const vialMg = Math.max(0.01, plan.vialMg);
  const doses = [];
  let totalMg = 0;

  plan.tiers.forEach((tier, tierIndex) => {
    const count = tierDoseCount(tier, plan);
    for (let i = 0; i < count; i += 1) {
      doses.push({ doseMg: tier.doseMg, tierIndex });
      totalMg += tier.doseMg;
    }
  });

  let vialsNeeded = doses.length > 0 ? 1 : 0;
  let vialRemaining = vialMg;
  let firstVialDoses = 0;
  let onFirstVial = true;

  doses.forEach((dose) => {
    if (dose.doseMg > vialRemaining + 1e-6) {
      vialsNeeded += 1;
      vialRemaining = vialMg;
      onFirstVial = false;
    }
    vialRemaining -= dose.doseMg;
    if (onFirstVial) {
      firstVialDoses += 1;
    }
  });

  const lastVialLeftover = vialsNeeded > 0 ? Math.max(0, vialMg * vialsNeeded - totalMg) : 0;

  return { doses, totalMg, vialsNeeded, firstVialDoses, lastVialLeftover };
}

// Score candidate BAC water volumes by how close the typical shot lands to the
// preferred syringe size, penalising over-full syringes, tiny draws, and
// non-round unit counts. Lower score is better.
export function buildWaterOptions(vialMg, doses, prefs) {
  const doseMgs = doses.map((dose) => dose.doseMg);
  const maxDoseMg = Math.max(...doseMgs);
  const options = [];

  for (let ml = 0.5; ml <= 10.0001; ml += 0.5) {
    const concentration = vialMg / ml;
    const unitsByDose = doseMgs.map((mg) => (mg / concentration) * 100);
    const maxUnits = Math.max(...unitsByDose);
    const minUnits = Math.min(...unitsByDose);

    if (maxUnits > 100 || minUnits < 2) {
      continue;
    }

    const typicalUnits = (maxDoseMg / concentration) * 100;
    const highVolumePenalty = maxUnits > prefs.maxUnits ? (maxUnits - prefs.maxUnits) * 3.5 : 0;
    const tinyPenalty = minUnits < 10 ? (10 - minUnits) * 1.5 : 0;
    const roundnessPenalty = unitsByDose.reduce(
      (total, units) => total + Math.abs(units - Math.round(units / 5) * 5) * 0.2,
      0,
    );
    const score =
      Math.abs(typicalUnits - prefs.idealUnits) + highVolumePenalty + tinyPenalty + roundnessPenalty;

    options.push({ ml, concentration, unitsByDose, maxUnits, minUnits, typicalUnits, score });
  }

  return options.sort((a, b) => a.score - b.score || a.ml - b.ml);
}

// Everything derived for one plan. Returns { empty: true } when there are no
// doses, or { recommended: null } when nothing fits a 100-unit syringe.
export function computePlan(plan, prefs) {
  const vialMg = Math.max(0.01, plan.vialMg);
  const { doses, totalMg, vialsNeeded, firstVialDoses, lastVialLeftover } = buildDosePlan(plan);

  if (doses.length === 0) {
    return { empty: true };
  }

  const interval = intervalDays(plan);
  const options = buildWaterOptions(vialMg, doses, prefs);
  const recommended = options[0] || null;
  const startDate = parseStartDate(plan.startDate);
  const bacUseBy = addDays(startDate, prefs.bacWindowDays);
  const vialDurationDays = Math.max(0, Math.round((Math.max(1, firstVialDoses) - 1) * interval));
  const planDurationDays = Math.max(0, Math.round((doses.length - 1) * interval));

  const shots = doses.map((dose, index) => ({
    index,
    date: addDays(startDate, Math.round(index * interval)),
    doseMg: dose.doseMg,
    tierIndex: dose.tierIndex,
    units: recommended ? recommended.unitsByDose[index] : null,
  }));

  return {
    empty: false,
    plan,
    vialMg,
    doses,
    totalMg,
    vialsNeeded,
    firstVialDoses,
    lastVialLeftover,
    interval,
    options,
    recommended,
    startDate,
    bacUseBy,
    vialDurationDays,
    planDurationDays,
    shots,
    lastShotDate: shots[shots.length - 1].date,
  };
}

// Group a dose sequence into runs of equal dose, e.g. "12x 2.5 mg, 4x 5 mg".
export function summarizeDoses(doses, formatMg) {
  const groups = [];
  doses.forEach((dose) => {
    const last = groups[groups.length - 1];
    if (last && last.doseMg === dose.doseMg) {
      last.count += 1;
    } else {
      groups.push({ doseMg: dose.doseMg, count: 1 });
    }
  });
  return groups.map((g) => `${g.count}x ${formatMg(g.doseMg)} mg`).join(", ");
}

// Compute every plan, dropping the ones with nothing valid to show. Used by both
// the per-plan view and the combined schedule.
export function computeAll(plans, prefs) {
  return plans
    .map((plan) => ({ plan, result: computePlan(plan, prefs) }))
    .filter((entry) => !entry.result.empty && entry.result.recommended);
}

// Merge every plan's shots into one date-sorted timeline for the schedule tab.
export function mergeSchedule(computed) {
  const merged = [];
  computed.forEach(({ plan, result }) => {
    result.shots.forEach((shot) => {
      merged.push({ ...shot, peptideName: plan.peptideName || "Untitled" });
    });
  });
  merged.sort((a, b) => a.date - b.date);
  merged.forEach((shot, index) => {
    shot.index = index;
  });
  return merged;
}
