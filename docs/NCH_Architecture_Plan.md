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
15. Customer pricing (Built) and sales documents (Planned)
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
| Estimates, Invoices, Challans, GST report | Planned |
| Labels page and label printing | Planned (Label exists only as a Manufacturing input rule) |
| Portals, Orders, Notifications | Planned |

Backend domains: authentication, employees, attendance, payroll and payout, customers, suppliers and supplier payments, material receipts, stock, washers and washing processes, washer accounting, manufacturing, dashboard.

## 4. Repository and frontend structure

```text
src/
├── App.jsx  index.jsx
├── components/   AdminLayout  AdminShell(.css)  Navbar(.css)  ProtectedRoute
├── config/       api.js  auth.js  axios.js
├── utils/        businessDate.js  gst.js  text.js  washerPayoutCycle.js
└── pages/
    ├── AdminCommon.css  AdminPortalPage  FactoryFlowPage  HomePage  Hero  Login  Products
    ├── Customer/    CustomersPage  CustomerDetailPage
    ├── Employees/   EmployeesPage  Attendance  PayoutPage  SalarySlip
    ├── Suppliers/   SuppliersPage  SupplierDetailPage  ReceiveMaterialPage
    └── Stock/       StockHomePage  StockPage  StockTypesPage  StockTypeProductsPage
                     ProcessGoodsPage  ManufacturingPage  ManufacturingHistoryPage
                     ManufacturingHistoryTable  WashersListPage  WashersPage
                     WasherDetailFixed  WasherDetailPage  WasherPayoutSlipPage
```

`pages/Products.jsx` is a public marketing section on the home page; it is not the admin Products item. `WasherDetailFixed.jsx` is the live route for washer master data and rates; the name is legacy. There is no `StockHistoryPage`, `LabelsPage` or `WashingPage`.

Backend: `index.js`; `src/routes/` (14 route files), `src/models/` (24 models), `src/middleware/` (auth, role, database readiness), `src/utils/` (helpers listed per feature below), `test/` (plain Node assert scripts, see Development Plan section 6).

## 5. Routes and navigation

### Built admin routes (all protected)

```text
/admin/dashboard
/admin/employees
/admin/attendance
/admin/payout
/admin/salary-slip                              (data only through router state)
/admin/customers
/admin/customers/:customerId                    details, Products and Prices
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
/admin/stock/history     complete stock movement history
/admin/labels            label generation and printing
/admin/estimates
/admin/invoices
/admin/challans
/admin/reports/gst
```

### Admin Shell navigation (Built)

All admin routes render through one responsive `AdminShell`. The public `Navbar` is used only on the public home page.

- **Desktop:** a fixed, collapsible dark-navy sidebar. Order: **Dashboard, Products, Attendance, Stock, Factory Flow, Payout, Washers, Suppliers, Customers, Employees.** Logout is a separate button at the bottom. There is no Stock dropdown. Products opens `/admin/stock/manage`.
- **Brand:** `NCH` with `NEW CALCUTTA HANDLOOM` beneath it. The Admin identity shows at the right. There is no notification bell and no profile menu.
- **Mobile:** a compact brand header plus a fixed bottom bar: **Home, Attendance, Stock, More.** The More sheet holds Products, Factory Flow, Payout, Washers, Suppliers, Customers, Employees and Logout.
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

## 15. Customer pricing (Built) and sales documents (Planned)

### Final design decisions (approved, Step 11A)

- NCH is registered in Uttar Pradesh, GST state code `09`.
- Tax type is decided from the customer's `stateCode` (Step 11C): state `09` gives CGST + SGST, any other state gives IGST, and a customer with no GSTIN is treated as local (CGST + SGST).
- GST is calculated **once on the invoice taxable total**, not per line, rounded to the nearest rupee with a separate round-off line (Step 11C).
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

### Planned (Steps 11B and later)

**Document rules (approved):**

| Document | Stock effect | Tax fields | Ledger |
|---|---|---|---|
| Estimate | Deducts or reserves stock on creation | No HSN or GST | Separate Estimate ledger, payments and balance |
| Invoice | Deducts stock | GST invoice has HSN, GST and customer GSTIN where applicable | Customer Invoice ledger, payments and balance |
| Estimate converted to Invoice | No second deduction | Invoice tax fields apply | Reference or transfer must be auditable |
| Challan | Manual; no stock effect | No GST or GSTIN | No sales or payment balance effect |

One invoice may have partial or multiple challans; challan quantities cannot exceed the document quantity. The monthly GST report is built from GST invoices only. A legacy `POST /api/customers/:id/order` stub exists (no frontend caller, no Order model).

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
