using System.IO.Compression;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
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
        catch (System.ComponentModel.Win32Exception error)
        {
            // A generic API parameter error is NOT evidence of no-overwrite.
            refused = error.NativeErrorCode is 80 or 183;
            if (!refused)
            {
                throw new InvalidOperationException(
                    $"Native rename failed for an unexpected reason: {error.NativeErrorCode}",
                    error);
            }
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
        catch (System.ComponentModel.Win32Exception error)
        {
            // A generic API parameter error is NOT evidence of no-overwrite.
            refused = error.NativeErrorCode is 80 or 183;
            if (!refused)
            {
                throw new InvalidOperationException(
                    $"Native rename failed for an unexpected reason: {error.NativeErrorCode}",
                    error);
            }
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


Run("Windows approval snapshot permits an unchanged authorized file move", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentMoveApprovalTests", Guid.NewGuid().ToString("N"));
    var targetParent = Path.Combine(root, "incoming");
    Directory.CreateDirectory(targetParent);

    try
    {
        var source = Path.Combine(root, "source.txt");
        var destination = Path.Combine(targetParent, "new.txt");
        File.WriteAllText(source, "approved bytes");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "op-test-approved-1");
        WindowsNoReplaceMovePrototype.MoveFileForTest(
            source, destination, approved: approved, operationId: "op-test-approved-1");

        Require(!File.Exists(source), "approved source must be moved");
        Equal("approved bytes", File.ReadAllText(destination), "approved result bytes");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Windows approval snapshot refuses a same-byte source replacement", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentMoveApprovalTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var source = Path.Combine(root, "source.txt");
        var original = Path.Combine(root, "old-original.txt");
        var destination = Path.Combine(root, "destination.txt");
        File.WriteAllText(source, "identical contents");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "op-test-approved-1");

        File.Move(source, original);
        File.WriteAllText(source, "identical contents");

        var refused = false;
        try
        {
            WindowsNoReplaceMovePrototype.MoveFileForTest(
                source, destination, approved: approved, operationId: "op-test-approved-1");
        }
        catch (InvalidOperationException)
        {
            refused = true;
        }

        Require(refused, "approval must not authorize a substituted file object");
        Require(!File.Exists(destination), "no destination may be created");
        Equal("identical contents", File.ReadAllText(source), "replacement must survive");
        Equal("identical contents", File.ReadAllText(original), "original must survive");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Windows approval snapshot refuses destination parent replacement", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentMoveApprovalTests", Guid.NewGuid().ToString("N"));
    var parent = Path.Combine(root, "incoming");
    var movedParent = Path.Combine(root, "previous-parent");
    Directory.CreateDirectory(parent);

    try
    {
        var source = Path.Combine(root, "source.txt");
        var destination = Path.Combine(parent, "new.txt");
        File.WriteAllText(source, "do not move");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "op-test-approved-1");

        Directory.Move(parent, movedParent);
        Directory.CreateDirectory(parent);

        var refused = false;
        try
        {
            WindowsNoReplaceMovePrototype.MoveFileForTest(
                source, destination, approved: approved, operationId: "op-test-approved-1");
        }
        catch (InvalidOperationException)
        {
            refused = true;
        }

        Require(refused, "destination parent object substitution must be refused");
        Equal("do not move", File.ReadAllText(source), "source remains");
        Require(!File.Exists(destination), "replacement parent must not receive moved file");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Windows approval snapshot detects destination-parent swap at precommit test barrier", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentMoveApprovalTests", Guid.NewGuid().ToString("N"));
    var parent = Path.Combine(root, "incoming");
    var oldParent = Path.Combine(root, "displaced");
    Directory.CreateDirectory(parent);

    try
    {
        var source = Path.Combine(root, "source.txt");
        var destination = Path.Combine(parent, "new.txt");
        File.WriteAllText(source, "protected source");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "op-test-approved-1");

        var refused = false;
        var callbackInvoked = false;
        try
        {
            WindowsNoReplaceMovePrototype.MoveFileForTest(
                source,
                destination,
                beforeNativeRename: () =>
                {
                    Directory.Move(parent, oldParent);
                    Directory.CreateDirectory(parent);
                    callbackInvoked = true;
                },
                approved: approved, operationId: "op-test-approved-1");
        }
        catch (InvalidOperationException)
        {
            refused = true;
        }

        Require(callbackInvoked, "attack setup must run before rejecting");
        Require(refused, "parent swap at test barrier must be rejected");
        Equal("protected source", File.ReadAllText(source), "source preserved");
        Require(!File.Exists(destination), "swapped parent receives no file");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Windows approval snapshot refuses source outside its allowed root", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var baseDir = Path.Combine(Path.GetTempPath(), "PcAgentMoveApprovalTests", Guid.NewGuid().ToString("N"));
    var allowedRoot = Path.Combine(baseDir, "allowed");
    Directory.CreateDirectory(allowedRoot);

    try
    {
        var source = Path.Combine(baseDir, "outside.txt");
        var destination = Path.Combine(allowedRoot, "destination.txt");
        File.WriteAllText(source, "private outside content");

        var rejected = false;
        try
        {
            _ = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
                source, destination, allowedRoot, "op-test-approved-1");
        }
        catch (InvalidOperationException)
        {
            rejected = true;
        }

        Require(rejected, "outside source must not pass approval capture");
        Equal("private outside content", File.ReadAllText(source), "source preserved");
        Require(!File.Exists(destination), "destination not created");
    }
    finally
    {
        Directory.Delete(baseDir, recursive: true);
    }
});


Run("Windows approval snapshot refuses a destination junction swap outside the root", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var sandbox = Path.Combine(
        Path.GetTempPath(),
        "PcAgentMoveJunctionTests",
        Guid.NewGuid().ToString("N"));
    var allowed = Path.Combine(sandbox, "allowed");
    var outside = Path.Combine(sandbox, "outside");
    var destinationParent = Path.Combine(allowed, "incoming");
    var displacedParent = Path.Combine(allowed, "original-incoming");
    Directory.CreateDirectory(destinationParent);
    Directory.CreateDirectory(outside);

    try
    {
        var source = Path.Combine(allowed, "source.txt");
        var destination = Path.Combine(destinationParent, "moved.txt");
        var outsideDestination = Path.Combine(outside, "moved.txt");
        File.WriteAllText(source, "keep this inside approved roots");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, allowed, "op-test-approved-1");

        var hookCompleted = false;
        var rejected = false;

        try
        {
            WindowsNoReplaceMovePrototype.MoveFileForTest(
                source,
                destination,
                beforeNativeRename: () =>
                {
                    Directory.Move(destinationParent, displacedParent);

                    // Test-only Windows directory junction to an outside fixture.
                    // The Agent does NOT execute cmd.exe or arbitrary shell commands.
                    var command = new System.Diagnostics.ProcessStartInfo
                    {
                        FileName = "cmd.exe",
                        Arguments = "/d /c mklink /J \"" + destinationParent
                            + "\" \"" + outside + "\"",
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        CreateNoWindow = true,
                        UseShellExecute = false
                    };
                    using var process = System.Diagnostics.Process.Start(command)
                        ?? throw new InvalidOperationException("Could not start junction fixture");
                    var output = process.StandardOutput.ReadToEnd();
                    var error = process.StandardError.ReadToEnd();
                    Require(process.WaitForExit(10_000), "junction setup timed out");
                    Equal(0, process.ExitCode, "junction fixture: " + output + error);

                    hookCompleted = true;
                },
                approved: approved, operationId: "op-test-approved-1");
        }
        catch (InvalidOperationException)
        {
            rejected = true;
        }

        Require(hookCompleted, "the junction must actually have been created");
        Require(rejected, "approved destination parent must not be redirected");
        Equal(
            "keep this inside approved roots",
            File.ReadAllText(source),
            "source must survive");
        Require(!File.Exists(outsideDestination), "nothing may appear outside allowed roots");

        // Reusing the junction at the approval stage must also be denied.
        var captureRefused = false;
        try
        {
            _ = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
                source, destination, allowed, "op-test-approved-1");
        }
        catch (InvalidOperationException)
        {
            captureRefused = true;
        }
        Require(captureRefused, "a junction parent must fail at approval capture");
    }
    finally
    {
        // Remove the junction itself, not the target directory.
        if (Directory.Exists(destinationParent) &&
            (File.GetAttributes(destinationParent) & FileAttributes.ReparsePoint) != 0)
        {
            Directory.Delete(destinationParent);
        }

        Directory.Delete(sandbox, recursive: true);
    }
});


Run("Windows approval snapshot cannot authorize a different operation ID", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentMoveApprovalTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var source = Path.Combine(root, "original.txt");
        var destination = Path.Combine(root, "result.txt");
        File.WriteAllText(source, "protected content");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "approved-operation-1");

        var refused = false;
        try
        {
            WindowsNoReplaceMovePrototype.MoveFileForTest(
                source,
                destination,
                approved: approved,
                operationId: "different-operation-2");
        }
        catch (InvalidOperationException)
        {
            refused = true;
        }

        Require(refused, "another operation must not reuse an approval");
        Equal("protected content", File.ReadAllText(source), "original survives");
        Require(!File.Exists(destination), "unapproved destination remains absent");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});


