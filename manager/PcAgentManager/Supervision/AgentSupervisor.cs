using System.Diagnostics;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text.Json;
using PcAgentManager.Configuration;
using PcAgentManager.Models;
using PcAgentManager.Services;

namespace PcAgentManager.Supervision;

public sealed class AgentSupervisor : IAsyncDisposable
{
    private readonly ManagerPaths _paths;
    private readonly ManagerConfigurationStore _configStore;
    private readonly EmergencyStopStore _emergencyStopStore;
    private readonly ManagerLogger _logger;
    private readonly CrashRecoveryPolicy _crashPolicy = new();
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _pipeName;
    private string? _localApprovalSecret;

    private Process? _process;
    private WindowsJobObject? _job;
    private CancellationTokenSource? _healthCts;
    private Task? _healthTask;
    private bool _manualStopRequested;
    private bool _disposed;
    private int _recentCrashCount;
    private string? _pendingApprovalOperationId;

    public event EventHandler<ManagerSnapshot>? SnapshotChanged;
    public event Action<PendingApprovalSnapshot?>? PendingApprovalChanged;

    public ManagerSnapshot Snapshot { get; private set; }

    public AgentSupervisor(
        ManagerPaths paths,
        ManagerConfigurationStore configStore,
        EmergencyStopStore emergencyStopStore,
        ManagerLogger logger)
    {
        _paths = paths;
        _configStore = configStore;
        _emergencyStopStore = emergencyStopStore;
        _logger = logger;
        _pipeName = BuildPipeName() + "-" +
            Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        Snapshot = ManagerSnapshot.Stopped(emergencyStopStore.IsEngaged);
    }

    public static string BuildPipeName()
    {
        try
        {
            var sid = WindowsIdentity.GetCurrent().User?.Value;
            if (!string.IsNullOrWhiteSpace(sid))
            {
                return "PcAgent-" + sid;
            }
        }
        catch
        {
            // Fall back to a per-user-safe name below.
        }

        var safeUser = new string(
            Environment.UserName
                .Where(c => char.IsLetterOrDigit(c) || c is '-' or '_')
                .ToArray());

        return "PcAgent-" + (string.IsNullOrWhiteSpace(safeUser) ? "CurrentUser" : safeUser);
    }

