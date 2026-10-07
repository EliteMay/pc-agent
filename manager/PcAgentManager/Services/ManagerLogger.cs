namespace PcAgentManager.Services;

public sealed class ManagerLogger
{
    private const long MaxBytes = 5 * 1024 * 1024;
    private readonly string _path;
    private readonly object _gate = new();

    public ManagerLogger(string path)
    {
        _path = path;
    }

    public void Write(string level, string message)
    {
        lock (_gate)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);

            if (File.Exists(_path) && new FileInfo(_path).Length >= MaxBytes)
            {
                var rotated = _path + ".1";
                File.Delete(rotated);
                File.Move(_path, rotated);
            }

            File.AppendAllText(
                _path,
                $"{DateTimeOffset.UtcNow:O}\t{level}\t{message}{Environment.NewLine}");
        }
    }
}
