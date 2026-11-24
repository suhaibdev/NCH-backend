# NCH Factory Management System — Architecture Plan

Status tags used in this file: **Built** (working route and UI exist), **Partial** (part exists, or known defects), **Planned** (approved, no code). Status was checked against the source and the 2026-11-21 audits (`NCH_Audit_Backend.md`, `NCH_Audit_Frontend.md`). The audits describe commits from 2026-10-24; where the current source is newer, the source wins. Delivery status and the backlog are in `NCH_Development_Plan.md`.

## Table of contents

1. Purpose and scope
2. Technology stack and hosting
3. System architecture
4. Repository and frontend structure
5. Routes and navigation
6. Security, API conventions and data access
7. Stock core
8. Stock Home, Universal Search and Stock Type pages
9. Suppliers, Material Receiving and Supplier Accounting
10. Washers and Process Goods
11. Manufacturing
12. Attendance
13. Payroll and Payout
14. Dashboard
15. Customer pricing, sales documents and the GST report (Built)
16. Planned: Labels
17. Planned: portals, orders, notifications and analytics
18. UI/UX standards
19. Performance and pagination standards
20. Engineering rules learned

---

## 1. Purpose and scope

**Project:** NCH Factory Management System. **Company:** New Calcutta Handloom (NCH).

An internal factory-management system for employees, attendance, payroll, suppliers, stock, washing, manufacturing and (planned) sales documents, labels and portals. It stays tailored to NCH workflows and does not become a generic ERP.

## 2. Technology stack and hosting

| Layer | Technology |
|---|---|
| Frontend | React 19, JavaScript only, React Router 7, Axios |
| Frontend build | Rsbuild (port 4000 in dev); deployed with an SPA rewrite (`vercel.json`) |
| Backend | Node.js + Express 4 |
| Database | MongoDB through Mongoose 7 |
| Authentication | JWT (7-day token carrying id and role) |
| Authorization | Role-based; only `admin` is used by any API |
| Backend hosting | Render |
| Frontend API base | `PUBLIC_API_BASE_URL` (read in `config/api.js`, with a hard-coded fallback URL) |

Rules: no TypeScript, no unnecessary packages, no duplicate data stores. Preserve working functionality. Rsbuild exposes only `PUBLIC_` variables to the browser (see section 20).

Backend and frontend are two separate git repositories (`NCH backend/`, `NCH frontend/`). The parent folder is not a repository.

## 3. System architecture

```text
Admin  →  React frontend  →  Axios / REST  →  Express backend  →  Mongoose  →  MongoDB
```

| Module | Status |
|---|---|
| Authentication | Built |
| Admin Shell (navigation) | Built |
| Dashboard | Partial ("today" counts use server-local time) |
| Employees | Built |
| Attendance, Bulk | Built |
| Attendance, Single | Built |
| Payout, Bulk | Built |
| Payout, Single | Built |
| Payout history, edit, print, delete | Built |
| Salary Slip (legacy page) | Partial (works only from router state; no slip for bulk lines) |
| Customers (billing details, GSTIN and state, detail page) | Built |
| Customer product prices, Finished Goods HSN and GST rate | Built (11A) |
| Suppliers, Material Receiving, Supplier Accounting | Built |
| Stock, Stock Types, Universal Search | Built |
| Stock History | Built |
| Washers, Process Goods, Washer advances and payouts | Built |
| Manufacturing (create, history, reversal) | Built |
| Products | Partial (a navigation alias to Stock Management; no Product model) |
| Estimates (create, edit, cancel, payments, print) | Built (11B) |
| GST Invoices (create, edit before payment, reverse, payments, print) | Built (11C) |
| Estimate to Invoice conversion (convert, carry-over of payments, links) | Built (11D) |
| Delivery Challans (against an invoice, partial dispatch, cancel, print) | Built (11E) |
| Monthly GST report (summary, rate, B2B/B2C, HSN, register, CSV) | Built (11F) |
| Labels page and label printing | Planned (Label exists only as a Manufacturing input rule) |
| Portals, Orders, Notifications | Planned |

Backend domains: authentication, employees, attendance, payroll and payout, customers, suppliers and supplier payments, material receipts, stock, washers and washing processes, washer accounting, manufacturing, dashboard.

## 4. Repository and frontend structure

```text
src/
├── App.jsx  index.jsx
├── components/   AdminLayout  AdminShell(.css)  Navbar(.css)  ProtectedRoute
├── config/       api.js  auth.js  axios.js
├── utils/        businessDate.js  challans.js  estimates.js  gst.js  gstReport.js  invoiceTax.js  text.js  washerPayoutCycle.js
└── pages/
    ├── AdminCommon.css  AdminPortalPage  FactoryFlowPage  HomePage  Hero  Login  Products
    ├── Customer/    CustomersPage  CustomerDetailPage
    ├── Estimates/   EstimatesPage  EstimateFormPage  EstimateDetailPage  EstimatePrint
    ├── Invoices/    InvoicesPage  InvoiceFormPage  InvoiceDetailPage  InvoicePrint  InvoiceTaxBreakdown
    ├── Challans/    ChallansPage  ChallanFormPage  ChallanDetailPage  ChallanPrint
    ├── Reports/     GstReportPage
    ├── Sales/       DocumentPayments (shared by Estimate and Invoice detail pages)
    ├── Employees/   EmployeesPage  Attendance  PayoutPage  SalarySlip
    ├── Suppliers/   SuppliersPage  SupplierDetailPage  ReceiveMaterialPage
    └── Stock/       StockHomePage  StockPage  StockTypesPage  StockTypeProductsPage
                     ProcessGoodsPage  ManufacturingPage  ManufacturingHistoryPage
                     ManufacturingHistoryTable  WashersListPage  WashersPage
                     WasherDetailFixed  WasherDetailPage  WasherPayoutSlipPage
```

`pages/Products.jsx` is a public marketing section on the home page; it is not the admin Products item. `WasherDetailFixed.jsx` is the live route for washer master data and rates; the name is legacy. `Stock/StockHistoryPage` serves `/admin/stock/history`. There is no `LabelsPage` or `WashingPage`.

Backend: `index.js`; `src/config/sellerProfile.js` (public NCH seller details); `src/routes/` (19 route files), `src/models/` (32 models), `src/middleware/` (auth, role, database readiness), `src/utils/` (helpers listed per feature below), `test/` (plain Node assert scripts, see Development Plan section 6).

## 5. Routes and navigation

### Built admin routes (all protected)

```text
/admin/dashboard
/admin/employees
/admin/attendance
/admin/payout
/admin/salary-slip                              (data only through router state)
/admin/customers
/admin/customers/:customerId                    details, Estimate Account, Products and Prices
/admin/estimates                                list (filters sync to the URL, e.g. ?customer=)
/admin/estimates/new                            create (?customer= preselects)
/admin/estimates/:estimateId                    detail, payments, cancel, convert to invoice, print
/admin/estimates/:estimateId/edit               edit lines and notes
/admin/invoices                                 GST invoice list (filters sync to the URL)
/admin/invoices/new                             create (?customer= preselects)
/admin/invoices/:invoiceId                      detail, tax summary, payments, reverse, print
/admin/invoices/:invoiceId/edit                 edit lines and notes (only while no valid payment)
/admin/challans                                 delivery challan list (filters sync to the URL, e.g. ?invoice=)
/admin/challans/new                             create against an invoice (?invoice= required)
/admin/challans/:challanId                      detail, edit transport, cancel, print
/admin/reports/gst                               monthly GST report (period in the URL: mode, month, fy, from, to)
/admin/stock/history                            stock movement history
/admin/suppliers
/admin/suppliers/:supplierId
/admin/suppliers/:supplierId/receive
/admin/stock                                    Stock Home + Universal Stock Search
/admin/stock/manage                             Stock Management
/admin/stock/types                              Stock Types
/admin/stock/type/:typeId                       one reusable Stock Type page
/admin/factory-flow                             Process Goods and Manufacturing cards
/admin/stock/process-goods
/admin/stock/manufacturing
/admin/stock/manufacturing/history
/admin/washers                                  directory
/admin/washers/new                              add/edit form
/admin/washers/:washerId                        master data and per-output-type rates
/admin/washers/:washerId/account                advances, payouts, process history
/admin/washers/:washerId/payouts/:payoutId/slip
```

Legacy redirects: `/employees`, `/customers`, `/employees/attendance`, `/employees/payout` go to their `/admin/...` equivalents. `*` goes to `/`. Route protection in the browser is a token-exists check; the backend enforces expiry and role.

### Planned routes (no page exists)

```text
/admin/labels            label generation and printing
```

### Admin Shell navigation (Built)

All admin routes render through one responsive `AdminShell`. The public `Navbar` is used only on the public home page.

- **Desktop:** a fixed, collapsible dark-navy sidebar. Order: **Dashboard, Products, Attendance, Stock, Factory Flow, Payout, Washers, Suppliers, Customers, Estimates, Invoices, Challans, GST Report, Employees.** Logout is a separate button at the bottom. There is no Stock dropdown. Products opens `/admin/stock/manage`.
- **Brand:** `NCH` with `NEW CALCUTTA HANDLOOM` beneath it. The Admin identity shows at the right. There is no notification bell and no profile menu.
- **Mobile:** a compact brand header plus a fixed bottom bar: **Home, Attendance, Stock, More.** The More sheet holds Products, Factory Flow, Payout, Washers, Suppliers, Customers, Estimates, Invoices, Challans, GST Report, Employees and Logout.
- **Collapsed rail:** centered `NCH` row, then the centered chevron toggle below it.
- The shell makes no startup data requests. Responsive padding and bottom-bar clearance come from the shell.

## 6. Security, API conventions and data access

