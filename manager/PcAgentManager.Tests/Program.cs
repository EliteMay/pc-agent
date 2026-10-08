using System.IO.Compression;
using PcAgentManager.Services;
using PcAgentManager.Configuration;
using PcAgentManager.Supervision;

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static void Equal<T>(T expected, T actual, string message)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
    {
        throw new InvalidOperationException($"{message}: expected={expected}, actual={actual}");
    }
}

var failures = new List<string>();

void Run(string name, Action test)
{
    try
    {
        test();
        Console.WriteLine($"PASS {name}");
    }
    catch (Exception ex)
    {
        failures.Add($"{name}: {ex.Message}");
        Console.Error.WriteLine($"FAIL {name}: {ex}");
    }
}

Run("Crash policy uses exponential backoff", () =>
{
    var policy = new CrashRecoveryPolicy(
        crashLimit: 5,
        crashWindow: TimeSpan.FromMinutes(2),
        maxBackoff: TimeSpan.FromSeconds(30));

    var now = DateTimeOffset.Parse("2026-10-07T06:00:00Z");

    Equal(TimeSpan.FromSeconds(1), policy.RegisterCrash(now).RestartDelay, "crash 1");
    Equal(TimeSpan.FromSeconds(2), policy.RegisterCrash(now.AddSeconds(1)).RestartDelay, "crash 2");
    Equal(TimeSpan.FromSeconds(4), policy.RegisterCrash(now.AddSeconds(2)).RestartDelay, "crash 3");
    Equal(TimeSpan.FromSeconds(8), policy.RegisterCrash(now.AddSeconds(3)).RestartDelay, "crash 4");

    var fifth = policy.RegisterCrash(now.AddSeconds(4));
    Require(fifth.CrashLoopDetected, "fifth crash should trip crash-loop detection");
    Require(fifth.RestartDelay is null, "crash loop must stop automatic restart");
});

Run("Crash policy forgets old crashes", () =>
{
    var policy = new CrashRecoveryPolicy(
        crashLimit: 3,
        crashWindow: TimeSpan.FromSeconds(10),
        maxBackoff: TimeSpan.FromSeconds(30));

    var now = DateTimeOffset.Parse("2026-10-07T06:00:00Z");
    _ = policy.RegisterCrash(now);
    _ = policy.RegisterCrash(now.AddSeconds(1));

    var afterWindow = policy.RegisterCrash(now.AddSeconds(20));
    Require(!afterWindow.CrashLoopDetected, "old crashes must be pruned");
    Equal(TimeSpan.FromSeconds(1), afterWindow.RestartDelay, "backoff should reset after window");
});

Run("Manager paths stay under LocalAppData", () =>
{
    var root = Path.Combine(Path.GetTempPath(), "PcAgentManagerTests", Guid.NewGuid().ToString("N"));
    var paths = ManagerPaths.ForRoot(root);

    Require(paths.ConfigPath.StartsWith(root, StringComparison.OrdinalIgnoreCase), "config path");
    Require(paths.JournalPath.StartsWith(root, StringComparison.OrdinalIgnoreCase), "journal path");
    Require(paths.EmergencyStopPath.StartsWith(root, StringComparison.OrdinalIgnoreCase), "emergency path");
    Require(paths.LogPath.StartsWith(root, StringComparison.OrdinalIgnoreCase), "log path");
    Require(paths.ReleasesDirectory.StartsWith(root, StringComparison.OrdinalIgnoreCase), "releases path");
    Require(paths.UpdateDownloadsDirectory.StartsWith(root, StringComparison.OrdinalIgnoreCase), "updates path");
    Require(paths.UpdateTransactionPath.StartsWith(root, StringComparison.OrdinalIgnoreCase), "transaction path");
});

