using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;

namespace PcAgentManager.Services;

/// <summary>
/// ISOLATED SECURITY RESEARCH ONLY: demonstrates a pipe created with an
/// explicit, non-inherited Windows DACL. Not used by the Agent or Manager UI.
/// The production Node IPC remains separate and must not be described as
/// owner-only until it actually uses an audited native server boundary.
/// </summary>
internal static class OwnerOnlyNamedPipePrototype
{
    private const string TestPipePrefix = "PcAgentAclTest-";

    internal static NamedPipeServerStream CreateForCurrentUser(string pipeName)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException(
                "An owner-only named pipe requires Windows security descriptors.");
        }

        // Restrict this proof-of-concept entry point to disposable test names.
        // There is deliberately no production listener or command dispatcher.
        if (string.IsNullOrEmpty(pipeName)
            || !pipeName.StartsWith(TestPipePrefix, StringComparison.Ordinal)
            || pipeName.Length != TestPipePrefix.Length + 32
            || !pipeName[TestPipePrefix.Length..].All(Uri.IsHexDigit))
        {
            throw new ArgumentException(
                "Only unique PcAgentAclTest-<128-bit-hex> names are permitted.",
                nameof(pipeName));
        }

        var owner = WindowsIdentity.GetCurrent().User
            ?? throw new InvalidOperationException(
                "The current Windows token has no user SID.");

        var security = new PipeSecurity();
        // A protected, non-null DACL with exactly one allow ACE.
        // Never inherit a default grant to Everyone or Anonymous.
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.SetOwner(owner);
        security.AddAccessRule(
            new PipeAccessRule(
                owner,
                PipeAccessRights.FullControl,
                AccessControlType.Allow));

        // Do not rely on PipeOptions.CurrentUserOnly here: the documented
        // .NET factory ignores a supplied PipeSecurity in that mode.
        // Pass the explicit DACL when the FIRST native pipe instance is made.
        var stream = NamedPipeServerStreamAcl.Create(
            pipeName,
            PipeDirection.InOut,
            maxNumberOfServerInstances: 1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            inBufferSize: 4096,
            outBufferSize: 4096,
            pipeSecurity: security,
            inheritability: HandleInheritability.None);

        try
        {
            VerifyActualDacl(stream, owner);
            return stream;
        }
        catch
        {
            stream.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Read back the ACL actually attached to the OS pipe handle.
    /// Fail closed if the owner, inheritance or effective explicit ACE
    /// structure differs. This is structural verification, NOT a test using
    /// a separate Windows user security token.
    /// </summary>
    internal static void VerifyActualDacl(
        NamedPipeServerStream stream,
        SecurityIdentifier owner)
    {
        ArgumentNullException.ThrowIfNull(stream);
        ArgumentNullException.ThrowIfNull(owner);

        var actual = stream.GetAccessControl();
        var actualOwner = actual.GetOwner(typeof(SecurityIdentifier))
            as SecurityIdentifier;

        if (actualOwner is null || !actualOwner.Equals(owner)
            || !actual.AreAccessRulesProtected)
        {
            throw new InvalidOperationException(
                "Named pipe owner or DACL inheritance violates the owner-only policy.");
        }

        var rules = actual.GetAccessRules(
            includeExplicit: true,
            includeInherited: true,
            targetType: typeof(SecurityIdentifier));

        if (rules.Count != 1
            || rules[0] is not PipeAccessRule rule
            || rule.IdentityReference is not SecurityIdentifier sid
            || !sid.Equals(owner)
            || rule.AccessControlType != AccessControlType.Allow
            || (rule.PipeAccessRights & PipeAccessRights.ReadWrite)
                != PipeAccessRights.ReadWrite)
        {
            throw new InvalidOperationException(
                "Named pipe DACL contains missing, inherited or non-owner access grants.");
        }
    }
}
