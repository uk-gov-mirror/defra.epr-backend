import { fetchJson } from '#common/helpers/fetch-json.js'
import jwt from '@hapi/jwt'
import { config } from '../config.js'
import { STATUS } from '#domain/organisations.js'

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

      console.log('DEBUG: defraIdWellKnownDetails', defraIdWellKnownDetails)

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

function defraIdJwtOptions({ jwks_uri: jwksUri, issuer }) {
  console.log(
    'DEBUG: defraIdJwtOptions',
    { jwksUri, issuer },
    config.get('oidc.defraId.clientId')
  )

  return {
    keys: {
      uri: jwksUri
    },
    verify: {
      // aud: config.get('oidc.defraId.clientId'), // @fixme
      aud: false,
      iss: issuer,
      sub: false,
      nbf: false,
      exp: true,
      maxAgeSec: 3600, // 60 minutes
      timeSkewSec: 15
    },
    validate: async (artifacts, request) => {
      const tokenPayload = artifacts.decoded.payload

      console.log('DEBUG: tokenPayload', tokenPayload)

      const credentials = {
        id: tokenPayload.contactId,
        email: tokenPayload.email,
        issuer: tokenPayload.iss,
        scope: await getScope(tokenPayload.email, request)
      }

      // @todo: should we consider returning isValid: false in some situations?
      return { isValid: true, credentials }
    }
  }
}

async function getScope(email, request) {
  const { organisationsRepository, params = {} } = request
  const { organisationId } = params

  const organisation = await organisationsRepository.findById(organisationId)

  // Organisation is not yet approved and API requests associated with it cannot be granted a scope
  if (organisation.status === STATUS.CREATED) {
    return []
  }

  if (organisation.status === STATUS.APPROVED) {
    if (organisation.submitterContactDetails.email === email) {
      await organisationsRepository.update(
        organisationId,
        organisation.version,
        {
          statusHistory: [
            ...organisation.statusHistory,
            {
              status: STATUS.ACTIVE,
              updatedAt: new Date().toISOString()
            }
          ]
        }
      )
    } else {
      // User is not known to us, so we cannot convert organisation data to an 'active' state
      return []
    }
  }

  // @todo: replace this with a collection lookup
  // const knownEmails = ['alice@foo.com', 'bob@bar.com']

  console.log('DEBUG: getScope', { organisation, organisationId })

  return ['user']
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

      console.log('DEBUG: decodedToken', {
        decodedToken,
        params: request.params,
        route: request.route
      })

      const { strategy } = candidateStrategies.find((candidate) =>
        candidate.test(decodedToken)
      )

      console.log('DEBUG: delegateTo', strategy)

      // TODO throw Boom.unauthorized if no strategy found to delgate to

      const { credentials, artifacts } = await server.auth.test(
        strategy,
        request
      )

      return h.authenticated({ credentials, artifacts })
    }
  }
}
