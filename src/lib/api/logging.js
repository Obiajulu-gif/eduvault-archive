import { logger } from '@/lib/logger'

export function createRequestLogger(route, method) {
  return {
    info: (message, context = {}) => {
      logger.info({
        route,
        method,
        level: 'info',
        message,
        ...context,
        timestamp: new Date().toISOString(),
      })
    },
    warn: (message, context = {}) => {
      logger.warn({
        route,
        method,
        level: 'warn',
        message,
        ...context,
        timestamp: new Date().toISOString(),
      })
    },
    error: (message, context = {}) => {
      logger.error({
        route,
        method,
        level: 'error',
        message,
        ...context,
        timestamp: new Date().toISOString(),
      })
    },
    debug: (message, context = {}) => {
      logger.debug({
        route,
        method,
        level: 'debug',
        message,
        ...context,
        timestamp: new Date().toISOString(),
      })
    },
  }
}

export function logApiRequest(route, method, { status, duration, error, details } = {}) {
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
  const logFn = logger[level]

  logFn({
    event: 'api_request_completed',
    route,
    method,
    status,
    durationMs: duration,
    error: error ? error.message : undefined,
    errorStack: error ? error.stack : undefined,
    ...details,
    timestamp: new Date().toISOString(),
  })
}

export function logApiError(route, method, error, { status = 500, details } = {}) {
  logger.error({
    event: 'api_error',
    route,
    method,
    status,
    error: error.message,
    errorStack: error.stack,
    errorName: error.name,
    ...details,
    timestamp: new Date().toISOString(),
  })
}

export function withRequestLogging(route, method) {
  return async (handler) => {
    return async (request) => {
      const startTime = Date.now()
      const log = createRequestLogger(route, method)

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
          details: {
            contentType: response.headers.get('content-type'),
          },
        })

        return response
      } catch (error) {
        const duration = Date.now() - startTime

        logApiError(route, method, error, {
          status: 500,
          details: {
            duration,
          },
        })

        throw error
      }
    }
  }
}