- Every `/api/*` route except `POST /api/auth/login` and `GET /api/health` is mounted with `verifyToken` and `authorizeRoles("admin")`. Route files add no auth of their own. The token is not re-checked against the user collection.
- Startup connects to MongoDB before binding the HTTP port (10-second server-selection timeout). A shared readiness gate returns 503 for `/api` traffic while MongoDB is disconnected. `GET /api/health` reports only `ready` or `not_ready`.
- Server errors return generic messages through `utils/httpErrors.js` (`sendServerError`); details are logged on the server only.
- The backend is authoritative for stock, payout, label, reversal, duplicate-batch, financial-total and transaction rules. Frontend validation is a convenience.
- Money is stored in integer paise for suppliers, washers and material receipts. Payroll amounts use rupee numbers rounded to two decimals.
- Never expose secrets or JWT keys in frontend code. `.env` is never tracked.
- Gaps: CORS is open, there is no login rate limit, and there is no pagination on several list endpoints (Development Plan section 7).

## 7. Stock core

### Fixed main categories

```text
raw_material   washed_raw_material   finished_goods
```

These are fixed because washing and manufacturing depend on them.

### Stock Types

Admins create Stock Types under a fixed main category. A Stock Type belongs to exactly one category. `StockType` declares `requiresSupplier` and `requiresSize` (both default false, forced false for Finished Goods).

- Raw and Washed Raw Material require a Stock Type. Finished Goods may stay Unassigned.
- Creating a Stock Type never auto-assigns old products.
- Legacy Raw/Washed items with `stockType: null` still load and accept stock in/out; a master-data edit must classify them first.
- Product forms show only Stock Types of the selected category. All dedicated Stock Type pages use one reusable component.
- Stock Type delete is blocked while items use the type.
- No cloth or material name is hard-coded in route logic. The only name rule is the Manufacturing Label type (section 11).

### StockItem

```js
{ productName, category, stockType, size, supplier, unit, currentStock, minimumStock, notes }
```

- Units: `pcs` or `dozen`. One fixed unit per product. No automatic conversion.
- Purchase price and receipt condition live on `MaterialReceipt`, never on `StockItem`. No Finished Goods cost is calculated anywhere.
- One inventory store only: `StockItem`.

### Structured size and identity

Size is `{length value+unit, width value+unit}` with units `m`, `cm`, `inch`, `ft`; values are positive decimals stored as entered, with no conversion. For a tracked type (one that requires supplier and size) the identity is:

```text
category + Stock Type + supplier + length + width + stock unit
```

An exact tracked identity cannot be created twice. A non-unique compound index supports lookup. A `StockIdentityLock` collection (unique identity key) serializes first-time creation without a risky unique index on legacy data. Once an item has stock activity or a positive balance, its supplier, Stock Type and size cannot change.

### Quantity rules

- Whole numbers only. Never negative. `currentStock` is never edited directly.
- Stock changes only through: Stock In, Stock Out, Material Receiving, Process Goods send and complete, Manufacturing and its reversal, and the opening balance on create. Every decrement is a conditional update (`currentStock >= quantity`).
- Low stock: `currentStock <= minimumStock`.

### Stock movements

Every quantity change writes a permanent `StockMovement` with snapshots of product, category, Stock Type, supplier, size and unit, plus direction, quantity, balance before/after, reference and date. History stays understandable after a rename. Movements are never deleted.

Movement types the code writes:

```text
stock_in  stock_out  material_receipt
washing_sent  washing_completed
manufacturing_use  manufacturing_output
manufacturing_reverse_in  manufacturing_reverse_out
```

`washing_out`, `washing_in` and `adjustment` exist in the schema enum but no code writes them. Reference types include `washing_process`, `manufacturing`, `manual` and `material_receipt`.

### Stock History

**Built.** `/admin/stock/history` is a read-only page with filters (product, movement type, main category, From/To date in Asia/Kolkata) and server-side pagination (20 per page). `GET /api/stock/history` accepts `category`, `search`, `startDate`, `endDate`, `movementType`, `itemId`, plus optional `page`/`limit` (max 100). With paging params it returns `{ items, page, limit, total, totalPages }`; without them it returns the legacy array capped at 500. `GET /api/stock/:id/history` also exists and the Stock Management page shows per-item history. Movements are never deletable from it.

## 8. Stock Home, Universal Search and Stock Type pages

**Stock Home (`/admin/stock`) has exactly three cards: Stock Management, Stock Types and Stock History.** It also holds Universal Stock Search. Process Goods and Manufacturing are reached from Factory Flow (`/admin/factory-flow`), which has two whole-card links.

**Universal Stock Search** calls `GET /api/stock?search=<QUERY>` against the single `StockItem` collection, searching product name and Stock Type name across all categories. Results show Product, Main Category, Stock Type, Current Stock, Unit, Minimum Stock and Status. Filters: main category, Stock Type, status (All, In Stock, Low, Out). Searches are debounced and superseded requests are cancelled.

**Dedicated Stock Type page (`/admin/stock/type/:typeId`)** shows the type name and parent category, lists only products of that type, searches only within the type, and adds products with category and type preset.

## 9. Suppliers, Material Receiving and Supplier Accounting

All **Built**.

- **Supplier** master data: normalized unique name, contact person, phone (optional, exactly 10 digits), email, address, GSTIN (optional, standard 15-character structure), notes. Server-side search and pagination. No delete API. No balance fields.
- **Material Receiving** starts at `/admin/suppliers/:supplierId/receive` with the supplier locked. The condition maps in the backend: `not_washed` becomes `raw_material`, `already_washed` becomes `washed_raw_material`. The admin picks a configured Stock Type in that category that requires supplier and size. PCS only. Price is integer paise (`pricePerPiecePaise`); the backend computes `totalAmountPaise`. One MongoDB transaction writes the `MaterialReceipt`, merges into or creates the matching `StockItem` (using `StockIdentityLock` for first creation) and writes a `material_receipt` movement. Receipts have no edit or delete. `GET /api/material-receipts` is paginated and uses `lean()`.
- **Supplier Accounting:** `SupplierPayment` is permanent (integer paise, date, method, reference, notes; no edit or delete). Balance is derived: receipts minus payments. **A payment may never exceed the current outstanding; advances are not allowed; Record Payment is disabled at zero outstanding.** `GET /api/suppliers/:id/account-summary` uses aggregation. `GET /api/suppliers/:id/ledger` merges receipts and payments with `unionWith`, paginated. `POST /api/supplier-payments` recalculates inside a transaction and increments a `SupplierAccountLock` so concurrent payments serialize.

## 10. Washers and Process Goods

All **Built**.

### Washers

`Washer` stores a normalized unique name, optional phone, address, default rate per PCS (integer paise), per-output-type rates (`washingRates[]`), notes and active status. It has no balance fields. The Washer Detail page loads the eligible Washed Output Types (configured `washed_raw_material` Stock Types that require supplier and size), edits per-type rates, and can create a new eligible type through the Stock Type API. The empty state keeps the Add Output Type action visible.

### Process Goods: the real two-step flow

```text
Send     Raw -N          creates WashingProcess (in_process)   movement: washing_sent
Complete Washed +N       earns the washer charge, status completed movement: washing_completed
```

**Send** (`POST /api/washing-processes`, one MongoDB transaction):
- Source must be a Raw Material PCS item whose configured Stock Type requires supplier and size.
- The admin selects and the process snapshots the **Washed Output Type** (a configured Washed Stock Type requiring supplier and size). No cloth name is hard-coded; the types are whatever the admin configured.
- Requires an active washer, a whole positive quantity, a paise-safe rate (washer/type rate, with an admin batch-rate override) and a sent date.
- Raw stock is deducted with a conditional update, the `WashingProcess` is created (`estimatedChargePaise` snapshotted) and a `washing_sent` movement is written with supplier, type and size snapshots.

**Complete** (`POST /api/washing-processes/:id/complete`, one transaction):
- Uses the saved output type, supplier, size, unit, washer and rate. A replacement output type is never accepted.
- Adds the quantity (1:1) to the matching Washed item, creating it under the identity-lock pattern if absent.
- Sets `earnedAmountPaise`, marks the process completed, and writes a `washing_completed` movement.

Raw stock is deducted on send only. Washed stock and the earned charge exist only after completion. The UI auto-selects the washer when exactly one active washer exists, shows the estimated charge before submit, and lists processes with server pagination. `WashingProcess` has no `reason` field.

### Washer accounting

`WasherAdvance` and `WasherPayout` are permanent records (integer paise).
- Advances are allowed without earnings.
- A payout settles only completed, unpaid processes in the selected date range, applies no more than the outstanding advance or the gross earnings, links the processes and marks them paid in one transaction. Numbers are `WP-YYYY-NNNN`. Payouts are paid on generation.
- Default cycle: Friday through Thursday (Thursday is the normal payout day); the admin may pick another range.
- Washer Account has Advance, Payout preview, Payout History (each row has a View Slip action) and Process History. The slip route loads one saved payout by washer id and payout id, so a mismatched URL is rejected. Print uses the saved snapshot, A4 portrait.
- `ProcessGoodsPage.css` is shared by all washer pages (see the global button rule in the backlog).

## 11. Manufacturing

**Built.** Protected at `/api/manufacturing`. Pages: `/admin/stock/manufacturing` and `/admin/stock/manufacturing/history`.

