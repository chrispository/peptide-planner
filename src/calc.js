// The planning engine. Pure functions only — given a plan and shared prefs they
// return derived data (dose sequence, best water volume, dated shots). No DOM,
// no persistence. This is the part worth trusting, so keep it isolated.

import { addDays, parseStartDate } from "./format.js";

// A phase's cadence, expressed two ways:
//   tierIntervalDays – days between consecutive shots
//   tierDosesPerWeek – how many shots fit in one calendar week
// Weekly phases use weeks; interval phases use explicit shot counts.
export function tierIntervalDays(tier) {
  if (tier.scheduleMode === "interval") {
    return Math.max(1, tier.everyDays || 1);
  }
  return 7 / Math.max(0.1, tier.shotsPerWeek || 1);
}

export function tierDosesPerWeek(tier) {
  if (tier.scheduleMode === "interval") {
    return 7 / Math.max(1, tier.everyDays || 1);
  }
  return Math.max(0.1, tier.shotsPerWeek || 1);
}

export function tierScheduleLabel(tier) {
  if (tier.scheduleMode === "interval") {
    const days = tier.everyDays || 1;
    return `every ${days} ${days === 1 ? "day" : "days"}`;
  }
  return `${tier.shotsPerWeek || 1}x per week`;
}

export function scheduleLabel(plan) {
  const labels = [
    ...new Set((plan.tiers || []).filter((tier) => tier.type !== "off").map((tier) => tierScheduleLabel(tier))),
  ];
  if (labels.length === 0) {
    return "no active phases";
  }
  if (labels.length === 1) {
    return labels[0];
  }
  return "mixed cadence";
}

// Number of individual doses a phase contains at the plan's current cadence.
export function tierDoseCount(tier) {
  if (tier.type === "off") {
    return 0;
  }
  if (tier.scheduleMode === "interval") {
    return Math.max(1, Math.round(tier.count || 1));
  }
  return Math.max(1, Math.round((tier.weeks || 0) * tierDosesPerWeek(tier)));
}

export function tierScheduleCount(tier) {
  if (tier.scheduleMode === "interval") {
    return Math.max(1, Math.round(tier.count || 1));
  }
  return Math.max(1, Math.round((tier.weeks || 0) * tierDosesPerWeek(tier)));
}

function tierFlexibleRatio(tier) {
  return Math.max(0.01, Math.min(1, (tier.flexibleDosePct ?? 10) / 100));
}

