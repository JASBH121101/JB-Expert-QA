import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const POWERSHELL_SERVER = "$ErrorActionPreference = 'Stop'\n$source = @'\nusing System;\nusing System.Globalization;\nusing System.Runtime.InteropServices;\nusing System.Threading;\nnamespace JBQA {\n  [StructLayout(LayoutKind.Sequential)] public struct BasicLimitInformation {\n    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;\n    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;\n    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;\n  }\n  [StructLayout(LayoutKind.Sequential)] public struct IoCounters {\n    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;\n    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;\n  }\n  [StructLayout(LayoutKind.Sequential)] public struct ExtendedLimitInformation {\n    public BasicLimitInformation BasicLimitInformation; public IoCounters IoInfo;\n    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;\n    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;\n  }\n  [StructLayout(LayoutKind.Sequential)] public struct CpuRateInformation { public uint ControlFlags; public uint CpuRate; }\n  [StructLayout(LayoutKind.Sequential)] public struct BasicAccountingInformation {\n    public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime;\n    public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;\n  }\n  public static class Native {\n    [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);\n    [DllImport(\"kernel32.dll\", SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInformation info, uint length);\n    [DllImport(\"kernel32.dll\", SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref CpuRateInformation info, uint length);\n    [DllImport(\"kernel32.dll\", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);\n    [DllImport(\"kernel32.dll\", SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);\n    [DllImport(\"kernel32.dll\", SetLastError=true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);\n    [DllImport(\"kernel32.dll\", SetLastError=true)] private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, ref BasicAccountingInformation info, uint length, IntPtr returned);\n    [DllImport(\"kernel32.dll\", SetLastError=true)] private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInformation info, uint length, IntPtr returned);\n    [DllImport(\"kernel32.dll\", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);\n    private static Exception Failure(string name) { return new InvalidOperationException(name + \":\" + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture)); }\n    public static IntPtr CreateAndConfigure(ulong memoryBytes, uint processLimit, uint cpuRate) {\n      IntPtr job = CreateJobObject(IntPtr.Zero, null);\n      if (job == IntPtr.Zero) throw Failure(\"CreateJobObject\");\n      try {\n        ExtendedLimitInformation limits = new ExtendedLimitInformation();\n        limits.BasicLimitInformation.LimitFlags = 0x00000200 | 0x00000008 | 0x00002000;\n        limits.BasicLimitInformation.ActiveProcessLimit = processLimit;\n        limits.JobMemoryLimit = new UIntPtr(memoryBytes);\n        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation)))) throw Failure(\"SetExtendedLimitInformation\");\n        CpuRateInformation cpu = new CpuRateInformation();\n        cpu.ControlFlags = 0x1 | 0x4; cpu.CpuRate = cpuRate;\n        if (!SetInformationJobObject(job, 15, ref cpu, (uint)Marshal.SizeOf(typeof(CpuRateInformation)))) throw Failure(\"SetCpuRateControlInformation\");\n        return job;\n      } catch { CloseHandle(job); throw; }\n    }\n    public static void Attach(IntPtr job, uint processId) {\n      IntPtr process = OpenProcess(0x0001 | 0x0100, false, processId);\n      if (process == IntPtr.Zero) throw Failure(\"OpenProcess\");\n      try { if (!AssignProcessToJobObject(job, process)) throw Failure(\"AssignProcessToJobObject\"); }\n      finally { CloseHandle(process); }\n    }\n    public static void Terminate(IntPtr job) {\n      if (job != IntPtr.Zero && !TerminateJobObject(job, 0xE0000001)) throw Failure(\"TerminateJobObject\");\n    }\n    public static string Stats(IntPtr job) {\n      BasicAccountingInformation accounting = new BasicAccountingInformation();\n      if (!QueryInformationJobObject(job, 1, ref accounting, (uint)Marshal.SizeOf(typeof(BasicAccountingInformation)), IntPtr.Zero)) throw Failure(\"QueryBasicAccountingInformation\");\n      ExtendedLimitInformation extended = new ExtendedLimitInformation();\n      if (!QueryInformationJobObject(job, 9, ref extended, (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation)), IntPtr.Zero)) throw Failure(\"QueryExtendedLimitInformation\");\n      ulong cpu100ns = unchecked((ulong)(accounting.TotalUserTime + accounting.TotalKernelTime));\n      return \"{\\\"activeProcesses\\\":\" + accounting.ActiveProcesses.ToString(CultureInfo.InvariantCulture) +\n        \",\\\"totalProcesses\\\":\" + accounting.TotalProcesses.ToString(CultureInfo.InvariantCulture) +\n        \",\\\"terminatedProcesses\\\":\" + accounting.TotalTerminatedProcesses.ToString(CultureInfo.InvariantCulture) +\n        \",\\\"totalCpuTime100ns\\\":\" + cpu100ns.ToString(CultureInfo.InvariantCulture) +\n        \",\\\"peakJobMemoryBytes\\\":\" + extended.PeakJobMemoryUsed.ToUInt64().ToString(CultureInfo.InvariantCulture) + \"}\";\n    }\n    public static bool WaitForEmpty(IntPtr job, int timeoutMs) {\n      DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);\n      do {\n        BasicAccountingInformation accounting = new BasicAccountingInformation();\n        if (!QueryInformationJobObject(job, 1, ref accounting, (uint)Marshal.SizeOf(typeof(BasicAccountingInformation)), IntPtr.Zero)) throw Failure(\"QueryJobBeforeClose\");\n        if (accounting.ActiveProcesses == 0) return true;\n        Thread.Sleep(10);\n      } while (DateTime.UtcNow < deadline);\n      return false;\n    }\n    private static readonly object OutputLock = new object();\n    public static Timer StartTelemetry(IntPtr job, int intervalMs) {\n      return new Timer(delegate(object state) {\n        try {\n          string snapshot = Stats((IntPtr)state);\n          lock (OutputLock) {\n            Console.Out.WriteLine(\"{\\\"type\\\":\\\"usage\\\",\\\"data\\\":\" + snapshot + \"}\");\n            Console.Out.Flush();\n          }\n        } catch {}\n      }, job, intervalMs, intervalMs);\n    }\n    public static void StopTelemetry(Timer timer) {\n      if (timer == null) return;\n      using (ManualResetEvent completed = new ManualResetEvent(false)) {\n        timer.Dispose(completed);\n        completed.WaitOne(1000);\n      }\n    }\n    public static void Close(IntPtr job) { if (job != IntPtr.Zero && !CloseHandle(job)) throw Failure(\"CloseJobHandle\"); }\n  }\n}\n'@\n$job = [IntPtr]::Zero\n$telemetry = $null\ntry {\n  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop\n  $job = [JBQA.Native]::CreateAndConfigure(__MEMORY__, __PROCESSES__, __CPU_RATE__)\n  $telemetry = [JBQA.Native]::StartTelemetry($job, 250)\n  [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ type = 'ready' }))\n  [Console]::Out.Flush()\n  $shouldExit = $false\n  $treeTerminated = $false\n  while (-not $shouldExit) {\n    $line = [Console]::In.ReadLine()\n    if ($null -eq $line) { break }\n    $request = ConvertFrom-Json -InputObject $line\n    $requestId = [int]$request.id\n    try {\n      $data = $null\n      switch ([string]$request.type) {\n        'attach' { [JBQA.Native]::Attach($job, [UInt32]$request.pid); $data = ConvertFrom-Json -InputObject ([JBQA.Native]::Stats($job)) }\n        'usage' { $data = ConvertFrom-Json -InputObject ([JBQA.Native]::Stats($job)) }\n        'terminate' {\n          if (-not $treeTerminated) {\n            [JBQA.Native]::Terminate($job)\n            if (-not [JBQA.Native]::WaitForEmpty($job, __CLEANUP_TIMEOUT__)) { throw 'JOB_CLEANUP_TIMEOUT' }\n            $treeTerminated = $true\n          }\n          $data = ConvertFrom-Json -InputObject ([JBQA.Native]::Stats($job))\n        }\n        'close' {\n          if (-not $treeTerminated) {\n            [JBQA.Native]::Terminate($job)\n            if (-not [JBQA.Native]::WaitForEmpty($job, __CLEANUP_TIMEOUT__)) { throw 'JOB_CLEANUP_TIMEOUT' }\n            $treeTerminated = $true\n          }\n          [JBQA.Native]::StopTelemetry($telemetry); $telemetry = $null\n          [JBQA.Native]::Close($job); $job = [IntPtr]::Zero\n          $data = @{ closed = $true }; $shouldExit = $true\n        }\n        default { throw 'UNSUPPORTED_COMMAND' }\n      }\n      [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 6 -InputObject @{ type = 'response'; id = $requestId; data = $data }))\n      [Console]::Out.Flush()\n    } catch {\n      [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ type = 'response'; id = $requestId; error = 'WINDOWS_JOB_OPERATION_FAILED' }))\n      [Console]::Out.Flush()\n    }\n  }\n} catch {\n  [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ type = 'fatal'; error = 'WINDOWS_JOB_INITIALIZATION_FAILED' }))\n  [Console]::Out.Flush()\n} finally {\n  if ($telemetry -ne $null) { try { [JBQA.Native]::StopTelemetry($telemetry) } catch {} }\n  if ($job -ne [IntPtr]::Zero) { try { [JBQA.Native]::Close($job) } catch {} }\n}";

export class WindowsJobObjectResourceControllerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WindowsJobObjectResourceControllerError";
    this.code = code;
  }
}

function readRecord(value, label, allowedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WindowsJobObjectResourceControllerError("INVALID_OPTIONS", label + " must be a plain object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new WindowsJobObjectResourceControllerError("INVALID_OPTIONS", label + " must be a plain object");
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) throw new WindowsJobObjectResourceControllerError("UNSUPPORTED_OPTION", label + " contains an unsupported field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new WindowsJobObjectResourceControllerError("ACCESSOR_NOT_ALLOWED", label + " cannot contain accessors");
    output[key] = descriptor.value;
  }
  return output;
}

function normalizeLimits(value = {}) {
  const config = readRecord(value, "limits", new Set(["maxMemoryBytes", "cpuRatePercent", "maxProcesses", "startupTimeoutMs", "commandTimeoutMs", "cleanupTimeoutMs"]));
  const limits = {
    maxMemoryBytes: config.maxMemoryBytes ?? 536870912,
    cpuRatePercent: config.cpuRatePercent ?? 50,
    maxProcesses: config.maxProcesses ?? 32,
    startupTimeoutMs: config.startupTimeoutMs ?? 10000,
    commandTimeoutMs: config.commandTimeoutMs ?? 5000,
    cleanupTimeoutMs: config.cleanupTimeoutMs ?? 5000
  };
  if (!Number.isSafeInteger(limits.maxMemoryBytes) || limits.maxMemoryBytes < 16 * 1024 * 1024 || limits.maxMemoryBytes > 1099511627776) throw new WindowsJobObjectResourceControllerError("INVALID_MEMORY_LIMIT", "maxMemoryBytes must be between 16 MiB and 1 TiB");
  if (!Number.isSafeInteger(limits.cpuRatePercent) || limits.cpuRatePercent < 1 || limits.cpuRatePercent > 100) throw new WindowsJobObjectResourceControllerError("INVALID_CPU_LIMIT", "cpuRatePercent must be an integer from 1 to 100");
  if (!Number.isSafeInteger(limits.maxProcesses) || limits.maxProcesses < 1 || limits.maxProcesses > 65535) throw new WindowsJobObjectResourceControllerError("INVALID_PROCESS_LIMIT", "maxProcesses must be an integer from 1 to 65535");
  for (const [name, minimum, maximum] of [["startupTimeoutMs", 500, 30000], ["commandTimeoutMs", 250, 30000], ["cleanupTimeoutMs", 100, 30000]]) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < minimum || limits[name] > maximum) throw new WindowsJobObjectResourceControllerError("INVALID_TIMEOUT", name + " is outside its supported range");
  }
  return Object.freeze(limits);
}

