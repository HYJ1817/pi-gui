# 测试夹具

## `tool-history.json`

`get_messages` 返回值的**真实样本**，用来验证「刷新页面后从历史重建工具时间线」
这条路径（见 `public/tool-history.js`）。

手写的假数据只能证明「代码符合我对协议的想象」；这一份是用来证明
「协议本来就是这样」的 —— 尤其是那几条只靠读文档很容易搞错的地方：

- `toolResult` 是**独立的一条消息**，不在 `assistant.content[]` 里；
- 配对键是 `toolResult.toolCallId === toolCall.id`；
- 一条 `assistant` 消息可以带**多个** `toolCall`（这份里有 3 个和 2 个的），
  后面跟同样多条 `toolResult`；
- `tool_execution_end` 之外，历史里**没有**工具级的起止时间戳，时长只能估；
- `bash` 的 `details` 里**没有**退出码，失败信息在输出文本的末尾；
- `edit` 的 `details` 是 `{ diff, patch, firstChangedLine }`。

### 来源

从本机 pi 会话记录里切出的一段（`type: "message"` 记录按原顺序取），
共 55 条消息：3 条 user、25 条 assistant、27 条 toolResult，27 次工具调用
（`bash` 15 次、`read` 9 次、`write` 2 次、`edit` 1 次），其中 5 次 `isError`，
退出码分别是 35 / 35 / 1 / 2 / 1。有 4 组多调用（分别是 3 / 2 / 2 / 2 个）。

### 脱敏规则

源数据里含私有项目源码、命令输出与第三方站点标识，全部替换掉了。
**只改字符串，不改结构** —— 角色、`content` part 的类型与顺序、字段名、
`details` 的键、时间戳的相对差值、`isError` 全部保持原样。

| 类别 | 处理 |
|---|---|
| 绝对路径里的用户名 | `…\Users\21022\…` → `…\Users\dev\…` |
| 命令输出里的 uid/gid 列 | `21022` → `dev` |
| 第三方站点 | `*.moe` / `*.xyz` / `*.org` / `*.vip` → `*.example.test` |
| 私有项目名 | → `my-addon` / `my-widgets` / `MyWidget` 等中性名 |
| 凭证 | cookie / token 的值整体换成 `(已脱敏)` |
| `thinkingSignature` | 几十 KB 的不透明签名 blob，换成固定占位串（对协议形状零信息量） |

### 截断

长正文保留**头尾**各 120 字符，中间标注省略了多少字符。

只留头是不行的：`bash` 失败时 pi 把退出码写在输出的**最后一行**
（`Command exited with code N`），而「退出码只能从输出文本解析」正是最需要
被真实数据覆盖的一条规则 —— 只截头会让这份夹具里所有错误用例的退出码
凭空消失，测试就退化成了「测一个我自己编的字符串」。

### 测试怎么用它

`tests/smoke.cjs` 里「Tool Timeline：真实会话 fixture」那一段：
先核对夹具自身自洽（每条 `toolCall` 都有 `toolResult`、没有孤儿），
再把整份丢给 `rebuildFromMessages`，然后拿 DOM 和**数据本身算出来的期望值**
逐项比对（条目数、分组数、失败数、退出码、`+N −M`、是否产生活元素、
是否留下空白「Pi」）。刻意不写死数字 —— 夹具换了，断言跟着走。

退化情况（缺 `toolResult`、孤儿 `toolResult`）在这份夹具里不存在
（原始会话 125 次调用里只有 1 个缺结果，不在这一段里），所以那两条用例
用现场构造的最小消息验证，而不是去改夹具。
