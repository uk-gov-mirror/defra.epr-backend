import { STATUS } from './status.js'

const eligibleStatuses = [STATUS.APPROVED, STATUS.ACTIVE, STATUS.SUSPENDED]

export function getAllowedUsers({
  accreditations,
  allowedUsers,
  registrations,
  submitterContactDetails,
  statusHistory
}) {
  return eligibleStatuses.includes(statusHistory.at(-1)?.status)
    ? [
        submitterContactDetails,
        ...(allowedUsers?.map((user) => user) ?? []),
        ...registrations.reduce(
          (
            prev,
            { approvedPersons, statusHistory: registrationStatusHistory }
          ) =>
            eligibleStatuses.includes(registrationStatusHistory.at(-1)?.status)
              ? [...prev, ...approvedPersons]
              : prev,
          []
        ),
        ...accreditations.reduce(
          (
            prev,
            {
              prnIssuance = {},
              pernIssuance = {},
              statusHistory: accreditationStatusHistory
            }
          ) =>
            eligibleStatuses.includes(accreditationStatusHistory.at(-1)?.status)
              ? [
                  ...prev,
                  ...(prnIssuance.signatories ?? []),
                  ...(pernIssuance.signatories ?? [])
                ]
              : prev,
          []
        )
      ].reduce(
        (prev, user) =>
          prev.find(({ email }) => user.email === email)
            ? prev
            : [...prev, user],
        []
      )
    : []
}
