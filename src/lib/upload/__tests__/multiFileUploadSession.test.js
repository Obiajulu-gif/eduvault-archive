import { describe, it, expect, beforeEach } from 'vitest';
import { MultiFileUploadSessionStore, DRAFT_STATUS } from '../multiFileUploadSession.js';

describe('Multi-File Upload Session Recovery', () => {
  let store;

  beforeEach(() => {
    store = new MultiFileUploadSessionStore();
  });

  it('tracks progress and resumes without re-uploading completed files', () => {
    const draft = store.createDraft('draft-101', ['material', 'thumbnail']);
    store.recordFileProgress('draft-101', 'thumbnail', { cid: 'QmThumb123', status: 'pinned' });

    const retrieved = store.getDraft('draft-101');
    expect(retrieved.uploadedFiles.thumbnail.cid).toBe('QmThumb123');
    expect(store.canPublishListing('draft-101').allowed).toBe(false);
  });

  it('blocks publication until all required components are pinned', () => {
    store.createDraft('draft-102', ['material', 'thumbnail']);
    store.recordFileProgress('draft-102', 'thumbnail', { cid: 'QmThumb123', status: 'pinned' });

    expect(() => store.publishListing('draft-102')).toThrow(/missing or unverified/);

    store.recordFileProgress('draft-102', 'material', { cid: 'QmMaterial456', status: 'pinned' });
    const check = store.canPublishListing('draft-102');
    expect(check.allowed).toBe(true);

    const published = store.publishListing('draft-102');
    expect(published.status).toBe(DRAFT_STATUS.PUBLISHED);
  });
});
