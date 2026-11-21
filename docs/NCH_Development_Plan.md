# NCH Factory Management System — Development Plan

This file holds delivery status, working rules, the test inventory, the backlog and the roadmap. Domain rules and architecture are in `NCH_Architecture_Plan.md`; this file does not repeat them. Status was checked against the source and the 2026-11-21 audits (`NCH_Audit_Backend.md`, `NCH_Audit_Frontend.md`); the audits describe commits from 2026-10-24, and where the current source is newer the source wins.

## Table of contents

1. Objective and how to read these plans
2. Status
3. Development rules
4. Workflow and approval rules
5. How to work with AI sessions
6. Testing
7. Known issues and backlog
8. Roadmap
9. Deployment workflow
10. Handoff instructions

---

## 1. Objective and how to read these plans

Continue building the NCH Factory Management System in controlled, testable phases while preserving working functionality. The status tags are:

- **Built:** a working route and UI exist in the code.
- **Partial:** only part exists, or there are known defects (listed in section 7).
- **Planned:** approved or discussed, but no code exists.

"Built" means the code exists and passed static checks. It does not mean verified in a live browser, with live MongoDB or with a physical printer; see "Not verified live" in section 7.

## 2. Status

| Area | Feature | Status | Notes |
|---|---|---|---|
| Core | Authentication | Built | Admin role only |
| Core | Admin Shell (sidebar, mobile bottom nav) | Built | Order: Dashboard, Products, Attendance, Stock, Factory Flow, Payout, Washers, Suppliers, Customers, Employees. No Stock dropdown. |
| Core | Dashboard | Partial | Month salary and month advance use the IST month; "today" counts still use server-local time |
| HR | Employees | Built | |
| HR | Attendance, Bulk | Built | Default hours from `STANDARD_WORK_HOURS = 8`, max 8, `DD/MM/YY` date input |
| HR | Attendance, Single | Built | Still hard-codes 8 in several UI places |
| HR | Attendance lock after payout | Built | 409 `ATTENDANCE_LOCKED_BY_PAYOUT` |
| HR | Payout, Bulk | Built | |
| HR | Payout, Single | Built | Same overlap, advance and negative-net rules as bulk |
| HR | Payout history (Bulk and Single tabs) | Built | 20 per page. `GET /api/payout` for the legacy table is unbounded. |
| HR | Payout edit | Built | `PATCH /api/payout/:id`, `PATCH /api/payout/bulk/:id`; no audit trail |
| HR | Payout print | Built | Bulk and single; physical print not verified |
| HR | Payout delete | Built | Permanent, in a transaction |
| HR | Salary Slip page | Partial | Router state only; no slip for bulk lines |
| Customers | Customers (billing name and addresses, contact, GSTIN, state code, active flag) | Built | Step 11A. Server-side field validation; GSTIN locks the state; detail page at `/admin/customers/:customerId` |
| Customers | Customer product prices | Built | Step 11A. Per customer per Finished Goods item, integer paise, deactivate only. No default selling price by design |
| Suppliers | Supplier master data | Built | |
| Suppliers | Material Receiving | Built | |
| Suppliers | Supplier Accounting | Built | No overpayment, no advances |
| Stock | Stock Management | Built | |
| Stock | Stock Types and Stock Type pages | Built | |
| Stock | Stock Home (two cards) and Universal Search | Built | |
| Stock | Structured size and supplier identity | Built | |
| Stock | Stock History | Partial | Backend endpoints exist; the page is missing |
| Stock | Products | Partial | Navigation alias to Stock Management; no Product model |
| Stock | Finished Goods HSN and GST rate | Built | Step 11A. GST rates 0, 0.25, 3, 5, 18, 40 (default 5); edited in Stock Management. A default selling price was dropped by design |
| Factory | Factory Flow page | Built | Process Goods and Manufacturing cards |
| Factory | Washers (master data, rates) | Built | |
| Factory | Process Goods (send, complete) | Built | Two-step flow |
| Factory | Washer advances, payouts, slips | Built | |
| Factory | Manufacturing (create, history, reversal) | Built | Batch duplicate race not closed |
| Factory | Labels page and printing | Planned | Label is only a Manufacturing input rule today |
| Sales | Estimates | Planned | |
| Sales | Invoices | Planned | |
| Sales | Challans | Planned | |
| Sales | GST report | Planned | |
| Sales | Orders | Planned | A legacy stub route exists with no caller |
| Platform | Portals (customer, supplier) | Planned | |
| Platform | Notifications, WhatsApp | Planned | |
| Platform | Dashboard analytics | Planned | |
| Platform | Performance Round 1 (caps, optional pagination, indexes, bounded payout previews) | Built | Static checks only; needs live MongoDB timing and `explain()` evidence. Create, edit and delete payout routes and `GET /stock/history` are still unbounded or full-history |

