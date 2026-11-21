const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

const StockItem = require("../models/StockItem");
const StockMovement = require("../models/StockMovement");
const StockType = require("../models/StockType");
const Supplier = require("../models/Supplier");
const CustomerProductPrice = require("../models/CustomerProductPrice");
const {
  DEFAULT_GST_RATE_PERCENT,
  validateTaxMetadata,
} = require("../utils/gst");
const {
  applyLegacyCap,
  parseOptionalPagination,
  sendListResponse,
  withStockVirtuals,
} = require("../utils/listQuery");
const { buildStockSummaryPipeline } = require("../utils/stockSummary");

// Hard safety caps for list endpoints (legacy mode, no ?page/?limit).
const STOCK_LIST_CAP = 2000;
const STOCK_TYPE_LIST_CAP = 500;
const ITEM_HISTORY_CAP = 1000;


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

const VALID_SIZE_UNITS = [
  "m",
  "cm",
  "inch",
  "ft",
];

const normalizeBoolean = (value) =>
  value === true || value === "true";


/* ==========================================================
   HELPERS
========================================================== */

const escapeRegex = (value = "") => {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
};


const cleanText = (value = "") => {
  return String(value)
    .trim()
    .replace(/\s+/g, " ");
};


const cleanProductName = (
  value = ""
) => {
  return cleanText(value);
};


const parseWholeNumber = (
  value,
  fieldName,
  {
    min = 0,
    allowZero = true,
  } = {}
) => {
  const number =
    Number(value);

  if (
    !Number.isInteger(
      number
    )
  ) {
    return {
      valid: false,

      message:
        `${fieldName} must be a whole number.`,
    };
  }


  if (
    number < min
  ) {
    return {
      valid: false,

      message:
        `${fieldName} cannot be less than ${min}.`,
    };
  }


  if (
    !allowZero &&
    number === 0
  ) {
    return {
      valid: false,

      message:
        `${fieldName} must be greater than 0.`,
    };
  }


  return {
    valid: true,
    value: number,
  };
};


const normalizeSize = (
  size,
  required = false
) => {
  const fields = [
    "lengthValue",
    "lengthUnit",
    "widthValue",
    "widthUnit",
  ];

  const isEmpty =
    !size ||
    typeof size !== "object" ||
    fields.every(
      (field) =>
        size[field] === undefined ||
        size[field] === null ||
        String(size[field]).trim() === ""
    );

  if (isEmpty) {
    return required
      ? {
          valid: false,
          message: "Complete size details are required for this Stock Type.",
        }
      : { valid: true, value: null };
  }

  const lengthValue = Number(size.lengthValue);
  const widthValue = Number(size.widthValue);
  const lengthUnit = String(size.lengthUnit || "").trim();
  const widthUnit = String(size.widthUnit || "").trim();

  if (
    !Number.isFinite(lengthValue) ||
    !Number.isFinite(widthValue) ||
    lengthValue <= 0 ||
    widthValue <= 0 ||
    !VALID_SIZE_UNITS.includes(lengthUnit) ||
    !VALID_SIZE_UNITS.includes(widthUnit)
  ) {
    return {
      valid: false,
      message: "Enter positive length and width values with valid size units.",
    };
  }

  return {
    valid: true,
    value: {
      lengthValue,
      lengthUnit,
      widthValue,
      widthUnit,
    },
  };
};

const validateStockIdentity = async ({
  stockType,
  supplier,
  size,
}) => {
  const requiresSupplier = Boolean(stockType?.requiresSupplier);
  const requiresSize = Boolean(stockType?.requiresSize);
  let resolvedSupplier = null;

  if (requiresSupplier && !supplier) {
    return {
      valid: false,
      message: "Supplier is required for this Stock Type.",
    };
  }

  if (supplier) {
    if (!mongoose.Types.ObjectId.isValid(supplier)) {
      return { valid: false, message: "Invalid Supplier ID." };
    }

    resolvedSupplier = await Supplier.findById(supplier)
      .select("_id name")
      .lean();

    if (!resolvedSupplier) {
      return { valid: false, message: "Supplier not found." };
    }
  }

  const normalizedSize = normalizeSize(size, requiresSize);

  if (!normalizedSize.valid) {
    return normalizedSize;
  }

  return {
    valid: true,
    supplier: resolvedSupplier,
    size: normalizedSize.value,
  };
};

