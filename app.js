const root = document.documentElement;
const form = document.getElementById("plannerForm");
const themeToggle = document.getElementById("themeToggle");
const themeLabel = document.getElementById("themeLabel");
const preset = document.getElementById("preset");
const modeButtons = document.querySelectorAll(".segmented-button");
const scheduleFields = document.querySelectorAll(".schedule-field");

const fields = {
  peptideName: document.getElementById("peptideName"),
  vialMg: document.getElementById("vialMg"),
  doseMg: document.getElementById("doseMg"),
  startDate: document.getElementById("startDate"),
  shotsPerWeek: document.getElementById("shotsPerWeek"),
  everyDays: document.getElementById("everyDays"),
  previewCount: document.getElementById("previewCount"),
  maxUnits: document.getElementById("maxUnits"),
  idealUnits: document.getElementById("idealUnits"),
  bacBottleMl: document.getElementById("bacBottleMl"),
  bacWindowDays: document.getElementById("bacWindowDays"),
};

const output = {
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
};

let scheduleMode = "weekly";

function numberValue(input, fallback = 0) {
  const value = Number.parseFloat(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function formatNumber(value, maximumFractionDigits = 1) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
  }).format(value);
}

function formatDate(date) {
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
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

function getIntervalDays() {
  if (scheduleMode === "interval") {
    return Math.max(1, numberValue(fields.everyDays, 3));
  }

  const shotsPerWeek = Math.max(0.1, numberValue(fields.shotsPerWeek, 2.5));
  return 7 / shotsPerWeek;
}

function buildWaterOptions(vialMg, doseMg, idealUnits, maxUnits, intervalDays, totalShots) {
  const options = [];

  for (let ml = 0.5; ml <= 10.0001; ml += 0.5) {
    const concentration = vialMg / ml;
    const shotMl = doseMg / concentration;
    const units = shotMl * 100;
    const totalInjectedMl = shotMl * totalShots;

    if (units < 2 || units > 100) {
      continue;
    }

    const comfortablePenalty = units > maxUnits ? (units - maxUnits) * 3.5 : 0;
    const tinyPenalty = units < 10 ? (10 - units) * 2 : 0;
    const roundnessPenalty = Math.abs(units - Math.round(units / 5) * 5) * 0.35;
    const score = Math.abs(units - idealUnits) + comfortablePenalty + tinyPenalty + roundnessPenalty;

    options.push({
      ml,
      concentration,
      shotMl,
      units,
      totalInjectedMl,
      score,
      daysLasting: Math.max(0, Math.round((totalShots - 1) * intervalDays)),
    });
  }

  return options.sort((a, b) => a.score - b.score || a.ml - b.ml);
}

function scheduleLabel(intervalDays) {
  if (scheduleMode === "interval") {
    return `every ${formatNumber(intervalDays, 1)} days`;
  }

  return `${formatNumber(7 / intervalDays, 1)}x per week`;
}

function renderOptions(options, recommended, maxUnits) {
  output.optionList.innerHTML = "";

  options.slice(0, 5).forEach((option) => {
    const row = document.createElement("div");
    row.className = `option${option === recommended ? " recommended" : ""}`;

    const status = option.units <= maxUnits ? "good" : "warn";
    const label = option === recommended ? "Best fit" : option.units > maxUnits ? "High volume" : "Option";

    row.innerHTML = `
      <strong>${formatNumber(option.ml, 1)} mL</strong>
      <div>
        <p>${formatNumber(option.units, 1)} units per ${formatNumber(numberValue(fields.doseMg), 3)} mg shot</p>
        <p>${formatNumber(option.concentration, 1)} mg/mL concentration</p>
      </div>
      <span class="pill ${status}">${label}</span>
    `;

    output.optionList.appendChild(row);
  });
}

function renderSchedule(startDate, intervalDays, count, doseMg, units) {
  output.scheduleList.innerHTML = "";

  for (let index = 0; index < count; index += 1) {
    const date = addDays(startDate, Math.round(index * intervalDays));
    const row = document.createElement("div");
    row.className = "shot";
    row.innerHTML = `
      <div class="shot-number">${index + 1}</div>
      <div>
        <div class="shot-date">${formatDate(date)}</div>
        <div class="shot-meta">${formatNumber(doseMg, 3)} mg dose</div>
      </div>
      <span class="pill">${formatNumber(units, 1)} units</span>
    `;
    output.scheduleList.appendChild(row);
  }
}

function calculate() {
  const vialMg = Math.max(0.01, numberValue(fields.vialMg, 500));
  const doseMg = Math.max(0.001, numberValue(fields.doseMg, 100));
  const idealUnits = Math.max(1, numberValue(fields.idealUnits, 50));
  const maxUnits = Math.max(1, numberValue(fields.maxUnits, 70));
  const bacBottleMl = Math.max(1, numberValue(fields.bacBottleMl, 30));
  const bacWindowDays = Math.max(1, numberValue(fields.bacWindowDays, 35));
  const previewCount = Math.max(3, Math.min(24, Math.round(numberValue(fields.previewCount, 8))));
  const intervalDays = getIntervalDays();
  const totalShots = Math.max(1, Math.floor(vialMg / doseMg));
  const vialDurationDays = Math.max(0, Math.round((totalShots - 1) * intervalDays));
  const startDate = fields.startDate.value ? new Date(`${fields.startDate.value}T00:00:00`) : new Date();
  const bacUseBy = addDays(startDate, bacWindowDays);
  const options = buildWaterOptions(vialMg, doseMg, idealUnits, maxUnits, intervalDays, totalShots);
  const recommended = options[0];

  if (!recommended) {
    output.recommendedMl.textContent = "-";
    output.recommendedUnits.textContent = "-";
    output.recommendedSummary.textContent = "No option fits within a 100-unit syringe. Adjust the dose or vial amount.";
    return;
  }

  const vialEndsBeforeBacExpires = vialDurationDays <= bacWindowDays;
  const waterUsedPercent = (recommended.ml / bacBottleMl) * 100;

  output.recommendedMl.textContent = `${formatNumber(recommended.ml, 1)} mL`;
  output.recommendedUnits.textContent = formatNumber(recommended.units, 1);
  output.recommendedSummary.textContent = `Add ${formatNumber(recommended.ml, 1)} mL BAC water to ${fields.peptideName.value || "the vial"} for ${formatNumber(doseMg, 3)} mg shots.`;
  output.vialLasts.textContent = `${formatNumber(vialDurationDays, 0)} days`;
  output.totalShots.textContent = formatNumber(totalShots, 0);
  output.concentration.textContent = `${formatNumber(recommended.concentration, 1)} mg/mL`;
  output.bacUseBy.textContent = formatDate(bacUseBy);
  output.scheduleSummary.textContent = `${scheduleLabel(intervalDays)}; vial ${vialEndsBeforeBacExpires ? "finishes inside" : "runs past"} the selected BAC window. Uses ${formatNumber(waterUsedPercent, 1)}% of a ${formatNumber(bacBottleMl, 1)} mL BAC bottle.`;

  renderOptions(options, recommended, maxUnits);
  renderSchedule(startDate, intervalDays, Math.min(previewCount, totalShots), doseMg, recommended.units);
}

function setTheme(theme) {
  root.classList.toggle("dark", theme === "dark");
  themeLabel.textContent = theme === "dark" ? "Light" : "Dark";
  localStorage.setItem("peptide-planner-theme", theme);
}

function setScheduleMode(mode) {
  scheduleMode = mode;
  modeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  scheduleFields.forEach((field) => {
    field.classList.toggle("hidden", field.dataset.for !== mode);
  });
  calculate();
}

preset.addEventListener("change", () => {
  if (preset.value === "custom") {
    return;
  }

  const [name, vialMg, doseMg] = preset.value.split("|");
  fields.peptideName.value = name;
  fields.vialMg.value = vialMg;
  fields.doseMg.value = doseMg;
  calculate();
});

form.addEventListener("input", (event) => {
  if (event.target !== preset) {
    preset.value = "custom";
  }
  calculate();
});

modeButtons.forEach((button) => {
  button.addEventListener("click", () => setScheduleMode(button.dataset.mode));
});

themeToggle.addEventListener("click", () => {
  setTheme(root.classList.contains("dark") ? "light" : "dark");
});

fields.startDate.value = dateInputValue(new Date());
setTheme(localStorage.getItem("peptide-planner-theme") || "light");
calculate();
