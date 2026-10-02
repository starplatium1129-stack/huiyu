; Shared native surface. Keep actual NSIS buttons, focus rings and progress controls.
!include nsDialogs.nsh
Var GamePage
Var GameImage
Var GameLeftBitmap
Var GameArtWidth
Var GameFont
Var GameTitleFont
Var GameSmallFont
Var GameWidth
Var GameHeight
Var GameScale
Var GameControl
Var GameProgress
Var GameProgressText
Var GameLog
Var GameHeadline
Var GameLight
Var GameMode
Var GameStep

; SetCtlColors accepts compile-time colors only (NSIS reference 4.9.14.16).
; Branch at runtime so system light/dark works without unsupported color variables.
!define GAME_LIGHT_Ink "211C30"
!define GAME_LIGHT_Muted "536173"
!define GAME_LIGHT_Accent "92365F"
!define GAME_LIGHT_Surface "FFF8F4"
!define GAME_LIGHT_Card "FFFFFF"
!define GAME_DARK_Ink "FFF8F4"
!define GAME_DARK_Muted "BFC2D3"
!define GAME_DARK_Accent "E7BCD2"
!define GAME_DARK_Surface "14192D"
!define GAME_DARK_Card "252B43"
!macro GameColors hwnd ink background
  ${If} $GameLight == 1
    SetCtlColors ${hwnd} "${GAME_LIGHT_${ink}}" "${GAME_LIGHT_${background}}"
  ${Else}
    SetCtlColors ${hwnd} "${GAME_DARK_${ink}}" "${GAME_DARK_${background}}"
  ${EndIf}
!macroend

!macro GameLabel x y w h text font color
  ${NSD_CreateLabel} ${x} ${y} ${w} ${h} "${text}"
  Pop $GameControl
  ${NSD_AddStyle} $GameControl ${WS_CLIPSIBLINGS}
  !insertmacro GameColors $GameControl ${color} Surface
  SendMessage $GameControl ${WM_SETFONT} ${font} 1
!macroend

!macro GameFrame prefix mode
Function ${prefix}GameGuiInit
  StrCpy $GameMode "${mode}"
  StrCpy $GameLight 0
  ReadRegDWORD $GameLight HKCU "Software\Microsoft\Windows\CurrentVersion\Themes\Personalize" "AppsUseLightTheme"
  !ifdef GAME_PREVIEW_LIGHT
    StrCpy $GameLight 1
  !endif
  !ifdef GAME_PREVIEW_DARK
    StrCpy $GameLight 0
  !endif
  !ifdef GAME_PREVIEW_UNINSTALL
    StrCpy $GameMode "卸载"
  !endif
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${GAME_ASSET_DIR}\atelier-left.bmp"
  CreateFont $GameFont "Microsoft YaHei UI" 11 400
  CreateFont $GameSmallFont "Microsoft YaHei UI" 9 400
  CreateFont $GameTitleFont "Microsoft YaHei UI" 23 600
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i.r0'
  ${If} $0 == 0
    StrCpy $0 96
  ${EndIf}
  StrCpy $GameScale $0
  IntOp $GameWidth 960 * $0
  IntOp $GameWidth $GameWidth / 96
  IntOp $GameHeight 660 * $0
  IntOp $GameHeight $GameHeight / 96
  ; The work area excludes the taskbar; physical screen size is not layout space.
  System::Call '*(i 0,i 0,i 0,i 0) p.r0'
  System::Call 'user32::SystemParametersInfoW(i 48,i 0,p r0,i 0)'
  System::Call '*$0(i.r5,i.r6,i.r1,i.r2)'
  System::Free $0
  IntOp $1 $1 - $5
  IntOp $2 $2 - $6
  IntOp $3 $1 - 24
  ${If} $GameWidth > $3
    StrCpy $GameWidth $3
  ${EndIf}
  IntOp $3 $2 - 24
  ${If} $GameHeight > $3
    StrCpy $GameHeight $3
  ${EndIf}
  IntOp $1 $1 - $GameWidth
  IntOp $1 $1 / 2
  IntOp $1 $1 + $5
  IntOp $2 $2 - $GameHeight
  IntOp $2 $2 / 2
  IntOp $2 $2 + $6
  System::Call 'user32::SetWindowPos(p $HWNDPARENT,p 0,i r1,i r2,i $GameWidth,i $GameHeight,i 0x14)'
  !insertmacro GameColors $HWNDPARENT Ink Surface
  SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:绘遇 HUIYU · $GameMode"
  System::Call '*(i 0,i 0,i 0,i 0) p.r0'
  System::Call 'user32::GetClientRect(p $HWNDPARENT,p r0)'
  System::Call '*$0(i,i,i.r1,i.r2)'
  System::Free $0
  StrCpy $GameWidth $1
  IntOp $3 64 * $GameScale
  IntOp $3 $3 / 96
  IntOp $GameHeight $2 - $3
  IntOp $GameArtWidth $GameWidth * 44
  IntOp $GameArtWidth $GameArtWidth / 100
  System::Call 'user32::LoadImageW(p 0,w "$PLUGINSDIR\atelier-left.bmp",i 0,i $GameArtWidth,i $GameHeight,i 0x10) p.s'
  Pop $GameLeftBitmap
  System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "",i 0x5000000E,i 0,i 0,i $GameArtWidth,i $GameHeight,p $HWNDPARENT,p 0,p 0,p 0) p.r0'
  SendMessage $0 0x0172 0 $GameLeftBitmap
  System::Call 'user32::SetWindowPos(p r0,p 1,i 0,i 0,i 0,i 0,i 0x13)'
  !insertmacro GameHideChrome 1037
  !insertmacro GameHideChrome 1038
  !insertmacro GameHideChrome 1034
  !insertmacro GameHideChrome 1035
  !insertmacro GameHideChrome 1028
  Call ${prefix}GameFooter