## 3. Development rules

1. Never assume current file contents; inspect the relevant files before substantial changes.
2. Always state the exact file path, and state whether the change is a full replacement or a targeted edit.
3. Prefer targeted edits. Replace a whole file only when clearly justified. Make readable multi-line changes, never giant one-line shell writes.
4. JavaScript only. Avoid unnecessary packages.
5. Preserve working functionality and existing API contracts unless a change is necessary.
6. Work sequentially and test each phase before continuing.
7. The three main stock categories are fixed.
8. Stock Type is required for Raw and Washed stock; it is optional only for Finished Goods where appropriate. A Stock Type belongs to one category. Creating a Stock Type never auto-assigns old products. Legacy `stockType: null` items stay valid until explicitly updated.
9. Never edit `currentStock` directly. Every stock quantity change must be auditable through a `StockMovement`.
10. Never allow negative stock. Whole-number quantities only. Do not convert PCS and Dozen automatically.
11. Backend validation is authoritative.
12. Use MongoDB transactions for multi-record stock and financial operations.
13. Never destructively delete stock movement history.
14. Do not duplicate stock data. `StockItem` is the single inventory source.
15. Do not hard-code cloth or material names. Eligibility comes from configured Stock Types (`requiresSupplier`, `requiresSize`). The only name rule is the Manufacturing Label type.
16. Follow the engineering rules in `NCH_Architecture_Plan.md` section 20.

## 4. Workflow and approval rules

**Approval before implementation.** For any meaningful new workflow, page or business-rule change: inspect the current behavior; discuss with the user; agree the business rules, fields and their order, layout, control sizes, actions, validation and desktop/tablet/mobile behavior; update both plans with the approved decisions; then implement. Do not guess unresolved behavior; stop and ask a focused question. This is mandatory for Attendance, Payout, Stock, Factory Flow and accounting work.

**Responsive review.** Every UI change is reviewed at desktop, tablet and mobile widths against the standard in `NCH_Architecture_Plan.md` section 18.

**End-of-session checks.** At the end of every implementation session:
1. Inspect the changed files and the connected workflow.
2. Check touched navigation and actions, loading/empty/error states, responsive effects and obvious regressions.
3. Run proportionate syntax, test and build checks plus `git diff --check`.
4. Inspect the actual diff.
5. Report known remaining issues. A passing build alone is not sufficient.
6. If live browser, API or MongoDB testing was not run, say so. Use wording such as "No known static issues in the scoped changes", never "No bugs".

**Plans are updated at the end of each task** (section 5).

## 5. How to work with AI sessions

1. **One task per chat.** Start a new chat for each task so the context stays small and the diff stays reviewable.
2. **Plan mode first.** The AI reads the code, proposes the change and the list of files, and waits for approval before editing. For documentation tasks, show the proposed structure and the change list first.
3. **Choose the model by the work.**
   - **Opus** for design decisions and money logic (payout, advances, accounting, transactions).
   - **Sonnet** to build the approved change.
   - **Haiku** for mechanical work (renames, formatting, repetitive edits, simple searches).
4. **Required final report.** Every session ends with: Files Changed, Tests Run, Test Results, Live Test Limitations, Known Remaining Bugs, Website Changes to Check, and Push-Ready/Acceptance Status.
5. **Update the plans at the end of each task.** If behavior, status or a rule changed, update the affected section in `NCH_Architecture_Plan.md` and the status row here. Replace the old text; do not append a history entry.
6. Never read or print `.env` files or secrets, and never put secret values in a plan, a report or a commit message.