function resolvePowerShell() {
  if (process.platform !== "win32") throw new WindowsJobObjectResourceControllerError("UNSUPPORTED_PLATFORM", "Windows Job Object resource containment is available only on Windows");
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) throw new WindowsJobObjectResourceControllerError("POWERSHELL_UNAVAILABLE", "Windows SystemRoot is unavailable");
  const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const info = lstatSync(executable);
    if (info.isSymbolicLink() || !info.isFile()) throw new WindowsJobObjectResourceControllerError("POWERSHELL_UNAVAILABLE", "the built-in Windows PowerShell host is not a regular executable");
  } catch (error) {
    if (error instanceof WindowsJobObjectResourceControllerError) throw error;
    throw new WindowsJobObjectResourceControllerError("POWERSHELL_UNAVAILABLE", "the built-in Windows PowerShell host could not be resolved");
  }
  return executable;
}

function usageSnapshot(value, limits, attachedPid, state) {
  const cpu100ns = Number(value?.totalCpuTime100ns);
  const peak = Number(value?.peakJobMemoryBytes);
  return Object.freeze({
    state,
    attachedPid,
    processCount: Number.isSafeInteger(value?.activeProcesses) ? value.activeProcesses : 0,
    totalProcesses: Number.isSafeInteger(value?.totalProcesses) ? value.totalProcesses : 0,
    terminatedProcesses: Number.isSafeInteger(value?.terminatedProcesses) ? value.terminatedProcesses : 0,
    totalCpuTimeMicros: Number.isSafeInteger(cpu100ns) ? Math.floor(cpu100ns / 10) : 0,
    peakJobMemoryBytes: Number.isSafeInteger(peak) ? peak : 0,
    committedMemoryLimitBytes: limits.maxMemoryBytes,
    cpuRateLimitPercent: limits.cpuRatePercent,
    maxProcesses: limits.maxProcesses
  });
}

