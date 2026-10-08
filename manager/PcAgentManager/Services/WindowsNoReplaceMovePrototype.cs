using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace PcAgentManager.Services;

/// <summary>
/// Research-only Windows file rename experiment. This is NOT wired to the
/// Agent or Manager UI. The optional approval snapshot performs defensive
/// source/parent/root identity checks, but cannot eliminate the final
/// pathname re-resolution race, so it is NOT production authorization.
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
    /// When supplied, the immutable approval snapshot is checked before and
    /// after the test hook. Validation is NOT atomic with absolute-path rename.
    /// </summary>
    internal static void MoveFileForTest(
        string source,
        string destination,
        Action? beforeNativeRename = null,
        MoveApprovalSnapshotForTest? approved = null,
        string? operationId = null)
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

        if (approved is not null &&
            (!string.Equals(approved.OperationId, operationId, StringComparison.Ordinal)
             || !PathEquals(approved.SourcePath, originalPath)
             || !PathEquals(approved.DestinationPath, destinationPath)))
        {
            throw new InvalidOperationException(
                "Queued move paths differ from the locally approved operation.");
        }

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

        using var rootHandle = approved is null
            ? null
            : OpenFile(
                approved.AllowedRootPath,
                FileReadAttributes | FileTraverse,
                FileFlagBackupSemantics | FileFlagOpenReparsePoint);

        if (approved is not null)
        {
            ValidateApproval(approved, sourceHandle, parentHandle, rootHandle!);
        }

        var utf16Name = Encoding.Unicode.GetBytes(destinationPath);
        if (utf16Name.Length == 0 || utf16Name.Length > 65536)
        {
            throw new ArgumentException("Target name is invalid.");
        }

        // The native kernel operation itself must reject a competing target.
        // The precommit callback is never used by the normal Agent.
        beforeNativeRename?.Invoke();

        if (approved is not null)
        {
            // Detect deterministic parent/source swaps across the test hook.
            // This remains a check-before-use, not a kernel-enforced path lock.
            ValidateApproval(approved, sourceHandle, parentHandle, rootHandle!);
        }

        // FileNameLength excludes the trailing UTF-16 NUL. The Win32
        // wrapper still needs a terminated string in the backing buffer.
        var length = checked(FilenameOffsetX64 + utf16Name.Length + 2);
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
            Marshal.WriteInt16(
                IntPtr.Add(renameInfo, FilenameOffsetX64 + utf16Name.Length),
                0);

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

    /// <summary>
    /// Research-only local approval capture. Caller can present these paths to
    /// a human before later passing this same immutable snapshot to execution.
    /// Captures Windows filesystem object IDs, not merely a string/hash.
    /// It does not authorize commands from the network or persist credentials.
    /// </summary>
    internal static MoveApprovalSnapshotForTest CaptureApprovalForTest(
        string source,
        string destination,
        string allowedRoot,
        string operationId)
    {
        if (!OperatingSystem.IsWindows() || !Environment.Is64BitProcess)
        {
            throw new PlatformNotSupportedException(
                "This experiment is supported only on Windows x64.");
        }

        if (string.IsNullOrWhiteSpace(operationId) || operationId.Length > 128)
        {
            throw new ArgumentException(
                "A bounded operation ID is mandatory for the approval snapshot.",
                nameof(operationId));
        }

        var sourcePath = Path.GetFullPath(source);
        var destinationPath = Path.GetFullPath(destination);
        var rootPath = Path.GetFullPath(allowedRoot);
        var parentPath = Path.GetDirectoryName(destinationPath)
            ?? throw new ArgumentException("Destination needs a parent.");

        if (PathEquals(sourcePath, destinationPath)
            || PathEquals(sourcePath, rootPath)
            || !PathEquals(Path.GetPathRoot(sourcePath)!, Path.GetPathRoot(destinationPath)!))
        {
            throw new InvalidOperationException(
                "Source/destination must be distinct entries on one volume.");
        }

        using var rootHandle = OpenFile(
            rootPath,
            FileReadAttributes | FileTraverse,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint);
        using var sourceHandle = OpenFile(
            sourcePath,
            FileReadAttributes,
            FileFlagOpenReparsePoint);
        using var parentHandle = OpenFile(
            parentPath,
            FileReadAttributes | FileTraverse,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint);

        EnsurePlainFile(sourceHandle);
        EnsurePlainDirectory(rootHandle, "Allowed root");
        EnsurePlainDirectory(parentHandle, "Destination parent");

        var canonicalRoot = FinalPath(rootHandle);
        var canonicalSource = FinalPath(sourceHandle);
        var canonicalParent = FinalPath(parentHandle);

        if (!StrictDescendant(canonicalSource, canonicalRoot)
            || !IsUnderOrEqual(canonicalParent, canonicalRoot))
        {
            throw new InvalidOperationException(
                "Source or destination parent resolves outside the approved root.");
        }

        return new MoveApprovalSnapshotForTest(
            operationId,
            sourcePath,
            destinationPath,
            rootPath,
            canonicalSource,
            canonicalParent,
            canonicalRoot,
            GetIdentity(sourceHandle),
            GetIdentity(parentHandle),
            GetIdentity(rootHandle));
    }

    private static void ValidateApproval(
        MoveApprovalSnapshotForTest approved,
        SafeFileHandle sourceHandle,
        SafeFileHandle parentHandle,
        SafeFileHandle rootHandle)
    {
        EnsurePlainFile(sourceHandle);
        EnsurePlainDirectory(parentHandle, "Destination parent");
        EnsurePlainDirectory(rootHandle, "Allowed root");

        var sourceId = GetIdentity(sourceHandle);
        var parentId = GetIdentity(parentHandle);
        var rootId = GetIdentity(rootHandle);

        if (!sourceId.Equals(approved.SourceIdentity)
            || !SameObject(parentId, approved.ParentIdentity)
            || !SameObject(rootId, approved.RootIdentity))
        {
            throw new InvalidOperationException(
                "Approved source, destination parent, or allowed root identity changed.");
        }

        var sourceFinal = FinalPath(sourceHandle);
        var parentFinal = FinalPath(parentHandle);
        var rootFinal = FinalPath(rootHandle);

        if (!PathEquals(sourceFinal, approved.SourceFinalPath)
            || !PathEquals(parentFinal, approved.ParentFinalPath)
            || !PathEquals(rootFinal, approved.RootFinalPath)
            || !StrictDescendant(sourceFinal, rootFinal)
            || !IsUnderOrEqual(parentFinal, rootFinal))
        {
            throw new InvalidOperationException(
                "Approved canonical source/parent/root location changed.");
        }

        // Detect a swapped pathname even when the original opened handle is
        // still valid. Reject reparse entry and compare the new path's object.
        using var currentSource = OpenFile(
            approved.SourcePath,
            FileReadAttributes,
            FileFlagOpenReparsePoint);
        using var currentParent = OpenFile(
            Path.GetDirectoryName(approved.DestinationPath)!,
            FileReadAttributes | FileTraverse,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint);
        using var currentRoot = OpenFile(
            approved.AllowedRootPath,
            FileReadAttributes | FileTraverse,
            FileFlagBackupSemantics | FileFlagOpenReparsePoint);

        EnsurePlainFile(currentSource);
        EnsurePlainDirectory(currentParent, "Destination parent");
        EnsurePlainDirectory(currentRoot, "Allowed root");

        if (!GetIdentity(currentSource).Equals(sourceId)
            || !SameObject(GetIdentity(currentParent), parentId)
            || !SameObject(GetIdentity(currentRoot), rootId))
        {
            throw new InvalidOperationException(
                "An approved filesystem pathname was replaced.");
        }
    }

    private static void EnsurePlainFile(SafeFileHandle handle)
    {
        if ((GetAttributes(handle) &
             (AttributeDirectory | AttributeReparsePoint)) != 0)
        {
            throw new InvalidOperationException(
                "Only regular non-reparse source files are allowed in the prototype.");
        }
    }

    private static void EnsurePlainDirectory(SafeFileHandle handle, string label)
    {
        var attributes = GetAttributes(handle);

        if ((attributes & AttributeDirectory) == 0
            || (attributes & AttributeReparsePoint) != 0)
        {
            throw new InvalidOperationException(
                label + " must be a non-reparse directory.");
        }
    }

    private static MoveObjectIdentity GetIdentity(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandle(handle, out var info))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        return new MoveObjectIdentity(
            info.VolumeSerialNumber,
            info.FileIndexHigh,
            info.FileIndexLow,
            info.FileSizeHigh,
            info.FileSizeLow,
            info.LastWriteTime.High,
            info.LastWriteTime.Low);
    }

    private static bool SameObject(MoveObjectIdentity left, MoveObjectIdentity right) =>
        left.VolumeSerialNumber == right.VolumeSerialNumber
        && left.FileIndexHigh == right.FileIndexHigh
        && left.FileIndexLow == right.FileIndexLow;

    private static string FinalPath(SafeFileHandle handle)
    {
        var buffer = new StringBuilder(32768);
        var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);

        if (length == 0 || length >= buffer.Capacity)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        var nativePath = buffer.ToString();

        if (!nativePath.StartsWith(@"\\?\", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Unsupported final path format.");
        }

        // The proof of concept is restricted to local DOS paths, not UNC paths.
        var dosPath = nativePath[4..];

        if (!Path.IsPathFullyQualified(dosPath)
            || dosPath.StartsWith("UNC\\", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Network paths are not supported.");
        }

        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(dosPath));
    }

    private static bool PathEquals(string left, string right) =>
        string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(left)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(right)),
            StringComparison.OrdinalIgnoreCase);

    private static bool IsUnderOrEqual(string child, string root)
    {
        var c = Path.TrimEndingDirectorySeparator(Path.GetFullPath(child));
        var r = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));

        return c.Equals(r, StringComparison.OrdinalIgnoreCase)
            || c.StartsWith(
                Path.EndsInDirectorySeparator(r)
                    ? r
                    : r + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase);
    }

    private static bool StrictDescendant(string child, string root) =>
        !PathEquals(child, root) && IsUnderOrEqual(child, root);

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

    internal readonly record struct MoveObjectIdentity(
        uint VolumeSerialNumber,
        uint FileIndexHigh,
        uint FileIndexLow,
        uint FileSizeHigh,
        uint FileSizeLow,
        uint LastWriteTimeHigh,
        uint LastWriteTimeLow);

    internal sealed record MoveApprovalSnapshotForTest(
        string OperationId,
        string SourcePath,
        string DestinationPath,
        string AllowedRootPath,
        string SourceFinalPath,
        string ParentFinalPath,
        string RootFinalPath,
        MoveObjectIdentity SourceIdentity,
        MoveObjectIdentity ParentIdentity,
        MoveObjectIdentity RootIdentity);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeFileTime
    {
        internal uint Low;
        internal uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        internal uint FileAttributes;
        internal NativeFileTime CreationTime;
        internal NativeFileTime LastAccessTime;
        internal NativeFileTime LastWriteTime;
        internal uint VolumeSerialNumber;
        internal uint FileSizeHigh;
        internal uint FileSizeLow;
        internal uint NumberOfLinks;
        internal uint FileIndexHigh;
        internal uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AttributeTagInfo
    {
        internal uint Attributes;
        internal uint ReparseTag;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle fileHandle,
        out ByHandleFileInformation fileInformation);

    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
        SafeFileHandle fileHandle,
        StringBuilder filePath,
        uint filePathSize,
        uint flags);

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
