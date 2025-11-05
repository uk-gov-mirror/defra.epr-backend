import {
  validateUser,
  validateDefraIdOrgId,
  validateId,
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
import { generateInitialUsers } from '#domain/organisations/generate-initial-users.js'

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
      users: generateInitialUsers(data)
    })
  } catch (error) {
    if (error.code === MONGODB_DUPLICATE_KEY_ERROR_CODE) {
      throw Boom.conflict(`Organisation with ${id} already exists`)
    }
    throw error
  }
}

const performUpdate = async (db, id, version, updates) => {
  console.log('DEBUG: performUpdate', updates)

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
      $set: data
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

const performFindByDefraIdOrgId = async (db, defraIdOrgId) => {
  // validate the ID and throw early
  let validatedDefraIdOrgId
  try {
    validatedDefraIdOrgId = validateDefraIdOrgId(defraIdOrgId)
  } catch (error) {
    throw Boom.notFound(
      `Organisation with defraIdOrgId ${defraIdOrgId} not found`
    )
  }

  const doc = await db
    .collection(COLLECTION_NAME)
    .findOne({ defraIdOrgId: validatedDefraIdOrgId })

  if (!doc) {
    // throw Boom.notFound(`Organisation with id ${defraIdOrgId} not found`)

    return null
  }

  return mapDocumentWithCurrentStatuses(doc)
}

const performFindAllLinkedOrganisationsByUser = async (db, options) => {
  // validate the name and throw early
  let validatedUserEntries
  try {
    validatedUserEntries = validateUser(options)
  } catch (error) {
    throw Boom.notFound(`Organisation with provided email not found`)
  }

  const docs = await db
    .collection(COLLECTION_NAME)
    .find({
      ...validatedUserEntries.reduce(
        (prev, [key, value]) => ({ ...prev, [`users.${key}`]: value }),
        {}
      ),
      defraIdOrgId: { $exists: false }
    })
    .toArray()

  if (!docs.length) {
    // throw Boom.notFound(`No organisations with provided email found`)

    return []
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

  async findAllLinkedOrganisationsByUser(userOptions) {
    return performFindAllLinkedOrganisationsByUser(db, userOptions)
  },

  async findByDefraIdOrgId(defraIdOrgId) {
    return performFindByDefraIdOrgId(db, defraIdOrgId)
  },

  async findAll() {
    return performFindAll(db)
  }
})
