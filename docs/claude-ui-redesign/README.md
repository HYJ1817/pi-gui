# 旧版 UI 重构验收材料归档说明

2026-11-06 仓库清理：UI-1 至 UI-5 的历史测试截图、日志和 JSON 结果从当前 Git 工作树移除，原始内容保留在不可变的历史提交 `d5494993d8f57072b21528e7a00622d047625fa2`。旧验收报告仍保留在本目录，相关 Markdown 证据链接已改为指向该历史提交。

本次移除 4237 个历史证据文件，合计 416.4 MiB（436578307 字节）。清理仅缩小当前 checkout 和源代码压缩包；Git 历史中的旧对象仍存在，不会因此立即缩小已有完整克隆的 .git，也不涉及强推或重写提交历史。

归档入口：

- [ui-1-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui-1-evidence)
- [ui-2-c-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui-2-c-evidence)
- [ui2-followup-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui2-followup-evidence)
- [ui2-integration-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui2-integration-evidence)
- [ui2a-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui2a-evidence)
- [ui3-c-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui3-c-evidence)
- [ui3-integration-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui3-integration-evidence)
- [ui3a-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui3a-evidence)
- [ui3b-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui3b-evidence)
- [ui4-integration-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui4-integration-evidence)
- [ui4a-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui4a-evidence)
- [ui4b-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui4b-evidence)
- [ui4c-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui4c-evidence)
- [ui5-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui5-evidence)
- [ui5-main-integration-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui5-main-integration-evidence)
- [ui5-patch-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui5-patch-evidence)
- [ui5-visual-evidence](https://github.com/HYJ1817/pi-gui/tree/d5494993d8f57072b21528e7a00622d047625fa2/docs/claude-ui-redesign/ui5-visual-evidence)

说明：归档中的截图、日志、测试 JSON 是过去对应提交的证据，不代表最新代码通过测试。实际 CI 和运行测试需以当前 Commit 为准。不要把自动生成的历史证据重新提交到这些目录。
