# D2 isolated core. No setup, privilege adjustment, fault or metadata setter command.
$ErrorActionPreference='Stop'
function Line { $b=[Text.StringBuilder]::new(); while($true){$c=[Console]::In.Read();if($c -lt 0){throw 'eof'};if($c -eq 10){return $b.ToString()};if($b.Length -ge 32768){throw 'budget'};[void]$b.Append([char]$c)} }
function Exact($o,$keys){if(!$o -or @($o.PSObject.Properties.Name).Count -ne $keys.Count){throw 'shape'};foreach($k in $o.PSObject.Properties.Name){if($k -notin $keys){throw 'field'}}}
function Emit($phase,$status,$measurement){[Console]::Out.WriteLine((@{version=1;phase=$phase;attemptId=$a.attemptId;bindingDigest=$a.bindingDigest;status=$status;measurement=$measurement}|ConvertTo-Json -Compress -Depth 8));[Console]::Out.Flush()}
$writer=$null
try {
 $a=(Line)|ConvertFrom-Json
 Exact $a @('version','command','attemptId','nonce','bindingDigest','planId','intentRevision','root','relativePath','inputs','expectedObject')
 if($a.version -isnot [int] -or $a.version -ne 1 -or $a.command -cne 'open' -or $a.attemptId -notmatch '^[a-f0-9-]{36}$' -or $a.nonce -notmatch '^[a-f0-9]{64}$' -or $a.bindingDigest -notmatch '^[a-f0-9]{64}$' -or $a.planId -notmatch '^[a-f0-9-]{36}$' -or $a.intentRevision -isnot [int] -or $a.intentRevision -ne 1){throw 'protocol'}
 Exact $a.expectedObject @('version','profileId','source','binding','status','platform','file','path','security','streams','ea','times','nonAtomic')
 $root=[IO.Path]::GetFullPath([string]$a.root);$relative=[string]$a.relativePath
 if($root.StartsWith('\\') -or ![IO.Path]::IsPathRooted($root) -or [IO.Path]::IsPathRooted($relative) -or $relative -match '[\x00-\x1f\x7f:]' -or @([regex]::Split($relative,'[\\/]')|Where-Object {$_ -in @('','..','.','.git','.pi')}).Count){throw 'path'}
 if(@($a.inputs).Count -ne 2){throw 'input'}
 foreach($i in $a.inputs){Exact $i @('path','digest','bytes','ino');if($i.digest -notmatch '^[a-f0-9]{64}$' -or $i.bytes -lt 0 -or $i.bytes -gt 2097152 -or $i.ino -notmatch '^\d+$'){throw 'input'}}
 Add-Type -TypeDefinition @'
using System; using System.IO; using System.Text; using System.Collections.Generic; using System.Diagnostics; using System.Security.Cryptography; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles; using System.Security.AccessControl; using System.Security.Principal;
public sealed class OriginalObjectWriter : IDisposable {
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

 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(SafeFileHandle h,byte[] b,uint n,out uint count,IntPtr over);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle h,long pos,out long actual,uint method);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetEndOfFile(SafeFileHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
 [DllImport("ntdll.dll")] static extern int NtQueryEaFile(SafeFileHandle h,out IoStatus io,byte[] b,uint length,[MarshalAs(UnmanagedType.U1)] bool single,IntPtr list,uint listLength,IntPtr index,[MarshalAs(UnmanagedType.U1)] bool restart);
 readonly List<SafeFileHandle> pins=new List<SafeFileHandle>(); readonly List<string> locations=new List<string>(); readonly List<string> ids=new List<string>();
 SafeFileHandle target,current,candidate; string targetPath; byte[] C,R; string preMetadata; int targetParents; public bool WriteStarted;
 public string FailureCause="unconfirmed";public int FailureNativeCode; void Api(bool ok,string cause){if(!ok){FailureCause=cause;FailureNativeCode=Marshal.GetLastWin32Error();throw new IOException("native_api");}}
 static void Check(bool ok){if(!ok)throw new IOException("native_api");}
 static void Seek(SafeFileHandle h,long pos){long actual;Check(SetFilePointerEx(h,pos,out actual,0));Check(actual==pos);}
 static byte[] ReadBytes(SafeFileHandle h){Check(Process.GetCurrentProcess().WorkingSet64<=268435456);var i=Information(h);Check((i.Attributes&0x410)==0&&i.Links==1&&i.SizeHigh==0&&i.SizeLow<=2097152);Seek(h,0);byte[] all=new byte[(int)i.SizeLow];int offset=0;while(offset<all.Length){byte[] b=new byte[Math.Min(65536,all.Length-offset)];uint count;Check(ReadFile(h,b,(uint)b.Length,out count,IntPtr.Zero)&&count>0&&count<=b.Length);Buffer.BlockCopy(b,0,all,offset,(int)count);offset+=(int)count;}byte[] extra=new byte[1];uint end;Check(ReadFile(h,extra,1,out end,IntPtr.Zero)&&end==0);return all;}
 void PinParents(string path){var chain=new List<string>();string p=Path.GetDirectoryName(path);while(p!=null){Check(chain.Count<128);chain.Add(p);var next=Directory.GetParent(p);p=next==null?null:next.FullName;}chain.Reverse();foreach(string at in chain){var h=CreateFileW(at,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);Check(!h.IsInvalid);pins.Add(h);locations.Add(at);var i=Information(h);Check((i.Attributes&0x410)==0x10);Canonical(h,at);ids.Add(Id(i));}}
 void Paths(){for(int n=0;n<pins.Count;n++){var i=Information(pins[n]);Check(Id(i)==ids[n]&&(i.Attributes&0x410)==0x10);Canonical(pins[n],locations[n]);using(var again=Open(locations[n],0x80)){Check(Id(Information(again))==ids[n]);}}Canonical(target,targetPath);var t=Information(target);Check((t.Attributes&0x410)==0&&t.Links==1);using(var again=Open(targetPath,0x80)){Check(Id(Information(again))==Id(t));}}
 static void Private(SafeFileHandle h){var sd=new RawSecurityDescriptor(Descriptor(h,7));var identity=WindowsIdentity.GetCurrent();string own=identity.User.Value;var allowed=new HashSet<string>(new[]{own,"S-1-5-18","S-1-5-32-544"});Check(sd.Owner!=null&&allowed.Contains(sd.Owner.Value)&&sd.DiscretionaryAcl!=null);bool user=false;foreach(GenericAce ace in sd.DiscretionaryAcl){var known=ace as CommonAce;Check(known!=null);if(known.AceQualifier==AceQualifier.AccessAllowed){Check(allowed.Contains(known.SecurityIdentifier.Value));if(known.SecurityIdentifier.Value==own&&(known.AccessMask&0x1f01ff)==0x1f01ff)user=true;}}Check(user);}
 SafeFileHandle Material(string p,string hash,int bytes,string ino){Check(Path.IsPathRooted(p)&&!p.StartsWith("\\\\"));PinParents(p);var h=CreateFileW(p,0x120089,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);Check(!h.IsInvalid);var i=Information(h);Check((i.Attributes&0x410)==0&&i.Links==1&&i.SizeHigh==0&&i.SizeLow==bytes&&(((ulong)i.IdHigh<<32)|i.IdLow).ToString()==ino);Canonical(h,p);Private(h);Check(Digest(ReadBytes(h))==hash);return h;}
 public OriginalObjectWriter(string p,string expectedId,string cPath,string cHash,int cBytes,string cIno,string rPath,string rHash,int rBytes,string rIno){try{
  targetPath=Path.GetFullPath(p);PinParents(targetPath);targetParents=ids.Count;
  // Read/write DATA, READ_EA, READ_ATTRIBUTES, READ_CONTROL, SYNCHRONIZE only.
  target=CreateFileW(targetPath,0x12008b,0,IntPtr.Zero,3,0x02200000,IntPtr.Zero);Check(!target.IsInvalid);var i=Information(target);Check(Id(i)==expectedId&&(i.Attributes&0x410)==0&&i.Links==1);Canonical(target,targetPath);
  var volume=new StringBuilder(8192);var fileSystem=new StringBuilder(64);uint serial,max,flags;Check(GetVolumePathNameW(targetPath,volume,8192)&&GetVolumeInformationW(volume.ToString(),null,0,out serial,out max,out flags,fileSystem,64));Check(fileSystem.ToString()=="NTFS"&&GetDriveTypeW(volume.ToString())==3);
  current=Material(cPath,cHash,cBytes,cIno);candidate=Material(rPath,rHash,rBytes,rIno);C=ReadBytes(current);R=ReadBytes(candidate);Check(Digest(ReadBytes(target))==cHash);Text(C);Text(R);Paths();preMetadata=MetadataSignature();
 }catch{Dispose();throw;}}
 static void Text(byte[] b){new UTF8Encoding(false,true).GetString(b);foreach(byte c in b)Check(!(c<=8||c==11||c==12||(c>=14&&c<=31)||c==127));}
 public Dictionary<string,object> Snapshot(){Paths();var info=Information(target);var sd=new RawSecurityDescriptor(Descriptor(target,7));string sacl=null;string auditState="unavailable";try{using(var audit=Open(targetPath,0x01020080)){Check(Id(Information(audit))==Id(info));sacl=Descriptor(audit,8);auditState="known";}}catch{}
  IoStatus io;uint eaSize;Check(NtQueryInformationFile(target,out io,out eaSize,4,7)>=0&&eaSize<=65536);string eaHash="";if(eaSize>0){byte[] ea=new byte[65536];int status=NtQueryEaFile(target,out io,ea,(uint)ea.Length,false,IntPtr.Zero,0,IntPtr.Zero,true);Check(status>=0&&io.Information.ToUInt64()<=65536);byte[] used=new byte[(int)io.Information.ToUInt64()];Buffer.BlockCopy(ea,0,used,0,used.Length);eaHash=Digest(used);}
  var streams=new List<string>();var streamHashes=new List<string>();StreamInfo si;IntPtr find=FindFirstStreamW(targetPath,0,out si,0);Check(find!=new IntPtr(-1));try{bool more=true;while(more){Check(streams.Count<32);streams.Add(si.Name);if(si.Name!="::$DATA"){Check(si.Size>=0&&si.Size<=2097152);using(var stream=Open(targetPath+si.Name,0x120089)){streamHashes.Add(si.Name+":"+Digest(ReadBytes(stream)));}}more=FindNextStreamW(find,out si);if(!more)Check(Marshal.GetLastWin32Error()==38);}}finally{FindClose(find);}streams.Sort(StringComparer.Ordinal);streamHashes.Sort(StringComparer.Ordinal);
  return Row("creation",info.Creation.ToString(),"lastAccess",info.Access.ToString(),"lastWrite",info.Write.ToString(),"parents",ids.GetRange(0,targetParents),"id",Id(info),"links",info.Links,"attributes",info.Attributes,"owner",sd.Owner.Value,"group",sd.Group.Value,"dacl",sd.GetSddlForm(AccessControlSections.Access),"descriptor",Descriptor(target,7),"saclState",auditState,"sacl",sacl,"streams",streams,"streamHashes",streamHashes,"eaBytes",eaSize,"eaHash",eaHash,"digest",Digest(ReadBytes(target)),"bytes",(int)Information(target).SizeLow,"nonAtomic",true);
 }
 string MetadataSignature(){var s=Snapshot();var b=new StringBuilder();foreach(string key in new[]{"creation","id","links","attributes","owner","group","dacl","descriptor","saclState","sacl","eaBytes","eaHash"})b.Append(key).Append(':').Append(s[key]).Append('|');foreach(string name in (List<string>)s["streams"])b.Append(name).Append('|');foreach(string name in (List<string>)s["streamHashes"])b.Append(name).Append('|');return b.ToString();}
 public bool Unchanged(){Private(current);Private(candidate);return MetadataSignature()==preMetadata&&Digest(ReadBytes(target))==Digest(C)&&Digest(ReadBytes(current))==Digest(C)&&Digest(ReadBytes(candidate))==Digest(R);}
 public Dictionary<string,object> Commit(){Check(Unchanged());Paths();Seek(target,0);WriteStarted=true;int offset=0;while(offset<R.Length){byte[] b=new byte[Math.Min(65536,R.Length-offset)];Buffer.BlockCopy(R,offset,b,0,b.Length);uint count;/*D2_WRITE_BOUNDARY*/Api(WriteFile(target,b,(uint)b.Length,out count,IntPtr.Zero),"write_failed");Check(count>0&&count<=b.Length);offset+=(int)count;}
  Seek(target,R.Length);/*D2_EOF_BOUNDARY*/Api(SetEndOfFile(target),"eof_failed");/*D2_FLUSH_BOUNDARY*/Api(FlushFileBuffers(target),"flush_failed");/*D2_RESULT_BOUNDARY*/Check(Digest(ReadBytes(target))==Digest(R));Private(current);Private(candidate);var after=Snapshot();after["metadataEqual"]=MetadataSignature()==preMetadata;Check((bool)after["metadataEqual"]);Check(Digest(ReadBytes(current))==Digest(C)&&Digest(ReadBytes(candidate))==Digest(R));return after;
 }
 public void Dispose(){if(target!=null)target.Dispose();if(current!=null)current.Dispose();if(candidate!=null)candidate.Dispose();foreach(var h in pins)h.Dispose();pins.Clear();}
}
'@
 $p=[IO.Path]::GetFullPath([IO.Path]::Combine($root,$relative));if(!$p.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'path'}
 $c=$a.inputs[0];$r=$a.inputs[1];$e=$a.expectedObject
 $writer=[OriginalObjectWriter]::new($p,$e.file.id,$c.path,$c.digest,$c.bytes,$c.ino,$r.path,$r.digest,$r.bytes,$r.ino)
 $before=$writer.Snapshot()
 if($before.attributes -notin @(32,34,8224,8226) -or $before.attributes -ne $e.file.attributes -or $before.owner -cne $e.security.owner.value -or $before.group -cne $e.security.group.value -or $before.dacl -cne $e.security.dacl.value -or $before.eaBytes -ne $e.ea.bytes -or (@($before.streams) -join '|') -cne (@($e.streams.names) -join '|')){throw 'metadata'}
 if($e.security.sacl.state -eq 'known' -and ($before.saclState -ne 'known' -or $before.sacl -cne $e.security.sacl.value)){throw 'sacl'}
 Emit 'ready' 'ready' $before
 $b=(Line)|ConvertFrom-Json
 Exact $b @('version','command','attemptId','nonce','bindingDigest','planId','intentRevision')
 foreach($key in @('version','attemptId','nonce','bindingDigest','planId','intentRevision')){if($b.$key -cne $a.$key){throw 'binding'}}
 if($b.command -ceq 'cancel'){Emit 'result' 'not_applied' $null}
 elseif($b.command -ceq 'commit'){
  # Exactly one terminal command, then EOF. Duplicate commands refuse pre-write.
  if([Console]::In.Read() -ne -1){throw 'duplicate'}
  $after=$writer.Commit();Emit 'result' 'verified' $after
 }else{throw 'command'}
}catch{if($writer -and $writer.WriteStarted){Emit 'result' 'recovery_required' @{cause=$writer.FailureCause;nativeCode=$writer.FailureNativeCode}}else{Emit 'result' 'refused' $null}}
finally{if($writer){$writer.Dispose()}}
