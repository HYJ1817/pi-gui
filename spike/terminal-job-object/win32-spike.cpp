// P3-C0 test-only Win32 spike. Not production code, not linked into the app.
//
// Verifies, on the machine it runs on:
//   - Plan B+ (ConPTY + PROC_THREAD_ATTRIBUTE_JOB_LIST + CREATE_SUSPENDED)
//   - Plan B  (ConPTY + PROC_THREAD_ATTRIBUTE_JOB_LIST, no suspension)
//   - ActiveProcesses accounting (suspended, handle reference, nested jobs)
//   - KILL_ON_JOB_CLOSE for a suspended process and for a creator crash
//     before ResumeThread
//   - TerminateJobObject return-vs-exit timing
//   - TerminateProcess / WaitForSingleObject / CloseHandle failure returns
//   - ClosePseudoConsole return timing with and without a drained output pipe
//   - conhost membership in the job, WMI-created process escape
//   - natural shell exit with a surviving background descendant
//
// Every child used by the tests is this same executable in "child" mode; all
// files live under %TEMP%\pi-gui-p3c0-*. No user data is touched.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00

#include <windows.h>
#include <consoleapi.h>
#include <winternl.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

using namespace std::chrono;

// ---------------------------------------------------------------- utilities

static uint64_t now_ms() {
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

// Wall-clock epoch milliseconds, used where the value must be comparable with
// timestamps written by a different process (the worker_threads driver).
static uint64_t epoch_ms() {
  FILETIME ft{};
  GetSystemTimeAsFileTime(&ft);
  ULARGE_INTEGER u{};
  u.LowPart = ft.dwLowDateTime;
  u.HighPart = ft.dwHighDateTime;
  return u.QuadPart / 10000ULL - 11644473600000ULL;
}

static int count_lines(const std::string& s) {
  return (int)std::count(s.begin(), s.end(), '\n');
}

static std::string to_u8(const std::wstring& w) {
  if (w.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string out((size_t)n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), out.data(), n, nullptr, nullptr);
  return out;
}

static std::string esc(const std::string& s) {
  std::string o;
  o.reserve(s.size() + 8);
  for (char c : s) {
    switch (c) {
      case '\\': o += "\\\\"; break;
      case '"': o += "\\\""; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if ((unsigned char)c < 0x20) {
          char b[8];
          std::snprintf(b, sizeof(b), "\\u%04x", (unsigned char)c);
          o += b;
        } else {
          o += c;
        }
    }
  }
  return o;
}

struct Json {
  std::ostringstream o;
  bool first = true;
  Json() { o << "{"; }
  void sep() {
    if (!first) o << ",";
    first = false;
  }
  Json& s(const char* k, const std::string& v) {
    sep(); o << "\"" << k << "\":\"" << esc(v) << "\""; return *this;
  }
  Json& w(const char* k, const std::wstring& v) { return s(k, to_u8(v)); }
  Json& n(const char* k, long long v) {
    sep(); o << "\"" << k << "\":" << v; return *this;
  }
  Json& b(const char* k, bool v) {
    sep(); o << "\"" << k << "\":" << (v ? "true" : "false"); return *this;
  }
  Json& raw(const char* k, const std::string& v) {
    sep(); o << "\"" << k << "\":" << v; return *this;
  }
  std::string str() { o << "}"; return o.str(); }
};

static std::wstring self_path() {
  wchar_t buf[MAX_PATH * 4];
  DWORD n = GetModuleFileNameW(nullptr, buf, (DWORD)(sizeof(buf) / sizeof(buf[0])));
  return std::wstring(buf, n);
}

static std::wstring env_str(const wchar_t* name, const wchar_t* fallback) {
  wchar_t buf[MAX_PATH * 2];
  DWORD n = GetEnvironmentVariableW(name, buf, (DWORD)(sizeof(buf) / sizeof(buf[0])));
  if (n == 0 || n >= sizeof(buf) / sizeof(buf[0])) return fallback;
  return std::wstring(buf, n);
}

static std::wstring comspec() {
  return env_str(L"ComSpec", L"C:\\Windows\\System32\\cmd.exe");
}

static std::wstring powershell_path() {
  return env_str(L"SystemRoot", L"C:\\Windows") +
         L"\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
}

// The execution sandbox used for this C0 run denies writes under %TEMP%
// (CreateDirectoryW -> ERROR_ACCESS_DENIED) while the working tree is
// writable. Fixtures therefore live under the spike's own .tmp directory; no
// user data or application data directory is touched.
static std::wstring make_temp_dir() {
  std::wstring exe = self_path();
  size_t p = exe.find_last_of(L"\\/");
  std::wstring base = (p == std::wstring::npos ? std::wstring(L".") : exe.substr(0, p)) + L"\\.tmp";
  CreateDirectoryW(base.c_str(), nullptr);
  std::wstring dir = base + L"\\run-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
                     std::to_wstring(GetTickCount64());
  CreateDirectoryW(dir.c_str(), nullptr);
  return dir;
}

static bool file_exists(const std::wstring& path) {
  DWORD a = GetFileAttributesW(path.c_str());
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

static bool wait_file(const std::wstring& path, DWORD timeout_ms) {
  uint64_t end = now_ms() + timeout_ms;
  while (now_ms() < end) {
    if (file_exists(path)) return true;
    Sleep(20);
  }
  return file_exists(path);
}

static bool write_text(const std::wstring& path, const std::string& text) {
  std::ofstream f(path.c_str(), std::ios::binary | std::ios::trunc);
  if (!f) return false;
  f.write(text.data(), (std::streamsize)text.size());
  return f.good();
}

static std::string read_text(const std::wstring& path) {
  std::ifstream f(path.c_str(), std::ios::binary);
  if (!f) return std::string();
  std::ostringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

static std::string win_version() {
  OSVERSIONINFOW vi{};
  vi.dwOSVersionInfoSize = sizeof(vi);
  typedef LONG(WINAPI * RtlGetVersionFn)(PRTL_OSVERSIONINFOW);
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  auto fn = ntdll ? (RtlGetVersionFn)GetProcAddress(ntdll, "RtlGetVersion") : nullptr;
  if (fn) fn((PRTL_OSVERSIONINFOW)&vi);
  char b[64];
  std::snprintf(b, sizeof(b), "%lu.%lu.%lu", vi.dwMajorVersion, vi.dwMinorVersion, vi.dwBuildNumber);
  return b;
}

static bool in_any_job() {
  BOOL r = FALSE;
  if (!IsProcessInJob(GetCurrentProcess(), nullptr, &r)) return false;
  return r != FALSE;
}

static std::wstring image_name(DWORD pid) {
  HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!p) return std::wstring();
  wchar_t buf[2048];
  DWORD n = (DWORD)(sizeof(buf) / sizeof(buf[0]));
  std::wstring out;
  if (QueryFullProcessImageNameW(p, 0, buf, &n)) out.assign(buf, n);
  CloseHandle(p);
  return out;
}

static std::wstring base_name(const std::wstring& path) {
  size_t p = path.find_last_of(L"\\/");
  return p == std::wstring::npos ? path : path.substr(p + 1);
}

// ---------------------------------------------------------------- job helpers

static bool make_job(HANDLE& job, bool kill_on_close, DWORD* err) {
  job = CreateJobObjectW(nullptr, nullptr);
  if (!job) {
    if (err) *err = GetLastError();
    return false;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION li{};
  li.BasicLimitInformation.LimitFlags =
      kill_on_close ? JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE : 0;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &li, sizeof(li))) {
    if (err) *err = GetLastError();
    CloseHandle(job);
    job = nullptr;
    return false;
  }
  return true;
}

struct Acct {
  bool ok = false;
  DWORD err = 0;
  DWORD active = 0;
  DWORD total = 0;
  DWORD terminated = 0;
};

static Acct query_acct(HANDLE job) {
  Acct a;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
  if (!job) {
    a.err = ERROR_INVALID_HANDLE;
    return a;
  }
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info,
                                 sizeof(info), nullptr)) {
    a.err = GetLastError();
    return a;
  }
  a.ok = true;
  a.active = info.ActiveProcesses;
  a.total = info.TotalProcesses;
  a.terminated = info.TotalTerminatedProcesses;
  return a;
}

static std::vector<DWORD> query_pids(HANDLE job, DWORD* err = nullptr) {
  std::vector<DWORD> out;
  if (!job) {
    if (err) *err = ERROR_INVALID_HANDLE;
    return out;
  }
  std::vector<BYTE> buf(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + 255 * sizeof(ULONG_PTR));
  DWORD ret = 0;
  if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buf.data(),
                                 (DWORD)buf.size(), &ret)) {
    if (err) *err = GetLastError();
    return out;
  }
  auto* list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buf.data());
  for (DWORD i = 0; i < list->NumberOfProcessIdsInList; ++i) out.push_back(list->ProcessIdList[i]);
  return out;
}

static std::string pids_json(const std::vector<DWORD>& v) {
  std::ostringstream o;
  o << "[";
  for (size_t i = 0; i < v.size(); ++i) {
    if (i) o << ",";
    o << v[i];
  }
  o << "]";
  return o.str();
}

