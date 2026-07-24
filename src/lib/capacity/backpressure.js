/**
 * Stream backpressure — utilities for streaming downloads and uploads
 * that honor backpressure without buffering full files.
 *
 * When a downstream consumer is slow, the producer pauses. When the
 * consumer disconnects, the producer is notified and can cancel
 * downstream work (e.g., IPFS fetch, DB query).
 */

import { PassThrough, Readable, finished } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// ── Bounded Stream Transformer ───────────────────────────────────────────────

/**
 * Create a transform stream that enforces a maximum buffer size.
 * When the buffer is full, the source stream is paused (backpressure).
 *
 * @param {object} opts
 * @param {number} opts.maxBufferBytes - Maximum bytes to buffer before applying backpressure
 * @param {AbortSignal} [opts.signal] - Abort signal for client disconnect
 * @returns {PassThrough}
 */
export function createBackpressuredStream({ maxBufferBytes = 64 * 1024, signal } = {}) {
  const stream = new PassThrough({
    highWaterMark: maxBufferBytes,
    objectMode: false,
  });

  if (signal) {
    signal.addEventListener('abort', () => {
      stream.destroy(new Error('Client disconnected'));
    });
  }

  return stream;
}

/**
 * Pipe a readable stream through a backpressured passthrough, respecting
 * client disconnect. Cleans up all streams on completion or error.
 *
 * @param {Readable} source - The data source (e.g., IPFS fetch body)
 * @param {PassThrough} through - The backpressured passthrough
 * @param {AbortSignal} [signal] - Client disconnect signal
 * @returns {Promise<void>}
 */
export async function pipeWithBackpressure(source, through, signal) {
  try {
    await pipeline(source, through, { signal });
  } catch (err) {
    if (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || signal?.aborted) {
      // Client disconnected — clean up silently
      source.destroy?.();
      through.destroy?.();
      return;
    }
    throw err;
  }
}

// ── Client Disconnect Handler ────────────────────────────────────────────────

/**
 * Create an AbortController tied to a request's abort event.
 * When the client disconnects, the signal fires and downstream work
 * (DB queries, IPFS fetches, RPC calls) can be cancelled.
 *
 * @param {Request} request - The incoming Next.js request
 * @returns {{ signal: AbortSignal, cleanup: () => void }}
 */
export function createDisconnectSignal(request) {
  const controller = new AbortController();

  const cleanup = () => {
    request.signal?.removeEventListener('abort', onAbort);
  };

  const onAbort = () => {
    controller.abort();
    cleanup();
  };

  if (request.signal) {
    if (request.signal.aborted) {
      controller.abort();
    } else {
      request.signal.addEventListener('abort', onAbort);
    }
  }

  return { signal: controller.signal, cleanup };
}

// ── Bounded Queue for Background Work ────────────────────────────────────────

/**
 * A bounded async queue that applies backpressure when full.
 * Used for background work like IPFS retries and worker jobs.
 *
 * @param {object} opts
 * @param {number} opts.maxSize - Maximum queue depth
 * @param {number} opts.maxConcurrency - Maximum concurrent processing
 * @returns {{ push: (item: any) => Promise<void>, size: () => number, pending: () => number }}
 */
export function createBoundedQueue({ maxSize = 100, maxConcurrency = 5 } = {}) {
  let queue = [];
  let processing = 0;
  const waiters = [];

  function size() { return queue.length; }
  function pending() { return processing; }

  function tryProcess() {
    while (processing < maxConcurrency && queue.length > 0) {
      const { item, resolve } = queue.shift();
      processing++;
      resolve(item);
    }
  }

  function push(item) {
    return new Promise((resolve, reject) => {
      if (queue.length >= maxSize) {
        reject(new Error(`Queue full: ${queue.length}/${maxSize}`));
        return;
      }
      queue.push({ item, resolve });
      tryProcess();
    });
  }

  function markDone() {
    processing = Math.max(0, processing - 1);
    tryProcess();
  }

  return {
    push,
    size,
    pending,
    markDone,
  };
}

// ── Streaming Download with Cancellation ─────────────────────────────────────

/**
 * Create a streaming response that supports client disconnect cancellation.
 * The upstream fetch is aborted if the client disconnects.
 *
 * @param {object} params
 * @param {string} params.url - URL to fetch
 * @param {AbortSignal} params.signal - Disconnect signal
 * @param {object} [params.fetchOptions] - Additional fetch options
 * @returns {Promise<{ body: ReadableStream, contentType: string, contentLength: number|null, abort: () => void }>}
 */
export async function createCancellableStream({ url, signal, fetchOptions = {} }) {
  const controller = new AbortController();

  // Link external signal to internal controller
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  const response = await fetch(url, {
    ...fetchOptions,
    signal: controller.signal,
  });

  if (!response.ok) {
    throw new Error(`Upstream fetch failed: ${response.status} ${response.statusText}`);
  }

  return {
    body: response.body,
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    contentLength: response.headers.get('content-length')
      ? parseInt(response.headers.get('content-length'), 10)
      : null,
    abort: () => controller.abort(),
    status: response.status,
  };
}
