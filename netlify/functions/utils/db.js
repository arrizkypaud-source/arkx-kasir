const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('./auth');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'nuallakoko@gmail.com';

function genId(prefix) { return prefix + crypto.randomUUID().slice(0, 12); }

function defaultDB() {
  console.log(`[ARKX] First run — Admin: ${ADMIN_EMAIL} / Password: 123456`);
  return {
    users: [{
      id: genId('U'), name: 'Admin ARKX', email: ADMIN_EMAIL,
      password: hashPassword('123456'), role: 'admin', status: 'approved',
      createdAt: new Date().toISOString()
    }],
    products: [
      { id: genId('P'), barcode: '8992761131059', name: 'Indomie Goreng', price: 3500, cost: 3000, stock: 120, minStock: 20, category: 'Makanan' },
      { id: genId('P'), barcode: '8998866201834', name: 'Aqua 600ml', price: 3000, cost: 2200, stock: 80, minStock: 15, category: 'Minuman' },
      { id: genId('P'), barcode: '8991002103815', name: 'Pocari Sweat 350ml', price: 6500, cost: 5000, stock: 50, minStock: 10, category: 'Minuman' },
      { id: genId('P'), barcode: '8992761113819', name: 'Sari Roti Tawar', price: 15000, cost: 13000, stock: 30, minStock: 5, category: 'Makanan' },
      { id: genId('P'), barcode: '8993175537018', name: 'Teh Pucuk 350ml', price: 4000, cost: 3200, stock: 60, minStock: 12, category: 'Minuman' },
      { id: genId('P'), barcode: '8992388101017', name: 'Chitato Sapi Panggang', price: 12000, cost: 9800, stock: 40, minStock: 8, category: 'Snack' }
    ],
    customers: [],
    sales: [],
    shifts: [],
    settings: { storeName: 'ARKX MART', storeAddress: 'Jl. Merdeka No. 123, Jakarta', storePhone: '0812-3456-7890', footerNote: 'Terima kasih sudah berbelanja!', logoUrl: '' }
  };
}

function migrate(d) {
  if (!d.customers) d.customers = [];
  if (!d.shifts) d.shifts = [];
  if (!d.settings) d.settings = {};
  if (!d.settings.logoUrl) d.settings.logoUrl = '';
  if (!Array.isArray(d.sales)) d.sales = [];
  d.products.forEach(p => { if (p.minStock == null) p.minStock = 5; if (p.cost == null) p.cost = 0; });
  d.sales.forEach(s => { if (!s.status) s.status = 'ok'; });
  return d;
}

let cachedDb = null;

async function getDb() {
  if (cachedDb) return cachedDb;
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore({ name: 'arkx-kasir-db' });
    const data = await store.get('db', { type: 'json' });
    if (data) { cachedDb = migrate(data); return cachedDb; }
  } catch (e) {
    console.warn('[ARKX] Blobs not available, using in-memory');
  }
  cachedDb = defaultDB();
  return cachedDb;
}

async function saveDb(data) {
  cachedDb = data;
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore({ name: 'arkx-kasir-db' });
    await store.set('db', JSON.stringify(data));
  } catch (e) {
    console.warn('[ARKX] Blobs save failed, in-memory only');
  }
}

module.exports = { getDb, saveDb, genId, hashPassword, verifyPassword, defaultDB, migrate, ADMIN_EMAIL };
