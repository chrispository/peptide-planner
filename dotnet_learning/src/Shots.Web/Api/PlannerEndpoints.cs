using Shots.Domain;
using Shots.Web.Services;

namespace Shots.Web.Api;

/// <summary>
/// REST surface over the single-user planner snapshot. Every mutation flows
/// through <see cref="PlannerService"/> so it shares the same "current" state
/// the Blazor UI reads and writes.
/// </summary>
public static class PlannerEndpoints
{
    public static IEndpointRouteBuilder MapPlannerApi(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api");

        // --- Whole state ---------------------------------------------------
        api.MapGet("/state", async (PlannerService svc) => Results.Ok(await svc.GetStoreAsync()));

        // --- Preferences ---------------------------------------------------
        api.MapGet("/prefs", async (PlannerService svc) =>
            Results.Ok((await svc.GetStoreAsync()).Prefs));

        api.MapPut("/prefs", (PlannerService svc, PrefsUpdate body) =>
            Run(svc, store =>
            {
                var prefs = store.Prefs;
                if (body.PreviewCount is { } pc) prefs.PreviewCount = pc;
                if (body.MaxUnits is { } mu) prefs.MaxUnits = mu;
                if (body.IdealUnits is { } iu) prefs.IdealUnits = iu;
                if (body.BacWindowDays is { } bw) prefs.BacWindowDays = bw;
                if (body.ManualBacOpenDates is { } dates)
                {
                    prefs.ManualBacOpenDates = dates.Distinct().Order().ToList();
                }
                return prefs;
            }));

        // --- Plans (peptides) ---------------------------------------------
        api.MapGet("/plans", async (PlannerService svc) =>
            Results.Ok((await svc.GetStoreAsync()).Plans));

        api.MapGet("/plans/{id}", async (PlannerService svc, string id) =>
        {
            var plan = (await svc.GetStoreAsync()).Plans.FirstOrDefault(p => p.Id == id);
            return plan is null ? NotFound(id) : Results.Ok(plan);
        });

        // Add a plan.
        api.MapPost("/plans", (PlannerService svc, PlanUpdate? body) =>
            Run(svc, store =>
            {
                var plan = StateFactory.CreatePlan(p => p.PeptideName = "");
                ApplyPlanUpdate(plan, body);
                store.Plans.Add(plan);
                store.ActivePlanId = plan.Id;
                return plan;
            }, created: true));

        // Update a plan.
        api.MapPut("/plans/{id}", (PlannerService svc, string id, PlanUpdate body) =>
            Run(svc, store =>
            {
                var plan = store.Plans.FirstOrDefault(p => p.Id == id)
                    ?? throw new PlannerApiException(StatusCodes.Status404NotFound, $"No plan with id '{id}'.");
                ApplyPlanUpdate(plan, body);
                return plan;
            }));

        // Remove a plan.
        api.MapDelete("/plans/{id}", (PlannerService svc, string id) =>
            Run(svc, store =>
            {
                if (store.Plans.All(p => p.Id != id))
                {
                    throw new PlannerApiException(StatusCodes.Status404NotFound, $"No plan with id '{id}'.");
                }
                if (store.Plans.Count <= 1)
                {
                    throw new PlannerApiException(StatusCodes.Status409Conflict, "Cannot remove the last remaining plan.");
                }
                store.Plans = store.Plans.Where(p => p.Id != id).ToList();
                return new { removed = id };
            }));

        // Set the active plan.
        api.MapPost("/plans/{id}/activate", (PlannerService svc, string id) =>
            Run(svc, store =>
            {
                if (store.Plans.All(p => p.Id != id))
                {
                    throw new PlannerApiException(StatusCodes.Status404NotFound, $"No plan with id '{id}'.");
                }
                store.ActivePlanId = id;
                return new { activePlanId = id };
            }));

        // --- Dose tiers within a plan -------------------------------------
        api.MapPost("/plans/{id}/tiers", (PlannerService svc, string id, TierCreate? body) =>
            Run(svc, store =>
            {
                var plan = RequirePlan(store, id);
                var tier = body?.Type == TierTypes.Off
                    ? new DoseTier { Type = TierTypes.Off, Weeks = body?.Weeks ?? 1, Count = body?.Count ?? 1, DoseMg = 0 }
                    : new DoseTier
                    {
                        Type = TierTypes.Dose,
                        Weeks = body?.Weeks ?? 1,
                        Count = body?.Count ?? 1,
                        DoseMg = body?.DoseMg ?? plan.Tiers.LastOrDefault(t => t.Type != TierTypes.Off)?.DoseMg ?? 100
                    };
                plan.Tiers.Add(tier);
                return tier;
            }, created: true));

        api.MapDelete("/plans/{id}/tiers/{index:int}", (PlannerService svc, string id, int index) =>
            Run(svc, store =>
            {
                var plan = RequirePlan(store, id);
                if (index < 0 || index >= plan.Tiers.Count)
                {
                    throw new PlannerApiException(StatusCodes.Status404NotFound, $"No tier at index {index}.");
                }
                if (plan.Tiers.Count <= 1)
                {
                    throw new PlannerApiException(StatusCodes.Status409Conflict, "Cannot remove the last remaining tier.");
                }
                plan.Tiers.RemoveAt(index);
                return new { removedTierIndex = index };
            }));

        // --- Schedule generation ------------------------------------------
        // Full computed plan (water options, vial math, shots) for one plan.
        api.MapGet("/plans/{id}/compute", async (PlannerService svc, string id) =>
        {
            var store = await svc.GetStoreAsync();
            var plan = store.Plans.FirstOrDefault(p => p.Id == id);
            return plan is null ? NotFound(id) : Results.Ok(PlannerCalculator.ComputePlan(plan, store.Prefs));
        });

        // Just the injection list for one plan.
        api.MapGet("/plans/{id}/schedule", async (PlannerService svc, string id) =>
        {
            var store = await svc.GetStoreAsync();
            var plan = store.Plans.FirstOrDefault(p => p.Id == id);
            return plan is null ? NotFound(id) : Results.Ok(PlannerCalculator.ComputePlan(plan, store.Prefs).Shots);
        });

        // Merged schedule across all plans, in date order.
        api.MapGet("/schedule", async (PlannerService svc) =>
        {
            var store = await svc.GetStoreAsync();
            var merged = PlannerCalculator.MergeSchedule(PlannerCalculator.ComputeAll(store.Plans, store.Prefs));
            return Results.Ok(merged);
        });

        // Merged schedule as a downloadable .ics calendar.
        api.MapGet("/schedule.ics", async (PlannerService svc) =>
        {
            var store = await svc.GetStoreAsync();
            var merged = PlannerCalculator.MergeSchedule(PlannerCalculator.ComputeAll(store.Plans, store.Prefs));
            if (merged.Count == 0)
            {
                return Results.NotFound(new { error = "No injections to export." });
            }
            var ics = CalendarExporter.BuildIcs(merged);
            return Results.File(System.Text.Encoding.UTF8.GetBytes(ics), "text/calendar",
                $"peptide-schedule-{Dates.DateInputValue(DateTime.Today)}.ics");
        });

        // --- Peptide library ----------------------------------------------
        api.MapGet("/peptides", () => Results.Ok(PeptideLibrary.All));

        return app;
    }

