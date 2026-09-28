const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

const StockItem = require("../models/StockItem");
const StockMovement = require("../models/StockMovement");
const StockType = require("../models/StockType");

/* ==========================================================
   CONSTANTS
========================================================== */

const VALID_CATEGORIES = [
  "raw_material",
  "washed_raw_material",
  "finished_goods",
];

const VALID_UNITS = [
  "pcs",
  "dozen",
];


/* ==========================================================
   HELPERS
========================================================== */

const escapeRegex = (value = "") => {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
};


const cleanProductName = (value = "") => {
  return String(value)
    .trim()
    .replace(/\s+/g, " ");
};


const parseWholeNumber = (
  value,
  fieldName,
  {
    min = 0,
    allowZero = true,
  } = {}
) => {
  const number = Number(value);

  if (!Number.isInteger(number)) {
    return {
      valid: false,
      message: `${fieldName} must be a whole number.`,
    };
  }

  if (number < min) {
    return {
      valid: false,
      message: `${fieldName} cannot be less than ${min}.`,
    };
  }

  if (
    !allowZero &&
    number === 0
  ) {
    return {
      valid: false,
      message: `${fieldName} must be greater than 0.`,
    };
  }

  return {
    valid: true,
    value: number,
  };
};


const findDuplicateProduct = async (
  productName,
  excludeId = null,
  session = null
) => {
  const query = {
    productName: {
      $regex: `^${escapeRegex(
        productName
      )}$`,
      $options: "i",
    },
  };

  if (excludeId) {
    query._id = {
      $ne: excludeId,
    };
  }

  let request =
    StockItem.findOne(query);

  if (session) {
    request =
      request.session(session);
  }

  return request;
};


/* ==========================================================
   STOCK TYPES
========================================================== */


/* ==========================================================
   GET ALL STOCK TYPES

   GET /api/stock/types

   Optional:
   ?category=raw_material
========================================================== */

router.get(
  "/types",
  async (req, res) => {
    try {
      const {
        category,
      } = req.query;

      const query = {};

      if (category) {
        if (
          !VALID_CATEGORIES.includes(
            category
          )
        ) {
          return res
            .status(400)
            .json({
              message:
                "Invalid main stock category.",
            });
        }

        query.category =
          category;
      }

      const types =
        await StockType.find(
          query
        )
          .sort({
            category: 1,
            name: 1,
          })
          .lean();

      /*
       * Count how many stock products
       * currently use each Stock Type.
       */
      const productCounts =
        await StockItem.aggregate([
          {
            $match: {
              stockType: {
                $ne: null,
              },
            },
          },
          {
            $group: {
              _id: "$stockType",
              productCount: {
                $sum: 1,
              },
            },
          },
        ]);

      const countMap =
        new Map(
          productCounts.map(
            (row) => [
              String(row._id),
              row.productCount,
            ]
          )
        );

      const result =
        types.map(
          (type) => ({
            ...type,

            productCount:
              countMap.get(
                String(type._id)
              ) || 0,
          })
        );

      return res.json(result);
    } catch (err) {
      console.error(
        "GET STOCK TYPES ERROR:",
        err
      );

      return res
        .status(500)
        .json({
          message:
            "Unable to load stock types.",
        });
    }
  }
);


/* ==========================================================
   CREATE STOCK TYPE

   POST /api/stock/types

   Example:

   {
     "name": "Label",
     "category": "raw_material",
     "notes": ""
   }
========================================================== */

