// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// Toolchain canary (task 1.1): proves OZ WebAuthn + MessageHashUtils + ECDSA compile and link under
/// solc 0.8.37 / cancun. If an upgrade breaks the toolchain, this suite fails first.
contract ToolchainProbe {
    function typedDigest(bytes32 domainSeparator, bytes32 structHash) external pure returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
    }

    function verifyPasskey(bytes32 digest, WebAuthn.WebAuthnAuth calldata auth, bytes32 qx, bytes32 qy)
        external
        view
        returns (bool)
    {
        return WebAuthn.verify(abi.encodePacked(digest), auth, qx, qy);
    }

    function recover(bytes32 digest, bytes calldata sig) external pure returns (address) {
        return ECDSA.recover(digest, sig);
    }
}

contract ToolchainTest is Test {
    ToolchainProbe internal probe;

    function setUp() public {
        probe = new ToolchainProbe();
    }

    function test_TypedDigestMatchesEip712Prefix() public view {
        bytes32 domain = keccak256("domain");
        bytes32 structHash = keccak256("struct");
        assertEq(probe.typedDigest(domain, structHash), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    function test_GarbagePasskeyAssertionIsRejected() public view {
        WebAuthn.WebAuthnAuth memory auth;
        auth.authenticatorData = new bytes(37);
        auth.clientDataJSON = '{"type":"webauthn.get","challenge":"AA"}';
        assertFalse(probe.verifyPasskey(bytes32(0), auth, bytes32(uint256(1)), bytes32(uint256(2))));
    }

    function test_EcdsaRecoversSigner() public {
        (address signer, uint256 pk) = makeAddrAndKey("founder");
        bytes32 digest = keccak256("digest");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        assertEq(probe.recover(digest, abi.encodePacked(r, s, v)), signer);
    }
}
