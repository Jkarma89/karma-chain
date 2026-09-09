// tools/protocol/load.mjs
// 读取并校验 blockchain/protocol.json —— KarmaChain 协议参数的唯一事实来源（宪法第十六条）。
// 其他所有工具（创世/文档/compose 生成器、验证器、测试）必须经由本模块获取参数，不得自行解析或硬编码。
//
// 用法（库）：   import { loadProtocol } from '../protocol/load.mjs'
// 用法（CLI）：  node tools/protocol/load.mjs [path]   → 打印摘要，校验失败以退出码 1 结束

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { getAddress, isAddress } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const DEFAULT_PROTOCOL_PATH = resolve(REPO_ROOT, 'blockchain', 'protocol.json');
export const DEFAULT_SCHEMA_PATH = resolve(REPO_ROOT, 'blockchain', 'protocol.schema.json');

// Avalanche 主网 / Fuji 的 Network ID —— 本地网络绝不允许与之相同（spec 边缘用例"误连真实网络"）。
const REAL_NETWORK_IDS = new Set([1, 5]);

// RPCChainVM 协议版本兼容表。来源（2026-09-01 核实）：
//   avalanchego  version/compatibility.json      → "44": [v1.14.0, v1.14.1], "45": [v1.14.2]
//   subnet-evm   compatibility.json（归档仓库）   → v0.8.0: 44, v0.7.9: 43
// 升级任一版本时必须同步更新此表并递增 configVersion（宪法第十五条协议变更流程）。
export const RPC_CHAIN_VM_PROTOCOL = {
  avalanchego: { 'v1.13.4': 43, 'v1.13.5': 43, 'v1.14.0': 44, 'v1.14.1': 44, 'v1.14.2': 45 },
  subnetEvm: { 'v0.7.9': 43, 'v0.8.0': 44 },
};

// 容器内被其他组件占用的端口：Avalanche CLI 主网节点固定区间（9650-9653，CLI 常量，非本项目参数）。
// 对外 RPC 代理端口来自 protocol.json，运行时并入检查（见 validateConstraints）。
const CLI_PRIMARY_NODE_PORTS = [9650, 9651, 9652, 9653];

let ajvInstance;
function getAjv() {
  if (!ajvInstance) {
    ajvInstance = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajvInstance);
  }
  return ajvInstance;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 仅做 JSON Schema 校验；返回 ajv 错误数组（空数组 = 通过）。 */
export function validateSchema(protocol, schema = readJson(DEFAULT_SCHEMA_PATH)) {
  const ajv = getAjv();
  // 同一 $id 在一个 Ajv 实例里只能编译一次；复用已编译的校验器。
  const validate = (schema.$id && ajv.getSchema(schema.$id)) || ajv.compile(schema);
  return validate(protocol) ? [] : validate.errors.map(formatAjvError);
}

function formatAjvError(e) {
  return `${e.instancePath || '/'} ${e.message}${e.params?.allowedValues ? ` (${JSON.stringify(e.params.allowedValues)})` : ''}`;
}

/** data-model.md §1 的业务约束；返回可读错误列表（空数组 = 通过）。假定 schema 已通过。 */
/**
 * 约束 T-5（每故障边界的验证者数不得超过容错上限）违规的机器可读标记。
 *
 * 为什么需要它：违规必须映射到**退出码 13**（contracts/cli-interface.md），
 * 而 validateConstraints 只产出字符串。此前 validate-topology.mjs 靠匹配英文散文
 * （`'holds'` + `'L1 validators, limit is'`）来识别 —— 文案一改（比如按契约要求改成中文）
 * 判据就静默失效，退出码退化成 10。用标记后二者不再耦合于措辞或语言。
 * T-5 的编号见 specs/002-resilient-validator-network/data-model.md §1。
 */
export const TOPOLOGY_VIOLATION_TAG = '[T-5]';

