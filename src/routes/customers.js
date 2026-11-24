// File: server/routes/customers.js
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Customer = require('../models/Customer');
const CustomerProductPrice = require('../models/CustomerProductPrice');
const StockItem = require('../models/StockItem');
const Estimate = require('../models/Estimate');
const EstimatePayment = require('../models/EstimatePayment');
const { buildEstimateAccount } = require('../utils/estimateConversion');
const Invoice = require('../models/Invoice');
const InvoicePayment = require('../models/InvoicePayment');
const {
  buildPagedResponse,
  parseOptionalPagination,
  sendListResponse,
} = require('../utils/listQuery');
const { sendServerError } = require('../utils/httpErrors');
const { buildCustomerPayload } = require('../utils/customerValidation');
const { isAssignableItem, parsePricePaise } = require('../utils/customerPricing');

// Map known Mongoose/Mongo errors to safe client responses; never leak stack traces.
const handleError = (err, res) => {
  if (res.headersSent) return;
  if (err && err.code === 11000) {
    return res.status(409).json({ message: 'A customer with this email already exists.' });
  }
  if (err && (err.name === 'ValidationError' || err.name === 'CastError')) {
    return res.status(400).json({ message: 'Invalid customer data.' });
  }
  return sendServerError(res, 'CUSTOMERS ROUTE', err, 'Internal server error.');
};

// Local to this file only.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => handleError(err, res));

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isValidId = (value) => mongoose.Types.ObjectId.isValid(value) && String(new mongoose.Types.ObjectId(value)) === String(value);

const ITEM_FIELDS = 'productName unit category hsnCode gstRatePercent';

/** Shapes one price row (with its looked-up item) for the API. */
const toPriceResponse = (row, item) => ({
  _id: row._id,
  pricePaise: row.pricePaise,
  isActive: row.isActive !== false,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  item: item && item._id
    ? {
        _id: item._id,
        productName: item.productName || '',
        unit: item.unit || '',
        category: item.category || '',
        hsnCode: item.hsnCode || '',
        gstRatePercent: item.gstRatePercent ?? null,
      }
    : null,
});

/* ==========================================================
   CUSTOMERS
========================================================== */

// Get all customers
// Legacy callers get the full array (capped); ?page/?limit returns a paged envelope.
// Optional filters: ?status=active|inactive, ?search= (name, billing name, GSTIN, email).
router.get('/', asyncHandler(async (req, res) => {
  const filter = {};
  const { status, search } = req.query;

  if (status === 'active') filter.isActive = { $ne: false };
  else if (status === 'inactive') filter.isActive = false;
  else if (status !== undefined && status !== '' && status !== 'all') {
    return res.status(400).json({ message: 'Invalid customer status filter.' });
  }

  if (typeof search === 'string' && search.trim()) {
    const regex = { $regex: escapeRegex(search.trim()), $options: 'i' };
    filter.$or = [{ name: regex }, { billingName: regex }, { gst: regex }, { email: regex }];
  }

  await sendListResponse(
    res,
    req.query,
    { cap: 1000 },
    () => Customer.find(filter).sort({ _id: 1 }),
    () => Customer.countDocuments(filter)
  );
}));

// Get one customer
router.get('/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ message: 'Invalid customer ID.' });
  }
  const customer = await Customer.findById(req.params.id);
  if (!customer) {
    return res.status(404).json({ message: 'Customer not found' });
  }
  return res.json(customer);
}));

// Add a new customer
router.post('/', asyncHandler(async (req, res) => {
  const payload = buildCustomerPayload(req.body, null);
  if (!payload.valid) {
    return res.status(400).json({ message: payload.message });
  }
  const newCustomer = new Customer(payload.value);
  await newCustomer.save();
  res.json(newCustomer);
}));

// Add a customer order (legacy stub, no frontend caller)
router.post('/:id/order', asyncHandler(async (req, res) => {
  const { product, quantity } = req.body || {};
  if (typeof product !== 'string' || product.trim() === '') {
    return res.status(400).json({ message: 'Product is required.' });
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({ message: 'Quantity must be a whole number greater than 0.' });
  }
  const customer = await Customer.findById(req.params.id);
  if (customer) {
    customer.orders.push({ product: product.trim(), quantity });
    customer.stock += quantity;
    await customer.save();
    res.json(customer);
  } else {
    res.status(404).json({ message: 'Customer not found' });
  }
}));

