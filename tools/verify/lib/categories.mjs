// tools/verify/lib/categories.mjs —— FR-030 的九类故障分类。
// 验证器每个失败项必须带上其中之一，使输出能区分"应用错误 / 基础设施故障 / 共识故障"（宪法第九条）。

export const CATEGORIES = Object.freeze({
  GENESIS: 'genesis',             // 创世文件被拒、生成物与提交文件不一致、创世哈希不符
  CONFIGURATION: 'configuration', // protocol.json 不合法、端口冲突、依赖缺失、链数据与参数不匹配
  NODE: 'node',                   // 进程未运行 / /ext/health 非 healthy / 启动超时
  VALIDATOR: 'validator',         // L1 节点未 bootstrapped、PoA 初始化失败
  P2P: 'p2p',                     // 对等连接数低于期望
  RPC: 'rpc',                     // HTTP 不可达、JSON-RPC 错误、方法不存在
  EVM: 'evm',                     // 合约部署/调用失败、eth_call 结果不符
  TRANSACTION: 'transaction',     // 交易未确认、回执 status=0、余额不符
  STORAGE: 'storage',             // 磁盘不足、数据库打开失败
});

export const ALL_CATEGORIES = Object.freeze(Object.values(CATEGORIES));

/** 把底层异常粗分到类别，供检查项在 catch 中兜底使用。 */
export function categorizeError(err) {
  const m = `${err?.code ?? ''} ${err?.cause?.code ?? ''} ${err?.message ?? err}`.toLowerCase();
  if (/econnrefused|enotfound|ehostunreach|etimedout|timed out|socket hang up|fetch failed/.test(m)) return CATEGORIES.RPC;
  if (/does not exist|is not available|method not found|-32601/.test(m)) return CATEGORIES.RPC;
  if (/no space left|disk|database|leveldb|pebble/.test(m)) return CATEGORIES.STORAGE;
  if (/revert|out of gas|execution reverted|invalid opcode/.test(m)) return CATEGORIES.EVM;
  if (/nonce|replacement|underpriced|receipt|reverted/.test(m)) return CATEGORIES.TRANSACTION;
  if (/bootstrap/.test(m)) return CATEGORIES.VALIDATOR;
  if (/peer/.test(m)) return CATEGORIES.P2P;
  if (/genesis/.test(m)) return CATEGORIES.GENESIS;
  return CATEGORIES.NODE;
}
