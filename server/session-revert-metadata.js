import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

// A deliberately narrow, versioned profile. In particular, an unreadable SACL is
// unknown, never an empty SACL. Ordinary users may therefore be preview-only.
const PROFILE = 'windows-local-ntfs-v1';
function run(script, args) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const env={...process.env,PI_REVERT_METADATA_ARGS:Buffer.from(JSON.stringify(args)).toString('base64')};
  for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],
    {windowsHide:true, timeout:15000, maxBuffer:128*1024, env},
    (error, stdout) => { if(error) reject(Object.assign(Error('metadata_unavailable'),{code:'metadata_unavailable'})); else {try{resolve(JSON.parse(stdout.trim()));}catch{reject(Object.assign(Error('metadata_unavailable'),{code:'metadata_unavailable'}));}} }));
}
const HEADER = `$ErrorActionPreference='Stop'; $x=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PI_REVERT_METADATA_ARGS))|ConvertFrom-Json; $p=$x.path; `;
const PRIVILEGE = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class RevertNative {
 [StructLayout(LayoutKind.Sequential)] public struct IO_STATUS_BLOCK {public IntPtr Status; public UIntPtr Information;}
 [StructLayout(LayoutKind.Sequential)] public struct LUID {public uint LowPart; public int HighPart;}
 [StructLayout(LayoutKind.Sequential)] public struct TOKEN_PRIVILEGES {public uint Count; public LUID Luid; public uint Attributes;}
 [DllImport("advapi32.dll",SetLastError=true)] public static extern bool OpenProcessToken(IntPtr h,uint access,out IntPtr token);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool LookupPrivilegeValue(string system,string name,out LUID luid);
 [DllImport("advapi32.dll",SetLastError=true)] public static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref TOKEN_PRIVILEGES state,uint size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool MoveFileEx(string source,string dest,uint flags);
 [DllImport("ntdll.dll")] public static extern int NtQueryInformationFile(IntPtr file,out IO_STATUS_BLOCK status,out uint eaSize,uint length,int infoClass);
 public static long EaSize(string path){try{using(var file=new System.IO.FileStream(path,System.IO.FileMode.Open,System.IO.FileAccess.Read,System.IO.FileShare.ReadWrite|System.IO.FileShare.Delete)){IO_STATUS_BLOCK status;uint size;int result=NtQueryInformationFile(file.SafeFileHandle.DangerousGetHandle(),out status,out size,4,7);return result<0?-1L:(long)size;}}catch{return -1;}}
 public static bool EnableAudit(){IntPtr token;if(!OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle,0x28,out token))return false;try{LUID luid;if(!LookupPrivilegeValue(null,"SeSecurityPrivilege",out luid))return false;TOKEN_PRIVILEGES p=new TOKEN_PRIVILEGES{Count=1,Luid=luid,Attributes=2};return AdjustTokenPrivileges(token,false,ref p,0,IntPtr.Zero,IntPtr.Zero)&&Marshal.GetLastWin32Error()==0;}finally{CloseHandle(token);}}
}
'@; $auditEnabled=[RevertNative]::EnableAudit(); `;
const INSPECT = HEADER + PRIVILEGE + `try {
 $i=Get-Item -LiteralPath $p -Force; $a=[int]$i.Attributes;
 # Only Hidden, Archive, Normal and NotContentIndexed are supported. Unknown
 # future flags are refused rather than silently discarded by replacement.
 if(($a -band (-bnot (2+32+128+8192))) -ne 0){@{supported=$false;reason='metadata_attributes_unsupported'}|ConvertTo-Json -Compress; exit};
 $drive=[IO.Path]::GetPathRoot($p); $v=Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='"+$drive.TrimEnd('\\')+"'");
 if(!$v -or $v.FileSystem -ne 'NTFS' -or $v.DriveType -ne 3 -or !$v.VolumeSerialNumber){@{supported=$false;reason='metadata_volume_unsupported'}|ConvertTo-Json -Compress; exit};
 $streams=@(Get-Item -LiteralPath $p -Stream *); if(@($streams|Where-Object {$_.Stream -ne ':$DATA'}).Count -ne 0){@{supported=$false;reason='metadata_streams_unsupported'}|ConvertTo-Json -Compress; exit};
 if(!$auditEnabled){@{supported=$false;reason='metadata_audit_unavailable'}|ConvertTo-Json -Compress; exit};
 $eaSize=[RevertNative]::EaSize($p); if($eaSize -ne 0){@{supported=$false;reason='metadata_extended_attributes_unsupported'}|ConvertTo-Json -Compress; exit};
 try {$acl=Get-Acl -LiteralPath $p -Audit} catch {@{supported=$false;reason='metadata_audit_unavailable'}|ConvertTo-Json -Compress; exit};
 $sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All);
 @{supported=$true;version=1;profile='${PROFILE}';platform='win32';volume=($v.DeviceID+':'+$v.VolumeSerialNumber);acl=$sddl;attributes=$a;streams=@()}|ConvertTo-Json -Compress -Depth 5
} catch {@{supported=$false;reason='metadata_unavailable'}|ConvertTo-Json -Compress}`;

