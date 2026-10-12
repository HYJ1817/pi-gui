# Research fixture only. Never imported by production code. The supervisor owns
# durable C/R and intent; this helper cannot write until it receives "commit".
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Emit($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 8)); [Console]::Out.Flush() }
function Refuse($code, $nativeCode = 0) { Emit @{ phase = 'refused'; code = $code; nativeCode = $nativeCode } }
$holder = $null
$mapping = $null
$view = $null
$stream = $null
try {
    $a = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PI_INPLACE_INPUT)) | ConvertFrom-Json
    if ($a.mode -notin @('observe','setup','write','hold','mapping') -or
        $a.relativePath -cne 'workspace/file.txt' -or
        $a.fault -notin @($null,'none','after_first_write','after_eof','after_flush') -or
        $a.metadataKind -notin @($null,'protected','inherited') -or
        -not [IO.Path]::IsPathRooted([string]$a.root)) { Refuse 'invalid_arguments'; exit 2 }
    $root = [IO.Path]::GetFullPath([string]$a.root).TrimEnd('\','/')
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if ([IO.Path]::GetDirectoryName($root) -ine $temp -or
        [IO.Path]::GetFileName($root) -notmatch '^p33-inplace-[a-zA-Z0-9_-]+$') { Refuse 'fixture_root_required'; exit 2 }
    $fixtureDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
    if ($fixtureDrive.DriveType -ne [IO.DriveType]::Fixed -or $fixtureDrive.DriveFormat -cne 'NTFS') { Refuse 'fixed_ntfs_required'; exit 2 }
    $path = [IO.Path]::Combine($root, 'workspace', 'file.txt')
    # Check the entire chain before acquiring pins; acquisition checks every
    # pinned handle again. Root and workspace pins deny delete/rename.
    $scan = [IO.Path]::GetDirectoryName($path)
    while ($scan) {
        if (([IO.File]::GetAttributes($scan) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse 'reparse_point'; exit 2 }
        $parent = [IO.Path]::GetDirectoryName($scan)
        if ($parent -eq $scan) { break }; $scan = $parent
    }
    if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse 'reparse_point'; exit 2 }
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class InplaceFailure : Exception {
 public string Code; public int NativeCode;
 public InplaceFailure(string code,int native=0) { Code=code; NativeCode=native; }
}
public sealed class InplaceFixture : IDisposable {
 [StructLayout(LayoutKind.Sequential)] public struct Info {
  public uint Attr; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
  public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
 }
 [StructLayout(LayoutKind.Sequential)] struct IOStatus { public IntPtr Status; public UIntPtr Information; }
 [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
 [StructLayout(LayoutKind.Sequential)] struct TokenPrivilege { public uint Count; public Luid Luid; public uint Attributes; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint access,uint share,IntPtr sa,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetFileType(SafeFileHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(SafeFileHandle h,byte[] b,uint n,out uint count,IntPtr over);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(SafeFileHandle h,byte[] b,uint n,out uint count,IntPtr over);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle h,long pos,out long result,uint method);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetEndOfFile(SafeFileHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
 [DllImport("ntdll.dll")] static extern int NtSetEaFile(SafeFileHandle h,out IOStatus io,byte[] b,uint length);
 [DllImport("ntdll.dll")] static extern int NtQueryEaFile(SafeFileHandle h,out IOStatus io,byte[] b,uint length,[MarshalAs(UnmanagedType.U1)] bool single,IntPtr list,uint listLen,IntPtr index,[MarshalAs(UnmanagedType.U1)] bool restart);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeValue(string system,string name,out Luid luid);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref TokenPrivilege priv,uint length,IntPtr old,IntPtr ret);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 List<SafeFileHandle> pins = new List<SafeFileHandle>();
 SafeFileHandle source;
 public bool WriteStarted;
 public Info Information;
 public string Id { get { return Identity(Information); } }
 public static string Identity(Info i) { return i.Volume.ToString("x8")+":"+i.IndexHigh.ToString("x8")+i.IndexLow.ToString("x8"); }
 static void Check(bool good,string code) { if(!good) throw new InplaceFailure(code,Marshal.GetLastWin32Error()); }
 static SafeFileHandle Open(string p,uint rights,uint share,uint flags) {
  SafeFileHandle h=CreateFileW(p,rights,share,IntPtr.Zero,3,flags,IntPtr.Zero);
  if(h.IsInvalid) { int n=Marshal.GetLastWin32Error(); h.Dispose(); throw new InplaceFailure("open_failed",n); } return h;
 }
 static Info Inspect(SafeFileHandle h,bool dir) {
  Info i; Check(GetFileInformationByHandle(h,out i),"information_failed");
  if(GetFileType(h)!=1 || (i.Attr & 0x400)!=0 || ((i.Attr & 0x10)!=0)!=dir) throw new InplaceFailure("unsupported_object");
  return i;
 }
 public InplaceFixture(string root,string path,bool writer) {
  try {
   pins.Add(Open(root,0x80,3,0x02200000)); Inspect(pins[pins.Count-1],true);
   pins.Add(Open(Path.GetDirectoryName(path),0x80,3,0x02200000)); Inspect(pins[pins.Count-1],true);
   source=Open(path,writer ? 0x100083u : 0x88u,writer ? 0u : 7u,0x00200000);
   Information=Inspect(source,false);
   if(Information.Links!=1) throw new InplaceFailure("multiple_links");
   if(Information.SizeHigh!=0 || Information.SizeLow>2097152) throw new InplaceFailure("buffer_limit");
  } catch { Dispose(); throw; }
 }
 public static byte[] Decode(string s) {
  if(s==null || s.Length>2796204) throw new InplaceFailure("invalid_buffer");
  byte[] b; try {b=Convert.FromBase64String(s);} catch {throw new InplaceFailure("invalid_buffer");}
  if(b.Length>2097152) throw new InplaceFailure("buffer_limit"); return b;
 }
 void Seek(long pos) {long actual; Check(SetFilePointerEx(source,pos,out actual,0),"seek_failed"); if(actual!=pos) throw new InplaceFailure("seek_mismatch");}
 byte[] ReadAll() {
  Info i=Inspect(source,false); if(i.SizeHigh!=0 || i.SizeLow>2097152) throw new InplaceFailure("buffer_limit");
  byte[] b=new byte[(int)i.SizeLow]; Seek(0); int offset=0;
  while(offset<b.Length) {byte[] chunk=new byte[b.Length-offset]; uint n; Check(ReadFile(source,chunk,(uint)chunk.Length,out n,IntPtr.Zero),"read_failed"); if(n==0) throw new InplaceFailure("short_read"); Buffer.BlockCopy(chunk,0,b,offset,(int)n); offset+=(int)n;}
  return b;
 }
 public void Verify(string id,byte[] expected) {
  Info i=Inspect(source,false); if(i.Links!=1 || Identity(i)!=id) throw new InplaceFailure("identity_mismatch");
  byte[] b=ReadAll(); if(b.Length!=expected.Length) throw new InplaceFailure("stale_content");
  for(int j=0;j<b.Length;j++) if(b[j]!=expected[j]) throw new InplaceFailure("stale_content");
 }
 void WritePart(byte[] data,int start,int length) {
  int offset=0; while(offset<length) {byte[] chunk=new byte[length-offset]; Buffer.BlockCopy(data,start+offset,chunk,0,chunk.Length); uint n;
   WriteStarted=true; Check(WriteFile(source,chunk,(uint)chunk.Length,out n,IntPtr.Zero),"write_failed"); if(n==0) throw new InplaceFailure("short_write"); offset+=(int)n;
  }
 }
 public void Commit(string id,byte[] expected,byte[] replacement,string fault) {
  Verify(id,expected); Seek(0); int first=(replacement.Length+1)/2; WritePart(replacement,0,first);
  if(fault=="after_first_write") Environment.Exit(73);
  WritePart(replacement,first,replacement.Length-first); Seek(replacement.Length);
  WriteStarted=true; Check(SetEndOfFile(source),"eof_failed");
  if(fault=="after_eof") Environment.Exit(73);
  Check(FlushFileBuffers(source),"flush_failed");
  if(fault=="after_flush") Environment.Exit(73);
  Verify(id,replacement);
 }
 public string Ea() {
  byte[] b=new byte[65536]; IOStatus io; int status=NtQueryEaFile(source,out io,b,(uint)b.Length,false,IntPtr.Zero,0,IntPtr.Zero,true);
  if(status==unchecked((int)0xC0000052) || status==unchecked((int)0x80000012)) return "";
  if(status!=0) throw new InplaceFailure("ea_query_failed",status);
  ulong n=io.Information.ToUInt64(); if(n>(ulong)b.Length) throw new InplaceFailure("ea_query_failed");
  return Convert.ToBase64String(b,0,(int)n);
 }
 public static void SetEa(string path) {
  using(SafeFileHandle h=Open(path,0x10,7,0x00200000)) {
   Inspect(h,false); byte[] name=System.Text.Encoding.ASCII.GetBytes("P33PROBE"), value=System.Text.Encoding.ASCII.GetBytes("original-ea");
   byte[] b=new byte[8+name.Length+1+value.Length]; b[5]=(byte)name.Length; b[6]=(byte)value.Length; Buffer.BlockCopy(name,0,b,8,name.Length); Buffer.BlockCopy(value,0,b,9+name.Length,value.Length);
   IOStatus io; int status=NtSetEaFile(h,out io,b,(uint)b.Length); if(status!=0) throw new InplaceFailure("ea_setup_failed",status);
  }
 }
 public static void SetAds(string path) {
  using(SafeFileHandle h=CreateFileW(path+":probe",0x2,7,IntPtr.Zero,2,0x00200000,IntPtr.Zero)) {
   if(h.IsInvalid) throw new InplaceFailure("ads_setup_failed",Marshal.GetLastWin32Error());
   byte[] b=System.Text.Encoding.UTF8.GetBytes("original-ads"); uint n;
   Check(WriteFile(h,b,(uint)b.Length,out n,IntPtr.Zero),"ads_setup_failed");
   if(n!=b.Length) throw new InplaceFailure("ads_setup_failed"); Check(FlushFileBuffers(h),"ads_setup_failed");
  }
 }
 public static string GetAds(string path) {
  using(SafeFileHandle h=CreateFileW(path+":probe",0x1,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
   if(h.IsInvalid) {int n=Marshal.GetLastWin32Error(); if(n==2) return null; throw new InplaceFailure("ads_query_failed",n);}
   byte[] b=new byte[4096]; uint count; Check(ReadFile(h,b,(uint)b.Length,out count,IntPtr.Zero),"ads_query_failed");
   if(count==b.Length) throw new InplaceFailure("ads_buffer_limit"); return System.Text.Encoding.UTF8.GetString(b,0,(int)count);
  }
 }
 public static bool EnableAssignedAuditPrivilege() {
  IntPtr token; if(!OpenProcessToken(GetCurrentProcess(),0x28,out token)) return false;
  try {Luid luid; if(!LookupPrivilegeValue(null,"SeSecurityPrivilege",out luid)) return false;
   TokenPrivilege p=new TokenPrivilege(); p.Count=1; p.Luid=luid; p.Attributes=2;
   return AdjustTokenPrivileges(token,false,ref p,0,IntPtr.Zero,IntPtr.Zero) && Marshal.GetLastWin32Error()==0;
  } finally {CloseHandle(token);}
 }
 public void Dispose() {if(source!=null) {source.Dispose(); source=null;} for(int j=pins.Count-1;j>=0;j--) pins[j].Dispose(); pins.Clear();}
}
'@ -ErrorAction Stop
    if ($a.mode -eq 'write') {
        $expected = [InplaceFixture]::Decode([string]$a.expectedBase64)
        $candidate = [InplaceFixture]::Decode([string]$a.candidateBase64)
        if ([string]$a.expectedId -notmatch '^[0-9a-f]{8}:[0-9a-f]{16}$') { Refuse 'invalid_identity'; exit 2 }
        $holder = [InplaceFixture]::new($root,$path,$true)
        $holder.Verify([string]$a.expectedId,$expected)
        Emit @{phase='ready'; id=$holder.Id}
        if ([Console]::In.ReadLine() -cne 'commit') { Refuse 'commit_required'; exit 2 }
        $holder.Commit([string]$a.expectedId,$expected,$candidate,[string]$a.fault)
        Emit @{phase='done'; id=$holder.Id; verified=$true}
    } elseif ($a.mode -eq 'hold') {
        $holder = [InplaceFixture]::new($root,$path,$false)
        $stream = [IO.FileStream]::new($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        Emit @{phase='held'}
        [void][Console]::In.ReadLine()
        Emit @{phase='done'}
    } elseif ($a.mode -eq 'mapping') {
        $holder = [InplaceFixture]::new($root,$path,$false)
        $stream = [IO.FileStream]::new($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        if ($stream.Length -lt 1 -or $stream.Length -gt 2097152) { Refuse 'buffer_limit'; exit 2 }
        $mapping = [IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($stream,[System.Management.Automation.Language.NullString]::Value,0,[IO.MemoryMappedFiles.MemoryMappedFileAccess]::ReadWrite,[IO.HandleInheritability]::None,$true)
        $view = $mapping.CreateViewAccessor(0,0,[IO.MemoryMappedFiles.MemoryMappedFileAccess]::ReadWrite)
        $stream.Dispose(); $stream=$null
        # Observe handle must also be closed: only mapping and view survive.
        $holder.Dispose(); $holder=$null
        Emit @{phase='mapped'}
        if ([Console]::In.ReadLine() -ceq 'mutate') { $view.Write(0,[byte]68); $view.Flush(); Emit @{phase='mutated'}; [void][Console]::In.ReadLine() }
        Emit @{phase='done'}
    } else {
        $holder = [InplaceFixture]::new($root,$path,$false)
        $auditPrivilege = [InplaceFixture]::EnableAssignedAuditPrivilege()
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        if ($a.mode -eq 'setup') {
            # All ACL/attribute/EA mutation belongs solely to fixture setup.
            $rootAcl = Get-Acl -LiteralPath $root
            $rootAcl.SetAccessRuleProtection($true,$false)
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
            $rootAcl.SetAccessRule($rule); Set-Acl -LiteralPath $root -AclObject $rootAcl
            $fileAcl = Get-Acl -LiteralPath $path
            if ($a.metadataKind -eq 'inherited') {
                $fileAcl.SetAccessRuleProtection($false,$false)
                foreach ($r in @($fileAcl.Access)) { if (-not $r.IsInherited) { [void]$fileAcl.RemoveAccessRuleSpecific($r) } }
            } else {
                $fileAcl.SetAccessRuleProtection($true,$false)
                $fileAcl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',[Security.AccessControl.AccessControlType]::Allow))
            }
            Set-Acl -LiteralPath $path -AclObject $fileAcl
            if ($auditPrivilege) {
                $auditFlags = [Security.AccessControl.AuditFlags]::Success -bor [Security.AccessControl.AuditFlags]::Failure
                $rootAudit = Get-Acl -LiteralPath $root -Audit
                $rootAudit.AddAuditRule([Security.AccessControl.FileSystemAuditRule]::new($sid,'WriteData',([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,$auditFlags))
                Set-Acl -LiteralPath $root -AclObject $rootAudit
                $fileAudit = Get-Acl -LiteralPath $path -Audit
                $fileAudit.SetAuditRuleProtection($false,$false)
                $fileAudit.AddAuditRule([Security.AccessControl.FileSystemAuditRule]::new($sid,'ReadData',$auditFlags))
                Set-Acl -LiteralPath $path -AclObject $fileAudit
            }
            if ($a.withExtras) {
                [InplaceFixture]::SetEa($path)
                [InplaceFixture]::SetAds($path)
                [IO.File]::SetAttributes($path,([IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::Archive -bor [IO.FileAttributes]::NotContentIndexed))
            }
            $holder.Dispose(); $holder = [InplaceFixture]::new($root,$path,$false)
        }
        $acl = Get-Acl -LiteralPath $path
        $sacl = $null; $auditCount = 0; $inheritedAuditCount = 0; $auditReadable = $false
        if ($auditPrivilege) {
            try {
                $aud = Get-Acl -LiteralPath $path -Audit
                $sacl = $aud.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Audit)
                $auditCount = @($aud.Audit).Count
                $inheritedAuditCount = @($aud.Audit | Where-Object IsInherited).Count
                $auditReadable = $true
            } catch { $sacl = $null }
        }
        $ads = [InplaceFixture]::GetAds($path)
        Emit @{phase='observed'; fileSystem=$fixtureDrive.DriveFormat; osVersion=[Environment]::OSVersion.Version.ToString(); id=$holder.Id; links=$holder.Information.Links; size=$holder.Information.SizeLow; attributes=$holder.Information.Attr;
            dacl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);
            owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; group=$acl.GetGroup([Security.Principal.SecurityIdentifier]).Value;
            ea=$holder.Ea(); ads=$ads; auditReadable=$auditReadable; sacl=$sacl; auditCount=$auditCount; inheritedAuditCount=$inheritedAuditCount }
    }
} catch {
    $e = $_.Exception
    while ($e.InnerException) { $e=$e.InnerException }
    $code='native_fixture_failed'; $nativeCode=0
    # Invalid input can fail before Add-Type has defined InplaceFailure.
    if ($e.GetType().Name -eq 'InplaceFailure') { $code=$e.Code; $nativeCode=$e.NativeCode }
    if ($holder -and $holder.WriteStarted) { $code='recovery_required' }
    Refuse $code $nativeCode
    exit 2
} finally {
    if ($view) { $view.Dispose() }
    if ($mapping) { $mapping.Dispose() }
    if ($stream) { $stream.Dispose() }
    if ($holder) { $holder.Dispose() }
}
