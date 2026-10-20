// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {PlanApproval, Sig, HogeeKinds} from "../src/interfaces/IHogee.sol";
import {IHogeeErrors} from "../src/interfaces/IHogeeBase.sol";
import {HogeeSigs} from "../src/HogeeSigs.sol";
import {HogeeTestBase} from "./utils/HogeeTestBase.sol";

/// The two checks the contracts run on a founder passkey, with calldata arguments like the real callers.
contract PasskeyVectorProbe {
    /// OZ WebAuthn.verify with requireUV, as HogeeSigs kind 1 calls it.
    function ozVerify(bytes32 digest, WebAuthn.WebAuthnAuth calldata auth, bytes32 qx, bytes32 qy)
        external
        view
        returns (bool)
    {
        return WebAuthn.verify(abi.encodePacked(digest), auth, qx, qy, true);
    }

    /// HogeeSigs.check: PlanRegistry._requireFounder and checkFounderSig (Treasury, MilestoneEscrow) both use it.
    function hogeeCheck(bytes32 digest, Sig calldata sig, bytes32 qx, bytes32 qy)
        external
        view
        returns (bool ok, address ecdsaSigner)
    {
        return HogeeSigs.check(digest, sig, qx, qy, address(0));
    }
}

/// Task 1.9 / gate G3: P2's 20 browser passkey vectors (Chrome virtual authenticator, /dev/passkey) verify the way
/// the contracts verify a founder passkey: OZ 5.7 WebAuthn.verify(abi.encodePacked(digest), auth, qx, qy) with
/// requireUV, through HogeeSigs kind 1, and on a deployed PlanRegistry with the vectors' key registered.
/// Fixtures: P2's originals in e2e/vectors (read in place, read-only fs_permissions in foundry.toml; G2 removed the
/// byte-identical copy under test/vectors/passkey). The e2e "vectors" Playwright project (e2e/passkey/vectors.spec.ts)
/// makes them: one CDP virtual-authenticator credential (RP ID localhost, UV on) signs 20 random digests, encoded by
/// apps/web/lib/passkey-encode.ts. P2's set has no negative vectors, so the negative cases below are derived from the
/// valid ones.
contract PasskeyVectorsTest is HogeeTestBase {
    uint256 private constant VECTOR_COUNT = 20;
    string private constant VECTOR_DIR = "/../e2e/vectors";
    /// Fields of e2e/vectors/passkey-N.json: digest, qx, qy and the six WebAuthnAuth fields.
    uint256 private constant VECTOR_FIELDS = 9;
    /// keccak256(abi.encode(auth)) of passkey-1.json, i.e. its Sig.data. Pinned in packages/chain/test/passkey.test.ts.
    bytes32 private constant GOLDEN_SIG_DATA_HASH_1 =
        0x1efaa75223cb4cde9f18663679059e3478e78b65f2ed7d08e0be14a34e5055a6;
    bytes1 private constant FLAG_UP = 0x01;
    bytes1 private constant FLAG_UV = 0x04;
    /// A valid P-256 key that did not sign the vectors.
    uint256 private constant OTHER_P256_KEY = 0xB0B;

    struct PasskeyVector {
        bytes32 digest;
        bytes32 qx;
        bytes32 qy;
        WebAuthn.WebAuthnAuth auth;
    }

    PasskeyVectorProbe private probe;

    function setUp() public override {
        super.setUp();
        probe = new PasskeyVectorProbe();
    }

    // ---------------------------------------------------------------------------------------------------------
    // The fixture
    // ---------------------------------------------------------------------------------------------------------

    function test_Vectors_FixtureHoldsExactlyTwentyVectors() public view {
        Vm.DirEntry[] memory entries = vm.readDir(string.concat(vm.projectRoot(), VECTOR_DIR));
        uint256 json;
        for (uint256 k; k < entries.length; ++k) {
            if (!entries[k].isDir && _endsWith(entries[k].path, ".json")) ++json;
        }
        assertEq(json, VECTOR_COUNT, "passkey-1.json .. passkey-20.json and nothing else");
        for (uint256 i = 1; i <= VECTOR_COUNT; ++i) {
            assertTrue(vm.isFile(_path(i)), "passkey-N.json is numbered 1..20");
        }
    }

    /// Every vector is one key's assertion with UP and UV set and s already low (P2's encoder normalised it).
    function test_Vectors_AreLowSAndUserVerified() public view {
        PasskeyVector memory first = _vector(1);
        for (uint256 i = 1; i <= VECTOR_COUNT; ++i) {
            PasskeyVector memory v = _vector(i);
            assertEq(v.qx, first.qx, "one credential signed every vector");
            assertEq(v.qy, first.qy, "one credential signed every vector");
            assertLe(uint256(v.auth.s), P256_N / 2, "low-s");
            bytes1 flags = v.auth.authenticatorData[32];
            assertEq(flags & FLAG_UP, FLAG_UP, "user present");
            assertEq(flags & FLAG_UV, FLAG_UV, "user verified");
            assertEq(v.auth.authenticatorData.length, 37, "rpIdHash, flags, counter; no extensions");
        }
    }

    /// The bytes the TS encoder in packages/chain sends as Sig.data are byte-identical to Solidity abi.encode(auth).
    function test_Vectors_SigDataMatchesTsEncoderGolden() public view {
        assertEq(keccak256(_sig(_vector(1).auth).data), GOLDEN_SIG_DATA_HASH_1);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Valid vectors verify (20/20)
    // ---------------------------------------------------------------------------------------------------------

    function test_Vectors_AllVerifyWithOzWebAuthnRequireUV() public view {
        uint256 verified;
        for (uint256 i = 1; i <= VECTOR_COUNT; ++i) {
            PasskeyVector memory v = _vector(i);
            assertTrue(probe.ozVerify(v.digest, v.auth, v.qx, v.qy), string.concat("vector ", vm.toString(i)));
            ++verified;
        }
        assertEq(verified, VECTOR_COUNT);
    }

    /// HogeeSigs kind 1 accepts both encodings: abi.encode(struct) (offset word, what viem sends) and the flat tuple.
    function test_Vectors_AllVerifyThroughHogeeSigsKind1() public view {
        for (uint256 i = 1; i <= VECTOR_COUNT; ++i) {
            PasskeyVector memory v = _vector(i);
            (bool ok, address signer) = probe.hogeeCheck(v.digest, _sig(v.auth), v.qx, v.qy);
            assertTrue(ok, string.concat("struct encoding, vector ", vm.toString(i)));
            assertEq(signer, address(0));
            (ok,) = probe.hogeeCheck(v.digest, _flatSig(v.auth), v.qx, v.qy);
            assertTrue(ok, string.concat("flat encoding, vector ", vm.toString(i)));
        }
    }

    /// End to end: the lender registers the browser credential's (qx, qy) on a deployed PlanRegistry, and the
    /// registry's founder check (the one Treasury and MilestoneEscrow call) accepts every vector.
    function test_E2E_PlanRegistry_RegisteredPasskeyVerifiesEveryVector() public {
        PasskeyVector memory first = _vector(1);
        vm.prank(lender);
        registry.registerFounderKey(first.qx, first.qy, founder); // passkey + backup-owner EOA (§8.7)
        (bytes32 qx, bytes32 qy, address eoa) = registry.founderKey();
        assertEq(qx, first.qx);
        assertEq(qy, first.qy);
        assertEq(eoa, founder);
        for (uint256 i = 1; i <= VECTOR_COUNT; ++i) {
            PasskeyVector memory v = _vector(i);
            (bool ok, address signer) = registry.checkFounderSig(v.digest, _sig(v.auth));
            assertTrue(ok, string.concat("vector ", vm.toString(i)));
            assertEq(signer, address(0));
        }
    }

    /// The vectors sign random digests, so none is a PlanApproval: commitPlan must refuse one (T27). The accepted
    /// passkey commit is PlanRegistry.t.sol test_CommitPlan_PassesWithKind1WebAuthnSignature.
    function test_Revert_InvalidSignature_commitPlan_vectorOverAnotherDigest() public {
        PasskeyVector memory v = _vector(1);
        _openFacility();
        vm.prank(lender);
        registry.registerFounderKey(v.qx, v.qy, founder);
        PlanApproval memory a = _rinaApproval();
        assertTrue(_planDigest(a) != v.digest);
        Sig memory sig = _sig(v.auth);
        vm.prank(relayer);
        vm.expectRevert(IHogeeErrors.InvalidSignature.selector);
        registry.commitPlan(a, _lines(), _stages(), sig);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Derived negatives (each valid vector, one field changed)
    // ---------------------------------------------------------------------------------------------------------

    /// n - s is the same P-256 signature, but OZ only accepts low-s: why the encoder normalises.
    function test_Vectors_HighSFormIsRejected() public view {
        for (uint256 i = 1; i <= VECTOR_COUNT; ++i) {
            PasskeyVector memory v = _vector(i);
            v.auth.s = bytes32(P256_N - uint256(v.auth.s));
            assertFalse(probe.ozVerify(v.digest, v.auth, v.qx, v.qy), string.concat("vector ", vm.toString(i)));
        }
    }

    function test_Vectors_OtherDigestIsRejected() public view {
        for (uint256 i = 1; i <= VECTOR_COUNT; ++i) {
            PasskeyVector memory v = _vector(i);
            bytes32 other = v.digest ^ bytes32(uint256(1));
            assertFalse(probe.ozVerify(other, v.auth, v.qx, v.qy), string.concat("vector ", vm.toString(i)));
        }
    }

    function test_Vectors_OtherKeyIsRejected() public view {
        (uint256 x, uint256 y) = vm.publicKeyP256(OTHER_P256_KEY);
        for (uint256 i = 1; i <= VECTOR_COUNT; ++i) {
            PasskeyVector memory v = _vector(i);
            assertFalse(
                probe.ozVerify(v.digest, v.auth, bytes32(x), bytes32(y)), string.concat("vector ", vm.toString(i))
            );
        }
    }

    /// The indices are byte offsets of the keys; an off-by-one (e.g. a UTF-16 count) fails.
    function test_Vectors_ShiftedIndicesAreRejected() public view {
        for (uint256 i = 1; i <= VECTOR_COUNT; ++i) {
            PasskeyVector memory v = _vector(i);
            v.auth.challengeIndex += 1;
            assertFalse(
                probe.ozVerify(v.digest, v.auth, v.qx, v.qy), string.concat("challenge, vector ", vm.toString(i))
            );
            v.auth.challengeIndex -= 1;
            v.auth.typeIndex += 1;
            assertFalse(probe.ozVerify(v.digest, v.auth, v.qx, v.qy), string.concat("type, vector ", vm.toString(i)));
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------------------

    function _path(uint256 i) private view returns (string memory) {
        return string.concat(vm.projectRoot(), VECTOR_DIR, "/passkey-", vm.toString(i), ".json");
    }

    function _vector(uint256 i) private view returns (PasskeyVector memory v) {
        string memory json = vm.readFile(_path(i));
        assertEq(vm.parseJsonKeys(json, "$").length, VECTOR_FIELDS, "vector fields");
        v.digest = vm.parseJsonBytes32(json, ".digest");
        v.qx = vm.parseJsonBytes32(json, ".qx");
        v.qy = vm.parseJsonBytes32(json, ".qy");
        v.auth = WebAuthn.WebAuthnAuth({
            r: vm.parseJsonBytes32(json, ".r"),
            s: vm.parseJsonBytes32(json, ".s"),
            challengeIndex: vm.parseJsonUint(json, ".challengeIndex"),
            typeIndex: vm.parseJsonUint(json, ".typeIndex"),
            authenticatorData: vm.parseJsonBytes(json, ".authenticatorData"),
            clientDataJSON: vm.parseJsonString(json, ".clientDataJSON")
        });
    }

    /// Sig.data = Solidity abi.encode(auth) (leading 0x20 offset word), as packages/chain webAuthnSigData encodes it.
    function _sig(WebAuthn.WebAuthnAuth memory auth) private pure returns (Sig memory) {
        return Sig({kind: HogeeKinds.SIG_WEBAUTHN, data: abi.encode(auth)});
    }

    /// OZ's flat tuple, without the offset word.
    function _flatSig(WebAuthn.WebAuthnAuth memory auth) private pure returns (Sig memory) {
        return Sig({
            kind: HogeeKinds.SIG_WEBAUTHN,
            data: abi.encode(
                auth.r, auth.s, auth.challengeIndex, auth.typeIndex, auth.authenticatorData, auth.clientDataJSON
            )
        });
    }

    function _endsWith(string memory s, string memory suffix) private pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(suffix);
        if (a.length < b.length) return false;
        for (uint256 k; k < b.length; ++k) {
            if (a[a.length - b.length + k] != b[k]) return false;
        }
        return true;
    }
}