Run("NT relative-handle file move succeeds with matching local approval", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentNtAnchorTests", Guid.NewGuid().ToString("N"));
    var parent = Path.Combine(root, "destination");
    Directory.CreateDirectory(parent);

    try
    {
        var source = Path.Combine(root, "from.txt");
        var destination = Path.Combine(parent, "to.txt");
        File.WriteAllText(source, "only approved data");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "nt-approved-1");
        WindowsNoReplaceMovePrototype.MoveFileForTest(
            source, destination,
            approved: approved, operationId: "nt-approved-1",
            useNativeRelativeMoveForTest: true);

        Require(!File.Exists(source), "native relative-handle source must be moved");
        Equal("only approved data", File.ReadAllText(destination), "native result bytes");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("NT relative-handle move refuses a preexisting target", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentNtAnchorTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var source = Path.Combine(root, "from.txt");
        var destination = Path.Combine(root, "to.txt");
        File.WriteAllText(source, "authorized source");
        File.WriteAllText(destination, "protected existing");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "nt-approved-2");

        var refused = false;
        try
        {
            WindowsNoReplaceMovePrototype.MoveFileForTest(
                source, destination,
                approved: approved, operationId: "nt-approved-2",
                useNativeRelativeMoveForTest: true);
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            refused = error.NativeErrorCode is 80 or 183;
            if (!refused) throw;
        }

        Require(refused, "native NT collision must report target exists");
        Equal("authorized source", File.ReadAllText(source), "NT source preserved");
        Equal("protected existing", File.ReadAllText(destination), "NT target preserved");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("NT relative-handle move refuses a competing target at the native boundary", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentNtAnchorTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var source = Path.Combine(root, "from.txt");
        var destination = Path.Combine(root, "to.txt");
        File.WriteAllText(source, "authorized source");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "nt-approved-3");

        var refused = false;
        try
        {
            WindowsNoReplaceMovePrototype.MoveFileForTest(
                source, destination,
                beforeNativeRename: () =>
                    File.WriteAllText(destination, "racing target"),
                approved: approved, operationId: "nt-approved-3",
                useNativeRelativeMoveForTest: true);
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            refused = error.NativeErrorCode is 80 or 183;
            if (!refused) throw;
        }

        Require(refused, "native NT race must report target exists");
        Equal("authorized source", File.ReadAllText(source), "NT source survives");
        Equal("racing target", File.ReadAllText(destination), "competing NT target survives");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("NT relative-handle move blocks destination parent relocation while opened", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentNtAnchorTests", Guid.NewGuid().ToString("N"));
    var parent = Path.Combine(root, "incoming");
    var relocated = Path.Combine(root, "relocated");
    Directory.CreateDirectory(parent);

    try
    {
        var source = Path.Combine(root, "from.txt");
        var destination = Path.Combine(parent, "to.txt");
        File.WriteAllText(source, "remain within root");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "nt-approved-4");

        var relocationDenied = false;
        WindowsNoReplaceMovePrototype.MoveFileForTest(
            source, destination,
            beforeNativeRename: () =>
            {
                try
                {
                    Directory.Move(parent, relocated);
                }
                catch (IOException)
                {
                    relocationDenied = true;
                }
            },
            approved: approved, operationId: "nt-approved-4",
            useNativeRelativeMoveForTest: true);

        Require(relocationDenied, "opened parent handle must block relocation");
        Equal("remain within root", File.ReadAllText(destination), "file remains inside root");
        Require(!Directory.Exists(relocated), "parent could not be moved");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("NT relative-handle move refuses same-byte source replacement after approval", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentNtAnchorTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var source = Path.Combine(root, "from.txt");
        var original = Path.Combine(root, "original.txt");
        var destination = Path.Combine(root, "to.txt");
        File.WriteAllText(source, "identical");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "nt-approved-5");
        File.Move(source, original);
        File.WriteAllText(source, "identical");

        var denied = false;
        try
        {
            WindowsNoReplaceMovePrototype.MoveFileForTest(
                source, destination,
                approved: approved, operationId: "nt-approved-5",
                useNativeRelativeMoveForTest: true);
        }
        catch (InvalidOperationException)
        {
            denied = true;
        }

        Require(denied, "native helper must enforce object identity");
        Require(!File.Exists(destination), "replacement must not move");
        Equal("identical", File.ReadAllText(source), "substitute survives");
        Equal("identical", File.ReadAllText(original), "approved object survives");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});


Run("NT relative-handle move blocks relocation of an intermediate destination ancestor", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentNtAnchorTests", Guid.NewGuid().ToString("N"));
    var intermediate = Path.Combine(root, "group");
    var parent = Path.Combine(intermediate, "incoming");
    var displaced = Path.Combine(root, "group-displaced");
    Directory.CreateDirectory(parent);

    try
    {
        var source = Path.Combine(root, "source.txt");
        var destination = Path.Combine(parent, "target.txt");
        File.WriteAllText(source, "must stay inside");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "nt-ancestor-lock-1");

        var relocationDenied = false;
        WindowsNoReplaceMovePrototype.MoveFileForTest(
            source,
            destination,
            beforeNativeRename: () =>
            {
                try
                {
                    Directory.Move(intermediate, displaced);
                }
                catch (IOException)
                {
                    relocationDenied = true;
                }
            },
            approved: approved,
            operationId: "nt-ancestor-lock-1",
            useNativeRelativeMoveForTest: true);

        Require(relocationDenied, "intermediate ancestor cannot be renamed while guard is open");
        Equal("must stay inside", File.ReadAllText(destination), "result remains inside approved root");
        Require(!Directory.Exists(displaced), "ancestor did not move");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("NT relative-handle move blocks relocation of an intermediate source ancestor", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentNtAnchorTests", Guid.NewGuid().ToString("N"));
    var intermediate = Path.Combine(root, "workspace");
    var parent = Path.Combine(intermediate, "src");
    var displaced = Path.Combine(root, "workspace-displaced");
    Directory.CreateDirectory(parent);

    try
    {
        var source = Path.Combine(parent, "source.txt");
        var destination = Path.Combine(root, "target.txt");
        File.WriteAllText(source, "approved source content");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "nt-ancestor-lock-2");

        var relocationDenied = false;
        WindowsNoReplaceMovePrototype.MoveFileForTest(
            source,
            destination,
            beforeNativeRename: () =>
            {
                try
                {
                    Directory.Move(intermediate, displaced);
                }
                catch (IOException)
                {
                    relocationDenied = true;
                }
            },
            approved: approved,
            operationId: "nt-ancestor-lock-2",
            useNativeRelativeMoveForTest: true);

        Require(relocationDenied, "intermediate source ancestor cannot be renamed");
        Equal("approved source content", File.ReadAllText(destination), "move result is correct");
        Require(!Directory.Exists(displaced), "source ancestor remains anchored");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});


Run("NT move approval binds source SHA even when size and last-write time are restored", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentMoveHashTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var source = Path.Combine(root, "source.txt");
        var destination = Path.Combine(root, "moved.txt");
        File.WriteAllText(source, "first-contents");
        var originalWriteTime = File.GetLastWriteTimeUtc(source);

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "content-approved-1");

        File.WriteAllText(source, "other-contents");
        File.SetLastWriteTimeUtc(source, originalWriteTime);

        var current = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "content-approved-2");

        Equal(approved.SourceIdentity, current.SourceIdentity,
            "the replacement must keep the same file identity, length and write timestamp");
        Require(approved.SourceSha256 != current.SourceSha256,
            "same-metadata content mutation must change SHA");

        var denied = false;
        try
        {
            WindowsNoReplaceMovePrototype.MoveFileForTest(
                source, destination,
                approved: approved, operationId: "content-approved-1",
                useNativeRelativeMoveForTest: true);
        }
        catch (InvalidOperationException)
        {
            denied = true;
        }

        Require(denied, "changed content must invalidate approval even if metadata is restored");
        Equal("other-contents", File.ReadAllText(source), "modified source must stay");
        Require(!File.Exists(destination), "unapproved content must not move");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("NT move keeps concurrent source writers out while the approved handle is open", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentMoveHashTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var source = Path.Combine(root, "source.txt");
        var destination = Path.Combine(root, "moved.txt");
        File.WriteAllText(source, "unchanged-approved-bytes");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, root, "content-approved-3");

        var writerRejected = false;
        WindowsNoReplaceMovePrototype.MoveFileForTest(
            source,
            destination,
            beforeNativeRename: () =>
            {
                try
                {
                    using var writer = new FileStream(
                        source, FileMode.Open, FileAccess.Write,
                        FileShare.ReadWrite | FileShare.Delete);
                    writer.WriteByte(0x78);
                }
                catch (IOException)
                {
                    writerRejected = true;
                }
            },
            approved: approved, operationId: "content-approved-3",
            useNativeRelativeMoveForTest: true);

        Require(writerRejected, "writers must not open while the rename handle is held");
        Require(!File.Exists(source), "approved file moved");
        Equal("unchanged-approved-bytes", File.ReadAllText(destination),
            "the renamed file must retain approved content");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("NT move prototype rejects approval of an oversized source without reading it", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentMoveHashTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var source = Path.Combine(root, "oversized.bin");
        var destination = Path.Combine(root, "moved.bin");
        using (var stream = new FileStream(source, FileMode.CreateNew, FileAccess.Write))
        {
            stream.SetLength(64L * 1024 * 1024 + 1);
        }

        var rejected = false;
        try
        {
            _ = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
                source, destination, root, "content-approved-4");
        }
        catch (InvalidOperationException)
        {
            rejected = true;
        }

        Require(rejected, "source size must be bounded to 64 MiB in the prototype");
        Require(File.Exists(source), "large source preserved");
        Require(!File.Exists(destination), "no large target created");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});


