# Dedicated Robinhood Testnet Deployment

This workflow targets **46630 only**. It never imports an existing wallet, reads `.env`, or uses a mainnet private key. Contracts are unaudited testnet copies, not a production deployment. No application configuration is changed automatically.

Run from the repository root:

```sh
pnpm --filter @hood/shared exec tsx scripts/testnet.ts init
pnpm --filter @hood/shared exec tsx scripts/testnet.ts status
pnpm --filter @hood/shared exec tsx scripts/testnet.ts prepare
pnpm --filter @hood/shared exec tsx scripts/testnet.ts deploy
```

`init` creates three random dedicated accounts: deployer/owner/operator, verifier, and trader. Only public addresses are printed. `.testnet/` is gitignored, must be owned by the current user and mode `0700`; `secrets.json` is exclusively created with mode `0600`. Reinitialization refuses to overwrite. Do not fund these wallets on mainnet. Do not send transactions from the deployer outside this tool: deployment addresses depend on its nonce starting at zero.

`status` reads the public manifest, not secrets. It reports testnet balances, infrastructure compatibility checks, blockers and public journal entries. A completed journal is explicitly not an independent completion attestation.

`prepare` downloads all eight verified mainnet Pons artifacts from Sourcify's v2 API into `.testnet/artifacts/`. Each response retains ABI, recompiled creation bytecode, source input, compiler version/settings, mainnet address and verification result. Both creation and runtime must be verified, with no linked libraries. The immutable plan pins SHA-256 hashes of the full responses. Previously cached artifacts and plans are not replaced. The prior `/tmp` research files are not trusted as deployment inputs.

The supplied mainnet locker at `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` is verified as **RobinFunFiV2LaunchLocker**, compiler `0.8.26`, not under the newer Pons name. Its inspected constructor, one-time factory setter, factory-only token/position locks and PositionManager custody check match the interface the Pons factory uses. This exact verified deployment is copied, preserving that provenance rather than silently substituting the newer source embedded in the factory's compilation bundle. The other seven mainnet contracts are verified under their Pons names.

The three verification contracts use local Foundry output, requiring compiler 0.8.28 and source hashes matching the current contract/dependency files. After Foundry and the existing pinned dependencies have been installed, build them first:

```sh
pnpm --filter @hood/contracts build
pnpm --filter @hood/contracts test
```

No dependency installation is performed by this tool. Missing artifacts block preparation; they never count as a successful deploy. `TESTNET_RPC_URL` can override the public RPC. `eth_chainId` must still be 46630. No generic `PRIVATE_KEY`, `RPC_URL`, or application environment variables are consumed.

## Broadcast

`deploy` without flags estimates **only the next transaction** against current state. It is not a simulation of the entire dependent sequence, launch, trade or graduation. A lack of funds may prevent even this estimate. The only broadcasting command is:

```sh
pnpm --filter @hood/shared exec tsx scripts/testnet.ts deploy --broadcast
```

Before broadcasting, inspect `.testnet/plan.json` and `.testnet/status.json`, fund the dedicated deployer with **testnet ETH**, and review this implementation. The tool requires a `0.02 ETH` reserve in addition to each transaction's estimated maximum cost and value. This reserve is not a total deployment cost estimate. Verifier/trader funding is separate and is not automated.

All external addresses require code. PositionManager must return the exact configured PoolManager and Permit2. PoolManager `owner`/`extsload`, PositionManager `nextTokenId`, and Permit2 domain/allowance calls must work. The CREATE2 proxy must match the canonical deterministic-deployment-proxy runtime exactly. These checks are necessary, not sufficient to prove full V4 compatibility.

## Wiring And Economics

The plan deploys RigorRegistry, VerificationPool, FeeSplitter, fee escrow, locker, mined hook, buyback vault, factory, executor, launch deployer and launch-and-buy router. The factory itself creates the graduation guard at its first CREATE address. It does **not** create the executor or launch deployer. The hook salt is mined against the real constructor init code for lower 14 bits `0x2044` (beforeInitialize, afterSwap, afterSwapReturnDelta).

The hook is the buyback vault's fee-policy provider. Both its protocol fee recipient and the native launch fee's eventual destination are the FeeSplitter. Its fee-sweep operator is the dedicated deployer. Locker, hook and vault receive the factory once; the hook receives the vault once. Factory receives executor, launch deployer and router forwarder. Public launches open last.

Testnet-only owner configuration uses supported setters without changing contract semantics:

| Setting | Value |
| --- | --- |
| Pons launch fee | 0.00001 ETH |
| Curve phantom reserve / graduation threshold | 0.01 / 0.02 ETH |
| Supply | 1 billion tokens, 18 decimals |
| Curve / hook fee | 100 / 100 bps |
| Core LP fee / tick spacing | 0 / 200 |
| Verification submission fee | 0.00001 ETH |
| Verification minimum pool balance | 0.0001 ETH |
| Tier rewards | 0.00001 through 0.00005 ETH |
| Initial pool seed | 0.001 ETH |

The Pons default anti-snipe tax, split, buyback and vesting behavior are preserved. Only native ETH launch pairs are configured. The FeeSplitter distributes ETH, not ERC20 fees.

Escrow claims debit the caller's credit, so the owner must call `FeeSplitter.claimEscrow(escrow, address(0))` to claim native fees credited to the splitter, not call the escrow directly from the owner wallet. Claiming only receives the funds; a separate, permissionless `distributeFee()` call splits the splitter's entire ETH balance 30% to the verification pool and 70% to the operator by default.

For ERC20 credit, the owner calls `FeeSplitter.claimEscrow(escrow, token)`. Claimed tokens, or protocol vested tokens once delivered to the splitter, remain there until the owner calls `recoverToken(token, recipient, amount)`. There is no automatic ERC20 pool distribution or conversion to ETH. Any conversion is a separate, manual operation; ETH subsequently sent to the splitter can be distributed through the existing native flow.

## Recovery And Limits

An exclusive operation lock prevents concurrent prepare/deploy processes. A crash can leave `.testnet/operation.lock`; remove that file **only after confirming no deployment process is running**. A failed atomic write may leave a `.tmp` file; preserve it and inspect it before removing it. Never delete secrets, the plan or journal to retry a partially deployed wallet.

State saves fsync the file before closing it, then fsync the parent directory after exclusive creation or atomic rename before returning. Wallet initialization retains its exclusive-create, private-permission and no-overwrite safeguards; a persistence failure is not reported as success.

Before each send the tool estimates gas, checks balance and nonce, signs with the dedicated wallet, and journals the exact signed transaction before sending. Resume verifies its recovered signer, chain, nonce, calldata, destination and value against the plan, rechecks successful receipts and runtime hashes, waits for known pending transactions, or rebroadcasts the identical signed transaction. It does not generate replacement transactions or silently redeploy after a revert, changed nonce, reorg, changed artifact or plan mismatch. A pending underpriced transaction may require manual review; there is intentionally no automatic fee bump. Signed journal transactions are sensitive operational data, although they do not contain private keys.

After two confirmations per transaction, the journal records receipt/block and created address/runtime hash. Completion requires all steps and final getters for ownership, dependency wiring, rewards and launch economics. Completion means **deployed and wiring checked**, not end-to-end readiness: launch, buy, sell, graduation/LP locking, escrow distribution, vesting and formal verification payouts still need dedicated testnet smoke tests. Do not advertise completion when `prepare` or `deploy` reports blocked. Source explorer publication is not automated; retained Sourcify inputs/compiler settings provide provenance for subsequent verification.