router.post(
  "/types",
  async (req, res) => {
    try {
      const {
        name,
        category,
        notes = "",
      } = req.body;

      const finalName =
        cleanProductName(name);

      if (!finalName) {
        return res
          .status(400)
          .json({
            message:
              "Stock Type name is required.",
          });
      }

      if (
        !VALID_CATEGORIES.includes(
          category
        )
      ) {
        return res
          .status(400)
          .json({
            message:
              "Please select a valid main category.",
          });
      }

      const normalizedName =
        finalName.toLowerCase();

      const duplicate =
        await StockType.findOne({
          category,
          normalizedName,
        }).lean();

      if (duplicate) {
        return res
          .status(409)
          .json({
            message:
              `Stock Type "${finalName}" already exists in this main category.`,
          });
      }

      const stockType =
        await StockType.create({
          name: finalName,

          normalizedName,

          category,

          notes:
            String(
              notes || ""
            ).trim(),
        });

      return res
        .status(201)
        .json({
          message:
            "Stock Type created successfully.",

          stockType: {
            ...stockType.toObject(),

            productCount: 0,
          },
        });
    } catch (err) {
      console.error(
        "CREATE STOCK TYPE ERROR:",
        err
      );

      if (
        err?.code === 11000
      ) {
        return res
          .status(409)
          .json({
            message:
              "This Stock Type already exists in the selected main category.",
          });
      }

      return res
        .status(500)
        .json({
          message:
            err.message ||
            "Unable to create Stock Type.",
        });
    }
  }
);


/* ==========================================================
   UPDATE STOCK TYPE

   PUT /api/stock/types/:id

   Name and notes can be changed.

   Main category can only change when
   no products currently use this type.
========================================================== */

router.put(
  "/types/:id",
  async (req, res) => {
    try {
      const {
        id,
      } = req.params;

      if (
        !mongoose.Types.ObjectId.isValid(
          id
        )
      ) {
        return res
          .status(400)
          .json({
            message:
              "Invalid Stock Type ID.",
          });
      }

      const stockType =
        await StockType.findById(
          id
        );

      if (!stockType) {
        return res
          .status(404)
          .json({
            message:
              "Stock Type not found.",
          });
      }

      const {
        name,
        category,
        notes,
      } = req.body;

      let nextName =
        stockType.name;

      let nextCategory =
        stockType.category;


      /* ------------------------------
         NAME
      ------------------------------ */

      if (
        name !== undefined
      ) {
        nextName =
          cleanProductName(
            name
          );

        if (!nextName) {
          return res
            .status(400)
            .json({
              message:
                "Stock Type name cannot be empty.",
            });
        }
      }


      /* ------------------------------
         CATEGORY
      ------------------------------ */

      if (
        category !== undefined
      ) {
        if (
          !VALID_CATEGORIES.includes(
            category
          )
        ) {
          return res
            .status(400)
            .json({
              message:
                "Invalid main stock category.",
            });
        }

        if (
          category !==
          stockType.category
        ) {
          const productCount =
            await StockItem.countDocuments({
              stockType:
                stockType._id,
            });

          if (
            productCount > 0
          ) {
            return res
              .status(400)
              .json({
                message:
                  `Main category cannot be changed because ${productCount} product${
                    productCount === 1
                      ? ""
                      : "s"
                  } currently use this Stock Type.`,
              });
          }
        }

        nextCategory =
          category;
      }


      /* ------------------------------
         DUPLICATE CHECK
      ------------------------------ */

      const normalizedName =
        nextName.toLowerCase();

      const duplicate =
        await StockType.findOne({
          _id: {
            $ne:
              stockType._id,
          },

          category:
            nextCategory,

          normalizedName,
        }).lean();

      if (duplicate) {
        return res
          .status(409)
          .json({
            message:
              `Stock Type "${nextName}" already exists in this main category.`,
          });
      }


      /* ------------------------------
         SAVE
      ------------------------------ */

      stockType.name =
        nextName;

      stockType.normalizedName =
        normalizedName;

      stockType.category =
        nextCategory;

      if (
        notes !== undefined
      ) {
        stockType.notes =
          String(
            notes || ""
          ).trim();
      }

      await stockType.save();

      const productCount =
        await StockItem.countDocuments({
          stockType:
            stockType._id,
        });

      return res.json({
        message:
          "Stock Type updated successfully.",

        stockType: {
          ...stockType.toObject(),

          productCount,
        },
      });
    } catch (err) {
      console.error(
        "UPDATE STOCK TYPE ERROR:",
        err
      );

      if (
        err?.code === 11000
      ) {
        return res
          .status(409)
          .json({
            message:
              "This Stock Type already exists in the selected main category.",
          });
      }

      return res
        .status(500)
        .json({
          message:
            err.message ||
            "Unable to update Stock Type.",
        });
    }
  }
);


