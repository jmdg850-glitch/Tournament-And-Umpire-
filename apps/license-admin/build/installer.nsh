; Custom NSIS hooks for RESETIQ License Admin.

; Upgrades from "Tournament License Admin": reuse the registered install folder instead of
; letting electron-builder's instFilesPre append "\RESETIQ License Admin" to it (which
; nested non-silent upgrades such as "Restart to update"). New installs, and upgrades
; where the user picks a different folder, still go through instFilesPre unchanged.
; Same hook as apps/operator/build/installer.nsh.
!macro customPageAfterChangeDir
  !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !define MUI_PAGE_CUSTOMFUNCTION_PRE resetiqInstFilesPre
  Function resetiqInstFilesPre
    ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != ""
    ${AndIf} $0 == $INSTDIR
      Return
    ${EndIf}
    Call instFilesPre
  FunctionEnd
!macroend
