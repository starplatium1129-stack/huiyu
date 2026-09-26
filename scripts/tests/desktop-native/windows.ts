import { errorMessage as runtimeErrorMessage } from '../../lib/runtime-errors';
'use strict'

const fs: typeof import('node:fs') = require('node:fs')
const path: typeof import('node:path') = require('node:path')
const { spawnSync }: typeof import('node:child_process') = require('node:child_process')

function powershell(script: any, options: any = {}) {
  const utf8Script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n${script}`
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', utf8Script,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs || 60_000,
    env: options.env || process.env,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`PowerShell exit=${result.status}: ${String(result.stderr || result.stdout).trim()}`)
  }
  return String(result.stdout || '').trim()
}

function powershellJson(script: any, options: any = {}) {
  const output = powershell(script, options)
  if (!output) return null
  try {
    return JSON.parse(output)
  } catch (error) {
    throw new Error(`PowerShell returned invalid JSON: ${runtimeErrorMessage(error)}; output=${output.slice(0, 500)}`)
  }
}

const DISPLAY_API = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class D10DisplayApi {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MONITORINFOEX {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }
  public sealed class DisplayInfo {
    public string Device;
    public int X;
    public int Y;
    public int Width;
    public int Height;
    public int WorkX;
    public int WorkY;
    public int WorkWidth;
    public int WorkHeight;
    public uint DpiX;
    public uint DpiY;
    public bool Primary;
  }
  private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  public static DisplayInfo[] GetDisplays() {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    var output = new List<DisplayInfo>();
    MonitorEnumProc callback = delegate(IntPtr monitor, IntPtr hdc, ref RECT rect, IntPtr data) {
      var info = new MONITORINFOEX();
      info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      if (!GetMonitorInfo(monitor, ref info)) return true;
      uint dx = 96, dy = 96;
      try { GetDpiForMonitor(monitor, 0, out dx, out dy); } catch { }
      output.Add(new DisplayInfo {
        Device = info.szDevice,
        X = info.rcMonitor.Left,
        Y = info.rcMonitor.Top,
        Width = info.rcMonitor.Right - info.rcMonitor.Left,
        Height = info.rcMonitor.Bottom - info.rcMonitor.Top,
        WorkX = info.rcWork.Left,
        WorkY = info.rcWork.Top,
        WorkWidth = info.rcWork.Right - info.rcWork.Left,
        WorkHeight = info.rcWork.Bottom - info.rcWork.Top,
        DpiX = dx,
        DpiY = dy,
        Primary = (info.dwFlags & 1) != 0
      });
      return true;
    };
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
    return output.ToArray();
  }
}
`

const WINDOW_API = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class D10WindowApi {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public sealed class WindowInfo {
    public long Hwnd;
    public int Pid;
    public string Title;
    public string ClassName;
    public int X;
    public int Y;
    public int Width;
    public int Height;
    public bool Visible;
    public uint Dpi;
  }
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

  public static WindowInfo[] GetWindows(int processId) {
    var output = new List<WindowInfo>();
    EnumWindowsProc callback = delegate(IntPtr hwnd, IntPtr data) {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (processId > 0 && pid != processId) return true;
      RECT rect;
      if (!GetWindowRect(hwnd, out rect)) return true;
      var title = new StringBuilder(512);
      var className = new StringBuilder(256);
      GetWindowText(hwnd, title, title.Capacity);
      GetClassName(hwnd, className, className.Capacity);
      uint dpi = 96;
      try { dpi = GetDpiForWindow(hwnd); } catch { }
      output.Add(new WindowInfo {
        Hwnd = hwnd.ToInt64(), Pid = (int)pid, Title = title.ToString(), ClassName = className.ToString(),
        X = rect.Left, Y = rect.Top, Width = rect.Right - rect.Left, Height = rect.Bottom - rect.Top,
        Visible = IsWindowVisible(hwnd), Dpi = dpi
      });
      return true;
    };
    EnumWindows(callback, IntPtr.Zero);
    return output.ToArray();
  }
}
`

function collectEnvironment() {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${DISPLAY_API}
'@
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$os = Get-CimInstance Win32_OperatingSystem
$gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; driverVersion = $_.DriverVersion; driverDate = $_.DriverDate; adapterRam = $_.AdapterRAM }
})
$edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
if (-not (Test-Path -LiteralPath $edgePath)) { $edgePath = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' }
$edge = if (Test-Path -LiteralPath $edgePath) { (Get-Item -LiteralPath $edgePath).VersionInfo.ProductVersion } else { $null }
$webviewRoot = 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application'
$webview = $null
if (Test-Path -LiteralPath $webviewRoot) {
  $versions = @(Get-ChildItem -LiteralPath $webviewRoot -Directory | ForEach-Object {
    try { [version]$_.Name } catch { $null }
  } | Where-Object { $_ -ne $null } | Sort-Object -Descending)
  if ($versions.Count -gt 0) { $webview = $versions[0].ToString() }
}
$displays = @([D10DisplayApi]::GetDisplays() | ForEach-Object {
  [pscustomobject]@{
    device = $_.Device; x = $_.X; y = $_.Y; width = $_.Width; height = $_.Height;
    workX = $_.WorkX; workY = $_.WorkY; workWidth = $_.WorkWidth; workHeight = $_.WorkHeight;
    dpiX = $_.DpiX; dpiY = $_.DpiY; scalePercent = [math]::Round($_.DpiX / 96 * 100); primary = $_.Primary
  }
})
[pscustomobject]@{
  capturedAt = (Get-Date).ToUniversalTime().ToString('o')
  user = $identity.Name
  isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  windows = [pscustomobject]@{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; architecture = $os.OSArchitecture }
  gpu = $gpu
  edgeVersion = $edge
  edgePath = if (Test-Path -LiteralPath $edgePath) { $edgePath } else { $null }
  webView2Version = $webview
  displays = $displays
} | ConvertTo-Json -Depth 8 -Compress
`
  return powershellJson(script)
}

