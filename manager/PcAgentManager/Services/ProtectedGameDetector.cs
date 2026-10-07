using System.Diagnostics;

namespace PcAgentManager.Services;

public static class ProtectedGameDetector
{
    private static readonly string[] ProtectedProcessNames =
    [
        "VALORANT-Win64-Shipping",
        "VALORANT"
    ];

    public static bool IsProtectedGameRunning()
    {
        foreach (var processName in ProtectedProcessNames)
        {
            Process[] processes = [];
            try
            {
                processes = Process.GetProcessesByName(processName);
                if (processes.Length > 0)
                {
                    return true;
                }
            }
            catch
            {
                // Detection is advisory. Failure to inspect one process name
                // must not crash the Manager.
            }
            finally
            {
                foreach (var process in processes)
                {
                    process.Dispose();
                }
            }
        }

        return false;
    }

    public static bool IsProtectedProcessName(string? processName)
    {
        if (string.IsNullOrWhiteSpace(processName))
        {
            return false;
        }

        var normalized = Path.GetFileNameWithoutExtension(processName.Trim());

        return ProtectedProcessNames.Any(name =>
            name.Equals(
                normalized,
                StringComparison.OrdinalIgnoreCase));
    }
}
