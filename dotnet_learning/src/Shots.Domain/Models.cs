using System.Text.Json.Serialization;

namespace Shots.Domain;

public static class StateVersion
{
    public const int Current = 5;
}

public static class ScheduleModes
{
    public const string Weekly = "weekly";
    public const string Interval = "interval";
}

public static class TierTypes
{
    public const string Dose = "dose";
    public const string Off = "off";
}

public sealed class PlannerPrefs
{
    public int PreviewCount { get; set; } = 8;
    public double MaxUnits { get; set; } = 70;
    public double IdealUnits { get; set; } = 60;
    public int BacWindowDays { get; set; } = 35;
    public List<string> ManualBacOpenDates { get; set; } = [];
}

public sealed class DoseTier
{
    public string Type { get; set; } = TierTypes.Dose;
    public double Weeks { get; set; } = 2.5;
    public int Count { get; set; } = 5;
    public double DoseMg { get; set; } = 100;
}

public sealed class PeptidePlan
{
    public string Id { get; set; } = Ids.NewPlanId();
    public string PeptideName { get; set; } = "NAD+";
    public double VialMg { get; set; } = 500;
    public string StartDate { get; set; } = Dates.DateInputValue(DateTime.Today);
    public string ScheduleMode { get; set; } = ScheduleModes.Weekly;
    public double ShotsPerWeek { get; set; } = 2;
    public int EveryDays { get; set; } = 3;
    public bool FlexibleDose { get; set; }
    public double FlexibleDosePct { get; set; } = 10;
    public List<DoseTier> Tiers { get; set; } = [new()];
}

public sealed class PlannerStore
{
    public int Version { get; set; } = StateVersion.Current;
    public PlannerPrefs Prefs { get; set; } = new();
    public List<PeptidePlan> Plans { get; set; } = [StateFactory.CreatePlan()];
    public string ActivePlanId { get; set; } = "";
    public string ActiveTab { get; set; } = "reconstitution";

    [JsonIgnore]
    public PeptidePlan? ActivePlan => Plans.FirstOrDefault(p => p.Id == ActivePlanId) ?? Plans.FirstOrDefault();
}

public sealed class DoseEntry
{
    public int Index { get; set; }
    public double DoseMg { get; set; }
    public double BaseDoseMg { get; set; }
    public double FlexibleAddedMg { get; set; }
    public int TierIndex { get; set; }
    public int ScheduleIndex { get; set; }
    public int VialNumber { get; set; }
    public bool OpensVial { get; set; }
    public VialEnd? EndsVial { get; set; }
    public double VialRemainingAfter { get; set; }
}

public sealed class VialEnd
{
    public int VialNumber { get; set; }
    public double UnusedMg { get; set; }
}

public sealed class CleanupSuggestion
{
    public int VialNumber { get; set; }
    public int ShotStartIndex { get; set; }
    public int ShotEndIndex { get; set; }
    public double AdjustmentPct { get; set; }
    public double AddedMg { get; set; }
    public bool Applied { get; set; }
}

public sealed class DosePlanResult
{
    public List<DoseEntry> Doses { get; set; } = [];
    public double TotalMg { get; set; }
    public int VialsNeeded { get; set; }
    public int FirstVialDoses { get; set; }
    public double LastVialLeftover { get; set; }
    public List<CleanupSuggestion> CleanupSuggestions { get; set; } = [];
}

public sealed class WaterOption
{
    public double Ml { get; set; }
    public double Concentration { get; set; }
    public List<double> UnitsByDose { get; set; } = [];
    public double MaxUnits { get; set; }
    public double MinUnits { get; set; }
    public double TypicalUnits { get; set; }
    public double Score { get; set; }
}

public sealed class ShotEntry
{
    public int Index { get; set; }
    public DateTime Date { get; set; }
    public double DoseMg { get; set; }
    public int TierIndex { get; set; }
    public bool BacOpened { get; set; }
    public DateTime? BacExpires { get; set; }
    public int VialNumber { get; set; }
    public bool OpensVial { get; set; }
    public VialEnd? EndsVial { get; set; }
    public double VialRemainingAfter { get; set; }
    public double? Units { get; set; }
    public string PeptideName { get; set; } = "";
}

public sealed class ComputedPlan
{
    public bool Empty { get; set; }
    public PeptidePlan Plan { get; set; } = new();
    public double VialMg { get; set; }
    public List<DoseEntry> Doses { get; set; } = [];
    public double TotalMg { get; set; }
    public int VialsNeeded { get; set; }
    public int FirstVialDoses { get; set; }
    public double LastVialLeftover { get; set; }
    public List<CleanupSuggestion> CleanupSuggestions { get; set; } = [];
    public double Interval { get; set; }
    public List<WaterOption> Options { get; set; } = [];
    public WaterOption? Recommended { get; set; }
    public DateTime StartDate { get; set; }
    public DateTime BacUseBy { get; set; }
    public int VialDurationDays { get; set; }
    public int PlanDurationDays { get; set; }
    public List<ShotEntry> Shots { get; set; } = [];
    public DateTime LastShotDate { get; set; }
}

public sealed class ComputedPlanEntry
{
    public PeptidePlan Plan { get; set; } = new();
    public ComputedPlan Result { get; set; } = new();
}

internal static class Ids
{
    private static int _sequence;

    public static string NewPlanId()
    {
        var value = Interlocked.Increment(ref _sequence);
        return $"plan-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}-{value}";
    }
}