/**
 * Creates one native Windows Job Object per execution via inbox Windows
 * PowerShell and kernel32 APIs. Limits cover job committed memory, hard CPU
 * rate, active process count and process-tree termination. Breakaway is never
 * enabled; KILL_ON_JOB_CLOSE provides fail-safe cleanup if the helper exits.
 */
export function createWindowsJobObjectResourceController(options = {}) {
  const config = readRecord(options, "options", new Set(["limits"]));
  const limits = normalizeLimits(config.limits);
  const executable = resolvePowerShell();
  let closed = false;
  const scopes = new Map();

  function getStatus() {
    return Object.freeze({
      platform: "win32",
      mode: "windows-job-object",
      available: true,
      enforced: true,
      accepting: !closed,
      activeScopes: scopes.size,
      limits,
      controls: Object.freeze(["job-committed-memory", "cpu-rate-hard-cap", "active-process-count", "process-tree-termination", "kill-on-job-close"])
    });
  }

  function createScope(input) {
    if (closed) throw new WindowsJobObjectResourceControllerError("CONTROLLER_CLOSED", "resource controller is closed");
    const request = readRecord(input, "scope request", new Set(["engineId", "requestId"]));
    if (typeof request.engineId !== "string" || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(request.engineId) ||
        typeof request.requestId !== "string" || !/^[0-9a-f-]{36}$/iu.test(request.requestId)) {
      throw new WindowsJobObjectResourceControllerError("INVALID_SCOPE_REQUEST", "scope identity is invalid");
    }

    const scopeId = randomUUID();
    const script = POWERSHELL_SERVER
      .replaceAll("__MEMORY__", String(limits.maxMemoryBytes))
      .replaceAll("__PROCESSES__", String(limits.maxProcesses))
      .replaceAll("__CPU_RATE__", String(limits.cpuRatePercent * 100))
      .replaceAll("__CLEANUP_TIMEOUT__", String(limits.cleanupTimeoutMs));
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");
    let helper;
    try {
      helper = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: false
      });
    } catch {
      throw new WindowsJobObjectResourceControllerError("WINDOWS_JOB_HELPER_START_FAILED", "the native Job Object host could not be started");
    }

    let outputBuffer = "";
    let helperExited = false;
    let helperExitCode = null;
    let nextCommandId = 0;
    const pending = new Map();
    let commandChain = Promise.resolve();
    let attachedPid = null;
    let scopeClosed = false;
    let closing = false;
    let terminationPromise = null;
    let lastUsage = usageSnapshot(null, limits, null, "starting");
    let readyResolve;
    let readyReject;
    let readySettled = false;
    const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });

    const readyTimer = setTimeout(() => failReady(new WindowsJobObjectResourceControllerError("WINDOWS_JOB_START_TIMEOUT", "the native Job Object host did not become ready within the startup deadline")), limits.startupTimeoutMs);
    function failReady(error) {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(readyTimer);
      readyReject(error);
    }

    function parseOutputLine(line) {
      if (Buffer.byteLength(line, "utf8") > 16384) {
        failReady(new WindowsJobObjectResourceControllerError("WINDOWS_JOB_PROTOCOL_INVALID", "the native Job Object host emitted an oversized message"));
        try { helper.kill(); } catch {}
        return;
      }
      let message;
      try { message = JSON.parse(line); } catch {
        failReady(new WindowsJobObjectResourceControllerError("WINDOWS_JOB_PROTOCOL_INVALID", "the native Job Object host emitted invalid JSON"));
        try { helper.kill(); } catch {}
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      if (message.type === "ready") {
        if (readySettled) return;
        readySettled = true;
        clearTimeout(readyTimer);
        readyResolve(true);
        return;
      }
      if (message.type === "fatal") {
        failReady(new WindowsJobObjectResourceControllerError("WINDOWS_JOB_INITIALIZATION_FAILED", "Windows could not initialize the native Job Object resource scope"));
        return;
      }
      if (message.type === "usage") {
        lastUsage = usageSnapshot(message.data, limits, attachedPid, attachedPid === null ? "ready" : "active");
        return;
      }
      if (message.type !== "response" || !Number.isSafeInteger(message.id)) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(new WindowsJobObjectResourceControllerError("WINDOWS_JOB_OPERATION_FAILED", "a Windows Job Object operation was rejected"));
      } else {
        lastUsage = usageSnapshot(message.data, limits, attachedPid, "active");
        waiter.resolve(message.data ?? Object.freeze({}));
      }
    }

    helper.stdout.setEncoding("utf8");
    helper.stdout.on("data", (chunk) => {
      outputBuffer += chunk;
      if (Buffer.byteLength(outputBuffer, "utf8") > 32768) {
        failReady(new WindowsJobObjectResourceControllerError("WINDOWS_JOB_PROTOCOL_INVALID", "the native Job Object host exceeded its output buffer limit"));
        try { helper.kill(); } catch {}
        return;
      }
      while (true) {
        const newline = outputBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = outputBuffer.slice(0, newline).trim();
        outputBuffer = outputBuffer.slice(newline + 1);
        if (line) parseOutputLine(line);
      }
    });
    helper.on("error", () => {
      failReady(new WindowsJobObjectResourceControllerError("WINDOWS_JOB_HELPER_START_FAILED", "the native Job Object host could not be started"));
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new WindowsJobObjectResourceControllerError("WINDOWS_JOB_HELPER_EXITED", "the native Job Object host exited unexpectedly"));
      }
      pending.clear();
    });
    helper.on("exit", (code) => {
      helperExited = true;
      helperExitCode = code;
      if (!readySettled) failReady(new WindowsJobObjectResourceControllerError("WINDOWS_JOB_INITIALIZATION_FAILED", "the native Job Object host exited before creating a resource scope"));
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new WindowsJobObjectResourceControllerError("WINDOWS_JOB_HELPER_EXITED", "the native Job Object host exited unexpectedly"));
      }
      pending.clear();
    });
    readyPromise.catch(() => undefined);

    function command(type, payload = {}) {
      const operation = commandChain.then(async () => {
        await readyPromise;
        if (helperExited || helper.exitCode !== null || helper.signalCode !== null) throw new WindowsJobObjectResourceControllerError("WINDOWS_JOB_HELPER_EXITED", "the native Job Object host is no longer available");
        const id = ++nextCommandId;
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new WindowsJobObjectResourceControllerError("WINDOWS_JOB_COMMAND_TIMEOUT", "the native Job Object host did not complete an operation within its deadline"));
          }, limits.commandTimeoutMs);
          pending.set(id, { resolve, reject, timer });
          try {
            helper.stdin.write(JSON.stringify({ id, type, ...payload }) + "\n", "utf8", (error) => {
              if (!error) return;
              const waiter = pending.get(id);
              if (!waiter) return;
              pending.delete(id);
              clearTimeout(waiter.timer);
              waiter.reject(new WindowsJobObjectResourceControllerError("WINDOWS_JOB_COMMAND_FAILED", "a command could not be delivered to the native Job Object host"));
            });
          } catch {
            pending.delete(id);
            clearTimeout(timer);
            reject(new WindowsJobObjectResourceControllerError("WINDOWS_JOB_COMMAND_FAILED", "a command could not be delivered to the native Job Object host"));
          }
        });
      });
      commandChain = operation.catch(() => undefined);
      return operation;
    }

    async function waitForHelperExit() {
      if (helperExited) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try { helper.kill(); } catch {}
          reject(new WindowsJobObjectResourceControllerError("WINDOWS_JOB_CLEANUP_TIMEOUT", "the native Job Object host did not exit within the cleanup deadline"));
        }, limits.cleanupTimeoutMs + limits.commandTimeoutMs);
        helper.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }

    const scope = Object.freeze({
      async attachProcess(pid) {
        if (scopeClosed || closing || attachedPid !== null || !Number.isSafeInteger(pid) || pid < 1 || pid > 0xFFFFFFFF) {
          throw new WindowsJobObjectResourceControllerError("WINDOWS_JOB_ATTACH_INVALID", "process attachment is invalid or already completed");
        }
        await command("attach", { pid });
        attachedPid = pid;
        lastUsage = Object.freeze({ ...lastUsage, attachedPid, state: "active" });
        return Object.freeze({ attached: true, pid });
      },
      terminateAll() {
        if (scopeClosed || helperExited) return Promise.resolve(false);
        if (terminationPromise) return terminationPromise;
        terminationPromise = command("terminate").then(() => {
          lastUsage = Object.freeze({ ...lastUsage, state: "terminated", processCount: 0 });
          return true;
        });
        return terminationPromise;
      },
      getUsage() { return lastUsage; },
      async close() {
        if (scopeClosed) return Object.freeze({ closed: true });
        closing = true;
        try {
          if (!helperExited) {
            await command("close");
            await waitForHelperExit();
          } else if (helperExitCode !== 0 || attachedPid !== null) {
            throw new WindowsJobObjectResourceControllerError("WINDOWS_JOB_HELPER_EXITED", "the native Job Object host exited before cleanup was confirmed");
          }
          scopeClosed = true;
          scopes.delete(scopeId);
          lastUsage = usageSnapshot(null, limits, attachedPid, "closed");
          return Object.freeze({ closed: true });
        } catch (error) {
          try { if (!helperExited) helper.kill(); } catch {}
          throw error instanceof WindowsJobObjectResourceControllerError ? error
            : new WindowsJobObjectResourceControllerError("WINDOWS_JOB_CLEANUP_FAILED", "the Windows Job Object resource scope could not be cleaned up");
        }
      }
    });
    scopes.set(scopeId, scope);
    return scope;
  }

  async function close() {
    if (closed) return getStatus();
    const failures = [];
    for (const scope of [...scopes.values()]) {
      try { await scope.close(); } catch (error) { failures.push(error?.code ?? "WINDOWS_JOB_CLEANUP_FAILED"); }
    }
    if (failures.length) throw new WindowsJobObjectResourceControllerError("CONTROLLER_CLOSE_FAILED", "one or more Windows Job Object scopes could not be cleaned up: " + failures.join(","));
    closed = true;
    return getStatus();
  }
  return Object.freeze({ createScope, getStatus, close });
}
