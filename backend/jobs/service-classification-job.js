'use strict';
require('dotenv').config();
const { supabase } = require('../lib/supabase');
const { classifyByRules, classifyBatch } = require('../lib/service-classification');

const AI_BATCH = 50;
const PAGE     = 1000;

async function runServiceClassification({ reclassify = false } = {}) {
  console.log(`[service-classification] inicio (reclassify=${reclassify})`);

  // Load lines to classify (by default only unclassified ones)
  const lines = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('fd_invoice_lines')
      .select('id, description')
      .range(from, from + PAGE - 1);
    if (!reclassify) q = q.is('service_category', null);
    const { data, error } = await q;
    if (error) throw new Error(`[service-classification] select: ${error.message}`);
    lines.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }

  console.log(`[service-classification] ${lines.length} líneas a clasificar`);
  if (!lines.length) return { ruleCount: 0, aiCount: 0, otherCount: 0, catCounts: {} };

  // Rule-based pass
  const byRules = [];
  const forAI   = [];
  for (const line of lines) {
    const cat = classifyByRules(line.description);
    if (cat) byRules.push({ id: line.id, category: cat });
    else      forAI.push({ id: line.id, description: line.description });
  }

  console.log(`[service-classification] reglas: ${byRules.length}, IA: ${forAI.length}`);

  // AI fallback in batches
  const aiResults = [];
  for (let i = 0; i < forAI.length; i += AI_BATCH) {
    const batch = forAI.slice(i, i + AI_BATCH);
    try {
      const results = await classifyBatch(batch);
      aiResults.push(...results);
    } catch (e) {
      console.error(`[service-classification] error batch IA ${i}:`, e.message);
      aiResults.push(...batch.map(l => ({ id: l.id, category: 'OTHER' })));
    }
    if ((i / AI_BATCH) % 10 === 0) {
      process.stdout.write(`\r[service-classification] IA: ${Math.min(i + AI_BATCH, forAI.length)}/${forAI.length}  `);
    }
  }
  if (forAI.length) console.log('');

  // Group updates by category to minimize DB round-trips (one UPDATE per category)
  const allUpdates = [...byRules, ...aiResults];
  const byCat = {};
  for (const item of allUpdates) {
    if (!byCat[item.category]) byCat[item.category] = [];
    byCat[item.category].push(item.id);
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const [cat, ids] of Object.entries(byCat)) {
    const validIds = ids.filter(id => UUID_RE.test(id));
    const invalid = ids.length - validIds.length;
    if (invalid > 0) console.warn(`[service-classification] ${invalid} IDs inválidos descartados en ${cat}`);
    if (!validIds.length) continue;
    // Split into chunks of 500 to stay within PostgREST URL limits
    for (let i = 0; i < validIds.length; i += 500) {
      const chunk = validIds.slice(i, i + 500);
      const { error } = await supabase
        .from('fd_invoice_lines')
        .update({ service_category: cat })
        .in('id', chunk);
      if (error) console.error(`[service-classification] error update ${cat}:`, error.message);
    }
  }

  // Stats
  const catCounts = {};
  for (const [cat, ids] of Object.entries(byCat)) catCounts[cat] = ids.length;
  const otherCount = catCounts['OTHER'] || 0;

  console.log('[service-classification] distribución por categoría:');
  const sorted = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
  for (const [cat, n] of sorted) console.log(`  ${cat.padEnd(18)} ${n}`);
  console.log(`[service-classification] total: ${allUpdates.length} | reglas: ${byRules.length} | IA: ${aiResults.length} | OTHER: ${otherCount}`);

  return { ruleCount: byRules.length, aiCount: aiResults.length, otherCount, catCounts };
}

module.exports = { runServiceClassification };
