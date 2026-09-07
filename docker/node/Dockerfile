# KarmaChain 节点运行时镜像（功能 002 / T024）
#
# 一节点一容器，容器内直接运行 avalanchego。**镜像内没有 Avalanche CLI** ——
# FR-015（能在不含编排工具的环境中启动节点）由镜像构成静态保证，而不是靠约定（研究 R-02）。
#
# 基底是官方节点镜像（Debian 12 bookworm，avalanchego 在 /avalanchego/build/），
# 只叠加三样东西：subnet-evm 插件、启动期校验、健康检查。
#
# 二进制版本与校验值的唯一出处：docker/binaries.env。
# 下面的 ARG 默认值必须与该文件一致 —— tests/unit/binaries-env.test.mjs 会拦截漂移。

ARG AVALANCHEGO_VERSION=v1.14.1
FROM avaplatform/avalanchego:${AVALANCHEGO_VERSION}

ARG SUBNET_EVM_VERSION=v0.8.0
ARG TARGETARCH
ARG SHA_SUBNET_EVM_AMD64=f9cfd6438be5b4fb134a298f9abc0a4835d5c734dcd5ddb352d0eb3127e11b17
ARG SHA_SUBNET_EVM_ARM64=40719bdbf762a29648358cd36b9d44792697451ab39ac6c3eed51838f37be47b

# 官方镜像不带 jq / curl：入口要读 JSON 配置，健康检查要发 RPC
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# subnet-evm 插件。放在固定路径，由入口按 protocol.json 推导出的 VM ID 链接进 plugin-dir ——
# 插件文件名必须等于 VM ID，而 VM ID 由链名派生，因此不在镜像里写死。
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) SHA_EVM="${SHA_SUBNET_EVM_AMD64}" ;; \
      arm64) SHA_EVM="${SHA_SUBNET_EVM_ARM64}" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/subnet-evm /tmp/dl; cd /tmp/dl; \
    EVM_TGZ="subnet-evm_${SUBNET_EVM_VERSION#v}_linux_${TARGETARCH}.tar.gz"; \
    curl -fsSL -o "${EVM_TGZ}" "https://github.com/ava-labs/subnet-evm/releases/download/${SUBNET_EVM_VERSION}/${EVM_TGZ}"; \
    echo "${SHA_EVM}  ${EVM_TGZ}" | sha256sum -c -; \
    tar -xzf "${EVM_TGZ}" -C /opt/subnet-evm subnet-evm; \
    chmod +x /opt/subnet-evm/subnet-evm; \
    rm -rf /tmp/dl

COPY docker/node/entrypoint.sh docker/node/healthcheck.sh /opt/karmachain/
RUN chmod +x /opt/karmachain/entrypoint.sh /opt/karmachain/healthcheck.sh

ENV AVALANCHEGO_BIN=/avalanchego/build/avalanchego \
    SUBNET_EVM_BIN=/opt/subnet-evm/subnet-evm \
    KARMACHAIN_CONFIG=/config \
    KARMACHAIN_KEYS=/keys \
    KARMACHAIN_DATA=/data \
    KARMACHAIN_PLUGINS=/plugins

ENTRYPOINT ["/opt/karmachain/entrypoint.sh"]
