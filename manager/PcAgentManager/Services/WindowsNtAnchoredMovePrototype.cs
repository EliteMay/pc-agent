using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace PcAgentManager.Services;

/// <summary>
/// Experimental native NT rename primitive for research tests only.
/// It is never exposed to the Agent, the Manager UI or an external caller.
/// Do not promote it without resolving all path/approval/ACL threat models.
/// </summary>
internal static class WindowsNtAnchoredMovePrototype
{
    private const int FileRenameInformation = 10;
    private const int FileNameOffsetX64 = 20;

    internal static void RenameFileNoReplace(
        SafeFileHandle sourceHandle,
        SafeFileHandle destinationDirectoryHandle,
        string destinationLeaf)
    {
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess)
        {
            throw new PlatformNotSupportedException(
                "Native rename research requires Windows x64.");
        }

        // A single leaf is required. No slashes, traversal, alternate streams,
        // trailing spaces/dots, or device names should reach the NT primitive.
        if (string.IsNullOrWhiteSpace(destinationLeaf)
            || destinationLeaf is "." or ".."
            || destinationLeaf.IndexOfAny(['\\', '/', ':', '\0']) >= 0
            || destinationLeaf.EndsWith(' ')
            || destinationLeaf.EndsWith('.')
            || destinationLeaf.Length > 255)
        {
            throw new ArgumentException(
                "Native rename target must be one safe filename.",
                nameof(destinationLeaf));
        }

        var reservedBase = destinationLeaf.Split('.')[0];
        if (reservedBase.Equals("CON", StringComparison.OrdinalIgnoreCase)
            || reservedBase.Equals("PRN", StringComparison.OrdinalIgnoreCase)
            || reservedBase.Equals("AUX", StringComparison.OrdinalIgnoreCase)
            || reservedBase.Equals("NUL", StringComparison.OrdinalIgnoreCase)
            || (reservedBase.Length == 4
                && (reservedBase.StartsWith("COM", StringComparison.OrdinalIgnoreCase)
                    || reservedBase.StartsWith("LPT", StringComparison.OrdinalIgnoreCase))
                && reservedBase[3] is >= '1' and <= '9'))
        {
            throw new ArgumentException(
                "Reserved device names are not valid rename targets.",
                nameof(destinationLeaf));
        }

        // NT FILE_RENAME_INFORMATION on x64:
        // byte 0: ReplaceIfExists = FALSE; bytes 1..7: padding;
        // bytes 8..15: RootDirectory (held-open directory handle);
        // bytes 16..19: UTF-16 byte length; byte 20 onwards: relative leaf.
        var filenameBytes = Encoding.Unicode.GetBytes(destinationLeaf);
        var bufferLength = checked(FileNameOffsetX64 + filenameBytes.Length + 2);
        var buffer = Marshal.AllocHGlobal(bufferLength);

        try
        {
            // Explicit initialization prevents stray pointer/flag values.
            for (var i = 0; i < FileNameOffsetX64; i++)
            {
                Marshal.WriteByte(buffer, i, 0);
            }

            Marshal.WriteIntPtr(
                buffer, 8, destinationDirectoryHandle.DangerousGetHandle());
            Marshal.WriteInt32(buffer, 16, filenameBytes.Length);
            Marshal.Copy(
                filenameBytes, 0,
                IntPtr.Add(buffer, FileNameOffsetX64),
                filenameBytes.Length);
            Marshal.WriteInt16(
                IntPtr.Add(buffer, FileNameOffsetX64 + filenameBytes.Length),
                0);

            // NTSTATUS success is >= 0. Do not silently retry on pending or
            // unknown outcomes: this is a synchronous test-only handle.
            var status = NtSetInformationFile(
                sourceHandle, out var ioStatus,
                buffer, (uint)bufferLength, FileRenameInformation);

            if (status != 0)
            {
                if (status > 0)
                {
                    throw new InvalidOperationException(
                        $"Unexpected asynchronous NTSTATUS 0x{status:X8}; no retry allowed.");
                }

                var win32 = RtlNtStatusToDosError(status);
                throw new Win32Exception((int)win32,
                    $"Native handle-relative move failed: NTSTATUS 0x{status:X8}.");
            }

            if (ioStatus.Status != IntPtr.Zero)
            {
                throw new InvalidOperationException(
                    "Unexpected IO_STATUS_BLOCK result after native rename.");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock
    {
        internal IntPtr Status;
        internal UIntPtr Information;
    }

    [DllImport("ntdll.dll", ExactSpelling = true)]
    private static extern int NtSetInformationFile(
        SafeFileHandle fileHandle,
        out IoStatusBlock ioStatusBlock,
        IntPtr fileInformation,
        uint length,
        int fileInformationClass);

    [DllImport("ntdll.dll", ExactSpelling = true)]
    private static extern uint RtlNtStatusToDosError(int status);
}
