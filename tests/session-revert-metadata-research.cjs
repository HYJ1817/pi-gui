// Opt-in native API experiment. It is NOT a production eligibility provider.
// Run on a disposable NTFS fixture; optional assigned audit privilege is used
// only inside this child process. No elevation, policy changes or real data.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile);
const script=String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.IO; using System.Runtime.InteropServices;
public class ProbeNative {
 [StructLayout(LayoutKind.Sequential)] public struct IO {public IntPtr Status;public UIntPtr Information;}
 [StructLayout(LayoutKind.Sequential)] public struct LUID {public uint Low;public int High;}
 [StructLayout(LayoutKind.Sequential)] public struct TP {public uint Count;public LUID Luid;public uint Attributes;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool ReplaceFile(string oldFile,string newFile,string backup,uint flags,IntPtr exclude,IntPtr reserved);
 [DllImport("advapi32.dll",SetLastError=true)] public static extern bool OpenProcessToken(IntPtr h,uint a,out IntPtr t);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool LookupPrivilegeValue(string s,string n,out LUID l);
 [DllImport("advapi32.dll",SetLastError=true)] public static extern bool AdjustTokenPrivileges(IntPtr t,bool d,ref TP p,uint n,IntPtr a,IntPtr b);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
 [DllImport("ntdll.dll")] public static extern int NtSetEaFile(IntPtr f,out IO io,byte[] b,uint n);
 [DllImport("ntdll.dll")] public static extern int NtQueryEaFile(IntPtr f,out IO io,byte[] b,uint n,bool one,IntPtr list,uint listSize,IntPtr index,bool restart);
 public static bool Audit(){IntPtr t;if(!OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle,0x28,out t))return false;try{LUID l;if(!LookupPrivilegeValue(null,"SeSecurityPrivilege",out l))return false;TP p=new TP{Count=1,Luid=l,Attributes=2};return AdjustTokenPrivileges(t,false,ref p,0,IntPtr.Zero,IntPtr.Zero)&&Marshal.GetLastWin32Error()==0;}finally{CloseHandle(t);}}
 public static int SetEA(string path){byte[] name=System.Text.Encoding.ASCII.GetBytes("P33_PROBE"),value=System.Text.Encoding.ASCII.GetBytes("original-ea");byte[] b=new byte[9+name.Length+value.Length];b[5]=(byte)name.Length;b[6]=(byte)value.Length;Array.Copy(name,0,b,8,name.Length);Array.Copy(value,0,b,9+name.Length,value.Length);using(FileStream f=new FileStream(path,FileMode.Open,FileAccess.ReadWrite,FileShare.ReadWrite|FileShare.Delete)){IO io;return NtSetEaFile(f.SafeFileHandle.DangerousGetHandle(),out io,b,(uint)b.Length);}}
 public static string EA(string path){using(FileStream f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)){IO io;byte[] b=new byte[4096];int result=NtQueryEaFile(f.SafeFileHandle.DangerousGetHandle(),out io,b,4096,false,IntPtr.Zero,0,IntPtr.Zero,true);if(result<0)return "status:"+result;byte[] exact=new byte[(int)io.Information.ToUInt64()];Array.Copy(b,exact,exact.Length);return Convert.ToBase64String(exact);}}
}
'@
$root=$env:PI_REVERT_RESEARCH_ROOT
$old=Join-Path $root 'original.txt';$replacement=Join-Path $root 'candidate.txt';$backup=Join-Path $root 'backup.txt'
[IO.File]::WriteAllText($old,'C',[Text.UTF8Encoding]::new($false));[IO.File]::WriteAllText($replacement,'R',[Text.UTF8Encoding]::new($false))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=Get-Acl -LiteralPath $old;$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $old -AclObject $acl
$audit=[ProbeNative]::Audit();$saclBefore=$null;$saclAfter=$null;$saclBackup=$null
if($audit){$acl=Get-Acl -LiteralPath $old -Audit;$rule=New-Object Security.AccessControl.FileSystemAuditRule($sid,'WriteData','Success');$acl.AddAuditRule($rule);Set-Acl -LiteralPath $old -AclObject $acl;$saclBefore=(Get-Acl -LiteralPath $old -Audit).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Audit)}
$daclBefore=(Get-Acl -LiteralPath $old).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
Set-Content -LiteralPath $old -Stream probe -Value 'original-ads' -NoNewline
$eaSet=[ProbeNative]::SetEA($old);if($eaSet -ne 0){throw 'EA fixture setup failed'}
$eaBefore=[ProbeNative]::EA($old)
[IO.File]::SetAttributes($old,([IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::Archive -bor [IO.FileAttributes]::NotContentIndexed))
$attributesBefore=[int][IO.File]::GetAttributes($old)
if(![ProbeNative]::ReplaceFile($old,$replacement,$backup,0,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'ReplaceFile failed'}
$daclAfter=(Get-Acl -LiteralPath $old).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
if($audit){$saclAfter=(Get-Acl -LiteralPath $old -Audit).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Audit);$saclBackup=(Get-Acl -LiteralPath $backup -Audit).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Audit)}
@{contentR=([IO.File]::ReadAllText($old) -eq 'R');backupC=([IO.File]::ReadAllText($backup) -eq 'C');daclEqual=($daclBefore -eq $daclAfter);adsEqual=((Get-Content -LiteralPath $old -Stream probe -Raw) -eq 'original-ads');eaEqual=($eaBefore -eq [ProbeNative]::EA($old));backupEaEqual=($eaBefore -eq [ProbeNative]::EA($backup));attributesBefore=$attributesBefore;attributesAfter=[int][IO.File]::GetAttributes($old);auditReadable=$audit;saclEqual=$(if($audit){$saclBefore -eq $saclAfter}else{$null});backupSaclEqual=$(if($audit){$saclBefore -eq $saclBackup}else{$null})}|ConvertTo-Json -Compress
`;
(async()=>{
 if(process.platform!=='win32'){console.log('Native metadata research: 0 passed, 0 failed; Windows-only experiment not run');return;}
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'p34a-metadata-'));
 try{
  const env={...process.env,PI_REVERT_RESEARCH_ROOT:root};for(const k of Object.keys(env))if(k.toLowerCase()==='psmodulepath')delete env[k];
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,windowsHide:true,timeout:30000,maxBuffer:8192});
  const observed=JSON.parse(stdout.trim());assert.equal(observed.contentR,true);assert.equal(observed.backupC,true);assert.equal(observed.daclEqual,true);assert.equal(observed.adsEqual,true);
  // EA/attributes/SACL are measurements, NOT assumed guarantees of ReplaceFileW.
  console.log('ReplaceFileW flags=0 observed:',JSON.stringify(observed));
  const {inspectFileMetadata}=await import('../server/session-revert-metadata.js');
  const native=await inspectFileMetadata(path.join(root,'backup.txt'));console.log('production qualification:',JSON.stringify(native));assert.equal(native.supported,false);assert.ok(['metadata_streams_unsupported','metadata_audit_unavailable','metadata_extended_attributes_unsupported'].includes(native.reason));
  await fs.unlink(path.join(root,'backup.txt')+':probe');
  const eaOnly=await inspectFileMetadata(path.join(root,'backup.txt'));assert.equal(eaOnly.reason,'metadata_extended_attributes_unsupported');
  console.log('Native metadata research: 6 passed, 0 failed; SACL preservation '+(observed.auditReadable?'measured (see result)':'NOT VERIFIED; privilege unavailable'));
 }finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error('Native metadata research failed:',e.code||e.name);process.exitCode=1;});
