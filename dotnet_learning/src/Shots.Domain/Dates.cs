using System.Globalization;

namespace Shots.Domain;

public static class Dates
{
    public static string DateInputValue(DateTime date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public static DateTime ParseStartDate(string? value)
    {
        return DateTime.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            ? date.Date
            : DateTime.Today;
    }

    public static DateTime AddDays(DateTime date, double days) => date.Date.AddDays(days);

    public static DateTime StartOfToday() => DateTime.Today;

    public static int DaysBetween(DateTime a, DateTime b) => (int)Math.Round((b.Date - a.Date).TotalDays);
}
