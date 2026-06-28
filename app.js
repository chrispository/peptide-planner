// Generic peptide knowledge base. Add entries here to support more peptides;
// everything in the UI (suggestions, cadence defaults, vial presets) is driven
// from this table so nothing else needs to change.
const PEPTIDE_LIBRARY = {
  "Tirzepatide": {
    commonVialsMg: [10, 15, 30, 60],
    doseStepsMg: [2.5, 5, 7.5, 10, 12.5, 15],
    defaultDoseMg: 2.5,
    schedule: { mode: "weekly", shotsPerWeek: 1 },
    titrating: true,
    note: "GLP-1/GIP agonist. One injection per week, titrated up roughly every 4 weeks as tolerated.",
  },
  "Semaglutide": {
    commonVialsMg: [2, 5, 10],
    doseStepsMg: [0.25, 0.5, 1, 1.7, 2.4],
    defaultDoseMg: 0.25,
    schedule: { mode: "weekly", shotsPerWeek: 1 },
    titrating: true,
    note: "GLP-1 agonist. One injection per week, titrated up monthly.",
  },
  "NAD+": {
    commonVialsMg: [100, 500, 1000],
    doseStepsMg: [50, 100],
    defaultDoseMg: 100,
    schedule: { mode: "weekly", shotsPerWeek: 2 },
    titrating: false,
    note: "Commonly 50–100 mg, 1–3x per week. Start low to limit flushing.",
  },
  "BPC-157": {
    commonVialsMg: [5, 10],
    doseStepsMg: [0.25, 0.5],
    defaultDoseMg: 0.25,
    schedule: { mode: "interval", everyDays: 1 },
    titrating: false,
    note: "Often 250–500 mcg once or twice daily through a healing cycle.",
  },
  "TB-500": {
    commonVialsMg: [5, 10],
    doseStepsMg: [1, 2, 2.5],
    defaultDoseMg: 2,
    schedule: { mode: "weekly", shotsPerWeek: 2 },
    titrating: false,
    note: "Loading phase often 2–2.5 mg twice weekly.",
  },
};

const root = document.documentElement;
const form = document.getElementById("plannerForm");
const themeToggle = document.getElementById("themeToggle");
const themeLabel = document.getElementById("themeLabel");
const modeButtons = document.querySelectorAll(".segmented-button");
const scheduleFields = document.querySelectorAll(".schedule-field");
const appTabs = document.querySelectorAll(".app-tab");
const tabPanels = document.querySelectorAll(".tab-panel");
const tierList = document.getElementById("tierList");
const addTierButton = document.getElementById("addTier");
const planChips = document.getElementById("planChips");
const addPlanButton = document.getElementById("addPlan");
const peptideList = document.getElementById("peptideList");
const peptideNote = document.getElementById("peptideNote");
const vialChips = document.getElementById("vialChips");
const suggestionList = document.getElementById("suggestionList");
const maximizeBtn = document.getElementById("maximizeBtn");
const titrationBtn = document.getElementById("titrationBtn");
const aiLookupBtn = document.getElementById("aiLookupBtn");

// Peptides fetched at runtime via the AI lookup endpoint. Same shape as
// PEPTIDE_LIBRARY entries, but flagged so the UI can label them.
const aiLibrary = {};
const aiTried = new Set();

// Plan-scoped inputs (one peptide at a time).
const planInputs = {
  peptideName: document.getElementById("peptideName"),
  vialMg: document.getElementById("vialMg"),
  startDate: document.getElementById("startDate"),
  shotsPerWeek: document.getElementById("shotsPerWeek"),
  everyDays: document.getElementById("everyDays"),
};

// Preferences shared across every plan.
const prefInputs = {
  previewCount: document.getElementById("previewCount"),
  maxUnits: document.getElementById("maxUnits"),
  idealUnits: document.getElementById("idealUnits"),
  bacBottleMl: document.getElementById("bacBottleMl"),
  bacWindowDays: document.getElementById("bacWindowDays"),
};

const output = {
  saveStatus: document.getElementById("saveStatus"),
  recommendedMl: document.getElementById("recommendedMl"),
  recommendedSummary: document.getElementById("recommendedSummary"),
  recommendedUnits: document.getElementById("recommendedUnits"),
  vialLasts: document.getElementById("vialLasts"),
  totalShots: document.getElementById("totalShots"),
  concentration: document.getElementById("concentration"),
  bacUseBy: document.getElementById("bacUseBy"),
  optionList: document.getElementById("optionList"),
  scheduleList: document.getElementById("scheduleList"),
  scheduleSummary: document.getElementById("scheduleSummary"),
  scheduleTabTitle: document.getElementById("scheduleTabTitle"),
  scheduleTabSummary: document.getElementById("scheduleTabSummary"),
  scheduleTabUnits: document.getElementById("scheduleTabUnits"),
  scheduleTabNext: document.getElementById("scheduleTabNext"),
  scheduleTabLastShot: document.getElementById("scheduleTabLastShot"),
  scheduleTabSpan: document.getElementById("scheduleTabSpan"),
  scheduleTabUseBy: document.getElementById("scheduleTabUseBy"),
  scheduleTabMeta: document.getElementById("scheduleTabMeta"),
  scheduleTabList: document.getElementById("scheduleTabList"),
  planSummaryList: document.getElementById("planSummaryList"),
};

