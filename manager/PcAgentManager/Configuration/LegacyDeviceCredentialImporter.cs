using System.Text.Json;

namespace PcAgentManager.Configuration;

public sealed record LegacyDeviceCredentialImportResult(
    bool Found,
    string DeviceId,
    string DeviceToken,
    string? SourcePath)
{
    public static LegacyDeviceCredentialImportResult NotFound { get; } =
        new(false, "", "", null);
}

public sealed class LegacyDeviceCredentialImporter
{
    private const int MaxDirectoriesPerRoot = 256;

    private readonly IReadOnlyList<string> _searchRoots;
    private readonly string _expectedSupabaseProjectId;

    public LegacyDeviceCredentialImporter(
        IEnumerable<string> searchRoots,
        string expectedSupabaseProjectId)
    {
        ArgumentNullException.ThrowIfNull(searchRoots);
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedSupabaseProjectId);

        _searchRoots = searchRoots
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Select(Path.GetFullPath)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        _expectedSupabaseProjectId = expectedSupabaseProjectId.Trim();
    }

    public static LegacyDeviceCredentialImporter CreateDefault()
    {
        var roots = new List<string>();

        if (Directory.Exists(@"D:\AI\config"))
        {
            roots.Add(@"D:\AI\config");
        }

        var localAppData = Environment.GetFolderPath(
            Environment.SpecialFolder.LocalApplicationData);

        if (!string.IsNullOrWhiteSpace(localAppData) &&
            Directory.Exists(localAppData))
        {
            roots.Add(localAppData);
        }

        return new LegacyDeviceCredentialImporter(
            roots,
            expectedSupabaseProjectId: "vtnwbgejlaqpnwmlzbjy");
    }

    public LegacyDeviceCredentialImportResult TryFind()
    {
        foreach (var candidate in EnumerateCandidateFiles())
        {
            var result = TryReadCandidate(candidate);
            if (result.Found)
            {
                return result;
            }
        }

        return LegacyDeviceCredentialImportResult.NotFound;
    }

    private IEnumerable<string> EnumerateCandidateFiles()
    {
        foreach (var root in _searchRoots)
        {
            if (!Directory.Exists(root))
            {
                continue;
            }

            var direct = Path.Combine(root, "device.json");
            if (File.Exists(direct))
            {
                yield return direct;
            }

            IEnumerable<string> directories;
            try
            {
                directories = Directory
                    .EnumerateDirectories(root)
                    .Take(MaxDirectoriesPerRoot)
                    .ToArray();
            }
            catch
            {
                continue;
            }

            foreach (var directory in directories)
            {
                var candidate = Path.Combine(directory, "device.json");
                if (File.Exists(candidate))
                {
                    yield return candidate;
                }
            }
        }
    }

    private LegacyDeviceCredentialImportResult TryReadCandidate(string path)
    {
        try
        {
            using var document = JsonDocument.Parse(
                File.ReadAllText(path),
                new JsonDocumentOptions
                {
                    AllowTrailingCommas = true,
                    CommentHandling = JsonCommentHandling.Skip
                });

            var root = document.RootElement;

            if (!TryGetString(root, "deviceId", out var deviceId) ||
                !Guid.TryParse(deviceId, out _))
            {
                return LegacyDeviceCredentialImportResult.NotFound;
            }

            if (!TryGetString(root, "deviceToken", out var deviceToken) ||
                deviceToken.Length < 24)
            {
                return LegacyDeviceCredentialImportResult.NotFound;
            }

            if (!TryGetString(root, "relayUrl", out var relayUrl) ||
                !Uri.TryCreate(relayUrl, UriKind.Absolute, out var uri) ||
                !uri.Host.Equals(
                    _expectedSupabaseProjectId + ".supabase.co",
                    StringComparison.OrdinalIgnoreCase))
            {
                return LegacyDeviceCredentialImportResult.NotFound;
            }

            return new LegacyDeviceCredentialImportResult(
                Found: true,
                DeviceId: deviceId,
                DeviceToken: deviceToken,
                SourcePath: path);
        }
        catch
        {
            return LegacyDeviceCredentialImportResult.NotFound;
        }
    }

    private static bool TryGetString(
        JsonElement element,
        string propertyName,
        out string value)
    {
        value = "";

        foreach (var property in element.EnumerateObject())
        {
            if (!property.Name.Equals(
                    propertyName,
                    StringComparison.OrdinalIgnoreCase) ||
                property.Value.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            value = property.Value.GetString()?.Trim() ?? "";
            return value.Length > 0;
        }

        return false;
    }
}
