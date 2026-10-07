using System.Text.Json.Serialization;

namespace PcAgentManager.Models;

public sealed class AgentHealthSnapshot
{
    [JsonPropertyName("agent_state")]
    public string AgentState { get; set; } = "STARTING";

    [JsonPropertyName("last_poll_time")]
    public string? LastPollTime { get; set; }

    [JsonPropertyName("queue_connectivity")]
    public string QueueConnectivity { get; set; } = "unknown";

    [JsonPropertyName("active_command_id")]
    public string? ActiveCommandId { get; set; }

    [JsonPropertyName("version")]
    public string Version { get; set; } = "";

    [JsonPropertyName("protocol_version")]
    public int ProtocolVersion { get; set; }

    [JsonPropertyName("last_error")]
    public string? LastError { get; set; }
}

public sealed record ManagerSnapshot(
    string ManagerState,
    string AgentState,
    string QueueConnectivity,
    DateTimeOffset? LastHeartbeat,
    int? ProcessId,
    string AgentVersion,
    string? LastError,
    bool EmergencyStopped,
    int RecentCrashCount)
{
    public static ManagerSnapshot Stopped(bool emergency = false) => new(
        emergency ? "EMERGENCY_STOPPED" : "STOPPED",
        emergency ? "EMERGENCY_STOPPED" : "STOPPED",
        "unknown",
        null,
        null,
        "",
        null,
        emergency,
        0);
}


public sealed class PendingApprovalSnapshot
{
    [JsonPropertyName("command_id")]
    public string CommandId { get; set; } = "";

    [JsonPropertyName("operation_id")]
    public string OperationId { get; set; } = "";

    [JsonPropertyName("tool")]
    public string Tool { get; set; } = "";

    [JsonPropertyName("risk")]
    public string Risk { get; set; } = "";

    [JsonPropertyName("summary")]
    public System.Text.Json.JsonElement Summary { get; set; }

    [JsonPropertyName("requested_at")]
    public string RequestedAt { get; set; } = "";

    [JsonPropertyName("expires_at")]
    public string ExpiresAt { get; set; } = "";
}

public sealed class ApprovalResponseSnapshot
{
    [JsonPropertyName("accepted")]
    public bool Accepted { get; set; }

    [JsonPropertyName("code")]
    public string? Code { get; set; }
}
