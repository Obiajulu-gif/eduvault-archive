import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NOTE_STATES, NOTE_TYPES, NOTE_VISIBILITY, createMaintainerNote, editMaintainerNote,
  redactMaintainerNote, archiveMaintainerNote, expireMaintainerNote, canViewMaintainerNote,
} from "../../src/lib/notes/maintainerNotes.js";

const admin = { id: "admin-1", role: "admin" };
const support = { id: "support-1", role: "support" };
const other = { id: "support-2", role: "support" };
const now = "2026-10-20T12:00:00.000Z";

test("maintainer notes have structured type, visibility, retention, and audit metadata", () => {
  const note = createMaintainerNote({ actor: support, targetId: "case-1", type: NOTE_TYPES.SECURITY, visibility: NOTE_VISIBILITY.PRIVATE, body: "Review recovery evidence.", now });
  assert.equal(note.state, NOTE_STATES.ACTIVE);
  assert.equal(note.retentionDays, 730);
  assert.equal(note.audit[0].event, "maintainer_note.created");
  assert.equal(canViewMaintainerNote(note, support, now), true);
  assert.equal(canViewMaintainerNote(note, other, now), false);
});

test("authors can edit and archive, while admins can redact and preserve audit references", () => {
  const note = createMaintainerNote({ actor: support, targetId: "case-1", type: NOTE_TYPES.SUPPORT, body: "Initial", now });
  const edited = editMaintainerNote(note, { actor: support, body: "Updated", now: "2026-10-21T12:00:00Z" });
  const redacted = redactMaintainerNote(edited, { actor: admin, now: "2026-10-22T12:00:00Z" });
  assert.equal(redacted.body, "[REDACTED]");
  assert.equal(redacted.audit.some((event) => event.event === "maintainer_note.created"), true);
  assert.equal(redacted.audit.at(-1).event, "maintainer_note.redacted");
  assert.equal(archiveMaintainerNote(redacted, { actor: admin, now: "2026-10-23T12:00:00Z" }).state, NOTE_STATES.ARCHIVED);
});

test("retention expiry archives notes and unauthorized actions fail", () => {
  const note = createMaintainerNote({ actor: support, targetId: "case-1", type: NOTE_TYPES.SUPPORT, body: "Old", retentionDays: 1, now });
  assert.equal(expireMaintainerNote(note, { now: "2026-10-22T12:00:00Z" }).state, NOTE_STATES.ARCHIVED);
  assert.throws(() => editMaintainerNote(note, { actor: other, body: "Nope", now }), /author or an admin/);
  assert.throws(() => redactMaintainerNote(note, { actor: support, now }), /Only admins/);
});