FunctionEnd

Function ${prefix}GameFooter
  IntOp $1 $GameWidth * 64
  IntOp $1 $1 / 100
  IntOp $2 10 * $GameScale
  IntOp $2 $2 / 96
  IntOp $2 $2 + $GameHeight
  IntOp $3 $GameWidth * 16
  IntOp $3 $3 / 100
  IntOp $4 36 * $GameScale
  IntOp $4 $4 / 96
  GetDlgItem $0 $HWNDPARENT 1
  System::Call 'user32::SetWindowPos(p r0,p 0,i r1,i r2,i r3,i r4,i 0x14)'
  SendMessage $0 ${WM_SETFONT} $GameFont 1
  IntOp $1 $GameWidth * 82
  IntOp $1 $1 / 100
  GetDlgItem $0 $HWNDPARENT 2
  System::Call 'user32::SetWindowPos(p r0,p 0,i r1,i r2,i r3,i r4,i 0x14)'
  SendMessage $0 ${WM_SETFONT} $GameSmallFont 1
  IntOp $1 $GameWidth * 46
  IntOp $1 $1 / 100
  GetDlgItem $0 $HWNDPARENT 3
  System::Call 'user32::SetWindowPos(p r0,p 0,i r1,i r2,i r3,i r4,i 0x14)'
  SendMessage $0 ${WM_SETFONT} $GameSmallFont 1
FunctionEnd

Function ${prefix}GameCreatePage
  ${If} $GameHeadline != 0
    ShowWindow $GameHeadline ${SW_HIDE}
  ${EndIf}
  nsDialogs::Create 1044
  Pop $GamePage
  ${If} $GamePage == error
    Abort
  ${EndIf}
  System::Call 'user32::SetWindowPos(p $GamePage,p 0,i 0,i 0,i $GameWidth,i $GameHeight,i 0x14)'
  !insertmacro GameColors $GamePage Ink Surface
  ${NSD_CreateBitmap} 0 0 44% 100% ""
  Pop $GameImage
  ${NSD_AddStyle} $GameImage ${WS_CLIPSIBLINGS}
  SendMessage $GameImage 0x0172 0 $GameLeftBitmap
  !insertmacro GameLabel 49% 7% 46% 5% "绘遇 HUIYU  /  $GameMode" $GameSmallFont Accent
  !insertmacro GameLabel 49% 16% 46% 5% "$GameStep" $GameSmallFont Muted
  !insertmacro GameLabel 49% 92% 46% 5% "${VERSION}  ·  Windows x64" $GameSmallFont Muted
  Call ${prefix}GameFooter
FunctionEnd

Function ${prefix}GameShowPage
  System::Call 'user32::SetWindowPos(p $GameImage,p 1,i 0,i 0,i 0,i 0,i 0x13)'
  nsDialogs::Show
FunctionEnd

