#!/usr/bin/env bash
# tools/membership/gen-node-keys.sh —— 在**目标机器上**生成一个新节点的 staking 材料，
# 并只打印**公开材料**（功能 005 / T030 / FR-019）。
#
# ## 私钥不离开这台机器
#
# 005 的安全约束：新验证者的私钥（staking TLS key、BLS signer key）**必须在目标机器上
# 生成，不得经过仓库、对话或任何中间环节**。只有公开材料参与注册。
#
# 本脚本据此设计：
#   - 三个文件落在本机的 keyDir 里，**不提交、不外传**（.gitignore 已排除）
#   - 打印出来的只有 NodeID、BLS 公钥、以及三个文件的 **sha256 指纹**
#   - 指纹不是私钥：容器的 check_key_material() 靠它们确认挂进去的是同一份材料，
#     而 32 字节熵的秘密，公开其 sha256 只能用来核对一个猜测
#
# **绝不要把 staker.key 或 signer.key 的内容贴进任何地方。**
#
# ## 为什么用 avalanchego 自己生成
#
# 既有五个节点的材料是 Avalanche CLI v1.9.6 生成的，而 ADR-0008 已让 CLI 退出运行时。
# 用 openssl 复制那套参数（X.509 v3 / 序列号 0 / ecdsa-with-SHA256 / Issuer 与 Subject
# 均为空 / Not Before 1999-12-31 / EC P-256）容易出偏差，而偏差的表现是
# avalanchego 拒绝加载，或者派生出的 NodeID 与注册在链上的对不上。
#
# 实测（2026-09-14）：avalanchego **不会**在 `--staking-*-file` 指定的路径上生成 ——
# 会直接报 `couldn't find staking key`。只在**默认位置** `<data-dir>/staking/` 生成。
# 所以这里让它在一个临时 data-dir 里跑二十几秒，再把三个文件搬到 keyDir。
# 生成出的证书参数与 CLI 那批**逐项一致**（已比对）。
#
# 身份也由 avalanchego 自己给出：它在启动日志里打印 nodeID 与 nodePOP.publicKey，
# 所以这台机器**不需要装 node/npm**。
#
# 用法：
#   tools/membership/gen-node-keys.sh <节点序号> [镜像]
#   例：tools/membership/gen-node-keys.sh 6
#
# 退出码：0 成功；10 依赖或参数问题；13 生成出的材料不完整
set -euo pipefail

EXIT_DEPS=10
EXIT_INCOMPLETE=13

INDEX="${1:-}"
IMAGE="${2:-karmachain/node:local}"

case "${INDEX}" in
  ''|*[!0-9]*) echo "用法: $0 <节点序号> [镜像]   例: $0 6" >&2; exit ${EXIT_DEPS} ;;
esac

cd "$(dirname "$0")/../.."
KEYDIR="blockchain/validators/dev/node-${INDEX}"

command -v docker >/dev/null 2>&1 || { echo "需要 docker" >&2; exit ${EXIT_DEPS}; }
command -v jq >/dev/null 2>&1 || { echo "需要 jq" >&2; exit ${EXIT_DEPS}; }
command -v sha256sum >/dev/null 2>&1 || { echo "需要 sha256sum" >&2; exit ${EXIT_DEPS}; }

if [ -e "${KEYDIR}/staker.key" ]; then
  echo "" >&2
  echo "${KEYDIR}/staker.key 已存在 —— **不覆盖**。" >&2
  echo "" >&2
  echo "  重新生成会换掉这个节点的身份：NodeID 变了，而链上注册的是旧的那个。" >&2
  echo "  确实要重来，先手工移走整个目录，并且记住链上那条注册要退掉。" >&2
  exit ${EXIT_DEPS}
fi