Run("NT move prevents an ancestor above the approved root from being relocated", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var sandbox = Path.Combine(
        Path.GetTempPath(), "PcAgentAncestorRaceTests", Guid.NewGuid().ToString("N"));
    var relocatedSandbox = sandbox + "-displaced";
    var approvedRoot = Path.Combine(sandbox, "allowed");
    Directory.CreateDirectory(approvedRoot);

    try
    {
        var source = Path.Combine(approvedRoot, "source.txt");
        var destination = Path.Combine(approvedRoot, "destination.txt");
        File.WriteAllText(source, "anchored approved source");

        var approved = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, approvedRoot, "nt-root-ancestor-lock-1");

        var relocationBlocked = false;
        WindowsNoReplaceMovePrototype.MoveFileForTest(
            source, destination,
            beforeNativeRename: () =>
            {
                try
                {
                    Directory.Move(sandbox, relocatedSandbox);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    relocationBlocked = true;
                }
            },
            approved: approved, operationId: "nt-root-ancestor-lock-1",
            useNativeRelativeMoveForTest: true);

        Require(relocationBlocked, "the parent of the allowed root must remain anchored");
        Require(!Directory.Exists(relocatedSandbox), "approved root ancestor not relocated");
        Require(!File.Exists(source), "the authorized source was moved");
        Equal("anchored approved source", File.ReadAllText(destination),
            "authorized destination remains in place");
    }
    finally
    {
        if (Directory.Exists(relocatedSandbox) && !Directory.Exists(sandbox))
        {
            Directory.Move(relocatedSandbox, sandbox);
        }
        if (Directory.Exists(sandbox))
        {
            Directory.Delete(sandbox, recursive: true);
        }
    }
});


Run("Local move approval ticket authenticates and can only be consumed once", () =>
{
    var now = DateTimeOffset.Parse("2026-10-08T02:00:00Z");
    using var issuer = new LocalMoveApprovalTicketPrototype(
        Enumerable.Repeat((byte)0x42, 32).ToArray());

    var request = new LocalMoveApprovalTicketPrototype.MoveRequest(
        "command-1",
        "device-1",
        "operation-1",
        @"C:\Workspace\from.txt",
        @"C:\Workspace\to.txt",
        @"C:\Workspace",
        new string('a', 64));

    var ticket = issuer.IssueApprovedForTest(request, now);
    issuer.ConsumeForTest(ticket, request, now.AddSeconds(1));

    var replayRejected = false;
    try
    {
        issuer.ConsumeForTest(ticket, request, now.AddSeconds(2));
    }
    catch (InvalidOperationException)
    {
        replayRejected = true;
    }

    Require(replayRejected, "consumed approval cannot be replayed");
    var freshTicket = issuer.IssueApprovedForTest(request, now.AddSeconds(3));
    var freshNonceSameOperationRejected = false;
    try
    {
        issuer.ConsumeForTest(freshTicket, request, now.AddSeconds(4));
    }
    catch (InvalidOperationException)
    {
        freshNonceSameOperationRejected = true;
    }
    Require(freshNonceSameOperationRejected,
        "minting a new nonce must not authorize reusing the same operation ID");
});

Run("Local move ticket rejects tampering and a mismatched execution request", () =>
{
    var now = DateTimeOffset.Parse("2026-10-08T02:00:00Z");
    using var issuer = new LocalMoveApprovalTicketPrototype(
        Enumerable.Repeat((byte)0x7d, 32).ToArray());

    var request = new LocalMoveApprovalTicketPrototype.MoveRequest(
        "command-2",
        "device-2",
        "operation-2",
        @"D:\Approved\from.txt",
        @"D:\Approved\to.txt",
        @"D:\Approved",
        new string('b', 64));

    var ticket = issuer.IssueApprovedForTest(request, now);
    var mutatedBytes = (byte[])ticket.PayloadUtf8.Clone();
    mutatedBytes[mutatedBytes.Length / 2] ^= 0x01;
    var tampered = new LocalMoveApprovalTicketPrototype.SignedTicket(
        mutatedBytes, ticket.HmacSha256);

    var tamperRejected = false;
    try
    {
        issuer.ConsumeForTest(tampered, request, now.AddSeconds(1));
    }
    catch (InvalidOperationException)
    {
        tamperRejected = true;
    }
    Require(tamperRejected, "modified payload must fail HMAC check");

    foreach (var wrong in new[]
    {
        request with { CommandId = "other-command" },
        request with { DeviceId = "other-device" },
        request with { OperationId = "other-operation" },
        request with { SourcePath = @"D:\Approved\other.txt" },
        request with { DestinationPath = @"D:\Approved\different.txt" },
        request with { AllowedRootPath = @"D:\Other" },
        request with { SourceSha256 = new string('c', 64) }
    })
    {
        var mismatchRejected = false;
        try
        {
            issuer.ConsumeForTest(ticket, wrong, now.AddSeconds(1));
        }
        catch (InvalidOperationException)
        {
            mismatchRejected = true;
        }
        Require(mismatchRejected, "mismatched operation context must be rejected");
    }

    // Failed verification does not consume a valid approval.
    issuer.ConsumeForTest(ticket, request, now.AddSeconds(1));
});

Run("Local move ticket enforces two-minute expiry, future issuance and its secret", () =>
{
    var now = DateTimeOffset.Parse("2026-10-08T02:00:00Z");
    var request = new LocalMoveApprovalTicketPrototype.MoveRequest(
        "command-3", "device-3", "operation-3",
        @"D:\Sandbox\source.txt", @"D:\Sandbox\destination.txt", @"D:\Sandbox",
        new string('d', 64));

    using var first = new LocalMoveApprovalTicketPrototype(
        Enumerable.Repeat((byte)0x11, 32).ToArray());
    using var differentKey = new LocalMoveApprovalTicketPrototype(
        Enumerable.Repeat((byte)0x12, 32).ToArray());

    var ticket = first.IssueApprovedForTest(request, now);

    foreach (var consume in new Action[]
    {
        () => first.ConsumeForTest(ticket, request, now.AddSeconds(-1)),
        () => first.ConsumeForTest(ticket, request, now.AddMinutes(3)),
        () => differentKey.ConsumeForTest(ticket, request, now.AddSeconds(5))
    })
    {
        var rejected = false;
        try
        {
            consume();
        }
        catch (InvalidOperationException)
        {
            rejected = true;
        }
        Require(rejected, "invalid time or different secret must deny the grant");
    }

    first.ConsumeForTest(ticket, request, now.AddSeconds(10));
});

Run("Local move ticket rejects oversized or malformed ticket data", () =>
{
    var now = DateTimeOffset.Parse("2026-10-08T02:00:00Z");
    using var service = new LocalMoveApprovalTicketPrototype(
        Enumerable.Repeat((byte)0x20, 32).ToArray());
    var request = new LocalMoveApprovalTicketPrototype.MoveRequest(
        "command-4", "device-4", "operation-4",
        @"D:\Sandbox\from.txt", @"D:\Sandbox\to.txt", @"D:\Sandbox",
        new string('e', 64));

    var tickets = new[]
    {
        new LocalMoveApprovalTicketPrototype.SignedTicket(new byte[9000], new byte[32]),
        new LocalMoveApprovalTicketPrototype.SignedTicket(new byte[] { 0x41 }, new byte[0])
    };

    foreach (var ticket in tickets)
    {
        var rejected = false;
        try
        {
            service.ConsumeForTest(ticket, request, now);
        }
        catch (InvalidOperationException)
        {
            rejected = true;
        }
        Require(rejected, "malformed tickets must be refused");
    }

    var issued = service.IssueApprovedForTest(request, now);
    service.ConsumeForTest(issued, request, now);
});


