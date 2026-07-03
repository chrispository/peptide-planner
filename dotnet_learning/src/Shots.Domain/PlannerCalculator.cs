namespace Shots.Domain;

public static class PlannerCalculator
{
    public static double IntervalDays(PeptidePlan plan)
    {
        return plan.ScheduleMode == ScheduleModes.Interval
            ? Math.Max(1, plan.EveryDays)
            : 7 / Math.Max(0.1, plan.ShotsPerWeek);
    }

    public static double DosesPerWeek(PeptidePlan plan)
    {
        return plan.ScheduleMode == ScheduleModes.Interval
            ? 7 / Math.Max(1, plan.EveryDays)
            : Math.Max(0.1, plan.ShotsPerWeek);
    }

    public static string ScheduleLabel(PeptidePlan plan)
    {
        return plan.ScheduleMode == ScheduleModes.Interval
            ? $"every {plan.EveryDays} days"
            : $"{Formatters.Number(plan.ShotsPerWeek, 1)}x per week";
    }

    public static int TierDoseCount(DoseTier tier, PeptidePlan plan)
    {
        if (tier.Type == TierTypes.Off)
        {
            return 0;
        }

        return plan.ScheduleMode == ScheduleModes.Interval
            ? Math.Max(1, (int)Math.Round((double)(tier.Count == 0 ? 1 : tier.Count)))
            : Math.Max(1, (int)Math.Round((tier.Weeks == 0 ? 0 : tier.Weeks) * DosesPerWeek(plan)));
    }

    public static int TierScheduleCount(DoseTier tier, PeptidePlan plan)
    {
        return plan.ScheduleMode == ScheduleModes.Interval
            ? Math.Max(1, (int)Math.Round((double)(tier.Count == 0 ? 1 : tier.Count)))
            : Math.Max(1, (int)Math.Round((tier.Weeks == 0 ? 0 : tier.Weeks) * DosesPerWeek(plan)));
    }

    public static DosePlanResult BuildDosePlan(PeptidePlan plan)
    {
        var vialMg = Math.Max(0.01, plan.VialMg);
        var flexibleRatio = Math.Max(0.01, Math.Min(1, plan.FlexibleDosePct / 100));
        var doses = new List<DoseEntry>();
        double totalMg = 0;
        var scheduleCursor = 0;

        for (var tierIndex = 0; tierIndex < plan.Tiers.Count; tierIndex++)
        {
            var tier = plan.Tiers[tierIndex];
            var count = TierScheduleCount(tier, plan);
            if (tier.Type == TierTypes.Off)
            {
                scheduleCursor += count;
                continue;
            }

            for (var i = 0; i < count; i++)
            {
                doses.Add(new DoseEntry
                {
                    DoseMg = tier.DoseMg,
                    BaseDoseMg = tier.DoseMg,
                    TierIndex = tierIndex,
                    ScheduleIndex = scheduleCursor
                });
                totalMg += tier.DoseMg;
                scheduleCursor += 1;
            }
        }

        var vialsNeeded = 0;
        var vialRemaining = vialMg;
        var firstVialDoses = 0;
        double unusedAcrossOpenedVials = 0;
        var currentVial = 1;
        var vialStartIndex = 0;
        var cleanupSuggestions = new List<CleanupSuggestion>();

        void CloseVial(int vialNumber, int startIndex, int endIndex, double unusedMg)
        {
            if (endIndex < 0 || endIndex >= doses.Count)
            {
                return;
            }

            var lastDose = doses[endIndex];
            var finalUnusedMg = unusedMg;
            var vialDoses = doses.Skip(startIndex).Take(endIndex - startIndex + 1).ToList();
            var vialTotalMg = vialDoses.Sum(dose => dose.DoseMg);
            var adjustmentRatio = vialTotalMg > 0 ? unusedMg / vialTotalMg : double.PositiveInfinity;

            if (plan.FlexibleDose && unusedMg > 0.001 && adjustmentRatio <= flexibleRatio + 1e-9)
            {
                var runningRemaining = vialMg;
                for (var index = startIndex; index <= endIndex; index++)
                {
                    var dose = doses[index];
                    var addedMg = dose.DoseMg * adjustmentRatio;
                    dose.FlexibleAddedMg = addedMg;
                    dose.DoseMg += addedMg;
                    runningRemaining -= dose.DoseMg;
                    dose.VialRemainingAfter = Math.Max(0, runningRemaining);
                }

                totalMg += unusedMg;
                finalUnusedMg = 0;
                cleanupSuggestions.Add(new CleanupSuggestion
                {
                    VialNumber = vialNumber,
                    ShotStartIndex = startIndex,
                    ShotEndIndex = endIndex,
                    AdjustmentPct = adjustmentRatio * 100,
                    AddedMg = unusedMg,
                    Applied = true
                });
            }

            lastDose.EndsVial = new VialEnd { VialNumber = vialNumber, UnusedMg = finalUnusedMg };
            unusedAcrossOpenedVials += finalUnusedMg;
        }

        for (var index = 0; index < doses.Count; index++)
        {
            var dose = doses[index];
            if (dose.DoseMg > vialRemaining + 1e-6)
            {
                if (index > 0)
                {
                    CloseVial(currentVial, vialStartIndex, index - 1, Math.Max(0, vialRemaining));
                }

                currentVial += 1;
                vialStartIndex = index;
                vialRemaining = vialMg;
            }

            dose.Index = index;
            dose.VialNumber = currentVial;
            dose.OpensVial = index == 0 || doses[index - 1].EndsVial is not null;
            vialRemaining -= dose.DoseMg;
            dose.VialRemainingAfter = Math.Max(0, vialRemaining);
            if (currentVial == 1)
            {
                firstVialDoses += 1;
            }
        }

        if (doses.Count > 0)
        {
            CloseVial(currentVial, vialStartIndex, doses.Count - 1, Math.Max(0, vialRemaining));
            vialsNeeded = currentVial;
        }

        return new DosePlanResult
        {
            Doses = doses,
            TotalMg = totalMg,
            VialsNeeded = vialsNeeded,
            FirstVialDoses = firstVialDoses,
            LastVialLeftover = unusedAcrossOpenedVials,
            CleanupSuggestions = cleanupSuggestions
        };
    }

