<#
Capture one virtual-desktop region to a PNG file.

The ball asks PowerShell for the pixels because this exact path is already proven
on this machine: `CopyFromScreen` against the virtual desktop (3000x1920 at
(-1080,-418), 96 DPI, no scaling) returns real screen content. The process is
made per-monitor DPI aware first so the rectangle it is handed is interpreted in
the same physical pixels Electron laid its overlay windows out in.

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File capture.ps1 `
    -X -1080 -Y -418 -Width 3000 -Height 1920 -Out C:\path\shot.png
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$Width,
  [Parameter(Mandatory = $true)][int]$Height,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'

# Per-monitor-v2 DPI awareness. Without this a scaled desktop would report and
# capture in logical pixels, and the selection rectangle would be wrong by the
# scale factor.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DpiAwareness {
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("shcore.dll")] private static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  public static void Enable() {
    // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == -4
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    try { if (SetProcessDpiAwareness(2) == 0) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }
}
'@ -ErrorAction SilentlyContinue
try { [DpiAwareness]::Enable() } catch { }

Add-Type -AssemblyName System.Drawing

if ($Width -lt 1 -or $Height -lt 1) { throw "capture: refusing a ${Width}x${Height} region" }

$bitmap = New-Object System.Drawing.Bitmap $Width, $Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size $Width, $Height), [System.Drawing.CopyPixelOperation]::SourceCopy)
  } finally { $graphics.Dispose() }

  $directory = Split-Path -Parent $Out
  if ($directory -and -not (Test-Path $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
  $bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $bitmap.Dispose() }

# Machine-readable receipt for the caller.
Write-Output ("OK {0} {1}x{2}" -f $Out, $Width, $Height)
