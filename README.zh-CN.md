# orca-colab

[**English**](./README.md) | [**简体中文**](./README.zh-CN.md)

让 [Orca](https://github.com/stablyai/orca) 中的本地 Coding Agent 将 Google Colab GPU 作为自治远程算力后端使用。

- **人只设边界**：一键登录 Google 账号，设置允许使用的 GPU 级别、最大并发数与月度计算单元预算。
- **Agent 自治算力**：Agent 自动检查策略、按需开启或并发扩容多台实例、安装依赖、流式回传日志，并在任务完成后释放算力。
- **免配置直连**：默认通过 Google Colab Direct API 直连，无需配置 Tailscale 或手动操作浏览器（同时保留可选的 Tailscale SSH 模式）。

## 快速开始

### 1. 安装

```sh
orca plugin install github:vzxxbacq/orca-colab
```

本地开发加载或单独安装 Skill：

```sh
orca plugin dev load .
npx skills add vzxxbacq/orca-colab
```

### 2. 配置

1. 在 Orca 右侧打开 **Colab GPU** 面板，点击 **Sign in with Google**。
2. 在 **Guardrails & CU** 中设置允许的 GPU 级别与并发上限。
3. 直接让 Agent 执行 GPU 任务即可。

## CLI

完整命令参考：[`skills/colab-gpu/references/cli.md`](./skills/colab-gpu/references/cli.md)

```sh
orca-colab auth [login --add | list | switch <account>] --json
orca-colab doctor --json
orca-colab up [--new] [--account <account>] --json
orca-colab job submit --name "Train" --wait --json -- <cmd>
orca-colab run --json -- <cmd>
orca-colab sync [path] --json
orca-colab pull <remote> <local> --json
orca-colab down [--all] --json
```

## 远程 Orca 服务器

如果项目位于远程 Orca 服务器上，桌面端的 **Colab GPU** 面板显示的是该服务器上的会话、任务、实时输出和
Google 账号，而不是本机的。插件会在该工作区打开一个名为 `Colab Bridge` 的后台终端并通过它驱动
`orca-colab watch`，只复用你已有的 Orca 连接，不需要 SSH、守护进程或额外登录。若服务器 `PATH` 中没有
`orca-colab`，请在插件设置 **orca-colab command on remote Orca servers** 中填写命令（源码目录可填
`node /path/to/orca-colab/bin/orca-colab.mjs`）。此时面板上的 Google 登录在服务器上进行：打开面板给出的
链接并授权，然后把浏览器最终跳转到的 `http://127.0.0.1:…` 地址粘贴回面板（CLI 等价：`auth login
--no-browser` + `auth redirect <url>`）。本地项目的行为保持不变。

## 开源协议

MIT
