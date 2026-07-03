using Microsoft.Data.Sqlite;
using Shots.Domain;

namespace Shots.Web.Services;

public sealed class PlannerRepository
{
    private readonly string _dbPath;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public PlannerRepository(IConfiguration configuration, IWebHostEnvironment environment)
    {
        var configured = configuration["SHOTS_DATA_DIR"] ?? Environment.GetEnvironmentVariable("SHOTS_DATA_DIR");
        var dataDir = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(environment.ContentRootPath, "data")
            : Path.GetFullPath(configured);
        Directory.CreateDirectory(dataDir);
        _dbPath = Path.Combine(dataDir, "shots.sqlite");
    }

    public string DatabasePath => _dbPath;

    public async Task InitializeAsync()
    {
        await _gate.WaitAsync();
        try
        {
            await using var connection = OpenConnection();
            await connection.OpenAsync();
            await ExecuteAsync(connection, "DROP TABLE IF EXISTS settings;");
            await ExecuteAsync(connection, """
                CREATE TABLE IF NOT EXISTS planner_snapshots (
                  key TEXT PRIMARY KEY,
                  payload_json TEXT NOT NULL,
                  peptide_name TEXT,
                  vial_mg REAL,
                  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                ) STRICT;
                """);
            await ExecuteAsync(connection, "PRAGMA user_version = 1;");
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<PlannerStore> LoadCurrentAsync()
    {
        await _gate.WaitAsync();
        try
        {
            await using var connection = OpenConnection();
            await connection.OpenAsync();
            var command = connection.CreateCommand();
            command.CommandText = """
                SELECT payload_json
                FROM planner_snapshots
                WHERE key = $key
                """;
            command.Parameters.AddWithValue("$key", "current");
            var raw = await command.ExecuteScalarAsync() as string;
            var store = StateFactory.CreateStore();
            if (!string.IsNullOrWhiteSpace(raw))
            {
                StateFactory.Hydrate(store, raw);
            }

            return store;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task SaveCurrentAsync(PlannerStore store)
    {
        var firstPlan = store.Plans.FirstOrDefault();
        var peptideName = (firstPlan?.PeptideName ?? "").Length > 120
            ? firstPlan!.PeptideName[..120]
            : firstPlan?.PeptideName ?? "";
        var vialMg = firstPlan?.VialMg;
        var payload = StateFactory.Serialize(store);

        await _gate.WaitAsync();
        try
        {
            await using var connection = OpenConnection();
            await connection.OpenAsync();
            var command = connection.CreateCommand();
            command.CommandText = """
                INSERT INTO planner_snapshots (key, payload_json, peptide_name, vial_mg, updated_at)
                VALUES ($key, $payload, $peptideName, $vialMg, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET
                  payload_json = excluded.payload_json,
                  peptide_name = excluded.peptide_name,
                  vial_mg = excluded.vial_mg,
                  updated_at = CURRENT_TIMESTAMP
                """;
            command.Parameters.AddWithValue("$key", "current");
            command.Parameters.AddWithValue("$payload", payload);
            command.Parameters.AddWithValue("$peptideName", peptideName);
            command.Parameters.AddWithValue("$vialMg", vialMg is null ? DBNull.Value : vialMg);
            await command.ExecuteNonQueryAsync();
        }
        finally
        {
            _gate.Release();
        }
    }

    private SqliteConnection OpenConnection()
    {
        return new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = _dbPath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            ForeignKeys = true,
            DefaultTimeout = 5
        }.ToString());
    }

    private static async Task ExecuteAsync(SqliteConnection connection, string sql)
    {
        var command = connection.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync();
    }
}
