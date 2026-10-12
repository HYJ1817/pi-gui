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
    if ($a.mode -notin @('observe','setup','write','hold','mapping','privilege','sacl_setup','attributes') -or
        ($a.mode -ne 'privilege' -and $a.relativePath -cne 'workspace/file.txt') -or
        $a.fault -notin @($null,'none','after_first_write','after_eof','after_flush','write_failure','write_after_partial_failure','eof_failure','flush_failure','short_write','zero_write') -or
        $a.metadataKind -notin @($null,'protected','inherited') -or
        ($a.mode -eq 'sacl_setup' -and $a.auditProfile -notin @('explicit','inherited','protected','mixed')) -or
        ($null -ne $a.fileTransport -and $a.fileTransport -isnot [bool]) -or
        ($a.mode -ne 'privilege' -and -not [IO.Path]::IsPathRooted([string]$a.root))) { Refuse 'invalid_arguments'; exit 2 }
    if ($a.fileTransport -eq $true) {
        $transportFields = @('mode','root','relativePath','fault','expectedId','fileTransport','expectedDigest','candidateDigest')
        foreach ($property in $a.PSObject.Properties) {
            if ($property.Name -notin $transportFields) { Refuse 'invalid_arguments'; exit 2 }
        }
    }
    if ($a.mode -ne 'privilege') {
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
    }
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
 [StructLayout(LayoutKind.Sequential)] struct BasicInfo { public long Creation, Access, Write, Change; public uint Attributes; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint access,uint share,IntPtr sa,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetFileType(SafeFileHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(SafeFileHandle h,byte[] b,uint n,out uint count,IntPtr over);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(SafeFileHandle h,byte[] b,uint n,out uint count,IntPtr over);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle h,long pos,out long result,uint method);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetEndOfFile(SafeFileHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr process,SafeFileHandle source,IntPtr target,out SafeFileHandle duplicate,uint access,bool inherit,uint options);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int infoClass,ref BasicInfo info,uint length);
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
 public string Attempted;
 public string Fault;
 public int ShortWriteCount;
 public static int AuditError;
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
 public InplaceFixture(string root,string path,bool writer) : this(root,path,writer ? 1 : 0) {}
 public InplaceFixture(string root,string path,int mode) {
  try {
   pins.Add(Open(root,0x80,3,0x02200000)); Inspect(pins[pins.Count-1],true);
   pins.Add(Open(Path.GetDirectoryName(path),0x80,3,0x02200000)); Inspect(pins[pins.Count-1],true);
   source=Open(path,mode==1 ? 0x100083u : mode==2 ? 0x180u : 0x88u,mode==1 ? 0u : 7u,0x00200000);
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
 public byte[] Input(string root,string name,string digest) {
  if(name!="current.bin" && name!="candidate.bin") throw new InplaceFailure("invalid_input_name");
  if(digest==null || !System.Text.RegularExpressions.Regex.IsMatch(digest,"^[0-9a-f]{64}$")) throw new InplaceFailure("invalid_digest");
  string directory=Path.Combine(root,"inputs");
  SafeFileHandle parent=Open(directory,0x80,3,0x02200000); pins.Add(parent); Inspect(parent,true);
  SafeFileHandle input=Open(Path.Combine(directory,name),0x81,1,0x00200000); pins.Add(input);
  Info info=Inspect(input,false); if(info.Links!=1) throw new InplaceFailure("multiple_links");
  if(info.SizeHigh!=0 || info.SizeLow>2097152) throw new InplaceFailure("buffer_limit");
  byte[] bytes=new byte[(int)info.SizeLow]; int offset=0;
  while(offset<bytes.Length) { byte[] chunk=new byte[bytes.Length-offset]; uint count; Check(ReadFile(input,chunk,(uint)chunk.Length,out count,IntPtr.Zero),"input_read_failed"); if(count==0) throw new InplaceFailure("short_read"); Buffer.BlockCopy(chunk,0,bytes,offset,(int)count); offset+=(int)count; }
  using(var sha=System.Security.Cryptography.SHA256.Create()) { string actual=BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant(); if(actual!=digest) throw new InplaceFailure("input_digest_mismatch"); }
  return bytes;
 }
 public void VerifyIdentity(string id) { Info i=Inspect(source,false); if(i.Links!=1 || Identity(i)!=id) throw new InplaceFailure("identity_mismatch"); }
 public static void ValidateAttributes(uint attributes) {
  if(attributes==0 || (attributes & ~0x20a2u)!=0 || ((attributes & 0x80)!=0 && attributes!=0x80)) throw new InplaceFailure("invalid_attributes");
 }
 public void Attributes(string id,uint attributes) {
  ValidateAttributes(attributes); VerifyIdentity(id); BasicInfo info=new BasicInfo(); info.Attributes=attributes;
  // Zero timestamps preserve each existing time. This operation is not CAS.
  WriteStarted=true; Attempted="SetFileInformationByHandle";
  Check(SetFileInformationByHandle(source,0,ref info,(uint)Marshal.SizeOf(typeof(BasicInfo))),"attributes_failed"); VerifyIdentity(id);
 }
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
 SafeFileHandle ReadOnlyDuplicate() {
  SafeFileHandle h; IntPtr p=GetCurrentProcess(); Check(DuplicateHandle(p,source,p,out h,0x100081,false,0),"duplicate_failed"); return h;
 }
 void FailWrite() { using(SafeFileHandle h=ReadOnlyDuplicate()) { uint count; WriteStarted=true; Attempted="WriteFile"; Check(WriteFile(h,new byte[]{1},1,out count,IntPtr.Zero),"write_failed"); throw new InplaceFailure("fault_did_not_fail"); } }
 void WritePart(byte[] data,int start,int length) {
  int offset=0; while(offset<length) {byte[] chunk=new byte[length-offset]; Buffer.BlockCopy(data,start+offset,chunk,0,chunk.Length); uint n;
   // Explicit request-size injection, not a naturally occurring disk short write.
   uint request=Fault=="zero_write" ? 0u : Fault=="short_write" && ShortWriteCount==0 ? Math.Min(1u,(uint)chunk.Length) : (uint)chunk.Length;
   WriteStarted=true; Attempted="WriteFile"; Check(WriteFile(source,chunk,request,out n,IntPtr.Zero),"write_failed"); if(n==0) throw new InplaceFailure("short_write"); if(n<chunk.Length) ShortWriteCount++; offset+=(int)n;
  }
 }
 public void Commit(string id,byte[] expected,byte[] replacement,string fault) {
  Fault=fault; Verify(id,expected);
  if((fault=="short_write" && replacement.Length<2) || (fault=="write_after_partial_failure" && replacement.Length==0)) throw new InplaceFailure("fault_buffer_required");
  Seek(0);
  if(fault=="write_failure") FailWrite();
  if(fault=="zero_write" && replacement.Length==0) { uint count; WriteStarted=true; Attempted="WriteFile"; Check(WriteFile(source,new byte[0],0,out count,IntPtr.Zero),"write_failed"); if(count==0) throw new InplaceFailure("short_write"); }
  int first=fault=="short_write" ? replacement.Length : (replacement.Length+1)/2; WritePart(replacement,0,first);
  if(fault=="after_first_write") Environment.Exit(73);
  if(fault=="write_after_partial_failure") FailWrite();
  WritePart(replacement,first,replacement.Length-first); Seek(replacement.Length);
  WriteStarted=true; Attempted="SetEndOfFile";
  if(fault=="eof_failure") { using(SafeFileHandle h=ReadOnlyDuplicate()) { Check(SetEndOfFile(h),"eof_failed"); throw new InplaceFailure("fault_did_not_fail"); } }
  Check(SetEndOfFile(source),"eof_failed");
  if(fault=="after_eof") Environment.Exit(73);
  Attempted="FlushFileBuffers";
  if(fault=="flush_failure") { using(SafeFileHandle h=ReadOnlyDuplicate()) { Check(FlushFileBuffers(h),"flush_failed"); throw new InplaceFailure("fault_did_not_fail"); } }
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
  AuditError=0; IntPtr token; if(!OpenProcessToken(GetCurrentProcess(),0x28,out token)) {AuditError=Marshal.GetLastWin32Error(); return false;}
  try {Luid luid; if(!LookupPrivilegeValue(null,"SeSecurityPrivilege",out luid)) {AuditError=Marshal.GetLastWin32Error(); return false;}
   TokenPrivilege p=new TokenPrivilege(); p.Count=1; p.Luid=luid; p.Attributes=2;
   bool adjusted=AdjustTokenPrivileges(token,false,ref p,0,IntPtr.Zero,IntPtr.Zero); AuditError=Marshal.GetLastWin32Error(); return adjusted && AuditError==0;
  } finally {CloseHandle(token);}
 }
 public void Dispose() {if(source!=null) {source.Dispose(); source=null;} for(int j=pins.Count-1;j>=0;j--) pins[j].Dispose(); pins.Clear();}
}
'@ -ErrorAction Stop
    if ($a.mode -eq 'privilege') {
        $auditEnabled = [InplaceFixture]::EnableAssignedAuditPrivilege()
        Emit @{phase='privilege'; auditEnabled=$auditEnabled; auditError=[InplaceFixture]::AuditError}
    } elseif ($a.mode -eq 'attributes') {
        if ([string]$a.expectedId -notmatch '^[0-9a-f]{8}:[0-9a-f]{16}$') { Refuse 'invalid_identity'; exit 2 }
        if ([string]$a.attributes -notmatch '^\d{1,10}$' -or [decimal]$a.attributes -gt [uint32]::MaxValue) { Refuse 'invalid_attributes'; exit 2 }
        [InplaceFixture]::ValidateAttributes([uint32]$a.attributes)
        $holder = [InplaceFixture]::new($root,$path,[int]2)
        $holder.VerifyIdentity([string]$a.expectedId)
        Emit @{phase='attrs_ready'; id=$holder.Id}
        if ([Console]::In.ReadLine() -cne 'commit') { Refuse 'commit_required'; exit 2 }
        $holder.Attributes([string]$a.expectedId,[uint32]$a.attributes)
        Emit @{phase='done'; id=$holder.Id; verified=$true}
    } elseif ($a.mode -eq 'write') {
        if ([string]$a.expectedId -notmatch '^[0-9a-f]{8}:[0-9a-f]{16}$') { Refuse 'invalid_identity'; exit 2 }
        $holder = [InplaceFixture]::new($root,$path,$true)
        if ($a.fileTransport -eq $true) {
            $expected = $holder.Input($root,'current.bin',[string]$a.expectedDigest)
            $candidate = $holder.Input($root,'candidate.bin',[string]$a.candidateDigest)
        } else {
            $expected = [InplaceFixture]::Decode([string]$a.expectedBase64)
            $candidate = [InplaceFixture]::Decode([string]$a.candidateBase64)
        }
        $holder.Verify([string]$a.expectedId,$expected)
        Emit @{phase='ready'; id=$holder.Id}
        if ([Console]::In.ReadLine() -cne 'commit') { Refuse 'commit_required'; exit 2 }
        $holder.Commit([string]$a.expectedId,$expected,$candidate,[string]$a.fault)
        Emit @{phase='done'; id=$holder.Id; verified=$true; shortWriteCount=$holder.ShortWriteCount}
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
        if ($a.mode -eq 'sacl_setup') {
            # Assigned privilege only; never elevate or adjust system audit policy.
            # No marker or metadata mutation is permitted when privilege is absent.
            if (-not $auditPrivilege) { Refuse 'audit_privilege_unavailable' ([InplaceFixture]::AuditError); exit 2 }
            # The caller owns fresh mkdtemp provenance. These checks restrict this
            # research setup to its initial, one-file shape, not a general capability.
            $rootEntries = @([IO.Directory]::GetFileSystemEntries($root))
            $workspaceEntries = @([IO.Directory]::GetFileSystemEntries([IO.Path]::GetDirectoryName($path)))
            if ($rootEntries.Count -ne 1 -or [IO.Path]::GetFileName($rootEntries[0]) -cne 'workspace' -or
                $workspaceEntries.Count -ne 1 -or [IO.Path]::GetFileName($workspaceEntries[0]) -cne 'file.txt') { Refuse 'fresh_fixture_required'; exit 2 }
            $rootAudit = Get-Acl -LiteralPath $root -Audit
            $fileAudit = Get-Acl -LiteralPath $path -Audit
            if (@($rootAudit.Audit).Count -ne 0 -or @($fileAudit.Audit).Count -ne 0 -or $fileAudit.AreAuditRulesProtected) { Refuse 'fresh_fixture_required'; exit 2 }
            $markerPath = [IO.Path]::Combine($root,'.sacl-setup-once')
            $marker = [IO.File]::Open($markerPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            $marker.Dispose()
            # The fresh TEMP chain must have no inherited audit ACEs. We refuse
            # such environments above instead of silently removing their audit.
            $rootAcl = Get-Acl -LiteralPath $root
            $rootAcl.SetAccessRuleProtection($true,$false)
            $rootAcl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
            Set-Acl -LiteralPath $root -AclObject $rootAcl
            if ($a.metadataKind -ne 'inherited') {
                $fileAcl = Get-Acl -LiteralPath $path
                $fileAcl.SetAccessRuleProtection($true,$false)
                $fileAcl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',[Security.AccessControl.AccessControlType]::Allow))
                Set-Acl -LiteralPath $path -AclObject $fileAcl
            }
            # inherited keeps the fresh default inheritance, never weakens it.
            $rootAudit = Get-Acl -LiteralPath $root -Audit
            $fileAudit = Get-Acl -LiteralPath $path -Audit
            if ($a.auditProfile -in @('inherited','mixed')) {
                $rootAudit.AddAuditRule([Security.AccessControl.FileSystemAuditRule]::new($sid,'WriteData',([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,([Security.AccessControl.AuditFlags]::Success -bor [Security.AccessControl.AuditFlags]::Failure)))
                Set-Acl -LiteralPath $root -AclObject $rootAudit
                $fileAudit = Get-Acl -LiteralPath $path -Audit
            }
            if ($a.auditProfile -eq 'protected') { $fileAudit.SetAuditRuleProtection($true,$false) }
            if ($a.auditProfile -in @('explicit','protected','mixed')) {
                $fileAudit.AddAuditRule([Security.AccessControl.FileSystemAuditRule]::new($sid,'ReadData',[Security.AccessControl.AuditFlags]::Success))
                $fileAudit.AddAuditRule([Security.AccessControl.FileSystemAuditRule]::new($sid,'AppendData',[Security.AccessControl.AuditFlags]::Failure))
                Set-Acl -LiteralPath $path -AclObject $fileAudit
            }
            if ($a.withExtras) {
                [InplaceFixture]::SetEa($path); [InplaceFixture]::SetAds($path)
                [IO.File]::SetAttributes($path,([IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::Archive -bor [IO.FileAttributes]::NotContentIndexed))
            }
            $holder.Dispose(); $holder = [InplaceFixture]::new($root,$path,$false)
        }
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
        $sacl = $null; $fullSDDL = $null; $isAuditProtected = $null; $explicitAuditCount = $null
        $auditCount = 0; $inheritedAuditCount = 0; $auditReadable = $false
        if ($auditPrivilege) {
            try {
                $aud = Get-Acl -LiteralPath $path -Audit
                $sacl = $aud.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Audit)
                $fullSDDL = $aud.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
                $isAuditProtected = $aud.AreAuditRulesProtected
                $auditCount = @($aud.Audit).Count
                $inheritedAuditCount = @($aud.Audit | Where-Object IsInherited).Count
                $explicitAuditCount = $auditCount - $inheritedAuditCount
                $auditReadable = $true
            } catch { $sacl = $null; $fullSDDL = $null; $isAuditProtected = $null; $explicitAuditCount = $null }
        }
        if ($a.mode -eq 'sacl_setup' -and -not $auditReadable) { Refuse 'audit_snapshot_unavailable'; exit 2 }
        $ads = [InplaceFixture]::GetAds($path)
        Emit @{phase='observed'; fileSystem=$fixtureDrive.DriveFormat; osVersion=[Environment]::OSVersion.Version.ToString(); id=$holder.Id; links=$holder.Information.Links; size=$holder.Information.SizeLow; attributes=$holder.Information.Attr;
            dacl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);
            isDaclProtected=$acl.AreAccessRulesProtected;
            owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; group=$acl.GetGroup([Security.Principal.SecurityIdentifier]).Value;
            ea=$holder.Ea(); ads=$ads; auditReadable=$auditReadable; sacl=$sacl; auditCount=$auditCount; inheritedAuditCount=$inheritedAuditCount;
            auditEnabled=$auditPrivilege; auditError=[InplaceFixture]::AuditError; fullSDDL=$fullSDDL; isAuditProtected=$isAuditProtected; explicitAuditCount=$explicitAuditCount }
    }
} catch {
    $e = $_.Exception
    while ($e.InnerException) { $e=$e.InnerException }
    $code='native_fixture_failed'; $nativeCode=0
    # Invalid input can fail before Add-Type has defined InplaceFailure.
    if ($e.GetType().Name -eq 'InplaceFailure') { $code=$e.Code; $nativeCode=$e.NativeCode }
    if ($holder -and $holder.WriteStarted) {
        Emit @{phase='refused'; code='recovery_required'; cause=$code; attempted=$holder.Attempted; fault=$holder.Fault; nativeCode=$nativeCode}
    } else { Refuse $code $nativeCode }
    exit 2
} finally {
    if ($view) { $view.Dispose() }
    if ($mapping) { $mapping.Dispose() }
    if ($stream) { $stream.Dispose() }
    if ($holder) { $holder.Dispose() }
}
