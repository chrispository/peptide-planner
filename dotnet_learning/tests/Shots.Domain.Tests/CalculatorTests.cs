using Shots.Domain;

namespace Shots.Domain.Tests;

public sealed class CalculatorTests
{
    private static readonly PlannerPrefs Prefs = new()
    {
        PreviewCount = 8,
        MaxUnits = 70,
        IdealUnits = 60,
        BacWindowDays = 35
    };

    private static PeptidePlan Plan(Action<PeptidePlan>? configure = null)
    {
        return StateFactory.CreatePlan(plan =>
        {
            plan.Id = "t";
            plan.PeptideName = "NAD+";
            plan.VialMg = 500;
            plan.StartDate = "2026-01-01";
            plan.ScheduleMode = ScheduleModes.Weekly;
            plan.ShotsPerWeek = 2;
            plan.EveryDays = 3;
            plan.Tiers = [new DoseTier { Type = TierTypes.Dose, Weeks = 2.5, Count = 5, DoseMg = 100 }];
            configure?.Invoke(plan);
        });
    }

    [Fact]
    public void CadenceHelpersConvertBetweenWeeklyAndInterval()
    {
        Assert.Equal(2, PlannerCalculator.DosesPerWeek(Plan(p => p.ShotsPerWeek = 2)));
        Assert.Equal(3.5, PlannerCalculator.IntervalDays(Plan(p => p.ShotsPerWeek = 2)));
        Assert.Equal(1, PlannerCalculator.DosesPerWeek(Plan(p => { p.ScheduleMode = ScheduleModes.Interval; p.EveryDays = 7; })));
        Assert.Equal(3, PlannerCalculator.IntervalDays(Plan(p => { p.ScheduleMode = ScheduleModes.Interval; p.EveryDays = 3; })));
    }

    [Fact]
    public void TierDoseCountUsesWeeksForWeeklyModeAndCountForIntervalMode()
    {
        Assert.Equal(5, PlannerCalculator.TierDoseCount(new DoseTier { Weeks = 2.5, DoseMg = 100 }, Plan(p => p.ShotsPerWeek = 2)));
        Assert.Equal(1, PlannerCalculator.TierDoseCount(new DoseTier { Weeks = 0.1, DoseMg = 100 }, Plan(p => p.ShotsPerWeek = 1)));
        Assert.Equal(3, PlannerCalculator.TierDoseCount(new DoseTier { Weeks = 10, Count = 3, DoseMg = 100 }, Plan(p => p.ScheduleMode = ScheduleModes.Interval)));
    }

    [Fact]
    public void BuildDosePlanFlattensPhasesAndCountsVials()
    {
        var result = PlannerCalculator.BuildDosePlan(Plan());

        Assert.Equal(5, result.Doses.Count);
        Assert.Equal(500, result.TotalMg);
        Assert.Equal(1, result.VialsNeeded);
    }

    [Fact]
    public void BuildDosePlanSplitsAcrossMultipleVialsWhenPlanExceedsOne()
    {
        var result = PlannerCalculator.BuildDosePlan(Plan(p =>
        {
            p.VialMg = 30;
            p.ScheduleMode = ScheduleModes.Weekly;
            p.ShotsPerWeek = 1;
            p.Tiers = [new DoseTier { Weeks = 8, Count = 8, DoseMg = 5 }];
        }));

        Assert.Equal(40, result.TotalMg);
        Assert.Equal(2, result.VialsNeeded);
        Assert.Equal(20, result.LastVialLeftover);
    }

