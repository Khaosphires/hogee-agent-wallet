// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IHogeeErrors, IHogeeDomain} from "./interfaces/IHogeeBase.sol";
import {HogeeTypes} from "./interfaces/HogeeTypes.sol";

/// @title HogeeDomain: custom EIP-712 domain, unordered nonces and the clock shared by every Hogee contract.
/// @notice Domain = EIP712Domain(name "Hogee", version "1", verifyingContract, salt = keccak256(abi.encode(chainTag,
///         deploymentId))). No chainId, so it works on FISCO (CHAINID = 0); the salt blocks cross-chain and
///         cross-deployment replay (§8.7, T28). Nonces are unordered and scoped to this verifying contract.
abstract contract HogeeDomain is IHogeeErrors, IHogeeDomain {
    bytes32 private immutable _DEPLOYMENT_ID;
    bytes32 private immutable _CHAIN_TAG;
    bytes32 private immutable _DOMAIN_SEPARATOR;
    /// FISCO BCOS reports block.timestamp in milliseconds (§8.8).
    bool private immutable _FISCO_MS;

    mapping(uint256 nonce => bool used) private _nonceUsed;

    constructor(bytes32 deploymentId_, bytes32 chainTag_, bool fiscoMs_) {
        _DEPLOYMENT_ID = deploymentId_;
        _CHAIN_TAG = chainTag_;
        _FISCO_MS = fiscoMs_;
        _DOMAIN_SEPARATOR = HogeeTypes.domainSeparator(address(this), chainTag_, deploymentId_);
    }

    // ---- IHogeeDomain ----

    function domainSeparator() public view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }

    function deploymentId() public view returns (bytes32) {
        return _DEPLOYMENT_ID;
    }

    function chainTag() public view returns (bytes32) {
        return _CHAIN_TAG;
    }

    function isNonceUsed(uint256 nonce) external view returns (bool) {
        return _nonceUsed[nonce];
    }

    /// Not frozen: whether _now() divides block.timestamp by 1000.
    function fiscoMs() public view returns (bool) {
        return _FISCO_MS;
    }

    // ---- internal ----

    /// Unix seconds on every chain (§8.8).
    function _now() internal view returns (uint64) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(_FISCO_MS ? block.timestamp / 1000 : block.timestamp); // unix seconds fit uint64 for 5e11 y
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return HogeeTypes.digest(_DOMAIN_SEPARATOR, structHash);
    }

    /// Require-table rows ENV-1..ENV-3 and the ENV-5 effect. Call before verifying the signature itself.
    function _useEnvelope(bytes32 structDeploymentId, uint64 expiry, uint256 nonce) internal {
        if (structDeploymentId != _DEPLOYMENT_ID) revert InvalidSignature();
        // forge-lint: disable-next-line(block-timestamp)
        if (_now() > expiry) revert SignatureExpired(); // expiry is hours/days; a few seconds of drift is harmless
        if (_nonceUsed[nonce]) revert InvalidSignature();
        _nonceUsed[nonce] = true;
    }
}
