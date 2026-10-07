namespace PcAgentManager.Configuration;

public sealed class ManagerPaths
{
    public string RootDirectory { get; }
    public string BundleRootDirectory { get; }
    public string ConfigPath { get; }
    public string TokenPath { get; }
    public string JournalPath { get; }
    public string EmergencyStopPath { get; }
    public string LogPath { get; }
    public string ReleasesDirectory { get; }
    public string UpdateDownloadsDirectory { get; }
    public string UpdateTransactionPath { get; }
    public string NodeExecutablePath { get; }
    public string AgentEntryPath { get; }

    private ManagerPaths(string rootDirectory, string bundleRoot)
    {
        RootDirectory = Path.GetFullPath(rootDirectory);
        BundleRootDirectory = Path.GetFullPath(bundleRoot);
        ConfigPath = Path.Combine(RootDirectory, "manager.json");
        TokenPath = Path.Combine(RootDirectory, "device-token.bin");
        JournalPath = Path.Combine(RootDirectory, "journal.sqlite");
        EmergencyStopPath = Path.Combine(RootDirectory, "emergency-stop.lock");
        LogPath = Path.Combine(RootDirectory, "manager.log");
        ReleasesDirectory = Path.Combine(RootDirectory, "releases");
        UpdateDownloadsDirectory = Path.Combine(RootDirectory, "updates");
        UpdateTransactionPath = Path.Combine(RootDirectory, "update-transaction.json");
        NodeExecutablePath = Path.Combine(BundleRootDirectory, "Runtime", "node.exe");
        AgentEntryPath = Path.Combine(BundleRootDirectory, "Agent", "bin", "pc-agent.js");
    }

    public static ManagerPaths CreateDefault()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return ForRoot(Path.Combine(local, "PcAgent"), AppContext.BaseDirectory);
    }

    public static ManagerPaths ForRoot(string rootDirectory, string? bundleRoot = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(rootDirectory);
        return new ManagerPaths(rootDirectory, Path.GetFullPath(bundleRoot ?? AppContext.BaseDirectory));
    }

    public void EnsureDirectories()
    {
        Directory.CreateDirectory(RootDirectory);
        Directory.CreateDirectory(ReleasesDirectory);
        Directory.CreateDirectory(UpdateDownloadsDirectory);
    }
}