Run("Durable approval ticket replay stays blocked after Manager restart", () =>
{
    var root = Path.Combine(Path.GetTempPath(), "PcAgentReplayStoreTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var now = DateTimeOffset.Parse("2026-10-08T02:00:00Z");
        var key = Enumerable.Repeat((byte)0x45, 32).ToArray();
        var request = new LocalMoveApprovalTicketPrototype.MoveRequest(
            "cmd-restart", "device-restart", "operation-restart",
            @"D:\AI\source.txt", @"D:\AI\target.txt", @"D:\AI", new string('f', 64));

        // First Manager instance accepts the exact local approval once.
        var store = new DurableMoveApprovalReplayStorePrototype(root);
        using (var first = new LocalMoveApprovalTicketPrototype(key, store))
        {
            var ticket = first.IssueApprovedForTest(request, now);
            first.ConsumeForTest(ticket, request, now.AddSeconds(1));
        }

        // New Manager instance has an empty in-memory cache, but the marker
        // must reject both the original ticket and a freshly minted nonce.
        using (var reopened = new LocalMoveApprovalTicketPrototype(
            key, new DurableMoveApprovalReplayStorePrototype(root)))
        {
            var replay = reopened.IssueApprovedForTest(request, now.AddSeconds(2));
            var denied = false;
            try
            {
                reopened.ConsumeForTest(replay, request, now.AddSeconds(3));
            }
            catch (InvalidOperationException)
            {
                denied = true;
            }
            Require(denied, "restarted Manager must not forget consumed operation");

            // A different operation ID still works in the same store.
            var next = request with { OperationId = "operation-new" };
            var nextTicket = reopened.IssueApprovedForTest(next, now.AddSeconds(4));
            reopened.ConsumeForTest(nextTicket, next, now.AddSeconds(5));
        }

        Equal(2, Directory.EnumerateFiles(root, "*.used").Count(),
            "both authorized reservations remain durable");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Durable approval replay reservation is atomic across independent instances", () =>
{
    var root = Path.Combine(Path.GetTempPath(), "PcAgentReplayStoreTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var success = 0;
        var rejected = 0;
        Parallel.For(0, 8, _ =>
        {
            var independent = new DurableMoveApprovalReplayStorePrototype(root);
            try
            {
                independent.Reserve("one-concurrent-operation");
                Interlocked.Increment(ref success);
            }
            catch (InvalidOperationException)
            {
                Interlocked.Increment(ref rejected);
            }
        });

        Equal(1, success, "exactly one independent process-style claimant reserves");
        Equal(7, rejected, "all competing claimants are denied");
        Equal(1, Directory.EnumerateFiles(root, "*.used").Count(),
            "only one operation marker is persisted");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Uncertain outcome keeps a durable replay marker permanently", () =>
{
    var root = Path.Combine(Path.GetTempPath(), "PcAgentReplayStoreTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);

    try
    {
        var beforeCrash = new DurableMoveApprovalReplayStorePrototype(root);
        beforeCrash.Reserve("reserved-but-never-executed");

        // Simulates a power loss / process crash after authorization but
        // before the move. The existing marker must NOT be erased.
        var afterCrash = new DurableMoveApprovalReplayStorePrototype(root);
        var denied = false;
        try
        {
            afterCrash.Reserve("reserved-but-never-executed");
        }
        catch (InvalidOperationException)
        {
            denied = true;
        }
        Require(denied, "uncertain outcome must fail closed across restart");
        Equal(1, Directory.EnumerateFiles(root, "*.used").Count(),
            "reservation retained after simulated crash");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Durable replay store fails closed when its directory is invalid", () =>
{
    var root = Path.Combine(Path.GetTempPath(), "PcAgentReplayStoreTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);
    try
    {
        var journalRoot = Path.Combine(root, "approvals");
        var store = new DurableMoveApprovalReplayStorePrototype(journalRoot);

        // Lose the trusted storage directory before reserving. No fallback
        // to an in-memory cache or an alternative location is permitted.
        Directory.Delete(journalRoot, recursive: true);
        File.WriteAllText(journalRoot, "not a trusted directory");

        var denied = false;
        try
        {
            store.Reserve("must-not-execute");
        }
        catch (InvalidOperationException)
        {
            denied = true;
        }
        Require(denied, "tampered durable replay location must deny execution");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});


Run("Manager pipe client blocks unauthenticated privileged requests before connection", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var client = new NamedPipeAgentClient("PcAgent-Test-MissingKey-" + Guid.NewGuid().ToString("N"));
    var deniedResponse = false;
    try
    {
        _ = client.RespondApprovalAsync("op-private", "approved", new string('f', 32)).GetAwaiter().GetResult();
    }
    catch (InvalidOperationException)
    {
        deniedResponse = true;
    }
    Require(deniedResponse, "Manager must not attempt unauthenticated approval");

    var deniedPreview = false;
    try
    {
        _ = client.GetPendingApprovalAsync().GetAwaiter().GetResult();
    }
    catch (InvalidOperationException)
    {
        deniedPreview = true;
    }
    Require(deniedPreview, "Manager must not request private approvals without a key");
});

Run("Manager sends per-launch secret for an authorized approval over Windows named pipe", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var pipeName = "PcAgent-Auth-Test-" + Guid.NewGuid().ToString("N");
    var secret = new string('c', 64);
    using var server = new NamedPipeServerStream(
        pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous);

    var serverTask = Task.Run(async () =>
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await server.WaitForConnectionAsync(timeout.Token);

        using var reader = new StreamReader(
            server, new UTF8Encoding(false), false, 4096, leaveOpen: true);
        using var writer = new StreamWriter(
            server, new UTF8Encoding(false), 4096, leaveOpen: true)
        {
            AutoFlush = true
        };

        var line = await reader.ReadLineAsync(timeout.Token)
            ?? throw new InvalidDataException("Missing IPC request");
        using var parsed = JsonDocument.Parse(line);
        var message = parsed.RootElement;
        Equal("respond_approval",
            message.GetProperty("method").GetString(), "authenticated IPC method");
        var parameters = message.GetProperty("params");
        Equal(secret, parameters.GetProperty("auth_token").GetString(),
            "authorization key must be sent to Agent");
        Equal("op-private", parameters.GetProperty("operation_id").GetString(),
            "operation ID must be bound to local user confirmation");
        Equal("approved", parameters.GetProperty("decision").GetString(),
            "decision must match local approval");
        Equal(new string('f', 32),
            parameters.GetProperty("approval_nonce").GetString(),
            "response must bind to the exact local dialog instance");

        await writer.WriteLineAsync(JsonSerializer.Serialize(new
        {
            id = message.GetProperty("id").GetString(),
            ok = true,
            result = new { accepted = true }
        }));
    });

    var client = new NamedPipeAgentClient(pipeName, secret);
    var result = client.RespondApprovalAsync(
        "op-private", "approved", new string('f', 32))
        .GetAwaiter().GetResult();
    Require(result.Accepted, "authenticated local approval reply must be accepted");
    serverTask.GetAwaiter().GetResult();
});


Run("Isolated native move workflow executes only a confirmed and reserved operation", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentMoveFlowTests", Guid.NewGuid().ToString("N"));
    var allowed = Path.Combine(root, "allowed");
    var journal = Path.Combine(root, "replay");
    Directory.CreateDirectory(allowed);

    try
    {
        var source = Path.Combine(allowed, "source.txt");
        var destination = Path.Combine(allowed, "destination.txt");
        File.WriteAllText(source, "approved exact content");

        using var signer = new LocalMoveApprovalTicketPrototype(
            Enumerable.Repeat((byte)0x61, 32).ToArray(),
            new DurableMoveApprovalReplayStorePrototype(journal));
        var workflow = new LocalApprovedNativeMoveWorkflowPrototype(signer);
        var now = DateTimeOffset.Parse("2026-10-08T02:00:00Z");
        var proposal = workflow.ProposeForTest(
            "cmd-flow", "device-flow", "op-flow",
            source, destination, allowed);

        var refused = false;
        try
        {
            _ = workflow.ConfirmForTest(proposal, false, now);
        }
        catch (InvalidOperationException)
        {
            refused = true;
        }

        Require(refused, "denied local confirmation must never mint a ticket");
        Require(!File.Exists(destination), "a denied request changes nothing");
        Equal(0, Directory.EnumerateFiles(journal, "*.used").Count(),
            "denial consumes no durable reservation");

        var approved = workflow.ConfirmForTest(proposal, true, now);
        workflow.ExecuteForTest(approved, now.AddSeconds(1));

        Require(!File.Exists(source), "approved source moved");
        Equal("approved exact content", File.ReadAllText(destination), "approved bytes survive");
        Equal(1, Directory.EnumerateFiles(journal, "*.used").Count(),
            "approved operation was durably reserved before moving");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Isolated native move workflow rejects tampered ticket before any mutation", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentMoveFlowTests", Guid.NewGuid().ToString("N"));
    var allowed = Path.Combine(root, "allowed");
    var journal = Path.Combine(root, "replay");
    Directory.CreateDirectory(allowed);

    try
    {
        var source = Path.Combine(allowed, "source.txt");
        var destination = Path.Combine(allowed, "destination.txt");
        File.WriteAllText(source, "protected");

        using var signer = new LocalMoveApprovalTicketPrototype(
            Enumerable.Repeat((byte)0x62, 32).ToArray(),
            new DurableMoveApprovalReplayStorePrototype(journal));
        var workflow = new LocalApprovedNativeMoveWorkflowPrototype(signer);
        var now = DateTimeOffset.Parse("2026-10-08T02:00:00Z");
        var proposal = workflow.ProposeForTest(
            "cmd-tamper", "device-tamper", "op-tamper",
            source, destination, allowed);
        var original = workflow.ConfirmForTest(proposal, true, now);

        var changedPayload = (byte[])original.Ticket.PayloadUtf8.Clone();
        changedPayload[changedPayload.Length - 5] ^= 0x01;
        var modified = original with
        {
            Ticket = new LocalMoveApprovalTicketPrototype.SignedTicket(
                changedPayload, original.Ticket.HmacSha256)
        };

        var denied = false;
        try
        {
            workflow.ExecuteForTest(modified, now.AddSeconds(1));
        }
        catch (InvalidOperationException)
        {
            denied = true;
        }

        Require(denied, "tampered signature must fail");
        Equal("protected", File.ReadAllText(source), "source remains unchanged");
        Require(!File.Exists(destination), "no mutation occurred");
        Equal(0, Directory.EnumerateFiles(journal, "*.used").Count(),
            "invalid HMAC must not reserve an operation");

        workflow.ExecuteForTest(original, now.AddSeconds(2));
        Equal("protected", File.ReadAllText(destination),
            "legitimate unaltered ticket still works");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Isolated native move workflow never retries failed rename after replay reservation", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentMoveFlowTests", Guid.NewGuid().ToString("N"));
    var allowed = Path.Combine(root, "allowed");
    var journal = Path.Combine(root, "replay");
    Directory.CreateDirectory(allowed);

    try
    {
        var source = Path.Combine(allowed, "source.txt");
        var destination = Path.Combine(allowed, "destination.txt");
        File.WriteAllText(source, "protected source");
        File.WriteAllText(destination, "competing target");

        var now = DateTimeOffset.Parse("2026-10-08T02:00:00Z");
        var key = Enumerable.Repeat((byte)0x63, 32).ToArray();

        using (var signer = new LocalMoveApprovalTicketPrototype(
            key, new DurableMoveApprovalReplayStorePrototype(journal)))
        {
            var workflow = new LocalApprovedNativeMoveWorkflowPrototype(signer);
            var proposal = workflow.ProposeForTest(
                "cmd-failure", "device-failure", "op-failure",
                source, destination, allowed);
            var confirmed = workflow.ConfirmForTest(proposal, true, now);

            var failed = false;
            try
            {
                workflow.ExecuteForTest(confirmed, now.AddSeconds(1));
            }
            catch (System.ComponentModel.Win32Exception error)
            {
                failed = error.NativeErrorCode is 80 or 183;
                if (!failed) throw;
            }
            Require(failed, "native no-replace must reject existing destination");
            Equal("protected source", File.ReadAllText(source),
                "existing destination failure preserves source");
            Equal("competing target", File.ReadAllText(destination),
                "existing destination is never overwritten");
        }

        // A newly started Manager instance and newly signed ticket for
        // the SAME operation must not trigger a retry.
        using (var restartedSigner = new LocalMoveApprovalTicketPrototype(
            key, new DurableMoveApprovalReplayStorePrototype(journal)))
        {
            var restarted = new LocalApprovedNativeMoveWorkflowPrototype(restartedSigner);
            var repeatedProposal = restarted.ProposeForTest(
                "cmd-failure", "device-failure", "op-failure",
                source, destination, allowed);
            var repeatedTicket = restarted.ConfirmForTest(
                repeatedProposal, true, now.AddSeconds(3));
            var replayDenied = false;
            try
            {
                restarted.ExecuteForTest(repeatedTicket, now.AddSeconds(4));
            }
            catch (InvalidOperationException)
            {
                replayDenied = true;
            }
            Require(replayDenied, "reserved uncertain outcome cannot be repeated after restart");
        }

        Equal(1, Directory.EnumerateFiles(journal, "*.used").Count(),
            "no additional use marker was created");
        Equal("competing target", File.ReadAllText(destination),
            "competitor remains intact across denied retry");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Isolated native move workflow rejects source change after local confirmation", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentMoveFlowTests", Guid.NewGuid().ToString("N"));
    var allowed = Path.Combine(root, "allowed");
    var journal = Path.Combine(root, "replay");
    Directory.CreateDirectory(allowed);

    try
    {
        var source = Path.Combine(allowed, "source.txt");
        var destination = Path.Combine(allowed, "destination.txt");
        File.WriteAllText(source, "approved bytes");

        using var signer = new LocalMoveApprovalTicketPrototype(
            Enumerable.Repeat((byte)0x64, 32).ToArray(),
            new DurableMoveApprovalReplayStorePrototype(journal));
        var workflow = new LocalApprovedNativeMoveWorkflowPrototype(signer);
        var now = DateTimeOffset.Parse("2026-10-08T02:00:00Z");
        var proposal = workflow.ProposeForTest(
            "cmd-change", "device-change", "op-change",
            source, destination, allowed);
        var confirmed = workflow.ConfirmForTest(proposal, true, now);

        File.WriteAllText(source, "modified bytes");

        var denied = false;
        try
        {
            workflow.ExecuteForTest(confirmed, now.AddSeconds(1));
        }
        catch (InvalidOperationException)
        {
            denied = true;
        }

        Require(denied, "source content changed after approval must be rejected");
        Equal("modified bytes", File.ReadAllText(source), "no unexpected source mutation");
        Require(!File.Exists(destination), "unapproved content was not moved");
        Equal(1, Directory.EnumerateFiles(journal, "*.used").Count(),
            "a consumed approval is never reused even when native validation rejects it");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Isolated native move workflow rejects expired authorization without reservation", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentMoveFlowTests", Guid.NewGuid().ToString("N"));
    var allowed = Path.Combine(root, "allowed");
    var journal = Path.Combine(root, "replay");
    Directory.CreateDirectory(allowed);

    try
    {
        var source = Path.Combine(allowed, "source.txt");
        var destination = Path.Combine(allowed, "destination.txt");
        File.WriteAllText(source, "do not move");

        using var signer = new LocalMoveApprovalTicketPrototype(
            Enumerable.Repeat((byte)0x65, 32).ToArray(),
            new DurableMoveApprovalReplayStorePrototype(journal));
        var workflow = new LocalApprovedNativeMoveWorkflowPrototype(signer);
        var now = DateTimeOffset.Parse("2026-10-08T02:00:00Z");
        var proposal = workflow.ProposeForTest(
            "cmd-expired", "device-expired", "op-expired",
            source, destination, allowed);
        var confirmed = workflow.ConfirmForTest(proposal, true, now);

        var expired = false;
        try
        {
            workflow.ExecuteForTest(confirmed, now.AddMinutes(3));
        }
        catch (InvalidOperationException)
        {
            expired = true;
        }
        Require(expired, "expired ticket must fail before a filesystem operation");
        Equal(0, Directory.EnumerateFiles(journal, "*.used").Count(),
            "expired ticket did not reserve the operation");
        Equal("do not move", File.ReadAllText(source), "source remains");
        Require(!File.Exists(destination), "destination never created");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});


Run("Crash after durable approval reservation blocks move replay after restart", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var root = Path.Combine(Path.GetTempPath(), "PcAgentMoveFlowTests", Guid.NewGuid().ToString("N"));
    var allowed = Path.Combine(root, "allowed");
    var journal = Path.Combine(root, "replay");
    Directory.CreateDirectory(allowed);

    try
    {
        var source = Path.Combine(allowed, "source.txt");
        var destination = Path.Combine(allowed, "target.txt");
        File.WriteAllText(source, "must not move on retry");
        var key = Enumerable.Repeat((byte)0x66, 32).ToArray();
        var now = DateTimeOffset.Parse("2026-10-08T02:00:00Z");
        var crashed = false;

        using (var signer = new LocalMoveApprovalTicketPrototype(
            key, new DurableMoveApprovalReplayStorePrototype(journal)))
        {
            var workflow = new LocalApprovedNativeMoveWorkflowPrototype(signer);
            var proposal = workflow.ProposeForTest(
                "cmd-crash", "device-crash", "op-crash",
                source, destination, allowed);
            var confirmed = workflow.ConfirmForTest(proposal, true, now);

            try
            {
                workflow.ExecuteForTest(
                    confirmed, now.AddSeconds(1),
                    afterTicketConsumedBeforeMoveForTest: () =>
                        throw new IOException("Simulated process termination at commit barrier"));
            }
            catch (IOException)
            {
                crashed = true;
            }
        }

        Require(crashed, "test must interrupt execution after durable reservation");
        Equal(1, Directory.EnumerateFiles(journal, "*.used").Count(),
            "crash leaves a durable operation marker");
        Equal("must not move on retry", File.ReadAllText(source),
            "no native move occurred after simulated interruption");

        using (var restartedSigner = new LocalMoveApprovalTicketPrototype(
            key, new DurableMoveApprovalReplayStorePrototype(journal)))
        {
            var restarted = new LocalApprovedNativeMoveWorkflowPrototype(restartedSigner);
            var proposal = restarted.ProposeForTest(
                "cmd-crash", "device-crash", "op-crash",
                source, destination, allowed);
            var ticket = restarted.ConfirmForTest(
                proposal, true, now.AddSeconds(2));

            var denied = false;
            try
            {
                restarted.ExecuteForTest(ticket, now.AddSeconds(3));
            }
            catch (InvalidOperationException)
            {
                denied = true;
            }
            Require(denied, "restarted Manager must reject an uncertain operation");
        }

        Require(!File.Exists(destination), "replay never creates destination");
        Equal(1, Directory.EnumerateFiles(journal, "*.used").Count(),
            "no second durable reservation");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});


Run("Manager creates unique unpredictable private Agent pipe names", () =>
{
    var prefix = AgentSupervisor.BuildPipeName();
    var first = AgentSupervisor.BuildPrivatePipeName();
    var second = AgentSupervisor.BuildPrivatePipeName();

    Require(first.StartsWith(prefix + "-", StringComparison.Ordinal),
        "private pipe must retain the local user scoped prefix");
    Require(second.StartsWith(prefix + "-", StringComparison.Ordinal),
        "second pipe must retain the user prefix");
    Require(!string.Equals(first, second, StringComparison.Ordinal),
        "each new Manager instance must have an independent pipe name");
    Require(first.Length == prefix.Length + 33,
        "private pipe suffix must contain 128 bits of randomness in hex");
    Require(first[(prefix.Length + 1)..].All(Uri.IsHexDigit),
        "private suffix must be a hex nonce");
    Require(!first.Contains('\\'), "pipe name must contain no path separators");
});


Run("Manager rejects an IPC reply with a different request ID", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var pipeName = "PcAgent-MismatchedReply-" + Guid.NewGuid().ToString("N");
    using var server = new NamedPipeServerStream(
        pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous);

    var serverTask = Task.Run(async () =>
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await server.WaitForConnectionAsync(timeout.Token);
        using var reader = new StreamReader(
            server, new UTF8Encoding(false), false, 4096, leaveOpen: true);
        using var writer = new StreamWriter(
            server, new UTF8Encoding(false), 4096, leaveOpen: true)
        {
            AutoFlush = true
        };

        _ = await reader.ReadLineAsync(timeout.Token);
        await writer.WriteLineAsync(
            "{\"id\":\"forged-reply-id\",\"ok\":true,\"result\":{\"version\":\"forged\"}}");
    });

    var rejected = false;
    try
    {
        _ = new NamedPipeAgentClient(pipeName).GetHealthAsync()
            .GetAwaiter().GetResult();
    }
    catch (InvalidDataException)
    {
        rejected = true;
    }

    serverTask.GetAwaiter().GetResult();
    Require(rejected, "a mismatched reply ID must not be trusted");
});

Run("Manager rejects oversized local IPC replies before parsing JSON", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var pipeName = "PcAgent-OversizedReply-" + Guid.NewGuid().ToString("N");
    using var server = new NamedPipeServerStream(
        pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous);

    var serverTask = Task.Run(async () =>
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await server.WaitForConnectionAsync(timeout.Token);
        using var reader = new StreamReader(
            server, new UTF8Encoding(false), false, 4096, leaveOpen: true);
        using var writer = new StreamWriter(
            server, new UTF8Encoding(false), 4096, leaveOpen: true)
        {
            AutoFlush = true
        };

        var frame = await reader.ReadLineAsync(timeout.Token)
            ?? throw new InvalidDataException("Missing Manager request");
        using var parsed = JsonDocument.Parse(frame);
        var id = parsed.RootElement.GetProperty("id").GetString();
        var oversized = JsonSerializer.Serialize(new
        {
            id,
            ok = true,
            result = new
            {
                version = new string('x', 20_000),
                protocol_version = 1
            }
        });
        await writer.WriteLineAsync(oversized);
    });

    var rejected = false;
    try
    {
        _ = new NamedPipeAgentClient(pipeName).GetHealthAsync()
            .GetAwaiter().GetResult();
    }
    catch (InvalidDataException)
    {
        rejected = true;
    }

    serverTask.GetAwaiter().GetResult();
    Require(rejected, "a large IPC reply must be refused before deserialization");
});


Run("Windows owner-only pipe creates a protected on-handle DACL without broad grants", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var name = "PcAgentAclTest-" + Guid.NewGuid().ToString("N");
    using var server = OwnerOnlyNamedPipePrototype.CreateForCurrentUser(name);
    var userSid = System.Security.Principal.WindowsIdentity.GetCurrent().User
        ?? throw new InvalidOperationException("Missing Windows user SID");

    // Verify the kernel object's actual descriptor, not merely the intended
    // in-memory PipeSecurity that was passed into the factory.
    OwnerOnlyNamedPipePrototype.VerifyActualDacl(server, userSid);

    var actual = server.GetAccessControl();
    var accessRules = actual.GetAccessRules(
        includeExplicit: true,
        includeInherited: true,
        targetType: typeof(System.Security.Principal.SecurityIdentifier));

    Equal(1, accessRules.Count, "owner-only pipe must have one allow rule");
    Require(actual.AreAccessRulesProtected,
        "the actual native pipe DACL must not inherit ACL entries");
    var only = accessRules[0] as System.IO.Pipes.PipeAccessRule
        ?? throw new InvalidOperationException("Expected a pipe access rule");
    Equal(userSid.Value, only.IdentityReference.Value,
        "owner must be the only Windows user granted access");
    Equal(System.Security.AccessControl.AccessControlType.Allow,
        only.AccessControlType, "only owner allow rule must be present");

    foreach (var forbidden in new[]
    {
        System.Security.Principal.WellKnownSidType.WorldSid,
        System.Security.Principal.WellKnownSidType.AnonymousSid,
        System.Security.Principal.WellKnownSidType.BuiltinUsersSid
    })
    {
        var forbiddenSid = new System.Security.Principal.SecurityIdentifier(
            forbidden, null);
        Require(!string.Equals(only.IdentityReference.Value, forbiddenSid.Value,
                StringComparison.Ordinal),
            "a broad Windows group cannot be the granted principal");
    }
});

Run("Windows owner-only pipe permits same-user round-trip and refuses invalid names", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var name = "PcAgentAclTest-" + Guid.NewGuid().ToString("N");
    using var server = OwnerOnlyNamedPipePrototype.CreateForCurrentUser(name);
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));

    var listener = Task.Run(async () =>
    {
        await server.WaitForConnectionAsync(timeout.Token);
        var request = new byte[4];
        await server.ReadExactlyAsync(request, timeout.Token);
        Equal("PING", Encoding.ASCII.GetString(request),
            "local same-user request arrives over protected Windows pipe");
        await server.WriteAsync(Encoding.ASCII.GetBytes("PONG"), timeout.Token);
        await server.FlushAsync(timeout.Token);
    });

    using var client = new NamedPipeClientStream(
        ".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
    client.Connect(2000);
    client.Write(Encoding.ASCII.GetBytes("PING"));
    client.Flush();
    var reply = new byte[4];
    client.ReadExactly(reply);
    Equal("PONG", Encoding.ASCII.GetString(reply), "same-user reply is received");
    listener.GetAwaiter().GetResult();

    var invalidRejected = false;
    try
    {
        using var ignored = OwnerOnlyNamedPipePrototype.CreateForCurrentUser(
            @"PcAgentAclTest-..\\other-user");
    }
    catch (ArgumentException)
    {
        invalidRejected = true;
    }
    Require(invalidRejected, "proof-of-concept cannot bind arbitrary pipe names");
});

