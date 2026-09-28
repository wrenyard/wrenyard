; Wrenyard NSIS custom include. Wired in explicitly through `nsis.include` in
; electron-builder.yml rather than relying on implicit discovery.
;
; Adds an optional "add wrenyard to PATH" opt-in (default off) to the
; current-user assistive installer. The choice is stored in HKCU so a silent
; update keeps it, and a real uninstall removes the entry it added. PATH is
; edited as exact semicolon-delimited segments (case-insensitive, one trailing
; backslash ignored) and a WM_SETTINGCHANGE broadcast lets newly opened
; terminals pick the change up. Only core NSIS, the bundled System plugin and
; the registry are used; no third-party plugin is installed.

!include "LogicLib.nsh"

!define WRENYARD_PATH_REG_KEY "Software\Wrenyard"
!define WRENYARD_PATH_REG_VALUE "AddToPath"
!define WRENYARD_BIN_SUBDIR "resources\wrenyard"

; Per-user environment store and the constants used to publish a PATH change.
!define WRENYARD_ENV_KEY "Environment"
!define WRENYARD_ENV_VALUE "PATH"
!define WRENYARD_HKCU 0x80000001
!define WRENYARD_KEY_READ 0x20019
!define WRENYARD_HWND_BROADCAST 0xFFFF
!define WRENYARD_WM_SETTINGCHANGE 0x001A
!define WRENYARD_SMTO_ABORTIFHUNG 0x0002

; NSIS string capacity. electron-builder compiles Unicode NSIS with
; NSIS_MAX_STRLEN raised (8192). A registry PATH that would not fit is left
; untouched rather than silently truncated, so the user's environment is never
; corrupted. (Unicode NSIS stores two bytes per character.)
!ifdef NSIS_MAX_STRLEN
  !define WRENYARD_MAX_STRLEN ${NSIS_MAX_STRLEN}
!else
  !define WRENYARD_MAX_STRLEN 1024
!endif

!ifndef BUILD_UNINSTALLER
Var WrenyardAddToPath
!endif
Var WrenyardContainsResult
Var WrenyardPathOverflow

; Installer-only page state.
!ifndef BUILD_UNINSTALLER
Var WrenyardPathPageDialog
Var WrenyardPathPageCheckbox
!endif

; Current-user only: skip the install-scope page instead of letting the user
; pick a scope, and never request elevation. Applies to the installer pass only.
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    StrCpy $isForceCurrentInstall "1"
  !endif
!macroend

; Read the persisted PATH decision before any page renders so a silent (update)
; run reapplies the previous choice without a UI. A fresh install leaves the
; default (unchecked) untouched.
!macro customInit
  StrCpy $WrenyardAddToPath "0"
  ClearErrors
  ReadRegDWORD $0 HKCU "${WRENYARD_PATH_REG_KEY}" "${WRENYARD_PATH_REG_VALUE}"
  IfErrors wrenyardInitDone 0
  StrCmp $0 0 wrenyardInitDone 0
  StrCpy $WrenyardAddToPath "1"
  wrenyardInitDone:
!macroend

