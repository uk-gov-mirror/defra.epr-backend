import { LOGGING_EVENT_CATEGORIES } from '#common/enums/index.js'
import { TEST_ORGANISATION_IDS } from '#common/helpers/parse-test-organisations.js'
import { toYearMonth } from '#common/helpers/dates/year-month.js'
import { CADENCE } from '#reports/domain/cadence.js'
import { selectSubmittedReports } from '#reports/domain/merge-reporting-periods.js'
import { periodBounds } from '#reports/domain/reporting-period.js'
import {
  getReportableRegistrations,
  resolveAccreditation,
  resolveMaterial
} from '#domain/organisations/registration-utils.js'
import {
  TONNAGE_MONITORING_MATERIALS,
  WASTE_PROCESSING_TYPE
} from '#domain/organisations/model.js'
import {
  addMeasures,
  figuresContributedTo,
  measuresOf,
  noMeasures,
  withOperatorCounts,
  withPublishedFigures,
  withSentOnTotal
} from '#market-insights/domain/reprocessor-exporter-figures.js'
import {
  countMonthlyReports,
  owedMonthlyReports
} from '#market-insights/application/monthly-reports.js'
import { recordOf } from '#common/helpers/record-of.js'

/**
 * @typedef {import('#repositories/organisations/port.js').OrganisationsRepository} OrganisationsRepository
 * @typedef {import('#reports/repository/port.js').ReportsRepository} ReportsRepository
 * @typedef {import('#common/helpers/dates/year-month.js').YearMonth} YearMonth
 * @typedef {import('#domain/organisations/model.js').Material} Material
 * @typedef {import('#domain/organisations/model.js').Organisation} Organisation
 * @typedef {import('#domain/organisations/model.js').RegulatorValue} RegulatorValue
 * @typedef {import('#domain/organisations/registration.js').Registration} Registration
 * @typedef {import('#reports/repository/port.js').PeriodicReport} PeriodicReport
 * @typedef {import('#domain/organisations/model.js').WasteProcessingTypeValue} WasteProcessingTypeValue
 * @typedef {import('#domain/organisations/registration.js').ReportableRegistration} ReportableRegistration
 * @typedef {import('#market-insights/domain/reprocessor-exporter-figures.js').Measures} Measures
 * @typedef {import('#market-insights/domain/reprocessor-exporter-figures.js').PublishedFigures} PublishedFigures
 * @typedef {import('#market-insights/domain/reprocessor-exporter-figures.js').PublishedTotal} PublishedTotal
 */

/**
 * @template T
 * @typedef {import('#market-insights/domain/reprocessor-exporter-figures.js').WithOperatorCounts<T>} WithOperatorCounts
 */

/**
 * @typedef {import('#market-insights/application/monthly-reports.js').CoversRegistration} CoversRegistration
 * @typedef {import('#market-insights/application/monthly-reports.js').ReportCount} ReportCount
 * @typedef {import('#market-insights/application/monthly-reports.js').OwedReport} OwedReport
 */

/**
 * An operator's registration that could put a report into a month's figures.
 *
 * @typedef {Pick<OwedReport, 'month' | 'org' | 'registration'>} Contribution
 */

/**
 * A report the figures include, and the figures it put something into.
 *
 * @typedef {Contribution & { figures: string[] }} IncludedReport
 */

/**
 * The operators behind every figure, each keyed as the figure's cell or grand
 * total is, and for those contributing, the figure within it too.
 *
 * @typedef {Object} OperatorsByCell
 * @property {Map<string, Set<string>>} possible - those who could have contributed
 * @property {Map<string, Set<string>>} submitting - those whose reports the figure includes
 * @property {Map<string, Set<string>>} contributing - those whose reports put something into the figure
 */

/**
 * @typedef {Record<WasteProcessingTypeValue, WithOperatorCounts<PublishedFigures>>} FiguresByAccreditationType
 * @typedef {Record<Material, FiguresByAccreditationType>} FiguresByMaterial
 * @typedef {Record<WasteProcessingTypeValue, WithOperatorCounts<PublishedTotal>>} TotalsByAccreditationType
 */

/**
 * One reporting month as published: the reports it was owed and how many of
 * them arrived, the figures for every material and accreditation type, and
 * each table's grand total.
 *
 * @typedef {Object} PublishedMonth
 * @property {ReportCount} reports
 * @property {FiguresByMaterial} figures
 * @property {TotalsByAccreditationType} totals
 */

