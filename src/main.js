// Entry point: owns the store, wires DOM events to state mutations, and asks the
// render layer to repaint. Keeps mutation logic here and rendering in render.js.

import { dateInputValue } from "./format.js";
import { computeAll, mergeSchedule } from "./calc.js";
import { lookupPeptide } from "./peptides.js";
import { downloadFile, buildIcs } from "./exporters.js";
import {
  createStore,
  createPlan,
  getActivePlan,
  serialize,
  hydrate,
  num,
  clamp,
} from "./state.js";
import { createPersistence } from "./persistence.js";
import {
  renderOutputs,
  renderAll,
  renderTiers,
  writeFormValues,
  writeScheduleControls,
  writePrefs,
  setSaveStatus,
  populatePeptideList,
  ADD_PEPTIDE_OPTION,
} from "./render.js";

const store = createStore();
const root = document.documentElement;

const persistence = createPersistence({
  getPayload: () => serialize(store),
  onStatus: setSaveStatus,
});

// ---- Reading the form into state ------------------------------------------

function readActivePlan() {
  const plan = getActivePlan(store);
  if (!plan) {
    return;
  }
  plan.peptideName = document.getElementById("peptideName").value;
  plan.vialMg = Math.max(0.01, num(document.getElementById("vialMg").value, plan.vialMg));
  plan.startDate = document.getElementById("startDate").value || plan.startDate;
}

function readPrefs() {
  const { prefs } = store;
  prefs.previewCount = clamp(Math.round(num(document.getElementById("previewCount").value, 8)), 3, 24);
  prefs.maxUnits = Math.max(1, num(document.getElementById("maxUnits").value, 50));
  prefs.idealUnits = Math.max(1, num(document.getElementById("idealUnits").value, 25));
  prefs.bacWindowDays = Math.max(1, num(document.getElementById("bacWindowDays").value, 35));
}

function syncTiersFromDom() {
  const plan = getActivePlan(store);
  if (!plan) {
    return;
  }
  plan.tiers = Array.from(document.querySelectorAll("#tierList .tier-row")).map((row) => {
    const previous = plan.tiers[Number(row.dataset.index)] || {};
    const isOff = previous.type === "off";
    const doseInput = row.querySelector(".tier-dose");
    const scheduleMode = row.querySelector(".tier-schedule-mode")?.value === "interval" ? "interval" : "weekly";
    const cadenceValue = num(row.querySelector(".tier-cadence")?.value, scheduleMode === "interval" ? previous.everyDays : previous.shotsPerWeek);
    const flexibleDose = Boolean(row.querySelector(".tier-flexible")?.checked);
    return {
      type: isOff ? "off" : "dose",
      weeks: previous.weeks ?? 1,
      count: previous.count ?? 1,
      doseMg: isOff ? 0 : Math.max(0.001, num(doseInput?.value, previous.doseMg || 1)),
      scheduleMode,
      shotsPerWeek:
        scheduleMode === "weekly"
          ? Math.max(0.1, cadenceValue)
          : Math.max(0.1, num(previous.shotsPerWeek, plan.shotsPerWeek || 2)),
      everyDays:
        scheduleMode === "interval"
          ? Math.max(1, Math.round(cadenceValue))
          : Math.max(1, num(previous.everyDays, plan.everyDays || 3)),
      flexibleDose,
      flexibleDosePct: clamp(
        num(row.querySelector(".tier-flexible-pct")?.value, previous.flexibleDosePct ?? 10),
        1,
        100,
      ),
    };
  });
  plan.tiers.forEach((tier, index) => {
    const input = document.querySelector(`#tierList .tier-row[data-index="${index}"] .tier-duration`);
    if (!input) {
      return;
    }
    if (tier.scheduleMode === "interval") {
      tier.count = Math.max(1, Math.round(num(input.value, tier.count)));
    } else {
      tier.weeks = Math.max(0.5, num(input.value, tier.weeks));
    }
  });
}

// When a name matches a known peptide, adopt its cadence (only when the name
// actually changed, so manual cadence edits aren't stomped).
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
  plan.tiers = plan.tiers.map((tier) => ({
    ...tier,
    scheduleMode: info.schedule.mode,
    shotsPerWeek: info.schedule.shotsPerWeek || tier.shotsPerWeek || plan.shotsPerWeek,
    everyDays: info.schedule.everyDays || tier.everyDays || plan.everyDays,
  }));
}

function addPeptidePlan() {
  const plan = createPlan({
    peptideName: "",
  });
  store.plans.push(plan);
  store.activePlanId = plan.id;
  renderAll(store);
  document.getElementById("peptideName").focus();
  persistence.scheduleSave();
}

// ---- Event wiring ---------------------------------------------------------

const form = document.getElementById("plannerForm");

