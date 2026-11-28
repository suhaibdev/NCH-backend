/*
 * In-memory stand-in for the LoginAttempt model. It RUNS the real update
 * pipeline with a small evaluator of the operators the pipeline uses, so the
 * lockout rules under test are the ones MongoDB will execute.
 */
const assert = require("node:assert/strict");

const comparable = (value) => {
  if (value === undefined || value === null) return -Infinity; // null sorts first
  return value instanceof Date ? value.getTime() : value;
};

const evaluate = (expression, doc) => {
  if (typeof expression === "string" && expression.startsWith("$")) {
    return doc[expression.slice(1)];
  }
  if (expression === null || typeof expression !== "object" || expression instanceof Date) {
    return expression;
  }
  const [[operator, argument]] = Object.entries(expression);
  const args = () => argument.map((item) => evaluate(item, doc));

  switch (operator) {
    case "$gt": {
      const [a, b] = args();
      return comparable(a) > comparable(b);
    }
    case "$gte": {
      const [a, b] = args();
      return comparable(a) >= comparable(b);
    }
    case "$lte": {
      const [a, b] = args();
      return comparable(a) <= comparable(b);
    }
    case "$ne": {
      const [a, b] = args();
      return comparable(a) !== comparable(b);
    }
    case "$and":
      return args().every(Boolean);
    case "$or":
      return args().some(Boolean);
    case "$not":
      return !args()[0];
    case "$ifNull": {
      const [a, b] = args();
      return a === undefined || a === null ? b : a;
    }
    case "$cond": {
      const [test, yes, no] = argument;
      return evaluate(evaluate(test, doc) ? yes : no, doc);
    }
    case "$add": {
      const values = args();
      const sum = values.reduce((total, value) => total + comparable(value), 0);
      return values.some((value) => value instanceof Date) ? new Date(sum) : sum;
    }
    case "$max": {
      const present = args().filter((value) => value !== undefined && value !== null);
      return present.reduce((best, value) => (comparable(value) > comparable(best) ? value : best));
    }
    default:
      throw new Error(`Unsupported operator in test evaluator: ${operator}`);
  }
};

const applyPipeline = (document, pipeline) => {
  let current = { ...document };
  for (const stage of pipeline) {
    if (stage.$set) {
      const next = { ...current };
      // Every field in a stage reads the document as it entered the stage.
      for (const [field, expression] of Object.entries(stage.$set)) {
        const value = evaluate(expression, current);
        if (value !== undefined) next[field] = value;
      }
      current = next;
    } else if (stage.$unset) {
      stage.$unset.forEach((field) => delete current[field]);
    } else {
      throw new Error("Unsupported pipeline stage in test evaluator.");
    }
  }
  return current;
};

const createLoginAttemptFake = () => {
  const records = new Map();
  const lean = (work) => ({ lean: async () => work() });

  return {
    records,
    find(filter) {
      return lean(() =>
        filter.key.$in.filter((key) => records.has(key)).map((key) => ({ ...records.get(key) }))
      );
    },
    findOneAndUpdate(filter, update, options) {
      assert.ok(Array.isArray(update), "the failure update is one atomic pipeline");
      assert.deepEqual(options, { upsert: true, new: true });
      return lean(() => {
        const next = applyPipeline(records.get(filter.key) || { key: filter.key }, update);
        records.set(filter.key, next);
        return { ...next };
      });
    },
    async deleteOne(filter) {
      records.delete(filter.key);
    },
  };
};

module.exports = { applyPipeline, createLoginAttemptFake };