let activeTab = "reconstitution";
let persistenceReady = false;
let saveTimer = null;
let savePending = false;

let prefs = {
  previewCount: 8,
  maxUnits: 70,
  idealUnits: 60,
  bacBottleMl: 30,
  bacWindowDays: 35,
};

let plans = [];
let activePlanId = null;
let planSeq = 0;

function uid() {
  planSeq += 1;
  return `plan-${Date.now().toString(36)}-${planSeq}`;
}

function getActivePlan() {
  return plans.find((plan) => plan.id === activePlanId) || plans[0];
}

function createPlan(overrides = {}) {
  return {
    id: uid(),
    peptideName: "NAD+",
    vialMg: 500,
    startDate: dateInputValue(new Date()),
    scheduleMode: "weekly",
    shotsPerWeek: 2,
    everyDays: 3,
    tiers: [{ count: 5, doseMg: 100 }],
    ...overrides,
  };
}

function lookupPeptide(name) {
  if (!name) {
    return null;
  }
  const needle = String(name).trim().toLowerCase();
  const key = Object.keys(PEPTIDE_LIBRARY).find((entry) => entry.toLowerCase() === needle);
  if (key) {
    return { name: key, source: "library", ...PEPTIDE_LIBRARY[key] };
  }
  const aiKey = Object.keys(aiLibrary).find((entry) => entry.toLowerCase() === needle);
  return aiKey ? { name: aiKey, source: "ai", ...aiLibrary[aiKey] } : null;
}

