using Shots.Domain;

namespace Shots.Domain.Tests;

public sealed class StateTests
{
    [Fact]
    public void CreateStoreYieldsOneDefaultPlanAndSanePrefs()
    {
        var store = StateFactory.CreateStore();

        Assert.Single(store.Plans);
        Assert.Equal(store.Plans[0].Id, store.ActivePlanId);
        Assert.Equal(60, store.Prefs.IdealUnits);
        Assert.Equal(StateVersion.Current, store.Version);
        Assert.False(store.Plans[0].FlexibleDose);
        Assert.Equal(10, store.Plans[0].FlexibleDosePct);
    }

    [Fact]
    public void HydrateMigratesLegacyV1ToHybridTiers()
    {
        var store = StateFactory.CreateStore();
        var ok = StateFactory.Hydrate(store, """
        {
          "scheduleMode": "interval",
          "fields": { "peptideName": "BPC-157", "vialMg": 10, "everyDays": 1, "shotsPerWeek": 2, "startDate": "2026-02-01" },
          "tiers": [{ "count": 14, "doseMg": 0.25 }]
        }
        """);

        Assert.True(ok);
        Assert.Single(store.Plans);
        var plan = store.Plans[0];
        Assert.Equal("BPC-157", plan.PeptideName);
        Assert.Equal(ScheduleModes.Interval, plan.ScheduleMode);
        AssertEquivalentTier(new DoseTier { Type = TierTypes.Dose, Weeks = 2, Count = 14, DoseMg = 0.25 }, plan.Tiers[0]);
    }

    [Fact]
    public void HydrateMigratesV2CountBasedTiersAndKeepsPrefsTab()
    {
        var store = StateFactory.CreateStore();
        var ok = StateFactory.Hydrate(store, """
        {
          "version": 2,
          "activeTab": "schedule",
          "activePlanId": "p1",
          "prefs": { "idealUnits": 50, "maxUnits": 70, "bacBottleMl": 30, "bacWindowDays": 28, "previewCount": 8 },
          "plans": [
            {
              "id": "p1",
              "peptideName": "Tirzepatide",
              "vialMg": 30,
              "scheduleMode": "weekly",
              "shotsPerWeek": 1,
              "everyDays": 3,
              "startDate": "2026-01-01",
              "tiers": [{ "count": 4, "doseMg": 2.5 }, { "count": 4, "doseMg": 5 }]
            }
          ]
        }
        """);

        Assert.True(ok);
        Assert.Equal("schedule", store.ActiveTab);
        Assert.Equal(50, store.Prefs.IdealUnits);
        Assert.Equal(28, store.Prefs.BacWindowDays);
        AssertEquivalentTier(new DoseTier { Type = TierTypes.Dose, Weeks = 4, Count = 4, DoseMg = 2.5 }, store.Plans[0].Tiers[0]);
        AssertEquivalentTier(new DoseTier { Type = TierTypes.Dose, Weeks = 4, Count = 4, DoseMg = 5 }, store.Plans[0].Tiers[1]);
    }

    [Fact]
    public void HydrateRoundTripsThroughSerializeUnchanged()
    {
        var store = StateFactory.CreateStore();
        store.Plans =
        [
            StateFactory.CreatePlan(p =>
            {
                p.PeptideName = "Semaglutide";
                p.VialMg = 5;
                p.Tiers = [new DoseTier { Weeks = 4, Count = 4, DoseMg = 0.25 }];
            })
        ];
        store.ActivePlanId = store.Plans[0].Id;
        store.Prefs.IdealUnits = 55;

        var payload = StateFactory.Serialize(store);
        var restored = StateFactory.CreateStore();

        Assert.True(StateFactory.Hydrate(restored, payload));
        Assert.Equal("Semaglutide", restored.Plans[0].PeptideName);
        AssertEquivalentTier(new DoseTier { Type = TierTypes.Dose, Weeks = 4, Count = 4, DoseMg = 0.25 }, restored.Plans[0].Tiers[0]);
        Assert.Equal(55, restored.Prefs.IdealUnits);
    }

    [Fact]
    public void HydrateNormalizesManualBacOpenDates()
    {
        var store = StateFactory.CreateStore();
        var id = "x";
        var ok = StateFactory.Hydrate(store, $$"""
        {
          "version": 5,
          "prefs": { "manualBacOpenDates": ["2026-02-10", "bad", "2026-02-01", "2026-02-10"] },
          "activePlanId": "{{id}}",
          "plans": [{ "id": "{{id}}" }]
        }
        """);

        Assert.True(ok);
        Assert.Equal(["2026-02-01", "2026-02-10"], store.Prefs.ManualBacOpenDates);
    }

    [Fact]
    public void HydrateRejectsEmptyOrMalformedPayloads()
    {
        Assert.False(StateFactory.Hydrate(StateFactory.CreateStore(), "null"));
        Assert.False(StateFactory.Hydrate(StateFactory.CreateStore(), "{}"));
        Assert.False(StateFactory.Hydrate(StateFactory.CreateStore(), """{ "version": 4, "plans": [] }"""));
    }

    [Fact]
    public void HydrateFallsBackToFirstPlanWhenActivePlanIdIsUnknown()
    {
        var store = StateFactory.CreateStore();

        StateFactory.Hydrate(store, """
        {
          "version": 4,
          "activePlanId": "missing",
          "prefs": {},
          "plans": [{ "id": "real", "peptideName": "NAD+" }]
        }
        """);

        Assert.Equal("real", store.ActivePlanId);
        Assert.Equal("NAD+", StateFactory.GetActivePlan(store)!.PeptideName);
    }

    [Fact]
    public void NormalizedTiersNeverEndUpEmpty()
    {
        var store = StateFactory.CreateStore();

        StateFactory.Hydrate(store, """
        {
          "version": 4,
          "prefs": {},
          "activePlanId": "x",
          "plans": [{ "id": "x", "tiers": [] }]
        }
        """);

        Assert.NotEmpty(store.Plans[0].Tiers);
    }

    private static void AssertEquivalentTier(DoseTier expected, DoseTier actual)
    {
        Assert.Equal(expected.Type, actual.Type);
        Assert.Equal(expected.Weeks, actual.Weeks);
        Assert.Equal(expected.Count, actual.Count);
        Assert.Equal(expected.DoseMg, actual.DoseMg);
    }
}
