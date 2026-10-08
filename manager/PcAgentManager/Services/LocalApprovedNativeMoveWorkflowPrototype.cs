namespace PcAgentManager.Services;

/// <summary>
/// INTEGRATION RESEARCH ONLY. Connects the isolated local approval ticket,
/// filesystem approval snapshot, durable one-use reservation, and native
/// no-clobber rename in a deterministic .NET test harness.
/// No GUI/IPC/Agent call site invokes this class. Remote queued requests
/// cannot issue tickets or execute moves through this component.
/// </summary>
internal sealed class LocalApprovedNativeMoveWorkflowPrototype
{
    private readonly LocalMoveApprovalTicketPrototype _ticketIssuer;

    internal LocalApprovedNativeMoveWorkflowPrototype(
        LocalMoveApprovalTicketPrototype ticketIssuer)
    {
        _ticketIssuer = ticketIssuer
            ?? throw new ArgumentNullException(nameof(ticketIssuer));
    }

    internal sealed record Proposal(
        LocalMoveApprovalTicketPrototype.MoveRequest Request,
        WindowsNoReplaceMovePrototype.MoveApprovalSnapshotForTest FilesystemSnapshot);

    internal sealed record ConfirmedMove(
        Proposal Proposal,
        LocalMoveApprovalTicketPrototype.SignedTicket Ticket);

    /// <summary>
    /// Open and inspect actual local source/parent/root objects. No approval
    /// ticket is created by this method.
    /// </summary>
    internal Proposal ProposeForTest(
        string commandId,
        string deviceId,
        string operationId,
        string source,
        string destination,
        string allowedRoot)
    {
        if (string.IsNullOrWhiteSpace(commandId)
            || string.IsNullOrWhiteSpace(deviceId))
        {
            throw new ArgumentException("Command and device identity are required.");
        }

        var snapshot = WindowsNoReplaceMovePrototype.CaptureApprovalForTest(
            source, destination, allowedRoot, operationId);

        var request = new LocalMoveApprovalTicketPrototype.MoveRequest(
            commandId,
            deviceId,
            operationId,
            snapshot.SourcePath,
            snapshot.DestinationPath,
            snapshot.AllowedRootPath,
            snapshot.SourceSha256);

        return new Proposal(request, snapshot);
    }

    /// <summary>
    /// Simulates a button press in TESTS ONLY. In production, this must be
    /// callable only after a trusted, real local Manager UI confirmation;
    /// an untrusted queued boolean is NEVER authorization.
    /// </summary>
    internal ConfirmedMove ConfirmForTest(
        Proposal proposal,
        bool simulatedLocalUserApproved,
        DateTimeOffset now)
    {
        if (!simulatedLocalUserApproved)
        {
            throw new InvalidOperationException("User did not approve the move.");
        }

        ValidateProposal(proposal);

        return new ConfirmedMove(
            proposal,
            _ticketIssuer.IssueApprovedForTest(proposal.Request, now));
    }

    /// <summary>
    /// Before any mutation, verify the exact signed request and reserve its
    /// operation ID persistently (if a durable store is configured). Once
    /// consumed, any failure leaves the reservation in place. Never retry an
    /// operation whose result is uncertain without human reconciliation.
    /// </summary>
    internal void ExecuteForTest(
        ConfirmedMove confirmed,
        DateTimeOffset now,
        Action? beforeNativeRename = null,
        Action? afterTicketConsumedBeforeMoveForTest = null)
    {
        if (confirmed is null)
        {
            throw new ArgumentNullException(nameof(confirmed));
        }

        ValidateProposal(confirmed.Proposal);

        var request = confirmed.Proposal.Request;
        _ticketIssuer.ConsumeForTest(
            confirmed.Ticket, request, now);

        // Test-only crash barrier. A simulated crash here must leave the
        // operation permanently reserved and unable to be retried.
        afterTicketConsumedBeforeMoveForTest?.Invoke();

        // No automatic retry and no destructive rollback after a failed or
        // potentially successful native rename.
        WindowsNoReplaceMovePrototype.MoveFileForTest(
            request.SourcePath,
            request.DestinationPath,
            beforeNativeRename: beforeNativeRename,
            approved: confirmed.Proposal.FilesystemSnapshot,
            operationId: request.OperationId,
            useNativeRelativeMoveForTest: true);
    }

    private static void ValidateProposal(Proposal proposal)
    {
        if (proposal is null || proposal.Request is null
            || proposal.FilesystemSnapshot is null)
        {
            throw new InvalidOperationException("Missing local approval proposal.");
        }

        var request = proposal.Request;
        var snapshot = proposal.FilesystemSnapshot;

        if (!string.Equals(
                request.OperationId, snapshot.OperationId, StringComparison.Ordinal)
            || !string.Equals(
                request.SourcePath, snapshot.SourcePath, StringComparison.Ordinal)
            || !string.Equals(
                request.DestinationPath, snapshot.DestinationPath, StringComparison.Ordinal)
            || !string.Equals(
                request.AllowedRootPath, snapshot.AllowedRootPath, StringComparison.Ordinal)
            || !string.Equals(
                request.SourceSha256, snapshot.SourceSha256, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "Local approval ticket request differs from captured filesystem objects.");
        }
    }
}