function windowsForProcess(pid: any) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WINDOW_API}
'@
[pscustomobject]@{ windows = @([D10WindowApi]::GetWindows(${Number(pid) || 0})) } | ConvertTo-Json -Depth 6 -Compress
`
  const value = powershellJson(script)
  return value?.windows || []
}

function findWindow(pid: any, matcher: any) {
  return windowsForProcess(pid).find((window: any) => matcher(window)) || null
}

function setWindowRect(hwnd: any, rect: any) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WINDOW_API}
'@
$ok = [D10WindowApi]::SetWindowPos([IntPtr]${Number(hwnd)}, [IntPtr]::Zero, ${Math.round(rect.x)}, ${Math.round(rect.y)}, ${Math.round(rect.width)}, ${Math.round(rect.height)}, 0x0014)
if (-not $ok) { throw 'SetWindowPos failed' }
[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
`
  return Number(powershell(script))
}

function sendClick(x: any, y: any) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WINDOW_API}
'@
[D10WindowApi]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
Start-Sleep -Milliseconds 40
[D10WindowApi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[D10WindowApi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`
  powershell(script)
}

function sendToggleVisibilityHotkey() {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WINDOW_API}
'@
[D10WindowApi]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[D10WindowApi]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)
[D10WindowApi]::keybd_event(0x20, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[D10WindowApi]::keybd_event(0x20, 0, 0x0002, [UIntPtr]::Zero)
[D10WindowApi]::keybd_event(0x10, 0, 0x0002, [UIntPtr]::Zero)
[D10WindowApi]::keybd_event(0x11, 0, 0x0002, [UIntPtr]::Zero)
[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
`
  return Number(powershell(script))
}

function captureDesktop(rect: any, filePath: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const escaped = filePath.replace(/'/g, "''")
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap(${Math.max(1, Math.round(rect.width))}, ${Math.max(1, Math.round(rect.height))})
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen(${Math.round(rect.x)}, ${Math.round(rect.y)}, 0, 0, $bitmap.Size)
  $bitmap.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
`
  powershell(script)
}

// Isolated native UI previews may be hidden. Paint briefly without activation,
// capture only the selected HWND, then restore its original visibility.
function captureWindow(hwnd: any, filePath: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const escaped = filePath.replace(/'/g, "''");
  return powershell(`
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class D10CaptureWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
}
'@
[D10CaptureWindow]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$target = [IntPtr]${Number(hwnd)}
$wasVisible = [D10CaptureWindow]::IsWindowVisible($target)
try {
  if (-not $wasVisible) { [D10CaptureWindow]::ShowWindow($target, 4) | Out-Null }
  Start-Sleep -Milliseconds 200
  $rect = New-Object D10CaptureWindow+RECT
  if (-not [D10CaptureWindow]::GetWindowRect($target, [ref]$rect)) { throw 'Window unavailable' }
  $bitmap = New-Object Drawing.Bitmap(($rect.R-$rect.L), ($rect.B-$rect.T))
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $dc = $graphics.GetHdc()
  try {
    if (-not [D10CaptureWindow]::PrintWindow($target, $dc, 2)) { throw 'PrintWindow failed' }
  } finally { $graphics.ReleaseHdc($dc) }
  try { $bitmap.Save('${escaped}', [Drawing.Imaging.ImageFormat]::Png) }
  finally { $graphics.Dispose(); $bitmap.Dispose() }
} finally {
  if (-not $wasVisible) { [D10CaptureWindow]::ShowWindow($target, 0) | Out-Null }
}
`);
}

function processesByExecutable(executable: any) {
  const escaped = path.resolve(executable).replace(/'/g, "''")
  const script = `
$target = [IO.Path]::GetFullPath('${escaped}')
$items = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $target, [StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object {
  [pscustomobject]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; executablePath = $_.ExecutablePath; commandLine = $_.CommandLine }
})
[pscustomobject]@{ processes = $items } | ConvertTo-Json -Depth 5 -Compress
`
  return powershellJson(script)?.processes || []
}

function processTree(rootPid: any) {
  // ParentProcessId outlives its parent. Compare creation times so PID reuse
  // cannot adopt an unrelated long-lived service into the measured/owned tree.
  const script = `
$all = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = $_.Name; executablePath = $_.ExecutablePath; createdAt = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { [long]0 } } })
$byId = @{}; foreach ($item in $all) { $byId[$item.pid] = $item }
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add(${Number(rootPid)})
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($item in $all) {
    if ($ids.Contains([int]$item.parentPid) -and $byId.ContainsKey($item.parentPid) -and $item.createdAt -ge $byId[$item.parentPid].createdAt -and -not $ids.Contains([int]$item.pid)) { [void]$ids.Add([int]$item.pid); $changed = $true }
  }
}
$items = @($all | Where-Object { $ids.Contains([int]$_.pid) })
[pscustomobject]@{ processes = $items } | ConvertTo-Json -Depth 5 -Compress
`
  return powershellJson(script)?.processes || []
}

function sampleProcess(pid: any) {
  const script = `
