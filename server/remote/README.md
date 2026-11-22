# Pi GUI Remote · protocol v1（M0 冻结合同载体）

`contract-v1.json` 是移动仓库 `HYJ1817/pi-gui-ios` 权威合同 `docs/contracts/remote-v1.json`（status `frozen-v1`，冻结 commit 447d98f3f4f40401d03b5f225a037cfc5d1848a8）的逐字节镜像。任何改动必须先在移动仓库改合同并过门禁，再同步本文件；两侧不一致一律 fail closed。

`*.mjs` 是本合同的桌面端实现（M1-remote 进行中）：独立 listener、Ed25519 签名请求、每设备 scope/重放/撤销、原子配对交换。默认关闭，仅在 `PI_GUI_REMOTE_PORT` 设置时于独立端口监听；绝不拓宽 `127.0.0.1` 主服务或复用 `PI_GUI_TOKEN`。
