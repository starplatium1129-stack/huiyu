Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState

; Preview uses these same pages in a no-op executable. Production uses un.*.
!macro GameUninstallPages prefix
Function ${prefix}GameUninstallConfirm
  StrCpy $DeleteAppDataCheckboxState 0
  Call ${prefix}SkipIfPassive
  StrCpy $GameMode "卸载"
  StrCpy $GameStep "01  确认卸载  /  02  卸载  /  03  完成"
  Call ${prefix}GameCreatePage
  !insertmacro GameLabel 49% 26% 46% 10% "卸载绘遇" $GameTitleFont Ink
  !insertmacro GameLabel 49% 39% 46% 12% "将移除应用程序与快捷方式。$\r$\n默认保留作品、个人设置与已导入资源。" $GameFont Ink
  !insertmacro GameLabel 49% 55% 46% 5% "应用位置" $GameSmallFont Muted
  ${NSD_CreateText} 49% 61% 46% 7% "$INSTDIR"
  Pop $GameControl
  ${NSD_AddStyle} $GameControl ${ES_READONLY}
  SendMessage $GameControl ${WM_SETFONT} $GameSmallFont 1
  !insertmacro GameColors $GameControl Ink Card
  ${NSD_CreateCheckbox} 49% 74% 46% 6% "同时清理当前用户的应用数据（可选）"
  Pop $DeleteAppDataCheckbox
  System::Call 'uxtheme::SetWindowTheme(p $DeleteAppDataCheckbox,w "",w "")'
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $GameSmallFont 1
  !insertmacro GameColors $DeleteAppDataCheckbox Ink Surface
  ${NSD_Uncheck} $DeleteAppDataCheckbox
  !insertmacro GameLabel 49% 82% 46% 8% "包括应用数据目录内的作品、设置和资源。$\r$\n勾选后需要再次确认；保留数据请勿勾选。" $GameSmallFont Muted
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:卸载绘遇(&U)"
  Call ${prefix}GameShowPage
FunctionEnd

Function ${prefix}GameUninstallConfirmLeave
  StrCpy $DeleteAppDataCheckboxState 0
  ${NSD_GetState} $DeleteAppDataCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    ; Match precisely the existing Tauri cleanup roots; never add a removal path.
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "确定同时清理当前用户的应用数据吗？$\r$\n$\r$\n将清理以下目录及其中的作品、设置和资源：$\r$\n%APPDATA%\${BUNDLEID}$\r$\n%LOCALAPPDATA%\${BUNDLEID}$\r$\n$\r$\n此操作无法通过绘遇撤销，请先备份。选择“否”将返回卸载选项。" IDYES confirmed
    ${NSD_Uncheck} $DeleteAppDataCheckbox
    Abort
    confirmed:
      StrCpy $DeleteAppDataCheckboxState 1
  ${EndIf}
FunctionEnd

Function ${prefix}GameUninstallFinish
  Call ${prefix}SkipIfPassive
  StrCpy $GameMode "卸载"
  StrCpy $GameStep "03  完成  /  已卸载绘遇"
  Call ${prefix}GameCreatePage
  !insertmacro GameLabel 49% 28% 46% 10% "绘遇已卸载" $GameTitleFont Ink
  ${If} $DeleteAppDataCheckboxState == 1
    !insertmacro GameLabel 49% 46% 46% 18% "已按你的选择执行应用数据清理。$\r$\n保存在其他位置的文件不受影响。" $GameFont Muted
  ${Else}
    !insertmacro GameLabel 49% 46% 46% 18% "个人作品、设置与已导入资源已保留。$\r$\n以后重新安装绘遇，可继续使用。" $GameFont Muted
  ${EndIf}
  !insertmacro GameLabel 49% 76% 46% 10% "感谢这段相伴，期待下一次相遇。" $GameSmallFont Accent
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:完成(&F)"
  Call ${prefix}GameShowPage
FunctionEnd
!macroend
!insertmacro GameUninstallPages "un."
