import { STATUS } from '#domain/organisations/status.js'

function getCurrentRelationship({ currentRelationshipId, relationships }) {
  return relationships.find((relationship) =>
    relationship.startsWith(`${currentRelationshipId}:`)
  )
}

async function findOrganisationMatches(email, orgNameFromToken, request) {
  const { organisationsRepository } = request
  const organisationsByEmail =
    await organisationsRepository.findAllByAssociatedEmail(email)

  /**
   * @todo: do we even need to match organisations by name?
   * Handling matches by OrgName adds a lot of complexity that we don't need if
   * the emails can be extracted from the organisation data.
   */
  // const organisationsByName =
  //   await organisationsRepository.findAllByCompanyName(orgNameFromToken)
  const organisationsByName = []

  return [...organisationsByName, ...organisationsByEmail].reduce(
    (prev, organisation) =>
      prev.find(({ id }) => id === organisation.id)
        ? prev
        : [...prev, organisation],
    []
  )
}

function isAllowedUser(organisation, email) {
  return organisation.allowedUsers.find((user) => user.email === email)
}

function getOrgNameFromToken(tokenPayload) {
  const relationship = getCurrentRelationship(tokenPayload)
  const [, , organisationName] = relationship?.split(':')

  return organisationName?.trim()
}

async function getScope(email, tokenPayload, request) {
  const { organisationsRepository, params = {} } = request
  const { organisationId } = params
  const orgNameFromToken = getOrgNameFromToken(tokenPayload)

  // No organisation name to match on
  if (!orgNameFromToken) {
    console.warn('No organisation name found in token')

    return []
  }

  // Request is for a specific organisation
  if (organisationId) {
    const organisationById =
      await organisationsRepository.findById(organisationId)

    console.log('DEBUG: organisationById', organisationById)

    // Organisation has a status allowing it to be accessed
    if ([STATUS.ACTIVE, STATUS.SUSPENDED].includes(organisationById.status)) {
      return isAllowedUser(organisationById, email) ? ['user'] : []
    }
  }

  const [organisation, ...otherOrganisations] = await findOrganisationMatches(
    email,
    orgNameFromToken,
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
    isAllowedUser(organisation, email)
  ) {
    console.log('DEBUG: approve organisation', organisation)

    await organisationsRepository.update(
      organisation.id,
      organisation.version,
      {
        status: STATUS.ACTIVE,
        registrations: organisation.registrations.map((registration) =>
          registration.status === STATUS.APPROVED
            ? { ...registration, status: STATUS.ACTIVE }
            : {}
        ),
        accreditations: organisation.accreditations.map((accreditation) =>
          accreditation.status === STATUS.APPROVED
            ? { ...accreditation, status: STATUS.ACTIVE }
            : {}
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
