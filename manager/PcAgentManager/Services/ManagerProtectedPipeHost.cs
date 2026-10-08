using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;

namespace PcAgentManager.Services;

/// <summary>
/// Manager-owned Windows pipe with a verified current-user-only DACL.
/// This is a deliberately READ-ONLY protocol experiment. It offers exactly
/// one fixed versioned liveness response and NEVER issues approvals, signs
/// tickets, runs code, or mutates the filesystem. It is not exposed to the
/// Agent queue or network.
/// </summary>
internal sealed class ManagerProtectedPipeHost : IAsyncDisposable
{
    private const int MaxRequestBytes = 32;
    private static readonly TimeSpan IdleTimeout = TimeSpan.FromSeconds(2);
    private static readonly byte[] Pong = "PONG 1\n"u8.ToArray();
    private static readonly byte[] Denied = "DENIED\n"u8.ToArray();

    private readonly NamedPipeServerStream _server;
    private readonly CancellationTokenSource _stopping = new();
    private readonly Task _listener;
    private bool _disposed;

    internal string PipeName { get; }

    private ManagerProtectedPipeHost(string pipeName, NamedPipeServerStream server)
    {
        PipeName = pipeName;
        _server = server;
        _listener = RunAsync();
    }

    /// <summary>
    /// Opens the secured OS pipe before starting the listener. If its ACL
    /// cannot be verified, construction fails closed without any listener.
    /// Only a single server instance exists for this unpredictable name.
    /// </summary>
    internal static ManagerProtectedPipeHost Start()
    {
        var name = "PcAgentMgrSafe-"
            + Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        var server = OwnerOnlyNamedPipePrototype.CreateManagerStatusPipe(name);

        return new ManagerProtectedPipeHost(name, server);
    }

    private async Task RunAsync()
    {
        // Reuse one OS pipe handle for the full Manager lifetime. Creating a
        // fresh instance between clients would introduce a name-squatting gap.
        while (!_stopping.IsCancellationRequested)
        {
            try
            {
                await _server.WaitForConnectionAsync(_stopping.Token);
            }
            catch (OperationCanceledException) when (_stopping.IsCancellationRequested)
            {
                break;
            }
            catch (ObjectDisposedException) when (_stopping.IsCancellationRequested)
            {
                break;
            }
            catch (IOException)
            {
                // Uncertain server state is not safe to retry automatically.
                break;
            }

            try
            {
                using var limit = CancellationTokenSource.CreateLinkedTokenSource(
                    _stopping.Token);
                limit.CancelAfter(IdleTimeout);

                var command = await ReadOneCommandAsync(_server, limit.Token);
                var answer = string.Equals(
                    command, "PING 1", StringComparison.Ordinal)
                    ? Pong : Denied;

                await _server.WriteAsync(answer, limit.Token);
                await _server.FlushAsync(limit.Token);
            }
            catch (OperationCanceledException) when (_stopping.IsCancellationRequested)
            {
                break;
            }
            catch (OperationCanceledException)
            {
                // A silent local client cannot hold the listener indefinitely.
            }
            catch (IOException)
            {
                // Reset/closed client connections do not trigger any action.
            }
            catch (ObjectDisposedException) when (_stopping.IsCancellationRequested)
            {
                break;
            }
            finally
            {
                try
                {
                    if (_server.IsConnected)
                    {
                        _server.Disconnect();
                    }
                }
                catch (IOException) { }
                catch (InvalidOperationException) { }
                catch (ObjectDisposedException) { }
            }
        }
    }

    private static async Task<string?> ReadOneCommandAsync(
        Stream stream,
        CancellationToken token)
    {
        var bytes = new byte[MaxRequestBytes + 1];
        var count = 0;
        var one = new byte[1];

        while (count <= MaxRequestBytes)
        {
            var read = await stream.ReadAsync(one.AsMemory(), token);
            if (read == 0)
            {
                return null;
            }

            if (one[0] == (byte)'\n')
            {
                return Encoding.ASCII.GetString(bytes, 0, count);
            }

            // Only printable ASCII with no CR or control characters.
            if (one[0] < 0x20 || one[0] > 0x7e || count == MaxRequestBytes)
            {
                return null;
            }

            bytes[count++] = one[0];
        }

        return null;
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        _stopping.Cancel();
        _server.Dispose();

        try
        {
            await _listener;
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
        finally
        {
            _stopping.Dispose();
        }
    }
}
