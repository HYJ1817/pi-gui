# Private guardian. Spec arrives over stdin; argv contains no process environment.
$ErrorActionPreference = 'Stop'
# This is a redirected protocol pipe, not an interactive console. Open its
# actual inherited handle without Console's global input initialization. Keep
# one UTF-8 reader for both the spec and EOF control, including buffered bytes.
$spec = $null
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
public static class PiGuiJob {
  [StructLayout(LayoutKind.Sequential)] struct SECURITY { public int length; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUP { public int cb; public string reserved, desktop, title; public int x,y,cx,cy,charsX,charsY,fill,flags; public short show,reserved2; public IntPtr data2,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPEX { public STARTUP startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASICLIMIT { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IOCOUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDEDLIMIT { public BASICLIMIT basic; public IOCOUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref EXTENDEDLIMIT info,uint size);
  [DllImport("kernel32",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out ACCOUNTING info,uint size,IntPtr length);
  [DllImport("kernel32",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pSecurity,IntPtr tSecurity,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPEX startup,out PROCESS info);
  [DllImport("kernel32",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY security,uint size);
  [DllImport("kernel32",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string file,uint access,uint share,ref SECURITY security,uint mode,uint flags,IntPtr template);
  [DllImport("kernel32")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32",SetLastError=true)] static extern IntPtr GetStdHandle(int type);
  public static TextReader OpenInput() {
    var handle=GetStdHandle(-10);
    if(handle==IntPtr.Zero||handle==new IntPtr(-1))throw new Exception("input_unavailable");
    return new StreamReader(new FileStream(new SafeFileHandle(handle,false),FileAccess.Read),new UTF8Encoding(false));
  }
  static void Check(bool value) { if(!value)throw new Exception("native_failure"); }
  static string Quote(string arg) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in arg) { if(c=='\\'){slashes++;continue;} if(c=='\"')b.Append('\\',slashes*2+1);else b.Append('\\',slashes);b.Append(c);slashes=0; }
    b.Append('\\',slashes*2);return b.Append('"').ToString();
  }
  static void Send(string type,string identity,uint code) { Console.Out.WriteLine("{\"type\":\""+type+"\",\"identity\":\""+identity+"\",\"code\":"+code+"}");Console.Out.Flush(); }
  public static void Run(string command,string[] args,string cwd,string[] entries,string identity,TextReader input) {
    IntPtr job=IntPtr.Zero,read=IntPtr.Zero,write=IntPtr.Zero,nul=IntPtr.Zero,env=IntPtr.Zero,list=IntPtr.Zero,handles=IntPtr.Zero;
    PROCESS process=new PROCESS();bool assigned=false;FileStream stream=null;Task pump=null;
    try {
      job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
      var limits=new EXTENDEDLIMIT();limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits)));
      var security=new SECURITY {length=Marshal.SizeOf(typeof(SECURITY)),inherit=1};
      Check(CreatePipe(out read,out write,ref security,0));Check(SetHandleInformation(read,1,0));
      nul=CreateFile("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero);Check(nul!=new IntPtr(-1));
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);list=Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(list,1,0,ref size));
      handles=Marshal.AllocHGlobal(IntPtr.Size*2);Marshal.WriteIntPtr(handles,0,nul);Marshal.WriteIntPtr(handles,IntPtr.Size,write);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*2),IntPtr.Zero,IntPtr.Zero));
      var startup=new STARTUPEX();startup.startup.cb=Marshal.SizeOf(typeof(STARTUPEX));startup.startup.flags=0x100;startup.startup.input=nul;startup.startup.output=write;startup.startup.error=write;startup.attributes=list;
      var cmd=new StringBuilder(Quote(command));foreach(var arg in args)cmd.Append(" ").Append(Quote(arg));
      Array.Sort(entries,StringComparer.OrdinalIgnoreCase);env=Marshal.StringToHGlobalUni(String.Join("\0",entries)+"\0\0");
      // Suspended -> assigned -> resumed: no child can escape before ownership exists.
      Check(CreateProcess(command,cmd,IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,cwd,ref startup,out process));
      Check(AssignProcessToJobObject(job,process.process));assigned=true;
      CloseHandle(write);write=IntPtr.Zero;CloseHandle(nul);nul=IntPtr.Zero;
      stream=new FileStream(new SafeFileHandle(read,true),FileAccess.Read);read=IntPtr.Zero;
      pump=Task.Run(()=>stream.CopyTo(Console.OpenStandardError()));
      Check(ResumeThread(process.thread)!=0xffffffff);Send("started",identity,0);
      var control=Task.Run(()=>input.ReadLine());bool exited=false;
      while(true) {
        if(control.IsCompleted){Check(TerminateJobObject(job,0));break;}
        if(!exited&&WaitForSingleObject(process.process,0)==0){uint code;Check(GetExitCodeProcess(process.process,out code));Send("exit",identity,code);exited=true;}
        ACCOUNTING account;Check(QueryInformationJobObject(job,1,out account,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero));
        if(account.active==0)break;
        System.Threading.Thread.Sleep(25);
      }
      // Wait for the kernel's job accounting, not a taskkill PID assumption.
      for(int i=0;i<200;i++){ACCOUNTING a;Check(QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero));if(a.active==0)break;System.Threading.Thread.Sleep(25);if(i==199)throw new Exception("cleanup_unconfirmed");}
      if(pump!=null)pump.Wait(1000);
    } finally {
      if(process.process!=IntPtr.Zero&&!assigned)TerminateProcess(process.process,1);
      if(job!=IntPtr.Zero)CloseHandle(job);
      if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);if(process.process!=IntPtr.Zero)CloseHandle(process.process);
      if(stream!=null)stream.Dispose();if(read!=IntPtr.Zero)CloseHandle(read);if(write!=IntPtr.Zero)CloseHandle(write);if(nul!=IntPtr.Zero&&nul!=new IntPtr(-1))CloseHandle(nul);
      if(list!=IntPtr.Zero){DeleteProcThreadAttributeList(list);Marshal.FreeHGlobal(list);}if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);
    }
  }
}
'@
  $inputReader = [PiGuiJob]::OpenInput()
  $spec = $inputReader.ReadLine() | ConvertFrom-Json
  [string[]]$entries = @($spec.env.psobject.Properties | ForEach-Object { $_.Name + '=' + [string]$_.Value })
  [PiGuiJob]::Run([string]$spec.command, [string[]]@($spec.args), [string]$spec.cwd, $entries, [string]$spec.identity, $inputReader)
} catch {
  # Never forward native exception messages, source snippets, spec, or paths.
  [Console]::Out.WriteLine((@{ type='failure'; identity=[string]$spec.identity } | ConvertTo-Json -Compress))
  exit 1
}
