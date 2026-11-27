import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api/auth';
import { getDb } from '@/lib/mongodb';
import { extractIdempotencyKey } from '@/lib/backend/idempotency';
import { AppError } from '@/lib/errors/AppError';
import {
  listDeadLetterWebhooks,
  replayDeadLetterWebhook,
  replayDeadLetterWebhooksBatch,
  WebhookReplayError,
} from '@/lib/webhooks/deadLetterReplay';

function mapErrorToResponse(error) {
  if (error instanceof WebhookReplayError) {
    return NextResponse.json(
      { error: error.message, code: error.code, details: error.details },
      { status: error.status }
    );
  }
  if (error instanceof AppError) {
    const status =
      error.code === 'CONFLICT_IDEMPOTENCY_KEY' || error.code === 'CONFLICT_IN_PROGRESS'
        ? 409
        : error.status || 400;
    return NextResponse.json(
      { error: error.message, code: error.code, details: error.details },
      { status }
    );
  }
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
}

export async function GET(request) {
  try {
    const admin = await requireAdmin(request);
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = await getDb();
    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get('limit') || 25);
    const skip = Number(searchParams.get('skip') || 0);

    const data = await listDeadLetterWebhooks(db, {
      actor: { id: admin.sub, role: admin.role || 'admin', isAdmin: true },
      limit,
      skip,
    });

    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    return mapErrorToResponse(error);
  }
}

export async function POST(request) {
  try {
    const admin = await requireAdmin(request);
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const idempotencyKey = extractIdempotencyKey({ headers: request.headers, body });
    if (!idempotencyKey) {
      return NextResponse.json(
        { error: 'Idempotency-Key header or idempotencyKey body field is required', code: 'MISSING_IDEMPOTENCY_KEY' },
        { status: 400 }
      );
    }

    const db = await getDb();
    const actor = { id: admin.sub, role: admin.role || 'admin', isAdmin: true };

    if (Array.isArray(body.entryIds)) {
      const batchResult = await replayDeadLetterWebhooksBatch(db, {
        entryIds: body.entryIds,
        idempotencyKey,
        actor,
        reason: body.reason || 'admin_api_batch_replay',
      });
      return NextResponse.json({ success: batchResult.failed === 0, ...batchResult });
    }

    const result = await replayDeadLetterWebhook(db, {
      entryId: body.entryId,
      deliveryId: body.deliveryId,
      idempotencyKey,
      actor,
      reason: body.reason || 'admin_api_replay',
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return mapErrorToResponse(error);
  }
}
