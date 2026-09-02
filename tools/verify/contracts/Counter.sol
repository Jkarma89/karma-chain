// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @notice 验证器用的最小 EVM 探针合约：证明部署、写入（状态转换）、只读调用、事件都正常。
/// 不是生产合约，只在 scripts/devnet-verify 中临时部署。
/// 编译时必须显式指定 evmVersion=cancun —— Subnet-EVM / C-Chain 尚不支持 Pectra，而 solc 0.8.30+
/// 的默认目标已是 Pectra（见 subnet-evm README）。
contract Counter {
    uint256 public count;
    address public lastCaller;

    event Incremented(address indexed caller, uint256 newCount);

    function increment() external returns (uint256) {
        count += 1;
        lastCaller = msg.sender;
        emit Incremented(msg.sender, count);
        return count;
    }

    function add(uint256 delta) external returns (uint256) {
        count += delta;
        lastCaller = msg.sender;
        emit Incremented(msg.sender, count);
        return count;
    }
}
