# Creator wallet recovery

Issue #764 uses an opt-in, delayed recovery process. The wallet remains the
primary creator identity; a verified recovery contact is only a signal to
start a review and can never directly replace a wallet.

## State machine

```text
pending --(72h + independent review)--> approved
   |                                      |
   +--------------> cancelled            +--> wallet reassociation
```

`src/lib/auth/walletRecovery.js` is the storage-independent state machine.
Production persistence should store a keyed contact hash rather than an email
address, the old/new wallet addresses, timestamps, reviewer id, and append-only
audit actions. It must not store seed phrases, private keys, or recovery tokens
in the profile document.

Before approval, the service must:

1. verify the contact through the existing email provider;
2. notify the old wallet when it is reachable and record delivery status;
3. require a reviewer distinct from the requester;
4. wait the full delay window and reject duplicate/pending requests;
5. write the reassociation and audit event atomically.

Creators without a recovery contact must see a clear onboarding warning that
wallet loss is otherwise unrecoverable. Approval and cancellation are
idempotent terminal actions, and a compromised recovery contact cannot bypass
the delay or reviewer requirement. The tests cover the delay gate, reviewer
requirement, audit entry, and cancellation path.

## Threat model and rollback

The main threat is social engineering a wallet reassociation. The delay,
old-wallet notification, independent review, and append-only audit trail are
the controls. Rolling back the feature leaves existing wallet identities
unchanged; pending requests must be cancelled or expired rather than applied
by an older deployment.