# --- docker 能不能用，和镜像在不在，是**两件事** -----------------------------
#
# 初版把它们混成一句「找不到镜像，先 docker build」。而在一台刚 usermod 还没重新登录的
# 机器上，`docker image inspect` 失败的真实原因是**权限不足** —— 报"找不到镜像"会把人
# 引去重新构建一个已经存在的镜像。两种失败要分开说。
DOCKER=docker
if ! docker info >/dev/null 2>&1; then
  echo "docker 不能直接用（本用户不在 docker 组，或 usermod 后还没重新登录）。" >&2
  echo "  试着用 sudo 调它 —— 可能要输密码。" >&2
  echo "  **只有 docker 走 sudo**，生成的文件仍属于你自己（容器带 --user）。" >&2
  if sudo docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
  else
    echo "" >&2
    echo "连不上 docker。两种情况：" >&2
    echo "  1. 本用户不在 docker 组：sudo usermod -aG docker \$USER，然后**重新登录**" >&2
    echo "  2. docker 服务没起：sudo systemctl start docker" >&2
    echo "" >&2
    echo "  **不要整条 sudo 跑本脚本** —— 那样生成的文件属主是 root，" >&2
    echo "  接下来 git 的任何操作都会撞到属主问题（2026-09-14 在 ubuntu-1 上刚栽过：" >&2
    echo "  早先某次 sudo git 让 .git/objects 变成 root 属主，git pull 直接失败）。" >&2
    exit ${EXIT_DEPS}
  fi
fi

${DOCKER} image inspect "${IMAGE}" >/dev/null 2>&1 || {
  echo "" >&2
  echo "docker 可用，但**找不到镜像** ${IMAGE}。先构建：" >&2
  echo "  docker build -f docker/node/Dockerfile --build-arg TARGETARCH=\$(dpkg --print-architecture) -t ${IMAGE} ." >&2
  exit ${EXIT_DEPS}
}

# 网络 / 链 id 一律从唯一事实来源读 —— 002 的 no-hardcode 守卫第八次在这儿抓到我。
# 脚本里写死这两个数的后果不是脚本坏掉，而是**换一条链时它静默地还对着旧网络生成**。
NETWORK_ID="$(jq -er .avalanche.networkId blockchain/protocol.json)"
CHAIN_ID="$(jq -er .chain.chainId blockchain/protocol.json)"

# 临时目录默认在 /tmp，但**有些 docker 装法 bind-mount 不了 /tmp**（snap 装的 docker
# 受严格约束；远程或 rootless daemon 的 /tmp 也不是宿主这个 /tmp）。
# 那种情形下容器跑得很好、往 /out 写得很好，而宿主这边看到的是空目录 ——
# 于是下面的判据会以为 avalanchego 什么都没生成。留一个出口，并在探测到时指出它。
if [ -n "${KARMACHAIN_WORKDIR:-}" ]; then
  mkdir -p "${KARMACHAIN_WORKDIR}"
  WORK="$(mktemp -d -p "${KARMACHAIN_WORKDIR}")"
else
  WORK="$(mktemp -d)"
fi
RUNLOG="$(mktemp)"
cleanup() { rm -rf "${WORK}" "${RUNLOG}"; }
trap cleanup EXIT

echo "在本机生成 node-${INDEX} 的 staking 材料（约 30 秒）…" >&2

# 端口给得很高且只绑回环：这个临时节点不该被任何人连上，也不该撞到正在跑的节点。
#
# ## 容器该以什么身份跑，**不能推断，要现场探一次**
#
# 默认带 `--user "$(id -u):$(id -g)"`，让容器以调用者身份写文件。少了它，
# avalanchego 以 root 生成 staker.key（0600、属主 root），后面这个脚本以普通用户
# cp 就**读不出来** —— 而那时报的是一句 Permission denied，看不出根因在运行身份上。
#
# 但 uid 一旦被命名空间重映射（rootless daemon，或 daemon 开了 userns-remap），
# 容器里的 1000 在宿主侧就是另一个 subuid，于是它写不进 mktemp 建出来的
# 那个属主为本用户、mode 700 的目录。2026-09-21 在 ubuntu-5 上实测到：
#
#     uid=1000 gid=1000 groups=1000
#     sh: 4: cannot create /out/mount-check: Permission denied
#
# 那种情形下**不带** --user 才对：容器 root 映射到本用户，文件落在宿主上就归本用户。
# 两种装法要的恰好相反，所以探一次再定，不靠猜。
#
# 判据是**往返**的：容器写得进去，而且宿主读得回来、删得掉。
# 只验"容器写成功"会漏掉 userns-remap —— 那时容器写得很好，
# 而文件属主是宿主读不了的 subuid，于是失败会推迟到 cp 那一步才暴露。
probe_identity() {
  rm -f "${WORK}/probe" 2>/dev/null || true
  ${DOCKER} run --rm --entrypoint sh "$@" -v "${WORK}:/out" "${IMAGE}" \
    -c 'echo ok > /out/probe' >/dev/null 2>&1 || return 1
  [ "$(cat "${WORK}/probe" 2>/dev/null || true)" = ok ] || return 1
  rm -f "${WORK}/probe" 2>/dev/null || return 1
  return 0
}

