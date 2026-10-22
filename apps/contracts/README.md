# @hood/contracts

Formal verification contracts (hood-exe-formal-verification-brief.md §3), Foundry.

- `RigorRegistry`: on-chain record of formally verified coins (Σ 100); only the pool upgrades, the owner can revoke.
- `VerificationPool`: submissions with a fee, reward pool, payouts authorised by the verifier bot's EIP-712
  signature (given only after the admin has reviewed a passed proof), pause switches, capped weekly withdrawal.
- `FeeSplitter`: splits fee income between the pool (30%, max 50%) and the operator.

**Not deployed to mainnet.** Local fork only until the contracts are reviewed.

```bash
pnpm --filter @hood/contracts setup   # forge-std + OpenZeppelin (pinned), into lib/ (not committed)
pnpm --filter @hood/contracts test
```

Deploy to the local fork (`pnpm fork` in packages/shared): see `script/Deploy.s.sol`.

For isolated Robinhood testnet (46630) wallet setup, verified Pons artifact preparation and opt-in journaled deployment,
see [TESTNET.md](TESTNET.md). This does not change the local-only defaults of `Deploy.s.sol`.
