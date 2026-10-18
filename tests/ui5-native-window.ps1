param([string]$WindowHandle,[uint32]$ExpectedPid,[string]$OutputFile)
# Own-window screen capture only. Never save if identity, visibility, desktop
# access, or coverage is uncertain. A refusal is evidence, not a pass.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class UI5Capture {
 [StructLayout(LayoutKind.Sequential)]public struct RECT{public int L,T,R,B;}
 [StructLayout(LayoutKind.Sequential)]public struct POINT{public int X,Y;public POINT(int x,int y){X=x;Y=y;}}
 [DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr p);
 [DllImport("user32.dll")]public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]public static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")]public static extern bool GetClientRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")]public static extern bool ClientToScreen(IntPtr h,ref POINT p);
 [DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr h,uint f);
 [DllImport("user32.dll")]public static extern IntPtr GetWindow(IntPtr h,uint f);
 [DllImport("dwmapi.dll")]public static extern int DwmGetWindowAttribute(IntPtr h,int a,out int v,int n);
 public static bool Owned(IntPtr h,uint pid){uint p;int c;return IsWindow(h)&&GetWindowThreadProcessId(h,out p)!=0&&p==pid&&IsWindowVisible(h)&&DwmGetWindowAttribute(h,14,out c,4)==0&&c==0;}
 public static bool Covered(IntPtr h,int l,int t,int w,int z){
  for(var p=GetWindow(h,3);p!=IntPtr.Zero;p=GetWindow(p,3)){if(!IsWindowVisible(p))continue;int c;DwmGetWindowAttribute(p,14,out c,4);if(c!=0)continue;RECT r;if(GetWindowRect(p,out r)&&r.L<l+w&&r.R>l&&r.T<t+z&&r.B>t)return false;}
  for(int y=4;y<z-4;y+=16)for(int x=4;x<w-4;x+=16)if(GetAncestor(WindowFromPoint(new POINT(l+x,t+y)),2)!=h)return false;
  return true;
 }
}
'@
[void][UI5Capture]::SetProcessDpiAwarenessContext([IntPtr](-4))
$target=[IntPtr]::new([long]::Parse($WindowHandle))
$rect=New-Object UI5Capture+RECT
$point=New-Object UI5Capture+POINT(0,0)
$saved=$false
$width=0;$height=0
$reason='identity_visibility_or_coverage_unproven'
if([UI5Capture]::Owned($target,$ExpectedPid) -and [UI5Capture]::GetClientRect($target,[ref]$rect) -and [UI5Capture]::ClientToScreen($target,[ref]$point)){
 $width=$rect.R;$height=$rect.B
 if($width -gt 0 -and $height -gt 0 -and [UI5Capture]::Covered($target,$point.X,$point.Y,$width,$height)){
  $bitmap=[Drawing.Bitmap]::new($width,$height);$graphics=[Drawing.Graphics]::FromImage($bitmap)
  try{
   $graphics.CopyFromScreen($point.X,$point.Y,0,0,[Drawing.Size]::new($width,$height))
   if([UI5Capture]::Owned($target,$ExpectedPid) -and [UI5Capture]::Covered($target,$point.X,$point.Y,$width,$height)){
    $bitmap.Save($OutputFile,[Drawing.Imaging.ImageFormat]::Png);$saved=$true;$reason='owned_client_area_including_native_caption_overlay'
   }
  }finally{$graphics.Dispose();$bitmap.Dispose()}
 }
}
@{saved=$saved;reason=$reason;method='CopyFromScreen';includes='owned client area only; native hidden-titlebar overlay is inside client';expectedPid=$ExpectedPid;windowDpi=[UI5Capture]::GetDpiForWindow($target);pixelWidth=$width;pixelHeight=$height} | ConvertTo-Json -Compress
