; ---------------------------------------------------------------------------
; Pi GUI 安装程序（NSIS 3，Unicode）
;
; 由 scripts/build-installer.mjs 用 /D 注入下面这些宏后编译，
; 不要在这个文件里手写具体版本号或路径：
;   APP_NAME      应用名（"Pi GUI"）
;   APP_EXE       主程序文件名（"Pi GUI.exe"）
;   VERSION       版本号
;   PUBLISHER     发布者
;   APP_DIR       待打包的应用目录（dist-app\Pi GUI-win32-x64）
;   ICON_FILE     安装程序图标（build/icon.ico）
;   ESTIMATED_KB  安装后体积（KB），用于「添加或删除程序」里的显示
;   OUT_FILE      输出的安装程序路径
;
; 几个刻意的选择（改之前先读）：
;   * 装在 $LOCALAPPDATA\Programs 而不是 Program Files —— 单用户、不弹 UAC。
;     收件人双击就能装完，不会被权限提示拦住，也不会往系统目录里写东西。
;   * 卸载只删程序文件，**不删用户数据**（%APPDATA%\pi-gui 里的项目列表、
;     窗口布局）。删掉别人的项目列表是很伤的，而重装本来也不需要它。
; ---------------------------------------------------------------------------

Unicode True

; 固体压缩：300 多 MB 里有大量已压缩的 .pak/.dll，固体 LZMA 能把重复段压掉。
; 字典给到 64 MB（默认 8 MB 对这种体量不够用）。
SetCompressor /SOLID lzma
SetCompressorDictSize 64

RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"
Name "${APP_NAME} ${VERSION}"
OutFile "${OUT_FILE}"
Icon "${ICON_FILE}"
BrandingText "${APP_NAME}"

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_WELCOMEPAGE_TITLE "${APP_NAME} 安装向导"
!define MUI_WELCOMEPAGE_TEXT \
  "将把 ${APP_NAME} 安装到你的用户目录，不需要管理员权限。$\r$\n$\r$\n\
  ${APP_NAME} 是 pi-coding-agent 的图形界面：**它需要本机已经装好 pi**。\
  界面靠 pi 与模型通信，没有 pi 的话程序能打开但无法对话。$\r$\n$\r$\n\
  点击“下一步”继续。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 ${APP_NAME}"
!define MUI_FINISHPAGE_TEXT \
  "${APP_NAME} 已安装完成。$\r$\n$\r$\n\
  第一次打开时先点左侧的“添加文件夹”选一个项目目录 —— 程序不会替你猜，\
  也不会默认落在某个目录里。$\r$\n$\r$\n\
  如果你的 pi 还没装好，现在装上再打开。"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------------------
; 宏检查。
;
; 少了哪个宏就立刻报错，不要硬着头皮往下编 —— 实测过：OUT_FILE 没定义时
; NSIS 会把字面量 ${OUT_FILE} 当成文件名，在脚本目录里生成出一个叫
; "${OUT_FILE}" 的 100 MB 文件，然后照样打印 "Total size"，看起来像成功了。
; 这种「编译成功但产物不在你以为的地方」最难查，所以这里显式挡掉。
!ifndef APP_NAME
  !error "APP_NAME 未定义 —— 请用 scripts/build-installer.mjs 编译"
!endif
!ifndef APP_EXE
  !error "APP_EXE 未定义"
!endif
!ifndef VERSION
  !error "VERSION 未定义"
!endif
!ifndef APP_DIR
  !error "APP_DIR 未定义"
!endif
!ifndef ICON_FILE
  !error "ICON_FILE 未定义"
!endif
!ifndef OUT_FILE
  !error "OUT_FILE 未定义"
!endif

; ---------------------------------------------------------------------------
; 安装前：把正在跑的实例关掉。
;
; 不关的话主 exe 被占用，NSIS 覆盖写入会失败，收件人只会看到“写入错误”。
; 用 tasklist + findstr 的**退出码**判断在不在跑 —— 不能去匹配输出文本，
; 中文系统的 tasklist 提示语是“信息: 没有运行的任务匹配指定标准。”，
; 靠文本匹配会在别的语言环境下失效。
; ---------------------------------------------------------------------------
Function CloseRunningInstance
  nsExec::ExecToStack 'cmd /c tasklist /NH /FI "IMAGENAME eq ${APP_EXE}" | findstr /I /C:"${APP_EXE}"'
  Pop $0 ; 退出码：findstr 找到 = 0
  Pop $1 ; 输出（不用）

  ${If} $0 == 0
    ; /SD 是必须的：NSIS 的 /S 只跳过向导页，**不会抑制 MessageBox**。
    ; 没有 /SD 时，静默安装会弹出这个框一直等人点 —— 升级脚本、CI、
    ; 以及本仓库的 test:installer 都会永久挂住。加了 /SD 之后，
    ; 静默模式自动按「确定」处理，即自动关掉正在运行的实例再继续。
    ; /SD 必须写在**文本之后**（写成 options 和文本之间会让 NSIS 把文本当成
    ; 跳转标签，报 could not resolve label）。
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "${APP_NAME} 正在运行，需要先关闭它才能继续。$\r$\n$\r$\n点“确定”自动关闭并继续。" /SD IDOK IDOK do_close
    ; 走到这里说明用户点了“取消”。同样加 /SD，避免静默模式下卡住。
    MessageBox MB_ICONSTOP|MB_OK "安装已取消。请手动关闭 ${APP_NAME} 后重新运行本安装程序。" /SD IDOK
    Quit
do_close:
    ExecWait 'taskkill /IM "${APP_EXE}" /F /T'
    Sleep 1200 ; 等系统把文件句柄真的放掉，不然下一秒写入还是会被锁
  ${EndIf}
FunctionEnd

Section "主程序" SEC_MAIN
  SectionIn RO
  Call CloseRunningInstance

  SetOutPath "$INSTDIR"
  File /r "${APP_DIR}\*.*"

  ; 卸载信息写在 HKCU —— 和「单用户安装」保持一致，
  ; 否则会出现「装在用户目录、卸载入口却要求管理员」的怪事。
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" \
    "DisplayName" "${APP_NAME} ${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" \
    "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" \
    "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" \
    "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" \
    "DisplayIcon" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" \
    "UninstallString" "$INSTDIR\Uninstall ${APP_NAME}.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" \
    "QuietUninstallString" '$INSTDIR\Uninstall ${APP_NAME}.exe /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" \
    "EstimatedSize" "${ESTIMATED_KB}"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" \
    "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" \
    "NoRepair" 1

  WriteUninstaller "$INSTDIR\Uninstall ${APP_NAME}.exe"

  ; 快捷方式的图标直接取自 exe（索引 0）—— 不用单独带一份 .ico
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" \
    "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" \
    "$INSTDIR\Uninstall ${APP_NAME}.exe"
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" \
    "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
SectionEnd

Section "Uninstall"
  Call un.CloseRunningInstance

  RMDir /r "$INSTDIR"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\${APP_NAME}.lnk"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
  DeleteRegKey HKCU "Software\${APP_NAME}"
SectionEnd

Function un.CloseRunningInstance
  nsExec::ExecToStack 'cmd /c tasklist /NH /FI "IMAGENAME eq ${APP_EXE}" | findstr /I /C:"${APP_EXE}"'
  Pop $0
  Pop $1
  ${If} $0 == 0
    ExecWait 'taskkill /IM "${APP_EXE}" /F /T'
    Sleep 1200
  ${EndIf}
FunctionEnd
