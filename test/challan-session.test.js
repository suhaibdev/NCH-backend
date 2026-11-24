/*
 * Delivery challan route safety, without MongoDB.
 *
 *  - A challan NEVER touches stock or payments: no StockItem update, no
 *    StockMovement, no payment write (tracked by stubs on those models).
 *  - The cap holds, including two challans racing for the last quantity. The
 *    fake Invoice lock serializes concurrent transactions on one invoice the
 *    way MongoDB's write conflict plus the driver retry does.
 *  - No two operations on one session at once; a failure aborts once and ends
 *    the session once; blocked requests write nothing.
 *  - Invoice reverse and edit are blocked while active challans exist.
 */
const assert = require("node:assert/strict");
const path = require("path");
const mongoose = require("mongoose");
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

const ID = (n) => `64a0000000000000000000${String(n).padStart(2, "0")}`;
const CUSTOMER = ID(1);
const INVOICE = ID(2);
const LINE_A = ID(3);
const LINE_B = ID(4);
const ITEM_A = ID(5);
const ITEM_B = ID(6);

const state = {};
const writes = {};

/* ---------- simulated invoice lock (MongoDB write conflict + retry) ---------- */
const locks = new Map();
const baseStartSession = mongoose.startSession;
mongoose.startSession = async () => {
  const session = await baseStartSession();
  const held = [];
  session.held = held;
  const original = session.withTransaction.bind(session);
  session.withTransaction = async (fn) => {
    try {
      return await original(fn);
    } finally {
      held.splice(0).forEach((release) => release());
    }
  };
  return session;
};
const acquireLock = async (key, session) => {
  while (locks.has(key)) await locks.get(key);
  let release;
  const gate = new Promise((resolve) => {
    release = () => {
      locks.delete(key);
      resolve();
    };
  });
  locks.set(key, gate);
  session.held.push(release);
};

const baseInvoice = () => ({
  _id: INVOICE,
  invoiceNumber: "INV/2026-27/0003",
  invoiceDate: new Date("2026-11-20T00:00:00.000Z"),
  status: "active",
  revision: 0,
  customer: CUSTOMER,
  taxType: "intra",
  customerSnapshot: {
    name: "Shree Medicals",
    billingName: "Shree Medicals Pvt Ltd",
    gstin: "09AAACH7409R1ZZ",
    stateCode: "09",
    contactNumber: "9876543210",
    billingAddress: { line1: "12 Aminabad", line2: "", city: "Lucknow", pincode: "226018" },
    shippingSameAsBilling: true,
    shippingAddress: {},
  },
  seller: {
    legalName: "NEW CALCUTTA HANDLOOM",
    gstin: "09AAACH7409R1ZZ",
    pan: "AAACH7409R",
    addressLine1: "1 Mill Road",
    city: "Kanpur",
    pincode: "208001",
    stateName: "Uttar Pradesh",
    phone: "0512-111111",
    email: "info@nch.example",
    bank: { accountNumber: "000111222" },
    signatoryLabel: "Authorised Signatory",
  },
  lines: [
    { _id: LINE_A, item: ITEM_A, productName: "Crepe 10cm", unit: "pcs", hsnCode: "3005", gstRatePercent: 5, quantity: 10, pricePaise: 3000, taxablePaise: 30000, dispatchedQuantity: 0 },
    { _id: LINE_B, item: ITEM_B, productName: "Gauze Roll", unit: "dozen", hsnCode: "3005", gstRatePercent: 5, quantity: 4, pricePaise: 5000, taxablePaise: 20000, dispatchedQuantity: 0 },
  ],
  activeChallanCount: 0,
  dispatchStatus: "none",
  totalPaise: 52500,
});

const reset = (overrides = {}) => {
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, {
    invoice: baseInvoice(),
    challans: [],
    counter: 0,
    items: {
      [ITEM_A]: { _id: ITEM_A, currentStock: 40 },
      [ITEM_B]: { _id: ITEM_B, currentStock: 12 },
    },
    challanCreateThrows: false,
    invoiceUpdateMatches: true,
    ...overrides,
  });
  writes.stockUpdates = [];
  writes.movements = [];
  writes.payments = 0;
  writes.invoiceUpdates = 0;
  locks.clear();
  resetCounters();
};

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

stub("src/models/Customer", { findById: () => fakeQuery(() => null) });
stub("src/models/InvoiceCounter", { findOneAndUpdate: () => ({ sequence: 1 }) });
stub("src/models/InvoicePayment", {
  find: () => fakeQuery(() => []),
  create: () => {
    writes.payments += 1;
    return [];
  },
  findOneAndUpdate: () => {
    writes.payments += 1;
    return null;
  },
});

