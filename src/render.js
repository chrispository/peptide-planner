// All DOM rendering. Functions read from `store` and write to the page; they
// never mutate state. Form writing is split into narrow helpers so that typing
// in one input never rewrites (and resets the caret of) another.

import {
  formatNumber,
  formatRange,
  formatDate,
  dateInputValue,
  parseStartDate,
  addDays,
  startOfToday,
  daysBetween,
} from "./format.js";
import {
  intervalDays,
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
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => (
    {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    }[char]
  ));
const iconX = `
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
`;

const el = {
  saveStatus: $("saveStatus"),
  settingsBtn: $("settingsBtn"),
  settingsMenu: $("settingsMenu"),
  planChips: $("planChips"),
  peptideName: $("peptideName"),
  peptideOptions: $("peptideOptions"),
  vialMg: $("vialMg"),
  startDate: $("startDate"),
  shotsPerWeek: $("shotsPerWeek"),
  everyDays: $("everyDays"),
  flexibleDose: $("flexibleDose"),
  flexibleDosePct: $("flexibleDosePct"),
  peptideNote: $("peptideNote"),
  tierList: $("tierList"),
  phaseLastShot: $("phaseLastShot"),
  phaseVials: $("phaseVials"),
  phaseLeftoverRow: $("phaseLeftoverRow"),
  phaseLeftover: $("phaseLeftover"),
  phaseSuggestion: $("phaseSuggestion"),
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
  scheduleTabNext: $("scheduleTabNext"),
  scheduleTabLastShot: $("scheduleTabLastShot"),
  scheduleTabSpan: $("scheduleTabSpan"),
  scheduleTabUseBy: $("scheduleTabUseBy"),
  scheduleTabMeta: $("scheduleTabMeta"),
  scheduleTabList: $("scheduleTabList"),
  planSummaryList: $("planSummaryList"),
  manualBacDate: $("manualBacDate"),
  manualBacList: $("manualBacList"),
};

export function setSaveStatus(text) {
  el.saveStatus.textContent = text;
}

// ---- Peptide selector -----------------------------------------------------

export const ADD_PEPTIDE_OPTION = "+ Add Peptide";

export function populatePeptideList() {
  const currentValue = el.peptideName.value;
  el.peptideOptions.innerHTML = "";

  const addOption = document.createElement("option");
  addOption.value = ADD_PEPTIDE_OPTION;
  el.peptideOptions.appendChild(addOption);

  const allNames = new Set(PEPTIDE_NAMES);
  if (currentValue && currentValue !== ADD_PEPTIDE_OPTION) {
    allNames.add(currentValue);
  }
  for (const name of [...allNames].sort()) {
    const option = document.createElement("option");
    option.value = name;
    el.peptideOptions.appendChild(option);
  }
  if (currentValue && allNames.has(currentValue)) {
    el.peptideName.value = currentValue;
  } else {
    el.peptideName.value = "";
  }
}

function ensurePeptideOption(name) {
  if (!name || [...el.peptideOptions.options].some((option) => option.value === name)) {
    return;
  }
  const option = document.createElement("option");
  option.value = name;
  el.peptideOptions.appendChild(option);
}

// ---- Form writers (targeted, never blanket) -------------------------------

// Full plan -> inputs. Only call when no field is being edited (plan switch,
// load, import).
export function writeFormValues(plan) {
  ensurePeptideOption(plan.peptideName);
  el.peptideName.value = plan.peptideName;
  el.vialMg.value = plan.vialMg;
  el.startDate.value = plan.startDate;
  el.shotsPerWeek.value = plan.shotsPerWeek;
  el.everyDays.value = plan.everyDays;
  el.flexibleDose.checked = Boolean(plan.flexibleDose);
  el.flexibleDosePct.value = plan.flexibleDosePct ?? 10;
  el.flexibleDosePct.disabled = !plan.flexibleDose;
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
  $("bacWindowDays").value = prefs.bacWindowDays;
  el.manualBacDate.value = dateInputValue(new Date());
}

// ---- Tier rows ------------------------------------------------------------

