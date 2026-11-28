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
11. Decisions log

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
| Core | Admin Shell (sidebar, mobile bottom nav) | Built | Order: Dashboard, Products, Attendance, Stock, Factory Flow, Payout, Washers, Suppliers, Customers, Estimates, Invoices, Challans, GST Report, Employees. Estimates, Invoices, Challans and GST Report sit in the mobile More sheet. No Stock dropdown. |
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
| Stock | Stock History | Built | `/admin/stock/history`: paginated, with movement-type, category, search and IST date-range filters (includes Estimate and Invoice movements) |
| Stock | Products | Partial | Navigation alias to Stock Management; no Product model |
| Stock | Finished Goods HSN and GST rate | Built | Step 11A. GST rates 0, 0.25, 3, 5, 18, 40 (default 5); edited in Stock Management. A default selling price was dropped by design |
| Factory | Factory Flow page | Built | Process Goods and Manufacturing cards |
| Factory | Washers (master data, rates) | Built | |
| Factory | Process Goods (send, complete) | Built | Two-step flow |
| Factory | Washer advances, payouts, slips | Built | |
| Factory | Manufacturing (create, history, reversal) | Built | Batch duplicate race not closed |
| Factory | Labels page and printing | Planned | Label is only a Manufacturing input rule today |
| Sales | Estimates | Built | Step 11B. No GST/HSN; `EST/2026-27/0001` per financial year; stock deducted at creation, edited by difference, returned on cancel; payments with void; print. Can be converted to an invoice (11D) |
| Sales | Estimate to Invoice conversion | Built | Step 11D. No second stock deduction; GST added on top of the saved estimate prices; payments carried over and marked transferred; the estimate becomes read-only `converted`; reversing the invoice returns stock once and the estimate stays converted |
| Sales | Invoices | Built | Step 11C. GST tax invoices `INV/2026-27/0001`. Prices exclusive of GST; tax once per rate group; grand total rounded with a round-off line; CGST + SGST for state 09, otherwise IGST. Edit only before payment; reversal; payments with void; print. Blocked until seller details are configured |
| Sales | Delivery Challans | Built | Step 11E. Invoice-only; no GST, prices, stock or ledger effect; `CH/2026-27/0001` series; partial dispatch capped per invoice line; cancel frees the quantity; edit is transport and notes only; invoice reverse and edit are blocked while challans are active; print |
| Sales | Monthly GST report | Built | Step 11F. GST invoices only, from saved snapshots, aggregated on the server; month, FY or a custom range of up to 366 days; reversed invoices excluded and listed with a reversed-after-period flag; rate, B2B/B2C, HSN (tax apportioned) and register; reconciliation check; CSV only (BOM, formula-safe, capped at 5,000 invoices). Not a GSTR-1 layout |
| Sales | Orders | Planned | PLANNED, step 16: approval flow; approval creates a draft invoice only. A legacy stub route exists with no caller |
| Platform | Portals (customer, supplier) | Planned | Customer: PLANNED, steps 16 and 17. Supplier: LATER, view-only proposal |
| Platform | Notifications, WhatsApp | Planned | Notifications: PLANNED, from step 14. WhatsApp: LATER |
| Platform | Dashboard analytics | Planned | Older proposal, not confirmed. The step 13 dashboard cards are to be finalised |
| Platform | Performance Round 1 (caps, optional pagination, indexes, bounded payout previews) | Built | Static checks only; needs live MongoDB timing and `explain()` evidence. Create, edit and delete payout routes and `GET /stock/history` are still unbounded or full-history |
| Platform | Security basics, audit log, ownership helper, hidden admin path | PLANNED | Step 12 |
| Platform | Design system and shell (navy, dark mode, grouped sidebar, logins, password banner, dashboard) | PLANNED | Step 13 |
| Public | Website (Home, Quality, Enquiry), Enquiries inbox, admin Notifications | PLANNED | Step 14, with anti-spam |
| Sales | Settings and final invoice (draft, preview, generate, 48-hour edit history, required Batch No.) | PLANNED | Step 15 |
| Customers | Customer accounts | PLANNED | Step 16 |
| Sales | Shipments (replaces Delivery Challans) | PLANNED | Step 16. Challan code is removed only after confirming the collection is empty |
| Customers | Customer Billing | PLANNED | Step 17 |
| Public | Website Products admin | PLANNED | Step 18 |
| Platform | Admin two-factor | PLANNED | Step 19 |

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
| `test/estimates.test.js` | Financial year (31 Mar / 1 Apr), estimate numbers, IST today, paise math, line and payload validation, stock difference on edit, payment cap, void and status rules, no GST/HSN on the model |
| `test/estimate-session.test.js` | Estimate create, edit, cancel, payment and void routes with fake sessions: shortage blocks with no documents written, one abort and one end per failure, never two operations on one session |
| `test/gst-invoice.test.js` | Tax type by state code, the five worked tax examples, CGST = SGST halves, round-off range and the .50 boundary, exact reconciliation on 500 random mixed-rate invoices, guards, missing HSN/GST messages, amount in words, `INV` numbering, batch references, seller profile and bank env, Invoice schema |
| `test/estimate-conversion.test.js` | Eligibility, conversion lines from saved snapshots, HSN/GST blocks naming the item, conversion tax (GST on top, reconciled), payment carry-over cap including the 0% edge, converted-estimate summary, the customer estimate account math, request validation (no quantities or prices accepted), model fields and the two unique partial indexes |
| `test/estimate-conversion-session.test.js` | Convert and preview routes with fake sessions: no StockItem update and no StockMovement, double conversion and cancelled estimates blocked, missing HSN/GST, state and seller rules, payments carried and marked transferred, paid-above-total blocked, abort and end once, never two operations on one session; converted estimate is read-only; reversing the invoice returns stock exactly once and the estimate stays converted |
| `test/estimate-account.test.js` | The real customer estimate-account and invoice-account routes against in-memory data: a converted estimate is excluded from the estimate total and outstanding, transferred payments are not estimate payments, the money is counted once in the invoice account |
| `test/challans.test.js` | Challan numbering across 31 Mar / 1 Apr, remaining-quantity math, the dispatch cap (single, several summing to the cap, cap plus one, cancelled challans freeing quantity), dispatch status, counters agreeing with the challans, payload and edit validation, and the schema having no GST, GSTIN, price or tax fields |
| `test/challan-session.test.js` | Challan routes with fake sessions and a simulated invoice lock: zero StockItem, StockMovement and payment writes, two and three challans racing for the last quantity, cancel (also twice and at once), reversed invoices, validation before any session, abort and end once, edit limited to transport and notes, dispatch summary and list, and invoice reverse and edit blocked while challans are active |
| `test/gst-report.test.js` | Month and FY bounds (28/29/30/31-day months, 31 Mar / 1 Apr, December to January), the 366-day range limit and invalid periods, paise-to-rupee formatting with no float error, CSV quoting and formula-injection protection, HSN tax apportionment summing exactly, totals reconciling on 500 random invoice sets |
| `test/gst-report-route.test.js` | The real report pipelines run by an in-memory aggregation evaluator: only active invoices inside the period count, reversed invoices excluded and flagged, the reconciliation check catches a one-paisa mismatch, FY and range modes, the register paginates, HSN totals equal the report totals, missing-HSN warning, CSV contents, headers, BOM and TOTAL row, the 5,000 cap, and no Estimate, Challan or payment model touched |
| `test/gst-report-mount.test.js` | The real app mounts `/api/reports/gst` once, behind `verifyToken` and the admin role check: no token or a bad token gives 401, non-admin roles give 403, admin passes (loads index.js with dotenv stubbed, so no .env is read) |
| `test/invoice-session.test.js` | Invoice create, edit, reverse, payment and void routes with fake sessions: snapshots and tax, IGST without GSTIN, no-state, missing HSN/GST and seller-not-configured blocks, shortage writes nothing, edit locked after payment, abort and end once, never two operations on one session |
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