- **Inputs:** multiple Raw or Washed StockItems. Finished Goods cannot be an input. **Output:** exactly one Finished Goods item; Raw/Washed cannot be an output. No fixed ratio, no BOM, no cost rollup. Quantities are whole numbers. `quantityUsed` includes wastage: `0 <= wastage <= quantityUsed`, and the deduction equals `quantityUsed` (10 used with 2 wasted deducts 10).
- **Required inputs per entry:** at least one Washed Raw Material input and exactly one Label input. The Label item must belong to the Raw Material Stock Type whose normalized name is `label`. Label `quantityUsed` equals the numeric Finished quantity (no Dozen-to-PCS conversion: 100 DOZ needs 100 PCS Labels), Label unit is PCS and Label wastage is zero. The backend rejects manipulated Label quantities, missing or duplicate Label input, and insufficient Label stock before any change.
- **Entry:** Admin enters Manufacturing Date, a required Batch No., Finished product, quantity and unit, materials, and optional notes. Number format is `MF-YYYY-NNNN`.
- **Transaction:** validate, conditionally deduct every input, increase the Finished item, create the `ManufacturingEntry`, and write `manufacturing_use` and `manufacturing_output` movements. Any insufficient input aborts everything. Each entry snapshots every input (item, category, type, supplier, size, unit, quantity, wastage) and the output.
- **Batch duplicate check** compares a normalized batch number with a `findOne` and a non-unique index, so two simultaneous creates with the same batch could both succeed. A unique constraint is not added because older records have no batch data (backlog).
- **Reversal:** entries are never deleted. A reason-required reversal blocks an already-reversed entry, blocks when current Finished stock cannot absorb the output, restores the inputs, subtracts the output, writes `manufacturing_reverse_in` and `manufacturing_reverse_out`, and saves the reversal time, user and reason.
- **Pages:** the main page shows the latest five entries from one bounded request. A row toggles one inline saved-snapshot detail (no View column). `View All History` opens the full history, which has Back, Month, From/To Date, Finished Product, Size and partial Batch No. filters, explicit Apply and Reset, server pagination and the same expandable table. Same-date From/To is exact. The batch filter escapes regex input. Dates show as `14 Oct 2026` through the shared `businessDate` formatter.
- **Form order:** Back, Manufacturing, Manufacturing Details (date, Batch No.), Finished Goods Output, Materials Used (Washed row: Item, Available, Qty Used, Wastage; Label row: Item, Available, read-only Required; `+ Add Input` for removable Raw/Washed rows), compact Notes and Summary, Complete Manufacturing, recent history.

## 12. Attendance

**Built** (Bulk and Single). Page: `/admin/attendance` (`pages/Employees/Attendance.jsx`).

### Rules

- `workHours` decides status: zero is Absent, any positive value is Present (single create, update, bulk, and calendar rendering, including legacy records with a stale `present` flag). The Advance indicator shows on both Present and Absent cells.
- **Default work hours:** `STANDARD_WORK_HOURS = 8` (`utils/payroll.js`). `GET /api/attendance/bulk` returns it as `defaultWorkHours`; the Bulk form uses that value and has no separate constant.
- **Working Hour maximum is 8** (frontend limit and backend `hasValidWorkHours`). **Overtime is 0–24.** Advance is non-negative.
- **Future dates are blocked.** Past dates and today are allowed, compared as date-only `YYYY-MM-DD` strings in `Asia/Kolkata`. The backend returns 400 with `code: "FUTURE_ATTENDANCE_DATE"` for single create, update and bulk. The native date pickers have `max=today`, and future register cells cannot be opened for entry.
- **Attendance is locked after payout.** Create, update, delete and bulk save are rejected with 409 `ATTENDANCE_LOCKED_BY_PAYOUT` when a `Payout` or a `BulkPayout` line covers that employee and date (`utils/attendanceLock.js`). Delete the payout first to edit attendance.
- Known gap: the `Attendance.workHours` schema allows up to 24; the routes cap at 8.

### Bulk Attendance

- The page opens on the Attendance Register with no entry form open. **Bulk Attendance** and **Single Attendance** actions open one form at a time (`attendanceMode` is `null`, `"bulk"` or `"single"`). A successful save closes the form, refreshes the register and shows feedback; a failed save keeps the form and values.
- **Date:** a compact editable `DD/MM/YY` input with a calendar icon that opens the native picker. Helpers convert between `DD/MM/YY` and canonical `YYYY-MM-DD` (two-digit years map to 2000–2099; impossible dates are rejected). A valid value commits on blur or Enter and reloads the rows; invalid input shows `Enter a valid date in DD/MM/YY format.` Save blocks invalid dates and commits a pending valid date first.
- **Rows:** `GET /api/attendance/bulk?date=YYYY-MM-DD` returns all active employees, `defaultWorkHours` and saved attendance. Employees are sorted A–Z. Unsaved rows start checked, Present, default hours, zero overtime, zero advance. A saved record overrides those defaults (a saved Absent / 0 row displays as saved).
- **Table (one table at every width):** Checkbox + Employee, Status, Working Hour, Overtime, Advance. Phones label the columns Work and OT. There is no Select All. The checkbox directly before each name decides whether the row is included in the save; unchecked rows are untouched (not Absent, not deleted).
- **Field behavior:** Working Hour 0 sets Absent and Overtime 0. A positive Working Hour sets Present. Manually choosing Absent zeros Working Hour and Overtime but keeps Advance editable. Manually choosing Present restores the default hours and zero overtime. A cleared Working Hour is invalid: status is unchanged, save is blocked with `Working Hour is required for <employee>`, and the backend also rejects a missing value.
- **Controls:** Working Hour and Overtime are compact two-digit inputs; Advance is a compact four-digit input; Status is a compact select that shows full Present/Absent text. On phones the Bulk table fits without any horizontal scroll (shared `colgroup`; Employee flexible; Status, Work, OT, Advance fixed widths; Employee left-aligned and other headers centered). `tbody` stays a normal row group.
- **Save:** `POST /api/attendance/bulk` validates the date (not future), unique active employees, hours, overtime and advance, then creates or updates each selected employee's record for that date in one MongoDB transaction. It returns created, updated and failed counts and the saved records; there is no partial success. Double submit is prevented.
- **Register:** employees sorted A–Z; flat layout with no outer card shells; on phones a compact sticky Employee column and locally scrollable date columns (aiming for about ten visible), never page-level horizontal overflow. Month browsing is unchanged.

### Single Attendance

One-employee create, edit and the monthly register. It still hard-codes 8 in several UI places (backlog).

## 13. Payroll and Payout

### Payroll rules

- `Employee.baseDailySalary` is a daily rate; the hourly rate is `baseDailySalary / 8`.
- Working time accumulates actual positive hours and is snapshotted as full 8-hour days plus remaining hours (20 hours is `2D 4H`); partial days are never rounded up.
- Gross = actual worked hours plus overtime at the hourly rate. Advance recovery is limited to the outstanding advance and counted once. Other Deduction is a non-negative number.
- `Net = Gross − Advance Deduction − Other Deduction`, calculated by the backend. **A negative net is rejected on bulk create, single create and payout edit** (`validateNetSalary`).
- Advance is derived from attendance advance payments minus the advance cuts of surviving payouts, counting both `Payout` and `BulkPayout` records.
- Payroll periods are a frontend list: `1–10`, `11–20`, `21–Month End`, `Custom` (default `Custom`). The backend takes only a start and end date and stores the period code and name given. The backend rejects an end date later than today, so a preset that ends after today is rejected.

### Records and numbering

- `BulkPayout`: one immutable parent snapshot per bulk run (period code/name, dates, paid-on date, totals, saved employee lines). Number `NCH-BULK-YYYY-NNNN`.
- `Payout`: single and legacy records, number `NCH-PAY-YYYY-NNNN` (shown as **Salary Slip No.**).
- Both are readable without migration.

### Create

- **Bulk (default mode):** `POST /api/payout/bulk-preview` then `POST /api/payout/bulk`. Every selected active employee is validated (overlap, attendance, advance, deductions) and the whole set commits in one transaction. Any invalid line rolls everything back; there is no partial success. Preview disables an overlapping employee with the source, period and paid-on detail.
- **Single:** `POST /api/payout/preview` then `POST /api/payout`. It applies the same overlap, advance and negative-net rules as bulk and runs in a transaction.
- **Overlap:** one shared lookup covers `Payout` records and `BulkPayout` employee lines, inclusive of the start and end days, in preview and in create (re-validated inside the transaction).
- `POST /api/payout/bulk-legacy` is disabled and returns HTTP 410.
- After a successful create the form is replaced by a saved-record success card (Period, employee count or name, total paid, Print, Create Another). The mode is preserved.
- Mobile: the Bulk Payout uses employee cards at 768px and below (Working Time, Gross, Advance Outstanding, Advance Left, Advance Cut and Other Deduction inputs with Zero/Full, Net Paid). Desktop uses a table with contained scrolling. The payout-level Payment Method (Cash, UPI, Bank Transfer) applies to the run.

### History

Independent **Bulk** and **Single** tabs (default Bulk), each paginated 20 per page with its own serial numbers. Rows expand inline to the saved snapshot. Desktop uses compact tables; mobile uses width-safe cards. Actions are compact text-only **Edit / Print / Delete**. `GET /api/payout` (all single payouts, unbounded) still feeds the legacy records table.

### Edit

`PATCH /api/payout/:id` (single) and `PATCH /api/payout/bulk/:id` (bulk). Edit expands the same history row or card; there is no separate page.
- **Editable:** payment method, Advance Cut, Other Deduction. Bulk has one common payment method plus per-employee Advance Cut and Other Deduction.
- **Immutable:** employee, payroll period, start and end dates, working time and days, gross salary, payout numbers. Unknown fields are rejected with 400.
- Advance Left and Net Paid are recalculated by the backend and read-only in the UI.
- **Advance cap:** a cut cannot exceed the outstanding advance at that payout's end date.
- **Chronology:** raising a cut is rejected with 409 `ADVANCE_CHRONOLOGY_CONFLICT` when a later payout would no longer fit within the advances available at its end date.
- Negative net is rejected. Validation runs before a transaction opens and again on fresh data inside it.
- There is no audit trail of edits (backlog).

### Print

- **Bulk print:** one complete saved `BulkPayout` is selected (from the success card or the clicked history row) and rendered by one direct-body React portal after an animation-frame trigger. The report uses only saved data, repeats the table header across pages, and lets the browser choose orientation with 12mm/14mm margins. The summary is two columns: Payment Method, Other Deduction, Advance Left at the left; Total Gross, Advance Cut, Total Paid at the right.
- **Single print:** `handlePrintSingle` converts a saved single payout into the same report layout.
- Print CSS isolates the portal from the global Salary Slip and Washer print rules. Physical print output has not been verified.
- **Salary Slip** (`/admin/salary-slip`) is the older single-payout view; it works only from router state and shows "No Salary Data Found" after a refresh.

### Delete

Hard and permanent. `DELETE /api/payout/:id` and `DELETE /api/payout/bulk/:id` each run in a transaction and delete only the canonical record (no employee-level bulk delete). Deleting restores future derived advance and overlap eligibility. The UI asks for confirmation, blocks duplicate clicks and refreshes only the affected history page.

