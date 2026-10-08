using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace PcAgentManager.Services;

/// <summary>
/// Research-only Windows file rename experiment. This is NOT wired to the
/// Agent or Manager UI, and provides NO allowed-root/approval enforcement.
/// It must not be promoted to a production command until Issue #27 is closed.
/// Win32 FileRenameInfo with a non-NULL RootDirectory fails with error 87
/// on our CI runner, so this experiment uses a full destination path.
/// This intentionally DOES NOT anchor the destination parent against races.
/// </summary>
internal static class WindowsNoReplaceMovePrototype
{
    private const uint DeleteAccess = 0x00010000;
    private const uint FileReadAttributes = 0x00000080;
    private const uint FileTraverse = 0x00000020;
    private const uint ShareReadWriteDelete = 0x00000007;
    private const uint OpenExisting = 3;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint AttributeDirectory = 0x00000010;
    private const uint AttributeReparsePoint = 0x00000400;

    // FILE_INFO_BY_HANDLE_CLASS: FileRenameInfo = 3, FileAttributeTagInfo = 9
    private const int FileRenameInfo = 3;
    private const int FileAttributeTagInfo = 9;

    // x64 FILE_RENAME_INFO layout:
    // 0: 4-byte ReplaceIfExists(FALSE)
    // 8: 8-byte RootDirectory
    // 16: 4-byte FileNameLength
    // 20: UTF-16 filename without a required trailing NUL.
    private const int FilenameOffsetX64 = 20;

    /// <summary>
    /// Test-only primitive: renames the opened source file without replacing an
    /// existing target. Deliberately has no security policy or remote interface.
    /// The callback allows the regression test to create a competing target
    /// precisely before the native filesystem call.
    /// </summary>
    internal static void MoveFileForTest(
        string source,
        string destination,
        Action? beforeNativeRename = null)
    {
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess)
        {
            throw new PlatformNotSupportedException(
                "This experiment is supported only on Windows x64.");
        }

        var originalPath = Path.GetFullPath(source);
        var destinationPath = Path.GetFullPath(destination);
        var destinationName = Path.GetFileName(destinationPath);
        var destinationDirectory = Path.GetDirectoryName(destinationPath);

        if (string.IsNullOrWhiteSpace(destinationName)
            || string.IsNullOrWhiteSpace(destinationDirectory)
            || string.Equals(originalPath, destinationPath, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(
                Path.GetPathRoot(originalPath),
                Path.GetPathRoot(destinationPath),
                StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException(
                "Source and target must be distinct paths on one volume.");
        }

        using var sourceHandle = OpenFile(
            originalPath,
            DeleteAccess | FileReadAttributes,
            FileFlagOpenReparsePoint);

        using var parentHandle = OpenFile(
            destinationDirectory,
            FileReadAttributes | FileTraverse,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint);

        var sourceAttributes = GetAttributes(sourceHandle);
        var parentAttributes = GetAttributes(parentHandle);

        if ((sourceAttributes & (AttributeDirectory | AttributeReparsePoint)) != 0)
        {
            throw new InvalidOperationException(
                "Prototype accepts regular files only, never source links or directories.");
        }

        if ((parentAttributes & AttributeDirectory) == 0
            || (parentAttributes & AttributeReparsePoint) != 0)
        {
            throw new InvalidOperationException(
                "Target parent must be a normal non-reparse directory.");
        }

        var utf16Name = Encoding.Unicode.GetBytes(destinationPath);
        if (utf16Name.Length == 0 || utf16Name.Length > 65536)
        {
            throw new ArgumentException("Target name is invalid.");
        }

        // The native kernel operation itself must reject a competing target.
        // The precommit callback is never used by the normal Agent.
        beforeNativeRename?.Invoke();

        var length = checked(FilenameOffsetX64 + utf16Name.Length);
        var renameInfo = Marshal.AllocHGlobal(length);

        try
        {
            // ReplaceIfExists = FALSE; there is deliberately no replace flag.
            Marshal.WriteInt32(renameInfo, 0, 0);
            // Win32 FileRenameInfo currently rejects RootDirectory handles
            // on tested Windows versions (ERROR_INVALID_PARAMETER = 87).
            // This is only a no-replace proof of concept. A production
            // solution must resolve the parent race using a supported API.
            Marshal.WriteIntPtr(renameInfo, 8, IntPtr.Zero);
            Marshal.WriteInt32(renameInfo, 16, utf16Name.Length);
            Marshal.Copy(
                utf16Name,
                0,
                IntPtr.Add(renameInfo, FilenameOffsetX64),
                utf16Name.Length);

            if (!SetFileInformationByHandle(
                    sourceHandle,
                    FileRenameInfo,
                    renameInfo,
                    (uint)length))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            Marshal.FreeHGlobal(renameInfo);
        }
    }

    private static SafeFileHandle OpenFile(
        string fileName,
        uint access,
        uint flags)
    {
        var handle = CreateFileW(
            fileName,
            access,
            ShareReadWriteDelete,
            IntPtr.Zero,
            OpenExisting,
            flags,
            IntPtr.Zero);

        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }

        return handle;
    }

    private static uint GetAttributes(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandleEx(
                handle,
                FileAttributeTagInfo,
                out var info,
                (uint)Marshal.SizeOf<AttributeTagInfo>()))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        return info.Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AttributeTagInfo
    {
        internal uint Attributes;
        internal uint ReparseTag;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle fileHandle,
        int fileInformationClass,
        out AttributeTagInfo fileInformation,
        uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle fileHandle,
        int fileInformationClass,
        IntPtr fileInformation,
        uint bufferSize);
}
