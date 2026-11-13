// P3-C0 test-only N-API spike. Not production code.
//
// Exercises the lifecycle assumptions used by the P3-C native design:
//   - TSFN initial thread count / Acquire / Release / finalize ordering
//   - napi_add_env_cleanup_hook timing relative to the exit thread and TSFN
//   - env teardown while a native cleanup thread is blocked (no TSFN ref)
//   - napi_queue_full and napi_closing behavior
//
// Modes:
//   wait      : exit thread waits on hStopEvent (500 ms slices)
//   drain     : exit thread polls for 5 s
//   closeBlock: exit thread waits; a second thread sleeps blockMs with zero
//               TSFN references, then tries to post ptyDisposed
//   spam      : exit thread posts every spamMs until closing/stop
//
// Logs go to stderr as "[lifecycle <ms>] ..."; the JS runner prints its own
// "[js ...]" lines. The parent process measures wall-clock teardown time.

#include <node_api.h>

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

static uint64_t g_t0 = 0;
static std::mutex g_log_mu;

static uint64_t now_ms() {
  return (uint64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

static void logf(const char* fmt, ...) {
  std::lock_guard<std::mutex> lock(g_log_mu);
  std::fprintf(stderr, "[lifecycle %llu] ", (unsigned long long)(now_ms() - g_t0));
  va_list ap;
  va_start(ap, fmt);
  std::vfprintf(stderr, fmt, ap);
  va_end(ap);
  std::fprintf(stderr, "\n");
  std::fflush(stderr);
}

struct FinalState {
  std::atomic<bool> ptyDisposed{false};
  std::atomic<int> closeMs{0};
};

// ---------------------------------------------------------------- worker fixture
//
// Mode 4 destroys a worker_threads environment while the host process keeps
// running. The env owns a Job + a running child; the cleanup thread blocks on a
// barrier file with zero TSFN references, then closes the Job (KILL_ON_JOB_CLOSE)
// and writes the native final state to a file. It deliberately never posts to
// the TSFN: this is the "cleanup thread writes native state, JS reconciles"
// minimal scheme.

static HANDLE g_job = nullptr;
static HANDLE g_child = nullptr;
static std::wstring g_order_file;
static std::wstring g_state_file;
static std::wstring g_release_file;

static uint64_t epoch_ms_now() {
  // Precise wall clock so native timestamps are comparable with JS Date.now()
  // (both are system time; the coarse variant updates only every ~15.6 ms).
  typedef VOID(WINAPI * GetTimeFn)(LPFILETIME);
  static GetTimeFn fn = [] () -> GetTimeFn {
    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    auto p = k32 ? (GetTimeFn)GetProcAddress(k32, "GetSystemTimePreciseAsFileTime") : nullptr;
    return p ? p : (GetTimeFn)&GetSystemTimeAsFileTime;
  }();
  FILETIME ft{};
  fn(&ft);
  ULARGE_INTEGER u{};
  u.LowPart = ft.dwLowDateTime;
  u.HighPart = ft.dwHighDateTime;
  return u.QuadPart / 10000ULL - 11644473600000ULL;
}

static bool file_exists_w(const std::wstring& path) {
  DWORD a = GetFileAttributesW(path.c_str());
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

// Append one line to the cross-thread/cross-process order log. A single
// FILE_APPEND_DATA write keeps lines whole even when the finalizer, the exit
// thread and the JS host append concurrently. The timestamp is taken under the
// lock so the file order matches the recorded order.
static std::mutex g_order_mu;

static void order_write_locked(const char* line, size_t len) {
  HANDLE h = CreateFileW(g_order_file.c_str(), FILE_APPEND_DATA,
                         FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS,
                         FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  WriteFile(h, line, (DWORD)len, &written, nullptr);
  CloseHandle(h);
}

static void order_event(const char* fmt, ...) {
  if (g_order_file.empty()) return;
  std::lock_guard<std::mutex> lock(g_order_mu);
  char line[512];
  int prefix = std::snprintf(line, sizeof(line), "%llu native ",
                             (unsigned long long)epoch_ms_now());
  if (prefix < 0 || (size_t)prefix >= sizeof(line)) return;
  va_list ap;
  va_start(ap, fmt);
  int body = std::vsnprintf(line + prefix, sizeof(line) - (size_t)prefix, fmt, ap);
  va_end(ap);
  if (body < 0) return;
  size_t len = (size_t)prefix + std::min((size_t)body, sizeof(line) - (size_t)prefix - 2);
  line[len++] = '\n';
  order_write_locked(line, len);
}

// JS lines get the same native clock and the same single-write path.
static void order_js(const std::string& msg) {
  if (g_order_file.empty()) return;
  std::lock_guard<std::mutex> lock(g_order_mu);
  char line[512];
  int prefix = std::snprintf(line, sizeof(line), "%llu js ",
                             (unsigned long long)epoch_ms_now());
  if (prefix < 0 || (size_t)prefix >= sizeof(line)) return;
  size_t body = std::min(msg.size(), sizeof(line) - (size_t)prefix - 2);
  std::memcpy(line + prefix, msg.data(), body);
  size_t len = (size_t)prefix + body;
  line[len++] = '\n';
  order_write_locked(line, len);
}

static std::wstring from_utf8(const char* s, size_t n) {
  if (!n) return std::wstring();
  int wlen = MultiByteToWideChar(CP_UTF8, 0, s, (int)n, nullptr, 0);
  if (wlen <= 0) return std::wstring();
  std::wstring out((size_t)wlen, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s, (int)n, out.data(), wlen);
  return out;
}

static std::string get_u8_arg(napi_env env, napi_value v) {
  char buf[32768];
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, buf, sizeof(buf), &len) != napi_ok) {
    return std::string();
  }
  return std::string(buf, len);
}

static std::wstring get_wstr_arg(napi_env env, napi_value v) {
  std::string s = get_u8_arg(env, v);
  return from_utf8(s.data(), s.size());
}

static void SetInt(napi_env env, napi_value obj, const char* name, int value);
static void SetBool(napi_env env, napi_value obj, const char* name, bool value);
static void SetStr(napi_env env, napi_value obj, const char* name, const std::wstring& value);

struct Post {
  int seq = 0;
  const char* kind = "event";
};

struct Channel {
  napi_threadsafe_function tsfn = nullptr;
  napi_env env = nullptr;
  std::atomic<int> holders{0};
  std::atomic<bool> closing{false};
  std::atomic<bool> stop{false};
  std::atomic<bool> finalized{false};
  std::atomic<bool> exitThreadDone{false};
  std::atomic<bool> cleanupThreadDone{false};
  std::atomic<int> posted{0};
  std::atomic<int> queueFull{0};
  std::atomic<int> closingPosts{0};
  std::atomic<int> otherPostErrors{0};
  HANDLE hStop = nullptr;
  int mode = 0;  // 0 wait, 1 drain, 2 closeBlock, 3 spam
  int blockMs = 60000;
  int spamMs = 5;
  std::shared_ptr<FinalState> finalState;
  std::thread exitThread;
  std::thread cleanupThread;
};

static Channel* g_channel = nullptr;

static bool AcquireHolder(Channel* c, const char* who) {
  if (!c || !c->tsfn) {
    logf("acquire %s: no tsfn", who);
    return false;
  }
  napi_status s = napi_acquire_threadsafe_function(c->tsfn);
  if (s != napi_ok) {
    logf("acquire %s: status=%d holders=%d", who, (int)s, c->holders.load());
    return false;
  }
  int h = c->holders.fetch_add(1) + 1;
  logf("acquire %s: holders=%d", who, h);
  return true;
}

static bool ReleaseHolder(Channel* c, const char* who) {
  if (!c) return false;
  int cur = c->holders.load(std::memory_order_acquire);
  while (cur > 0) {
    if (c->holders.compare_exchange_weak(cur, cur - 1, std::memory_order_acq_rel)) {
      napi_status s = napi_release_threadsafe_function(c->tsfn, napi_tsfn_release);
      logf("release %s: holders=%d status=%d", who, cur - 1, (int)s);
      order_event("release %s holders=%d status=%d", who, cur - 1, (int)s);
      return true;
    }
  }
  logf("release %s: underflow holders=%d", who, cur);
  return false;
}

static napi_status PostSeq(Channel* c, int seq, const char* kind) {
  auto* p = new Post{seq, kind};
  napi_status s = napi_call_threadsafe_function(c->tsfn, p, napi_tsfn_nonblocking);
  if (s == napi_queue_full) {
    c->queueFull.fetch_add(1);
    delete p;
  } else if (s == napi_closing) {
    c->closingPosts.fetch_add(1);
    delete p;
  } else if (s != napi_ok) {
    c->otherPostErrors.fetch_add(1);
    delete p;
  } else {
    c->posted.fetch_add(1);
  }
  return s;
}

static void CallJs(napi_env env, napi_value js_cb, void* context, void* data) {
  auto* c = static_cast<Channel*>(context);
  auto* p = static_cast<Post*>(data);
  if (!p) return;
  if (env == nullptr || js_cb == nullptr) {
    logf("calljs %s seq=%d: null env/cb", p->kind, p->seq);
    delete p;
    return;
  }
  napi_value arg = nullptr;
  napi_create_int32(env, p->seq, &arg);
  napi_value global = nullptr;
  napi_get_global(env, &global);
  napi_value result = nullptr;
  napi_status s = napi_call_function(env, global, js_cb, 1, &arg, &result);
  logf("calljs %s seq=%d: status=%d", p->kind, p->seq, (int)s);
  delete p;
}

static void FinalizeCB(napi_env env, void* data, void* hint) {
  auto* c = static_cast<Channel*>(data);
  if (c) {
    // Entry and write-time counts can differ: env teardown may enter the
    // finalizer while the exit thread is still releasing the last reference.
    int at_entry = c->holders.load();
    c->finalized.store(true);
    c->closing.store(true);
    logf("tsfn-finalize: holdersAtEntry=%d holdersNow=%d posted=%d", at_entry,
         c->holders.load(), c->posted.load());
    order_event("tsfn-finalize holdersAtEntry=%d holdersNow=%d posted=%d", at_entry,
                c->holders.load(), c->posted.load());
  } else {
    logf("tsfn-finalize: null channel");
  }
}

static void CleanupHook(void* arg) {
  auto* c = static_cast<Channel*>(arg);
  logf("env-cleanup-hook: enter holders=%d exitDone=%d cleanupDone=%d",
       c->holders.load(), c->exitThreadDone.load(), c->cleanupThreadDone.load());
  c->closing.store(true);
  c->stop.store(true);
  if (c->hStop) SetEvent(c->hStop);
  order_event("env-cleanup-hook");
  logf("env-cleanup-hook: leave (no TSFN release here; exit thread owns it)");
}

static void RunExitThread(Channel* c) {
  logf("exit-thread: start mode=%d", c->mode);
  order_event("exit-thread-start");
  if (c->mode == 1) {
    for (int i = 0; i < 100; ++i) {  // 5 s of 50 ms polls
      if (c->stop.load() || c->closing.load()) break;
      Sleep(50);
    }
  } else if (c->mode == 3) {
    int seq = 1000;
    for (int i = 0; i < 2000; ++i) {
      if (c->stop.load() || c->closing.load()) break;
      PostSeq(c, seq++, "spam");
      Sleep((DWORD)(c->spamMs > 0 ? c->spamMs : 1));
    }
  } else {
    while (!c->stop.load() && !c->closing.load()) {
      DWORD w = WaitForSingleObject(c->hStop, 500);
      if (w == WAIT_OBJECT_0) break;
    }
  }
  logf("exit-thread: stop observed stop=%d closing=%d", c->stop.load(), c->closing.load());
  order_event("exit-thread-stop-observed");
  ReleaseHolder(c, "exit-thread");
  c->exitThreadDone.store(true);
  order_event("exit-thread-done");
  logf("exit-thread: done");
}

static void RunCleanupThread(Channel* c) {
  if (c->mode == 4) {
    // Minimal scheme: zero TSFN references, no post, only the native final
    // state. Blocked on a barrier the host controls, so env teardown and Job
    // reclamation can be observed separately.
    order_event("cleanup-thread-start zero-refs");
    uint64_t deadline = now_ms() + 60000;
    while (!file_exists_w(g_release_file) && now_ms() < deadline) Sleep(20);
    bool released = file_exists_w(g_release_file);
    order_event("cleanup-release-observed released=%d", released ? 1 : 0);
    uint64_t t0 = now_ms();
    if (g_job) {
      CloseHandle(g_job);  // last Job handle -> KILL_ON_JOB_CLOSE
      g_job = nullptr;
    }
    DWORD w = g_child ? WaitForSingleObject(g_child, 10000) : WAIT_FAILED;
    uint64_t exit_ms = now_ms() - t0;
    DWORD code = 0;
    if (g_child) GetExitCodeProcess(g_child, &code);
    c->finalState->ptyDisposed.store(true);
    c->finalState->closeMs.store((int)exit_ms);
    FILE* f = g_state_file.empty() ? nullptr : _wfopen(g_state_file.c_str(), L"wb");
    if (f) {
      std::fprintf(f,
                   "{\"released\":%s,\"childWait\":%lu,\"childExitMs\":%llu,"
                   "\"childExitCode\":%lu,\"stateWrittenAt\":%llu}\n",
                   released ? "true" : "false", (unsigned long)w,
                   (unsigned long long)exit_ms, (unsigned long)code,
                   (unsigned long long)epoch_ms_now());
      std::fclose(f);
    }
    order_event("cleanup-final-state-written childWait=%lu exitMs=%llu exitCode=%lu",
                (unsigned long)w, (unsigned long long)exit_ms, (unsigned long)code);
    if (g_child) {
      CloseHandle(g_child);
      g_child = nullptr;
    }
    c->cleanupThreadDone.store(true);
    order_event("cleanup-thread-done");
    return;
  }
  logf("cleanup-thread: start blockMs=%d (zero TSFN references)", c->blockMs);
  Sleep((DWORD)(c->blockMs > 0 ? c->blockMs : 0));
  c->finalState->ptyDisposed.store(true);
  c->finalState->closeMs.store(c->blockMs);
  logf("cleanup-thread: ClosePseudoConsole-like call returned closing=%d", c->closing.load());
  if (AcquireHolder(c, "cleanup-thread")) {
    PostSeq(c, 9000, "ptyDisposed");
    ReleaseHolder(c, "cleanup-thread");
  } else {
    logf("cleanup-thread: no post, finalState updated");
  }
  c->cleanupThreadDone.store(true);
  logf("cleanup-thread: done");
}

static void SetInt(napi_env env, napi_value obj, const char* name, int value) {
  napi_value v = nullptr;
  napi_create_int32(env, value, &v);
  napi_set_named_property(env, obj, name, v);
}

static void SetBool(napi_env env, napi_value obj, const char* name, bool value) {
  napi_value v = nullptr;
  napi_get_boolean(env, value, &v);
  napi_set_named_property(env, obj, name, v);
}

static void SetStr(napi_env env, napi_value obj, const char* name, const std::wstring& value) {
  int n = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), (int)value.size(), nullptr, 0, nullptr,
                              nullptr);
  std::string u8((size_t)(n > 0 ? n : 0), '\0');
  if (n > 0) {
    WideCharToMultiByte(CP_UTF8, 0, value.c_str(), (int)value.size(), u8.data(), n, nullptr,
                        nullptr);
  }
  napi_value v = nullptr;
  napi_create_string_utf8(env, u8.c_str(), u8.size(), &v);
  napi_set_named_property(env, obj, name, v);
}