    public static List<WaterOption> BuildWaterOptions(double vialMg, IReadOnlyList<DoseEntry> doses, PlannerPrefs prefs)
    {
        var doseMgs = doses.Select(dose => dose.DoseMg).ToList();
        var maxDoseMg = doseMgs.Max();
        var options = new List<WaterOption>();

        for (var ml = 0.5; ml <= 10.0001; ml += 0.5)
        {
            var concentration = vialMg / ml;
            var unitsByDose = doseMgs.Select(mg => mg / concentration * 100).ToList();
            var maxUnits = unitsByDose.Max();
            var minUnits = unitsByDose.Min();

            if (maxUnits > 100 || minUnits < 2)
            {
                continue;
            }

            var typicalUnits = maxDoseMg / concentration * 100;
            var highVolumePenalty = maxUnits > prefs.MaxUnits ? (maxUnits - prefs.MaxUnits) * 3.5 : 0;
            var tinyPenalty = minUnits < 10 ? (10 - minUnits) * 1.5 : 0;
            var wholeUnitPenalty = unitsByDose.Sum(units => Math.Abs(units - Math.Round(units)) * 36);
            var fiveUnitPenalty = unitsByDose.Sum(units => Math.Abs(units - Math.Round(units / 5) * 5) * 0.05);
            var score = Math.Abs(typicalUnits - prefs.IdealUnits) +
                highVolumePenalty +
                tinyPenalty +
                wholeUnitPenalty +
                fiveUnitPenalty;

            options.Add(new WaterOption
            {
                Ml = ml,
                Concentration = concentration,
                UnitsByDose = unitsByDose,
                MaxUnits = maxUnits,
                MinUnits = minUnits,
                TypicalUnits = typicalUnits,
                Score = score
            });
        }

        return options.OrderBy(option => option.Score).ThenBy(option => option.Ml).ToList();
    }

