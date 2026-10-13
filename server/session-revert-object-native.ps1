# D1: read-only observation only. No privilege adjustment or metadata setters.
$ErrorActionPreference='Stop'
try {
 $inputText=''; $chunk=New-Object char[] 1024
 while(($read=[Console]::In.Read($chunk,0,$chunk.Length)) -gt 0){$inputText+=New-Object string($chunk,0,$read);if($inputText.Length -gt 16384){throw 'budget'}}
 $request=$inputText|ConvertFrom-Json
 if($request.mode -ne 'observe'){throw 'mode'}
 $root=[IO.Path]::GetFullPath([string]$request.root)
 $relative=[string]$request.relativePath
 if($root.StartsWith('\\') -or $relative.Length -gt 4096 -or [IO.Path]::IsPathRooted($relative) -or $relative -match '[\x00-\x1f\x7f:]' -or @([regex]::Split($relative,'[\\/]')|Where-Object {$_ -in @('','..','.')}).Count){throw 'path'}
 $target=[IO.Path]::GetFullPath([IO.Path]::Combine($root,$relative))
 if(!$target.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'path'}
 Add-Type -TypeDefinition @'
using System; using System.IO; using System.Text; using System.Collections.Generic; using System.Diagnostics; using System.Security.Cryptography; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public class ObjectObservation {
 [StructLayout(LayoutKind.Sequential)] public struct Time {public uint Low,High; public override string ToString(){return (((ulong)High<<32)|Low).ToString();}}
 [StructLayout(LayoutKind.Sequential)] public struct Info {public uint Attributes;public Time Creation,Access,Write;public uint Volume,SizeHigh,SizeLow,Links,IdHigh,IdLow;}
 [StructLayout(LayoutKind.Sequential)] public struct IoStatus {public IntPtr Status;public UIntPtr Information;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct StreamInfo {public long Size;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=296)] public string Name;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(SafeFileHandle h,byte[] b,uint length,out uint count,IntPtr offset);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder b,uint n,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumePathNameW(string path,StringBuilder volume,uint n);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationW(string root,StringBuilder label,uint n,out uint serial,out uint max,out uint flags,StringBuilder fs,uint length);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstStreamW(string path,int level,out StreamInfo data,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool FindNextStreamW(IntPtr find,out StreamInfo data);
 [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr find);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationFile(SafeFileHandle h,out IoStatus status,out uint eaSize,uint length,int type);
 [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle h,int type,uint fields,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor,uint revision,uint fields,out IntPtr text,out uint length);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
 static Dictionary<string,object> Row(params object[] fields){var r=new Dictionary<string,object>();for(int i=0;i<fields.Length;i+=2)r[(string)fields[i]]=fields[i+1];return r;}
 public static string Digest(byte[] b){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(b)).Replace("-","").ToLowerInvariant();}
 static string Id(Info i){return i.Volume.ToString("x8")+":"+i.IdHigh.ToString("x8")+i.IdLow.ToString("x8");}
 static Info Information(SafeFileHandle h){Info i;if(!GetFileInformationByHandle(h,out i))throw new IOException("information");return i;}
 static SafeFileHandle Open(string path,uint access){var h=CreateFileW(path,access,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);if(h.IsInvalid){h.Dispose();throw new IOException("open");}return h;}
 static string Descriptor(SafeFileHandle h,uint fields){IntPtr owner,group,dacl,sacl,sd,text;uint n;if(GetSecurityInfo(h,1,fields,out owner,out group,out dacl,out sacl,out sd)!=0)throw new IOException("security");try{if(!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd,1,fields,out text,out n)||n>8192)throw new IOException("descriptor");try{return Marshal.PtrToStringUni(text);}finally{LocalFree(text);}}finally{LocalFree(sd);}}
 static void Canonical(SafeFileHandle h,string path){var b=new StringBuilder(8192);uint n=GetFinalPathNameByHandleW(h,b,8192,0);if(n==0||n>=8192||!String.Equals(b.ToString(),"\\\\?\\"+Path.GetFullPath(path),StringComparison.OrdinalIgnoreCase))throw new IOException("canonical");}
 public static Dictionary<string,object> Observe(string path) {
  var watch=Stopwatch.StartNew();var pins=new List<SafeFileHandle>();var parents=new List<Dictionary<string,object>>();var locations=new List<string>();
  try{
   string parent=Path.GetDirectoryName(path);while(parent!=null){if(locations.Count>=128)throw new IOException("depth");locations.Add(parent);var next=Directory.GetParent(parent);parent=next==null?null:next.FullName;}locations.Reverse();
   foreach(var location in locations){var p=Open(location,0x80);pins.Add(p);var pi=Information(p);if((pi.Attributes&0x400)!=0||(pi.Attributes&0x10)==0)throw new IOException("parent");Canonical(p,location);parents.Add(Row("id",Id(pi),"binding",Digest(Encoding.UTF8.GetBytes(location.ToLowerInvariant())),"reparse",false));}
   using(var file=Open(path,0x120089)) {
    var before=Information(file);Canonical(file,path);if((before.Attributes&0x410)!=0||before.Links!=1||before.SizeHigh!=0||before.SizeLow>2097152)throw new IOException("object");
    byte[] bytes=new byte[(int)before.SizeLow];int offset=0;while(offset<bytes.Length){if(watch.ElapsedMilliseconds>15000)throw new IOException("time");byte[] chunk=new byte[Math.Min(65536,bytes.Length-offset)];uint count;if(!ReadFile(file,chunk,(uint)chunk.Length,out count,IntPtr.Zero)||count==0)throw new IOException("read");Buffer.BlockCopy(chunk,0,bytes,offset,(int)count);offset+=(int)count;}
    string encoding="utf8";try{new UTF8Encoding(false,true).GetString(bytes);foreach(byte c in bytes)if(c==0){encoding="unsupported";break;}}catch{encoding="unsupported";}
    var volume=new StringBuilder(8192);var fileSystem=new StringBuilder(64);uint serial,max,flags;if(!GetVolumePathNameW(path,volume,8192)||!GetVolumeInformationW(volume.ToString(),null,0,out serial,out max,out flags,fileSystem,64))throw new IOException("volume");
    var streams=Row("state","unavailable","names",null);StreamInfo si;IntPtr find=FindFirstStreamW(path,0,out si,0);
    if(find!=new IntPtr(-1)){try{var names=new List<string>();bool more=true;while(more){if(names.Count>=32||watch.ElapsedMilliseconds>15000)throw new IOException("stream_budget");names.Add(si.Name);more=FindNextStreamW(find,out si);if(!more&&Marshal.GetLastWin32Error()!=38)throw new IOException("streams");}names.Sort(StringComparer.Ordinal);streams=Row("state","known","names",names);}finally{FindClose(find);}}
    IoStatus io;uint ea;int status=NtQueryInformationFile(file,out io,out ea,4,7);var eaRow=status<0?Row("state","unavailable","bytes",null):Row("state","known","bytes",ea);
    string sddl=null;try{sddl=Descriptor(file,7);}catch{}var security=Row("descriptor",sddl,"sacl",Row("state","unavailable","value",null));
    // Only query existing token rights. Never enable/request SeSecurityPrivilege.
    try{using(var audit=Open(path,0x01020080)){if(Id(Information(audit))!=Id(before))throw new IOException("audit_identity");security["sacl"]=Row("state","known","value",Descriptor(audit,8));}}catch{}
    var after=Information(file);using(var again=Open(path,0x80)){if(Id(Information(again))!=Id(before))throw new IOException("identity");}
    if(Id(before)!=Id(after)||before.SizeLow!=after.SizeLow||before.Write.ToString()!=after.Write.ToString()||before.Attributes!=after.Attributes)throw new IOException("changed");
    for(int n=0;n<pins.Count;n++){using(var p=Open(locations[n],0x80)){if(Id(Information(p))!=(string)parents[n]["id"]||(Information(p).Attributes&0x400)!=0)throw new IOException("parent_changed");}}
    string architecture="unknown";try{architecture=RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant();}catch{}
    return Row("status","observed","platform",Row("state","known","osVersion",Environment.OSVersion.Version.ToString(),"architecture",architecture,"fileSystem",fileSystem.ToString(),"driveType",GetDriveTypeW(volume.ToString()),"volumeId",serial.ToString("x8")),
     "file",Row("state","known","id",Id(before),"links",before.Links,"bytes",bytes.Length,"attributes",before.Attributes,"isFile",true,"reparse",false,"digest",Digest(bytes),"encoding",encoding),
     "path",Row("state","known","parents",parents),"security",security,"streams",streams,"ea",eaRow,"times",Row("state","known","creation",before.Creation.ToString(),"lastAccess",before.Access.ToString(),"lastWrite",before.Write.ToString()),"nonAtomic",true);
   }
  }finally{foreach(var pin in pins)pin.Dispose();}
 }
}
'@
 $result=[ObjectObservation]::Observe($target)
 $security=$result.security
 foreach($field in @('owner','group','dacl')){$security[$field]=@{state='unavailable';value=$null}}
 if($security.descriptor){
  $raw=New-Object Security.AccessControl.RawSecurityDescriptor($security.descriptor)
  if($raw.Owner){$security.owner=@{state='known';value=$raw.Owner.Value}}
  if($raw.Group){$security.group=@{state='known';value=$raw.Group.Value}}
  if($raw.DiscretionaryAcl){$security.dacl=@{state='known';value=$raw.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)}}
 }
 $security.Remove('descriptor')|Out-Null
 $result|ConvertTo-Json -Compress -Depth 10
} catch { @{status='unavailable';reason='object_observation_unavailable';nonAtomic=$true}|ConvertTo-Json -Compress }
