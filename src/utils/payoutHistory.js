const getHistoryPagination = (query = {}) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(20, Math.max(1, Number.parseInt(query.limit, 10) || 20));

  return { page, limit };
};

const serializeBulkHistoryItem = (payout) => {
  const methods = [...new Set((payout.employees || []).map((line) => line.paymentMethod).filter(Boolean))];

  return {
    ...payout,
    paymentMethod: methods.length === 1 ? methods[0] : methods.length > 1 ? "mixed" : "",
  };
};

module.exports = { getHistoryPagination, serializeBulkHistoryItem };