// Rebuild the phase rows. Only call on structural change (add/remove, switch,
// load) — captions update in place during typing via renderOutputs.
export function renderTiers(plan) {
  el.tierList.innerHTML = "";
  const durationLabel = plan.scheduleMode === "interval" ? "Shots" : "Weeks";
  const durationValue = (tier) => (plan.scheduleMode === "interval" ? tier.count : tier.weeks);
  const durationAttrs =
    plan.scheduleMode === "interval"
      ? 'type="number" min="1" step="1"'
      : 'type="number" min="0.5" step="0.5"';
  plan.tiers.forEach((tier, index) => {
    const row = document.createElement("div");
    row.className = "tier-row";
    row.dataset.index = String(index);
    row.innerHTML = `
      <div class="tier-main">
        <div class="tier-index">${index + 1}</div>
        <label class="field">
          <span>${durationLabel}</span>
          <input class="tier-duration" ${durationAttrs} value="${durationValue(tier)}" />
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
  const interval = intervalDays(plan);
  const startDate = parseStartDate(plan.startDate);
  let doseCursor = 0;
  let lastShotDate = null;
  el.tierList.querySelectorAll(".tier-row").forEach((row, index) => {
    const tier = plan.tiers[index];
    if (!tier) {
      return;
    }
    const count = tierDoseCount(tier, plan);
    const startDose = doseCursor + 1;
    const endDose = doseCursor + count;
    doseCursor += count;
    lastShotDate = addDays(startDate, Math.round((endDose - 1) * interval));
    const startWeek = Math.ceil(startDose / dpw);
    const endWeek = Math.ceil(endDose / dpw);
    const rangeLabel =
      plan.scheduleMode === "interval"
        ? startDose === endDose
          ? `Shot ${startDose}`
          : `Shots ${startDose}–${endDose}`
        : startWeek === endWeek
          ? `Week ${startWeek}`
          : `Weeks ${startWeek}–${endWeek}`;
    const doseLabel = `${count} ${count === 1 ? "dose" : "doses"}`;
    row.querySelector(".tier-caption").textContent =
      `${rangeLabel} · ${doseLabel} · ${mg(count * tier.doseMg)} mg total`;
  });
  el.phaseLastShot.textContent = lastShotDate ? formatDate(lastShotDate) : "-";
}

// ---- Peptide meta ---------------------------------------------------------

function renderPeptideMeta(store, plan) {
  const info = lookupPeptide(plan.peptideName);
  const hasName = Boolean((plan.peptideName || "").trim());

  if (info) {
    el.peptideNote.textContent = info.note;
  } else {
    el.peptideNote.textContent = hasName
      ? "Not in the library — enter dose phases below."
      : "Custom peptide — enter your own dose phases below.";
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
      <button class="plan-chip-label" type="button" data-id="${plan.id}">${plan.peptideName || "Choose Peptide"}</button>
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
  el.phaseLastShot.textContent = "-";
  el.phaseVials.textContent = "-";
  el.phaseLeftover.textContent = "-";
  el.phaseLeftoverRow.classList.add("hidden");
  el.phaseSuggestion.textContent = "";
  el.phaseSuggestion.classList.add("hidden");
  el.scheduleList.innerHTML = "";
  el.scheduleSummary.textContent = "No schedule to preview yet.";
}

function renderShotList(target, shots, { showTag, events = [], bacNumber = 1 } = {}) {
  target.innerHTML = "";
  const days = new Map();
  const addDayItem = (date, item) => {
    const key = dateInputValue(date);
    if (!days.has(key)) {
      days.set(key, { date, items: [] });
    }
    days.get(key).items.push(item);
  };
  if (showTag && shots.length > 0) {
    const firstShot = [...shots].sort((a, b) => a.date - b.date)[0];
    addDayItem(firstShot.date, {
      type: "event",
      tone: "bac",
      label: `BAC Water ${bacNumber} Opened`,
    });
    addDayItem(firstShot.bacExpires, {
      type: "event",
      tone: "bac",
      label: `BAC Water ${bacNumber} Expiring`,
    });
  }

  events.forEach((event) => {
    addDayItem(event.date, {
      type: "event",
      tone: event.tone,
      label: event.label,
      value: event.value,
    });
  });

  shots.forEach((shot) => {
    if (!showTag && shot.bacOpened) {
      addDayItem(shot.date, {
        type: "event",
        tone: "bac",
        label: `BAC Water ${bacNumber} Opened`,
      });
      addDayItem(shot.bacExpires, {
        type: "event",
        tone: "bac",
        label: `BAC Water ${bacNumber} Expiring`,
      });
    }
    if (shot.opensVial) {
      const peptide = shot.peptideName ? `${shot.peptideName} ` : "";
      addDayItem(shot.date, {
        type: "event",
        tone: "open",
        label: `Open ${peptide}vial ${shot.vialNumber}`,
      });
    }
    const meta = showTag
      ? `<span class="shot-name">${escapeHtml(shot.peptideName)}</span><span class="shot-dose">${mg(shot.doseMg)} mg</span>`
      : `${mg(shot.doseMg)} mg · phase ${shot.tierIndex + 1}`;
    addDayItem(shot.date, {
      type: "shot",
      index: shot.index,
      meta,
      units: shot.units,
    });
    if (shot.endsVial) {
      const peptide = shot.peptideName ? `${shot.peptideName} ` : "";
      addDayItem(shot.date, {
        type: "event",
        tone: "end",
        label: `End ${peptide}vial ${shot.endsVial.vialNumber}`,
        value: `${mg(shot.endsVial.unusedMg)} mg unused`,
      });
    }
  });

  [...days.values()]
    .sort((a, b) => a.date - b.date)
    .forEach((day) => {
      const row = document.createElement("div");
      row.className = "schedule-day";
      const items = day.items
        .map((item) => {
          if (item.type === "shot") {
            return `
              <div class="schedule-shot${showTag ? " schedule-shot--named" : ""}">
                ${showTag ? "" : `<span class="shot-number">${item.index + 1}</span>`}
                <div class="shot-meta">${item.meta}</div>
                <span class="pill">${item.units != null ? `${formatNumber(item.units, 1)} units` : "-"}</span>
              </div>
            `;
          }
          return `
            <div class="schedule-event ${item.tone}">
              <span>${item.label}</span>
              ${item.value ? `<strong>${item.value}</strong>` : ""}
            </div>
          `;
        })
        .join("");
      row.innerHTML = `
        <div class="shot-date">${formatDate(day.date)}</div>
        <div class="schedule-day-items">${items}</div>
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

  const dpw = dosesPerWeek(plan);
  const distinctDoses = [...new Set(result.doses.map((d) => d.doseMg))].sort((a, b) => a - b);
  const mgPerWeek = distinctDoses.map((dose) => dose * dpw);
  const unitsPerWeek = distinctDoses.map((dose) => (dose / r.concentration) * 100 * dpw);

  el.recommendedMl.textContent = `${formatNumber(r.ml, 1)} mL`;
  el.recommendedUnits.textContent = formatRange(r.unitsByDose);
  el.recommendedSummary.textContent =
    `Add ${formatNumber(r.ml, 1)} mL BAC water to ${plan.peptideName || "the vial"} for ${summarizeDoses(result.doses, mg)}.`;
  el.recommendedPerWeek.textContent =
    `≈ ${formatRange(mgPerWeek, 3)} mg / week · ${formatRange(unitsPerWeek, 0)} units / week (${formatNumber(dpw, 1)}x weekly)`;
  el.vialLasts.textContent = `${formatNumber(result.vialDurationDays, 0)} days`;
  el.totalShots.textContent = formatNumber(result.doses.length, 0);
  el.concentration.textContent = `${formatNumber(r.concentration, 1)} mg/mL`;
  el.bacUseBy.textContent = formatDate(result.bacUseBy);
  el.phaseVials.textContent = vialsLabel;
  el.phaseLeftover.textContent = `${mg(result.lastVialLeftover)} mg`;
  el.phaseLeftoverRow.classList.toggle("hidden", result.lastVialLeftover <= 0.001);
  if (plan.flexibleDose && result.cleanupSuggestions.length > 0) {
    const suggestion = result.cleanupSuggestions[0];
    const more = result.cleanupSuggestions.length > 1 ? ` ${result.cleanupSuggestions.length - 1} more vial cleanup adjustment${result.cleanupSuggestions.length === 2 ? "" : "s"} applied.` : "";
    const shotRange =
      suggestion.shotStartIndex === suggestion.shotEndIndex
        ? `shot ${suggestion.shotStartIndex + 1}`
        : `shots ${suggestion.shotStartIndex + 1}-${suggestion.shotEndIndex + 1}`;
    el.phaseSuggestion.textContent =
      `Cleaned vial ${suggestion.vialNumber}: increased ${shotRange} by ${formatNumber(suggestion.adjustmentPct, 1)}% (+${mg(suggestion.addedMg)} mg total).${more}`;
    el.phaseSuggestion.classList.remove("hidden");
  } else {
    el.phaseSuggestion.textContent = plan.flexibleDose
      ? `No cleanup adjustment found within ${formatNumber(plan.flexibleDosePct ?? 10, 0)}%.`
      : "Flexible dose is off; vial cleanup suggestions are hidden.";
    el.phaseSuggestion.classList.remove("hidden");
  }
  el.scheduleSummary.textContent =
    `${scheduleLabel(plan)}; ${result.doses.length} shots over ~${formatNumber(planWeeks, 0)} weeks. Needs ${vialsLabel} (${mg(result.totalMg)} mg total); each vial ${vialEndsBeforeBac ? "finishes inside" : "runs past"} the ${prefs.bacWindowDays}-day BAC window.`;

  renderShotList(el.scheduleList, result.shots.slice(0, Math.min(prefs.previewCount, result.shots.length)));
}

// ---- Combined schedule tab ------------------------------------------------

function renderManualBacList(prefs) {
  const dates = prefs.manualBacOpenDates || [];
  if (dates.length === 0) {
    el.manualBacList.innerHTML = `<p class="empty-hint">No extra BAC bottles tracked.</p>`;
    return;
  }

  el.manualBacList.innerHTML = dates
    .map((date) => `
      <div class="manual-bac-item">
        <span>${formatDate(parseStartDate(date))}</span>
        <button class="button button--icon icon-button manual-bac-remove" type="button" data-date="${date}" aria-label="Remove BAC opened ${date}">
          ${iconX}
        </button>
      </div>
    `)
    .join("");
}

function renderScheduleTab(store) {
  const computed = computeAll(store.plans, store.prefs);
  renderManualBacList(store.prefs);
  const computedHasShots = computed.some((entry) => entry.result.shots.length > 0);
  const manualBacStartNumber = computedHasShots ? 2 : 1;
  const manualBacEvents = (store.prefs.manualBacOpenDates || []).flatMap((date, index) => {
    const opened = parseStartDate(date);
    const bacNumber = manualBacStartNumber + index;
    return [
      { date: opened, tone: "bac", kind: "opened", label: `BAC Water ${bacNumber} Opened` },
      {
        date: addDays(opened, store.prefs.bacWindowDays),
        tone: "bac",
        kind: "expires",
        label: `BAC Water ${bacNumber} Expiring`,
      },
    ];
  });

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
    el.scheduleTabNext.textContent = "-";
    el.scheduleTabLastShot.textContent = "-";
    el.scheduleTabSpan.textContent = "-";
    const manualUseByDates = manualBacEvents
      .filter((event) => event.kind === "expires")
      .map((event) => event.date);
    el.scheduleTabUseBy.textContent = manualUseByDates.length
      ? formatDate(manualUseByDates.sort((a, b) => a - b)[0])
      : "-";
    el.scheduleTabMeta.textContent = "All planned injections, merged in date order.";
    renderShotList(el.scheduleTabList, [], { showTag: true, events: manualBacEvents });
    return;
  }

  const today = startOfToday();
  const nextShot = merged.find((shot) => shot.date >= today) || merged[0];
  const lastDate = merged[merged.length - 1].date;
  const spanDays = daysBetween(merged[0].date, lastDate);
  const sharedBacUseBy = addDays(merged[0].date, store.prefs.bacWindowDays);
  const useByDates = [
    sharedBacUseBy,
    ...manualBacEvents.filter((event) => event.kind === "expires").map((event) => event.date),
  ];
  const soonestUseBy = useByDates.sort((a, b) => a - b)[0];
  const names = computed.map((e) => e.plan.peptideName || "Untitled").join(", ");

  el.scheduleTabNext.textContent = formatDate(nextShot.date);
  el.scheduleTabLastShot.textContent = formatDate(lastDate);
  el.scheduleTabSpan.textContent = `${spanDays} days`;
  el.scheduleTabUseBy.textContent = formatDate(soonestUseBy);
  el.scheduleTabMeta.textContent = `${merged.length} injections across ${names}.`;

  renderShotList(el.scheduleTabList, merged, { showTag: true, events: manualBacEvents });
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
  populatePeptideList();
  renderOutputs(store);
}
