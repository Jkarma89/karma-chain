# KarmaChain 一次性建链容器（功能 002 / T008）
#
# 仓库中**唯一包含 Avalanche CLI 的镜像**。它只做一件事：在 P 链上建出 L1
# （CreateSubnet → CreateChain → ConvertSubnetToL1 → PoA 初始化），把产出提取成
# blockchain/chain-identity/ 下的制品，然后退出。
#
# 与 docker/node/ 的分工是本特性的核心（研究 R-01/R-02）：
#   本镜像  = 建链，含 CLI，跑完即退
#   node 镜像 = 运行，不含 CLI，长期存活
# FR-015（能在不含编排工具的环境中启动节点）因此由镜像构成静态保证，而不是靠约定。
#
# 由 docker/devnet/Dockerfile 收缩而来，去掉了全部运行期成分：
# socat 代理、procps/iproute2、节点清单、健康检查、supervise 循环。
#
# 二进制版本与校验值的唯一出处：docker/binaries.env（版本本身源自 blockchain/protocol.json）。
# 下面的 ARG 默认值必须与该文件一致 —— tests/unit/binaries-env.test.mjs 会拦截漂移。

ARG AVALANCHE_CLI_VERSION=v1.9.6
FROM avaplatform/avalanche-cli:${AVALANCHE_CLI_VERSION}

ARG AVALANCHEGO_VERSION=v1.14.1
ARG SUBNET_EVM_VERSION=v0.8.0
ARG SIGNATURE_AGGREGATOR_VERSION=v0.5.3
ARG ICM_CONTRACTS_VERSION=v1.0.0
ARG TARGETARCH

ARG SHA_AVALANCHEGO_AMD64=9b94689364a1317fbd561919fd3c9a1dbbe92d2526dabe461b6fc41efe5cdfc3
ARG SHA_AVALANCHEGO_ARM64=335829c8a5f73f3f4de21ab2fb5e6d66eeeca0016151c93f538acaf99e8df7c5
ARG SHA_SUBNET_EVM_AMD64=f9cfd6438be5b4fb134a298f9abc0a4835d5c734dcd5ddb352d0eb3127e11b17
ARG SHA_SUBNET_EVM_ARM64=40719bdbf762a29648358cd36b9d44792697451ab39ac6c3eed51838f37be47b
ARG SHA_SIG_AGG_AMD64=c5672745f57c7b8b2c841a03febdbb50998dce4f6b4bbe5764dae92291b619dd
ARG SHA_SIG_AGG_ARM64=b68c4a3164234c9f32b1ed5b979be4af88d1e6eb82e196ba54cbc1b09f1a3846
ARG SHA_ICM_MESSENGER_ADDR=328922b742211cbc29c842d59d23444a34850ca9c192c9985879fd31ddc80116
ARG SHA_ICM_DEPLOYER_ADDR=aa902f6d932008a499ff859c2eed16fec8d13089dd248caa9dbded8227a07b87
ARG SHA_ICM_DEPLOY_TX=2fe97f31ce170eb94adbd1661e4666927341e77f476054d1ab00587c33e4810c
ARG SHA_ICM_REGISTRY_BYTECODE=1eef8ef36d0131922b1bba7bd8236d9c667ab09b6aa14efb9fa5258cd00caa02

ENV DEBIAN_FRONTEND=noninteractive \
    KARMACHAIN_OPT=/opt/avalanche \
    AVALANCHEGO_VERSION=${AVALANCHEGO_VERSION} \
    SUBNET_EVM_VERSION=${SUBNET_EVM_VERSION} \
    SIGNATURE_AGGREGATOR_VERSION=${SIGNATURE_AGGREGATOR_VERSION} \
    ICM_CONTRACTS_VERSION=${ICM_CONTRACTS_VERSION} \
    AVALANCHE_CLI_HOME=/root/.avalanche-cli