    [Fact]
    public void BuildDosePlanTracksUnusedMedicationAcrossOpenedVials()
    {
        var result = PlannerCalculator.BuildDosePlan(Plan(p =>
        {
            p.VialMg = 500;
            p.FlexibleDose = true;
            p.ScheduleMode = ScheduleModes.Interval;
            p.EveryDays = 3;
            p.FlexibleDosePct = 20;
            p.Tiers =
            [
                new DoseTier { Weeks = 1, Count = 1, DoseMg = 75 },
                new DoseTier { Weeks = 1, Count = 1, DoseMg = 100 },
                new DoseTier { Weeks = 1, Count = 1, DoseMg = 125 },
                new DoseTier { Weeks = 1, Count = 14, DoseMg = 150 }
            ];
        }));

        Assert.Equal(2650, result.TotalMg);
        Assert.Equal(6, result.VialsNeeded);
        Assert.Equal(350, result.LastVialLeftover);

        var suggestions = result.CleanupSuggestions.Take(2).Select(s => new
        {
            s.VialNumber,
            s.ShotStartIndex,
            s.ShotEndIndex,
            s.AddedMg,
            AdjustmentPct = Math.Round(s.AdjustmentPct * 10) / 10,
            s.Applied
        }).ToArray();

        Assert.Equal(new[]
        {
            new { VialNumber = 1, ShotStartIndex = 0, ShotEndIndex = 3, AddedMg = 50d, AdjustmentPct = 11.1, Applied = true },
            new { VialNumber = 2, ShotStartIndex = 4, ShotEndIndex = 6, AddedMg = 50d, AdjustmentPct = 11.1, Applied = true }
        }, suggestions);
    }

    [Fact]
    public void FlexibleDosingAppliesCleanupToComputedDosesAndVialRemainder()
    {
        var result = PlannerCalculator.BuildDosePlan(Plan(p =>
        {
            p.VialMg = 500;
            p.FlexibleDose = true;
            p.FlexibleDosePct = 12;
            p.ScheduleMode = ScheduleModes.Interval;
            p.Tiers = [new DoseTier { Weeks = 1, Count = 3, DoseMg = 150 }];
        }));

        Assert.Equal(500, result.TotalMg);
        Assert.Equal(0, result.LastVialLeftover);
        Assert.Equal(3, result.Doses.Count);
        Assert.Equal(166.667, Math.Round(result.Doses[0].DoseMg, 3));
        Assert.Equal(0, result.Doses[2].EndsVial!.UnusedMg);
        Assert.True(result.CleanupSuggestions[0].Applied);
    }

    [Fact]
    public void ComputePlanKeepsFlexibleCleanupOnWholeNumberSyringeUnitsWhenPossible()
    {
        var result = PlannerCalculator.ComputePlan(Plan(p =>
        {
            p.VialMg = 500;
            p.FlexibleDose = true;
            p.FlexibleDosePct = 20;
            p.ScheduleMode = ScheduleModes.Interval;
            p.EveryDays = 3;
            p.Tiers =
            [
                new DoseTier { Weeks = 1, Count = 1, DoseMg = 75 },
                new DoseTier { Weeks = 1, Count = 1, DoseMg = 100 },
                new DoseTier { Weeks = 1, Count = 1, DoseMg = 125 },
                new DoseTier { Weeks = 1, Count = 14, DoseMg = 150 }
            ];
        }), Prefs);

        Assert.Equal(1.5, result.Recommended!.Ml);
        Assert.Equal([25d, 33d, 42d, 50d], result.Recommended.UnitsByDose.Take(4).Select(units => Math.Round(units)).ToArray());
        foreach (var units in result.Recommended.UnitsByDose.Take(16))
        {
            Assert.True(Math.Abs(units - Math.Round(units)) < 0.001);
        }
    }

    [Fact]
    public void CleanupSuggestionsRespectFlexibleDosePercentage()
    {
        var result = PlannerCalculator.BuildDosePlan(Plan(p =>
        {
            p.VialMg = 500;
            p.FlexibleDose = true;
            p.FlexibleDosePct = 10;
            p.ScheduleMode = ScheduleModes.Interval;
            p.Tiers = [new DoseTier { Weeks = 1, Count = 4, DoseMg = 150 }];
        }));

        Assert.Equal(400, result.LastVialLeftover);
        Assert.Empty(result.CleanupSuggestions);
    }

    [Fact]
    public void ComputePlanRecommendsTheCanonicalNadReconstitution()
    {
        var result = PlannerCalculator.ComputePlan(Plan(), Prefs);

        Assert.False(result.Empty);
        Assert.Equal(3, result.Recommended!.Ml);
        Assert.Equal(166.7, Math.Round(result.Recommended.Concentration, 1));
        Assert.Equal(5, result.Doses.Count);
        Assert.Equal(1, result.VialsNeeded);
    }