// Expand the phases into a flat list of doses, then walk it to see how many
// vials are needed and how far the first vial stretches (each vial is
// reconstituted identically).
export function buildDosePlan(plan) {
  const vialMg = Math.max(0.01, plan.vialMg);
  const doses = [];
  let totalMg = 0;
  let dayCursor = 0;

  plan.tiers.forEach((tier, tierIndex) => {
    const count = tierScheduleCount(tier);
    const interval = tierIntervalDays(tier);
    if (tier.type === "off") {
      dayCursor += count * interval;
      return;
    }
    for (let i = 0; i < count; i += 1) {
      doses.push({
        doseMg: tier.doseMg,
        baseDoseMg: tier.doseMg,
        tierIndex,
        dayOffset: dayCursor + i * interval,
        flexibleDose: Boolean(tier.flexibleDose),
        flexibleRatio: tierFlexibleRatio(tier),
      });
      totalMg += tier.doseMg;
    }
    dayCursor += count * interval;
  });

  let vialsNeeded = 0;
  let vialRemaining = vialMg;
  let firstVialDoses = 0;
  let unusedAcrossOpenedVials = 0;
  let currentVial = 1;
  let vialStartIndex = 0;
  const cleanupSuggestions = [];

  function shiftFollowingDoses(startIndex, dayDelta) {
    for (let index = startIndex; index < doses.length; index += 1) {
      doses[index].dayOffset += dayDelta;
    }
  }

  function canAddCleanupDose(dose, unusedMg) {
    if (!dose?.flexibleDose || unusedMg <= 0.001) {
      return false;
    }
    const baseDoseMg = dose.baseDoseMg ?? dose.doseMg;
    const ratio = dose.flexibleRatio ?? 0;
    return unusedMg >= baseDoseMg * (1 - ratio) - 1e-9 && unusedMg <= baseDoseMg * (1 + ratio) + 1e-9;
  }

  function addCleanupDose(vialNumber, lastDose, unusedMg, insertIndex) {
    const baseDoseMg = lastDose.baseDoseMg ?? lastDose.doseMg;
    const interval = tierIntervalDays(plan.tiers[lastDose.tierIndex] || {});
    const cleanupDose = {
      doseMg: unusedMg,
      baseDoseMg,
      tierIndex: lastDose.tierIndex,
      dayOffset: lastDose.dayOffset + interval,
      flexibleDose: true,
      flexibleRatio: lastDose.flexibleRatio,
      flexibleAddedMg: unusedMg - baseDoseMg,
      cleanupDose: true,
    };

    shiftFollowingDoses(insertIndex, interval);
    doses.splice(insertIndex, 0, cleanupDose);
    totalMg += unusedMg;
    cleanupSuggestions.push({
      method: "added-dose",
      vialNumber,
      shotStartIndex: insertIndex,
      shotEndIndex: insertIndex,
      adjustmentPct: ((unusedMg - baseDoseMg) / baseDoseMg) * 100,
      addedMg: unusedMg,
      applied: true,
    });
  }

  function closeVial(vialNumber, startIndex, endIndex, unusedMg, insertIndex = endIndex + 1) {
    const lastDose = doses[endIndex];
    if (!lastDose) {
      return 0;
    }
    let finalUnusedMg = unusedMg;
    const vialDoses = doses.slice(startIndex, endIndex + 1);
    const vialTotalMg = vialDoses.reduce((total, dose) => total + dose.doseMg, 0);
    const adjustmentRatio = vialTotalMg > 0 ? unusedMg / vialTotalMg : Infinity;

    const canCleanup =
      unusedMg > 0.001 &&
      vialDoses.every((dose) => dose.flexibleDose && adjustmentRatio <= (dose.flexibleRatio ?? 0) + 1e-9);

    if (canCleanup) {
      let runningRemaining = vialMg;
      for (let index = startIndex; index <= endIndex; index += 1) {
        const dose = doses[index];
        const addedMg = dose.doseMg * adjustmentRatio;
        dose.flexibleAddedMg = addedMg;
        dose.doseMg += addedMg;
        runningRemaining -= dose.doseMg;
        dose.vialRemainingAfter = Math.max(0, runningRemaining);
      }
      totalMg += unusedMg;
      finalUnusedMg = 0;
      cleanupSuggestions.push({
        vialNumber,
        shotStartIndex: startIndex,
        shotEndIndex: endIndex,
        method: "adjust-existing",
        adjustmentPct: adjustmentRatio * 100,
        addedMg: unusedMg,
        applied: true,
      });
    } else if (canAddCleanupDose(lastDose, unusedMg)) {
      addCleanupDose(vialNumber, lastDose, unusedMg, insertIndex);
      return 1;
    }

    lastDose.endsVial = { vialNumber, unusedMg: finalUnusedMg };
    unusedAcrossOpenedVials += finalUnusedMg;
    return 0;
  }

  function assignDoseToCurrentVial(dose, index) {
    dose.vialNumber = currentVial;
    dose.opensVial = index === 0 || doses[index - 1]?.endsVial != null;
    vialRemaining -= dose.doseMg;
    dose.vialRemainingAfter = Math.max(0, vialRemaining);
    if (currentVial === 1) {
      firstVialDoses += 1;
    }
  }

  for (let index = 0; index < doses.length; index += 1) {
    let dose = doses[index];
    if (dose.doseMg > vialRemaining + 1e-6) {
      if (index > 0) {
        const inserted = closeVial(currentVial, vialStartIndex, index - 1, Math.max(0, vialRemaining), index);
        if (inserted > 0) {
          dose = doses[index];
          assignDoseToCurrentVial(dose, index);
          continue;
        }
      }
      currentVial += 1;
      vialStartIndex = index;
      vialRemaining = vialMg;
    }
    assignDoseToCurrentVial(dose, index);
  }

  for (let index = doses.length; doses.length > 0; index += 1) {
    const inserted = closeVial(currentVial, vialStartIndex, doses.length - 1, Math.max(0, vialRemaining), doses.length);
    if (inserted === 0) {
      break;
    }
    const dose = doses[index];
    assignDoseToCurrentVial(dose, index);
  }

  if (doses.length > 0) {
    vialsNeeded = currentVial;
  }

  return { doses, totalMg, vialsNeeded, firstVialDoses, lastVialLeftover: unusedAcrossOpenedVials, cleanupSuggestions };
}

