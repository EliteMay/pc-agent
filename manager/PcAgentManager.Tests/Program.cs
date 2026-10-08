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

if (failures.Count > 0)
{
    Console.Error.WriteLine();
    Console.Error.WriteLine($"{failures.Count} manager regression test(s) failed.");
    Environment.Exit(1);
}

Console.WriteLine("All manager regression tests passed.");
