/*
 * Invoice create / edit / reverse / payment / void session safety, without
 * MongoDB. No two operations may run on one session at once; a failure aborts
 * the transaction once and ends the session once; blocked requests write no
 * invoice, movement or payment documents.
 */
const assert = require("node:assert/strict");
const path = require("path");
const {
  root,
  tracker,
  counts,
  resetCounters,
  runOp,
  fakeQuery,
  stub,
  call,
} = require("./helpers/sessionFakes");

const ID = (n) => `64c0000000000000000000${String(n).padStart(2, "0")}`;
const CUSTOMER = ID(1);
const ITEM_A = ID(2);
const ITEM_B = ID(3);
const ITEM_C = ID(4);
const INVOICE = ID(5);
const PAYMENT = ID(6);

const state = {};
const writes = { invoices: [], movements: [], payments: 0, invoiceUpdates: [] };

const baseInvoice = () => ({
  _id: INVOICE,
  invoiceNumber: "INV/2026-27/0012",
  customer: CUSTOMER,
  invoiceDate: new Date("2026-11-20T00:00:00.000Z"),
  status: "active",
  taxType: "intra",
  totalPaise: 52500,
  lines: [
    { item: ITEM_A, productName: "Crepe 10cm", unit: "pcs", hsnCode: "3005", gstRatePercent: 5, quantity: 10, pricePaise: 3000, taxablePaise: 30000 },
    { item: ITEM_B, productName: "Gauze Roll", unit: "dozen", hsnCode: "3005", gstRatePercent: 5, quantity: 4, pricePaise: 5000, taxablePaise: 20000 },
  ],
});

const reset = (overrides = {}) => {
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, {
    sellerConfigured: true,
    customer: {
      _id: CUSTOMER,
      name: "Shree Medicals",
      gst: "",
      stateCode: "09",
      isActive: true,
      billingAddress: { line1: "Aminabad", city: "Lucknow", pincode: "226018" },
      shippingSameAsBilling: true,
    },
    items: {
      [ITEM_A]: { _id: ITEM_A, productName: "Crepe 10cm", unit: "pcs", category: "finished_goods", hsnCode: "3005", gstRatePercent: 5, currentStock: 50 },
      [ITEM_B]: { _id: ITEM_B, productName: "Gauze Roll", unit: "dozen", category: "finished_goods", hsnCode: "3005", gstRatePercent: 18, currentStock: 20 },
      [ITEM_C]: { _id: ITEM_C, productName: "Bandage Pack", unit: "pcs", category: "finished_goods", hsnCode: "3006", gstRatePercent: 5, currentStock: 30 },
    },
    prices: { [ITEM_A]: 3000, [ITEM_B]: 5000, [ITEM_C]: 1000 },
    invoice: baseInvoice(),
    payments: [],
    movementThrows: false,
    ...overrides,
  });
  writes.invoices = [];
  writes.movements = [];
  writes.payments = 0;
  writes.invoiceUpdates = [];
  resetCounters();
};

stub("src/config/sellerProfile", {
  isSellerConfigured: () => state.sellerConfigured,
  getSellerSnapshot: () => ({
    legalName: "NEW CALCUTTA HANDLOOM",
    gstin: "09AAACH7409R1ZZ",
    stateCode: "09",
    bank: null,
  }),
});

stub("src/models/Customer", {
  findById: () => fakeQuery(() => state.customer),
});

stub("src/models/StockItem", {
  findById: (id) => fakeQuery(() => (state.items[String(id)] ? { ...state.items[String(id)] } : null)),
  findOneAndUpdate: (filter, update, options = {}) =>
    runOp(options.session, () => {
      const item = state.items[String(filter._id)];
      if (!item) return null;
      if (filter.category && filter.category !== item.category) return null;
      const required = filter.currentStock?.$gte;
      if (required !== undefined && item.currentStock < required) return null;
      item.currentStock += update.$inc.currentStock;
      return { ...item, stockType: null };
    }),
});

stub("src/models/CustomerProductPrice", {
  findOne: (filter) =>
    fakeQuery(() => {
      const price = state.prices[String(filter.item)];
      return price ? { pricePaise: price } : null;
    }),
});

stub("src/models/InvoiceCounter", {
  findOneAndUpdate: (filter, update, options = {}) => runOp(options.session, () => ({ sequence: 12 })),
});

