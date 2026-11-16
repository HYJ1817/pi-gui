# P4-D 原始测量数据

主记录见 [P4-D 验收](../../session-ux-phase4d-acceptance.md)。所有数据由
`tests/session-ux-phase4d-perf.cjs` / `tests/session-ux-phase4d-shots.cjs`
在真实 Chromium 中生成；夹具合成，不启动 Pi、不读写用户会话。

## 主对照

| 目录 | 内容 |
| --- | --- |
| `baseline/` | 改动前的原始基线（更早时间点，5 次运行） |
| `baseline-recheck/` | 同一工作树关闭分块阈值后的同步路径，紧邻最终 after 复测（5 次运行） |
| `after-final-clean/` | 最终代码、无并发主机命令的验收数据（5 次运行） |
| `after/` | 复审修复后、实时守卫完成前的实现（5 次运行） |
| `after-final/` | 最终代码复跑；测量期间有轻量主机命令并发，切换同步段出现一个 112 ms 样本，作方差参考 |
| `shots/` | 1320×820 / 700×600、深色 / 浅色视觉验收与 `shots-summary.json` |

`baseline` 与 `baseline-recheck` 的差异是机器负载漂移，不是代码差异；
验收记录同时给出两组对照，不把漂移包装成门槛通过。验收表使用
`after-final-clean`，`after/` 与 `after-final/` 只用于观察运行间方差。

## 探索性变体（不作为验收门槛）

这些目录是选型过程中实际跑过的变体，保留原始 JSON 供复核：

| 目录 | 变体 |
| --- | --- |
| `probe-nocontain/` | 同步路径 + 无 CSS containment 对照 |
| `probe-contain/` | 同步路径 + `.thread > * { contain:layout style }` |
| `probe-noread/` | 分块挂载不读取 `scrollHeight`，直接写 `scrollTop` |
| `probe-geo4096/` | 分块大小 160 起翻倍、4,096 封顶 |
| `probe-geo8192/` | 分块大小 160 起翻倍、8,192 封顶 |
| `probe-cap512/` | 分块大小 160 起翻倍、512 封顶 |
| `probe-buildchunks/` | 构建与挂载合并为同一批次的原型 |
| `probe-phases/` | 批次阶段插桩（构建/挂载/收尾） |
| `probe-sync-phases/` | 同步路径阶段插桩 |
| `chunk-experiment/` | 早期分块探索 |
| `cv-experiment/` | 早期 `content-visibility` 探索 |

每轮运行的 `summary.json` 含中位数、P95、样本数；`run-N.json` 含逐场景原始样本；
`profile-run-1.json` 含第一轮的 CPU profile 热点与 `Performance.getMetrics` 差值。

## 复现

```bash
# 最终实现（5 轮，验收口径）
P4D_PERF_LABEL=after-final-clean P4D_PERF_RUNS=5 node tests/session-ux-phase4d-perf.cjs

# 视觉验收（8 张截图）
node tests/session-ux-phase4d-shots.cjs
```

`baseline/` 是改动前在旧提交上运行同一脚本得到的；`baseline-recheck/` 是同一工作树
临时把 `HISTORY_CHUNK_MESSAGES` 设为 `Infinity`（关闭分块）后紧邻最终 after 运行，
用于消除机器负载漂移。该临时改动不进入提交。测量期间不要并发运行其它命令：
`after-final/` 与 `after-final-clean/` 是同一代码的两次复跑，唯一区别就是主机负载，
可作为方差参考。
