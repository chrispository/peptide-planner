using Shots.Domain;

namespace Shots.Web.Services;

/// <summary>
/// Thin coordination layer over <see cref="PlannerRepository"/> that makes
/// load-modify-save cycles atomic for the single-user "current" snapshot, so
/// concurrent API calls (and the Blazor UI) don't clobber each other.
/// </summary>
public sealed class PlannerService(PlannerRepository repository)
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public Task<PlannerStore> GetStoreAsync() => repository.LoadCurrentAsync();

    /// <summary>
    /// Loads the current store, applies <paramref name="mutate"/>, normalizes,
    /// persists, and returns whatever the mutation produced. If the mutation
    /// throws (e.g. validation), nothing is saved.
    /// </summary>
    public async Task<T> MutateAsync<T>(Func<PlannerStore, T> mutate)
    {
        await _gate.WaitAsync();
        try
        {
            var store = await repository.LoadCurrentAsync();
            var result = mutate(store);
            PlannerNormalizer.Normalize(store);
            await repository.SaveCurrentAsync(store);
            return result;
        }
        finally
        {
            _gate.Release();
        }
    }
}
