/*
 * Products a customer can be billed for: active CustomerProductPrice rows on
 * Finished Goods items, sorted by product name, paginated.
 * Used by the estimate and invoice forms. `includeTax` adds the item's HSN
 * code and GST rate (invoices only), so the estimate response is unchanged.
 */
const mongoose = require("mongoose");

const CustomerProductPrice = require("../models/CustomerProductPrice");
const StockItem = require("../models/StockItem");
const { buildPagedResponse } = require("./listQuery");
const { escapeRegex } = require("./salesTransactions");

const findPriceableProducts = async (customerId, { search = "", paging, includeTax = false }) => {
  const itemMatch = { "itemDoc.category": "finished_goods" };
  if (search) itemMatch["itemDoc.productName"] = { $regex: escapeRegex(search), $options: "i" };

  const item = {
    _id: "$itemDoc._id",
    productName: "$itemDoc.productName",
    unit: "$itemDoc.unit",
    currentStock: "$itemDoc.currentStock",
  };
  if (includeTax) {
    item.hsnCode = { $ifNull: ["$itemDoc.hsnCode", ""] };
    item.gstRatePercent = { $ifNull: ["$itemDoc.gstRatePercent", null] };
  }

  const [result] = await CustomerProductPrice.aggregate([
    { $match: { customer: new mongoose.Types.ObjectId(customerId), isActive: true } },
    {
      $lookup: {
        from: StockItem.collection.name,
        localField: "item",
        foreignField: "_id",
        as: "itemDoc",
      },
    },
    { $unwind: "$itemDoc" },
    { $match: itemMatch },
    { $sort: { "itemDoc.productName": 1, _id: 1 } },
    {
      $facet: {
        items: [
          { $skip: paging.skip },
          { $limit: paging.limit },
          { $project: { _id: 0, pricePaise: 1, item } },
        ],
        total: [{ $count: "count" }],
      },
    },
  ]);

  return buildPagedResponse(result?.items || [], paging, result?.total?.[0]?.count || 0);
};

module.exports = { findPriceableProducts };