export async function inspectFileMetadata(absolute) {
  if (process.platform !== 'win32' || !path.isAbsolute(absolute) || absolute.startsWith('\\\\')) return {supported:false,reason:'metadata_platform_unsupported'};
  try {
    const stat=await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1) return {supported:false,reason:'metadata_path_unsupported'};
    return await run(INSPECT,{path:absolute});
  } catch {return {supported:false,reason:'metadata_unavailable'};}
}

export async function preserveFileMetadata(absolute, metadata) {
  if (!metadata?.supported || metadata.profile!==PROFILE || metadata.platform!=='win32' || process.platform!=='win32') throw Object.assign(Error('metadata_unsupported'),{code:'metadata_unsupported'});
  await run(HEADER + PRIVILEGE + `if(!$auditEnabled){throw 'audit_unavailable'}; $acl=New-Object Security.AccessControl.FileSecurity; $acl.SetSecurityDescriptorSddlForm($x.metadata.acl,[Security.AccessControl.AccessControlSections]::All); Set-Acl -LiteralPath $p -AclObject $acl; [IO.File]::SetAttributes($p,[IO.FileAttributes][int]$x.metadata.attributes); @{ok=$true}|ConvertTo-Json -Compress`,{path:absolute,metadata});
}

/** Windows same-volume move with no REPLACE_EXISTING and no COPY_ALLOWED flag. */
export async function moveFileNoReplace(source,destination) {
  if(process.platform!=='win32')throw Object.assign(Error('writer_unsupported'),{code:'writer_unsupported'});
  const result=await run(HEADER+PRIVILEGE+`$ok=[RevertNative]::MoveFileEx($x.source,$x.destination,0); @{ok=$ok;nativeCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error()}|ConvertTo-Json -Compress`,{source,destination});
  if(!result.ok)throw Object.assign(Error('restore_move_failed'),{code:'restore_move_failed'});
}

export async function protectRecoveryPath(absolute,{initialize=false,directory=true}={}) {
  if(process.platform!=='win32')throw Object.assign(Error('recovery_storage_unavailable'),{code:'recovery_storage_unavailable'});
  return run(HEADER+`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544'); `+
    (initialize?`$acl=New-Object Security.AccessControl.${directory?'DirectorySecurity':'FileSecurity'}; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach($s in $allowed){$id=New-Object Security.Principal.SecurityIdentifier($s); $rule=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','${directory?'ContainerInherit,ObjectInherit':'None'}','None','Allow'); $acl.AddAccessRule($rule)}; Set-Acl -LiteralPath $p -AclObject $acl; `:'')+
    `$acl=Get-Acl -LiteralPath $p; if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or !$acl.AreAccessRulesProtected){throw 'privacy'}; $own=$false; foreach($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow'){if($allowed -notcontains $r.IdentityReference.Value){throw 'privacy'};if($r.IdentityReference.Value -eq $sid.Value -and (($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)){$own=$true}}};if(!$own){throw 'privacy'}; @{ok=$true}|ConvertTo-Json -Compress`,{path:absolute});
}
