/**
 * MockTreasury: a TEST DOUBLE for the packages/chain live tests (T19 harness, forced reverts, watcher). It is
 * NOT the real Treasury (task 1.4 is written in parallel; contracts/ is not touched here). Its `spend`,
 * `isIntentUsed` and `recordDenied` selectors, the `Spent` / `Denied` events and the `DuplicateIntent` /
 * `CapExceeded` / `NotAgent` errors match ITreasury / IHogeeEvents / IHogeeErrors, so the generated
 * `iTreasuryAbi` encodes and decodes against it. spendId = keccak256(abi.encode(planId, lineId, payeeId,
 * invoiceHash, amount)), as §8.4.
 *
 * Regenerate: put the source below in `src/MockTreasury.sol` of an empty Foundry project with
 * solc_version = "0.8.37", evm_version = "cancun", optimizer_runs = 200, bytecode_hash = "none",
 * cbor_metadata = false; run `forge build`; copy `bytecode.object`.
 *
 * ```solidity
 * // SPDX-License-Identifier: MIT
 * pragma solidity 0.8.37;
 *
 * /// @notice Test double for packages/chain integration tests (T19 harness, forced reverts). NOT the real
 * /// Treasury (task 1.4). Selectors, event and error signatures match ITreasury / IHogeeEvents / IHogeeErrors.
 * contract MockTreasury {
 *     error DuplicateIntent();
 *     error CapExceeded();
 *     error NotAgent();
 *
 *     event Spent(
 *         bytes32 indexed spendId,
 *         bytes32 indexed lineId,
 *         bytes32 indexed payeeId,
 *         uint128 amountMinor,
 *         bytes32 invoiceHash,
 *         bytes32 decisionId,
 *         bytes32 rationaleHash,
 *         uint32 planVersion
 *     );
 *     event Denied(
 *         bytes32 indexed decisionId, bytes32 indexed lineId, bytes32 indexed reasonCode, bytes32 proposalHash, uint8 lineDenials
 *     );
 *
 *     bytes32 public immutable planId;
 *     address public immutable agent;
 *     uint128 public immutable perTxCapMinor;
 *     mapping(bytes32 => bool) private _used;
 *
 *     constructor(bytes32 planId_, address agent_, uint128 perTxCapMinor_) {
 *         planId = planId_;
 *         agent = agent_;
 *         perTxCapMinor = perTxCapMinor_;
 *     }
 *
 *     function spend(
 *         bytes32 lineId,
 *         bytes32 payeeId,
 *         uint128 amountMinor,
 *         bytes32 invoiceHash,
 *         uint32 planVersion,
 *         bytes32 decisionId,
 *         bytes32 rationaleHash
 *     ) external returns (bytes32 spendId) {
 *         if (msg.sender != agent) revert NotAgent();
 *         if (amountMinor > perTxCapMinor) revert CapExceeded();
 *         spendId = keccak256(abi.encode(planId, lineId, payeeId, invoiceHash, amountMinor));
 *         if (_used[spendId]) revert DuplicateIntent();
 *         _used[spendId] = true;
 *         emit Spent(spendId, lineId, payeeId, amountMinor, invoiceHash, decisionId, rationaleHash, planVersion);
 *     }
 *
 *     function isIntentUsed(bytes32 intentId) external view returns (bool) {
 *         return _used[intentId];
 *     }
 *
 *     function recordDenied(bytes32 lineId, bytes32 decisionId, bytes32 reasonCode, bytes32 proposalHash) external {
 *         if (msg.sender != agent) revert NotAgent();
 *         emit Denied(decisionId, lineId, reasonCode, proposalHash, 1);
 *     }
 * }
 * ```
 */
import type { Hex } from 'viem';

export const mockTreasuryAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: 'planId_', type: 'bytes32' },
      { name: 'agent_', type: 'address' },
      { name: 'perTxCapMinor_', type: 'uint128' },
    ],
    stateMutability: 'nonpayable',
  },
] as const;

export const mockTreasuryBytecode = (
  '0x60e060405234801561000f575f5ffd5b5060405161056538038061056583398101604081905261002e91610051565b6080' +
  '929092526001600160a01b031660a0526001600160801b031660c0526100a8565b5f5f5f60608486031215610063575f5ffd' +
  '5b835160208501519093506001600160a01b0381168114610081575f5ffd5b60408501519092506001600160801b03811681' +
  '1461009d575f5ffd5b809150509250925092565b60805160a05160c0516104796100ec5f395f818160fd01526101c201525f' +
  '818161013c01528181610182015261033a01525f818160d6015261021901526104795ff3fe608060405234801561000f575f' +
  '5ffd5b5060043610610060575f3560e01c8063114ca8701461006457806317449f801461008a578063288d2f231461009f57' +
  '8063bd300089146100d1578063cd40bf90146100f8578063f5ff5c7614610137575b5f5ffd5b6100776100723660046103bd' +
  '565b610176565b6040519081526020015b60405180910390f35b61009d610098366004610433565b61032f565b005b6100c1' +
  '6100ad366004610462565b5f9081526020819052604090205460ff1690565b6040519015158152602001610081565b610077' +
  '7f000000000000000000000000000000000000000000000000000000000000000081565b61011f7f00000000000000000000' +
  '0000000000000000000000000000000000000000000081565b6040516001600160801b039091168152602001610081565b61' +
  '015e7f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160a01b0390' +
  '91168152602001610081565b5f336001600160a01b037f000000000000000000000000000000000000000000000000000000' +
  '000000000016146101c057604051630d9ab13f60e01b815260040160405180910390fd5b7f00000000000000000000000000' +
  '000000000000000000000000000000000000006001600160801b0316866001600160801b031611156102135760405163a487' +
  '5a4960e01b815260040160405180910390fd5b604080517f0000000000000000000000000000000000000000000000000000' +
  '000000000000602082015290810189905260608101889052608081018690526001600160801b03871660a082015260c00160' +
  '408051601f1981840301815291815281516020928301205f8181529283905291205490915060ff16156102aa57604051633a' +
  'cb789b60e11b815260040160405180910390fd5b5f8181526020818152604091829020805460ff1916600117905581516001' +
  '600160801b03891681529081018790529081018490526060810183905263ffffffff851660808201528790899083907f8158' +
  'e3274061dc666881f75d91000b3a54862925b9c3ccc929a80b2108587d789060a00160405180910390a49796505050505050' +
  '50565b336001600160a01b037f00000000000000000000000000000000000000000000000000000000000000001614610378' +
  '57604051630d9ab13f60e01b815260040160405180910390fd5b60408051828152600160208201528391869186917f73017f' +
  '0232616a4bf21c4b126baf599e3d3772c0cb99be697b3600f94968c23a910160405180910390a450505050565b5f5f5f5f5f' +
  '5f5f60e0888a0312156103d3575f5ffd5b873596506020880135955060408801356001600160801b03811681146103f7575f' +
  '5ffd5b945060608801359350608088013563ffffffff81168114610416575f5ffd5b9699959850939692959460a084013594' +
  '5060c09093013592915050565b5f5f5f5f60808587031215610446575f5ffd5b505082359460208401359450604084013593' +
  '6060013592509050565b5f60208284031215610472575f5ffd5b503591905056') as Hex;