stub("src/models/Invoice", {
  create: (docs, options = {}) =>
    runOp(options.session, () => {
      writes.invoices.push(docs[0]);
      const doc = { ...docs[0], _id: INVOICE };
      return [{ ...doc, toObject: () => doc }];
    }),
  findById: () => fakeQuery(() => (state.invoice ? { ...state.invoice } : null)),
  findOneAndUpdate: (filter, update, options = {}) =>
    runOp(options.session, () =>
      state.invoice && state.invoice.status === filter.status ? { ...state.invoice } : null
    ),
  updateOne: (filter, update, options = {}) =>
    runOp(options.session, () => {
      writes.invoiceUpdates.push(update.$set);
      Object.assign(state.invoice, update.$set);
      return { acknowledged: true };
    }),
});

stub("src/models/InvoicePayment", {
  find: (filter) =>
    fakeQuery(() => state.payments.filter((payment) => filter.voided !== false || !payment.voided)),
  findOne: (filter) => fakeQuery(() => state.payments.find((payment) => payment._id === String(filter._id)) || null),
  create: (docs, options = {}) =>
    runOp(options.session, () => {
      writes.payments += 1;
      const doc = { ...docs[0], _id: PAYMENT, voided: false };
      state.payments.push(doc);
      return [{ ...doc, toObject: () => doc }];
    }),
  findOneAndUpdate: (filter, update, options = {}) =>
    runOp(options.session, () => {
      const payment = state.payments.find((entry) => entry._id === String(filter._id) && !entry.voided);
      if (!payment) return null;
      Object.assign(payment, update.$set);
      return payment;
    }),
});

stub("src/models/StockMovement", {
  create: (docs, options = {}) =>
    runOp(options.session, () => {
      if (state.movementThrows) throw new Error("movement write failed");
      writes.movements.push(...docs);
      return docs;
    }),
});

const router = require(path.join(root, "src/routes/invoices"));

const createBody = () => ({
  customer: CUSTOMER,
  invoiceDate: "2026-11-20",
  lines: [
    { item: ITEM_B, quantity: 3, batchReference: "B-17" },
    { item: ITEM_A, quantity: 7 },
  ],
  notes: "Dispatch by road",
});

const assertCleanSession = (label, { committed }) => {
  assert.equal(counts.sessions, 1, `${label}: one session`);
  assert.equal(counts.end, 1, `${label}: session ended once`);
  assert.equal(counts.commit, committed ? 1 : 0, `${label}: commit count`);
  assert.equal(counts.abort, committed ? 0 : 1, `${label}: abort count`);
  assert.ok(tracker.maxActive <= 1, `${label}: never two operations on one session at once`);
};

const originalConsoleError = console.error;