static bool pids_include_conhost(const std::vector<DWORD>& pids) {
  for (DWORD pid : pids) {
    std::wstring base = base_name(image_name(pid));
    if (_wcsicmp(base.c_str(), L"conhost.exe") == 0 ||
        _wcsicmp(base.c_str(), L"OpenConsole.exe") == 0) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- ConPTY

struct ConPty {
  HPCON hpc = nullptr;
  HANDLE in_write = nullptr;
  HANDLE out_read = nullptr;

  bool create(DWORD* err) {
    HANDLE in_read = nullptr, out_write = nullptr;
    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    if (!CreatePipe(&in_read, &in_write, &sa, 0)) {
      if (err) *err = GetLastError();
      return false;
    }
    if (!CreatePipe(&out_read, &out_write, &sa, 0)) {
      if (err) *err = GetLastError();
      CloseHandle(in_read);
      CloseHandle(in_write);
      in_write = nullptr;
      return false;
    }
    COORD size{120, 30};
    HRESULT hr = CreatePseudoConsole(size, in_read, out_write, 0, &hpc);
    CloseHandle(in_read);
    CloseHandle(out_write);
    if (FAILED(hr)) {
      if (err) *err = (DWORD)hr;
      close_pipes();
      return false;
    }
    return true;
  }

  void close_pipes() {
    if (in_write) { CloseHandle(in_write); in_write = nullptr; }
    if (out_read) { CloseHandle(out_read); out_read = nullptr; }
  }

  uint64_t close_hpc() {
    if (!hpc) return 0;
    uint64_t t0 = now_ms();
    ClosePseudoConsole(hpc);
    uint64_t dt = now_ms() - t0;
    hpc = nullptr;
    return dt;
  }
};

// ---------------------------------------------------------------- spawn

struct Spawn {
  bool ok = false;
  DWORD err = 0;
  PROCESS_INFORMATION pi{};

  void close_handles() {
    if (pi.hThread) { CloseHandle(pi.hThread); pi.hThread = nullptr; }
    if (pi.hProcess) { CloseHandle(pi.hProcess); pi.hProcess = nullptr; }
  }
};

static bool update_attr(LPPROC_THREAD_ATTRIBUTE_LIST attr, DWORD_PTR which, void* value,
                        SIZE_T size, DWORD* err) {
  if (!UpdateProcThreadAttribute(attr, 0, which, value, size, nullptr, nullptr)) {
    if (err) *err = GetLastError();
    return false;
  }
  return true;
}

// Creates with STARTUPINFOEX only when a job and/or ConPTY attribute is used.
static Spawn spawn_ex(const std::wstring& cmd, HANDLE job, HPCON hpc, bool suspended,
                      bool use_job, bool use_conpty, DWORD extra_flags = 0) {
  Spawn r;
  DWORD count = (use_job ? 1u : 0u) + (use_conpty ? 1u : 0u);
  if (count == 0) {
    r.err = ERROR_INVALID_PARAMETER;
    return r;
  }
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, count, 0, &size);
  std::vector<BYTE> buf(size ? size : 1);
  auto attr = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(buf.data());
  if (!InitializeProcThreadAttributeList(attr, count, 0, &size)) {
    r.err = GetLastError();
    return r;
  }
  bool attr_ok = true;
  if (use_conpty) {
    attr_ok = update_attr(attr, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc, sizeof(HPCON), &r.err);
  }
  HANDLE jobs[1] = {job};
  if (attr_ok && use_job) {
    attr_ok = update_attr(attr, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, sizeof(jobs), &r.err);
  }
  if (!attr_ok) {
    DeleteProcThreadAttributeList(attr);
    return r;
  }

  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof(si);
  si.lpAttributeList = attr;
  if (use_conpty) {
    // Match node-pty (conpty.cc:387-390): the ConPTY client must not inherit
    // the host's std handles; the pseudoconsole provides its own console.
    // Without this, a GUI/redirected parent leaks EOF-on-stdin into cmd /k.
    si.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = nullptr;
    si.StartupInfo.hStdOutput = nullptr;
    si.StartupInfo.hStdError = nullptr;
  }
  std::vector<wchar_t> line(cmd.begin(), cmd.end());
  line.push_back(0);
  DWORD flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | extra_flags;
  if (suspended) flags |= CREATE_SUSPENDED;
  r.ok = CreateProcessW(nullptr, line.data(), nullptr, nullptr, FALSE, flags, nullptr, nullptr,
                        &si.StartupInfo, &r.pi) != FALSE;
  if (!r.ok) r.err = GetLastError();
  DeleteProcThreadAttributeList(attr);
  return r;
}

static Spawn spawn_plain(const std::wstring& cmd, bool suspended = false) {
  Spawn r;
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  std::vector<wchar_t> line(cmd.begin(), cmd.end());
  line.push_back(0);
  DWORD flags = CREATE_UNICODE_ENVIRONMENT;
  if (suspended) flags |= CREATE_SUSPENDED;
  r.ok = CreateProcessW(nullptr, line.data(), nullptr, nullptr, FALSE, flags, nullptr, nullptr,
                        &si, &r.pi) != FALSE;
  if (!r.ok) r.err = GetLastError();
  return r;
}

static DWORD wait_proc(HANDLE h, DWORD timeout_ms) {
  return WaitForSingleObject(h, timeout_ms);
}

// ---------------------------------------------------------------- child modes

static int run_child(const std::vector<std::wstring>& args) {
  int seconds = 30;
  std::wstring marker, pidfile, tick_file;
  int tick_ms = 200;
  for (size_t i = 0; i < args.size(); ++i) {
    if (args[i] == L"--seconds" && i + 1 < args.size()) seconds = _wtoi(args[++i].c_str());
    else if (args[i] == L"--marker" && i + 1 < args.size()) marker = args[++i];
    else if (args[i] == L"--pidfile" && i + 1 < args.size()) pidfile = args[++i];
    else if (args[i] == L"--tick-file" && i + 1 < args.size()) tick_file = args[++i];
    else if (args[i] == L"--tick-ms" && i + 1 < args.size()) tick_ms = _wtoi(args[++i].c_str());
  }
  if (!pidfile.empty()) {
    std::ofstream f(pidfile.c_str(), std::ios::trunc);
    f << GetCurrentProcessId();
  }
  if (!marker.empty()) {
    std::ofstream f(marker.c_str(), std::ios::trunc);
    f << "child";
  }
  if (!tick_file.empty()) {
    // Appended one line per tick so a parent process can prove the child was
    // running, and that it stopped, without trusting PIDs.
    std::ofstream tick(tick_file.c_str(), std::ios::app);
    int total = std::max(0, seconds) * 1000;
    int step = std::max(1, tick_ms);
    for (int elapsed = 0; elapsed < total; elapsed += step) {
      tick << epoch_ms() << " " << GetCurrentProcessId() << "\n";
      tick.flush();
      Sleep((DWORD)step);
    }
    return 0;
  }
  Sleep((DWORD)std::max(0, seconds) * 1000);
  return 0;
}

// Creates a job + suspended child, verifies, records the child pid, then dies
// without closing anything. Process teardown closes the job handle.
static int run_crash_helper(const std::vector<std::wstring>& args) {
  std::wstring pidfile;
  for (size_t i = 0; i < args.size(); ++i) {
    if (args[i] == L"--pidfile" && i + 1 < args.size()) pidfile = args[++i];
  }
  HANDLE job = nullptr;
  DWORD err = 0;
  if (!make_job(job, true, &err)) return 2;
  std::wstring child = L"\"" + self_path() + L"\" child --seconds 30";
  Spawn sp = spawn_ex(child, job, nullptr, true, true, false);
  if (!sp.ok) return 3;
  BOOL in_job = FALSE;
  IsProcessInJob(sp.pi.hProcess, job, &in_job);
  Acct a = query_acct(job);
  if (!in_job || !a.ok || a.active < 1) return 4;
  if (!pidfile.empty()) {
    std::ofstream f(pidfile.c_str(), std::ios::trunc);
    f << sp.pi.dwProcessId;
    f.flush();
  }
  // Give the parent time to open the child before this process (and therefore
  // the Job handle) dies. The wait itself is outside the Job on purpose.
  Sleep(1500);
  TerminateProcess(GetCurrentProcess(), 0xC0DE);
  return 0;  // unreachable
}

// Runs ClosePseudoConsole with/without draining the output pipe. Writes JSON
// to --out. The parent runs this under a cleanup job and times it out.
static int run_conpty_close_child(const std::vector<std::wstring>& args) {
  std::wstring mode = L"nodrain", out;
  for (size_t i = 0; i < args.size(); ++i) {
    if (args[i] == L"--mode" && i + 1 < args.size()) mode = args[++i];
    else if (args[i] == L"--out" && i + 1 < args.size()) out = args[++i];
  }
  DWORD err = 0;
  ConPty pty;
  if (!pty.create(&err)) {
    Json j;
    j.s("test", "conpty-close-child").b("created", false).n("err", err);
    write_text(out, j.str());
    return 2;
  }
  Spawn sp = spawn_ex(L"\"" + comspec() + L"\" /d /q /k", nullptr, pty.hpc, false, false, true);
  if (!sp.ok) {
    Json j;
    j.s("test", "conpty-close-child").b("created", true).b("spawn", false).n("err", sp.err);
    write_text(out, j.str());
    pty.close_hpc();
    return 3;
  }

  std::atomic<bool> reader_stop{false};
  std::atomic<uint64_t> bytes_read{0};
  std::thread reader;
  if (mode == L"drain" && pty.out_read) {
    reader = std::thread([&] {
      char buf[4096];
      while (!reader_stop.load(std::memory_order_relaxed)) {
        DWORD avail = 0;
        if (!PeekNamedPipe(pty.out_read, nullptr, 0, nullptr, &avail, nullptr)) break;
        if (avail == 0) {
          Sleep(5);
          continue;
        }
        DWORD got = 0;
        if (!ReadFile(pty.out_read, buf, (DWORD)std::min<DWORD>(avail, sizeof(buf)), &got, nullptr)) break;
        bytes_read.fetch_add(got, std::memory_order_relaxed);
      }
    });
  }

  // Fill the output pipe with more than its buffer when not draining.
  std::wstring flood =
      L"for /L %i in (1,1,8000) do @echo 0123456789012345678901234567890123456789\r\n";
  DWORD written = 0;
  WriteFile(pty.in_write, flood.c_str(), (DWORD)(flood.size() * sizeof(wchar_t)), &written, nullptr);
  Sleep(1000);

  uint64_t t0 = now_ms();
  ClosePseudoConsole(pty.hpc);
  uint64_t close_ms = now_ms() - t0;
  pty.hpc = nullptr;

  DWORD wait_rc = wait_proc(sp.pi.hProcess, 3000);
  if (wait_rc != WAIT_OBJECT_0) TerminateProcess(sp.pi.hProcess, 1);
  reader_stop.store(true);
  if (reader.joinable()) reader.join();
  pty.close_pipes();
  sp.close_handles();

  Json j;
  j.s("test", "conpty-close-child").s("mode", to_u8(mode)).b("created", true)
      .b("spawn", true).n("closeMs", (long long)close_ms).n("bytesRead",
      (long long)bytes_read.load()).n("shellWait", wait_rc).b("returned", true);
  write_text(out, j.str());
  return 0;
}

// Fixture backend for experiment 1: ConPTY + Plan B+, shell resumed, a
// long-running child started inside the shell, then an abnormal exit without
// closing anything. Process teardown closes the Job handle; KILL_ON_JOB_CLOSE
// must take the shell and the child with it. The parent opens its own handles
// before the crash and verifies liveness by identity, not by PID lookup.
static int run_backend_crash_helper(const std::vector<std::wstring>& args) {
  std::wstring dir, tag, state;
  int child_seconds = 60;
  for (size_t i = 0; i < args.size(); ++i) {
    if (args[i] == L"--dir" && i + 1 < args.size()) dir = args[++i];
    else if (args[i] == L"--tag" && i + 1 < args.size()) tag = args[++i];
    else if (args[i] == L"--state" && i + 1 < args.size()) state = args[++i];
    else if (args[i] == L"--child-seconds" && i + 1 < args.size())
      child_seconds = _wtoi(args[++i].c_str());
  }
  if (dir.empty() || tag.empty()) return 2;

  HANDLE job = nullptr;
  DWORD err = 0;
  if (!make_job(job, true, &err)) return 3;
  ConPty pty;
  if (!pty.create(&err)) {
    CloseHandle(job);
    return 4;
  }
  Spawn sp = spawn_ex(L"\"" + comspec() + L"\" /d /q /k", job, pty.hpc, true, true, true);
  if (!sp.ok) {
    pty.close_hpc();
    pty.close_pipes();
    CloseHandle(job);
    return 5;
  }
  // Written before resume so the parent can open a process handle while the
  // shell is still suspended.
  std::wstring shell_pidfile = dir + L"\\" + tag + L".shell.pid";
  write_text(shell_pidfile, std::to_string(sp.pi.dwProcessId));
  BOOL in_job = FALSE;
  IsProcessInJob(sp.pi.hProcess, job, &in_job);
  Acct a0 = query_acct(job);
  DWORD resume_ret = ResumeThread(sp.pi.hThread);

  Sleep(1500);  // let cmd /k print its banner and prompt
  std::wstring child_pidfile = dir + L"\\" + tag + L".child.pid";
  std::wstring tick = dir + L"\\" + tag + L".tick";
  std::wstring script = dir + L"\\" + tag + L".cmd";
  write_text(script, "@start \"\" /b \"" + to_u8(self_path()) + "\" child --seconds " +
                         std::to_string(child_seconds) + " --tick-file \"" + to_u8(tick) +
                         "\" --tick-ms 100 --pidfile \"" + to_u8(child_pidfile) + "\"\r\n");
  std::string input = "call \"" + to_u8(script) + "\"\r\n";
  DWORD written = 0;
  WriteFile(pty.in_write, input.data(), (DWORD)input.size(), &written, nullptr);

  bool child_ready = wait_file(child_pidfile, 10000);
  bool tick_ready = wait_file(tick, 10000);
  Acct a1 = query_acct(job);
  std::vector<DWORD> p1 = query_pids(job);
  Json j;
  j.s("role", "backend-crash-helper").s("windows", win_version())
      .n("shellPid", sp.pi.dwProcessId).n("resumeRet", (long long)resume_ret)
      .b("inJobBeforeResume", in_job != FALSE).n("activeBeforeResume", a0.active)
      .b("childReady", child_ready).b("tickReady", tick_ready)
      .n("activeBeforeCrash", a1.active).raw("pidsBeforeCrash", pids_json(p1))
      .n("writtenToPty", written);
  write_text(state, j.str());
  // Window for the parent to open both process handles.
  Sleep(2000);
  TerminateProcess(GetCurrentProcess(), 0xC0DE);
  return 0;  // unreachable
}

// Opens a process by PID before the owner Job is closed and records what
// happens to that identity-bearing handle. Used by the worker_threads driver.
static int run_watch_child(const std::vector<std::wstring>& args) {
  DWORD pid = 0;
  int timeout_ms = 30000;
  std::wstring open_out, out;
  for (size_t i = 0; i < args.size(); ++i) {
    if (args[i] == L"--pid" && i + 1 < args.size()) pid = (DWORD)_wtoi(args[++i].c_str());
    else if (args[i] == L"--timeout" && i + 1 < args.size()) timeout_ms = _wtoi(args[++i].c_str());
    else if (args[i] == L"--open-out" && i + 1 < args.size()) open_out = args[++i];
    else if (args[i] == L"--out" && i + 1 < args.size()) out = args[++i];
  }
  uint64_t t0 = now_ms();
  HANDLE h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  DWORD open_err = h ? 0 : GetLastError();
  Json o;
  o.s("role", "watch-child").n("pid", pid).b("open", h != nullptr).n("openErr", open_err)
      .n("openAt", (long long)epoch_ms()).n("openMs", (long long)(now_ms() - t0));
  if (!open_out.empty()) write_text(open_out, o.str());
  if (!h) {
    if (!out.empty()) write_text(out, o.str());
    return 2;
  }
  DWORD w = WaitForSingleObject(h, (DWORD)std::max(0, timeout_ms));
  DWORD code = 0;
  GetExitCodeProcess(h, &code);
  Json j;
  j.s("role", "watch-child").n("pid", pid).b("open", true).n("openErr", 0)
      .n("wait", w).n("exitCode", code).n("waitMs", (long long)(now_ms() - t0))
      .n("exitAt", (long long)epoch_ms());
  if (!out.empty()) write_text(out, j.str());
  CloseHandle(h);
  return w == WAIT_OBJECT_0 ? 0 : 3;
}

// ---------------------------------------------------------------- tests

static bool test_selftest(const std::wstring& temp) {
  Json j;
  BOOL mk = CreateDirectoryW(temp.c_str(), nullptr);
  DWORD mkerr = mk ? 0 : GetLastError();
  std::wstring probe = temp + L"\\probe.txt";
  bool wrote = write_text(probe, "probe");
  DWORD werr = wrote ? 0 : GetLastError();
  j.s("test", "selftest").s("windows", win_version()).b("inAnyJob", in_any_job())
      .n("pid", GetCurrentProcessId()).w("self", self_path()).w("comspec", comspec())
      .w("temp", temp).b("tempExists", file_exists(temp))
      .b("mkdirAgain", mk != FALSE).n("mkdirErr", mkerr)
      .b("probeWrote", wrote).n("probeErr", werr).b("probeExists", file_exists(probe))
      .s("arch", sizeof(void*) == 8 ? "x64" : "x86");
  std::cout << j.str() << "\n";
  return true;
}

// Shared body for B+ / B, with/without ConPTY. `suspended` must be true for B+.
static bool test_bind(const char* name, bool use_conpty, bool suspended,
                      const std::wstring& temp) {
  Json j;
  j.s("test", name).s("windows", win_version()).b("inAnyJob", in_any_job())
      .b("conpty", use_conpty).b("suspended", suspended);

  HANDLE job = nullptr;
  DWORD err = 0;
  if (!make_job(job, true, &err)) {
    j.b("ok", false).n("jobErr", err);
    std::cout << j.str() << "\n";
    return false;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION q{};
  bool limit_ok = QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &q,
                                            sizeof(q), nullptr) != FALSE;
  j.b("limitQuery", limit_ok)
      .b("killOnClose", (q.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) != 0);

  ConPty pty;
  if (use_conpty) {
    if (!pty.create(&err)) {
      j.b("ok", false).n("conptyErr", err);
      CloseHandle(job);
      std::cout << j.str() << "\n";
      return false;
    }
  }

  std::wstring tag = std::wstring(L"p3c0-") + std::to_wstring(GetCurrentProcessId()) + L"-" +
                     std::to_wstring(now_ms());
  std::wstring script = temp + L"\\" + tag + L".cmd";
  std::wstring marker = temp + L"\\" + tag + L".marker";
  DeleteFileW(marker.c_str());
  write_text(script, "@echo x>\"" + to_u8(marker) + "\"\r\n@exit /b 0\r\n");
  std::wstring cmd = L"\"" + comspec() + L"\" /d /q /c \"" + script + L"\"";

  uint64_t t0 = now_ms();
  Spawn sp = spawn_ex(cmd, job, pty.hpc, suspended, true, use_conpty);
  j.b("spawn", sp.ok).n("spawnErr", sp.err).n("spawnMs", (long long)(now_ms() - t0));
  if (!sp.ok) {
    if (use_conpty) { pty.close_hpc(); pty.close_pipes(); }
    CloseHandle(job);
    j.b("ok", false);
    std::cout << j.str() << "\n";
    return false;
  }

  BOOL in_job = FALSE;
  BOOL in_job_ok = IsProcessInJob(sp.pi.hProcess, job, &in_job);
  Acct a0 = query_acct(job);
  bool marker_before = file_exists(marker);
  j.b("inJobBeforeResume", in_job != FALSE).b("isInJobCall", in_job_ok != FALSE)
      .b("acctBeforeOk", a0.ok).n("activeBeforeResume", a0.active)
      .b("markerBeforeResume", marker_before);

  DWORD resume_ret = (DWORD)-1;
  if (suspended) {
    resume_ret = ResumeThread(sp.pi.hThread);
    j.n("resumeRet", (long long)resume_ret);
  }

  bool marker_after = wait_file(marker, 5000);
  j.b("markerAfterResume", marker_after);
  DWORD wait_shell = wait_proc(sp.pi.hProcess, 8000);
  DWORD exit_code = 0;
  GetExitCodeProcess(sp.pi.hProcess, &exit_code);
  Acct a1 = query_acct(job);
  j.n("shellWait", wait_shell).n("shellExitCode", exit_code)
      .b("acctAfterShellOk", a1.ok).n("activeAfterShellExit", a1.active);

  // C0 counting-order question: does our own hShell handle keep the process
  // counted until it is closed?
  BOOL closed = CloseHandle(sp.pi.hProcess);
  sp.pi.hProcess = nullptr;
  Acct a2 = query_acct(job);
  j.b("closeShell", closed != FALSE).b("acctAfterCloseOk", a2.ok)
      .n("activeAfterCloseShell", a2.active);

  std::vector<DWORD> pl = query_pids(job);
  j.raw("jobPids", pids_json(pl)).b("conhostInJob", pids_include_conhost(pl));

  uint64_t close_ms = pty.close_hpc();
  j.n("closeHpcMs", (long long)close_ms);
  pty.close_pipes();
  sp.close_handles();
  CloseHandle(job);

  bool ok = sp.ok && in_job != FALSE && marker_after && wait_shell == WAIT_OBJECT_0;
  if (suspended) ok = ok && !marker_before;
  j.b("ok", ok);
  std::cout << j.str() << "\n";
  return ok;
}

// ConPTY + JOB_LIST + CREATE_SUSPENDED, but keep an interactive shell alive so
// conhost membership is observable.
static bool test_conpty_shell(const std::wstring& temp) {
  Json j;
  j.s("test", "conpty-shell").s("windows", win_version()).b("inAnyJob", in_any_job());
  HANDLE job = nullptr;
  DWORD err = 0;
  if (!make_job(job, true, &err)) {
    j.b("ok", false).n("jobErr", err);
    std::cout << j.str() << "\n";
    return false;
  }
  ConPty pty;
  if (!pty.create(&err)) {
    j.b("ok", false).n("conptyErr", err);
    CloseHandle(job);
    std::cout << j.str() << "\n";
    return false;
  }
  Spawn sp = spawn_ex(L"\"" + comspec() + L"\" /d /q /k", job, pty.hpc, true, true, true);
  j.b("spawn", sp.ok).n("spawnErr", sp.err);
  if (!sp.ok) {
    pty.close_hpc();
    pty.close_pipes();
    CloseHandle(job);
    j.b("ok", false);
    std::cout << j.str() << "\n";
    return false;
  }
  BOOL in_job = FALSE;
  IsProcessInJob(sp.pi.hProcess, job, &in_job);
  Acct a0 = query_acct(job);
  std::vector<DWORD> p0 = query_pids(job);
  j.b("inJobBeforeResume", in_job != FALSE).b("acctBeforeOk", a0.ok)
      .n("activeBeforeResume", a0.active).raw("pidsBeforeResume", pids_json(p0))
      .b("conhostBeforeResume", pids_include_conhost(p0));

  DWORD rr = ResumeThread(sp.pi.hThread);
  j.n("resumeRet", (long long)rr);
  Sleep(1500);
  Acct a1 = query_acct(job);
  std::vector<DWORD> p1 = query_pids(job);
  j.b("acctRunningOk", a1.ok).n("activeRunning", a1.active)
      .raw("pidsRunning", pids_json(p1)).b("conhostRunning", pids_include_conhost(p1))
      .raw("imagesRunning", [&] {
        std::ostringstream o; o << "[";
        for (size_t i = 0; i < p1.size(); ++i) {
          if (i) o << ",";
          o << "\"" << esc(to_u8(base_name(image_name(p1[i])))) << "\"";
        }
        o << "]";
        return o.str();
      }());

  // ConPTY input is a byte stream (UTF-8), not UTF-16.
  std::string input = "exit\r\n";
  DWORD written = 0;
  WriteFile(pty.in_write, input.data(), (DWORD)input.size(), &written, nullptr);
  DWORD wait_shell = wait_proc(sp.pi.hProcess, 8000);
  Acct a2 = query_acct(job);
  j.n("shellWait", wait_shell).b("acctAfterShellOk", a2.ok).n("activeAfterShellExit", a2.active);
  CloseHandle(sp.pi.hProcess);
  sp.pi.hProcess = nullptr;
  Acct a3 = query_acct(job);
  j.n("activeAfterCloseShell", a3.active);
  uint64_t close_ms = pty.close_hpc();
  j.n("closeHpcMs", (long long)close_ms);
  pty.close_pipes();
  sp.close_handles();
  CloseHandle(job);
  bool ok = sp.ok && in_job != FALSE && a0.active >= 1 && wait_shell == WAIT_OBJECT_0;
  j.b("ok", ok);
  std::cout << j.str() << "\n";
  return ok;
}

static bool test_conpty_shell_debug(const std::wstring& temp, bool use_job) {
  Json j;
  j.s("test", use_job ? "conpty-shell-debug-job" : "conpty-shell-debug-nojob")
      .s("windows", win_version());
  HANDLE job = nullptr;
  DWORD err = 0;
  if (use_job && !make_job(job, true, &err)) {
    j.b("ok", false).n("jobErr", err);
    std::cout << j.str() << "\n";
    return false;
  }
  ConPty pty;
  if (!pty.create(&err)) {
    j.b("ok", false).n("conptyErr", err);
    if (job) CloseHandle(job);
    std::cout << j.str() << "\n";
    return false;
  }
  Spawn sp = spawn_ex(L"\"" + comspec() + L"\"", job, pty.hpc, true, use_job, true);
  j.b("spawn", sp.ok).n("spawnErr", sp.err);
  if (!sp.ok) {
    pty.close_hpc(); pty.close_pipes(); if (job) CloseHandle(job);
    j.b("ok", false);
    std::cout << j.str() << "\n";
    return false;
  }
  DWORD rr = ResumeThread(sp.pi.hThread);
  j.n("resumeRet", (long long)rr);
  std::string output;
  std::atomic<bool> stop{false};
  std::thread reader([&] {
    char buf[4096];
    while (!stop.load()) {
      DWORD avail = 0;
      if (!PeekNamedPipe(pty.out_read, nullptr, 0, nullptr, &avail, nullptr)) break;
      if (avail == 0) { Sleep(10); continue; }
      DWORD got = 0;
      if (!ReadFile(pty.out_read, buf, (DWORD)std::min<DWORD>(avail, sizeof(buf)), &got, nullptr)) break;
      output.append(buf, got);
    }
  });
  Sleep(2000);
  DWORD code = 0;
  GetExitCodeProcess(sp.pi.hProcess, &code);
  std::vector<DWORD> pl = use_job ? query_pids(job) : std::vector<DWORD>();
  j.n("exitCodeAfter2s", code).b("stillActive", code == STILL_ACTIVE)
      .raw("pids", pids_json(pl)).s("output", output.substr(0, 512));
  std::string input = "exit\r\n";
  DWORD written = 0;
  WriteFile(pty.in_write, input.data(), (DWORD)input.size(), &written, nullptr);
  DWORD w = wait_proc(sp.pi.hProcess, 5000);
  j.n("shellWait", w);
  stop.store(true);
  reader.join();
  CloseHandle(sp.pi.hProcess);
  sp.pi.hProcess = nullptr;
  sp.close_handles();
  pty.close_hpc();
  pty.close_pipes();
  if (job) CloseHandle(job);
  j.b("ok", sp.ok && code == STILL_ACTIVE);
  std::cout << j.str() << "\n";
  return true;
}

static bool test_kill_on_close_suspended(const std::wstring& temp) {
  Json j;
  j.s("test", "kill-on-close-suspended").s("windows", win_version());
  HANDLE job = nullptr;
  DWORD err = 0;
  if (!make_job(job, true, &err)) {
    j.b("ok", false).n("jobErr", err);
    std::cout << j.str() << "\n";
    return false;
  }
  std::wstring child = L"\"" + self_path() + L"\" child --seconds 30";
  Spawn sp = spawn_ex(child, job, nullptr, true, true, false);
  j.b("spawn", sp.ok).n("spawnErr", sp.err);
  if (!sp.ok) {
    CloseHandle(job);
    j.b("ok", false);
    std::cout << j.str() << "\n";
    return false;
  }
  BOOL in_job = FALSE;
  IsProcessInJob(sp.pi.hProcess, job, &in_job);
  Acct a = query_acct(job);
  j.b("inJobBeforeResume", in_job != FALSE).b("acctOk", a.ok).n("activeBeforeResume", a.active);
  uint64_t t0 = now_ms();
  CloseHandle(job);  // last job handle -> KILL_ON_JOB_CLOSE
  job = nullptr;
  DWORD w = wait_proc(sp.pi.hProcess, 10000);
  uint64_t dt = now_ms() - t0;
  j.n("waitAfterClose", w).n("exitMs", (long long)dt);
  if (w != WAIT_OBJECT_0) {
    TerminateProcess(sp.pi.hProcess, 1);
    wait_proc(sp.pi.hProcess, 5000);
  }
  sp.close_handles();
  bool ok = in_job != FALSE && w == WAIT_OBJECT_0;
  j.b("ok", ok);
  std::cout << j.str() << "\n";
  return ok;
}

static bool test_crash_before_resume(const std::wstring& temp) {
  Json j;
  j.s("test", "crash-before-resume").s("windows", win_version());
  std::wstring tag = std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(now_ms());
  std::wstring pidfile = temp + L"\\crash-child-" + tag + L".pid";
  std::wstring cmd = L"\"" + self_path() + L"\" crash-helper --pidfile \"" + pidfile + L"\"";
  Spawn helper = spawn_plain(cmd);
  j.b("helperSpawn", helper.ok).n("helperErr", helper.err);
  if (!helper.ok) {
    j.b("ok", false);
    std::cout << j.str() << "\n";
    return false;
  }
  // Open the child BEFORE the helper dies so the verdict is a wait on an
  // identity-bearing handle, not a PID lookup that a recycled PID could fool.
  bool pid_ok = wait_file(pidfile, 10000);
  j.b("childPidFile", pid_ok);
  DWORD child_pid = 0;
  if (pid_ok) {
    std::string s = read_text(pidfile);
    child_pid = (DWORD)std::strtoul(s.c_str(), nullptr, 10);
  }
  j.n("childPid", child_pid);
  HANDLE child = nullptr;
  DWORD open_err = 0;
  if (child_pid) {
    child = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, child_pid);
    if (!child) open_err = GetLastError();
  }
  j.b("childOpen", child != nullptr).n("childOpenErr", open_err);

  DWORD hw = wait_proc(helper.pi.hProcess, 10000);
  DWORD helper_code = 0;
  GetExitCodeProcess(helper.pi.hProcess, &helper_code);
  j.n("helperWait", hw).n("helperExitCode", helper_code);
  helper.close_handles();

  bool ok = false;
  if (child) {
    DWORD w = wait_proc(child, 10000);
    j.n("childWaitAfterHelperCrash", w);
    if (w != WAIT_OBJECT_0) {
      TerminateProcess(child, 1);
      wait_proc(child, 5000);
    }
    CloseHandle(child);
    ok = hw == WAIT_OBJECT_0 && w == WAIT_OBJECT_0;
  } else {
    // ERROR_INVALID_PARAMETER means the PID is gone. With the pre-crash open
    // window above this is the rare path, recorded rather than hidden.
    j.n("helperWaitWithNoChild", hw);
    ok = hw == WAIT_OBJECT_0 && open_err == ERROR_INVALID_PARAMETER;
  }
  j.b("ok", ok);
  std::cout << j.str() << "\n";
  return ok;
}

