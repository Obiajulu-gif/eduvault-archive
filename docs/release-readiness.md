# Release readiness for high-risk changes

Use this checklist for changes that can affect learner or creator data, permissions, payments, storage, migrations, production configuration, or service availability. Complete it in the pull request before requesting maintainer review.

## Contributor checklist

- [ ] **Tests:** List the focused tests and broader checks run. Include relevant output and explain any check that could not run.
- [ ] **Documentation:** Update API, operator, and contributor documentation affected by the change.
- [ ] **Migration:** State whether a migration or backfill is needed. Include its dry-run and verification steps, or say `None` with a reason.
- [ ] **Configuration:** List new or changed settings, safe defaults, and deployment steps. Never include secret values.
- [ ] **Rollback:** Explain how to revert the code and any migration or configuration change. Identify data changes that cannot be reversed automatically.
- [ ] **Failure handling:** Describe behavior for partial failure, retries, duplicate requests, and unavailable dependencies where relevant.
- [ ] **Evidence:** Attach logs, screenshots, API examples, or other evidence appropriate to the change, with personal and secret data removed.

If an item does not apply, write `None` and briefly explain why. Do not leave an unchecked item unexplained.

## Maintainer sign-off

The maintainer reviewing a high-risk change confirms that:

- [ ] The evidence and checks are sufficient for the affected systems.
- [ ] Migration, configuration, monitoring, and rollback steps are actionable.
- [ ] Any unresolved risk has an owner and an explicit follow-up plan.
- [ ] The release or deployment plan is appropriate for the impact.

The author should request sign-off from a maintainer with responsibility for the affected area. A passing CI run does not replace this review.

## Urgent fixes and exceptions

When an urgent fix cannot complete the normal checklist before deployment, the responsible maintainer records the exception in the pull request or incident record before release. Record:

1. Which checklist items are deferred and why.
2. The risk accepted and the scope of the urgent deployment.
3. The monitoring or manual verification used during rollout.
4. A named owner and due date for each deferred check or follow-up change.

Urgency does not waive security review, data protection, or required authorization. Complete and link the deferred evidence after the immediate incident is contained.

## Automated checks

Pull requests should use the existing CI checks for the changed area. Backend API changes run the backend integration workflow; frontend changes run the frontend workflow; Soroban contract changes run the contract workflows. Contributors should also run focused local checks from the repository's contribution guide. If CI does not cover a risk described by the pull request, record the manual check and its result.

