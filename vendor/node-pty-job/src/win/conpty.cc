/**
 * Copyright (c) 2013-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 *
 * pty.cc:
 *   This file is responsible for starting processes
 *   with pseudo-terminal file descriptors.
 */

#define _WIN32_WINNT 0x600

#define NODE_ADDON_API_DISABLE_DEPRECATED
#include <node_api.h>
#include <assert.h>
#include <Shlwapi.h> // PathCombine, PathIsRelative
#include <atomic>
#include <chrono>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>
#include <Windows.h>
#include <strsafe.h>
#include "path_util.h"
#include "conpty.h"

// Taken from the RS5 Windows SDK, but redefined here in case we're targeting <= 17134
#ifndef PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
#define PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE \
  ProcThreadAttributeValue(22, FALSE, TRUE, FALSE)

typedef VOID* HPCON;
typedef HRESULT (__stdcall *PFNCREATEPSEUDOCONSOLE)(COORD c, HANDLE hIn, HANDLE hOut, DWORD dwFlags, HPCON* phpcon);
typedef HRESULT (__stdcall *PFNRESIZEPSEUDOCONSOLE)(HPCON hpc, COORD newSize);
typedef HRESULT (__stdcall *PFNCLEARPSEUDOCONSOLE)(HPCON hpc);
typedef void (__stdcall *PFNCLOSEPSEUDOCONSOLE)(HPCON hpc);
typedef void (__stdcall *PFNRELEASEPSEUDOCONSOLE)(HPCON hpc);

#endif

/* The file deliberately targets 0x600 so the fallback definitions above are
 * used. Job Objects need two symbols the older target hides. */
#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST ProcThreadAttributeValue(13, FALSE, TRUE, FALSE)
#endif

extern "C" HRESULT WINAPI CreatePseudoConsole(COORD size, HANDLE hInput, HANDLE hOutput, DWORD dwFlags, HPCON* phPC);
extern "C" VOID WINAPI ClosePseudoConsole(HPCON hPC);

/* P3-C local trial state. `snap` is the native final state and is the only
 * thing the cleanup thread writes after shell exit. The mutex also guards
 * ownership of hJob/hShell/hpc; no other lock may be held while waiting. */
struct JobSnapshot {
  bool present = false;
  bool gone = true;
  bool finalState = false;
  bool jobMode = false;
  bool jobAssigned = false;
  bool terminateAccepted = false;
  bool drainedVerified = false;
  bool shellExited = false;
  bool ptyDisposed = false;
  bool closeUnconfirmed = false;
  bool disposeRequested = false;
  bool queued = false;
  bool resumeReturned = false;
  bool finalizerRan = false;
  bool envClosing = false;
  int activeProcesses = -1;
  int lostEvents = 0;
  int64_t spawnedAtMs = -1;
  int64_t assignedAtMs = -1;
  int64_t resumeAtMs = -1;
  int64_t closeMs = -1;
  int64_t shellExitMs = -1;
  DWORD shellExitCode = 0;
  std::string connectState = "idle";
  std::string jobState = "connecting";
  std::string treeState = "connecting";
  std::string error;
};

struct pty_baton {
  int id;
  HANDLE hIn;
  HANDLE hOut;
  HPCON hpc;

  HANDLE hShell = nullptr;
  HANDLE hJob = nullptr;
  bool jobMode = false;

  std::mutex mu;
  JobSnapshot snap;
  std::atomic<bool> abortRequested{false};
  std::atomic<bool> envClosing{false};
  std::atomic<bool> exitThreadStarted{false};

  napi_threadsafe_function tsfn = nullptr;
  bool tsfnGuardHeld = false;

  pty_baton(int _id, HANDLE _hIn, HANDLE _hOut, HPCON _hpc)
    : id(_id), hIn(_hIn), hOut(_hOut), hpc(_hpc) {
    snap.connectState = "created";
    snap.jobState = "connecting";
    snap.treeState = "connecting";
  }
};

static std::mutex g_registry_mu;
static std::vector<std::shared_ptr<pty_baton>> ptyHandles;
static std::mutex g_final_mu;
static std::map<int, std::pair<JobSnapshot, int64_t>> finalStates;
static volatile LONG ptyCounter;

static int64_t monotonic_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}

static std::shared_ptr<pty_baton> get_pty_baton(int id) {
  std::lock_guard<std::mutex> lock(g_registry_mu);
  auto it = std::find_if(ptyHandles.begin(), ptyHandles.end(), [id](const auto& ptyHandle) {
    return ptyHandle->id == id;
  });
  if (it != ptyHandles.end()) {
    return *it;
  }
  return nullptr;
}

static bool remove_pty_baton(int id) {
  std::lock_guard<std::mutex> lock(g_registry_mu);
  auto it = std::remove_if(ptyHandles.begin(), ptyHandles.end(), [id](const auto& ptyHandle) {
    return ptyHandle->id == id;
  });
  if (it != ptyHandles.end()) {
    ptyHandles.erase(it);
    return true;
  }
  return false;
}

static JobSnapshot snapshot_locked(const pty_baton& b) {
  JobSnapshot s = b.snap;
  s.present = true;
  s.gone = false;
  s.jobMode = b.jobMode;
  s.envClosing = b.envClosing.load();
  s.finalState = s.ptyDisposed &&
      (s.shellExited || s.closeUnconfirmed || s.connectState == "failed");
  return s;
}

static JobSnapshot snapshot_of(const std::shared_ptr<pty_baton>& b) {
  if (!b) return JobSnapshot();
  std::lock_guard<std::mutex> lock(b->mu);
  return snapshot_locked(*b);
}

static void remember_final(const std::shared_ptr<pty_baton>& b, const JobSnapshot& s) {
  const int64_t now = monotonic_ms();
  {
    std::lock_guard<std::mutex> lock(g_final_mu);
    finalStates[b->id] = { s, now };
    while (finalStates.size() > 64) {
      auto oldest = finalStates.begin();
      for (auto it = finalStates.begin(); it != finalStates.end(); ++it) {
        if (it->second.second < oldest->second.second) oldest = it;
      }
      finalStates.erase(oldest);
    }
  }
  remove_pty_baton(b->id);
}

static JobSnapshot cached_or_gone(int id) {
  std::lock_guard<std::mutex> lock(g_final_mu);
  auto it = finalStates.find(id);
  if (it == finalStates.end()) {
    JobSnapshot s;
    s.present = false;
    s.gone = true;
    s.jobState = "gone";
    s.treeState = "gone";
    return s;
  }
  return it->second.first;
}

static void release_tsfn_guard(const std::shared_ptr<pty_baton>& b) {
  napi_threadsafe_function tsfn = nullptr;
  {
    std::lock_guard<std::mutex> lock(b->mu);
    if (!b->tsfnGuardHeld) return;
    b->tsfnGuardHeld = false;
    tsfn = b->tsfn;
    b->tsfn = nullptr;
  }
  if (tsfn) napi_release_threadsafe_function(tsfn, napi_tsfn_release);
}

struct ExitEvent {
  int exit_code = 0;
};

