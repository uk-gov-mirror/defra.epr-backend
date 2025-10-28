import Boom from '@hapi/boom'
import Wreck from '@hapi/wreck'
import { getTraceId } from '@defra/hapi-tracing'
import { config } from '../../config.js'

/**
 * Fetch JSON from a given URL
 * @param {string} url
 * @param {Wreck.options} options
 * @returns {Promise<{res: *, error}|{res: *, payload: *}>}
 */
async function fetchJson(url, options = {}) {
  const tracingHeader = config.get('tracing.header')
  const traceId = getTraceId()

  const method = (options?.method || 'get').toLowerCase()

  const { res, payload } = await Wreck[method](url, {
    ...options,
    json: true,
    headers: {
      'Content-Type': 'application/json',
      ...(traceId && { [tracingHeader]: traceId }),
      ...(options?.headers && options.headers)
    }
  })

  return handleResponse({ res, payload })
}

function handleResponse({ res, payload }) {
  if (!res.statusCode || res.statusCode < 200 || res.statusCode > 299) {
    return { res, error: payload || Boom.boomify(new Error('Unknown error')) }
  }

  return { res, payload }
}

export { fetchJson }