/**
 * @typedef {Object} ReprocessorExporterTable
 * @property {{ generatedAt: string }} meta
 * @property {{ months: Record<YearMonth, PublishedMonth>, period: { reports: ReportCount } }} data
 */

/**
 * @param {{ material: Material, accreditationType: WasteProcessingTypeValue, month: YearMonth }} cell
 */
const cellKey = ({ material, accreditationType, month }) =>
  `${material}::${accreditationType}::${month}`

/**
 * @param {{ accreditationType: WasteProcessingTypeValue, month: YearMonth }} total
 */
const totalKey = ({ accreditationType, month }) =>
  `${accreditationType}::${month}`

/**
 * @param {string} key - the cell's or grand total's
 * @param {string} figure
 */
const figureKey = (key, figure) => `${key}::${figure}`

/**
 * @param {{ organisationId: string, registrationId: string }} ref
 */
const registrationKey = ({ organisationId, registrationId }) =>
  `${organisationId}::${registrationId}`

/**
 * The submission that counts for a period: the highest submission number, as
 * the report-submissions feed tells its consumers to take. Ranked by number
 * rather than date because two submissions can share a date and cannot share
 * a number. A period nothing has been submitted for counts for nothing.
 *
 * @param {import('#reports/repository/port.js').ReportPerPeriod} slot
 */
const latestSubmission = (slot) => selectSubmittedReports(slot).at(-1)

/**
 * The accreditation type a registration reports under. The registration types
 * it as a bare string, though only an accreditation type is ever stored there.
 *
 * @param {Registration} registration
 * @returns {WasteProcessingTypeValue}
 */
const accreditationTypeOf = (registration) =>
  /** @type {WasteProcessingTypeValue} */ (registration.wasteProcessingType)

/**
 * @param {Map<string, Measures>} cells
 * @param {ReportableRegistration} registration
 * @param {YearMonth} month
 * @param {Measures} measures
 */
const foldIntoCell = (cells, registration, month, measures) => {
  const accreditationType = accreditationTypeOf(registration)
  const key = cellKey({
    material: resolveMaterial(registration),
    accreditationType,
    month
  })
  cells.set(
    key,
    addMeasures(cells.get(key) ?? noMeasures(accreditationType), measures)
  )
}

/**
 * @param {import('#common/hapi-types.js').TypedLogger} logger
 * @param {string} key
 */
const warnAboutUnmatchedReport = (logger, key) => {
  logger.warn({
    message: `Market insights reprocessor and exporter figures left out a periodic report whose registration no longer resolves: ${key}. Everything it reported is absent from the publication.`,
    event: {
      category: LOGGING_EVENT_CATEGORIES.SERVER,
      action: 'market_insights_report_unmatched',
      reference: key
    }
  })
}

/**
 * @param {Map<string, Measures>} cells
 * @param {Material} material
 * @param {WasteProcessingTypeValue} accreditationType
 * @param {YearMonth} month
 * @returns {Measures}
 */
const measuresFor = (cells, material, accreditationType, month) =>
  cells.get(cellKey({ material, accreditationType, month })) ??
  noMeasures(accreditationType)

/**
 * The separate operators among the contributions, keyed as each figure's cell
 * or grand total is. An operator counts once however many sites it reports
 * from, so one with a site in each of two nations counts once in each nation's
 * figures and once in the UK's.
 *
 * @template {Contribution} C
 * @param {Iterable<C>} contributions
 * @param {(key: string, contribution: C) => string} [keyWithin] - narrows each cell or grand total key to what the contribution is counted toward
 * @returns {Map<string, Set<string>>}
 */
const operatorsByCell = (contributions, keyWithin = (key) => key) => {
  /** @type {Map<string, Set<string>>} */
  const operators = new Map()
  /**
   * @param {string} key
   * @param {string} organisationId
   */
  const count = (key, organisationId) =>
    operators.set(key, (operators.get(key) ?? new Set()).add(organisationId))

  for (const contribution of contributions) {
    const { month, org, registration } = contribution
    const accreditationType = accreditationTypeOf(registration)
    const material = resolveMaterial(registration)
    count(
      keyWithin(cellKey({ material, accreditationType, month }), contribution),
      org.id
    )
    count(
      keyWithin(totalKey({ accreditationType, month }), contribution),
      org.id
    )
  }
  return operators
}