USER_ARGS=(--user "$(id -u):$(id -g)")
if probe_identity "${USER_ARGS[@]}"; then
  : # 普通 rootful docker —— 用调用者身份，文件属主正确
elif probe_identity; then
  USER_ARGS=()
  echo "  这套 docker 把 uid 重映射了（rootless 或 userns-remap）——" >&2
  echo "  改为不带 --user 运行：容器 root 会映射到本用户，文件属主仍然正确。" >&2
else
  echo "" >&2
  echo "**宿主与容器之间来不了文件。** 两种身份都探过了：" >&2
  echo "    带 --user $(id -u):$(id -g) → 不通" >&2
  echo "    不带 --user               → 也不通（写不进，或宿主读不回）" >&2
  echo "" >&2
  # 已经设过 KARMACHAIN_WORKDIR 还失败，就不该再劝人去设它 ——
  # 那是一句朝错误方向的提示，而那比没有提示更坏（2026-09-21 用桩当场演示到）。
  if [ -n "${KARMACHAIN_WORKDIR:-}" ]; then
    echo "  工作目录是 ${WORK}（来自 KARMACHAIN_WORKDIR）—— 换目录这条路已经试过了。" >&2
    echo "  所以问题不在 /tmp，而在这套 docker 的挂载或身份映射本身。先看它是什么：" >&2
    echo "    docker info -f '{{.SecurityOptions}}'; docker context show; echo \"\${DOCKER_HOST:-（未设）}\"" >&2
    echo "  若是远程 daemon，密钥必须在**它所在的那台机器**上生成 —— 换台机器跑本脚本。" >&2
  else
    echo "  工作目录当前是 ${WORK}。某些装法挂不了 /tmp —— 换到家目录下重试：" >&2
    echo "    KARMACHAIN_WORKDIR=\"\$HOME/karmachain-keygen\" KARMACHAIN_DOMAIN=${KARMACHAIN_DOMAIN:-<边界名>} $0 ${INDEX}" >&2
    echo "" >&2
    echo "  再看一眼这套 docker 是什么：" >&2
    echo "    docker info -f '{{.SecurityOptions}}'; docker context show" >&2
  fi
  exit ${EXIT_DEPS}
fi

# 容器的输出**不能扔掉**。初版是 `>/dev/null 2>&1`，于是 docker run 自己的失败
# 一点痕迹都不留，而下面的判据会报出「avalanchego 没有生成 staker.crt」——
# 一句指向 avalanchego 的话，而 avalanchego 可能根本没被启动过。
# 2026-09-21 在 ubuntu-5 上就是这样：连 avago.log 都不存在，`tail` 报文件不存在。
#
# `mount-check` 是给宿主看的：容器最先写它。它在容器里成功、而宿主看不见，
# 就说明 bind mount 没有把内容传回来 —— 与 avalanchego 失败是两件完全不同的事。
set +e
${DOCKER} run --rm --entrypoint sh ${USER_ARGS[@]+"${USER_ARGS[@]}"} \
  -e NETWORK_ID="${NETWORK_ID}" -v "${WORK}:/out" "${IMAGE}" -c '
  set -e
  id
  echo ok > /out/mount-check
  ls -ld /out
  mkdir -p /out/data
  timeout 25 /avalanchego/build/avalanchego \
    --network-id="${NETWORK_ID}" --data-dir=/out/data \
    --http-host=127.0.0.1 --http-port=29999 --staking-port=29998 \
    --bootstrap-ips= --bootstrap-ids= >/out/avago.log 2>&1 || true
  ls -la /out /out/data 2>&1
' >"${RUNLOG}" 2>&1
RUN_STATUS=$?
set -e

