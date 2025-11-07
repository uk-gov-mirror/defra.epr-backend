import { fetchJson } from '#common/helpers/fetch-json.js'
import jwt from '@hapi/jwt'
import { config } from '../../config.js'

import { defraIdJwtOptions } from './defra-id.js'

export const auth = {
  plugin: {
    name: 'auth',
    version: '1.0.0',
    register: async (server) => {
      await server.register(jwt)

      const { payload } = await fetchJson(
        config.get('oidc.defraId.configurationUrl')
      )
      const defraIdWellKnownDetails = payload ?? {}

      server.auth.strategy(
        'defra-id-access-token',
        'jwt',
        defraIdJwtOptions(defraIdWellKnownDetails)
      )

      server.auth.scheme('delegating', delegatingAuthScheme)

      server.auth.strategy('access-token', 'delegating', {
        candidateStrategies: [
          {
            strategy: 'defra-id-access-token',
            test(token) {
              return token.iss === defraIdWellKnownDetails.issuer
            }
          }
        ]
      })
    }
  }
}

function delegatingAuthScheme(server, { candidateStrategies }) {
  const extractAndDecodeBearerToken = (request) => {
    // TODO throw Boom.unauthorized if authorization header missing
    // TODO throw Boom.unauthorized if scheme not Bearer
    // TODO throw Boom.unauthorized if token not Bearer
    const [, token] = request.headers.authorization.split(/\s+/)

    // TODO throw Boom.unauthorized if decode fails
    return jwt.token.decode(token).decoded.payload
  }

  return {
    async authenticate(request, h) {
      const decodedToken = extractAndDecodeBearerToken(request)

      const { strategy } = candidateStrategies.find((candidate) =>
        candidate.test(decodedToken)
      )

      // TODO throw Boom.unauthorized if no strategy found to delgate to

      const { credentials, artifacts } = await server.auth.test(
        strategy,
        request
      )

      return h.authenticated({ credentials, artifacts })
    }
  }
}