static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "start(cb, mode, blockMs, queueSize, spamMs)");
    return nullptr;
  }
  napi_valuetype type = napi_undefined;
  napi_typeof(env, argv[0], &type);
  if (type != napi_function) {
    napi_throw_type_error(env, nullptr, "first argument must be a function");
    return nullptr;
  }
  int mode = 0, blockMs = 60000, queueSize = 64, spamMs = 5;
  if (argc > 1) napi_get_value_int32(env, argv[1], &mode);
  if (argc > 2) napi_get_value_int32(env, argv[2], &blockMs);
  if (argc > 3) napi_get_value_int32(env, argv[3], &queueSize);
  if (argc > 4) napi_get_value_int32(env, argv[4], &spamMs);
  if (queueSize < 1) queueSize = 1;

  if (g_channel) {
    napi_throw_error(env, nullptr, "already started");
    return nullptr;
  }
  g_t0 = now_ms();
  auto* c = new Channel();
  c->env = env;
  c->mode = mode;
  c->blockMs = blockMs;
  c->spamMs = spamMs;
  c->finalState = std::make_shared<FinalState>();
  c->hStop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  c->holders.store(1);  // the initial thread count is owned by the exit thread

  napi_value name = nullptr;
  napi_create_string_utf8(env, "p3c0-lifecycle", NAPI_AUTO_LENGTH, &name);
  // thread_finalize_data must be the channel: the finalize callback receives
  // that pointer, not the context pointer.
  napi_status s = napi_create_threadsafe_function(
      env, argv[0], nullptr, name, (size_t)queueSize, 1, c, FinalizeCB, c, CallJs, &c->tsfn);
  logf("tsfn-create: status=%d queue=%d mode=%d", (int)s, queueSize, mode);
  if (s != napi_ok) {
    napi_throw_error(env, nullptr, "napi_create_threadsafe_function failed");
    delete c;
    return nullptr;
  }
  napi_add_env_cleanup_hook(env, CleanupHook, c);
  g_channel = c;
  order_event("tsfn-create holders=1 queue=%d mode=%d", queueSize, mode);

  c->exitThread = std::thread(RunExitThread, c);
  c->exitThread.detach();
  if (mode == 2 || mode == 4) {
    c->cleanupThread = std::thread(RunCleanupThread, c);
    c->cleanupThread.detach();
  }
  logf("started: holders=%d", c->holders.load());
  return nullptr;
}