    private static void ApplyPlanUpdate(PeptidePlan plan, PlanUpdate? body)
    {
        if (body is null)
        {
            return;
        }
        if (body.PeptideName is { } name) plan.PeptideName = name;
        if (body.VialMg is { } vial) plan.VialMg = vial;
        if (body.StartDate is { } start) plan.StartDate = start;
        if (body.ScheduleMode is { } mode) plan.ScheduleMode = mode;
        if (body.ShotsPerWeek is { } spw) plan.ShotsPerWeek = spw;
        if (body.EveryDays is { } every) plan.EveryDays = every;
        if (body.FlexibleDose is { } flex) plan.FlexibleDose = flex;
        if (body.FlexibleDosePct is { } flexPct) plan.FlexibleDosePct = flexPct;
        if (body.Tiers is { Count: > 0 } tiers)
        {
            plan.Tiers = tiers.Select(t => new DoseTier
            {
                Type = t.Type == TierTypes.Off ? TierTypes.Off : TierTypes.Dose,
                Weeks = t.Weeks,
                Count = t.Count,
                DoseMg = t.DoseMg
            }).ToList();
        }
    }

    private static PeptidePlan RequirePlan(PlannerStore store, string id) =>
        store.Plans.FirstOrDefault(p => p.Id == id)
            ?? throw new PlannerApiException(StatusCodes.Status404NotFound, $"No plan with id '{id}'.");

    private static async Task<IResult> Run<T>(PlannerService svc, Func<PlannerStore, T> mutate, bool created = false)
    {
        try
        {
            var result = await svc.MutateAsync(mutate);
            return created ? Results.Created((string?)null, result) : Results.Ok(result);
        }
        catch (PlannerApiException ex)
        {
            return Results.Problem(detail: ex.Message, statusCode: ex.StatusCode);
        }
    }

    private static IResult NotFound(string id) =>
        Results.Problem(detail: $"No plan with id '{id}'.", statusCode: StatusCodes.Status404NotFound);
}

public sealed class PlannerApiException(int statusCode, string message) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}

public sealed record PrefsUpdate(
    int? PreviewCount,
    double? MaxUnits,
    double? IdealUnits,
    int? BacWindowDays,
    List<string>? ManualBacOpenDates);

public sealed record PlanUpdate(
    string? PeptideName,
    double? VialMg,
    string? StartDate,
    string? ScheduleMode,
    double? ShotsPerWeek,
    int? EveryDays,
    bool? FlexibleDose,
    double? FlexibleDosePct,
    List<DoseTier>? Tiers);

public sealed record TierCreate(string? Type, double Weeks = 1, int Count = 1, double DoseMg = 0);
