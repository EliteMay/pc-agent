namespace PcAgentManager.Supervision;

public sealed class EmergencyStopStore
{
    private readonly string _path;

    public EmergencyStopStore(string path)
    {
        _path = path;
    }

    public bool IsEngaged => File.Exists(_path);

    public void Engage(string reason)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        File.WriteAllText(
            _path,
            $"{DateTimeOffset.UtcNow:O}\n{reason}\n");
    }

    public void Clear()
    {
        File.Delete(_path);
    }
}
