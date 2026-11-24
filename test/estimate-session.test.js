/*
 * Estimate create / edit / cancel / payment / void session safety, without
 * MongoDB. No two operations may run on one session at once; a failure aborts
 * the transaction once and ends the session once; blocked requests write
 * nothing permanent (no estimate, movement or payment documents).
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

const ID = (n) => `64b0000000000000000000${String(n).padStart(2, "0")}`;
const CUSTOMER = ID(1);
const ITEM_A = ID(2);
const ITEM_B = ID(3);
const ITEM_C = ID(4);
const ESTIMATE = ID(5);
const PAYMENT = ID(6);

const state = {};
const writes = { estimates: 0, movements: [], payments: 0, estimateUpdates: [], voids: 0 };

const baseEstimate = () => ({
  _id: ESTIMATE,
  estimateNumber: "EST/2026-27/0007",
  customer: CUSTOMER,
  estimateDate: new Date("2026-11-20T00:00:00.000Z"),
  status: "active",
  totalPaise: 50000,
  lines: [
    { item: ITEM_A, productName: "Crepe 10cm", unit: "pcs", quantity: 10, pricePaise: 3000, lineTotalPaise: 30000 },
    { item: ITEM_B, productName: "Gauze Roll", unit: "dozen", quantity: 4, pricePaise: 5000, lineTotalPaise: 20000 },
  ],
});

const reset = (overrides = {}) => {
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, {
    customer: { _id: CUSTOMER, name: "Shree Medicals", isActive: true, billingAddress: {} },
    items: {
      [ITEM_A]: { _id: ITEM_A, productName: "Crepe 10cm", unit: "pcs", category: "finished_goods", currentStock: 50 },
      [ITEM_B]: { _id: ITEM_B, productName: "Gauze Roll", unit: "dozen", category: "finished_goods", currentStock: 20 },
      [ITEM_C]: { _id: ITEM_C, productName: "Cotton", unit: "pcs", category: "raw_material", currentStock: 90 },
    },
    prices: { [ITEM_A]: 3000, [ITEM_B]: 5000 },
    estimate: baseEstimate(),
    payments: [],
    movementThrows: false,
    ...overrides,
  });
  writes.estimates = 0;
  writes.movements = [];
  writes.payments = 0;
  writes.estimateUpdates = [];
  writes.voids = 0;
  resetCounters();
};

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
      // Real MongoDB would roll this back on abort; the tests only check
      // that no estimate/movement/payment documents are written.
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

stub("src/models/EstimateCounter", {
  findOneAndUpdate: (filter, update, options = {}) => runOp(options.session, () => ({ sequence: 7 })),
});

stub("src/models/Estimate", {
  create: (docs, options = {}) =>
    runOp(options.session, () => {
      writes.estimates += 1;
      const doc = { ...docs[0], _id: ESTIMATE };
      return [{ ...doc, toObject: () => doc }];
    }),
  findById: () => fakeQuery(() => (state.estimate ? { ...state.estimate } : null)),
  findOneAndUpdate: (filter, update, options = {}) =>
    runOp(options.session, () =>
      state.estimate && state.estimate.status === filter.status ? { ...state.estimate } : null
    ),
  updateOne: (filter, update, options = {}) =>
    runOp(options.session, () => {
      writes.estimateUpdates.push(update.$set);
      Object.assign(state.estimate, update.$set);
      return { acknowledged: true };
    }),
});

stub("src/models/EstimatePayment", {
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
      writes.voids += 1;
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

const router = require(path.join(root, "src/routes/estimates"));

const createBody = () => ({
  customer: CUSTOMER,
  estimateDate: "2026-11-20",
  lines: [
    { item: ITEM_B, quantity: 2 },
    { item: ITEM_A, quantity: 5 },
  ],
  notes: "Deliver Monday",
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
    // 1. Create succeeds.
    reset();
    let result = await call(router, "POST", "/", createBody());
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.estimate.estimateNumber, "EST/2026-27/0007");
    assert.equal(result.body.estimate.totalPaise, 2 * 5000 + 5 * 3000);
    assert.deepEqual(result.body.estimate.lines.map((line) => line.item), [ITEM_B, ITEM_A], "request order kept");
    assert.equal(result.body.estimate.lines[1].pricePaise, 3000, "price snapshot");
    assert.equal(JSON.stringify(result.body).toLowerCase().includes("gst"), false, "no GST");
    assert.deepEqual(result.body.summary, {
      totalPaise: 25000,
      paidPaise: 0,
      outstandingPaise: 25000,
      paymentCount: 0,
      voidedCount: 0,
    });
    assert.equal(writes.movements.length, 2);
    writes.movements.forEach((movement) => {
      assert.equal(movement.movementType, "estimate_out");
      assert.equal(movement.direction, "out");
      assert.equal(movement.referenceType, "estimate");
      assert.equal(movement.balanceBefore - movement.quantity, movement.balanceAfter);
    });
    assert.equal(state.items[ITEM_A].currentStock, 45);
    assertCleanSession("create", { committed: true });

    // 2. Insufficient stock blocks the whole estimate with no documents written.
    reset();
    state.items[ITEM_A].currentStock = 3;
    result = await call(router, "POST", "/", createBody());
    assert.equal(result.status, 409);
    assert.equal(
      result.body.message,
      "Insufficient stock for Crepe 10cm. Available 3 PCS, required 5 PCS."
    );
    assert.equal(writes.estimates, 0, "no estimate written");
    assert.equal(writes.movements.length, 0, "no movement written");
    assertCleanSession("create shortage", { committed: false });

    // 3. A failing movement write -> generic 500, abort once, end once.
    reset({ movementThrows: true });
    result = await call(router, "POST", "/", createBody());
    assert.equal(result.status, 500);
    assert.equal(result.body.message, "Unable to create estimate.");
    assertCleanSession("create movement failure", { committed: false });

    // 4. No active price -> 400, nothing written, stock untouched.
    reset();
    delete state.prices[ITEM_A];
    result = await call(router, "POST", "/", createBody());
    assert.equal(result.status, 400);
    assert.match(result.body.message, /Crepe 10cm has no active price/);
    assert.equal(writes.estimates, 0);
    assert.equal(state.items[ITEM_A].currentStock, 50);
    assertCleanSession("create without price", { committed: false });

    // 5. Raw material cannot be estimated.
    reset();
    state.prices[ITEM_C] = 100;
    result = await call(router, "POST", "/", { ...createBody(), lines: [{ item: ITEM_C, quantity: 1 }] });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /not a Finished Goods/);

    // 6. Validation happens before any session opens.
    reset();
    result = await call(router, "POST", "/", { ...createBody(), lines: [{ item: ITEM_A, quantity: 0 }] });
    assert.equal(result.status, 400);
    assert.equal(counts.sessions, 0, "invalid payload never opens a session");

    // 7. Edit: change quantity, remove a line, add a line -> movements by difference only.
    reset();
    state.prices[ITEM_A] = 3500; // current price differs; kept line keeps its 3000 snapshot
    state.items[ITEM_C] = { ...state.items[ITEM_C], category: "finished_goods", productName: "Bandage Pack" };
    state.prices[ITEM_C] = 1000;
    result = await call(router, "PUT", `/${ESTIMATE}`, {
      lines: [
        { item: ITEM_A, quantity: 12 },
        { item: ITEM_C, quantity: 3 },
      ],
      notes: "Revised",
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const update = writes.estimateUpdates[0];
    assert.equal(update.lines[0].pricePaise, 3000, "unchanged line keeps its snapshot");
    assert.equal(update.lines[1].pricePaise, 1000, "new line uses current price");
    assert.equal(update.totalPaise, 12 * 3000 + 3 * 1000);
    const byItem = Object.fromEntries(writes.movements.map((movement) => [String(movement.item), movement]));
    assert.deepEqual(
      [byItem[ITEM_A].movementType, byItem[ITEM_A].quantity],
      ["estimate_out", 2],
      "increase deducts the difference"
    );
    assert.deepEqual([byItem[ITEM_B].movementType, byItem[ITEM_B].quantity], ["estimate_return", 4], "removed line returns");
    assert.deepEqual([byItem[ITEM_C].movementType, byItem[ITEM_C].quantity], ["estimate_out", 3], "added line deducts");
    assert.equal(state.items[ITEM_B].currentStock, 24);
    assertCleanSession("edit", { committed: true });

    // 8. Explicit re-price takes the current price.
    reset();
    state.prices[ITEM_A] = 3500;
    result = await call(router, "PUT", `/${ESTIMATE}`, {
      lines: [
        { item: ITEM_A, quantity: 10, reprice: true },
        { item: ITEM_B, quantity: 4 },
      ],
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(writes.estimateUpdates[0].lines[0].pricePaise, 3500);
    assert.equal(writes.movements.length, 0, "no stock change, no movements");

    // 9. Edit that would drop the total below payments -> 409, nothing written.
    reset({ payments: [{ _id: PAYMENT, amountPaise: 40000, voided: false }] });
    result = await call(router, "PUT", `/${ESTIMATE}`, { lines: [{ item: ITEM_A, quantity: 1 }] });
    assert.equal(result.status, 409);
    assert.match(result.body.message, /less than the Rs 400.00 already paid/);
    assert.equal(writes.estimateUpdates.length, 0);
    assert.equal(writes.movements.length, 0);
    assertCleanSession("edit below paid", { committed: false });

    // 10. Edit shortage -> 409, abort once.
    reset();
    state.items[ITEM_A].currentStock = 1;
    result = await call(router, "PUT", `/${ESTIMATE}`, {
      lines: [
        { item: ITEM_A, quantity: 15 },
        { item: ITEM_B, quantity: 4 },
      ],
    });
    assert.equal(result.status, 409);
    assert.match(result.body.message, /Insufficient stock for Crepe 10cm. Available 1 PCS, required 5 PCS/);
    assertCleanSession("edit shortage", { committed: false });

    // 11. Cancel is blocked while valid payments exist.
    reset({ payments: [{ _id: PAYMENT, amountPaise: 1000, voided: false }] });
    result = await call(router, "POST", `/${ESTIMATE}/cancel`, { reason: "Customer withdrew" });
    assert.equal(result.status, 409);
    assert.match(result.body.message, /Void the recorded payments/);
    assert.equal(writes.movements.length, 0);
    assertCleanSession("cancel with payments", { committed: false });

    // 12. Cancel without valid payments restores every line.
    reset({ payments: [{ _id: PAYMENT, amountPaise: 1000, voided: true }] });
    result = await call(router, "POST", `/${ESTIMATE}/cancel`, { reason: "Customer withdrew" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.estimate.status, "cancelled");
    assert.equal(result.body.estimate.cancelReason, "Customer withdrew");
    assert.equal(writes.movements.length, 2);
    assert.ok(writes.movements.every((movement) => movement.movementType === "estimate_return"));
    assert.equal(state.items[ITEM_A].currentStock, 60);
    assertCleanSession("cancel", { committed: true });

    // 13. Cancel needs a reason (checked before the session).
    reset();
    result = await call(router, "POST", `/${ESTIMATE}/cancel`, { reason: " " });
    assert.equal(result.status, 400);
    assert.equal(counts.sessions, 0);

    // 14. Editing a cancelled estimate -> 409.
    reset();
    state.estimate.status = "cancelled";
    result = await call(router, "PUT", `/${ESTIMATE}`, { lines: [{ item: ITEM_A, quantity: 1 }] });
    assert.equal(result.status, 409);
    assert.match(result.body.message, /Only active estimates can be edited/);
    assertCleanSession("edit cancelled", { committed: false });

    // 15. Payment above the outstanding balance -> 400.
    reset({ payments: [{ _id: ID(7), amountPaise: 45000, voided: false }] });
    result = await call(router, "POST", `/${ESTIMATE}/payments`, {
      amount: "50.01",
      paymentDate: "2026-11-21",
      method: "upi",
    });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /outstanding balance of Rs 50.00/);
    assert.equal(writes.payments, 0);
    assertCleanSession("payment over cap", { committed: false });

    // 16. Exact outstanding payment succeeds.
    reset({ payments: [{ _id: ID(7), amountPaise: 45000, voided: false }] });
    result = await call(router, "POST", `/${ESTIMATE}/payments`, {
      amount: "50",
      paymentDate: "2026-11-21",
      method: "cash",
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.payment.amountPaise, 5000);
    assert.equal(result.body.summary.outstandingPaise, 0);
    assertCleanSession("payment", { committed: true });

    // 17. Payment dated before the estimate -> 400.
    reset();
    result = await call(router, "POST", `/${ESTIMATE}/payments`, {
      amount: "10",
      paymentDate: "2026-11-19",
      method: "cash",
    });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /before the estimate date/);

    // 18. Void a payment, then voiding again -> 409.
    reset({ payments: [{ _id: PAYMENT, amountPaise: 1000, voided: false }] });
    result = await call(router, "POST", `/${ESTIMATE}/payments/${PAYMENT}/void`, { reason: "Entered twice" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.summary.paidPaise, 0);
    assert.equal(result.body.summary.voidedCount, 1);
    assert.equal(result.body.payments[0].voidReason, "Entered twice");
    assertCleanSession("void", { committed: true });

    resetCounters();
    result = await call(router, "POST", `/${ESTIMATE}/payments/${PAYMENT}/void`, { reason: "Again" });
    assert.equal(result.status, 409);
    assert.match(result.body.message, /already voided/);
    assertCleanSession("void twice", { committed: false });

    // 19. Movement failure during cancel -> generic 500, abort once, end once.
    reset({ movementThrows: true });
    result = await call(router, "POST", `/${ESTIMATE}/cancel`, { reason: "Mistake" });
    assert.equal(result.status, 500);
    assert.equal(result.body.message, "Unable to cancel estimate.");
    assertCleanSession("cancel failure", { committed: false });
  } finally {
    console.error = originalConsoleError;
  }

  console.log("Estimate session safety: 19 scenarios passed.");
})().catch((err) => {
  console.error = originalConsoleError;
  console.error(err);
  process.exit(1);
});
