// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {PlanRegistry} from "../src/PlanRegistry.sol";
import {Treasury} from "../src/Treasury.sol";
import {TreasuryLinks} from "../src/HogeeHooks.sol";

/// @title DeployLoop: deploys a PlanRegistry + Treasury pair (the `loop-1` set, D17) and prints the deployment manifest.
/// @notice Constructor immutables only (no setters, no upgradeability). Treasury's CREATE address is precomputed
///         from the broadcaster's nonce so PlanRegistry can hold it immutably; the script asserts the link.
///         The EIP-712 domain salt is keccak256(abi.encode(chainTag, deploymentId)) (HogeeTypes), with both tags
///         right-padded UTF-8 bytes32 labels, exactly like packages/chain toBytes32Tag.
///
/// Inputs (environment; addresses and labels only, never a key; the broadcaster key comes from the forge CLI):
///   DEPLOYMENT_ID          label, default "loop-1"
///   CHAIN_TAG              label, default "anvil". Must name the chain: anvil on 31337, sepolia on 11155111; a FISCO
///                          tag ("fisco" or "fisco-*") on any other chain, with FISCO_MS true or false
///   LENDER_ADDRESS         required: LENDER role (registerFounderKey, openFacility, fund)
///   ORACLE_ADDRESS         required: ORACLE role (confirmSettlement, failSettlement); never the lender. Off Anvil,
///                          neither role may be one of Anvil's ten default accounts (their keys are public)
/// Off Anvil the broadcaster (--private-key / --account) may not be an Anvil default account either: the linked
/// addresses are precomputed from its nonces.
///   FISCO_MS               bool, default false: true when block.timestamp is in milliseconds, which only a FISCO chain
///                          does (so true needs a FISCO tag). It must match the clock the script sees (block.timestamp
///                          above 1e12 iff true). FISCO BCOS 3.x with feature_evm_timestamp=1 in the genesis keeps
///                          seconds, as does forge's simulation (it reads the RPC's seconds header): deploy there with
///                          a fisco tag and FISCO_MS=false. The script cannot see the EVM's clock unit past the
///                          simulation, so check the genesis feature before deploying (scripts/fisco/chain-check.sh)
///   COOLING_SECONDS        payee veto window, 1 s to 30 days. Default 120 (demo) on Anvil only: any other chain
///                          must set it, to at least 120 s (the labelled demo value). Production must use 24 h (86400)
///   JUDGING_WINDOW_END     unix seconds, default 1796083199 (2026-11-30T23:59:59Z); must be in the future
///   PLATFORM_PAYEE_IDS     comma-separated payee labels, e.g. "shopee-ads,shopee-fees,spx-logistics"
///   PLATFORM_PAYOUT_HASHES comma-separated bytes32, keccak256(utf8(JCS({channel, accountNumber, holderName}))), same order
///
/// Anvil:  anvil &  then
///   LENDER_ADDRESS=0x… ORACLE_ADDRESS=0x… forge script script/DeployLoop.s.sol --rpc-url http://127.0.0.1:8545 \
///     --broadcast --private-key <anvil account 0 key>
/// The manifest JSON (packages/chain/src/deployments.ts shape) is printed between the BEGIN/END markers; write it to
/// packages/chain/deployments/<chainTag>-<deploymentId>.json.
contract DeployLoop is Script {
    uint256 internal constant ANVIL_CHAIN_ID = 31_337;
    uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;
    uint256 internal constant DEMO_COOLING_SECONDS = 120;
    /// Off Anvil, COOLING_SECONDS and LOOSEN_TIMELOCK_SECONDS (DeployFinal) are at least the labelled-demo 120 s; the
    /// contracts keep their 1 s minimum for short Anvil runs. Production must use 24 h for both (project.md §8.8).
    uint256 internal constant MIN_SECONDS_OFF_ANVIL = 120;
    uint256 internal constant DEFAULT_JUDGING_WINDOW_END = 1_796_083_199; // 2026-11-30T23:59:59Z
    /// Treasury adds coolingSeconds to _now(), which is unix seconds on every chain (FISCO included): no ms scaling.
    uint256 internal constant MAX_COOLING_SECONDS = 30 days;
    /// 1e12 is 2001-09-09 in milliseconds and the year 33658 in seconds: it tells the two clocks apart.
    uint256 internal constant MS_CLOCK_THRESHOLD = 1e12;

    struct Config {
        string deploymentId;
        string chainTag;
        address lender;
        address oracle;
        bool fiscoMs;
        uint64 coolingSeconds;
        uint64 judgingWindowEnd;
        string[] platformPayeeLabels;
        bytes32[] platformPayeeIds;
        bytes32[] platformPayoutHashes;
    }

    function run() external virtual returns (PlanRegistry registry, Treasury treasury) {
        Config memory c = _config();
        uint256 startBlock = block.number;

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        _requireDeployer(deployer);
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        registry = new PlanRegistry(
            c.lender, predicted, _tag(c.deploymentId), _tag(c.chainTag), c.fiscoMs, c.judgingWindowEnd
        );
        treasury = new Treasury(
            address(registry), c.oracle, c.coolingSeconds, _loopLinks(), c.platformPayeeIds, c.platformPayoutHashes
        );
        vm.stopBroadcast();

        require(address(treasury) == predicted, "treasury address != precomputed");
        require(registry.treasury() == address(treasury), "registry -> treasury link mismatch");
        require(treasury.registry() == address(registry), "treasury -> registry link mismatch");
        require(treasury.lender() == c.lender && registry.lender() == c.lender, "lender mismatch");
        require(treasury.domainSeparator() != registry.domainSeparator(), "domains must differ per contract");

        _printSummary(c, deployer, registry, treasury);
        console2.log("BEGIN DEPLOYMENT JSON");
        console2.log(_manifest(c, startBlock, address(registry), address(treasury)));
        console2.log("END DEPLOYMENT JSON");
    }

    // ---------------------------------------------------------------------------------------------------------
    // config
    // ---------------------------------------------------------------------------------------------------------

    /// Task 1.8 constructor input, fixed for the loop-1 shape (no new environment input): no MilestoneEscrow, no
    /// SalesOracle, no observer, the §8.8 production timelock (24 h, so above the off-Anvil floor by construction).
    /// loop-1 itself is deployed from the pre-1.8 commit.
    function _loopLinks() internal pure returns (TreasuryLinks memory) {
        return TreasuryLinks({
            escrow: address(0), salesOracle: address(0), observer: address(0), loosenTimelockSeconds: 24 hours
        });
    }

    function _config() internal view returns (Config memory c) {
        c.deploymentId = vm.envOr("DEPLOYMENT_ID", string("loop-1"));
        c.chainTag = vm.envOr("CHAIN_TAG", string("anvil"));
        c.lender = vm.envAddress("LENDER_ADDRESS");
        c.oracle = vm.envAddress("ORACLE_ADDRESS");
        c.fiscoMs = vm.envOr("FISCO_MS", false);
        c.coolingSeconds = _coolingSeconds(vm.envExists("COOLING_SECONDS"), vm.envOr("COOLING_SECONDS", uint256(0)));
        c.judgingWindowEnd = _judgingWindowEnd(vm.envOr("JUDGING_WINDOW_END", DEFAULT_JUDGING_WINDOW_END));
        c.platformPayeeLabels = vm.envOr("PLATFORM_PAYEE_IDS", ",", new string[](0));
        c.platformPayoutHashes = vm.envOr("PLATFORM_PAYOUT_HASHES", ",", new bytes32[](0));
        _checkConfig(c);
        // Readable pre-checks before anything is broadcast; the Treasury constructor enforces the same (C(13)).
        require(
            c.platformPayeeLabels.length == c.platformPayoutHashes.length, "platform ids and hashes differ in length"
        );
        c.platformPayeeIds = new bytes32[](c.platformPayeeLabels.length);
        for (uint256 i; i < c.platformPayeeLabels.length; ++i) {
            c.platformPayeeIds[i] = _shortId(c.platformPayeeLabels[i]);
            require(c.platformPayoutHashes[i] != bytes32(0), "platform payout hash must be non-zero");
            for (uint256 j; j < i; ++j) {
                require(c.platformPayeeIds[j] != c.platformPayeeIds[i], "duplicate platform payee");
            }
        }
    }

    /// Checks on the parsed inputs (split out so tests can drive them without touching the process environment).
    function _checkConfig(Config memory c) internal view {
        require(c.lender != address(0) && c.oracle != address(0), "LENDER_ADDRESS and ORACLE_ADDRESS are required");
        require(c.lender != c.oracle, "LENDER_ADDRESS and ORACLE_ADDRESS must differ"); // role separation
        require(c.coolingSeconds > 0, "COOLING_SECONDS must be > 0");
        require(c.coolingSeconds <= MAX_COOLING_SECONDS, "COOLING_SECONDS must be <= 30 days"); // no _now() overflow
        _checkChain(c.chainTag, c.fiscoMs);
        // FISCO_MS must match the chain clock, or _now() reads as 1970 (or the far future) and every expiry is wrong.
        if (c.fiscoMs) {
            require(block.timestamp > MS_CLOCK_THRESHOLD, "FISCO_MS=true needs a millisecond block.timestamp");
        } else {
            require(block.timestamp < MS_CLOCK_THRESHOLD, "FISCO_MS=false needs a block.timestamp in seconds");
        }
        uint256 nowSeconds = c.fiscoMs ? block.timestamp / 1000 : block.timestamp;
        require(c.judgingWindowEnd > nowSeconds, "JUDGING_WINDOW_END must be in the future");
        if (block.chainid == ANVIL_CHAIN_ID) return;
        require(
            !_isAnvilAccount(c.lender) && !_isAnvilAccount(c.oracle),
            "LENDER_ADDRESS and ORACLE_ADDRESS must not be Anvil default accounts off Anvil"
        );
        require(
            c.coolingSeconds >= MIN_SECONDS_OFF_ANVIL, "COOLING_SECONDS must be >= 120 s off Anvil (production: 24 h)"
        );
    }

    /// CHAIN_TAG names the chain the script runs on, so the EIP-712 salt and the manifest file match it. A millisecond
    /// clock is a FISCO trait, so FISCO_MS=true needs a fisco tag; a fisco tag may run on either clock (the clock check
    /// in _checkConfig ties FISCO_MS to the one the script sees).
    function _checkChain(string memory chainTag, bool fiscoMs) internal view {
        bool fisco = _isFiscoTag(chainTag);
        require(fisco || !fiscoMs, "FISCO_MS=true needs a fisco CHAIN_TAG");
        bytes32 tag = keccak256(bytes(chainTag));
        if (block.chainid == ANVIL_CHAIN_ID) {
            require(tag == keccak256("anvil"), "CHAIN_TAG must be anvil on chain 31337");
        } else if (block.chainid == SEPOLIA_CHAIN_ID) {
            require(tag == keccak256("sepolia"), "CHAIN_TAG must be sepolia on chain 11155111");
        } else {
            require(fisco, "CHAIN_TAG does not match block.chainid");
        }
    }

    /// "fisco" or "fisco-*".
    function _isFiscoTag(string memory chainTag) internal pure returns (bool) {
        bytes memory b = bytes(chainTag);
        bytes memory p = bytes("fisco");
        if (b.length < p.length || (b.length > p.length && b[p.length] != "-")) return false;
        for (uint256 i; i < p.length; ++i) {
            if (b[i] != p[i]) return false;
        }
        return true;
    }

    /// The 120 s demo default applies on Anvil only; any other chain must set COOLING_SECONDS explicitly.
    function _coolingSeconds(bool isSet, uint256 raw) internal view returns (uint64) {
        require(isSet || block.chainid == ANVIL_CHAIN_ID, "COOLING_SECONDS must be set explicitly off Anvil");
        return SafeCast.toUint64(isSet ? raw : DEMO_COOLING_SECONDS);
    }

    function _judgingWindowEnd(uint256 raw) internal pure returns (uint64) {
        return SafeCast.toUint64(raw);
    }

    /// Off Anvil the broadcaster is never an Anvil default account (audit run-3): the linked CREATE addresses are
    /// precomputed from its nonces (DeployFinal: escrow n+2, sales oracle n+3), and anyone holding a public key could
    /// use those nonces first. Called right after vm.startBroadcast / vm.readCallers, before any deployment.
    function _requireDeployer(address deployer) internal view {
        if (block.chainid == ANVIL_CHAIN_ID) return;
        require(!_isAnvilAccount(deployer), "the broadcaster must not be an Anvil default account off Anvil");
    }

    /// Anvil's ten default accounts (mnemonic "test test ... junk"): their private keys are public.
    function _isAnvilAccount(address a) internal pure returns (bool) {
        address[10] memory known = [
            0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
            0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
            0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,
            0x90F79bf6EB2c4f870365E785982E1f101E93b906,
            0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65,
            0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc,
            0x976EA74026E726554dB657fA54763abd0C3a0aa9,
            0x14dC79964da2C08b23698B3D3cc7Ca32193d9955,
            0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f,
            0xa0Ee7A142d267C1f36714E4a8F75612F20a79720
        ];
        for (uint256 i; i < known.length; ++i) {
            if (a == known[i]) return true;
        }
        return false;
    }

    /// Deployment label: [a-z0-9][a-z0-9-]{0,31} (packages/chain deployments.ts LABEL_RE), right-padded to bytes32.
    function _tag(string memory label) internal pure returns (bytes32) {
        bytes memory b = bytes(label);
        require(b.length > 0 && b.length <= 32, "label must be 1-32 bytes");
        for (uint256 i; i < b.length; ++i) {
            bytes1 ch = b[i];
            bool ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || (ch == "-" && i > 0);
            require(ok, "label must match [a-z0-9][a-z0-9-]{0,31}");
        }
        return bytes32(b);
    }

    /// On-chain ShortId: [a-z0-9_-]{1,32} (G0-DECISIONS §1 #2), right-padded to bytes32.
    function _shortId(string memory id) internal pure returns (bytes32) {
        bytes memory b = bytes(id);
        require(b.length > 0 && b.length <= 32, "payee id must be 1-32 bytes");
        for (uint256 i; i < b.length; ++i) {
            bytes1 ch = b[i];
            bool ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch == "-" || ch == "_";
            require(ok, "payee id must match [a-z0-9_-]{1,32}");
        }
        return bytes32(b);
    }

    // ---------------------------------------------------------------------------------------------------------
    // output
    // ---------------------------------------------------------------------------------------------------------

    function _printSummary(Config memory c, address deployer, PlanRegistry registry, Treasury treasury) internal pure {
        console2.log("deployer        ", deployer);
        console2.log("PlanRegistry    ", address(registry));
        console2.log("Treasury        ", address(treasury));
        console2.log("deploymentId    ", c.deploymentId);
        console2.log("chainTag        ", c.chainTag);
        console2.log("lender          ", c.lender);
        console2.log("oracle          ", c.oracle);
        console2.log("coolingSeconds  ", c.coolingSeconds);
        console2.log("judgingWindowEnd", c.judgingWindowEnd);
        console2.log("fiscoMs         ", c.fiscoMs);
        for (uint256 i; i < c.platformPayeeLabels.length; ++i) {
            console2.log("platform payee  ", c.platformPayeeLabels[i]);
            console2.logBytes32(c.platformPayoutHashes[i]);
        }
    }

    /// packages/chain/src/deployments.ts DeploymentManifest. blockNumber is the head when the script ran: a safe
    /// lower bound for log scans (the deploy transactions land at or after it).
    function _manifest(Config memory c, uint256 startBlock, address registry, address treasury)
        internal
        view
        returns (string memory)
    {
        return string.concat(
            '{"chainId":',
            vm.toString(block.chainid),
            ',"deploymentId":"',
            c.deploymentId,
            '","chainTag":"',
            c.chainTag,
            '","contracts":{"PlanRegistry":{"address":"',
            vm.toString(registry),
            '"},"Treasury":{"address":"',
            vm.toString(treasury),
            '"}},"blockNumber":',
            vm.toString(startBlock),
            ',"deployedAt":"',
            _deployedAt(c.fiscoMs),
            '"}'
        );
    }

    /// The manifest's deployedAt: block.timestamp as UTC, scaled to seconds under FISCO_MS.
    function _deployedAt(bool fiscoMs) internal view returns (string memory) {
        return _isoUtc(fiscoMs ? block.timestamp / 1000 : block.timestamp);
    }

    /// Unix seconds to "YYYY-MM-DDTHH:MM:SSZ" (days-from-civil inverse, proleptic Gregorian).
    function _isoUtc(uint256 ts) internal pure returns (string memory) {
        uint256 z = ts / 86_400 + 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 day = doy - (153 * mp + 2) / 5 + 1;
        uint256 month = mp < 10 ? mp + 3 : mp - 9;
        uint256 year = yoe + era * 400 + (month <= 2 ? 1 : 0);
        uint256 secs = ts % 86_400;
        return string.concat(
            vm.toString(year),
            "-",
            _two(month),
            "-",
            _two(day),
            "T",
            _two(secs / 3600),
            ":",
            _two((secs % 3600) / 60),
            ":",
            _two(secs % 60),
            "Z"
        );
    }

    function _two(uint256 v) internal pure returns (string memory) {
        return v < 10 ? string.concat("0", vm.toString(v)) : vm.toString(v);
    }
}