; Shared installer/uninstaller PATH helpers, generated once per pass. PFX is the
; function-name prefix: "Wrenyard" for the installer, "un.Wrenyard" for the
; uninstaller. Only one pass is compiled at a time, so the labels stay unique.
!macro WrenyardPathHelpers PFX
  ; Read HKCU\Environment\PATH into $0. On an oversized value (longer than an
  ; NSIS string can hold) $0 is left empty and $WrenyardPathOverflow is set so
  ; callers fail safe instead of writing a truncated PATH.
  Function ${PFX}ReadPath
    StrCpy $0 ""
    StrCpy $WrenyardPathOverflow ""
    System::Call 'advapi32::RegOpenKeyExW(i ${WRENYARD_HKCU}, w "${WRENYARD_ENV_KEY}", i 0, i ${WRENYARD_KEY_READ}, *i .r3) i .r4'
    StrCmp $4 0 0 wrenyardReadPathDone
    System::Call 'advapi32::RegQueryValueExW(i r3, w "${WRENYARD_ENV_VALUE}", i 0, i 0, i 0, *i .r5) i .r4'
    System::Call 'advapi32::RegCloseKey(i r3)'
    StrCmp $4 0 0 wrenyardReadPathDone
    ; $5 is the raw value size in bytes; compare against the NSIS capacity.
    IntOp $6 ${WRENYARD_MAX_STRLEN} * 2
    IntCmp $5 $6 wrenyardReadPathValue wrenyardReadPathValue wrenyardReadPathTooLong
    wrenyardReadPathTooLong:
      StrCpy $WrenyardPathOverflow "1"
      Goto wrenyardReadPathDone
    wrenyardReadPathValue:
      ReadRegStr $0 HKCU "${WRENYARD_ENV_KEY}" "${WRENYARD_ENV_VALUE}"
    wrenyardReadPathDone:
  FunctionEnd

  ; Rebuild a semicolon-delimited PATH in $2 with exact-match segments removed,
  ; keeping every other segment untouched.
  ; in:  $0 = PATH, $1 = segment to drop (one trailing backslash ignored)
  ; out: $2 = rebuilt PATH, $WrenyardContainsResult = "1" when a segment matched
  Function ${PFX}FilterPath
    Push $0
    Push $1
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    Push $8

    ; Normalise the target by dropping a single trailing backslash.
    StrLen $6 $1
    IntCmp $6 1 wrenyardFilterTargetDone wrenyardFilterTargetTrim wrenyardFilterTargetTrim
    wrenyardFilterTargetTrim:
      StrCpy $5 $1 1 -1
      StrCmp $5 "\" 0 wrenyardFilterTargetDone
      IntOp $6 $6 - 1
      StrCpy $1 $1 $6
    wrenyardFilterTargetDone:

    StrCpy $2 ""
    StrCpy $3 ""
    StrCpy $8 "0"
    StrCpy $WrenyardContainsResult ""
    StrCpy $6 0
    StrLen $7 $0

    wrenyardFilterLoop:
      IntCmp $6 $7 wrenyardFilterTail wrenyardFilterRead wrenyardFilterTail

    wrenyardFilterRead:
      StrCpy $4 $0 1 $6
      IntOp $6 $6 + 1
      StrCmp $4 ";" 0 wrenyardFilterAccum
      StrCpy $8 "0"
      Goto wrenyardFilterSegment

    wrenyardFilterAccum:
      StrCpy $3 "$3$4"
      Goto wrenyardFilterLoop

    wrenyardFilterTail:
      StrCpy $8 "1"

    wrenyardFilterSegment:
      ; Compare the segment, ignoring a single trailing backslash on it too.
      StrLen $4 $3
      IntCmp $4 1 wrenyardFilterCompare wrenyardFilterSegmentTrim wrenyardFilterSegmentTrim
      wrenyardFilterSegmentTrim:
        StrCpy $5 $3 1 -1
        StrCmp $5 "\" 0 wrenyardFilterCompare
        IntOp $4 $4 - 1
        StrCpy $3 $3 $4
      wrenyardFilterCompare:
      StrCmp $3 "$1" wrenyardFilterDrop wrenyardFilterKeep

    wrenyardFilterDrop:
      StrCpy $WrenyardContainsResult "1"
      Goto wrenyardFilterSegmentDone

    wrenyardFilterKeep:
      StrCmp $3 "" wrenyardFilterSegmentDone
      StrCmp $2 "" wrenyardFilterFirst
      StrCpy $2 "$2;$3"
      Goto wrenyardFilterSegmentDone
    wrenyardFilterFirst:
      StrCpy $2 "$3"

    wrenyardFilterSegmentDone:
      StrCpy $3 ""
      StrCmp $8 "1" wrenyardFilterDone wrenyardFilterLoop

    wrenyardFilterDone:
      Pop $8
      Pop $7
      Pop $6
      Pop $5
      Pop $4
      Pop $3
      Pop $1
      Pop $0
  FunctionEnd

  ; Remove <install dir>\resources\wrenyard from the user PATH, preserving the
  ; other segments.
  Function ${PFX}RemoveInstallDirFromPath
    Call ${PFX}ReadPath
    StrCmp $WrenyardPathOverflow "" 0 wrenyardRemoveDone
    StrCpy $1 "$INSTDIR\${WRENYARD_BIN_SUBDIR}"
    Call ${PFX}FilterPath
    StrCmp $WrenyardContainsResult "1" 0 wrenyardRemoveDone
    WriteRegExpandStr HKCU "${WRENYARD_ENV_KEY}" "${WRENYARD_ENV_VALUE}" "$2"
    Call ${PFX}BroadcastEnvironment
    wrenyardRemoveDone:
  FunctionEnd

  ; Notify running shells that the environment block changed so newly opened
  ; terminals inherit the updated PATH.
  Function ${PFX}BroadcastEnvironment
    System::Call 'user32::SendMessageTimeoutW(i ${WRENYARD_HWND_BROADCAST}, i ${WRENYARD_WM_SETTINGCHANGE}, i 0, w "${WRENYARD_ENV_KEY}", i ${WRENYARD_SMTO_ABORTIFHUNG}, i 5000, i 0) i .r4'
  FunctionEnd