    public static ComputedPlan ComputePlan(PeptidePlan plan, PlannerPrefs prefs)
    {
        var vialMg = Math.Max(0.01, plan.VialMg);
        var flexibleRatio = Math.Max(0.01, Math.Min(1, plan.FlexibleDosePct / 100));
        var dosePlan = BuildDosePlan(plan);
        var doses = dosePlan.Doses;

        if (doses.Count == 0)
        {
            return new ComputedPlan { Empty = true, Plan = plan };
        }

        var interval = IntervalDays(plan);
        var options = BuildWaterOptions(vialMg, doses, prefs);
        WaterOption? recommended = null;

        if (plan.FlexibleDose && dosePlan.CleanupSuggestions.Count > 0)
        {
            foreach (var option in options)
            {
                var candidateDoses = CloneDoses(doses);
                var candidate = CloneWaterOption(option);
                if (ApplyWholeUnitCleanup(candidateDoses, dosePlan.CleanupSuggestions, vialMg, candidate, flexibleRatio))
                {
                    doses = candidateDoses;
                    recommended = candidate;
                    break;
                }
            }
        }

        recommended ??= options.FirstOrDefault();
        var startDate = Dates.ParseStartDate(plan.StartDate);
        var bacUseBy = Dates.AddDays(startDate, prefs.BacWindowDays);
        var vialDurationDays = Math.Max(0, (int)Math.Round((Math.Max(1, dosePlan.FirstVialDoses) - 1) * interval));
        var lastScheduleIndex = doses.Max(dose => dose.ScheduleIndex);
        var planDurationDays = Math.Max(0, (int)Math.Round(lastScheduleIndex * interval));

        var shots = doses.Select((dose, index) => new ShotEntry
        {
            Index = index,
            Date = Dates.AddDays(startDate, Math.Round(dose.ScheduleIndex * interval)),
            DoseMg = dose.DoseMg,
            TierIndex = dose.TierIndex,
            BacOpened = index == 0,
            BacExpires = index == 0 ? bacUseBy : null,
            VialNumber = dose.VialNumber,
            OpensVial = dose.OpensVial,
            EndsVial = dose.EndsVial is null ? null : new VialEnd { VialNumber = dose.EndsVial.VialNumber, UnusedMg = dose.EndsVial.UnusedMg },
            VialRemainingAfter = dose.VialRemainingAfter,
            Units = recommended is null ? null : recommended.UnitsByDose[index]
        }).ToList();

        return new ComputedPlan
        {
            Empty = false,
            Plan = plan,
            VialMg = vialMg,
            Doses = doses,
            TotalMg = dosePlan.TotalMg,
            VialsNeeded = dosePlan.VialsNeeded,
            FirstVialDoses = dosePlan.FirstVialDoses,
            LastVialLeftover = dosePlan.LastVialLeftover,
            CleanupSuggestions = dosePlan.CleanupSuggestions,
            Interval = interval,
            Options = options,
            Recommended = recommended,
            StartDate = startDate,
            BacUseBy = bacUseBy,
            VialDurationDays = vialDurationDays,
            PlanDurationDays = planDurationDays,
            Shots = shots,
            LastShotDate = shots[^1].Date
        };
    }

    public static List<ComputedPlanEntry> ComputeAll(IEnumerable<PeptidePlan> plans, PlannerPrefs prefs)
    {
        return plans
            .Select(plan => new ComputedPlanEntry { Plan = plan, Result = ComputePlan(plan, prefs) })
            .Where(entry => !entry.Result.Empty && entry.Result.Recommended is not null)
            .ToList();
    }

    public static List<ShotEntry> MergeSchedule(IEnumerable<ComputedPlanEntry> computed)
    {
        var merged = new List<ShotEntry>();
        foreach (var entry in computed)
        {
            merged.AddRange(entry.Result.Shots.Select(shot => new ShotEntry
            {
                Index = shot.Index,
                Date = shot.Date,
                DoseMg = shot.DoseMg,
                TierIndex = shot.TierIndex,
                BacOpened = shot.BacOpened,
                BacExpires = shot.BacExpires,
                VialNumber = shot.VialNumber,
                OpensVial = shot.OpensVial,
                EndsVial = shot.EndsVial,
                VialRemainingAfter = shot.VialRemainingAfter,
                Units = shot.Units,
                PeptideName = string.IsNullOrWhiteSpace(entry.Plan.PeptideName) ? "Untitled" : entry.Plan.PeptideName
            }));
        }

        merged = merged.OrderBy(shot => shot.Date).ToList();
        for (var i = 0; i < merged.Count; i++)
        {
            merged[i].Index = i;
        }

        return merged;
    }

    public static string SummarizeDoses(IEnumerable<DoseEntry> doses, Func<double, string> formatMg)
    {
        var groups = new List<(double DoseMg, int Count)>();
        foreach (var dose in doses)
        {
            if (groups.Count > 0 && Math.Abs(groups[^1].DoseMg - dose.DoseMg) < 0.0000001)
            {
                groups[^1] = (groups[^1].DoseMg, groups[^1].Count + 1);
            }
            else
            {
                groups.Add((dose.DoseMg, 1));
            }
        }

        return string.Join(", ", groups.Select(group => $"{group.Count}x {formatMg(group.DoseMg)} mg"));
    }

    private static List<DoseEntry> CloneDoses(IEnumerable<DoseEntry> doses)
    {
        return doses.Select(dose => new DoseEntry
        {
            Index = dose.Index,
            DoseMg = dose.DoseMg,
            BaseDoseMg = dose.BaseDoseMg,
            FlexibleAddedMg = dose.FlexibleAddedMg,
            TierIndex = dose.TierIndex,
            ScheduleIndex = dose.ScheduleIndex,
            VialNumber = dose.VialNumber,
            OpensVial = dose.OpensVial,
            EndsVial = dose.EndsVial is null ? null : new VialEnd { VialNumber = dose.EndsVial.VialNumber, UnusedMg = dose.EndsVial.UnusedMg },
            VialRemainingAfter = dose.VialRemainingAfter
        }).ToList();
    }

