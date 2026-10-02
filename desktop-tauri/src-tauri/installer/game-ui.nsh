; Presentation only: Tauri owns installation, upgrade and file removal.
!include "${__FILEDIR__}\game-frame.nsh"
!define MUI_CUSTOMFUNCTION_GUIINIT GameGuiInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.GameGuiInit
UninstallCaption "绘遇 HUIYU · 卸载"
!insertmacro GameFrame "" "安装"
!insertmacro GameFrame "un." "卸载"
Var GamePath
Var GameRun
Var GameShortcut
Var GameRequiredSize

Function .onGUIEnd
  Call GameCleanup
FunctionEnd
Function un.onGUIEnd
  Call un.GameCleanup
FunctionEnd
Function .onInstFailed
  Call GameFailed
FunctionEnd
Function un.onUninstFailed
  Call un.GameFailed
FunctionEnd

Function GameWelcome
  Call SkipIfPassive
  StrCpy $GameStep "欢迎  /  安装位置  /  安装  /  完成"
  Call GameCreatePage
  !insertmacro GameLabel 49% 29% 46% 10% "让故事，在此相遇。" $GameTitleFont Ink
  !insertmacro GameLabel 49% 46% 46% 16% "为角色、灵感与创作，准备一个专属空间。$\r$\n接下来选择安装位置，即可开始。" $GameFont Muted
  !insertmacro GameLabel 49% 72% 46% 11% "已有的作品、个人设置与导入资源会被保留。$\r$\n生成模型需要另行配置。" $GameSmallFont Muted
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:开始设置(&N)"
  Call GameShowPage
FunctionEnd

Function GameDirectory
  Call SkipIfPassive
  StrCpy $GameStep "01  安装位置  /  02  安装  /  03  完成"
  Call GameCreatePage
  !insertmacro GameLabel 49% 28% 46% 10% "选择安装位置" $GameTitleFont Ink
  !insertmacro GameLabel 49% 43% 46% 10% "应用程序将安装到以下文件夹。" $GameFont Muted
  ${NSD_CreateDirRequest} 49% 56% 35% 7% "$INSTDIR"
  Pop $GamePath
  SendMessage $GamePath ${WM_SETFONT} $GameSmallFont 1
  !insertmacro GameColors $GamePath Ink Card
  ${NSD_CreateBrowseButton} 85% 56% 10% 7% "浏览…"
  Pop $GameControl
  SendMessage $GameControl ${WM_SETFONT} $GameSmallFont 1
  ${NSD_OnClick} $GameControl GameBrowse
  IntOp $GameRequiredSize ${ESTIMATEDSIZE} / 1024
  IntOp $GameRequiredSize $GameRequiredSize + 1
  !insertmacro GameLabel 49% 68% 46% 6% "所需空间约 $GameRequiredSize MB" $GameSmallFont Accent
  !insertmacro GameLabel 49% 79% 46% 9% "重新安装会保留个人内容。$\r$\n安装时可能需要 Windows 管理员授权。" $GameSmallFont Muted
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:安装绘遇(&I)"
  Call GameShowPage
FunctionEnd

Function GameBrowse
  nsDialogs::SelectFolderDialog "选择绘遇的安装位置" "$INSTDIR"
  Pop $0
  ${If} $0 != error
    ${GetFileName} "$0" $1
    ${If} $1 == "${PRODUCTNAME}"
      ${NSD_SetText} $GamePath "$0"
    ${Else}
      ${NSD_SetText} $GamePath "$0\${PRODUCTNAME}"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function GameDirectoryLeave
  ${NSD_GetText} $GamePath $INSTDIR
  System::Call 'shlwapi::PathIsRelativeW(w "$INSTDIR") i.r2'
  ${If} $2 != 0
    MessageBox MB_ICONEXCLAMATION "请输入完整的安装路径，例如 D:\Apps\AI-CG-Studio。"
    Abort
  ${EndIf}
  GetFullPathName $INSTDIR "$INSTDIR"
  trim_path:
    StrCpy $1 $INSTDIR 1 -1
    ${If} $1 == "\"
      StrCpy $INSTDIR $INSTDIR -1
      Goto trim_path
    ${EndIf}
  ${GetRoot} "$INSTDIR" $0
  ${GetParent} "$INSTDIR" $1
  ${If} $INSTDIR == ""
  ${OrIf} $0 == ""
  ${OrIf} $1 == ""
  ${OrIf} $INSTDIR == $0
  ${OrIf} $INSTDIR == "$0\"
  ${OrIf} $INSTDIR == $WINDIR
  ${OrIf} $INSTDIR == $SYSDIR
  ${OrIf} $INSTDIR == $PROGRAMFILES
  ${OrIf} $INSTDIR == $PROGRAMFILES64
  ${OrIf} $INSTDIR == $PROFILE
    MessageBox MB_ICONEXCLAMATION "请选择专门的应用文件夹，例如 D:\Apps\AI-CG-Studio。"
    Abort
  ${EndIf}
FunctionEnd

Function GameFinish
  Call SkipIfPassive
  StrCpy $GameStep "03  完成  /  已安装绘遇"
  Call GameCreatePage
  !insertmacro GameLabel 49% 28% 46% 10% "绘遇已就绪" $GameTitleFont Ink
  !insertmacro GameLabel 49% 43% 46% 12% "安装完成。$\r$\n可以从一个角色或一个念头，开始创作。" $GameFont Muted
  ${NSD_CreateCheckbox} 49% 65% 46% 7% "创建桌面快捷方式"
  Pop $GameShortcut
  System::Call 'uxtheme::SetWindowTheme(p $GameShortcut,w "",w "")'
  SendMessage $GameShortcut ${WM_SETFONT} $GameSmallFont 1
  !insertmacro GameColors $GameShortcut Ink Surface
  ${NSD_Check} $GameShortcut
  ${NSD_CreateCheckbox} 49% 76% 46% 7% "完成后打开绘遇"
  Pop $GameRun
  System::Call 'uxtheme::SetWindowTheme(p $GameRun,w "",w "")'
  SendMessage $GameRun ${WM_SETFONT} $GameSmallFont 1
  !insertmacro GameColors $GameRun Ink Surface
  ${NSD_Check} $GameRun
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:完成(&F)"
  Call GameShowPage
FunctionEnd

Function GameFinishLeave
  ${NSD_GetState} $GameShortcut $0
  ${If} $0 = ${BST_CHECKED}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}
  ${NSD_GetState} $GameRun $0
  ${If} $0 = ${BST_CHECKED}
    Call RunMainBinary
  ${EndIf}
FunctionEnd

!include "${__FILEDIR__}\game-uninstall.nsh"
