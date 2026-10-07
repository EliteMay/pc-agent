using System.Text.Json.Serialization;

namespace PcAgentManager.Configuration;

public sealed class AgentConfiguration
{
    public string EndpointUrl { get; set; } =
        "https://vtnwbgejlaqpnwmlzbjy.supabase.co/functions/v1/pc-agent-device";

    public string DeviceId { get; set; } = "";

    [JsonIgnore]
    public string DeviceToken { get; set; } = "";

    public List<string> AllowedRoots { get; set; } = [@"D:\AI"];

    public bool AutoStartAgent { get; set; } = true;

    public bool AutoStartManager { get; set; } = false;

    public bool PauseAgentDuringProtectedGames { get; set; } = true;
}

public sealed record ConfigurationValidationResult(
    bool IsValid,
    IReadOnlyList<string> Errors);

public static class AgentConfigurationValidator
{
    public static ConfigurationValidationResult Validate(AgentConfiguration? config)
    {
        var errors = new List<string>();

        if (config is null)
        {
            return new(false, ["Configuration is missing."]);
        }

        if (!Uri.TryCreate(config.EndpointUrl, UriKind.Absolute, out var endpoint) ||
            endpoint.Scheme != Uri.UriSchemeHttps)
        {
            errors.Add("Supabase endpoint must be an absolute HTTPS URL.");
        }

        if (!Guid.TryParse(config.DeviceId, out _))
        {
            errors.Add("Device ID must be a valid UUID.");
        }

        if (string.IsNullOrWhiteSpace(config.DeviceToken) || config.DeviceToken.Length < 24)
        {
            errors.Add("Device token is missing or too short.");
        }

        if (config.AllowedRoots is null || config.AllowedRoots.Count == 0)
        {
            errors.Add("At least one allowed root is required.");
        }
        else
        {
            foreach (var root in config.AllowedRoots)
            {
                if (string.IsNullOrWhiteSpace(root) ||
                    !(Path.IsPathFullyQualified(root) ||
                      root.StartsWith(@"\\", StringComparison.Ordinal)))
                {
                    errors.Add($"Allowed root is not an absolute Windows path: {root}");
                }
            }
        }

        return new(errors.Count == 0, errors);
    }
}