static bool test_terminate_timing(const std::wstring& temp) {
  Json j;
  j.s("test", "terminate-timing").s("windows", win_version());
  HANDLE job = nullptr;
  DWORD err = 0;
  if (!make_job(job, true, &err)) {
    j.b("ok", false).n("jobErr", err);
    std::cout << j.str() << "\n";
    return false;
  }
  std::vector<Spawn> procs;
  std::wstring child = L"\"" + self_path() + L"\" child --seconds 30";
  for (int i = 0; i < 3; ++i) {
    Spawn sp = spawn_ex(child, job, nullptr, false, true, false);
    if (!sp.ok) {
      j.b("spawn", false).n("spawnErr", sp.err);
      for (auto& p : procs) p.close_handles();
      CloseHandle(job);
      j.b("ok", false);
      std::cout << j.str() << "\n";
      return false;
    }
    procs.push_back(sp);
  }
  Sleep(300);
  Acct before = query_acct(job);
  j.b("acctBeforeOk", before.ok).n("activeBefore", before.active);

  uint64_t t0 = now_ms();
  BOOL term = TerminateJobObject(job, 7);
  DWORD term_err = term ? 0 : GetLastError();
  uint64_t ret_ms = now_ms() - t0;
  j.b("terminate", term != FALSE).n("terminateErr", term_err).n("terminateReturnMs", (long long)ret_ms);

  std::ostringstream immediateWait;
  immediateWait << "[";
  for (size_t i = 0; i < procs.size(); ++i) {
    DWORD w = wait_proc(procs[i].pi.hProcess, 0);
    if (i) immediateWait << ",";
    immediateWait << w;
  }
  immediateWait << "]";
  Acct imm = query_acct(job);
  j.raw("immediateWait", immediateWait.str()).b("acctImmediateOk", imm.ok)
      .n("activeImmediate", imm.active);

  std::ostringstream exit_ms;
  exit_ms << "[";
  bool all_exited = true;
  for (size_t i = 0; i < procs.size(); ++i) {
    DWORD w = wait_proc(procs[i].pi.hProcess, 10000);
    if (i) exit_ms << ",";
    exit_ms << (long long)(now_ms() - t0);
    if (w != WAIT_OBJECT_0) {
      all_exited = false;
      TerminateProcess(procs[i].pi.hProcess, 1);
    }
  }
  exit_ms << "]";
  j.raw("exitMsFromTerminate", exit_ms.str());
  Acct after_handles_open = query_acct(job);
  j.b("acctAfterExitOk", after_handles_open.ok).n("activeAfterExitWithHandles",
                                                  after_handles_open.active);
  for (auto& p : procs) p.close_handles();
  Acct after_handles_closed = query_acct(job);
  j.b("acctAfterHandlesClosedOk", after_handles_closed.ok)
      .n("activeAfterHandlesClosed", after_handles_closed.active);
  CloseHandle(job);
  bool ok = term != FALSE && all_exited;
  j.b("ok", ok);
  std::cout << j.str() << "\n";
  return ok;
}