Run("Configuration validation requires endpoint, device, token and roots", () =>
{
    var invalid = new AgentConfiguration
    {
        EndpointUrl = "",
        DeviceId = "",
        DeviceToken = "",
        AllowedRoots = []
    };

    var result = AgentConfigurationValidator.Validate(invalid);
    Require(!result.IsValid, "empty config must be invalid");
    Require(result.Errors.Count >= 4, "expected multiple validation errors");

    var valid = new AgentConfiguration
    {
        EndpointUrl = "https://example.test/functions/v1/pc-agent-device",
        DeviceId = "11111111-1111-4111-8111-111111111111",
        DeviceToken = "a-very-long-device-secret-token",
        AllowedRoots = [@"D:\AI"]
    };

    var ok = AgentConfigurationValidator.Validate(valid);
    Require(ok.IsValid, string.Join("; ", ok.Errors));
});

Run("Desktop Commander supervisor matches only remote root commands", () =>
{
    Require(
        DesktopCommanderRemoteSupervisor.IsRemoteRootCommandLine(
            "\"C:\\Program Files\\nodejs\\node.exe\" "
            + "\"C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js\" "
            + "@wonderwhy-er/desktop-commander@latest remote"),
        "npx desktop-commander remote root should match");

    Require(
        DesktopCommanderRemoteSupervisor.IsRemoteRootCommandLine(
            "C:\\WINDOWS\\system32\\cmd.exe /d /s /c desktop-commander remote"),
        "direct desktop-commander remote command should match");

    Require(
        DesktopCommanderRemoteSupervisor.IsRemoteRootCommandLine(
            "\"node\" "
            + "\"C:\\Users\\test\\AppData\\Local\\npm-cache\\_npx\\pkg\\node_modules\\@wonderwhy-er\\desktop-commander\\dist\\index.js\" "
            + "remote"),
        "direct dist index remote command should match");

    Require(
        !DesktopCommanderRemoteSupervisor.IsRemoteRootCommandLine(
            "powershell.exe -File D:\\AI\\tools\\desktop-commander-remote\\watchdog.ps1"),
        "watchdog PowerShell must not match");

    Require(
        !DesktopCommanderRemoteSupervisor.IsRemoteRootCommandLine(
            "\"C:\\Program Files\\nodejs\\node.exe\" server.js"),
        "unrelated Node process must not match");

    Require(
        !DesktopCommanderRemoteSupervisor.IsRemoteRootCommandLine(
            "powershell.exe -Command Get-CimInstance Win32_Process -match desktop-commander"),
        "Desktop Commander child shell must not match");
});

Run("Game Safety recognizes only protected game process names", () =>
{
    Require(
        ProtectedGameDetector.IsProtectedProcessName("VALORANT-Win64-Shipping.exe"),
        "shipping process should match");
    Require(
        ProtectedGameDetector.IsProtectedProcessName("valorant"),
        "process matching should be case-insensitive");
    Require(
        !ProtectedGameDetector.IsProtectedProcessName("RiotClientServices.exe"),
        "launcher alone should not trigger game safety");
    Require(
        !ProtectedGameDetector.IsProtectedProcessName("notepad.exe"),
        "unrelated process must not match");
});

Run("Game Safety resumes only when Agent was intended to run", () =>
{
    var state = new GameSafetyState();

    var enterRunning = state.Observe(
        gameRunning: true,
        agentRunning: true);

    Require(enterRunning.EnteredGame, "should enter game state");
    Require(enterRunning.ShouldPauseAgent, "running Agent should be paused");
    Require(state.ResumeAgentAfterGame, "running Agent should resume later");

    var exitRunning = state.Observe(
        gameRunning: false,
        agentRunning: false);

    Require(exitRunning.ExitedGame, "should leave game state");
    Require(exitRunning.ShouldResumeAgent, "Agent should resume after game");

    var enterStopped = state.Observe(
        gameRunning: true,
        agentRunning: false);

    Require(!enterStopped.ShouldPauseAgent, "stopped Agent needs no pause");
    Require(!state.ResumeAgentAfterGame, "manually stopped Agent must stay stopped");

    state.RequestResumeAfterGame();
    Require(state.ResumeAgentAfterGame, "explicit start request during game should queue resume");
    state.CancelResumeAfterGame();
    Require(!state.ResumeAgentAfterGame, "manual stop should cancel queued resume");
});

