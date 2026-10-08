using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

/// <summary>
/// Windows CI-only cross-account negative probe. Uses a real logon token for a
/// temporary non-admin local account and attempts an actual kernel CreateFileW
/// open while impersonating that account. Never handles production credentials.
/// </summary>
internal static class WindowsCrossUserPipeProbe
{
    private const int Logon32LogonInteractive = 2;
    private const int Logon32ProviderDefault = 0;
    private const uint GenericReadWrite = 0xC0000000;
    private const uint FileShareReadWrite = 0x00000003;
    private const uint OpenExisting = 3;
    private const int ErrorAccessDenied = 5;

    internal static void AssertDifferentLocalUserDenied(
        string pipeName,
        SecurityIdentifier authorizedOwner,
        string otherUsername,
        string otherPassword)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException();
        }

        if (string.IsNullOrWhiteSpace(otherUsername)
            || string.IsNullOrWhiteSpace(otherPassword))
        {
            throw new ArgumentException("The test requires an independent temporary user.");
        }

        if (!LogonUserW(
            otherUsername,
            Environment.MachineName,
            otherPassword,
            Logon32LogonInteractive,
            Logon32ProviderDefault,
            out var token))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Could not obtain the temporary alternate-user token for the ACL probe.");
        }

        using (token)
        {
            var result = WindowsIdentity.RunImpersonated(token, () =>
            {
                var alternateSid = WindowsIdentity.GetCurrent().User
                    ?? throw new InvalidOperationException("Missing alternate user SID");

                if (alternateSid.Equals(authorizedOwner))
                {
                    throw new InvalidOperationException(
                        "The alternate account is the same principal as the pipe owner.");
                }

                using var pipe = CreateFileW(
                    @"\\.\pipe\" + pipeName,
                    GenericReadWrite,
                    FileShareReadWrite,
                    IntPtr.Zero,
                    OpenExisting,
                    0,
                    IntPtr.Zero);

                var lastError = Marshal.GetLastWin32Error();
                if (!pipe.IsInvalid)
                {
                    throw new InvalidOperationException(
                        "SECURITY FAILURE: another Windows user connected to an owner-only pipe.");
                }

                return lastError;
            });

            if (result != ErrorAccessDenied)
            {
                throw new InvalidOperationException(
                    "Cross-user connection must be rejected with actual Windows "
                    + "ERROR_ACCESS_DENIED (5), not timeouts or other unrelated failures. "
                    + "Actual Win32 error: " + result);
            }
        }
    }

    [DllImport("advapi32.dll", EntryPoint = "LogonUserW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LogonUserW(
        string username,
        string domain,
        string password,
        int logonType,
        int logonProvider,
        out SafeAccessTokenHandle token);

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW",
        CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);
}