function numberValue(input, fallback = 0) {
  // Accepts a DOM element (reads .value), a string, or a raw number.
  const raw = input !== null && typeof input === "object" ? input.value : input;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function formatNumber(value, maximumFractionDigits = 1) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function formatDate(date) {
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function dateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseStartDate(value) {
  return value ? new Date(`${value}T00:00:00`) : new Date();
}

function planIntervalDays(plan) {
  if (plan.scheduleMode === "interval") {
    return Math.max(1, plan.everyDays);
  }
  return 7 / Math.max(0.1, plan.shotsPerWeek);
}

// How many doses a single week of this plan's cadence contains. Lets phases be
// expressed in weeks while the engine keeps working in doses.
function dosesPerWeek(plan) {
  if (plan.scheduleMode === "interval") {
    return 7 / Math.max(1, plan.everyDays);
  }
  return Math.max(0.1, plan.shotsPerWeek);
}

function scheduleLabel(plan) {
  if (plan.scheduleMode === "interval") {
    return `every ${formatNumber(plan.everyDays, 1)} days`;
  }
  return `${formatNumber(plan.shotsPerWeek, 1)}x per week`;
}

function tierSummary(dosePlan) {
  const groups = [];
  dosePlan.forEach((dose) => {
    const last = groups[groups.length - 1];
    if (last && last.doseMg === dose.doseMg) {
      last.count += 1;
    } else {
      groups.push({ doseMg: dose.doseMg, count: 1 });
    }
  });
  return groups.map((group) => `${group.count}x ${formatNumber(group.doseMg, 3)} mg`).join(", ");
}

function unitRange(units) {
  const min = Math.min(...units);
  const max = Math.max(...units);
  if (Math.abs(min - max) < 0.01) {
    return formatNumber(max, 1);
  }
  return `${formatNumber(min, 1)}-${formatNumber(max, 1)}`;
}

function buildDosePlan(tiers, vialMg) {
  const dosePlan = [];
  let usedMg = 0;

  tiers.forEach((tier, tierIndex) => {
    for (let index = 0; index < tier.count; index += 1) {
      if (usedMg + tier.doseMg > vialMg + 0.000001) {
        return;
      }
      dosePlan.push({ doseMg: tier.doseMg, tierIndex, plannedIndex: index });
      usedMg += tier.doseMg;
    }
  });

  return { dosePlan, usedMg, remainingMg: Math.max(0, vialMg - usedMg) };
}

function buildWaterOptions(vialMg, dosePlan, idealUnits, maxUnits) {
  const options = [];
  const doses = dosePlan.map((dose) => dose.doseMg);
  const maxDoseMg = Math.max(...doses);

  for (let ml = 0.5; ml <= 10.0001; ml += 0.5) {
    const concentration = vialMg / ml;
    const unitsByDose = doses.map((doseMg) => (doseMg / concentration) * 100);
    const maxUnitsForPlan = Math.max(...unitsByDose);
    const minUnitsForPlan = Math.min(...unitsByDose);

    if (maxUnitsForPlan > 100 || minUnitsForPlan < 2) {
      continue;
    }

    const typicalUnits = (maxDoseMg / concentration) * 100;
    const highVolumePenalty = maxUnitsForPlan > maxUnits ? (maxUnitsForPlan - maxUnits) * 3.5 : 0;
    const tinyPenalty = minUnitsForPlan < 10 ? (10 - minUnitsForPlan) * 1.5 : 0;
    const roundnessPenalty = unitsByDose.reduce((total, units) => {
      return total + Math.abs(units - Math.round(units / 5) * 5) * 0.2;
    }, 0);
    const score = Math.abs(typicalUnits - idealUnits) + highVolumePenalty + tinyPenalty + roundnessPenalty;

    options.push({
      ml,
      concentration,
      unitsByDose,
      maxUnitsForPlan,
      minUnitsForPlan,
      typicalUnits,
      score,
    });
  }

  return options.sort((a, b) => a.score - b.score || a.ml - b.ml);
}

// Compute everything derived for a single plan: dose sequence, best water
// option, dated shots, and cadence. Returns { empty: true } when no dose fits.
function computePlan(plan) {
  const vialMg = Math.max(0.01, plan.vialMg);
  const { dosePlan, usedMg, remainingMg } = buildDosePlan(plan.tiers, vialMg);

  if (dosePlan.length === 0) {
    return { empty: true };
  }

  const intervalDays = planIntervalDays(plan);
  const options = buildWaterOptions(vialMg, dosePlan, prefs.idealUnits, prefs.maxUnits);
  const recommended = options[0] || null;
  const startDate = parseStartDate(plan.startDate);
  const bacUseBy = addDays(startDate, prefs.bacWindowDays);
  const vialDurationDays = Math.max(0, Math.round((dosePlan.length - 1) * intervalDays));

  const shots = dosePlan.map((dose, index) => ({
    index,
    date: addDays(startDate, Math.round(index * intervalDays)),
    doseMg: dose.doseMg,
    tierIndex: dose.tierIndex,
    units: recommended ? recommended.unitsByDose[index] : null,
  }));

  return {
    empty: false,
    plan,
    vialMg,
    dosePlan,
    usedMg,
    remainingMg,
    intervalDays,
    options,
    recommended,
    startDate,
    bacUseBy,
    vialDurationDays,
    shots,
    lastShotDate: shots[shots.length - 1].date,
  };
}

// ---- Suggested doses / maximize -------------------------------------------

function buildDoseSuggestions(plan) {
  const info = lookupPeptide(plan.peptideName);
  const steps = new Set();
  if (info) {
    info.doseStepsMg.forEach((step) => steps.add(step));
  }
  // Always include whatever the user is currently dosing so it stays selectable.
  plan.tiers.forEach((tier) => steps.add(tier.doseMg));

  const vialMg = Math.max(0.01, plan.vialMg);
  const list = [...steps]
    .filter((dose) => dose > 0 && dose <= vialMg + 1e-6)
    .sort((a, b) => a - b)
    .map((dose) => {
      const count = Math.floor(vialMg / dose + 1e-6);
      const used = count * dose;
      return { dose, count, used, remainder: Math.max(0, vialMg - used) };
    })
    .filter((item) => item.count >= 1);

  if (list.length === 0) {
    return { list: [], best: null };
  }

  // "Maximize" = smallest leftover. On a tie, prefer the dose closest to this
  // peptide's typical dose (so NAD+ 500 mg picks 100 mg, not 25 mg x20).
  const targetDose = info ? info.defaultDoseMg : Math.max(...plan.tiers.map((tier) => tier.doseMg));
  const best = list.reduce((a, b) => {
    if (b.remainder < a.remainder - 1e-6) return b;
    if (Math.abs(b.remainder - a.remainder) <= 1e-6) {
      return Math.abs(b.dose - targetDose) < Math.abs(a.dose - targetDose) ? b : a;
    }
    return a;
  });

  return { list, best };
}

function applyDose(dose) {
  const plan = getActivePlan();
  const vialMg = Math.max(0.01, plan.vialMg);
  const count = Math.max(1, Math.floor(vialMg / dose + 1e-6));
  plan.tiers = [{ count, doseMg: dose }];
  refreshActivePlan({ tiers: true });
  scheduleSave();
}

function buildTitration() {
  const plan = getActivePlan();
  const info = lookupPeptide(plan.peptideName);
  if (!info) {
    return;
  }

  const vialMg = Math.max(0.01, plan.vialMg);
  const dosesPerStep = 4; // ~4 weeks at one shot per week before stepping up.
  const tiers = [];
  let remaining = vialMg;

  for (const dose of info.doseStepsMg) {
    if (dose > remaining + 1e-6) {
      break;
    }
    const fit = Math.min(dosesPerStep, Math.floor(remaining / dose + 1e-6));
    if (fit < 1) {
      break;
    }
    tiers.push({ count: fit, doseMg: dose });
    remaining -= fit * dose;
  }

  if (tiers.length === 0) {
    return;
  }

  plan.tiers = tiers;
  refreshActivePlan({ tiers: true });
  scheduleSave();
}

// ---- Rendering: reconstitution --------------------------------------------

function renderPeptideDatalist() {
  peptideList.innerHTML = Object.keys(PEPTIDE_LIBRARY)
    .map((name) => `<option value="${name}"></option>`)
    .join("");
}

function renderPlanChips() {
  planChips.innerHTML = "";
  plans.forEach((plan) => {
    const chip = document.createElement("div");
    chip.className = `plan-chip${plan.id === activePlanId ? " active" : ""}`;
    chip.dataset.id = plan.id;
    chip.innerHTML = `
      <button class="plan-chip-label" type="button" data-id="${plan.id}">
        ${plan.peptideName || "Untitled"}
      </button>
      ${plans.length > 1 ? `<button class="plan-chip-remove" type="button" data-remove="${plan.id}" aria-label="Remove peptide">×</button>` : ""}
    `;
    planChips.appendChild(chip);
  });
}

function renderPeptideMeta(plan) {
  const info = lookupPeptide(plan.peptideName);
  const hasName = Boolean((plan.peptideName || "").trim());

  if (info) {
    peptideNote.textContent = info.source === "ai" ? `AI suggestion · ${info.note}` : info.note;
    aiLookupBtn.classList.add("hidden");
  } else {
    peptideNote.textContent = hasName
      ? "Not in the library — enter dose tiers below, or look up typical dosing with AI."
      : "Custom peptide — enter your own dose tiers below.";
    aiLookupBtn.classList.toggle("hidden", !hasName);
  }

  vialChips.innerHTML = "";
  if (info) {
    info.commonVialsMg.forEach((mg) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `vial-chip${Math.abs(mg - plan.vialMg) < 1e-6 ? " active" : ""}`;
      chip.dataset.vial = String(mg);
      chip.textContent = `${formatNumber(mg, 0)} mg`;
      vialChips.appendChild(chip);
    });
  }
}

function renderSuggestions(plan) {
  const { list, best } = buildDoseSuggestions(plan);
  suggestionList.innerHTML = "";

  if (list.length === 0) {
    suggestionList.innerHTML = `<p class="empty-hint">Enter a vial amount to see dose suggestions.</p>`;
  } else {
    list.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      const isBest = best && item.dose === best.dose;
      button.className = `suggestion${isBest ? " best" : ""}`;
      button.dataset.dose = String(item.dose);
      const leftover = item.remainder > 0.001 ? `${formatNumber(item.remainder, 3)} mg left` : "no waste";
      button.innerHTML = `
        <strong>${formatNumber(item.dose, 3)} mg</strong>
        <span>${item.count} ${item.count === 1 ? "dose" : "doses"}</span>
        <small>${leftover}</small>
        ${isBest ? `<span class="suggestion-tag">Best fill</span>` : ""}
      `;
      suggestionList.appendChild(button);
    });
  }

  const info = lookupPeptide(plan.peptideName);
  titrationBtn.classList.toggle("hidden", !(info && info.titrating));
}

