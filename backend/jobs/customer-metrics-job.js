'use strict';
const { recalculateAllMetrics } = require('../lib/customer-metrics');

async function runCustomerMetricsJob() {
  console.log(`[customer-metrics-job] iniciando @ ${new Date().toISOString()}`);
  const result = await recalculateAllMetrics();
  console.log(`[customer-metrics-job] completado @ ${new Date().toISOString()}`, result);
  return result;
}

module.exports = { runCustomerMetricsJob };
