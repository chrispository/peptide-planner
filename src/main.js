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
import { createPersistence, fetchPeptideInfo } from "./persistence.js";
import {
  renderPeptideDatalist,
  renderOutputs,
  renderAll,
  renderTiers,
  writeFormValues,
  writeScheduleControls,
  writePrefs,
  setSaveStatus,
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
}

function readPrefs() {
  const { prefs } = store;
  prefs.previewCount = clamp(Math.round(num(document.getElementById("previewCount").value, 8)), 3, 24);
  prefs.maxUnits = Math.max(1, num(document.getElementById("maxUnits").value, 70));
  prefs.idealUnits = Math.max(1, num(document.getElementById("idealUnits").value, 60));
  prefs.bacBottleMl = Math.max(1, num(document.getElementById("bacBottleMl").value, 30));
  prefs.bacWindowDays = Math.max(1, num(document.getElementById("bacWindowDays").value, 35));
}

function syncTiersFromDom() {
  const plan = getActivePlan(store);
  if (!plan) {
    return;
  }
  plan.tiers = Array.from(document.querySelectorAll("#tierList .tier-row")).map((row) => ({
    weeks: plan.tiers[Number(row.dataset.index)]?.weeks ?? 1,
    count: plan.tiers[Number(row.dataset.index)]?.count ?? 1,
    doseMg: Math.max(0.001, num(row.querySelector(".tier-dose").value, 1)),
  }));
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
  const info = lookupPeptide(plan.peptideName, store.aiLibrary);
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

// ---- Event wiring ---------------------------------------------------------

const form = document.getElementById("plannerForm");

form.addEventListener("input", (event) => {
  const target = event.target;
  const isTier = target.classList.contains("tier-duration") || target.classList.contains("tier-dose");
  const isPeptide = target.id === "peptideName";
  const plan = getActivePlan(store);
  const previousName = plan ? plan.peptideName : "";
  const previousMode = plan ? plan.scheduleMode : "";

  readActivePlan();
  readPrefs();
  if (isTier) {
    syncTiersFromDom();
  }
  if (isPeptide && plan) {
    maybeApplyPeptideDefaults(plan, previousName);
    writeScheduleControls(plan); // reflects adopted cadence without touching the name field
    if (plan.scheduleMode !== previousMode) {
      renderTiers(plan);
    }
  }

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
  const last = plan.tiers[plan.tiers.length - 1] || { doseMg: 100 };
  plan.tiers.push({ weeks: 1, count: 1, doseMg: last.doseMg });
  renderTiers(plan);
  renderOutputs(store);
  persistence.scheduleSave();
});

document.getElementById("aiLookupBtn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const plan = getActivePlan(store);
  const name = (plan?.peptideName || "").trim();
  if (!name) {
    return;
  }

  button.disabled = true;
  const originalLabel = button.innerHTML;
  button.innerHTML = `
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
    Looking up...
  `;
  try {
    const data = await fetchPeptideInfo(name);
    if (!data.known || !data.info) {
      document.getElementById("peptideNote").textContent =
        `No reliable dosing found for "${name}". Enter dose phases manually.`;
      return;
    }
    store.aiLibrary[data.name] = data.info;
    plan.peptideName = data.name;
    maybeApplyPeptideDefaults(plan, ""); // force-adopt the fetched cadence
    renderAll(store);
    persistence.scheduleSave();
  } catch (error) {
    document.getElementById("peptideNote").textContent = error.message || "AI lookup failed.";
  } finally {
    button.disabled = false;
    button.innerHTML = originalLabel;
  }
});

document.getElementById("vialChips").addEventListener("click", (event) => {
  const chip = event.target.closest(".vial-chip");
  const plan = getActivePlan(store);
  if (!chip || !plan) {
    return;
  }
  plan.vialMg = num(chip.dataset.vial, plan.vialMg);
  writeFormValues(plan);
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
  const plan = createPlan({
    peptideName: "Tirzepatide",
    vialMg: 30,
    shotsPerWeek: 1,
    tiers: [{ weeks: 12, count: 12, doseMg: 2.5 }],
  });
  maybeApplyPeptideDefaults(plan, "");
  store.plans.push(plan);
  store.activePlanId = plan.id;
  renderAll(store);
  persistence.scheduleSave();
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

document.getElementById("themeToggle").addEventListener("click", () => {
  setTheme(root.classList.contains("dark") ? "light" : "dark");
});

// ---- Backup, calendar, print ----------------------------------------------

document.getElementById("exportBtn").addEventListener("click", () => {
  const stamp = dateInputValue(new Date());
  downloadFile(`peptide-planner-${stamp}.json`, JSON.stringify(serialize(store), null, 2), "application/json");
});

document.getElementById("importBtn").addEventListener("click", () => {
  document.getElementById("importFile").click();
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

renderPeptideDatalist();
setTheme(localStorage.getItem("peptide-planner-theme") || "light");
writePrefs(store.prefs);
setActiveTab(store.activeTab);
renderAll(store);

persistence.load((payload) => {
  const applied = hydrate(store, payload);
  if (applied) {
    writePrefs(store.prefs);
    setActiveTab(store.activeTab);
    renderAll(store);
  }
  return applied;
});
