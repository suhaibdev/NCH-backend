/*
 * Estimate to Invoice conversion route safety, without MongoDB.
 *
 *  - Conversion never touches stock: no StockItem update, no StockMovement.
 *  - No two operations on one session at once; a failure aborts the
 *    transaction once and ends the session once.
 *  - A blocked conversion writes nothing (no invoice, payment or estimate change).
 *  - A converted estimate is read-only (edit, cancel, pay, void -> 409).
 *  - Reversing the converted invoice returns stock exactly once and leaves
 *    the estimate converted.
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

const ID = (n) => `64e0000000000000000000${String(n).padStart(2, "0")}`;
const CUSTOMER = ID(1);
const ITEM_A = ID(2);
const ITEM_B = ID(3);
const ESTIMATE = ID(4);
const INVOICE = ID(5);
const PAY_1 = ID(6);
const PAY_2 = ID(7);

const state = {};
const writes = {};

const baseEstimate = () => ({
  _id: ESTIMATE,
  estimateNumber: "EST/2026-27/0007",
  customer: CUSTOMER,
  estimateDate: new Date("2026-11-20T00:00:00.000Z"),
  status: "active",
  totalPaise: 53328,
  revision: 0,
  lines: [
    { item: ITEM_A, productName: "Crepe 10cm", unit: "pcs", quantity: 7, pricePaise: 3333, lineTotalPaise: 23331 },
    { item: ITEM_B, productName: "Gauze Roll", unit: "dozen", quantity: 3, pricePaise: 9999, lineTotalPaise: 29997 },
  ],
});

const reset = (overrides = {}) => {
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, {
    sellerConfigured: true,
    customer: { _id: CUSTOMER, name: "Shree Medicals", gst: "", stateCode: "09", isActive: true, billingAddress: {} },
    items: {
      [ITEM_A]: { _id: ITEM_A, productName: "Crepe 10cm", unit: "pcs", category: "finished_goods", hsnCode: "3005", gstRatePercent: 5, currentStock: 40 },
      [ITEM_B]: { _id: ITEM_B, productName: "Gauze Roll", unit: "dozen", category: "finished_goods", hsnCode: "30059040", gstRatePercent: 18, currentStock: 12 },
    },
    estimate: baseEstimate(),
    estimatePayments: [
      { _id: PAY_1, amountPaise: 10000, voided: false, transferred: false, method: "upi", reference: "UTR1", notes: "", paymentDate: new Date("2026-11-21T00:00:00.000Z"), createdBy: "Admin" },
      { _id: PAY_2, amountPaise: 20000, voided: false, transferred: false, method: "cash", reference: "", notes: "", paymentDate: new Date("2026-11-22T00:00:00.000Z"), createdBy: "Admin" },
    ],
    invoice: null,
    invoicePayments: [],
    invoiceCreateThrows: false,
    bulkModified: null,
    ...overrides,
  });
  writes.invoices = 0;
  writes.invoicePayments = 0;
  writes.estimateUpdates = [];
  writes.bulkOps = 0;
  writes.stockUpdates = [];
  writes.movements = [];
  resetCounters();
};

stub("src/config/sellerProfile", {
  isSellerConfigured: () => state.sellerConfigured,
  getSellerSnapshot: () => ({ legalName: "NEW CALCUTTA HANDLOOM", gstin: "09AAACH7409R1ZZ", stateCode: "09", bank: null }),
});

stub("src/models/Customer", { findById: () => fakeQuery(() => state.customer) });

stub("src/models/StockItem", {
  findById: (id) => fakeQuery(() => (state.items[String(id)] ? { ...state.items[String(id)] } : null)),
  findOneAndUpdate: (filter, update, options = {}) =>
    runOp(options.session, () => {
      const item = state.items[String(filter._id)];
      if (!item) return null;
      writes.stockUpdates.push({ item: String(filter._id), inc: update.$inc.currentStock });
      item.currentStock += update.$inc.currentStock;
      return { ...item, stockType: null };
    }),
});

stub("src/models/StockMovement", {
  create: (docs, options = {}) =>
    runOp(options.session, () => {
      writes.movements.push(...docs);
      return docs;
    }),
});

stub("src/models/EstimateCounter", { findOneAndUpdate: () => ({ sequence: 1 }) });

stub("src/models/Estimate", {
  findById: () => fakeQuery(() => (state.estimate ? { ...state.estimate } : null)),
  findOneAndUpdate: (filter, update, options = {}) =>
    runOp(options.session, () => {
      if (!state.estimate || state.estimate.status !== filter.status) return null;
      state.estimate.revision += 1;
      return { ...state.estimate };
    }),
  updateOne: (filter, update, options = {}) =>
    runOp(options.session, () => {
      const matches = !filter.status || state.estimate.status === filter.status;
      if (matches) {
        writes.estimateUpdates.push(update.$set);
        Object.assign(state.estimate, update.$set);
      }
      return { matchedCount: matches ? 1 : 0 };
    }),
});

stub("src/models/EstimatePayment", {
  find: (filter) =>
    fakeQuery(() =>
      state.estimatePayments.filter(
        (payment) =>
          (filter.voided !== false || !payment.voided) &&
          (!filter.transferred || filter.transferred.$ne !== true || !payment.transferred)
      )
    ),
  findOne: (filter) =>
    fakeQuery(() => state.estimatePayments.find((payment) => payment._id === String(filter._id)) || null),
  findOneAndUpdate: () => null,
  bulkWrite: (ops, options = {}) =>
    runOp(options.session, () => {
      writes.bulkOps += ops.length;
      let modified = 0;
      ops.forEach(({ updateOne }) => {
        const payment = state.estimatePayments.find((entry) => entry._id === updateOne.filter._id);
        if (payment && !payment.voided && !payment.transferred) {
          Object.assign(payment, updateOne.update.$set);
          modified += 1;
        }
      });
      return { modifiedCount: state.bulkModified === null ? modified : state.bulkModified };
    }),
});

stub("src/models/InvoiceCounter", { findOneAndUpdate: (f, u, options = {}) => runOp(options.session, () => ({ sequence: 5 })) });

stub("src/models/Invoice", {
  create: (docs, options = {}) =>
    runOp(options.session, () => {
      if (state.invoiceCreateThrows) throw new Error("invoice write failed");
      writes.invoices += 1;
      state.invoice = { ...docs[0], _id: INVOICE, revision: 0 };
      return [{ ...state.invoice, toObject: () => state.invoice }];
    }),
  findById: () => fakeQuery(() => (state.invoice ? { ...state.invoice } : null)),
  findOneAndUpdate: (filter, update, options = {}) =>
    runOp(options.session, () =>
      state.invoice && state.invoice.status === filter.status ? { ...state.invoice } : null
    ),
  updateOne: (filter, update, options = {}) =>
    runOp(options.session, () => {
      Object.assign(state.invoice, update.$set);
      return { matchedCount: 1 };
    }),
});

stub("src/models/InvoicePayment", {
  create: (docs, options = {}) =>
    runOp(options.session, () => {
      const created = docs.map((doc, index) => {
        writes.invoicePayments += 1;
        const saved = { ...doc, _id: ID(60 + index), voided: false };
        state.invoicePayments.push(saved);
        return saved;
      });
      return created;
    }),
  find: (filter) =>
    fakeQuery(() => state.invoicePayments.filter((payment) => filter.voided !== false || !payment.voided)),
  findOne: (filter) =>
    fakeQuery(() => state.invoicePayments.find((payment) => payment._id === String(filter._id)) || null),
  findOneAndUpdate: () => null,
});

const conversionRouter = require(path.join(root, "src/routes/estimateConversion"));
const estimateRouter = require(path.join(root, "src/routes/estimates"));
const invoiceRouter = require(path.join(root, "src/routes/invoices"));

const assertCleanSession = (label, { committed }) => {
  assert.equal(counts.sessions, 1, `${label}: one session`);
  assert.equal(counts.end, 1, `${label}: session ended once`);
  assert.equal(counts.commit, committed ? 1 : 0, `${label}: commit count`);
  assert.equal(counts.abort, committed ? 0 : 1, `${label}: abort count`);
  assert.ok(tracker.maxActive <= 1, `${label}: never two operations on one session at once`);
};

const assertNoStockOperation = (label) => {
  assert.equal(writes.stockUpdates.length, 0, `${label}: no StockItem update`);
  assert.equal(writes.movements.length, 0, `${label}: no StockMovement`);
};

const assertNothingWritten = (label) => {
  assert.equal(writes.invoices, 0, `${label}: no invoice`);
  assert.equal(writes.invoicePayments, 0, `${label}: no carried payment`);
  assert.equal(writes.bulkOps, 0, `${label}: no payment transfer`);
  assert.equal(writes.estimateUpdates.length, 0, `${label}: estimate unchanged`);
  assertNoStockOperation(label);
};

const originalConsoleError = console.error;

(async () => {
  console.error = () => {};
  try {
    /* 1. Convert succeeds: link, tax, carried payments, NO stock operation. */
    reset();
    const stockBefore = { a: state.items[ITEM_A].currentStock, b: state.items[ITEM_B].currentStock };
    let result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {
      invoiceDate: "2026-11-24",
      notes: "Dispatch Monday",
      lines: [{ item: ITEM_A, batchReference: " B-17 " }],
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const invoice = result.body.invoice;
    assert.equal(invoice.invoiceNumber, "INV/2026-27/0005");
    assert.equal(invoice.sourceEstimate, ESTIMATE);
    assert.equal(invoice.sourceEstimateNumber, "EST/2026-27/0007");
    assert.equal(invoice.taxType, "intra");
    assert.equal(invoice.taxablePaise, 53328, "estimate prices are the taxable values");
    assert.equal(invoice.totalPaise, 59900, "GST is added on top, then rounded");
    assert.equal(invoice.notes, "Dispatch Monday");
    assert.equal(invoice.lines[0].pricePaise, 3333, "estimate price snapshot");
    assert.equal(invoice.lines[0].hsnCode, "3005");
    assert.equal(invoice.lines[0].gstRatePercent, 5);
    assert.equal(invoice.lines[0].batchReference, "B-17");
    assert.equal(invoice.lines[1].gstRatePercent, 18);
    assert.equal(invoice.seller.gstin, "09AAACH7409R1ZZ");
    assert.equal(result.body.payments.length, 2, "payments carried over");
    assert.equal(result.body.summary.paidPaise, 30000);
    assert.equal(result.body.summary.outstandingPaise, 59900 - 30000);
    result.body.payments.forEach((payment) => {
      assert.ok(payment.carriedFromEstimatePayment);
      assert.equal(payment.carriedFromEstimateNumber, "EST/2026-27/0007");
    });
    assert.equal(state.estimate.status, "converted");
    assert.equal(state.estimate.convertedInvoice, INVOICE);
    assert.equal(state.estimate.convertedInvoiceNumber, "INV/2026-27/0005");
    assert.equal(writes.bulkOps, 2);
    state.estimatePayments.forEach((payment) => {
      assert.equal(payment.transferred, true);
      assert.equal(payment.voided, false, "transferred, never voided");
      assert.equal(payment.transferredInvoiceNumber, "INV/2026-27/0005");
      assert.ok(payment.transferredInvoicePayment);
    });
    assertNoStockOperation("convert");
    assert.deepEqual(
      { a: state.items[ITEM_A].currentStock, b: state.items[ITEM_B].currentStock },
      stockBefore,
      "stock is exactly as the estimate left it"
    );
    assertCleanSession("convert", { committed: true });

    /* 2. The same estimate cannot be converted twice. */
    resetCounters();
    const invoicesAfterFirst = writes.invoices;
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {});
    assert.equal(result.status, 409);
    assert.equal(result.body.message, "This estimate has already been converted to INV/2026-27/0005.");
    assert.equal(writes.invoices, invoicesAfterFirst, "no second invoice");
    assert.equal(writes.invoicePayments, 2, "payments carried only once");
    assertNoStockOperation("double conversion");
    assertCleanSession("double conversion", { committed: false });

    /* 3. Cancelled estimate, unknown estimate. */
    reset();
    state.estimate.status = "cancelled";
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {});
    assert.equal(result.status, 409);
    assert.equal(result.body.message, "Only active estimates can be converted.");
    assertNothingWritten("cancelled");
    assertCleanSession("cancelled", { committed: false });

    reset();
    state.estimate = null;
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {});
    assert.equal(result.status, 404);
    assertCleanSession("missing estimate", { committed: false });

    /* 4. Missing HSN or GST rate blocks the conversion, naming the item. */
    reset();
    state.items[ITEM_A].hsnCode = "";
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {});
    assert.equal(result.status, 400);
    assert.equal(result.body.message, "Crepe 10cm has no HSN code. Set it in Stock Management before invoicing.");
    assertNothingWritten("missing HSN");
    assert.equal(state.estimate.status, "active");
    assertCleanSession("missing HSN", { committed: false });

    reset();
    delete state.items[ITEM_B].gstRatePercent;
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {});
    assert.equal(result.status, 400);
    assert.match(result.body.message, /Gauze Roll has no GST rate/);
    assertNothingWritten("missing GST rate");

    /* 5. Customer state rules: no state blocks; another state gets IGST. */
    reset();
    state.customer.stateCode = "";
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {});
    assert.equal(result.status, 400);
    assert.match(result.body.message, /no valid state/);
    assertNothingWritten("no state");

    reset();
    state.customer.stateCode = "27";
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {});
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.invoice.taxType, "inter");
    assert.equal(result.body.invoice.igstPaise, 6566);
    assert.equal(result.body.invoice.cgstPaise, 0);
    assertNoStockOperation("interstate");

    reset();
    state.customer.isActive = false;
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {});
    assert.equal(result.status, 400);
    assert.match(result.body.message, /inactive/);

    /* 6. Validation happens before any session opens. */
    reset();
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, { invoiceDate: "2099-01-01" });
    assert.equal(result.status, 400);
    assert.equal(counts.sessions, 0, "future date: no session");

    reset({ sellerConfigured: false });
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {});
    assert.equal(result.status, 400);
    assert.match(result.body.message, /Seller details are not configured/);
    assert.equal(counts.sessions, 0, "seller not configured: no session");

    reset();
    result = await call(conversionRouter, "POST", "/not-an-id/convert", {});
    assert.equal(result.status, 400);
    assert.equal(counts.sessions, 0);

    /* 7. Invoice date before the estimate date; batch reference for a foreign product. */
    reset();
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, { invoiceDate: "2026-11-19" });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /before the estimate date/);
    assertNothingWritten("invoice before estimate");
    assertCleanSession("invoice before estimate", { committed: false });

    reset();
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {
      lines: [{ item: ID(40), batchReference: "B" }],
    });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /not on this estimate/);
    assertNothingWritten("foreign batch");

    /* 8. Paid more than the invoice total (0% edge) is blocked with nothing written. */
    reset();
    state.estimate.lines = [
      { item: ITEM_A, productName: "Crepe 10cm", unit: "pcs", quantity: 1, pricePaise: 10049, lineTotalPaise: 10049 },
    ];
    state.estimate.totalPaise = 10049;
    state.items[ITEM_A].gstRatePercent = 0;
    state.estimatePayments = [{ ...state.estimatePayments[0], amountPaise: 10049 }];
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {});
    assert.equal(result.status, 409);
    assert.match(result.body.message, /more than the invoice total/);
    assertNothingWritten("paid above total");
    assertCleanSession("paid above total", { committed: false });

    /* 9. Only valid, untransferred payments are carried (voided ones stay behind). */
    reset();
    state.estimatePayments[0].voided = true;
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {});
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.payments.length, 1);
    assert.equal(result.body.summary.paidPaise, 20000);
    assert.equal(state.estimatePayments[0].transferred, false, "voided payment is left alone");

    /* 10. A failing write aborts once and ends once; nothing else is written. */
    reset({ invoiceCreateThrows: true });
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {});
    assert.equal(result.status, 500);
    assert.equal(result.body.message, "Unable to convert estimate.");
    assert.equal(writes.bulkOps, 0, "payments are not transferred after a failed invoice write");
    assertNoStockOperation("failed write");
    assertCleanSession("failed write", { committed: false });

    /* 11. A payment that changed mid-conversion (transfer count mismatch) -> 409. */
    reset({ bulkModified: 1 });
    result = await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {});
    assert.equal(result.status, 409);
    assert.match(result.body.message, /payment changed/);
    assertCleanSession("transfer mismatch", { committed: false });

    /* 12. Preview: read-only, no session, shows the real invoice math. */
    reset();
    result = await call(conversionRouter, "GET", `/${ESTIMATE}/conversion-preview`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.eligible, true);
    assert.deepEqual(result.body.problems, []);
    assert.equal(result.body.taxType, "intra");
    assert.equal(result.body.estimateTotalPaise, 53328);
    assert.equal(result.body.tax.taxablePaise, 53328);
    assert.equal(result.body.tax.totalPaise, 59900);
    assert.equal(result.body.carriedPaymentsPaise, 30000);
    assert.equal(result.body.carriedPaymentCount, 2);
    assert.equal(result.body.lines[0].hsnCode, "3005");
    assert.equal(counts.sessions, 0, "preview opens no session");
    assertNothingWritten("preview");

    reset();
    state.items[ITEM_A].hsnCode = "";
    result = await call(conversionRouter, "GET", `/${ESTIMATE}/conversion-preview`);
    assert.equal(result.body.eligible, false);
    assert.deepEqual(result.body.problems, [
      "Crepe 10cm has no HSN code. Set it in Stock Management before invoicing.",
    ]);

    reset({ sellerConfigured: false });
    result = await call(conversionRouter, "GET", `/${ESTIMATE}/conversion-preview`);
    assert.equal(result.body.eligible, false);
    assert.equal(result.body.sellerConfigured, false);

    reset();
    state.estimate.status = "converted";
    state.estimate.convertedInvoiceNumber = "INV/2026-27/0001";
    result = await call(conversionRouter, "GET", `/${ESTIMATE}/conversion-preview`);
    assert.equal(result.body.eligible, false);
    assert.match(result.body.problems[0], /already been converted to INV\/2026-27\/0001/);

    /* 13. A converted estimate is read-only. */
    reset();
    await call(conversionRouter, "POST", `/${ESTIMATE}/convert`, {});
    assert.equal(state.estimate.status, "converted");
    const updatesAfterConversion = writes.estimateUpdates.length;
    const blocked = [
      ["PUT", `/${ESTIMATE}`, { lines: [{ item: ITEM_A, quantity: 1 }] }, /Only active estimates can be edited/],
      ["POST", `/${ESTIMATE}/cancel`, { reason: "Mistake" }, /Only active estimates can be cancelled/],
      ["POST", `/${ESTIMATE}/payments`, { amount: "1", paymentDate: "2026-11-22", method: "cash" }, /Only active estimates/],
      ["POST", `/${ESTIMATE}/payments/${PAY_1}/void`, { reason: "x" }, /Only active estimates/],
    ];
    for (const [method, url, body, pattern] of blocked) {
      resetCounters();
      result = await call(estimateRouter, method, url, body);
      assert.equal(result.status, 409, `${method} ${url}`);
      assert.match(result.body.message, pattern);
      assert.equal(counts.abort, 1);
      assert.equal(counts.end, 1);
    }
    assert.equal(writes.estimateUpdates.length, updatesAfterConversion, "estimate untouched");
    assert.equal(writes.stockUpdates.length, 0, "no stock returned by a blocked cancel");
    assert.equal(writes.movements.length, 0);

    /* 14. Converted estimate detail: left the estimate ledger, shows the transfer. */
    resetCounters();
    result = await call(estimateRouter, "GET", `/${ESTIMATE}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.estimate.status, "converted");
    assert.equal(result.body.estimate.convertedInvoiceNumber, "INV/2026-27/0005");
    assert.deepEqual(result.body.summary, {
      totalPaise: 53328,
      paidPaise: 0,
      outstandingPaise: 0,
      paymentCount: 0,
      voidedCount: 0,
      transferredPaise: 30000,
      transferredCount: 2,
    });
    assert.ok(result.body.payments.every((payment) => payment.transferred && !payment.voided));

    /* 15. Reversing the converted invoice returns stock exactly once; the estimate stays converted. */
    const stockAfterConversion = { a: state.items[ITEM_A].currentStock, b: state.items[ITEM_B].currentStock };
    resetCounters();
    result = await call(invoiceRouter, "POST", `/${INVOICE}/reverse`, { reason: "Wrong buyer" });
    assert.equal(result.status, 409, "carried payments are valid invoice payments");
    assert.match(result.body.message, /Void the recorded payments/);
    assert.equal(writes.stockUpdates.length, 0);
    assertCleanSession("reverse with carried payments", { committed: false });

    state.invoicePayments.forEach((payment) => {
      payment.voided = true;
    });
    resetCounters();
    result = await call(invoiceRouter, "POST", `/${INVOICE}/reverse`, { reason: "Wrong buyer" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.invoice.status, "reversed");
    assert.equal(writes.stockUpdates.length, 2, "one stock return per line");
    assert.ok(writes.stockUpdates.every((entry) => entry.inc > 0), "returned, never deducted");
    assert.equal(state.items[ITEM_A].currentStock, stockAfterConversion.a + 7);
    assert.equal(state.items[ITEM_B].currentStock, stockAfterConversion.b + 3);
    assert.ok(writes.movements.every((movement) => movement.movementType === "invoice_return"));
    assert.equal(writes.movements.length, 2);
    assert.equal(state.estimate.status, "converted", "the estimate does not reopen");
    assert.equal(writes.estimateUpdates.length, updatesAfterConversion, "the estimate was not touched by the reversal");
    assertCleanSession("reverse converted invoice", { committed: true });

    // A second reversal cannot return stock again, and the estimate cannot be cancelled to return it.
    resetCounters();
    result = await call(invoiceRouter, "POST", `/${INVOICE}/reverse`, { reason: "Again" });
    assert.equal(result.status, 409);
    assert.equal(writes.stockUpdates.length, 2, "stock is never returned twice");
    resetCounters();
    result = await call(estimateRouter, "POST", `/${ESTIMATE}/cancel`, { reason: "Return the stock" });
    assert.equal(result.status, 409);
    assert.equal(writes.stockUpdates.length, 2, "cancelling the converted estimate cannot return stock again");
    assert.equal(state.items[ITEM_A].currentStock, stockAfterConversion.a + 7);
  } finally {
    console.error = originalConsoleError;
  }

  console.log("Estimate conversion session safety: all scenarios passed.");
})().catch((err) => {
  console.error = originalConsoleError;
  console.error(err);
  process.exit(1);
});