void SetupExitCallback(Napi::Env env, Napi::Function cb, std::shared_ptr<pty_baton> baton) {
  std::thread *th = new std::thread;
  // Don't use Napi::AsyncWorker which is limited by UV_THREADPOOL_SIZE.
  auto tsfn = Napi::ThreadSafeFunction::New(
      env,
      cb,                           // JavaScript function called asynchronously
      "SetupExitCallback_resource", // Name
      0,                            // Unlimited queue
      1,                            // Only one thread will use this initially
      [th](Napi::Env) {   // Finalizer used to clean threads up
        th->join();
        delete th;
      });
  *th = std::thread([tsfn = std::move(tsfn), baton = std::move(baton)] {
    auto callback = [](Napi::Env env, Napi::Function cb, ExitEvent *exit_event) {
      cb.Call({Napi::Number::New(env, exit_event->exit_code)});
      delete exit_event;
    };

    ExitEvent *exit_event = new ExitEvent;
    // Wait for process to complete.
    WaitForSingleObject(baton->hShell, INFINITE);
    // Get process exit code.
    GetExitCodeProcess(baton->hShell, (LPDWORD)(&exit_event->exit_code));
    // Clean up handles
    CloseHandle(baton->hShell);
    assert(remove_pty_baton(baton->id));

    auto status = tsfn.BlockingCall(exit_event, callback); // In main thread
    switch (status) {
      case napi_closing:
        break;

      case napi_queue_full:
        Napi::Error::Fatal("SetupExitCallback", "Queue was full");

      case napi_ok:
        if (tsfn.Release() != napi_ok) {
          Napi::Error::Fatal("SetupExitCallback", "ThreadSafeFunction.Release() failed");
        }
        break;

      default:
        Napi::Error::Fatal("SetupExitCallback", "ThreadSafeFunction.BlockingCall() failed");
    }
  });
}

Napi::Error errorWithCode(const Napi::CallbackInfo& info, const char* text) {
  std::stringstream errorText;
  errorText << text;
  errorText << ", error code: " << GetLastError();
  return Napi::Error::New(info.Env(), errorText.str());
}

// Returns a new server named pipe.  It has not yet been connected.
bool createDataServerPipe(bool write,
                          std::wstring kind,
                          HANDLE* hServer,
                          std::wstring &name,
                          const std::wstring &pipeName)
{
  *hServer = INVALID_HANDLE_VALUE;

  name = L"\\\\.\\pipe\\" + pipeName + L"-" + kind;

  const DWORD winOpenMode =  PIPE_ACCESS_INBOUND | PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE/*  | FILE_FLAG_OVERLAPPED */;

  SECURITY_ATTRIBUTES sa = {};
  sa.nLength = sizeof(sa);

  *hServer = CreateNamedPipeW(
      name.c_str(),
      /*dwOpenMode=*/winOpenMode,
      /*dwPipeMode=*/PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
      /*nMaxInstances=*/1,
      /*nOutBufferSize=*/128 * 1024,
      /*nInBufferSize=*/128 * 1024,
      /*nDefaultTimeOut=*/30000,
      &sa);

  return *hServer != INVALID_HANDLE_VALUE;
}

HANDLE LoadConptyDll(const Napi::CallbackInfo& info,
                     const bool useConptyDll)
{
  if (!useConptyDll) {
    return GetModuleHandleW(L"kernel32.dll");
  }
  wchar_t currentDir[MAX_PATH];
  HMODULE hModule = GetModuleHandleA("conpty.node");
  if (hModule == NULL) {
    throw errorWithCode(info, "Failed to get conpty.node module handle");
  }
  DWORD result = GetModuleFileNameW(hModule, currentDir, MAX_PATH);
  if (result == 0) {
    throw errorWithCode(info, "Failed to get conpty.node module file name");
  }
  PathRemoveFileSpecW(currentDir);
  wchar_t conptyDllPath[MAX_PATH];
  PathCombineW(conptyDllPath, currentDir, L"conpty\\conpty.dll");
  if (!path_util::file_exists(conptyDllPath)) {
    std::wstring errorMessage = L"Cannot find conpty.dll at " + std::wstring(conptyDllPath);
    std::string errorMessageStr = path_util::wstring_to_string(errorMessage);
    throw errorWithCode(info, errorMessageStr.c_str());
  }

  return LoadLibraryW(conptyDllPath);
}

HRESULT CreateNamedPipesAndPseudoConsole(const Napi::CallbackInfo& info,
                                         COORD size,
                                         DWORD dwFlags,
                                         HANDLE *phInput,
                                         HANDLE *phOutput,
                                         HPCON* phPC,
                                         std::wstring& inName,
                                         std::wstring& outName,
                                         const std::wstring& pipeName,
                                         const bool useConptyDll)
{
  HANDLE hLibrary = LoadConptyDll(info, useConptyDll);
  DWORD error = GetLastError();
  bool fLoadedDll = hLibrary != nullptr;
  if (fLoadedDll)
  {
    PFNCREATEPSEUDOCONSOLE const pfnCreate = (PFNCREATEPSEUDOCONSOLE)GetProcAddress(
        (HMODULE)hLibrary,
        useConptyDll ? "ConptyCreatePseudoConsole" : "CreatePseudoConsole");
    if (pfnCreate)
    {
      if (phPC == NULL || phInput == NULL || phOutput == NULL)
      {
        return E_INVALIDARG;
      }

      bool success = createDataServerPipe(true, L"in", phInput, inName, pipeName);
      if (!success)
      {
        return HRESULT_FROM_WIN32(GetLastError());
      }
      success = createDataServerPipe(false, L"out", phOutput, outName, pipeName);
      if (!success)
      {
        return HRESULT_FROM_WIN32(GetLastError());
      }
      return pfnCreate(size, *phInput, *phOutput, dwFlags, phPC);
    }
    else
    {
      // Failed to find CreatePseudoConsole in kernel32. This is likely because
      //    the user is not running a build of Windows that supports that API.
      //    We should fall back to winpty in this case.
      return HRESULT_FROM_WIN32(GetLastError());
    }
  } else {
    throw errorWithCode(info, "Failed to load conpty.dll");
  }

  // Failed to find  kernel32. This is realy unlikely - honestly no idea how
  //    this is even possible to hit. But if it does happen, fall back to winpty.
  return HRESULT_FROM_WIN32(GetLastError());
}

/* -------------------------------------------------------------------------
 * P3-C Job Object path (local trial)
 * ---------------------------------------------------------------------- */

static bool query_active_processes(HANDLE job, DWORD* active) {
  if (!job) return false;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                 &accounting, sizeof(accounting), nullptr)) {
    return false;
  }
  *active = accounting.ActiveProcesses;
  return true;
}

static HANDLE create_kill_on_close_job() {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) return nullptr;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) {
    CloseHandle(job);
    return nullptr;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION check{};
  DWORD returned = 0;
  if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation,
                                 &check, sizeof(check), &returned) ||
      (check.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) == 0) {
    CloseHandle(job);
    return nullptr;
  }
  return job;
}

