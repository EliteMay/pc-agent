namespace PcAgentManager.Models;

public sealed record UpdateCandidate(
    string Version,
    Uri ArchiveUrl,
    Uri Sha256Url);

public sealed record StagedUpdate(
    string Version,
    string BundleDirectory,
    string ManagerExecutablePath);

public sealed record UpdateTransactionState(
    string PreviousVersion,
    string CandidateVersion,
    string PreviousExecutablePath,
    string CandidateExecutablePath,
    bool AutoStartManager,
    DateTimeOffset CreatedAtUtc,
    string Outcome = "pending",
    string? FailureReason = null);