function renderTiers(plan) {
  tierList.innerHTML = "";
  const dpw = dosesPerWeek(plan);
  let doseCursor = 0;

  plan.tiers.forEach((tier, index) => {
    // Week range this phase occupies, by dose position (a week holds `dpw` doses).
    const startWeek = Math.ceil((doseCursor + 1) / dpw);
    const endWeek = Math.ceil((doseCursor + tier.count) / dpw);
    doseCursor += tier.count;

    const weeksValue = formatNumber(tier.count / dpw, 1);
    const totalMg = formatNumber(tier.count * tier.doseMg, 3);
    const rangeLabel = startWeek === endWeek ? `Week ${startWeek}` : `Weeks ${startWeek}–${endWeek}`;
    const doseLabel = `${tier.count} ${tier.count === 1 ? "dose" : "doses"}`;

    const row = document.createElement("div");
    row.className = "tier-row";
    row.dataset.index = String(index);
    row.innerHTML = `
      <div class="tier-main">
        <div class="tier-index">${index + 1}</div>
        <label class="field">
          <span>Weeks</span>
          <input class="tier-weeks" type="number" min="0.5" step="0.5" value="${weeksValue}" />
        </label>
        <label class="field">
          <span>mg per dose</span>
          <input class="tier-dose" type="number" min="0.001" step="0.001" value="${tier.doseMg}" />
        </label>
        <button class="icon-button tier-remove" type="button" aria-label="Remove phase">×</button>
      </div>
      <div class="tier-caption">${rangeLabel} · ${doseLabel} · ${totalMg} mg total</div>
    `;
    tierList.appendChild(row);
  });

  tierList.querySelectorAll(".tier-remove").forEach((button) => {
    button.disabled = plan.tiers.length === 1;
  });
}

function writePlanToForm(plan) {
  planInputs.peptideName.value = plan.peptideName;
  planInputs.vialMg.value = plan.vialMg;
  planInputs.startDate.value = plan.startDate;
  planInputs.shotsPerWeek.value = plan.shotsPerWeek;
  planInputs.everyDays.value = plan.everyDays;

  modeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === plan.scheduleMode);
  });
  scheduleFields.forEach((field) => {
    field.classList.toggle("hidden", field.dataset.for !== plan.scheduleMode);
  });
}

function renderOptions(result) {
  output.optionList.innerHTML = "";
  result.options.slice(0, 5).forEach((option) => {
    const row = document.createElement("div");
    row.className = `option${option === result.recommended ? " recommended" : ""}`;
    const status = option.maxUnitsForPlan <= prefs.maxUnits ? "good" : "warn";
    const label = option === result.recommended
      ? "Best fit"
      : option.maxUnitsForPlan > prefs.maxUnits ? "High volume" : "Option";
    row.innerHTML = `
      <strong>${formatNumber(option.ml, 1)} mL</strong>
      <div>
        <p>${unitRange(option.unitsByDose)} units across ${result.dosePlan.length} planned shots</p>
        <p>${formatNumber(option.concentration, 1)} mg/mL concentration</p>
      </div>
      <span class="pill ${status}">${label}</span>
    `;
    output.optionList.appendChild(row);
  });
}

