// All DOM rendering. Functions read from `store` and write to the page; they
// never mutate state. Form writing is split into narrow helpers so that typing
// in one input never rewrites (and resets the caret of) another.

import {
  formatNumber,
  formatRange,
  formatDate,
  startOfToday,
  daysBetween,
} from "./format.js";
import {
  dosesPerWeek,
  scheduleLabel,
  tierDoseCount,
  computePlan,
  computeAll,
  mergeSchedule,
  summarizeDoses,
} from "./calc.js";
import { lookupPeptide, PEPTIDE_NAMES } from "./peptides.js";
import { getActivePlan } from "./state.js";

const $ = (id) => document.getElementById(id);
const mg = (value) => formatNumber(value, 3);
const iconX = `
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
`;

const el = {
  saveStatus: $("saveStatus"),
  planChips: $("planChips"),
  peptideList: $("peptideList"),
  peptideName: $("peptideName"),
  vialMg: $("vialMg"),
  startDate: $("startDate"),
  shotsPerWeek: $("shotsPerWeek"),
  everyDays: $("everyDays"),
  peptideNote: $("peptideNote"),
  vialChips: $("vialChips"),
  aiLookupBtn: $("aiLookupBtn"),
  tierList: $("tierList"),
  // recon outputs
  recommendedMl: $("recommendedMl"),
  recommendedSummary: $("recommendedSummary"),
  recommendedPerWeek: $("recommendedPerWeek"),
  recommendedUnits: $("recommendedUnits"),
  vialLasts: $("vialLasts"),
  totalShots: $("totalShots"),
  concentration: $("concentration"),
  bacUseBy: $("bacUseBy"),
  scheduleList: $("scheduleList"),
  scheduleSummary: $("scheduleSummary"),
  // schedule tab
  scheduleTabTitle: $("scheduleTabTitle"),
  scheduleTabSummary: $("scheduleTabSummary"),
  scheduleTabUnits: $("scheduleTabUnits"),
  scheduleTabNext: $("scheduleTabNext"),
  scheduleTabLastShot: $("scheduleTabLastShot"),
  scheduleTabSpan: $("scheduleTabSpan"),
  scheduleTabUseBy: $("scheduleTabUseBy"),
  scheduleTabMeta: $("scheduleTabMeta"),
  scheduleTabList: $("scheduleTabList"),
  planSummaryList: $("planSummaryList"),
};

export function setSaveStatus(text) {
  el.saveStatus.textContent = text;
}

export function renderPeptideDatalist() {
  el.peptideList.innerHTML = PEPTIDE_NAMES.map((name) => `<option value="${name}"></option>`).join("");
}

// ---- Form writers (targeted, never blanket) -------------------------------

// Full plan -> inputs. Only call when no field is being edited (plan switch,
// load, vial-chip click, AI lookup).
export function writeFormValues(plan) {
  el.peptideName.value = plan.peptideName;
  el.vialMg.value = plan.vialMg;
  el.startDate.value = plan.startDate;
  el.shotsPerWeek.value = plan.shotsPerWeek;
  el.everyDays.value = plan.everyDays;
}

// Schedule mode + cadence only — safe to call while the peptide-name field is
// focused (it doesn't touch that input).
export function writeScheduleControls(plan) {
  document.querySelectorAll(".segmented-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === plan.scheduleMode);
  });
  document.querySelectorAll(".schedule-field").forEach((field) => {
    field.classList.toggle("hidden", field.dataset.for !== plan.scheduleMode);
  });
  el.shotsPerWeek.value = plan.shotsPerWeek;
  el.everyDays.value = plan.everyDays;
}

export function writePrefs(prefs) {
  $("previewCount").value = prefs.previewCount;
  $("maxUnits").value = prefs.maxUnits;
  $("idealUnits").value = prefs.idealUnits;
  $("bacBottleMl").value = prefs.bacBottleMl;
  $("bacWindowDays").value = prefs.bacWindowDays;
}

// ---- Tier rows ------------------------------------------------------------

