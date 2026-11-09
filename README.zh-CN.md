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

## 开源协议

MIT