    private static WaterOption CloneWaterOption(WaterOption option)
    {
        return new WaterOption
        {
            Ml = option.Ml,
            Concentration = option.Concentration,
            UnitsByDose = [.. option.UnitsByDose],
            MaxUnits = option.MaxUnits,
            MinUnits = option.MinUnits,
            TypicalUnits = option.TypicalUnits,
            Score = option.Score
        };
    }

    private static List<int>? AllocateWholeUnitsForVial(IReadOnlyList<DoseEntry> vialDoses, double vialMg, double waterMl, double flexibleRatio)
    {
        var unitMg = vialMg / (waterMl * 100);
        var baseUnits = vialDoses.Select(dose => (dose.BaseDoseMg == 0 ? dose.DoseMg : dose.BaseDoseMg) / unitMg).ToList();
        var totalUnits = (int)Math.Round(waterMl * 100);
        var baseTotal = baseUnits.Sum();
        var extraUnits = totalUnits - baseTotal;
        var minUnits = baseUnits.Select(units => (int)Math.Ceiling(units - 1e-9)).ToList();
        var maxUnits = baseUnits.Select(units => (int)Math.Floor(units * (1 + flexibleRatio) + 1e-9)).ToList();
        var minTotal = minUnits.Sum();
        var maxTotal = maxUnits.Sum();

        if (extraUnits <= 0.001 || minTotal > totalUnits || maxTotal < totalUnits)
        {
            return null;
        }

        var targetUnits = baseUnits.Select(units => units + extraUnits * (units / baseTotal)).ToList();
        var allocated = targetUnits
            .Select((units, index) => Math.Min(maxUnits[index], Math.Max(minUnits[index], (int)Math.Floor(units))))
            .ToList();
        var allocatedTotal = allocated.Sum();

        while (allocatedTotal < totalUnits)
        {
            var bestIndex = -1;
            var bestScore = double.NegativeInfinity;
            for (var index = 0; index < allocated.Count; index++)
            {
                if (allocated[index] >= maxUnits[index])
                {
                    continue;
                }

                var score = targetUnits[index] - allocated[index];
                if (score > bestScore)
                {
                    bestScore = score;
                    bestIndex = index;
                }
            }

            if (bestIndex == -1)
            {
                return null;
            }

            allocated[bestIndex] += 1;
            allocatedTotal += 1;
        }

        while (allocatedTotal > totalUnits)
        {
            var bestIndex = -1;
            var bestScore = double.PositiveInfinity;
            for (var index = 0; index < allocated.Count; index++)
            {
                if (allocated[index] <= minUnits[index])
                {
                    continue;
                }

                var score = targetUnits[index] - allocated[index];
                if (score < bestScore)
                {
                    bestScore = score;
                    bestIndex = index;
                }
            }

            if (bestIndex == -1)
            {
                return null;
            }

            allocated[bestIndex] -= 1;
            allocatedTotal -= 1;
        }

        return allocated;
    }

    private static bool ApplyWholeUnitCleanup(
        List<DoseEntry> doses,
        IEnumerable<CleanupSuggestion> cleanupSuggestions,
        double vialMg,
        WaterOption recommended,
        double flexibleRatio)
    {
        foreach (var suggestion in cleanupSuggestions.Where(suggestion => suggestion.Applied))
        {
            var vialDoses = doses.Skip(suggestion.ShotStartIndex).Take(suggestion.ShotEndIndex - suggestion.ShotStartIndex + 1).ToList();
            var allocatedUnits = AllocateWholeUnitsForVial(vialDoses, vialMg, recommended.Ml, flexibleRatio);
            if (allocatedUnits is null)
            {
                return false;
            }

            var runningRemaining = vialMg;
            for (var offset = 0; offset < allocatedUnits.Count; offset++)
            {
                var dose = doses[suggestion.ShotStartIndex + offset];
                var baseDoseMg = dose.BaseDoseMg == 0 ? dose.DoseMg : dose.BaseDoseMg;
                dose.DoseMg = allocatedUnits[offset] * recommended.Concentration / 100;
                dose.FlexibleAddedMg = dose.DoseMg - baseDoseMg;
                runningRemaining -= dose.DoseMg;
                dose.VialRemainingAfter = Math.Max(0, runningRemaining);
            }

            var lastDose = doses[suggestion.ShotEndIndex];
            lastDose.EndsVial = new VialEnd
            {
                VialNumber = lastDose.EndsVial?.VialNumber ?? suggestion.VialNumber,
                UnusedMg = 0
            };
        }

        recommended.UnitsByDose = doses.Select(dose => dose.DoseMg / recommended.Concentration * 100).ToList();
        recommended.MaxUnits = recommended.UnitsByDose.Max();
        recommended.MinUnits = recommended.UnitsByDose.Min();
        return true;
    }
}