// Rebuild the phase rows. Only call on structural change (add/remove, switch,
// load) — captions update in place during typing via renderOutputs.
export function renderTiers(plan) {
  el.tierList.innerHTML = "";
  plan.tiers.forEach((tier, index) => {
    const row = document.createElement("div");
    row.className = "tier-row";
    row.dataset.index = String(index);
    row.innerHTML = `
      <div class="tier-main">
        <div class="tier-index">${index + 1}</div>
        <label class="field">
          <span>Weeks</span>
          <input class="tier-weeks" type="number" min="0.5" step="0.5" value="${tier.weeks}" />
        </label>
        <label class="field">
          <span>mg per dose</span>
          <input class="tier-dose" type="number" min="0.001" step="0.001" value="${tier.doseMg}" />
        </label>
        <button class="button button--icon icon-button tier-remove" type="button" aria-label="Remove phase"${plan.tiers.length === 1 ? " disabled" : ""}>${iconX}</button>
      </div>
      <div class="tier-caption"></div>
    `;
    el.tierList.appendChild(row);
  });
  updateTierCaptions(plan);
}

// Recompute the "Weeks 1–2 · 5 doses · 500 mg" caption for each phase without
// rebuilding the inputs.
function updateTierCaptions(plan) {
  const dpw = dosesPerWeek(plan);
  let doseCursor = 0;
  el.tierList.querySelectorAll(".tier-row").forEach((row, index) => {
    const tier = plan.tiers[index];
    if (!tier) {
      return;
    }
    const count = tierDoseCount(tier, plan);
    const startWeek = Math.ceil((doseCursor + 1) / dpw);
    const endWeek = Math.ceil((doseCursor + count) / dpw);
    doseCursor += count;
    const rangeLabel = startWeek === endWeek ? `Week ${startWeek}` : `Weeks ${startWeek}–${endWeek}`;
    const doseLabel = `${count} ${count === 1 ? "dose" : "doses"}`;
    row.querySelector(".tier-caption").textContent =
      `${rangeLabel} · ${doseLabel} · ${mg(count * tier.doseMg)} mg total`;
  });
}

// ---- Peptide meta ---------------------------------------------------------

function renderPeptideMeta(store, plan) {
  const info = lookupPeptide(plan.peptideName, store.aiLibrary);
  const hasName = Boolean((plan.peptideName || "").trim());

  if (info) {
    el.peptideNote.textContent = info.source === "ai" ? `AI suggestion · ${info.note}` : info.note;
    el.aiLookupBtn.classList.add("hidden");
  } else {
    el.peptideNote.textContent = hasName
      ? "Not in the library — enter dose phases below, or look up typical dosing with AI."
      : "Custom peptide — enter your own dose phases below.";
    el.aiLookupBtn.classList.toggle("hidden", !hasName);
  }

  el.vialChips.innerHTML = "";
  if (info) {
    info.commonVialsMg.forEach((value) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `chip vial-chip${Math.abs(value - plan.vialMg) < 1e-6 ? " active chip--active" : ""}`;
      chip.dataset.vial = String(value);
      chip.textContent = `${formatNumber(value, 0)} mg`;
      el.vialChips.appendChild(chip);
    });
  }
}

// ---- Plan switcher --------------------------------------------------------

function renderPlanChips(store) {
  el.planChips.innerHTML = "";
  store.plans.forEach((plan) => {
    const chip = document.createElement("div");
    chip.className = `chip plan-chip${plan.id === store.activePlanId ? " active chip--active" : ""}`;
    chip.dataset.id = plan.id;
    chip.innerHTML = `
      <button class="plan-chip-label" type="button" data-id="${plan.id}">${plan.peptideName || "Untitled"}</button>
      ${store.plans.length > 1 ? `<button class="plan-chip-remove" type="button" data-remove="${plan.id}" aria-label="Remove peptide">${iconX}</button>` : ""}
    `;
    el.planChips.appendChild(chip);
  });
}

// ---- Reconstitution results ----------------------------------------------