/**
 * The separate operators whose reports put something into each figure of each
 * cell and grand total, keyed by the figure within it.
 *
 * @param {IncludedReport[]} includedReports
 * @returns {Map<string, Set<string>>}
 */
const operatorsByFigure = (includedReports) =>
  operatorsByCell(
    includedReports.flatMap(({ figures, ...contribution }) =>
      figures.map((figure) => ({ ...contribution, figure }))
    ),
    (key, { figure }) => figureKey(key, figure)
  )

/**
 * @template {Record<string, number>} T
 * @param {T} figures - a cell's or grand total's
 * @param {OperatorsByCell} operators
 * @param {string} key - the cell's or grand total's
 * @returns {WithOperatorCounts<T>}
 */
const withOperatorsBehind = (
  figures,
  { possible, submitting, contributing },
  key
) =>
  withOperatorCounts(figures, {
    operatorCount: possible.get(key)?.size ?? 0,
    submittingOperatorCount: submitting.get(key)?.size ?? 0,
    contributingOperatorCountOf: (figure) =>
      contributing.get(figureKey(key, figure))?.size ?? 0
  })

/**
 * The publication prints every material and both accreditation types for
 * every month, so a combination nothing was reported into is still served, at
 * zero: a row vanishing when a material has no data is the error the work
 * instruction warns about.
 *
 * @param {Map<string, Measures>} cells
 * @param {OperatorsByCell} operators
 * @param {YearMonth} month
 * @returns {FiguresByMaterial}
 */
const publishedFigures = (cells, operators, month) =>
  recordOf(TONNAGE_MONITORING_MATERIALS, (material) =>
    recordOf(Object.values(WASTE_PROCESSING_TYPE), (accreditationType) =>
      withOperatorsBehind(
        withPublishedFigures(
          measuresFor(cells, material, accreditationType, month)
        ),
        operators,
        cellKey({ material, accreditationType, month })
      )
    )
  )

/**
 * The grand total each published table ends in: every material of that
 * accreditation type summed, for the month.
 *
 * @param {Map<string, Measures>} cells
 * @param {OperatorsByCell} operators
 * @param {YearMonth} month
 * @returns {TotalsByAccreditationType}
 */
const publishedTotals = (cells, operators, month) =>
  recordOf(Object.values(WASTE_PROCESSING_TYPE), (accreditationType) =>
    withOperatorsBehind(
      withSentOnTotal(
        TONNAGE_MONITORING_MATERIALS.reduce(
          (total, material) =>
            addMeasures(
              total,
              measuresFor(cells, material, accreditationType, month)
            ),
          noMeasures(accreditationType)
        )
      ),
      operators,
      totalKey({ accreditationType, month })
    )
  )

/**
 * Whether the registration holds a live accreditation and was submitted to the
 * regulator being published. The regulator a registration was submitted to is
 * the one the report-submissions extract prints, and so the one the England
 * tab is filtered on.
 *
 * This is the one rule that decides both what these figures are made of and
 * which months their coverage count is owed, so the two describe the same
 * operators by sharing it rather than by agreeing separately.
 *
 * @param {RegulatorValue} [regulator] - every regulator when absent
 * @returns {CoversRegistration}
 */
const publicationCovers =
  (regulator) =>
  ({ org, registration }) =>
    resolveAccreditation(registration, org) !== null &&
    (regulator === undefined || registration.submittedToRegulator === regulator)

/**
 * Every periodic report folded into its cell: the latest monthly submission of
 * each registration the publication covers, summed by material and
 * accreditation type within each month served, beside the contribution each
 * folded report made. A report whose registration no longer resolves is
 * logged and left out, unless a test organisation filed it.
 *
 * @param {Object} params
 * @param {Organisation[]} params.organisations
 * @param {PeriodicReport[]} params.periodicReports
 * @param {YearMonth[]} params.months - the reporting months to publish
 * @param {import('#common/hapi-types.js').TypedLogger} params.logger
 * @param {CoversRegistration} params.covers - which registrations the publication covers
 * @returns {{ cells: Map<string, Measures>, includedReports: IncludedReport[] }}
 */
