'use strict';
const axios = require('axios');

class FacturaDirectaClient {
  constructor() {
    this.baseUrl   = process.env.FACTURADIRECTA_BASE_URL;
    this.apiKey    = process.env.FACTURADIRECTA_API_KEY;
    this.companyId = process.env.FACTURADIRECTA_COMPANY_ID;
    if (!this.baseUrl || !this.apiKey || !this.companyId) {
      throw new Error('FacturaDirecta: faltan FACTURADIRECTA_BASE_URL / FACTURADIRECTA_API_KEY / FACTURADIRECTA_COMPANY_ID');
    }
    this.http = axios.create({
      baseURL: `${this.baseUrl}/${this.companyId}`,
      headers: {
        'facturadirecta-api-key': this.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000,
    });
  }

  async _get(path, params = {}) {
    const RETRIES = 3;
    let lastErr;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        const res = await this.http.get(path, { params });
        return res.data;
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        if (status && status >= 400 && status < 500) break;
        if (attempt < RETRIES) {
          const wait = 1000 * attempt;
          console.warn(`[fd-client] retrying ${path} (attempt ${attempt}, wait ${wait}ms, status=${status})`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }
    const status = lastErr.response?.status;
    const body   = lastErr.response?.data;
    console.error(`[fd-client] error GET ${this.baseUrl}/${this.companyId}${path} → status=${status}`, JSON.stringify(body));
    const msg = body?.message || body?.error || lastErr.message || 'FacturaDirecta API error';
    const e = new Error(`FacturaDirecta [${status}]: ${msg}`);
    e.status = status;
    e.body = body;
    throw e;
  }

  async getAll(path, params = {}) {
    const limit = 100;
    let offset = 0;
    const all = [];
    while (true) {
      const data = await this._get(path, { ...params, limit, offset });
      // FacturaDirecta returns { pagination: { limit, offset, total }, items: [] }
      const rows = data.items || [];
      all.push(...rows);
      const total = data.pagination?.total ?? rows.length;
      offset += rows.length;
      if (offset >= total || rows.length === 0) break;
    }
    return all;
  }

  async post(path, body) {
    const RETRIES = 2;
    let lastErr;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        const res = await this.http.post(path, body);
        return res.data;
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        if (status && status >= 400 && status < 500) break;
        if (attempt < RETRIES) await new Promise(r => setTimeout(r, 1000));
      }
    }
    const status = lastErr.response?.status;
    const body2  = lastErr.response?.data;
    const msg = body2?.message || body2?.error || lastErr.message;
    const e = new Error(`FacturaDirecta POST [${status}]: ${msg}`);
    e.status = status;
    e.body = body2;
    throw e;
  }
}

module.exports = { FacturaDirectaClient };
