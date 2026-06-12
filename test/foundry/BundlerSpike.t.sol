// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Spike test for SPEC005 §6.4 architectural commitment.
/// @dev Verifies that a "Bundler3 Adapter-style router with signature-based initiator" composes:
///      - User signs an EIP-712 action digest off-chain.
///      - Keeper (msg.sender ≠ user) submits the digest.
///      - The router recovers the user from the signature and calls Morpho with onBehalf = recovered user.
///      - Replay is prevented by a Permit2-style nonce bitmap (per §6.4 nonce model).
/// @dev This is a pattern proof, not a Morpho integration test. The existing LoopExecutor.sol fork tests
///      already prove that Morpho.setAuthorization + onBehalf composes on Base mainnet.

interface VmSpike {
    function addr(uint256 privateKey) external pure returns (address keyAddr);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
}

/// @dev Mocks Morpho.supplyCollateral / borrow / repay / withdrawCollateral. Records onBehalf to assert
///      that the recovered owner is what reached Morpho.
contract MockMorpho {
    struct Call {
        bytes32 op;
        address onBehalf;
        uint256 amount;
        address receiver;
    }

    Call[] public calls;

    function supplyCollateral(bytes32 marketId, uint256 assets, address onBehalf, bytes calldata) external {
        calls.push(Call({op: "supply", onBehalf: onBehalf, amount: assets, receiver: address(0)}));
    }

    function borrow(bytes32 marketId, uint256 assets, uint256, address onBehalf, address receiver)
        external
        returns (uint256, uint256)
    {
        calls.push(Call({op: "borrow", onBehalf: onBehalf, amount: assets, receiver: receiver}));
        return (assets, assets);
    }

    function repay(bytes32 marketId, uint256 assets, uint256, address onBehalf, bytes calldata)
        external
        returns (uint256, uint256)
    {
        calls.push(Call({op: "repay", onBehalf: onBehalf, amount: assets, receiver: address(0)}));
        return (assets, assets);
    }

    function withdrawCollateral(bytes32 marketId, uint256 assets, address onBehalf, address receiver) external {
        calls.push(Call({op: "withdrawCollateral", onBehalf: onBehalf, amount: assets, receiver: receiver}));
    }

    function callCount() external view returns (uint256) {
        return calls.length;
    }
}

/// @notice Minimal SPEC005-style adapter with signature-based initiator instead of msg.sender-based.
/// @dev Pattern: anyone may submit the action; signature determines onBehalf. Permit2-style nonce bitmap.
contract SignatureAdapter {
    error InvalidSignature();
    error NonceAlreadyUsed();
    error DeadlineExpired();
    error WrongChain();
    error WrongVerifyingContract();
    error UnknownAction();

    enum Action {
        Supply,
        Borrow,
        Repay,
        Withdraw
    }

    struct ActionDigest {
        address owner;
        uint256 chainId;
        address verifyingContract;
        bytes32 marketId;
        Action action;
        uint256 amount;
        address receiver; // only used for Borrow / Withdraw
        uint256 nonceSlot;
        uint8 nonceBit;
        uint256 deadline;
    }

    bytes32 public constant ACTION_TYPEHASH = keccak256(
        "ActionDigest(address owner,uint256 chainId,address verifyingContract,bytes32 marketId,uint8 action,uint256 amount,address receiver,uint256 nonceSlot,uint8 nonceBit,uint256 deadline)"
    );

    MockMorpho public immutable morpho;
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address owner => mapping(uint256 slot => uint256 bitmap)) public nonces;

    constructor(MockMorpho _morpho) {
        morpho = _morpho;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("LoopAuthorization")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function digestHash(ActionDigest calldata d) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ACTION_TYPEHASH,
                d.owner,
                d.chainId,
                d.verifyingContract,
                d.marketId,
                uint8(d.action),
                d.amount,
                d.receiver,
                d.nonceSlot,
                d.nonceBit,
                d.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function executeAction(ActionDigest calldata d, uint8 v, bytes32 r, bytes32 s) external {
        // Pre-flight checks bound to the digest.
        if (d.chainId != block.chainid) revert WrongChain();
        if (d.verifyingContract != address(this)) revert WrongVerifyingContract();
        if (block.timestamp > d.deadline) revert DeadlineExpired();

        // Nonce bitmap consumption (atomic with the Morpho call below).
        uint256 mask = 1 << uint256(d.nonceBit);
        if (nonces[d.owner][d.nonceSlot] & mask != 0) revert NonceAlreadyUsed();

        // Signature recovery — this is the "Bundler3 Adapter with signature-based initiator" core.
        bytes32 h = digestHash(d);
        address recovered = ecrecover(h, v, r, s);
        if (recovered == address(0) || recovered != d.owner) revert InvalidSignature();

        // Dispatch with onBehalf = recovered (which equals d.owner).
        if (d.action == Action.Supply) {
            morpho.supplyCollateral(d.marketId, d.amount, recovered, "");
        } else if (d.action == Action.Borrow) {
            morpho.borrow(d.marketId, d.amount, 0, recovered, d.receiver);
        } else if (d.action == Action.Repay) {
            morpho.repay(d.marketId, d.amount, 0, recovered, "");
        } else if (d.action == Action.Withdraw) {
            morpho.withdrawCollateral(d.marketId, d.amount, recovered, d.receiver);
        } else {
            revert UnknownAction();
        }

        // Set the bit only after the external call succeeded.
        nonces[d.owner][d.nonceSlot] |= mask;
    }
}

