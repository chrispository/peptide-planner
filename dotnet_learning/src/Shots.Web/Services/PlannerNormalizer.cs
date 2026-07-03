using Shots.Domain;

namespace Shots.Web.Services;

/// <summary>
/// Clamps a planner store to valid ranges. Mirrors the normalization the
/// Blazor Home page applies before every save so API mutations behave the same.
/// </summary>
public static class PlannerNormalizer
{
    public static void Normalize(PlannerStore store)
    {
        store.Prefs.PreviewCount = (int)StateFactory.Clamp(store.Prefs.PreviewCount, 3, 24);
        store.Prefs.MaxUnits = Math.Max(1, store.Prefs.MaxUnits);
        store.Prefs.IdealUnits = Math.Max(1, store.Prefs.IdealUnits);
        store.Prefs.BacWindowDays = Math.Max(1, store.Prefs.BacWindowDays);

        foreach (var plan in store.Plans)
        {
            plan.VialMg = Math.Max(0.01, plan.VialMg);
            plan.ShotsPerWeek = Math.Max(0.1, plan.ShotsPerWeek);
            plan.EveryDays = Math.Max(1, plan.EveryDays);
            plan.ScheduleMode = plan.ScheduleMode == ScheduleModes.Interval
                ? ScheduleModes.Interval
                : ScheduleModes.Weekly;
            plan.FlexibleDosePct = StateFactory.Clamp(plan.FlexibleDosePct, 1, 100);
            if (plan.Tiers.Count == 0)
            {
                plan.Tiers.Add(new DoseTier { Type = TierTypes.Dose, Weeks = 2.5, Count = 5, DoseMg = 100 });
            }

            foreach (var tier in plan.Tiers)
            {
                tier.Type = tier.Type == TierTypes.Off ? TierTypes.Off : TierTypes.Dose;
                tier.Count = Math.Max(1, tier.Count);
                tier.Weeks = Math.Max(0.5, tier.Weeks);
                tier.DoseMg = tier.Type == TierTypes.Off ? 0 : Math.Max(0.001, tier.DoseMg);
            }
        }

        if (store.Plans.Count > 0 && store.Plans.All(p => p.Id != store.ActivePlanId))
        {
            store.ActivePlanId = store.Plans[0].Id;
        }
    }
}
