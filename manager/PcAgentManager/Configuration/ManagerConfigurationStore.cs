using System.Text.Json;

namespace PcAgentManager.Configuration;

public sealed class ManagerConfigurationStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    };

    private readonly ManagerPaths _paths;
    private readonly SecureTokenStore _tokenStore;

    public ManagerConfigurationStore(ManagerPaths paths)
    {
        _paths = paths;
        _tokenStore = new SecureTokenStore(paths.TokenPath);
    }

    public AgentConfiguration Load()
    {
        _paths.EnsureDirectories();

        AgentConfiguration config;
        if (!File.Exists(_paths.ConfigPath))
        {
            config = new AgentConfiguration();
        }
        else
        {
            var json = File.ReadAllText(_paths.ConfigPath);
            config = JsonSerializer.Deserialize<AgentConfiguration>(json, JsonOptions)
                ?? new AgentConfiguration();
        }

        config.DeviceToken = _tokenStore.Load();
        return config;
    }

    public void Save(AgentConfiguration config)
    {
        ArgumentNullException.ThrowIfNull(config);
        _paths.EnsureDirectories();

        if (!string.IsNullOrWhiteSpace(config.DeviceToken))
        {
            _tokenStore.Save(config.DeviceToken);
        }

        var json = JsonSerializer.Serialize(config, JsonOptions);
        var temp = _paths.ConfigPath + ".tmp";
        File.WriteAllText(temp, json);
        File.Move(temp, _paths.ConfigPath, overwrite: true);
    }
}
