using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using PcAgentManager.Configuration;
using PcAgentManager.Models;

namespace PcAgentManager.Services;

public sealed class ManagerUpdateService
{
    public const string ArchiveAssetName = "pc-agent-manager-win-x64.zip";
    public const string HashAssetName = "pc-agent-manager-win-x64.zip.sha256";

    private const long MaxArchiveBytes = 512L * 1024 * 1024;
    private const long MaxExpandedBytes = 1024L * 1024 * 1024;
    private const int MaxArchiveEntries = 20_000;

    private static readonly Uri LatestReleaseUri =
        new("https://api.github.com/repos/EliteMay/pc-agent/releases/latest");

    private static readonly JsonSerializerOptions StateJsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    };

    private readonly ManagerPaths _paths;
    private readonly ManagerLogger _logger;
    private readonly HttpClient _httpClient;

    public ManagerUpdateService(
        ManagerPaths paths,
        ManagerLogger logger,
        HttpClient? httpClient = null)
    {
        _paths = paths;
        _logger = logger;
        _httpClient = httpClient ?? new HttpClient();
        _httpClient.DefaultRequestHeaders.UserAgent.ParseAdd(
            "PcAgentManager/" + CurrentVersion);
        _httpClient.DefaultRequestHeaders.Accept.ParseAdd(
            "application/vnd.github+json");
    }

    public static string CurrentVersion
    {
        get
        {
            var version = typeof(ManagerUpdateService)
                .Assembly
                .GetName()
                .Version;

            return version is null
                ? "0.0.0"
                : new Version(
                    version.Major,
                    version.Minor,
                    Math.Max(0, version.Build))
                    .ToString(3);
        }
    }

    public async Task<UpdateCandidate?> CheckLatestAsync(
        CancellationToken cancellationToken = default)
    {
        using var response = await _httpClient.GetAsync(
            LatestReleaseUri,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream =
            await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document =
            await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        var root = document.RootElement;

        if (root.TryGetProperty("draft", out var draft) && draft.GetBoolean())
        {
            return null;
        }

        if (root.TryGetProperty("prerelease", out var prerelease) &&
            prerelease.GetBoolean())
        {
            return null;
        }

        var tag = root.GetProperty("tag_name").GetString()
            ?? throw new InvalidDataException("Latest release has no tag_name.");

        var versionText = tag.StartsWith("v", StringComparison.OrdinalIgnoreCase)
            ? tag[1..]
            : tag;

        if (!Version.TryParse(versionText, out var latestVersion))
        {
            throw new InvalidDataException(
                "Latest release tag is not a semantic version.");
        }

        var normalizedVersion = NormalizeVersion(latestVersion);

        if (!IsNewerVersion(normalizedVersion, CurrentVersion))
        {
            return null;
        }

        Uri? archiveUrl = null;
        Uri? hashUrl = null;

        foreach (var asset in root.GetProperty("assets").EnumerateArray())
        {
            var name = asset.GetProperty("name").GetString();
            var urlText = asset.GetProperty("browser_download_url").GetString();

            if (string.IsNullOrWhiteSpace(name) ||
                string.IsNullOrWhiteSpace(urlText) ||
                !Uri.TryCreate(urlText, UriKind.Absolute, out var url))
            {
                continue;
            }

            if (name.Equals(ArchiveAssetName, StringComparison.Ordinal))
            {
                archiveUrl = RequireTrustedReleaseUrl(url);
            }
            else if (name.Equals(HashAssetName, StringComparison.Ordinal))
            {
                hashUrl = RequireTrustedReleaseUrl(url);
            }
        }

        if (archiveUrl is null || hashUrl is null)
        {
            throw new InvalidDataException(
                "Latest release is missing the required Windows update assets.");
        }

        return new UpdateCandidate(
            normalizedVersion,
            archiveUrl,
            hashUrl);
    }

    public async Task<StagedUpdate> StageAsync(
        UpdateCandidate candidate,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(candidate);

        if (!Version.TryParse(candidate.Version, out var parsedVersion))
        {
            throw new InvalidDataException("Update version is invalid.");
        }

        var normalizedVersion = NormalizeVersion(parsedVersion);
        var downloadDirectory = Path.Combine(
            _paths.UpdateDownloadsDirectory,
            normalizedVersion);
        var releaseDirectory = Path.Combine(
            _paths.ReleasesDirectory,
            normalizedVersion);
        var archivePath = Path.Combine(
            downloadDirectory,
            ArchiveAssetName);

        Directory.CreateDirectory(_paths.UpdateDownloadsDirectory);
        Directory.CreateDirectory(_paths.ReleasesDirectory);

        if (Directory.Exists(downloadDirectory))
        {
            Directory.Delete(downloadDirectory, recursive: true);
        }
        Directory.CreateDirectory(downloadDirectory);

        _logger.Write(
            "info",
            $"Downloading update {normalizedVersion}.");

        await DownloadBoundedAsync(
            RequireTrustedReleaseUrl(candidate.ArchiveUrl),
            archivePath,
            MaxArchiveBytes,
            cancellationToken);

        var hashText = await DownloadBoundedTextAsync(
            RequireTrustedReleaseUrl(candidate.Sha256Url),
            maxBytes: 4096,
            cancellationToken);

        var expectedHash = ParseSha256Text(hashText);
        var actualHash = await ComputeSha256Async(
            archivePath,
            cancellationToken);

        if (!FixedTimeHexEquals(expectedHash, actualHash))
        {
            File.Delete(archivePath);
            throw new InvalidDataException(
                "Update archive SHA-256 verification failed.");
        }

        var tempReleaseDirectory =
            releaseDirectory + ".staging-" + Guid.NewGuid().ToString("N");

        try
        {
            if (Directory.Exists(tempReleaseDirectory))
            {
                Directory.Delete(tempReleaseDirectory, recursive: true);
            }

            Directory.CreateDirectory(tempReleaseDirectory);
            ExtractZipSafely(archivePath, tempReleaseDirectory);

            var managerExecutable = Path.Combine(
                tempReleaseDirectory,
                "PcAgentManager.exe");
            var nodeExecutable = Path.Combine(
                tempReleaseDirectory,
                "Runtime",
                "node.exe");
            var agentEntry = Path.Combine(
                tempReleaseDirectory,
                "Agent",
                "bin",
                "pc-agent.js");

            foreach (var requiredPath in new[]
                     {
                         managerExecutable,
                         nodeExecutable,
                         agentEntry
                     })
            {
                if (!File.Exists(requiredPath))
                {
                    throw new InvalidDataException(
                        "Staged update is missing: " + requiredPath);
                }
            }

            await RunBundleCheckAsync(
                managerExecutable,
                cancellationToken);

            if (Directory.Exists(releaseDirectory))
            {
                Directory.Delete(releaseDirectory, recursive: true);
            }

            Directory.Move(
                tempReleaseDirectory,
                releaseDirectory);

            var finalManagerExecutable = Path.Combine(
                releaseDirectory,
                "PcAgentManager.exe");

            _logger.Write(
                "info",
                $"Update {normalizedVersion} staged and verified.");

            return new StagedUpdate(
                normalizedVersion,
                releaseDirectory,
                finalManagerExecutable);
        }
        catch
        {
            if (Directory.Exists(tempReleaseDirectory))
            {
                Directory.Delete(tempReleaseDirectory, recursive: true);
            }
            throw;
        }
    }

    public void BeginApply(
        StagedUpdate staged,
        bool autoStartManager)
    {
        ArgumentNullException.ThrowIfNull(staged);

        var currentExecutable = Environment.ProcessPath
            ?? throw new InvalidOperationException(
                "Current Manager executable path is unavailable.");

        var state = new UpdateTransactionState(
            PreviousVersion: CurrentVersion,
            CandidateVersion: staged.Version,
            PreviousExecutablePath: Path.GetFullPath(currentExecutable),
            CandidateExecutablePath:
                Path.GetFullPath(staged.ManagerExecutablePath),
            AutoStartManager: autoStartManager,
            CreatedAtUtc: DateTimeOffset.UtcNow);

        var stateJson = JsonSerializer.Serialize(
            state,
            StateJsonOptions);
        var tempStatePath = _paths.UpdateTransactionPath + ".tmp";

        Directory.CreateDirectory(_paths.RootDirectory);
        File.WriteAllText(tempStatePath, stateJson);
        File.Move(
            tempStatePath,
            _paths.UpdateTransactionPath,
            overwrite: true);

        var startInfo = new ProcessStartInfo
        {
            FileName = currentExecutable,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = AppContext.BaseDirectory
        };
        startInfo.ArgumentList.Add("--update-bootstrap");
        startInfo.ArgumentList.Add(_paths.UpdateTransactionPath);
        startInfo.ArgumentList.Add("--parent-pid");
        startInfo.ArgumentList.Add(Environment.ProcessId.ToString());

        if (Process.Start(startInfo) is null)
        {
            throw new InvalidOperationException(
                "Unable to launch update bootstrap process.");
        }

        _logger.Write(
            "info",
            $"Update apply requested: {CurrentVersion} -> {staged.Version}.");
    }

    public static bool IsNewerVersion(
        string candidate,
        string current)
    {
        return Version.TryParse(candidate, out var candidateVersion) &&
               Version.TryParse(current, out var currentVersion) &&
               candidateVersion > currentVersion;
    }

    public static string ParseSha256Text(string text)
    {
        var token = text
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault();

        if (token is null ||
            token.Length != 64 ||
            !token.All(Uri.IsHexDigit))
        {
            throw new InvalidDataException(
                "Release SHA-256 file is invalid.");
        }

        return token.ToLowerInvariant();
    }

    public static void ExtractZipSafely(
        string archivePath,
        string destinationDirectory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(archivePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(destinationDirectory);

        var root = Path.GetFullPath(destinationDirectory);
        Directory.CreateDirectory(root);
        var rootPrefix = root.EndsWith(Path.DirectorySeparatorChar)
            ? root
            : root + Path.DirectorySeparatorChar;

        using var archive = ZipFile.OpenRead(archivePath);

        if (archive.Entries.Count > MaxArchiveEntries)
        {
            throw new InvalidDataException(
                "Update archive contains too many entries.");
        }

        long expandedBytes = 0;

        foreach (var entry in archive.Entries)
        {
            if (entry.FullName.Contains(':'))
            {
                throw new InvalidDataException(
                    "Update archive contains an unsafe path.");
            }

            expandedBytes = checked(expandedBytes + entry.Length);
            if (expandedBytes > MaxExpandedBytes)
            {
                throw new InvalidDataException(
                    "Update archive expands beyond the allowed size.");
            }

            var relative = entry.FullName
                .Replace('/', Path.DirectorySeparatorChar);
            var target = Path.GetFullPath(
                Path.Combine(root, relative));

            if (!target.StartsWith(
                    rootPrefix,
                    StringComparison.OrdinalIgnoreCase) &&
                !target.Equals(root, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException(
                    "Update archive attempted to escape the staging directory.");
            }

            var isDirectory =
                entry.FullName.EndsWith("/", StringComparison.Ordinal) ||
                entry.FullName.EndsWith("\\", StringComparison.Ordinal);

            if (isDirectory)
            {
                Directory.CreateDirectory(target);
                continue;
            }

            var parent = Path.GetDirectoryName(target)
                ?? throw new InvalidDataException(
                    "Update archive entry has no parent directory.");

            Directory.CreateDirectory(parent);
            entry.ExtractToFile(target, overwrite: true);
        }
    }

    private static string NormalizeVersion(Version version)
    {
        return new Version(
            version.Major,
            version.Minor,
            Math.Max(0, version.Build))
            .ToString(3);
    }

    private static Uri RequireTrustedReleaseUrl(Uri url)
    {
        if (url.Scheme != Uri.UriSchemeHttps ||
            !url.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException(
                "Update asset URL is not an approved GitHub HTTPS URL.");
        }

        return url;
    }

    private async Task DownloadBoundedAsync(
        Uri url,
        string destinationPath,
        long maxBytes,
        CancellationToken cancellationToken)
    {
        using var response = await _httpClient.GetAsync(
            url,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        response.EnsureSuccessStatusCode();

        if (response.Content.Headers.ContentLength is { } length &&
            length > maxBytes)
        {
            throw new InvalidDataException(
                "Update download exceeds the allowed size.");
        }

        await using var source =
            await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var destination = new FileStream(
            destinationPath,
            FileMode.Create,
            FileAccess.Write,
            FileShare.None,
            bufferSize: 128 * 1024,
            useAsync: true);

        var buffer = new byte[128 * 1024];
        long total = 0;

        while (true)
        {
            var read = await source.ReadAsync(
                buffer,
                cancellationToken);

            if (read == 0)
            {
                break;
            }

            total += read;
            if (total > maxBytes)
            {
                throw new InvalidDataException(
                    "Update download exceeds the allowed size.");
            }

            await destination.WriteAsync(
                buffer.AsMemory(0, read),
                cancellationToken);
        }
    }

    private async Task<string> DownloadBoundedTextAsync(
        Uri url,
        int maxBytes,
        CancellationToken cancellationToken)
    {
        using var response = await _httpClient.GetAsync(
            url,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var source =
            await response.Content.ReadAsStreamAsync(cancellationToken);

        using var memory = new MemoryStream();
        var buffer = new byte[1024];

        while (true)
        {
            var read = await source.ReadAsync(
                buffer,
                cancellationToken);

            if (read == 0)
            {
                break;
            }

            if (memory.Length + read > maxBytes)
            {
                throw new InvalidDataException(
                    "Update hash file exceeds the allowed size.");
            }

            memory.Write(buffer, 0, read);
        }

        return System.Text.Encoding.UTF8.GetString(memory.ToArray());
    }

    private static async Task<string> ComputeSha256Async(
        string path,
        CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 128 * 1024,
            useAsync: true);

        using var sha256 = SHA256.Create();
        var hash = await sha256.ComputeHashAsync(
            stream,
            cancellationToken);

        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static bool FixedTimeHexEquals(
        string expected,
        string actual)
    {
        try
        {
            var expectedBytes = Convert.FromHexString(expected);
            var actualBytes = Convert.FromHexString(actual);

            return expectedBytes.Length == actualBytes.Length &&
                   CryptographicOperations.FixedTimeEquals(
                       expectedBytes,
                       actualBytes);
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static async Task RunBundleCheckAsync(
        string managerExecutable,
        CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = managerExecutable,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(managerExecutable)!
        };
        startInfo.ArgumentList.Add("--bundle-check");

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException(
                "Unable to start staged bundle check.");

        using var timeout =
            CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));

        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch
            {
                // Best effort.
            }

            throw new TimeoutException(
                "Staged bundle check did not finish in time.");
        }

        if (process.ExitCode != 0)
        {
            throw new InvalidDataException(
                $"Staged bundle check failed with exit code {process.ExitCode}.");
        }
    }
}
