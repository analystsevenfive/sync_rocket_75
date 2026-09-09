# Project review — 9 September 2026

Reviewed the production Node.js sync scripts, shared clients, workflow definitions,
legacy Apps Script paths, HR warning-card sync, and diagnostic scripts. No production
sync was dispatched and no live spreadsheet was modified during this review.

## Confirmed defects fixed locally

| Priority | Defect and trigger | Change |
| --- | --- | --- |
| High | Snapshot writers cleared the sheet before writing. A write error left the previous data erased. Affected both Node.js snapshot layouts and HR warning cards. | Replace new values and the obsolete tail together, without a preliminary clear. |
| High | Parent/detail/enrichment requests could fail, be logged or ignored, and then publish a partial snapshot as successful. | Production ticket syncs use a strict concurrent fetch wrapper: retry once, then stop before writing if any worker still fails. Modal HTTP failures propagate instead of becoming empty strings. |
| High | Gasoline found no matching ticket+technician row and fell back to ticket alone, overwriting another technician's row and associating their review/note with the wrong person. Legacy Gasoline also indexed tickets without technician identity. | Both writers use ticket+technician keys; repeated input keys within a batch are deduplicated. Existing review/note columns are preserved. This does not reconstruct rows overwritten by previous runs. |
| High | Backfill assumed Ticket ID was column A, Ticket No was D and data began on row 2. Production now has extra leading columns and a summary row. | Detect headers in the first two rows, fetch only missing ticket numbers, write only those cells using RAW, and share the production Tickets concurrency group. |
| High | HTTP 200 login/blank responses could be interpreted as zero parent tickets and clear daily snapshots. | Require table markup and reject password forms before parsing the parent response. A valid empty table still represents an empty day. |
| High | Employee scraping could return no employees or silently lose a discovered department after HTTP/network failure, then replace the directory. | Stop on an empty directory and department fetch failures. Missing optional discovery endpoints may still return 404/405. |
| Medium | A newly created sheet has 26 columns, but Tickets needs 36. The shared grid helper expanded only rows. | Snapshot writes expand column count before reading/writing the required range. |
| Medium | HTTP timeout was cleared as soon as response headers arrived; a stalled response body could hang the worker. Employee and gasoline export requests also lacked this timeout. | Keep the abort signal active while consuming the body, and use it for those requests. |
| Medium | Legacy Apps Script retained the old sub-ticket URL parser. | Accept fast links and row IDs, matching the production fix. |
| Medium | Installation-plan dates used a separate parser that rejected Thai month names and ISO dates already supported elsewhere. | Reuse shared date parsing and avoid interpreting dotted dates as appointment times. |

## Verification

- `node --check` across all 22 JavaScript files, including the regression suite.
- Offline regression suite: **22 tests passed** under Node.js 20, matching production
  workflows. Run with `cd github_action && npm test`.
- Tests cover failed writes without data loss, stale-tail cleanup, column expansion,
  partial-fetch rejection, script integration, technician identity, both backfill
  layouts, a real local HTTP server with a stalled body, malformed parent responses,
  employee failures, legacy parsers/writers, HR write failures, and appointment formats.
- Added `.github/workflows/checks.yml` to run the offline suite on push and PR.
- No real Rocket/Sheets integration run; fixtures and simulated failures do not prove
  compatibility with every current HTML variant or Apps Script runtime behavior.

## Dependency remediation

- Upgraded `googleapis` from 144 to pinned version 178.1.1.
- Replaced the outdated npm registry `xlsx@0.18.5` with SheetJS 0.20.3 from
  the [official distribution](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/).
  This version is beyond the affected ranges of the prototype-pollution and ReDoS
  advisories found in the initial review.
- Added `github_action/package-lock.json` with integrity hashes and changed every
  dependency-installing workflow to `npm ci` for repeatable installations.
- `npm audit` after the upgrade reports **0 known vulnerabilities**.
- Added Thai XLSX report parsing tests (both shared and inline strings), including
  leading-zero job numbers, multiple technicians and numeric counts.
- Exercised the real upgraded Google API client against a local HTTP server with
  OAuth headers and verified the complete snapshot request payload. This is not a
  live Google service-account authorization test.

## Operational limits

1. **HTML parsing remains structural.** The new checks reject common invalid
   responses and transport failures; they cannot detect every plausible but incomplete
   HTTP 200 table. Representative Rocket HTML fixtures are needed for broader coverage.
2. **Strict failure handling changes operational behavior.** A run that previously
   showed success with missing rows now fails and retains the last snapshot. Read the
   GitHub Actions result and Last Sync date when checking freshness; cron's HTTP result
   alone cannot establish a successful sheet refresh.
3. **Separate runtime deployments.** GitHub Actions uses the committed Node.js
   code after it is pushed. Legacy Apps Script and HR changes require updating the
   deployed script project separately if those entrypoints are still used. This
   review does not modify those live Apps Script projects.


API behavior consulted: [Sheets values batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate)
and [Node AbortSignal timeout](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay).