## 14. Dashboard

**Partial.** `GET /api/dashboard` returns employee counts, today's attendance, recent employees and salary and advance totals for the month. It uses parallel reads and `lean()`; unused all-history advance data is not computed. The month salary card sums `Payout` and `BulkPayout` over the IST calendar month (fixed +05:30, bounds are IST midnight instants); month advance uses the IST month start at UTC midnight because attendance dates are stored that way. "Today" still uses server-local time (backlog).

## 15. Customer pricing, sales documents and the GST report (Built)

### Final design decisions (approved, Step 11A)

- NCH is registered in Uttar Pradesh, GST state code `09`.
- Tax type is decided **only** from the customer's `stateCode` (revised in Step 11C): state `09` gives CGST + SGST, any other valid state gives IGST, whether or not the customer has a GSTIN. A customer without a valid state cannot be invoiced. (The earlier "no GSTIN = local" fallback was removed.)
- GST is calculated **once per GST-rate group** on that group's taxable total, not per line. The grand total is rounded to the nearest rupee with a separate round-off line (Step 11C; full algorithm below).
- **There is no default selling price.** Prices exist only per customer per product. A customer can be billed only for a product that has an active price assigned to that customer.
- Finished Goods keep an HSN code and a GST rate. These are tax metadata, never prices or a manufacturing cost.
- Allowed GST rates: **0, 0.25, 3, 5, 18, 40** percent. Default 5. (12 and 28 are rejected.)
- Estimates, Invoices and Challans each get their own number series (later steps).
- Documents keep immutable snapshots: each line copies the price, product name, unit, HSN and GST rate. Changing or deactivating a customer price never alters an existing document.

### Built in Step 11A

**Customer** (`models/Customer.js`, `routes/customers.js`, `utils/customerValidation.js`). All new fields are optional or defaulted, so existing customers needed no migration.
- `name` (required), `email` (required, unique, lowercased on write), `billingName` (empty means use `name`), `contactPerson`, `contactNumber` (String, empty or exactly 10 digits; legacy numeric values are cast to strings on load), `gst` (the GSTIN; empty or a valid 15-character GSTIN whose prefix is a valid state code).
- `stateCode`: derived from the GSTIN's first two digits and locked to it (a mismatch is rejected with 400). With no GSTIN, the admin must choose it manually. Valid codes are 01 to 24, 26, 27, 29 to 38 and 97; 25, 28 and 99 are rejected (`utils/gst.js`).
- `billingAddress {line1, line2, city, pincode}`, `shippingSameAsBilling` (default true), `shippingAddress {line1, line2, city, pincode, stateCode}` (cleared when same as billing; otherwise line 1 and state are required). PIN codes are 6 digits.
- `isActive` (default true; a legacy document without the field reads as active). Inactive customers cannot get new or changed prices.
- Legacy `stock` and `orders` fields and the `POST /:id/order` stub are untouched (no caller). They should be removed in a later cleanup.
- Indexes: existing unique `email`; new `{gst}` and `{isActive, name}`. Timestamps added.

**CustomerProductPrice** (`models/CustomerProductPrice.js`): `customer`, `item` (a Finished Goods `StockItem`), `pricePaise` (integer, 1 to 100,000,000, that is up to Rs 10,00,000 per stock unit), `isActive`, timestamps. Unique `{customer, item}`; index `{item}`. The price is per the item's stock unit (PCS or Dozen). Rows are never hard-deleted; deactivating sets `isActive: false`.

**Finished Goods tax metadata** (`models/StockItem.js`, `routes/stock.js`): `hsnCode` (empty or 4 to 8 digits) and `gstRatePercent` (allowed set above). No schema default, so Raw and Washed items never carry these fields; the schema and routes reject them for other categories. New Finished Goods get 5 percent; existing Finished Goods without the field are treated as 5 percent. Moving an item out of Finished Goods clears the fields and is blocked (409) while customer prices exist for it. Stock quantity and movement logic are unchanged. Edited in Stock Management (`/admin/stock/manage`), in the Add Product and Edit Product modals, shown only for Finished Goods.

**Customer endpoints** (all admin-only under `/api/customers`):

| Method | Path | Notes |
|---|---|---|
| GET | `/` | Legacy array (cap 1000) or `?page/&limit` envelope; optional `?status=active\|inactive`, `?search=` |
| GET | `/:id` | 400 bad id, 404 |
| POST | `/` | 200 with the customer; 400 validation; 409 duplicate email |
| PUT | `/:id` | Changes only the fields sent; cross-field rules checked on the merged result |
| DELETE | `/:id` | 409 when any price row exists (deactivate instead) |
| GET | `/:id/prices` | Always paginated (default 20, max 100); `?status=active` (default) `\|inactive\|all`; sorted active first, then product name |
| PUT | `/:id/prices/:itemId` | Body `{ price: "125.50" }` in rupees, stored as paise. 201 created or 200 updated (also reactivates). Rejects inactive customers and non-Finished Goods items |
| DELETE | `/:id/prices/:itemId` | Deactivates (idempotent); 404 when no row exists |

**Frontend:** `/admin/customers` has the sectioned form (GSTIN auto-fills and locks the state), a status filter and whole-row click to `/admin/customers/:customerId`. The detail page shows the customer details and a Products and Prices section: add a product from a Finished Goods search, set the price in rupees, edit it inline, deactivate or reactivate it, 20 rows per page.

### Built in Step 11B: Estimates

**Final rules (approved):**
- An Estimate has **no GST and no HSN** anywhere (model, API, UI, print).
- Number `EST/2026-27/0001`: its own counter per financial year (April to March), taken from the estimate date and generated inside the creating transaction. It is never shared with invoices or challans.
- Lines are Finished Goods with an **active** `CustomerProductPrice` for that customer, one line per product (1 to 100 lines). Quantity is a whole number from 1 to 100,000 in the item's unit, with no PCS/Dozen conversion. The price, product name and unit are **snapshotted** on the line.
- The estimate date is a date-only value (default IST today, never in the future; backdating allowed). The customer and the date are fixed after creation.
- **Stock is deducted at creation** in one transaction, with a conditional update (`currentStock >= qty`) and one permanent `estimate_out` StockMovement per line (`referenceType: "estimate"`). A shortage blocks the whole estimate with 409, naming the item and the available quantity.
- **Edit** (lines and notes only) adjusts stock **by difference** per product: an increase deducts with `estimate_out`, while a decrease or a removed line returns stock with `estimate_return`.
  - A kept line keeps its price snapshot unless it is sent with `reprice: true`, which takes the current active price.
  - New lines use the current active price.
  - An edit that would make the total less than the valid payments is blocked (409).
- **Cancel** is a reversal, never a delete. It needs a reason, returns every line with `estimate_return`, and records the cancel date, user and reason. It is **blocked while any non-voided payment exists**: the admin voids payments first, so a refund decision is never hidden inside a stock operation, and a cancelled estimate never holds valid payments.
- **Payments** (`EstimatePayment`):
  - Recorded by an admin, partial payments allowed, integer paise.
  - The payment date is not in the future and not before the estimate date.
  - Method is cash, upi, bank_transfer, cheque or other, with an optional reference and notes.
  - A payment can never exceed the outstanding balance.
- **Voiding** is final and in place: `voided`, `voidedAt`, `voidedBy` and `voidReason` are set, and the amount, date and method never change. Nothing is deleted. To correct an amount, void the payment and record a new one.
- The **balance is derived** (total minus non-voided payments) and is never stored or edited.
- The estimate ledger is **separate** from the future invoice ledger. Totals and balances are never mixed.
- Conversion to an Invoice is built in Step 11D (see "Built in Step 11D" below). An estimate becomes `converted`, read-only and linked to the invoice, without a second stock deduction.

**Models:**
- `Estimate`:
  - Fields: `estimateNumber`, `financialYear`, `sequence`, `customer`, `customerSnapshot {name, billingName, contactNumber, stateCode, billingAddress}`, `estimateDate`, `lines[] {item, productName, unit, quantity, pricePaise, lineTotalPaise}`, `totalPaise`, `status active|cancelled|converted`, `notes`, `revision`, `createdBy`, `updatedBy`, `cancelledAt`, `cancelledBy`, `cancelReason`, `convertedInvoice`, `convertedAt`, timestamps.
  - Indexes: unique `estimateNumber`; `{customer, estimateDate, _id}`; `{status, estimateDate, _id}`; `{estimateDate, _id}`.
- `EstimateCounter`: `{financialYear unique, sequence}`.
- `EstimatePayment`:
  - Fields: `estimate`, `customer`, `estimateNumber`, `amountPaise`, `paymentDate`, `method`, `reference`, `notes`, `createdBy`, `voided`, `voidedAt`, `voidedBy`, `voidReason`.
  - Indexes: `{estimate, paymentDate, createdAt}` and `{customer, voided}`.
- `StockMovement` enums gain `estimate_out`, `estimate_return` and referenceType `estimate`. The Stock History labels are "Estimate Out" and "Estimate Return".

**Endpoints** (`/api/estimates`, admin only; helpers in `utils/estimates.js`):

| Method | Path | Notes |
|---|---|---|
| GET | `/priceable-products?customer=&search=&page=&limit=` | Active prices for Finished Goods with available stock, for the form |
| GET | `/` | Always paginated (20, max 100). Filters: `customer`, `status`, `from`, `to`, `search` (number). Rows include `paidPaise` and `outstandingPaise` |
| GET | `/:id` | `{ estimate, payments (voided included), summary {totalPaise, paidPaise, outstandingPaise, paymentCount, voidedCount} }` |
| POST | `/` | `{ customer, estimateDate, lines:[{item, quantity}], notes }` → 201 with the detail shape |
| PUT | `/:id` | `{ lines:[{item, quantity, reprice?}], notes }`; customer and date are rejected |
| POST | `/:id/cancel` | `{ reason }` |
| POST | `/:id/payments` | `{ amount (rupees), paymentDate, method, reference, notes }` → 201 |
| POST | `/:id/payments/:paymentId/void` | `{ reason }`; 409 when already voided |

