using System.Diagnostics;
using System.Management;
using PcAgentManager.Supervision;

namespace PcAgentManager.Services;

public sealed class DesktopCommanderRemoteSupervisor : IDisposable
{
    private readonly ManagerLogger _logger;
    private readonly object _gate = new();

    private Process? _ownedProcess;
    private WindowsJobObject? _ownedJob;
    private bool _enabled;
    private string? _startScriptPath;
    private bool _disposed;

    public DesktopCommanderRemoteSupervisor(ManagerLogger logger)
    {
        _logger = logger;
    }

    public string State { get; private set; } = "Disabled";

    public event EventHandler? StateChanged;

    public void Configure(bool enabled, string? startScriptPath)
    {
        ThrowIfDisposed();

        lock (_gate)
        {
            _enabled = enabled;
            _startScriptPath = string.IsNullOrWhiteSpace(startScriptPath)
                ? null
                : Path.GetFullPath(startScriptPath);

            SetStateNoLock(enabled ? "Stopped" : "Disabled");
        }
    }

    public bool IsRunning()
    {
        ThrowIfDisposed();

        lock (_gate)
        {
            if (_ownedProcess is { HasExited: false })
            {
                return true;
            }
        }

        return FindExternalRemoteRoots().Count > 0;
    }

    public Task StartAsync()
    {
        ThrowIfDisposed();

        lock (_gate)
        {
            if (!_enabled)
            {
                SetStateNoLock("Disabled");
                return Task.CompletedTask;
            }

            if (IsRunningNoLock())
            {
                SetStateNoLock("Running");
                return Task.CompletedTask;
            }

            if (
                string.IsNullOrWhiteSpace(_startScriptPath)
                || !Path.IsPathFullyQualified(_startScriptPath)
                || !File.Exists(_startScriptPath)
                || !string.Equals(
                    Path.GetExtension(_startScriptPath),
                    ".cmd",
                    StringComparison.OrdinalIgnoreCase))
            {
                SetStateNoLock("Unavailable");
                _logger.Write(
                    "warn",
                    "Desktop Commander start script is missing or invalid.");
                return Task.CompletedTask;
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = Environment.GetEnvironmentVariable("ComSpec")
                    ?? Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.System),
                        "cmd.exe"),
                WorkingDirectory =
                    Path.GetDirectoryName(_startScriptPath)
                    ?? Environment.CurrentDirectory,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            startInfo.ArgumentList.Add("/d");
            startInfo.ArgumentList.Add("/s");
            startInfo.ArgumentList.Add("/c");
            startInfo.ArgumentList.Add(_startScriptPath);

            var process = new Process
            {
                StartInfo = startInfo,
                EnableRaisingEvents = true
            };

            if (!process.Start())
            {
                process.Dispose();
                SetStateNoLock("Error");
                _logger.Write(
                    "error",
                    "Unable to start Desktop Commander Remote.");
                return Task.CompletedTask;
            }

            var job = new WindowsJobObject();
            try
            {
                job.Assign(process);
            }
            catch
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                process.Dispose();
                job.Dispose();
                throw;
            }