    public async Task StartAsync()
    {
        ThrowIfDisposed();

        await _gate.WaitAsync();
        try
        {
            if (_emergencyStopStore.IsEngaged)
            {
                Publish(Snapshot with
                {
                    ManagerState = "EMERGENCY_STOPPED",
                    AgentState = "EMERGENCY_STOPPED",
                    EmergencyStopped = true,
                    LastError = "Emergency Stop is engaged."
                });
                return;
            }

            if (_process is { HasExited: false })
            {
                return;
            }

            var config = _configStore.Load();
            var validation = AgentConfigurationValidator.Validate(config);
            if (!validation.IsValid)
            {
                Publish(ManagerSnapshot.Stopped() with
                {
                    ManagerState = "CONFIG_REQUIRED",
                    AgentState = "STOPPED",
                    LastError = string.Join(" ", validation.Errors)
                });
                return;
            }

            if (!File.Exists(_paths.NodeExecutablePath))
            {
                PublishFailure("Bundled Node.js runtime is missing.");
                return;
            }

            if (!File.Exists(_paths.AgentEntryPath))
            {
                PublishFailure("Bundled Agent entrypoint is missing.");
                return;
            }

            _paths.EnsureDirectories();
            _manualStopRequested = false;
            _localApprovalSecret = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

            var startInfo = new ProcessStartInfo
            {
                FileName = _paths.NodeExecutablePath,
                WorkingDirectory = AppContext.BaseDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            startInfo.ArgumentList.Add(_paths.AgentEntryPath);
            startInfo.Environment["PC_AGENT_ENDPOINT"] = config.EndpointUrl;
            startInfo.Environment["PC_AGENT_DEVICE_ID"] = config.DeviceId;
            startInfo.Environment["PC_AGENT_DEVICE_TOKEN"] = config.DeviceToken;
            startInfo.Environment["PC_AGENT_ALLOWED_ROOTS_JSON"] =
                JsonSerializer.Serialize(config.AllowedRoots);
            startInfo.Environment["PC_AGENT_JOURNAL_PATH"] = _paths.JournalPath;
            startInfo.Environment["PC_AGENT_PIPE_NAME"] = _pipeName;
            startInfo.Environment["PC_AGENT_LOCAL_APPROVAL_SECRET"] = _localApprovalSecret;
            startInfo.Environment["PC_AGENT_VERSION"] = "0.11.3";

            var process = new Process
            {
                StartInfo = startInfo,
                EnableRaisingEvents = true
            };

            if (!process.Start())
            {
                PublishFailure("Unable to start the Agent process.");
                process.Dispose();
                return;
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

            _process = process;
            _job = job;

            _ = PumpOutputAsync(process.StandardOutput, "agent");
            _ = PumpOutputAsync(process.StandardError, "agent-error");
            _ = MonitorExitAsync(process);

            _healthCts?.Cancel();
            _healthCts?.Dispose();
            _healthCts = new CancellationTokenSource();
            _healthTask = MonitorHealthAsync(process, _healthCts.Token);

            Publish(new(
                ManagerState: "RUNNING",
                AgentState: "STARTING",
                QueueConnectivity: "unknown",
                LastHeartbeat: null,
                ProcessId: process.Id,
                AgentVersion: "",
                LastError: null,
                EmergencyStopped: false,
                RecentCrashCount: _recentCrashCount));

            _logger.Write("info", $"Agent started PID={process.Id}");
        }
        catch (Exception ex)
        {
            _logger.Write("error", "Start failed: " + ex.Message);
            PublishFailure(ex.Message);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task StopAsync()
    {
        ThrowIfDisposed();
        await StopCoreAsync(manual: true, finalState: "STOPPED");
    }

    public async Task RestartAsync()
    {
        ThrowIfDisposed();
        await StopCoreAsync(manual: true, finalState: "STOPPED");
        _crashPolicy.Reset();
        _recentCrashCount = 0;
        await StartAsync();
    }

    public async Task<bool> RespondApprovalAsync(
        string operationId,
        bool approved,
        CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();

        var pipe = new NamedPipeAgentClient(_pipeName, _localApprovalSecret);
        var response = await pipe.RespondApprovalAsync(
            operationId,
            approved ? "approved" : "denied",
            cancellationToken);

        if (!response.Accepted)
        {
            _logger.Write(
                "warn",
                $"Approval response rejected: {response.Code ?? "unknown"}");
            return false;
        }

        _logger.Write(
            "info",
            $"Local approval {(approved ? "approved" : "denied")} operation={operationId}");

        PublishPendingApproval(null);
        return true;
    }

    public async Task EmergencyStopAsync()
    {
        ThrowIfDisposed();
        _emergencyStopStore.Engage("Local Emergency Stop");
        await StopCoreAsync(manual: true, finalState: "EMERGENCY_STOPPED");

        Publish(ManagerSnapshot.Stopped(emergency: true) with
        {
            LastError = "Emergency Stop is engaged. Automatic restart is disabled."
        });
    }

    public void ClearEmergencyStop()
    {
        ThrowIfDisposed();
        _emergencyStopStore.Clear();
        _crashPolicy.Reset();
        _recentCrashCount = 0;
        Publish(ManagerSnapshot.Stopped());
        _logger.Write("info", "Emergency Stop cleared by local user.");
    }

    public string BuildDiagnostics()
    {
        var config = _configStore.Load();
        var validation = AgentConfigurationValidator.Validate(config);

        return string.Join(Environment.NewLine, new[]
        {
            "PC Agent Manager Diagnostic",
            $"Timestamp: {DateTimeOffset.Now:O}",
            $"Manager state: {Snapshot.ManagerState}",
            $"Agent state: {Snapshot.AgentState}",
            $"Queue: {Snapshot.QueueConnectivity}",
            $"Heartbeat: {Snapshot.LastHeartbeat?.ToString("O") ?? "not available"}",
            $"Agent PID: {Snapshot.ProcessId?.ToString() ?? "none"}",
            $"Agent version: {Snapshot.AgentVersion}",
            $"Emergency Stop: {Snapshot.EmergencyStopped}",
            $"Configuration: {(validation.IsValid ? "OK" : "INVALID")}",
            $"Node runtime: {(File.Exists(_paths.NodeExecutablePath) ? "OK" : "MISSING")}",
            $"Agent bundle: {(File.Exists(_paths.AgentEntryPath) ? "OK" : "MISSING")}",
            $"Data directory: {_paths.RootDirectory}",
            $"Last error: {Snapshot.LastError ?? "none"}"
        });
    }

    private async Task StopCoreAsync(bool manual, string finalState)
    {
        await _gate.WaitAsync();
        try
        {
            _manualStopRequested = manual;
            _healthCts?.Cancel();

            var process = _process;
            if (process is null || process.HasExited)
            {
                CleanupProcess();
                Publish(ManagerSnapshot.Stopped(finalState == "EMERGENCY_STOPPED"));
                return;
            }

            try
            {
                var pipe = new NamedPipeAgentClient(_pipeName, _localApprovalSecret);
                using var shutdownCts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await pipe.PrepareShutdownAsync(shutdownCts.Token);
            }
            catch (Exception ex)
            {
                _logger.Write("warn", "Graceful Agent shutdown request failed: " + ex.Message);
            }

            try
            {
                using var waitCts = new CancellationTokenSource(TimeSpan.FromSeconds(7));
                await process.WaitForExitAsync(waitCts.Token);
            }
            catch (OperationCanceledException)
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                    await process.WaitForExitAsync();
                }
                catch (Exception ex)
                {
                    _logger.Write("warn", "Forced Agent stop failed: " + ex.Message);
                }
            }

            CleanupProcess();

            Publish(finalState == "EMERGENCY_STOPPED"
                ? ManagerSnapshot.Stopped(emergency: true)
                : ManagerSnapshot.Stopped());
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task MonitorExitAsync(Process process)
    {
        try
        {
            await process.WaitForExitAsync();
        }
        catch
        {
            return;
        }

        if (_disposed)
        {
            return;
        }

        var exitCode = 0;
        try { exitCode = process.ExitCode; } catch { }

        await _gate.WaitAsync();
        bool shouldRestart;
        CrashDecision? decision = null;
        try
        {
            if (!ReferenceEquals(_process, process))
            {
                return;
            }

            shouldRestart = !_manualStopRequested && !_emergencyStopStore.IsEngaged;
            CleanupProcess();

            if (!shouldRestart)
            {
                return;
            }

            decision = _crashPolicy.RegisterCrash(DateTimeOffset.UtcNow);
            _recentCrashCount = decision.RecentCrashCount;

            if (decision.CrashLoopDetected)
            {
                Publish(ManagerSnapshot.Stopped() with
                {
                    ManagerState = "CRASH_LOOP",
                    AgentState = "CRASH_LOOP",
                    LastError = $"Agent exited repeatedly. Last exit code: {exitCode}",
                    RecentCrashCount = _recentCrashCount
                });
                _logger.Write("error", $"Crash loop detected; exit={exitCode}");
                return;
            }

            Publish(ManagerSnapshot.Stopped() with
            {
                ManagerState = "CRASHED",
                AgentState = "CRASHED",
                LastError = $"Agent exited unexpectedly with code {exitCode}.",
                RecentCrashCount = _recentCrashCount
            });
        }
        finally
        {
            _gate.Release();
        }

        if (decision?.RestartDelay is { } delay)
        {
            _logger.Write("warn", $"Restarting Agent after {delay.TotalSeconds:0}s.");
            await Task.Delay(delay);

            if (!_disposed && !_manualStopRequested && !_emergencyStopStore.IsEngaged)
            {
                await StartAsync();
            }
        }
    }

    private async Task MonitorHealthAsync(Process process, CancellationToken cancellationToken)
    {
        var pipe = new NamedPipeAgentClient(_pipeName, _localApprovalSecret);

        while (!cancellationToken.IsCancellationRequested && !process.HasExited)
        {
            try
            {
                var health = await pipe.GetHealthAsync(cancellationToken);
                var pendingApproval = await pipe.GetPendingApprovalAsync(cancellationToken);
                var heartbeat = DateTimeOffset.UtcNow;

                PublishPendingApproval(pendingApproval);

                Publish(new(
                    ManagerState: "RUNNING",
                    AgentState: health.AgentState,
                    QueueConnectivity: health.QueueConnectivity,
                    LastHeartbeat: heartbeat,
                    ProcessId: process.Id,
                    AgentVersion: health.Version,
                    LastError: health.LastError,
                    EmergencyStopped: false,
                    RecentCrashCount: _recentCrashCount));
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                Publish(Snapshot with
                {
                    ManagerState = "RUNNING",
                    AgentState = process.HasExited ? "CRASHED" : "DEGRADED",
                    ProcessId = process.HasExited ? null : process.Id,
                    LastError = ex.Message
                });
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private async Task PumpOutputAsync(StreamReader reader, string level)
    {
        try
        {
            while (await reader.ReadLineAsync() is { } line)
            {
                _logger.Write(level, line);
            }
        }
        catch
        {
            // Process exit may close redirected streams.
        }
    }

    private void CleanupProcess()
    {
        _healthCts?.Cancel();
        _healthCts?.Dispose();
        _healthCts = null;
        _healthTask = null;

        _job?.Dispose();
        _job = null;

        _process?.Dispose();
        _process = null;

        PublishPendingApproval(null);
    }

    private void PublishPendingApproval(PendingApprovalSnapshot? pending)
    {
        var operationId = pending?.OperationId;

        if (string.Equals(
                _pendingApprovalOperationId,
                operationId,
                StringComparison.Ordinal))
        {
            return;
        }

        _pendingApprovalOperationId = operationId;
        PendingApprovalChanged?.Invoke(pending);
    }

    private void PublishFailure(string error)
    {
        Publish(ManagerSnapshot.Stopped(_emergencyStopStore.IsEngaged) with
        {
            ManagerState = "ERROR",
            AgentState = "STOPPED",
            LastError = error,
            RecentCrashCount = _recentCrashCount
        });
    }

    private void Publish(ManagerSnapshot snapshot)
    {
        Snapshot = snapshot;
        SnapshotChanged?.Invoke(this, snapshot);
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;

        try
        {
            await StopCoreAsync(manual: true, finalState: "STOPPED");
        }
        catch
        {
            CleanupProcess();
        }

        _gate.Dispose();
    }
}
