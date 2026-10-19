# NSIS 发布依赖故障修复记录

## 故障与范围

v0.26.1 发布四次在 Chocolatey NSIS 3.13.0 元数据查询遇到 HTTP 503。
Chocolatey 未安装任何包，却以成功状态结束步骤；后续构建在找不到 makensis 时失败。
没有生成新 Release。既有 v0.26.1 tag 保留，不移动。

本次只修改发布工具链及其回归测试；不改业务代码或外部 Pi。

## 修复方案

- Release 与手动 Release check 共用 scripts/install-ci-nsis.mjs。
- 固定官方 SourceForge 的 NSIS 3.13 安装程序；SHA256 来自微软 WinGet 清单：
  https://github.com/microsoft/winget-pkgs/blob/master/manifests/n/NSIS/NSIS/3.13/NSIS.NSIS.installer.yaml
- 固定摘要为 db9a1038bbc0e53fef24f423fd609979bd578e942f1be1198db186d1c42652a3。
- 下载最多三次，单次 60 秒、大小最多 10 MiB；摘要不符不落盘、不执行。
- 仅允许 Windows GitHub Actions runner 执行；安装成功后立即验证编译器版本。
- 验证成功才导出 NSIS_HOME，后续构建使用已验证的同一编译器。
- 保留精确 SHA CI 证明、最终 CI gate、真实安装卸载、产物及上传摘要验证。

## 已完成验证

- 真实下载安装程序至本机临时目录，Get-FileHash 与固定摘要相同；未执行安装程序。
- node tests/nsis-bootstrap.cjs：12/12；全部使用临时 fixture、模拟下载或模拟进程。
- npm run test:ci：测试计划、workflow、CI proof 16/16、NSIS 回归均通过。
- node tests/release-artifacts.cjs：77/77。
- node tests/version-consistency.cjs：34/34。
- git diff --check 通过；未增加依赖或扩大 Token 权限。
- 独立功能与安全审查均通过，Blocker 0 / Important 0。
  首轮指出的编译器路径绑定问题已修复，并新增只在成功后导出的回归测试。

## 待验证与恢复边界

首次修复提交的 CI 四组测试通过，security 及后续 gate 尚未取得完整成功。
部分重跑持续 queued，取消接口却报告运行已完成；不能将此状态当成通过。
需用新的 main 提交执行完整 CI，只有该精确 SHA 的完整运行和最终 gate 成功后才能推 tag。
真实 NSIS 安装、安装包构建、安装卸载与正式上传的验收以 Release 实测为准。

计划发布版本为 v0.26.2。Stop 真供应商验收此前因 HTTP 502 未通过，发布说明保留限制。
生产恢复资格仍为 NO-GO。回滚此工具链修复可恢复原 Chocolatey 下载流程，但它仍可能返回 503。