            _ownedProcess = process;
            _ownedJob = job;
            process.Exited += OwnedProcessExited;
            SetStateNoLock("Running");
            _logger.Write(
                "info",
                $"Desktop Commander Remote started PID={process.Id}");
        }

        return Task.CompletedTask;
    }

    public async Task StopAsync(string state = "Paused")
    {
        ThrowIfDisposed();

        Process? owned;
        WindowsJobObject? ownedJob;

        lock (_gate)
        {
            owned = _ownedProcess;
            ownedJob = _ownedJob;
            _ownedProcess = null;
            _ownedJob = null;
        }

        if (owned is { HasExited: false })
        {
            try
            {
                owned.Kill(entireProcessTree: true);
                using var cts = new CancellationTokenSource(
                    TimeSpan.FromSeconds(5));
                await owned.WaitForExitAsync(cts.Token);
            }
            catch (OperationCanceledException)
            {
                _logger.Write(
                    "warn",
                    "Timed out waiting for owned Desktop Commander Remote to stop.");
            }
            catch (Exception ex)
            {
                _logger.Write(
                    "warn",
                    "Unable to stop owned Desktop Commander Remote: "
                    + ex.Message);
            }
        }

        owned?.Dispose();
        ownedJob?.Dispose();

        foreach (var processId in FindExternalRemoteRoots())
        {
            try
            {
                using var process = Process.GetProcessById(processId);
                process.Kill(entireProcessTree: true);

                using var cts = new CancellationTokenSource(
                    TimeSpan.FromSeconds(5));
                await process.WaitForExitAsync(cts.Token);

                _logger.Write(
                    "info",
                    $"Stopped external Desktop Commander Remote PID={processId}");
            }
            catch (ArgumentException)
            {
                // The process already exited.
            }
            catch (OperationCanceledException)
            {
                _logger.Write(
                    "warn",
                    $"Timed out stopping Desktop Commander Remote PID={processId}");
            }
            catch (Exception ex)
            {
                _logger.Write(
                    "warn",
                    $"Unable to stop Desktop Commander Remote PID={processId}: "
                    + ex.Message);
            }
        }

        lock (_gate)
        {
            SetStateNoLock(_enabled ? state : "Disabled");
        }
    }

    public void RefreshState()
    {
        ThrowIfDisposed();

        lock (_gate)
        {
            if (!_enabled)
            {
                SetStateNoLock("Disabled");
                return;
            }

            SetStateNoLock(IsRunningNoLock() ? "Running" : "Stopped");
        }
    }

    public static bool IsRemoteRootCommandLine(string? commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine))
        {
            return false;
        }

        var normalized = commandLine
            .Replace('/', '\\')
            .ToLowerInvariant();

        var hasRemoteToken =
            normalized.EndsWith(" remote", StringComparison.Ordinal)
            || normalized.Contains(" remote ", StringComparison.Ordinal)
            || normalized.Contains(" remote"", StringComparison.Ordinal);

        if (!hasRemoteToken)
        {
            return false;
        }

        var npxRoot =
            normalized.Contains("npx-cli.js", StringComparison.Ordinal)
            && normalized.Contains(
                "@wonderwhy-er\desktop-commander",
                StringComparison.Ordinal);

        var directCommand =
            normalized.Contains(
                "desktop-commander remote",
                StringComparison.Ordinal);

        var directNode =
            normalized.Contains(
                "@wonderwhy-er\desktop-commander\dist\index.js",
                StringComparison.Ordinal);

        return npxRoot || directCommand || directNode;
    }

    private bool IsRunningNoLock()
    {
        if (_ownedProcess is { HasExited: false })
        {
            return true;
        }

        return FindExternalRemoteRoots().Count > 0;
    }

    private static List<int> FindExternalRemoteRoots()
    {
        var result = new List<int>();

        if (!OperatingSystem.IsWindows())
        {
            return result;
        }

        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process "
                + "WHERE CommandLine IS NOT NULL");

            foreach (ManagementObject item in searcher.Get())
            {
                using (item)
                {
                    var commandLine = item["CommandLine"] as string;
                    if (!IsRemoteRootCommandLine(commandLine))
                    {
                        continue;
                    }

                    if (item["ProcessId"] is uint pid)
                    {
                        result.Add(checked((int)pid));
                    }
                }
            }
        }
        catch
        {
            // State probing must not crash the Manager.
        }

        return result.Distinct().ToList();
    }

    private void OwnedProcessExited(object? sender, EventArgs e)
    {
        lock (_gate)
        {
            if (!ReferenceEquals(sender, _ownedProcess))
            {
                return;
            }

            _ownedProcess?.Dispose();
            _ownedProcess = null;
            _ownedJob?.Dispose();
            _ownedJob = null;

            SetStateNoLock(_enabled ? "Stopped" : "Disabled");
        }
    }

    private void SetStateNoLock(string state)
    {
        if (string.Equals(State, state, StringComparison.Ordinal))
        {
            return;
        }

        State = state;
        StateChanged?.Invoke(this, EventArgs.Empty);
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;

        lock (_gate)
        {
            _ownedProcess?.Dispose();
            _ownedProcess = null;

            _ownedJob?.Dispose();
            _ownedJob = null;
        }
    }
}