(async () => {
  console.error = () => {};
  try {
    // 1. Create succeeds: snapshots, tax, number, movements.
    reset();
    let result = await call(router, "POST", "/", createBody());
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const created = writes.invoices[0];
    assert.equal(result.body.invoice.invoiceNumber, "INV/2026-27/0012");
    assert.equal(created.taxType, "intra");
    assert.equal(created.placeOfSupplyStateCode, "09");
    assert.equal(created.customerSnapshot.gstin, "");
    assert.equal(created.seller.gstin, "09AAACH7409R1ZZ");
    assert.deepEqual(created.lines.map((line) => line.item), [ITEM_B, ITEM_A], "request order kept");
    assert.equal(created.lines[0].hsnCode, "3005");
    assert.equal(created.lines[0].gstRatePercent, 18, "GST rate snapshot");
    assert.equal(created.lines[0].batchReference, "B-17");
    // 18%: 15000 taxable -> 1350 per half; 5%: 21000 -> 525 per half.
    assert.equal(created.taxablePaise, 36000);
    assert.equal(created.cgstPaise, 1875);
    assert.equal(created.sgstPaise, 1875);
    assert.equal(created.igstPaise, 0);
    assert.equal(created.roundOffPaise, 50);
    assert.equal(created.totalPaise, 39800);
    assert.equal(created.totalInWords, "Rupees Three Hundred Ninety Eight Only");
    assert.equal(writes.movements.length, 2);
    writes.movements.forEach((movement) => {
      assert.equal(movement.movementType, "invoice_out");
      assert.equal(movement.referenceType, "invoice");
      assert.equal(movement.balanceBefore - movement.quantity, movement.balanceAfter);
    });
    assertCleanSession("create", { committed: true });

    // 2. Another state uses IGST even without a GSTIN (no "no GSTIN = local" fallback).
    reset();
    state.customer = { ...state.customer, stateCode: "27", gst: "" };
    result = await call(router, "POST", "/", createBody());
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(writes.invoices[0].taxType, "inter");
    assert.equal(writes.invoices[0].igstPaise, 3750);
    assert.equal(writes.invoices[0].cgstPaise, 0);

    // 3. Customer without a state is blocked before any write.
    reset();
    state.customer = { ...state.customer, stateCode: "" };
    result = await call(router, "POST", "/", createBody());
    assert.equal(result.status, 400);
    assert.match(result.body.message, /no valid state/);
    assert.equal(writes.invoices.length, 0);
    assertCleanSession("no state", { committed: false });

    // 4. Insufficient stock blocks the whole invoice with no documents written.
    reset();
    state.items[ITEM_A].currentStock = 2;
    result = await call(router, "POST", "/", createBody());
    assert.equal(result.status, 409);
    assert.equal(result.body.message, "Insufficient stock for Crepe 10cm. Available 2 PCS, required 7 PCS.");
    assert.equal(writes.invoices.length, 0, "no invoice written");
    assert.equal(writes.movements.length, 0, "no movement written");
    assertCleanSession("create shortage", { committed: false });

    // 5. Missing HSN blocks before any stock is touched.
    reset();
    state.items[ITEM_A].hsnCode = "";
    result = await call(router, "POST", "/", createBody());
    assert.equal(result.status, 400);
    assert.equal(result.body.message, "Crepe 10cm has no HSN code. Set it in Stock Management before invoicing.");
    assert.equal(state.items[ITEM_B].currentStock, 20, "no stock deducted");
    assertCleanSession("missing HSN", { committed: false });

    // 6. Missing GST rate blocks too (no silent 5% default).
    reset();
    delete state.items[ITEM_B].gstRatePercent;
    result = await call(router, "POST", "/", createBody());
    assert.equal(result.status, 400);
    assert.match(result.body.message, /Gauze Roll has no GST rate/);

    // 7. Seller not configured: rejected before any session opens.
    reset({ sellerConfigured: false });
    result = await call(router, "POST", "/", createBody());
    assert.equal(result.status, 400);
    assert.match(result.body.message, /Seller details are not configured/);
    assert.equal(counts.sessions, 0);

    // 8. A failing movement write -> generic 500, abort once, end once.
    reset({ movementThrows: true });
    result = await call(router, "POST", "/", createBody());
    assert.equal(result.status, 500);
    assert.equal(result.body.message, "Unable to create invoice.");
    assertCleanSession("create movement failure", { committed: false });

    // 9. Edit without payments: stock by difference, tax recomputed, snapshots kept.
    reset();
    state.items[ITEM_A].gstRatePercent = 18; // master changed; kept line keeps 5%
    state.prices[ITEM_A] = 3500;
    result = await call(router, "PUT", `/${INVOICE}`, {
      lines: [
        { item: ITEM_A, quantity: 12, batchReference: "B-20" },
        { item: ITEM_C, quantity: 3 },
      ],
      notes: "Revised",
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const update = writes.invoiceUpdates[0];
    assert.equal(update.lines[0].pricePaise, 3000, "kept line keeps its price snapshot");
    assert.equal(update.lines[0].gstRatePercent, 5, "kept line keeps its GST snapshot");
    assert.equal(update.lines[0].batchReference, "B-20");
    assert.equal(update.lines[1].pricePaise, 1000, "new line uses the current price");
    assert.equal(update.taxablePaise, 12 * 3000 + 3 * 1000);
    assert.equal(update.taxablePaise + update.cgstPaise + update.sgstPaise + update.igstPaise + update.roundOffPaise, update.totalPaise);
    const byItem = Object.fromEntries(writes.movements.map((movement) => [String(movement.item), movement]));
    assert.deepEqual([byItem[ITEM_A].movementType, byItem[ITEM_A].quantity], ["invoice_out", 2]);
    assert.deepEqual([byItem[ITEM_B].movementType, byItem[ITEM_B].quantity], ["invoice_return", 4]);
    assert.deepEqual([byItem[ITEM_C].movementType, byItem[ITEM_C].quantity], ["invoice_out", 3]);
    assertCleanSession("edit", { committed: true });

    // 10. Edit is locked once a valid payment exists.
    reset({ payments: [{ _id: PAYMENT, amountPaise: 1000, voided: false }] });
    result = await call(router, "PUT", `/${INVOICE}`, { lines: [{ item: ITEM_A, quantity: 1 }] });
    assert.equal(result.status, 409);
    assert.match(result.body.message, /has payments and is locked/);
    assert.equal(writes.invoiceUpdates.length, 0);
    assertCleanSession("edit locked", { committed: false });

    // 11. A voided payment does not lock the invoice.
    reset({ payments: [{ _id: PAYMENT, amountPaise: 1000, voided: true }] });
    result = await call(router, "PUT", `/${INVOICE}`, {
      lines: [
        { item: ITEM_A, quantity: 10 },
        { item: ITEM_B, quantity: 4 },
      ],
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));

    // 12. Edit shortage -> 409, abort once, nothing written.
    reset();
    state.items[ITEM_A].currentStock = 1;
    result = await call(router, "PUT", `/${INVOICE}`, {
      lines: [
        { item: ITEM_A, quantity: 15 },
        { item: ITEM_B, quantity: 4 },
      ],
    });
    assert.equal(result.status, 409);
    assert.match(result.body.message, /Insufficient stock for Crepe 10cm. Available 1 PCS, required 5 PCS/);
    assert.equal(writes.invoiceUpdates.length, 0);
    assertCleanSession("edit shortage", { committed: false });

    // 13. Reverse is blocked while valid payments exist.
    reset({ payments: [{ _id: PAYMENT, amountPaise: 1000, voided: false }] });
    result = await call(router, "POST", `/${INVOICE}/reverse`, { reason: "Wrong customer" });
    assert.equal(result.status, 409);
    assert.match(result.body.message, /Void the recorded payments/);
    assert.equal(writes.movements.length, 0);
    assertCleanSession("reverse with payments", { committed: false });

    // 14. Reverse after voiding returns every line.
    reset({ payments: [{ _id: PAYMENT, amountPaise: 1000, voided: true }] });
    result = await call(router, "POST", `/${INVOICE}/reverse`, { reason: "Wrong customer" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.invoice.status, "reversed");
    assert.equal(result.body.invoice.reverseReason, "Wrong customer");
    assert.equal(writes.movements.length, 2);
    assert.ok(writes.movements.every((movement) => movement.movementType === "invoice_return"));
    assert.equal(state.items[ITEM_A].currentStock, 60);
    assertCleanSession("reverse", { committed: true });

    // 15. Editing a reversed invoice -> 409.
    reset();
    state.invoice.status = "reversed";
    result = await call(router, "PUT", `/${INVOICE}`, { lines: [{ item: ITEM_A, quantity: 1 }] });
    assert.equal(result.status, 409);
    assert.match(result.body.message, /Only active invoices can be edited/);

    // 16. Payment above the outstanding balance -> 400; exact amount -> 201.
    reset({ payments: [{ _id: ID(7), amountPaise: 50000, voided: false }] });
    result = await call(router, "POST", `/${INVOICE}/payments`, { amount: "25.01", paymentDate: "2026-11-21", method: "upi" });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /outstanding balance of Rs 25.00/);
    assert.equal(writes.payments, 0);
    assertCleanSession("payment over cap", { committed: false });

    reset({ payments: [{ _id: ID(7), amountPaise: 50000, voided: false }] });
    result = await call(router, "POST", `/${INVOICE}/payments`, { amount: "25", paymentDate: "2026-11-21", method: "cheque" });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.summary.outstandingPaise, 0);
    assertCleanSession("payment", { committed: true });

    // 17. Payment dated before the invoice -> 400.
    reset();
    result = await call(router, "POST", `/${INVOICE}/payments`, { amount: "10", paymentDate: "2026-11-19", method: "cash" });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /before the invoice date/);

    // 18. Void, then void again -> 409.
    reset({ payments: [{ _id: PAYMENT, amountPaise: 1000, voided: false }] });
    result = await call(router, "POST", `/${INVOICE}/payments/${PAYMENT}/void`, { reason: "Entered twice" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.summary.paidPaise, 0);
    assertCleanSession("void", { committed: true });
    resetCounters();
    result = await call(router, "POST", `/${INVOICE}/payments/${PAYMENT}/void`, { reason: "Again" });
    assert.equal(result.status, 409);
    assert.match(result.body.message, /already voided/);
    assertCleanSession("void twice", { committed: false });

    // 19. Movement failure during reverse -> generic 500, abort once, end once.
    reset({ movementThrows: true });
    result = await call(router, "POST", `/${INVOICE}/reverse`, { reason: "Mistake" });
    assert.equal(result.status, 500);
    assert.equal(result.body.message, "Unable to reverse invoice.");
    assertCleanSession("reverse failure", { committed: false });
  } finally {
    console.error = originalConsoleError;
  }

  console.log("Invoice session safety: 19 scenarios passed.");
})().catch((err) => {
  console.error = originalConsoleError;
  console.error(err);
  process.exit(1);
});
