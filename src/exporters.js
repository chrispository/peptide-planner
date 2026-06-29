// Client-side file generation: JSON backups and an .ics calendar of the
// merged injection schedule. No DOM beyond the download anchor.

import { formatNumber } from "./format.js";

// Trigger a browser download of `text` as `filename`.
export function downloadFile(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so the click has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

// Local calendar date (YYYYMMDD) for an all-day VEVENT.
function icsDate(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

// UTC timestamp for DTSTAMP.
function icsStamp(date) {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function escapeText(value) {
  return String(value).replace(/[\\;,]/g, (match) => `\\${match}`).replace(/\n/g, "\\n");
}

// Build a VCALENDAR with one all-day event per shot. `shots` is the merged
// timeline (each: { date, peptideName, doseMg, units }).
export function buildIcs(shots) {
  const stamp = icsStamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Peptide Planner//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  shots.forEach((shot, index) => {
    const start = icsDate(shot.date);
    const end = icsDate(new Date(shot.date.getTime() + 86_400_000));
    const units = shot.units != null ? ` (${formatNumber(shot.units, 1)} units)` : "";
    const summary = `${shot.peptideName} ${formatNumber(shot.doseMg, 3)} mg${units}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:peptide-${index}-${start}@peptide-planner`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${escapeText(summary)}`,
      `DESCRIPTION:${escapeText(`Injection ${index + 1}: ${summary}`)}`,
      "END:VEVENT",
    );
  });

  lines.push("END:VCALENDAR");
  // RFC 5545 wants CRLF line endings.
  return `${lines.join("\r\n")}\r\n`;
}
