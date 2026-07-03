namespace Shots.Domain;

public sealed record PeptideInfo(
    string Name,
    double[] CommonVialsMg,
    double[] DoseStepsMg,
    double DefaultDoseMg,
    string Mode,
    double? ShotsPerWeek,
    int? EveryDays,
    bool Titrating,
    string Note);

public static class PeptideLibrary
{
    private static readonly List<PeptideInfo> Items =
    [
        new("Tirzepatide", [10, 15, 30, 60], [2.5, 5, 7.5, 10, 12.5, 15], 2.5, ScheduleModes.Weekly, 1, null, true, "GLP-1/GIP agonist. One injection per week, titrated up roughly every 4 weeks as tolerated."),
        new("Semaglutide", [2, 5, 10], [0.25, 0.5, 1, 1.7, 2.4], 0.25, ScheduleModes.Weekly, 1, null, true, "GLP-1 agonist. One injection per week, titrated up monthly."),
        new("Retatrutide", [2, 4, 6, 8, 12], [2, 4, 6, 8, 12], 2, ScheduleModes.Weekly, 1, null, true, "GLP-1/GIP/glucagon triple agonist. Once weekly, titrated every 4 weeks."),
        new("NAD+", [100, 500, 1000], [25, 50, 100], 100, ScheduleModes.Weekly, 2, null, false, "Commonly 50-100 mg, 1-3x per week. Start low to limit flushing."),
        new("BPC-157", [5, 10], [0.25, 0.5], 0.25, ScheduleModes.Interval, null, 1, false, "Often 250-500 mcg once or twice daily through a healing cycle."),
        new("TB-500", [5, 10], [1, 2, 2.5], 2, ScheduleModes.Weekly, 2, null, false, "Loading phase often 2-2.5 mg twice weekly."),
        new("AOD-9604", [5], [0.25, 0.3], 0.25, ScheduleModes.Interval, null, 1, false, "hGH fragment 177-191. Daily, often cycled 5 days on / 2 off."),
        new("Ipamorelin", [2, 5], [0.1, 0.2, 0.3], 0.2, ScheduleModes.Interval, null, 1, false, "GHRP. 100-300 mcg 1-3x daily. Often paired with CJC-1295 no DAC."),
        new("CJC-1295 (no DAC)", [2, 5], [0.1], 0.1, ScheduleModes.Interval, null, 1, false, "GHRH analog (Mod GRF 1-29). 100 mcg 1-3x daily. Commonly paired with Ipamorelin."),
        new("Sermorelin", [3, 6, 9, 15], [0.2, 0.3, 0.5], 0.3, ScheduleModes.Interval, null, 1, false, "GHRH peptide. Daily at bedtime, 200-500 mcg."),
        new("Tesamorelin", [10, 20], [1, 2], 2, ScheduleModes.Interval, null, 1, false, "GHRH analog (Egrifta). 2 mg daily for visceral fat reduction."),
        new("Melanotan II", [10], [0.1, 0.25, 0.5, 1], 0.25, ScheduleModes.Interval, null, 1, true, "MT2. Start at ~100 mcg to assess tolerance. Maintenance 250-500 mcg every 2-3 days."),
        new("GHK-Cu", [50, 100], [1, 2], 1, ScheduleModes.Interval, null, 1, false, "Copper peptide. 1-2 mg 1-2x daily, commonly cycled."),
        new("Thymosin Alpha-1", [1.6, 3.2], [0.45, 1.6], 1.6, ScheduleModes.Interval, null, 2, false, "Immune modulator. Often 1.6 mg every 2-3 days. Varies by protocol."),
        new("MOTS-c", [10], [5, 10], 5, ScheduleModes.Weekly, 3, null, false, "Mitochondrial peptide. 5-10 mg 2-3x weekly."),
        new("SS-31", [10, 20, 40], [4], 4, ScheduleModes.Interval, null, 1, false, "Mitochondrial peptide (Elamipretide). 4 mg daily."),
        new("Epitalon", [100, 200], [5, 10], 5, ScheduleModes.Interval, null, 1, false, "Pineal peptide. 5-10 mg daily in 10-20 day cycles."),
        new("Kisspeptin-10", [5], [0.1, 0.2, 0.3], 0.1, ScheduleModes.Interval, null, 1, false, "Hormone signaling peptide. 100-300 mcg 2-3x daily."),
        new("PT-141", [10], [1, 2], 1, ScheduleModes.Weekly, 1, null, false, "Bremelanotide. 1-2 mg as needed (not daily)."),
        new("DSIP", [5], [0.1, 0.2, 0.3], 0.1, ScheduleModes.Interval, null, 1, false, "Delta sleep-inducing peptide. 100-300 mcg at bedtime."),
        new("GHRP-2", [5], [0.1, 0.2, 0.3], 0.2, ScheduleModes.Interval, null, 1, false, "Growth hormone releasing peptide. 100-300 mcg 1-3x daily."),
        new("GHRP-6", [5], [0.1, 0.2, 0.3], 0.2, ScheduleModes.Interval, null, 1, false, "GHRP with strong appetite stimulation. 100-300 mcg 1-3x daily."),
        new("Hexarelin", [2], [0.1, 0.2], 0.1, ScheduleModes.Interval, null, 1, false, "Potent GHRP. 100-200 mcg 1-2x daily. Cycle to avoid desensitization."),
        new("IGF-1 LR3", [1], [0.02, 0.04, 0.05, 0.1], 0.04, ScheduleModes.Interval, null, 1, false, "Long-acting IGF-1. 20-50 mcg daily post-workout. Cycle 4-6 weeks."),
        new("Selank", [5, 10], [0.25, 0.5], 0.25, ScheduleModes.Interval, null, 1, false, "Anxiolytic nootropic peptide. 250-500 mcg 1-2x daily."),
        new("Semax", [5, 10, 30], [0.4, 0.8], 0.4, ScheduleModes.Interval, null, 1, false, "Nootropic peptide. 400-800 mcg 1-2x daily."),
        new("LL-37", [5], [0.25, 0.5], 0.25, ScheduleModes.Interval, null, 1, false, "Antimicrobial peptide (CAP-18). 250-500 mcg 1-2x daily, typically cycled."),
        new("Thymalin", [100], [5, 10], 5, ScheduleModes.Interval, null, 1, false, "Thymus peptide. 5-10 mg daily in 5-10 day cycles."),
        new("Pinealon", [100], [5, 10], 5, ScheduleModes.Interval, null, 1, false, "Nootropic peptide. 5-10 mg daily in 10-20 day cycles."),
        new("Follistatin 344", [1], [0.1], 0.1, ScheduleModes.Interval, null, 5, false, "Myostatin inhibitor. 100 mcg every 5-7 days for limited cycles.")
    ];

    public static IReadOnlyList<PeptideInfo> All => Items;

    public static IReadOnlyList<string> Names => Items.Select(item => item.Name).ToList();

    public static PeptideInfo? Lookup(string? name)
    {
        var needle = (name ?? "").Trim();
        return string.IsNullOrEmpty(needle)
            ? null
            : Items.FirstOrDefault(item => string.Equals(item.Name, needle, StringComparison.OrdinalIgnoreCase));
    }
}