function handleFormEdit(event) {
  const target = event.target;
  const isTier =
    target.classList.contains("tier-duration") ||
    target.classList.contains("tier-dose") ||
    target.classList.contains("tier-cadence") ||
    target.classList.contains("tier-flexible") ||
    target.classList.contains("tier-flexible-pct") ||
    target.classList.contains("tier-schedule-mode");
  const isPeptide = target.id === "peptideName";
  const isTierMode = target.classList.contains("tier-schedule-mode");
  const isTierFlexibleToggle = target.classList.contains("tier-flexible");
  const plan = getActivePlan(store);
  const previousName = plan ? plan.peptideName : "";

  if (isPeptide && target.value === ADD_PEPTIDE_OPTION) {
    addPeptidePlan();
    return;
  }

  readActivePlan();
  readPrefs();
  if (isTier) {
    syncTiersFromDom();
  }
  if (isPeptide && plan) {
    maybeApplyPeptideDefaults(plan, previousName);
    writeScheduleControls(plan); // reflects adopted cadence without touching the name field
  }
  if ((isTierMode || isTierFlexibleToggle) && plan) {
    renderTiers(plan);
  }

  renderOutputs(store);
  persistence.scheduleSave();
}

form.addEventListener("input", handleFormEdit);

form.addEventListener("change", (event) => {
  if (event.target.tagName === "SELECT") {
    handleFormEdit(event);
  }
});

// The reconstitution mL lives in the results panel, not the planner form, so it
// gets its own handler. A blank/invalid entry clears the override (back to auto).
document.getElementById("recommendedMl").addEventListener("input", (event) => {
  const plan = getActivePlan(store);
  if (!plan) {
    return;
  }
  const raw = event.target.value.trim();
  const parsed = num(raw, NaN);
  plan.waterMlOverride = raw === "" || !Number.isFinite(parsed) || parsed <= 0 ? null : Math.max(0.1, parsed);
  renderOutputs(store);
  persistence.scheduleSave();
});

document.getElementById("resetMlBtn").addEventListener("click", () => {
  const plan = getActivePlan(store);
  if (!plan) {
    return;
  }
  plan.waterMlOverride = null;
  renderOutputs(store);
  persistence.scheduleSave();
});

document.getElementById("recommendedPhaseList").addEventListener("click", (event) => {
  if (!event.target.closest("#resetMlPhaseBtn")) {
    return;
  }
  const plan = getActivePlan(store);
  if (!plan) {
    return;
  }
  plan.waterMlOverride = null;
  renderOutputs(store);
  persistence.scheduleSave();
});

document.getElementById("tierList").addEventListener("click", (event) => {
  const removeButton = event.target.closest(".tier-remove");
  const plan = getActivePlan(store);
  if (!removeButton || !plan || plan.tiers.length === 1) {
    return;
  }
  plan.tiers.splice(Number(removeButton.closest(".tier-row").dataset.index), 1);
  renderTiers(plan);
  renderOutputs(store);
  persistence.scheduleSave();
});

document.getElementById("addTier").addEventListener("click", () => {
  const plan = getActivePlan(store);
  if (!plan) {
    return;
  }
  const last = [...plan.tiers].reverse().find((tier) => tier.type !== "off") || {
    doseMg: 100,
    scheduleMode: "weekly",
    shotsPerWeek: 1,
    everyDays: 7,
    flexibleDose: false,
    flexibleDosePct: 10,
  };
  plan.tiers.push({
    type: "dose",
    weeks: 1,
    count: 1,
    doseMg: last.doseMg || 100,
    scheduleMode: last.scheduleMode || "weekly",
    shotsPerWeek: last.shotsPerWeek || 1,
    everyDays: last.everyDays || 7,
    flexibleDose: Boolean(last.flexibleDose),
    flexibleDosePct: last.flexibleDosePct ?? 10,
  });
  renderTiers(plan);
  renderOutputs(store);
  persistence.scheduleSave();
});

document.getElementById("addOffTier").addEventListener("click", () => {
  const plan = getActivePlan(store);
  if (!plan) {
    return;
  }
  const last = plan.tiers[plan.tiers.length - 1] || {
    scheduleMode: "weekly",
    shotsPerWeek: 1,
    everyDays: 7,
    flexibleDose: false,
    flexibleDosePct: 10,
  };
  plan.tiers.push({
    type: "off",
    weeks: 1,
    count: 1,
    doseMg: 0,
    scheduleMode: last.scheduleMode || "weekly",
    shotsPerWeek: last.shotsPerWeek || 1,
    everyDays: last.everyDays || 7,
    flexibleDose: Boolean(last.flexibleDose),
    flexibleDosePct: last.flexibleDosePct ?? 10,
  });
  renderTiers(plan);
  renderOutputs(store);
  persistence.scheduleSave();
});

document.getElementById("planChips").addEventListener("click", (event) => {
  const removeButton = event.target.closest(".plan-chip-remove");
  if (removeButton) {
    store.plans = store.plans.filter((plan) => plan.id !== removeButton.dataset.remove);
    if (!store.plans.some((plan) => plan.id === store.activePlanId)) {
      store.activePlanId = store.plans[0].id;
    }
    renderAll(store);
    persistence.scheduleSave();
    return;
  }
  const label = event.target.closest(".plan-chip-label");
  if (label) {
    store.activePlanId = label.dataset.id;
    renderAll(store);
    persistence.scheduleSave();
  }
});

document.getElementById("addPlan").addEventListener("click", () => {
  addPeptidePlan();
});