# 建链只需要：bash（脚本）、jq（读 protocol.json / 写制品）、curl + ca-certificates（下载与 RPC 探测）
# 不安装 socat / procps / iproute2 —— 那些是运行期的东西
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl jq \
 && rm -rf /var/lib/apt/lists/*

# 预置版本锁定的二进制到 /opt/avalanche（镜像层，不受运行时卷影响）
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) SHA_AVAGO="${SHA_AVALANCHEGO_AMD64}"; SHA_EVM="${SHA_SUBNET_EVM_AMD64}" ;; \
      arm64) SHA_AVAGO="${SHA_AVALANCHEGO_ARM64}"; SHA_EVM="${SHA_SUBNET_EVM_ARM64}" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p "${KARMACHAIN_OPT}" /tmp/dl; cd /tmp/dl; \
    AVAGO_TGZ="avalanchego-linux-${TARGETARCH}-${AVALANCHEGO_VERSION}.tar.gz"; \
    curl -fsSL -o "${AVAGO_TGZ}" "https://github.com/ava-labs/avalanchego/releases/download/${AVALANCHEGO_VERSION}/${AVAGO_TGZ}"; \
    echo "${SHA_AVAGO}  ${AVAGO_TGZ}" | sha256sum -c -; \
    tar -xzf "${AVAGO_TGZ}" -C "${KARMACHAIN_OPT}"; \
    test -x "${KARMACHAIN_OPT}/avalanchego-${AVALANCHEGO_VERSION}/avalanchego"; \
    EVM_TGZ="subnet-evm_${SUBNET_EVM_VERSION#v}_linux_${TARGETARCH}.tar.gz"; \
    curl -fsSL -o "${EVM_TGZ}" "https://github.com/ava-labs/subnet-evm/releases/download/${SUBNET_EVM_VERSION}/${EVM_TGZ}"; \
    echo "${SHA_EVM}  ${EVM_TGZ}" | sha256sum -c -; \
    mkdir -p "${KARMACHAIN_OPT}/subnet-evm-${SUBNET_EVM_VERSION}"; \
    tar -xzf "${EVM_TGZ}" -C "${KARMACHAIN_OPT}/subnet-evm-${SUBNET_EVM_VERSION}" subnet-evm; \
    test -x "${KARMACHAIN_OPT}/subnet-evm-${SUBNET_EVM_VERSION}/subnet-evm"; \
    case "${TARGETARCH}" in amd64) SHA_SA="${SHA_SIG_AGG_AMD64}" ;; arm64) SHA_SA="${SHA_SIG_AGG_ARM64}" ;; esac; \
    SA_TGZ="signature-aggregator_${SIGNATURE_AGGREGATOR_VERSION#v}_linux_${TARGETARCH}.tar.gz"; \
    curl -fsSL -o "${SA_TGZ}" "https://github.com/ava-labs/icm-services/releases/download/signature-aggregator-${SIGNATURE_AGGREGATOR_VERSION}/${SA_TGZ}"; \
    echo "${SHA_SA}  ${SA_TGZ}" | sha256sum -c -; \
    mkdir -p "${KARMACHAIN_OPT}/signature-aggregator-${SIGNATURE_AGGREGATOR_VERSION}"; \
    tar -xzf "${SA_TGZ}" -C "${KARMACHAIN_OPT}/signature-aggregator-${SIGNATURE_AGGREGATOR_VERSION}" signature-aggregator; \
    test -x "${KARMACHAIN_OPT}/signature-aggregator-${SIGNATURE_AGGREGATOR_VERSION}/signature-aggregator"; \
    ICM_DIR="${KARMACHAIN_OPT}/icm-contracts-${ICM_CONTRACTS_VERSION}"; mkdir -p "${ICM_DIR}"; \
    ICM_BASE="https://github.com/ava-labs/icm-contracts/releases/download/${ICM_CONTRACTS_VERSION}"; \
    for pair in \
      "TeleporterMessenger_Contract_Address_${ICM_CONTRACTS_VERSION}.txt:${SHA_ICM_MESSENGER_ADDR}" \
      "TeleporterMessenger_Deployer_Address_${ICM_CONTRACTS_VERSION}.txt:${SHA_ICM_DEPLOYER_ADDR}" \
      "TeleporterMessenger_Deployment_Transaction_${ICM_CONTRACTS_VERSION}.txt:${SHA_ICM_DEPLOY_TX}" \
      "TeleporterRegistry_Bytecode_${ICM_CONTRACTS_VERSION}.txt:${SHA_ICM_REGISTRY_BYTECODE}"; do \
      f="${pair%%:*}"; s="${pair##*:}"; \
      curl -fsSL -o "${ICM_DIR}/${f}" "${ICM_BASE}/${f}"; \
      echo "${s}  ${ICM_DIR}/${f}" | sha256sum -c -; \
    done; \
    rm -rf /tmp/dl; \
    "${KARMACHAIN_OPT}/avalanchego-${AVALANCHEGO_VERSION}/avalanchego" --version

# CLI 下载缓存模板（使 CLI 不联网重复下载）
COPY docker/devnet/cache/*.json /opt/karmachain/cache/

# CLI 可执行文件放入 PATH
RUN ln -sf /avalanche /usr/local/bin/avalanche

# 只带建链需要的库 —— 运行期的 runtime.sh / nodes.sh / health.sh 刻意不进来
COPY docker/lib/protocol.sh docker/lib/binaries.sh docker/lib/avalanche.sh docker/lib/preflight.sh /opt/karmachain/lib/
# 入口只负责建链并把 CLI 的原始产出搬到挂载卷上；
# 把原始产出重塑成制品的是 tools/protocol/extract-*.mjs（Node，可直接对 fixture 单测）。
# 容器脚本不含业务逻辑，这是 001 已确立的分工。
COPY docker/bootstrap/entrypoint.sh /opt/karmachain/bin/
RUN chmod +x /opt/karmachain/bin/*

ENV PROTOCOL_FILE=/workspace/blockchain/protocol.json \
    KARMACHAIN_LIB=/opt/karmachain/lib \
    KARMACHAIN_BIN=/opt/karmachain/bin
WORKDIR /workspace

ENTRYPOINT ["/opt/karmachain/bin/entrypoint.sh"]