**Estimates (Step 11B, needs live MongoDB):**
- Create an estimate and check the stock and the two Stock History rows ("Estimate Out").
- Two browser tabs racing for the last units: one succeeds, the other gets 409 and the stock never goes negative.
- Edit: increase, decrease, remove and add lines, checking the movements by difference; re-price a kept line; editing below the amount paid is blocked.
- Cancel is blocked with a valid payment and works after voiding it, returning all stock.
- Two payments at once cannot exceed the outstanding balance; a payment dated before the estimate or in the future is rejected.
- The first estimate after 1 April gets `EST/<new FY>/0001`.
- Print shows no GST or HSN and paginates naturally.

**Invoices (Step 11C, needs live MongoDB and the seller details):**
- With the seller details still blank, creating an invoice is refused.
- After the details are filled in, check a UP customer (CGST + SGST) and an out-of-state customer with no GSTIN (IGST).
- An item with no HSN code or GST rate blocks the invoice with its name.
- The worked examples from Architecture §15 match the saved invoice, and round-off and total agree with the print.
- Edit before any payment adjusts stock and tax; after a payment it is refused.
- Reversal is blocked with a valid payment and works after voiding.
- Two payments at once cannot exceed the outstanding balance.
- The first invoice after 1 April gets `INV/<new FY>/0001`.
- With the bank env variables set, the bank block prints; without them it is omitted.