/* ==========================================================
   DELETE STOCK TYPE

   DELETE /api/stock/types/:id

   Deletion is blocked when any stock
   product still uses this Stock Type.
========================================================== */

router.delete(
  "/types/:id",
  async (req, res) => {
    try {
      const {
        id,
      } = req.params;

      if (
        !mongoose.Types.ObjectId.isValid(
          id
        )
      ) {
        return res
          .status(400)
          .json({
            message:
              "Invalid Stock Type ID.",
          });
      }

      const stockType =
        await StockType.findById(
          id
        );

      if (!stockType) {
        return res
          .status(404)
          .json({
            message:
              "Stock Type not found.",
          });
      }

      const productCount =
        await StockItem.countDocuments({
          stockType:
            stockType._id,
        });

      if (
        productCount > 0
      ) {
        return res
          .status(400)
          .json({
            message:
              `Cannot delete "${stockType.name}". ${productCount} product${
                productCount === 1
                  ? " is"
                  : "s are"
              } using this Stock Type. Move those products to another Stock Type first.`,
          });
      }

      await StockType.deleteOne({
        _id:
          stockType._id,
      });

      return res.json({
        message:
          `Stock Type "${stockType.name}" deleted successfully.`,
      });
    } catch (err) {
      console.error(
        "DELETE STOCK TYPE ERROR:",
        err
      );

      return res
        .status(500)
        .json({
          message:
            err.message ||
            "Unable to delete Stock Type.",
        });
    }
  }
);


/* ==========================================================
   GET LOW STOCK ITEMS

   GET /api/stock/low-stock
========================================================== */

router.get(
  "/low-stock",
  async (req, res) => {
    try {
      const items =
        await StockItem.find({
          minimumStock: {
            $gt: 0,
          },

          $expr: {
            $lte: [
              "$currentStock",
              "$minimumStock",
            ],
          },
        })
          .sort({
            currentStock: 1,
            productName: 1,
          })
          .lean({
            virtuals: true,
          });

      return res.json({
        count: items.length,
        items,
      });
    } catch (err) {
      console.error(
        "GET LOW STOCK ERROR:",
        err
      );

      return res
        .status(500)
        .json({
          message:
            "Unable to load low stock items.",
        });
    }
  }
);


/* ==========================================================
   GET STOCK HISTORY

   GET /api/stock/history

   Optional query:
   ?itemId=
   ?movementType=
   ?startDate=
   ?endDate=
========================================================== */

router.get(
  "/history",
  async (req, res) => {
    try {
      const {
        itemId,
        movementType,
        startDate,
        endDate,
      } = req.query;

      const query = {};

      if (itemId) {
        if (
          !mongoose.Types.ObjectId.isValid(
            itemId
          )
        ) {
          return res
            .status(400)
            .json({
              message:
                "Invalid stock item ID.",
            });
        }

        query.item = itemId;
      }

      if (movementType) {
        query.movementType =
          movementType;
      }

      if (
        startDate ||
        endDate
      ) {
        query.movementDate = {};

        if (startDate) {
          const start =
            new Date(startDate);

          if (
            Number.isNaN(
              start.getTime()
            )
          ) {
            return res
              .status(400)
              .json({
                message:
                  "Invalid start date.",
              });
          }

          start.setHours(
            0,
            0,
            0,
            0
          );

          query.movementDate.$gte =
            start;
        }

        if (endDate) {
          const end =
            new Date(endDate);

          if (
            Number.isNaN(
              end.getTime()
            )
          ) {
            return res
              .status(400)
              .json({
                message:
                  "Invalid end date.",
              });
          }

          end.setHours(
            23,
            59,
            59,
            999
          );

          query.movementDate.$lte =
            end;
        }
      }

      const history =
        await StockMovement.find(
          query
        )
          .populate(
            "item",
            "productName category unit currentStock minimumStock"
          )
          .sort({
            movementDate: -1,
            createdAt: -1,
          })
          .limit(500)
          .lean();

      return res.json(history);
    } catch (err) {
      console.error(
        "GET STOCK HISTORY ERROR:",
        err
      );

      return res
        .status(500)
        .json({
          message:
            "Unable to load stock history.",
        });
    }
  }
);