// Creates a Job (KILL_ON_JOB_CLOSE) and a suspended child via JOB_LIST,
// verifies membership/accounting, resumes it, and returns {pid, tick, pidFile,
// inJob, activeBeforeResume}. Used by mode 4 inside a worker environment.
static napi_value StartJobChild(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 5) {
    napi_throw_type_error(
        env, nullptr, "startJobChild(exe, tmp, orderFile, stateFile, releaseFile)");
    return nullptr;
  }
  std::wstring exe = get_wstr_arg(env, argv[0]);
  std::wstring tmp = get_wstr_arg(env, argv[1]);
  g_order_file = get_wstr_arg(env, argv[2]);
  g_state_file = get_wstr_arg(env, argv[3]);
  g_release_file = get_wstr_arg(env, argv[4]);
  if (exe.empty() || tmp.empty()) {
    napi_throw_type_error(env, nullptr, "exe and tmp are required");
    return nullptr;
  }
  if (g_job) {
    napi_throw_error(env, nullptr, "job already created");
    return nullptr;
  }
  g_job = CreateJobObjectW(nullptr, nullptr);
  if (!g_job) {
    napi_throw_error(env, nullptr, "CreateJobObjectW failed");
    return nullptr;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION li{};
  li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &li, sizeof(li))) {
    CloseHandle(g_job);
    g_job = nullptr;
    napi_throw_error(env, nullptr, "SetInformationJobObject failed");
    return nullptr;
  }
  order_event("job-created");

  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
  std::vector<BYTE> buf(size ? size : 1);
  auto attr = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(buf.data());
  if (!InitializeProcThreadAttributeList(attr, 1, 0, &size)) {
    CloseHandle(g_job);
    g_job = nullptr;
    napi_throw_error(env, nullptr, "InitializeProcThreadAttributeList failed");
    return nullptr;
  }
  HANDLE jobs[1] = {g_job};
  BOOL attr_ok = UpdateProcThreadAttribute(attr, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs,
                                           sizeof(jobs), nullptr, nullptr);
  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof(si);
  si.lpAttributeList = attr;
  std::wstring tag =
      std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
  std::wstring tick = tmp + L"\\worker-" + tag + L".tick";
  std::wstring pidfile = tmp + L"\\worker-" + tag + L".pid";
  std::wstring cmd = L"\"" + exe + L"\" child --seconds 120 --tick-file \"" + tick +
                     L"\" --tick-ms 100 --pidfile \"" + pidfile + L"\"";
  std::vector<wchar_t> line(cmd.begin(), cmd.end());
  line.push_back(0);
  PROCESS_INFORMATION pi{};
  BOOL created =
      attr_ok && CreateProcessW(nullptr, line.data(), nullptr, nullptr, FALSE,
                                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT |
                                    CREATE_SUSPENDED,
                                nullptr, nullptr, &si.StartupInfo, &pi);
  DWORD create_err = created ? 0 : GetLastError();
  DeleteProcThreadAttributeList(attr);
  if (!created) {
    CloseHandle(g_job);
    g_job = nullptr;
    char msg[128];
    std::snprintf(msg, sizeof(msg), "CreateProcessW failed: %lu", (unsigned long)create_err);
    napi_throw_error(env, nullptr, msg);
    return nullptr;
  }
  g_child = pi.hProcess;
  BOOL in_job = FALSE;
  IsProcessInJob(pi.hProcess, g_job, &in_job);
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION ai{};
  QueryInformationJobObject(g_job, JobObjectBasicAccountingInformation, &ai, sizeof(ai), nullptr);
  order_event("child-created pid=%lu inJob=%d active=%lu",
              (unsigned long)pi.dwProcessId, in_job ? 1 : 0,
              (unsigned long)ai.ActiveProcesses);
  DWORD resume_ret = ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  order_event("child-resumed ret=%lu", (unsigned long)resume_ret);

  napi_value o = nullptr;
  napi_create_object(env, &o);
  SetInt(env, o, "pid", (int)pi.dwProcessId);
  SetInt(env, o, "resumeRet", (int)resume_ret);
  SetInt(env, o, "activeBeforeResume", (int)ai.ActiveProcesses);
  SetBool(env, o, "inJob", in_job != FALSE);
  SetStr(env, o, "tick", tick);
  SetStr(env, o, "pidFile", pidfile);
  return o;
}