    [Fact]
    public void ComputePlanKeepsEveryShotWithinA100UnitSyringe()
    {
        var result = PlannerCalculator.ComputePlan(Plan(), Prefs);

        foreach (var units in result.Recommended!.UnitsByDose)
        {
            Assert.True(units is <= 100 and >= 2, $"units out of range: {units}");
        }
    }

    [Fact]
    public void ComputePlanPrefersWholeNumberSyringeUnits()
    {
        var result = PlannerCalculator.ComputePlan(Plan(p =>
        {
            p.PeptideName = "Test";
            p.VialMg = 30;
            p.Tiers = [new DoseTier { Weeks = 1, Count = 1, DoseMg = 2.5 }];
        }), new PlannerPrefs { PreviewCount = 8, MaxUnits = 70, IdealUnits = 20, BacWindowDays = 35 });

        Assert.Equal(3, result.Recommended!.Ml);
        Assert.Equal(25, result.Recommended.UnitsByDose[0]);
    }

    [Fact]
    public void ComputePlanDatesShotsFromStartDateAtCadenceInterval()
    {
        var result = PlannerCalculator.ComputePlan(Plan(p =>
        {
            p.StartDate = "2026-01-01";
            p.ShotsPerWeek = 2;
        }), Prefs);

        Assert.Equal(2026, result.Shots[0].Date.Year);
        Assert.True(result.Shots[0].BacOpened);
        Assert.Equal("2026-02-05", Dates.DateInputValue(result.Shots[0].BacExpires!.Value));
        Assert.False(result.Shots[1].BacOpened);
        Assert.Equal(7, Dates.DaysBetween(result.Shots[0].Date, result.Shots[2].Date));
    }

    [Fact]
    public void OffPhasesSkipScheduledDoseSlotsWithoutAddingMedication()
    {
        var result = PlannerCalculator.ComputePlan(Plan(p =>
        {
            p.StartDate = "2026-01-01";
            p.ScheduleMode = ScheduleModes.Weekly;
            p.ShotsPerWeek = 1;
            p.Tiers =
            [
                new DoseTier { Type = TierTypes.Dose, Weeks = 1, Count = 1, DoseMg = 100 },
                new DoseTier { Type = TierTypes.Off, Weeks = 2, Count = 2, DoseMg = 0 },
                new DoseTier { Type = TierTypes.Dose, Weeks = 1, Count = 1, DoseMg = 100 }
            ];
        }), Prefs);

        Assert.Equal(2, result.Doses.Count);
        Assert.Equal(200, result.TotalMg);
        Assert.Equal("2026-01-01", Dates.DateInputValue(result.Shots[0].Date));
        Assert.Equal("2026-01-22", Dates.DateInputValue(result.Shots[1].Date));
    }

    [Fact]
    public void ComputePlanReturnsEmptyWhenThereAreNoPhases()
    {
        var result = PlannerCalculator.ComputePlan(Plan(p => p.Tiers = []), Prefs);

        Assert.True(result.Empty);
    }

    [Fact]
    public void ComputeAllDropsUncomputablePlansAndMergeScheduleSortsByDate()
    {
        var a = Plan(p => { p.Id = "a"; p.PeptideName = "NAD+"; p.StartDate = "2026-01-10"; });
        var b = Plan(p =>
        {
            p.Id = "b";
            p.PeptideName = "TB-500";
            p.VialMg = 10;
            p.StartDate = "2026-01-01";
            p.Tiers = [new DoseTier { Weeks = 2, Count = 4, DoseMg = 2 }];
        });

        var computed = PlannerCalculator.ComputeAll([a, b], Prefs);
        var merged = PlannerCalculator.MergeSchedule(computed);

        Assert.Equal(2, computed.Count);
        for (var i = 1; i < merged.Count; i++)
        {
            Assert.True(merged[i].Date >= merged[i - 1].Date, "merged schedule not sorted");
        }

        Assert.Equal("TB-500", merged[0].PeptideName);
    }

    [Fact]
    public void SummarizeDosesGroupsConsecutiveEqualDoses()
    {
        var doses = new[]
        {
            new DoseEntry { DoseMg = 2.5 },
            new DoseEntry { DoseMg = 2.5 },
            new DoseEntry { DoseMg = 5 }
        };

        Assert.Equal("2x 2.5 mg, 1x 5 mg", PlannerCalculator.SummarizeDoses(doses, v => v.ToString()));
    }
}