function renderReconEmpty(message) {
  el.recommendedMl.textContent = "-";
  el.recommendedUnits.textContent = "-";
  el.recommendedSummary.textContent = message;
  el.recommendedPerWeek.textContent = "";
  el.vialLasts.textContent = "-";
  el.totalShots.textContent = "0";
  el.concentration.textContent = "-";
  el.bacUseBy.textContent = "-";
  el.scheduleList.innerHTML = "";
  el.scheduleSummary.textContent = "No schedule to preview yet.";
}

function renderShotList(target, shots, { showTag } = {}) {
  target.innerHTML = "";
  shots.forEach((shot) => {
    const meta = showTag
      ? `<span class="shot-tag">${shot.peptideName}</span>${mg(shot.doseMg)} mg`
      : `${mg(shot.doseMg)} mg · phase ${shot.tierIndex + 1}`;
    const row = document.createElement("div");
    row.className = "shot";
    row.innerHTML = `
      <div class="shot-number">${shot.index + 1}</div>
      <div>
        <div class="shot-date">${formatDate(shot.date)}</div>
        <div class="shot-meta">${meta}</div>
      </div>
      <span class="pill">${shot.units != null ? `${formatNumber(shot.units, 1)} units` : "-"}</span>
    `;
    target.appendChild(row);
  });
}

function renderRecon(store, plan) {
  const result = computePlan(plan, store.prefs);

  if (result.empty) {
    renderReconEmpty("Add at least one dose phase to build a plan.");
    return;
  }
  if (!result.recommended) {
    renderReconEmpty(
      "No water amount keeps this plan within a 100-unit syringe. Lower the dose or raise the vial amount.",
    );
    return;
  }

  const { prefs } = store;
  const r = result.recommended;
  const planWeeks = result.planDurationDays / 7;
  const vialEndsBeforeBac = result.vialDurationDays <= prefs.bacWindowDays;
  const vialsLabel = result.vialsNeeded === 1 ? "1 vial" : `${result.vialsNeeded} vials`;
  const vialsNote =
    result.vialsNeeded > 1
      ? ` Reconstitute each of the ${result.vialsNeeded} vials the same way.`
      : result.lastVialLeftover > 0.001
        ? ` ${mg(result.lastVialLeftover)} mg left unused in the vial.`
        : "";

  const dpw = dosesPerWeek(plan);
  const distinctDoses = [...new Set(result.doses.map((d) => d.doseMg))].sort((a, b) => a - b);
  const mgPerWeek = distinctDoses.map((dose) => dose * dpw);
  const unitsPerWeek = distinctDoses.map((dose) => (dose / r.concentration) * 100 * dpw);

  el.recommendedMl.textContent = `${formatNumber(r.ml, 1)} mL`;
  el.recommendedUnits.textContent = formatRange(r.unitsByDose);
  el.recommendedSummary.textContent =
    `Add ${formatNumber(r.ml, 1)} mL BAC water to ${plan.peptideName || "the vial"} for ${summarizeDoses(result.doses, mg)}.${vialsNote}`;
  el.recommendedPerWeek.textContent =
    `≈ ${formatRange(mgPerWeek, 3)} mg / week · ${formatRange(unitsPerWeek, 0)} units / week (${formatNumber(dpw, 1)}x weekly)`;
  el.vialLasts.textContent = `${formatNumber(result.vialDurationDays, 0)} days`;
  el.totalShots.textContent = formatNumber(result.doses.length, 0);
  el.concentration.textContent = `${formatNumber(r.concentration, 1)} mg/mL`;
  el.bacUseBy.textContent = formatDate(result.bacUseBy);
  el.scheduleSummary.textContent =
    `${scheduleLabel(plan)}; ${result.doses.length} shots over ~${formatNumber(planWeeks, 0)} weeks. Needs ${vialsLabel} (${mg(result.totalMg)} mg total); each vial ${vialEndsBeforeBac ? "finishes inside" : "runs past"} the ${prefs.bacWindowDays}-day BAC window.`;

  renderShotList(el.scheduleList, result.shots.slice(0, Math.min(prefs.previewCount, result.shots.length)));
}