**Delivery Challans (Step 11E, needs live MongoDB):**
- Create a challan for part of an invoice: stock and Stock History do not change, payments do not change, and the invoice shows Partly dispatched with the remaining quantities.
- A second challan for the rest makes the invoice Fully dispatched. A further challan is refused.
- Two browser tabs creating a challan for the last quantity at the same time: one succeeds and the other gets 409; the invoice never shows more dispatched than ordered.
- Cancel a challan: its quantity returns to the remaining pool and a new challan can use it. Cancelling twice, or in two tabs, frees it once.
- Reversing or editing an invoice with an active challan is refused with a clear message. After cancelling the challans, the reversal works and returns stock once.
- Edit the transport details and notes; quantities cannot be changed from the edit form.
- The first challan after 1 April gets `CH/<new FY>/0001`.
- Print: no prices, GST or GSTIN; the table header repeats on later pages; a cancelled challan prints a CANCELLED banner.

**Monthly GST Report (Step 11F, needs live MongoDB):**
- For a month with known invoices, the cards and the register TOTAL row match the invoices to the paisa, and the reconciliation badge shows "Totals reconcile".
- A reversed invoice in the month is not in any total and appears in the Reversed list. Reversing an invoice from last month shows "Reversed after period".
- Estimates and challans in the same month do not change any number.
- Invoices on the 1st and on the last day of the month are included; the day before and after are not (check 31 March / 1 April).
- The FY view equals the sum of its months. A custom range longer than 366 days is refused.
- Download each CSV and open it in Excel: ₹ and names display correctly, amounts are numbers, a customer name starting with = shows as text, and the TOTAL row matches the screen.
- The HSN tax column totals equal the rate-wise totals.
- Check the query plans in MongoDB use the `{status, invoiceDate, _id}` index for a large month.

**Estimate to Invoice conversion (Step 11D, needs live MongoDB):**
- Convert an estimate that has two payments. Stock does not change and Stock History gets no new rows. The invoice has the same lines at the saved prices, with GST added on top.
- The estimate shows Converted, read-only, with the link to the invoice, and its payments show "Transferred". The invoice shows both payments as carried.
- Customer page: the estimate account drops that estimate and its payments, and the invoice account gains the total and the paid amount (no double counting).
- Two browser tabs converting the same estimate: one succeeds and the other gets 409. A conversion racing a payment or an edit on the same estimate ends cleanly, either order.
- A product with no HSN code or GST rate blocks the conversion with its name. With the seller details unset, conversion is refused.
- Void the carried payments, then reverse the invoice: stock returns once and the estimate stays converted.
- At 0% GST with a payment that is a few paise more than the rounded total, conversion is blocked.

