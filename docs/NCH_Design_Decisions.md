NCH Design Decisions (approved)

Status as of 28 Nov 2026. Design only, nothing here is built yet unless stated. Rule: design topics are discussed until the owner says "prompt".

1. Final invoice layout (APPROVED, v5)

A4 portrait, white page, 6 mm margin, ONE copy per PDF (no Customer/Office copy labels). Accent colour maroon #7a1f2b, tint #f6e8ea (selectable in Settings: maroon default, navy, teal, green, charcoal).

Header: logo box (left), NCH / NEW CALCUTTA HANDLOOM / address line, "TAX INVOICE" centred, right: Mobile 1, Mobile 2, email, website. Top rule 3px accent.
GSTIN bar: left "GSTIN: ..."; right "Mfg. Licence No.: ...".
Two boxes, 50/50, colon-aligned:

Customer Detail: Buyer, Address, GSTIN, Place of supply (state + code). NO phone, NO PAN.
Invoice Detail: Invoice No., Invoice Date, E-Way No., Transport, Transport ID, Vehicle No. (optional).
Item table: Sr | Item | HSN | Batch No. | Qty (with unit pcs/doz, as saved in stock) | Rate (plain, e.g. 210.00) | Amount. Batch No. is required, defaulted from Manufacturing, admin can overwrite. Empty stretch area, then Total row. About 15 items fit on one page. No per-line GST columns.
Bottom left: "Total in words" (bold), Bank Details (Name, Branch, Acc. No., IFSC, UPI ID + UPI QR box), "Customer signature, stamp and date" (at top of its box).
Bottom right (each with colon): Taxable Amount, Add: CGST x%, Add: SGST x%, Total Tax, Round off, Total Amount (rupee symbol). Then signature box: "For NEW CALCUTTA HANDLOOM" at top, "Authorised Signatory" at bottom.
Very bottom line: "This is a computer generated invoice. E & O.E." (E & O.E. is permanent, no setting). Removed: certified line, tax breakup section at left, phone, PAN, challan date, copy labels, terms. GST: tax once per rate group on taxable total; CGST+SGST if buyer state code is 09, else IGST; grand total rounded to the rupee with a separate Round off line. IGST shows as one IGST line. Invoice keeps the bank details it was created with. 48-hour edit window after Generate, with edit history. Flow: order approved -> DRAFT invoice (no number, no stock, not in GST report, fully editable) -> Preview -> Generate (number assigned, stock taken). Pending: logo (owner doing later), licence number(s) value, seller profile and bank details entered in Settings, HSN + GST rate on every Finished Goods product, accountant sign-off (one-total GST method, round-off, HSN apportioning).
2. Brand and theme

Public website and all apps: navy blue #0b1f3a (tint #e6ebf3). Invoice stays maroon. Logo not final (concepts G/H/I square surgical marks drawn; owner will decide later). Do not use red (Red Cross emblem).

3. Public website (navy)

Pages: Home, Quality (own page), Enquiry. No separate Products page. Not a Calcutta-based company in copy ("New Calcutta Handloom" is only the company name); factory state Uttar Pradesh. "Across India" supply. India only. Home: top strip (phone/email), header (logo, Home, Quality, Enquiry, Login, Ask for rates), hero + image, trust strip (own factory, licensed, GST invoices, across India), Our products (4 cards, images, rates only on enquiry), How it works (3 steps), CTA band to Enquiry, footer (address, GSTIN, licence, links, Customer/Supplier login). NO link to admin login anywhere. Quality page: made in own factory, 4-step process, licences (Mfg licence, GSTIN, batch traceability). Enquiry page: Talk to us (reply within 2 working days, business hours Mon-Sat 10-4), address/phone/email, form: name, business/shop, mobile, city+state, product, message (optional), consent tick. No quantity on enquiry form. OTP later. Anti-spam: see 9.7. Website Products (admin): add, edit, delete (confirm), Shown/Hidden. Fields: name, group, photo, short description, status. Sample images used until real photos.

4. Login pages
Customer and supplier: one Login page (mobile or email + password). Logins are created by admin. No sign-up. "Ask for rates" link for new people. Forgot password: reset link later; admin reset meanwhile.
First login: NO forced password change. Dismissible reminder banner ("Change it for better security") with Change password / Later. Admin gives random per-person passwords.
Admin login: separate, hidden, long non-obvious address, not linked publicly, noindex. Email + password + 6-digit authenticator code. Lockout, rate limiting stay.
5. Admin (navy; sidebar)

Sidebar: grouped, see 9.1. Badges on Enquiries and Orders, unread badge on Notifications. Dark mode option on dashboard. Compact density.

Enquiries: tabs New / Contacted / Rates sent / Customer made / Closed / All; list + detail panel; Call, WhatsApp, status, internal note, Create customer, Delete (confirm). Reply by = 2 working days.
Orders: summary tiles; tabs Pending approval / Approved / Dispatched / Received / Rejected; items WITH quantity. Actions: Approve, Approve with changes (edit approved quantity or remove items, message to customer; cannot exceed ordered qty; stock warning), Reject (reason required, shown to customer). Approval creates only a DRAFT invoice. Admin can mark Dispatched and Received; customer can also mark Received. Customer gets notification (status "Approved with modification" when changed). Customer can cancel only before approval. Shipments replace challans (challan to be removed after checking the collection is empty).
Notifications (admin list): new enquiry, new order, order received, low stock; unread filter; mark all read; opens the item. Payment notification: see 9.6.
Audit Log: read-only, kept forever, filters by type/date, includes failed logins.
Settings (admin only): Company (legal name, GSTIN, licence, state, address, mobiles, email, website, logo), Bank and UPI (editable bank details + upload/remove UPI QR), Invoice (colour, 48 h window as read-only text, bank-on-invoice toggle), Website and enquiry (see 9.5), Security (see 9.5).
6. Customer portal