if [ ${RUN_STATUS} -ne 0 ]; then
  echo "" >&2
  echo "**容器没跑起来**（docker run 退出 ${RUN_STATUS}）—— 与 avalanchego 无关。输出：" >&2
  sed 's/^/    /' "${RUNLOG}" >&2
  echo "" >&2
  echo "  常见成因：镜像与本机架构不符；--user 不被这套 docker 接受；挂载被拒。" >&2
  exit ${EXIT_DEPS}
fi

if [ ! -f "${WORK}/mount-check" ]; then
  echo "" >&2
  echo "**容器跑完了，但它写进 /out 的东西宿主看不见** —— bind mount 没有生效。" >&2
  echo "  这不是 avalanchego 的问题：它的日志与密钥都写在容器那一侧，然后一起消失了。" >&2
  echo "" >&2
  echo "  容器自己的视角（它认为写成功了）：" >&2
  sed 's/^/    /' "${RUNLOG}" >&2
  echo "" >&2
  echo "  三种成因，按可能性排：" >&2
  echo "    1. docker 是 snap 装的 —— 严格约束下挂载不了 /tmp。" >&2
  echo "       用 \$HOME 下的目录重试：" >&2
  echo "         KARMACHAIN_WORKDIR=\"\$HOME/karmachain-keygen\" KARMACHAIN_DOMAIN=${KARMACHAIN_DOMAIN:-<边界名>} $0 ${INDEX}" >&2
  echo "    2. DOCKER_HOST 指向远程或 rootless daemon —— 那边的 /tmp 不是这边的 /tmp。" >&2
  echo "       检查：docker context show; echo \"\${DOCKER_HOST:-（未设）}\"" >&2
  echo "    3. 宿主 /tmp 是某种不可共享的挂载（noexec/tmpfs 命名空间隔离）。同样用第 1 条的出口。" >&2
  exit ${EXIT_DEPS}
fi

if [ ! -s "${WORK}/avago.log" ]; then
  echo "" >&2
  echo "**挂载是通的，但 avalanchego 没有产生任何日志。** 容器输出：" >&2
  sed 's/^/    /' "${RUNLOG}" >&2
  exit ${EXIT_INCOMPLETE}
fi

STAKING="${WORK}/data/staking"
for f in staker.crt staker.key signer.key; do
  [ -s "${STAKING}/${f}" ] || {
    echo "avalanchego 没有生成 ${f} —— 日志尾部：" >&2
    tail -5 "${WORK}/avago.log" >&2 || true
    exit ${EXIT_INCOMPLETE}
  }
done

# 身份取自 avalanchego 自己的启动日志（"initializing node" 那一行）。
# 不用 grep 裸文本 —— 带键路径取值，否则拿到的可能是别处的数
# （2026-09-10 在 percentConnected 上栽过一次：不带键路径 grep 嵌套 JSON，拿到的是别人的数）。
LINE="$(grep -m1 'initializing node' "${WORK}/avago.log" || true)"
[ -n "${LINE}" ] || { echo "日志里找不到 'initializing node' 那一行" >&2; exit ${EXIT_INCOMPLETE}; }
JSON="${LINE#*initializing node }"
NODE_ID="$(printf '%s' "${JSON}" | jq -er '.nodeID')"
BLS_PUB="$(printf '%s' "${JSON}" | jq -er '.nodePOP.publicKey')"
BLS_POP="$(printf '%s' "${JSON}" | jq -er '.nodePOP.proofOfPossession')"

mkdir -p "${KEYDIR}"
cp "${STAKING}/staker.crt" "${STAKING}/staker.key" "${STAKING}/signer.key" "${KEYDIR}/"
chmod 600 "${KEYDIR}/staker.key" "${KEYDIR}/signer.key"

CERT_SHA="$(sha256sum "${KEYDIR}/staker.crt" | cut -d' ' -f1)"
KEY_SHA="$(sha256sum "${KEYDIR}/staker.key" | cut -d' ' -f1)"
SIGNER_SHA="$(sha256sum "${KEYDIR}/signer.key" | cut -d' ' -f1)"

DOMAIN="${KARMACHAIN_DOMAIN:-<本机的故障边界 id>}"