static napi_value Stop(napi_env env, napi_callback_info info) {
  if (!g_channel) return nullptr;
  g_channel->stop.store(true);
  if (g_channel->hStop) SetEvent(g_channel->hStop);
  logf("stop: requested");
  return nullptr;
}

static napi_value PostFn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  int n = 1;
  if (argc > 0) napi_get_value_int32(env, argv[0], &n);
  if (!g_channel) {
    napi_throw_error(env, nullptr, "not started");
    return nullptr;
  }
  for (int i = 0; i < n; ++i) {
    napi_status s = PostSeq(g_channel, i, "event");
    logf("post seq=%d status=%d", i, (int)s);
  }
  return nullptr;
}

static napi_value AcquireFn(napi_env env, napi_callback_info info) {
  if (!g_channel) return nullptr;
  bool ok = AcquireHolder(g_channel, "js");
  logf("acquire: ok=%d holders=%d", ok ? 1 : 0, g_channel->holders.load());
  return nullptr;
}

static napi_value AbortFn(napi_env env, napi_callback_info info) {
  if (!g_channel || !g_channel->tsfn) return nullptr;
  // Drops one thread reference and moves the TSFN into the closing state.
  napi_status s = napi_release_threadsafe_function(g_channel->tsfn, napi_tsfn_abort);
  logf("abort: status=%d holders=%d", (int)s, g_channel->holders.load());
  return nullptr;
}