$ErrorActionPreference = 'Stop'
$targetPid = ${Number(pid)}
$p = Get-Process -Id $targetPid
$dedicated = $null
$shared = $null
$scope = 'unavailable'
try {
  $samples = @(Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction Stop).CounterSamples | Where-Object { $_.InstanceName -like "pid_${Number(pid)}_*" }
  if ($samples.Count -gt 0) { $dedicated = [int64](($samples | Measure-Object -Property CookedValue -Sum).Sum); $scope = 'process' }
} catch {}
try {
  $samples = @(Get-Counter '\\GPU Process Memory(*)\\Shared Usage' -ErrorAction Stop).CounterSamples | Where-Object { $_.InstanceName -like "pid_${Number(pid)}_*" }
  if ($samples.Count -gt 0) { $shared = [int64](($samples | Measure-Object -Property CookedValue -Sum).Sum); $scope = 'process' }
} catch {}
[pscustomobject]@{
  pid = $targetPid; workingSetBytes = [int64]$p.WorkingSet64; privateBytes = [int64]$p.PrivateMemorySize64;
  gpuDedicatedBytes = $dedicated; gpuSharedBytes = $shared; gpuScope = $scope
} | ConvertTo-Json -Compress
`
  return powershellJson(script)
}

function sampleProcessTree(rootPid: any) {
  const script = `