static bool job_api_available() {
  HMODULE kernel32 = GetModuleHandleW(L"kernel32.dll");
  const auto rtlGetVersion = reinterpret_cast<LONG (WINAPI*)(OSVERSIONINFOW*)>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
  OSVERSIONINFOW version{};
  version.dwOSVersionInfoSize = sizeof(version);
  if (!rtlGetVersion || rtlGetVersion(&version) != 0 || version.dwBuildNumber != 26200) {
    return false; // Only the Windows 11 25H2 trial build has been qualified.
  }
  if (!kernel32 || !GetProcAddress(kernel32, "CreatePseudoConsole") ||
      !GetProcAddress(kernel32, "ClosePseudoConsole")) {
    return false;
  }
  HANDLE job = create_kill_on_close_job();
  if (!job) return false;
  CloseHandle(job);
  return true;
}

struct JobExitEvent {
  int type; // 1 = shell exit
  DWORD exitCode;
  DWORD activeProcesses;
  int64_t atMs;
};

struct TsfnFinalizeToken {
  std::shared_ptr<pty_baton> baton;
  bool hookRegistered = false; // Accessed only on the owning env thread.
};

static void CallJs(napi_env env, napi_value js_cb, void* /*context*/, void* data) {
  std::unique_ptr<JobExitEvent> event(static_cast<JobExitEvent*>(data));
  if (!env || !js_cb || !event) return;
  napi_value obj;
  napi_value value;
  napi_create_object(env, &obj);
  napi_create_double(env, static_cast<double>(event->exitCode), &value);
  napi_set_named_property(env, obj, "exitCode", value);
  napi_get_boolean(env, true, &value);
  napi_set_named_property(env, obj, "shellExited", value);
  napi_create_double(env, static_cast<double>(event->activeProcesses), &value);
  napi_set_named_property(env, obj, "activeProcesses", value);
  napi_create_double(env, static_cast<double>(event->atMs), &value);
  napi_set_named_property(env, obj, "atMs", value);
  napi_value global;
  napi_get_global(env, &global);
  napi_call_function(env, global, js_cb, 1, &obj, nullptr);
}

static void OnJobEnvCleanup(void* data) {
  auto* token = static_cast<TsfnFinalizeToken*>(data);
  token->hookRegistered = false;
  token->baton->envClosing.store(true);
}

static void TsfnFinalize(napi_env env, void* data, void* /*hint*/) {
  std::unique_ptr<TsfnFinalizeToken> token(static_cast<TsfnFinalizeToken*>(data));
  if (token->hookRegistered) {
    napi_remove_env_cleanup_hook(env, OnJobEnvCleanup, token.get());
  }
  std::lock_guard<std::mutex> lock(token->baton->mu);
  token->baton->snap.finalizerRan = true;
}

static napi_status create_exit_tsfn(napi_env env, napi_value callback,
                                    const std::shared_ptr<pty_baton>& baton) {
  napi_value name;
  napi_status status = napi_create_string_utf8(env, "PtyJobExit", NAPI_AUTO_LENGTH, &name);
  if (status != napi_ok) return status;
  TsfnFinalizeToken* token = new TsfnFinalizeToken{ baton };
  napi_threadsafe_function tsfn = nullptr;
  status = napi_create_threadsafe_function(
      env, callback, nullptr, name,
      0,   // unlimited queue
      1,   // initial thread count: owned by the connecting Guard
      token, TsfnFinalize, nullptr, CallJs, &tsfn);
  if (status != napi_ok) {
    delete token;
    return status;
  }
  // Register after the TSFN so this hook runs first during env teardown.
  status = napi_add_env_cleanup_hook(env, OnJobEnvCleanup, token);
  token->hookRegistered = status == napi_ok;
  {
    std::lock_guard<std::mutex> lock(baton->mu);
    baton->tsfn = tsfn;
    baton->tsfnGuardHeld = true;
  }
  return status;
}

/* Wait only for the Job transport handshake. Restore blocking I/O before
 * creating the shell, which uses the same pipes through ConPTY. */
static bool connect_job_pipe(HANDLE pipe, int64_t deadline,
                             const std::atomic<bool>& abortRequested) {
  DWORD mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
  if (!SetNamedPipeHandleState(pipe, &mode, nullptr, nullptr)) return false;
  DWORD error = ERROR_SEM_TIMEOUT;
  while (monotonic_ms() < deadline) {
    if (abortRequested.load()) {
      error = ERROR_CANCELLED;
      break;
    }
    if (!ConnectNamedPipe(pipe, nullptr)) {
      const DWORD result = GetLastError();
      if (result == ERROR_PIPE_CONNECTED) {
        error = ERROR_SUCCESS;
        break;
      }
      if (result != ERROR_PIPE_LISTENING) {
        error = result;
        break;
      }
    }
    Sleep(10);
  }
  mode = PIPE_READMODE_BYTE | PIPE_WAIT;
  if (!SetNamedPipeHandleState(pipe, &mode, nullptr, nullptr)) return false;
  SetLastError(error);
  return error == ERROR_SUCCESS;
}

/* Close every kernel object that may have been created before the terminal
 * was committed. Called only from the connecting thread; the TSFN finalizer
 * must never close these handles. */
static void cleanup_connecting(const std::shared_ptr<pty_baton>& baton,
                               const char* reason) {
  HANDLE job = nullptr;
  HANDLE shell = nullptr;
  HPCON hpc = nullptr;
  HANDLE in = INVALID_HANDLE_VALUE;
  HANDLE out = INVALID_HANDLE_VALUE;
  {
    std::lock_guard<std::mutex> lock(baton->mu);
    job = baton->hJob;
    baton->hJob = nullptr;
    shell = baton->hShell;
    baton->hShell = nullptr;
    hpc = baton->hpc;
    baton->hpc = nullptr;
    in = baton->hIn;
    baton->hIn = INVALID_HANDLE_VALUE;
    out = baton->hOut;
    baton->hOut = INVALID_HANDLE_VALUE;
  }
  if (in != INVALID_HANDLE_VALUE) CloseHandle(in);
  if (out != INVALID_HANDLE_VALUE) CloseHandle(out);
  if (job) TerminateJobObject(job, 1);
  bool confirmed = true;
  DWORD exitCode = 0;
  if (shell) {
    if (WaitForSingleObject(shell, 0) != WAIT_OBJECT_0) TerminateProcess(shell, 1);
    confirmed = WaitForSingleObject(shell, 2000) == WAIT_OBJECT_0;
    if (confirmed) GetExitCodeProcess(shell, &exitCode);
    CloseHandle(shell);
  }
  const bool jobClosed = !job || CloseHandle(job);
  // Job mode is gated to build 26200, where this returns without waiting for
  // output drain. Both local pipe handles were released above.
  if (hpc) ClosePseudoConsole(hpc);
  {
    std::lock_guard<std::mutex> lock(baton->mu);
    baton->snap.shellExited = shell != nullptr && confirmed;
    baton->snap.shellExitCode = exitCode;
    baton->snap.ptyDisposed = true;
    baton->snap.closeMs = 0;
    baton->snap.closeUnconfirmed = !confirmed || !jobClosed;
    /* Nothing was committed: the Job is empty (or its fate is unknown). */
    baton->snap.activeProcesses = shell == nullptr ? 0 : -1;
    baton->snap.jobAssigned = false;
    baton->snap.connectState = "failed";
    baton->snap.jobState = confirmed ? "closed" : "unconfirmed";
    baton->snap.treeState = confirmed ? "closed" : "unconfirmed";
    baton->snap.error = reason;
    baton->snap.finalState = true;
    baton->snap.present = false;
    baton->snap.gone = true;
  }
  release_tsfn_guard(baton);
  JobSnapshot final = snapshot_of(baton);
  final.present = false;
  final.gone = true;
  remember_final(baton, final);
}