**PLANNED features:** live checks for steps 12 to 19 are in section 8. The Step 11A-11E checks above describe today's behaviour; steps 15 and 16 will change the invoice and challan checks.

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
| 10 | Invoices cannot be created until the NCH seller details are filled in, and Finished Goods saved before Step 11A (no stored GST rate) or without an HSN code cannot be invoiced until they are updated in Stock Management. | `src/config/sellerProfile.js`, Stock Management |
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

### Open items before go-live

- [ ] Credential rotation (record no values here):
  - [ ] Atlas password
  - [ ] Render `MONGODB_URI` and `JWT_SECRET`
  - [ ] Admin password
  - [ ] Atlas network access
  - [ ] Repository privacy
- [ ] Real logo
- [ ] Licence number
- [ ] Seller profile and bank details entered in Settings (Settings is built in step 15)
- [ ] HSN code and GST rate on every Finished Goods product
- [ ] Accountant sign-off (one-total GST method, round-off, HSN apportioning)
- [ ] Live checks for steps 11A to 11F (section 6)

### Not verified live

Browser behavior at 360/390/430px, tablet and desktop; physical or PDF print output (payout, washer slip); authenticated API calls against a deployed backend; MongoDB transactions, rollback and concurrency on the deployed topology; the deployed server time zone; query plans for the declared indexes; Render and Vercel environment variables.

## 8. Roadmap

All steps are **PLANNED**. Each follows section 4 before it starts. Rules are in `NCH_Architecture_Plan.md` and `NCH_Design_Decisions.md`. Models follow section 5. The live checks below need a deployed or connected environment.

### Step 12: Security basics

- **Scope:** admin login lockout, rate-limit infrastructure and limits, CORS, security headers, audit log, ownership helper, hidden admin path (`ADMIN_LOGIN_PATH`). The enquiry limit is applied in step 14.
- **Model:** Opus to plan, Sonnet to build.
- **Live checks:**
  - The 5th failed admin login locks for 15 minutes, per account and per IP; login works after the lock ends.
  - The login limit (10 per 15 minutes per IP) and general API limit (300 per 15 minutes per IP) apply, using the real client IP behind Render.
  - The deployed frontend works; other origins are blocked.
  - Security headers are present on deployed responses.
  - Failed logins are in the audit log.
  - The ownership helper refuses another customer's record (route-level checks follow in steps 16 and 17).
  - The admin login opens at the configured path; there is no public link to it.

### Step 13: Design system and shell

- **Scope:** navy theme, dark mode, grouped sidebar, login pages, optional password banner, dashboard. Finalise the dashboard card list.
- **Model:** Sonnet.
- **Live checks:**
  - 360, 390 and 430px, tablet and desktop, in light and dark mode.
  - Every built page is still reachable from the sidebar and on phones.
  - Both login pages work. The admin page is `noindex`.
  - The banner can be dismissed and does not force a password change.

### Step 14: Public website, Enquiries inbox and Notifications

- **Scope:** Home, Quality and Enquiry pages; enquiry form with honeypot, Cloudflare Turnstile and rate limit; Enquiries inbox; admin Notifications.
- **Model:** Sonnet.
- **Live checks:**
  - The pages work on phone and desktop, with no admin link anywhere.
  - An enquiry reaches the inbox, with a badge and a notification.
  - The 6th enquiry within an hour from one IP is refused. Honeypot and failed Turnstile submissions are refused.
  - Tabs, status, note, Call, WhatsApp, Create customer and Delete work.
  - Unread filter, mark all read and open-item work.