document.querySelectorAll(".app-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    setActiveTab(tab.dataset.tab);
    persistence.scheduleSave();
  });
});

document.getElementById("addManualBacBtn").addEventListener("click", () => {
  const input = document.getElementById("manualBacDate");
  addManualBacDate(input.value);
});

function addManualBacDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return;
  }
  store.prefs.manualBacOpenDates = [...new Set([...(store.prefs.manualBacOpenDates || []), date])].sort();
  renderOutputs(store);
  persistence.scheduleSave();
}

document.getElementById("manualBacList").addEventListener("click", (event) => {
  const removeButton = event.target.closest(".manual-bac-remove");
  if (!removeButton) {
    return;
  }
  store.prefs.manualBacOpenDates = (store.prefs.manualBacOpenDates || []).filter(
    (date) => date !== removeButton.dataset.date,
  );
  renderOutputs(store);
  persistence.scheduleSave();
});

document.getElementById("scheduleTabList").addEventListener("click", (event) => {
  const toggle = event.target.closest(".quick-bac-toggle");
  if (!toggle) {
    return;
  }
  const form = toggle.closest(".quick-bac-form");
  form?.classList.toggle("is-open");
  form?.querySelector(".quick-bac-date")?.focus();
});

document.getElementById("scheduleTabList").addEventListener("submit", (event) => {
  const form = event.target.closest(".quick-bac-form");
  if (!form) {
    return;
  }
  event.preventDefault();
  addManualBacDate(form.querySelector(".quick-bac-date")?.value || "");
});

// ---- Tools menu ------------------------------------------------------------

function closeSettingsMenu() {
  document.getElementById("settingsMenu").classList.add("hidden");
  document.getElementById("settingsBtn").setAttribute("aria-expanded", "false");
}

document.getElementById("settingsBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = document.getElementById("settingsMenu");
  const isOpen = !menu.classList.contains("hidden");
  menu.classList.toggle("hidden", isOpen);
  event.currentTarget.setAttribute("aria-expanded", String(!isOpen));
});

document.getElementById("settingsMenu").addEventListener("click", (event) => {
  event.stopPropagation();
});

document.addEventListener("click", closeSettingsMenu);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSettingsMenu();
  }
});

// ---- Theme -----------------------------------------------------------------

document.getElementById("themeToggle").addEventListener("click", () => {
  setTheme(root.classList.contains("dark") ? "light" : "dark");
  closeSettingsMenu();
});

// ---- Backup, calendar, print ----------------------------------------------

document.getElementById("exportBtn").addEventListener("click", () => {
  const stamp = dateInputValue(new Date());
  downloadFile(`peptide-planner-${stamp}.json`, JSON.stringify(serialize(store), null, 2), "application/json");
  closeSettingsMenu();
});

document.getElementById("importBtn").addEventListener("click", () => {
  document.getElementById("importFile").click();
  closeSettingsMenu();
});

document.getElementById("importFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = ""; // allow re-importing the same file later
  if (!file) {
    return;
  }
  try {
    const payload = JSON.parse(await file.text());
    if (!hydrate(store, payload)) {
      throw new Error("not a recognized backup");
    }
    writePrefs(store.prefs);
    setActiveTab(store.activeTab);
    renderAll(store);
    persistence.scheduleSave();
    setSaveStatus("Imported");
  } catch (error) {
    setSaveStatus("Import failed");
    window.alert(`Could not import this file: ${error.message}`);
  }
});

document.getElementById("icsBtn").addEventListener("click", () => {
  const merged = mergeSchedule(computeAll(store.plans, store.prefs));
  if (merged.length === 0) {
    window.alert("No scheduled injections to export yet.");
    return;
  }
  downloadFile(`peptide-schedule-${dateInputValue(new Date())}.ics`, buildIcs(merged), "text/calendar");
});

document.getElementById("printBtn").addEventListener("click", () => {
  setActiveTab("reconstitution"); // the print stylesheet targets this panel
  window.print();
});

document.getElementById("printScheduleBtn").addEventListener("click", () => {
  setActiveTab("schedule");
  document.body.classList.add("printing-schedule");
  window.print();
});

window.addEventListener("afterprint", () => {
  document.body.classList.remove("printing-schedule");
});

// ---- Tabs + theme ---------------------------------------------------------

function setActiveTab(tabName) {
  store.activeTab = tabName;
  document.querySelectorAll(".app-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });
}

function setTheme(theme) {
  root.classList.toggle("dark", theme === "dark");
  document.getElementById("themeLabel").textContent = theme === "dark" ? "Light" : "Dark";
  localStorage.setItem("peptide-planner-theme", theme);
}

// ---- Boot -----------------------------------------------------------------

setTheme(localStorage.getItem("peptide-planner-theme") || "dark");
writePrefs(store.prefs);
setActiveTab(store.activeTab);
populatePeptideList();
renderAll(store);

persistence.load((payload) => {
  const applied = hydrate(store, payload);
  if (applied) {
    writePrefs(store.prefs);
    setActiveTab(store.activeTab);
    populatePeptideList();
    renderAll(store);
  }
  return applied;
});
