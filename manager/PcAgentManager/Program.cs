using System.Text.Json;
using PcAgentManager.Configuration;
using PcAgentManager.Services;
using PcAgentManager.Supervision;

namespace PcAgentManager;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("PC Agent Manager supports Windows only.");
            Environment.ExitCode = 1;
            return;
        }

        var paths = ManagerPaths.CreateDefault();

        if (args.Contains("--bundle-check", StringComparer.OrdinalIgnoreCase))
        {
            var result = new
            {
                node = File.Exists(paths.NodeExecutablePath),
                agent = File.Exists(paths.AgentEntryPath),
                node_path = paths.NodeExecutablePath,
                agent_path = paths.AgentEntryPath
            };

            Console.WriteLine(JsonSerializer.Serialize(result));
            Environment.ExitCode = result.node && result.agent ? 0 : 2;
            return;
        }

        if (TryGetOption(args, "--update-bootstrap", out var statePath))
        {
            if (!TryGetIntOption(args, "--parent-pid", out var parentPid))
            {
                Environment.ExitCode = 24;
                return;
            }

            Environment.ExitCode = UpdateBootstrapper
                .RunAsync(paths, statePath!, parentPid)
                .GetAwaiter()
                .GetResult();
            return;
        }

        if (args.Contains(
                "--update-health-check",
                StringComparer.OrdinalIgnoreCase))
        {
            Environment.ExitCode = RunUpdateHealthCheckAsync(paths)
                .GetAwaiter()
                .GetResult();
            return;
        }

        using var mutex = new Mutex(
            initiallyOwned: true,
            name: @"Local\PcAgentManager-SingleInstance",
            createdNew: out var createdNew);

        if (!createdNew)
        {
            MessageBox.Show(
                "PC Agent Manager はすでに起動しています。",
                "PC Agent",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        paths.EnsureDirectories();

        var store = new ManagerConfigurationStore(paths);
        var emergency = new EmergencyStopStore(paths.EmergencyStopPath);
        var logger = new ManagerLogger(paths.LogPath);
        var supervisor = new AgentSupervisor(
            paths,
            store,
            emergency,
            logger);
        var updateService = new ManagerUpdateService(
            paths,
            logger);
        using var desktopCommander =
            new DesktopCommanderRemoteSupervisor(logger);

        var background = args.Contains(
            "--background",
            StringComparer.OrdinalIgnoreCase);
        using var form = new MainForm(
            paths,
            store,
            supervisor,
            updateService,
            desktopCommander,
            background);

        ManagerProtectedPipeHost? protectedStatusPipe = null;

        try
        {
            try
            {
                // This is a separate, owner-only, READ-ONLY Manager endpoint.
                // It exposes PING 1 only. The existing Agent approval channel
                // is unchanged and no native file move RPC is registered.
                protectedStatusPipe = ManagerProtectedPipeHost.Start();
                logger.Write("info",
                    "Manager owner-only status pipe active (read-only PING only).");
            }
            catch (Exception ex)
            {
                // The optional status-only boundary fails closed: no pipe is
                // exposed on error. Do not weaken its DACL or fall back to
                // Node's existing pipe to emulate this feature.
                logger.Write("warn",
                    "Owner-only status pipe unavailable; disabled ("
                    + ex.GetType().Name + ").");
            }

            Application.Run(form);
        }
        finally
        {
            if (protectedStatusPipe is not null)
            {
                try
                {
                    protectedStatusPipe.DisposeAsync()
                        .AsTask().GetAwaiter().GetResult();
                }
                catch (Exception ex)
                {
                    logger.Write("warn",
                        "Owner-only status pipe stop failed ("
                        + ex.GetType().Name + ").");
                }
            }

            supervisor.DisposeAsync()
                .AsTask()
                .GetAwaiter()
                .GetResult();
        }
    }

    private static async Task<int> RunUpdateHealthCheckAsync(
        ManagerPaths paths)
    {
        paths.EnsureDirectories();

        var store = new ManagerConfigurationStore(paths);
        var emergency = new EmergencyStopStore(
            paths.EmergencyStopPath);

        if (emergency.IsEngaged)
        {
            return 31;
        }

        var logger = new ManagerLogger(paths.LogPath);
        await using var supervisor = new AgentSupervisor(
            paths,
            store,
            emergency,
            logger);

        await supervisor.StartAsync();

        var deadline =
            DateTimeOffset.UtcNow + TimeSpan.FromSeconds(30);

        while (DateTimeOffset.UtcNow < deadline)
        {
            var snapshot = supervisor.Snapshot;

            if (snapshot.AgentState == "HEALTHY" &&
                snapshot.QueueConnectivity == "connected")
            {
                return 0;
            }

            if (snapshot.ManagerState is
                "ERROR" or
                "CONFIG_REQUIRED" or
                "CRASH_LOOP")
            {
                return 32;
            }

            await Task.Delay(500);
        }

        return 33;
    }

    private static bool TryGetOption(
        IReadOnlyList<string> args,
        string name,
        out string? value)
    {
        for (var index = 0; index < args.Count - 1; index++)
        {
            if (args[index].Equals(
                    name,
                    StringComparison.OrdinalIgnoreCase))
            {
                value = args[index + 1];
                return !string.IsNullOrWhiteSpace(value);
            }
        }

        value = null;
        return false;
    }

    private static bool TryGetIntOption(
        IReadOnlyList<string> args,
        string name,
        out int value)
    {
        if (TryGetOption(args, name, out var text) &&
            int.TryParse(text, out value) &&
            value > 0)
        {
            return true;
        }

        value = 0;
        return false;
    }
}