Function ${prefix}GameInstallShow
  ; MUI restores its header when entering a built-in page; hide it again here.
  !insertmacro GameHideChrome 1037
  !insertmacro GameHideChrome 1038
  !insertmacro GameHideChrome 1034
  !insertmacro GameHideChrome 1035
  !insertmacro GameHideChrome 1039
  !insertmacro GameHideChrome 1045
  !insertmacro GameHideChrome 1046
  FindWindow $GamePage "#32770" "" $HWNDPARENT
  GetDlgItem $GameProgressText $GamePage 1006
  GetDlgItem $GameProgress $GamePage 1004
  GetDlgItem $GameLog $GamePage 1016
  IntOp $0 $GameWidth * 49
  IntOp $0 $0 / 100
  IntOp $1 $GameHeight * 28
  IntOp $1 $1 / 100
  IntOp $2 $GameWidth * 46
  IntOp $2 $2 / 100
  IntOp $3 $GameHeight * 60
  IntOp $3 $3 / 100
  IntOp $4 $GameHeight * 12
  IntOp $4 $4 / 100
  IntOp $5 70 * $GameScale
  IntOp $5 $5 / 96
  System::Call 'user32::CreateWindowExW(i 0,w "STATIC",w "正在$GameMode绘遇",i 0x50000000,i r0,i r4,i r2,i r5,p $HWNDPARENT,p 0,p 0,p 0) p.s'
  Pop $GameHeadline
  SendMessage $GameHeadline ${WM_SETFONT} $GameTitleFont 1
  !insertmacro GameColors $GameHeadline Ink Surface
  System::Call 'user32::SetWindowPos(p $GamePage,p 0,i r0,i r1,i r2,i r3,i 0x14)'
  !insertmacro GameColors $GamePage Ink Surface
  IntOp $4 38 * $GameScale
  IntOp $4 $4 / 96
  System::Call 'user32::SetWindowPos(p $GameProgressText,p 0,i 0,i 0,i r2,i r4,i 0x14)'
  IntOp $5 12 * $GameScale
  IntOp $5 $5 / 96
  System::Call 'user32::SetWindowPos(p $GameProgress,p 0,i 0,i r4,i r2,i r5,i 0x14)'
  IntOp $4 70 * $GameScale
  IntOp $4 $4 / 96
  IntOp $3 $3 - $4
  System::Call 'user32::SetWindowPos(p $GameLog,p 0,i 0,i r4,i r2,i r3,i 0x14)'
  !insertmacro GameColors $GameProgressText Ink Surface
  ; The detail log is a ListView, so it needs LVM colors, not SetCtlColors.
  System::Call 'uxtheme::SetWindowTheme(p $GameProgress,w "",w "")'
  ${If} $GameLight == 1
    SendMessage $GameLog 0x1024 0 0x301C21
    SendMessage $GameLog 0x1026 0 0xFFFFFF
    SendMessage $GameLog 0x1001 0 0xFFFFFF
    SendMessage $GameProgress 0x0409 0 0x5F3692
    SendMessage $GameProgress 0x2001 0 0xFFFFFF
  ${Else}
    SendMessage $GameLog 0x1024 0 0xF4F8FF
    SendMessage $GameLog 0x1026 0 0x432B25
    SendMessage $GameLog 0x1001 0 0x432B25
    SendMessage $GameProgress 0x0409 0 0xD2BCE7
    SendMessage $GameProgress 0x2001 0 0x432B25
  ${EndIf}
  SendMessage $GameLog ${WM_SETFONT} $GameSmallFont 1
  GetDlgItem $GameControl $GamePage 1027
  ShowWindow $GameControl ${SW_HIDE}
  ShowWindow $GameLog ${SW_SHOW}
  Call ${prefix}GameFooter
FunctionEnd

Function ${prefix}GameFailed
  SendMessage $GameHeadline ${WM_SETTEXT} 0 "STR:$GameMode未完成"
FunctionEnd

Function ${prefix}GameCleanup
  System::Call 'gdi32::DeleteObject(p $GameLeftBitmap)'
  System::Call 'gdi32::DeleteObject(p $GameFont)'
  System::Call 'gdi32::DeleteObject(p $GameSmallFont)'
  System::Call 'gdi32::DeleteObject(p $GameTitleFont)'
FunctionEnd
!macroend

!macro GameHideChrome id
  GetDlgItem $0 $HWNDPARENT ${id}
  ShowWindow $0 ${SW_HIDE}
!macroend
