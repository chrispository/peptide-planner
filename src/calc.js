// The planning engine. Pure functions only — given a plan and shared prefs they
// return derived data (dose sequence, best water volume, dated shots). No DOM,
// no persistence. This is the part worth trusting, so keep it isolated.

import { addDays, parseStartDate } from "./format.js";

// A plan's cadence, expressed two ways:
//   intervalDays  – days between consecutive shots
//   dosesPerWeek  – how many shots fit in one calendar week
// Weekly phases use weeks; interval phases use explicit shot counts.
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
  if (tier.type === "off") {
    return 0;
  }
  if (plan.scheduleMode === "interval") {
    return Math.max(1, Math.round(tier.count || 1));
  }
  return Math.max(1, Math.round((tier.weeks || 0) * dosesPerWeek(plan)));
}

export function tierScheduleCount(tier, plan) {
  if (plan.scheduleMode === "interval") {
    return Math.max(1, Math.round(tier.count || 1));
  }
  return Math.max(1, Math.round((tier.weeks || 0) * dosesPerWeek(plan)));
}

// Expand the phases into a flat list of doses, then walk it to see how many
// vials are needed and how far the first vial stretches (each vial is
// reconstituted identically).
export function buildDosePlan(plan) {
  const vialMg = Math.max(0.01, plan.vialMg);
  const flexibleRatio = Math.max(0.01, Math.min(1, (plan.flexibleDosePct ?? 10) / 100));
  const doses = [];
  let totalMg = 0;
  let scheduleCursor = 0;

  plan.tiers.forEach((tier, tierIndex) => {
    const count = tierScheduleCount(tier, plan);
    if (tier.type === "off") {
      scheduleCursor += count;
      return;
    }
    for (let i = 0; i < count; i += 1) {
      doses.push({ doseMg: tier.doseMg, baseDoseMg: tier.doseMg, tierIndex, scheduleIndex: scheduleCursor });
      totalMg += tier.doseMg;
      scheduleCursor += 1;
    }
  });

  let vialsNeeded = 0;
  let vialRemaining = vialMg;
  let firstVialDoses = 0;
  let unusedAcrossOpenedVials = 0;
  let currentVial = 1;
  let vialStartIndex = 0;
  const cleanupSuggestions = [];

  function closeVial(vialNumber, startIndex, endIndex, unusedMg) {
    const lastDose = doses[endIndex];
    if (!lastDose) {
      return;
    }
    let finalUnusedMg = unusedMg;
    const vialDoses = doses.slice(startIndex, endIndex + 1);
    const vialTotalMg = vialDoses.reduce((total, dose) => total + dose.doseMg, 0);
    const adjustmentRatio = vialTotalMg > 0 ? unusedMg / vialTotalMg : Infinity;

    if (plan.flexibleDose && unusedMg > 0.001 && adjustmentRatio <= flexibleRatio + 1e-9) {
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
        adjustmentPct: adjustmentRatio * 100,
        addedMg: unusedMg,
        applied: true,
      });
    }

    lastDose.endsVial = { vialNumber, unusedMg: finalUnusedMg };
    unusedAcrossOpenedVials += finalUnusedMg;
  }

  doses.forEach((dose, index) => {
    if (dose.doseMg > vialRemaining + 1e-6) {
      if (index > 0) {
        closeVial(currentVial, vialStartIndex, index - 1, Math.max(0, vialRemaining));
      }
      currentVial += 1;
      vialStartIndex = index;
      vialRemaining = vialMg;
    }
    dose.vialNumber = currentVial;
    dose.opensVial = index === 0 || doses[index - 1]?.endsVial != null;
    vialRemaining -= dose.doseMg;
    dose.vialRemainingAfter = Math.max(0, vialRemaining);
    if (currentVial === 1) {
      firstVialDoses += 1;
    }
  });

  if (doses.length > 0) {
    closeVial(currentVial, vialStartIndex, doses.length - 1, Math.max(0, vialRemaining));
    vialsNeeded = currentVial;
  }

  return { doses, totalMg, vialsNeeded, firstVialDoses, lastVialLeftover: unusedAcrossOpenedVials, cleanupSuggestions };
}

// Score candidate BAC water volumes by how close the typical shot lands to the
// preferred syringe size, penalising over-full syringes, tiny draws, and unit
// counts that are hard to measure. Lower score is better.
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
    const wholeUnitPenalty = unitsByDose.reduce((total, units) => total + Math.abs(units - Math.round(units)) * 36, 0);
    const fiveUnitPenalty = unitsByDose.reduce(
      (total, units) => total + Math.abs(units - Math.round(units / 5) * 5) * 0.05,
      0,
    );
    const score =
      Math.abs(typicalUnits - prefs.idealUnits) + highVolumePenalty + tinyPenalty + wholeUnitPenalty + fiveUnitPenalty;

    options.push({ ml, concentration, unitsByDose, maxUnits, minUnits, typicalUnits, score });
  }

  return options.sort((a, b) => a.score - b.score || a.ml - b.ml);
}

function cloneDoses(doses) {
  return doses.map((dose) => ({
    ...dose,
    endsVial: dose.endsVial ? { ...dose.endsVial } : undefined,
  }));
}

