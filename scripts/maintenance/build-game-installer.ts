'use strict';

// Pinned Tauri template + small presentation patch; never fork payload/upgrade logic.
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const crypto: typeof import('node:crypto') = require('node:crypto');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const sharp: typeof import('sharp') = require('sharp');
const ROOT = path.resolve(__dirname, '../..');
const INSTALLER = path.join(ROOT, 'desktop-tauri/src-tauri/installer');
const TEMPLATE_HASH = '20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079';

function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw new Error(`Installer template anchor drift: ${from.slice(0, 65)}`);
  return source.replace(from, to);
}

function customizeTemplate(source, background, uiFile) {
  const escapePath = value => value.replace(/\$/g, '$$$$');
  let output = replaceOnce(source, '; Installer pages, must be ordered as they appear',
    `!define GAME_BACKGROUND "${escapePath(background)}"\n!define GAME_ASSET_DIR "${escapePath(path.dirname(background))}"\n!include "${escapePath(uiFile)}"\n\n; Installer pages, must be ordered as they appear`);
  output = replaceOnce(output, 'Name "${PRODUCTNAME}"', 'Name "${PRODUCTNAME}"\nCaption "绘遇 · 安装旅程"');
  // Display branding is separate from PRODUCTNAME: that name is the legacy
  // uninstall registry key and installation directory used by update discovery.
  output = replaceOnce(output, 'WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"', 'WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "绘遇 · HUIYU"');
  output = replaceOnce(output, 'VIAddVersionKey "ProductName" "${PRODUCTNAME}"', 'VIAddVersionKey "ProductName" "绘遇 · HUIYU"');
  output = replaceOnce(output, 'VIAddVersionKey "FileDescription" "${PRODUCTNAME}"', 'VIAddVersionKey "FileDescription" "绘遇安装器"');
  output = output.replaceAll('${PRODUCTNAME}.lnk', '绘遇 HUIYU.lnk');
  output = output.replace(/(CreateShortcut "[^"\n]+" "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe")/g, '$1 "" "$INSTDIR\\huiyu-icon.ico" 0');
  output = replaceOnce(output, 'Function .onInstSuccess', 'Function .onInstSuccess\n  System::Call \'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)\'');
  // Rename only an existing shortcut targeting this installation. Preserve the
  // user's no-shortcut choice and never overwrite an unrelated named shortcut.
  const migrateShortcut = location => `
  !insertmacro IsShortcutTarget "${location}\\\${PRODUCTNAME}.lnk" "$INSTDIR\\\${MAINBINARYNAME}.exe"
  Pop $0
  \${If} $0 = 1
    \${IfNot} \${FileExists} "${location}\\绘遇 HUIYU.lnk"
      Rename "${location}\\\${PRODUCTNAME}.lnk" "${location}\\绘遇 HUIYU.lnk"
    \${EndIf}
  \${EndIf}
`;
  output = replaceOnce(output, 'Function CreateOrUpdateDesktopShortcut', 'Function CreateOrUpdateDesktopShortcut' + migrateShortcut('$DESKTOP'));
  output = replaceOnce(output, 'Function CreateOrUpdateStartMenuShortcut', 'Function CreateOrUpdateStartMenuShortcut' + migrateShortcut('$SMPROGRAMS') + migrateShortcut('$SMPROGRAMS\\$AppStartMenuFolder'));
  output = replaceOnce(output, '!define INSTALLERICON "{{installer_icon}}"', `!define INSTALLERICON "${escapePath(path.resolve(path.dirname(uiFile), '../icons/icon.ico'))}"`);
  output = replaceOnce(output, '!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive\n!insertmacro MUI_PAGE_WELCOME', 'Page custom GameWelcome');
  output = replaceOnce(output, '!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive\n!insertmacro MUI_PAGE_DIRECTORY', 'Page custom GameDirectory GameDirectoryLeave');
  output = replaceOnce(output, '!insertmacro MUI_PAGE_INSTFILES', '!define MUI_PAGE_CUSTOMFUNCTION_SHOW GameInstallShow\n!insertmacro MUI_PAGE_INSTFILES');
  const finishStart = output.indexOf('; 8. Finish page');
  const finishEnd = output.indexOf('Function RunMainBinary', finishStart);
  if (finishStart < 0 || finishEnd < 0) throw new Error('Installer finish-page anchor drift');
  output = output.slice(0, finishStart) + '; 8. Game-style finish page\nPage custom GameFinish GameFinishLeave\n\n' + output.slice(finishEnd);
  output = replaceOnce(output, '    nsDialogs::Create 1018\n    Pop $R4',
    '    Call GameCreatePage\n    StrCpy $R4 $GamePage\n    !insertmacro GameLabel 56% 22% 40% 13% "继续你的旅程" $GameTitleFont "F6F0FA"');
  output = replaceOnce(output, '${NSD_CreateLabel} 0 0 100% 24u $R1\n    Pop $R1',
    '${NSD_CreateLabel} 56% 40% 38% 18% $R1\n    Pop $R1\n    SetCtlColors $R1 "CED0DF" "14192D"\n    SendMessage $R1 ${WM_SETFONT} $GameFont 1');
  output = replaceOnce(output, '${NSD_CreateRadioButton} 30u 50u -30u 8u $R2\n    Pop $R2',
    '${NSD_CreateRadioButton} 56% 62% 38% 8% $R2\n    Pop $R2\n    System::Call \'uxtheme::SetWindowTheme(p $R2,w "",w "")\'\n    SendMessage $R2 ${WM_SETFONT} $GameSmallFont 1\n    SetCtlColors $R2 "F6F0FA" "14192D"');
  output = replaceOnce(output, '${NSD_CreateRadioButton} 30u 70u -30u 8u $R3\n    Pop $R3',
    '${NSD_CreateRadioButton} 56% 73% 38% 8% $R3\n    Pop $R3\n    System::Call \'uxtheme::SetWindowTheme(p $R3,w "",w "")\'\n    SendMessage $R3 ${WM_SETFONT} $GameSmallFont 1\n    SetCtlColors $R3 "F6F0FA" "14192D"');
  output = replaceOnce(output, '    nsDialogs::Show', '    Call GameShowPage');
  return output;
}

async function bitmap(source, destination, width = 1920, height = 1200) {
  const { data } = await sharp(source).resize(width, height).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const stride = Math.ceil(width * 3 / 4) * 4;
  const bmp = Buffer.alloc(54 + stride * height);
  bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(width, 18); bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const input = (y * width + x) * 3; const target = 54 + (height - y - 1) * stride + x * 3;
    bmp[target] = data[input + 2]; bmp[target + 1] = data[input + 1]; bmp[target + 2] = data[input];
  }
  fs.writeFileSync(destination, bmp);
}