static void cleanup_job_after_exit(const std::shared_ptr<pty_baton>& baton) {
  HPCON hpc = nullptr;
  HANDLE job = nullptr;
  bool terminatePath = false;
  {
    std::lock_guard<std::mutex> lock(baton->mu);
    hpc = baton->hpc;
    baton->hpc = nullptr;
    job = baton->hJob;
    terminatePath = baton->snap.terminateAccepted;
    baton->snap.queued = true;
    baton->snap.jobState = "draining";
    baton->snap.treeState = "draining";
  }

  bool drained = false;
  if (job) {
    const int64_t deadline = monotonic_ms() + (terminatePath ? 5000 : 500);
    int zeroSamples = 0;
    while (monotonic_ms() < deadline) {
      DWORD active = 0;
      if (query_active_processes(job, &active)) {
        {
          std::lock_guard<std::mutex> lock(baton->mu);
          baton->snap.activeProcesses = static_cast<int>(active);
        }
        if (active == 0) {
          zeroSamples++;
          if (zeroSamples >= 2) { drained = true; break; }
        } else {
          zeroSamples = 0;
        }
      } else {
        zeroSamples = 0;
      }
      Sleep(50);
    }
  }

  // Release the Job before entering a potentially blocking ConPTY close.
  {
    std::lock_guard<std::mutex> lock(baton->mu);
    /* Closing the last Job handle invokes KILL_ON_JOB_CLOSE for any
     * descendant still alive after the shell exited. */
    if (baton->hJob) {
      if (!CloseHandle(baton->hJob)) baton->snap.closeUnconfirmed = true;
      baton->hJob = nullptr;
    }
  }
  const int64_t closeStart = monotonic_ms();
  if (hpc) ClosePseudoConsole(hpc);
  const int64_t closeMs = monotonic_ms() - closeStart;

  {
    std::lock_guard<std::mutex> lock(baton->mu);
    baton->snap.ptyDisposed = true;
    baton->snap.queued = false;
    baton->snap.closeMs = closeMs;
    baton->snap.drainedVerified = drained;
    baton->snap.activeProcesses = drained ? 0 : baton->snap.activeProcesses;
    baton->snap.jobState = drained ? "drained" : "unconfirmed";
    baton->snap.treeState = drained ? "drained" : "unconfirmed";
    baton->snap.finalState = true;
  }
  JobSnapshot final = snapshot_of(baton);
  final.present = false;
  final.gone = true;
  remember_final(baton, final);
}

static void exit_thread_main(std::shared_ptr<pty_baton> baton) {
  HANDLE shell = nullptr;
  {
    std::lock_guard<std::mutex> lock(baton->mu);
    shell = baton->hShell;
  }
  const int64_t startedAt = monotonic_ms();
  int64_t stopDeadline = -1;
  bool exited = false;
  for (;;) {
    DWORD wait = shell ? WaitForSingleObject(shell, 100) : WAIT_OBJECT_0;
    if (wait == WAIT_OBJECT_0) { exited = true; break; }
    if (wait == WAIT_FAILED) break;
    if (stopDeadline < 0 && (baton->abortRequested.load() || baton->envClosing.load())) {
      stopDeadline = monotonic_ms() + 10000;
      std::lock_guard<std::mutex> lock(baton->mu);
      if (!baton->snap.terminateAccepted && baton->hJob &&
          TerminateJobObject(baton->hJob, 1)) {
        baton->snap.terminateAccepted = true;
        baton->snap.jobState = "terminating";
      }
    }
    if (stopDeadline >= 0 && monotonic_ms() >= stopDeadline) break;
  }

  DWORD exitCode = 0;
  int64_t shellExitMs = -1;
  if (exited) {
    GetExitCodeProcess(shell, &exitCode);
    shellExitMs = monotonic_ms() - startedAt;
  }
  {
    std::lock_guard<std::mutex> lock(baton->mu);
    if (baton->hShell) {
      CloseHandle(baton->hShell);
      baton->hShell = nullptr;
    }
    baton->snap.shellExited = exited;
    baton->snap.shellExitCode = exitCode;
    baton->snap.shellExitMs = shellExitMs;
    baton->snap.closeUnconfirmed = !exited;
    if (!exited) {
      baton->snap.jobState = "unconfirmed";
      baton->snap.treeState = "unconfirmed";
    } else {
      baton->snap.jobState = "draining";
      baton->snap.treeState = "draining";
    }
  }

  napi_threadsafe_function tsfn = nullptr;
  int activeProcesses = -1;
  {
    std::lock_guard<std::mutex> lock(baton->mu);
    tsfn = baton->tsfn;
    baton->tsfn = nullptr;
    activeProcesses = baton->snap.activeProcesses;
  }
  if (tsfn && exited && !baton->envClosing.load()) {
    JobExitEvent* event = new JobExitEvent{ 1, exitCode, static_cast<DWORD>(activeProcesses), monotonic_ms() };
    napi_status status = napi_call_threadsafe_function(tsfn, event, napi_tsfn_nonblocking);
    if (status == napi_closing) tsfn = nullptr; // Node consumed this holder.
    if (status != napi_ok) {
      delete event;
      std::lock_guard<std::mutex> lock(baton->mu);
      baton->snap.lostEvents++;
    }
  }
  if (tsfn) napi_release_threadsafe_function(tsfn, napi_tsfn_release);
  cleanup_job_after_exit(baton);
}

static void start_job_exit_thread(const std::shared_ptr<pty_baton>& baton) {
  /* Create first, transfer second: if std::thread throws, the Guard still
   * owns the TSFN reference and the caller's failure cleanup releases it. */
  std::thread thread([baton] { exit_thread_main(baton); });
  {
    std::lock_guard<std::mutex> lock(baton->mu);
    baton->tsfnGuardHeld = false;
  }
  thread.detach();
  baton->exitThreadStarted.store(true);
}