export function validateConstraints(p) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  // --- 链身份 ---
  if (p.chain.chainId === p.chain.reservedMainnetChainId) {
    fail(`chain.chainId (${p.chain.chainId}) must differ from reservedMainnetChainId — the local devnet must never impersonate mainnet`);
  }
  if (REAL_NETWORK_IDS.has(p.avalanche.networkId)) {
    fail(`avalanche.networkId ${p.avalanche.networkId} is a real Avalanche network (mainnet=1, fuji=5)`);
  }
  if (p.environment !== 'dev') fail(`environment must be "dev" in this file (got ${p.environment})`);

  // --- 版本兼容 ---
  const avagoProto = RPC_CHAIN_VM_PROTOCOL.avalanchego[p.avalanche.avalanchegoVersion];
  const evmProto = RPC_CHAIN_VM_PROTOCOL.subnetEvm[p.avalanche.subnetEvmVersion];
  if (avagoProto === undefined) fail(`avalanche.avalanchegoVersion ${p.avalanche.avalanchegoVersion} is not in the compatibility table (update RPC_CHAIN_VM_PROTOCOL after verifying upstream)`);
  if (evmProto === undefined) fail(`avalanche.subnetEvmVersion ${p.avalanche.subnetEvmVersion} is not in the compatibility table`);
  if (avagoProto !== undefined && evmProto !== undefined && avagoProto !== evmProto) {
    fail(`protocol mismatch: avalanchego ${p.avalanche.avalanchegoVersion} speaks RPCChainVM ${avagoProto} but subnet-evm ${p.avalanche.subnetEvmVersion} speaks ${evmProto}`);
  }
  if (avagoProto !== undefined && p.avalanche.rpcChainVmProtocol !== avagoProto) {
    fail(`avalanche.rpcChainVmProtocol ${p.avalanche.rpcChainVmProtocol} does not match the table value ${avagoProto} for ${p.avalanche.avalanchegoVersion}`);
  }

  // --- 出块 / 费用一致性 ---
  if (p.blockProduction.targetBlockRateSeconds !== p.feeConfig.targetBlockRate) {
    fail(`blockProduction.targetBlockRateSeconds (${p.blockProduction.targetBlockRateSeconds}) must equal feeConfig.targetBlockRate (${p.feeConfig.targetBlockRate})`);
  }
  if (p.feeConfig.minBlockGasCost > p.feeConfig.maxBlockGasCost) fail('feeConfig.minBlockGasCost must be <= maxBlockGasCost');

  // --- 验证者 ---
  const nodes = p.validators.nodes;
  if (p.validators.count !== nodes.length) fail(`validators.count (${p.validators.count}) != validators.nodes.length (${nodes.length})`);
  const expectedIdx = nodes.map((_, i) => i + 1);
  if (JSON.stringify(nodes.map((n) => n.index)) !== JSON.stringify(expectedIdx)) fail('validators.nodes[].index must be 1..count in order');
  nodes.forEach((n) => {
    if (n.keyDir !== `blockchain/validators/dev/node-${n.index}/`) fail(`validators.nodes[${n.index}].keyDir must be blockchain/validators/dev/node-${n.index}/`);
  });
  const ports = nodes.flatMap((n) => [n.httpPort, n.stakingPort]);
  const dupPorts = ports.filter((x, i) => ports.indexOf(x) !== i);
  if (dupPorts.length) fail(`validator ports must be unique; duplicates: ${[...new Set(dupPorts)].join(', ')}`);
  const reserved = new Set([...CLI_PRIMARY_NODE_PORTS, p.endpoints.hostRpcPort]);
  ports.filter((x) => reserved.has(x)).forEach((x) => fail(`validator port ${x} collides with a reserved container port (${[...reserved].join(', ')})`));

  // --- 开发账户 ---
  const labels = p.devAccounts.map((a) => a.label);
  if (new Set(labels).size !== labels.length) fail('devAccounts[].label must be unique');
  const lowerAddrs = p.devAccounts.map((a) => a.address.toLowerCase());
  if (new Set(lowerAddrs).size !== lowerAddrs.length) fail('devAccounts[].address must be unique');
  p.devAccounts.forEach((a) => {
    if (!isAddress(a.address, { strict: true }) || getAddress(a.address) !== a.address) {
      fail(`devAccounts[${a.label}].address ${a.address} is not EIP-55 checksummed`);
    }
    if (BigInt(a.balanceWei) <= 0n) fail(`devAccounts[${a.label}].balanceWei must be > 0`);
  });
  if (!labels.includes(p.validators.ownerAccount)) fail(`validators.ownerAccount "${p.validators.ownerAccount}" is not a devAccounts label`);

  // --- 端点 ---
  const expectedPath = `/ext/bc/${p.chain.blockchainName}/rpc`;
  if (p.endpoints.rpcPath !== expectedPath) fail(`endpoints.rpcPath must be ${expectedPath} (derived from chain.blockchainName)`);

  // --- 拓扑（功能 002；约束编号见 specs/002-…/data-model.md §1）---
  const t = p.topology;
  const tNodes = t.nodes;
  const validatorNodes = tNodes.filter((n) => n.role === 'l1-validator');
  const primaryNodes = tNodes.filter((n) => n.role === 'primary');

  // T-6 节点 id 唯一
  const ids = tNodes.map((n) => n.id);
  const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dupIds.length) fail(`topology.nodes[].id must be unique; duplicates: ${[...new Set(dupIds)].join(', ')}`);

  // T-1 / T-2 节点数量与既有声明一致
  if (validatorNodes.length !== p.validators.count) {
    fail(`topology has ${validatorNodes.length} l1-validator nodes but validators.count is ${p.validators.count}`);
  }
  if (primaryNodes.length !== p.primaryNetwork.nodeCount) {
    fail(`topology has ${primaryNodes.length} primary nodes but primaryNetwork.nodeCount is ${p.primaryNetwork.nodeCount}`);
  }

  // validatorIndex 必须恰好覆盖 1..validators.count（端口与 keyDir 由 validators.nodes[] 提供）
  const vIdx = validatorNodes.map((n) => n.validatorIndex).sort((a, b) => a - b);
  const wantIdx = nodes.map((n) => n.index);
  if (JSON.stringify(vIdx) !== JSON.stringify(wantIdx)) {
    fail(`topology l1-validator nodes must reference validators.nodes indices ${wantIdx.join(',')} exactly once each (got ${vIdx.join(',')})`);
  }

  // Primary 端口不得与验证者端口或宿主 RPC 端口冲突
  const primaryPorts = primaryNodes.flatMap((n) => [n.httpPort, n.stakingPort]);
  const dupPrimary = primaryPorts.filter((x, i) => primaryPorts.indexOf(x) !== i);
  if (dupPrimary.length) fail(`topology primary ports must be unique; duplicates: ${[...new Set(dupPrimary)].join(', ')}`);
  const validatorPorts = new Set(ports);
  primaryPorts.filter((x) => validatorPorts.has(x) || x === p.endpoints.hostRpcPort)
    .forEach((x) => fail(`topology primary port ${x} collides with a validator port or endpoints.hostRpcPort`));

  // T-3 activeDeployment 必须存在
  if (!Object.prototype.hasOwnProperty.call(t.deployments, t.activeDeployment)) {
    fail(`topology.activeDeployment "${t.activeDeployment}" is not a key of topology.deployments (${Object.keys(t.deployments).join(', ')})`);
  }

  const idSet = new Set(ids);
  for (const [name, dep] of Object.entries(t.deployments)) {
    const domains = dep.failureDomains;

    // 边界 id 唯一
    const dIds = domains.map((d) => d.id);
    const dupD = dIds.filter((x, i) => dIds.indexOf(x) !== i);
    if (dupD.length) fail(`deployment "${name}": failureDomains[].id must be unique; duplicates: ${[...new Set(dupD)].join(', ')}`);

    // T-4 成员并集 == 节点全集，且互不重叠
    const members = domains.flatMap((d) => d.nodes);
    const dupM = members.filter((x, i) => members.indexOf(x) !== i);
    if (dupM.length) fail(`deployment "${name}": node(s) assigned to more than one failure domain: ${[...new Set(dupM)].join(', ')}`);
    const unknown = members.filter((m) => !idSet.has(m));
    if (unknown.length) fail(`deployment "${name}": unknown node id(s) ${[...new Set(unknown)].join(', ')}`);
    const missing = ids.filter((i) => !members.includes(i));
    if (missing.length) fail(`deployment "${name}": node(s) not assigned to any failure domain: ${missing.join(', ')}`);

    // T-5 边界数 > 1 时，任一边界内的验证者不得超过容错上限 ⌊n/4⌋。
    // 这是 **FR-020**（5 个验证者 MUST 分布在 5 个故障边界上，每边界恰好 1 个）与
    // **FR-021**（MUST 拒绝违反容错约束的拓扑声明）的执行点 —— 违规是**错误**而非告警，
    // 因为"声明了 5 个边界但实际只有 2 台机器"曾在全部测试皆绿的情况下存在过
    // （2026-09-07，见 docs/adr/0007-failure-domain-independence.md）。
    // 单边界形态（阶段一）不做整机失效容错承诺，故不适用 —— 见 specs/002-…/data-model.md §4
    if (domains.length > 1) {
      const maxPerDomain = Math.floor(p.validators.count / 4);
      for (const d of domains) {
        const inDomain = d.nodes.filter((id) => validatorNodes.some((n) => n.id === id));
        if (inDomain.length > maxPerDomain) {
          // 文案依 contracts/cli-interface.md 的"新增退出码 13"一节：必须给出**可执行**的
          // 修正方向（把哪个节点挪走），而不只是报出违规。语言与工具其余输出一致（中文）。
          const surplus = inDomain.slice(maxPerDomain);
          fail(`${TOPOLOGY_VIOLATION_TAG} 形态 "${name}"：故障边界 '${d.id}' 含 ${inDomain.length} 个 L1 验证者，`
            + `上限为 ${maxPerDomain}（${p.validators.count} 个等权验证者，查询门槛 75% → `
            + `最多容忍 ⌊${p.validators.count}/4⌋ = ${maxPerDomain} 个离线）。`
            + `把 ${surplus.join('、')} 移到另一个边界，或增加边界数量。`);
        }
      }
    }
  }

  return errors;
}