Run("Game Safety can defer configured auto-start until game exit", () =>
{
    var state = new GameSafetyState();
    var enter = state.Observe(
        gameRunning: true,
        agentRunning: false,
        resumeWhenGameEndsIfNotRunning: true);

    Require(!enter.ShouldPauseAgent, "no running Agent to pause");
    Require(state.ResumeAgentAfterGame, "configured auto-start should resume after game");

    var exit = state.Observe(
        gameRunning: false,
        agentRunning: false);

    Require(exit.ShouldResumeAgent, "deferred auto-start should run after game");
});

Run("Emergency stop persists until explicitly cleared", () =>
{
    var root = Path.Combine(Path.GetTempPath(), "PcAgentManagerTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var store = new EmergencyStopStore(Path.Combine(root, "emergency-stop.lock"));
        Require(!store.IsEngaged, "initial state");

        store.Engage("test");
        Require(store.IsEngaged, "engaged state");

        var second = new EmergencyStopStore(Path.Combine(root, "emergency-stop.lock"));
        Require(second.IsEngaged, "state should persist across instances");

        second.Clear();
        Require(!second.IsEngaged, "explicit clear");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});



Run("Legacy device credentials are discovered and imported without manual entry", () =>
{
    var root = Path.Combine(
        Path.GetTempPath(),
        "PcAgentManagerLegacyImportTests",
        Guid.NewGuid().ToString("N"));

    var searchRoot = Path.Combine(root, "config");
    var legacyDirectory = Path.Combine(searchRoot, "legacy-agent");
    Directory.CreateDirectory(legacyDirectory);

    try
    {
        var deviceId = "11111111-1111-4111-8111-111111111111";
        var token = "legacy-device-token-that-is-long-enough";

        File.WriteAllText(
            Path.Combine(legacyDirectory, "device.json"),
            System.Text.Json.JsonSerializer.Serialize(new
            {
                relayUrl = "https://vtnwbgejlaqpnwmlzbjy.supabase.co/functions/v1/legacy-gateway",
                deviceId,
                deviceToken = token,
                deviceName = "Windows PC"
            }));

        var importer = new LegacyDeviceCredentialImporter(
            [searchRoot],
            expectedSupabaseProjectId: "vtnwbgejlaqpnwmlzbjy");

        var result = importer.TryFind();

        Require(result.Found, "legacy credentials should be found");
        Equal(deviceId, result.DeviceId, "device id");
        Equal(token, result.DeviceToken, "device token");
        Require(
            result.SourcePath?.EndsWith("device.json", StringComparison.OrdinalIgnoreCase) == true,
            "source path should point to the legacy device.json");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Legacy importer ignores unrelated device.json files", () =>
{
    var root = Path.Combine(
        Path.GetTempPath(),
        "PcAgentManagerLegacyImportTests",
        Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        File.WriteAllText(
            Path.Combine(root, "device.json"),
            """
            {
              "deviceId": "11111111-1111-4111-8111-111111111111",
              "deviceToken": "this-token-is-long-but-not-from-our-supabase",
              "relayUrl": "https://example.test/device"
            }
            """);

        var importer = new LegacyDeviceCredentialImporter(
            [root],
            expectedSupabaseProjectId: "vtnwbgejlaqpnwmlzbjy");

        var result = importer.TryFind();

        Require(!result.Found, "unrelated device config must not be imported");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});


Run("Updater compares semantic versions and parses SHA-256 files", () =>
{
    Require(
        ManagerUpdateService.IsNewerVersion("0.6.0", "0.5.0"),
        "0.6.0 should be newer than 0.5.0");
    Require(
        !ManagerUpdateService.IsNewerVersion("0.5.0", "0.5.0"),
        "equal versions are not updates");
    Require(
        !ManagerUpdateService.IsNewerVersion("0.4.9", "0.5.0"),
        "older versions are not updates");

    var hash = new string('a', 64);
    Equal(
        hash,
        ManagerUpdateService.ParseSha256Text(
            hash + "  pc-agent-manager-win-x64.zip"),
        "sha256 parser");

    var invalidRejected = false;
    try
    {
        _ = ManagerUpdateService.ParseSha256Text("not-a-hash");
    }
    catch (InvalidDataException)
    {
        invalidRejected = true;
    }

    Require(invalidRejected, "invalid SHA-256 text must be rejected");
});

Run("Updater rejects ZIP path traversal", () =>
{
    var root = Path.Combine(
        Path.GetTempPath(),
        "PcAgentUpdateZipTests",
        Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    var archivePath = Path.Combine(root, "update.zip");
    var destination = Path.Combine(root, "extract");

    try
    {
        using (var archive = ZipFile.Open(
                   archivePath,
                   ZipArchiveMode.Create))
        {
            var entry = archive.CreateEntry("../escape.txt");
            using var writer = new StreamWriter(entry.Open());
            writer.Write("escape");
        }

        var rejected = false;
        try
        {
            ManagerUpdateService.ExtractZipSafely(
                archivePath,
                destination);
        }
        catch (InvalidDataException)
        {
            rejected = true;
        }

        Require(rejected, "path traversal archive must be rejected");
        Require(
            !File.Exists(Path.Combine(root, "escape.txt")),
            "path traversal must not create an escaped file");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Update bootstrap only accepts candidate executables inside release root", () =>
{
    var root = Path.Combine(
        Path.GetTempPath(),
        "PcAgentUpdatePathTests",
        Guid.NewGuid().ToString("N"));
    var releases = Path.Combine(root, "releases");
    var candidate = Path.Combine(
        releases,
        "0.6.0",
        "PcAgentManager.exe");
    var sibling = Path.Combine(
        root,
        "releases-evil",
        "PcAgentManager.exe");

    Require(
        UpdateBootstrapper.IsPathInside(candidate, releases),
        "candidate under releases should be allowed");
    Require(
        !UpdateBootstrapper.IsPathInside(sibling, releases),
        "sibling-prefix path must be rejected");
});



Run("Windows move prototype renames one file without replacing another", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentNoReplacePrototype", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var source = Path.Combine(root, "source.txt");
        var destination = Path.Combine(root, "destination.txt");
        File.WriteAllText(source, "approved source");

        WindowsNoReplaceMovePrototype.MoveFileForTest(source, destination);

        Require(!File.Exists(source), "source must be moved");
        Equal("approved source", File.ReadAllText(destination), "moved bytes");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Windows move prototype refuses a preexisting target without losing data", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentNoReplacePrototype", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var source = Path.Combine(root, "source.txt");
        var destination = Path.Combine(root, "destination.txt");
        File.WriteAllText(source, "original source");
        File.WriteAllText(destination, "protected target");

        var refused = false;

        try
        {
            WindowsNoReplaceMovePrototype.MoveFileForTest(source, destination);
        }
        catch (System.ComponentModel.Win32Exception)
        {
            refused = true;
        }

        Require(refused, "existing destination must be rejected by Windows");
        Equal("original source", File.ReadAllText(source), "source preserved");
        Equal("protected target", File.ReadAllText(destination), "destination preserved");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Windows move prototype fails when a competing target appears at the native boundary", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentNoReplacePrototype", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var source = Path.Combine(root, "source.txt");
        var destination = Path.Combine(root, "destination.txt");
        File.WriteAllText(source, "original source");

        var refused = false;

        try
        {
            WindowsNoReplaceMovePrototype.MoveFileForTest(
                source,
                destination,
                beforeNativeRename: () => File.WriteAllText(
                    destination,
                    "concurrently created target"));
        }
        catch (System.ComponentModel.Win32Exception)
        {
            refused = true;
        }

        Require(refused, "native rename must refuse the competing target");
        Equal("original source", File.ReadAllText(source), "source preserved");
        Equal("concurrently created target", File.ReadAllText(destination), "competing target preserved");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

if (failures.Count > 0)
{
    Console.Error.WriteLine();
    Console.Error.WriteLine($"{failures.Count} manager regression test(s) failed.");
    Environment.Exit(1);
}

Console.WriteLine("All manager regression tests passed.");