$ErrorActionPreference = 'Stop'
$rootPid = ${Number(rootPid)}
$collectorPid = $PID
$all = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = $_.Name; createdAt = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { [long]0 } }
})
$byId = @{}; foreach ($item in $all) { $byId[$item.pid] = $item }
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add($rootPid)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($item in $all) {
    if ($ids.Contains($item.parentPid) -and $byId.ContainsKey($item.parentPid) -and $item.createdAt -ge $byId[$item.parentPid].createdAt -and -not $ids.Contains($item.pid)) {
      [void]$ids.Add($item.pid)
      $changed = $true
    }
  }
}
$excluded = New-Object System.Collections.Generic.HashSet[int]
[void]$excluded.Add($collectorPid)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($item in $all) {
    if ($excluded.Contains($item.parentPid) -and -not $excluded.Contains($item.pid)) {
      [void]$excluded.Add($item.pid)
      $changed = $true
    }
  }
}
foreach ($excludedPid in $excluded) { [void]$ids.Remove($excludedPid) }
$processes = @($all | Where-Object { $ids.Contains($_.pid) })
$workingSet = [int64]0
$privateBytes = [int64]0
foreach ($item in $processes) {
  $process = Get-Process -Id $item.pid -ErrorAction SilentlyContinue
  if ($process) {
    $workingSet += [int64]$process.WorkingSet64
    $privateBytes += [int64]$process.PrivateMemorySize64
  }
}
$dedicated = [int64]0
$shared = [int64]0
$dedicatedAvailable = $false
$sharedAvailable = $false
try {
  foreach ($sample in @(Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction Stop).CounterSamples) {
    if ($sample.InstanceName -match '^pid_(\\d+)_') {
      $samplePid = [int]$Matches[1]
      if ($ids.Contains($samplePid)) {
        $dedicated += [int64]$sample.CookedValue
        $dedicatedAvailable = $true
      }
    }
  }
} catch {}
try {
  foreach ($sample in @(Get-Counter '\\GPU Process Memory(*)\\Shared Usage' -ErrorAction Stop).CounterSamples) {
    if ($sample.InstanceName -match '^pid_(\\d+)_') {
      $samplePid = [int]$Matches[1]
      if ($ids.Contains($samplePid)) {
        $shared += [int64]$sample.CookedValue
        $sharedAvailable = $true
      }
    }
  }
} catch {}
[pscustomobject]@{
  rootPid = $rootPid
  processCount = $processes.Count
  processes = $processes
  workingSetBytes = $workingSet
  privateBytes = $privateBytes
  gpuDedicatedBytes = if ($dedicatedAvailable) { $dedicated } else { $null }
  gpuSharedBytes = if ($sharedAvailable) { $shared } else { $null }
  gpuScope = if ($dedicatedAvailable -or $sharedAvailable) { 'process-tree' } else { 'unavailable' }
} | ConvertTo-Json -Depth 5 -Compress
`
  return powershellJson(script)
}

function findUninstallEntry() {
  const script = `
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$items = @()
foreach ($registryPath in $paths) {
  $items += @(Get-ItemProperty -Path $registryPath -ErrorAction SilentlyContinue | Where-Object {
    $_.DisplayName -eq 'AI-CG-Studio' -or $_.DisplayName -like 'AI-CG-Studio*'
  } | ForEach-Object {
    [pscustomobject]@{
      displayName = $_.DisplayName; displayVersion = $_.DisplayVersion; installLocation = $_.InstallLocation;
      uninstallString = $_.UninstallString; quietUninstallString = $_.QuietUninstallString; registryPath = $_.PSPath
    }
  })
}
[pscustomobject]@{ entries = $items } | ConvertTo-Json -Depth 5 -Compress
`
  return powershellJson(script)?.entries || []
}

function portOwner(port: any) {
  const script = `
$items = @(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ pid = $_.OwningProcess; address = $_.LocalAddress; port = $_.LocalPort }
})
[pscustomobject]@{ listeners = $items } | ConvertTo-Json -Depth 4 -Compress
`
  return powershellJson(script)?.listeners || []
}

function terminateOwnedPids(pids: any) {
  const unique = [...new Set(pids.map(Number).filter((pid: any) => Number.isInteger(pid) && pid > 0))]
  if (!unique.length) return
  const list = unique.join(',')
  powershell(`$ids = @(${list}); foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }`)
}

export = {
  captureDesktop,
  captureWindow,
  collectEnvironment,
  findUninstallEntry,
  findWindow,
  portOwner,
  powershell,
  processesByExecutable,
  processTree,
  sampleProcess,
  sampleProcessTree,
  sendClick,
  sendToggleVisibilityHotkey,
  setWindowRect,
  terminateOwnedPids,
  windowsForProcess,
}
