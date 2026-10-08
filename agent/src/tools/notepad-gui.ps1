$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PcAgentNotepadInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT {
        public ushort wVk, wScan;
        public uint dwFlags, time;
        public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT {
        public uint type;
        public INPUTUNION data;
    }
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError=true)]
    private static extern uint SendInput(uint count, [In] INPUT[] inputs, int size);

    public static void RequireFocused(IntPtr hwnd) {
        if (GetForegroundWindow() != hwnd) throw new InvalidOperationException("Notepad lost foreground focus.");
    }

    private static void Dispatch(INPUT input) {
        if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new InvalidOperationException("Windows rejected an input event.");
    }
    private static void Key(ushort virtualKey, uint flags) {
        var input = new INPUT { type = 1 };
        input.data.ki = new KEYBDINPUT { wVk = virtualKey, dwFlags = flags };
        Dispatch(input);
    }
    public static void UnicodeChar(IntPtr hwnd, char c) {
        RequireFocused(hwnd);
        var down = new INPUT { type = 1 };
        down.data.ki = new KEYBDINPUT { wScan = c, dwFlags = 0x0004 };
        Dispatch(down);
        down.data.ki.dwFlags = 0x0004 | 0x0002;
        Dispatch(down);
    }
    public static void SpecialKey(IntPtr hwnd, ushort virtualKey) {
        RequireFocused(hwnd);
        Key(virtualKey, 0);
        Key(virtualKey, 0x0002);
    }
    public static void Click(IntPtr hwnd, int x, int y) {
        RequireFocused(hwnd);
        if (!SetCursorPos(x, y)) throw new InvalidOperationException("Cannot set mouse position.");
        RequireFocused(hwnd);
        var input = new INPUT { type = 0 };
        input.data.mi = new MOUSEINPUT { dwFlags = 0x0002 };
        Dispatch(input);
        input.data.mi.dwFlags = 0x0004;
        Dispatch(input);
    }
    public static void Scroll(IntPtr hwnd, int x, int y, int delta) {
        RequireFocused(hwnd);
        if (!SetCursorPos(x, y)) throw new InvalidOperationException("Cannot set mouse position.");
        RequireFocused(hwnd);
        var input = new INPUT { type = 0 };
        input.data.mi = new MOUSEINPUT { dwFlags = 0x0800, mouseData = unchecked((uint)delta) };
        Dispatch(input);
    }
    public static void Save(IntPtr hwnd) {
        RequireFocused(hwnd);
        Key(0x11, 0); // Control
        try {
            RequireFocused(hwnd);
            SpecialKey(hwnd, 0x53); // S
        } finally {
            Key(0x11, 0x0002);
        }
    }
}
'@

function Assert-NoProtectedGame {
    if (@([System.Diagnostics.Process]::GetProcessesByName('VALORANT')).Count -gt 0 -or
        @([System.Diagnostics.Process]::GetProcessesByName('VALORANT-Win64-Shipping')).Count -gt 0) {
        throw 'Game Safety: a protected game is running.'
    }
}
Assert-NoProtectedGame
if (-not $env:PC_AGENT_NOTEPAD_ACTION_B64 -or $env:PC_AGENT_NOTEPAD_ACTION_B64.Length -gt 6000) {
    throw 'Invalid bounded action payload.'
}
$raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PC_AGENT_NOTEPAD_ACTION_B64))
$request = ConvertFrom-Json -InputObject $raw
if ($request.action -notin @('click', 'type', 'scroll', 'save')) { throw 'Unsupported action.' }

$windows = @(
    foreach ($p in [System.Diagnostics.Process]::GetProcessesByName('notepad')) {
        try {
            $p.Refresh()
            $hw = $p.MainWindowHandle
            $actualPid = [uint32]0
            if ($hw -ne [IntPtr]::Zero -and
                [PcAgentNotepadInput]::IsWindowVisible($hw) -and
                -not [PcAgentNotepadInput]::IsIconic($hw) -and
                [PcAgentNotepadInput]::GetWindowThreadProcessId($hw, [ref]$actualPid) -ne 0 -and
                $actualPid -eq [uint32]$p.Id) {
                $hw
            }
        } finally { $p.Dispose() }
    }
)
if ($windows.Count -ne 1) { throw 'Exactly one visible Notepad window is required.' }
$target = [IntPtr]$windows[0]
if (-not [PcAgentNotepadInput]::SetForegroundWindow($target)) {
    throw 'Unable to activate the Notepad window.'
}
Start-Sleep -Milliseconds 100
[PcAgentNotepadInput]::RequireFocused($target)
Assert-NoProtectedGame

$client = [PcAgentNotepadInput+RECT]::new()
if (-not [PcAgentNotepadInput]::GetClientRect($target, [ref]$client)) {
    throw 'Cannot determine Notepad client area.'
}
$clientWidth = $client.Right - $client.Left
$clientHeight = $client.Bottom - $client.Top
if ($clientWidth -lt 64 -or $clientHeight -lt 64 -or
    $clientWidth -gt 3840 -or $clientHeight -gt 2160) {
    throw 'Notepad client area is outside supported bounds.'
}

switch ($request.action) {
    'click' {
        $x = [int]$request.x
        $y = [int]$request.y
        if ($x -lt 0 -or $y -lt 0 -or $x -ge $clientWidth -or $y -ge $clientHeight) {
            throw 'Click coordinates must stay within the Notepad client area.'
        }
        $screen = [PcAgentNotepadInput+POINT]::new()
        $screen.X = $x; $screen.Y = $y
        if (-not [PcAgentNotepadInput]::ClientToScreen($target, [ref]$screen)) {
            throw 'Cannot translate Notepad coordinates.'
        }
        [PcAgentNotepadInput]::Click($target, $screen.X, $screen.Y)
    }
    'type' {
        $value = [string]$request.text
        if ($value.Length -lt 1 -or $value.Length -gt 500) {
            throw 'Text length is out of bounds.'
        }
        for ($i = 0; $i -lt $value.Length; $i++) {
            if (($i % 32) -eq 0) { Assert-NoProtectedGame }
            if ($value[$i] -eq [char]13) { continue }
            if ($value[$i] -eq [char]10) {
                [PcAgentNotepadInput]::SpecialKey($target, 13)
            } elseif ($value[$i] -eq [char]9) {
                [PcAgentNotepadInput]::SpecialKey($target, 9)
            } else {
                [PcAgentNotepadInput]::UnicodeChar($target, $value[$i])
            }
        }
    }
    'scroll' {
        $steps = [int]$request.steps
        if ($steps -lt 1 -or $steps -gt 3 -or $request.direction -notin @('up','down')) {
            throw 'Scroll arguments are out of bounds.'
        }
        $center = [PcAgentNotepadInput+POINT]::new()
        $center.X = [int][Math]::Floor($clientWidth / 2)
        $center.Y = [int][Math]::Floor($clientHeight / 2)
        if (-not [PcAgentNotepadInput]::ClientToScreen($target, [ref]$center)) {
            throw 'Cannot translate Notepad coordinates.'
        }
        $delta = $steps * 120
        if ($request.direction -eq 'down') { $delta = -$delta }
        [PcAgentNotepadInput]::Scroll($target, $center.X, $center.Y, $delta)
    }
    'save' {
        [PcAgentNotepadInput]::Save($target)
    }
}
Assert-NoProtectedGame
[Console]::Out.WriteLine((@{
    target = 'notepad'
    action = [string]$request.action
    dispatched = $true
    verified = $false
} | ConvertTo-Json -Compress))
