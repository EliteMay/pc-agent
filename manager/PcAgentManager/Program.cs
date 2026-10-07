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
        var supervisor = new AgentSupervisor(paths, store, emergency, logger);

        var background = args.Contains("--background", StringComparer.OrdinalIgnoreCase);
        using var form = new MainForm(paths, store, supervisor, background);

        try
        {
            Application.Run(form);
        }
        finally
        {
            supervisor.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
    }
}