// Derive everything about one candidate water volume: concentration, the units
// each dose draws, and a score for how easily it measures. `prefs` is optional —
// without it the score is 0, which is fine for a user-forced override where the
// volume is chosen, not ranked. Lower score is better.
export function evaluateWaterOption(vialMg, doses, ml, prefs) {
  const doseMgs = doses.map((dose) => dose.doseMg);
  const maxDoseMg = Math.max(...doseMgs);
  const concentration = vialMg / ml;
  const unitsByDose = doseMgs.map((mg) => (mg / concentration) * 100);
  const maxUnits = Math.max(...unitsByDose);
  const minUnits = Math.min(...unitsByDose);
  const typicalUnits = (maxDoseMg / concentration) * 100;

  let score = 0;
  if (prefs) {
    const highVolumePenalty = maxUnits > prefs.maxUnits ? (maxUnits - prefs.maxUnits) * 3.5 : 0;
    const tinyPenalty = minUnits < 10 ? (10 - minUnits) * 1.5 : 0;
    const wholeUnitPenalty = unitsByDose.reduce((total, units) => total + Math.abs(units - Math.round(units)) * 36, 0);
    const fiveUnitPenalty = unitsByDose.reduce(
      (total, units) => total + Math.abs(units - Math.round(units / 5) * 5) * 0.05,
      0,
    );
    score =
      Math.abs(typicalUnits - prefs.idealUnits) + highVolumePenalty + tinyPenalty + wholeUnitPenalty + fiveUnitPenalty;
  }

  return { ml, concentration, unitsByDose, maxUnits, minUnits, typicalUnits, score };
}

// Score candidate BAC water volumes by how close the typical shot lands to the
// preferred syringe size, penalising over-full syringes, tiny draws, and unit
// counts that are hard to measure. Lower score is better.
export function buildWaterOptions(vialMg, doses, prefs) {
  const options = [];

  for (let ml = 0.5; ml <= 10.0001; ml += 0.5) {
    const option = evaluateWaterOption(vialMg, doses, ml, prefs);
    if (option.maxUnits > 100 || option.minUnits < 2) {
      continue;
    }
    options.push(option);
  }

  return options.sort((a, b) => a.score - b.score || a.ml - b.ml);
}

function cloneDoses(doses) {
  return doses.map((dose) => ({
    ...dose,
    endsVial: dose.endsVial ? { ...dose.endsVial } : undefined,
  }));
}

