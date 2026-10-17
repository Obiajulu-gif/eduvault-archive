# Cross-Environment Configuration Contract (#944)

`src/lib/config/configContract.js` declares, in one table (`CONFIG_CONTRACT`),
which production-critical settings each environment must provide and what
shape they must have. `evaluateConfigContract(env, environment)` checks any env
map against it without touching `process.env`, so the same rules run in unit
tests, against CI workflow env blocks, against `.env.example`, and against a
candidate deployment config before rollout.

It is additive: startup validation in `src/lib/env.js` is unchanged, and
nothing in the app imports the contract at runtime.

## Environments

`development`, `test`, `ci`, `staging`, `production`. Resolved by
`resolveEnvironment(env)`: `EDUVAULT_DEPLOY_ENV` → `VERCEL_ENV`
(`production`/`preview`→`staging`) → `CI=true` → `NODE_ENV` → `development`.
`staging` and `production` are "deployed" and get the strict rules.

## Rules

| Rule | Applies to | Fails when |
| :--- | :--- | :--- |
| `required` / `placeholder` | `NEXT_PUBLIC_APP_URL`, `MONGODB_URI`, `JWT_SECRET`, `PINATA_JWT`, `NEXT_PUBLIC_GATEWAY_URL` (ci + deployed); `NEXT_PUBLIC_STELLAR_NETWORK`, `UNSUBSCRIBE_TOKEN_SECRET` (production) | missing, blank, or a template value (`replace-…`, `your-…`, `changeme`, …) |
| `url` / `https` / `no-localhost` | every URL setting | not absolute http(s); deployed: not https or points at localhost |
| `mongo-uri` / `no-localhost` | `MONGODB_URI` | wrong scheme; deployed: localhost |
| `min-length` | every secret | deployed: shorter than 32 characters |
| `contract-id` / `distinct-contracts` | Soroban contract IDs | not a 56-char `C…` strkey; two settings share one ID |
| `required-with-contracts` | RPC + Horizon URL | deployed with contract IDs but no RPC/Horizon URL |
| `network` / `network-mismatch` | `NEXT_PUBLIC_STELLAR_NETWORK` + URLs | not `TESTNET`/`PUBLIC`; lowercase `public` (chain.js would silently use testnet); PUBLIC with testnet URLs or TESTNET with mainnet URLs |
| `required-with-webhooks` | `STELLAR_WEBHOOK_SECRET`/`CRON_SECRET` | deployed with `WEBHOOK_URL` set and no secret |
| `distinct-secrets` | JWT, download, manifest, unsubscribe, analytics, webhook secrets | deployed: two share a value (warning locally) |
| `public-secret` | any `NEXT_PUBLIC_*` | name looks like a secret, or value is shaped like a Stellar seed / JWT (it would ship to browsers) |
| `stellar-seed` / `stellar-public-key` | refund signer keys | malformed |
| `sandbox-disabled` | `EDUVAULT_SANDBOX` | `true` in staging/production |
| `node-env` | `NODE_ENV` | production contract with `NODE_ENV` ≠ `production` |

Warnings (non-blocking): lowercase `testnet`, hosted DB in local dev, open
inbound Stellar webhook in production, signer secret without public key.

Error messages name settings and rules only — **values are never printed**.

## Drift tests

`src/lib/config/__tests__/configContract.test.js` also fails when:

- a contract setting is not documented in `.env.example`;
- `.env.example` is not a valid development config, or would pass in production;
- a job in `.github/workflows/backend.yml` or `frontend.yml` that runs
  `npm run build` no longer satisfies the `ci` contract;
- `src/lib/env.js` requires a setting in production that the contract does not.

## Dry-running a deployment

```bash
npm run config:contract -- --env production --file .env.production.candidate
npm run config:contract -- --env staging --json   # uses process.env
```

Exit codes: `0` pass, `1` violations, `2` usage error (unknown env, unreadable file).

## Edge cases and failure modes

- **Whitespace-only values** count as missing.
- **`NEXT_PUBLIC_STELLAR_NETWORK=public`** fails: `chain.js` compares with
  `=== 'PUBLIC'`, so this would run production on testnet.
- **`UNSUBSCRIBE_TOKEN_SECRET` unset** fails in production:
  `src/lib/email/unsubscribeToken.js` otherwise falls back to a hard-coded
  default, letting anyone forge unsubscribe links.
- **Hostname heuristics** for network mismatch only recognise the public
  Stellar/Soroban hosts and `testnet`/`futurenet` substrings; a private RPC
  proxy with a neutral hostname is not cross-checked.
- **Placeholder detection** is a denylist + `replace-`/`your-` prefix; a truly
  random-looking placeholder will pass. Pair with secret rotation runbooks.

## Rollback / recovery

- The contract is not on the startup path, so a false positive can never take
  production down. If a rule is wrong, fix or relax the rule in
  `CONFIG_CONTRACT`/`evaluateConfigContract` and the tests together.
- If a deploy was made with a failing config: fix the env in the hosting
  provider, re-run `npm run config:contract -- --env production`, then redeploy.
  For a rotated secret, rotate one secret at a time — `distinct-secrets`
  catches accidental reuse during rotation.
- Reverting this change removes the module, script, tests and the
  `.env.example` documentation lines; no data or schema is affected.
