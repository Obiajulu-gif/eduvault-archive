/**
 * Manages durable multi-file upload draft sessions.
 * Allows recovery from network drops and prevents publishing listings with missing/unverified CIDs.
 */

export const DRAFT_STATUS = {
  IN_PROGRESS: 'in_progress',
  READY_TO_PUBLISH: 'ready_to_publish',
  PUBLISHED: 'published',
  ABANDONED: 'abandoned'
};

export class MultiFileUploadSessionStore {
  constructor() {
    this.sessions = new Map();
  }

  createDraft(draftId, requiredFiles = ['material', 'thumbnail']) {
    const session = {
      draftId,
      status: DRAFT_STATUS.IN_PROGRESS,
      requiredFiles,
      uploadedFiles: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.sessions.set(draftId, session);
    return session;
  }

  getDraft(draftId) {
    return this.sessions.get(draftId) || null;
  }

  recordFileProgress(draftId, fileKey, fileData) {
    const draft = this.sessions.get(draftId);
    if (!draft) throw new Error(`Draft session ${draftId} not found`);

    draft.uploadedFiles[fileKey] = {
      cid: fileData.cid,
      status: fileData.status || 'pinned', // 'pinned' or 'pending'
      filename: fileData.filename,
      uploadedAt: new Date().toISOString()
    };
    draft.updatedAt = new Date().toISOString();

    const allVerified = draft.requiredFiles.every(
      (key) => draft.uploadedFiles[key] && draft.uploadedFiles[key].status === 'pinned'
    );

    if (allVerified) {
      draft.status = DRAFT_STATUS.READY_TO_PUBLISH;
    }

    return draft;
  }

  canPublishListing(draftId) {
    const draft = this.sessions.get(draftId);
    if (!draft) return { allowed: false, reason: 'Draft not found' };

    const missingFiles = draft.requiredFiles.filter(
      (key) => !draft.uploadedFiles[key] || draft.uploadedFiles[key].status !== 'pinned'
    );

    if (missingFiles.length > 0) {
      return {
        allowed: false,
        reason: `Cannot publish listing: missing or unverified components [${missingFiles.join(', ')}]`,
        missingFiles
      };
    }

    return { allowed: true };
  }

  publishListing(draftId) {
    const check = this.canPublishListing(draftId);
    if (!check.allowed) {
      throw new Error(check.reason);
    }

    const draft = this.sessions.get(draftId);
    draft.status = DRAFT_STATUS.PUBLISHED;
    draft.updatedAt = new Date().toISOString();
    return draft;
  }

  getAbandonedDrafts(staleAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    const abandoned = [];
    for (const [id, session] of this.sessions.entries()) {
      if (session.status === DRAFT_STATUS.IN_PROGRESS && now - new Date(session.updatedAt).getTime() > staleAgeMs) {
        abandoned.push(session);
      }
    }
    return abandoned;
  }
}

export const globalDraftStore = new MultiFileUploadSessionStore();
