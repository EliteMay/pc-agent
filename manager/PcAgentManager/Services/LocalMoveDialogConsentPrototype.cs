using System.Security.Cryptography;
using System.Windows.Forms;

namespace PcAgentManager.Services;

/// <summary>
/// TEST-ONLY, IN-PROCESS preparation for future local WinForms confirmation.
/// The token is a pending-dialog capability, NOT cryptographic proof of a
/// physical human click. Only a future audited Manager GUI call-site may
/// supply a real DialogResult after showing exactly these displayed details.
/// No IPC, cloud queue, Agent command, or production UI calls this type.
/// </summary>
internal sealed class LocalMoveDialogConsentPrototype
{
    private static readonly TimeSpan MaxDialogLifetime = TimeSpan.FromSeconds(30);
    private readonly LocalApprovedNativeMoveWorkflowPrototype _workflow;
    private readonly object _gate = new();
    private Pending? _pending;

    private sealed record Pending(
        DialogChallenge Displayed,
        LocalApprovedNativeMoveWorkflowPrototype.Proposal Proposal);

    internal sealed record DialogChallenge(
        string ChallengeNonce,
        string CommandId,
        string DeviceId,
        string OperationId,
        string SourcePath,
        string DestinationPath,
        string AllowedRootPath,
        string SourceSha256,
        DateTimeOffset IssuedAt,
        DateTimeOffset ExpiresAt);

    internal LocalMoveDialogConsentPrototype(
        LocalApprovedNativeMoveWorkflowPrototype workflow)
    {
        _workflow = workflow ?? throw new ArgumentNullException(nameof(workflow));
    }

    /// <summary>
    /// Builds an immutable display snapshot from the exact validated operation.
    /// Only one dialog may remain pending. A later request cannot silently
    /// replace an existing confirmation.
    /// </summary>
    internal DialogChallenge OpenForTest(
        LocalApprovedNativeMoveWorkflowPrototype.Proposal proposal,
        DateTimeOffset now)
    {
        LocalApprovedNativeMoveWorkflowPrototype.ValidateProposalForTest(proposal);

        lock (_gate)
        {
            if (_pending is not null && now <= _pending.Displayed.ExpiresAt)
            {
                throw new InvalidOperationException(
                    "Another local native move confirmation is already pending.");
            }

            // An expired challenge is discarded; it can never authorize a
            // later dialog even for the same operation ID.
            _pending = null;

            var request = proposal.Request;
            var challenge = new DialogChallenge(
                Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
                request.CommandId,
                request.DeviceId,
                request.OperationId,
                request.SourcePath,
                request.DestinationPath,
                request.AllowedRootPath,
                request.SourceSha256,
                now,
                now + MaxDialogLifetime);

            _pending = new Pending(challenge, proposal);
            return challenge;
        }
    }

    /// <summary>
    /// Experimental real WinForms bridge. Only a local STA UI thread can
    /// display this modal confirmation; no remote command may call it.
    /// There is deliberately no MainForm/Agent/IPC call site yet.
    /// </summary>
    internal LocalApprovedNativeMoveWorkflowPrototype.ConfirmedMove
        PromptOnManagerUiThreadForTest(
            LocalApprovedNativeMoveWorkflowPrototype.Proposal proposal,
            IWin32Window owner)
    {
        if (!OperatingSystem.IsWindows()
            || Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
        {
            throw new InvalidOperationException(
                "A real local Windows STA UI thread is required.");
        }

        ArgumentNullException.ThrowIfNull(owner);

        var displayed = OpenForTest(proposal, DateTimeOffset.UtcNow);
        try
        {
            using var dialog = new LocalMoveConfirmationFormPrototype(displayed);
            var result = dialog.ShowDialog(owner);
            return ResolveLocalDialogForTest(
                displayed, result, DateTimeOffset.UtcNow);
        }
        finally
        {
            // If WinForms throws or the user dismisses the modal, no orphaned
            // challenge may authorize a later operation.
            lock (_gate)
            {
                if (_pending is not null
                    && ReferenceEquals(_pending.Displayed, displayed))
                {
                    _pending = null;
                }
            }
        }
    }

    /// <summary>
    /// Consume the exact displayed challenge once, even on denial or failure.
    /// DialogResult.Yes is an IN-PROCESS test stand-in for a future genuine
    /// Manager-local UI click. A remote bool, JSON object, copied challenge,
    /// stale nonce, or absent display must never issue an approval ticket.
    /// </summary>
    internal LocalApprovedNativeMoveWorkflowPrototype.ConfirmedMove
        ResolveLocalDialogForTest(
            DialogChallenge displayed,
            DialogResult actualLocalDialogResult,
            DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_pending is null || displayed is null)
            {
                throw new InvalidOperationException(
                    "There is no active local confirmation to consume.");
            }

            var current = _pending;
            // Object identity ties this response to the exact in-process
            // display instance; equal-looking values are not a new grant.
            if (!ReferenceEquals(displayed, current.Displayed))
            {
                throw new InvalidOperationException(
                    "Local confirmation does not match the active displayed dialog.");
            }

            _pending = null;

            if (now < current.Displayed.IssuedAt
                || now > current.Displayed.ExpiresAt)
            {
                throw new InvalidOperationException(
                    "Local confirmation has expired.");
            }

            if (actualLocalDialogResult != DialogResult.Yes)
            {
                throw new InvalidOperationException(
                    "The local user did not explicitly approve this operation.");
            }

            LocalApprovedNativeMoveWorkflowPrototype.ValidateProposalForTest(
                current.Proposal);

            var request = current.Proposal.Request;
            if (!string.Equals(current.Displayed.CommandId, request.CommandId, StringComparison.Ordinal)
                || !string.Equals(current.Displayed.DeviceId, request.DeviceId, StringComparison.Ordinal)
                || !string.Equals(current.Displayed.OperationId, request.OperationId, StringComparison.Ordinal)
                || !string.Equals(current.Displayed.SourcePath, request.SourcePath, StringComparison.Ordinal)
                || !string.Equals(current.Displayed.DestinationPath, request.DestinationPath, StringComparison.Ordinal)
                || !string.Equals(current.Displayed.AllowedRootPath, request.AllowedRootPath, StringComparison.Ordinal)
                || !string.Equals(current.Displayed.SourceSha256, request.SourceSha256, StringComparison.Ordinal)
                || current.Displayed.ChallengeNonce.Length != 32
                || !current.Displayed.ChallengeNonce.All(Uri.IsHexDigit))
            {
                throw new InvalidOperationException(
                    "The displayed operation identity changed before local approval.");
            }

            // The signed ticket is only issued after all local dialog checks.
            // File identity, root, no-clobber and replay validation remain
            // mandatory at the separate execution step.
            return _workflow.ConfirmForTest(
                current.Proposal,
                simulatedLocalUserApproved: true,
                now);
        }
    }
}