!macroend

!ifndef BUILD_UNINSTALLER

!include "nsDialogs.nsh"

!insertmacro WrenyardPathHelpers "Wrenyard"

!macro customPageAfterChangeDir
  Page custom WrenyardPathPageCreate WrenyardPathPageLeave
!macroend

Function WrenyardPathPageCreate
  nsDialogs::Create 1018
  Pop $WrenyardPathPageDialog
  ${If} $WrenyardPathPageDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 20u "将 wrenyard 命令添加到 PATH 后，可以在终端直接使用。"
  Pop $0
  ${NSD_CreateLabel} 0 20u 100% 20u "仅影响以后新打开的终端。"
  Pop $1

  ${NSD_CreateCheckBox} 0 44u 100% 12u "添加到用户 PATH"
  Pop $WrenyardPathPageCheckbox
  ${If} $WrenyardAddToPath == "1"
    ${NSD_SetState} $WrenyardPathPageCheckbox 1
  ${Else}
    ${NSD_SetState} $WrenyardPathPageCheckbox 0
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function WrenyardPathPageLeave
  ${NSD_GetState} $WrenyardPathPageCheckbox $0
  StrCmp $0 "1" 0 wrenyardPathUnchecked
  StrCpy $WrenyardAddToPath "1"
  Goto wrenyardPathLeaveDone
  wrenyardPathUnchecked:
  StrCpy $WrenyardAddToPath "0"
  wrenyardPathLeaveDone:
FunctionEnd

; Append <install dir>\resources\wrenyard to the user PATH once. Installer-only;
; the uninstaller never needs to add the entry back.
Function WrenyardAddInstallDirToPath
  Call WrenyardReadPath
  StrCmp $WrenyardPathOverflow "" 0 wrenyardAddDone
  StrCpy $1 "$INSTDIR\${WRENYARD_BIN_SUBDIR}"
  Call WrenyardFilterPath
  StrCmp $WrenyardContainsResult "1" wrenyardAddDone
  ; Guard the NSIS capacity so appending can never truncate the user PATH.
  StrLen $3 $1
  StrLen $4 $0
  IntOp $5 $3 + $4
  IntOp $5 $5 + 1
  IntOp $6 ${WRENYARD_MAX_STRLEN} - 1
  IntCmp $5 $6 wrenyardAddWrite wrenyardAddWrite wrenyardAddTooLong
  wrenyardAddWrite:
    StrCmp $0 "" wrenyardAddSetTarget
    StrCpy $0 "$0;$1"
    Goto wrenyardAddStore
  wrenyardAddSetTarget:
    StrCpy $0 "$1"
  wrenyardAddStore:
    WriteRegExpandStr HKCU "${WRENYARD_ENV_KEY}" "${WRENYARD_ENV_VALUE}" "$0"
    Call WrenyardBroadcastEnvironment
    Goto wrenyardAddDone
  wrenyardAddTooLong:
    StrCpy $WrenyardPathOverflow "1"
  wrenyardAddDone:
FunctionEnd

!macro customInstall
  WriteRegDWORD HKCU "${WRENYARD_PATH_REG_KEY}" "${WRENYARD_PATH_REG_VALUE}" $WrenyardAddToPath
  ${If} $WrenyardAddToPath == "1"
    Call WrenyardAddInstallDirToPath
  ${Else}
    Call WrenyardRemoveInstallDirFromPath
  ${EndIf}
!macroend

!else

!insertmacro WrenyardPathHelpers "un.Wrenyard"

; Uninstaller pass. A silent update runs the uninstaller with the `--updated`
; flag, so the PATH entry and the recorded choice must survive it. Only a real
; uninstall removes the entry and clears the stored decision.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    Call un.WrenyardRemoveInstallDirFromPath
    DeleteRegValue HKCU "${WRENYARD_PATH_REG_KEY}" "${WRENYARD_PATH_REG_VALUE}"
  ${EndIf}
!macroend

!endif