function renderShotList(target, shots, peptideName) {
  target.innerHTML = "";
  shots.forEach((shot) => {
    const row = document.createElement("div");
    row.className = "shot";
    const tag = peptideName ? `<span class="shot-tag">${peptideName}</span>` : "";
    row.innerHTML = `
      <div class="shot-number">${shot.index + 1}</div>
      <div>
        <div class="shot-date">${formatDate(shot.date)}</div>
        <div class="shot-meta">${tag}${formatNumber(shot.doseMg, 3)} mg${peptideName ? "" : ` · phase ${shot.tierIndex + 1}`}</div>
      </div>
      <span class="pill">${shot.units != null ? `${formatNumber(shot.units, 1)} units` : "-"}</span>
    `;
    target.appendChild(row);
  });
}

function renderReconEmpty() {
  output.recommendedMl.textContent = "-";
  output.recommendedUnits.textContent = "-";
  output.recommendedSummary.textContent = "Add at least one dose tier that fits inside the vial amount.";
  output.vialLasts.textContent = "-";
  output.totalShots.textContent = "0";
  output.concentration.textContent = "-";
  output.bacUseBy.textContent = "-";
  output.optionList.innerHTML = "";
  output.scheduleList.innerHTML = "";
  output.scheduleSummary.textContent = "No schedule to preview yet.";
}

function renderReconResults(plan) {
  const result = computePlan(plan);

  if (result.empty) {
    renderReconEmpty();
    return;
  }

  if (!result.recommended) {
    output.recommendedMl.textContent = "-";
    output.recommendedUnits.textContent = "-";
    output.recommendedSummary.textContent =
      "No water amount keeps this plan within a 100-unit syringe. Lower the dose or raise the vial water amount.";
    output.optionList.innerHTML = "";
    output.scheduleList.innerHTML = "";
    return;
  }

  const recommended = result.recommended;
  const vialEndsBeforeBac = result.vialDurationDays <= prefs.bacWindowDays;
  const waterUsedPercent = (recommended.ml / Math.max(1, prefs.bacBottleMl)) * 100;
  const remainingNote = result.remainingMg > 0.001
    ? ` ${formatNumber(result.remainingMg, 3)} mg remains unplanned.`
    : "";
  const summary = `${scheduleLabel(plan)}; vial ${vialEndsBeforeBac ? "finishes inside" : "runs past"} the ${formatNumber(prefs.bacWindowDays, 0)}-day BAC window. Uses ${formatNumber(waterUsedPercent, 1)}% of a ${formatNumber(prefs.bacBottleMl, 1)} mL BAC bottle and ${formatNumber(result.usedMg, 3)} mg of peptide.`;

  output.recommendedMl.textContent = `${formatNumber(recommended.ml, 1)} mL`;
  output.recommendedUnits.textContent = unitRange(recommended.unitsByDose);
  output.recommendedSummary.textContent =
    `Add ${formatNumber(recommended.ml, 1)} mL BAC water to ${plan.peptideName || "the vial"} for ${tierSummary(result.dosePlan)}.${remainingNote}`;
  output.vialLasts.textContent = `${formatNumber(result.vialDurationDays, 0)} days`;
  output.totalShots.textContent = formatNumber(result.dosePlan.length, 0);
  output.concentration.textContent = `${formatNumber(recommended.concentration, 1)} mg/mL`;
  output.bacUseBy.textContent = formatDate(result.bacUseBy);
  output.scheduleSummary.textContent = summary;

  renderOptions(result);
  renderShotList(output.scheduleList, result.shots.slice(0, Math.min(prefs.previewCount, result.shots.length)), null);
}

// ---- Rendering: combined scheduling tab -----------------------------------

