/**
 * ARKX Kasir Server v3 — Pure Node.js (zero dependency)
 * Fix: env-based secrets, rate limiting, mutex, UUID, input validation
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'arkx-kasir-dev-secret-change-in-production';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'nuallakoko@gmail.com';
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const POINT_RP = 100;
const EARN_PER = 10000;
const MAX_BODY_SIZE = 1024 * 1024; // 1MB

if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET tidak diset. Gunakan env variable untuk production!');
}

// ---------- password ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = stored.split(':');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex'), 'hex'));
  } catch { return false; }
}
function generatePassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let r = '';
  const buf = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) r += chars[buf[i] % chars.length];
  return r;
}

// ---------- token ----------
const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function signToken(payload) {
  const h = b64url({ alg: 'HS256', typ: 'JWT' });
  const b = b64url({ ...payload, exp: Date.now() + 7 * 24 * 3600 * 1000 });
  const s = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest('base64url');
  return `${h}.${b}.${s}`;
}
function verifyToken(token) {
  try {
    const [h, b, s] = token.split('.');
    if (s !== crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest('base64url')) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp < Date.now() ? null : p;
  } catch { return null; }
}

// ---------- rate limiter ----------
const rateBuckets = new Map();
function rateLimit(key, maxReqs = 5, windowMs = 60000) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count > maxReqs;
}
// cleanup every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) { if (now - v.start > 300000) rateBuckets.delete(k); }
}, 300000).unref();

// ---------- DB ----------
function genId(prefix) { return prefix + crypto.randomUUID().slice(0, 12); }

let db = null;
let dbLock = Promise.resolve();

function defaultDB() {
  const adminPw = process.env.ADMIN_PASSWORD || generatePassword(12);
  console.log(`\n  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║  🛒  ARKX KASIR v3 — First Run Setup         ║`);
  console.log(`  ╠══════════════════════════════════════════════╣`);
  console.log(`  ║  Admin email: ${ADMIN_EMAIL}`);
  console.log(`  ║  Admin password: ${adminPw}`);
  console.log(`  ║  ⚠️  Simpan password ini! Tidak akan ditampilkan lagi.`);
  console.log(`  ╚══════════════════════════════════════════════╝\n`);
  return {
    users: [{
      id: genId('U'), name: 'Admin ARKX', email: ADMIN_EMAIL,
      password: hashPassword(adminPw), role: 'admin', status: 'approved',
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
    settings: {
      storeName: 'ARKX MART',
      storeAddress: 'Jl. Merdeka No. 123, Jakarta',
      storePhone: '0812-3456-7890',
      footerNote: 'Terima kasih sudah berbelanja!',
      logoUrl: ''
    }
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

function loadDB() {
  if (db) return db;
  if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  if (!fs.existsSync(DB_PATH)) { db = defaultDB(); saveDBSync(); return db; }
  try { db = migrate(JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))); }
  catch { db = defaultDB(); saveDBSync(); }
  return db;
}

function saveDBSync() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function saveDB() {
  const doWrite = () => { saveDBSync(); };
  dbLock = dbLock.then(doWrite).catch(doWrite);
  return dbLock;
}

// ---------- helpers ----------
function json(res, code, obj, headers = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        resolve(null);
        return;
      }
      d += chunk;
    });
    req.on('end', () => {
      if (size > MAX_BODY_SIZE) return resolve(null);
      if (!d) return resolve({});
      try { resolve(JSON.parse(d)); }
      catch { resolve(null); }
    });
  });
}

function sanitizeStr(s, maxLen = 200) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim().slice(0, maxLen);
}

function validateLogoUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:image/')) return url;
  if (url.startsWith('https://') || url.startsWith('http://')) return url;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  return '';
}

const dayStr = iso => iso.slice(0, 10);
const todayStr = () => new Date().toISOString().slice(0, 10);

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, handler, opts });
}

// ================= AUTH =================
route('POST', '/api/signup', async (req, res, p, body) => {
  if (rateLimit('signup:' + req.socket.remoteAddress, 3, 3600000)) return json(res, 429, { message: 'Terlalu banyak percobaan. Coba lagi nanti.' });
  const d = loadDB();
  const name = sanitizeStr(body.name, 50);
  const email = sanitizeStr(body.email, 100).toLowerCase();
  const password = String(body.password || '');
  if (!name || !email || !password) return json(res, 400, { message: 'Nama, email & password wajib' });
  if (password.length < 6) return json(res, 400, { message: 'Password minimal 6 karakter' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { message: 'Format email tidak valid' });
  if (d.users.find(u => u.email === email)) return json(res, 400, { message: 'Email sudah terdaftar' });
  const isAdmin = email === ADMIN_EMAIL.toLowerCase();
  d.users.push({ id: genId('U'), name, email, password: hashPassword(password), role: isAdmin ? 'admin' : 'user', status: isAdmin ? 'approved' : 'pending', createdAt: new Date().toISOString() });
  await saveDB();
  json(res, 200, { message: isAdmin ? 'Akun admin aktif!' : 'Pendaftaran berhasil! Menunggu approval admin.', needApproval: !isAdmin });
});

route('POST', '/api/login', async (req, res, p, body) => {
  if (rateLimit('login:' + req.socket.remoteAddress, 5, 60000)) return json(res, 429, { message: 'Terlalu banyak percobaan login. Tunggu 1 menit.' });
  const d = loadDB();
  const email = sanitizeStr(body.email, 100).toLowerCase();
  const user = d.users.find(u => u.email === email);
  if (!user) return json(res, 400, { message: 'Email tidak ditemukan' });
  if (!verifyPassword(body.password, user.password)) return json(res, 400, { message: 'Password salah' });
  if (user.status !== 'approved') return json(res, 403, { message: 'Akun belum di-approve admin.' });
  json(res, 200, { token: signToken({ id: user.id, email: user.email, role: user.role, name: user.name }), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

route('GET', '/api/me', async (req, res, p, b, u) => {
  const x = loadDB().users.find(i => i.id === u.id);
  if (!x) return json(res, 404, { message: 'User tidak ditemukan' });
  json(res, 200, { id: x.id, name: x.name, email: x.email, role: x.role, status: x.status });
}, { auth: true });

route('PUT', '/api/me', async (req, res, p, body, u) => {
  const d = loadDB();
  const x = d.users.find(i => i.id === u.id);
  if (body.name && body.name.trim()) x.name = sanitizeStr(body.name, 50);
  await saveDB();
  json(res, 200, { message: 'Profil diperbarui', name: x.name });
}, { auth: true });

route('PUT', '/api/me/password', async (req, res, p, body, u) => {
  const d = loadDB();
  const x = d.users.find(i => i.id === u.id);
  if (!verifyPassword(body.oldPassword || '', x.password)) return json(res, 400, { message: 'Password lama salah' });
  if (!body.newPassword || String(body.newPassword).length < 6) return json(res, 400, { message: 'Password baru minimal 6 karakter' });
  x.password = hashPassword(body.newPassword);
  await saveDB();
  json(res, 200, { message: 'Password berhasil diganti' });
}, { auth: true });

// ================= SETTINGS =================
route('GET', '/api/settings', async (req, res) => json(res, 200, loadDB().settings));
route('PUT', '/api/settings', async (req, res, p, body) => {
  const d = loadDB();
  for (const k of ['storeName', 'storeAddress', 'storePhone', 'footerNote'])
    if (body[k] !== undefined) d.settings[k] = sanitizeStr(body[k], 200);
  if (body.logoUrl !== undefined) d.settings.logoUrl = validateLogoUrl(body.logoUrl);
  await saveDB();
  json(res, 200, d.settings);
}, { auth: true, admin: true });

// ================= USERS =================
route('GET', '/api/users', async (req, res) =>
  json(res, 200, loadDB().users.map(({ password, ...u }) => u)), { auth: true, admin: true });

route('PUT', '/api/users/:id/status', async (req, res, p, body) => {
  const d = loadDB();
  const u = d.users.find(x => x.id === p.id);
  if (!u) return json(res, 404, { message: 'User tidak ditemukan' });
  if (u.email === ADMIN_EMAIL.toLowerCase()) return json(res, 400, { message: 'Admin utama tidak bisa diubah statusnya' });
  if (!['approved', 'rejected', 'pending'].includes(body.status)) return json(res, 400, { message: 'Status tidak valid' });
  u.status = body.status;
  await saveDB();
  json(res, 200, { message: `User ${body.status}` });
}, { auth: true, admin: true });

route('DELETE', '/api/users/:id', async (req, res, p) => {
  const d = loadDB();
  const idx = d.users.findIndex(x => x.id === p.id);
  if (idx === -1) return json(res, 404, { message: 'Not found' });
  if (d.users[idx].email === ADMIN_EMAIL.toLowerCase()) return json(res, 400, { message: 'Admin utama tidak bisa dihapus' });
  d.users.splice(idx, 1);
  await saveDB();
  json(res, 200, { message: 'User dihapus' });
}, { auth: true, admin: true });

// ================= PRODUCTS =================
route('GET', '/api/products', async (req, res) => json(res, 200, loadDB().products), { auth: true });

route('GET', '/api/products/barcode/:code', async (req, res, p) => {
  const prod = loadDB().products.find(x => x.barcode === p.code);
  prod ? json(res, 200, prod) : json(res, 404, { message: 'Produk tidak ditemukan' });
}, { auth: true });

route('POST', '/api/products', async (req, res, p, body) => {
  const d = loadDB();
  const barcode = sanitizeStr(body.barcode, 30);
  const name = sanitizeStr(body.name, 100);
  const category = sanitizeStr(body.category, 50) || 'Umum';
  const price = Number(body.price);
  const cost = Number(body.cost || 0);
  if (!barcode || !name) return json(res, 400, { message: 'Barcode & nama wajib' });
  if (!Number.isFinite(price) || price <= 0) return json(res, 400, { message: 'Harga harus lebih dari 0' });
  if (!Number.isFinite(cost) || cost < 0) return json(res, 400, { message: 'Harga modal tidak valid' });
  if (d.products.find(x => x.barcode === barcode)) return json(res, 400, { message: 'Barcode sudah terdaftar' });
  const prod = { id: genId('P'), barcode, name, price, cost, stock: Math.max(0, Number(body.stock || 0)), minStock: Math.max(0, Number(body.minStock ?? 5)), category };
  d.products.push(prod);
  await saveDB();
  json(res, 200, prod);
}, { auth: true });

route('PUT', '/api/products/:id', async (req, res, p, body) => {
  const d = loadDB();
  const x = d.products.find(i => i.id === p.id);
  if (!x) return json(res, 404, { message: 'Not found' });
  if (body.barcode !== undefined) {
    const newBarcode = sanitizeStr(body.barcode, 30);
    if (newBarcode && d.products.find(y => y.barcode === newBarcode && y.id !== p.id)) return json(res, 400, { message: 'Barcode sudah dipakai produk lain' });
    if (newBarcode) x.barcode = newBarcode;
  }
  if (body.name !== undefined) x.name = sanitizeStr(body.name, 100);
  if (body.category !== undefined) x.category = sanitizeStr(body.category, 50);
  if (body.price !== undefined) {
    const p2 = Number(body.price);
    if (!Number.isFinite(p2) || p2 <= 0) return json(res, 400, { message: 'Harga harus lebih dari 0' });
    x.price = p2;
  }
  if (body.cost !== undefined) {
    const c = Number(body.cost);
    if (!Number.isFinite(c) || c < 0) return json(res, 400, { message: 'Harga modal tidak valid' });
    x.cost = c;
  }
  if (body.stock !== undefined) x.stock = Math.max(0, Number(body.stock));
  if (body.minStock !== undefined) x.minStock = Math.max(0, Number(body.minStock));
  await saveDB();
  json(res, 200, x);
}, { auth: true });

route('POST', '/api/products/:id/restock', async (req, res, p, body) => {
  const d = loadDB();
  const x = d.products.find(i => i.id === p.id || i.barcode === p.id);
  if (!x) return json(res, 404, { message: 'Produk tidak ditemukan' });
  const qty = Number(body.qty || 0);
  if (!Number.isFinite(qty) || qty <= 0) return json(res, 400, { message: 'Qty harus > 0' });
  x.stock += qty;
  await saveDB();
  json(res, 200, x);
}, { auth: true });

route('DELETE', '/api/products/:id', async (req, res, p) => {
  const d = loadDB();
  const idx = d.products.findIndex(x => x.id === p.id);
  if (idx === -1) return json(res, 404, { message: 'Not found' });
  d.products.splice(idx, 1);
  await saveDB();
  json(res, 200, { message: 'Produk dihapus' });
}, { auth: true });

// ================= CUSTOMERS / MEMBER =================
route('GET', '/api/customers', async (req, res) => json(res, 200, loadDB().customers), { auth: true });

route('POST', '/api/customers', async (req, res, p, body) => {
  const d = loadDB();
  const name = sanitizeStr(body.name, 50);
  const phone = sanitizeStr(body.phone, 20);
  if (!name || !phone) return json(res, 400, { message: 'Nama & no. HP wajib' });
  if (d.customers.find(c => c.phone === phone)) return json(res, 400, { message: 'No. HP sudah terdaftar' });
  const c = { id: genId('C'), name, phone, points: Math.max(0, Number(body.points || 0)), createdAt: new Date().toISOString() };
  d.customers.push(c);
  await saveDB();
  json(res, 200, c);
}, { auth: true });

route('PUT', '/api/customers/:id', async (req, res, p, body) => {
  const d = loadDB();
  const c = d.customers.find(x => x.id === p.id);
  if (!c) return json(res, 404, { message: 'Member tidak ditemukan' });
  if (body.name) c.name = sanitizeStr(body.name, 50);
  if (body.phone) c.phone = sanitizeStr(body.phone, 20);
  if (body.points != null) c.points = Math.max(0, Math.floor(Number(body.points)));
  await saveDB();
  json(res, 200, c);
}, { auth: true });

route('DELETE', '/api/customers/:id', async (req, res, p) => {
  const d = loadDB();
  const idx = d.customers.findIndex(x => x.id === p.id);
  if (idx === -1) return json(res, 404, { message: 'Not found' });
  d.customers.splice(idx, 1);
  await saveDB();
  json(res, 200, { message: 'Member dihapus' });
}, { auth: true });

// ================= SALES =================
route('GET', '/api/sales', async (req, res) => json(res, 200, loadDB().sales.slice().reverse()), { auth: true });

route('POST', '/api/sales', async (req, res, p, body, user) => {
  const d = loadDB();
  const items = body.items || [];
  if (!items.length) return json(res, 400, { message: 'Keranjang kosong' });

  let subtotal = 0, profitTotal = 0;
  const saleItems = [];
  for (const it of items) {
    const qty = Math.floor(Number(it.qty));
    if (!Number.isFinite(qty) || qty <= 0) return json(res, 400, { message: `Qty tidak valid` });
    const prod = d.products.find(x => x.barcode === String(it.barcode) || x.id === it.barcode);
    if (!prod) return json(res, 400, { message: `Produk tidak ditemukan` });
    if (prod.stock < qty) return json(res, 400, { message: `Stok ${prod.name} kurang (sisa ${prod.stock})` });
    const unitCost = Number(prod.cost || 0);
    subtotal += prod.price * qty;
    profitTotal += (prod.price - unitCost) * qty;
    saleItems.push({ barcode: prod.barcode, name: prod.name, price: prod.price, cost: unitCost, qty, subtotal: prod.price * qty, profit: (prod.price - unitCost) * qty });
  }

  let discountAmount = 0, discountType = null, discountValue = null, pointsUsed = 0;
  const cust = body.customerId ? d.customers.find(c => c.id === body.customerId) : null;
  const disc = body.discount || {};
  const dv = Number(disc.value);
  if (disc.type === 'percent' && Number.isFinite(dv) && dv > 0) {
    discountType = 'percent'; discountValue = Math.min(dv, 100);
    discountAmount = Math.round(subtotal * discountValue / 100);
  } else if (disc.type === 'points' && Number.isFinite(dv) && dv > 0) {
    if (!cust) return json(res, 400, { message: 'Diskon poin butuh member' });
    pointsUsed = Math.min(Math.floor(dv), cust.points);
    if (pointsUsed > 0) { discountType = 'points'; discountValue = pointsUsed; discountAmount = pointsUsed * POINT_RP; }
  } else if (disc.type === 'nominal' && Number.isFinite(dv) && dv > 0) {
    discountType = 'nominal'; discountValue = dv; discountAmount = dv;
  }
  discountAmount = Math.min(discountAmount, subtotal);
  const total = Math.round(subtotal - discountAmount);

  const paid = Number(body.paidAmount != null ? body.paidAmount : total);
  if (!Number.isFinite(paid)) return json(res, 400, { message: 'Nominal bayar tidak valid' });
  if (paid < total) return json(res, 400, { message: 'Uang bayar kurang dari total' });

  for (const si of saleItems) d.products.find(x => x.barcode === si.barcode).stock -= si.qty;

  let pointsEarned = 0;
  if (cust) {
    if (pointsUsed > 0) cust.points -= pointsUsed;
    pointsEarned = Math.floor(total / EARN_PER);
    cust.points += pointsEarned;
  }

  const curShift = d.shifts.find(s => s.status === 'open');
  const sale = {
    id: genId('TRX'),
    number: 'INV/' + todayStr().replace(/-/g, '') + '/' + String(d.sales.length + 1).padStart(4, '0'),
    date: new Date().toISOString(),
    items: saleItems, subtotal,
    totalProfit: Math.round(profitTotal),
    discount: discountType ? { type: discountType, value: discountValue, amount: discountAmount } : null,
    total, payment: body.payment || 'cash',
    paidAmount: paid, change: paid - total,
    customerId: cust ? cust.id : null, memberName: cust ? cust.name : null,
    pointsUsed, pointsEarned,
    cashier: user.name,
    shiftId: curShift ? curShift.id : null,
    status: 'ok',
    store: { ...d.settings }
  };
  d.sales.push(sale);
  await saveDB();
  json(res, 200, sale);
}, { auth: true });

route('POST', '/api/sales/:id/void', async (req, res, p, body, user) => {
  const d = loadDB();
  const sale = d.sales.find(s => s.id === p.id);
  if (!sale) return json(res, 404, { message: 'Transaksi tidak ditemukan' });
  if (sale.status === 'void') return json(res, 400, { message: 'Sudah dibatalkan' });
  for (const it of sale.items) {
    const prod = d.products.find(x => x.barcode === it.barcode);
    if (prod) prod.stock += it.qty;
  }
  if (sale.customerId) {
    const cust = d.customers.find(c => c.id === sale.customerId);
    if (cust) { cust.points -= (sale.pointsEarned || 0); cust.points += (sale.pointsUsed || 0); if (cust.points < 0) cust.points = 0; }
  }
  sale.status = 'void';
  sale.voidReason = sanitizeStr(body.reason, 200) || '-';
  sale.voidedBy = user.name;
  sale.voidedAt = new Date().toISOString();
  await saveDB();
  json(res, 200, { message: 'Transaksi dibatalkan, stok dikembalikan' });
}, { auth: true });

// ================= SHIFTS =================
route('GET', '/api/shifts', async (req, res) => json(res, 200, loadDB().shifts.slice().reverse()), { auth: true });

route('GET', '/api/shifts/current', async (req, res) => {
  const d = loadDB();
  const raw = d.shifts.find(s => s.status === 'open');
  if (!raw) return json(res, 200, null);
  const sales = d.sales.filter(s => s.shiftId === raw.id && s.status === 'ok');
  json(res, 200, {
    ...raw,
    liveCash: sales.filter(s => s.payment === 'cash').reduce((a, s) => a + s.total, 0),
    liveTotal: sales.reduce((a, s) => a + s.total, 0),
    trxCount: sales.length
  });
}, { auth: true });

route('POST', '/api/shifts/open', async (req, res, p, body, user) => {
  const d = loadDB();
  if (d.shifts.find(s => s.status === 'open')) return json(res, 400, { message: 'Masih ada shift aktif. Tutup dulu.' });
  const openingCash = Number(body.openingCash || 0);
  if (!Number.isFinite(openingCash) || openingCash < 0) return json(res, 400, { message: 'Saldo awal tidak valid' });
  const shift = { id: genId('SH'), openedBy: user.name, openedAt: new Date().toISOString(), openingCash, status: 'open' };
  d.shifts.push(shift);
  await saveDB();
  json(res, 200, shift);
}, { auth: true });

route('POST', '/api/shifts/close', async (req, res, p, body, user) => {
  const d = loadDB();
  const cur = d.shifts.find(s => s.status === 'open');
  if (!cur) return json(res, 400, { message: 'Tidak ada shift aktif' });
  const cashSales = d.sales.filter(s => s.shiftId === cur.id && s.status === 'ok' && s.payment === 'cash').reduce((a, s) => a + s.total, 0);
  cur.expectedCash = cur.openingCash + cashSales;
  cur.closingCash = Number(body.closingCash || 0);
  cur.difference = cur.closingCash - cur.expectedCash;
  cur.closedBy = user.name;
  cur.closedAt = new Date().toISOString();
  cur.status = 'closed';
  cur.totalSales = d.sales.filter(s => s.shiftId === cur.id && s.status === 'ok').reduce((a, s) => a + s.total, 0);
  await saveDB();
  json(res, 200, cur);
}, { auth: true });

// ================= REPORTS =================
route('GET', '/api/reports', async (req, res) => {
  const d = loadDB();
  const valid = d.sales.filter(s => s.status !== 'void');
  const today = todayStr();
  const monthPrefix = today.slice(0, 7);
  const last14 = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const rev = valid.filter(s => dayStr(s.date) === dt).reduce((a, s) => a + s.total, 0);
    last14.push({ date: dt, revenue: rev });
  }
  const topMap = {};
  for (const s of valid) for (const it of s.items) {
    topMap[it.name] = topMap[it.name] || { name: it.name, qty: 0, revenue: 0, profit: 0 };
    topMap[it.name].qty += it.qty;
    topMap[it.name].revenue += it.subtotal;
    topMap[it.name].profit += Number(it.profit || 0);
  }
  json(res, 200, {
    todayRevenue: valid.filter(s => dayStr(s.date) === today).reduce((a, s) => a + s.total, 0),
    todayCount: valid.filter(s => dayStr(s.date) === today).length,
    todayProfit: valid.filter(s => dayStr(s.date) === today).reduce((a, s) => a + (s.totalProfit || 0), 0),
    monthRevenue: valid.filter(s => dayStr(s.date).startsWith(monthPrefix)).reduce((a, s) => a + s.total, 0),
    monthProfit: valid.filter(s => dayStr(s.date).startsWith(monthPrefix)).reduce((a, s) => a + (s.totalProfit || 0), 0),
    allTimeRevenue: valid.reduce((a, s) => a + s.total, 0),
    allTimeProfit: valid.reduce((a, s) => a + (s.totalProfit || 0), 0),
    last14, topProducts: Object.values(topMap).sort((a, b) => b.qty - a.qty).slice(0, 10),
    lowStock: d.products.filter(p => p.stock <= p.minStock),
    counts: { products: d.products.length, members: d.customers.length, sales: valid.length }
  });
}, { auth: true });

// ================= DASHBOARD =================
route('GET', '/api/dashboard', async (req, res) => {
  const d = loadDB();
  const valid = d.sales.filter(s => s.status !== 'void');
  const today = todayStr();
  const monthPrefix = today.slice(0, 7);
  const todays = valid.filter(s => dayStr(s.date) === today);
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    last7.push({ date: dt, revenue: valid.filter(s => dayStr(s.date) === dt).reduce((a, s) => a + s.total, 0) });
  }
  const topMap = {};
  for (const s of valid) for (const it of s.items) {
    topMap[it.name] = topMap[it.name] || { name: it.name, qty: 0, revenue: 0 };
    topMap[it.name].qty += it.qty;
    topMap[it.name].revenue += it.subtotal;
  }
  const lowStock = d.products.filter(p => p.stock <= p.minStock);
  const curShift = d.shifts.find(s => s.status === 'open') || null;
  json(res, 200, {
    todayRevenue: todays.reduce((a, s) => a + s.total, 0),
    todayProfit: todays.reduce((a, s) => a + (s.totalProfit || 0), 0),
    todayCount: todays.length,
    todayItemsSold: todays.reduce((a, s) => a + s.items.reduce((x, i) => x + i.qty, 0), 0),
    monthRevenue: valid.filter(s => dayStr(s.date).startsWith(monthPrefix)).reduce((a, s) => a + s.total, 0),
    monthProfit: valid.filter(s => dayStr(s.date).startsWith(monthPrefix)).reduce((a, s) => a + (s.totalProfit || 0), 0),
    memberCount: d.customers.length,
    productCount: d.products.length,
    last7,
    topProducts: Object.values(topMap).sort((a, b) => b.qty - a.qty).slice(0, 5),
    lowStockTop: lowStock.slice(0, 5),
    lowStockCount: lowStock.length,
    recentSales: valid.slice(-8).reverse().map(s => ({ id: s.id, number: s.number, date: s.date, cashier: s.cashier, memberName: s.memberName, total: s.total, payment: s.payment })),
    shift: curShift ? { openedBy: curShift.openedBy, openedAt: curShift.openedAt } : null
  });
}, { auth: true });

// ================= BACKUP / RESTORE =================
route('GET', '/api/backup', async (req, res) => {
  const data = JSON.stringify(loadDB(), null, 2);
  json(res, 200, data, { 'Content-Disposition': `attachment; filename="arkx-backup-${todayStr()}.json"` });
}, { auth: true, admin: true });

route('POST', '/api/restore', async (req, res, p, body) => {
  const data = body.data;
  if (!data || !Array.isArray(data.users) || !Array.isArray(data.products)) return json(res, 400, { message: 'File backup tidak valid' });
  db = migrate(data);
  await saveDB();
  json(res, 200, { message: 'Data berhasil direstore' });
}, { auth: true, admin: true });

// ================= SERVER =================
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return json(res, 400, { message: 'Bad request' }); }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.regex);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => params[k] = m[i + 1]);
    let user = null;
    if (r.opts.auth) {
      user = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
      if (!user) return json(res, 401, { message: 'Silakan login dulu' });
      if (r.opts.admin && user.role !== 'admin') return json(res, 403, { message: 'Khusus admin' });
    }
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    if (body === null) return json(res, 400, { message: 'Body terlalu besar atau format salah' });
    try { await r.handler(req, res, params, body, user); }
    catch (e) { console.error(e); json(res, 500, { message: 'Terjadi kesalahan server' }); }
    return;
  }

  let file = pathname === '/' ? '/index.html' : pathname;
  const pubDir = path.join(__dirname, 'public');
  const full = path.join(pubDir, file);
  if ((full === pubDir || full.startsWith(pubDir + path.sep)) && fs.existsSync(full) && fs.statSync(full).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } else {
    const index = path.join(pubDir, 'index.html');
    if (fs.existsSync(index)) { res.writeHead(200, { 'Content-Type': MIME['.html'] }); fs.createReadStream(index).pipe(res); }
    else json(res, 404, { message: 'Not found' });
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════╗');
  console.log('  ║     🛒  ARKX KASIR v3 — SECURE  🚀    ║');
  console.log(`  ║   Buka: http://localhost:${PORT}          ║`);
  console.log('  ╚═══════════════════════════════════════╝');
  console.log('');
});