// Update a customer (only the fields sent are changed)
router.put('/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ message: 'Invalid customer ID.' });
  }
  const existing = await Customer.findById(req.params.id).lean();
  if (!existing) {
    return res.status(404).json({ message: 'Customer not found' });
  }
  const payload = buildCustomerPayload(req.body, existing);
  if (!payload.valid) {
    return res.status(400).json({ message: payload.message });
  }
  const customer = await Customer.findByIdAndUpdate(
    req.params.id,
    { $set: payload.changes },
    { new: true, runValidators: true }
  );
  if (customer) {
    res.json(customer);
  } else {
    res.status(404).json({ message: 'Customer not found' });
  }
}));

// Delete a customer (blocked once product prices exist; deactivate instead)
router.delete('/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ message: 'Invalid customer ID.' });
  }
  const hasPrices = await CustomerProductPrice.exists({ customer: req.params.id });
  if (hasPrices) {
    return res.status(409).json({ message: 'Customer has product prices. Deactivate instead.' });
  }
  const hasEstimates = await Estimate.exists({ customer: req.params.id });
  if (hasEstimates) {
    return res.status(409).json({ message: 'Customer has estimates. Deactivate instead.' });
  }
  const hasInvoices = await Invoice.exists({ customer: req.params.id });
  if (hasInvoices) {
    return res.status(409).json({ message: 'Customer has invoices. Deactivate instead.' });
  }
  const customer = await Customer.findByIdAndDelete(req.params.id);
  if (customer) {
    res.json({ message: 'Customer deleted' });
  } else {
    res.status(404).json({ message: 'Customer not found' });
  }
}));

/* ==========================================================
   CUSTOMER ESTIMATE ACCOUNT (separate from any invoice ledger)
   GET /api/customers/:id/estimate-account
========================================================== */

router.get('/:id/estimate-account', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ message: 'Invalid customer ID.' });
  }
  const customerExists = await Customer.exists({ _id: req.params.id });
  if (!customerExists) {
    return res.status(404).json({ message: 'Customer not found' });
  }

  const customerId = new mongoose.Types.ObjectId(req.params.id);
  const [estimateRows, paymentRows] = await Promise.all([
    Estimate.aggregate([
      { $match: { customer: customerId } },
      { $group: { _id: '$status', count: { $sum: 1 }, totalPaise: { $sum: '$totalPaise' } } },
    ]),
    // Cancelled estimates never hold valid payments (cancel requires voiding first).
    // Payments carried to an invoice on conversion belong to the invoice ledger.
    EstimatePayment.aggregate([
      { $match: { customer: customerId, voided: false, transferred: { $ne: true } } },
      { $group: { _id: null, paidPaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
    ]),
  ]);

  return res.json(buildEstimateAccount(estimateRows, paymentRows));
}));

/* ==========================================================
   CUSTOMER INVOICE ACCOUNT (separate from the estimate ledger)
   GET /api/customers/:id/invoice-account
========================================================== */

router.get('/:id/invoice-account', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ message: 'Invalid customer ID.' });
  }
  const customerExists = await Customer.exists({ _id: req.params.id });
  if (!customerExists) {
    return res.status(404).json({ message: 'Customer not found' });
  }

  const customerId = new mongoose.Types.ObjectId(req.params.id);
  const [invoiceRows, paymentRows] = await Promise.all([
    Invoice.aggregate([
      { $match: { customer: customerId } },
      { $group: { _id: '$status', count: { $sum: 1 }, totalPaise: { $sum: '$totalPaise' } } },
    ]),
    // Reversed invoices never hold valid payments (reversal requires voiding first).
    InvoicePayment.aggregate([
      { $match: { customer: customerId, voided: false } },
      { $group: { _id: null, paidPaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
    ]),
  ]);

  const byStatus = new Map(invoiceRows.map((row) => [row._id, row]));
  const totalInvoicedPaise = Number(byStatus.get('active')?.totalPaise || 0);
  const totalPaidPaise = Number(paymentRows[0]?.paidPaise || 0);

  return res.json({
    activeCount: Number(byStatus.get('active')?.count || 0),
    reversedCount: Number(byStatus.get('reversed')?.count || 0),
    totalInvoicedPaise,
    totalPaidPaise,
    outstandingPaise: totalInvoicedPaise - totalPaidPaise,
    paymentCount: Number(paymentRows[0]?.count || 0),
  });
}));

/* ==========================================================
   CUSTOMER PRODUCT PRICES
========================================================== */