static Napi::Object snapshot_to_js(Napi::Env env, const JobSnapshot& s) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("present", Napi::Boolean::New(env, s.present));
  obj.Set("gone", Napi::Boolean::New(env, s.gone));
  obj.Set("final", Napi::Boolean::New(env, s.finalState));
  obj.Set("jobMode", Napi::Boolean::New(env, s.jobMode));
  obj.Set("jobAssigned", Napi::Boolean::New(env, s.jobAssigned));
  obj.Set("jobState", Napi::String::New(env, s.jobState));
  obj.Set("treeState", Napi::String::New(env, s.treeState));
  obj.Set("connectState", Napi::String::New(env, s.connectState));
  obj.Set("terminateAccepted", Napi::Boolean::New(env, s.terminateAccepted));
  obj.Set("drainedVerified", Napi::Boolean::New(env, s.drainedVerified));
  obj.Set("shellExited", Napi::Boolean::New(env, s.shellExited));
  obj.Set("ptyDisposed", Napi::Boolean::New(env, s.ptyDisposed));
  obj.Set("closeUnconfirmed", Napi::Boolean::New(env, s.closeUnconfirmed));
  obj.Set("disposeRequested", Napi::Boolean::New(env, s.disposeRequested));
  obj.Set("queued", Napi::Boolean::New(env, s.queued));
  obj.Set("resumeReturned", Napi::Boolean::New(env, s.resumeReturned));
  obj.Set("finalizerRan", Napi::Boolean::New(env, s.finalizerRan));
  obj.Set("envClosing", Napi::Boolean::New(env, s.envClosing));
  obj.Set("activeProcesses", Napi::Number::New(env, s.activeProcesses));
  obj.Set("lostEvents", Napi::Number::New(env, s.lostEvents));
  obj.Set("spawnedAtMs", Napi::Number::New(env, (double)s.spawnedAtMs));
  obj.Set("assignedAtMs", Napi::Number::New(env, (double)s.assignedAtMs));
  obj.Set("resumeAtMs", Napi::Number::New(env, (double)s.resumeAtMs));
  obj.Set("closeMs", Napi::Number::New(env, (double)s.closeMs));
  obj.Set("shellExitMs", Napi::Number::New(env, (double)s.shellExitMs));
  obj.Set("shellExitCode", Napi::Number::New(env, (double)s.shellExitCode));
  obj.Set("error", Napi::String::New(env, s.error));
  return obj;
}

static Napi::Value PtyJobStatus(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  if (info.Length() != 1 || !info[0].IsNumber()) {
    throw Napi::Error::New(env, "Usage: pty.jobStatus(id)");
  }
  const int id = info[0].As<Napi::Number>().Int32Value();
  std::shared_ptr<pty_baton> baton = get_pty_baton(id);
  if (baton) {
    /* activeProcesses is a live accounting value: children of the shell join
     * the Job after connect, so the connect-time count is not enough. */
    std::lock_guard<std::mutex> lock(baton->mu);
    DWORD active = 0;
    if (baton->hJob && !baton->snap.ptyDisposed
        && query_active_processes(baton->hJob, &active)) {
      baton->snap.activeProcesses = static_cast<int>(active);
    }
  }
  /* The lock above is scoped to this block; snapshot_of takes it again. */
  JobSnapshot snapshot = baton ? snapshot_of(baton) : cached_or_gone(id);
  return snapshot_to_js(env, snapshot);
}

static Napi::Value PtyKillJob(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  if (info.Length() != 1 || !info[0].IsNumber()) {
    throw Napi::Error::New(env, "Usage: pty.killJob(id)");
  }
  const int id = info[0].As<Napi::Number>().Int32Value();
  std::shared_ptr<pty_baton> baton = get_pty_baton(id);
  if (!baton) {
    return snapshot_to_js(env, cached_or_gone(id));
  }
  {
    std::lock_guard<std::mutex> lock(baton->mu);
    baton->abortRequested.store(true);
    baton->snap.disposeRequested = true;
    if (baton->jobMode && baton->hJob && !baton->snap.terminateAccepted &&
        baton->snap.connectState == "connected") {
      if (TerminateJobObject(baton->hJob, 1)) {
        baton->snap.terminateAccepted = true;
        baton->snap.jobState = "terminating";
        baton->snap.treeState = "terminating";
      }
    }
  }
  return snapshot_to_js(env, snapshot_of(baton));
}

static Napi::Value PtyDisposeJob(const Napi::CallbackInfo& info) {
  if (info.Length() == 1 && info[0].IsNumber()) {
    auto baton = get_pty_baton(info[0].As<Napi::Number>().Int32Value());
    if (baton && baton->jobMode) {
      bool abandon = false;
      {
        std::lock_guard<std::mutex> lock(baton->mu);
        if (baton->snap.connectState == "created") {
          baton->snap.connectState = "abandoning";
          abandon = true;
        }
      }
      if (abandon) {
        cleanup_connecting(baton, "pty_aborted");
        return snapshot_to_js(info.Env(), cached_or_gone(baton->id));
      }
    }
  }
  return PtyKillJob(info);
}

static Napi::Value PtySupportsJobObject(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), job_api_available());
}

static Napi::Value PtyStartProcess(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  Napi::Object marshal;
  std::wstring inName, outName;
  BOOL fSuccess = FALSE;
  std::unique_ptr<wchar_t[]> mutableCommandline;
  PROCESS_INFORMATION _piClient{};

  const bool hasJobOption = info.Length() == 8;
  if ((info.Length() != 7 && !hasJobOption) ||
      !info[0].IsString() ||
      !info[1].IsNumber() ||
      !info[2].IsNumber() ||
      !info[3].IsBoolean() ||
      !info[4].IsString() ||
      !info[5].IsBoolean() ||
      !info[6].IsBoolean() ||
      (hasJobOption && !info[7].IsBoolean())) {
    throw Napi::Error::New(env, "Usage: pty.startProcess(file, cols, rows, debug, pipeName, inheritCursor, useConptyDll, useJobObject)");
  }

  const std::wstring filename(path_util::to_wstring(info[0].As<Napi::String>()));
  const SHORT cols = static_cast<SHORT>(info[1].As<Napi::Number>().Uint32Value());
  const SHORT rows = static_cast<SHORT>(info[2].As<Napi::Number>().Uint32Value());
  const bool debug = info[3].As<Napi::Boolean>().Value();
  const std::wstring pipeName(path_util::to_wstring(info[4].As<Napi::String>()));
  const bool inheritCursor = info[5].As<Napi::Boolean>().Value();
  const bool useConptyDll = info[6].As<Napi::Boolean>().Value();
  const bool useJobObject = hasJobOption && info[7].As<Napi::Boolean>().Value();

  if (useJobObject && !job_api_available()) {
    throw Napi::Error::New(env, "Job Object mode is unavailable on this Windows build");
  }
  if (useJobObject && useConptyDll) {
    throw Napi::Error::New(env, "Job Object mode requires the system ConPTY (useConptyDll=false)");
  }

  // use environment 'Path' variable to determine location of
  // the relative path that we have recieved (e.g cmd.exe)
  std::wstring shellpath;
  if (::PathIsRelativeW(filename.c_str())) {
    shellpath = path_util::get_shell_path(filename.c_str());
  } else {
    shellpath = filename;
  }

  if (shellpath.empty() || !path_util::file_exists(shellpath)) {
    std::string why;
    why += "File not found: ";
    why += path_util::wstring_to_string(shellpath);
    throw Napi::Error::New(env, why);
  }

  HANDLE job = nullptr;
  if (useJobObject) {
    job = create_kill_on_close_job();
    if (!job) {
      throw Napi::Error::New(env, "Cannot create a kill-on-close Job Object");
    }
  }

  HANDLE hIn = INVALID_HANDLE_VALUE;
  HANDLE hOut = INVALID_HANDLE_VALUE;
  HPCON hpc = nullptr;
  HRESULT hr = CreateNamedPipesAndPseudoConsole(info, {cols, rows}, inheritCursor ? 1/*PSEUDOCONSOLE_INHERIT_CURSOR*/ : 0, &hIn, &hOut, &hpc, inName, outName, pipeName, useConptyDll);
  if (FAILED(hr)) {
    if (hIn != INVALID_HANDLE_VALUE) CloseHandle(hIn);
    if (hOut != INVALID_HANDLE_VALUE) CloseHandle(hOut);
    if (job) CloseHandle(job);
    throw Napi::Error::New(env, "Cannot launch conpty");
  }

  std::string inNameStr = path_util::wstring_to_string(inName);
  std::string outNameStr = path_util::wstring_to_string(outName);
  if (inNameStr.empty() || outNameStr.empty()) {
    if (hIn != INVALID_HANDLE_VALUE) CloseHandle(hIn);
    if (hOut != INVALID_HANDLE_VALUE) CloseHandle(hOut);
    if (hpc) ClosePseudoConsole(hpc);
    if (job) CloseHandle(job);
    throw Napi::Error::New(env, inNameStr.empty()
        ? "Failed to initialize conpty conin" : "Failed to initialize conpty conout");
  }

  // Restore default handling of ctrl+c
  SetConsoleCtrlHandler(NULL, FALSE);

  // Set return values
  marshal = Napi::Object::New(env);
  const int ptyId = InterlockedIncrement(&ptyCounter);
  auto baton = std::make_shared<pty_baton>(ptyId, hIn, hOut, hpc);
  baton->hJob = job;
  baton->jobMode = useJobObject;
  baton->snap.jobMode = useJobObject;
  baton->snap.jobAssigned = false;
  {
    std::lock_guard<std::mutex> lock(g_registry_mu);
    ptyHandles.push_back(baton);
  }
  marshal.Set("pty", Napi::Number::New(env, ptyId));
  marshal.Set("fd", Napi::Number::New(env, -1));
  marshal.Set("conin", Napi::String::New(env, inNameStr));
  marshal.Set("conout", Napi::String::New(env, outNameStr));
  return marshal;
}