function renderScheduleTab() {
  const computed = plans
    .map((plan) => ({ plan, result: computePlan(plan) }))
    .filter((entry) => !entry.result.empty && entry.result.recommended);

  output.scheduleTabUnits.textContent = String(computed.length);

  // Per-peptide summary rows.
  output.planSummaryList.innerHTML = "";
  if (computed.length === 0) {
    output.planSummaryList.innerHTML = `<p class="empty-hint">No peptide has a valid plan yet.</p>`;
  }
  computed.forEach(({ plan, result }) => {
    const row = document.createElement("div");
    row.className = "plan-summary";
    row.innerHTML = `
      <div>
        <div class="plan-summary-name">${plan.peptideName || "Untitled"}</div>
        <div class="plan-summary-meta">${tierSummary(result.dosePlan)} · ${scheduleLabel(plan)}</div>
      </div>
      <div class="plan-summary-stat">
        <strong>${formatNumber(recommendedMlAvg(result), 1)} mL</strong>
        <small>${unitRange(result.recommended.unitsByDose)} units</small>
      </div>
      <div class="plan-summary-stat">
        <strong>${formatNumber(result.dosePlan.length, 0)} shots</strong>
        <small>ends ${formatDate(result.lastShotDate)}</small>
      </div>
    `;
    output.planSummaryList.appendChild(row);
  });

  // Merge all shots across peptides into one dated timeline.
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

  if (merged.length === 0) {
    output.scheduleTabTitle.textContent = "0 shots";
    output.scheduleTabSummary.textContent = "Add a peptide plan to build a schedule.";
    output.scheduleTabNext.textContent = "-";
    output.scheduleTabLastShot.textContent = "-";
    output.scheduleTabSpan.textContent = "-";
    output.scheduleTabUseBy.textContent = "-";
    output.scheduleTabMeta.textContent = "All planned injections, merged in date order.";
    output.scheduleTabList.innerHTML = "";
    return;
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const nextShot = merged.find((shot) => shot.date >= today) || merged[0];
  const firstDate = merged[0].date;
  const lastDate = merged[merged.length - 1].date;
  const spanDays = Math.round((lastDate - firstDate) / 86400000);
  const soonestUseBy = computed
    .map((entry) => entry.result.bacUseBy)
    .sort((a, b) => a - b)[0];

  output.scheduleTabTitle.textContent = `${formatNumber(merged.length, 0)} shots`;
  output.scheduleTabSummary.textContent =
    `${computed.length} ${computed.length === 1 ? "peptide" : "peptides"} across ${formatNumber(spanDays, 0)} days.`;
  output.scheduleTabNext.textContent = formatDate(nextShot.date);
  output.scheduleTabLastShot.textContent = formatDate(lastDate);
  output.scheduleTabSpan.textContent = `${formatNumber(spanDays, 0)} days`;
  output.scheduleTabUseBy.textContent = formatDate(soonestUseBy);
  output.scheduleTabMeta.textContent =
    `${formatNumber(merged.length, 0)} injections across ${computed.map((e) => e.plan.peptideName || "Untitled").join(", ")}.`;

  output.scheduleTabList.innerHTML = "";
  merged.forEach((shot) => {
    const row = document.createElement("div");
    row.className = "shot";
    row.innerHTML = `
      <div class="shot-number">${shot.index + 1}</div>
      <div>
        <div class="shot-date">${formatDate(shot.date)}</div>
        <div class="shot-meta"><span class="shot-tag">${shot.peptideName}</span>${formatNumber(shot.doseMg, 3)} mg</div>
      </div>
      <span class="pill">${shot.units != null ? `${formatNumber(shot.units, 1)} units` : "-"}</span>
    `;
    output.scheduleTabList.appendChild(row);
  });
}

function recommendedMlAvg(result) {
  return result.recommended ? result.recommended.ml : 0;
}

// ---- Master refresh -------------------------------------------------------

function refreshActivePlan(opts = {}) {
  const plan = getActivePlan();
  if (!plan) {
    return;
  }
  if (opts.chips !== false) {
    renderPlanChips();
  }
  if (opts.form !== false) {
    writePlanToForm(plan);
  }
  renderPeptideMeta(plan);
  renderSuggestions(plan);
  if (opts.tiers || opts.form !== false) {
    renderTiers(plan);
  }
  renderReconResults(plan);
  renderScheduleTab();
}

// ---- Persistence ----------------------------------------------------------

function setSaveStatus(text) {
  output.saveStatus.textContent = text;
}

function getPlannerState() {
  return {
    version: 2,
    activePlanId,
    activeTab,
    prefs,
    plans,
  };
}

function applyPlannerState(state) {
  if (!state) {
    return false;
  }

  // Migrate v1 (single plan stored in `fields` + `tiers`).
  if (state.version !== 2 && state.fields) {
    const f = state.fields;
    prefs = {
      previewCount: numberValue(f.previewCount, 8),
      maxUnits: numberValue(f.maxUnits, 70),
      idealUnits: numberValue(f.idealUnits, 60),
      bacBottleMl: numberValue(f.bacBottleMl, 30),
      bacWindowDays: numberValue(f.bacWindowDays, 35),
    };
    plans = [createPlan({
      peptideName: f.peptideName || "NAD+",
      vialMg: numberValue(f.vialMg, 500),
      startDate: f.startDate || dateInputValue(new Date()),
      scheduleMode: state.scheduleMode === "interval" ? "interval" : "weekly",
      shotsPerWeek: numberValue(f.shotsPerWeek, 2),
      everyDays: numberValue(f.everyDays, 3),
      tiers: Array.isArray(state.tiers) && state.tiers.length ? normalizeTiers(state.tiers) : undefined,
    })];
    activePlanId = plans[0].id;
    return true;
  }

  if (!Array.isArray(state.plans) || state.plans.length === 0) {
    return false;
  }

  prefs = { ...prefs, ...(state.prefs || {}) };
  plans = state.plans.map((plan) => ({
    ...createPlan(),
    ...plan,
    id: plan.id || uid(),
    tiers: normalizeTiers(plan.tiers),
  }));
  activePlanId = plans.some((plan) => plan.id === state.activePlanId)
    ? state.activePlanId
    : plans[0].id;
  activeTab = state.activeTab === "schedule" ? "schedule" : "reconstitution";
  return true;
}

function normalizeTiers(tiers) {
  const list = (Array.isArray(tiers) ? tiers : [])
    .map((tier) => ({
      count: Math.max(1, Math.round(numberValue(tier.count, 1))),
      doseMg: Math.max(0.001, numberValue(tier.doseMg, 1)),
    }));
  return list.length ? list : [{ count: 5, doseMg: 100 }];
}

async function loadPlanner() {
  try {
    const response = await fetch("/api/planner/current");
    if (response.status === 404) {
      setSaveStatus("Ready to save");
      persistenceReady = true;
      return;
    }
    if (!response.ok) {
      throw new Error(`Load failed: ${response.status}`);
    }
    const record = await response.json();
    if (record && record.payload && applyPlannerState(record.payload)) {
      setSaveStatus("Loaded");
    } else {
      setSaveStatus("Ready to save");
    }
    persistenceReady = true;
    writePrefsToForm();
    setActiveTab(activeTab);
    refreshActivePlan();
  } catch (error) {
    persistenceReady = false;
    setSaveStatus("Browser only");
  }
}

async function savePlanner() {
  if (!persistenceReady) {
    return;
  }
  window.clearTimeout(saveTimer);
  savePending = false;
  setSaveStatus("Saving…");
  try {
    const response = await fetch("/api/planner/current", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(getPlannerState()),
    });
    if (!response.ok) {
      throw new Error(`Save failed: ${response.status}`);
    }
    setSaveStatus("Saved");
  } catch (error) {
    savePending = true; // keep it dirty so a later flush retries
    setSaveStatus("Save failed");
  }
}