### Step 15: Settings and final invoice

- **Scope:** Settings (company, bank, QR, invoice, website and enquiry, security), invoice layout v5, draft, preview, generate, 48-hour edit window with history, required Batch No. Settle the step 15 open questions (Architecture section 15) first.
- **Model:** Opus to plan, Sonnet to build.
- **Live checks:**
  - Settings save and are admin-only; the QR uploads and removes.
  - Drafts (direct and estimate conversion) take no number or stock and are not in the GST report.
  - Generate assigns one number and takes stock once, also with two tabs. A converted estimate takes no stock again.
  - A payment locks edits; so do 48 hours after Generate. Reverse still works. Edits appear in the history.
  - Batch default, split lines and overwrite work; a blank batch is refused.
  - Old invoices keep their bank details after Settings change.
  - Printed and PDF output matches v5: one copy, about 15 items per page, CGST + SGST and IGST cases, each colour.

### Step 16: Orders, customer accounts and Shipments

- **Scope:** customer accounts, orders and approval flow, Shipments replacing challans. Plan Shipment details first. Before removing challan code, confirm the challans collection is empty.
- **Model:** Opus to plan, Sonnet to build.
- **Live checks:**
  - Admin creates a login; the customer signs in with mobile or email.
  - A customer cannot read another customer's data, including by changing ids in requests.
  - Order, Approve, Approve with changes (never above the ordered quantity) and Reject (reason required) work, with customer notifications.
  - Cancel works only before approval, also when it races an approval.
  - Approval creates only a draft: no number, no stock change.
  - Mark Dispatched and Mark Received work.
  - Partial shipments never exceed invoice quantities, also with two tabs. A shipment works without an order. Shipments change no stock.

### Step 17: Customer Billing

- **Scope:** Billing tabs Invoices, Payments and Statement, with PDF download; payment notification to the customer.
- **Model:** Opus to plan, Sonnet to build.
- **Live checks:**
  - Only the customer's generated invoices appear, never drafts; the PDF matches the printed layout.
  - Recording a payment shows the customer a notification. Payments are read-only.
  - Billed, paid, balance and statement opening, running and closing balances match the admin ledger.
  - Another customer's invoice or PDF is refused.

### Step 18: Website Products admin

- **Scope:** add, edit, delete (confirm), Shown or Hidden; name, group, photo, short description, status.
- **Model:** Sonnet.
- **Live checks:** each action works; hidden products do not appear publicly; photos still load after a redeploy; the public site needs no login and the admin actions do.

### Step 19: Admin two-factor

- **Scope:** authenticator setup in Settings (Security) and the 6-digit code at admin login.
- **Model:** Opus to plan, Sonnet to build.
- **Live checks:** setup with a real authenticator app; wrong and expired codes are refused; lockout and rate limits still apply; the admin API cannot be used with the password alone.

### Later

Supplier portal (view-only first), WhatsApp, OTP, forgot-password by email or SMS.

### Not scheduled

- **Labels.** Confirm the specification first (`NCH_Architecture_Plan.md` section 16).
- **Backlog fixes** (section 7): IST "today", payout edit audit trail, pagination and indexes, split `PayoutPage.jsx`, scope the global button rule, prettier clean-up.
- **Reports:** inventory by category, low stock, stock movement, raw material consumption, manufacturing, wastage, Finished Goods production, payroll register, attendance summaries.
- **Performance Phase 2**, only after live timing and query-plan evidence.
- **Credit notes** for invoices reversed after a filed month.
- **GSTR-1** export, once the extra data in `NCH_Architecture_Plan.md` section 15 is confirmed.

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

## 11. Decisions log

| Date | Decision record |
|---|---|
| 28 Nov 2026 | Approved design decisions, including the additional decisions in section 9 of that file: `docs/NCH_Design_Decisions.md`. It is the source of truth for what it covers. |