static bool test_wait_failures(const std::wstring& temp) {
  Json j;
  j.s("test", "wait-failures").s("windows", win_version());
  std::wstring child = L"\"" + self_path() + L"\" child --seconds 30";
  Spawn sp = spawn_plain(child);
  j.b("spawn", sp.ok).n("spawnErr", sp.err);
  if (!sp.ok) {
    j.b("ok", false);
    std::cout << j.str() << "\n";
    return false;
  }
  DWORD w_running = wait_proc(sp.pi.hProcess, 0);
  j.n("waitRunning", w_running);
  HANDLE bad = (HANDLE)(ULONG_PTR)0x1234;
  DWORD w_bad = WaitForSingleObject(bad, 0);
  j.n("waitBad", w_bad).n("waitBadErr", GetLastError());
  BOOL term = TerminateProcess(sp.pi.hProcess, 5);
  DWORD term_err = term ? 0 : GetLastError();
  DWORD w_after = wait_proc(sp.pi.hProcess, 5000);
  BOOL term_again = TerminateProcess(sp.pi.hProcess, 5);
  DWORD term_again_err = term_again ? 0 : GetLastError();
  BOOL term_bad = TerminateProcess(bad, 0);
  DWORD term_bad_err = term_bad ? 0 : GetLastError();
  j.b("terminateRunning", term != FALSE).n("terminateErr", term_err)
      .n("waitAfterTerminate", w_after)
      .b("terminateAfterExit", term_again != FALSE).n("terminateAfterExitErr", term_again_err)
      .b("terminateBad", term_bad != FALSE).n("terminateBadErr", term_bad_err);

  BOOL close1 = CloseHandle(sp.pi.hProcess);
  DWORD close1_err = close1 ? 0 : GetLastError();
  BOOL close2 = CloseHandle(sp.pi.hProcess);
  DWORD close2_err = close2 ? 0 : GetLastError();
  // Is the value still usable after the failed second CloseHandle? Nothing has
  // opened a new handle since, so the value cannot have been recycled here.
  DWORD stale_wait = WaitForSingleObject(sp.pi.hProcess, 0);
  DWORD stale_wait_err = GetLastError();
  BOOL stale_term = TerminateProcess(sp.pi.hProcess, 0);
  DWORD stale_term_err = GetLastError();
  BOOL close_null = CloseHandle(nullptr);
  DWORD close_null_err = close_null ? 0 : GetLastError();
  sp.pi.hProcess = nullptr;
  BOOL close_bad = CloseHandle(bad);
  DWORD close_bad_err = close_bad ? 0 : GetLastError();
  j.b("closeFirst", close1 != FALSE).n("closeFirstErr", close1_err)
      .b("closeSecond", close2 != FALSE).n("closeSecondErr", close2_err)
      .n("staleWait", (long long)stale_wait).n("staleWaitErr", stale_wait_err)
      .b("staleTerminate", stale_term != FALSE).n("staleTerminateErr", stale_term_err)
      .b("closeNull", close_null != FALSE).n("closeNullErr", close_null_err)
      .b("closeBad", close_bad != FALSE).n("closeBadErr", close_bad_err);
  sp.close_handles();
  bool ok = w_running == WAIT_TIMEOUT && w_bad == WAIT_FAILED && term != FALSE &&
            w_after == WAIT_OBJECT_0 && close2 == FALSE &&
            stale_wait == WAIT_FAILED && stale_term == FALSE;
  j.b("ok", ok);
  std::cout << j.str() << "\n";
  return ok;
}