Run("Windows ACL pipe factory fails closed if another process already owns the name", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var name = "PcAgentAclTest-" + Guid.NewGuid().ToString("N");
    using var squat = new NamedPipeServerStream(
        name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous);

    var denied = false;
    try
    {
        using var unexpected = OwnerOnlyNamedPipePrototype.CreateForCurrentUser(name);
    }
    catch (Exception error) when (error is IOException
        or UnauthorizedAccessException)
    {
        denied = true;
    }

    Require(denied, "preexisting pipe instance must never be reused as trusted ACL listener");
});


Run("Windows ACL pipe rejects a genuinely different local user by kernel access check", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var otherName = Environment.GetEnvironmentVariable("PC_AGENT_TEST_ALT_USER");
    var otherPassword = Environment.GetEnvironmentVariable("PC_AGENT_TEST_ALT_PASSWORD");
    var mustRun = Environment.GetEnvironmentVariable("PC_AGENT_REQUIRE_ALT_USER_TEST")
        == "1";

    if (string.IsNullOrWhiteSpace(otherName)
        || string.IsNullOrWhiteSpace(otherPassword))
    {
        if (mustRun)
        {
            throw new InvalidOperationException(
                "Required cross-user ACL test credentials were not provisioned.");
        }

        Console.WriteLine("SKIP cross-user ACL attempt: test account not provisioned");
        return;
    }

    var pipeName = "PcAgentAclTest-" + Guid.NewGuid().ToString("N");
    using var server = OwnerOnlyNamedPipePrototype.CreateForCurrentUser(pipeName);
    var owner = System.Security.Principal.WindowsIdentity.GetCurrent().User
        ?? throw new InvalidOperationException("Missing current Windows SID");

    // Unlike DACL inspection alone, this opens the actual kernel named pipe
    // while impersonating a separate local Windows logon token.
    WindowsCrossUserPipeProbe.AssertDifferentLocalUserDenied(
        pipeName, owner, otherName, otherPassword);
    OwnerOnlyNamedPipePrototype.VerifyActualDacl(server, owner);

    // Negative attempt must not break access for the real authorized owner.
    using var authorizedClient = new NamedPipeClientStream(
        ".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
    authorizedClient.Connect(2000);
    Require(authorizedClient.IsConnected, "owner still connects after denial");
});


