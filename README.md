# DSH Plugins

DeepSeek Harness 插件合集。

| 插件 | 用途 |
| --- | --- |
| [DSH Agent 桥接插件](plugins/dsh-agent-bridge/) | 通过回环 REST 和 SSE 管理 DSH 工作区和 Agent 会话，供 Blueprint Studio 或其他本机工具调用。 |

克隆仓库后，可在目标 DSH profile 中安装本地插件。参见
[安装与配置](plugins/dsh-agent-bridge/README.md#安装)。

[marketplace.json](marketplace.json) 使用 Git 来源记录插件版本，固定到对应提交和插件路径。
仓库结构参考 [kadaliao/dsh-plugins](https://github.com/kadaliao/dsh-plugins)。
