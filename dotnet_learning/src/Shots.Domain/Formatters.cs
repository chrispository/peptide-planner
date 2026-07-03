using System.Globalization;

namespace Shots.Domain;

public static class Formatters
{
    private static readonly CultureInfo Culture = CultureInfo.GetCultureInfo("en-US");

    public static string Number(double value, int maximumFractionDigits = 1)
    {
        if (!double.IsFinite(value))
        {
            return "-";
        }

        return value.ToString($"0.{new string('#', Math.Max(0, maximumFractionDigits))}", Culture);
    }

    public static string Range(IEnumerable<double> values, int digits = 1)
    {
        var list = values.ToList();
        if (list.Count == 0)
        {
            return "-";
        }

        var min = list.Min();
        var max = list.Max();
        return Math.Abs(min - max) < 0.01 ? Number(max, digits) : $"{Number(min, digits)}-{Number(max, digits)}";
    }

    public static string Date(DateTime date) => date.ToString("ddd, MMM d", Culture);
}
