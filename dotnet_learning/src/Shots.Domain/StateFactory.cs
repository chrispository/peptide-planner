using System.Text.Json;

namespace Shots.Domain;

public static class StateFactory
{
    public static PlannerPrefs DefaultPrefs() => new();

    public static PlannerStore CreateStore()
    {
        var plan = CreatePlan();
        return new PlannerStore
        {
            Version = StateVersion.Current,
            Prefs = DefaultPrefs(),
            Plans = [plan],
            ActivePlanId = plan.Id,
            ActiveTab = "reconstitution"
        };
    }

    public static PeptidePlan CreatePlan(Action<PeptidePlan>? configure = null)
    {
        var plan = new PeptidePlan
        {
            Id = Ids.NewPlanId(),
            PeptideName = "NAD+",
            VialMg = 500,
            StartDate = Dates.DateInputValue(DateTime.Today),
            ScheduleMode = ScheduleModes.Weekly,
            ShotsPerWeek = 2,
            EveryDays = 3,
            FlexibleDose = false,
            FlexibleDosePct = 10,
            Tiers = [new DoseTier { Type = TierTypes.Dose, Weeks = 2.5, Count = 5, DoseMg = 100 }]
        };
        configure?.Invoke(plan);
        return plan;
    }

    public static PeptidePlan? GetActivePlan(PlannerStore store) => store.ActivePlan;

    public static double Num(string? value, double fallback = 0)
    {
        return double.TryParse(value, out var parsed) && double.IsFinite(parsed) ? parsed : fallback;
    }

    public static double Clamp(double value, double min, double max) => Math.Min(max, Math.Max(min, value));

    public static bool Hydrate(PlannerStore store, string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            return Hydrate(store, document.RootElement);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    public static bool Hydrate(PlannerStore store, JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object)
        {
            return false;
        }

        if (!IsKnownVersion(payload) && payload.TryGetProperty("fields", out var fields))
        {
            return HydrateLegacyV1(store, payload, fields);
        }

        if (!payload.TryGetProperty("plans", out var plansElement) ||
            plansElement.ValueKind != JsonValueKind.Array ||
            plansElement.GetArrayLength() == 0)
        {
            return false;
        }

        store.Prefs = NormalizePrefs(payload.TryGetProperty("prefs", out var prefs) ? prefs : default);
        store.Plans = plansElement.EnumerateArray().Select(ReadPlan).ToList();
        if (store.Plans.Count == 0)
        {
            return false;
        }

        var activePlanId = ReadString(payload, "activePlanId", "");
        store.ActivePlanId = store.Plans.Any(p => p.Id == activePlanId) ? activePlanId : store.Plans[0].Id;
        store.ActiveTab = ReadString(payload, "activeTab", "") == "schedule" ? "schedule" : "reconstitution";
        store.Version = StateVersion.Current;
        return true;
    }

    public static string Serialize(PlannerStore store) => JsonSerializer.Serialize(store, PlannerJson.Options);

    private static bool IsKnownVersion(JsonElement payload)
    {
        return payload.TryGetProperty("version", out var version) &&
            version.TryGetInt32(out var value) &&
            value is 2 or 3 or 4 or 5;
    }

    private static bool HydrateLegacyV1(PlannerStore store, JsonElement payload, JsonElement fields)
    {
        store.Prefs = NormalizePrefs(fields);
        var plan = CreatePlan(p =>
        {
            p.PeptideName = ReadString(fields, "peptideName", "NAD+");
            p.VialMg = ReadDouble(fields, "vialMg", 500);
            p.StartDate = ReadString(fields, "startDate", Dates.DateInputValue(DateTime.Today));
            p.ScheduleMode = ReadString(payload, "scheduleMode", "") == ScheduleModes.Interval
                ? ScheduleModes.Interval
                : ScheduleModes.Weekly;
            p.ShotsPerWeek = ReadDouble(fields, "shotsPerWeek", 2);
            p.EveryDays = (int)Math.Max(1, Math.Round(ReadDouble(fields, "everyDays", 3)));
        });
        plan.Tiers = NormalizeTiers(payload.TryGetProperty("tiers", out var tiers) ? tiers : default, plan);
        store.Plans = [plan];
        store.ActivePlanId = plan.Id;
        store.ActiveTab = "reconstitution";
        store.Version = StateVersion.Current;
        return true;
    }

    private static PlannerPrefs NormalizePrefs(JsonElement rawPrefs)
    {
        return new PlannerPrefs
        {
            PreviewCount = (int)ReadDouble(rawPrefs, "previewCount", 8),
            MaxUnits = ReadDouble(rawPrefs, "maxUnits", 70),
            IdealUnits = ReadDouble(rawPrefs, "idealUnits", 60),
            BacWindowDays = (int)ReadDouble(rawPrefs, "bacWindowDays", 35),
            ManualBacOpenDates = NormalizeManualBacOpenDates(rawPrefs)
        };
    }

