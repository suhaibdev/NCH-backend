/*
 * Aggregation pipeline for GET /api/stock/summary (one pass, no documents loaded).
 * The low-stock test requires both fields to be numbers so it matches the old JS
 * comparison, where `undefined <= x` is false.
 */
const countWhen = (condition) => ({ $sum: { $cond: [condition, 1, 0] } });

const buildStockSummaryPipeline = () => [
  {
    $group: {
      _id: null,
      totalItems: { $sum: 1 },
      rawMaterial: countWhen({ $eq: ["$category", "raw_material"] }),
      washedRawMaterial: countWhen({ $eq: ["$category", "washed_raw_material"] }),
      finishedGoods: countWhen({ $eq: ["$category", "finished_goods"] }),
      lowStock: countWhen({
        $and: [
          { $isNumber: "$currentStock" },
          { $isNumber: "$minimumStock" },
          { $lte: ["$currentStock", "$minimumStock"] },
        ],
      }),
    },
  },
];

module.exports = { buildStockSummaryPipeline };
