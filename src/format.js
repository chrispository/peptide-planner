// Formatting and date helpers. No DOM, no state — safe to use anywhere.

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function formatNumber(value, maximumFractionDigits = 1) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (maximumFractionDigits === 1) {
    return numberFormat.format(value);
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

// A min–max range, collapsed to a single value when the ends are equal.
export function formatRange(values, digits = 1) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (Math.abs(min - max) < 0.01) {
    return formatNumber(max, digits);
  }
  return `${formatNumber(min, digits)}–${formatNumber(max, digits)}`;
}

export function formatDate(date) {
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// YYYY-MM-DD for <input type="date">, using local time (not UTC).
export function dateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseStartDate(value) {
  return value ? new Date(`${value}T00:00:00`) : new Date();
}

export function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function daysBetween(a, b) {
  return Math.round((b - a) / 86_400_000);
}