static bool test_conpty_close(const std::wstring& temp, const wchar_t* mode) {
  Json j;
  j.s("test", "conpty-close").s("windows", win_version()).s("mode", to_u8(mode));
  HANDLE cleanup = nullptr;
  DWORD err = 0;
  if (!make_job(cleanup, true, &err)) {
    j.b("ok", false).n("jobErr", err);
    std::cout << j.str() << "\n";
    return false;
  }
  std::wstring tag = std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(now_ms());
  std::wstring out = temp + L"\\conpty-close-" + std::wstring(mode) + L"-" + tag + L".json";
  std::wstring cmd = L"\"" + self_path() + L"\" conpty-close --mode " + mode + L" --out \"" + out + L"\"";
  Spawn sp = spawn_ex(cmd, cleanup, nullptr, false, true, false);
  j.b("spawn", sp.ok).n("spawnErr", sp.err);
  if (!sp.ok) {
    CloseHandle(cleanup);
    j.b("ok", false);
    std::cout << j.str() << "\n";
    return false;
  }
  uint64_t t0 = now_ms();
  DWORD w = wait_proc(sp.pi.hProcess, 25000);
  uint64_t elapsed = now_ms() - t0;
  j.n("childWait", w).n("elapsedMs", (long long)elapsed);
  bool timed_out = (w == WAIT_TIMEOUT);
  if (timed_out) {
    TerminateJobObject(cleanup, 1);
    wait_proc(sp.pi.hProcess, 5000);
  }
  sp.close_handles();
  CloseHandle(cleanup);  // kills any shell/conhost left in the cleanup job
  std::string child = read_text(out);
  if (child.empty()) {
    j.raw("child", "null");
  } else {
    j.raw("child", child);
  }
  j.b("timedOut", timed_out);
  bool ok = !timed_out && !child.empty();
  j.b("ok", ok);
  std::cout << j.str() << "\n";
  return ok;
}

static bool test_nested(const std::wstring& temp) {
  Json j;
  j.s("test", "nested-job").s("windows", win_version());
  HANDLE parent = nullptr, child_job = nullptr;
  DWORD err = 0;
  if (!make_job(parent, true, &err)) {
    j.b("ok", false).n("parentErr", err);
    std::cout << j.str() << "\n";
    return false;
  }
  if (!make_job(child_job, true, &err)) {
    j.b("ok", false).n("childJobErr", err);
    CloseHandle(parent);
    std::cout << j.str() << "\n";
    return false;
  }
  Spawn sp = spawn_ex(L"\"" + self_path() + L"\" child --seconds 30", parent, nullptr, false, true, false);
  j.b("spawn", sp.ok).n("spawnErr", sp.err);
  if (!sp.ok) {
    CloseHandle(parent);
    CloseHandle(child_job);
    j.b("ok", false);
    std::cout << j.str() << "\n";
    return false;
  }
  BOOL assign = AssignProcessToJobObject(child_job, sp.pi.hProcess);
  DWORD assign_err = assign ? 0 : GetLastError();
  BOOL in_parent = FALSE, in_child = FALSE;
  IsProcessInJob(sp.pi.hProcess, parent, &in_parent);
  IsProcessInJob(sp.pi.hProcess, child_job, &in_child);
  Acct ap = query_acct(parent), ac = query_acct(child_job);
  j.b("assign", assign != FALSE).n("assignErr", assign_err)
      .b("inParent", in_parent != FALSE).b("inChild", in_child != FALSE)
      .b("parentAcctOk", ap.ok).n("parentActive", ap.active)
      .b("childAcctOk", ac.ok).n("childActive", ac.active);

  BOOL term = TerminateJobObject(parent, 9);
  DWORD term_err = term ? 0 : GetLastError();
  DWORD w = wait_proc(sp.pi.hProcess, 10000);
  Acct ap2 = query_acct(parent), ac2 = query_acct(child_job);
  j.b("terminateParent", term != FALSE).n("terminateErr", term_err).n("processWait", w)
      .b("parentAcctAfterOk", ap2.ok).n("parentActiveAfter", ap2.active)
      .b("childAcctAfterOk", ac2.ok).n("childActiveAfter", ac2.active);
  if (w != WAIT_OBJECT_0) TerminateProcess(sp.pi.hProcess, 1);
  sp.close_handles();
  CloseHandle(parent);
  CloseHandle(child_job);
  bool ok = assign != FALSE && in_parent != FALSE && in_child != FALSE && w == WAIT_OBJECT_0;
  j.b("ok", ok);
  std::cout << j.str() << "\n";
  return ok;
}

