param([Parameter(Mandatory=$true)][string]$workspaceRoot, [Parameter(Mandatory=$true)][string]$auditRoot)
$ErrorActionPreference = 'Stop'
$auditRoot = [IO.Path]::GetFullPath($auditRoot)
if ((Split-Path $auditRoot) -ne [IO.Path]::GetTempPath().TrimEnd('\') -or (Split-Path $auditRoot -Leaf) -notlike 'aics-installer-policy-*') { throw 'Fixture must use a dedicated OS temporary child directory' }
if (!(Test-Path -LiteralPath $auditRoot -PathType Container)) { throw 'Fixture directory must exist' }
$nsis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$policy = [IO.File]::ReadAllText((Join-Path $workspaceRoot 'desktop-tauri\src-tauri\installer\game-install-policy.nsh'))
$policy = $policy.Replace('$SMPROGRAMS', '$FixtureMenu').Replace('$DESKTOP', '$FixtureDesktop')
[IO.File]::WriteAllText((Join-Path $auditRoot 'policy.nsh'), $policy, $utf8)
$utils = [IO.File]::ReadAllText((Join-Path $workspaceRoot 'desktop-tauri\src-tauri\target\release\nsis\x64\utils.nsh'))
$begin = $utils.IndexOf('!macro IsShortcutTarget ')
$end = $utils.IndexOf('!macroend', $begin) + 9
[IO.File]::WriteAllText((Join-Path $auditRoot 'shortcut.nsh'), $utils.Substring($begin, $end - $begin), $utf8)
$script = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
!include LogicLib.nsh
!include FileFunc.nsh
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "Win\RestartManager.nsh"
!define ERROR_MORE_DATA 234
!define MAINBINARYNAME "fixture-host"
!define STARTMENUFOLDER ""
!define MANUPRODUCTKEY "Software\HuiyuIsolatedInstallerFixture"
Var FixtureMenu
Var FixtureDesktop
Var AppStartMenuFolder
Var NoShortcutMode
Var UpdateMode
Var WixMode
Var TestMode
!macro MUI_STARTMENU_GETFOLDER id result
  StrCpy ${result} ""
!macroend
!include shortcut.nsh
!include policy.nsh
Name "Isolated installer policy fixture"
OutFile "policy-test.exe"
InstallDir "@ROOT@"
Function .onInit
  StrCpy $FixtureMenu "$INSTDIR\menu"
  StrCpy $FixtureDesktop "$INSTDIR\desktop"
  StrCpy $AppStartMenuFolder ""
  ${GetParameters} $0
  ${GetOptions} $0 "/MODE=" $TestMode
  ClearErrors
  ${GetOptions} $0 "/NS" $1
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd
Function un.onInit
  StrCpy $FixtureMenu "$INSTDIR\menu"
  StrCpy $FixtureDesktop "$INSTDIR\desktop"
  StrCpy $AppStartMenuFolder ""
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd
Section
  ${If} $TestMode == "check"
    Call GameCheckStopped
  ${ElseIf} $TestMode == "create"
    Call GameCreateResourceShortcut
  ${ElseIf} $TestMode == "uninstaller"
    WriteUninstaller "$INSTDIR\uninstall-test.exe"
  ${EndIf}
  FileOpen $0 "$INSTDIR\passed.txt" w
  FileWrite $0 "passed"
  FileClose $0
SectionEnd
Section Uninstall
  Call un.GameCheckStopped
  ${If} $UpdateMode <> 1
    Call un.GameRemoveResourceShortcut
  ${EndIf}
SectionEnd
'@
[IO.File]::WriteAllText((Join-Path $auditRoot 'fixture.nsi'), $script.Replace('@ROOT@', $auditRoot), $utf8)
$compileOutput = & $nsis '/INPUTCHARSET' 'UTF8' '/V3' (Join-Path $auditRoot 'fixture.nsi') 2>&1
$compileOutput | Out-File (Join-Path $auditRoot 'compile.log') -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw ($compileOutput -join "`n") }
$source = 'using System; using System.Threading; public static class Sleeper { public static void Main() { Thread.Sleep(120000); } }'
[IO.File]::WriteAllText((Join-Path $auditRoot 'Sleeper.cs'), $source, $utf8)
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler '/nologo' '/target:winexe' ('/out:' + (Join-Path $auditRoot 'fixture-host.exe')) (Join-Path $auditRoot 'Sleeper.cs')
if ($LASTEXITCODE -ne 0) { throw 'Sleeper compile failed' }
New-Item -ItemType Directory -Path (Join-Path $auditRoot 'gateway\tools'), (Join-Path $auditRoot 'menu'), (Join-Path $auditRoot 'desktop') | Out-Null
Copy-Item -LiteralPath (Join-Path $auditRoot 'fixture-host.exe') -Destination (Join-Path $auditRoot 'gateway\huiyu-runtime.exe')
[IO.File]::WriteAllText((Join-Path $auditRoot 'gateway\tools\Install-OfflineResources.cmd'), '@exit /b 0', $utf8)
$results = New-Object System.Collections.Generic.List[object]
function Get-FixtureHash([string]$file) {
  $stream = [IO.File]::OpenRead($file)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
  finally { $sha.Dispose(); $stream.Dispose() }
}
function Invoke-Fixture([string]$arguments, [int]$expected = 0, [string]$exe = 'policy-test.exe') {
  $process = Start-Process -FilePath (Join-Path $auditRoot $exe) -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
  if ($process.ExitCode -ne $expected) { throw "Fixture $arguments returned $($process.ExitCode), expected $expected" }
  $results.Add(@{arguments=$arguments; exitCode=$process.ExitCode; executable=$exe})
}
$freshPath = Join-Path $auditRoot '新安装 Empty'
New-Item -ItemType Directory -Path $freshPath | Out-Null
Invoke-Fixture ('/S /MODE=check /D=' + $freshPath)
foreach ($relative in @('fixture-host.exe', 'gateway\huiyu-runtime.exe')) {
  $sleeper = Start-Process -FilePath (Join-Path $auditRoot $relative) -WindowStyle Hidden -PassThru
  try {
    Start-Sleep -Milliseconds 150
    Invoke-Fixture '/S /MODE=check' 1618
    $sleeper.Refresh()
    if ($sleeper.HasExited) { throw "Guard killed owned fixture process $relative" }
    $results.Add(@{scenario='running process retained'; executable=$relative; pid=$sleeper.Id})
  } finally {
    $sleeper.Refresh()
    if (!$sleeper.HasExited) { Stop-Process -Id $sleeper.Id; $sleeper.WaitForExit() }
    $sleeper.Dispose()
  }
  Invoke-Fixture '/S /MODE=check'
}
$shell = New-Object -ComObject WScript.Shell
$mainLink = Join-Path $auditRoot 'menu\绘遇 HUIYU.lnk'
$helperLink = Join-Path $auditRoot 'menu\绘遇 · 资源安装助手.lnk'
$cmdPath = Join-Path $auditRoot 'gateway\tools\Install-OfflineResources.cmd'
Invoke-Fixture '/S /MODE=create /UPDATE'
if (Test-Path -LiteralPath $helperLink) { throw 'Update with no app shortcut must not add helper' }
$link = $shell.CreateShortcut($mainLink); $link.TargetPath = Join-Path $auditRoot 'fixture-host.exe'; $link.Save()
Invoke-Fixture '/S /MODE=create /NS'
if (Test-Path -LiteralPath $helperLink) { throw '/NS must suppress helper' }
Invoke-Fixture '/S /MODE=create /UPDATE'
$link = $shell.CreateShortcut($helperLink)
if ($link.TargetPath -ne $cmdPath -or $link.WorkingDirectory -ne (Split-Path $cmdPath)) { throw 'Helper target or working directory mismatch' }
$before = Get-FixtureHash $helperLink
Invoke-Fixture '/S /MODE=create /UPDATE'
if ((Get-FixtureHash $helperLink) -ne $before) { throw 'Existing helper changed' }
$link.Description = 'personal shortcut modification'; $link.Save()
$before = Get-FixtureHash $helperLink
Invoke-Fixture '/S /MODE=create'
if ((Get-FixtureHash $helperLink) -ne $before) { throw 'Modified helper changed' }
Invoke-Fixture '/S /MODE=uninstaller'
$sleeper = Start-Process -FilePath (Join-Path $auditRoot 'fixture-host.exe') -WindowStyle Hidden -PassThru
try {
  Start-Sleep -Milliseconds 150
  Invoke-Fixture ('/S _?=' + $auditRoot) 1618 'uninstall-test.exe'
  $sleeper.Refresh()
  if ($sleeper.HasExited -or !(Test-Path -LiteralPath $helperLink)) { throw 'Busy uninstall changed the process or helper' }
} finally {
  $sleeper.Refresh()
  if (!$sleeper.HasExited) { Stop-Process -Id $sleeper.Id; $sleeper.WaitForExit() }
  $sleeper.Dispose()
}
Invoke-Fixture ('/S /UPDATE _?=' + $auditRoot) 0 'uninstall-test.exe'
if (!(Test-Path -LiteralPath $helperLink)) { throw 'Update removed helper' }
Invoke-Fixture ('/S _?=' + $auditRoot) 0 'uninstall-test.exe'
if (Test-Path -LiteralPath $helperLink) { throw 'Uninstall failed to remove owned helper' }
$link = $shell.CreateShortcut($helperLink); $link.TargetPath = Join-Path $auditRoot 'fixture-host.exe'; $link.Save()
$before = Get-FixtureHash $helperLink
Invoke-Fixture '/S /MODE=create'
if ((Get-FixtureHash $helperLink) -ne $before) { throw 'Name collision overwritten' }
Invoke-Fixture ('/S _?=' + $auditRoot) 0 'uninstall-test.exe'
if ((Get-FixtureHash $helperLink) -ne $before) { throw 'Unrelated helper shortcut removed' }
$report = @{auditRoot=$auditRoot; scope='isolated fixtures only; no production installation or registry writes'; scenarios=$results; result='PASS'}
$report | ConvertTo-Json -Depth 5 | Out-File (Join-Path $auditRoot 'result.json') -Encoding utf8
Write-Output 'NSIS policy fixture PASS: active processes preserved; retry, owned shortcut creation and removal verified.'