stub("src/models/ChallanCounter", {
  findOneAndUpdate: (filter, update, options = {}) =>
    runOp(options.session, () => {
      state.counter += 1;
      return { sequence: state.counter };
    }),
});

const byIdMatch = (doc, id) => String(doc._id) === String(id);

stub("src/models/Challan", {
  create: (docs, options = {}) =>
    runOp(options.session, () => {
      if (state.challanCreateThrows) throw new Error("challan write failed");
      const saved = { ...docs[0], _id: ID(70 + state.challans.length), revision: 0 };
      state.challans.push(saved);
      return [{ ...saved, toObject: () => ({ ...saved }) }];
    }),
  findById: (id) => fakeQuery(() => state.challans.find((c) => byIdMatch(c, id)) || null),
  find: (filter) => {
    const query = fakeQuery(() => {
      state.lastChallanFilter = filter;
      return state.challans.filter((c) => !filter.invoice || String(c.invoice) === String(filter.invoice));
    });
    query.skip = () => query;
    return query;
  },
  countDocuments: async () => state.challans.length,
  findOneAndUpdate: (filter, update, options = {}) =>
    runOp(options.session, () => {
      const challan = state.challans.find((c) => byIdMatch(c, filter._id) && c.status === filter.status);
      if (!challan) return null;
      Object.assign(challan, update.$set);
      challan.revision += update.$inc?.revision || 0;
      return { ...challan };
    }),
});

stub("src/models/Invoice", {
  findById: () => fakeQuery(() => (state.invoice ? JSON.parse(JSON.stringify(state.invoice)) : null)),
  findOneAndUpdate: async (filter, update, options = {}) => {
    if (update.$inc?.revision && options.session) await acquireLock(String(filter._id), options.session);
    return runOp(options.session, () => {
      const invoice = state.invoice;
      if (!invoice || (filter.status && invoice.status !== filter.status)) return null;
      invoice.revision += update.$inc?.revision || 0;
      return JSON.parse(JSON.stringify(invoice));
    });
  },
  updateOne: (filter, update, options = {}) =>
    runOp(options.session, () => {
      const invoice = state.invoice;
      if (!state.invoiceUpdateMatches || (filter.revision !== undefined && filter.revision !== invoice.revision)) {
        return { matchedCount: 0 };
      }
      writes.invoiceUpdates += 1;
      Object.entries(update.$inc || {}).forEach(([key, amount]) => {
        const match = /^lines\.\$\[(\w+)\]\.dispatchedQuantity$/.exec(key);
        if (match) {
          const filterDoc = (options.arrayFilters || []).find((entry) => `${match[1]}._id` in entry);
          assert.ok(filterDoc, "array filter present for the line counter");
          const line = invoice.lines.find((l) => String(l._id) === String(filterDoc[`${match[1]}._id`]));
          line.dispatchedQuantity = (line.dispatchedQuantity || 0) + amount;
        } else if (key === "activeChallanCount") {
          invoice.activeChallanCount += amount;
        }
      });
      Object.assign(invoice, update.$set || {});
      return { matchedCount: 1 };
    }),
});

const challanRouter = require(path.join(root, "src/routes/challans"));
const invoiceRouter = require(path.join(root, "src/routes/invoices"));

/** Like call(), but with the parsed query string a real Express app provides. */
const callWithQuery = (router, url, query) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, body: payload });
      },
    };
    router.handle({ method: "GET", url, query, body: undefined, headers: {} }, res, (err) =>
      resolve({ status: "next", body: err })
    );
  });

const body = (...pairs) => ({
  invoice: INVOICE,
  challanDate: "2026-11-22",
  lines: pairs.map(([invoiceLine, quantity]) => ({ invoiceLine, quantity })),
  transport: { transporterName: "Sharma Transport", vehicleNumber: "up32ab1234", lrNumber: "LR-77" },
  notes: "Fragile",
});

const assertCleanSession = (label, { committed }) => {
  assert.equal(counts.sessions, 1, `${label}: one session`);
  assert.equal(counts.end, 1, `${label}: session ended once`);
  assert.equal(counts.commit, committed ? 1 : 0, `${label}: commit count`);
  assert.equal(counts.abort, committed ? 0 : 1, `${label}: abort count`);
  assert.ok(tracker.maxActive <= 1, `${label}: never two operations on one session at once`);
};

