; Product-only integration. Never stop a process from an installer: its owner
; must save work and exit normally. Unknown Restart Manager state also refuses.
Var GamePreviousInstallDirectory
!macro GameRequireStopped installRoot
  Push $0
  Push $1
  Push $2
  Push $3
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  StrCpy $R3 0
  !insertmacro RestartManager_StartSession $R0
  ${If} $R0 == ""
    StrCpy $R3 1603
  ${Else}
    ${If} ${FileExists} "${installRoot}\${MAINBINARYNAME}.exe"
      !insertmacro RestartManager_RegisterFile $R0 "${installRoot}\${MAINBINARYNAME}.exe"
      ${If} $0 != 0
        StrCpy $R3 1603
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "${installRoot}\gateway\huiyu-runtime.exe"
      !insertmacro RestartManager_RegisterFile $R0 "${installRoot}\gateway\huiyu-runtime.exe"
      ${If} $0 != 0
        StrCpy $R3 1603
      ${EndIf}
    ${EndIf}
    ${If} $R3 == 0
      System::Call 'RSTRTMGR::RmGetList(i R0, *i 0 r1, *i 0 r2, p 0, *i 0 r3) i .r0'
      ${If} $0 == ${ERROR_MORE_DATA}
        StrCpy $R3 1618
      ${ElseIf} $0 != 0
        StrCpy $R3 1603
      ${ElseIf} $1 != 0
      ${OrIf} $2 != 0
      ${OrIf} $3 != 0
        StrCpy $R3 1603
      ${EndIf}
    ${EndIf}
    !insertmacro RestartManager_EndSession $R0
  ${EndIf}
  ${If} $R3 != 0
    SetErrorLevel $R3
    ${IfNot} ${Silent}
      MessageBox MB_ICONEXCLAMATION "绘遇或资源任务仍在运行，或无法确认程序已退出。请先保存工作，从托盘菜单完全退出绘遇，等待资源任务结束，再重新运行安装或卸载。程序和个人内容尚未替换。"
    ${EndIf}
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
    Pop $3
    Pop $2
    Pop $1
    Pop $0
    Abort
  ${EndIf}
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

Function GameCheckStopped
  !insertmacro GameRequireStopped "$INSTDIR"
FunctionEnd
Function un.GameCheckStopped
  !insertmacro GameRequireStopped "$INSTDIR"
FunctionEnd

Function GameCheckPreviousStopped
  ; The user can choose a different /D target. Check the installation that the
  ; legacy uninstaller will actually remove before permitting it to run.
  ${If} $WixMode == 1
    ReadRegStr $GamePreviousInstallDirectory HKLM "$R6" "InstallLocation"
  ${Else}
    ReadRegStr $GamePreviousInstallDirectory SHCTX "${MANUPRODUCTKEY}" ""
  ${EndIf}
  ${If} $GamePreviousInstallDirectory == ""
    SetErrorLevel 1603
    MessageBox MB_ICONEXCLAMATION "无法确认旧版安装位置。请先保存工作并完全退出绘遇，再从 Windows 设置中卸载旧版；默认保留应用数据，然后重新安装。"
    Abort
  ${EndIf}
  !insertmacro GameRequireStopped "$GamePreviousInstallDirectory"
FunctionEnd

Function GameCreateResourceShortcut
  ; /NS must also suppress this new entry. /UPDATE keeps existing links and
  ; adds the helper only for installations with an existing owned app shortcut.
  ${If} $NoShortcutMode == 1
    Return
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\gateway\tools\Install-OfflineResources.cmd"
    Return
  ${EndIf}
  StrCpy $R0 0
  !insertmacro IsShortcutTarget "$SMPROGRAMS\绘遇 HUIYU.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  IntOp $R0 $R0 | $0
  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\绘遇 HUIYU.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  IntOp $R0 $R0 | $0
  !insertmacro IsShortcutTarget "$DESKTOP\绘遇 HUIYU.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  IntOp $R0 $R0 | $0
  ${If} $R0 != 1
    Return
  ${EndIf}
  !if "${STARTMENUFOLDER}" != ""
    StrCpy $R1 "$SMPROGRAMS\$AppStartMenuFolder"
  !else
    StrCpy $R1 "$SMPROGRAMS"
  !endif
  ; Preserve existing links, including user changes or an unrelated collision.
  ${If} ${FileExists} "$R1\绘遇 · 资源安装助手.lnk"
    Return
  ${EndIf}
  CreateDirectory "$R1"
  StrCpy $R2 $OUTDIR
  SetOutPath "$INSTDIR\gateway\tools"
  CreateShortcut "$R1\绘遇 · 资源安装助手.lnk" "$INSTDIR\gateway\tools\Install-OfflineResources.cmd" "" "$INSTDIR\huiyu-icon.ico" 0
  SetOutPath "$R2"
  ; Do not launch the helper here: this installer can run as another admin.
FunctionEnd

Function un.GameRemoveResourceShortcut
  !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\绘遇 · 资源安装助手.lnk" "$INSTDIR\gateway\tools\Install-OfflineResources.cmd"
  Pop $0
  ${If} $0 == 1
    Delete "$SMPROGRAMS\$AppStartMenuFolder\绘遇 · 资源安装助手.lnk"
  ${EndIf}
  !insertmacro IsShortcutTarget "$SMPROGRAMS\绘遇 · 资源安装助手.lnk" "$INSTDIR\gateway\tools\Install-OfflineResources.cmd"
  Pop $0
  ${If} $0 == 1
    Delete "$SMPROGRAMS\绘遇 · 资源安装助手.lnk"
  ${EndIf}
FunctionEnd