## 6. Testing

### Existing automated tests (backend)

There is no test runner and no `test` script. The files are plain `assert` scripts, each run with `node <file>`. None connects to MongoDB or opens a port; the session tests use fakes from `test/helpers/sessionFakes.js`.

| File | Covers |
|---|---|
| `test/payroll-calculations.test.js` | Hours, days, gross, net, negative-net validation |
| `test/payout-overlap.test.js` | Inclusive overlap across `Payout` and `BulkPayout` |
| `test/payout-history.test.js` | History pagination and serialization |
| `test/payout-edit.test.js` | Edit parsing, immutable fields, advance cap, chronology |
| `test/payout-edit-session.test.js` | PATCH routes and transaction handling |
| `test/payout-single-safety.test.js` | Single payout overlap, advance and negative-net parity |
| `test/payout-single-session.test.js` | Single payout transaction handling |
| `test/attendance-lock.test.js` | Attendance lock after payout |
| `test/dashboard-month.test.js` | IST month bounds (1st-of-month boundary) and month salary total |
| `test/list-query.test.js` | Optional pagination, caps, attendance range validation |
| `test/stock-list-shape.test.js` | Lean stock rows keep schema virtuals; summary pipeline |
| `test/payout-preview-equivalence.test.js` | Bounded payout previews equal the old full-history results |
| `test/error-responses.test.js` | Generic 500 responses |
| `test/supplier-accounting.test.js` | Paise parsing, payment rules |
| `test/customer-gst.test.js` | GSTIN, GSTIN to state code, state code list, GST rates, HSN, Finished-Goods-only tax metadata |
| `test/customer-pricing.test.js` | Rupees and paise conversion, price limits, Finished-Goods-only assignment, price schema and unique index |
| `test/customer-validation.test.js` | Customer payload rules (state lock, shipping, phone, email), partial updates on legacy customers |
| `test/washing.test.js` | Washing helpers (paise, size, charge, identity) |
| `test/washing-session.test.js` | Send and complete transaction handling |
| `test/manufacturing-session.test.js` | Manufacturing transaction handling |
| `test/performance-phase1.test.js` | Readiness, timing and dashboard response helpers |
| `src/utils/manufacturing.test.js` | Manufacturing payload and Label rules |
| `src/utils/manufacturingHistory.test.js` | History filters |

The frontend has no tests; its checks are `rsbuild build` and `prettier --check src`.

### Planned test scenarios

Run these against a connected database before a release.

**Stock Types and items**
- Create a Stock Type; reject a duplicate in the same category; a new type shows zero products; assign a product manually; deletion is blocked while products use the type and allowed when unused.
- Create without a Stock Type (Finished Goods only), with a compatible type, and reject an incompatible type. Reject decimal and negative quantities. Require a type for Raw and Washed stock. Reject incompatible supplier, type or size merges.
- Dedicated Stock Type page: Label page shows 0 products, add a product there, Label shows 1 and Wrapper shows 0.

**Stock in and out**
- Stock In increases stock and writes a movement; Stock Out decreases it; Stock Out above available is blocked; concurrent operations never produce negative stock.

**Suppliers and receiving**
- Create and search suppliers. Receive Raw and already-Washed material with structured size and a price. Merge only matching supplier, category, type, size and unit. Supplier balance is correct after several payments; a payment above outstanding is rejected; Record Payment is disabled at zero.

**Process Goods (send and complete)**
- Send deducts Raw only, snapshots the output type and rate, and writes `washing_sent`.
- Send blocks insufficient Raw stock, a non-eligible source type, an inactive washer, a non-whole quantity and a bad rate.
- Complete adds Washed stock (merging or creating the exact identity), earns the charge and writes `washing_completed`; it ignores any replacement output type; completing twice is rejected.
- Transaction rollback leaves no partial change in either step.
- Washer payout settles only completed unpaid processes in range, never exceeds outstanding advance or gross, and links the processes.