static Napi::Value PtyConnect(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  // If we're working with conpty's we need to call ConnectNamedPipe here AFTER
  //    the Socket has attempted to connect to the other end, then actually
  //    spawn the process here.

  BOOL fSuccess = FALSE;

  const bool hasJobOption = info.Length() == 7;
  const size_t callbackIndex = hasJobOption ? 6 : 5;
  if ((info.Length() != 6 && !hasJobOption) ||
      !info[0].IsNumber() ||
      !info[1].IsString() ||
      !info[2].IsString() ||
      !info[3].IsArray() ||
      !info[4].IsBoolean() ||
      (hasJobOption && !info[5].IsBoolean()) ||
      !info[callbackIndex].IsFunction()) {
    throw Napi::Error::New(env, "Usage: pty.connect(id, cmdline, cwd, env, useConptyDll, useJobObject, exitCallback)");
  }

  const int id = info[0].As<Napi::Number>().Int32Value();
  const std::wstring cmdline(path_util::to_wstring(info[1].As<Napi::String>()));
  const std::wstring cwd(path_util::to_wstring(info[2].As<Napi::String>()));
  const Napi::Array envValues = info[3].As<Napi::Array>();
  const bool useConptyDll = info[4].As<Napi::Boolean>().Value();
  const bool useJobObject = hasJobOption && info[5].As<Napi::Boolean>().Value();
  Napi::Function exitCallback = info[callbackIndex].As<Napi::Function>();

  // Fetch pty handle from ID and start process
  std::shared_ptr<pty_baton> handle = get_pty_baton(id);
  if (!handle) {
    throw Napi::Error::New(env, "Invalid pty handle");
  }
  if (useJobObject != handle->jobMode) {
    throw Napi::Error::New(env, "Job Object mode does not match startProcess");
  }

  // Prepare command line
  std::unique_ptr<wchar_t[]> mutableCommandline = std::make_unique<wchar_t[]>(cmdline.length() + 1);
  HRESULT hr = StringCchCopyW(mutableCommandline.get(), cmdline.length() + 1, cmdline.c_str());

  // Prepare cwd
  std::unique_ptr<wchar_t[]> mutableCwd = std::make_unique<wchar_t[]>(cwd.length() + 1);
  hr = StringCchCopyW(mutableCwd.get(), cwd.length() + 1, cwd.c_str());
  (void)hr;

  // Prepare environment
  std::wstring envStr;
  if (!envValues.IsEmpty()) {
    std::wstring envBlock;
    for(uint32_t i = 0; i < envValues.Length(); i++) {
      envBlock += path_util::to_wstring(envValues.Get(i).As<Napi::String>());
      envBlock += L'\0';
    }
    envBlock += L'\0';
    envStr = std::move(envBlock);
  }
  std::vector<wchar_t> envV(envStr.cbegin(), envStr.cend());
  LPWSTR envArg = envV.empty() ? nullptr : envV.data();

  if (!handle->jobMode) {
    ConnectNamedPipe(handle->hIn, nullptr);
    ConnectNamedPipe(handle->hOut, nullptr);

    // Attach the pseudoconsole to the client application we're creating
    STARTUPINFOEXW siEx{0};
    siEx.StartupInfo.cb = sizeof(STARTUPINFOEXW);
    siEx.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
    siEx.StartupInfo.hStdError = nullptr;
    siEx.StartupInfo.hStdInput = nullptr;
    siEx.StartupInfo.hStdOutput = nullptr;

    SIZE_T size = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &size);
    std::unique_ptr<BYTE[]> attrList(new BYTE[size]);
    siEx.lpAttributeList = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attrList.get());

    fSuccess = InitializeProcThreadAttributeList(siEx.lpAttributeList, 1, 0, &size);
    if (!fSuccess) {
      throw errorWithCode(info, "InitializeProcThreadAttributeList failed");
    }
    fSuccess = UpdateProcThreadAttribute(siEx.lpAttributeList,
                                         0,
                                         PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                                         handle->hpc,
                                         sizeof(HPCON),
                                         NULL,
                                         NULL);
    if (!fSuccess) {
      throw errorWithCode(info, "UpdateProcThreadAttribute failed");
    }

    PROCESS_INFORMATION piClient{};
    fSuccess = !!CreateProcessW(
        nullptr,
        mutableCommandline.get(),
        nullptr,                      // lpProcessAttributes
        nullptr,                      // lpThreadAttributes
        false,                        // bInheritHandles VERY IMPORTANT that this is false
        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, // dwCreationFlags
        envArg,                       // lpEnvironment
        mutableCwd.get(),             // lpCurrentDirectory
        &siEx.StartupInfo,            // lpStartupInfo
        &piClient                     // lpProcessInformation
    );
    if (!fSuccess) {
      throw errorWithCode(info, "Cannot create process");
    }

    HANDLE hLibrary = LoadConptyDll(info, useConptyDll);
    bool fLoadedDll = hLibrary != nullptr;
    if (useConptyDll && fLoadedDll)
    {
      PFNRELEASEPSEUDOCONSOLE const pfnReleasePseudoConsole = (PFNRELEASEPSEUDOCONSOLE)GetProcAddress(
        (HMODULE)hLibrary, "ConptyReleasePseudoConsole");
      if (pfnReleasePseudoConsole)
      {
        pfnReleasePseudoConsole(handle->hpc);
      }
    }

    // Update handle
    {
      std::lock_guard<std::mutex> lock(handle->mu);
      handle->hShell = piClient.hProcess;
    }

    // Close the thread handle to avoid resource leak
    CloseHandle(piClient.hThread);
    // Close the input read and output write handle of the pseudoconsole
    CloseHandle(handle->hIn);
    CloseHandle(handle->hOut);
    handle->hIn = INVALID_HANDLE_VALUE;
    handle->hOut = INVALID_HANDLE_VALUE;

    SetupExitCallback(env, exitCallback, handle);

    // Return
    auto marshal = Napi::Object::New(env);
    marshal.Set("pid", Napi::Number::New(env, piClient.dwProcessId));
    return marshal;
  }

  /* ---- Job Object mode (Plan B+) -------------------------------------- */

  {
    std::lock_guard<std::mutex> lock(handle->mu);
    if (handle->snap.connectState != "created") {
      throw Napi::Error::New(env, "pty_connect_busy");
    }
    handle->snap.connectState = "connecting";
  }
  if (handle->abortRequested.load()) {
    cleanup_connecting(handle, "pty_aborted");
    throw Napi::Error::New(env, "pty_aborted");
  }

  napi_status tsfnStatus = create_exit_tsfn(env, exitCallback, handle);
  if (tsfnStatus != napi_ok) {
    cleanup_connecting(handle, "tsfn_create_failed");
    throw Napi::Error::New(env, "Cannot create the exit event channel");
  }

  const int64_t pipeDeadline = monotonic_ms() + 3000;
  if (!connect_job_pipe(handle->hIn, pipeDeadline, handle->abortRequested) ||
      !connect_job_pipe(handle->hOut, pipeDeadline, handle->abortRequested)) {
    const DWORD error = GetLastError();
    cleanup_connecting(handle, error == ERROR_CANCELLED ? "pty_aborted" : "pipe_connect_failed");
    throw Napi::Error::New(env, "ConPTY pipe connection failed, error code: " + std::to_string(error));
  }

  STARTUPINFOEXW siEx{0};
  siEx.StartupInfo.cb = sizeof(STARTUPINFOEXW);
  siEx.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
  siEx.StartupInfo.hStdError = nullptr;
  siEx.StartupInfo.hStdInput = nullptr;
  siEx.StartupInfo.hStdOutput = nullptr;

  SIZE_T size = 0;
  InitializeProcThreadAttributeList(NULL, 2, 0, &size);
  std::unique_ptr<BYTE[]> attrList(new BYTE[size]);
  siEx.lpAttributeList = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(attrList.get());
  fSuccess = InitializeProcThreadAttributeList(siEx.lpAttributeList, 2, 0, &size);
  if (!fSuccess) {
    const DWORD error = GetLastError();
    cleanup_connecting(handle, "attribute_list_failed");
    throw Napi::Error::New(env, "InitializeProcThreadAttributeList failed, error code: " + std::to_string(error));
  }
  fSuccess = UpdateProcThreadAttribute(siEx.lpAttributeList,
                                       0,
                                       PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                                       handle->hpc,
                                       sizeof(HPCON),
                                       NULL,
                                       NULL);
  if (!fSuccess) {
    const DWORD error = GetLastError();
    DeleteProcThreadAttributeList(siEx.lpAttributeList);
    cleanup_connecting(handle, "pseudoconsole_attribute_failed");
    throw Napi::Error::New(env, "UpdateProcThreadAttribute(pseudoconsole) failed, error code: " + std::to_string(error));
  }

  HANDLE job = nullptr;
  {
    std::lock_guard<std::mutex> lock(handle->mu);
    job = handle->hJob;
  }
  if (!job) {
    DeleteProcThreadAttributeList(siEx.lpAttributeList);
    cleanup_connecting(handle, "job_missing");
    throw Napi::Error::New(env, "job_assign_failed");
  }
  fSuccess = UpdateProcThreadAttribute(siEx.lpAttributeList,
                                       0,
                                       PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                       &job,
                                       sizeof(job),
                                       NULL,
                                       NULL);
  if (!fSuccess) {
    const DWORD error = GetLastError();
    DeleteProcThreadAttributeList(siEx.lpAttributeList);
    cleanup_connecting(handle, "job_list_attribute_failed");
    throw Napi::Error::New(env, "job_assign_failed, error code: " + std::to_string(error));
  }

  PROCESS_INFORMATION piClient{};
  fSuccess = !!CreateProcessW(
      nullptr,
      mutableCommandline.get(),
      nullptr,                      // lpProcessAttributes
      nullptr,                      // lpThreadAttributes
      false,                        // bInheritHandles VERY IMPORTANT that this is false
      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
      envArg,                       // lpEnvironment
      mutableCwd.get(),             // lpCurrentDirectory
      &siEx.StartupInfo,            // lpStartupInfo
      &piClient                     // lpProcessInformation
  );
  const DWORD createError = fSuccess ? ERROR_SUCCESS : GetLastError();
  DeleteProcThreadAttributeList(siEx.lpAttributeList);
  if (!fSuccess) {
    const DWORD error = createError;
    const bool aborted = handle->abortRequested.load();
    cleanup_connecting(handle, error == ERROR_ACCESS_DENIED && aborted ? "pty_aborted" : "create_process_failed");
    if (error == ERROR_ACCESS_DENIED && aborted) {
      throw Napi::Error::New(env, "pty_aborted");
    }
    throw Napi::Error::New(env, "Cannot create process, error code: " + std::to_string(error));
  }

  {
    std::lock_guard<std::mutex> lock(handle->mu);
    handle->hShell = piClient.hProcess;
    handle->snap.spawnedAtMs = monotonic_ms();
  }

  // The shell is still suspended here. Its presence in the exact Job is a
  // precondition, not something inferred from a successful CreateProcessW.
  BOOL inJob = FALSE;
  IsProcessInJob(piClient.hProcess, job, &inJob);
  DWORD active = 0;
  bool counted = false;
  for (int i = 0; i < 3; i++) {
    if (query_active_processes(job, &active) && active >= 1) {
      counted = true;
      break;
    }
    Sleep(15);
  }
  if (!inJob || !counted) {
    CloseHandle(piClient.hThread);
    cleanup_connecting(handle, inJob ? "job_accounting_failed" : "job_assign_failed");
    throw Napi::Error::New(env, inJob ? "job_accounting_failed" : "job_assign_failed");
  }
  {
    std::lock_guard<std::mutex> lock(handle->mu);
    handle->snap.jobAssigned = true;
    handle->snap.activeProcesses = static_cast<int>(active);
    handle->snap.assignedAtMs = monotonic_ms();
  }

  bool abortedBeforeResume = false;
  DWORD previousSuspendCount = static_cast<DWORD>(-1);
  DWORD resumeError = ERROR_SUCCESS;
  {
    std::lock_guard<std::mutex> lock(handle->mu);
    abortedBeforeResume = handle->abortRequested.load();
    if (!abortedBeforeResume) {
      previousSuspendCount = ResumeThread(piClient.hThread);
      if (previousSuspendCount == static_cast<DWORD>(-1)) resumeError = GetLastError();
      if (previousSuspendCount == 1) handle->snap.resumeAtMs = monotonic_ms();
    }
  }
  CloseHandle(piClient.hThread);
  if (abortedBeforeResume || previousSuspendCount != 1) {
    const char* reason = abortedBeforeResume ? "pty_aborted" : "job_resume_failed";
    cleanup_connecting(handle, reason);
    throw Napi::Error::New(env, std::string(reason) + ", error code: " + std::to_string(resumeError));
  }

  bool abortedAtCommit = false;
  {
    std::lock_guard<std::mutex> lock(handle->mu);
    if (handle->abortRequested.load()) {
      abortedAtCommit = true;
    } else {
      handle->snap.connectState = "connected";
      handle->snap.jobState = "active";
      handle->snap.treeState = "active";
      handle->snap.resumeReturned = true;
    }
  }
  if (abortedAtCommit) {
    cleanup_connecting(handle, "pty_aborted");
    throw Napi::Error::New(env, "pty_aborted");
  }

  CloseHandle(handle->hIn);
  CloseHandle(handle->hOut);
  handle->hIn = INVALID_HANDLE_VALUE;
  handle->hOut = INVALID_HANDLE_VALUE;

  try {
    start_job_exit_thread(handle);
  } catch (...) {
    cleanup_connecting(handle, "exit_thread_failed");
    throw Napi::Error::New(env, "Cannot start the exit thread");
  }

  auto marshal = Napi::Object::New(env);
  marshal.Set("pid", Napi::Number::New(env, piClient.dwProcessId));
  marshal.Set("jobAssigned", Napi::Boolean::New(env, true));
  return marshal;
}

