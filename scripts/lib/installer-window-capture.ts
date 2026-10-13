import { errorMessage as runtimeErrorMessage } from './runtime-errors';

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


function terminateOwnedPids(pids: any) {
  const unique = [...new Set(pids.map(Number).filter((pid: any) => Number.isInteger(pid) && pid > 0))]
  if (!unique.length) return
  const list = unique.join(',')
  powershell(`$ids = @(${list}); foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }`)
}
export = {powershell, windowsForProcess, captureWindow, terminateOwnedPids};
