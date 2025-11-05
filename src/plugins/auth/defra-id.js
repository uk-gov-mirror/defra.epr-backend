import { ROLE, STATUS } from '#domain/organisations/status.js'
import { organisationsLinkPath } from '#domain/organisations/paths.js'
import { StatusCodes } from 'http-status-codes'

function getCurrentRelationship(relationships) {
  return relationships.find(({ isCurrent }) => isCurrent)
}

async function findOrganisationMatches(email, defraIdOrgId, request) {
  const { organisationsRepository } = request
  let linkedOrganisations
  let unlinkedOrganisations

  try {
    unlinkedOrganisations =
      await organisationsRepository.findAllLinkedOrganisationsByUser({
        email,
        isInitialUser: true
      })
    const linkedOrganisationId =
      await organisationsRepository.findByDefraIdOrgId(defraIdOrgId)
    linkedOrganisations = linkedOrganisationId ? [linkedOrganisationId] : []
  } catch (error) {
    linkedOrganisations = []
    unlinkedOrganisations = []

    request.logger.error(error, 'defra-id: failed to find Organisation matches')
  }

  request.logger.debug('defra-id: findOrganisationMatches', {
    unlinkedOrganisations,
    linkedOrganisations,
    defraIdOrgId
  })

  return {
    all: [...unlinkedOrganisations, ...linkedOrganisations].reduce(
      (prev, organisation) =>
        prev.find(({ id }) => id === organisation.id)
          ? prev
          : [...prev, organisation],
      []
    ),
    unlinked: unlinkedOrganisations,
    linked: linkedOrganisations
  }
}

function isLinkedUser(organisation, defraIdOrgId) {
  return organisation.defraIdOrgId === defraIdOrgId
}

function isInitialUser(organisation, email) {
  return !!organisation.users.find(
    (user) => user.email === email && !!user.isInitialUser
  )
}

function getOrgDataFromToken(tokenPayload) {
  const { currentRelationshipId, relationships } = tokenPayload

  return relationships.map((relationship) => {
    const [relationshipId, organisationId, organisationName] =
      relationship?.split(':')

    return {
      defraIdRelationshipId: relationshipId,
      defraIdOrgId: organisationId,
      defraIdOrgName: organisationName?.trim(),
      isCurrent: currentRelationshipId === relationshipId
    }
  })
}

function getOrganisationsSummary(organisations) {
  return organisations.map(({ orgId, id, companyDetails }) => ({
    id,
    orgId,
    name: companyDetails.name,
    tradingName: companyDetails.tradingName
  }))
}

