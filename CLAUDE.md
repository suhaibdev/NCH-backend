# NCH backend (New Calcutta Handloom factory system)

Node + Express + MongoDB (Mongoose), JavaScript only. Deployed on Render. Admin-only JWT auth.
Full context: docs/NCH_Architecture_Plan.md and docs/NCH_Development_Plan.md. Read the relevant section before changing anything.

## Commands
- Run: `npm start` (dev: `npm run dev`)
- Tests (plain node assert, no DB): `Get-ChildItem test,src\utils -Filter *.test.js | ForEach-Object { node $_.FullName }`
- Syntax check changed files: `node --check <file>`

## Hard rules
- Never read, print or commit .env or any secret value. Never put secrets in docs or reports.
- No commit or push unless I ask. No new packages without approval.
- Plan first: inspect, show the plan, wait for approval, then implement. Do not guess business rules; ask.
- Backend validation is authoritative. Do not change existing successful response shapes unless I approve.
- Stock: never edit currentStock directly, never allow negative stock, whole numbers only, every change creates a StockMovement, no destructive deletes of history.
- Money: integer paise for supplier/washer accounting. Payout net can never be negative.
- Transactions: validate BEFORE opening one. Never run parallel operations on one session (await sequentially). Abort only if session.inTransaction(). End the session once in finally.
- Dates: compare date-only values independent of server time zone. Business date is Asia/Kolkata.
- 500 responses must be generic; log the real error with utils/httpErrors.js.
- Attendance is locked once a payout covers that employee and date (409 ATTENDANCE_LOCKED_BY_PAYOUT).
- Do not rewrite unrelated working code. Reuse existing helpers in src/utils.

## Finish every task with this report
Files changed, tests run and results, what needs live MongoDB, known risks, live checks for me. Say "no known static issues", never "no bugs".