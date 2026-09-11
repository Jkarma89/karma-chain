// tools/protocol/field-ownership.mjs —— 协议参数与部署描述的归属表（功能 005 / T003）。
//
// **生成器与守卫共用这一份。** 两处各写一份必然漂移，而漂移的表现是
// "守卫说分家干净了，实际没有" —— 那比没有守卫更坏。
//
// ## 判据是一个问题，不是这张表
//
//     改了这个字段，**已经存在的链上状态还有没有意义**？
//
//   - 没意义 → 协议参数 → stamp 保护，改它必须重置链
//   - 有意义 → 部署描述 → 不进 stamp，改它不重置
//
// **把问题写在表前面，是因为表会过期而问题不会。** 日后新增字段时，
// 先回答这个问题，再决定它落在哪一侧 —— 而不是照着表猜。
//
// ## 为什么要分家：本仓库自己的历史
//
// `configVersion` 至今递增过四次，每次都让七个节点的出生证明失配、逼出全链重置：
//
//   1.1.0  调整开发账户的创世分配        ← 真协议变更（动了创世）
//   1.2.0  新增 endpoints.publishedHosts  ← 部署描述
//   1.3.0  新增 topology                  ← 部署描述
//   1.4.0  节点端口整体迁移（取值见 deployment.json）  ← 部署描述
//
// **四次里三次是部署变更。** 每一次都丢掉了当时的全部链上状态，
// 而链的身份一个字节都没动。建链初期重置近乎免费所以没人觉得不对 ——
// 代价是现在才显现的：链上已有 890+ 区块与合约状态，而要加一台机器。

/**
 * 留在协议参数文件里的顶层字段。**改它们 = 换一条链。**
 *
 * `$schema` / `name` / `environment` 是文件自身的元信息，跟着协议侧走。
 */
export const PROTOCOL_FIELDS = Object.freeze([
  '$schema',
  'name',
  'environment',
  'configVersion',
  'chain',              // chainId / reservedMainnetChainId / blockchainName
  'avalanche',          // networkId + 组件版本（见下方边界情形 ①）
  'nativeToken',
  'feeConfig',
  'allowFeeRecipients',
  'blockProduction',
  'devAccounts',        // 进创世分配 —— 创世 sha256 本来就在 stamp 里
]);

/**
 * 移到部署描述文件的顶层字段。**改它们 = 同一条链换了部署。**
 *
 * 注意 `validators` 是**拆开**的：`management` / `ownerAccount` 属协议（PoA 的治理主体，
 * 是链上权限），而 `count` / `nodes[]` 属部署（期望成员数、端口、密钥目录）。
 * 这是本表里唯一一个需要**按子键拆**的顶层字段 —— 见 `VALIDATORS_SPLIT`。
 */
export const DEPLOYMENT_FIELDS = Object.freeze([
  'topology',           // activeDeployment / nodes / deployments
  'endpoints',          // hostRpcPort / publishedHosts / rpcPath（见边界情形 ②）
  'primaryNetwork',     // nodeCount —— 期望值
]);

/** `validators` 按子键拆开：哪些留在协议侧，哪些去部署侧。 */
export const VALIDATORS_SPLIT = Object.freeze({
  protocol: Object.freeze(['management', 'ownerAccount']),
  deployment: Object.freeze(['count', 'nodes']),
});

/**
 * 三个边界情形的决定与理由（T003 要求逐条记录）。
 *
 * 这些不是"难以归类所以随便放"，而是**两侧都说得通、必须选一边并写明代价**的。
 */
export const BORDERLINE = Object.freeze({
  'avalanche.*Version': {
    decision: 'protocol',
    why: '它们是**组件版本**不是链身份，按字面像部署描述。但换 avalanchego / subnet-evm '
       + '的版本**可能改变状态转移**（宪法第十五条明列 "VM Behavior"）。'
       + '按更重的那一侧归 —— 误判为部署的代价是"半新半旧地跑着两个 VM 版本"，'
       + '而误判为协议的代价只是"升级组件时多走一次重置流程"。**代价不对称时取保守侧。**',
  },
  'endpoints.rpcPath': {
    decision: 'deployment',
    why: '它是**访问路径**（形如 `/ext/bc/<别名>/rpc`），属部署；'
       + '但取值由协议侧的 `chain.blockchainName` 派生。'
       + '移出并**加一条一致性守卫**比对两者 —— 否则改了别名而路径没跟着改，'
       + '链照常跑而所有客户端连不上，且没有任何东西会红。',
  },
  'validators.count': {
    decision: 'deployment',
    why: '005 之后成员**运行期可变**，这个字段降级为**期望成员数**。'
       + '它仍用于建链与 T-5 校验，但不再是"现在有几个验证者"的答案 —— 那在链上。'
       + '两者漂移必须可见（FR-030）。',
  },
  'docs/protocol-parameters.md': {
    decision: 'render-both',
    why: '它是生成物之一且**逐字段文档化**协议文件，分家后按定义会变 —— '
       + '而 SC-003 要求全部生成物**逐字节相同**。'
       + '决定让 `render-docs.mjs` **读两个文件**：它虽叫"协议参数"，实际是一份**参数参考**，'
       + '读它的人想知道"这条链是怎么配的"，不是"哪些字段住哪个文件"。'
       + '另一条路（文档也分家）要在 SC-003 上开口子，而那是本期最强的不回归判据。'
       + '（来自 /speckit-analyze 的 A1）',
  },
});

/** 给守卫用：某个顶层字段应当出现在哪一侧？返回 'protocol' | 'deployment' | null（未登记）。 */
export function ownerOf(topLevelKey) {
  if (PROTOCOL_FIELDS.includes(topLevelKey)) return 'protocol';
  if (DEPLOYMENT_FIELDS.includes(topLevelKey)) return 'deployment';
  if (topLevelKey === 'validators') return 'split';
  return null;
}
