#!/usr/bin/env bash
# lib/binaries.sh —— 把镜像层预置的 AvalancheGo / Subnet-EVM 二进制软链进 Avalanche CLI 的缓存目录。
#
# CLI 判定"已安装"的规则（avalanche-cli v1.9.6 pkg/binutils/binaries.go ExistsWithVersion）：
#   glob  ~/.avalanche-cli/bin/avalanchego/avalanchego-<version>
#   glob  ~/.avalanche-cli/bin/subnet-evm/subnet-evm-<version>
# 命中即跳过下载（research V-2）。~/.avalanche-cli 是运行时命名卷，可能为空，故每次启动都重建软链。

: "${KARMACHAIN_OPT:=/opt/avalanche}"
: "${AVALANCHE_CLI_HOME:=/root/.avalanche-cli}"
: "${AVALANCHEGO_VERSION:?AVALANCHEGO_VERSION not set}"
: "${SUBNET_EVM_VERSION:?SUBNET_EVM_VERSION not set}"

avalanchego_bin() { printf '%s/avalanchego-%s/avalanchego' "${KARMACHAIN_OPT}" "${AVALANCHEGO_VERSION}"; }
subnet_evm_bin() { printf '%s/subnet-evm-%s/subnet-evm' "${KARMACHAIN_OPT}" "${SUBNET_EVM_VERSION}"; }

ensure_cached_binaries() {
  local avago_dir="${AVALANCHE_CLI_HOME}/bin/avalanchego"
  local evm_dir="${AVALANCHE_CLI_HOME}/bin/subnet-evm"
  mkdir -p "${avago_dir}" "${evm_dir}"

  local avago_link="${avago_dir}/avalanchego-${AVALANCHEGO_VERSION}"
  local evm_link="${evm_dir}/subnet-evm-${SUBNET_EVM_VERSION}"

  # 若卷里已有同名真实目录（例如 CLI 曾自行下载），保留不动；否则建立软链
  if [ ! -e "${avago_link}" ] || [ -L "${avago_link}" ]; then
    ln -sfn "${KARMACHAIN_OPT}/avalanchego-${AVALANCHEGO_VERSION}" "${avago_link}"
  fi
  if [ ! -e "${evm_link}" ] || [ -L "${evm_link}" ]; then
    ln -sfn "${KARMACHAIN_OPT}/subnet-evm-${SUBNET_EVM_VERSION}" "${evm_link}"
  fi

  [ -x "$(avalanchego_bin)" ] || { echo "avalanchego binary missing at $(avalanchego_bin)" >&2; return 1; }
  [ -x "$(subnet_evm_bin)" ] || { echo "subnet-evm binary missing at $(subnet_evm_bin)" >&2; return 1; }

  # --- CLI 在 deploy 时拉取的辅助组件（T011 实测）：同样预置 + 软链 ---
  if [ -n "${SIGNATURE_AGGREGATOR_VERSION:-}" ]; then
    local sa_dir="${AVALANCHE_CLI_HOME}/bin/signature-aggregator"
    local sa_link="${sa_dir}/signature-aggregator-${SIGNATURE_AGGREGATOR_VERSION}"
    mkdir -p "${sa_dir}"
    if [ ! -e "${sa_link}" ] || [ -L "${sa_link}" ]; then
      ln -sfn "${KARMACHAIN_OPT}/signature-aggregator-${SIGNATURE_AGGREGATOR_VERSION}" "${sa_link}"
    fi
  fi
  if [ -n "${ICM_CONTRACTS_VERSION:-}" ]; then
    local icm_dir="${AVALANCHE_CLI_HOME}/bin/icm-contracts"
    local icm_link="${icm_dir}/${ICM_CONTRACTS_VERSION}"
    mkdir -p "${icm_dir}"
    if [ ! -e "${icm_link}" ] || [ -L "${icm_link}" ]; then
      ln -sfn "${KARMACHAIN_OPT}/icm-contracts-${ICM_CONTRACTS_VERSION}" "${icm_link}"
    fi
  fi

  # --- "latest" 版本解析缓存：复制模板并刷新 mtime（CLI 缓存有效期 3h），避免联网查询 GitHub ---
  local cache_src="${KARMACHAIN_CACHE_TEMPLATES:-/opt/karmachain/cache}"
  local cache_dst="${AVALANCHE_CLI_HOME}/download-cache"
  if [ -d "${cache_src}" ]; then
    mkdir -p "${cache_dst}"
    local f
    for f in "${cache_src}"/*.json; do
      [ -f "$f" ] || continue
      cp -f "$f" "${cache_dst}/$(basename "$f")"
      touch "${cache_dst}/$(basename "$f")"
    done
  fi
}

# 校验 protocol.json 声明的版本与镜像内预置版本一致（防止改了 protocol.json 却没重建镜像）
assert_binary_versions_match_protocol() {
  local want_avago want_evm want_cli
  want_avago="$(proto_get '.avalanche.avalanchegoVersion')"
  want_evm="$(proto_get '.avalanche.subnetEvmVersion')"
  want_cli="$(proto_get '.avalanche.avalancheCliVersion')"
  [ "${want_avago}" = "${AVALANCHEGO_VERSION}" ] || { echo "protocol.json wants avalanchego ${want_avago}, image has ${AVALANCHEGO_VERSION} — rebuild the image" >&2; return 1; }
  [ "${want_evm}" = "${SUBNET_EVM_VERSION}" ] || { echo "protocol.json wants subnet-evm ${want_evm}, image has ${SUBNET_EVM_VERSION} — rebuild the image" >&2; return 1; }
  local have_cli
  have_cli="$(avalanche --version 2>/dev/null | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  case "${have_cli}" in
    "${want_cli}"|"${want_cli#v}") ;;
    *) echo "protocol.json wants avalanche-cli ${want_cli}, image has '${have_cli}' — rebuild the image" >&2; return 1 ;;
  esac
}