// List a customer's product prices (always paginated).
// ?status=active (default) | inactive | all, ?page, ?limit (max 100)
router.get('/:id/prices', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ message: 'Invalid customer ID.' });
  }
  const status = req.query.status || 'active';
  if (!['active', 'inactive', 'all'].includes(status)) {
    return res.status(400).json({ message: 'Invalid price status filter.' });
  }

  const customerExists = await Customer.exists({ _id: req.params.id });
  if (!customerExists) {
    return res.status(404).json({ message: 'Customer not found' });
  }

  const paging = parseOptionalPagination(
    { page: req.query.page ?? 1, limit: req.query.limit },
    { cap: 100, maxLimit: 100, defaultLimit: 20 }
  );

  const match = { customer: new mongoose.Types.ObjectId(req.params.id) };
  if (status === 'active') match.isActive = true;
  if (status === 'inactive') match.isActive = false;

  const [result] = await CustomerProductPrice.aggregate([
    { $match: match },
    {
      $lookup: {
        from: StockItem.collection.name,
        localField: 'item',
        foreignField: '_id',
        as: 'itemDoc',
      },
    },
    { $unwind: { path: '$itemDoc', preserveNullAndEmptyArrays: true } },
    { $sort: { isActive: -1, 'itemDoc.productName': 1, _id: 1 } },
    {
      $facet: {
        items: [
          { $skip: paging.skip },
          { $limit: paging.limit },
          {
            $project: {
              pricePaise: 1,
              isActive: 1,
              createdAt: 1,
              updatedAt: 1,
              'itemDoc._id': 1,
              'itemDoc.productName': 1,
              'itemDoc.unit': 1,
              'itemDoc.category': 1,
              'itemDoc.hsnCode': 1,
              'itemDoc.gstRatePercent': 1,
            },
          },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  const rows = result?.items || [];
  const total = result?.total?.[0]?.count || 0;
  return res.json(
    buildPagedResponse(rows.map((row) => toPriceResponse(row, row.itemDoc)), paging, total)
  );
}));

// Create or update the price of one Finished Goods item for a customer.
// Body: { price: "125.50" } in rupees; stored as integer paise.
router.put('/:id/prices/:itemId', asyncHandler(async (req, res) => {
  const { id, itemId } = req.params;
  if (!isValidId(id)) {
    return res.status(400).json({ message: 'Invalid customer ID.' });
  }
  if (!isValidId(itemId)) {
    return res.status(400).json({ message: 'Invalid product ID.' });
  }

  const priceCheck = parsePricePaise((req.body || {}).price);
  if (!priceCheck.valid) {
    return res.status(400).json({ message: priceCheck.message });
  }

  const customer = await Customer.findById(id).select('isActive').lean();
  if (!customer) {
    return res.status(404).json({ message: 'Customer not found' });
  }
  if (customer.isActive === false) {
    return res.status(400).json({ message: 'Customer is inactive. Activate the customer before setting prices.' });
  }

  const item = await StockItem.findById(itemId).select(ITEM_FIELDS).lean();
  if (!item) {
    return res.status(404).json({ message: 'Product not found.' });
  }
  if (!isAssignableItem(item)) {
    return res.status(400).json({ message: 'Only Finished Goods can be priced for a customer.' });
  }

  const filter = { customer: id, item: itemId };
  const update = { $set: { pricePaise: priceCheck.value, isActive: true } };

  let row;
  let created = false;
  try {
    const raw = await CustomerProductPrice.findOneAndUpdate(filter, update, {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
      includeResultMetadata: true,
    });
    row = raw.value;
    created = raw.lastErrorObject ? !raw.lastErrorObject.updatedExisting : false;
  } catch (err) {
    // A concurrent request created the same row first; update it instead.
    if (err && err.code === 11000) {
      row = await CustomerProductPrice.findOneAndUpdate(filter, update, {
        new: true,
        runValidators: true,
      });
    } else {
      throw err;
    }
  }

  if (!row) {
    return sendServerError(res, 'CUSTOMER PRICE SAVE', new Error('Price row missing after upsert.'));
  }

  return res.status(created ? 201 : 200).json({
    message: created ? 'Price added.' : 'Price updated.',
    price: toPriceResponse(row, item),
  });
}));

// Deactivate a customer's price for one item (no hard delete).
router.delete('/:id/prices/:itemId', asyncHandler(async (req, res) => {
  const { id, itemId } = req.params;
  if (!isValidId(id)) {
    return res.status(400).json({ message: 'Invalid customer ID.' });
  }
  if (!isValidId(itemId)) {
    return res.status(400).json({ message: 'Invalid product ID.' });
  }

  const row = await CustomerProductPrice.findOneAndUpdate(
    { customer: id, item: itemId },
    { $set: { isActive: false } },
    { new: true }
  );
  if (!row) {
    return res.status(404).json({ message: 'No price is set for this product.' });
  }

  const item = await StockItem.findById(itemId).select(ITEM_FIELDS).lean();
  return res.json({ message: 'Price deactivated.', price: toPriceResponse(row, item) });
}));

module.exports = router;
