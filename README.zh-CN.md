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

## 远程 Orca 服务器（Beta）

如果项目位于远程 Orca 服务器上，桌面端的 **Colab GPU** 面板显示的是该服务器上的 Colab 状态，而不是本机的：
它的运行时、Agent 任务和实时输出、算力估算和 Google 账号。本地项目的行为保持不变；顶栏的标识会告诉你当前看的是哪一边
（`Local · <主机>` 或 `Server · <主机>`）。

**实现方式：Bridge Terminal。** Orca 没有给插件在远程服务器上执行代码的接口，终端是唯一通道，所以插件为每台服务器
维护一个名为 `Colab Bridge · <服务器>` 的终端，里面运行 `orca-colab watch`。这个进程把服务器状态编码成紧凑的帧流回传，
并接收面板动作作为输入命令；插件通过本机 `orca` CLI、复用你已有的服务器连接，在第一个需要它的项目里打开该终端，
同一服务器上的其他项目共用它。请让它一直运行；关掉后面板会重新打开。不安装任何额外东西，不开端口，不需要 SSH 或 VPN。

设置项：

- **orca-colab command on remote Orca servers**：在服务器上启动 `watch` 的命令。默认用 `npx` 拉取本仓库；
  服务器上有源码时填 `node /path/to/orca-colab/bin/orca-colab.mjs`。
- **Open the bridge terminal on remote servers automatically**：关闭后由你自己启动终端，面板会给出准确的命令。

面板上的 Google 登录在你本机浏览器完成；token 先用服务器端 `watch` 进程的密钥加密（X25519 + AES-256-GCM）再经终端传输，
本机不保存任何凭据。护栏、预算、Keep 等修改在面板上即时生效，服务器在一两秒内确认，失败会弹出提示。

Beta 阶段的已知限制：桥接终端是可见的（Orca 没有隐藏终端）；面板跟随聚焦项目约有 1 秒延迟；实时输出只显示所选任务的
最后 120 行；本机和服务器上同名同分支的项目，只有在其中一方开了终端时才能可靠区分；浏览器客户端不运行插件 worker，
该功能仅限桌面应用。

## 开源协议

MIT