const findDuplicateProduct =
  async (
    {
      productName,
      category,
      stockType,
      supplier,
      size,
      unit,
      isTracked,
    },
    excludeId = null,
    session = null
  ) => {
    const query = isTracked
      ? {
          category,
          stockType: stockType || null,
          supplier: supplier || null,
          "size.lengthValue": size?.lengthValue ?? null,
          "size.lengthUnit": size?.lengthUnit ?? null,
          "size.widthValue": size?.widthValue ?? null,
          "size.widthUnit": size?.widthUnit ?? null,
          unit,
        }
      : {
          productName: {
            $regex:
              `^${escapeRegex(productName)}$`,
            $options: "i",
          },
        };


    if (excludeId) {
      query._id = {
        $ne:
          excludeId,
      };
    }


    let request =
      StockItem.findOne(
        query
      );


    if (session) {
      request =
        request.session(
          session
        );
    }


    return request;
  };


const getLowStockValue = (
  item
) => {
  return (
    item.currentStock <=
    item.minimumStock
  );
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
          .limit(STOCK_TYPE_LIST_CAP)
          .lean();


      // Count products only for the types being returned (same counts, far
      // fewer items scanned than grouping the whole collection).
      const productCounts =
        await StockItem.aggregate([
          {
            $match: {
              stockType: {
                $in: types.map(
                  (type) =>
                    type._id
                ),
              },
            },
          },

          {
            $group: {
              _id:
                "$stockType",

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
              String(
                row._id
              ),

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
                String(
                  type._id
                )
              ) || 0,
          })
        );


      return res.json(
        result
      );
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
========================================================== */

router.post(
  "/types",
  async (req, res) => {
    try {
      const {
        name,
        category,
        notes = "",
        requiresSupplier = false,
        requiresSize = false,
      } = req.body;


      const finalName =
        cleanText(
          name
        );


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

      if (
        category === "finished_goods" &&
        (normalizeBoolean(requiresSupplier) ||
          normalizeBoolean(requiresSize))
      ) {
        return res
          .status(400)
          .json({
            message: "Finished Goods Stock Types cannot require supplier or size.",
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
          name:
            finalName,

          normalizedName,

          category,

          notes:
            String(
              notes || ""
            ).trim(),

          requiresSupplier:
            category === "finished_goods"
              ? false
              : normalizeBoolean(requiresSupplier),

          requiresSize:
            category === "finished_goods"
              ? false
              : normalizeBoolean(requiresSize),
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
        err?.code ===
        11000
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
            "Unable to create Stock Type.",
        });
    }
  }
);


/* ==========================================================
   UPDATE STOCK TYPE

   PUT /api/stock/types/:id
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
        requiresSupplier,
        requiresSize,
      } = req.body;


      let nextName =
        stockType.name;


      let nextCategory =
        stockType.category;


      if (
        name !==
        undefined
      ) {
        nextName =
          cleanText(
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


      if (
        category !==
        undefined
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
            productCount >
            0
          ) {
            return res
              .status(400)
              .json({
                message:
                  `Main category cannot be changed because ${productCount} product${
                    productCount ===
                    1
                      ? ""
                      : "s"
                  } currently use this Stock Type.`,
              });
          }
        }


        nextCategory =
          category;
      }


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


      stockType.name =
        nextName;

      stockType.normalizedName =
        normalizedName;

      stockType.category =
        nextCategory;

      if (nextCategory === "finished_goods") {
        if (
          normalizeBoolean(requiresSupplier) ||
          normalizeBoolean(requiresSize)
        ) {
          return res
            .status(400)
            .json({
              message: "Finished Goods Stock Types cannot require supplier or size.",
            });
        }

        stockType.requiresSupplier = false;
        stockType.requiresSize = false;
      } else {
        if (requiresSupplier !== undefined) {
          stockType.requiresSupplier = normalizeBoolean(requiresSupplier);
        }

        if (requiresSize !== undefined) {
          stockType.requiresSize = normalizeBoolean(requiresSize);
        }
      }


      if (
        notes !==
        undefined
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
        err?.code ===
        11000
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
            "Unable to update Stock Type.",
        });
    }
  }
);


/* ==========================================================
   DELETE STOCK TYPE

   DELETE /api/stock/types/:id
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
        productCount >
        0
      ) {
        return res
          .status(400)
          .json({
            message:
              `Cannot delete "${stockType.name}". ${productCount} product${
                productCount ===
                1
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
      const rows =
        await StockItem.find({
          $expr: {
            $lte: [
              "$currentStock",
              "$minimumStock",
            ],
          },
        })
          .populate(
            "stockType",
            "name category requiresSupplier requiresSize"
          )
          .populate("supplier", "name")
          .sort({
            currentStock: 1,
            productName: 1,
            _id: 1,
          })
          .limit(STOCK_LIST_CAP + 1)
          .lean();

      const {
        rows: cappedRows,
        capped: wasCapped,
      } = applyLegacyCap(
        rows,
        STOCK_LIST_CAP
      );

      const items =
        cappedRows.map(
          withStockVirtuals
        );


      return res.json({
        count:
          items.length,

        items,

        ...(wasCapped
          ? { capped: true }
          : {}),
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

   Optional:
   ?itemId=
   ?movementType=
   ?category=
   ?search=   (product name)
   ?startDate=  YYYY-MM-DD (Asia/Kolkata day)
   ?endDate=
   ?page= &limit=  (paged mode: { items, page, limit, total, totalPages };
                    without them: legacy array, max 500)
========================================================== */

const HISTORY_CAP = 500;
const IST_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Asia/Kolkata (UTC+05:30, no DST) day bounds for a YYYY-MM-DD value.
const parseHistoryDate = (value, endOfDay) => {
  const text = String(value).trim().slice(0, 10);
  if (!IST_DATE_ONLY.test(text)) return null;
  const date = new Date(
    `${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+05:30`
  );
  if (Number.isNaN(date.getTime())) return null;
  // Reject overflow such as 2026-02-31 (JS would roll it into March).
  const roundTrip = new Date(date.getTime() + 5.5 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return roundTrip === text ? date : null;
};

router.get("/history", async (req, res) => {
  try {
    const { itemId, movementType, category, search, startDate, endDate } =
      req.query;

    const query = {};

    if (itemId) {
      if (!mongoose.Types.ObjectId.isValid(itemId)) {
        return res.status(400).json({ message: "Invalid stock item ID." });
      }
      query.item = itemId;
    }

    if (movementType) {
      if (
        !StockMovement.schema
          .path("movementType")
          .enumValues.includes(movementType)
      ) {
        return res.status(400).json({ message: "Invalid movement type." });
      }
      query.movementType = movementType;
    }

    if (category) {
      if (!VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({ message: "Invalid stock category." });
      }
      query.category = category;
    }

    const searchText = cleanText(search || "");
    if (searchText) {
      query.productName = {
        $regex: escapeRegex(searchText),
        $options: "i",
      };
    }

    if (startDate || endDate) {
      query.movementDate = {};

      if (startDate) {
        const start = parseHistoryDate(startDate, false);
        if (!start) {
          return res.status(400).json({ message: "Invalid start date." });
        }
        query.movementDate.$gte = start;
      }

      if (endDate) {
        const end = parseHistoryDate(endDate, true);
        if (!end) {
          return res.status(400).json({ message: "Invalid end date." });
        }
        query.movementDate.$lte = end;
      }

      if (
        query.movementDate.$gte &&
        query.movementDate.$lte &&
        query.movementDate.$gte > query.movementDate.$lte
      ) {
        return res
          .status(400)
          .json({ message: "Start date cannot be after end date." });
      }
    }

    const buildQuery = () =>
      StockMovement.find(query)
        .populate({
          path: "item",
          select:
            "productName category stockType supplier size unit currentStock minimumStock",
          populate: [
            { path: "supplier", select: "name" },
            {
              path: "stockType",
              select: "name category requiresSupplier requiresSize",
            },
          ],
        })
        .sort({ movementDate: -1, createdAt: -1, _id: -1 })
        .lean();

    return await sendListResponse(
      res,
      req.query,
      { cap: HISTORY_CAP, maxLimit: 100, defaultLimit: 20 },
      buildQuery,
      () => StockMovement.countDocuments(query)
    );
  } catch (err) {
    console.error("GET STOCK HISTORY ERROR:", err);

    return res.status(500).json({
      message: "Unable to load stock history.",
    });
  }
});


/* ==========================================================
   GET STOCK SUMMARY

   GET /api/stock/summary
========================================================== */

router.get(
  "/summary",
  async (req, res) => {
    try {
      // One aggregation instead of loading every item.
      const [row] =
        await StockItem.aggregate(
          buildStockSummaryPipeline()
        );


      const summary = {
        totalItems:
          row?.totalItems || 0,

        rawMaterial:
          row?.rawMaterial || 0,

        washedRawMaterial:
          row?.washedRawMaterial || 0,

        finishedGoods:
          row?.finishedGoods || 0,

        lowStock:
          row?.lowStock || 0,
      };


      return res.json(
        summary
      );
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

         This is what makes dedicated
         Label / Wrapper / Cotton pages
         show only their own products.
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


        const typeExists =
          await StockType.exists({
            _id:
              stockType,
          });


        if (!typeExists) {
          return res
            .status(404)
            .json({
              message:
                "Stock Type not found.",
            });
        }


        query.stockType =
          stockType;
      }


      /* ------------------------------
         SEARCH

         Dedicated Stock Type page:
         search product names only
         inside selected Stock Type.

         Global page:
         search product name and
         Stock Type name.
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


        if (stockType) {
          query.productName =
            searchRegex;
        } else {
          const matchingTypes =
            await StockType.find({
              name:
                searchRegex,
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

            {
              stockType: {
                $in:
                  matchingTypeIds,
              },
            },
          ];
        }
      }


      // Legacy callers get the full array (capped); ?page/?limit returns a
      // paged envelope. lean() output gets the schema virtuals re-added so the
      // JSON is identical to a hydrated document.
      return await sendListResponse(
        res,
        req.query,
        {
          cap: STOCK_LIST_CAP,
        },
        () =>
          StockItem.find(
            query
          )
            .populate(
              "stockType",
              "name category notes requiresSupplier requiresSize"
            )
            .populate("supplier", "name")
            .sort({
              productName: 1,
              _id: 1,
            })
            .lean(),
        () =>
          StockItem.countDocuments(
            query
          ),
        (rows) =>
          rows.map(
            withStockVirtuals
          )
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
========================================================== */

router.post(
  "/",
  async (req, res) => {
    let session =
      null;


    try {
      const {
        productName,
        category,
        stockType = null,
        supplier = null,
        size = null,
        unit,
        openingStock = 0,
        minimumStock = 0,
        notes = "",
        hsnCode,
        gstRatePercent,
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


      /* ------------------------------
         FINISHED GOODS TAX METADATA
      ------------------------------ */

      const taxCheck =
        validateTaxMetadata({
          category,
          hsnCode,
          gstRatePercent,
        });

      if (!taxCheck.valid) {
        return res
          .status(400)
          .json({
            message: taxCheck.message,
          });
      }

      const taxFields =
        category === "finished_goods"
          ? {
              hsnCode:
                taxCheck.value.hsnCode ?? "",
              gstRatePercent:
                taxCheck.value.gstRatePercent ??
                DEFAULT_GST_RATE_PERCENT,
            }
          : {};


      /* ------------------------------
         VALIDATE STOCK TYPE
      ------------------------------ */

      let selectedStockType =
        null;


      if (
        (category === "raw_material" ||
          category === "washed_raw_material") &&
        !stockType
      ) {
        return res
          .status(400)
          .json({
            message: "Stock Type is required for Raw Material and Washed Raw Material.",
          });
      }


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


        selectedStockType =
          await StockType.findById(
            stockType
          ).lean();


        if (
          !selectedStockType
        ) {
          return res
            .status(404)
            .json({
              message:
                "Stock Type not found.",
            });
        }


        if (
          selectedStockType.category !==
          category
        ) {
          return res
            .status(400)
            .json({
              message:
                `"${selectedStockType.name}" belongs to a different main stock category.`,
            });
        }
      }


      const identityCheck =
        await validateStockIdentity({
          stockType: selectedStockType,
          supplier,
          size,
        });


      if (!identityCheck.valid) {
        return res
          .status(400)
          .json({
            message: identityCheck.message,
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
          {
            productName: finalName,
            category,
            stockType: selectedStockType?._id || null,
            supplier: identityCheck.supplier?._id || null,
            size: identityCheck.size,
            unit,
            isTracked: Boolean(
              selectedStockType?.requiresSupplier ||
              selectedStockType?.requiresSize
            ),
          },
          null,
          session
        );


      if (duplicate) {
        await session.abortTransaction();


        return res
          .status(409)
          .json({
            message:
              selectedStockType?.requiresSupplier ||
              selectedStockType?.requiresSize
                ? "A matching stock item already exists for this supplier, type and size."
                : "A stock product with this name already exists.",
          });
      }


      const item =
        new StockItem({
          productName:
            finalName,

          category,

          stockType:
            selectedStockType
              ? selectedStockType._id
              : null,

          supplier:
            identityCheck.supplier
              ? identityCheck.supplier._id
              : null,

          size:
            identityCheck.size,

          unit,

          currentStock:
            openingCheck.value,

          minimumStock:
            minimumCheck.value,

          notes:
            String(
              notes || ""
            ).trim(),

          ...taxFields,
        });


      await item.save({
        session,
      });


      /*
       * Opening stock must also
       * create stock history.
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

              supplier:
                item.supplier,

              supplierName:
                identityCheck.supplier?.name || "",

              size:
                item.size,

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


      const createdItem =
        await StockItem.findById(
          item._id
        ).populate(
          "stockType",
          "name category notes requiresSupplier requiresSize"
        ).populate("supplier", "name");


      return res
        .status(201)
        .json({
          message:
            "Stock item created successfully.",

          item:
            createdItem,
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

   Does NOT directly change currentStock.
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

      const originalStockTypeId =
        item.stockType
          ? String(item.stockType)
          : "";


      const {
        productName,
        category,
        stockType,
        supplier,
        size,
        unit,
        minimumStock,
        notes,
        hsnCode,
        gstRatePercent,
      } = req.body;

      const originalCategory =
        item.category;


      /* ------------------------------
         PRODUCT NAME
      ------------------------------ */

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


        item.productName =
          finalName;
      }


      /* ------------------------------
         MINIMUM STOCK
      ------------------------------ */

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


      /* ------------------------------
         NOTES
      ------------------------------ */

      if (
        notes !==
        undefined
      ) {
        item.notes =
          String(
            notes || ""
          ).trim();
      }


      /* ======================================================
         CATEGORY / UNIT

         These cannot be casually changed
         after stock activity starts.
      ====================================================== */

      if (
        category !== undefined ||
        unit !== undefined
      ) {
        const movementExists =
          await StockMovement.exists({
            item:
              item._id,
          });


        if (
          movementExists ||
          item.currentStock >
          0
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
            unit !==
              item.unit
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
          category !==
          undefined
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
          unit !==
          undefined
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


          item.unit =
            unit;
        }
      }


      /* ======================================================
         FINISHED GOODS TAX METADATA

         Only Finished Goods carry HSN / GST. Leaving
         Finished Goods clears them, and is blocked while
         customer prices exist for the item.
      ====================================================== */

      const taxCheck =
        validateTaxMetadata({
          category: item.category,
          hsnCode,
          gstRatePercent,
        });

      if (!taxCheck.valid) {
        return res
          .status(400)
          .json({
            message: taxCheck.message,
          });
      }

      if (
        originalCategory === "finished_goods" &&
        item.category !== "finished_goods"
      ) {
        const hasCustomerPrices =
          await CustomerProductPrice.exists({
            item: item._id,
          });

        if (hasCustomerPrices) {
          return res
            .status(409)
            .json({
              message:
                "This product has customer prices, so it must stay in Finished Goods.",
            });
        }

        item.hsnCode = undefined;
        item.gstRatePercent = undefined;
      }

      if (item.category === "finished_goods") {
        if (taxCheck.value.hsnCode !== undefined) {
          item.hsnCode = taxCheck.value.hsnCode;
        }

        if (taxCheck.value.gstRatePercent !== undefined) {
          item.gstRatePercent = taxCheck.value.gstRatePercent;
        } else if (
          originalCategory !== "finished_goods"
        ) {
          item.gstRatePercent = DEFAULT_GST_RATE_PERCENT;
        }
      }


      /* ======================================================
         STOCK TYPE

         Stock Type can be changed without
         changing stock quantity/history.

         null / empty = Unassigned.
      ====================================================== */

      if (
        stockType !==
        undefined
      ) {
        if (
          stockType === null ||
          stockType === ""
        ) {
          item.stockType =
            null;
        } else {
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


          const selectedStockType =
            await StockType.findById(
              stockType
            ).lean();


          if (
            !selectedStockType
          ) {
            return res
              .status(404)
              .json({
                message:
                  "Stock Type not found.",
              });
          }


          if (
            selectedStockType.category !==
            item.category
          ) {
            return res
              .status(400)
              .json({
                message:
                  `"${selectedStockType.name}" belongs to a different main stock category.`,
              });
          }


          item.stockType =
            selectedStockType._id;
        }
      }


      /*
       * Safety:
       * If category changed and caller
       * did not explicitly send stockType,
       * existing Stock Type must still
       * belong to that category.
       */
      if (
        stockType ===
          undefined &&
        item.stockType
      ) {
        const existingStockType =
          await StockType.findById(
            item.stockType
          ).lean();


        if (
          !existingStockType
        ) {
          item.stockType =
            null;
        } else if (
          existingStockType.category !==
          item.category
        ) {
          return res
            .status(400)
            .json({
              message:
                "Please select a Stock Type that belongs to the new main category.",
            });
        }
      }


      const selectedStockType = item.stockType
        ? await StockType.findById(item.stockType).lean()
        : null;


      if (
        (item.category === "raw_material" ||
          item.category === "washed_raw_material") &&
        !selectedStockType
      ) {
        return res
          .status(400)
          .json({
            message: "Select a Stock Type to classify this Raw Material or Washed Raw Material item.",
          });
      }


      const identityCheck =
        await validateStockIdentity({
          stockType: selectedStockType,
          supplier:
            supplier === undefined
              ? item.supplier
              : supplier,
          size:
            size === undefined
              ? item.size
              : size,
        });


      if (!identityCheck.valid) {
        return res
          .status(400)
          .json({
            message: identityCheck.message,
          });
      }


      const oldSize = normalizeSize(item.size).value;
      const identityChanged =
        originalStockTypeId !==
          String(selectedStockType?._id || "") ||
        String(item.supplier || "") !==
          String(identityCheck.supplier?._id || "") ||
        JSON.stringify(oldSize) !==
          JSON.stringify(identityCheck.size);


      if (identityChanged) {
        const movementExists =
          await StockMovement.exists({ item: item._id });

        if (movementExists || item.currentStock > 0) {
          return res
            .status(400)
            .json({
              message: "Supplier, Stock Type, or size cannot be changed after stock activity has started.",
            });
        }
      }


      const duplicate =
        await findDuplicateProduct(
          {
            productName: item.productName,
            category: item.category,
            stockType: selectedStockType?._id || null,
            supplier: identityCheck.supplier?._id || null,
            size: identityCheck.size,
            unit: item.unit,
            isTracked: Boolean(
              selectedStockType?.requiresSupplier ||
              selectedStockType?.requiresSize
            ),
          },
          item._id
        );


      if (duplicate) {
        return res
          .status(409)
          .json({
            message:
              selectedStockType?.requiresSupplier ||
              selectedStockType?.requiresSize
                ? "A matching stock item already exists for this supplier, type and size."
                : "Another stock product already uses this name.",
          });
      }


      item.supplier =
        identityCheck.supplier
          ? identityCheck.supplier._id
          : null;

      item.size = identityCheck.size;


      await item.save();


      const updatedItem =
        await StockItem.findById(
          item._id
        ).populate(
          "stockType",
          "name category notes requiresSupplier requiresSize"
        ).populate("supplier", "name");


      return res.json({
        message:
          "Stock item updated successfully.",

        item:
          updatedItem,
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
            "Unable to update stock item.",
        });
    }
  }
);


/* ==========================================================
   STOCK IN

   POST /api/stock/:id/in
========================================================== */

router.post(
  "/:id/in",
  async (req, res) => {
    let session =
      null;


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
            _id:
              id,
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


      if (
        !updatedItem
      ) {
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

      const supplierSnapshot =
        updatedItem.supplier
          ? await Supplier.findById(updatedItem.supplier)
              .select("name")
              .session(session)
              .lean()
          : null;


      await StockMovement.create(
        [
          {
            item:
              updatedItem._id,

            productName:
              updatedItem.productName,

            category:
              updatedItem.category,

            supplier:
              updatedItem.supplier || null,

            supplierName:
              supplierSnapshot?.name || "",

            size:
              updatedItem.size || null,

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


      const itemForResponse =
        await StockItem.findById(
          updatedItem._id
        ).populate(
          "stockType",
          "name category notes requiresSupplier requiresSize"
        ).populate("supplier", "name");


      return res.json({
        message:
          `Stock added successfully. Current stock: ${updatedItem.currentStock} ${updatedItem.unit}.`,

        item:
          itemForResponse,

        lowStock:
          getLowStockValue(
            updatedItem
          ),
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
    let session =
      null;


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
       * currentStock condition prevents
       * stock from going negative even if
       * two requests happen close together.
       */
      const updatedItem =
        await StockItem.findOneAndUpdate(
          {
            _id:
              id,

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


      if (
        !updatedItem
      ) {
        const existingItem =
          await StockItem.findById(
            id
          )
            .session(
              session
            )
            .lean();


        await session.abortTransaction();


        if (
          !existingItem
        ) {
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

      const supplierSnapshot =
        updatedItem.supplier
          ? await Supplier.findById(updatedItem.supplier)
              .select("name")
              .session(session)
              .lean()
          : null;


      await StockMovement.create(
        [
          {
            item:
              updatedItem._id,

            productName:
              updatedItem.productName,

            category:
              updatedItem.category,

            supplier:
              updatedItem.supplier || null,

            supplierName:
              supplierSnapshot?.name || "",

            size:
              updatedItem.size || null,

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
        getLowStockValue(
          updatedItem
        );


      const itemForResponse =
        await StockItem.findById(
          updatedItem._id
        ).populate(
          "stockType",
          "name category notes requiresSupplier requiresSize"
        ).populate("supplier", "name");


      return res.json({
        message:
          lowStock
            ? `Stock removed successfully. Warning: ${updatedItem.productName} is now low on stock.`
            : `Stock removed successfully. Current stock: ${updatedItem.currentStock} ${updatedItem.unit}.`,

        item:
          itemForResponse,

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
        )
          .populate(
            "stockType",
            "name category notes requiresSupplier requiresSize"
          )
          .populate("supplier", "name")
          .lean();


      if (!item) {
        return res
          .status(404)
          .json({
            message:
              "Stock item not found.",
          });
      }


      const paging =
        parseOptionalPagination(
          req.query,
          {
            cap: ITEM_HISTORY_CAP,
            maxLimit: 200,
          }
        );

      const historyQuery =
        StockMovement.find({
          item:
            id,
        })
          .sort({
            movementDate: -1,
            createdAt: -1,
          })
          .skip(paging.skip)
          .limit(paging.limit)
          .lean();

      // history stays an array; pagination info is an additive field.
      if (paging.paged) {
        const [
          history,
          total,
        ] = await Promise.all([
          historyQuery,
          StockMovement.countDocuments({
            item:
              id,
          }),
        ]);

        return res.json({
          item,
          history,
          pagination: {
            page:
              paging.page,
            limit:
              paging.limit,
            total,
            totalPages:
              Math.max(
                1,
                Math.ceil(
                  total /
                    paging.limit
                )
              ),
            capped: false,
          },
        });
      }

      const {
        rows: history,
        capped,
      } = applyLegacyCap(
        await historyQuery,
        ITEM_HISTORY_CAP
      );

      return res.json({
        item,
        history,
        pagination: {
          page: 1,
          limit:
            ITEM_HISTORY_CAP,
          total: capped
            ? null
            : history.length,
          totalPages: 1,
          capped,
        },
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