/* ==========================================================
   GET STOCK SUMMARY

   GET /api/stock/summary
========================================================== */

router.get(
  "/summary",
  async (req, res) => {
    try {
      const items =
        await StockItem.find()
          .lean();

      const summary = {
        totalItems:
          items.length,

        rawMaterial: 0,

        washedRawMaterial: 0,

        finishedGoods: 0,

        lowStock: 0,
      };

      items.forEach(
        (item) => {
          if (
            item.category ===
            "raw_material"
          ) {
            summary.rawMaterial +=
              1;
          }

          if (
            item.category ===
            "washed_raw_material"
          ) {
            summary.washedRawMaterial +=
              1;
          }

          if (
            item.category ===
            "finished_goods"
          ) {
            summary.finishedGoods +=
              1;
          }

          if (
            item.minimumStock > 0 &&
            item.currentStock <=
              item.minimumStock
          ) {
            summary.lowStock +=
              1;
          }
        }
      );

      return res.json(summary);
    } catch (err) {
      console.error(
        "GET STOCK SUMMARY ERROR:",
        err
      );

      return res
        .status(500)
        .json({
          message:
            "Unable to load stock summary.",
        });
    }
  }
);


/* ==========================================================
   GET ALL STOCK ITEMS

   GET /api/stock

   Optional:
   ?category=raw_material
   ?search=abc
========================================================== */

router.get(
  "/",
  async (req, res) => {
    try {
      const {
        category,
        search,
      } = req.query;

      const query = {};

      if (category) {
        if (
          !VALID_CATEGORIES.includes(
            category
          )
        ) {
          return res
            .status(400)
            .json({
              message:
                "Invalid stock category.",
            });
        }

        query.category =
          category;
      }

      if (
        search &&
        search.trim()
      ) {
        query.productName = {
          $regex:
            escapeRegex(
              search.trim()
            ),

          $options: "i",
        };
      }

      const items =
        await StockItem.find(
          query
        )
          .sort({
            productName: 1,
          });

      return res.json(items);
    } catch (err) {
      console.error(
        "GET STOCK ERROR:",
        err
      );

      return res
        .status(500)
        .json({
          message:
            "Unable to load stock items.",
        });
    }
  }
);

/* ==========================================================
   GET ALL STOCK ITEMS

   GET /api/stock

   Optional:
   ?category=raw_material
   ?stockType=STOCK_TYPE_ID
   ?search=label
========================================================== */