`GET /api/customers/:id/estimate-account` returns `{ activeCount, cancelledCount, totalEstimatedPaise, totalPaidPaise, outstandingPaise, paymentCount }` from two aggregations. Customer DELETE now also returns 409 when the customer has estimates.

**Transactions and concurrency:**
- Payloads and ids are validated before the session opens. Every write runs inside `session.withTransaction`, with session operations awaited one at a time. The session is ended once in `finally`.
- Edit, cancel, payment and void first lock the estimate by bumping `revision` on an active estimate. That serializes them per estimate, so two racing payments cannot exceed the outstanding balance, and a payment cannot race a cancel or an edit that lowers the total.
- Two estimates racing for the last stock conflict on the StockItem document. The loser is retried by the driver, fails the `$gte` filter, and returns 409 with nothing persisted.
- `balanceBefore` and `balanceAfter` on movements come from the conditional update's result, never from an earlier read.
- Write conflicts, TransientTransactionError and 11000 that remain after retries return 409 "please retry".

**Frontend:**
- `pages/Estimates/` holds `EstimatesPage` (list), `EstimateFormPage` (create and edit), `EstimateDetailPage` and `EstimatePrint`.
- **Print:**
  - It portals `#estimate-print-root` into `<body>` and sets `body.est-printing` while printing.
  - It is text only and comes from the saved snapshot only.
  - It shows the total, paid to date and balance. A cancelled estimate prints a CANCELLED line.
  - The table header repeats and rows avoid page breaks.
- The customer detail page has an Estimate Account section with links to the list (filtered) and to New Estimate.

### Built in Step 11C: GST Invoices

