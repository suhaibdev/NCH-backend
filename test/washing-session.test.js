/*
 * Washing send / complete session safety, without MongoDB.
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
const SOURCE = ID(1);
const WASHER = ID(2);
const DEST_TYPE = ID(3);
const SRC_TYPE = ID(4);
const SUPPLIER = ID(5);
const PROCESS = ID(6);
const DEST_ITEM = ID(7);
const size = { lengthValue: 2, lengthUnit: "m", widthValue: 1, widthUnit: "m" };

const scenario = {};

stub("src/models/StockItem", {
  findById: () =>
    fakeQuery(() => ({ _id: SOURCE, productName: "Raw", category: "raw_material", unit: "pcs", stockType: SRC_TYPE, supplier: SUPPLIER, size, currentStock: 100 })),
  findOneAndUpdate: (filter, update, options = {}) =>
    runOp(options.session, () => ({ _id: filter._id, productName: "Item", category: "washed_raw_material", currentStock: 110 })),
  find: () => fakeQuery(() => (scenario.existingDestination ? [{ _id: DEST_ITEM, currentStock: 10 }] : [])),
  create: (docs, options = {}) =>
    runOp(options.session, () => [{ _id: DEST_ITEM, productName: docs[0].productName, category: docs[0].category, currentStock: docs[0].currentStock }]),
});
stub("src/models/StockIdentityLock", {
  findOneAndUpdate: (f, u, options = {}) => runOp(options.session, () => ({ _id: "lock-1" })),
  updateOne: (f, u, options = {}) => runOp(options.session, () => ({})),
});
stub("src/models/StockMovement", {
  create: (docs, options = {}) =>
    runOp(options.session, () => {
      if (scenario.movementThrows) throw new Error("movement write failed");
      return docs;
    }),
});
stub("src/models/StockType", {
  findOne: (filter) =>
    fakeQuery(() =>
      filter.category === "raw_material"
        ? { _id: SRC_TYPE, name: "Raw Type" }
        : { _id: DEST_TYPE, name: "Washed Type" }
    ),
});
stub("src/models/Supplier", { findById: () => fakeQuery(() => ({ _id: SUPPLIER, name: "Supplier" })) });
stub("src/models/Washer", { findOne: () => fakeQuery(() => ({ _id: WASHER, name: "Washer" })) });

const processDoc = (extra = {}) => ({
  _id: PROCESS,
  quantity: 10,
  ratePerPiecePaise: 550,
  estimatedChargePaise: 5500,
  earnedAmountPaise: null,
  ...extra,
});
const makeProcess = () => {
  const doc = processDoc({
    status: "in_process",
    sentDate: new Date("2025-10-01T00:00:00.000Z"),
    destinationStockType: DEST_TYPE,
    supplier: SUPPLIER,
    supplierName: "Supplier",
    size,
    unit: "pcs",
    notes: "",
  });
  doc.save = (options = {}) => runOp(options.session, () => doc);
  doc.toObject = () => processDoc({ status: doc.status });
  return doc;
};
stub("src/models/WashingProcess", {
  findById: () => fakeQuery(() => makeProcess()),
  create: (docs, options = {}) => runOp(options.session, () => [{ ...processDoc(), toObject: () => processDoc() }]),
});

const router = require(path.join(root, "src/routes/washingProcesses"));

const sendBody = {
  sourceStockItem: SOURCE,
  washer: WASHER,
  destinationStockType: DEST_TYPE,
  quantity: "10",
  ratePerPiece: "5.50",
  sentDate: "2025-10-01",
};
const completeBody = { completedDate: "2025-10-05" };

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

    // 1. Send success.
    setScenario();
    let result = await call(router, "POST", "/", sendBody);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.sourceBalance, 110);
    assert.equal(counts.commit, 1);
    assert.equal(counts.abort, 0);
    assert.equal(counts.end, 1);
    assert.ok(tracker.maxActive <= 1, "send: never two session operations at once");

    // 2. Send fails mid-transaction -> 500, one abort, one end, generic text.
    setScenario({ movementThrows: true });
    result = await call(router, "POST", "/", sendBody);
    assert.equal(result.status, 500);
    assert.equal(result.body.message, "Unable to send goods to washing.");
    assert.equal(counts.abort, 1);
    assert.equal(counts.end, 1);
    assert.equal(counts.commit, 0);

    // 3. Complete success, creating a new washed stock item (lock path).
    setScenario();
    result = await call(router, "POST", `/${PROCESS}/complete`, completeBody);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(counts.commit, 1);
    assert.equal(counts.abort, 0);
    assert.equal(counts.end, 1);
    assert.ok(tracker.maxActive <= 1, "complete (new item): never two session operations at once");

    // 4. Complete success, adding to an existing washed stock item.
    setScenario({ existingDestination: true });
    result = await call(router, "POST", `/${PROCESS}/complete`, completeBody);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.destinationBalance, 110);
    assert.ok(tracker.maxActive <= 1, "complete (existing item): never two session operations at once");

    // 5. Complete fails mid-transaction -> 500, one abort, one end.
    setScenario({ movementThrows: true });
    result = await call(router, "POST", `/${PROCESS}/complete`, completeBody);
    assert.equal(result.status, 500);
    assert.equal(result.body.message, "Unable to complete washing process.");
    assert.equal(counts.abort, 1);
    assert.equal(counts.end, 1);
    assert.equal(counts.commit, 0);
  } finally {
    console.error = originalConsoleError;
  }

  console.log("Washing session safety: 6 scenarios passed.");
})().catch((err) => {
  console.error = originalConsoleError;
  console.error(err);
  process.exit(1);
});
