import {
  extractAgencyFromDefinitionName,
  extractAnswers,
  extractTimestamp,
  flattenAnswersByShortDesc
} from './parse-forms-data.js'
import { FORM_PAGES } from './form-field-constants.js'
import { parseUkAddress } from './parse-address.js'
import { mapMaterial, mapRecyclingProcess } from './form-data-mapper.js'

function getSiteDetails(answersByShortDescription) {
  const siteAddress =
    answersByShortDescription[
      FORM_PAGES.REGISTRATION.SITE_DETAILS.fields.SITE_ADDRESS
    ]

  return {
    address: siteAddress ? parseUkAddress(siteAddress) : undefined,
    gridReference:
      answersByShortDescription[
        FORM_PAGES.REGISTRATION.SITE_DETAILS.fields.GRID_REFERENCE
      ]
  }
}

function getSubmitterDetails(answersByShortDescription) {
  return {
    fullName:
      answersByShortDescription[
        FORM_PAGES.REGISTRATION.SUBMITTER_DETAILS.fields.NAME
      ],
    email:
      answersByShortDescription[
        FORM_PAGES.REGISTRATION.SUBMITTER_DETAILS.fields.EMAIL
      ],
    phone:
      answersByShortDescription[
        FORM_PAGES.REGISTRATION.SUBMITTER_DETAILS.fields.TELEPHONE_NUMBER
      ],
    title:
      answersByShortDescription[
        FORM_PAGES.REGISTRATION.SUBMITTER_DETAILS.fields.JOB_TITLE
      ]
  }
}

function getNoticeAddress(answersByShortDescription) {
  const noticeAddress =
    answersByShortDescription[
      FORM_PAGES.REGISTRATION.SITE_DETAILS.fields.NOTICE_ADDRESS
    ]

  return noticeAddress ? parseUkAddress(noticeAddress) : undefined
}

function getExportPorts(answersByShortDescription) {
  const exportPorts =
    answersByShortDescription[FORM_PAGES.REGISTRATION.EXPORT_PORTS]

  if (!exportPorts) {
    return undefined
  }

  return exportPorts
    .split(/\r?\n/)
    .map((port) => port.trim())
    .filter((port) => port.length > 0)
}

export async function parseRegistrationSubmission(id, rawSubmissionData) {
  const answersByPages = extractAnswers(rawSubmissionData)
  const answersByShortDescription = flattenAnswersByShortDesc(answersByPages)
  return {
    id,
    formSubmissionTime: extractTimestamp(rawSubmissionData),
    submittedToRegulator: extractAgencyFromDefinitionName(rawSubmissionData),
    orgName:
      answersByShortDescription[
        FORM_PAGES.REGISTRATION.ORGANISATION_DETAILS.fields.ORG_NAME
      ],
    submitterContactDetails: getSubmitterDetails(answersByShortDescription),
    site: getSiteDetails(answersByShortDescription),
    noticeAddress: getNoticeAddress(answersByShortDescription),
    wasteRegistrationNumber:
      answersByShortDescription[
        FORM_PAGES.REGISTRATION.WASTE_REGISTRATION_NUMBER
      ],
    material: mapMaterial(
      answersByShortDescription[FORM_PAGES.REGISTRATION.MATERIAL_REGISTERED]
    ),
    recyclingType: mapRecyclingProcess(
      answersByShortDescription[FORM_PAGES.REGISTRATION.GLASS_RECYCLING_PROCESS]
    ),
    suppliers: answersByShortDescription[FORM_PAGES.REGISTRATION.SUPPLIERS],
    exportPorts: getExportPorts(answersByShortDescription),
    plantEquipmentDetails:
      answersByShortDescription[FORM_PAGES.REGISTRATION.PLANT_EQUIMENT_DETAILS]
  }
}
