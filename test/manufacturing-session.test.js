/*
 * Manufacturing create/reverse session safety, without MongoDB.
 * No two operations may run on the same session at once, and a failure must
 * abort the transaction once and end the session once.
 */
const assert = require("node:assert/strict");
const path = require("path");
const {
  root,
  tracker,
  counts,
  resetCounters,
  runOp,
  createFakeSession,
  fakeQuery,
  stub,
  call,
} = require("./helpers/sessionFakes");

const ID = (n) => `64b00000000000000000000${n}`;
const WASHED = ID(1);
const LABEL = ID(2);
const FINISHED = ID(3);
const LABEL_TYPE = ID(4);
const TYPE_A = ID(5);
const SUPPLIER = ID(6);
const ENTRY = ID(7);

const scenario = {};
const items = () => ({
  [WASHED]: { _id: WASHED, productName: "Washed", category: "washed_raw_material", stockType: TYPE_A, supplier: SUPPLIER, unit: "pcs", currentStock: 100 },
  [LABEL]: { _id: LABEL, productName: "Label", category: "raw_material", stockType: LABEL_TYPE, supplier: SUPPLIER, unit: "pcs", currentStock: 50 },
  [FINISHED]: { _id: FINISHED, productName: "Bandage", category: "finished_goods", stockType: TYPE_A, supplier: null, unit: "pcs", currentStock: 20 },
});

stub("src/models/ManufacturingCounter", {
  findOneAndUpdate: (f, u, options = {}) => runOp(options.session, () => ({ sequence: 3 })),
});
stub("src/models/StockType", {
  findOne: () => fakeQuery(() => ({ _id: LABEL_TYPE, name: "Label" })),
  findById: () => fakeQuery(() => ({ name: "Type A" })),
});
stub("src/models/Supplier", { findById: () => fakeQuery(() => ({ name: "Supplier" })) });
stub("src/models/StockItem", {
  findById: (id) => fakeQuery(() => items()[String(id)] || null),
  findOneAndUpdate: (filter, update, options = {}) =>
    runOp(options.session, () => {
      if (scenario.failStockUpdateFor === String(filter._id)) return null;
      const base = items()[String(filter._id)];
      return { ...base, currentStock: base.currentStock + Object.values(update.$inc)[0] };
    }),
});
stub("src/models/StockMovement", {
  create: (docs, options = {}) =>
    runOp(options.session, () => {
      if (scenario.movementThrows) throw new Error("movement write failed");
      return docs;
    }),
});

const makeEntry = () => ({
  _id: ENTRY,
  manufacturingNumber: "MF-2025-0003",
  status: "completed",
  reversed: false,
  output: { finishedStockItem: FINISHED, finishedStockItemName: "Bandage", unit: "pcs", quantityProduced: 5 },
  materials: [
    { item: WASHED, productName: "Washed", category: "washed_raw_material", unit: "pcs", quantityUsed: 10 },
    { item: LABEL, productName: "Label", category: "raw_material", unit: "pcs", quantityUsed: 5 },
  ],
  save(options = {}) {
    return runOp(options.session, () => this);
  },
  toObject() {
    return { _id: this._id, status: this.status };
  },
});
stub("src/models/ManufacturingEntry", {
  findOne: () => fakeQuery(() => null),
  findById: () => fakeQuery(() => makeEntry()),
  create: (docs, options = {}) =>
    runOp(options.session, () => [{ ...docs[0], _id: ENTRY, toObject: () => ({ _id: ENTRY, manufacturingNumber: docs[0].manufacturingNumber }) }]),
});

const router = require(path.join(root, "src/routes/manufacturing"));

const createBody = {
  inputs: [
    { stockItem: WASHED, quantityUsed: 10, wastage: 0 },
    { stockItem: LABEL, quantityUsed: 5, wastage: 0 },
  ],
  output: { finishedStockItem: FINISHED, quantityProduced: 5 },
  manufacturingDate: "2025-10-02",
  batchNumber: "B100",
};

const setScenario = (values = {}) => {
  Object.keys(scenario).forEach((key) => delete scenario[key]);
  Object.assign(scenario, values);
  resetCounters();
};

const originalConsoleError = console.error;

(async () => {
  console.error = () => {};
  try {
    // 0. Detector self-check.
    resetCounters();
    const session = createFakeSession();
    await Promise.all([fakeQuery(() => 1).session(session), fakeQuery(() => 2).session(session)]);
    assert.equal(tracker.maxActive, 2, "detector notices overlapping session operations");

    // 1. Create success.
    setScenario();
    let result = await call(router, "POST", "/", createBody);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.entry.manufacturingNumber, "MF-2025-0003");
    assert.equal(counts.commit, 1);
    assert.equal(counts.abort, 0);
    assert.equal(counts.end, 1);
    assert.ok(tracker.maxActive <= 1, "create: never two session operations at once");

    // 2. Create fails mid-transaction (movement write) -> 500, one abort, one end.
    setScenario({ movementThrows: true });
    result = await call(router, "POST", "/", createBody);
    assert.equal(result.status, 500);
    assert.equal(result.body.message, "Unable to complete manufacturing.");
    assert.equal(counts.abort, 1, "create failure aborts once");
    assert.equal(counts.end, 1, "create failure ends session once");
    assert.equal(counts.commit, 0);
    assert.ok(tracker.maxActive <= 1);

    // 3. Insufficient stock on the atomic update -> 400, one abort, one end.
    setScenario({ failStockUpdateFor: LABEL });
    result = await call(router, "POST", "/", createBody);
    assert.equal(result.status, 400);
    assert.match(result.body.message, /Insufficient Label stock/);
    assert.equal(counts.abort, 1);
    assert.equal(counts.end, 1);

    // 4. Reverse success.
    setScenario();
    result = await call(router, "POST", `/${ENTRY}/reverse`, { reason: "Entered by mistake" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(counts.commit, 1);
    assert.equal(counts.abort, 0);
    assert.equal(counts.end, 1);
    assert.ok(tracker.maxActive <= 1, "reverse: never two session operations at once");

    // 5. Reverse fails mid-transaction -> 500, one abort, one end.
    setScenario({ movementThrows: true });
    result = await call(router, "POST", `/${ENTRY}/reverse`, { reason: "Entered by mistake" });
    assert.equal(result.status, 500);
    assert.equal(result.body.message, "Unable to reverse manufacturing.");
    assert.equal(counts.abort, 1);
    assert.equal(counts.end, 1);
    assert.equal(counts.commit, 0);
  } finally {
    console.error = originalConsoleError;
  }

  console.log("Manufacturing session safety: 6 scenarios passed.");
})().catch((err) => {
  console.error = originalConsoleError;
  console.error(err);
  process.exit(1);
});