/** 完整校验（schema + 约束）。 */
export function validateProtocol(protocol, schema) {
  const schemaErrors = validateSchema(protocol, schema);
  if (schemaErrors.length) return { ok: false, errors: schemaErrors.map((e) => `schema: ${e}`) };
  const constraintErrors = validateConstraints(protocol);
  return { ok: constraintErrors.length === 0, errors: constraintErrors.map((e) => `constraint: ${e}`) };
}

/** 读取 + 校验；失败抛出含全部错误的 Error。 */
export function loadProtocol(path = DEFAULT_PROTOCOL_PATH, schemaPath = DEFAULT_SCHEMA_PATH) {
  const protocol = readJson(path);
  const { ok, errors } = validateProtocol(protocol, readJson(schemaPath));
  if (!ok) throw new Error(`protocol.json invalid (${path}):\n  - ${errors.join('\n  - ')}`);
  return Object.freeze(protocol);
}

// --- 派生值（不存储于 protocol.json，避免第二份事实）---
export function derive(p) {
  const initialSupplyWei = p.devAccounts.reduce((sum, a) => sum + BigInt(a.balanceWei), 0n);
  return {
    chainIdHex: `0x${p.chain.chainId.toString(16)}`,
    // 端点主机来自 protocol.json 的 endpoints.publishedHosts（声明的协议参数，不在代码里硬编码）。
    // rpcUrl / wsUrl 保留为"首选端点"，等于列表首项。
    rpcUrls: p.endpoints.publishedHosts.map((h) => `http://${h}:${p.endpoints.hostRpcPort}${p.endpoints.rpcPath}`),
    wsUrls: p.endpoints.publishedHosts.map((h) => `ws://${h}:${p.endpoints.hostRpcPort}${p.endpoints.rpcPath.replace(/\/rpc$/, '/ws')}`),
    rpcUrl: `http://${p.endpoints.publishedHosts[0]}:${p.endpoints.hostRpcPort}${p.endpoints.rpcPath}`,
    wsUrl: `ws://${p.endpoints.publishedHosts[0]}:${p.endpoints.hostRpcPort}${p.endpoints.rpcPath.replace(/\/rpc$/, '/ws')}`,
    initialSupplyWei,
    initialSupplyTokens: initialSupplyWei / 10n ** BigInt(p.nativeToken.decimals),
    totalNodeCount: p.primaryNetwork.nodeCount + p.validators.count,
    ...deriveTopology(p),
  };
}

