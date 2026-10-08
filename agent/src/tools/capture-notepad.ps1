$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PcAgentWindowCapture {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
}
'@
function Assert-GameNotRunning {
    if (@([System.Diagnostics.Process]::GetProcessesByName('VALORANT')).Count -gt 0 -or
        @([System.Diagnostics.Process]::GetProcessesByName('VALORANT-Win64-Shipping')).Count -gt 0) {
        throw 'Protected game is running.'
    }
}
Assert-GameNotRunning
$candidates = @(
    foreach ($app in [System.Diagnostics.Process]::GetProcessesByName('notepad')) {
        try {
            $app.Refresh()
            $handle = $app.MainWindowHandle
            $realPid = [uint32]0
            if ($handle -ne [IntPtr]::Zero -and
                [PcAgentWindowCapture]::IsWindowVisible($handle) -and
                -not [PcAgentWindowCapture]::IsIconic($handle) -and
                [PcAgentWindowCapture]::GetWindowThreadProcessId($handle, [ref]$realPid) -ne 0 -and
                $realPid -eq [uint32]$app.Id) {
                $handle
            }
        } finally { $app.Dispose() }
    }
)
if ($candidates.Count -ne 1) { throw 'Exactly one visible Notepad window is required.' }
$hwnd = [IntPtr]$candidates[0]
$rect = [PcAgentWindowCapture+RECT]::new()
if (-not [PcAgentWindowCapture]::GetWindowRect($hwnd, [ref]$rect)) { throw 'Cannot read Notepad bounds.' }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 64 -or $height -lt 64 -or $width -gt 3840 -or $height -gt 2160) {
    throw 'Notepad dimensions are outside capture limits.'
}
$source = [System.Drawing.Bitmap]::new($width, $height)
try {
    $graphics = [System.Drawing.Graphics]::FromImage($source)
    try {
        $hdc = $graphics.GetHdc()
        try {
            if (-not [PcAgentWindowCapture]::PrintWindow($hwnd, $hdc, 2)) {
                if (-not [PcAgentWindowCapture]::PrintWindow($hwnd, $hdc, 0)) {
                    throw 'Notepad did not support window-only capture.'
                }
            }
        } finally { $graphics.ReleaseHdc($hdc) }
    } finally { $graphics.Dispose() }
    Assert-GameNotRunning
    $scale = [Math]::Min(1.0, [Math]::Min(960.0 / $width, 720.0 / $height))
    $outWidth = [int][Math]::Max(1, [Math]::Floor($width * $scale))
    $outHeight = [int][Math]::Max(1, [Math]::Floor($height * $scale))
    $scaled = [System.Drawing.Bitmap]::new($outWidth, $outHeight)
    try {
        $draw = [System.Drawing.Graphics]::FromImage($scaled)
        try { $draw.DrawImage($source, 0, 0, $outWidth, $outHeight) }
        finally { $draw.Dispose() }
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
            Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
        if ($null -eq $codec) { throw 'JPEG encoder unavailable.' }
        $encoderParams = [System.Drawing.Imaging.EncoderParameters]::new(1)
        try {
            $encoderParams.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new(
                [System.Drawing.Imaging.Encoder]::Quality, [long]65)
            $stream = [System.IO.MemoryStream]::new()
            try {
                $scaled.Save($stream, $codec, $encoderParams)
                if ($stream.Length -gt 350000) { throw 'Captured image exceeded limit.' }
                $payload = @{
                    mime_type = 'image/jpeg'
                    image_base64 = [Convert]::ToBase64String($stream.ToArray())
                    width = $outWidth
                    height = $outHeight
                    target = 'notepad'
                }
                [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))
            } finally { $stream.Dispose() }
        } finally { $encoderParams.Dispose() }
    } finally { $scaled.Dispose() }
} finally { $source.Dispose() }