Top menu (desktop): Home, My orders, New order, Billing, Account. Phone bottom bar: Home, My orders, centred raised + New order, Billing, Account (content never under the bar, 40 px+ targets).

Home: optional password banner, tiles (open orders, on the way, balance due), recent orders.
New order: products with the customer's own rates and quantity; estimate before GST; "Send for approval". Products with no rate show "Ask admin".
My orders: progress line (Sent, Approved, Dispatched, Received), ordered vs approved quantities, admin message, Mark as received, Cancel (before approval only), download invoice.
Billing: sub-tabs Invoices / Payments / Statement. Totals billed/paid/balance. Payments list (date, invoice, mode, amount), read-only. Statement: date range, opening balance, billed, paid, running balance, closing balance, PDF download. Invoice PDF in the same layout as the printed invoice; only generated invoices, never drafts.
Account: business details read-only (contact NCH to change), change password, log out.
Rules: customer sees only own prices/orders/invoices, enforced on the server for every request.
7. Supplier portal (LATER)

Proposed, view-only first: balance owed, supplies, payments, statement, account. Phone bar: Home, Supplies, Payments, Account. To be drawn later.

8. Not decided / later

WhatsApp notifications, OTP, forgot-password email/SMS, supplier portal actions, real logo, real product photos, Cloudflare/domain (using Vercel for now), credential rotation (Atlas password, Render MONGODB_URI and JWT_SECRET, admin password, Atlas network access, repo privacy) which must be done before go-live.

9. Additional decisions (approved after the sections above)

9.1 Admin sidebar. Nothing built is removed; the earlier sidebar list was a simplified sketch. Groups:
Overview: Dashboard, Notifications
Sales: Enquiries, Orders, Customers, Estimates, Invoices, Shipments, GST Report
Factory: Employees, Attendance, Payout, Washers, Factory Flow
Stock: Stock, Stock History
Website: Website Products
System: Suppliers, Audit Log, Settings
Dashboard summary: an Attendance card where a Stock card was planned. Stock alerts still come through Low stock notifications. The exact dashboard card list is to be finalised in step 13.

9.2 Draft flow. Every invoice (direct, from an order, or an estimate conversion) goes Draft -> Preview -> Generate. Estimate conversion must not deduct stock again. Stock rules for estimates stay as they are today.

9.3 Edit lock. A recorded payment locks edits, even inside 48 hours (today's rule). The 48 hours start at Generate. After 48 hours or after any payment the invoice is locked, and corrections use the existing reverse flow. The 48-hour length is fixed, not configurable; Settings shows it as read-only text. Every edit is saved in the edit history.

9.4 Batch default. The oldest manufacturing batch that still has stock. One invoice line uses one batch; if the quantity needs more than one batch, it is split into several lines. Admin can overwrite. If the stock model does not track stock per batch, that is an open question for step 15.

9.5 Settings tabs.
Security: change password, authenticator setup (step 19), active sessions and log out everywhere.
Website and enquiry: reply-within days (2), business hours (10 to 4), public phone and email, enquiry thank-you message.

9.6 Notifications. Payment: when admin records a payment, the customer sees a notification in the portal. The admin Notifications list shows only: new enquiry, new order, order received, low stock.

9.7 Security.
Login lockout (all login types: admin, customer, supplier): 5 failed attempts within 15 minutes, locked 15 minutes, per account and per IP, counted separately for each login type. Generic messages; never reveal whether an account exists. The lock expires on its own. A successful login clears the account count, not the IP count.
Rate limits per IP: login 10 per 15 minutes; public enquiry 5 per hour; general API 300 per 15 minutes.
Admin login address: a frontend setting, added in step 13. The backend has no admin path setting. The value is never written in the docs.
Anti-spam: honeypot and Cloudflare Turnstile are built in step 14 with the enquiry form, which uses the enquiry rate limit. Step 12 provides the rate limits and a placeholder enquiry route.

9.8 Shipments. Partial shipments are needed (same cap logic as challans today). A shipment can be created from any generated invoice; an order is optional. Other details are decided when step 16 is planned.

9.9 Step 12, security basics (status: built, backend only; not yet checked live).
Packages: helmet and express-rate-limit.
Lockout counts are stored in MongoDB and expire automatically, so they survive restarts. Rate limit counts are in memory: on the Render free tier a restart, deploy or spin-down resets them.
CORS allow-list: CORS_ALLOWED_ORIGINS, no wildcard. If it is empty, all browser origins are blocked. HSTS only in production.
Request limit: 100 KB for JSON only. File uploads (logo, UPI QR, step 15) need their own limit.
Audit log: append-only, kept forever. Step 12 records login success, failure and lockout only. One helper serves later events. By default a failed audit write is logged and the request continues. Money and security events use the fail-closed option and, when they run in a transaction, write inside it.
The Audit Log page is built in step 13.
Events to wire in later: password change and reset; creating or disabling a customer account; invoice generate, edit and reverse; payment record and void; order approve and reject; Settings changes (especially bank details); manual stock changes; enquiry delete.
Ownership: a shared helper limits a customer or supplier to their own records. No portal route uses it yet.
Live checks: see the Development Plan, section 8, step 12.
