// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {Sig, HogeeKinds} from "./interfaces/IHogee.sol";

/// @title HogeeSigs: verifies a founder `Sig` over an EIP-712 digest (§8.7).
/// kind 0: 65-byte ECDSA (OZ rejects high-s and malformed signatures) recovering `ownerEOA`.
/// kind 1: the WebAuthnAuth tuple (see below); OZ `WebAuthn.verify` with the raw 32-byte digest as the challenge,
///         UV required, low-s required, against the registered P-256 key (qx, qy).
library HogeeSigs {
    /// @return ok the signature is valid for the registered key.
    /// @return ecdsaSigner the address recovered for kind 0 (0 if malformed); 0 for kind 1.
    function check(bytes32 digest, Sig calldata sig, bytes32 qx, bytes32 qy, address ownerEOA)
        internal
        view
        returns (bool ok, address ecdsaSigner)
    {
        if (sig.kind == HogeeKinds.SIG_ECDSA) {
            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, sig.data);
            if (err != ECDSA.RecoverError.NoError) return (false, address(0));
            return (ownerEOA != address(0) && signer == ownerEOA, signer);
        }
        if (sig.kind == HogeeKinds.SIG_WEBAUTHN) {
            if (qx == bytes32(0) && qy == bytes32(0)) return (false, address(0));
            bytes calldata data = sig.data;
            // OZ decodes the flat tuple abi.encode(r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON).
            // Solidity abi.encode(auth) and viem's single-tuple encoding prepend one 0x20 offset word: accept both.
            if (data.length >= 32 && uint256(bytes32(data[:32])) == 0x20) data = data[32:];
            (bool decoded, WebAuthn.WebAuthnAuth calldata auth) = WebAuthn.tryDecodeAuth(data);
            if (!decoded) return (false, address(0));
            return (WebAuthn.verify(abi.encodePacked(digest), auth, qx, qy), address(0));
        }
        return (false, address(0));
    }
}