static Napi::Value PtyResize(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 4 ||
      !info[0].IsNumber() ||
      !info[1].IsNumber() ||
      !info[2].IsNumber() ||
      !info[3].IsBoolean()) {
    throw Napi::Error::New(env, "Usage: pty.resize(id, cols, rows, useConptyDll)");
  }

  int id = info[0].As<Napi::Number>().Int32Value();
  SHORT cols = static_cast<SHORT>(info[1].As<Napi::Number>().Uint32Value());
  SHORT rows = static_cast<SHORT>(info[2].As<Napi::Number>().Uint32Value());
  const bool useConptyDll = info[3].As<Napi::Boolean>().Value();

  std::shared_ptr<pty_baton> handle = get_pty_baton(id);

  if (handle != nullptr) {
    HANDLE hLibrary = LoadConptyDll(info, useConptyDll);
    std::lock_guard<std::mutex> lock(handle->mu);
    HPCON hpc = handle->hpc;
    bool fLoadedDll = hLibrary != nullptr;
    if (fLoadedDll && hpc)
    {
      PFNRESIZEPSEUDOCONSOLE const pfnResizePseudoConsole = (PFNRESIZEPSEUDOCONSOLE)GetProcAddress(
        (HMODULE)hLibrary,
        useConptyDll ? "ConptyResizePseudoConsole" : "ResizePseudoConsole");
      if (pfnResizePseudoConsole)
      {
        COORD size = {cols, rows};
        pfnResizePseudoConsole(hpc, size);
      }
    }
  }

  return env.Undefined();
}

