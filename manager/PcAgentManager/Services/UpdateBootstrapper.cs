using System.Diagnostics;
using System.Text.Json;
using PcAgentManager.Configuration;
using PcAgentManager.Models;

namespace PcAgentManager.Services;

public static class UpdateBootstrapper
{
    private static readonly JsonSerializerOptions StateJsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    };

    public static async Task<int> RunAsync(
        ManagerPaths paths,
        string statePath,
        int parentPid)
    {
        try
        {
            var expectedStatePath =
                Path.GetFullPath(paths.UpdateTransactionPath);
            var actualStatePath =
                Path.GetFullPath(statePath);

            if (!actualStatePath.Equals(
                    expectedStatePath,
                    StringComparison.OrdinalIgnoreCase))
            {
                return 20;
            }

            var state = ReadState(actualStatePath);
            var helperExecutable = Environment.ProcessPath
                ?? throw new InvalidOperationException(
                    "Bootstrap executable path is unavailable.");

            if (!Path.GetFullPath(state.PreviousExecutablePath).Equals(
                    Path.GetFullPath(helperExecutable),
                    StringComparison.OrdinalIgnoreCase))
            {
                WriteState(
                    actualStatePath,
                    state with
                    {
                        Outcome = "rejected",
                        FailureReason =
                            "Bootstrap executable does not match previous version."
                    });
                return 21;
            }

            if (!IsPathInside(
                    state.CandidateExecutablePath,
                    paths.ReleasesDirectory) ||
                !File.Exists(state.CandidateExecutablePath))
            {
                WriteState(
                    actualStatePath,
                    state with
                    {
                        Outcome = "rejected",
                        FailureReason =
                            "Candidate executable is outside the managed releases directory or missing."
                    });
                return 22;
            }

            if (!await WaitForParentExitAsync(parentPid))
            {
                WriteState(
                    actualStatePath,
                    state with
                    {
                        Outcome = "failed",
                        FailureReason =
                            "Previous Manager did not exit before update timeout."
                    });
                return 23;
            }

            var healthExit = await RunAndWaitAsync(
                state.CandidateExecutablePath,
                ["--update-health-check"],
                TimeSpan.FromSeconds(45));

            if (healthExit != 0)
            {
                return RollBack(
                    paths,
                    actualStatePath,
                    state,
                    "Candidate health check failed with exit code " + healthExit + ".");
            }

            StartupRegistration.SetExecutable(
                state.AutoStartManager,
                state.CandidateExecutablePath);

            var candidateProcess = StartBackground(
                state.CandidateExecutablePath);

            if (candidateProcess is null)
            {
                return RollBack(
                    paths,
                    actualStatePath,
                    state,
                    "Candidate Manager could not be started.");
            }

            using (candidateProcess)
            {
                var exitedEarly = await ExitedWithinAsync(
                    candidateProcess,
                    TimeSpan.FromSeconds(5));

                if (exitedEarly)
                {
                    return RollBack(
                        paths,
                        actualStatePath,
                        state,
                        "Candidate Manager exited during post-update startup verification.");
                }
            }

            WriteState(
                actualStatePath,
                state with
                {
                    Outcome = "committed",
                    FailureReason = null
                });

            return 0;
        }
        catch (Exception ex)
        {
            try
            {
                var state = ReadState(statePath);
                return RollBack(
                    paths,
                    statePath,
                    state,
                    "Update bootstrap failed: " + ex.Message);
            }
            catch
            {
                return 29;
            }
        }
    }

    private static UpdateTransactionState ReadState(
        string statePath)
    {
        var json = File.ReadAllText(statePath);
        return JsonSerializer.Deserialize<UpdateTransactionState>(
                   json,
                   StateJsonOptions)
               ?? throw new InvalidDataException(
                   "Update transaction state is invalid.");
    }

    private static void WriteState(
        string statePath,
        UpdateTransactionState state)
    {
        var json = JsonSerializer.Serialize(
            state,
            StateJsonOptions);
        var temp = statePath + ".tmp";
        File.WriteAllText(temp, json);
        File.Move(temp, statePath, overwrite: true);
    }

    private static async Task<bool> WaitForParentExitAsync(
        int parentPid)
    {
        if (parentPid <= 0 ||
            parentPid == Environment.ProcessId)
        {
            return false;
        }

        Process? parent = null;

        try
        {
            parent = Process.GetProcessById(parentPid);
        }
        catch (ArgumentException)
        {
            return true;
        }

        using (parent)
        using (var timeout = new CancellationTokenSource(
                   TimeSpan.FromSeconds(30)))
        {
            try
            {
                await parent.WaitForExitAsync(timeout.Token);
                return true;
            }
            catch (OperationCanceledException)
            {
                return false;
            }
        }
    }

    private static async Task<int> RunAndWaitAsync(
        string executable,
        IReadOnlyList<string> arguments,
        TimeSpan timeoutValue)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory =
                Path.GetDirectoryName(executable)!
        };

        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException(
                "Unable to start update verification process.");

        using var timeout =
            new CancellationTokenSource(timeoutValue);

        try
        {
            await process.WaitForExitAsync(timeout.Token);
            return process.ExitCode;
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
            catch
            {
                // Best effort.
            }

            return 124;
        }
    }

    private static Process? StartBackground(
        string executable)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory =
                Path.GetDirectoryName(executable)!
        };
        startInfo.ArgumentList.Add("--background");

        return Process.Start(startInfo);
    }

    private static async Task<bool> ExitedWithinAsync(
        Process process,
        TimeSpan duration)
    {
        using var timeout = new CancellationTokenSource(duration);

        try
        {
            await process.WaitForExitAsync(timeout.Token);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    private static int RollBack(
        ManagerPaths paths,
        string statePath,
        UpdateTransactionState state,
        string reason)
    {
        try
        {
            StartupRegistration.SetExecutable(
                state.AutoStartManager,
                state.PreviousExecutablePath);

            if (File.Exists(state.PreviousExecutablePath))
            {
                _ = StartBackground(
                    state.PreviousExecutablePath);
            }

            WriteState(
                statePath,
                state with
                {
                    Outcome = "rolled_back",
                    FailureReason = reason
                });

            return 10;
        }
        catch (Exception rollbackError)
        {
            try
            {
                WriteState(
                    statePath,
                    state with
                    {
                        Outcome = "rollback_failed",
                        FailureReason =
                            reason + " Rollback error: " + rollbackError.Message
                    });
            }
            catch
            {
                // Preserve the original rollback failure.
            }

            return 11;
        }
    }

    public static bool IsPathInside(
        string candidatePath,
        string rootDirectory)
    {
        var candidate = Path.GetFullPath(candidatePath);
        var root = Path.GetFullPath(rootDirectory);
        var prefix = root.EndsWith(Path.DirectorySeparatorChar)
            ? root
            : root + Path.DirectorySeparatorChar;

        return candidate.StartsWith(
            prefix,
            StringComparison.OrdinalIgnoreCase);
    }
}
