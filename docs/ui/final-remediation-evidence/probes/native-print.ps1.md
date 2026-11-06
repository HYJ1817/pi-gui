# 本次 TEMP 探针原文

仅为本次证据留档；路径绑定本轮 TEMP 目录。正式复现先替换输出目录和仓库路径，保持临时数据隔离。

```
param([string]$WindowHandle,[uint32]$ExpectedPid,[string]$OutputFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class OwnPrint {
[StructLayout(LayoutKind.Sequential)]public struct R{public int L,T,Ri,B;}
[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr p);
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")]public static extern bool GetClientRect(IntPtr h,out R r);
[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
}
'@
[void][OwnPrint]::SetProcessDpiAwarenessContext([IntPtr](-4))
$target=[IntPtr]::new([long]::Parse($WindowHandle));[uint32]$owner=0
[void][OwnPrint]::GetWindowThreadProcessId($target,[ref]$owner)
if($owner -ne $ExpectedPid -or -not [OwnPrint]::IsWindowVisible($target)){throw 'identity not verified'}
$rect=New-Object OwnPrint+R;[void][OwnPrint]::GetClientRect($target,[ref]$rect)
$bitmap=[Drawing.Bitmap]::new($rect.Ri,$rect.B);$graphics=[Drawing.Graphics]::FromImage($bitmap);$hdc=$graphics.GetHdc()
try{$ok=[OwnPrint]::PrintWindow($target,$hdc,3)}finally{$graphics.ReleaseHdc($hdc);$graphics.Dispose()}
try{
$colors=[Collections.Generic.HashSet[int]]::new()
for($y=0;$y -lt $bitmap.Height;$y+=20){for($x=0;$x -lt $bitmap.Width;$x+=20){[void]$colors.Add($bitmap.GetPixel($x,$y).ToArgb())}}
if(-not $ok -or $colors.Count -lt 16){throw 'native render is empty or unproven'}
$bitmap.Save($OutputFile,[Drawing.Imaging.ImageFormat]::Png)
@{saved=$true;method='PrintWindow CLIENTONLY RENDERFULLCONTENT';expectedPid=$ExpectedPid;pixelWidth=$bitmap.Width;pixelHeight=$bitmap.Height;sampleColors=$colors.Count}|ConvertTo-Json -Compress
}finally{$bitmap.Dispose()}


```