**Manufacturing**
- Multiple inputs; at least one Washed input; exactly one Label input; Label quantity equals the Finished quantity with no Dozen conversion; Label wastage zero; Finished Goods cannot be an input; the output must be Finished Goods.
- Insufficient input blocks the whole transaction. Wastage within `0..quantityUsed`. Blank Batch No. rejected; a duplicate normalized Batch No. blocked, including two simultaneous creates (currently open).
- Reversal restores inputs and subtracts output; it is blocked when Finished stock is insufficient or the entry is already reversed.
- History filters: same-date range, month, product, size, partial batch.

**Attendance**
- Bulk: new rows Present with 8 hours; cleared hours rejected; 0 means Absent with overtime 0; above 8 rejected; unchecked rows untouched; saved rows override defaults; all-or-nothing save.
- A future date (Asia/Kolkata) is rejected in single and bulk; today and yesterday are accepted, including near midnight.
- Editing or deleting attendance covered by a payout returns 409 `ATTENDANCE_LOCKED_BY_PAYOUT`.

**Payout**
- Bulk create is all-or-nothing; overlap against both `Payout` and `BulkPayout`; a negative net is rejected in create and edit; a preset period ending after today is rejected.
- Edit: immutable fields rejected; the advance cap holds; raising a cut that breaks a later payout returns 409 `ADVANCE_CHRONOLOGY_CONFLICT`.
- Delete restores advance and overlap eligibility. `bulk-legacy` returns 410.

**Customer pricing (Step 11A, needs live MongoDB):** create customers with and without a GSTIN; a state that does not match the GSTIN is rejected; a legacy customer can be deactivated without fixing old fields; assign, update, deactivate and reactivate a price; two simultaneous assignments of the same product end as one row; a non-Finished-Goods item is rejected; customer delete returns 409 once prices exist; moving a priced item out of Finished Goods returns 409.

**Planned features (when built):** Estimate (deducts stock, no HSN or GST), Invoice (deducts stock, HSN and GST), conversion without a second deduction, manual Challans with no stock effect, challan quantity caps, GST report from GST invoices only.

**Performance and UX:** paginated APIs return stable pages using their expected indexes; every page navigation shows a loading indicator; every API-backed page has loading, error with retry and empty states; duplicate submit is prevented.

## 7. Known issues and backlog

### Known issues

| # | Issue | Where |
|---|---|---|
| 1 | The dashboard "today" counts and payout date parsing use server-local time. (Month salary and month advance are IST.) | `dashboard.js`; `payout.js` `parseDate` |
| 2 | Payout edits keep no audit trail (who, when, before and after). | `payout.js` PATCH routes |
| 3 | `PayoutPage.jsx` is very large (about 3,650 lines) and mixes creation, history, edit and print. | `pages/Employees/PayoutPage.jsx` |
| 4 | `ProcessGoodsPage.css` has a global `button` rule, and all washer pages import that file, so it restyles buttons elsewhere. | `pages/Stock/ProcessGoodsPage.css` |
| 5 | Three files are not prettier-clean. (This figure is from the task brief; the audit counted 32 files before later cleanups; the current set was not re-run.) | frontend `src/` |
| 6 | List endpoints now have hard caps and optional `?page/?limit` (section 19 of the Architecture Plan). Payout create, edit and delete still load full history inside their transactions. `GET /api/payout` returns at most the newest 2000 single payouts; the legacy records table filters client-side. | backend routes |
| 7 | Indexes added in code (build on next deploy, not yet verified live): `Attendance {date}`, `Employee {isActive,name}`, `Payout {paidOn,_id}`, `StockItem {stockType,productName}`. Query plans are unverified. | models |
| 8 | `Customer.stock`, `Customer.orders` and `POST /api/customers/:id/order` are legacy with no caller. Remove them in a cleanup. Existing customers with an invalid stored GST must correct it on their next edit of the GSTIN. | `models/Customer.js`, `routes/customers.js` |
| 9 | "Products" is only a navigation alias to Stock Management. There is no Product model; Finished Goods carry HSN and GST rate, and prices live per customer. | `AdminShell.jsx` |
| 10 | The Stock History page is missing although the backend endpoints exist. | `/admin/stock/history` |
| 11 | **Credential rotation is pending.** A secrets file was committed in earlier history, so those values must be treated as exposed. No values are recorded in these plans. | backend repo |

### Other known gaps

