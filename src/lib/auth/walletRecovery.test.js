import { describe, expect, it } from "vitest";
import {
  RECOVERY_DELAY_MS,
  approveRecovery,
  cancelRecovery,
  createRecoveryRequest,
} from "./walletRecovery";

describe("wallet recovery state machine", () => {
  const input = {
    profileId: "profile-1",
    oldWallet: "old-wallet",
    newWallet: "new-wallet",
    verifiedContactHash: "contact-hash",
    now: 1000,
  };

  it("requires a delay and a reviewer before reassociation", () => {
    const request = createRecoveryRequest(input);
    expect(() => approveRecovery(request, { now: 1000, reviewerId: "reviewer" })).toThrow(
      "recovery_delay_active",
    );
    const approved = approveRecovery(request, {
      now: 1000 + RECOVERY_DELAY_MS,
      reviewerId: "reviewer",
    });
    expect(approved.state).toBe("approved");
    expect(approved.audit).toHaveLength(2);
  });

  it("allows a pending request to be cancelled", () => {
    const cancelled = cancelRecovery(createRecoveryRequest(input), { actor: "old-wallet" });
    expect(cancelled.state).toBe("cancelled");
  });
});
