; Custom NSIS hooks for RESETIQ Operator.
; $DESKTOP follows the user's actual Desktop (including OneDrive redirection).
; Names come from electron-builder (nsis.shortcutName / productName), so this
; stays in sync with package.json instead of hard-coding the product name.

!macro customInstall
  CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

; Upgrades from "Tournament Operator": reuse the registered install folder instead of
; letting electron-builder's instFilesPre append "\RESETIQ Operator" to it (which
; nested non-silent upgrades such as "Restart to update"). New installs, and upgrades
; where the user picks a different folder, still go through instFilesPre unchanged.
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
