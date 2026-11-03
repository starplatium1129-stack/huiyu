; Interactive removal uses the same WPF surface as setup. Silent/update removal
; remains NSIS-owned, including its file list, process guard and data roots.
Function un.GameModernUninstall
  ${If} ${Silent}
    ClearErrors
    ${GetOptions} $CMDLINE "/HUIYU_DELETE_DATA" $0
    ${IfNot} ${Errors}
    ${AndIf} $UpdateMode != 1
      StrCpy $DeleteAppDataCheckboxState 1
    ${EndIf}
    ClearErrors
    Return
  ${EndIf}
  ${If} $PassiveMode == 1
  ${OrIf} $UpdateMode == 1
    Return
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${GAME_ASSET_DIR}\modern\HuiyuUninstaller.exe"
  ClearErrors
  CopyFiles /SILENT "$EXEPATH" "$PLUGINSDIR\UninstallCore.exe"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法准备卸载界面，请重新打开卸载器。应用与个人数据尚未更改。"
    SetErrorLevel 1603
    Quit
  ${EndIf}
  HideWindow
  ClearErrors
  ExecWait '"$PLUGINSDIR\HuiyuUninstaller.exe" "--core=$PLUGINSDIR\UninstallCore.exe" /D=$INSTDIR' $0
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法打开卸载界面，请检查 Windows .NET Framework 后重试。应用与个人数据尚未更改。"
    SetErrorLevel 1603
  ${Else}
    SetErrorLevel $0
  ${EndIf}
  ; WPF waited for the silent private core; never run deletion a second time.
  Quit
FunctionEnd