router.get(
  "/",
  async (req, res) => {
    try {
      const {
        category,
        stockType,
        search,
      } = req.query;

      const query = {};


      /* ------------------------------
         MAIN CATEGORY FILTER
      ------------------------------ */

      if (category) {
        if (
          !VALID_CATEGORIES.includes(
            category
          )
        ) {
          return res
            .status(400)
            .json({
              message:
                "Invalid stock category.",
            });
        }

        query.category =
          category;
      }


      /* ------------------------------
         STOCK TYPE FILTER

         Used by dedicated pages such as:
         Label
         Wrapper
         Cotton
      ------------------------------ */

      if (stockType) {
        if (
          !mongoose.Types.ObjectId.isValid(
            stockType
          )
        ) {
          return res
            .status(400)
            .json({
              message:
                "Invalid Stock Type ID.",
            });
        }

        query.stockType =
          stockType;
      }


      /* ------------------------------
         GLOBAL SEARCH

         Searches:
         1. Product name
         2. Stock Type name

         No category is required,
         so it can search ALL stock.
      ------------------------------ */

      if (
        search &&
        search.trim()
      ) {
        const searchText =
          search.trim();

        const searchRegex = {
          $regex:
            escapeRegex(
              searchText
            ),
          $options: "i",
        };

        const matchingTypes =
          await StockType.find({
            name: searchRegex,
          })
            .select("_id")
            .lean();

        const matchingTypeIds =
          matchingTypes.map(
            (type) =>
              type._id
          );

        query.$or = [
          {
            productName:
              searchRegex,
          },
        ];

        if (
          matchingTypeIds.length >
          0
        ) {
          query.$or.push({
            stockType: {
              $in:
                matchingTypeIds,
            },
          });
        }
      }


      const items =
        await StockItem.find(
          query
        )
          .populate(
            "stockType",
            "name category notes"
          )
          .sort({
            productName: 1,
          });


      return res.json(
        items
      );
    } catch (err) {
      console.error(
        "GET STOCK ERROR:",
        err
      );

      return res
        .status(500)
        .json({
          message:
            "Unable to load stock items.",
        });
    }
  }
);


/* ==========================================================
   CREATE STOCK ITEM

   POST /api/stock

   Body example:

   {
     "productName": "ABC Cotton Bandage 10cm",
     "category": "raw_material",
     "unit": "pcs",
     "openingStock": 20,
     "minimumStock": 5,
     "notes": ""
   }
========================================================== */

router.post(
  "/",
  async (req, res) => {
    let session = null;

    try {
      const {
        productName,
        category,
        unit,
        openingStock = 0,
        minimumStock = 0,
        notes = "",
      } = req.body;

      const finalName =
        cleanProductName(
          productName
        );

      if (!finalName) {
        return res
          .status(400)
          .json({
            message:
              "Product name is required.",
          });
      }

      if (
        !VALID_CATEGORIES.includes(
          category
        )
      ) {
        return res
          .status(400)
          .json({
            message:
              "Please select a valid category.",
          });
      }

      if (
        !VALID_UNITS.includes(
          unit
        )
      ) {
        return res
          .status(400)
          .json({
            message:
              "Unit must be PCS or Dozen.",
          });
      }

      const openingCheck =
        parseWholeNumber(
          openingStock,
          "Opening stock"
        );

      if (
        !openingCheck.valid
      ) {
        return res
          .status(400)
          .json({
            message:
              openingCheck.message,
          });
      }

      const minimumCheck =
        parseWholeNumber(
          minimumStock,
          "Minimum stock"
        );

      if (
        !minimumCheck.valid
      ) {
        return res
          .status(400)
          .json({
            message:
              minimumCheck.message,
          });
      }

      session =
        await mongoose.startSession();

      session.startTransaction();

      const duplicate =
        await findDuplicateProduct(
          finalName,
          null,
          session
        );

      if (duplicate) {
        await session.abortTransaction();

        return res
          .status(409)
          .json({
            message:
              "A stock product with this name already exists.",
          });
      }

      const item =
        new StockItem({
          productName:
            finalName,

          category,

          unit,

          currentStock:
            openingCheck.value,

          minimumStock:
            minimumCheck.value,

          notes:
            String(
              notes || ""
            ).trim(),
        });

      await item.save({
        session,
      });

      /*
       * Opening stock is also saved
       * in stock history.
       */
      if (
        openingCheck.value >
        0
      ) {
        await StockMovement.create(
          [
            {
              item:
                item._id,

              productName:
                item.productName,

              category:
                item.category,

              unit:
                item.unit,

              direction:
                "in",

              movementType:
                "stock_in",

              quantity:
                openingCheck.value,

              balanceBefore:
                0,

              balanceAfter:
                openingCheck.value,

              reason:
                "Opening stock",

              notes: "",

              referenceType:
                "manual",

              movementDate:
                new Date(),

              createdBy:
                "Admin",
            },
          ],
          {
            session,
          }
        );
      }

      await session.commitTransaction();

      return res
        .status(201)
        .json({
          message:
            "Stock item created successfully.",

          item,
        });
    } catch (err) {
      if (
        session?.inTransaction()
      ) {
        await session.abortTransaction();
      }

      console.error(
        "CREATE STOCK ERROR:",
        err
      );

      return res
        .status(500)
        .json({
          message:
            err.message ||
            "Unable to create stock item.",
        });
    } finally {
      if (session) {
        session.endSession();
      }
    }
  }
);