Run("Manager protected status pipe accepts only versioned read-only PING", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    static string Query(string name, string query)
    {
        using var client = new NamedPipeClientStream(
            ".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
        client.Connect(2000);

        var message = Encoding.ASCII.GetBytes(query + "\n");
        client.Write(message);
        client.Flush();

        using var reader = new StreamReader(
            client, Encoding.ASCII, false, 1024, leaveOpen: true);
        return reader.ReadLineAsync()
            .WaitAsync(TimeSpan.FromSeconds(3))
            .GetAwaiter().GetResult()
            ?? throw new InvalidDataException("Protected Manager endpoint closed without reply");
    }

    var first = ManagerProtectedPipeHost.Start();
    try
    {
        Require(first.PipeName.StartsWith("PcAgentMgrSafe-", StringComparison.Ordinal),
            "Manager owner-only endpoint must use a dedicated prefix");
        Equal("PONG 1", Query(first.PipeName, "PING 1"), "valid status handshake");
        Equal("DENIED", Query(first.PipeName, "PING 0"), "wrong version must be denied");
        Equal("DENIED", Query(first.PipeName, "move_path"), "filesystem commands must be denied");
        Equal("DENIED", Query(first.PipeName, "approve"), "approvals cannot be issued by status endpoint");
        Equal("DENIED", Query(first.PipeName, new string('Z', 40)),
            "oversized requests must fail closed");
        Equal("PONG 1", Query(first.PipeName, "PING 1"),
            "the original protected pipe must remain usable after denied requests");

        var owner = System.Security.Principal.WindowsIdentity.GetCurrent().User
            ?? throw new InvalidOperationException("Missing Windows SID");
        using var inspector = new NamedPipeClientStream(
            ".", first.PipeName, PipeDirection.InOut);
        inspector.Connect(2000);
        Require(inspector.IsConnected,
            "same user must still access protected Manager listener");
    }
    finally
    {
        first.DisposeAsync().AsTask().GetAwaiter().GetResult();
    }

    using var cancelled = new NamedPipeClientStream(
        ".", first.PipeName, PipeDirection.InOut);
    var connectDenied = false;
    try
    {
        cancelled.Connect(100);
    }
    catch (Exception exception) when (exception is TimeoutException
        or IOException or UnauthorizedAccessException)
    {
        connectDenied = true;
    }
    Require(connectDenied, "disposing Manager endpoint must close its pipe");
});

Run("Manager protected status pipe has a fresh name per instance and no mutation RPC", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var first = ManagerProtectedPipeHost.Start();
    var second = ManagerProtectedPipeHost.Start();

    try
    {
        Require(!string.Equals(first.PipeName, second.PipeName, StringComparison.Ordinal),
            "two Manager-owned pipes must use different random names");
        Equal(32, first.PipeName["PcAgentMgrSafe-".Length..].Length,
            "new pipe name has 128-bit random suffix");
        Require(first.PipeName["PcAgentMgrSafe-".Length..].All(Uri.IsHexDigit),
            "name suffix must be hex");
    }
    finally
    {
        second.DisposeAsync().AsTask().GetAwaiter().GetResult();
        first.DisposeAsync().AsTask().GetAwaiter().GetResult();
    }
});

