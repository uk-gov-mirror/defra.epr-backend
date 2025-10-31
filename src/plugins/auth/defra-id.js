import { ROLE, STATUS } from '#domain/organisations/status.js'
import { defraIdOrgIdSchema } from '#repositories/organisations/schema.js'

function getCurrentRelationship({ currentRelationshipId, relationships }) {
  return relationships.find((relationship) =>
    relationship.startsWith(`${currentRelationshipId}:`)
  )
}

async function findOrganisationMatches(email, defraIdOrgId, request) {
  const { organisationsRepository } = request
  let organisationsByDefraIdOrgId

  const organisationsByEmail = await organisationsRepository.findAllByUser({
    email,
    isInitialUser: true
  })

  try {
    organisationsByDefraIdOrgId = [
      await organisationsRepository.findAllByDefraIdOrgId(defraIdOrgId)
    ]
  } catch (error) {
    organisationsByDefraIdOrgId = []

    // @todo: log this scenario
  }

  console.log(
    'DEBUG: findOrganisationMatches',
    organisationsByEmail,
    organisationsByDefraIdOrgId,
    defraIdOrgId
  )

  return [...organisationsByEmail, ...organisationsByDefraIdOrgId].reduce(
    (prev, organisation) =>
      prev.find(({ id }) => id === organisation.id)
        ? prev
        : [...prev, organisation],
    []
  )
}

function isLinkedUser(organisation, defraIdOrgId) {
  const isLinked = organisation.defraIdOrgId === defraIdOrgId

  console.log('DEBUG: isLinkedUser', { defraIdOrgId, isLinked })

  return isLinked
}

function isKnownUser(organisation, email) {
  const isKnown = !!organisation.users.find((user) => user.email === email)

  console.log('DEBUG: isKnownUser', { email, isKnown })

  return isKnown
}

function isAuthorisedUser(organisation, { defraIdOrgId, email }) {
  const isAuthorised =
    isLinkedUser(organisation, defraIdOrgId) || isKnownUser(organisation, email)
  console.log('DEBUG: isAuthorisedUser', { defraIdOrgId, email, isAuthorised })

  return isAuthorised
}

function getOrgDataFromToken(tokenPayload) {
  const relationship = getCurrentRelationship(tokenPayload)
  const [, organisationId, organisationName] = relationship?.split(':')

  return {
    defraIdOrgId: organisationId,
    defraIdOrgName: organisationName?.trim()
  }
}

async function getScope(email, tokenPayload, request) {
  const { organisationsRepository, params = {} } = request
  const { organisationId } = params
  const { defraIdOrgId } = getOrgDataFromToken(tokenPayload)

  // No defraIdOrgId to link
  if (!defraIdOrgId) {
    console.warn('No defraIdOrgId found in token')

    return []
  }

  // Request is for a specific organisation
  if (organisationId) {
    const organisationById =
      await organisationsRepository.findById(organisationId)

    console.log('DEBUG: organisationById', organisationById)

    // Organisation has a status allowing it to be accessed
    if ([STATUS.ACTIVE, STATUS.SUSPENDED].includes(organisationById.status)) {
      const isLinked = isLinkedUser(organisationById, defraIdOrgId)
      const isKnown = isKnownUser(organisationById, email)
      const isAuthorised = isLinked || isKnown
      const shouldAddUser = isLinked && !isKnown

      console.log('DEBUG: organisation is active or suspended', {
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

      return isAuthorised ? ['user'] : []
    }
  }

  const [organisation, ...otherOrganisations] = await findOrganisationMatches(
    email,
    defraIdOrgId,
    request
  )

  console.log('DEBUG: organisation', {
    organisation,
    otherOrganisations
  })

  // More than one organisation matched
  if (otherOrganisations.length > 0) {
    console.warn('More than one organisation matched')

    return []
  }

  // Organisation requested does not match the organisation the user is associated with
  if (organisationId && organisationId !== organisation.id) {
    console.warn(
      'Organisation requested does not match the organisation the user is associated with'
    )

    return []
  }

  // Organisation is not yet approved
  if (!organisation || organisation.status !== STATUS.APPROVED) {
    console.warn('Organisation is not yet approved')

    return []
  }

  // Organisation is approved and the user is associated with it
  if (
    organisation.status === STATUS.APPROVED &&
    isAuthorisedUser(organisation, { defraIdOrgId, email })
  ) {
    console.log('DEBUG: approve organisation', organisation)

    if (!organisation.defraIdOrgId) {
      console.log('Linking organisation to defraIdOrgId', defraIdOrgId)
    }

    await organisationsRepository.update(
      organisation.id,
      organisation.version,
      {
        status: STATUS.ACTIVE,
        defraIdOrgId: `${defraIdOrgId}`,
        registrations: organisation.registrations.reduce(
          (prev, registration) =>
            registration.status === STATUS.APPROVED
              ? [...prev, { ...registration, status: STATUS.ACTIVE }]
              : prev,
          []
        ),
        accreditations: organisation.accreditations.reduce(
          (prev, accreditation) =>
            accreditation.status === STATUS.APPROVED
              ? [...prev, { ...accreditation, status: STATUS.ACTIVE }]
              : prev,
          []
        )
      }
    )

    return ['user']
  }

  console.warn('Organisation could not be matched for user')

  return []
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
    validate: async (artifacts, request) => {
      const tokenPayload = artifacts.decoded.payload

      console.log('DEBUG: tokenPayload', tokenPayload)

      const credentials = {
        id: tokenPayload.contactId,
        email: tokenPayload.email,
        issuer: tokenPayload.iss,
        scope: await getScope(tokenPayload.email, tokenPayload, request)
      }

      // @todo: should we consider returning isValid: false in some situations?
      return { isValid: true, credentials }
    }
  }
}
