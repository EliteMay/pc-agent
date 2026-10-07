namespace PcAgentManager.Supervision;

public sealed record CrashDecision(
    bool CrashLoopDetected,
    TimeSpan? RestartDelay,
    int RecentCrashCount);

public sealed class CrashRecoveryPolicy
{
    private readonly int _crashLimit;
    private readonly TimeSpan _crashWindow;
    private readonly TimeSpan _maxBackoff;
    private readonly Queue<DateTimeOffset> _crashes = new();

    public CrashRecoveryPolicy(
        int crashLimit = 5,
        TimeSpan? crashWindow = null,
        TimeSpan? maxBackoff = null)
    {
        if (crashLimit < 2) throw new ArgumentOutOfRangeException(nameof(crashLimit));

        _crashLimit = crashLimit;
        _crashWindow = crashWindow ?? TimeSpan.FromMinutes(2);
        _maxBackoff = maxBackoff ?? TimeSpan.FromSeconds(30);
    }

    public CrashDecision RegisterCrash(DateTimeOffset now)
    {
        var cutoff = now - _crashWindow;

        while (_crashes.Count > 0 && _crashes.Peek() < cutoff)
        {
            _crashes.Dequeue();
        }

        _crashes.Enqueue(now);

        if (_crashes.Count >= _crashLimit)
        {
            return new(true, null, _crashes.Count);
        }

        var seconds = Math.Min(
            _maxBackoff.TotalSeconds,
            Math.Pow(2, _crashes.Count - 1));

        return new(
            false,
            TimeSpan.FromSeconds(seconds),
            _crashes.Count);
    }

    public void Reset() => _crashes.Clear();
}