/* ==========================================================
   UPDATE STOCK ITEM DETAILS

   PUT /api/stock/:id

   This DOES NOT directly change stock quantity.
========================================================== */

router.put(
  "/:id",
  async (req, res) => {
    try {
      const {
        id,
      } = req.params;

      if (
        !mongoose.Types.ObjectId.isValid(
          id
        )
      ) {
        return res
          .status(400)
          .json({
            message:
              "Invalid stock item ID.",
          });
      }

      const item =
        await StockItem.findById(
          id
        );

      if (!item) {
        return res
          .status(404)
          .json({
            message:
              "Stock item not found.",
          });
      }

      const {
        productName,
        category,
        unit,
        stockType,
        minimumStock,
        notes,
      } = req.body;

      if (
        productName !==
        undefined
      ) {
        const finalName =
          cleanProductName(
            productName
          );

        if (!finalName) {
          return res
            .status(400)
            .json({
              message:
                "Product name cannot be empty.",
            });
        }

        const duplicate =
          await findDuplicateProduct(
            finalName,
            item._id
          );

        if (duplicate) {
          return res
            .status(409)
            .json({
              message:
                "Another stock product already uses this name.",
            });
        }

        item.productName =
          finalName;
      }

      if (
        minimumStock !==
        undefined
      ) {
        const minimumCheck =
          parseWholeNumber(
            minimumStock,
            "Minimum stock"
          );

        if (
          !minimumCheck.valid
        ) {
          return res
            .status(400)
            .json({
              message:
                minimumCheck.message,
            });
        }

        item.minimumStock =
          minimumCheck.value;
      }

      if (
        notes !== undefined
      ) {
        item.notes =
          String(
            notes || ""
          ).trim();
      }

      /*
       * Category/unit should not be casually
       * changed after stock movements exist,
       * because old history would become confusing.
       */
      if (
        category !== undefined ||
        unit !== undefined
      ) {
        const movementExists =
          await StockMovement.exists({
            item: item._id,
          });

        if (
          movementExists ||
          item.currentStock > 0
        ) {
          if (
            category !== undefined &&
            category !==
              item.category
          ) {
            return res
              .status(400)
              .json({
                message:
                  "Category cannot be changed after stock activity has started.",
              });
          }

          if (
            unit !== undefined &&
            unit !== item.unit
          ) {
            return res
              .status(400)
              .json({
                message:
                  "Unit cannot be changed after stock activity has started.",
              });
          }
        }

        if (
          category !== undefined
        ) {
          if (
            !VALID_CATEGORIES.includes(
              category
            )
          ) {
            return res
              .status(400)
              .json({
                message:
                  "Invalid stock category.",
              });
          }

          item.category =
            category;
        }

        if (
          unit !== undefined
        ) {
          if (
            !VALID_UNITS.includes(
              unit
            )
          ) {
            return res
              .status(400)
              .json({
                message:
                  "Invalid stock unit.",
              });
          }

          item.unit = unit;
        }
      }

      await item.save();

      return res.json({
        message:
          "Stock item updated successfully.",

        item,
      });
    } catch (err) {
      console.error(
        "UPDATE STOCK ITEM ERROR:",
        err
      );

      return res
        .status(500)
        .json({
          message:
            err.message ||
            "Unable to update stock item.",
        });
    }
  }
);


