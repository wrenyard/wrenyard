<div align="center">

<img src="packages/themes/src/paper/assets/icon-256.png" width="96" alt="" />

# 啾啾工坊 Wrenyard

**本地优先的 AI 工程编排工作台。**

一次对话专注推理目标；探索、编辑、测试、提交以并行任务在你已经付费的模型上运行，
每一个 token、每一个额度窗口、每一个任务都看得见。

[![Release](https://img.shields.io/github/v/release/wrenyard/wrenyard?include_prereleases&label=latest-dev)](https://github.com/wrenyard/wrenyard/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) · [下载](https://github.com/wrenyard/wrenyard/releases) · [观看 77 秒演示](docs/media/wrenyard-desktop-promo.mp4)

</div>

![啾啾工坊](docs/images/hero.png)

> **开发预览版。** 以 `1.0.0-dev.N` 滚动发布预览版本，作者日常在用，但尚不是稳定版，
> 见[状态](#状态)。

## 为什么是啾啾工坊

- **贵的只用来推理。** 主模型只负责推理和标注要做的事；收集上下文、派发任务、撰写回复
  交给便宜模型和任务运行时。
- **上下文可审计。** 每个会话是一条只追加的账本。发送之前，就能看到所选模型下
  *下一次*推理请求有多大、由什么构成、如何增长。
- **你的供应商，你的额度。** Claude、ChatGPT、Kimi、智谱、Cursor、DeepSeek 等并排列出
  剩余额度、配速与重置时间；任务路由自动权衡价格、速度、额度与能力。
- **本地优先。** 本地 daemon 通过仅限当前用户的 IPC 管理任务与状态，不托管任何服务，
  除了你发出的模型请求，数据不离开本机。

## 功能一览

**会话即工作台**：一轮对话可以派发 `explore`、`edit`、`test`、`commit` 等任务到各个项目；
时间线和原始账本在检查器中一键可见。

**发送前就知道上下文有多大**：发送按钮旁的圆环显示下一次推理的预估占用、缓存命中率，
以及当前模型供应商的额度；展开看构成，或在检查器中做完整审计：按层与条目的构成、
按轮增长、换模型预演、各角色调用费用。

<table>
  <tr>
    <td><img src="docs/images/context-meter.png" alt="上下文仪表" /></td>
    <td><img src="docs/images/context-inspector.png" alt="检查器中的上下文审计" /></td>
  </tr>
</table>

**额度、配速、重置一目了然**：模型供应页每个供应商一行；状态栏始终显示最紧张的额度窗口，
用尽之前提醒你。

![模型供应](docs/images/providers.png)

**工房台账**：调度次数、Token 消耗、完成率与任务耗时，附一年的活跃热力图。

![工房台账](docs/images/ledger.png)

**主题**：温暖的「纸本」与 shadcn 风格的「简约」，各有浅色与深色，可跟随系统；
设置页可搜索。

![主题](docs/images/themes.png)

## 安装

在 [Releases](https://github.com/wrenyard/wrenyard/releases) 下载对应平台的安装包：

| 平台 | 文件 |
| --- | --- |
| macOS（Apple 芯片） | `wrenyard-desktop-<version>-darwin-arm64.dmg` |
| Windows（x64） | `wrenyard-desktop-<version>-win32-x64-setup.exe` |

应用自带 `wrenyard` 命令行、Node 运行时与 daemon，无需其他依赖。

**首次启动**：预览版在 macOS 上为 ad-hoc 签名、在 Windows 上未签名，系统会拦截一次：

- **macOS**：打开「系统设置 → 隐私与安全性」，选择「仍要打开」。
- **Windows**：在 SmartScreen 提示中选择「更多信息 → 仍要运行」。

**更新**：应用会检查更新、校验下载文件的 SHA-256，由你决定何时安装；需从菜单栏 / 托盘完全退出后才会应用。

## 命令行与源码

命令行用法、内置任务、源码构建与仓库结构见[英文 README](README.md)，开发流程见
[开发指南](docs/development.md)。

## 状态

目前为 macOS（Apple 芯片）与 Windows（x64）滚动发布 `1.0.0-dev.N` 预览版。稳定版之前还需要可信代码签名、
更广泛的干净环境测试与兼容性策略。

## 许可

[MIT](LICENSE)。