static napi_value Unref(napi_env env, napi_callback_info info) {
  if (g_channel && g_channel->tsfn) {
    napi_status s = napi_unref_threadsafe_function(env, g_channel->tsfn);
    logf("unref: status=%d", (int)s);
    order_event("unref status=%d", (int)s);
  }
  return nullptr;
}

static napi_value Mark(napi_env env, napi_callback_info info) {
  napi_value v = nullptr;
  napi_create_double(env, (double)(now_ms() - g_t0), &v);
  return v;
}

static napi_value State(napi_env env, napi_callback_info info) {
  napi_value o = nullptr;
  napi_create_object(env, &o);
  if (!g_channel) {
    SetBool(env, o, "started", false);
    return o;
  }
  SetBool(env, o, "started", true);
  SetInt(env, o, "holders", g_channel->holders.load());
  SetBool(env, o, "closing", g_channel->closing.load());
  SetBool(env, o, "stop", g_channel->stop.load());
  SetBool(env, o, "finalized", g_channel->finalized.load());
  SetBool(env, o, "exitThreadDone", g_channel->exitThreadDone.load());
  SetBool(env, o, "cleanupThreadDone", g_channel->cleanupThreadDone.load());
  SetInt(env, o, "posted", g_channel->posted.load());
  SetInt(env, o, "queueFull", g_channel->queueFull.load());
  SetInt(env, o, "closingPosts", g_channel->closingPosts.load());
  SetInt(env, o, "otherPostErrors", g_channel->otherPostErrors.load());
  SetBool(env, o, "finalPtyDisposed", g_channel->finalState->ptyDisposed.load());
  SetInt(env, o, "finalCloseMs", g_channel->finalState->closeMs.load());
  return o;
}