Run("Manager protected pipe denies a genuine different Windows account", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var alternateUser = Environment.GetEnvironmentVariable("PC_AGENT_TEST_ALT_USER");
    var password = Environment.GetEnvironmentVariable("PC_AGENT_TEST_ALT_PASSWORD");
    var required = Environment.GetEnvironmentVariable("PC_AGENT_REQUIRE_ALT_USER_TEST") == "1";

    if (string.IsNullOrWhiteSpace(alternateUser)
        || string.IsNullOrWhiteSpace(password))
    {
        if (required)
        {
            throw new InvalidOperationException(
                "Cross-user ACL probe is mandatory, but no alternate account is available.");
        }

        Console.WriteLine("SKIP Manager status cross-user ACL probe: no separate Windows account");
        return;
    }

    var host = ManagerProtectedPipeHost.Start();
    try
    {
        var owner = System.Security.Principal.WindowsIdentity.GetCurrent().User
            ?? throw new InvalidOperationException("Missing Windows SID");
        // This is the ACTUAL Manager-owned listener, not the older test fixture.
        WindowsCrossUserPipeProbe.AssertDifferentLocalUserDenied(
            host.PipeName, owner, alternateUser, password);
    }
    finally
    {
        host.DisposeAsync().AsTask().GetAwaiter().GetResult();
    }
});


Run("Windows owner-only durable replay directory protects markers and denies replay after restart", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var name = "PcAgentReplayAclTest-" + Guid.NewGuid().ToString("N");
    var root = OwnerOnlyReplayDirectoryPrototype.CreateNewTestDirectory(
        Path.GetTempPath(), name);
    try
    {
        var owner = System.Security.Principal.WindowsIdentity.GetCurrent().User
            ?? throw new InvalidOperationException("Missing Windows SID");
        OwnerOnlyReplayDirectoryPrototype.VerifyActualDirectoryAcl(root, owner);

        var first = new DurableMoveApprovalReplayStorePrototype(
            root, requireOwnerOnlyDirectoryForTest: true);
        first.Reserve("approved-operation-1");

        var marker = Directory.GetFiles(root, "*.used").Single();
        var acl = new FileInfo(marker).GetAccessControl(
            System.Security.AccessControl.AccessControlSections.Access);
        var rules = acl.GetAccessRules(
            includeExplicit: true,
            includeInherited: true,
            targetType: typeof(System.Security.Principal.SecurityIdentifier));
        Require(rules.Count > 0, "persisted marker must have an ACL");
        foreach (System.Security.AccessControl.FileSystemAccessRule rule in rules)
        {
            Require(rule.IdentityReference.Value == owner.Value,
                "marker must not inherit permissions granted to other users");
            Require(rule.AccessControlType ==
                System.Security.AccessControl.AccessControlType.Allow,
                "marker ACL must contain owner-only allow rules");
        }

        var reopened = new DurableMoveApprovalReplayStorePrototype(
            root, requireOwnerOnlyDirectoryForTest: true);
        var refused = false;
        try
        {
            reopened.Reserve("approved-operation-1");
        }
        catch (InvalidOperationException)
        {
            refused = true;
        }
        Require(refused, "a restarted Manager cannot reserve an already-used operation");
        reopened.Reserve("approved-operation-2");
        Equal(2, Directory.GetFiles(root, "*.used").Length,
            "different operations get their own non-overwritten marker");
        OwnerOnlyReplayDirectoryPrototype.VerifyActualDirectoryAcl(root, owner);
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Native replay ACL directory factory refuses preexisting and malformed names", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var name = "PcAgentReplayAclTest-" + Guid.NewGuid().ToString("N");
    var root = OwnerOnlyReplayDirectoryPrototype.CreateNewTestDirectory(
        Path.GetTempPath(), name);
    try
    {
        var duplicateRejected = false;
        try
        {
            _ = OwnerOnlyReplayDirectoryPrototype.CreateNewTestDirectory(
                Path.GetTempPath(), name);
        }
        catch (System.ComponentModel.Win32Exception ex) when
            (ex.NativeErrorCode == 183)
        {
            duplicateRejected = true;
        }
        Require(duplicateRejected,
            "a preexisting journal directory must never be silently reused");

        var invalidRejected = false;
        try
        {
            _ = OwnerOnlyReplayDirectoryPrototype.CreateNewTestDirectory(
                Path.GetTempPath(), "PcAgentReplayAclTest-..\\untrusted");
        }
        catch (ArgumentException)
        {
            invalidRejected = true;
        }
        Require(invalidRejected,
            "replay ACL factory refuses arbitrary paths or traversal names");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});

Run("Protected replay store refuses a missing directory rather than creating it insecurely", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var path = Path.Combine(
        Path.GetTempPath(), "PcAgentReplayAclTest-" + Guid.NewGuid().ToString("N"));
    Require(!Directory.Exists(path), "fixture path must not already exist");

    var refused = false;
    try
    {
        _ = new DurableMoveApprovalReplayStorePrototype(
            path, requireOwnerOnlyDirectoryForTest: true);
    }
    catch (InvalidOperationException)
    {
        refused = true;
    }

    Require(refused, "strict store must fail closed until a secured directory exists");
    Require(!Directory.Exists(path),
        "strict store must not create a directory with the parent's default ACL");
});

Run("Real different Windows user cannot inject a durable replay marker", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var alternateUser = Environment.GetEnvironmentVariable("PC_AGENT_TEST_ALT_USER");
    var alternatePassword = Environment.GetEnvironmentVariable("PC_AGENT_TEST_ALT_PASSWORD");
    var required = Environment.GetEnvironmentVariable("PC_AGENT_REQUIRE_ALT_USER_TEST") == "1";

    if (string.IsNullOrWhiteSpace(alternateUser)
        || string.IsNullOrWhiteSpace(alternatePassword))
    {
        if (required)
        {
            throw new InvalidOperationException(
                "Mandatory Windows replay ACL cross-user credentials were not provisioned.");
        }

        Console.WriteLine("SKIP replay directory cross-user test: no alternate account");
        return;
    }

    var name = "PcAgentReplayAclTest-" + Guid.NewGuid().ToString("N");
    var root = OwnerOnlyReplayDirectoryPrototype.CreateNewTestDirectory(
        Path.GetTempPath(), name);
    try
    {
        var owner = System.Security.Principal.WindowsIdentity.GetCurrent().User
            ?? throw new InvalidOperationException("Windows owner SID unavailable");
        var store = new DurableMoveApprovalReplayStorePrototype(
            root, requireOwnerOnlyDirectoryForTest: true);
        store.Reserve("authorized-owner-operation");

        WindowsCrossUserPipeProbe.AssertDifferentLocalUserCannotCreateReplayMarker(
            root, owner, alternateUser, alternatePassword);

        Require(!File.Exists(Path.Combine(root, "cross-user-injection.used")),
            "other Windows user did not inject a fake approval marker");
        OwnerOnlyReplayDirectoryPrototype.VerifyActualDirectoryAcl(root, owner);

        // Rejected outsiders must not prevent the authorized owner from
        // using the journal or reenable already-reserved operations.
        store.Reserve("next-authorized-operation");
        Equal(2, Directory.GetFiles(root, "*.used").Length,
            "owner retains valid journal access after attack attempt");
    }
    finally
    {
        Directory.Delete(root, recursive: true);
    }
});


Run("Local move dialog consent binds displayed details to a single native move", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var basePath = Path.Combine(
        Path.GetTempPath(), "PcAgentLocalDialogTests", Guid.NewGuid().ToString("N"));
    var allowed = Path.Combine(basePath, "allowed");
    Directory.CreateDirectory(allowed);
    try
    {
        var journal = OwnerOnlyReplayDirectoryPrototype.CreateNewTestDirectory(
            basePath, "PcAgentReplayAclTest-" + Guid.NewGuid().ToString("N"));
        var source = Path.Combine(allowed, "source.txt");
        var destination = Path.Combine(allowed, "destination.txt");
        File.WriteAllText(source, "must move once only");
        var now = DateTimeOffset.Parse("2026-10-08T07:00:00Z");

        using var signer = new LocalMoveApprovalTicketPrototype(
            System.Security.Cryptography.RandomNumberGenerator.GetBytes(32),
            new DurableMoveApprovalReplayStorePrototype(
                journal, requireOwnerOnlyDirectoryForTest: true));
        var workflow = new LocalApprovedNativeMoveWorkflowPrototype(signer);
        var gate = new LocalMoveDialogConsentPrototype(workflow);
        var proposal = workflow.ProposeForTest(
            "cmd-dialog-one", "device-dialog", "op-dialog-one",
            source, destination, allowed);
        var displayed = gate.OpenForTest(proposal, now);

        Equal("op-dialog-one", displayed.OperationId, "displayed operation identity");
        Equal(proposal.Request.SourcePath, displayed.SourcePath, "displayed source");
        Equal(proposal.Request.DestinationPath, displayed.DestinationPath, "displayed destination");
        Equal(proposal.Request.SourceSha256, displayed.SourceSha256, "displayed source fingerprint");
        Equal(32, displayed.ChallengeNonce.Length, "unique 128-bit dialog nonce");
        Require(!File.Exists(destination), "displaying a dialog must not mutate any file");
        Equal(0, Directory.GetFiles(journal, "*.used").Length,
            "displaying a dialog must not consume an operation");

        var confirmed = gate.ResolveLocalDialogForTest(
            displayed, DialogResult.Yes, now.AddSeconds(1));
        workflow.ExecuteForTest(confirmed, now.AddSeconds(2));

        Require(!File.Exists(source), "the locally confirmed source was moved");
        Equal("must move once only", File.ReadAllText(destination),
            "the exact approved bytes were preserved");
        Equal(1, Directory.GetFiles(journal, "*.used").Length,
            "a one-use operation was reserved before the native move");

        var replayDenied = false;
        try
        {
            _ = gate.ResolveLocalDialogForTest(
                displayed, DialogResult.Yes, now.AddSeconds(3));
        }
        catch (InvalidOperationException)
        {
            replayDenied = true;
        }
        Require(replayDenied, "the same local dialog cannot approve twice");

        var executionReplayDenied = false;
        try
        {
            workflow.ExecuteForTest(confirmed, now.AddSeconds(4));
        }
        catch (InvalidOperationException)
        {
            executionReplayDenied = true;
        }
        Require(executionReplayDenied,
            "the same signed and durably reserved native move cannot execute twice");
    }
    finally
    {
        Directory.Delete(basePath, recursive: true);
    }
});

