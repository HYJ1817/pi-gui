# G2 CI 性能与稳定性基线

日期：2026-10-24。来源为 GitHub Actions `ci.yml` 最近 20 个已完成 run，覆盖 push 与 pull_request，**未按最终成功过滤**；两次重跑的首次失败/取消均保留。只读访问，未为采样触发新 CI。

## 样本与口径

[结构化聚合数据](G2-ci-baseline.json) 保留 run ID/URL、完整 SHA、event、每个 attempt 的开始/结束与结论、job ID/名称/起止时间/耗时和测试步骤时长。它是白名单投影及统计结果，不含原始日志、API token 或模型 payload。

样本窗口（UTC）：2026-10-21 17:26:08 至 2026-10-24 05:33:21；北京时间为 10 月 22 日 01:26:08 至 10 月 24 日 13:33:21。20 个唯一 run、22 个 attempt，重跑 run 2 个；不能称为 22 个独立样本。下表按每个 run 的**首次 attempt** 统计，失败/取消也计入分布；跳过 job 的运行时长为 unavailable，不当作执行零秒。

| Job | 有效耗时样本 | 平均秒 | 中位秒 | 最大秒 | P90 秒 | P95 秒 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| core | 20 | 393.15 | 398 | 617 | 587 | 608 |
| ui | 20 | 155.95 | 153.5 | 213 | 168 | 197 |
| security | 20 | 1174.85 | 1117 | 1739 | 1546 | 1635 |
| native | 20 | 863.35 | 842 | 1106 | 1052 | 1082 |
| faults | 20 | 958.90 | 842.5 | 3614 | 1209 | 1412 |
| Electron build check | 18 | 96.56 | 92.5 | 156 | unavailable | unavailable |
| Validate complete test plan | 20 | 32 | 31.5 | 50 | 47 | 48 |
| CI gate | 20 | 3.4 | 3 | 6 | 5 | 5 |

P90/P95 仅在至少 20 个耗时观测时给出经验 nearest-rank 值；这批样本少、提交及测试集合不同，尾部分位数仅作描述，不是稳定 SLA 或性能回归的精密证明。全部 attempt 的另一个统计视图在 JSON `groups` 中，明确按 attempt 加权，不混入上表。

- **Wall time**：首个 attempt 的 `run_started_at` 到最后 attempt 的最后可观察 job 结束。20 run 平均 1622.05 秒、中位 1332 秒、最大 5096 秒，P90 1778 秒、P95 3336 秒。
- **Runner time**：所有 attempt 中非 skipped job 的起止跨度之和；20 run 平均 4035.25 秒、中位 3616.5 秒、最大 10118 秒。并行 runner 的占用会相加，不能与 wall time 相互替代。
- **测试执行时间**：JSON job 的 `testExecutionMs` 来自 `Run canonical test group` 步骤，不包含 setup/install/upload；叶命令的进程计时只能由对应 artifact 获得。
- **重跑等待**：相邻 attempt 的前次最后 job 到下次 `run_started_at` 的间隔；两个 run 分别为 1153 和 531 秒。这是观测到的间隔，包含人工等待，不冒充排队时长。
- **排队**：缺少可靠的 job 入队时点，显示 unavailable；不从 createdAt 与依赖开始时间猜测。completedAt 来自可观察 job 的最大结束时间，不使用可能受后续操作影响的 run updated_at。

## 来源 run

全部完整 SHA、起止时间和逐 job 数据在相邻 JSON；此表便于直接打开来源。单 attempt 未标号时均为 attempt 1。

