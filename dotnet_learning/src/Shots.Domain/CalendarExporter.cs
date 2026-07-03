using System.Text;

namespace Shots.Domain;

public static class CalendarExporter
{
    public static string BuildIcs(IEnumerable<ShotEntry> shots)
    {
        var stamp = IcsStamp(DateTime.UtcNow);
        var lines = new List<string>
        {
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Peptide Planner//EN",
            "CALSCALE:GREGORIAN",
            "METHOD:PUBLISH"
        };

        var index = 0;
        foreach (var shot in shots)
        {
            var start = IcsDate(shot.Date);
            var end = IcsDate(shot.Date.AddDays(1));
            var units = shot.Units is not null ? $" ({Formatters.Number(shot.Units.Value, 1)} units)" : "";
            var summary = $"{shot.PeptideName} {Formatters.Number(shot.DoseMg, 3)} mg{units}";
            lines.AddRange([
                "BEGIN:VEVENT",
                $"UID:peptide-{index}-{start}@peptide-planner",
                $"DTSTAMP:{stamp}",
                $"DTSTART;VALUE=DATE:{start}",
                $"DTEND;VALUE=DATE:{end}",
                $"SUMMARY:{EscapeText(summary)}",
                $"DESCRIPTION:{EscapeText($"Injection {index + 1}: {summary}")}",
                "END:VEVENT"
            ]);
            index++;
        }

        lines.Add("END:VCALENDAR");
        return string.Join("\r\n", lines) + "\r\n";
    }

    private static string IcsDate(DateTime date) => date.ToString("yyyyMMdd");

    private static string IcsStamp(DateTime date) => date.ToString("yyyyMMdd'T'HHmmss'Z'");

    private static string EscapeText(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var character in value)
        {
            builder.Append(character switch
            {
                '\\' => @"\\",
                ';' => @"\;",
                ',' => @"\,",
                '\n' => @"\n",
                _ => character
            });
        }

        return builder.ToString();
    }
}