# ## 密钥一旦落盘，**任何事都不许阻止下面那段公开材料被打印出来**
#
# 初版写的是：
#     ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
# `2>/dev/null` 只吞掉 stderr，而 `set -o pipefail` 让 `hostname -I` 的非零状态
# 成为整个管道的状态，`set -e` 于是把脚本打掉 —— **就在 cp 之后**。
# 后果不是"少一行地址"：密钥已经在 keyDir 里了，公开材料却一个字没印出来，
# 而重跑会被上面那条「staker.key 已存在 —— 不覆盖」拦住。
# 机器卡在一个既没拿到材料、又不能重来的状态里，只能手工移走目录重新生成身份。
#
# 2026-09-21 在 win-1 上用桩跑完整路径时撞到（Git Bash 的 hostname 没有 -I）。
# Linux 上不复现，所以它能一直躺着 —— 而"只在某些机器上炸"的那一类，
# 正是这种脚本最该防的：它的用途就是在**一台陌生的新机器**上跑第一次。
#
# 地址只是个便于追溯的注记，取不到就留空；绝不让它决定脚本的成败。
ADDR="$( (hostname -I 2>/dev/null || true) | awk '{print $1}' )" || ADDR=""
if [ -z "${ADDR}" ]; then
  ADDR="$( (ip -4 -o addr show scope global 2>/dev/null || true) | awk '{print $4}' | cut -d/ -f1 | head -1 )" || ADDR=""
fi
TODAY="$(date -u +%Y-%m-%d)" || TODAY="(日期未知)"

cat > "${KEYDIR}/README.md" <<EOF
# DEVELOPMENT ONLY — KarmaChain 本地开发网络的验证者材料（node-${INDEX}）

**绝不可用于任何真实网络。** 仅在本地开发网络（Network ID ${NETWORK_ID} / Chain ID ${CHAIN_ID}）中有效。

**本目录的私钥不进版本库。** 与 node-1…node-5 不同：那几个按宪法第四条 v1.1.0 例外条款
提交入库；而功能 005 起，**创世之后加入**的验证者，私钥必须在目标机器上生成并留在本机。
只有公开材料进 blockchain/deployment.json：NodeID、BLS 公钥、**proof of possession**、三个 sha256 指纹。

| 项 | 值 |
|---|---|
| 节点序号 | node-${INDEX} |
| NodeID | ${NODE_ID} |
| 生成于 | ${DOMAIN} (${ADDR:-地址未知})，${TODAY} |
| 生成方式 | tools/membership/gen-node-keys.sh（avalanchego 自生成，非 Avalanche CLI） |
EOF

echo "" >&2
echo "✅ 材料已生成在 ${KEYDIR}/ —— **私钥留在本机，不要提交、不要外传**" >&2
echo "" >&2
echo "把下面这一块贴给对方（**只有公开材料，没有任何私钥**）：" >&2
echo "" >&2
jq -n \
  --argjson index "${INDEX}" \
  --arg nodeId "${NODE_ID}" \
  --arg bls "${BLS_PUB}" \
  --arg pop "${BLS_POP}" \
  --arg cert "${CERT_SHA}" \
  --arg key "${KEY_SHA}" \
  --arg signer "${SIGNER_SHA}" \
  --arg by "${DOMAIN} (${ADDR:-unknown})" \
  --arg at "${TODAY}" \
  '{
     validatorIndex: $index,
     identity: {
       origin: "joined",
       nodeId: $nodeId,
       blsPublicKey: $bls,
       certSha256: $cert,
       keySha256: $key,
       signerSha256: $signer,
       proofOfPossession: $pop,
       reportedBy: $by,
       reportedAt: $at
     }
   }'
echo "" >&2
echo "说明：" >&2
echo "  - identity 那一块直接进 blockchain/deployment.json 的 validators.nodes[] 对应项" >&2
echo "  - proofOfPossession **在 identity 块里，必须一起贴** —— P 链的" >&2
echo "    RegisterL1ValidatorTx 要它来验证这个 BLS 公钥确实由持有私钥的人声明。" >&2
echo "    （初版把它列在 identity 之外并注明\"只为留档\"，那是个失误：" >&2
echo "     写注册第三步时才发现它是必需的。少了它，流程会走到花钱那一步才失败。）" >&2
echo "  - 三个 sha256 是**文件指纹**，容器启动时用它们确认挂进去的是同一份材料" >&2
