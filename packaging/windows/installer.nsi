; Thndr Radar Windows installer (per-user, no admin needed). Built by packaging/build-win.sh with makensis.
Unicode true
!define APP "Thndr Radar"
!ifndef VERSION
  !define VERSION "0.1.0"
!endif
Name "${APP}"
OutFile "..\..\dist\ThndrRadar-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\ThndrRadar"
RequestExecutionLevel user
Icon "..\icon.ico"
UninstallIcon "..\icon.ico"
SetCompressor /SOLID lzma
!include "MUI2.nsh"
!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APP}"
!insertmacro MUI_PAGE_LICENSE "..\..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function LaunchApp
  Exec '"$WINDIR\System32\wscript.exe" "$INSTDIR\ThndrRadar.vbs"'
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "..\..\build\win\*.*"
  File "..\icon.ico"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$WINDIR\System32\wscript.exe" '"$INSTDIR\ThndrRadar.vbs"' "$INSTDIR\icon.ico"
  CreateShortcut "$DESKTOP\${APP}.lnk" "$WINDIR\System32\wscript.exe" '"$INSTDIR\ThndrRadar.vbs"' "$INSTDIR\icon.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ThndrRadar" "DisplayName" "${APP}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ThndrRadar" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ThndrRadar" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ThndrRadar" "Publisher" "TheGeekyM"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ThndrRadar" "UninstallString" '"$INSTDIR\Uninstall.exe"'
SectionEnd

Section "Uninstall"
  ; stop a running server (node.exe from this folder) before deleting files
  nsExec::Exec 'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" | Where-Object { $$_.ExecutablePath -like ''$INSTDIR\*'' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ThndrRadar"
SectionEnd