function scheduleSave() {
  if (!persistenceReady) {
    return;
  }
  savePending = true;
  setSaveStatus("Saving…");
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(savePlanner, 450);
}

// Flush any pending change immediately — used when the page is hidden or
// closed so a debounced edit isn't lost. keepalive lets it finish during unload.
function flushSave() {
  if (!persistenceReady || !savePending) {
    return;
  }
  window.clearTimeout(saveTimer);
  savePending = false;
  fetch("/api/planner/current", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(getPlannerState()),
    keepalive: true,
  }).catch(() => {
    savePending = true;
  });
}

window.addEventListener("pagehide", flushSave);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushSave();
  }
});

// ---- Form wiring ----------------------------------------------------------

function writePrefsToForm() {
  prefInputs.previewCount.value = prefs.previewCount;
  prefInputs.maxUnits.value = prefs.maxUnits;
  prefInputs.idealUnits.value = prefs.idealUnits;
  prefInputs.bacBottleMl.value = prefs.bacBottleMl;
  prefInputs.bacWindowDays.value = prefs.bacWindowDays;
}

function readFormIntoState() {
  const plan = getActivePlan();
  if (plan) {
    plan.peptideName = planInputs.peptideName.value;
    plan.vialMg = Math.max(0.01, numberValue(planInputs.vialMg, plan.vialMg));
    plan.startDate = planInputs.startDate.value || plan.startDate;
    plan.shotsPerWeek = Math.max(0.1, numberValue(planInputs.shotsPerWeek, plan.shotsPerWeek));
    plan.everyDays = Math.max(1, numberValue(planInputs.everyDays, plan.everyDays));
  }
  prefs.previewCount = Math.max(3, Math.min(24, Math.round(numberValue(prefInputs.previewCount, 8))));
  prefs.maxUnits = Math.max(1, numberValue(prefInputs.maxUnits, 70));
  prefs.idealUnits = Math.max(1, numberValue(prefInputs.idealUnits, 60));
  prefs.bacBottleMl = Math.max(1, numberValue(prefInputs.bacBottleMl, 30));
  prefs.bacWindowDays = Math.max(1, numberValue(prefInputs.bacWindowDays, 35));
}

function syncTiersFromDom() {
  const plan = getActivePlan();
  if (!plan) {
    return;
  }
  const dpw = dosesPerWeek(plan);
  plan.tiers = Array.from(tierList.querySelectorAll(".tier-row")).map((row) => ({
    // Weeks entered in the UI are converted to a dose count using the cadence.
    count: Math.max(1, Math.round(numberValue(row.querySelector(".tier-weeks"), 1) * dpw)),
    doseMg: Math.max(0.001, numberValue(row.querySelector(".tier-dose"), 1)),
  }));
}

// When the peptide name matches a library entry, adopt its cadence/vial defaults
// (only if the user hasn't customized the vial away from a known value).
function maybeApplyPeptideDefaults(plan, previousName) {
  const info = lookupPeptide(plan.peptideName);
  if (!info || plan.peptideName === previousName) {
    return;
  }
  plan.scheduleMode = info.schedule.mode;
  if (info.schedule.shotsPerWeek) {
    plan.shotsPerWeek = info.schedule.shotsPerWeek;
  }
  if (info.schedule.everyDays) {
    plan.everyDays = info.schedule.everyDays;
  }
}

form.addEventListener("input", (event) => {
  const target = event.target;
  const isTierEdit = target.classList.contains("tier-weeks") || target.classList.contains("tier-dose");
  const isPeptide = target === planInputs.peptideName;
  const isCadence = target === planInputs.shotsPerWeek || target === planInputs.everyDays;
  const plan = getActivePlan();
  const previousName = plan ? plan.peptideName : "";

  readFormIntoState();
  if (isTierEdit) {
    syncTiersFromDom();
  }

  if (isPeptide && plan) {
    maybeApplyPeptideDefaults(plan, previousName);
  }

  // Don't re-render tier inputs while editing them (preserves the caret), but do
  // re-render when the cadence changes so week ranges/doses recompute.
  refreshActivePlan({ tiers: isCadence, form: isPeptide });
  if (isPeptide) {
    // writePlanToForm reset the peptide value caret; restore typed value.
    planInputs.peptideName.value = plan.peptideName;
  }
  scheduleSave();
});