// JS-side order lines go through the same single-write native append; mixing
// fs.appendFileSync with native appends lets one write land inside the other.
static napi_value SetOrderFileFn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc >= 1) g_order_file = get_wstr_arg(env, argv[0]);
  return nullptr;
}

static napi_value OrderFn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc >= 1) order_js(get_u8_arg(env, argv[0]));
  return nullptr;
}

NAPI_MODULE_INIT() {
  napi_value fn = nullptr;
  napi_create_function(env, "start", NAPI_AUTO_LENGTH, Start, nullptr, &fn);
  napi_set_named_property(env, exports, "start", fn);
  napi_create_function(env, "stop", NAPI_AUTO_LENGTH, Stop, nullptr, &fn);
  napi_set_named_property(env, exports, "stop", fn);
  napi_create_function(env, "post", NAPI_AUTO_LENGTH, PostFn, nullptr, &fn);
  napi_set_named_property(env, exports, "post", fn);
  napi_create_function(env, "unref", NAPI_AUTO_LENGTH, Unref, nullptr, &fn);
  napi_set_named_property(env, exports, "unref", fn);
  napi_create_function(env, "abort", NAPI_AUTO_LENGTH, AbortFn, nullptr, &fn);
  napi_set_named_property(env, exports, "abort", fn);
  napi_create_function(env, "acquire", NAPI_AUTO_LENGTH, AcquireFn, nullptr, &fn);
  napi_set_named_property(env, exports, "acquire", fn);
  napi_create_function(env, "mark", NAPI_AUTO_LENGTH, Mark, nullptr, &fn);
  napi_set_named_property(env, exports, "mark", fn);
  napi_create_function(env, "state", NAPI_AUTO_LENGTH, State, nullptr, &fn);
  napi_set_named_property(env, exports, "state", fn);
  napi_create_function(env, "startJobChild", NAPI_AUTO_LENGTH, StartJobChild, nullptr, &fn);
  napi_set_named_property(env, exports, "startJobChild", fn);
  napi_create_function(env, "setOrderFile", NAPI_AUTO_LENGTH, SetOrderFileFn, nullptr, &fn);
  napi_set_named_property(env, exports, "setOrderFile", fn);
  napi_create_function(env, "order", NAPI_AUTO_LENGTH, OrderFn, nullptr, &fn);
  napi_set_named_property(env, exports, "order", fn);
  return exports;
}
