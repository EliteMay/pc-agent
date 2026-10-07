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

    public NamedPipeAgentClient(string pipeName)
    {
        _pipeName = pipeName;
    }

    public async Task<AgentHealthSnapshot> GetHealthAsync(
        CancellationToken cancellationToken = default)
    {
        var result = await SendAsync("get_health", cancellationToken);
        return result.Deserialize<AgentHealthSnapshot>(JsonOptions)
            ?? throw new InvalidDataException("Agent returned no health object.");
    }

    public async Task PrepareShutdownAsync(
        CancellationToken cancellationToken = default)
    {
        _ = await SendAsync("prepare_shutdown", cancellationToken);
    }

    private async Task<JsonElement> SendAsync(
        string method,
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
        await writer.WriteLineAsync(JsonSerializer.Serialize(new { id, method }));

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
