# Fixed candidate file protocol. No shell, path commands, privilege changes or metadata restoration.
$ErrorActionPreference='Stop'
function Line { $s=[Text.StringBuilder]::new();while($true){$c=[Console]::In.Read();if($c -lt 0){throw 'eof'};if($c -eq 10){return $s.ToString()};if($s.Length -ge 24000000){throw 'budget'};[void]$s.Append([char]$c)} }
function Emit($ok,$value){[Console]::Out.WriteLine((@{token=$a.token;ok=$ok;value=$value}|ConvertTo-Json -Compress -Depth 12));[Console]::Out.Flush()}
$writer=$null
try{
 $a=(Line)|ConvertFrom-Json
 if($a.version -ne 1 -or $a.token -notmatch '^[a-f0-9]{64}$' -or @($a.files).Count -gt 512 -or @($a.pins).Count -gt 2048){throw 'shape'}
 Add-Type -TypeDefinition @'
using System;using System.IO;using System.Text;using System.Collections.Generic;using System.Security.Cryptography;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public sealed class CandidateWriter:IDisposable {
 [StructLayout(LayoutKind.Sequential,Pack=4)] public struct Info {public uint Attributes;public long Creation,Access,Write;public uint Volume,SizeHigh,SizeLow,Links,High,Low;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr security,uint d,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder b,uint n,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(SafeFileHandle h,byte[] b,uint n,out uint got,IntPtr over);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(SafeFileHandle h,byte[] b,uint n,out uint got,IntPtr over);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle h,long n,out long actual,uint method);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetEndOfFile(SafeFileHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int type,IntPtr b,uint size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumePathNameW(string p,StringBuilder b,uint n);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationW(string p,StringBuilder label,uint n,out uint serial,out uint max,out uint flags,StringBuilder fs,uint len);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string p);
 sealed class Item {public string Path,Id,Before,After,Backup,Restore;public byte[] Bytes;public SafeFileHandle Handle;public bool Done;}
 readonly List<Item> items=new List<Item>();readonly Dictionary<string,SafeFileHandle> parents=new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
 readonly List<SafeFileHandle> pins=new List<SafeFileHandle>();readonly string root,recovery;
 static void Check(bool b){if(!b)throw new IOException("native_refused");}
 static Info Stat(SafeFileHandle h){Info i;Check(GetFileInformationByHandle(h,out i));return i;}
 static string Id(Info i){return (((ulong)i.High<<32)|i.Low).ToString();}
 public static string Hash(byte[] b){using(var s=SHA256.Create())return BitConverter.ToString(s.ComputeHash(b)).Replace("-","").ToLowerInvariant();}
 static void Canonical(SafeFileHandle h,string p){var b=new StringBuilder(8192);uint n=GetFinalPathNameByHandleW(h,b,8192,0);Check(n>0&&n<8192&&String.Equals(b.ToString(),"\\\\?\\"+p,StringComparison.OrdinalIgnoreCase));}
 static SafeFileHandle Open(string p,uint access,uint create){var h=CreateFileW(p,access,1,IntPtr.Zero,create,0x02200000,IntPtr.Zero);if(h.IsInvalid){h.Dispose();throw new IOException("native_open_refused");}return h;}
 static void Seek(SafeFileHandle h,long n){long actual;Check(SetFilePointerEx(h,n,out actual,0)&&actual==n);}
 static byte[] Read(SafeFileHandle h){var i=Stat(h);Check((i.Attributes&~(uint)(32|128))==0&&i.Links==1&&i.SizeHigh==0&&i.SizeLow<=1048576);Seek(h,0);var b=new byte[i.SizeLow];int at=0;while(at<b.Length){var chunk=new byte[Math.Min(65536,b.Length-at)];uint got;Check(ReadFile(h,chunk,(uint)chunk.Length,out got,IntPtr.Zero)&&got>0);Buffer.BlockCopy(chunk,0,b,at,(int)got);at+=(int)got;}return b;}
 static void Write(SafeFileHandle h,byte[] b){Seek(h,0);int at=0;while(at<b.Length){var chunk=new byte[Math.Min(65536,b.Length-at)];Buffer.BlockCopy(b,at,chunk,0,chunk.Length);uint got;/*CANDIDATE_WRITE*/Check(WriteFile(h,chunk,(uint)chunk.Length,out got,IntPtr.Zero)&&got>0);at+=(int)got;}Seek(h,b.Length);Check(SetEndOfFile(h));Check(FlushFileBuffers(h));Check(Hash(Read(h))==Hash(b));}
 static void Rename(SafeFileHandle h,string to){byte[] name=Encoding.Unicode.GetBytes(to);int offset=IntPtr.Size==8?20:12;IntPtr b=Marshal.AllocHGlobal(offset+name.Length+2);try{for(int i=0;i<offset+name.Length+2;i++)Marshal.WriteByte(b,i,0);Marshal.WriteInt32(b,IntPtr.Size==8?16:8,name.Length);Marshal.Copy(name,0,IntPtr.Add(b,offset),name.Length);/*CANDIDATE_RENAME*/Check(SetFileInformationByHandle(h,3,b,(uint)(offset+name.Length+2)));Canonical(h,to);}finally{Marshal.FreeHGlobal(b);}}
 void Parents(string p){string d=Path.GetDirectoryName(p);while(d!=null){if(!parents.ContainsKey(d)){var h=CreateFileW(d,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);Check(!h.IsInvalid);parents.Add(d,h);Check((Stat(h).Attributes&0x410)==0x10);Canonical(h,d);}var next=Directory.GetParent(d);d=next==null?null:next.FullName;}}
 string Target(string relative){Check(!String.IsNullOrEmpty(relative)&&relative.Length<=512&&!Path.IsPathRooted(relative)&&relative.IndexOfAny(new[]{'\\',':','\0'})<0);foreach(string n in relative.Split('/'))Check(n!=""&&n!="."&&n!=".."&&n.ToLowerInvariant()!=".git"&&!n.EndsWith(".")&&!n.EndsWith(" "));string p=Path.GetFullPath(Path.Combine(root,relative));Check(p.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase));Parents(p);return p;}
 public CandidateWriter(string r,string recover,string gatePath){root=Path.GetFullPath(r);recovery=Path.GetFullPath(recover);Check(!root.StartsWith("\\\\")&&!recovery.StartsWith("\\\\")&&!recovery.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase));Parents(Path.Combine(root,"pin"));Parents(Path.Combine(recovery,"pin"));var gate=CreateFileW(gatePath,0xc0000000,0,IntPtr.Zero,4,0x02200000,IntPtr.Zero);Check(!gate.IsInvalid);pins.Add(gate);Check((Stat(gate).Attributes&0x410)==0&&Stat(gate).Links==1);var vol=new StringBuilder(8192);var fs=new StringBuilder(64);uint serial,max,flags;Check(GetVolumePathNameW(root,vol,8192)&&GetDriveTypeW(vol.ToString())==3&&GetVolumeInformationW(vol.ToString(),null,0,out serial,out max,out flags,fs,64)&&fs.ToString()=="NTFS");}
 public void Pin(string p,string expected){Parents(p);var h=Open(p,0x80000000,3);pins.Add(h);Canonical(h,Path.GetFullPath(p));Check(Id(Stat(h))==expected);Read(h);}
 public void Add(string relative,string expected,string before,string after,string bytes,int index,string restore){expected=String.IsNullOrEmpty(expected)?null:expected;before=String.IsNullOrEmpty(before)?null:before;after=String.IsNullOrEmpty(after)?null:after;bytes=after==null?null:bytes;string p=Target(relative);Check(!items.Exists(i=>String.Equals(i.Path,p,StringComparison.OrdinalIgnoreCase)));restore=String.IsNullOrEmpty(restore)?null:Path.GetFullPath(restore);if(restore!=null){Check(restore.StartsWith(Directory.GetParent(recovery).FullName+"\\",StringComparison.OrdinalIgnoreCase)&&!File.Exists(p)&&!Directory.Exists(p));Parents(restore);}var x=new Item{Restore=restore,Path=p,Id=expected,Before=before,After=after,Bytes=bytes==null?null:Convert.FromBase64String(bytes),Backup=Path.Combine(recovery,"deleted-"+index)};items.Add(x);Check(restore!=null|| (x.Bytes==null?after==null:x.Bytes.Length<=1048576&&Hash(x.Bytes)==after));if(expected!=null){x.Handle=Open(restore??p,after==null||restore!=null?0x80010000u:0xc0000000u,3);Canonical(x.Handle,restore??p);Check(Id(Stat(x.Handle))==expected&&Hash(Read(x.Handle))==before);if(after==null)Check(Stat(x.Handle).Volume==Stat(parents[recovery]).Volume);}else{Check(before==null&&after!=null&&!File.Exists(p)&&!Directory.Exists(p));}}
 public Dictionary<string,object> Apply(int index){Check(index>=0&&index<items.Count);var x=items[index];Check(!x.Done);if(x.Handle!=null){Canonical(x.Handle,x.Restore??x.Path);Check(Id(Stat(x.Handle))==x.Id&&Hash(Read(x.Handle))==x.Before);}if(x.Restore!=null){Rename(x.Handle,x.Path);x.Done=true;return Result(index);}if(x.After==null){Rename(x.Handle,x.Backup);x.Done=true;return Result(index);}if(x.Handle==null){x.Handle=Open(x.Path,0xc0010000u,1);x.Id=Id(Stat(x.Handle));Canonical(x.Handle,x.Path);}Write(x.Handle,x.Bytes);x.Done=true;return Result(index);}
 public Dictionary<string,object> Result(int index){var x=items[index];return new Dictionary<string,object>{{"index",index},{"identity",x.Id},{"digest",x.Handle==null?null:Hash(Read(x.Handle))},{"deleted",x.Done&&x.After==null}};}
 public void Dispose(){foreach(var x in items)if(x.Handle!=null)x.Handle.Dispose();foreach(var h in pins)h.Dispose();foreach(var h in parents.Values)h.Dispose();}
}
'@
 $writer=[CandidateWriter]::new([string]$a.root,[string]$a.recovery,[string]$a.gate)
 foreach($p in @($a.pins)){$writer.Pin([string]$p.path,[string]$p.identity)}
 $i=0;foreach($f in @($a.files)){$writer.Add([string]$f.path,$f.identity,$f.before,$f.after,$f.bytes,$i,$f.restore);$i++}
 Emit $true @{state='ready'}
 $next=0
 while($true){$b=(Line)|ConvertFrom-Json;if($b.token -cne $a.token){throw 'binding'}
  if($b.command -ceq 'close'){break}
  if($b.command -ceq 'apply' -and $b.index -is [int] -and $b.index -eq $next){$result=$writer.Apply($next);$next++;Emit $true $result}else{throw 'command'}
 }
}catch{Emit $false @{code='candidate_native_refused'}}finally{if($writer){$writer.Dispose()}}
