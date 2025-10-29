import {
  validateEmail,
  validateId,
  validateCompanyName,
  validateOrganisationInsert,
  validateOrganisationUpdate
} from './validation.js'
import {
  SCHEMA_VERSION,
  createInitialStatusHistory,
  getCurrentStatus,
  statusHistoryWithChanges,
  mergeSubcollection
} from './helpers.js'
import Boom from '@hapi/boom'
import { ObjectId } from 'mongodb'
import { getAllowedUsers } from '#domain/organisations/get-allowed-users.js'

const COLLECTION_NAME = 'epr-organisations'
const MONGODB_DUPLICATE_KEY_ERROR_CODE = 11000

const mapDocumentWithCurrentStatuses = (org) => {
  const { _id, ...rest } = org

  rest.status = getCurrentStatus(rest)

  for (const item of rest.registrations ?? []) {
    item.status = getCurrentStatus(item)
  }

  for (const item of rest.accreditations ?? []) {
    item.status = getCurrentStatus(item)
  }
  return { id: _id.toString(), ...rest }
}

const performInsert = async (db, organisation) => {
  const validated = validateOrganisationInsert(organisation)
  const { id, ...orgFields } = validated

  const registrations =
    orgFields.registrations?.map((reg) => ({
      ...reg,
      statusHistory: createInitialStatusHistory()
    })) || []

  const accreditations =
    orgFields.accreditations?.map((acc) => ({
      ...acc,
      statusHistory: createInitialStatusHistory()
    })) || []

  const data = {
    _id: ObjectId.createFromHexString(id),
    version: 1,
    schemaVersion: SCHEMA_VERSION,
    statusHistory: createInitialStatusHistory(),
    ...orgFields,
    registrations,
    accreditations
  }

  try {
    await db.collection(COLLECTION_NAME).insertOne({
      ...data,
      allowedUsers: getAllowedUsers(data)
    })
  } catch (error) {
    if (error.code === MONGODB_DUPLICATE_KEY_ERROR_CODE) {
      throw Boom.conflict(`Organisation with ${id} already exists`)
    }
    throw error
  }
}

const performUpdate = async (db, id, version, updates) => {
  const validatedId = validateId(id)
  const validatedUpdates = validateOrganisationUpdate(updates)

  const existing = await db
    .collection(COLLECTION_NAME)
    .findOne({ _id: ObjectId.createFromHexString(validatedId) })

  if (!existing) {
    throw Boom.notFound(`Organisation with id ${validatedId} not found`)
  }

  const merged = {
    ...existing,
    ...validatedUpdates
  }

  const registrations = mergeSubcollection(
    existing.registrations,
    validatedUpdates.registrations
  )
  const accreditations = mergeSubcollection(
    existing.accreditations,
    validatedUpdates.accreditations
  )

  const data = {
    ...merged,
    statusHistory: statusHistoryWithChanges(validatedUpdates, existing),
    registrations,
    accreditations,
    version: existing.version + 1
  }

  const result = await db.collection(COLLECTION_NAME).updateOne(
    { _id: ObjectId.createFromHexString(validatedId), version },
    {
      $set: {
        ...data,
        allowedUsers: getAllowedUsers(data)
      }
    }
  )

  if (result.matchedCount === 0) {
    throw Boom.conflict(
      `Version conflict: attempted to update with version ${version} but current version is ${existing.version}`
    )
  }
}

const performFindById = async (db, id) => {
  // validate the ID and throw early
  let validatedId
  try {
    validatedId = validateId(id)
  } catch (error) {
    throw Boom.notFound(`Organisation with id ${id} not found`)
  }

  const doc = await db
    .collection(COLLECTION_NAME)
    .findOne({ _id: ObjectId.createFromHexString(validatedId) })

  if (!doc) {
    throw Boom.notFound(`Organisation with id ${id} not found`)
  }

  return mapDocumentWithCurrentStatuses(doc)
}

const performFindAllByAssociatedEmail = async (db, email) => {
  // validate the name and throw early
  let validatedEmail
  try {
    validatedEmail = validateEmail(email)
  } catch (error) {
    throw Boom.notFound(`Organisation with provided email not found`)
  }

  const docs = await db
    .collection(COLLECTION_NAME)
    .find({
      $or: [
        { 'registrations.approvedPersons.email': validatedEmail },
        { 'allowedUsers.email': validatedEmail }
      ]
    })
    .toArray()

  if (!docs.length) {
    throw Boom.notFound(`No organisations with provided email found`)
  }

  return docs.map((doc) => mapDocumentWithCurrentStatuses(doc))
}

const performFindAllByCompanyName = async (db, name) => {
  // validate the name and throw early
  let validatedName
  try {
    validatedName = validateCompanyName(name)
  } catch (error) {
    throw Boom.notFound(`Organisation with name ${name} not found`)
  }

  const docs = await db
    .collection(COLLECTION_NAME)
    .find({ 'companyDetails.name': validatedName })
    .toArray()

  if (!docs.length) {
    throw Boom.notFound(`No organisations with name ${name} found`)
  }

  return docs.map((doc) => mapDocumentWithCurrentStatuses(doc))
}

const performFindAll = async (db) => {
  const docs = await db.collection(COLLECTION_NAME).find().toArray()
  return docs.map((doc) => mapDocumentWithCurrentStatuses(doc))
}

/**
 * @param {import('mongodb').Db} db - MongoDB database instance
 * @returns {import('./port.js').OrganisationsRepositoryFactory}
 */
export const createOrganisationsRepository = (db) => () => ({
  async insert(organisation) {
    return performInsert(db, organisation)
  },

  async update(id, version, updates) {
    return performUpdate(db, id, version, updates)
  },

  async findById(id) {
    return performFindById(db, id)
  },

  async findAllByAssociatedEmail(email) {
    return performFindAllByAssociatedEmail(db, email)
  },

  async findAllByCompanyName(name) {
    return performFindAllByCompanyName(db, name)
  },

  async findAll() {
    return performFindAll(db)
  }
})
