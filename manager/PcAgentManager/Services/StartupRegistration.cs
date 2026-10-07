using Microsoft.Win32;

namespace PcAgentManager.Services;

public static class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "PC Agent Manager";

    public static bool IsEnabled
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
            return key?.GetValue(ValueName) is string value &&
                value.Contains(Environment.ProcessPath ?? "", StringComparison.OrdinalIgnoreCase);
        }
    }

    public static void SetEnabled(bool enabled)
    {
        var executable = Environment.ProcessPath
            ?? throw new InvalidOperationException("Manager executable path is unavailable.");

        SetExecutable(enabled, executable);
    }

    public static void SetExecutable(bool enabled, string executable)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true)
            ?? throw new InvalidOperationException("Unable to open Windows startup registry key.");

        if (!enabled)
        {
            key.DeleteValue(ValueName, throwOnMissingValue: false);
            return;
        }

        ArgumentException.ThrowIfNullOrWhiteSpace(executable);

        var fullPath = Path.GetFullPath(executable);
        if (!Path.IsPathFullyQualified(fullPath) || !File.Exists(fullPath))
        {
            throw new InvalidOperationException(
                "Manager startup executable is missing or not absolute.");
        }

        key.SetValue(ValueName, $"\"{fullPath}\" --background");
    }
}
