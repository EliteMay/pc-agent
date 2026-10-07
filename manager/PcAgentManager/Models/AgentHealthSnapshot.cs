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