**Final rules (approved):**
- Number `INV/2026-27/0001`: its own counter per financial year, from the invoice date, generated inside the creating transaction. It is never shared with estimates or challans.
- Customer prices are **exclusive** of GST: taxable value = quantity × price.
- Lines are Finished Goods with an active customer price, one line per product (1 to 100). Each line snapshots the price, the **HSN code** and the **GST rate**. An item without an HSN code or GST rate **blocks** the invoice with a message naming it. There is no silent 5% default for invoices.
- Optional per-line `batchReference` (up to 100 characters), so a production batch can be referenced later.
- The invoice snapshots:
  - the customer's name, billing name, GSTIN, state, contact and billing/shipping addresses
  - the tax type and the place of supply (the customer's state)
  - the **seller** details
- Stock is deducted at creation in one transaction: a conditional `currentStock >= qty` update plus an `invoice_out` StockMovement per line (`referenceType: "invoice"`). A shortage blocks the whole invoice with 409, naming the item and the available quantity.
- **Edit** (lines, batch references and notes) is allowed **only while no valid payment exists**:
  - Stock is adjusted by difference (`invoice_out` / `invoice_return`) and the tax is recomputed with the invoice's saved tax type.
  - Kept lines keep their price, HSN and rate snapshots unless re-priced.
  - After the first valid payment the invoice is locked; corrections are made by reversal.
- **Reverse:**
  - It is never a delete and needs a reason.
  - It returns all stock with `invoice_return` and records `reversedAt`, `reversedBy` and `reverseReason`.
  - It is blocked while valid payments exist; void them first. The number stays on record as reversed.
- **Payments:** the same rules as estimate payments (partial allowed, never above the outstanding balance, date not in the future and not before the invoice date, void in place). They are stored in `InvoicePayment`, a ledger **separate** from estimates.
- The balance is derived (total − valid payments). The customer's invoice outstanding grows by each invoice total.
- **Estimate link (used by 11D):** `sourceEstimate` and `sourceEstimateNumber` on the invoice, with a unique partial index on `sourceEstimate` so one estimate becomes at most one invoice.

**Tax algorithm** (`src/utils/gstInvoice.js` only; the frontend `utils/invoiceTax.js` is a preview mirror):

All amounts are integer paise. A rate becomes basis points (bp): 0.25 → 25, 5 → 500, 18 → 1800. `roundHalfUp(n, d) = floor((2n + d) / 2d)`.

1. Line taxable = quantity × price.
2. Group the lines by GST rate.
3. Tax type: customer state `09` → `intra` (CGST + SGST); another valid state → `inter` (IGST); no valid state → blocked.
4. Per group:
   - `intra`: each half = `roundHalfUp(taxable × bp, 20000)`, so CGST and SGST are equal.
   - `inter`: IGST = `roundHalfUp(taxable × bp, 10000)`.
5. The invoice taxes are the sums of the groups.
6. exact = taxable + tax; total = `roundHalfUp(exact, 100) × 100` (nearest rupee, 50 paise rounds up); round off = total − exact, always −49..+50 paise.
7. Invariant: taxable + CGST + SGST + IGST + round off = total. The per-rate summary rows sum exactly to the invoice totals.

Worked examples (all in `test/gst-invoice.test.js`):
1. 10 × ₹125.50 @ 5%, UP buyer: CGST ₹31.38 + SGST ₹31.38; exact ₹1,317.76; round off +₹0.24; total **₹1,318.00**.
2. 7 × ₹33.33 @ 5% plus 3 × ₹99.99 @ 18%, UP buyer: 5% group ₹5.83 + ₹5.83; 18% group ₹27.00 + ₹27.00; exact ₹598.94; round off +₹0.06; total **₹599.00**.
3. The same lines for a Maharashtra buyer: IGST ₹11.67 + ₹53.99; total **₹599.00**. The 5% group's IGST (₹11.67) is one paisa more than its CGST + SGST (₹11.66), because each half is rounded on its own; this is for the accountant to confirm.
4. 1 × ₹100 @ 0.25%, UP buyer: ₹0.13 + ₹0.13; round off −₹0.26; total **₹100.00**.
5. 1 × ₹99.50 @ 0%: round off +₹0.50; total **₹100.00**.

**Models:**
- `Invoice`:
  - Number and customer: `invoiceNumber`, `financialYear`, `sequence`, `customer`, `customerSnapshot`, `seller` (snapshot).
  - Date and tax: `invoiceDate`, `taxType intra|inter`, `placeOfSupplyStateCode`.
  - Lines: `{item, productName, unit, hsnCode, gstRatePercent, quantity, pricePaise, taxablePaise, batchReference}`.
  - `taxSummary[] {gstRatePercent, taxablePaise, cgstPaise, sgstPaise, igstPaise, taxPaise}`.
  - Totals: `taxablePaise`, `cgstPaise`, `sgstPaise`, `igstPaise`, `taxTotalPaise`, `roundOffPaise` (−49..50), `totalPaise`, `totalInWords`.
  - Status and audit: `status active|reversed`, `notes`, `revision`, `createdBy`, `updatedBy`, `reversedAt`, `reversedBy`, `reverseReason`, `sourceEstimate`, `sourceEstimateNumber`, timestamps.
  - Indexes: unique `invoiceNumber`; `{customer, invoiceDate, _id}`; `{status, invoiceDate, _id}`; `{invoiceDate, _id}`; unique partial `{sourceEstimate}`.
- `InvoiceCounter`: `{financialYear unique, sequence}`.
- `InvoicePayment`: the same shape as `EstimatePayment`, with `invoice` and `invoiceNumber`.
- `StockMovement` adds `invoice_out`, `invoice_return` and referenceType `invoice` (Stock History labels "Invoice Out" and "Invoice Return").

**Seller details** live in `src/config/sellerProfile.js`. It holds public fields only: legal and trade name, address, GSTIN (must start with 09), PAN, phone, email, declaration and signatory label.
- Creation returns 400 "Seller details are not configured" until the legal name, address, PIN and a valid 09 GSTIN are set.
- Bank details come only from environment variables (`SELLER_BANK_ACCOUNT_NAME`, `SELLER_BANK_ACCOUNT_NUMBER`, `SELLER_BANK_IFSC`, `SELLER_BANK_NAME`, optional `SELLER_BANK_BRANCH`; names listed in `.env.example`). If any required one is missing, the bank block is omitted.
- The seller details, bank included, are snapshotted onto each invoice at creation.

**Endpoints** (`/api/invoices`, admin only):

| Method | Path | Notes |
|---|---|---|
| GET | `/seller-status` | `{ configured }` |
| GET | `/priceable-products` | Active prices with `hsnCode` and `gstRatePercent` (the estimate endpoint's shape is unchanged) |
| GET | `/` | Paginated (20, max 100). Filters: `customer`, `status`, `from`, `to`, `search` (number). Rows include `taxType`, `paidPaise` and `outstandingPaise` |
| GET | `/:id` | `{ invoice, payments, summary }` |
| POST | `/` | `{ customer, invoiceDate, lines:[{item, quantity, batchReference?}], notes }` → 201 |
| PUT | `/:id` | `{ lines:[{item, quantity, reprice?, batchReference?}], notes }`; 409 when a valid payment exists |
| POST | `/:id/reverse` | `{ reason }` |
| POST | `/:id/payments` | `{ amount, paymentDate, method, reference, notes }` → 201 |
| POST | `/:id/payments/:paymentId/void` | `{ reason }` |

`GET /api/customers/:id/invoice-account` returns `{ activeCount, reversedCount, totalInvoicedPaise, totalPaidPaise, outstandingPaise, paymentCount }`. Customer DELETE also returns 409 when the customer has invoices.

**Shared code with Estimates:**
- `utils/salesDocuments.js`: numbering, financial year, line, payment and reason validation, paise math, stock difference.
- `utils/salesTransactions.js`: transaction runner, error mapping, conditional stock deduct/return, movement builder.
- `utils/priceableProducts.js`.
- The `DocumentPayments` frontend component.

The estimate routes and helpers were refactored onto these modules with no behaviour change; their existing tests pass unchanged. Transactions and concurrency follow the 11B rules (a revision lock per invoice, conditional stock updates, a counter upsert).

**Frontend:**
- Invoices list, form and detail pages.
- The form shows a live tax preview, labelled as a preview.
- The detail page shows the per-rate tax summary.
- The print uses `#invoice-print-root` with `body.inv-printing`. It contains: TAX INVOICE, seller, Bill To / Ship To with GSTIN or "Unregistered", lines with HSN and rate, the per-rate summary with HSN codes, totals with round-off, amount in words, the bank block when configured, the declaration and the signatory. A reversed invoice prints a REVERSED banner.
- The customer detail page has an Invoice Account section.

### Built in Step 11D: Estimate to Invoice conversion

**Final rules (approved):**
- **No second stock deduction.** The estimate already deducted the stock; conversion only moves ownership of those units to the invoice. The conversion transaction contains **no StockItem update and no StockMovement**. The audit link is the two-way reference (estimate `convertedInvoice` / `convertedInvoiceNumber`, invoice `sourceEstimate` / `sourceEstimateNumber`), plus the transferred payments.
- The invoice follows every 11C rule: its own `INV/<FY>/NNNN` number (financial year of the invoice date), seller profile must be configured, tax type from the customer's state, GST once per rate group, grand-total round-off, HSN and GST rate required on every line.
- **Prices and lines:** the estimate's saved price, quantity, product name and unit are copied exactly. Estimate prices are treated as GST-exclusive taxable prices, so **GST is added on top**: the invoice total is higher than the estimate total. The HSN code and GST rate are the item's **current** values (estimates never stored them); a missing one blocks the conversion with a message naming the item.
- **Customer details** come from the current customer record (it must be active and have a valid state).
- **What the admin can change:** only the invoice date (default today; not in the future; not before the estimate date), per-line batch references and invoice notes. Quantities and prices cannot be sent. Later changes go through the normal invoice edit (allowed only while the invoice has no valid payment) or, before converting, through an estimate edit.
- **Payments are carried over, not voided.**
  - Each valid estimate payment is copied into `InvoicePayment` with the same amount, date, method, reference and notes, marked `carriedFromEstimatePayment` and `carriedFromEstimateNumber`.
  - The estimate payment is kept and marked `transferred` (`transferredAt`, `transferredToInvoice`, `transferredInvoiceNumber`, `transferredInvoicePayment`). It is never voided, so the history shows money that was really received.
  - If the amount already paid is more than the invoice total (possible at 0% GST when the total rounds down), conversion is blocked with 409.
  - Carried payments are valid invoice payments, so they lock the new invoice against editing; reversing it requires voiding them.
- **Ledgers stay separate and nothing is counted twice.**
  - A converted estimate has left the estimate ledger: its summary shows paid 0, outstanding 0 and `transferredPaise`.
  - The customer estimate account counts active estimates only and excludes transferred payments (`convertedCount` is added).
  - The money appears once, in the customer invoice account.
- **A converted estimate is read-only** (status `converted`): edit, cancel, payment and void all return 409 because they require an active estimate. Its list row shows a Converted badge with outstanding "-", the detail page links to the invoice, and the print shows "CONVERTED TO INVOICE INV/…".
- **Reversing the converted invoice** uses the normal invoice reversal: stock is returned once with `invoice_return`. The estimate **stays `converted`** (it never reopens), and it cannot be cancelled to return the stock again. To bill again, create a new estimate or invoice.

**Model additions** (all optional or defaulted, so no migration is needed):
- `Estimate`: `convertedInvoiceNumber`, `convertedBy` (`convertedInvoice` and `convertedAt` already existed).
- `EstimatePayment`: `transferred`, `transferredAt`, `transferredToInvoice`, `transferredInvoiceNumber`, `transferredInvoicePayment`.
- `InvoicePayment`: `carriedFromEstimatePayment`, `carriedFromEstimateNumber`, with a unique partial index on `carriedFromEstimatePayment` so a payment can be carried over only once.

**Endpoints** (`routes/estimateConversion.js`, mounted at `/api/estimates`, admin only):

| Method | Path | Notes |
|---|---|---|
| GET | `/:id/conversion-preview` | Read-only, no session. `{ eligible, problems[], taxType, customer, lines[], tax, carriedPaymentsPaise, carriedPaymentCount, estimateTotalPaise, sellerConfigured, estimateNumber, estimateDate }`, using the real invoice math |
| POST | `/:id/convert` | `{ invoiceDate?, notes?, lines?: [{item, batchReference}] }` → 201 with the invoice detail shape |

Existing responses only gained fields: estimate `summary.transferredPaise` and `transferredCount`, invoice list rows `sourceEstimateNumber`, customer estimate account `convertedCount`.

**Convert transaction** (validation, seller check and request parsing run before the session opens):
1. Claim the estimate: bump `revision` on an **active** estimate. If it is not active: 404, or 409 (already converted / cancelled).
2. The invoice date must not be before the estimate date; batch references must belong to the estimate's products.
3. Read the customer and each item, build the lines from the snapshots, compute the tax and total the carried payments. Any problem returns 400 naming the item or customer; paid above the total returns 409.
4. Take the next `INV` number for the invoice date's financial year.
5. Create the invoice with the customer and seller snapshots, `sourceEstimate` and `sourceEstimateNumber`.
6. Create the carried invoice payments, then mark the estimate payments `transferred` in one bulk write (a count mismatch returns 409).
7. Set the estimate to `converted` and return the invoice detail.

**Concurrency:** two conversions of the same estimate, or a conversion racing an estimate edit, cancel, payment or void, all contend on the estimate's `revision`. The loser is retried by the driver, sees the new status and returns 409. Two unique partial indexes (`Invoice.sourceEstimate`, `InvoicePayment.carriedFromEstimatePayment`) are the final guard. There are no stock writes, so there is no stock race.

**Frontend:** the active estimate detail page has a **Convert to Invoice** action that opens a confirmation panel:
- It states that GST is added on top of the saved estimate prices and shows the resulting total, the tax type, the lines with HSN and rate, and the per-rate tax breakdown.
- It lists any problems (which disable confirmation) and the payments that will move.
- It lets the admin change the invoice date, batch references and notes.

A converted estimate shows a banner linking to the invoice, "Moved to Invoice" in the summary, and payments marked "Transferred to INV/…". The invoice shows "from EST/…" in its list, header and details, and carried payments show "Carried from EST/…". The estimate list has a Converted status filter.

### Built in Step 11E: Delivery Challans

**Final rules (approved):**
- A challan is a manual **delivery record** against exactly one invoice. It never stands alone and is not created from an estimate; a converted estimate is dispatched through its invoice.
- **No GST, no GSTIN, no prices, no tax amounts** anywhere: not in the model, the API, the screens or the print. The print shows the seller's public details only (no GSTIN, PAN or bank).
- **No stock effect.** A challan never creates a StockMovement and never changes a StockItem; the invoice already deducted the stock. **No payment or ledger effect:** it never touches an invoice or estimate payment or balance. Challans do not depend on stock availability.
- Number `CH/2026-27/0001`: its own counter per financial year (April to March, from the challan date), generated inside the creating transaction. It is never shared with invoices or estimates, and a cancelled challan's number is not reused.
- **Partial dispatch with a hard cap.** One invoice may have many challans. For every invoice line, the quantity on all **active** challans can never exceed the invoice line quantity. A cancelled challan returns its quantities to the remaining pool.
- The challan date is date-only (default today in IST, not in the future, not before the invoice date).
- **Invoice status:** challans can be created only for **active** invoices.
- **Invoice reverse and edit are blocked (409) while the invoice has active challans.** The goods have physically left, so their stock must not be returned silently, and an edit must not cut a line below what has been dispatched. Cancel the challans first; after that the invoice reverses normally and returns its stock once.
- **Cancel** needs a reason and keeps the record. **Edit** is limited to the transport fields and notes; quantities change by cancelling and creating a new challan, so the cap logic lives in one place.
- Optional fields (printed only when filled): transporter name, vehicle number, LR (lorry receipt) number, LR date, notes.

**Models** (additive; no migration needed):
- `Challan`:
  - Number and invoice reference: `challanNumber`, `financialYear`, `sequence`, `invoice`, `invoiceNumber`, `invoiceDate`.
  - Snapshots: `customer`, `customerSnapshot { name, billingName, contactNumber, shipTo{...} }`, and `seller` (public details only).
  - Date, lines and transport: `challanDate`, `lines[] { invoiceLine, item, productName, unit, quantity }`, `transport { transporterName, vehicleNumber, lrNumber, lrDate }`.
  - Status and audit: `notes`, `status active|cancelled`, `cancelledAt`, `cancelledBy`, `cancelReason`, `revision`, `createdBy`, `updatedBy`, timestamps.
  - Indexes: unique `challanNumber`; `{invoice, challanDate, _id}`; `{customer, challanDate, _id}`; `{status, challanDate, _id}`; `{challanDate, _id}`.
- `ChallanCounter`: `{financialYear unique, sequence}`.
- `Invoice` (defaults, so existing invoices read as "nothing dispatched"): `lines[].dispatchedQuantity`, `activeChallanCount`, `dispatchStatus none|partial|full`.

**Dispatch counters instead of queries.** The invoice carries the dispatched quantity per line, the number of active challans and the overall status. They are updated **in the same transaction** as every challan create or cancel, under the invoice lock. So invoice detail and list show ordered, dispatched and remaining with no extra queries, and the reverse and edit guards need no challan lookup. The challans stay the audit record; a pure helper recomputes the quantities from them and a test checks both agree.

**Endpoints** (`/api/challans`, admin only):

| Method | Path | Notes |
|---|---|---|
| GET | `/invoice-dispatch/:invoiceId` | Invoice header, `dispatchStatus`, `canCreate`, per-line `orderedQuantity / dispatchedQuantity / remainingQuantity`, and the invoice's challans. One invoice read plus one challan query |
| POST | `/` | `{ invoice, challanDate?, lines:[{invoiceLine, quantity}], transport?, notes? }` → 201 |
| GET | `/` | Paginated (20, max 100). Filters: `customer`, `invoice`, `status`, `from`, `to`, `search` (number) |
| GET | `/:id` | `{ challan }` |
| PUT | `/:id` | `{ transport?, notes? }` only; any other field is rejected with 400 |
| POST | `/:id/cancel` | `{ reason }`; 409 if already cancelled |

Existing invoice responses only gained fields (the stored dispatch counters, and `dispatchStatus` on list rows).

**Create transaction** (payload validated before the session opens):
1. Lock the invoice: bump `revision` on an **active** invoice (404, or 409 if not active).
2. The challan date must not be before the invoice date.
3. `planDispatch`: every line belongs to the invoice, each at most once, and `quantity <= ordered - dispatched`; otherwise 400, or 409 naming the product and the remaining quantity.
4. Take the next `CH` number, then create the challan with its snapshots.
5. Update the invoice, conditional on the locked revision: add the quantities to each line's `dispatchedQuantity`, add 1 to `activeChallanCount`, and set `dispatchStatus`.

**Cancel transaction:** lock the invoice, flip the challan from `active` to `cancelled` (409 if it already was), then subtract its quantities and 1 from the invoice counters and recompute `dispatchStatus`.

**Concurrency:** every challan create, challan cancel, invoice edit and invoice reverse bumps the same invoice `revision` first, so they run one after another.
- Two challans racing for the last quantity: the loser is retried, re-reads the counters, fails the cap check and gets 409 with nothing written.
- A challan racing an invoice reverse or edit: the second one sees the other's result (active challans block the reversal; a reversed invoice blocks the challan).
- Two cancels of one challan: only one flips the status, so a quantity is never freed twice.

**Frontend:**
- **Navigation:** Challans sits after Invoices in the sidebar and in the mobile More sheet.
- **Pages:** `pages/Challans/` holds the list (whole-row click, filters, `?invoice=`), the create form (`/admin/challans/new?invoice=<id>`, prefilled with the remaining quantities, editable down), the detail page (edit transport, cancel with a reason, print) and the print.
- **Invoice detail:** it shows a dispatch badge and a Dispatch section (ordered, dispatched and remaining per line, the challan list, **Create Challan**). It hints that Edit and Reverse are unavailable while challans are active.
- **Invoice list:** it has a Dispatch column.
- **Print:** it uses the same portal pattern as the invoice print (`body.ch-printing`), from the saved snapshot only: seller, challan number and date, invoice reference, deliver-to, optional transport, product / unit / quantity with the total, the receipt line and the signature blocks.

### Built in Step 11F: Monthly GST Report

**Final rules (approved):**
- Built from **GST invoices only**. Estimates and challans never appear; the report route imports the Invoice model and nothing else.
- Source is the **saved invoice snapshot** only: customer name, GSTIN and state, line HSN, rate, unit, quantity and taxable value, the per-rate `taxSummary`, and the invoice totals. Nothing is recomputed from current product or customer data.
- Period by **invoice date** in the Asia/Kolkata calendar:
  - a month (`month=YYYY-MM`, the default is the current month)
  - a financial year (`fy=2026-27`, 1 Apr to 31 Mar)
  - a custom range (`from`/`to`, inclusive, **at most 366 days**)
  - Periods cannot start, or a range end, in the future. Invoice dates are stored as UTC midnight of the business date, so the period is a plain UTC range with an exclusive end.
- **Reversed invoices are excluded from every total**: totals, rate table, B2B/B2C, HSN and the register CSV. They are listed separately with their reversal date.
  - Each one carries a **"reversed after period"** flag when it was reversed after the period ended.
  - Caution: the report reads each invoice's current status, so re-running an already-filed month after such a reversal gives lower numbers than were filed. Under GST that correction is normally a credit note in the later month, and credit notes are not built.
- **Reconciliation:** inside the summary aggregation every invoice is checked for taxable + CGST + SGST + IGST + round-off = total. The response reports `mismatchedInvoices` and whether the totals reconcile, and the UI shows a badge or a warning.
- **HSN tax is apportioned.** Tax per HSN is not stored, because GST is computed once per rate group. Within each rate, that rate's exact CGST/SGST/IGST is split across its HSN rows by taxable value (largest remainder, BigInt), so HSN taxes sum exactly to the rate totals. The table and CSV are labelled "apportioned". HSN, unit, quantity and taxable value are exact.
- A line without an HSN code should be impossible (the schema requires one). If found, it is grouped as "(missing)", never dropped, and the affected invoice numbers are listed in `warnings`.

**Endpoints** (`/api/reports/gst`, admin only; every one takes the period query and returns `period {mode, from, to, label}`; an invalid period is 400):

| Method | Path | Returns |
|---|---|---|
| GET | `/summary` | `totals` (count, taxable, CGST, SGST, IGST, tax, round-off, total), `byRate`, `bySupplyType` (B2B = GSTIN present / B2C, each intra and inter), `numberRange`, `reconciliation`, `reversed {count, items (first 200) with reversedAfterPeriod}`, `warnings` |
| GET | `/invoices?page&limit` | Paginated register (20, max 100), sorted by date then number |
| GET | `/hsn` | HSN rows (HSN, rate, unit, quantity, taxable, apportioned taxes), totals, `taxApportioned: true`, `warnings` |
| GET | `/export.csv?section=register\|rate\|hsn` | A CSV download |

**Pipelines and indexes:** every query matches `{ status, invoiceDate }`, which is served by the existing `{status, invoiceDate, _id}` index; no new index is needed.
- **Summary:** one aggregation with `$facet`:
  - totals and the reconciliation count in one `$group`
  - by rate: `$unwind taxSummary` then `$group`
  - B2B/B2C: `$group` by GSTIN present and tax type
  - number range: sort by date and sequence, then first and last
  - The reversed list is one small capped `find` plus a count.
- **HSN:** one aggregation (`$unwind lines` then `$group` by HSN, rate and unit, plus the rate totals), then the apportionment in `utils/gstReport.js`.
- **Register:** `find` with skip/limit plus `countDocuments`.

**CSV (no package):**
- **Format:** UTF-8 with a BOM (so Excel shows ₹ and Indian names correctly), CRLF line endings, RFC 4180 quoting (comma, quote or line break means quoted, with inner quotes doubled).
- **Formula-injection protection:** text cells starting with `=`, `+`, `-`, `@`, tab or CR get a leading apostrophe. Amounts come only from the server's own formatter (integer paise to `125.50` / `-0.26` with string math) and stay numeric.
- **Contents:** each file starts with a title and period line and the column header, and ends with a TOTAL row.
  - The rate file also has the invoice-level round-off and grand total rows, so it reconciles on its own.
  - Files are named `gst-<section>-<2026-11 | FY2026-27 | from_to_to>.csv`.
- **Cap:** the register export is capped at **5,000 invoices**; a longer period returns 400 asking for a shorter one.
- **Register columns:** Invoice Date, Invoice No, Customer, GSTIN, Supply Type (B2B/B2C), State, Tax Type, Taxable Value, CGST, SGST, IGST, Round Off, Invoice Total.

**Not GSTR-1.** The files are a generic layout for the accountant to reshape. A GSTR-1 export would also need:
- invoice type (regular, SEZ, export, deemed export)
- a reverse-charge flag
- an e-commerce operator GSTIN
- the B2C-large classification rule
- credit and debit notes (not built)
- units mapped to GST UQC codes
- HSN descriptions
- a "documents issued" summary (the report already gives the number range and the reversed count)

**Frontend:** `/admin/reports/gst` ("GST Report" after Challans in the sidebar and the mobile More sheet):
- `Back`, then a FY select, a month select (or Whole year) and a Custom range option.
- Summary cards: Taxable, CGST, SGST, IGST, Round Off, Total. Then the invoice count, number range, reconciliation badge and reversed count.
- The rate-wise, B2B/B2C and HSN tables, and the paginated register (rows open the invoice).
- **Download CSV** for the rate, HSN and register sections. It uses an authenticated Blob download.
- The reversed list carries the "reversed after period" badge.
- Each section has its own loading, error with Retry, and empty state.
- On mobile, tables become flat rows and the cards sit two to a row.

### Planned (later steps)

**Document rules (approved):**

| Document | Stock effect | Tax fields | Ledger |
|---|---|---|---|
| Estimate (Built, 11B) | Deducts stock on creation; edit adjusts by difference; cancel returns it | No HSN or GST | Separate Estimate ledger, payments and balance |
| Invoice (Built, 11C) | Deducts stock on creation; edit (before payment) adjusts by difference; reversal returns it | HSN, GST rate, customer GSTIN, CGST/SGST or IGST | Customer Invoice ledger, payments and balance |
| Estimate converted to Invoice (Built, 11D) | No second deduction | Invoice tax fields apply | Payments carried over; the estimate and invoice links are auditable |
| Challan (Built, 11E) | None; the invoice already deducted the stock | No GST, GSTIN or prices | No sales or payment balance effect |

The monthly GST report (Built, 11F) is built from GST invoices only. A legacy `POST /api/customers/:id/order` stub exists (no frontend caller, no Order model).

## 16. Planned: Labels

Today a Label exists only as a Manufacturing input rule (section 11). The `/admin/labels` page and label printing are Planned. Confirm before building: label and sheet size, labels per sheet, company name, manufacturer address, product name, size or type, pack quantity, batch number, manufacturing date, MRP, barcode or QR, regulatory text and the print/PDF format.

## 17. Planned: portals, orders, notifications and analytics

Approved direction; no code exists. The `User.role` enum lists `employee` and `customer`, but every API is admin-only and no portal UI exists.

**Identity and access**
- No public registration, Sign Up or role selector. Admin creates the business master, enables portal access and issues a Login ID with a temporary password; the user changes it on first login. Forgot Password is allowed later. Passwords stay hashed; Admin can reset but never read one.
- Business masters and Portal Users are separate; a Portal User links to one Customer or Supplier. Future roles: `admin`, `customer`, `supplier`, `factory_manager`. Every portal endpoint needs backend authorization plus ownership checks; hiding in the UI is never a permission control.
- Planned: enable/disable, forced session invalidation where practical, reset workflow, last login, activity logs and an audited read-only Admin "View As Customer" that never uses or reveals the password.

**Customer portal and orders**
- Customers see only Admin-assigned Finished Goods (their active `CustomerProductPrice` rows), never factory stock, quantities or availability. There is no product default price: the customer price applies, optionally replaced by a document-specific Admin override. Price changes affect future activity only; Orders, Estimates and Invoices keep immutable price snapshots.
- Order and Invoice are separate entities with separate counters. Orders may come from portal, phone, WhatsApp, in person, salesperson or Admin. Statuses: Received, Confirmed, Preparing, Ready to Ship, Invoiced, Dispatched, Completed, Cancelled. Lines keep requested and confirmed quantity; notes keep Customer, Admin and Factory visibility separately. No stock is deducted until Invoice finalization. A confirmed order may produce a non-financial Factory Order Slip. After invoicing, cancellation must follow Invoice reversal rules.
- On Invoice finalization, one transaction validates Finished Goods, finalizes the invoice, deducts stock with movements, updates the Customer Invoice account, links any Order and optionally creates a notification. Customer account data is view-only; only Admin records payments.

**Supplier portal and purchase orders**
- Supplier Detail will gain Materials Supplied, Purchase Orders, Receipts, Payments, Account and Portal Access. A bulk PO builder creates separate supplier-specific POs; suppliers see only their own. PO receiving supports partial delivery; direct Material Receiving stays valid. Supplier bill uploads never change stock, create a receipt or create a payable until Admin verifies. Suppliers cannot record payments or mark material received.

**Notifications**
- A separate in-app notification system (unread count, read state, related-record links, recent activity). WhatsApp is optional, controlled by Admin per account and per action, and uses only an approved provider. A WhatsApp failure never rolls back a transaction; it is logged or queued and retried later.
- Public Estimate Request: visitors do not register; they submit name, company, phone, email, products, quantity and a message, then verify the phone by OTP. Admin reviews and prices it; public input never creates a final Estimate by itself.

**Dashboard analytics**
- New, Pending and Ready-to-Ship orders, Customer and Supplier Outstanding, invoices this month, low stock, recent activity, and a six-month Sales Overview with server-side month, financial-year and custom ranges. All use backend aggregation endpoints, never browser-side scans of every Invoice.

## 18. UI/UX standards

These apply to every change. They do not authorize redesigning a working workflow by themselves.

**Approval first.** Before implementing a meaningful workflow, page or business-rule change, inspect current behavior, discuss it with the user and agree the business rules, fields and their order, layout, actions, validation and desktop/tablet/mobile behavior. Do not guess. This applies especially to Attendance, Payout, Stock, Factory Flow and accounting. Update both plans with the approved decisions, then implement.

**Responsive standard.** Review every new or changed page at desktop, tablet and mobile widths. Required outcomes: no page-level horizontal overflow; no clipped important control; no overlapping text or actions; long names wrap safely; fixed desktop sizes do not leak into mobile; fixed bottom navigation never covers final content or actions; navigation controls stay visible with enough contrast. Tables need a deliberate strategy: a compact mobile representation where a desktop table cannot fit, or contained local scrolling only where appropriate (never page-level). Important information must not disappear on mobile.

**Design direction.** Professional navy and white NCH look: clean cards, lightweight tables, status badges, consistent spacing and type, compact sidebar, mobile bottom navigation.

**Controls and layout**
- Every internal, detail or workflow page has a left-aligned control whose text is exactly `Back` ("Back to Supplier" is not allowed). New routed pages open at the top.
- Pages are compact and operational with a consistent title hierarchy; a primary action may sit at the right of the heading.
- Controls in one row share a baseline and height (about 46–50px on desktop). Small numeric, date and rate inputs do not stretch across the row. Read-only calculated values align with editable controls. Avoid oversized textareas.
- Use human-readable labels, never storage enums (`bank_transfer` as Bank Transfer, `washed_raw_material` as Washed Raw Material, `in_process` as In Process).
- Business dates show as date only (`14 Oct 2026`); audit timestamps may include time.

**Tables and histories.** When a row has one obvious action, the row itself is the action (pointer, hover, keyboard focus), with no redundant View button or "click row" text. Use explicit buttons only when a row has several independent actions. Main operational pages stay compact (Manufacturing shows five records; full history has filters and pagination).

**States.** Every API-backed screen has loading (skeletons for tables and cards), error with retry, and an intentional empty state. No raw `undefined`, `null`, `NaN` or server objects. Mutations disable duplicate submit and show progress. Every route change shows a loading indicator.

**Reuse.** Inspect for an existing component, hook, helper, validator, API wrapper, style or pattern before creating one. One canonical routed component per workflow; no `PageFixed`, `PageFinal`, `Page2` or `ComponentNew`. Use targeted readable patches and format only the changed files.

**Immutability.** Stock and financial records change through transactions, snapshots, status or reversal, not destructive deletion (payout hard delete is the approved exception, section 13).

## 19. Performance and pagination standards

**Standard (target).** Growing list APIs use validated pagination, stable sorting and bounded filters. Indexes follow real query patterns. Use `lean()`, narrow `select`, selective populate, parallel independent reads, short transactions, debounced and cancelled search, no N+1 and no duplicate requests. Dashboard and portal summaries use backend aggregation. The aim is useful content within about 1–2 seconds under normal production conditions. This is a target, not a guarantee. Correct stock and accounting behavior always beats speed.

**Current state.** The standard is met for suppliers, material receipts, supplier ledger, washers, washing processes, manufacturing history and payout history. `GET /api/employees`, `/customers`, `/attendance`, `/attendance/range`, `/attendance/employee/:id`, `/payout`, `/payout/:employeeId`, `/stock`, `/stock/low-stock` and `/stock/:id/history` keep their legacy array response but are capped (1000 to 10000 rows; 500 stock types) and set the `X-Result-Capped: true` header when truncated; sending `?page` or `?limit` returns `{items, page, limit, total, totalPages}` instead (`/stock/:id/history` adds an additive `pagination` field and keeps `history` an array; `/stock/low-stock` adds `capped`). `/attendance/range` requires strict `YYYY-MM-DD` dates, start not after end, and at most 366 days. `/stock/summary` is one aggregation and `/stock/types` counts products only for the returned types. `POST /payout/preview` and `/payout/bulk-preview` load only the period's attendance, sum advances in the database and read only overlapping payouts; results equal the old full-history calculation. Indexes added: `Attendance {date}`, `Employee {isActive,name}`, `Payout {paidOn,_id}`, `StockItem {stockType,productName}`. Still open: payout create, edit and delete load full history inside their transactions, `/payout/register` and `/stock/history` (500 rows) are unchanged, and none of this has been timed or explained against live MongoDB.

**Startup and logging.** Startup connects to MongoDB first. Payload-free timing logs cover MongoDB connect, startup, login and dashboard. Logs never contain bodies, credentials, tokens or connection data.

## 20. Engineering rules learned

1. **Never run parallel operations on one transaction session.** A MongoDB session cannot run two operations at once. Reads that use a session run one after another; parallel reads are fine only without a session.
2. **Validate before opening a transaction.** Do all input and business-rule checks first, then open the transaction and re-check the facts that can change (stock, overlap, locks) on fresh data inside it.
3. **Abort only when `inTransaction`.** Call `abortTransaction` only if the session is still in a transaction; otherwise it throws and hides the real error.
4. **Generic 500 messages.** Return `utils/httpErrors.js` messages to the client and log details server-side only, so internals never leak.
5. **Date-only comparisons must not depend on the server time zone.** Compare `YYYY-MM-DD` day keys (attendance and payouts use shared helpers; business "today" uses `Asia/Kolkata`) instead of local-time `Date` arithmetic. Local-time helpers are correct only when the server runs in UTC.
6. **Rsbuild exposes only `PUBLIC_` environment variables** to the browser. Anything else is invisible there, and `import.meta.env.VITE_*` does not apply.
7. **`.env` is never tracked.** Commit only `.env.example`. A value that was ever committed counts as exposed and must be rotated.
8. **`withTransaction` callbacks must be retry-safe.** The driver may run the callback again after a write conflict, so build every per-attempt value (snapshots, movement lists, totals) inside the callback. Never mutate outer state that a retry would double up.
9. **Serialize per-document money changes with a revision bump.** When several routes change one account (estimate payments, edits, cancel, void), each transaction first bumps the same document (`Estimate.revision`, `SupplierAccountLock`). MongoDB then serializes them, and the retry sees committed data before re-checking caps.
10. **Movement balances come from the update result.** Use the document returned by the conditional `findOneAndUpdate` for `balanceAfter`, and derive `balanceBefore` from it, never from a read taken earlier in the request.
11. **Print roots need scoped, more specific selectors.** All page CSS ships in one bundle, so a page's `@media print` rules apply everywhere. `PayoutPage.css` hides every `<body>` child except `#payout-print-root` when printing. New print views use a body class while printing (`body.est-printing`, `body.inv-printing`) and selectors such as `html body.est-printing > #estimate-print-root`.
12. **Tax math lives in one place.** Invoice GST is computed only in `src/utils/gstInvoice.js` and stored on the invoice. The frontend `utils/invoiceTax.js` mirrors it for a labelled preview only, and the saved invoice is always authoritative.
13. **Seller secrets stay out of source.** Public seller details live in `src/config/sellerProfile.js`. Bank details come from environment variables; only their names are listed in `.env.example`.
14. **Conversion moves ownership of already-deducted stock and never touches stock.** A conversion transaction contains no StockItem update and no StockMovement, so stock can be neither deducted twice nor returned twice. Money moves by carry-over (copy plus a `transferred` mark), never by voiding real payments.
15. **Claim a document with its revision before changing its status.** Conversion, like edit, cancel, payment and void, first bumps `revision` on an active document; once it is no longer active, every later attempt is a 409. Back this with a unique partial index on the link field.
16. **Keep dispatch counters on the parent document, under its revision lock.** A cap that spans several child records (challans per invoice line) is enforced by updating counters on the parent in the same transaction as the child write, after bumping the parent's revision. Reads and guards then need no extra query, and concurrent children serialize.
17. **Reports read saved snapshots and aggregate on the server.** A report never recomputes from current master data and never sends every document to the browser: it filters by an indexed date range in MongoDB, paginates detail rows, caps exports, and checks its own totals reconcile. CSV cells that could start a formula are neutralised.