/* ==========================================================
   STOCK IN

   POST /api/stock/:id/in

   {
      "quantity": 10,
      "reason": "Received stock",
      "notes": ""
   }
========================================================== */

router.post(
  "/:id/in",
  async (req, res) => {
    let session = null;

    try {
      const {
        id,
      } = req.params;

      if (
        !mongoose.Types.ObjectId.isValid(
          id
        )
      ) {
        return res
          .status(400)
          .json({
            message:
              "Invalid stock item ID.",
          });
      }

      const quantityCheck =
        parseWholeNumber(
          req.body.quantity,
          "Quantity",
          {
            min: 1,
            allowZero: false,
          }
        );

      if (
        !quantityCheck.valid
      ) {
        return res
          .status(400)
          .json({
            message:
              quantityCheck.message,
          });
      }

      session =
        await mongoose.startSession();

      session.startTransaction();

      const updatedItem =
        await StockItem.findOneAndUpdate(
          {
            _id: id,
          },
          {
            $inc: {
              currentStock:
                quantityCheck.value,
            },
          },
          {
            new: true,
            session,
            runValidators: true,
          }
        );

      if (!updatedItem) {
        await session.abortTransaction();

        return res
          .status(404)
          .json({
            message:
              "Stock item not found.",
          });
      }

      const balanceAfter =
        updatedItem.currentStock;

      const balanceBefore =
        balanceAfter -
        quantityCheck.value;

      await StockMovement.create(
        [
          {
            item:
              updatedItem._id,

            productName:
              updatedItem.productName,

            category:
              updatedItem.category,

            unit:
              updatedItem.unit,

            direction:
              "in",

            movementType:
              "stock_in",

            quantity:
              quantityCheck.value,

            balanceBefore,

            balanceAfter,

            reason:
              String(
                req.body.reason ||
                ""
              ).trim(),

            notes:
              String(
                req.body.notes ||
                ""
              ).trim(),

            referenceType:
              "manual",

            movementDate:
              new Date(),

            createdBy:
              "Admin",
          },
        ],
        {
          session,
        }
      );

      await session.commitTransaction();

      return res.json({
        message:
          `Stock added successfully. Current stock: ${updatedItem.currentStock} ${updatedItem.unit}.`,

        item:
          updatedItem,

        lowStock:
          updatedItem.minimumStock >
            0 &&
          updatedItem.currentStock <=
            updatedItem.minimumStock,
      });
    } catch (err) {
      if (
        session?.inTransaction()
      ) {
        await session.abortTransaction();
      }

      console.error(
        "STOCK IN ERROR:",
        err
      );

      return res
        .status(500)
        .json({
          message:
            err.message ||
            "Unable to add stock.",
        });
    } finally {
      if (session) {
        session.endSession();
      }
    }
  }
);


/* ==========================================================
   STOCK OUT

   POST /api/stock/:id/out

   Negative stock is NEVER allowed.
========================================================== */