static bool test_wmi(const std::wstring& temp, bool kill_on_close = true,
                     bool via_job_list = true, bool breakaway = false,
                     DWORD spawn_flags = 0) {
  Json j;
  j.s("test", spawn_flags & CREATE_BREAKAWAY_FROM_JOB
                  ? "wmi-escape-detached"
                  : (breakaway ? "wmi-escape-breakaway"
                               : (via_job_list ? (kill_on_close ? "wmi-escape" : "wmi-escape-nokill")
                                               : "wmi-escape-assign")))
      .s("windows", win_version());
  HANDLE job = nullptr;
  DWORD err = 0;
  if (!make_job(job, kill_on_close, &err)) {
    j.b("ok", false).n("jobErr", err);
    std::cout << j.str() << "\n";
    return false;
  }
  if (breakaway) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION li{};
    li.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    BOOL set = SetInformationJobObject(job, JobObjectExtendedLimitInformation, &li, sizeof(li));
    j.b("breakawaySet", set != FALSE);
  }
  std::wstring tag = std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(now_ms());
  std::wstring marker = temp + L"\\wmi-" + tag + L".marker";
  std::wstring pidfile = temp + L"\\wmi-" + tag + L".pid";
  std::wstring script = temp + L"\\wmi-" + tag + L".ps1";
  std::wstring psout = temp + L"\\wmi-" + tag + L".out";
  std::string ps;
  ps += "$cmd = '\"" + to_u8(self_path()) + "\" child --seconds 15 --marker \"" +
        to_u8(marker) + "\" --pidfile \"" + to_u8(pidfile) + "\"'\r\n";
  // Invoke-CimMethod throws ArgumentException on this machine (CimCmdlets);
  // the [wmiclass] path is the stable WMI entry point here.
  ps += "try { $r = ([wmiclass]'Win32_Process').Create($cmd) } catch {\r\n";
  ps += "('EX=' + $_.Exception.Message) | Out-File -FilePath '" + to_u8(psout) +
        "' -Encoding ascii\r\nexit 1 }\r\n";
  ps += "('RV=' + $r.ReturnValue + ' PID=' + $r.ProcessId) | Out-File -FilePath '" +
        to_u8(psout) + "' -Encoding ascii\r\n";
  ps += "if ($r.ReturnValue -ne 0) { exit 1 }\r\n";
  write_text(script, ps);
  std::wstring cmd = L"\"" + powershell_path() + L"\" -NoProfile -ExecutionPolicy Bypass -File \"" +
                     script + L"\"";
  // The caller must itself be in the Job: the question is whether a process
  // created through WMI inherits Job membership from a Job member.
  Spawn sp = via_job_list ? spawn_ex(cmd, job, nullptr, false, true, false, spawn_flags)
                          : spawn_plain(cmd);
  if (sp.ok && !via_job_list) {
    BOOL assigned = AssignProcessToJobObject(job, sp.pi.hProcess);
    j.b("assignAfterCreate", assigned != FALSE).n("assignErr", assigned ? 0 : GetLastError());
  }
  j.b("powershellSpawn", sp.ok).n("powershellErr", sp.err);
  BOOL ps_in_job = FALSE;
  if (sp.ok) IsProcessInJob(sp.pi.hProcess, job, &ps_in_job);
  j.b("powershellInJob", ps_in_job != FALSE);
  if (!sp.ok) {
    CloseHandle(job);
    j.b("ok", false);
    std::cout << j.str() << "\n";
    return false;
  }
  DWORD w = wait_proc(sp.pi.hProcess, 30000);
  j.n("powershellWait", w);
  sp.close_handles();
  std::string ps_out;
  if (file_exists(psout)) ps_out = read_text(psout);
  bool denied = ps_out.compare(0, 3, "EX=") == 0;
  j.s("psOut", ps_out.substr(0, 200)).b("creationDenied", denied);
  bool marker_ok = wait_file(marker, 5000);
  bool pid_ok = wait_file(pidfile, 5000);
  j.b("marker", marker_ok).b("pidFile", pid_ok);
  DWORD pid = 0;
  if (pid_ok) pid = (DWORD)std::strtoul(read_text(pidfile).c_str(), nullptr, 10);
  j.n("wmiChildPid", pid);
  bool in_job = false;
  if (pid) {
    HANDLE h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    j.b("open", h != nullptr);
    if (h) {
      BOOL b = FALSE;
      IsProcessInJob(h, job, &b);
      in_job = b != FALSE;
      TerminateProcess(h, 0);
      wait_proc(h, 5000);
      CloseHandle(h);
    }
  }
  j.b("inJob", in_job);
  CloseHandle(job);
  // Pass means "the question was answered definitively": the caller was in the
  // Job, and either the WMI child was created and its membership measured, or
  // creation was refused. Which of those happened is the finding.
  bool ok = ps_in_job != FALSE && w == WAIT_OBJECT_0 &&
            (denied || (marker_ok && pid != 0));
  j.b("ok", ok);
  std::cout << j.str() << "\n";
  return ok;
}

static bool test_natural_exit(const std::wstring& temp) {
  Json j;
  j.s("test", "natural-exit-descendant").s("windows", win_version());
  HANDLE job = nullptr;
  DWORD err = 0;
  if (!make_job(job, true, &err)) {
    j.b("ok", false).n("jobErr", err);
    std::cout << j.str() << "\n";
    return false;
  }
  ConPty pty;
  if (!pty.create(&err)) {
    j.b("ok", false).n("conptyErr", err);
    CloseHandle(job);
    std::cout << j.str() << "\n";
    return false;
  }
  Spawn sp = spawn_ex(L"\"" + comspec() + L"\" /d /q /k", job, pty.hpc, true, true, true);
  j.b("spawn", sp.ok).n("spawnErr", sp.err);
  if (!sp.ok) {
    pty.close_hpc();
    pty.close_pipes();
    CloseHandle(job);
    j.b("ok", false);
    std::cout << j.str() << "\n";
    return false;
  }
  BOOL in_job = FALSE;
  IsProcessInJob(sp.pi.hProcess, job, &in_job);
  DWORD rr = ResumeThread(sp.pi.hThread);
  j.b("inJob", in_job != FALSE).n("resumeRet", (long long)rr);
  Sleep(800);

  std::wstring tag = std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(now_ms());
  std::wstring marker = temp + L"\\nat-" + tag + L".marker";
  std::wstring pidfile = temp + L"\\nat-" + tag + L".pid";
  std::wstring script = temp + L"\\nat-" + tag + L".cmd";
  write_text(script, "@start \"\" /b \"" + to_u8(self_path()) +
                          "\" child --seconds 20 --marker \"" + to_u8(marker) +
                          "\" --pidfile \"" + to_u8(pidfile) + "\"\r\n");
  // ConPTY input is a byte stream (UTF-8), not UTF-16. The script path is ASCII.
  std::string input = "call \"" + to_u8(script) + "\"\r\nexit\r\n";
  DWORD written = 0;
  WriteFile(pty.in_write, input.data(), (DWORD)input.size(), &written, nullptr);
  DWORD shell_wait = wait_proc(sp.pi.hProcess, 10000);
  bool marker_ok = wait_file(marker, 8000);
  bool pid_ok = wait_file(pidfile, 8000);
  j.n("shellWait", shell_wait).b("marker", marker_ok).b("pidFile", pid_ok);
  DWORD child_pid = 0;
  if (pid_ok) child_pid = (DWORD)std::strtoul(read_text(pidfile).c_str(), nullptr, 10);
  j.n("descendantPid", child_pid);
  bool alive_in_job = false;
  HANDLE child = nullptr;
  if (child_pid) {
    child = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, child_pid);
    if (child) {
      BOOL b = FALSE;
      IsProcessInJob(child, job, &b);
      alive_in_job = b != FALSE && wait_proc(child, 0) == WAIT_TIMEOUT;
    }
  }
  j.b("descendantInJobAndAlive", alive_in_job);
  Acct a = query_acct(job);
  std::vector<DWORD> p = query_pids(job);
  j.b("acctOk", a.ok).n("activeAfterShellExit", a.active).raw("pidsAfterShellExit", pids_json(p));
  uint64_t t0 = now_ms();
  BOOL term = TerminateJobObject(job, 3);
  j.b("terminateJob", term != FALSE);
  DWORD child_wait = child ? wait_proc(child, 10000) : WAIT_FAILED;
  j.n("descendantWaitAfterTerminate", child_wait).n("descendantExitMs", (long long)(now_ms() - t0));
  if (child) {
    if (child_wait != WAIT_OBJECT_0) TerminateProcess(child, 1);
    CloseHandle(child);
  }
  uint64_t close_ms = pty.close_hpc();
  pty.close_pipes();
  sp.close_handles();
  CloseHandle(job);
  j.n("closeHpcMs", (long long)close_ms);
  bool ok = in_job != FALSE && marker_ok && alive_in_job && term != FALSE &&
            child_wait == WAIT_OBJECT_0;
  j.b("ok", ok);
  std::cout << j.str() << "\n";
  return ok;
}

// Connecting-period cancellation windows. This is the OS-level part of the
// design's lock-free abort protocol: TerminateJobObject on the same hJob that
// CreateProcessW is using via PROC_THREAD_ATTRIBUTE_JOB_LIST, plus the
// before-create / after-create-suspended / after-resume orderings.
static bool test_connect_race(const std::wstring& temp) {
  (void)temp;
  Json j;
  j.s("test", "connect-race").s("windows", win_version());
  struct Case { const char* name; int when; };
  const Case cases[] = {{"before-create", 0},
                        {"during-create", 1},
                        {"after-create-before-resume", 2},
                        {"after-resume", 3}};
  const int kIters = 20;
  bool measured = true;
  for (const Case& cs : cases) {
    int create_ok = 0, create_err = 0, in_job = 0, resume_ok = 0;
    int wait_exited = 0, wait_timeout = 0, term_ok = 0, active_members = 0;
    DWORD last_create_err = 0, last_resume_err = 0;
    std::ostringstream rets, codes, waits;
    rets << "[";
    codes << "[";
    waits << "[";
    for (int i = 0; i < kIters; ++i) {
      HANDLE job = nullptr;
      DWORD err = 0;
      if (!make_job(job, true, &err)) { measured = false; break; }
      Spawn sp;
      std::wstring child = L"\"" + self_path() + L"\" child --seconds 20";
      if (cs.when == 0) {
        if (TerminateJobObject(job, 1)) ++term_ok;
      }
      if (cs.when == 1) {
        std::atomic<bool> go{true};
        std::atomic<bool> term_any{false};
        std::thread killer([&] {
          while (go.load(std::memory_order_relaxed)) {
            if (TerminateJobObject(job, 1)) term_any.store(true, std::memory_order_relaxed);
          }
        });
        sp = spawn_ex(child, job, nullptr, true, true, false);
        go.store(false, std::memory_order_relaxed);
        killer.join();
        if (term_any.load()) ++term_ok;
      } else {
        sp = spawn_ex(child, job, nullptr, true, true, false);
      }
      if (!sp.ok) {
        ++create_err;
        last_create_err = sp.err;
        if (sp.pi.hThread) CloseHandle(sp.pi.hThread);
        if (sp.pi.hProcess) CloseHandle(sp.pi.hProcess);
        CloseHandle(job);
        continue;
      }
      ++create_ok;
      BOOL b = FALSE;
      IsProcessInJob(sp.pi.hProcess, job, &b);
      if (b) ++in_job;
      if (cs.when == 2) {
        if (TerminateJobObject(job, 1)) ++term_ok;
      }
      DWORD rr = ResumeThread(sp.pi.hThread);
      if (rr != (DWORD)-1 && rr != 0) ++resume_ok;
      if (rr == (DWORD)-1) last_resume_err = GetLastError();
      if (cs.when == 3) {
        Sleep(50);
        if (TerminateJobObject(job, 1)) ++term_ok;
      }
      DWORD w = wait_proc(sp.pi.hProcess, 3000);
      DWORD code = 0;
      GetExitCodeProcess(sp.pi.hProcess, &code);  // before any fallback kill
      Acct a = query_acct(job);
      if (a.ok && a.active > 0) ++active_members;
      if (w == WAIT_OBJECT_0) {
        ++wait_exited;
      } else {
        ++wait_timeout;
        TerminateProcess(sp.pi.hProcess, 1);
        wait_proc(sp.pi.hProcess, 3000);
      }
      if (i) { rets << ","; codes << ","; waits << ","; }
      rets << (rr == (DWORD)-1 ? -1 : (long long)rr);
      codes << (long long)code;
      waits << (long long)w;
      CloseHandle(sp.pi.hThread);
      CloseHandle(sp.pi.hProcess);
      CloseHandle(job);
    }
    rets << "]";
    codes << "]";
    waits << "]";
    std::ostringstream o;
    o << "{\"iterations\":" << kIters << ",\"createOk\":" << create_ok
      << ",\"createErr\":" << create_err << ",\"lastCreateErr\":" << last_create_err
      << ",\"inJob\":" << in_job << ",\"resumeOk\":" << resume_ok
      << ",\"lastResumeErr\":" << last_resume_err << ",\"terminateOk\":" << term_ok
      << ",\"waitExited\":" << wait_exited << ",\"waitTimeout\":" << wait_timeout
      << ",\"activeMembersAfterWait\":" << active_members
      << ",\"resumeRets\":" << rets.str() << ",\"exitCodes\":" << codes.str()
      << ",\"waitRets\":" << waits.str() << "}";
    j.raw(cs.name, o.str());
    if (create_ok + create_err != kIters) measured = false;
  }
  j.b("ok", measured);
  std::cout << j.str() << "\n";
  return measured;
}

