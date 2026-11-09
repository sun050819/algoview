; AlgoView 1.0.0 - offline NSIS installer
; ASCII only: makensis reads this file with the system code page, so any
; non-ASCII text here breaks the build. Keep comments in English.
; scripts/package.mjs copies this file next to win-unpacked/ and runs it
; from that directory, so all paths below stay relative.
Unicode true
!define APPNAME "AlgoView"
!define APPVERSION "1.0.0"
Name "${APPNAME} ${APPVERSION}"
OutFile "AlgoView-Setup-1.0.0.exe"
InstallDir "$LOCALAPPDATA\Programs\AlgoView"
InstallDirRegKey HKCU "Software\AlgoView" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
AutoCloseWindow false
ShowInstDetails nevershow

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "win-unpacked\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\AlgoView" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlgoView" "DisplayName" "AlgoView 1.0.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlgoView" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlgoView" "Publisher" "Sun Jichen"
  CreateShortcut "$DESKTOP\AlgoView.lnk" "$INSTDIR\AlgoView.exe"
  CreateDirectory "$SMPROGRAMS\AlgoView"
  CreateShortcut "$SMPROGRAMS\AlgoView\AlgoView.lnk" "$INSTDIR\AlgoView.exe"
  CreateShortcut "$SMPROGRAMS\AlgoView\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\AlgoView.lnk"
  RMDir /r "$SMPROGRAMS\AlgoView"
  DeleteRegKey HKCU "Software\AlgoView"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AlgoView"
  ; user data: renderer cache / local settings live in %APPDATA%\AlgoView
  ; (electron/main.ts pins the folder to this ASCII name, see applyUserDataPaths)
  RMDir /r "$APPDATA\AlgoView"
  RMDir /r "$INSTDIR"
SectionEnd
