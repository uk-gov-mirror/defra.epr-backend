import { describe, expect, it } from 'vitest'
import { parseRegistrationSubmission } from './transform-registration-data.js'

import exporter from '#data/fixtures/ea/registration/exporter.json'
import reprocessorAllMaterials from '#data/fixtures/ea/registration/reprocessor-all-materials.json'

describe('parseRegistrationSubmission - Integration Tests with Fixture Data', () => {
  it('should parse exporter registration from fixture', async () => {
    const result = await parseRegistrationSubmission(
      exporter._id.$oid,
      exporter.rawSubmissionData
    )

    expect(result).toStrictEqual({
      id: exporter._id.$oid,
      formSubmissionTime: new Date('2025-10-08T17:48:22.220Z'),
      submittedToRegulator: 'ea',
      orgName: 'EuroPack GmbH',
      material: 'glass',
      wasteRegistrationNumber: 'CBDU123456',
      suppliers:
        'Local authorities, supermarkets, manufacturing companies, waste collection companies, materials recovery facilities (MRFs)',
      recyclingType: ['glass_re_melt', 'glass_other'],
      plantEquipmentDetails: undefined,
      exportPorts: ['SouthHampton', 'Portsmouth'],
      submitterContactDetails: {
        fullName: 'Sarah Mitchell',
        email: 'reexserviceteam@defra.gov.uk',
        phone: '1234567890',
        title: 'Packaging Compliance Officer'
      },
      site: {
        address: undefined,
        gridReference: undefined
      },
      noticeAddress: {
        line1: '45',
        postcode: 'B2 4AA',
        fullAddress: '45,High Street,Birmingham,B2 4AA',
        country: 'UK'
      }
    })
  })

  it('should parse reprocessor registration for all materials from fixture', async () => {
    const result = await parseRegistrationSubmission(
      reprocessorAllMaterials._id.$oid,
      reprocessorAllMaterials.rawSubmissionData
    )

    expect(result).toStrictEqual({
      id: reprocessorAllMaterials._id.$oid,
      formSubmissionTime: new Date('2025-10-08T17:40:07.373Z'),
      submittedToRegulator: 'ea',
      orgName: 'Green Recycling Solutions Ltd',
      material: 'glass',
      wasteRegistrationNumber: 'CBDU123456',
      suppliers:
        'Local authorities, supermarkets, manufacturing companies, waste collection companies, materials recovery facilities (MRFs)',
      recyclingType: 'glass_other',
      plantEquipmentDetails:
        'Optical sorting machine (Model XR-500), industrial crusher producing 10-40mm cullet, trommel screen (50mm aperture), magnetic separator, vibrating screens for grading, wash and rinse facility, rotary dryer, storage bunkers (50 tonne capacity), conveyor belt system (50m length), bag splitter, dust extraction system, weighbridge (60 tonne)',
      exportPorts: undefined,
      submitterContactDetails: {
        fullName: 'James Patterson',
        email: 'reexserviceteam@defra.gov.uk',
        phone: '020 7946 0123',
        title: 'Director'
      },
      site: {
        address: {
          line1: '78 Portland Place',
          postcode: 'W1B 1NT',
          fullAddress: '78 Portland Place,London,London,W1B 1NT',
          country: 'UK'
        },
        gridReference: 'TQ 295 805'
      },
      noticeAddress: {
        line1: '90',
        postcode: 'W1B 1NT',
        fullAddress: '90,Portland Place,London,W1B 1NT',
        country: 'UK'
      }
    })
  })

  it('should handle missing notice address', async () => {
    const exporterWithoutNoticeAddress = {
      ...exporter,
      rawSubmissionData: {
        ...exporter.rawSubmissionData,
        data: {
          ...exporter.rawSubmissionData.data,
          main: {
            ...exporter.rawSubmissionData.data.main,
            pGYoub: ''
          }
        }
      }
    }

    const result = await parseRegistrationSubmission(
      exporterWithoutNoticeAddress._id.$oid,
      exporterWithoutNoticeAddress.rawSubmissionData
    )

    expect(result.noticeAddress).toBeUndefined()
  })
})