/**
 * 把共享失效因素相同的故障边界合并成**有效边界**。
 *
 * 为什么必须合并：整域失效容忍的前提是"各边界独立失效"。两个边界共享同一个因素时，
 * 该因素一旦触发会同时打掉两边 —— 对这项承诺而言它们根本就是同一个边界。
 * 只把共享因素报成告警是不够的：2026-09-07 实测发现声明的 5 个边界里有 3 个是虚拟机、
 * 宿主只有 2 台物理机（win-1 承载 3 个验证者），而当时的模型仍然打印
 * "可容忍 1 个边界整体失效 [OK]" —— 一个**在现实里为假的绿灯**，正是最危险的缺陷形态。
 *
 * 合并用并查集：因素是可传递的（A 与 B 共享 f1、B 与 C 共享 f2 ⇒ A/B/C 同生共死）。
 * @returns {Array<{ids: string[], factors: string[], nodes: string[]}>}
 */
export function effectiveDomains(domains) {
  const parent = new Map(domains.map((d) => [d.id, d.id]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const byFactor = new Map();
  for (const d of domains) {
    for (const f of d.sharedFailureFactors ?? []) {
      if (!byFactor.has(f)) byFactor.set(f, []);
      byFactor.get(f).push(d.id);
    }
  }
  for (const ids of byFactor.values()) for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);

  const groups = new Map();
  for (const d of domains) {
    const root = find(d.id);
    if (!groups.has(root)) groups.set(root, { ids: [], factors: new Set(), nodes: [] });
    const g = groups.get(root);
    g.ids.push(d.id);
    g.nodes.push(...d.nodes);
    for (const f of d.sharedFailureFactors ?? []) g.factors.add(f);
  }
  return [...groups.values()].map((g) => ({ ids: g.ids, factors: [...g.factors], nodes: g.nodes }));
}

/**
 * 容错推导。**声明边界**用于校验 T-5（每边界至多 maxOfflineValidators 个验证者），
 * **有效边界**（合并共享因素后）才决定 tolerateWholeDomainLoss 这项对外承诺。
 */
function faultTolerance(domains, nodes, n, maxOfflineValidators) {
  const isValidator = (id) => nodes.some((x) => x.id === id && x.role === 'l1-validator');
  const countIn = (ids) => ids.filter(isValidator).length;
  const effective = effectiveDomains(domains);
  const withinLimit = (list) => list.every((x) => countIn(x.nodes) <= maxOfflineValidators);

  return {
    validatorCount: n,
    maxOfflineValidators,
    domainCount: domains.length,
    // 单边界形态不做整机失效承诺；多边界时每边界至多 maxOfflineValidators 个验证者
    maxValidatorsPerDomain: domains.length > 1 ? maxOfflineValidators : n,
    // 声明层面是否合规（T-5 校验用）
    declaredWithinLimit: domains.length > 1 && withinLimit(domains.map((d) => ({ nodes: d.nodes }))),
    effectiveDomainCount: effective.length,
    effectiveDomains: effective.map((g) => ({ ids: g.ids, factors: g.factors, validators: countIn(g.nodes) })),
    // 对外承诺：必须按有效边界判定，否则共享因素会被绿灯掩盖
    tolerateWholeDomainLoss: effective.length > 1 && withinLimit(effective),
  };
}

/**
 * 拓扑派生（功能 002）：把 topology 的引用解析成每个节点的完整参数。
 * 验证者的端口与 keyDir 来自 validators.nodes[]（唯一出处），此处只做解析，不引入新值。
 */
export function deriveTopology(p) {
  const byIndex = new Map(p.validators.nodes.map((n) => [n.index, n]));
  const deployment = p.topology.deployments[p.topology.activeDeployment];
  const domainOf = new Map();
  for (const d of deployment.failureDomains) for (const id of d.nodes) domainOf.set(id, d);

  // 故障边界地址允许由环境变量覆盖（T060）：机器 IP 是**安装特有**数据，
  // 提交进 protocol.json 是为了满足 FR-022（跨机部署不得依赖手工步骤），
  // 但换网段、换机器、他人复用本仓库时不该被迫改事实来源。
  //   KARMACHAIN_ADDRESS_OVERRIDE="win-1=192.168.1.50 ubuntu-2=192.168.1.61"
  const overrides = new Map(
    (process.env.KARMACHAIN_ADDRESS_OVERRIDE ?? '')
      .split(/\s+/).filter(Boolean)
      .map((pair) => {
        const i = pair.indexOf('=');
        if (i < 1) throw new Error(`KARMACHAIN_ADDRESS_OVERRIDE 格式应为 "<domain>=<ip>"，收到 "${pair}"`);
        return [pair.slice(0, i), pair.slice(i + 1)];
      }),
  );
  for (const id of overrides.keys()) {
    if (!deployment.failureDomains.some((d) => d.id === id)) {
      throw new Error(`KARMACHAIN_ADDRESS_OVERRIDE 指向未知故障边界 "${id}"；本形态可选：${deployment.failureDomains.map((d) => d.id).join(', ')}`);
    }
  }
  const addressOf = (d) => overrides.get(d.id) ?? d.address;

  // 单机形态：每个节点是独立容器，必须有各自的地址 —— 共用边界地址会让节点连向自身。
  // 多机形态：节点分处不同机器，地址即所属边界的机器地址，靠端口区分同机节点。
  const net = deployment.containerNetwork;
  const containerIp = (index) => {
    const base = net.subnet.split('/')[0].split('.').slice(0, 3).join('.');
    return `${base}.${net.firstHost + index}`;
  };

  const nodes = p.topology.nodes.map((n, i) => {
    const d = domainOf.get(n.id);
    const v = n.role === 'l1-validator' ? byIndex.get(n.validatorIndex) : null;
    return {
      id: n.id,
      role: n.role,
      httpPort: v ? v.httpPort : n.httpPort,
      stakingPort: v ? v.stakingPort : n.stakingPort,
      keyDir: v ? v.keyDir : n.keyDir,
      domain: d?.id ?? null,
      address: net ? containerIp(i) : (d ? addressOf(d) : null),
      hostAddress: d ? addressOf(d) : null,
      platform: d?.platform ?? null,
    };
  });

  // 容错上限：等权验证者 n 个，发起查询需已连接权重 >= 共识法定人数/采样规模 = 75%
  // => (n-f)/n >= 0.75 => f <= n/4（001 研究 R-05，源码 snow/engine/snowman/engine.go）
  const n = p.validators.count;
  const maxOfflineValidators = Math.floor(n / 4);
  const domains = deployment.failureDomains;

  return {
    activeDeployment: p.topology.activeDeployment,
    containerNetwork: net ?? null,
    topologyNodes: nodes,
    failureDomains: domains.map((d) => ({
      ...d,
      address: addressOf(d),
      validatorCount: d.nodes.filter((id) => nodes.some((x) => x.id === id && x.role === 'l1-validator')).length,
    })),
    faultTolerance: faultTolerance(domains, nodes, n, maxOfflineValidators),
  };
}

// --- CLI ---
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const p = loadProtocol(process.argv[2] ? resolve(process.argv[2]) : undefined);
    const d = derive(p);
    console.log(`${p.name} protocol config v${p.configVersion} (${p.environment}) — OK`);
    console.log(`  chainId ${p.chain.chainId} (${d.chainIdHex})  networkId ${p.avalanche.networkId}  token ${p.nativeToken.symbol}`);
    console.log(`  avalanchego ${p.avalanche.avalanchegoVersion} / subnet-evm ${p.avalanche.subnetEvmVersion} / cli ${p.avalanche.avalancheCliVersion} (RPCChainVM ${p.avalanche.rpcChainVmProtocol})`);
    console.log(`  nodes ${d.totalNodeCount} (${p.primaryNetwork.nodeCount} primary + ${p.validators.count} L1)  rpc ${d.rpcUrl}`);
    console.log(`  dev accounts ${p.devAccounts.length}, initial supply ${d.initialSupplyTokens} ${p.nativeToken.symbol}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