// Experiment 1: real ConPTY + B+, a long-running child started after resume,
// then the fixture backend dies abnormally. The parent opened handles to both
// processes before the crash, so both verdicts wait on those exact objects.
static bool test_backend_crash(const std::wstring& temp) {
  Json j;
  j.s("test", "backend-crash-conpty").s("windows", win_version()).b("inAnyJob", in_any_job());
  std::wstring tag = std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(now_ms());
  std::wstring state = temp + L"\\" + tag + L".state.json";
  std::wstring shell_pidfile = temp + L"\\" + tag + L".shell.pid";
  std::wstring child_pidfile = temp + L"\\" + tag + L".child.pid";
  std::wstring tick = temp + L"\\" + tag + L".tick";
  std::wstring cmd = L"\"" + self_path() + L"\" backend-crash-helper --dir \"" + temp +
                     L"\" --tag \"" + tag + L"\" --state \"" + state + L"\"";
  Spawn helper = spawn_plain(cmd);
  j.b("helperSpawn", helper.ok).n("helperErr", helper.err);
  if (!helper.ok) {
    j.b("ok", false);
    std::cout << j.str() << "\n";
    return false;
  }

  bool shell_pid_ok = wait_file(shell_pidfile, 10000);
  DWORD shell_pid =
      shell_pid_ok ? (DWORD)std::strtoul(read_text(shell_pidfile).c_str(), nullptr, 10) : 0;
  HANDLE shell = shell_pid ? OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                         shell_pid)
                           : nullptr;
  DWORD shell_open_err = shell ? 0 : (shell_pid ? GetLastError() : ERROR_INVALID_PARAMETER);

  bool child_pid_ok = wait_file(child_pidfile, 15000);
  DWORD child_pid =
      child_pid_ok ? (DWORD)std::strtoul(read_text(child_pidfile).c_str(), nullptr, 10) : 0;
  HANDLE child = child_pid ? OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                         child_pid)
                           : nullptr;
  DWORD child_open_err = child ? 0 : (child_pid ? GetLastError() : ERROR_INVALID_PARAMETER);
  bool state_ok = wait_file(state, 15000);

  int ticks_before_crash = count_lines(read_text(tick));
  DWORD shell_alive_before = shell ? wait_proc(shell, 0) : WAIT_FAILED;
  DWORD child_alive_before = child ? wait_proc(child, 0) : WAIT_FAILED;

  DWORD hw = wait_proc(helper.pi.hProcess, 15000);
  DWORD helper_code = 0;
  GetExitCodeProcess(helper.pi.hProcess, &helper_code);
  uint64_t t_crash = now_ms();
  DWORD shell_wait = shell ? wait_proc(shell, 15000) : WAIT_FAILED;
  uint64_t shell_exit_ms = now_ms() - t_crash;
  DWORD shell_exit_code = 0;
  if (shell) GetExitCodeProcess(shell, &shell_exit_code);
  DWORD child_wait = child ? wait_proc(child, 15000) : WAIT_FAILED;
  uint64_t child_exit_ms = now_ms() - t_crash;
  DWORD child_exit_code = 0;
  if (child) GetExitCodeProcess(child, &child_exit_code);
  int ticks_at_death = count_lines(read_text(tick));
  Sleep(500);
  int ticks_after = count_lines(read_text(tick));

  j.n("shellPid", shell_pid).b("shellPidFile", shell_pid_ok).b("shellOpen", shell != nullptr)
      .n("shellOpenErr", shell_open_err)
      .b("shellAliveBeforeCrash", shell_alive_before == WAIT_TIMEOUT)
      .n("childPid", child_pid).b("childPidFile", child_pid_ok).b("childOpen", child != nullptr)
      .n("childOpenErr", child_open_err)
      .b("childAliveBeforeCrash", child_alive_before == WAIT_TIMEOUT)
      .b("stateFile", state_ok).n("ticksBeforeCrash", ticks_before_crash)
      .n("helperWait", hw).n("helperExitCode", helper_code)
      .n("shellWaitAfterCrash", shell_wait).n("shellExitMs", (long long)shell_exit_ms)
      .n("shellExitCode", shell_exit_code)
      .n("childWaitAfterCrash", child_wait).n("childExitMs", (long long)child_exit_ms)
      .n("childExitCode", child_exit_code)
      .n("ticksAtDeath", ticks_at_death).n("ticksAfter500ms", ticks_after);
  if (state_ok) j.raw("helperState", read_text(state));

  bool ok = shell_pid_ok && shell && child_pid_ok && child && state_ok &&
            shell_alive_before == WAIT_TIMEOUT && child_alive_before == WAIT_TIMEOUT &&
            hw == WAIT_OBJECT_0 && helper_code == 0xC0DE && shell_wait == WAIT_OBJECT_0 &&
            child_wait == WAIT_OBJECT_0 && ticks_before_crash > 0 &&
            ticks_after == ticks_at_death;
  j.b("ok", ok);
  std::cout << j.str() << "\n";
  if (hw != WAIT_OBJECT_0) {
    TerminateProcess(helper.pi.hProcess, 1);
    wait_proc(helper.pi.hProcess, 5000);
  }
  helper.close_handles();
  if (shell) CloseHandle(shell);
  if (child) CloseHandle(child);
  return ok;
}

// Experiment 2: two independent terminals, each with its own Job, shell and
// ticking child. Stop one; the other must keep running and keep producing
// marker ticks.
struct TermFixture {
  HANDLE job = nullptr;
  ConPty pty;
  Spawn sp;
  HANDLE child = nullptr;
  DWORD child_pid = 0;
  std::wstring tick;
  std::wstring child_pidfile;

  void cleanup() {
    if (job) TerminateJobObject(job, 1);
    if (sp.pi.hProcess) wait_proc(sp.pi.hProcess, 5000);
    if (child) {
      wait_proc(child, 5000);
      CloseHandle(child);
      child = nullptr;
    }
    sp.close_handles();
    pty.close_hpc();
    pty.close_pipes();
    if (job) {
      CloseHandle(job);
      job = nullptr;
    }
  }
};

static bool start_ticker_terminal(TermFixture& f, const std::wstring& temp,
                                  const std::wstring& tag, DWORD* err) {
  if (!make_job(f.job, true, err)) return false;
  if (!f.pty.create(err)) return false;
  f.sp = spawn_ex(L"\"" + comspec() + L"\" /d /q /k", f.job, f.pty.hpc, true, true, true);
  if (!f.sp.ok) {
    *err = f.sp.err;
    return false;
  }
  DWORD rr = ResumeThread(f.sp.pi.hThread);
  if (rr == (DWORD)-1) {
    *err = GetLastError();
    return false;
  }
  Sleep(1500);  // prompt
  f.tick = temp + L"\\" + tag + L".tick";
  f.child_pidfile = temp + L"\\" + tag + L".child.pid";
  std::wstring script = temp + L"\\" + tag + L".cmd";
  write_text(script, "@start \"\" /b \"" + to_u8(self_path()) +
                         "\" child --seconds 60 --tick-file \"" + to_u8(f.tick) +
                         "\" --tick-ms 100 --pidfile \"" + to_u8(f.child_pidfile) + "\"\r\n");
  std::string input = "call \"" + to_u8(script) + "\"\r\n";
  DWORD written = 0;
  WriteFile(f.pty.in_write, input.data(), (DWORD)input.size(), &written, nullptr);
  bool pid_ok = wait_file(f.child_pidfile, 10000);
  bool tick_ok = wait_file(f.tick, 10000);
  if (!pid_ok || !tick_ok) {
    *err = ERROR_TIMEOUT;
    return false;
  }
  f.child_pid = (DWORD)std::strtoul(read_text(f.child_pidfile).c_str(), nullptr, 10);
  f.child = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, f.child_pid);
  if (!f.child) {
    *err = GetLastError();
    return false;
  }
  return true;
}

static bool test_two_terminals(const std::wstring& temp) {
  Json j;
  j.s("test", "two-terminals").s("windows", win_version());
  std::wstring tag = std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(now_ms());
  TermFixture a, b;
  DWORD err_a = 0, err_b = 0;
  bool ok_a = start_ticker_terminal(a, temp, tag + L"-a", &err_a);
  bool ok_b = start_ticker_terminal(b, temp, tag + L"-b", &err_b);
  j.b("startA", ok_a).n("startAErr", err_a).b("startB", ok_b).n("startBErr", err_b);
  if (!ok_a || !ok_b) {
    a.cleanup();
    b.cleanup();
    j.b("ok", false);
    std::cout << j.str() << "\n";
    return false;
  }
  uint64_t end = now_ms() + 10000;
  while (now_ms() < end &&
         (count_lines(read_text(a.tick)) < 3 || count_lines(read_text(b.tick)) < 3)) {
    Sleep(50);
  }
  int a_before = count_lines(read_text(a.tick));
  int b_before = count_lines(read_text(b.tick));
  Acct acct_a = query_acct(a.job), acct_b = query_acct(b.job);

  BOOL term_a = TerminateJobObject(a.job, 5);
  DWORD term_a_err = term_a ? 0 : GetLastError();
  DWORD a_shell_wait = wait_proc(a.sp.pi.hProcess, 10000);
  DWORD a_child_wait = wait_proc(a.child, 10000);
  int a_at_death = count_lines(read_text(a.tick));
  Acct acct_a_after = query_acct(a.job);

  Sleep(1500);
  int a_later = count_lines(read_text(a.tick));
  int b_later = count_lines(read_text(b.tick));
  DWORD b_shell_state = wait_proc(b.sp.pi.hProcess, 0);
  DWORD b_child_state = wait_proc(b.child, 0);
  Acct acct_b_after = query_acct(b.job);

  j.n("ticksABeforeStop", a_before).n("ticksBBeforeStop", b_before)
      .b("acctAOk", acct_a.ok).n("activeABeforeStop", acct_a.active)
      .b("acctBOk", acct_b.ok).n("activeBBeforeStop", acct_b.active)
      .b("terminateA", term_a != FALSE).n("terminateAErr", term_a_err)
      .n("aShellWait", a_shell_wait).n("aChildWait", a_child_wait)
      .n("ticksAAtDeath", a_at_death).n("ticksA1500msLater", a_later)
      .b("acctAAfterOk", acct_a_after.ok).n("activeAAfterStop", acct_a_after.active)
      .n("ticksB1500msAfterAStopped", b_later)
      .n("bShellState", b_shell_state).n("bChildState", b_child_state)
      .b("bStillRunning", b_shell_state == WAIT_TIMEOUT && b_child_state == WAIT_TIMEOUT)
      .b("acctBAfterOk", acct_b_after.ok).n("activeBAfterAStopped", acct_b_after.active);
  bool ok = term_a != FALSE && a_shell_wait == WAIT_OBJECT_0 &&
            a_child_wait == WAIT_OBJECT_0 && a_before >= 3 && b_before >= 3 &&
            a_later == a_at_death && b_later > b_before &&
            b_shell_state == WAIT_TIMEOUT && b_child_state == WAIT_TIMEOUT &&
            acct_b_after.ok && acct_b_after.active >= 2;
  j.b("ok", ok);
  std::cout << j.str() << "\n";
  a.cleanup();
  b.cleanup();
  return ok;
}

