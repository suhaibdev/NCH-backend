/*
 * Customer estimate account vs invoice account after conversion (no DB).
 *
 * The real GET /api/customers/:id/estimate-account and /invoice-account
 * routes run against in-memory data through a tiny $match/$group evaluator,
 * so the pipelines' filters are actually exercised: a converted estimate
 * must be excluded from the estimate total and outstanding, its transferred
 * payments must not count as estimate payments, and the money must appear
 * exactly once, in the invoice account.
 */
const assert = require("node:assert/strict");
const path = require("path");
const { root, stub, call } = require("./helpers/sessionFakes");

const ID = (n) => `64f0000000000000000000${String(n).padStart(2, "0")}`;
const CUSTOMER = ID(1);

const data = { estimates: [], estimatePayments: [], invoices: [], invoicePayments: [] };

const matches = (doc, filter) =>
  Object.entries(filter).every(([key, expected]) => {
    const actual = doc[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !expected._bsontype) {
      if ("$ne" in expected) return String(actual) !== String(expected.$ne);
      throw new Error(`unsupported operator in test evaluator: ${JSON.stringify(expected)}`);
    }
    return String(actual) === String(expected);
  });

const aggregate = (collection) => async (pipeline) => {
  const [{ $match }, { $group }] = pipeline;
  const rows = data[collection].filter((doc) => matches(doc, $match));
  const groups = new Map();
  rows.forEach((doc) => {
    const key = $group._id === null ? null : doc[$group._id.replace("$", "")];
    const group = groups.get(key) || { _id: key };
    Object.entries($group).forEach(([field, spec]) => {
      if (field === "_id") return;
      if (spec.$sum === 1) group[field] = (group[field] || 0) + 1;
      else group[field] = (group[field] || 0) + doc[spec.$sum.replace("$", "")];
    });
    groups.set(key, group);
  });
  return [...groups.values()];
};

stub("src/models/Customer", { exists: async () => ({ _id: CUSTOMER }) });
stub("src/models/CustomerProductPrice", {});
stub("src/models/StockItem", {});
stub("src/models/Estimate", { aggregate: aggregate("estimates") });
stub("src/models/EstimatePayment", { aggregate: aggregate("estimatePayments") });
stub("src/models/Invoice", { aggregate: aggregate("invoices") });
stub("src/models/InvoicePayment", { aggregate: aggregate("invoicePayments") });

const router = require(path.join(root, "src/routes/customers"));

const estimate = (overrides) => ({ customer: CUSTOMER, status: "active", totalPaise: 0, ...overrides });
const estimatePayment = (overrides) => ({
  customer: CUSTOMER,
  amountPaise: 0,
  voided: false,
  transferred: false,
  ...overrides,
});

(async () => {
  // Before conversion: 3 active estimates (E1 100000, E2 50000, E3 53328), E3 has 30000 paid.
  data.estimates = [
    estimate({ _id: "E1", totalPaise: 100000 }),
    estimate({ _id: "E2", totalPaise: 50000 }),
    estimate({ _id: "E3", totalPaise: 53328 }),
    estimate({ _id: "E4", status: "cancelled", totalPaise: 70000 }),
  ];
  data.estimatePayments = [
    estimatePayment({ _id: "P1", estimate: "E3", amountPaise: 10000 }),
    estimatePayment({ _id: "P2", estimate: "E3", amountPaise: 20000 }),
    estimatePayment({ _id: "P3", estimate: "E1", amountPaise: 5000, voided: true }),
  ];

  let result = await call(router, "GET", `/${CUSTOMER}/estimate-account`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, {
    activeCount: 3,
    cancelledCount: 1,
    convertedCount: 0,
    totalEstimatedPaise: 203328,
    totalPaidPaise: 30000,
    outstandingPaise: 173328,
    paymentCount: 2,
  });

  result = await call(router, "GET", `/${CUSTOMER}/invoice-account`);
  assert.deepEqual(result.body, {
    activeCount: 0,
    reversedCount: 0,
    totalInvoicedPaise: 0,
    totalPaidPaise: 0,
    outstandingPaise: 0,
    paymentCount: 0,
  });

  // Convert E3: it becomes "converted", its payments are transferred, and an
  // invoice (total 59900) with the two carried payments is created.
  data.estimates[2].status = "converted";
  data.estimatePayments[0].transferred = true;
  data.estimatePayments[1].transferred = true;
  data.invoices = [{ _id: "I1", customer: CUSTOMER, status: "active", totalPaise: 59900 }];
  data.invoicePayments = [
    { _id: "IP1", invoice: "I1", customer: CUSTOMER, amountPaise: 10000, voided: false },
    { _id: "IP2", invoice: "I1", customer: CUSTOMER, amountPaise: 20000, voided: false },
  ];

  result = await call(router, "GET", `/${CUSTOMER}/estimate-account`);
  assert.deepEqual(
    result.body,
    {
      activeCount: 2,
      cancelledCount: 1,
      convertedCount: 1,
      totalEstimatedPaise: 150000,
      totalPaidPaise: 0,
      outstandingPaise: 150000,
      paymentCount: 0,
    },
    "converted estimate excluded from the estimate total, paid and outstanding"
  );
  assert.equal(result.body.totalEstimatedPaise, 100000 + 50000, "E3 (53328) is no longer counted");
  assert.equal(result.body.paymentCount, 0, "transferred payments are not estimate payments");

  result = await call(router, "GET", `/${CUSTOMER}/invoice-account`);
  assert.deepEqual(result.body, {
    activeCount: 1,
    reversedCount: 0,
    totalInvoicedPaise: 59900,
    totalPaidPaise: 30000,
    outstandingPaise: 29900,
    paymentCount: 2,
  });

  // No double counting: the 30000 received is counted once, in the invoice ledger.
  const estimateAccount = (await call(router, "GET", `/${CUSTOMER}/estimate-account`)).body;
  const invoiceAccount = result.body;
  assert.equal(estimateAccount.totalPaidPaise + invoiceAccount.totalPaidPaise, 30000);

  // Reversing the converted invoice moves nothing back into the estimate account.
  data.invoices[0].status = "reversed";
  data.invoicePayments.forEach((payment) => {
    payment.voided = true;
  });
  const afterReversal = {
    estimate: (await call(router, "GET", `/${CUSTOMER}/estimate-account`)).body,
    invoice: (await call(router, "GET", `/${CUSTOMER}/invoice-account`)).body,
  };
  assert.equal(afterReversal.estimate.totalEstimatedPaise, 150000, "the estimate stays converted");
  assert.equal(afterReversal.estimate.convertedCount, 1);
  assert.equal(afterReversal.invoice.totalInvoicedPaise, 0);
  assert.equal(afterReversal.invoice.reversedCount, 1);

  console.log("Customer estimate and invoice accounts after conversion: all assertions passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