static Napi::Value PtyClear(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 2 ||
      !info[0].IsNumber() ||
      !info[1].IsBoolean()) {
    throw Napi::Error::New(env, "Usage: pty.clear(id, useConptyDll)");
  }

  int id = info[0].As<Napi::Number>().Int32Value();
  const bool useConptyDll = info[1].As<Napi::Boolean>().Value();

  // This API is only supported for conpty.dll as it was introduced in a later version of Windows.
  // We could hook it up to point at >= a version of Windows only, but the future is conpty.dll
  // anyway.
  if (!useConptyDll) {
    return env.Undefined();
  }

  std::shared_ptr<pty_baton> handle = get_pty_baton(id);

  if (handle != nullptr) {
    HPCON hpc = nullptr;
    {
      std::lock_guard<std::mutex> lock(handle->mu);
      hpc = handle->hpc;
    }
    HANDLE hLibrary = LoadConptyDll(info, useConptyDll);
    bool fLoadedDll = hLibrary != nullptr;
    if (fLoadedDll && hpc)
    {
      PFNCLEARPSEUDOCONSOLE const pfnClearPseudoConsole = (PFNCLEARPSEUDOCONSOLE)GetProcAddress((HMODULE)hLibrary, "ConptyClearPseudoConsole");
      if (pfnClearPseudoConsole)
      {
        pfnClearPseudoConsole(hpc);
      }
    }
  }

  return env.Undefined();
}

static Napi::Value PtyKill(const Napi::CallbackInfo& info) {
  Napi::Env env(info.Env());
  Napi::HandleScope scope(env);

  if (info.Length() != 2 ||
      !info[0].IsNumber() ||
      !info[1].IsBoolean()) {
    throw Napi::Error::New(env, "Usage: pty.kill(id, useConptyDll)");
  }

  int id = info[0].As<Napi::Number>().Int32Value();
  const bool useConptyDll = info[1].As<Napi::Boolean>().Value();

  std::shared_ptr<pty_baton> handle = get_pty_baton(id);

  if (handle != nullptr) {
    if (handle->jobMode) {
      /* Job mode never terminates by PID and never closes the Job handle
       * here: the exit/cleanup threads own that handoff. */
      {
        std::lock_guard<std::mutex> lock(handle->mu);
        handle->abortRequested.store(true);
        handle->snap.disposeRequested = true;
        if (handle->hJob && !handle->snap.terminateAccepted &&
            handle->snap.connectState == "connected") {
          if (TerminateJobObject(handle->hJob, 1)) {
            handle->snap.terminateAccepted = true;
            handle->snap.jobState = "terminating";
            handle->snap.treeState = "terminating";
          }
        }
      }
      return env.Undefined();
    }
    HPCON hpc = nullptr;
    HANDLE shell = nullptr;
    {
      std::lock_guard<std::mutex> lock(handle->mu);
      hpc = handle->hpc;
      shell = handle->hShell;
    }
    HANDLE hLibrary = LoadConptyDll(info, useConptyDll);
    bool fLoadedDll = hLibrary != nullptr;
    if (fLoadedDll && hpc)
    {
      PFNCLOSEPSEUDOCONSOLE const pfnClosePseudoConsole = (PFNCLOSEPSEUDOCONSOLE)GetProcAddress(
        (HMODULE)hLibrary,
        useConptyDll ? "ConptyClosePseudoConsole" : "ClosePseudoConsole");
      if (pfnClosePseudoConsole)
      {
        pfnClosePseudoConsole(hpc);
      }
    }
    if (useConptyDll && shell) {
      TerminateProcess(shell, 1);
    }
  }

  return env.Undefined();
}

/**
* Init
*/

Napi::Object init(Napi::Env env, Napi::Object exports) {
  exports.Set("startProcess", Napi::Function::New(env, PtyStartProcess));
  exports.Set("connect", Napi::Function::New(env, PtyConnect));
  exports.Set("resize", Napi::Function::New(env, PtyResize));
  exports.Set("clear", Napi::Function::New(env, PtyClear));
  exports.Set("kill", Napi::Function::New(env, PtyKill));
  exports.Set("killJob", Napi::Function::New(env, PtyKillJob));
  exports.Set("dispose", Napi::Function::New(env, PtyDisposeJob));
  exports.Set("jobStatus", Napi::Function::New(env, PtyJobStatus));
  exports.Set("supportsJobObject", Napi::Function::New(env, PtySupportsJobObject));
  return exports;
};

NODE_API_MODULE(NODE_GYP_MODULE_NAME, init);