Run("Local move dialog refusal, closing and copied challenges never grant permission", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var basePath = Path.Combine(
        Path.GetTempPath(), "PcAgentLocalDialogTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(basePath);
    try
    {
        var source = Path.Combine(basePath, "source.txt");
        var destination = Path.Combine(basePath, "destination.txt");
        File.WriteAllText(source, "unchanged");
        var now = DateTimeOffset.Parse("2026-10-08T07:00:00Z");

        using var signer = new LocalMoveApprovalTicketPrototype(
            System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        var workflow = new LocalApprovedNativeMoveWorkflowPrototype(signer);
        var gate = new LocalMoveDialogConsentPrototype(workflow);
        var proposal = workflow.ProposeForTest(
            "cmd-dialog-refuse", "device-dialog", "op-dialog-refuse",
            source, destination, basePath);

        var first = gate.OpenForTest(proposal, now);
        var copiedChallengeRejected = false;
        try
        {
            _ = gate.ResolveLocalDialogForTest(
                first with { }, DialogResult.Yes, now.AddSeconds(1));
        }
        catch (InvalidOperationException)
        {
            copiedChallengeRejected = true;
        }
        Require(copiedChallengeRejected,
            "a newly constructed challenge with identical values has no local UI capability");

        var denied = false;
        try
        {
            _ = gate.ResolveLocalDialogForTest(
                first, DialogResult.No, now.AddSeconds(2));
        }
        catch (InvalidOperationException)
        {
            denied = true;
        }
        Require(denied, "local denial must not mint any signed ticket");

        var second = gate.OpenForTest(proposal, now.AddSeconds(3));
        Require(first.ChallengeNonce != second.ChallengeNonce,
            "new dialog even for same operation must generate fresh randomness");

        var staleRejected = false;
        try
        {
            _ = gate.ResolveLocalDialogForTest(
                first, DialogResult.Yes, now.AddSeconds(4));
        }
        catch (InvalidOperationException)
        {
            staleRejected = true;
        }
        Require(staleRejected, "previous dialog must not approve a later instance");

        var closed = false;
        try
        {
            _ = gate.ResolveLocalDialogForTest(
                second, DialogResult.Cancel, now.AddSeconds(5));
        }
        catch (InvalidOperationException)
        {
            closed = true;
        }
        Require(closed, "closing the dialog must fail closed");

        var third = gate.OpenForTest(proposal, now.AddSeconds(6));
        var implicitOkDenied = false;
        try
        {
            _ = gate.ResolveLocalDialogForTest(
                third, DialogResult.OK, now.AddSeconds(7));
        }
        catch (InvalidOperationException)
        {
            implicitOkDenied = true;
        }
        Require(implicitOkDenied,
            "only a distinct explicit Yes result may be accepted by future real UI code");

        Equal("unchanged", File.ReadAllText(source),
            "denied/stale/copied dialogs must never move the source");
        Require(!File.Exists(destination),
            "no denied or closed confirmation can create the destination");
    }
    finally
    {
        Directory.Delete(basePath, recursive: true);
    }
});

Run("Local move dialog prevents overlapping, expired and time-reversed approvals", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    var basePath = Path.Combine(
        Path.GetTempPath(), "PcAgentLocalDialogTests", Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(basePath);
    try
    {
        var source = Path.Combine(basePath, "source.txt");
        var destination = Path.Combine(basePath, "destination.txt");
        File.WriteAllText(source, "unchanged");
        var now = DateTimeOffset.Parse("2026-10-08T07:00:00Z");

        using var signer = new LocalMoveApprovalTicketPrototype(
            System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        var workflow = new LocalApprovedNativeMoveWorkflowPrototype(signer);
        var gate = new LocalMoveDialogConsentPrototype(workflow);
        var proposal = workflow.ProposeForTest(
            "cmd-dialog-expiry", "device-dialog", "op-dialog-expiry",
            source, destination, basePath);

        var initial = gate.OpenForTest(proposal, now);
        var overlappingDenied = false;
        try
        {
            _ = gate.OpenForTest(proposal, now.AddSeconds(1));
        }
        catch (InvalidOperationException)
        {
            overlappingDenied = true;
        }
        Require(overlappingDenied,
            "a pending approval cannot silently be replaced by a second dialog");

        var expiredDenied = false;
        try
        {
            _ = gate.ResolveLocalDialogForTest(
                initial, DialogResult.Yes, now.AddSeconds(31));
        }
        catch (InvalidOperationException)
        {
            expiredDenied = true;
        }
        Require(expiredDenied, "a user reply after the 30-second expiry is rejected");

        var newInstance = gate.OpenForTest(proposal, now.AddSeconds(32));
        var staleDenied = false;
        try
        {
            _ = gate.ResolveLocalDialogForTest(
                initial, DialogResult.Yes, now.AddSeconds(33));
        }
        catch (InvalidOperationException)
        {
            staleDenied = true;
        }
        Require(staleDenied, "an expired dialog cannot authorize a new instance");

        var reversedDenied = false;
        try
        {
            _ = gate.ResolveLocalDialogForTest(
                newInstance, DialogResult.Yes, now.AddSeconds(30));
        }
        catch (InvalidOperationException)
        {
            reversedDenied = true;
        }
        Require(reversedDenied,
            "clock rollback must not make a dialog valid before it was issued");

        var fresh = gate.OpenForTest(proposal, now.AddSeconds(34));
        var confirmed = gate.ResolveLocalDialogForTest(
            fresh, DialogResult.Yes, now.AddSeconds(35));
        Require(confirmed.Ticket.PayloadUtf8.Length > 0,
            "a fresh single local test decision can issue a signed request");
        Require(!File.Exists(destination),
            "issuing a ticket alone must never execute the native move");
        Equal("unchanged", File.ReadAllText(source),
            "source remains unchanged without the separate execution step");
    }
    finally
    {
        Directory.Delete(basePath, recursive: true);
    }
});


Run("Real Windows move confirmation form renders exact fields and defaults to denial", () =>
{
    if (!OperatingSystem.IsWindows()) return;

    Exception? failure = null;
    var thread = new Thread(() =>
    {
        try
        {
            var issued = DateTimeOffset.UtcNow;
            var challenge = new LocalMoveDialogConsentPrototype.DialogChallenge(
                new string('e', 32),
                "command-ui-preview",
                "device-ui-preview",
                "operation-ui-preview",
                @"D:\\Allowed\\source.txt",
                @"D:\\Allowed\\destination.txt",
                @"D:\\Allowed",
                new string('a', 64),
                issued,
                issued.AddSeconds(30));

            using var form = new LocalMoveConfirmationFormPrototype(challenge);
            Require(!form.IsApprovalEnabledForTest,
                "native file mutation approval must be disabled by default");
            Require(!form.ApprovedByExplicitClick,
                "a newly created confirmation cannot count as an explicit click");
            Require(form.AcceptButton is null,
                "pressing Enter alone must never grant a native move");
            Require(form.CancelButton is not null,
                "Escape must have an explicit denial control");

            // Traverse form contents without opening a window in headless CI.
            static IEnumerable<Control> Visit(Control control)
            {
                foreach (Control child in control.Controls)
                {
                    yield return child;
                    foreach (var nested in Visit(child))
                    {
                        yield return nested;
                    }
                }
            }

            var preview = Visit(form).OfType<TextBox>()
                .Single(box => box.Multiline && box.ReadOnly);
            Require(preview.Text.Contains(challenge.OperationId, StringComparison.Ordinal)
                    && preview.Text.Contains(challenge.SourcePath, StringComparison.Ordinal)
                    && preview.Text.Contains(challenge.DestinationPath, StringComparison.Ordinal)
                    && preview.Text.Contains(challenge.SourceSha256, StringComparison.Ordinal),
                "modal must display the exact operation, paths and source fingerprint");

            var approve = Visit(form).OfType<Button>()
                .Single(button => button.Text == "内容を確認して許可");
            Require(approve.DialogResult == DialogResult.None,
                "setting the native Yes result alone is not permitted");
            var deny = Visit(form).OfType<Button>()
                .Single(button => button.DialogResult == DialogResult.No);
            Require(!approve.Enabled, "Yes must stay disabled before explicit acknowledgement");
            Require(deny.Enabled, "denial is available without acknowledgement");

            form.SetAcknowledgedForTest(true);
            Require(form.IsApprovalEnabledForTest && approve.Enabled,
                "user acknowledgement unlocks the explicit affirmative control");

            form.SetAcknowledgedForTest(false);
            Require(!form.IsApprovalEnabledForTest,
                "unchecking the confirmation must revoke the affirmative control");
            Require(!form.ApprovedByExplicitClick,
                "setting and unsetting the checkbox must not count as a human approval");
        }
        catch (Exception ex)
        {
            failure = ex;
        }
    })
    {
        IsBackground = true
    };

    thread.SetApartmentState(ApartmentState.STA);
    thread.Start();
    Require(thread.Join(TimeSpan.FromSeconds(10)),
        "Windows form creation must not deadlock on a local STA thread");
    if (failure is not null)
    {
        throw new InvalidOperationException(
            "Native move confirmation dialog inspection failed.", failure);
    }
});

if (failures.Count > 0)
{
    Console.Error.WriteLine();
    Console.Error.WriteLine($"{failures.Count} manager regression test(s) failed.");
    Environment.Exit(1);
}

Console.WriteLine("All manager regression tests passed.");
