import { ObjectId } from 'mongodb'
import { SCHEMA_VERSION } from '#common/enums/index.js'

import { getAllowedUsers } from '#domain/organisations/get-allowed-users.js'

export function eprOrganisationFactory({ id, ...eprOrganisation }) {
  return {
    ...eprOrganisation,
    _id: new ObjectId(id),
    schemaVersion: SCHEMA_VERSION,
    allowedUsers: getAllowedUsers(eprOrganisation)
  }
}