function allocateWholeUnitsForVial(vialDoses, vialMg, waterMl, flexibleRatio) {
  const unitMg = vialMg / (waterMl * 100);
  const baseUnits = vialDoses.map((dose) => (dose.baseDoseMg ?? dose.doseMg) / unitMg);
  const totalUnits = Math.round(waterMl * 100);
  const baseTotal = baseUnits.reduce((total, units) => total + units, 0);
  const extraUnits = totalUnits - baseTotal;
  const minUnits = baseUnits.map((units) => Math.ceil(units - 1e-9));
  const maxUnits = baseUnits.map((units) => Math.floor(units * (1 + flexibleRatio) + 1e-9));
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

function applyWholeUnitCleanup(doses, cleanupSuggestions, vialMg, recommended, flexibleRatio) {
  if (!recommended || cleanupSuggestions.length === 0) {
    return true;
  }

  for (const suggestion of cleanupSuggestions) {
    if (!suggestion.applied) {
      continue;
    }
    const vialDoses = doses.slice(suggestion.shotStartIndex, suggestion.shotEndIndex + 1);
    const allocatedUnits = allocateWholeUnitsForVial(vialDoses, vialMg, recommended.ml, flexibleRatio);
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

// Everything derived for one plan. Returns { empty: true } when there are no
// doses, or { recommended: null } when nothing fits a 100-unit syringe.
export function computePlan(plan, prefs) {
  const vialMg = Math.max(0.01, plan.vialMg);
  const flexibleRatio = Math.max(0.01, Math.min(1, (plan.flexibleDosePct ?? 10) / 100));
  let { doses, totalMg, vialsNeeded, firstVialDoses, lastVialLeftover, cleanupSuggestions } = buildDosePlan(plan);

  if (doses.length === 0) {
    return { empty: true };
  }

  const interval = intervalDays(plan);
  const options = buildWaterOptions(vialMg, doses, prefs);
  let recommended = null;
  if (plan.flexibleDose && cleanupSuggestions.length > 0) {
    for (const option of options) {
      const candidateDoses = cloneDoses(doses);
      const candidate = { ...option, unitsByDose: [...option.unitsByDose] };
      if (applyWholeUnitCleanup(candidateDoses, cleanupSuggestions, vialMg, candidate, flexibleRatio)) {
        doses = candidateDoses;
        recommended = candidate;
        break;
      }
    }
  }
  recommended = recommended || options[0] || null;
  const startDate = parseStartDate(plan.startDate);
  const bacUseBy = addDays(startDate, prefs.bacWindowDays);
  const vialDurationDays = Math.max(0, Math.round((Math.max(1, firstVialDoses) - 1) * interval));
  const lastScheduleIndex = Math.max(...doses.map((dose) => dose.scheduleIndex ?? 0));
  const planDurationDays = Math.max(0, Math.round(lastScheduleIndex * interval));

  const shots = doses.map((dose, index) => ({
    index,
    date: addDays(startDate, Math.round((dose.scheduleIndex ?? index) * interval)),
    doseMg: dose.doseMg,
    tierIndex: dose.tierIndex,
    bacOpened: index === 0,
    bacExpires: index === 0 ? bacUseBy : null,
    vialNumber: dose.vialNumber,
    opensVial: dose.opensVial,
    endsVial: dose.endsVial,
    vialRemainingAfter: dose.vialRemainingAfter,
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
    cleanupSuggestions,
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

export function analyzeCartridge(result, bacWindowDays, cartridgeMl = 3) {
  if (!result || result.empty || !result.doses?.length || cartridgeMl <= 0 || bacWindowDays <= 0) {
    return null;
  }

  const cartridgeFillMl = Math.min(result.recommended?.ml || cartridgeMl, cartridgeMl);
  const concentration = result.vialMg / cartridgeFillMl;
  const doseVolumes = result.doses.map((dose) => dose.doseMg / concentration);
  const unitsByDose = doseVolumes.map((ml) => ml * 100);
  const mlUsedWithinWindow = result.doses.reduce((total, dose, index) => {
    const elapsedDays = Math.round((dose.scheduleIndex ?? index) * result.interval);
    return elapsedDays <= bacWindowDays ? total + doseVolumes[index] : total;
  }, 0);
  const fillMlWithinWindow = Math.min(cartridgeMl, mlUsedWithinWindow);
  const estimatedFullCartridgeDays =
    mlUsedWithinWindow > 0 ? Math.ceil((cartridgeMl / mlUsedWithinWindow) * bacWindowDays) : null;
  const phaseSummaries = (result.plan?.tiers || [])
    .map((tier, tierIndex) => {
      const phaseDoses = result.doses.filter((dose) => dose.tierIndex === tierIndex);
      if (tier.type === "off" || phaseDoses.length === 0) {
        return null;
      }
      const firstScheduleIndex = phaseDoses[0].scheduleIndex ?? 0;
      const rawMlWithinWindow = phaseDoses.reduce((total, dose) => {
        const elapsedDays = Math.round(((dose.scheduleIndex ?? firstScheduleIndex) - firstScheduleIndex) * result.interval);
        return elapsedDays <= bacWindowDays ? total + dose.doseMg / concentration : total;
      }, 0);
      const mlWithinWindow = Math.min(cartridgeMl, rawMlWithinWindow);
      return {
        phaseNumber: tierIndex + 1,
        doseMg: tier.doseMg,
        shotsWithinWindow: phaseDoses.filter((dose) => {
          const elapsedDays = Math.round(((dose.scheduleIndex ?? firstScheduleIndex) - firstScheduleIndex) * result.interval);
          return elapsedDays <= bacWindowDays;
        }).length,
        mlWithinWindow,
        rawMlWithinWindow,
        fullCartridgeWithinWindow: rawMlWithinWindow >= cartridgeMl - 1e-9,
      };
    })
    .filter(Boolean);

  return {
    cartridgeMl,
    cartridgeFillMl,
    concentration,
    doseVolumes,
    unitsByDose,
    mlUsedWithinWindow,
    fillMlWithinWindow,
    estimatedFullCartridgeDays,
    fullCartridgeWithinWindow: mlUsedWithinWindow >= cartridgeMl - 1e-9,
    phaseSummaries,
  };
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
