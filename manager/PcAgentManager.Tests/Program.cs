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

if (failures.Count > 0)
{
    Console.Error.WriteLine();
    Console.Error.WriteLine($"{failures.Count} manager regression test(s) failed.");
    Environment.Exit(1);
}

Console.WriteLine("All manager regression tests passed.");
