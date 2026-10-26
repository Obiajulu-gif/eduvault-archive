# Ownership transfer disputes

Transfer parties or administrators can open a dispute for a pending, accepting,
or completed ownership transfer. An open or under-review dispute places the
transfer on hold: accept, decline, and cancel operations fail with a conflict
until an administrator resolves the dispute as accepted or rejected.

Disputes retain bounded evidence references and an append-only history. A
resolution records the administrator, reason, timestamp, and outcome; it does
not silently rewrite ownership. Any corrective ownership action must therefore
use the normal transfer workflow and produce its own audit trail.