// ---- Combined schedule tab ------------------------------------------------

function renderScheduleTab(store) {
  const computed = computeAll(store.plans, store.prefs);
  el.scheduleTabUnits.textContent = String(computed.length);

  el.planSummaryList.innerHTML = "";
  if (computed.length === 0) {
    el.planSummaryList.innerHTML = `<p class="empty-hint">No peptide has a valid plan yet.</p>`;
  }
  computed.forEach(({ plan, result }) => {
    const vialsLabel = result.vialsNeeded === 1 ? "1 vial" : `${result.vialsNeeded} vials`;
    const row = document.createElement("div");
    row.className = "plan-summary";
    row.innerHTML = `
      <div>
        <div class="plan-summary-name">${plan.peptideName || "Untitled"}</div>
        <div class="plan-summary-meta">${summarizeDoses(result.doses, mg)} · ${scheduleLabel(plan)}</div>
      </div>
      <div class="plan-summary-stat">
        <strong>${mg(result.totalMg)} mg</strong>
        <small>${vialsLabel}</small>
      </div>
      <div class="plan-summary-stat">
        <strong>${formatNumber(result.recommended.ml, 1)} mL</strong>
        <small>${formatRange(result.recommended.unitsByDose)} units</small>
      </div>
      <div class="plan-summary-stat">
        <strong>${result.doses.length} shots</strong>
        <small>ends ${formatDate(result.lastShotDate)}</small>
      </div>
    `;
    el.planSummaryList.appendChild(row);
  });

  const merged = mergeSchedule(computed);
  if (merged.length === 0) {
    el.scheduleTabTitle.textContent = "0 shots";
    el.scheduleTabSummary.textContent = "Add a peptide plan to build a schedule.";
    el.scheduleTabNext.textContent = "-";
    el.scheduleTabLastShot.textContent = "-";
    el.scheduleTabSpan.textContent = "-";
    el.scheduleTabUseBy.textContent = "-";
    el.scheduleTabMeta.textContent = "All planned injections, merged in date order.";
    el.scheduleTabList.innerHTML = "";
    return;
  }

  const today = startOfToday();
  const nextShot = merged.find((shot) => shot.date >= today) || merged[0];
  const lastDate = merged[merged.length - 1].date;
  const spanDays = daysBetween(merged[0].date, lastDate);
  const soonestUseBy = computed.map((e) => e.result.bacUseBy).sort((a, b) => a - b)[0];
  const names = computed.map((e) => e.plan.peptideName || "Untitled").join(", ");

  el.scheduleTabTitle.textContent = `${merged.length} shots`;
  el.scheduleTabSummary.textContent =
    `${computed.length} ${computed.length === 1 ? "peptide" : "peptides"} across ${spanDays} days.`;
  el.scheduleTabNext.textContent = formatDate(nextShot.date);
  el.scheduleTabLastShot.textContent = formatDate(lastDate);
  el.scheduleTabSpan.textContent = `${spanDays} days`;
  el.scheduleTabUseBy.textContent = formatDate(soonestUseBy);
  el.scheduleTabMeta.textContent = `${merged.length} injections across ${names}.`;

  renderShotList(el.scheduleTabList, merged, { showTag: true });
}

// ---- Public entry points --------------------------------------------------

// Everything derived from state. Safe to call on every keystroke — it never
// rewrites the editable form inputs or rebuilds tier rows.
export function renderOutputs(store) {
  const plan = getActivePlan(store);
  if (!plan) {
    return;
  }
  renderPlanChips(store);
  renderPeptideMeta(store, plan);
  updateTierCaptions(plan);
  renderRecon(store, plan);
  renderScheduleTab(store);
}

// Full sync of the active plan into the form (inputs + tier rows) followed by a
// fresh render. Call on plan switch, load, and structural changes.
export function renderAll(store) {
  const plan = getActivePlan(store);
  if (!plan) {
    return;
  }
  writeFormValues(plan);
  writeScheduleControls(plan);
  renderTiers(plan);
  renderOutputs(store);
}
