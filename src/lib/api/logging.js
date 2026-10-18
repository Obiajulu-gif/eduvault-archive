import { logger } from '@/lib/logger'
import { ensureCorrelationId, runWithCorrelationId, sanitizeLogFields } from '@/lib/monitoring/telemetry'

export function createRequestLogger(route, method, correlationId) {
  return {
    info: (message, context = {}) => {
      logger.info({
        route,
        method,
        correlationId,
        level: 'info',
        message,
        ...sanitizeLogFields(context),
        timestamp: new Date().toISOString(),
      })
    },
    warn: (message, context = {}) => {
      logger.warn({
        route,
        method,
        correlationId,
        level: 'warn',
        message,
        ...sanitizeLogFields(context),
        timestamp: new Date().toISOString(),
      })
    },
    error: (message, context = {}) => {
      logger.error({
        route,
        method,
        correlationId,
        level: 'error',
        message,
        ...sanitizeLogFields(context),
        timestamp: new Date().toISOString(),
      })
    },
    debug: (message, context = {}) => {
      logger.debug({
        route,
        method,
        correlationId,
        level: 'debug',
        message,
        ...sanitizeLogFields(context),
        timestamp: new Date().toISOString(),
      })
    },
  }
}

export function logApiRequest(route, method, { status, duration, error, details, correlationId } = {}) {
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
  const logFn = logger[level]

  logFn({
    event: 'api_request_completed',
    route,
    method,
    correlationId,
    status,
    durationMs: duration,
    error: error ? sanitizeLogFields({ message: error.message }).message : undefined,
    errorStack: error ? error.stack : undefined,
    ...sanitizeLogFields(details),
    timestamp: new Date().toISOString(),
  })
}

export function logApiError(route, method, error, { status = 500, details, correlationId } = {}) {
  logger.error({
    event: 'api_error',
    route,
    method,
    correlationId,
    status,
    error: sanitizeLogFields({ message: error.message }).message,
    errorStack: error.stack,
    errorName: error.name,
    ...sanitizeLogFields(details),
    timestamp: new Date().toISOString(),
  })
}

export function withRequestLogging(route, method) {
  return async (handler) => {
    return async (request) => {
      const startTime = Date.now()
      const headers = request?.headers
      const incoming = headers?.get?.('x-correlation-id') || headers?.get?.('x-request-id')
      const correlationId = ensureCorrelationId(incoming)
      const log = createRequestLogger(route, method, correlationId)

      return runWithCorrelationId(correlationId, async () => {
        try {
        log.debug('API request received', {
          url: request.url,
          headers: Object.fromEntries(
            Array.from(request.headers.entries())
              .filter(([key]) => !['authorization', 'cookie'].includes(key.toLowerCase()))
              .slice(0, 10)
          ),
        })

        const response = await handler(request, log)
        const duration = Date.now() - startTime

        logApiRequest(route, method, {
          status: response.status,
          duration,
          correlationId,
          details: {
            contentType: response.headers.get('content-type'),
          },
        })

        return response
        } catch (error) {
        const duration = Date.now() - startTime

        logApiError(route, method, error, {
          status: 500,
          correlationId,
          details: {
            duration,
          },
        })

        throw error
        }
      })
    }
  }
}