- `Attendance.workHours` allows 24 in the schema while the routes cap it at 8.
- Single Attendance hard-codes 8 in several UI places; the Bulk form uses `defaultWorkHours`.
- Manufacturing batch-number duplicate protection is a `findOne` plus a non-unique index, so a duplicate race is possible.
- `ManufacturingEntry.manufacturingNumber` declares its unique index twice (Mongoose may warn at startup).
- Salary Slip works only from router state.
- CORS is open and login has no rate limit. A deleted user's token stays valid until it expires.
- Unused or stray files: `Login.jsx`, `auth.js`, `axios.js`, `rsbuild.config.mjs` in the backend repo; unused template images and `dayjs` in the frontend; `WashingEntry` model has no importer; `createAdmin.js` carries a default admin credential that must be changed after use.
- Two overlapping washer directory views (`WashersPage`, `WashersListPage`).
- Legacy per-employee payment-method control on the desktop Bulk Payout table, and the creation form sitting after history in the DOM (ordered visually with CSS).

### Not verified live

Browser behavior at 360/390/430px, tablet and desktop; physical or PDF print output (payout, washer slip); authenticated API calls against a deployed backend; MongoDB transactions, rollback and concurrency on the deployed topology; the deployed server time zone; query plans for the declared indexes; Render and Vercel environment variables.

## 8. Roadmap

Order of work (each item follows section 4 before it starts):

1. **Stock History page** (`/admin/stock/history`). Use `GET /api/stock/history`. Filters: product, movement type, start and end date, main category. Columns: date, product, category, movement type, direction, quantity, balance before and after, reference. No movement deletion. Raise the 500-row cap with pagination.
2. **Backlog hardening** (section 7): month and today in IST, payout edit audit trail, pagination and indexes, split `PayoutPage.jsx`, scope the global button rule, prettier clean-up.
3. **Labels.** Confirm the label specification first (`NCH_Architecture_Plan.md` section 16), then build the product selector, template, batch and date inputs, preview and PDF or print output.
4. **Sales documents** (rules in `NCH_Architecture_Plan.md` section 15). Step 11A (customer billing details, customer prices, Finished Goods HSN and GST rate) is built. Next: Estimates, GST Invoices with one GST calculation on the taxable total and a round-off line (11C), Challans, separate number series, then the GST report.
5. **Reports:** inventory by category, low stock, stock movement, raw material consumption, manufacturing, wastage, Finished Goods production, payroll register, attendance summaries, monthly GST report. Build after operational workflows are stable.
6. **Portals, orders, notifications and dashboard analytics** (`NCH_Architecture_Plan.md` section 17).
7. **Performance Phase 2.** Only after live timing and query-plan evidence.

## 9. Deployment workflow

```text
Edit the real local project → test → commit → push to GitHub → wait for deployment → verify the API
```

- Backend path: `C:\NCH Github\NCH backend\` (deployed on Render). Frontend path: `C:\NCH Github\NCH frontend\` (deployed with the SPA rewrite).
- Backend and frontend are separate repositories. `C:\NCH Github\` itself is not a repository.
- Do not edit `C:\NCH Github\.pnpm-store\`. Do not edit the stray `Employee.js` and `employees.js` in the parent folder (they differ from the backend versions).
- Before a release run the backend test scripts (section 6), `rsbuild build` and `git diff --check` in both repositories.
- Never commit `.env`; commit `.env.example` only. Never paste secret values into plans, reports or commit messages.

## 10. Handoff instructions

```text
This is an existing production project.

Do not rewrite unrelated working code.
Do not assume current file contents; read the relevant file first.
Use JavaScript only.
State the exact file path, and state full replacement vs targeted edit.
Keep changes sequential and testable.
Preserve existing API contracts unless a change is necessary.
Plan first; wait for approval before editing.
Do not duplicate stock data. Never edit currentStock directly.
Require a Stock Type for Raw and Washed stock; Finished Goods may stay unassigned.
Keep the three main stock categories fixed.
Creating a Stock Type never auto-assigns old products.
Use transactions for multi-record stock and money changes.
Never allow negative stock. Preserve permanent stock history.
Never read or print .env files or secrets.
Update both plans at the end of each task.
```
