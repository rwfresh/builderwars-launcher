; Included by electron-builder's NSIS installer (build/installer.nsh is picked up automatically).
; Registers the builderwars:// deep-link scheme at install time and removes it on uninstall.
; SHELL_CONTEXT is HKCU for the per-user install (nsis.perMachine: false), HKLM for per-machine.
!macro customInstall
  DeleteRegKey SHELL_CONTEXT "Software\Classes\builderwars"
  WriteRegStr SHELL_CONTEXT "Software\Classes\builderwars" "" "URL:Builder Wars"
  WriteRegStr SHELL_CONTEXT "Software\Classes\builderwars" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\builderwars\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\builderwars\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ; Not during an update: the old uninstaller runs then, and the new install keeps the scheme.
  ${ifNot} ${isUpdated}
    DeleteRegKey SHELL_CONTEXT "Software\Classes\builderwars"
  ${endIf}
!macroend