    private static List<string> NormalizeManualBacOpenDates(JsonElement rawPrefs)
    {
        if (rawPrefs.ValueKind != JsonValueKind.Object ||
            !rawPrefs.TryGetProperty("manualBacOpenDates", out var dates) ||
            dates.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return dates.EnumerateArray()
            .Select(date => date.ValueKind == JsonValueKind.String ? date.GetString() : null)
            .Where(date => date is not null && DateTime.TryParseExact(date, "yyyy-MM-dd", null, System.Globalization.DateTimeStyles.None, out _))
            .Select(date => date!)
            .Distinct()
            .Order()
            .ToList();
    }

    private static PeptidePlan ReadPlan(JsonElement raw)
    {
        var plan = CreatePlan(p =>
        {
            p.Id = ReadString(raw, "id", Ids.NewPlanId());
            p.PeptideName = ReadString(raw, "peptideName", "NAD+");
            p.VialMg = ReadDouble(raw, "vialMg", 500);
            p.StartDate = ReadString(raw, "startDate", Dates.DateInputValue(DateTime.Today));
            p.ScheduleMode = ReadString(raw, "scheduleMode", "") == ScheduleModes.Interval
                ? ScheduleModes.Interval
                : ScheduleModes.Weekly;
            p.ShotsPerWeek = ReadDouble(raw, "shotsPerWeek", 2);
            p.EveryDays = (int)Math.Max(1, Math.Round(ReadDouble(raw, "everyDays", 3)));
            p.FlexibleDose = ReadBool(raw, "flexibleDose", false);
            p.FlexibleDosePct = ReadDouble(raw, "flexibleDosePct", 10);
        });
        plan.Tiers = NormalizeTiers(raw.TryGetProperty("tiers", out var tiers) ? tiers : default, plan);
        return plan;
    }

    private static List<DoseTier> NormalizeTiers(JsonElement tiers, PeptidePlan plan)
    {
        if (tiers.ValueKind != JsonValueKind.Array)
        {
            return [new DoseTier { Type = TierTypes.Dose, Weeks = 2.5, Count = 5, DoseMg = 100 }];
        }

        var list = new List<DoseTier>();
        foreach (var raw in tiers.EnumerateArray())
        {
            var type = ReadString(raw, "type", TierTypes.Dose) == TierTypes.Off ? TierTypes.Off : TierTypes.Dose;
            var doseMg = type == TierTypes.Off ? 0 : Math.Max(0.001, ReadDouble(raw, "doseMg", 1));
            var hasWeeks = TryReadDouble(raw, "weeks", out var rawWeeks);
            var hasCount = TryReadDouble(raw, "count", out var rawCount);
            var count = hasCount
                ? Math.Max(1, (int)Math.Round(rawCount))
                : Math.Max(1, (int)Math.Round((hasWeeks ? rawWeeks : 1) * PlannerCalculator.DosesPerWeek(plan)));
            var weeks = hasWeeks
                ? Math.Max(0.5, rawWeeks)
                : Math.Max(0.5, count / PlannerCalculator.DosesPerWeek(plan));
            list.Add(new DoseTier { Type = type, Weeks = weeks, Count = count, DoseMg = doseMg });
        }

        return list.Count > 0 ? list : [new DoseTier { Type = TierTypes.Dose, Weeks = 2.5, Count = 5, DoseMg = 100 }];
    }

    private static string ReadString(JsonElement element, string name, string fallback)
    {
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(name, out var property) &&
            property.ValueKind == JsonValueKind.String
            ? property.GetString() ?? fallback
            : fallback;
    }

    private static bool ReadBool(JsonElement element, string name, bool fallback)
    {
        return element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(name, out var property) &&
            property.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? property.GetBoolean()
            : fallback;
    }

    private static double ReadDouble(JsonElement element, string name, double fallback)
    {
        return TryReadDouble(element, name, out var value) ? value : fallback;
    }

    private static bool TryReadDouble(JsonElement element, string name, out double value)
    {
        value = 0;
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var property))
        {
            return false;
        }

        if (property.ValueKind == JsonValueKind.Number && property.TryGetDouble(out value))
        {
            return double.IsFinite(value);
        }

        if (property.ValueKind == JsonValueKind.String &&
            double.TryParse(property.GetString(), out value))
        {
            return double.IsFinite(value);
        }

        return false;
    }
}

public static class PlannerJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };
}
