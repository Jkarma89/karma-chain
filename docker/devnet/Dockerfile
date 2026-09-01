# KarmaChain 本地开发网络容器（功能 001 / T008）
#
# 基础镜像：官方 Avalanche CLI v1.9.6（Debian trixie-slim，/avalanche 可执行文件）。
# 在其上预置版本锁定的 AvalancheGo v1.14.1 与 Subnet-EVM v0.8.0 官方发行二进制（RPCChainVM 协议 44），
# 运行时由 entrypoint 软链进 CLI 缓存目录，使 `avalanche` 不再联网下载（research V-2）。
#
# 版本与校验值的唯一来源：blockchain/protocol.json（avalanche.*Version）。
# 升级任一版本 = 协议变更（宪法第十五条）：同步改 protocol.json、本文件 ARG/SHA、tools/protocol/load.mjs 兼容表。

ARG AVALANCHE_CLI_VERSION=v1.9.6
FROM avaplatform/avalanche-cli:${AVALANCHE_CLI_VERSION}

ARG AVALANCHEGO_VERSION=v1.14.1
ARG SUBNET_EVM_VERSION=v0.8.0
# CLI 在 deploy 时还会拉取的辅助组件（T011 实测），版本无标志可锁 → 在此预置并配合 cache/latest.json 固定
ARG SIGNATURE_AGGREGATOR_VERSION=v0.5.3
ARG ICM_CONTRACTS_VERSION=v1.0.0
# TARGETARCH 由 BuildKit 注入（amd64 / arm64）
ARG TARGETARCH

# sha256 —— 2026-09-01 从 GitHub Releases 下载后计算（avalanchego 官方只提供 .sig；subnet-evm / signature-aggregator 另有 checksums.txt 且已核对一致）
ARG SHA_AVALANCHEGO_AMD64=9b94689364a1317fbd561919fd3c9a1dbbe92d2526dabe461b6fc41efe5cdfc3
ARG SHA_AVALANCHEGO_ARM64=335829c8a5f73f3f4de21ab2fb5e6d66eeeca0016151c93f538acaf99e8df7c5
ARG SHA_SUBNET_EVM_AMD64=f9cfd6438be5b4fb134a298f9abc0a4835d5c734dcd5ddb352d0eb3127e11b17
ARG SHA_SUBNET_EVM_ARM64=40719bdbf762a29648358cd36b9d44792697451ab39ac6c3eed51838f37be47b
ARG SHA_SIG_AGG_AMD64=c5672745f57c7b8b2c841a03febdbb50998dce4f6b4bbe5764dae92291b619dd
ARG SHA_SIG_AGG_ARM64=b68c4a3164234c9f32b1ed5b979be4af88d1e6eb82e196ba54cbc1b09f1a3846
# icm-contracts v1.0.0：CLI 只取 4 个文本文件（与架构无关）
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

# 容器内工具：bash（脚本）、jq（读 protocol.json）、curl（下载 + RPC 探测）、socat（RPC 代理）、procps（pgrep）、iproute2（端口检查）
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl jq socat procps iproute2 \
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
    # 包内为 avalanchego-vX.Y.Z/avalanchego —— 与 CLI 缓存目录命名 (avalanchego-<version>) 一致
    tar -xzf "${AVAGO_TGZ}" -C "${KARMACHAIN_OPT}"; \
    test -x "${KARMACHAIN_OPT}/avalanchego-${AVALANCHEGO_VERSION}/avalanchego"; \
    EVM_TGZ="subnet-evm_${SUBNET_EVM_VERSION#v}_linux_${TARGETARCH}.tar.gz"; \
    curl -fsSL -o "${EVM_TGZ}" "https://github.com/ava-labs/subnet-evm/releases/download/${SUBNET_EVM_VERSION}/${EVM_TGZ}"; \
    echo "${SHA_EVM}  ${EVM_TGZ}" | sha256sum -c -; \
    # 包为平铺文件 —— 放入 subnet-evm-<version>/ 以匹配 CLI 缓存目录命名
    mkdir -p "${KARMACHAIN_OPT}/subnet-evm-${SUBNET_EVM_VERSION}"; \
    tar -xzf "${EVM_TGZ}" -C "${KARMACHAIN_OPT}/subnet-evm-${SUBNET_EVM_VERSION}" subnet-evm; \
    test -x "${KARMACHAIN_OPT}/subnet-evm-${SUBNET_EVM_VERSION}/subnet-evm"; \
    # signature-aggregator（ava-labs/icm-services 单仓多版本标签 signature-aggregator-vX.Y.Z）
    case "${TARGETARCH}" in amd64) SHA_SA="${SHA_SIG_AGG_AMD64}" ;; arm64) SHA_SA="${SHA_SIG_AGG_ARM64}" ;; esac; \
    SA_TGZ="signature-aggregator_${SIGNATURE_AGGREGATOR_VERSION#v}_linux_${TARGETARCH}.tar.gz"; \
    curl -fsSL -o "${SA_TGZ}" "https://github.com/ava-labs/icm-services/releases/download/signature-aggregator-${SIGNATURE_AGGREGATOR_VERSION}/${SA_TGZ}"; \
    echo "${SHA_SA}  ${SA_TGZ}" | sha256sum -c -; \
    mkdir -p "${KARMACHAIN_OPT}/signature-aggregator-${SIGNATURE_AGGREGATOR_VERSION}"; \
    tar -xzf "${SA_TGZ}" -C "${KARMACHAIN_OPT}/signature-aggregator-${SIGNATURE_AGGREGATOR_VERSION}" signature-aggregator; \
    test -x "${KARMACHAIN_OPT}/signature-aggregator-${SIGNATURE_AGGREGATOR_VERSION}/signature-aggregator"; \
    # icm-contracts 文本资产（CLI 在 create 时读取；目录名与 CLI 缓存 bin/icm-contracts/<version> 一致）
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

# CLI 下载缓存模板（见 docker/devnet/cache/README.md）
COPY docker/devnet/cache/*.json /opt/karmachain/cache/

# CLI 可执行文件放入 PATH；容器内脚本与库
RUN ln -sf /avalanche /usr/local/bin/avalanche
COPY docker/devnet/lib/ /opt/karmachain/lib/
COPY docker/devnet/bin/ /opt/karmachain/bin/
COPY docker/devnet/spike/ /opt/karmachain/spike/
COPY docker/devnet/entrypoint.sh /opt/karmachain/entrypoint.sh
RUN find /opt/karmachain -name .gitkeep -delete; \
    chmod +x /opt/karmachain/entrypoint.sh; \
    find /opt/karmachain/bin /opt/karmachain/spike -type f -exec chmod +x {} +; \
    for f in /opt/karmachain/bin/*; do [ -f "$f" ] && ln -sf "$f" /usr/local/bin/; done; true

# 协议参数由 compose 以只读方式挂载到 /workspace/blockchain（唯一事实来源，不复制进镜像）
ENV PROTOCOL_FILE=/workspace/blockchain/protocol.json \
    KARMACHAIN_LIB=/opt/karmachain/lib
WORKDIR /workspace

ENTRYPOINT ["/opt/karmachain/entrypoint.sh"]
CMD ["run"]