async function validateRequest(tokenPayload, request, h) {
  const { email } = tokenPayload
  const { organisationsRepository, params = {} } = request
  const { organisationId } = params
  const defraIdRelationships = getOrgDataFromToken(tokenPayload)
  const { defraIdOrgId, defraIdOrgName } =
    getCurrentRelationship(defraIdRelationships) || {}

  console.log('tokenPayload', tokenPayload)

  // No defraIdOrgId to link
  if (!defraIdOrgId) {
    request.logger.warn('defra-id: defraIdOrgId not found in token')

    return { scope: [] }
  }

  request.server.app.organisationId = organisationId.trim()
  request.server.app.defraIdOrgId = defraIdOrgId
  request.server.app.defraIdOrgName = defraIdOrgName

  // Request is for a specific organisation
  if (organisationId) {
    const organisationById =
      await organisationsRepository.findById(organisationId)
    const isInitial = isInitialUser(organisationById, email)

    if (request.route.path === organisationsLinkPath && isInitial) {
      // Linking organisation is allowed because a known user is requesting to link it
      request.logger.debug('defra-id: approve organisation', organisationById)

      return { scope: ['user_can_link_organisation'] }
    }

    // Organisation has a status allowing it to be accessed
    if ([STATUS.ACTIVE, STATUS.SUSPENDED].includes(organisationById.status)) {
      const isLinked = isLinkedUser(organisationById, defraIdOrgId)
      const isAuthorised = isLinked || isInitial
      const shouldAddUser = isLinked && !isInitial

      request.logger.debug('defra-id: organisation is active or suspended', {
        isAuthorised,
        shouldAddUser
      })

      if (shouldAddUser) {
        await organisationsRepository.update(
          organisationById.id,
          organisationById.version,
          {
            users: [
              ...organisationById.users,
              {
                email,
                fullName: `${tokenPayload.firstName} ${tokenPayload.lastName}`,
                isInitialUser: false,
                roles: [ROLE.STANDARD_USER]
              }
            ]
          }
        )
      }

      return {
        scope: isAuthorised ? ['user'] : []
      }
    }
  }

  const organisations = await findOrganisationMatches(
    email,
    defraIdOrgId,
    request
  )

  const hasUnlinkedOrganisations = organisations.unlinked.length > 0
  const currentLinkedOrganisation = organisations.linked.find(
    (organisation) => defraIdOrgId === organisation.defraIdOrgId
  )

  console.log(
    'currentLinkedOrganisation',
    !currentLinkedOrganisation ||
      currentLinkedOrganisation.id !== organisationId,
    organisations.all.find(({ id }) => id === organisationId)
  )

  // Organisation is not yet approved
  // if (
  //   currentLinkedOrganisation &&
  //   currentLinkedOrganisation.status !== STATUS.APPROVED
  // ) {
  //   request.logger.warn(
  //     'defra-id: organisation is not yet approved and access cannot be authorised'
  //   )
  //
  //   return { scope: [] }
  // }

  // Organisation requested does not match the organisations the user is associated with
  if (!organisations.all.find(({ id }) => id === organisationId)) {
    request.logger.warn(
      'defra-id: user is not associated with this organisation'
    )

    return { scope: [] }
  }

  // Current Organisation in token not linked or the organisation requested does not match the current Organisation in the token
  if (
    !currentLinkedOrganisation ||
    currentLinkedOrganisation.id !== organisationId
  ) {
    const message = 'No linked organisation found'
    request.logger.warn(`defra-id: ${message}`)
    console.dir({ currentLinkedOrganisation })
    const isCurrentOrganisationLinked = !!currentLinkedOrganisation

    return {
      scope: [],
      response: h
        .response({
          action: 'link-organisations',
          defraId: {
            userId: tokenPayload.id,
            orgName: defraIdOrgName,
            otherRelationships: defraIdRelationships.filter(
              ({ isCurrent }) => !isCurrent
            )
          },
          isCurrentOrganisationLinked,
          message,
          organisationId,
          organisations: hasUnlinkedOrganisations
            ? getOrganisationsSummary(organisations.unlinked)
            : []
        })
        .code(StatusCodes.PARTIAL_CONTENT)
    }
  }

  // Organisation requested does not match the organisation the user is associated with
  if (organisationId && organisationId !== currentLinkedOrganisation.id) {
    request.logger.warn(
      'defra-id: organisation requested does not match the organisation the user is associated with'
    )
    console.dir({ currentLinkedOrganisation, organisationId })

    return { scope: [] }
  }

  request.logger.warn('defra-id: organisation could not be matched for user')

  return { scope: [] }
}

export function defraIdJwtOptions({ jwks_uri: jwksUri, issuer }) {
  return {
    keys: {
      uri: jwksUri
    },
    verify: {
      aud: false, // aud doesn't appear to be supported by cdp-defra-id-stub and is not used on the FE via @hapi/bell
      iss: issuer,
      sub: false,
      nbf: false,
      exp: true,
      maxAgeSec: 3600, // 60 minutes
      timeSkewSec: 15
    },
    validate: async (artifacts, request, h) => {
      const tokenPayload = artifacts.decoded.payload

      request.logger.debug('defra-id: tokenPayload', tokenPayload)

      const { scope, response } = await validateRequest(
        tokenPayload,
        request,
        h
      )

      const isValid = !!scope?.length

      const credentials = isValid
        ? {
            id: tokenPayload.contactId,
            email: tokenPayload.email,
            issuer: tokenPayload.iss,
            scope
          }
        : undefined

      return response
        ? {
            response
          }
        : {
            isValid,
            credentials
          }
    }
  }
}
