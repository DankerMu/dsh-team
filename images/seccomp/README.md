# images/seccomp

用户实例的 seccomp 配置：钉定的 Moby 默认策略，无额外放宽。

## 来源

- URL：`https://raw.githubusercontent.com/moby/profiles/seccomp/v0.2.3/seccomp/default.json`
- 标签：`seccomp/v0.2.3`
- 原始字节 SHA256（下载后、接受前核验）：`536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`
- 本目录提交文件 SHA256：`63814f70abf4cec5a49d573d97342e24bf37c98eca0035599040cefa44bb86cc`

提交文件按仓库 Prettier JSON 约定重排空白（2 空格、LF、末尾换行），`JSON.parse` 与上游 deep-equal。未增加 syscall allow、未改 `defaultAction` / `defaultErrnoRet`、未做自定义裁剪。提交文件哈希 ≠ 上游钉；不要把格式化后的字节当成 `536529b6…4c74`。

## 许可证

`moby/profiles` 在 `seccomp/v0.2.3` 的 `LICENSE` 为 Apache License 2.0，已原样放在本目录 `LICENSE`（SHA256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`）。同标签 Go 源文件声明 `Copyright The Moby Authors.` / `SPDX-License-Identifier: Apache-2.0`。`default.json` 本身无版权头；该标签无 NOTICE 文件。

## 容器选项合同

Docker 用法是显式文件路径：

```text
--security-opt seccomp=<images/seccomp/dsh-user.json 的绝对路径>
```

编排器读入本文件内容再交给 Engine API。禁止：`--cap-add`、`--privileged`、`systempaths=unconfined`、`seccomp=unconfined`。

`scripts/probe-sandbox.sh` 的 custom-seccomp 级会在默认策略上**额外** allow `clone,unshare,mount,umount2,pivot_root`。那是探针梯子的放宽候选，不是本文件。本文件是未改动的上游默认。

## 最小性

额外放宽集合为空。规格「去掉该组合里任意一项放宽后重跑」对本产物明确为 N/A，不是漏测。不要用随意删 syscall 伪造「去掉一项」。另以移除 Landlock syscall allow 的临时策略作负对照，真实 DSH 工具报告 `SANDBOX_UNAVAILABLE`、容器退出 1；这是失败检测证据，不是空放宽集合的删除试验。

## 验证状态

2026-10-03 在 giap-vps（Ubuntu 24.04、Linux `6.8.0-117-generic`、amd64、Docker 29.1.3）分别验证 Docker 引擎内嵌默认和显式 `seccomp=<本文件>`：两者均以 uid 1001 运行真实 DSH `0.2.0-rc.2` bash 工具，工作区写入/读回匹配，状态目录出现明确 sandbox denial 且未创建文件，容器退出 0。保留了 `landlock-run: partial enforcement (older Landlock ABI)` 警告；未声称两份策略字节相同，也未把局部写入测试等同于全部 Landlock 特性保证。阶段 0 的 arm64 Docker Desktop 需要 seccomp 与 systempaths 放宽，与本次结果不同；差异根因尚未证明。Ubuntu 22.04 仍由项目方执行探针并独立验证这份显式策略，不可直接继承 VPS 结论。

## 用现有 driver 跑这份文件

根入口 `pnpm probe:sandbox` 仍是三级梯子（先测引擎内嵌默认），不会把本文件传给 Docker。要证明本文件，在装有 Docker 和 GNU timeout 的 Linux 宿主（giap-vps）上对**这份 JSON** 跑现有 `scripts/probe-sandbox-bash-tool.mjs`。下例保留容器到 EXIT 清理，检查实际容器退出状态，不把日志中的成功文本单独当作通过；只删除本次唯一资源，不做全局 prune。

```sh
set -eu
run_id="$(date +%s)-$$"
prefix="dsh-team-seccomp-explicit-${run_id}"
image="${prefix}-image"
container="${prefix}-container"
profile="$(pwd)/images/seccomp/dsh-user.json"
driver="$(pwd)/scripts/probe-sandbox-bash-tool.mjs"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  failed=0
  docker rm -f "$container" || failed=1
  docker image rm "$image" || failed=1
  if [ "$status" -eq 0 ] && [ "$failed" -ne 0 ]; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker build -t "$image" -f images/dsh-user/Dockerfile images/dsh-user
timeout --foreground 90 docker run --name "$container" --user 1001:1001 \
  --security-opt "seccomp=${profile}" \
  --mount "type=bind,src=${driver},dst=/probe/probe-sandbox-bash-tool.mjs,ro" \
  "$image" node /probe/probe-sandbox-bash-tool.mjs
```

成功时容器日志有且仅有一行 `PROBE_RESULT`，且 `usable` / `wsOk` / `stateDenied` 为 true、`statePresent` 为 false（工作区字节精确匹配、状态目录拒绝写入且标记文件不存在）。结束后不得留下本次前缀的镜像或容器。

## 行数与 diff-limit-exempt

保留可读 JSON，不压缩以规避 400 行门禁。本策略超过 400 行；PR 使用 `diff-limit-exempt`，理由：钉定上游默认 seccomp 的原子可审计交付，格式化不改变策略语义。不要改 CI 或 format ignore 来绕过检查。
