using System.Security.Cryptography;
using System.Text;

namespace PcAgentManager.Services;

/// <summary>
/// Experimental crash-persistent, fail-closed reservation store for locally
/// approved operations. No production Manager/Agent/IPC integration exists.
/// Each operation ID gets a unique filename and is reserved with CREATE_NEW:
/// a second process or a restarted process cannot reserve that ID again.
/// </summary>
internal sealed class DurableMoveApprovalReplayStorePrototype
{
    private const int MaxOperationIdChars = 128;
    private const int MaxMarkerCount = 10_000;
    private readonly string _directory;

    internal DurableMoveApprovalReplayStorePrototype(string directory)
    {
        if (string.IsNullOrWhiteSpace(directory))
        {
            throw new ArgumentException("Replay store directory is required.", nameof(directory));
        }

        _directory = Path.GetFullPath(directory);
        Directory.CreateDirectory(_directory);
        EnsurePlainDirectory(_directory);
    }

    /// <summary>
    /// Reserve BEFORE any filesystem mutation. Never delete these reservations
    /// after failure or crash: an uncertain operation outcome must not retry.
    /// This store requires a trusted Manager-owned, access-controlled folder.
    /// </summary>
    internal void Reserve(string operationId)
    {
        if (string.IsNullOrWhiteSpace(operationId)
            || operationId.Length > MaxOperationIdChars)
        {
            throw new ArgumentException("Operation ID is missing or too long.", nameof(operationId));
        }

        EnsurePlainDirectory(_directory);

        // Hard limit: no eviction, and no automatic forgetting after restart.
        // The prototype fails closed instead of allowing unbounded disk writes.
        if (Directory.EnumerateFiles(_directory, "*.used", SearchOption.TopDirectoryOnly)
            .Take(MaxMarkerCount + 1).Count() >= MaxMarkerCount)
        {
            throw new InvalidOperationException(
                "Durable replay store exhausted; refusing any new approval.");
        }

        var key = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(operationId))).ToLowerInvariant();
        var marker = Path.Combine(_directory, key + ".used");

        // CreateNew is an atomic no-overwrite reservation, including across
        // independent processes. A preexisting marker is NEVER removed.
        // Crash during creation still leaves a marker that forbids replay.
        try
        {
            using var stream = new FileStream(
                marker, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                bufferSize: 4096, options: FileOptions.WriteThrough);
            var bytes = Encoding.ASCII.GetBytes("v1:" + key + "\n");
            stream.Write(bytes);
            stream.Flush(flushToDisk: true);
        }
        catch (IOException exception)
        {
            throw new InvalidOperationException(
                "Approval already consumed, or durable reservation could not be guaranteed.",
                exception);
        }

        // NOTE: only file contents were flushed. Crash durability of the
        // directory entry itself depends on filesystem/storage semantics.
        // A production version needs tested power-loss guarantees.
    }

    private static void EnsurePlainDirectory(string directory)
    {
        var info = new DirectoryInfo(directory);
        info.Refresh();

        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidOperationException(
                "Durable approval directory must exist and must not be a reparse point.");
        }
    }
}
