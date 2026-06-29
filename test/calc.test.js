import { test } from "node:test";
import assert from "node:assert/strict";

import {
  intervalDays,
  dosesPerWeek,
  tierDoseCount,
  buildDosePlan,
  computePlan,
  computeAll,
  mergeSchedule,
  summarizeDoses,
} from "../src/calc.js";

const PREFS = { previewCount: 8, maxUnits: 70, idealUnits: 60, bacBottleMl: 30, bacWindowDays: 35 };

function plan(overrides = {}) {
  return {
    id: "t",
    peptideName: "NAD+",
    vialMg: 500,
    startDate: "2026-01-01",
    scheduleMode: "weekly",
    shotsPerWeek: 2,
    everyDays: 3,
    tiers: [{ weeks: 2.5, count: 5, doseMg: 100 }],
    ...overrides,
  };
}

test("cadence helpers convert between weekly and interval", () => {
  assert.equal(dosesPerWeek(plan({ scheduleMode: "weekly", shotsPerWeek: 2 })), 2);
  assert.equal(intervalDays(plan({ scheduleMode: "weekly", shotsPerWeek: 2 })), 3.5);
  assert.equal(dosesPerWeek(plan({ scheduleMode: "interval", everyDays: 7 })), 1);
  assert.equal(intervalDays(plan({ scheduleMode: "interval", everyDays: 3 })), 3);
});

test("tierDoseCount uses weeks for weekly mode and count for interval mode", () => {
  assert.equal(tierDoseCount({ weeks: 2.5, doseMg: 100 }, plan({ shotsPerWeek: 2 })), 5);
  assert.equal(tierDoseCount({ weeks: 0.1, doseMg: 100 }, plan({ shotsPerWeek: 1 })), 1);
  assert.equal(tierDoseCount({ weeks: 10, count: 3, doseMg: 100 }, plan({ scheduleMode: "interval" })), 3);
});

test("buildDosePlan flattens phases and counts vials", () => {
  const { doses, totalMg, vialsNeeded } = buildDosePlan(plan());
  assert.equal(doses.length, 5);
  assert.equal(totalMg, 500);
  assert.equal(vialsNeeded, 1);
});

test("buildDosePlan splits across multiple vials when the plan exceeds one", () => {
  const { vialsNeeded, totalMg, lastVialLeftover } = buildDosePlan(
    plan({ vialMg: 30, tiers: [{ weeks: 8, count: 8, doseMg: 5 }], scheduleMode: "weekly", shotsPerWeek: 1 }),
  );
  // 8 doses * 5 mg = 40 mg over two 30 mg vials.
  assert.equal(totalMg, 40);
  assert.equal(vialsNeeded, 2);
  assert.equal(lastVialLeftover, 20);
});

test("buildDosePlan tracks unused medication across opened vials", () => {
  const result = buildDosePlan(
    plan({
      vialMg: 500,
      flexibleDose: true,
      scheduleMode: "interval",
      everyDays: 3,
      tiers: [
        { weeks: 1, count: 1, doseMg: 75 },
        { weeks: 1, count: 1, doseMg: 100 },
        { weeks: 1, count: 1, doseMg: 125 },
        { weeks: 1, count: 14, doseMg: 150 },
      ],
    }),
  );
  assert.equal(result.totalMg, 2400);
  assert.equal(result.vialsNeeded, 6);
  assert.equal(result.lastVialLeftover, 600);
  assert.deepEqual(
    result.cleanupSuggestions.slice(0, 2).map((s) => ({ vialNumber: s.vialNumber, shotIndex: s.shotIndex, addedMg: s.addedMg })),
    [
      { vialNumber: 1, shotIndex: 3, addedMg: 50 },
      { vialNumber: 2, shotIndex: 6, addedMg: 50 },
    ],
  );
});

test("computePlan recommends the canonical NAD+ reconstitution", () => {
  const result = computePlan(plan(), PREFS);
  assert.equal(result.empty, false);
  assert.equal(result.recommended.ml, 3);
  assert.equal(Math.round(result.recommended.concentration * 10) / 10, 166.7);
  assert.equal(result.doses.length, 5);
  assert.equal(result.vialsNeeded, 1);
});

test("computePlan keeps every shot within a 100-unit syringe", () => {
  const result = computePlan(plan(), PREFS);
  for (const units of result.recommended.unitsByDose) {
    assert.ok(units <= 100 && units >= 2, `units out of range: ${units}`);
  }
});

test("computePlan dates shots from the start date at the cadence interval", () => {
  const result = computePlan(plan({ startDate: "2026-01-01", shotsPerWeek: 2 }), PREFS);
  assert.equal(result.shots[0].date.getFullYear(), 2026);
  assert.equal(result.shots[0].bacOpened, true);
  assert.equal(result.shots[0].bacExpires.toISOString().slice(0, 10), "2026-02-05");
  assert.equal(result.shots[1].bacOpened, false);
  // 2x/week => 3.5 day spacing, rounded: shot 3 lands 7 days out.
  const days = Math.round((result.shots[2].date - result.shots[0].date) / 86_400_000);
  assert.equal(days, 7);
});

test("computePlan returns empty when there are no phases", () => {
  assert.deepEqual(computePlan(plan({ tiers: [] }), PREFS), { empty: true });
});

test("computeAll drops uncomputable plans and mergeSchedule sorts by date", () => {
  const a = plan({ id: "a", peptideName: "NAD+", startDate: "2026-01-10" });
  const b = plan({ id: "b", peptideName: "TB-500", vialMg: 10, startDate: "2026-01-01", tiers: [{ weeks: 2, count: 4, doseMg: 2 }] });
  const computed = computeAll([a, b], PREFS);
  assert.equal(computed.length, 2);
  const merged = mergeSchedule(computed);
  for (let i = 1; i < merged.length; i += 1) {
    assert.ok(merged[i].date >= merged[i - 1].date, "merged schedule not sorted");
  }
  assert.equal(merged[0].peptideName, "TB-500"); // earlier start date first
});

test("summarizeDoses groups consecutive equal doses", () => {
  const doses = [{ doseMg: 2.5 }, { doseMg: 2.5 }, { doseMg: 5 }];
  assert.equal(summarizeDoses(doses, (v) => String(v)), "2x 2.5 mg, 1x 5 mg");
});
