# KarmaChain 签名聚合器镜像（功能 005 / T027 第四步）
#
# ## 为什么需要它
#
# ACP-77 注册的第四步要把 P 链发回的确认消息交给合约，而链配置里
# `requirePrimaryNetworkSigners: true` + `quorumNumerator: 67` 意味着那条消息必须由
# **Primary Network 验证者**签名（两个 Primary 各握 50% P 链权益 ⇒ 两个都得签，研究 V-32）。
#
# 而收这个签名**没有 HTTP 路可走**（2026-09-16 逐个实测）：
#   - L1 节点的 `warp_getMessageAggregateSignature` 只能聚合它自己库里有的消息 → `not found`
#   - P 链的 `platform.*`（试了 4 个方法名）→ 全部 `can't find method`
#   - avalanchego 级端点 `/ext/warp`、`/ext/signature-aggregator`、`/ext/bc/P/warp` → 全部 404
#
# 签名请求只走 **P2P**，所以必须有一个能说 P2P 的客户端。icm-services 的
# signature-aggregator 就是这个东西，而它的版本与校验值**本来就已经锁在仓库里**
# （docker/binaries.env，当初为 bootstrap 镜像备的）—— 本镜像不引入任何新的信任决定。
#
# ## 为什么另开一个镜像，而不是用 bootstrap 那个
#
# bootstrap 镜像里确实有同一个二进制，但它 `FROM avaplatform/avalanche-cli` ——
# 而 ADR-0008 刚让 Avalanche CLI 退出运行时。为了一个 30 MB 的二进制把整个 CLI
# 请回常规运维路径，方向是反的。
#
# ## 按需起，不常驻
#
# 聚合器只在**加入/退出成员**时用得到（一次人工操作里几秒钟）。所以这里刻意
# 不配 healthcheck、不进 docker/compose/ 的任何 yml、不写 restart 策略 ——
# 它由 tools/membership/ 用 `docker run --rm` 拉起，用完即退。
# 多养一个常驻进程要付的是配置、监控、升级三笔账，而它一年用不了几次。
#
# 二进制版本与校验值的唯一出处：docker/binaries.env。
# 下面的 ARG 默认值必须与该文件一致 —— tests/unit/binaries-env.test.mjs 会拦截漂移。

ARG SIGNATURE_AGGREGATOR_VERSION=v0.5.3

FROM debian:bookworm-slim AS fetch

ARG SIGNATURE_AGGREGATOR_VERSION
ARG TARGETARCH
ARG SHA_SIG_AGG_AMD64=c5672745f57c7b8b2c841a03febdbb50998dce4f6b4bbe5764dae92291b619dd
ARG SHA_SIG_AGG_ARM64=b68c4a3164234c9f32b1ed5b979be4af88d1e6eb82e196ba54cbc1b09f1a3846

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    if [ -z "${TARGETARCH:-}" ]; then \
      echo "" >&2; \
      echo "TARGETARCH 是空的 —— 这台机器用的是 docker 的 **legacy builder**。" >&2; \
      echo "" >&2; \
      echo "  TARGETARCH 由 BuildKit 注入，legacy builder 不提供它。2026-09-14 在一台" >&2; \
      echo "  用 apt 装 docker.io 的 Ubuntu 上撞到：它默认走 legacy builder，而报出来的" >&2; \
      echo "  只有一句 'TARGETARCH: parameter not set'，毫无指向性。" >&2; \
      echo "" >&2; \
      echo "  两种修法，任选一个：" >&2; \
      echo "    docker build --build-arg TARGETARCH=\$(dpkg --print-architecture) …" >&2; \
      echo "    DOCKER_BUILDKIT=1 docker build …" >&2; \
      echo "" >&2; \
      echo "  **刻意不给 TARGETARCH 默认值**：猜错架构会下载到另一个平台的二进制，" >&2; \
      echo "  而 sha256 校验会在下一步失败 —— 那时报出来的是校验不符，" >&2; \
      echo "  更难查。宁可在这里停住并说清楚。" >&2; \
      exit 1; \
    fi; \
    case "${TARGETARCH}" in \
      amd64) SHA_SA="${SHA_SIG_AGG_AMD64}" ;; \
      arm64) SHA_SA="${SHA_SIG_AGG_ARM64}" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}（本镜像只备了 amd64 与 arm64 的 sha256）" >&2; exit 1 ;; \
    esac; \
    mkdir -p /out /tmp/dl; cd /tmp/dl; \
    SA_TGZ="signature-aggregator_${SIGNATURE_AGGREGATOR_VERSION#v}_linux_${TARGETARCH}.tar.gz"; \
    curl -fsSL -o "${SA_TGZ}" "https://github.com/ava-labs/icm-services/releases/download/signature-aggregator-${SIGNATURE_AGGREGATOR_VERSION}/${SA_TGZ}"; \
    echo "${SHA_SA}  ${SA_TGZ}" | sha256sum -c -; \
    tar -xzf "${SA_TGZ}" -C /out signature-aggregator; \
    chmod +x /out/signature-aggregator; \
    test -x /out/signature-aggregator; \
    rm -rf /tmp/dl

FROM debian:bookworm-slim

ARG SIGNATURE_AGGREGATOR_VERSION

# ca-certificates：访问 P 链 / info 的 HTTP 接口并做 TLS 握手
# jq：入口脚本从挂进来的 deployment.json / identity.json 现推配置
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates jq \
 && rm -rf /var/lib/apt/lists/*

COPY --from=fetch /out/signature-aggregator /usr/local/bin/signature-aggregator
COPY docker/aggregator/entrypoint.sh /opt/karmachain/entrypoint.sh
RUN chmod +x /opt/karmachain/entrypoint.sh

ENV SIGNATURE_AGGREGATOR_VERSION=${SIGNATURE_AGGREGATOR_VERSION}

# 配置由入口脚本从**挂进来的声明**推导 —— 地址、端口、NodeID 一律取自
# blockchain/deployment.json 与 blockchain/nodes/*.identity.json，镜像里不写死任何一个。
ENTRYPOINT ["/opt/karmachain/entrypoint.sh"]
