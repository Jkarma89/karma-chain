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

WORK="$(mktemp -d)"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

echo "在本机生成 node-${INDEX} 的 staking 材料（约 30 秒）…" >&2

# 端口给得很高且只绑回环：这个临时节点不该被任何人连上，也不该撞到正在跑的节点。
# `--user` 让容器以**调用者**的身份写文件。少了它，avalanchego 以 root 生成
# staker.key（权限 0600、属主 root），后面这个脚本以普通用户 cp 就**读不出来** ——
# 而那时报的是一句 Permission denied，看不出根因在容器的运行身份上。
${DOCKER} run --rm --entrypoint sh --user "$(id -u):$(id -g)" \
  -e NETWORK_ID="${NETWORK_ID}" -v "${WORK}:/out" "${IMAGE}" -c '
  mkdir -p /out/data
  timeout 25 /avalanchego/build/avalanchego \
    --network-id="${NETWORK_ID}" --data-dir=/out/data \
    --http-host=127.0.0.1 --http-port=29999 --staking-port=29998 \
    --bootstrap-ips= --bootstrap-ids= >/out/avago.log 2>&1 || true
' >/dev/null 2>&1

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
ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
TODAY="$(date -u +%Y-%m-%d)"

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
