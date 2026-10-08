using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using PcAgentManager.Models;

namespace PcAgentManager.Supervision;

public sealed class NamedPipeAgentClient
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly string _pipeName;
    private readonly string? _localApprovalSecret;

    public NamedPipeAgentClient(string pipeName, string? localApprovalSecret = null)
    {
        _pipeName = pipeName;
        _localApprovalSecret = localApprovalSecret;
    }

    public async Task<AgentHealthSnapshot> GetHealthAsync(
        CancellationToken cancellationToken = default)
    {
        var result = await SendAsync(
            "get_health",
            parameters: null,
            cancellationToken);
        return result.Deserialize<AgentHealthSnapshot>(JsonOptions)
            ?? throw new InvalidDataException("Agent returned no health object.");
    }

    public async Task<PendingApprovalSnapshot?> GetPendingApprovalAsync(
        CancellationToken cancellationToken = default)
    {
        RequireLocalAuthentication();
        var result = await SendAsync(
            "get_pending_approval",
            new { auth_token = _localApprovalSecret },
            cancellationToken);

        if (result.ValueKind == JsonValueKind.Null)
        {
            return null;
        }

        return result.Deserialize<PendingApprovalSnapshot>(JsonOptions);
    }

    public async Task<ApprovalResponseSnapshot> RespondApprovalAsync(
        string operationId,
        string decision,
        string approvalNonce,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(operationId);
        ArgumentException.ThrowIfNullOrWhiteSpace(decision);
        if (approvalNonce.Length != 32 || !approvalNonce.All(Uri.IsHexDigit))
        {
            throw new InvalidOperationException(
                "Approval response must match a valid pending UI challenge.");
        }
        RequireLocalAuthentication();

        var result = await SendAsync(
            "respond_approval",
            new
            {
                operation_id = operationId,
                decision,
                approval_nonce = approvalNonce,
                auth_token = _localApprovalSecret
            },
            cancellationToken);

        return result.Deserialize<ApprovalResponseSnapshot>(JsonOptions)
            ?? new ApprovalResponseSnapshot
            {
                Accepted = false,
                Code = "EMPTY_APPROVAL_RESPONSE"
            };
    }

    public async Task PrepareShutdownAsync(
        CancellationToken cancellationToken = default)
    {
        RequireLocalAuthentication();
        _ = await SendAsync(
            "prepare_shutdown",
            new { auth_token = _localApprovalSecret },
            cancellationToken);
    }

    private void RequireLocalAuthentication()
    {
        if (_localApprovalSecret is null
            || _localApprovalSecret.Length != 64
            || !_localApprovalSecret.All(Uri.IsHexDigit))
        {
            throw new InvalidOperationException(
                "Authenticated Manager IPC credential is unavailable.");
        }
    }

    private async Task<JsonElement> SendAsync(
        string method,
        object? parameters,
        CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(2));

        await using var pipe = new NamedPipeClientStream(
            ".",
            _pipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous);

        await pipe.ConnectAsync(1500, timeout.Token);

        using var writer = new StreamWriter(
            pipe,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            bufferSize: 4096,
            leaveOpen: true)
        {
            AutoFlush = true
        };

        using var reader = new StreamReader(
            pipe,
            new UTF8Encoding(
                encoderShouldEmitUTF8Identifier: false,
                throwOnInvalidBytes: true),
            detectEncodingFromByteOrderMarks: false,
            bufferSize: 4096,
            leaveOpen: true);

        var id = Guid.NewGuid().ToString("N");
        await writer.WriteLineAsync(JsonSerializer.Serialize(new
        {
            id,
            method,
            @params = parameters
        }));

        var line = await reader.ReadLineAsync(timeout.Token);
        if (string.IsNullOrWhiteSpace(line))
        {
            throw new InvalidDataException("Agent IPC returned an empty response.");
        }

        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;

        if (!root.TryGetProperty("ok", out var ok) || !ok.GetBoolean())
        {
            var message = root.TryGetProperty("error", out var error)
                ? error.ToString()
                : "Agent IPC request failed.";
            throw new InvalidOperationException(message);
        }

        if (!root.TryGetProperty("result", out var result))
        {
            throw new InvalidDataException("Agent IPC response has no result.");
        }

        return result.Clone();
    }
}