async function buildGameInstaller({ preview = false, capture = false, page = 'welcome' } = {}) {
  const vendor = fs.readFileSync(path.join(INSTALLER, 'vendor/tauri-2.11.4.nsi'));
  if (crypto.createHash('sha256').update(vendor).digest('hex') !== TEMPLATE_HASH) throw new Error('Pinned Tauri installer template hash mismatch');
  const generated = path.join(INSTALLER, 'generated');
  fs.mkdirSync(generated, { recursive: true });
  const background = path.join(generated, 'atelier-background.bmp');
  await bitmap(path.join(INSTALLER, 'atelier-keyart.png'), background);
  const leftArt = await sharp(path.join(INSTALLER, 'atelier-keyart.png')).resize(1920, 1200).extract({ left: 0, top: 0, width: 998, height: 1200 }).png().toBuffer();
  await bitmap(leftArt, path.join(generated, 'atelier-left.bmp'), 998, 1200);
  for (const [name, label] of Object.entries({ welcome: '开始旅程  →', install: '安装绘遇  →', continue: '继续  →', finish: '进入绘遇  →', cancel: '暂别', back: '返回' })) {
    const secondary = name === 'cancel' || name === 'back';
    const width = secondary ? 280 : 440;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="72"><rect width="${width}" height="72" fill="${secondary ? '#252b43' : '#e7bcd2'}"/><text x="${width / 2}" y="47" text-anchor="middle" font-family="Microsoft YaHei UI" font-size="32" font-weight="600" fill="${secondary ? '#f6f0fa' : '#14192d'}">${label}</text></svg>`;
    await bitmap(Buffer.from(svg), path.join(generated, `button-${name}.bmp`), width, 72);
  }
  const uiFile = path.join(INSTALLER, 'game-ui.nsh');
  fs.writeFileSync(path.join(generated, 'installer.nsi'), customizeTemplate(vendor.toString('utf8'), background, uiFile));
  if (preview) {
    if (!['welcome', 'directory', 'finish', 'install', 'maintenance'].includes(page)) throw new Error('Unknown preview page');
    const compiler = path.join(process.env.LOCALAPPDATA, 'tauri/NSIS/makensis.exe');
    const result = spawnSync(compiler, ['/INPUTCHARSET', 'UTF8', '/V2', `/DGAME_BACKGROUND=${background}`, `/DGAME_ASSET_DIR=${generated}`, `/DGAME_UI=${uiFile}`, `/DGAME_PREVIEW_PAGE=${page}`, path.join(INSTALLER, 'preview.nsi')], {
      cwd: generated, stdio: 'inherit', windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error(`NSIS preview compile failed: ${result.error?.message || result.status}`);
    console.log(`Preview: ${path.join(generated, `atelier-preview-${page}.exe`)}`);
    if (capture) {
      const windows: typeof import('../tests/desktop-native/windows') = require('../tests/desktop-native/windows');
      const exe = path.join(generated, `atelier-preview-${page}.exe`).replace(/'/g, "''");
      const pid = Number(windows.powershell(`(Start-Process -FilePath '${exe}' -WindowStyle Hidden -PassThru).Id`));
      try {
        let window;
        for (let attempt = 0; attempt < 10 && !window; attempt++) {
          window = windows.windowsForProcess(pid).find(item => item.ClassName === '#32770');
          if (!window) await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!window) throw new Error('Installer preview window did not appear');
        windows.captureWindow(window.Hwnd, path.join(ROOT, 'runtime', `installer-${page}-preview.png`));
      } finally { windows.terminateOwnedPids([pid]); }
    }
  }
  console.log('[installer] game pages and bitmap ready (Tauri 2.11.4 pinned)');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('Build native game-style installer UI. Options: --preview [--capture] [--page=welcome|directory|install|finish|maintenance]');
  else buildGameInstaller({ preview: args.includes('--preview'), capture: args.includes('--capture'), page: args.find(arg => arg.startsWith('--page='))?.slice(7) || 'welcome' }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
export = { buildGameInstaller, customizeTemplate };
