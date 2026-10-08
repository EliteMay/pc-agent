using System.Security.Cryptography;
using System.Text.Json;

namespace PcAgentManager.Services;

/// <summary>
/// Test-only proof of a tamper-evident, expiring, one-operation local approval
/// ticket. Does not connect to the Node Agent, the Manager UI, or any IPC.
/// A production service must obtain confirmation from the actual local UI,
/// secure its key, and persist consumed operation IDs across restarts.
/// </summary>
internal sealed class LocalMoveApprovalTicketPrototype : IDisposable
{
    private const int MaxPayloadBytes = 8192;
    private const int MaxConsumedOperations = 1024;
    private static readonly TimeSpan MaxLifetime = TimeSpan.FromMinutes(2);

    private readonly byte[] _secret;
    private readonly DurableMoveApprovalReplayStorePrototype? _durableReplayStore;
    private readonly HashSet<string> _consumedOperations = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private bool _disposed;

    internal LocalMoveApprovalTicketPrototype(
        byte[] ephemeralKey,
        DurableMoveApprovalReplayStorePrototype? durableReplayStore = null)
    {
        if (ephemeralKey is null || ephemeralKey.Length != 32)
        {
            throw new ArgumentException("A 32-byte local secret is required.");
        }

        _secret = (byte[])ephemeralKey.Clone();
        _durableReplayStore = durableReplayStore;
    }

    internal sealed record MoveRequest(
        string CommandId,
        string DeviceId,
        string OperationId,
        string SourcePath,
        string DestinationPath,
        string AllowedRootPath,
        string SourceSha256);

    internal sealed record SignedTicket(byte[] PayloadUtf8, byte[] HmacSha256);

    private sealed record TicketPayload(
        int Version,
        string CommandId,
        string DeviceId,
        string OperationId,
        string SourcePath,
        string DestinationPath,
        string AllowedRootPath,
        string SourceSha256,
        string Nonce,
        long IssuedAtUnixMilliseconds,
        long ExpiresAtUnixMilliseconds);

    /// <summary>
    /// TEST-ONLY stand-in for a grant issued after local user confirmation.
    /// Never call this from code handling unapproved queued commands.
    /// </summary>
    internal SignedTicket IssueApprovedForTest(MoveRequest request, DateTimeOffset now)
    {
        ThrowIfDisposed();
        ValidateRequest(request);

        var start = now.ToUnixTimeMilliseconds();
        var payload = new TicketPayload(
            1,
            request.CommandId,
            request.DeviceId,
            request.OperationId,
            request.SourcePath,
            request.DestinationPath,
            request.AllowedRootPath,
            request.SourceSha256,
            Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
            start,
            checked(start + (long)MaxLifetime.TotalMilliseconds));

        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload);

        if (bytes.Length is <= 0 or > MaxPayloadBytes)
        {
            throw new InvalidOperationException("Approval ticket size limit exceeded.");
        }

        return new SignedTicket(
            bytes,
            HMACSHA256.HashData(_secret, bytes));
    }

    /// <summary>
    /// Consume a single ticket only after comparing it against the exact,
    /// independently validated execution request. A valid HMAC is NOT a
    /// replacement for file policy and filesystem-identity validation.
    /// </summary>
    internal void ConsumeForTest(
        SignedTicket ticket,
        MoveRequest expectedRequest,
        DateTimeOffset now)
    {
        ThrowIfDisposed();
        ValidateRequest(expectedRequest);

        if (ticket?.PayloadUtf8 is not { Length: > 0 and <= MaxPayloadBytes }
            || ticket.HmacSha256 is not { Length: 32 })
        {
            throw new InvalidOperationException("Malformed approval ticket.");
        }

        var computed = HMACSHA256.HashData(_secret, ticket.PayloadUtf8);
        if (!CryptographicOperations.FixedTimeEquals(computed, ticket.HmacSha256))
        {
            throw new InvalidOperationException("Approval ticket authentication failed.");
        }

        TicketPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize<TicketPayload>(ticket.PayloadUtf8);
        }
        catch (JsonException exception)
        {
            throw new InvalidOperationException("Invalid approval ticket data.", exception);
        }

        if (payload is null || payload.Version != 1
            || payload.Nonce is null || payload.Nonce.Length != 32
            || !payload.Nonce.All(Uri.IsHexDigit)
            || !string.Equals(payload.CommandId, expectedRequest.CommandId, StringComparison.Ordinal)
            || !string.Equals(payload.DeviceId, expectedRequest.DeviceId, StringComparison.Ordinal)
            || !string.Equals(payload.OperationId, expectedRequest.OperationId, StringComparison.Ordinal)
            || !string.Equals(payload.SourcePath, expectedRequest.SourcePath, StringComparison.Ordinal)
            || !string.Equals(payload.DestinationPath, expectedRequest.DestinationPath, StringComparison.Ordinal)
            || !string.Equals(payload.AllowedRootPath, expectedRequest.AllowedRootPath, StringComparison.Ordinal)
            || !string.Equals(payload.SourceSha256, expectedRequest.SourceSha256, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Approval ticket does not match the current operation.");
        }

        var nowMs = now.ToUnixTimeMilliseconds();
        if (payload.ExpiresAtUnixMilliseconds <= payload.IssuedAtUnixMilliseconds
            || payload.ExpiresAtUnixMilliseconds - payload.IssuedAtUnixMilliseconds
                > (long)MaxLifetime.TotalMilliseconds
            || nowMs < payload.IssuedAtUnixMilliseconds
            || nowMs > payload.ExpiresAtUnixMilliseconds)
        {
            throw new InvalidOperationException("Approval ticket expired or is not yet valid.");
        }

        lock (_gate)
        {
            if (_consumedOperations.Count >= MaxConsumedOperations
                || _consumedOperations.Contains(payload.OperationId))
            {
                throw new InvalidOperationException(
                    "Approval operation already used or replay capacity exhausted.");
            }

            // Reserve the operation ID durably *before* it can be executed.
            // A failed reservation denies execution; never fall back to RAM.
            // A crash after reservation but before a move leaves it blocked.
            _durableReplayStore?.Reserve(payload.OperationId);
            _consumedOperations.Add(payload.OperationId);
        }
    }

    private static void ValidateRequest(MoveRequest request)
    {
        if (request is null
            || !ValidField(request.CommandId, 128)
            || !ValidField(request.DeviceId, 128)
            || !ValidField(request.OperationId, 128)
            || !ValidField(request.SourcePath, 2048)
            || !ValidField(request.DestinationPath, 2048)
            || !ValidField(request.AllowedRootPath, 2048)
            || request.SourceSha256 is not { Length: 64 }
            || !request.SourceSha256.All(Uri.IsHexDigit))
        {
            throw new ArgumentException("Approval request fields are missing or out of bounds.");
        }
    }

    private static bool ValidField(string? value, int maxLength) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= maxLength;

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(LocalMoveApprovalTicketPrototype));
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        CryptographicOperations.ZeroMemory(_secret);
        lock (_gate)
        {
            _consumedOperations.Clear();
        }
    }
}
