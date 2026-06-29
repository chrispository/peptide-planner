import { test } from "node:test";
import assert from "node:assert/strict";

import { createStore, hydrate, serialize, createPlan, getActivePlan, STATE_VERSION } from "../src/state.js";

test("createStore yields one default plan and sane prefs", () => {
  const store = createStore();
  assert.equal(store.plans.length, 1);
  assert.equal(store.activePlanId, store.plans[0].id);
  assert.equal(store.prefs.idealUnits, 60);
  assert.equal(store.version, STATE_VERSION);
});

test("hydrate migrates legacy v1 (fields + count tiers) to weeks", () => {
  const store = createStore();
  const ok = hydrate(store, {
    scheduleMode: "interval",
    fields: { peptideName: "BPC-157", vialMg: 10, everyDays: 1, shotsPerWeek: 2, startDate: "2026-02-01" },
    tiers: [{ count: 14, doseMg: 0.25 }],
  });
  assert.equal(ok, true);
  assert.equal(store.plans.length, 1);
  const p = store.plans[0];
  assert.equal(p.peptideName, "BPC-157");
  assert.equal(p.scheduleMode, "interval");
  // every 1 day => 7 doses/week, 14 doses => 2 weeks.
  assert.deepEqual(p.tiers, [{ weeks: 2, doseMg: 0.25 }]);
});

test("hydrate migrates v2 count-based tiers to weeks and keeps prefs/tab", () => {
  const store = createStore();
  const ok = hydrate(store, {
    version: 2,
    activeTab: "schedule",
    activePlanId: "p1",
    prefs: { idealUnits: 50, maxUnits: 70, bacBottleMl: 30, bacWindowDays: 28, previewCount: 8 },
    plans: [
      {
        id: "p1",
        peptideName: "Tirzepatide",
        vialMg: 30,
        scheduleMode: "weekly",
        shotsPerWeek: 1,
        everyDays: 3,
        startDate: "2026-01-01",
        tiers: [{ count: 4, doseMg: 2.5 }, { count: 4, doseMg: 5 }],
      },
    ],
  });
  assert.equal(ok, true);
  assert.equal(store.activeTab, "schedule");
  assert.equal(store.prefs.idealUnits, 50);
  assert.equal(store.prefs.bacWindowDays, 28);
  assert.deepEqual(store.plans[0].tiers, [{ weeks: 4, doseMg: 2.5 }, { weeks: 4, doseMg: 5 }]);
});

test("hydrate v3 round-trips through serialize unchanged", () => {
  const store = createStore();
  store.plans = [createPlan({ peptideName: "Semaglutide", vialMg: 5, tiers: [{ weeks: 4, doseMg: 0.25 }] })];
  store.activePlanId = store.plans[0].id;
  store.prefs.idealUnits = 55;

  const payload = serialize(store);
  assert.equal(payload.version, STATE_VERSION);
  assert.ok(!("aiLibrary" in payload), "aiLibrary must not be persisted");

  const restored = createStore();
  assert.equal(hydrate(restored, payload), true);
  assert.equal(restored.plans[0].peptideName, "Semaglutide");
  assert.deepEqual(restored.plans[0].tiers, [{ weeks: 4, doseMg: 0.25 }]);
  assert.equal(restored.prefs.idealUnits, 55);
});

test("hydrate rejects empty or malformed payloads", () => {
  assert.equal(hydrate(createStore(), null), false);
  assert.equal(hydrate(createStore(), {}), false);
  assert.equal(hydrate(createStore(), { version: 3, plans: [] }), false);
});

test("hydrate falls back to first plan when activePlanId is unknown", () => {
  const store = createStore();
  hydrate(store, {
    version: 3,
    activePlanId: "missing",
    prefs: {},
    plans: [createPlan({ id: "real", peptideName: "NAD+" })],
  });
  assert.equal(store.activePlanId, "real");
  assert.equal(getActivePlan(store).peptideName, "NAD+");
});

test("normalized tiers never end up empty", () => {
  const store = createStore();
  hydrate(store, { version: 3, prefs: {}, activePlanId: "x", plans: [createPlan({ id: "x", tiers: [] })] });
  assert.ok(store.plans[0].tiers.length >= 1);
});