function allocateWholeUnitsForVial(vialDoses, vialMg, waterMl) {
  const unitMg = vialMg / (waterMl * 100);
  const baseUnits = vialDoses.map((dose) => (dose.baseDoseMg ?? dose.doseMg) / unitMg);
  const totalUnits = Math.round(waterMl * 100);
  const baseTotal = baseUnits.reduce((total, units) => total + units, 0);
  const extraUnits = totalUnits - baseTotal;
  const minUnits = baseUnits.map((units) => Math.ceil(units - 1e-9));
  const maxUnits = baseUnits.map((units, index) =>
    Math.floor(units * (1 + (vialDoses[index].flexibleRatio ?? 0)) + 1e-9),
  );
  const minTotal = minUnits.reduce((total, units) => total + units, 0);
  const maxTotal = maxUnits.reduce((total, units) => total + units, 0);

  if (extraUnits <= 0.001 || minTotal > totalUnits || maxTotal < totalUnits) {
    return null;
  }

  const targetUnits = baseUnits.map((units) => units + extraUnits * (units / baseTotal));
  const allocated = targetUnits.map((units, index) => Math.min(maxUnits[index], Math.max(minUnits[index], Math.floor(units))));
  let allocatedTotal = allocated.reduce((total, units) => total + units, 0);

  while (allocatedTotal < totalUnits) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    allocated.forEach((units, index) => {
      if (units >= maxUnits[index]) {
        return;
      }
      const score = targetUnits[index] - units;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    if (bestIndex === -1) {
      return null;
    }
    allocated[bestIndex] += 1;
    allocatedTotal += 1;
  }

  while (allocatedTotal > totalUnits) {
    let bestIndex = -1;
    let bestScore = Infinity;
    allocated.forEach((units, index) => {
      if (units <= minUnits[index]) {
        return;
      }
      const score = targetUnits[index] - units;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    if (bestIndex === -1) {
      return null;
    }
    allocated[bestIndex] -= 1;
    allocatedTotal -= 1;
  }

  return allocated;
}

function applyWholeUnitCleanup(doses, cleanupSuggestions, vialMg, recommended) {
  if (!recommended || cleanupSuggestions.length === 0) {
    return true;
  }

  for (const suggestion of cleanupSuggestions) {
    if (!suggestion.applied || suggestion.method === "added-dose") {
      continue;
    }
    const vialDoses = doses.slice(suggestion.shotStartIndex, suggestion.shotEndIndex + 1);
    const allocatedUnits = allocateWholeUnitsForVial(vialDoses, vialMg, recommended.ml);
    if (!allocatedUnits) {
      return false;
    }

    let runningRemaining = vialMg;
    for (let offset = 0; offset < allocatedUnits.length; offset += 1) {
      const dose = doses[suggestion.shotStartIndex + offset];
      const baseDoseMg = dose.baseDoseMg ?? dose.doseMg;
      dose.doseMg = allocatedUnits[offset] * recommended.concentration / 100;
      dose.flexibleAddedMg = dose.doseMg - baseDoseMg;
      runningRemaining -= dose.doseMg;
      dose.vialRemainingAfter = Math.max(0, runningRemaining);
    }
    const lastDose = doses[suggestion.shotEndIndex];
    lastDose.endsVial = { ...lastDose.endsVial, unusedMg: 0 };
  }

  recommended.unitsByDose = doses.map((dose) => (dose.doseMg / recommended.concentration) * 100);
  recommended.maxUnits = Math.max(...recommended.unitsByDose);
  recommended.minUnits = Math.min(...recommended.unitsByDose);
  return true;
}

function buildPhaseRecommendations(plan, prefs, vialMg, doses, overrideMl) {
  return plan.tiers
    .map((tier, index) => {
      if (tier.type === "off") {
        return null;
      }
      const phaseDoses = doses.filter((dose) => dose.tierIndex === index);
      if (phaseDoses.length === 0) {
        return null;
      }
      const recommendation =
        overrideMl != null
          ? { ...evaluateWaterOption(vialMg, phaseDoses, overrideMl, prefs), overridden: true }
          : buildWaterOptions(vialMg, phaseDoses, prefs)[0] || null;
      if (!recommendation) {
        return null;
      }
      return {
        phaseNumber: index + 1,
        tierIndex: index,
        ml: recommendation.ml,
        concentration: recommendation.concentration,
        unitsByDose: recommendation.unitsByDose,
        maxUnits: recommendation.maxUnits,
        minUnits: recommendation.minUnits,
        overridden: Boolean(recommendation.overridden),
      };
    })
    .filter(Boolean);
}

// Everything derived for one plan. Returns { empty: true } when there are no
// doses, or { recommended: null } when nothing fits a 100-unit syringe.
export function computePlan(plan, prefs) {
  const vialMg = Math.max(0.01, plan.vialMg);
  let { doses, totalMg, vialsNeeded, firstVialDoses, lastVialLeftover, cleanupSuggestions } = buildDosePlan(plan);

  if (doses.length === 0) {
    return { empty: true };
  }

  const options = buildWaterOptions(vialMg, doses, prefs);
  const overrideMl = Number.isFinite(plan.waterMlOverride) && plan.waterMlOverride > 0 ? plan.waterMlOverride : null;
  let recommended = null;

  if (overrideMl != null) {
    // The user pinned the water volume; honour it verbatim (even if it pushes a
    // shot past 100 units) rather than letting the scorer pick.
    const candidateDoses = cloneDoses(doses);
    const candidate = { ...evaluateWaterOption(vialMg, candidateDoses, overrideMl, prefs), overridden: true };
    candidate.unitsByDose = [...candidate.unitsByDose];
    if (cleanupSuggestions.length > 0) {
      applyWholeUnitCleanup(candidateDoses, cleanupSuggestions, vialMg, candidate);
    }
    doses = candidateDoses;
    recommended = candidate;
  } else if (cleanupSuggestions.length > 0) {
    for (const option of options) {
      const candidateDoses = cloneDoses(doses);
      const candidate = { ...option, unitsByDose: [...option.unitsByDose] };
      if (applyWholeUnitCleanup(candidateDoses, cleanupSuggestions, vialMg, candidate)) {
        doses = candidateDoses;
        recommended = candidate;
        break;
      }
    }
  }
  recommended = recommended || options[0] || null;
  const phaseRecommendations = buildPhaseRecommendations(plan, prefs, vialMg, doses, overrideMl);
  const phaseRecommendationByTier = new Map(
    phaseRecommendations.map((recommendation) => [recommendation.tierIndex, recommendation]),
  );
  const startDate = parseStartDate(plan.startDate);
  const bacUseBy = addDays(startDate, prefs.bacWindowDays);
  const firstVialDayOffsets = doses.filter((dose) => dose.vialNumber === 1).map((dose) => dose.dayOffset ?? 0);
  const vialDurationDays = Math.max(0, Math.round(Math.max(...firstVialDayOffsets) - Math.min(...firstVialDayOffsets)));
  const lastDayOffset = Math.max(...doses.map((dose) => dose.dayOffset ?? 0));
  const planDurationDays = Math.max(0, Math.round(lastDayOffset));

  const shots = doses.map((dose, index) => ({
    index,
    date: addDays(startDate, Math.round(dose.dayOffset ?? index)),
    doseMg: dose.doseMg,
    tierIndex: dose.tierIndex,
    bacOpened: index === 0,
    bacExpires: index === 0 ? bacUseBy : null,
    vialNumber: dose.vialNumber,
    opensVial: dose.opensVial,
    endsVial: dose.endsVial,
    vialRemainingAfter: dose.vialRemainingAfter,
    cleanupDose: Boolean(dose.cleanupDose),
    flexibleAddedMg: dose.flexibleAddedMg,
    baseDoseMg: dose.baseDoseMg,
    units: phaseRecommendationByTier.has(dose.tierIndex)
      ? (dose.doseMg / phaseRecommendationByTier.get(dose.tierIndex).concentration) * 100
      : recommended
        ? recommended.unitsByDose[index]
        : null,
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
    cleanupSuggestions,
    options,
    recommended,
    phaseRecommendations,
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
