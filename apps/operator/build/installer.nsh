; Custom NSIS hooks for Tournament Operator.
; $DESKTOP follows the user's actual Desktop (including OneDrive redirection).

!macro customInstall
  CreateShortCut "$DESKTOP\Tournament Operator.lnk" "$INSTDIR\Tournament Operator.exe" "" "$INSTDIR\Tournament Operator.exe" 0
!macroend
