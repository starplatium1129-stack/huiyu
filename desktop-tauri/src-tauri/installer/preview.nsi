Unicode true
ManifestDPIAware true
RequestExecutionLevel user
!include MUI2.nsh
!include FileFunc.nsh
!define PRODUCTNAME "AI-CG-Studio"
!define VERSION "PREVIEW"
!define ESTIMATEDSIZE "520000"
!define BUNDLEID "com.aics.studio"
!if "${GAME_PREVIEW_PAGE}" == "uninstall"
!define GAME_PREVIEW_UNINSTALL
!else if "${GAME_PREVIEW_PAGE}" == "uninstall-progress"
!define GAME_PREVIEW_UNINSTALL
!else if "${GAME_PREVIEW_PAGE}" == "uninstall-finish"
!define GAME_PREVIEW_UNINSTALL
!endif
!include "${GAME_UI}"
!insertmacro GameUninstallPages ""
Name "绘遇 · 安装界面预览（不安装）"
!ifdef GAME_PREVIEW_UNINSTALL
Caption "绘遇 HUIYU · 卸载界面预览（不会卸载）"
!else
Caption "绘遇 · 安装界面预览"
!endif
Icon "..\icons\icon.ico"
OutFile "generated\atelier-preview-${GAME_PREVIEW_PAGE}.exe"
InstallDir "$LOCALAPPDATA\AI-CG-Studio-Preview"
!if "${GAME_PREVIEW_PAGE}" == "welcome"
Page custom GameWelcome
Page custom GameDirectory GameDirectoryLeave
!else if "${GAME_PREVIEW_PAGE}" == "directory"
Page custom GameDirectory GameDirectoryLeave
!else if "${GAME_PREVIEW_PAGE}" == "finish"
Page custom GameFinish GameFinishLeave
!else if "${GAME_PREVIEW_PAGE}" == "maintenance"
Page custom GameMaintenancePreview
!else if "${GAME_PREVIEW_PAGE}" == "uninstall"
Page custom GameUninstallConfirm GameUninstallConfirmLeave
!else if "${GAME_PREVIEW_PAGE}" == "uninstall-finish"
Page custom GameUninstallFinish
!endif
!define MUI_PAGE_CUSTOMFUNCTION_SHOW GameInstallShow
!insertmacro MUI_PAGE_INSTFILES
!if "${GAME_PREVIEW_PAGE}" == "uninstall"
Page custom GameUninstallFinish
!else if "${GAME_PREVIEW_PAGE}" == "uninstall-progress"
Page custom GameUninstallFinish
!else
Page custom GameFinish GameFinishLeave
!endif
!insertmacro MUI_LANGUAGE "SimpChinese"
Function SkipIfPassive
FunctionEnd
Function un.SkipIfPassive
FunctionEnd
Function .onInit
  !if "${GAME_PREVIEW_PAGE}" == "uninstall-progress"
    StrCpy $GameMode "卸载"
  !endif
FunctionEnd
Function RunMainBinary
  ; Preview intentionally never starts or installs the application.
FunctionEnd
Function CreateOrUpdateDesktopShortcut
  ; Preview intentionally never writes a shortcut.
FunctionEnd
Function GameMaintenancePreview
  Call GameCreatePage
  !insertmacro GameLabel 49% 28% 46% 13% "管理现有安装" $GameTitleFont Ink
  !insertmacro GameLabel 49% 46% 46% 12% "检测到已安装的绘遇，请选择如何继续。" $GameFont Muted
  ${NSD_CreateRadioButton} 49% 64% 46% 8% "重新安装当前版本"
  Pop $R2
  System::Call 'uxtheme::SetWindowTheme(p $R2,w "",w "")'
  SendMessage $R2 ${WM_SETFONT} $GameSmallFont 1
  !insertmacro GameColors $R2 Ink Surface
  ${NSD_CreateRadioButton} 49% 75% 46% 8% "卸载应用"
  Pop $R3
  System::Call 'uxtheme::SetWindowTheme(p $R3,w "",w "")'
  SendMessage $R3 ${WM_SETFONT} $GameSmallFont 1
  !insertmacro GameColors $R3 Ink Surface
  ${NSD_Check} $R2
  Call GameShowPage
FunctionEnd
Section
  DetailPrint "界面预览：不会安装、卸载、删除数据或启动应用。"
  Sleep 8000
SectionEnd