contract BundlerSpikeTest {
    VmSpike private constant vm = VmSpike(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant OWNER_KEY = 0xA11CE;
    uint256 private constant ATTACKER_KEY = 0xBAD;

    address private owner;
    address private attacker;
    address private keeper;

    MockMorpho private morpho;
    SignatureAdapter private adapter;

    bytes32 private constant MARKET_ID = bytes32(uint256(0xCAFE));

    function setUp() public {
        owner = vm.addr(OWNER_KEY);
        attacker = vm.addr(ATTACKER_KEY);
        keeper = address(0xBEEF);

        morpho = new MockMorpho();
        adapter = new SignatureAdapter(morpho);
    }

    // ---------- mechanical assertions ----------

    /// @notice Pattern works: a valid signature lets a non-owner keeper invoke the action,
    ///         and Morpho sees onBehalf = the signer (recovered from sig), not msg.sender.
    function testSupplyByKeeperUsesSignerAsOnBehalf() public {
        setUp();
        SignatureAdapter.ActionDigest memory d = _baseDigest(SignatureAdapter.Action.Supply, 1_000 ether, address(0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, adapter.digestHash(d));

        vm.prank(keeper);
        adapter.executeAction(d, v, r, s);

        require(morpho.callCount() == 1, "expected one morpho call");
        (bytes32 op, address recordedOnBehalf, uint256 amount,) = morpho.calls(0);
        require(op == "supply", "op mismatch");
        require(recordedOnBehalf == owner, "onBehalf must be the signer, NOT msg.sender");
        require(amount == 1_000 ether, "amount mismatch");
    }

    /// @notice All four Phase-1 ops compose under the same pattern.
    function testAllFourOpsCompose() public {
        setUp();

        _executeOnce(SignatureAdapter.Action.Supply, 100 ether, address(0), 0, 0);
        _executeOnce(SignatureAdapter.Action.Borrow, 50 ether, address(0xCAFE), 0, 1);
        _executeOnce(SignatureAdapter.Action.Repay, 50 ether, address(0), 0, 2);
        _executeOnce(SignatureAdapter.Action.Withdraw, 100 ether, address(0xBEEF), 0, 3);

        require(morpho.callCount() == 4, "all four ops should reach morpho");

        (bytes32 op0,,,) = morpho.calls(0);
        (bytes32 op1,,,) = morpho.calls(1);
        (bytes32 op2,,,) = morpho.calls(2);
        (bytes32 op3,,,) = morpho.calls(3);
        require(op0 == "supply", "op0");
        require(op1 == "borrow", "op1");
        require(op2 == "repay", "op2");
        require(op3 == "withdrawCollateral", "op3");
    }

    /// @notice Invalid signature (signed by an attacker, claiming to be the owner) reverts.
    function testAttackerSignatureReverts() public {
        setUp();
        SignatureAdapter.ActionDigest memory d = _baseDigest(SignatureAdapter.Action.Borrow, 1_000 ether, address(0xCAFE));
        // Attacker signs the digest that names `owner` as the owner field.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTACKER_KEY, adapter.digestHash(d));

        vm.prank(keeper);
        vm.expectRevert(SignatureAdapter.InvalidSignature.selector);
        adapter.executeAction(d, v, r, s);
    }

    /// @notice Replay of a successfully executed signed action reverts on nonce.
    function testNonceReplayReverts() public {
        setUp();
        SignatureAdapter.ActionDigest memory d = _baseDigest(SignatureAdapter.Action.Supply, 1 ether, address(0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, adapter.digestHash(d));

        vm.prank(keeper);
        adapter.executeAction(d, v, r, s);

        vm.prank(keeper);
        vm.expectRevert(SignatureAdapter.NonceAlreadyUsed.selector);
        adapter.executeAction(d, v, r, s);
    }

    /// @notice Signatures for a different verifyingContract revert (cross-deployment replay defense).
    function testWrongVerifyingContractReverts() public {
        setUp();
        SignatureAdapter.ActionDigest memory d = _baseDigest(SignatureAdapter.Action.Supply, 1 ether, address(0));
        d.verifyingContract = address(0xDEAD); // pretend the signature was for a different deployment
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, adapter.digestHash(d));

        vm.prank(keeper);
        vm.expectRevert(SignatureAdapter.WrongVerifyingContract.selector);
        adapter.executeAction(d, v, r, s);
    }

    /// @notice Signatures for a different chain id revert (cross-chain replay defense).
    function testWrongChainIdReverts() public {
        setUp();
        SignatureAdapter.ActionDigest memory d = _baseDigest(SignatureAdapter.Action.Supply, 1 ether, address(0));
        d.chainId = block.chainid + 1; // wrong chain
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, adapter.digestHash(d));

        vm.prank(keeper);
        vm.expectRevert(SignatureAdapter.WrongChain.selector);
        adapter.executeAction(d, v, r, s);
    }

    /// @notice An expired deadline reverts before any state change.
    function testExpiredDeadlineReverts() public {
        setUp();
        SignatureAdapter.ActionDigest memory d = _baseDigest(SignatureAdapter.Action.Supply, 1 ether, address(0));
        d.deadline = 0; // unambiguously in the past — Foundry's default block.timestamp is at least 1
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, adapter.digestHash(d));

        vm.prank(keeper);
        vm.expectRevert(SignatureAdapter.DeadlineExpired.selector);
        adapter.executeAction(d, v, r, s);
    }

    // ---------- helpers ----------

    function _baseDigest(SignatureAdapter.Action action, uint256 amount, address receiver)
        private
        view
        returns (SignatureAdapter.ActionDigest memory)
    {
        return SignatureAdapter.ActionDigest({
            owner: owner,
            chainId: block.chainid,
            verifyingContract: address(adapter),
            marketId: MARKET_ID,
            action: action,
            amount: amount,
            receiver: receiver,
            nonceSlot: 0,
            nonceBit: 0,
            deadline: type(uint256).max
        });
    }

    function _executeOnce(
        SignatureAdapter.Action action,
        uint256 amount,
        address receiver,
        uint256 nonceSlot,
        uint8 nonceBit
    ) private {
        SignatureAdapter.ActionDigest memory d = _baseDigest(action, amount, receiver);
        d.nonceSlot = nonceSlot;
        d.nonceBit = nonceBit;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, adapter.digestHash(d));
        vm.prank(keeper);
        adapter.executeAction(d, v, r, s);
    }
}
