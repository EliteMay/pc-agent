using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

namespace PcAgentManager.Services;

/// <summary>
/// Isolated Windows ACL experiment for durable move-replay marker directories.
/// Windows creates the NEW directory with a protected owner-only DACL in the
/// same native operation. This is NOT wired to any production move operation
/// or Manager UI. The supplied parent must be independently trusted: this
/// fixture does not protect against ancestor reparse/rename races.
/// </summary>
internal static class OwnerOnlyReplayDirectoryPrototype
{
    private const string FixturePrefix = "PcAgentReplayAclTest-";

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr SecurityDescriptor;
        internal int InheritHandle;
    }

    internal static string CreateNewTestDirectory(string trustedParent, string directoryName)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException(
                "Owner-only replay directory ACLs require Windows.");
        }

        if (string.IsNullOrWhiteSpace(trustedParent)
            || string.IsNullOrWhiteSpace(directoryName)
            || !directoryName.StartsWith(FixturePrefix, StringComparison.Ordinal)
            || directoryName.Length != FixturePrefix.Length + 32
            || !directoryName[FixturePrefix.Length..].All(Uri.IsHexDigit))
        {
            throw new ArgumentException("A trusted parent and random fixture-only name are required.");
        }

        var parent = Path.GetFullPath(trustedParent);
        var parentInfo = new DirectoryInfo(parent);
        parentInfo.Refresh();

        if (!parentInfo.Exists
            || (parentInfo.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidOperationException(
                "Replay ACL experiment needs an existing, plain trusted parent.");
        }

        var path = Path.Combine(parent, directoryName);
        var owner = WindowsIdentity.GetCurrent().User
            ?? throw new InvalidOperationException("Windows user SID unavailable.");

        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.SetOwner(owner);
        // Object inheritance ensures new .used markers are not assigned
        // permissions for Everyone/Users by the parent's default DACL.
        security.AddAccessRule(new FileSystemAccessRule(
            owner,
            FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));

        var descriptor = security.GetSecurityDescriptorBinaryForm();
        var memory = Marshal.AllocHGlobal(descriptor.Length);
        try
        {
            Marshal.Copy(descriptor, 0, memory, descriptor.Length);
            var attributes = new SecurityAttributes
            {
                Length = Marshal.SizeOf<SecurityAttributes>(),
                SecurityDescriptor = memory,
                InheritHandle = 0
            };

            // CREATE_NEW semantics: never adopt or reset permissions on a
            // preexisting directory that another process might control.
            if (!CreateDirectoryW(path, ref attributes))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Native owner-only replay directory creation failed.");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(memory);
        }

        VerifyActualDirectoryAcl(path, owner);
        return path;
    }

    internal static void VerifyActualDirectoryAcl(string path, SecurityIdentifier owner)
    {
        ArgumentNullException.ThrowIfNull(owner);
        var info = new DirectoryInfo(path);
        info.Refresh();

        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidOperationException(
                "Replay directory is missing or has become a reparse point.");
        }

        var actual = info.GetAccessControl(
            AccessControlSections.Owner | AccessControlSections.Access);
        var actualOwner = actual.GetOwner(typeof(SecurityIdentifier))
            as SecurityIdentifier;

        if (actualOwner is null || !actualOwner.Equals(owner)
            || !actual.AreAccessRulesProtected)
        {
            throw new InvalidOperationException(
                "Replay directory owner or protected DACL does not match its policy.");
        }

        var rules = actual.GetAccessRules(
            includeExplicit: true,
            includeInherited: true,
            targetType: typeof(SecurityIdentifier));

        if (rules.Count != 1
            || rules[0] is not FileSystemAccessRule rule
            || rule.IdentityReference is not SecurityIdentifier sid
            || !sid.Equals(owner)
            || rule.IsInherited
            || rule.AccessControlType != AccessControlType.Allow
            || (rule.FileSystemRights & FileSystemRights.FullControl)
                != FileSystemRights.FullControl
            || (rule.InheritanceFlags &
                (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit))
                != (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit))
        {
            throw new InvalidOperationException(
                "Replay directory DACL has an unexpected or broad access grant.");
        }
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateDirectoryW(
        string path,
        ref SecurityAttributes securityAttributes);
}
