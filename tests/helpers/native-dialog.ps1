param(
  [Parameter(Mandatory = $true)][string]$TitleLike,
  [string]$AppTitle = '',
  [int]$ShiftTabs = 0,
  [string]$Screenshot = '',
  [int]$ProcessId = 0,
  [int]$KeyDelayMs = 0,
  [int]$TimeoutSeconds = 20,
  [switch]$NoKeys,
  [switch]$ForegroundOnly
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PiGuiNativeRect {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

$shell = New-Object -ComObject WScript.Shell
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$activated = $false
while ((Get-Date) -lt $deadline) {
  if ($shell.AppActivate($TitleLike)) { $activated = $true; break }
  if ($AppTitle -and $shell.AppActivate($AppTitle)) { $activated = $true; break }
  if ($ProcessId -gt 0 -and $shell.AppActivate($ProcessId)) { $activated = $true; break }
  Start-Sleep -Milliseconds 150
}
Start-Sleep -Milliseconds 500

if ($Screenshot) {
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $capture = New-Object System.Drawing.Rectangle($screen.Left, $screen.Top, $screen.Width, $screen.Height)
  if ($ForegroundOnly) {
    $rect = New-Object PiGuiNativeRect+RECT
    if ([PiGuiNativeRect]::GetWindowRect([PiGuiNativeRect]::GetForegroundWindow(), [ref]$rect)) {
      $left = [Math]::Max($screen.Left, $rect.Left)
      $top = [Math]::Max($screen.Top, $rect.Top)
      $right = [Math]::Min($screen.Right, $rect.Right)
      $bottom = [Math]::Min($screen.Bottom, $rect.Bottom)
      if ($right -gt $left -and $bottom -gt $top) {
        $capture = New-Object System.Drawing.Rectangle($left, $top, ($right - $left), ($bottom - $top))
      }
    }
  }
  $bitmap = New-Object System.Drawing.Bitmap($capture.Width, $capture.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($capture.Left, $capture.Top, 0, 0, $bitmap.Size)
  $bitmap.Save($Screenshot, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
  "screenshot: $Screenshot ($($capture.Width) x $($capture.Height))"
}

if (-not $activated) { throw "window not activated: $TitleLike" }
if ($NoKeys) { return }
if ($KeyDelayMs -gt 0) { Start-Sleep -Milliseconds $KeyDelayMs }
for ($i = 0; $i -lt $ShiftTabs; $i++) {
  $shell.SendKeys('+{TAB}')
  Start-Sleep -Milliseconds 120
}
$shell.SendKeys('{ENTER}')
"activated: $TitleLike; shiftTabs=$ShiftTabs"