// Experiment 4 (local part): ConPTY trailing-output EOF, both after a natural
// shell exit and after ClosePseudoConsole while the shell is running. Pre-24H2
// coverage needs machines this one is not; see the report's per-version matrix.
static bool test_conpty_eof(const std::wstring& temp, bool close_first) {
  Json j;
  j.s("test", close_first ? "conpty-eof-close" : "conpty-eof-natural")
      .s("windows", win_version());
  HANDLE job = nullptr;
  DWORD err = 0;
  if (!make_job(job, true, &err)) {
    j.b("ok", false).n("jobErr", err);
    std::cout << j.str() << "\n";
    return false;
  }
  ConPty pty;
  if (!pty.create(&err)) {
    j.b("ok", false).n("conptyErr", err);
    CloseHandle(job);
    std::cout << j.str() << "\n";
    return false;
  }
  Spawn sp = spawn_ex(L"\"" + comspec() + L"\" /d /q /k", job, pty.hpc, true, true, true);
  j.b("spawn", sp.ok).n("spawnErr", sp.err);
  if (!sp.ok) {
    pty.close_hpc();
    pty.close_pipes();
    CloseHandle(job);
    j.b("ok", false);
    std::cout << j.str() << "\n";
    return false;
  }
  DWORD rr = ResumeThread(sp.pi.hThread);

  std::mutex mu;
  std::string out;
  std::atomic<bool> eof{false}, stop{false};
  std::atomic<DWORD> eof_err{0};
  std::atomic<uint64_t> bytes{0}, eof_ms{0};
  uint64_t t_start = now_ms();
  std::thread reader([&] {
    char buf[4096];
    while (!stop.load(std::memory_order_relaxed)) {
      DWORD avail = 0;
      if (!PeekNamedPipe(pty.out_read, nullptr, 0, nullptr, &avail, nullptr)) {
        eof_err.store(GetLastError());
        eof_ms.store(now_ms() - t_start);
        eof.store(true);
        break;
      }
      if (avail == 0) {
        Sleep(5);
        continue;
      }
      DWORD got = 0;
      if (!ReadFile(pty.out_read, buf, (DWORD)std::min<DWORD>(avail, sizeof(buf)), &got,
                    nullptr)) {
        eof_err.store(GetLastError());
        eof_ms.store(now_ms() - t_start);
        eof.store(true);
        break;
      }
      {
        std::lock_guard<std::mutex> g(mu);
        out.append(buf, got);
      }
      bytes.fetch_add(got, std::memory_order_relaxed);
    }
  });
  Sleep(1500);  // drain banner and prompt

  std::wstring tag = std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(now_ms());
  std::wstring script = temp + L"\\eof-" + tag + L".cmd";
  write_text(script, "@echo tailmarker_p3c0\r\n");
  uint64_t t_action = now_ms();
  uint64_t action_close_ms = (uint64_t)-1;
  if (close_first) {
    action_close_ms = pty.close_hpc();
  } else {
    std::string input = "call \"" + to_u8(script) + "\"\r\nexit\r\n";
    DWORD written = 0;
    WriteFile(pty.in_write, input.data(), (DWORD)input.size(), &written, nullptr);
  }

  // Observation window after the action. For the natural variant this proves
  // whether shell exit alone closes the output pipe.
  uint64_t deadline = now_ms() + 8000;
  while (!eof.load() && now_ms() < deadline) Sleep(10);
  bool eof_after_action = eof.load();
  DWORD shell_at_observation = wait_proc(sp.pi.hProcess, 0);
  DWORD shell_wait = wait_proc(sp.pi.hProcess, eof_after_action ? 5000 : 0);
  DWORD shell_code = 0;
  GetExitCodeProcess(sp.pi.hProcess, &shell_code);

  // Natural variant: close the pseudoconsole after the observation window and
  // see whether that is what ends the output stream.
  uint64_t final_close_ms = 0;
  if (pty.hpc) final_close_ms = pty.close_hpc();
  if (!eof.load()) {
    deadline = now_ms() + 5000;
    while (!eof.load() && now_ms() < deadline) Sleep(10);
  }
  bool eof_after_final_close = eof.load();
  if (shell_wait != WAIT_OBJECT_0) {
    TerminateJobObject(job, 1);
    wait_proc(sp.pi.hProcess, 5000);
  }
  stop.store(true);
  reader.join();
  std::string text;
  {
    std::lock_guard<std::mutex> g(mu);
    text = out;
  }
  bool marker = text.find("tailmarker_p3c0") != std::string::npos;
  pty.close_pipes();
  sp.close_handles();
  CloseHandle(job);

  j.n("resumeRet", (long long)rr)
      .n("actionAtMs", (long long)(t_action - t_start))
      .b("closeDuringAction", close_first)
      .b("eofAfterAction", eof_after_action)
      .b("eofAfterFinalClose", eof_after_final_close)
      .n("eofErr", eof_err.load()).n("eofMs", (long long)eof_ms.load())
      .n("bytesRead", (long long)bytes.load()).b("tailMarkerSeen", marker)
      .n("actionCloseMs", action_close_ms == (uint64_t)-1 ? -1 : (long long)action_close_ms)
      .n("finalCloseMs", (long long)final_close_ms)
      .n("shellStateAtObservation", shell_at_observation).n("shellWait", shell_wait)
      .n("shellExitCode", shell_code);
  bool ok = close_first
                ? (eof_after_action && shell_wait == WAIT_OBJECT_0)
                : (marker && shell_wait == WAIT_OBJECT_0 && !eof_after_action &&
                   eof_after_final_close);
  j.b("ok", ok);
  std::cout << j.str() << "\n";
  return ok;
}

static int run_all(const std::wstring& temp) {
  int total = 0, failed = 0;
  auto run = [&](bool r) {
    ++total;
    if (!r) ++failed;
  };
  run(test_selftest(temp));
  run(test_bind("bplus-conpty", true, true, temp));
  run(test_bind("bplus-noconpty", false, true, temp));
  run(test_bind("b-conpty", true, false, temp));
  run(test_bind("b-noconpty", false, false, temp));
  run(test_conpty_shell(temp));
  run(test_kill_on_close_suspended(temp));
  run(test_crash_before_resume(temp));
  run(test_terminate_timing(temp));
  run(test_wait_failures(temp));
  run(test_conpty_close(temp, L"drain"));
  run(test_conpty_close(temp, L"nodrain"));
  run(test_nested(temp));
  run(test_wmi(temp));
  run(test_natural_exit(temp));
  run(test_connect_race(temp));
  run(test_backend_crash(temp));
  run(test_two_terminals(temp));
  run(test_conpty_eof(temp, false));
  run(test_conpty_eof(temp, true));
  Json j;
  j.s("test", "summary").s("windows", win_version()).n("total", total).n("failed", failed);
  std::cout << j.str() << "\n";
  return failed == 0 ? 0 : 1;
}

int wmain(int argc, wchar_t** argv) {
  std::vector<std::wstring> args;
  for (int i = 1; i < argc; ++i) args.emplace_back(argv[i]);
  if (args.empty()) {
    std::cout << "usage: win32-spike.exe --all | selftest | bplus ...\n";
    return 2;
  }
  const std::wstring& mode = args[0];
  std::vector<std::wstring> rest(args.begin() + 1, args.end());
  if (mode == L"child") return run_child(rest);
  if (mode == L"crash-helper") return run_crash_helper(rest);
  if (mode == L"conpty-close") return run_conpty_close_child(rest);
  if (mode == L"backend-crash-helper") return run_backend_crash_helper(rest);
  if (mode == L"watch-child") return run_watch_child(rest);

  std::wstring temp = make_temp_dir();
  if (mode == L"--all") return run_all(temp);
  if (mode == L"selftest") return test_selftest(temp) ? 0 : 1;
  if (mode == L"bplus-conpty") return test_bind("bplus-conpty", true, true, temp) ? 0 : 1;
  if (mode == L"bplus-noconpty") return test_bind("bplus-noconpty", false, true, temp) ? 0 : 1;
  if (mode == L"b-conpty") return test_bind("b-conpty", true, false, temp) ? 0 : 1;
  if (mode == L"b-noconpty") return test_bind("b-noconpty", false, false, temp) ? 0 : 1;
  if (mode == L"conpty-shell") return test_conpty_shell(temp) ? 0 : 1;
  if (mode == L"conpty-shell-debug-job") return test_conpty_shell_debug(temp, true) ? 0 : 1;
  if (mode == L"conpty-shell-debug-nojob") return test_conpty_shell_debug(temp, false) ? 0 : 1;
  if (mode == L"kill-on-close-suspended") return test_kill_on_close_suspended(temp) ? 0 : 1;
  if (mode == L"crash-before-resume") return test_crash_before_resume(temp) ? 0 : 1;
  if (mode == L"terminate-timing") return test_terminate_timing(temp) ? 0 : 1;
  if (mode == L"wait-failures") return test_wait_failures(temp) ? 0 : 1;
  if (mode == L"conpty-close-drain") return test_conpty_close(temp, L"drain") ? 0 : 1;
  if (mode == L"conpty-close-nodrain") return test_conpty_close(temp, L"nodrain") ? 0 : 1;
  if (mode == L"nested") return test_nested(temp) ? 0 : 1;
  if (mode == L"wmi") return test_wmi(temp) ? 0 : 1;
  if (mode == L"wmi-nokill") return test_wmi(temp, false) ? 0 : 1;
  if (mode == L"wmi-assign") return test_wmi(temp, true, false) ? 0 : 1;
  if (mode == L"wmi-breakaway") return test_wmi(temp, true, true, true) ? 0 : 1;
  if (mode == L"wmi-detached")
    return test_wmi(temp, true, true, false, CREATE_BREAKAWAY_FROM_JOB) ? 0 : 1;
  if (mode == L"natural-exit") return test_natural_exit(temp) ? 0 : 1;
  if (mode == L"connect-race") return test_connect_race(temp) ? 0 : 1;
  if (mode == L"backend-crash") return test_backend_crash(temp) ? 0 : 1;
  if (mode == L"two-terminals") return test_two_terminals(temp) ? 0 : 1;
  if (mode == L"conpty-eof-natural") return test_conpty_eof(temp, false) ? 0 : 1;
  if (mode == L"conpty-eof-close") return test_conpty_eof(temp, true) ? 0 : 1;
  std::cout << "unknown mode\n";
  return 2;
}
