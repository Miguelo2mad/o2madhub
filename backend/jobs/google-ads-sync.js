const { GoogleAdsApi } = require('google-ads-api');
const { supabase } = require('../lib/supabase');

async function syncGoogleAds() {
  const adcJson = process.env.GOOGLE_ADS_ADC_JSON;
  if (!adcJson) {
    console.error('[campanas] ERROR: GOOGLE_ADS_ADC_JSON not set');
    return { clientes: 0, filas: 0 };
  }

  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) {
    console.error('[campanas] ERROR: GOOGLE_ADS_DEVELOPER_TOKEN not set');
    return { clientes: 0, filas: 0 };
  }

  let adc;
  try {
    adc = JSON.parse(adcJson);
  } catch (e) {
    console.error('[campanas] ERROR: GOOGLE_ADS_ADC_JSON is not valid JSON:', e.message);
    return { clientes: 0, filas: 0 };
  }

  const { client_id, client_secret, refresh_token } = adc;
  const loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || undefined;

  const gadsClient = new GoogleAdsApi({ client_id, client_secret, developer_token: developerToken });

  const { data: clientes, error } = await supabase
    .from('google_ads_clientes')
    .select('*')
    .eq('activo', true);

  if (error) {
    console.error('[campanas] ERROR fetching clientes:', error.message);
    return { clientes: 0, filas: 0 };
  }

  const gaql = `
    SELECT
      campaign.id,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      segments.date
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
    ORDER BY segments.date DESC
  `;

  let totalFilas = 0;

  for (const row of clientes) {
    try {
      const customer = gadsClient.Customer({
        customer_id: row.customer_id,
        refresh_token,
        ...(loginCustomerId ? { login_customer_id: loginCustomerId } : {}),
      });

      const rows = await customer.query(gaql);

      const upsertRows = rows.map(r => ({
        customer_id: row.customer_id,
        fecha: r.segments.date,
        campana_id: String(r.campaign.id),
        campana_nombre: r.campaign.name,
        impresiones: Number(r.metrics.impressions) || 0,
        clics: Number(r.metrics.clicks) || 0,
        coste: (Number(r.metrics.cost_micros) || 0) / 1_000_000,
        conversiones: Number(r.metrics.conversions) || 0,
        valor_conversiones: Number(r.metrics.conversions_value) || 0,
      }));

      if (upsertRows.length > 0) {
        const { error: upsertError } = await supabase
          .from('google_ads_stats_diarias')
          .upsert(upsertRows, { onConflict: 'customer_id,fecha,campana_id' });

        if (upsertError) {
          console.error(`[campanas] upsert error for ${row.customer_id}:`, upsertError.message);
        }
      }

      totalFilas += upsertRows.length;
      console.log(`[campanas] ✓ ${row.customer_id} — ${upsertRows.length} filas`);
    } catch (e) {
      console.error(`[campanas] ERROR syncing ${row.customer_id}:`, e.message);
    }
  }

  return { clientes: clientes.length, filas: totalFilas };
}

module.exports = { syncGoogleAds };