/** A challan never touches stock, stock history or payments. */
const assertNoStockOrLedgerWrites = (label) => {
  assert.equal(writes.stockUpdates.length, 0, `${label}: no StockItem update`);
  assert.equal(writes.movements.length, 0, `${label}: no StockMovement`);
  assert.equal(writes.payments, 0, `${label}: no payment write`);
};

const dispatched = () => state.invoice.lines.map((line) => line.dispatchedQuantity);

const originalConsoleError = console.error;

(async () => {
  console.error = () => {};
  try {
    /* 1. Create succeeds: snapshots, counters, NO stock or ledger writes. */
    reset();
    const stockBefore = { a: state.items[ITEM_A].currentStock, b: state.items[ITEM_B].currentStock };
    let result = await call(challanRouter, "POST", "/", body([LINE_A, 4], [LINE_B, 1]));
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const challan = result.body.challan;
    assert.equal(challan.challanNumber, "CH/2026-27/0001");
    assert.equal(challan.invoiceNumber, "INV/2026-27/0003");
    assert.equal(challan.status, "active");
    assert.deepEqual(challan.lines.map((line) => line.quantity), [4, 1]);
    assert.equal(challan.transport.vehicleNumber, "UP32AB1234");
    assert.equal(challan.customerSnapshot.shipTo.line1, "12 Aminabad", "billing address when same as billing");
    assert.equal(challan.customerSnapshot.shipTo.stateCode, "09");
    assert.equal(challan.seller.legalName, "NEW CALCUTTA HANDLOOM");
    const printed = JSON.stringify(challan).toLowerCase();
    assert.equal(/gstin|09aaach7409r1zz|aaach7409r|000111222|price|hsn|taxable/.test(printed), false, "no GST, GSTIN, PAN, bank or price on a challan");
    assert.deepEqual(dispatched(), [4, 1]);
    assert.equal(state.invoice.activeChallanCount, 1);
    assert.equal(state.invoice.dispatchStatus, "partial");
    assertNoStockOrLedgerWrites("create");
    assert.deepEqual({ a: state.items[ITEM_A].currentStock, b: state.items[ITEM_B].currentStock }, stockBefore);
    assertCleanSession("create", { committed: true });

    /* 2. Ship-to uses the shipping address when it differs. */
    reset();
    state.invoice.customerSnapshot.shippingSameAsBilling = false;
    state.invoice.customerSnapshot.shippingAddress = { line1: "Godown 4", city: "Pune", pincode: "411001", stateCode: "27" };
    result = await call(challanRouter, "POST", "/", body([LINE_A, 1]));
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.deepEqual(
      { line1: result.body.challan.customerSnapshot.shipTo.line1, state: result.body.challan.customerSnapshot.shipTo.stateCode },
      { line1: "Godown 4", state: "27" }
    );

    /* 3. The cap: over the remaining quantity is blocked and writes nothing. */
    reset();
    result = await call(challanRouter, "POST", "/", body([LINE_A, 11]));
    assert.equal(result.status, 409);
    assert.equal(result.body.message, "Only 10 PCS of Crepe 10cm remain to dispatch.");
    assert.equal(state.challans.length, 0, "no challan written");
    assert.equal(writes.invoiceUpdates, 0, "invoice counters untouched");
    assert.equal(state.counter, 0, "no challan number used");
    assertNoStockOrLedgerWrites("over cap");
    assertCleanSession("over cap", { committed: false });

    /* 4. Several challans add up to exactly the cap; one more is rejected. */
    reset();
    for (const quantity of [4, 3, 3]) {
      resetCounters();
      result = await call(challanRouter, "POST", "/", body([LINE_A, quantity]));
      assert.equal(result.status, 201, JSON.stringify(result.body));
    }
    assert.deepEqual(dispatched(), [10, 0]);
    assert.deepEqual(state.challans.map((c) => c.challanNumber), ["CH/2026-27/0001", "CH/2026-27/0002", "CH/2026-27/0003"]);
    resetCounters();
    result = await call(challanRouter, "POST", "/", body([LINE_A, 1]));
    assert.equal(result.status, 409);
    assert.equal(result.body.message, "Crepe 10cm has no quantity left to dispatch.");
    assert.equal(state.challans.length, 3);
    assertCleanSession("cap plus one", { committed: false });

    resetCounters();
    result = await call(challanRouter, "POST", "/", body([LINE_B, 4]));
    assert.equal(result.status, 201);
    assert.equal(state.invoice.dispatchStatus, "full");
    assertNoStockOrLedgerWrites("fill the invoice");

    /* 5. TWO CHALLANS RACING FOR THE LAST QUANTITY: exactly one wins. */
    reset();
    resetCounters();
    const race = await Promise.all([
      call(challanRouter, "POST", "/", body([LINE_A, 7])),
      call(challanRouter, "POST", "/", body([LINE_A, 7])),
    ]);
    assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
    assert.equal(race.find((r) => r.status === 409).body.message, "Only 3 PCS of Crepe 10cm remain to dispatch.");
    assert.equal(state.challans.length, 1, "only one challan exists");
    assert.equal(dispatched()[0], 7, "dispatched is 7, never 14");
    assert.equal(state.invoice.activeChallanCount, 1);
    assert.equal(counts.sessions, 2);
    assert.equal(counts.commit, 1);
    assert.equal(counts.abort, 1);
    assert.equal(counts.end, 2, "every session ended once");
    assert.ok(tracker.maxActive <= 1, "never two operations on one session at once");
    assertNoStockOrLedgerWrites("race");

    // Three racers for 10 units, 4 each: two fit (8), the third is rejected.
    reset();
    resetCounters();
    const three = await Promise.all([
      call(challanRouter, "POST", "/", body([LINE_A, 4])),
      call(challanRouter, "POST", "/", body([LINE_A, 4])),
      call(challanRouter, "POST", "/", body([LINE_A, 4])),
    ]);
    assert.deepEqual(three.map((r) => r.status).sort(), [201, 201, 409]);
    assert.equal(dispatched()[0], 8);
    assert.ok(dispatched()[0] <= 10);
    assert.equal(state.challans.length, 2);
    assert.deepEqual(
      state.challans.map((c) => c.challanNumber).sort(),
      ["CH/2026-27/0001", "CH/2026-27/0002"],
      "numbers are gap-free (the failed attempt used none)"
    );

    /* 6. Cancel returns the quantity to the pool; a new challan can use it. */
    reset();
    await call(challanRouter, "POST", "/", body([LINE_A, 10], [LINE_B, 4]));
    assert.equal(state.invoice.dispatchStatus, "full");
    const firstId = state.challans[0]._id;
    resetCounters();
    result = await call(challanRouter, "POST", `/${firstId}/cancel`, { reason: "Wrong lorry" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.challan.status, "cancelled");
    assert.equal(result.body.challan.cancelReason, "Wrong lorry");
    assert.deepEqual(dispatched(), [0, 0]);
    assert.equal(state.invoice.activeChallanCount, 0);
    assert.equal(state.invoice.dispatchStatus, "none");
    assert.equal(state.challans.length, 1, "the record is kept");
    assertNoStockOrLedgerWrites("cancel");
    assertCleanSession("cancel", { committed: true });

    resetCounters();
    result = await call(challanRouter, "POST", "/", body([LINE_A, 10]));
    assert.equal(result.status, 201, "the freed quantity can be dispatched again");
    assert.equal(result.body.challan.challanNumber, "CH/2026-27/0002", "a cancelled number is not reused");

    // Cancelling twice must not free the quantity twice.
    resetCounters();
    result = await call(challanRouter, "POST", `/${firstId}/cancel`, { reason: "Again" });
    assert.equal(result.status, 409);
    assert.equal(result.body.message, "This challan is already cancelled.");
    assert.equal(dispatched()[0], 10, "counters unchanged by the second cancel");
    assertCleanSession("cancel twice", { committed: false });

    // Two cancels at once: the quantity is freed exactly once.
    reset();
    await call(challanRouter, "POST", "/", body([LINE_A, 6]));
    await call(challanRouter, "POST", "/", body([LINE_A, 2]));
    const targetId = state.challans[0]._id;
    resetCounters();
    const cancels = await Promise.all([
      call(challanRouter, "POST", `/${targetId}/cancel`, { reason: "x" }),
      call(challanRouter, "POST", `/${targetId}/cancel`, { reason: "y" }),
    ]);
    assert.deepEqual(cancels.map((r) => r.status).sort(), [200, 409]);
    assert.equal(dispatched()[0], 2, "6 freed once, 2 remains dispatched");
    assert.equal(state.invoice.activeChallanCount, 1);
    assertNoStockOrLedgerWrites("double cancel");

    /* 7. Reversed (or unknown) invoices accept no challans. */
    reset();
    state.invoice.status = "reversed";
    result = await call(challanRouter, "POST", "/", body([LINE_A, 1]));
    assert.equal(result.status, 409);
    assert.equal(result.body.message, "Challans can be created only for active invoices.");
    assert.equal(state.challans.length, 0);
    assertCleanSession("reversed invoice", { committed: false });

    reset();
    state.invoice = null;
    result = await call(challanRouter, "POST", "/", body([LINE_A, 1]));
    assert.equal(result.status, 404);

    /* 8. Dates, ids and lines are validated before any session opens. */
    reset();
    for (const bad of [
      { ...body([LINE_A, 1]), challanDate: "2099-01-01" },
      { ...body([LINE_A, 1]), invoice: "nope" },
      { ...body([LINE_A, 1]), lines: [] },
      body([LINE_A, 0]),
      body([LINE_A, 1.5]),
      body([LINE_A, 1], [LINE_A, 2]),
      { ...body([LINE_A, 1]), transport: { vehicleNumber: "x".repeat(30) } },
    ]) {
      result = await call(challanRouter, "POST", "/", bad);
      assert.equal(result.status, 400, JSON.stringify(result.body));
    }
    assert.equal(counts.sessions, 0, "invalid payloads never open a session");

    // Checked inside the transaction (needs the invoice).
    reset();
    result = await call(challanRouter, "POST", "/", { ...body([LINE_A, 1]), challanDate: "2026-11-19" });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /before the invoice date/);
    assertCleanSession("date before invoice", { committed: false });

    reset();
    result = await call(challanRouter, "POST", "/", body([ID(90), 1]));
    assert.equal(result.status, 400);
    assert.match(result.body.message, /does not belong to this invoice/);
    assert.equal(state.challans.length, 0);

    /* 9. Failures abort once and end once; nothing half-written. */
    reset({ challanCreateThrows: true });
    result = await call(challanRouter, "POST", "/", body([LINE_A, 1]));
    assert.equal(result.status, 500);
    assert.equal(result.body.message, "Unable to create challan.");
    assert.equal(writes.invoiceUpdates, 0, "counters are not touched after a failed challan write");
    assertCleanSession("failed write", { committed: false });

    reset({ invoiceUpdateMatches: false });
    result = await call(challanRouter, "POST", "/", body([LINE_A, 1]));
    assert.equal(result.status, 409);
    assert.match(result.body.message, /invoice changed/);
    assertCleanSession("stale invoice", { committed: false });

    /* 10. Edit: transport details and notes only. */
    reset();
    await call(challanRouter, "POST", "/", body([LINE_A, 5]));
    const id = state.challans[0]._id;
    const countersBefore = JSON.stringify(state.invoice);
    resetCounters();
    result = await call(challanRouter, "PUT", `/${id}`, {
      transport: { transporterName: "VRL Logistics", vehicleNumber: "mh12 ab 99", lrNumber: "LR-9", lrDate: "2026-11-21" },
      notes: "Delivered to gate 2",
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.challan.transport.vehicleNumber, "MH12 AB 99");
    assert.equal(result.body.challan.notes, "Delivered to gate 2");
    assert.deepEqual(result.body.challan.lines.map((line) => line.quantity), [5], "quantities untouched");
    assert.equal(JSON.stringify(state.invoice), countersBefore, "an edit never touches the invoice");
    assert.equal(counts.sessions, 0, "a single-document update needs no transaction");

    for (const forbidden of [{ lines: [] }, { invoice: INVOICE }, { challanDate: "2026-11-23" }, { status: "active" }]) {
      result = await call(challanRouter, "PUT", `/${id}`, { notes: "x", ...forbidden });
      assert.equal(result.status, 400, JSON.stringify(forbidden));
      assert.match(result.body.message, /Only the transport details and notes/);
    }

    await call(challanRouter, "POST", `/${id}/cancel`, { reason: "Done" });
    result = await call(challanRouter, "PUT", `/${id}`, { notes: "late" });
    assert.equal(result.status, 409);
    assert.equal(result.body.message, "Only active challans can be edited.");
    result = await call(challanRouter, "PUT", `/${ID(99)}`, { notes: "x" });
    assert.equal(result.status, 404);

    /* 11. Dispatch summary and list. */
    reset();
    await call(challanRouter, "POST", "/", body([LINE_A, 6]));
    resetCounters();
    result = await call(challanRouter, "GET", `/invoice-dispatch/${INVOICE}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.dispatchStatus, "partial");
    assert.equal(result.body.canCreate, true);
    assert.deepEqual(
      result.body.lines.map((line) => [line.orderedQuantity, line.dispatchedQuantity, line.remainingQuantity]),
      [[10, 6, 4], [4, 0, 4]]
    );
    assert.equal(result.body.challans.length, 1);
    assert.equal(result.body.challans[0].totalQuantity, 6);
    assert.equal(counts.sessions, 0, "read-only: no session");
    assertNoStockOrLedgerWrites("dispatch summary");

    state.invoice.lines.forEach((line) => {
      line.dispatchedQuantity = line.quantity;
    });
    state.invoice.dispatchStatus = "full";
    result = await call(challanRouter, "GET", `/invoice-dispatch/${INVOICE}`);
    assert.equal(result.body.canCreate, false, "nothing remaining");
    state.invoice.status = "reversed";
    assert.equal((await call(challanRouter, "GET", `/invoice-dispatch/${INVOICE}`)).body.canCreate, false);
    assert.equal((await call(challanRouter, "GET", "/invoice-dispatch/bad")).status, 400);

    result = await callWithQuery(challanRouter, "/", { invoice: INVOICE, page: "1", limit: "20" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.total, 1);
    assert.equal(result.body.items[0].totalQuantity, 6);
    assert.equal(result.body.items[0].customerName, "Shree Medicals Pvt Ltd");
    assert.equal(result.body.items[0].invoiceNumber, "INV/2026-27/0003");
    assert.equal(state.lastChallanFilter.invoice, INVOICE, "filtered by invoice");
    assert.equal(
      (await callWithQuery(challanRouter, "/", { status: "shipped" })).status,
      400,
      "unknown status filter"
    );
    assert.equal((await callWithQuery(challanRouter, "/", { invoice: "bad" })).status, 400);
    assert.equal((await callWithQuery(challanRouter, "/", { from: "2026-12-01", to: "2026-11-01" })).status, 400);
    result = await callWithQuery(challanRouter, "/", { search: "CH/2026", customer: CUSTOMER, status: "active" });
    assert.equal(result.status, 200);
    assert.ok(state.lastChallanFilter.challanNumber.$regex.includes("CH/2026"));
    assert.equal((await call(challanRouter, "GET", `/${state.challans[0]._id}`)).status, 200);
    assert.equal((await call(challanRouter, "GET", `/${ID(98)}`)).status, 404);

    /* 12. Invoice reverse and edit are blocked while active challans exist. */
    reset();
    await call(challanRouter, "POST", "/", body([LINE_A, 5]));
    const challanId = state.challans[0]._id;
    const stockAfterChallan = state.items[ITEM_A].currentStock;

    resetCounters();
    result = await call(invoiceRouter, "POST", `/${INVOICE}/reverse`, { reason: "Wrong buyer" });
    assert.equal(result.status, 409);
    assert.equal(result.body.message, "Cancel the delivery challans for this invoice before reversing it.");
    assert.equal(writes.stockUpdates.length, 0, "no stock returned for dispatched goods");
    assert.equal(state.invoice.status, "active");
    assertCleanSession("reverse blocked", { committed: false });

    resetCounters();
    result = await call(invoiceRouter, "PUT", `/${INVOICE}`, { lines: [{ item: ITEM_A, quantity: 2 }] });
    assert.equal(result.status, 409);
    assert.match(result.body.message, /active delivery challans and cannot be edited/);
    assert.equal(writes.stockUpdates.length, 0);
    assertCleanSession("edit blocked", { committed: false });

    // After the challan is cancelled the invoice can be reversed, returning stock once.
    await call(challanRouter, "POST", `/${challanId}/cancel`, { reason: "Not shipped" });
    assert.equal(state.invoice.activeChallanCount, 0);
    assertNoStockOrLedgerWrites("cancel before reverse");
    resetCounters();
    result = await call(invoiceRouter, "POST", `/${INVOICE}/reverse`, { reason: "Wrong buyer" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(state.invoice.status, "reversed");
    assert.equal(writes.stockUpdates.length, 2, "the invoice reversal returns its own stock, once");
    assert.equal(state.items[ITEM_A].currentStock, stockAfterChallan + 10);
    assertCleanSession("reverse after cancel", { committed: true });
  } finally {
    console.error = originalConsoleError;
  }

  console.log("Challan session safety: all scenarios passed.");
})().catch((err) => {
  console.error = originalConsoleError;
  console.error(err);
  process.exit(1);
});
