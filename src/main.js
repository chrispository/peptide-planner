// Entry point: owns the store, wires DOM events to state mutations, and asks the
// render layer to repaint. Keeps mutation logic here and rendering in render.js.

import { dateInputValue } from "./format.js";
import { dosesPerWeek, computeAll, mergeSchedule } from "./calc.js";
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
  plan.shotsPerWeek = Math.max(0.1, num(document.getElementById("shotsPerWeek").value, plan.shotsPerWeek));
  plan.everyDays = Math.max(1, num(document.getElementById("everyDays").value, plan.everyDays));
  plan.flexibleDose = document.getElementById("flexibleDose").checked;
  plan.flexibleDosePct = clamp(num(document.getElementById("flexibleDosePct").value, plan.flexibleDosePct ?? 10), 1, 100);
}

function readPrefs() {
  const { prefs } = store;
  prefs.previewCount = clamp(Math.round(num(document.getElementById("previewCount").value, 8)), 3, 24);
  prefs.maxUnits = Math.max(1, num(document.getElementById("maxUnits").value, 70));
  prefs.idealUnits = Math.max(1, num(document.getElementById("idealUnits").value, 60));
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
    return {
      type: isOff ? "off" : "dose",
      weeks: previous.weeks ?? 1,
      count: previous.count ?? 1,
      doseMg: isOff ? 0 : Math.max(0.001, num(doseInput?.value, previous.doseMg || 1)),
    };
  });
  plan.tiers.forEach((tier, index) => {
    const input = document.querySelector(`#tierList .tier-row[data-index="${index}"] .tier-duration`);
    if (!input) {
      return;
    }
    if (plan.scheduleMode === "interval") {
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
    target.classList.contains("tier-dose");
  const isPeptide = target.id === "peptideName";
  const plan = getActivePlan(store);
  const previousName = plan ? plan.peptideName : "";
  const previousMode = plan ? plan.scheduleMode : "";

  if (isPeptide && target.value === ADD_PEPTIDE_OPTION) {
    addPeptidePlan();
    return;
  }

  readActivePlan();
  readPrefs();
  if (isTier) {
    syncTiersFromDom();
  }
  document.getElementById("flexibleDosePct").disabled = !plan?.flexibleDose;
  if (isPeptide && plan) {
    maybeApplyPeptideDefaults(plan, previousName);
    writeScheduleControls(plan); // reflects adopted cadence without touching the name field
    if (plan.scheduleMode !== previousMode) {
      renderTiers(plan);
    }
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
  const last = [...plan.tiers].reverse().find((tier) => tier.type !== "off") || { doseMg: 100 };
  plan.tiers.push({ type: "dose", weeks: 1, count: 1, doseMg: last.doseMg || 100 });
  renderTiers(plan);
  renderOutputs(store);
  persistence.scheduleSave();
});

document.getElementById("addOffTier").addEventListener("click", () => {
  const plan = getActivePlan(store);
  if (!plan) {
    return;
  }
  plan.tiers.push({ type: "off", weeks: 1, count: 1, doseMg: 0 });
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

document.querySelectorAll(".segmented-button").forEach((button) => {
  button.addEventListener("click", () => {
    const plan = getActivePlan(store);
    if (!plan) {
      return;
    }
    plan.scheduleMode = button.dataset.mode;
    writeScheduleControls(plan);
    renderTiers(plan);
    renderOutputs(store);
    persistence.scheduleSave();
  });
});

document.querySelectorAll(".app-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    setActiveTab(tab.dataset.tab);
    persistence.scheduleSave();
  });
});

document.getElementById("addManualBacBtn").addEventListener("click", () => {
  const input = document.getElementById("manualBacDate");
  const date = input.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return;
  }
  store.prefs.manualBacOpenDates = [...new Set([...(store.prefs.manualBacOpenDates || []), date])].sort();
  renderOutputs(store);
  persistence.scheduleSave();
});

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