const measuresByCell = ({
  organisations,
  periodicReports,
  months,
  logger,
  covers
}) => {
  const registrations = new Map(
    getReportableRegistrations(organisations).map((entry) => [
      registrationKey({
        organisationId: entry.org.id,
        registrationId: entry.registration.id
      }),
      entry
    ])
  )
  const testOrganisationIds = new Set(
    organisations
      .filter((org) => TEST_ORGANISATION_IDS.has(org.orgId))
      .map((org) => org.id)
  )

  /**
   * @param {PeriodicReport} periodicReport
   * @returns {{ org: Organisation, registration: ReportableRegistration } | undefined}
   */
  const coveredRegistrationFor = (periodicReport) => {
    const key = registrationKey(periodicReport)
    const entry = registrations.get(key)
    if (entry === undefined) {
      if (!testOrganisationIds.has(periodicReport.organisationId)) {
        warnAboutUnmatchedReport(logger, key)
      }
      return undefined
    }
    return covers(entry) ? entry : undefined
  }

  const served = new Set(months)
  /** @type {Map<string, Measures>} */
  const cells = new Map()
  /** @type {IncludedReport[]} */
  const includedReports = []

  for (const periodicReport of periodicReports) {
    const covered = coveredRegistrationFor(periodicReport)
    if (covered === undefined) {
      continue
    }
    const { org, registration } = covered
    for (const [period, slot] of Object.entries(
      periodicReport.reports.monthly ?? {}
    )) {
      const month = toYearMonth(
        periodBounds(CADENCE.monthly, periodicReport.year, Number(period))
          .startDate
      )
      const report = latestSubmission(slot)
      if (served.has(month) && report !== undefined) {
        const measures = measuresOf(report, accreditationTypeOf(registration))
        foldIntoCell(cells, registration, month, measures)
        includedReports.push({
          month,
          org,
          registration,
          figures: figuresContributedTo(measures)
        })
      }
    }
  }

  return { cells, includedReports }
}

/**
 * Aggregate the published reprocessor and exporter figures for the given
 * reporting months: the latest monthly submission of every registration
 * holding a live accreditation, summed by material and accreditation type
 * within each month. An accreditation cancelled since loses the months it
 * filed, as the regulator's workbooks and the report-submissions extract drop
 * them. Quarterly reports belong to registered-only operators and are left
 * out. Every regulator's registrations make the UK figures; one regulator's
 * make that nation's. Each month also carries the count of monthly reports it
 * was owed and how many were submitted, and the period carries the sum. Every
 * figure and grand total carries how many operators could have contributed to
 * it, how many it includes a report from, and how many of those put something
 * into each of its figures.
 *
 * @param {Object} params
 * @param {OrganisationsRepository} params.organisationsRepository
 * @param {ReportsRepository} params.reportsRepository
 * @param {import('#common/hapi-types.js').TypedLogger} params.logger
 * @param {number} params.year - the reporting year
 * @param {YearMonth[]} params.months - the reporting months of that year to publish
 * @param {RegulatorValue} [params.regulator] - publish only the registrations submitted to this regulator; every regulator when absent
 * @param {Date} params.now - clock reading supplied by the caller
 * @returns {Promise<ReprocessorExporterTable>}
 */
export const buildReprocessorExporterTable = async ({
  organisationsRepository,
  reportsRepository,
  logger,
  year,
  months,
  regulator,
  now
}) => {
  const [organisations, periodicReports] = await Promise.all([
    organisationsRepository.findAll(),
    reportsRepository.findPeriodicReportsForYear({ year })
  ])

  const covers = publicationCovers(regulator)
  const { cells, includedReports } = measuresByCell({
    organisations,
    periodicReports,
    months,
    logger,
    covers
  })

  // Counted over the registrations the figures cover rather than the whole
  // register, so a month cannot report coverage for one set of operators
  // beside tonnages for another. A cancelled accreditation is the case that
  // separates them: its submissions are absent from the figures, so its
  // months are not owed here.
  const owedReports = [
    ...owedMonthlyReports({ organisations, periodicReports, months, covers })
  ]
  const reports = countMonthlyReports(months, owedReports)
  // Whoever owed the month a report could have contributed to it, and so
  // could whoever the figures include a report from, owed or not.
  const operators = {
    possible: operatorsByCell([...owedReports, ...includedReports]),
    submitting: operatorsByCell(includedReports),
    contributing: operatorsByFigure(includedReports)
  }

  return {
    meta: { generatedAt: now.toISOString() },
    data: {
      months: recordOf(months, (month) => ({
        reports: reports.byMonth[month],
        figures: publishedFigures(cells, operators, month),
        totals: publishedTotals(cells, operators, month)
      })),
      period: { reports: reports.total }
    }
  }
}
