/* Pure tests for the optional-pagination helpers and list endpoint behavior (no DB). */
const assert = require("node:assert/strict");
const path = require("path");
const {
  CAPPED_HEADER,
  applyLegacyCap,
  buildPagedResponse,
  parseOptionalPagination,
  sendListResponse,
} = require("../src/utils/listQuery");

/* ---------------- parseOptionalPagination ---------------- */

// No ?page/?limit: legacy mode, one probe row beyond the cap.
assert.deepEqual(parseOptionalPagination({}, { cap: 1000 }), {
  paged: false,
  skip: 0,
  limit: 1001,
  cap: 1000,
});
// Either parameter switches to paged mode; values are clamped, never rejected.
assert.deepEqual(parseOptionalPagination({ page: "3", limit: "50" }, { cap: 1000 }), {
  paged: true, page: 3, limit: 50, skip: 100, cap: 1000,
});
assert.equal(parseOptionalPagination({ limit: "5000" }, { cap: 10, maxLimit: 100 }).limit, 100);
assert.equal(parseOptionalPagination({ page: "abc" }, { cap: 10 }).page, 1);
assert.equal(parseOptionalPagination({ page: "-4", limit: "0" }, { cap: 10 }).page, 1);
assert.equal(parseOptionalPagination({ page: "-4", limit: "0" }, { cap: 10 }).limit, 20);

/* ---------------- applyLegacyCap / buildPagedResponse ---------------- */

assert.deepEqual(applyLegacyCap([1, 2, 3], 3), { rows: [1, 2, 3], capped: false });
assert.deepEqual(applyLegacyCap([1, 2, 3, 4], 3), { rows: [1, 2, 3], capped: true });
assert.deepEqual(buildPagedResponse(["a"], { page: 2, limit: 10 }, 11), {
  items: ["a"], page: 2, limit: 10, total: 11, totalPages: 2,
});
assert.equal(buildPagedResponse([], { page: 1, limit: 10 }, 0).totalPages, 1);

/* ---------------- sendListResponse ---------------- */

// A chainable fake query over an in-memory array that records skip/limit.
const fakeQuery = (rows) => {
  const q = { skipN: 0, limitN: Infinity };
  q.skip = (n) => ((q.skipN = n), q);
  q.limit = (n) => ((q.limitN = n), q);
  q.then = (resolve, reject) =>
    Promise.resolve(rows.slice(q.skipN, q.skipN + q.limitN)).then(resolve, reject);
  return q;
};
const fakeRes = () => {
  const res = { headers: {}, body: undefined };
  res.set = (key, value) => ((res.headers[key] = value), res);
  res.json = (body) => ((res.body = body), res);
  return res;
};
const rows = Array.from({ length: 25 }, (_, i) => ({ n: i }));

(async () => {
  // Legacy mode under the cap: plain array, no header.
  let res = fakeRes();
  await sendListResponse(res, {}, { cap: 30 }, () => fakeQuery(rows), async () => rows.length);
  assert.equal(res.body.length, 25);
  assert.equal(res.headers[CAPPED_HEADER], undefined);

  // Legacy mode over the cap: truncated to the cap with the header set.
  res = fakeRes();
  await sendListResponse(res, {}, { cap: 10 }, () => fakeQuery(rows), async () => rows.length);
  assert.equal(res.body.length, 10);
  assert.equal(res.headers[CAPPED_HEADER], "true");
  assert.deepEqual(res.body[0], { n: 0 }, "order preserved");

  // Paged mode: envelope with total and totalPages; the transform is applied.
  res = fakeRes();
  await sendListResponse(
    res,
    { page: "2", limit: "10" },
    { cap: 10 },
    () => fakeQuery(rows),
    async () => rows.length,
    (items) => items.map((row) => row.n)
  );
  assert.deepEqual(res.body, {
    items: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    page: 2, limit: 10, total: 25, totalPages: 3,
  });

  /* ---------------- GET /attendance/range validation ---------------- */

  const stubModule = (relativePath, exports) => {
    const resolved = require.resolve(path.join(__dirname, "..", relativePath));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  };
  let lastFilter = null;
  const attendanceQuery = (filter) => {
    lastFilter = filter;
    const q = fakeQuery([{ employee: { name: "A" }, date: new Date("2026-11-02T00:00:00.000Z") }]);
    q.populate = () => q;
    q.sort = () => q;
    q.lean = () => q;
    return q;
  };
  stubModule("src/models/Attendance", {
    find: attendanceQuery,
    countDocuments: async () => 1,
    estimatedDocumentCount: async () => 1,
  });
  stubModule("src/models/Employee", {});
  stubModule("src/utils/attendanceLock", {
    ATTENDANCE_LOCK_CODE: "X",
    findAttendanceLocks: async () => [],
    lockedResponseBody: () => ({}),
  });
  const router = require("../src/routes/attendance");
  const handler = (routePath) =>
    router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods.get).route.stack[0].handle;
  const call = async (routePath, req) => {
    const out = { status: 200, body: undefined, headers: {} };
    const r = {
      status: (code) => ((out.status = code), r),
      json: (body) => ((out.body = body), r),
      set: (k, v) => ((out.headers[k] = v), r),
    };
    await handler(routePath)(req, r);
    return out;
  };

  const bad = [
    {},
    { startDate: "2026-11-01" },
    { startDate: "2026-11-01", endDate: "nope" },
    { startDate: "2026-02-30", endDate: "2026-03-01" },
    { startDate: "2026-11-30", endDate: "2026-11-01" },
    { startDate: "2024-01-01", endDate: "2026-01-01" },
    { startDate: "2026-11-01T00:00:00Z", endDate: "2026-11-30" },
  ];
  for (const query of bad) {
    const out = await call("/range", { query });
    assert.equal(out.status, 400, JSON.stringify(query));
    assert.ok(out.body.message);
  }
  // The frontend's month request still works, with the same inclusive filter.
  const ok = await call("/range", { query: { startDate: "2026-11-01", endDate: "2026-11-30" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.length, 1);
  assert.equal(lastFilter.date.$gte.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(lastFilter.date.$lte.toISOString(), "2026-11-30T00:00:00.000Z");
  // A single-day range is valid.
  assert.equal((await call("/range", { query: { startDate: "2026-11-05", endDate: "2026-11-05" } })).status, 200);

  // Invalid employee id is a 400, not a CastError 500.
  assert.equal((await call("/employee/:employeeId", { params: { employeeId: "xyz" }, query: {} })).status, 400);
  const good = await call("/employee/:employeeId", {
    params: { employeeId: "64b000000000000000000001" },
    query: {},
  });
  assert.equal(good.status, 200);

  console.log("List query helpers and attendance range validation: all assertions passed.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
