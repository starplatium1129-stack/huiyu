param([string]$workspaceRoot, [string]$auditRoot)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$nsis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
$framework = Split-Path $compiler
function Put([string]$name, [string]$text) { [IO.File]::WriteAllText((Join-Path $auditRoot $name), $text, $utf8) }
function Run([string]$file, [string[]]$arguments, [int]$expected = 0) {
  $process = Start-Process -FilePath $file -ArgumentList ($arguments -join ' ') -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne $expected) { throw "Fixture exit $($process.ExitCode), expected ${expected}: $file" }
}
$install = Join-Path $auditRoot 'installed'
New-Item -ItemType Directory -Force -Path $install | Out-Null
foreach ($version in @('1.0.0','1.1.0')) {
  Put "host-$version.cs" "using System.Reflection; [assembly:AssemblyInformationalVersion(`"$version`")][assembly:AssemblyVersion(`"$version.0`")] class Host { static void Main() {} }"
  & $compiler /nologo /target:winexe /platform:x64 "/out:$auditRoot\host-$version.exe" "$auditRoot\host-$version.cs"
  if ($LASTEXITCODE -ne 0) { throw 'Fixture host compilation failed' }
}
$data = New-Object byte[] (2MB)
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $random.GetBytes($data) } finally { $random.Dispose() }
[IO.File]::WriteAllBytes((Join-Path $auditRoot 'portrait.bin'), $data)
[IO.File]::WriteAllBytes((Join-Path $auditRoot 'webview.bin'), $data[0..(1MB-1)])
$sha = [Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($sha.ComputeHash($data)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
$requirements = @{schemaVersion=1;version='1.1.0';assets=@(@{path='gateway/assets/characters/portrait.bin';bytes=$data.Length;sha256=$hash})}
Put 'requirements.json' ($requirements | ConvertTo-Json -Depth 5 -Compress)
Put 'bridge.cs' @'
using System;
using System.IO;
using System.Reflection;
using System.Diagnostics;
class FixtureVerifier {
  static int Main(string[] args) {
    try {
      Huiyu.Upgrade.Requirements manifest;
      using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("UpgradeRequirements.json")) manifest=Huiyu.Upgrade.UpgradeCheck.Read(stream);
      var version=FileVersionInfo.GetVersionInfo(Path.Combine(args[0],"ai-cg-studio-desktop.exe")).ProductVersion;
      string registered = args.Length > 1 && args[1] == "unregistered" ? null : args[0];
      bool webview = !(args.Length > 1 && args[1] == "no-webview");
      Huiyu.Upgrade.UpgradeCheck.Verify(args[0],registered,version,webview,manifest);
      return 0;
    } catch { return 1603; }
  }
}
'@
$policy = Join-Path $workspaceRoot 'desktop-tauri/src-tauri/installer/modern/UpgradeCheck.cs'
& $compiler /nologo /target:exe /platform:x64 /main:FixtureVerifier "/out:$auditRoot\verifier.exe" "/reference:$framework\System.Runtime.Serialization.dll" "/resource:$auditRoot\requirements.json,UpgradeRequirements.json" $policy "$auditRoot\bridge.cs"
if ($LASTEXITCODE -ne 0) { throw 'Fixture verifier compilation failed' }
$template = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
SetCompress off
!include LogicLib.nsh
!define MAINBINARYSRCPATH "@ROOT@\host-1.0.0.exe"
!define INSTALLWEBVIEW2MODE "offlineInstaller"
OutFile "@ROOT@\full.exe"
Name "Huiyu isolated upgrade fixture"
InstallDir "@INSTALL@"
Var UpdateMode
Var WixMode
Function .onInit
  Call PageLeaveReinstall
FunctionEnd
Function PageLeaveReinstall
  IfFileExists "$INSTDIR\ai-cg-studio-desktop.exe" 0 reinst_done
  FileOpen $0 "$INSTDIR\uninstaller-was-called" w
  FileClose $0
  Delete "$INSTDIR\gateway\assets\characters\portrait.bin"
  reinst_done:
FunctionEnd
Section EarlyChecks
SectionEnd
Section WebView2
!if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
  SetOutPath "$INSTDIR"
  File "/oname=webview.bin" "@ROOT@\webview.bin"
!endif
SectionEnd
Section Install
  SetOutPath "$INSTDIR"
  File "/oname=ai-cg-studio-desktop.exe" "${MAINBINARYSRCPATH}"
  CreateDirectory "$INSTDIR\gateway\assets\characters"
  File /a "/oname=gateway\assets\characters\portrait.bin" "@ROOT@\portrait.bin"
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd
Section Uninstall
  Delete "$INSTDIR\ai-cg-studio-desktop.exe"
  Delete "$INSTDIR\gateway\assets\characters\portrait.bin"
  Delete "$INSTDIR\webview.bin"
  Delete "$INSTDIR\uninstall.exe"
SectionEnd
'@
$template = $template.Replace('@ROOT@',$auditRoot).Replace('@INSTALL@',$install.Replace('$','$$'))
Put 'full.nsi' $template
& $nsis /INPUTCHARSET UTF8 /V2 "$auditRoot\full.nsi"
if ($LASTEXITCODE -ne 0) { throw 'Full fixture compilation failed' }
$config = @{source=(Join-Path $auditRoot 'full.nsi');assets=$requirements.assets;verifier=(Join-Path $auditRoot 'verifier.exe');host=(Join-Path $auditRoot 'host-1.1.0.exe');output=(Join-Path $auditRoot 'upgrade.exe');script=(Join-Path $auditRoot 'upgrade.nsi')}
Put 'transform.json' ($config | ConvertTo-Json -Depth 5)
$env:HUIYU_UPGRADE_FIXTURE_ROOT = $auditRoot
$env:HUIYU_UPGRADE_FIXTURE_CODE = Join-Path $workspaceRoot 'scripts/lib/desktop-upgrade-installer.js'
@'
const fs=require('fs'),path=require('path');const p=process.env.HUIYU_UPGRADE_FIXTURE_ROOT,c=JSON.parse(fs.readFileSync(path.join(p,'transform.json'),'utf8'));const m=require(process.env.HUIYU_UPGRADE_FIXTURE_CODE);fs.writeFileSync(c.script,m.upgradeScript(fs.readFileSync(c.source,'utf8'),c.assets,c.verifier,c.host,c.output));
'@ | node
if ($LASTEXITCODE -ne 0) { throw 'Upgrade transform failed' }
& $nsis /INPUTCHARSET UTF8 /V2 "$auditRoot\upgrade.nsi"
if ($LASTEXITCODE -ne 0) { throw 'Upgrade fixture compilation failed' }
Run "$auditRoot\upgrade.exe" @('/S') 1603
if (Test-Path "$install\ai-cg-studio-desktop.exe") { throw 'Upgrade wrote files on a fresh machine' }
Run "$auditRoot\full.exe" @('/S')
Run "$auditRoot\verifier.exe" @("`"$install`"",'no-webview') 1603
Run "$auditRoot\verifier.exe" @("`"$install`"",'unregistered') 1603
$asset = Join-Path $install 'gateway/assets/characters/portrait.bin'
$unchanged = [IO.File]::ReadAllBytes($asset)
$changed = [byte[]]$unchanged.Clone(); $changed[0] = $changed[0] -bxor 1
[IO.File]::WriteAllBytes($asset,$changed)
Run "$auditRoot\upgrade.exe" @('/S') 1603
if ((Get-Item "$install\ai-cg-studio-desktop.exe").VersionInfo.ProductVersion -ne '1.0.0') { throw 'Invalid assets did not fence the update' }
[IO.File]::WriteAllBytes($asset,$unchanged)
Run "$auditRoot\upgrade.exe" @('/S')
if ((Get-Item "$install\ai-cg-studio-desktop.exe").VersionInfo.ProductVersion -ne '1.1.0') { throw 'New executable was not installed' }
if (Test-Path "$install\uninstaller-was-called") { throw 'Upgrade invoked old uninstaller' }
if (-not [Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($asset),[byte[]]$unchanged)) { throw 'Retained asset changed' }
if ((Get-Item "$auditRoot\full.exe").Length - (Get-Item "$auditRoot\upgrade.exe").Length -lt 2800000) { throw 'Upgrade still embeds the large fixture resources' }
[IO.File]::WriteAllText((Join-Path $install 'personal-marker.txt'),'keep')
Run "$install\uninstall.exe" @('/S',"_?=$install")
if (Test-Path $asset) { throw 'Upgrade uninstaller leaked retained app resources' }
if (-not (Test-Path "$install\personal-marker.txt")) { throw 'Uninstaller deleted an unrelated file' }
Write-Output 'PASS: fresh-install refusal, damaged-asset refusal, in-place upgrade, omitted payloads and complete resource uninstall.'