| Run | Event | Attempt 结果 | 全 run wall 秒 |
| --- | --- | --- | ---: |
| [40065343782](https://github.com/HYJ1817/pi-gui/actions/runs/40065343782) | push | success | 1257 |
| [40063960141](https://github.com/HYJ1817/pi-gui/actions/runs/40063960141) | pull_request | success | 1183 |
| [40061061150](https://github.com/HYJ1817/pi-gui/actions/runs/40061061150) | push | success | 1180 |
| [40060949475](https://github.com/HYJ1817/pi-gui/actions/runs/40060949475) | pull_request | success | 1024 |
| [40059313709](https://github.com/HYJ1817/pi-gui/actions/runs/40059313709) | pull_request | success | 1234 |
| [39976770700](https://github.com/HYJ1817/pi-gui/actions/runs/39976770700) | push | 1 failure → 2 success | 3336 |
| [39972192836](https://github.com/HYJ1817/pi-gui/actions/runs/39972192836) | pull_request | success | 1191 |
| [39925918451](https://github.com/HYJ1817/pi-gui/actions/runs/39925918451) | push | success | 1287 |
| [39922972162](https://github.com/HYJ1817/pi-gui/actions/runs/39922972162) | pull_request | success | 1378 |
| [39915263689](https://github.com/HYJ1817/pi-gui/actions/runs/39915263689) | push | success | 923 |
| [39912965495](https://github.com/HYJ1817/pi-gui/actions/runs/39912965495) | pull_request | success | 1200 |
| [39823004520](https://github.com/HYJ1817/pi-gui/actions/runs/39823004520) | push | success | 1073 |
| [39817859759](https://github.com/HYJ1817/pi-gui/actions/runs/39817859759) | pull_request | success | 1778 |
| [39796797262](https://github.com/HYJ1817/pi-gui/actions/runs/39796797262) | push | success | 1631 |
| [39789593782](https://github.com/HYJ1817/pi-gui/actions/runs/39789593782) | pull_request | success | 1685 |
| [39773851353](https://github.com/HYJ1817/pi-gui/actions/runs/39773851353) | push | success | 1377 |
| [39769635804](https://github.com/HYJ1817/pi-gui/actions/runs/39769635804) | pull_request | success | 1498 |
| [39746424693](https://github.com/HYJ1817/pi-gui/actions/runs/39746424693) | push | success | 1503 |
| [39742649727](https://github.com/HYJ1817/pi-gui/actions/runs/39742649727) | pull_request | success | 1607 |
| [39643761771](https://github.com/HYJ1817/pi-gui/actions/runs/39643761771) | push | 1 cancelled → 2 success | 5096 |

首次 attempt 成功 18/20（90%）、failure 1/20（5%）、cancelled 1/20（5%）；最终均成功不掩盖首次结果。22 attempt 中 faults 为 20 success / 1 failure / 1 cancelled；gate 为 20 success / 2 failure；build 为 20 success / 2 skipped；其余 job 均 success。API 没有 timed_out 结论。

## 慢路径与稳定性证据

security 的中位耗时最高；faults 的均值被一次接近一小时的 cancelled 执行显著拉高。[main e97ecf3 的 artifact](https://github.com/HYJ1817/pi-gui/actions/runs/40065343782) 可读取 193 条实际叶命令，全部退出 0；其前十慢项如下。这是该 run 的例子，不能当作全部 20 次都相同：

| 叶命令 | 组 | 秒 |
| --- | --- | ---: |
| session-revert-object-faults.cjs | faults | 407.573 |
| session-revert-object-writer.cjs | native | 381.807 |
| session-revert-object-runtime.cjs | native | 359.593 |
| session-revert-sacl-witness.cjs | security | 334.938 |
| session-revert-object-service.cjs | security | 264.408 |
| candidate-apply.cjs | native | 175.250 |
| candidate-runs.cjs | core | 144.594 |
| candidate-adoption.cjs | core | 132.550 |
| session-revert-inplace.cjs | security | 118.324 |
| session-revert-object-confirmation.cjs | security | 117.405 |

由此可定位 Native 元数据/权限见证、文件身份和故障恢复为主要观测热点；没有据此删除断言、缩短故障超时或并发执行安全用例。

两个异常 run 的有限日志核对：

- `39976770700` attempt 1，faults job `120493699409`：`pi-supervisor.cjs` 报 `pi_connect_timeout`。症状属于进程/连接生命周期，退出 1；不能仅据此确定是产品或权限环境的根因，保留 unknown。attempt 2 成功。
- `39643761771` attempt 1，faults job `119374161115`：先出现 `stop_unconfirmed`，后记录 `The operation was canceled`；API conclusion 为 cancelled，取消来源 unknown，不能自行改标 timed_out 或声称人为取消。attempt 2 成功，整体 wall 84 分 56 秒，包括 8 分 51 秒 inter-attempt gap。
- 未观察到同一种已确认根因在这批样本中重复失败。权限/文件系统、端口冲突或产品缺陷均缺少足够根因证据，不能把“未确认”写成“不存在”。

## 复现与 G3 候选

`node scripts/report-ci-history.mjs --repo HYJ1817/pi-gui --limit 20 --output <本机临时JSON>` 只读最新样本；随时间会改变窗口。固定本报告样本可用 `--input docs/G2-ci-baseline.json --output <临时JSON>` 重新计算，输入本身不修改。原始 Actions 日志和下载的五组 artifact 仅存本机 TEMP，不入仓。

G3 候选：先定位 guardian 连接/Stop 的异常收尾与超时证据；给最慢 Native/权限场景细分 setup/执行/cleanup 计时；在证明资源独立后再评估调度。当前 G2 保留五组、原安全断言、正常沙箱和发布政策，不实施这些优化。