router.post(
  "/:id/out",
  async (req, res) => {
    let session = null;

    try {
      const {
        id,
      } = req.params;

      if (
        !mongoose.Types.ObjectId.isValid(
          id
        )
      ) {
        return res
          .status(400)
          .json({
            message:
              "Invalid stock item ID.",
          });
      }

      const quantityCheck =
        parseWholeNumber(
          req.body.quantity,
          "Quantity",
          {
            min: 1,
            allowZero: false,
          }
        );

      if (
        !quantityCheck.valid
      ) {
        return res
          .status(400)
          .json({
            message:
              quantityCheck.message,
          });
      }

      session =
        await mongoose.startSession();

      session.startTransaction();

      /*
       * The currentStock condition makes this
       * safe even if two requests happen close
       * together.
       */
      const updatedItem =
        await StockItem.findOneAndUpdate(
          {
            _id: id,

            currentStock: {
              $gte:
                quantityCheck.value,
            },
          },
          {
            $inc: {
              currentStock:
                -quantityCheck.value,
            },
          },
          {
            new: true,
            session,
            runValidators: true,
          }
        );

      if (!updatedItem) {
        const existingItem =
          await StockItem.findById(
            id
          )
            .session(session)
            .lean();

        await session.abortTransaction();

        if (!existingItem) {
          return res
            .status(404)
            .json({
              message:
                "Stock item not found.",
            });
        }

        return res
          .status(400)
          .json({
            message:
              `Insufficient stock. Requested ${quantityCheck.value} ${existingItem.unit}, but only ${existingItem.currentStock} ${existingItem.unit} is available.`,

            shortage:
              Math.max(
                0,
                quantityCheck.value -
                  existingItem.currentStock
              ),

            available:
              existingItem.currentStock,

            requested:
              quantityCheck.value,

            unit:
              existingItem.unit,
          });
      }

      const balanceAfter =
        updatedItem.currentStock;

      const balanceBefore =
        balanceAfter +
        quantityCheck.value;

      await StockMovement.create(
        [
          {
            item:
              updatedItem._id,

            productName:
              updatedItem.productName,

            category:
              updatedItem.category,

            unit:
              updatedItem.unit,

            direction:
              "out",

            movementType:
              "stock_out",

            quantity:
              quantityCheck.value,

            balanceBefore,

            balanceAfter,

            reason:
              String(
                req.body.reason ||
                ""
              ).trim(),

            notes:
              String(
                req.body.notes ||
                ""
              ).trim(),

            referenceType:
              "manual",

            movementDate:
              new Date(),

            createdBy:
              "Admin",
          },
        ],
        {
          session,
        }
      );

      await session.commitTransaction();

      const lowStock =
        updatedItem.minimumStock >
          0 &&
        updatedItem.currentStock <=
          updatedItem.minimumStock;

      return res.json({
        message:
          lowStock
            ? `Stock removed successfully. Warning: ${updatedItem.productName} is now low on stock.`
            : `Stock removed successfully. Current stock: ${updatedItem.currentStock} ${updatedItem.unit}.`,

        item:
          updatedItem,

        lowStock,
      });
    } catch (err) {
      if (
        session?.inTransaction()
      ) {
        await session.abortTransaction();
      }

      console.error(
        "STOCK OUT ERROR:",
        err
      );

      return res
        .status(500)
        .json({
          message:
            err.message ||
            "Unable to remove stock.",
        });
    } finally {
      if (session) {
        session.endSession();
      }
    }
  }
);


/* ==========================================================
   GET HISTORY OF ONE PRODUCT

   GET /api/stock/:id/history
========================================================== */

router.get(
  "/:id/history",
  async (req, res) => {
    try {
      const {
        id,
      } = req.params;

      if (
        !mongoose.Types.ObjectId.isValid(
          id
        )
      ) {
        return res
          .status(400)
          .json({
            message:
              "Invalid stock item ID.",
          });
      }

      const item =
        await StockItem.findById(
          id
        ).lean();

      if (!item) {
        return res
          .status(404)
          .json({
            message:
              "Stock item not found.",
          });
      }

      const history =
        await StockMovement.find({
          item: id,
        })
          .sort({
            movementDate: -1,
            createdAt: -1,
          })
          .lean();

      return res.json({
        item,
        history,
      });
    } catch (err) {
      console.error(
        "GET ITEM HISTORY ERROR:",
        err
      );

      return res
        .status(500)
        .json({
          message:
            "Unable to load product stock history.",
        });
    }
  }
);


module.exports = router;