tierList.addEventListener("click", (event) => {
  const removeButton = event.target.closest(".tier-remove");
  const plan = getActivePlan();
  if (!removeButton || !plan || plan.tiers.length === 1) {
    return;
  }
  const row = removeButton.closest(".tier-row");
  plan.tiers.splice(Number(row.dataset.index), 1);
  refreshActivePlan({ tiers: true });
  scheduleSave();
});

addTierButton.addEventListener("click", () => {
  const plan = getActivePlan();
  if (!plan) {
    return;
  }
  const last = plan.tiers[plan.tiers.length - 1] || { doseMg: 100 };
  // Default a new phase to about one week of doses at the current cadence.
  const weekDoses = Math.max(1, Math.round(dosesPerWeek(plan)));
  plan.tiers.push({ count: weekDoses, doseMg: last.doseMg });
  refreshActivePlan({ tiers: true });
  scheduleSave();
});

suggestionList.addEventListener("click", (event) => {
  const button = event.target.closest(".suggestion");
  if (!button) {
    return;
  }
  applyDose(numberValue(button.dataset.dose, 0));
});

maximizeBtn.addEventListener("click", () => {
  const { best } = buildDoseSuggestions(getActivePlan());
  if (best) {
    applyDose(best.dose);
  }
});

titrationBtn.addEventListener("click", buildTitration);

aiLookupBtn.addEventListener("click", async () => {
  const plan = getActivePlan();
  const name = (plan.peptideName || "").trim();
  if (!name) {
    return;
  }

  aiLookupBtn.disabled = true;
  const originalLabel = aiLookupBtn.textContent;
  aiLookupBtn.textContent = "Looking up…";

  try {
    const response = await fetch(`/api/peptide-info?name=${encodeURIComponent(name)}`);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Lookup failed (${response.status}).`);
    }

    aiTried.add(name.toLowerCase());

    if (!data.known || !data.info) {
      peptideNote.textContent = `No reliable dosing found for "${name}". Enter dose tiers manually.`;
      return;
    }

    aiLibrary[data.name] = data.info;
    plan.peptideName = data.name;
    maybeApplyPeptideDefaults(plan, ""); // force-adopt the fetched cadence
    refreshActivePlan({ form: true });
    scheduleSave();
  } catch (error) {
    peptideNote.textContent = error.message || "AI lookup failed.";
  } finally {
    aiLookupBtn.disabled = false;
    aiLookupBtn.textContent = originalLabel;
  }
});

vialChips.addEventListener("click", (event) => {
  const chip = event.target.closest(".vial-chip");
  const plan = getActivePlan();
  if (!chip || !plan) {
    return;
  }
  plan.vialMg = numberValue(chip.dataset.vial, plan.vialMg);
  refreshActivePlan({ form: true });
  scheduleSave();
});

planChips.addEventListener("click", (event) => {
  const removeButton = event.target.closest(".plan-chip-remove");
  if (removeButton) {
    const id = removeButton.dataset.remove;
    plans = plans.filter((plan) => plan.id !== id);
    if (activePlanId === id) {
      activePlanId = plans[0].id;
    }
    refreshActivePlan({ form: true });
    scheduleSave();
    return;
  }

  const label = event.target.closest(".plan-chip-label");
  if (label) {
    activePlanId = label.dataset.id;
    refreshActivePlan({ form: true });
    scheduleSave();
  }
});

addPlanButton.addEventListener("click", () => {
  const plan = createPlan({ peptideName: "Tirzepatide", vialMg: 30, tiers: [{ count: 12, doseMg: 2.5 }], shotsPerWeek: 1 });
  maybeApplyPeptideDefaults(plan, "");
  plans.push(plan);
  activePlanId = plan.id;
  refreshActivePlan({ form: true });
  scheduleSave();
});

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const plan = getActivePlan();
    if (!plan) {
      return;
    }
    plan.scheduleMode = button.dataset.mode;
    refreshActivePlan({ form: true });
    scheduleSave();
  });
});

appTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setActiveTab(tab.dataset.tab);
    scheduleSave();
  });
});

themeToggle.addEventListener("click", () => {
  setTheme(root.classList.contains("dark") ? "light" : "dark");
});

function setTheme(theme) {
  root.classList.toggle("dark", theme === "dark");
  themeLabel.textContent = theme === "dark" ? "Light" : "Dark";
  localStorage.setItem("peptide-planner-theme", theme);
}

function setActiveTab(tabName) {
  activeTab = tabName;
  appTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabName));
  tabPanels.forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === tabName));
}

// ---- Boot -----------------------------------------------------------------

plans = [createPlan()];
activePlanId = plans[0].id;

renderPeptideDatalist();
setTheme(localStorage.getItem("peptide-planner-theme") || "light");
writePrefsToForm();
setActiveTab("reconstitution");
refreshActivePlan({ form: true });
loadPlanner();
