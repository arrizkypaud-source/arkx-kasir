/**
 * ARKX Kasir — Netlify Function (single catch-all)
 * Routes: /api/login, /api/signup, /api/me, /api/products, /api/sales, etc.
 */
const { signToken, verifyToken, hashPassword, verifyPassword } = require('./utils/auth');
const { getDb, saveDb, genId, ADMIN_EMAIL } = require('./utils/db');
const { jsonResponse, sanitizeStr, validateLogoUrl, todayStr, dayStr } = require('./utils/response');

const POINT_RP = 100;
const EARN_PER = 10000;

// ---------- rate limiter ----------
const rateBuckets = new Map();
function rateLimit(key, maxReqs = 5, windowMs = 60000) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start > windowMs) { bucket = { start: now, count: 0 }; rateBuckets.set(key, bucket); }
  bucket.count++;
  return bucket.count > maxReqs;
}

// ---------- routing ----------
async function handleRoute(method, path, event, user) {
  const body = (['POST', 'PUT', 'PATCH'].includes(method) && event.body)
    ? (event.isBase64 ? JSON.parse(Buffer.from(event.body, 'base64').toString()) : JSON.parse(event.body))
    : {};

  // AUTH
  if (method === 'POST' && path === '/api/signup') {
    if (rateLimit('signup:' + event.headers?.['client-ip'], 3, 3600000)) return jsonResponse(429, { message: 'Terlalu banyak percobaan' });
    const d = await getDb();
    const name = sanitizeStr(body.name, 50);
    const email = sanitizeStr(body.email, 100).toLowerCase();
    const password = String(body.password || '');
    if (!name || !email || !password) return jsonResponse(400, { message: 'Nama, email & password wajib' });
    if (password.length < 6) return jsonResponse(400, { message: 'Password minimal 6 karakter' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse(400, { message: 'Format email tidak valid' });
    if (d.users.find(u => u.email === email)) return jsonResponse(400, { message: 'Email sudah terdaftar' });
    const isAdmin = email === ADMIN_EMAIL.toLowerCase();
    d.users.push({ id: genId('U'), name, email, password: hashPassword(password), role: isAdmin ? 'admin' : 'user', status: isAdmin ? 'approved' : 'pending', createdAt: new Date().toISOString() });
    await saveDb(d);
    return jsonResponse(200, { message: isAdmin ? 'Akun admin aktif!' : 'Pendaftaran berhasil! Menunggu approval admin.', needApproval: !isAdmin });
  }

  if (method === 'POST' && path === '/api/login') {
    if (rateLimit('login:' + event.headers?.['client-ip'], 5, 60000)) return jsonResponse(429, { message: 'Terlalu banyak percobaan login' });
    const d = await getDb();
    const email = sanitizeStr(body.email, 100).toLowerCase();
    const u = d.users.find(x => x.email === email);
    if (!u) return jsonResponse(400, { message: 'Email tidak ditemukan' });
    if (!verifyPassword(body.password, u.password)) return jsonResponse(400, { message: 'Password salah' });
    if (u.status !== 'approved') return jsonResponse(403, { message: 'Akun belum di-approve admin.' });
    return jsonResponse(200, { token: signToken({ id: u.id, email: u.email, role: u.role, name: u.name }), user: { id: u.id, name: u.name, email: u.email, role: u.role } });
  }

  if (method === 'GET' && path === '/api/me') {
    const d = await getDb();
    const x = d.users.find(i => i.id === user.id);
    if (!x) return jsonResponse(404, { message: 'User tidak ditemukan' });
    return jsonResponse(200, { id: x.id, name: x.name, email: x.email, role: x.role, status: x.status });
  }

  if (method === 'PUT' && path === '/api/me') {
    const d = await getDb();
    const x = d.users.find(i => i.id === user.id);
    if (body.name && body.name.trim()) x.name = sanitizeStr(body.name, 50);
    await saveDb(d);
    return jsonResponse(200, { message: 'Profil diperbarui', name: x.name });
  }

  if (method === 'PUT' && path === '/api/me/password') {
    const d = await getDb();
    const x = d.users.find(i => i.id === user.id);
    if (!verifyPassword(body.oldPassword || '', x.password)) return jsonResponse(400, { message: 'Password lama salah' });
    if (!body.newPassword || String(body.newPassword).length < 6) return jsonResponse(400, { message: 'Password baru minimal 6 karakter' });
    x.password = hashPassword(body.newPassword);
    await saveDb(d);
    return jsonResponse(200, { message: 'Password berhasil diganti' });
  }

  // SETTINGS
  if (method === 'GET' && path === '/api/settings') {
    const d = await getDb();
    return jsonResponse(200, d.settings);
  }
  if (method === 'PUT' && path === '/api/settings') {
    if (user.role !== 'admin') return jsonResponse(403, { message: 'Khusus admin' });
    const d = await getDb();
    for (const k of ['storeName', 'storeAddress', 'storePhone', 'footerNote'])
      if (body[k] !== undefined) d.settings[k] = sanitizeStr(body[k], 200);
    if (body.logoUrl !== undefined) d.settings.logoUrl = validateLogoUrl(body.logoUrl);
    await saveDb(d);
    return jsonResponse(200, d.settings);
  }

  // USERS
  if (method === 'GET' && path === '/api/users') {
    if (user.role !== 'admin') return jsonResponse(403, { message: 'Khusus admin' });
    const d = await getDb();
    return jsonResponse(200, d.users.map(({ password, ...u }) => u));
  }
  if (method === 'PUT' && /^\/api\/users\/[^/]+\/status$/.test(path)) {
    if (user.role !== 'admin') return jsonResponse(403, { message: 'Khusus admin' });
    const id = path.split('/')[3];
    const d = await getDb();
    const u = d.users.find(x => x.id === id);
    if (!u) return jsonResponse(404, { message: 'User tidak ditemukan' });
    if (u.email === ADMIN_EMAIL.toLowerCase()) return jsonResponse(400, { message: 'Admin utama tidak bisa diubah' });
    if (!['approved', 'rejected', 'pending'].includes(body.status)) return jsonResponse(400, { message: 'Status tidak valid' });
    u.status = body.status;
    await saveDb(d);
    return jsonResponse(200, { message: `User ${body.status}` });
  }
  if (method === 'DELETE' && /^\/api\/users\/[^/]+$/.test(path)) {
    if (user.role !== 'admin') return jsonResponse(403, { message: 'Khusus admin' });
    const id = path.split('/')[3];
    const d = await getDb();
    const idx = d.users.findIndex(x => x.id === id);
    if (idx === -1) return jsonResponse(404, { message: 'Not found' });
    if (d.users[idx].email === ADMIN_EMAIL.toLowerCase()) return jsonResponse(400, { message: 'Admin utama tidak bisa dihapus' });
    d.users.splice(idx, 1);
    await saveDb(d);
    return jsonResponse(200, { message: 'User dihapus' });
  }

  // PRODUCTS
  if (method === 'GET' && path === '/api/products') {
    const d = await getDb();
    return jsonResponse(200, d.products);
  }
  if (method === 'GET' && /^\/api\/products\/barcode\/[^/]+$/.test(path)) {
    const code = path.split('/')[4];
    const d = await getDb();
    const prod = d.products.find(x => x.barcode === code);
    return prod ? jsonResponse(200, prod) : jsonResponse(404, { message: 'Produk tidak ditemukan' });
  }
  if (method === 'POST' && path === '/api/products') {
    const d = await getDb();
    const barcode = sanitizeStr(body.barcode, 30);
    const name = sanitizeStr(body.name, 100);
    const category = sanitizeStr(body.category, 50) || 'Umum';
    const price = Number(body.price);
    const cost = Number(body.cost || 0);
    if (!barcode || !name) return jsonResponse(400, { message: 'Barcode & nama wajib' });
    if (!Number.isFinite(price) || price <= 0) return jsonResponse(400, { message: 'Harga harus lebih dari 0' });
    if (!Number.isFinite(cost) || cost < 0) return jsonResponse(400, { message: 'Harga modal tidak valid' });
    if (d.products.find(x => x.barcode === barcode)) return jsonResponse(400, { message: 'Barcode sudah terdaftar' });
    const prod = { id: genId('P'), barcode, name, price, cost, stock: Math.max(0, Number(body.stock || 0)), minStock: Math.max(0, Number(body.minStock ?? 5)), category };
    d.products.push(prod);
    await saveDb(d);
    return jsonResponse(200, prod);
  }
  if (method === 'PUT' && /^\/api\/products\/[^/]+$/.test(path)) {
    const id = path.split('/')[3];
    const d = await getDb();
    const x = d.products.find(i => i.id === id);
    if (!x) return jsonResponse(404, { message: 'Not found' });
    if (body.barcode !== undefined) {
      const nb = sanitizeStr(body.barcode, 30);
      if (nb && d.products.find(y => y.barcode === nb && y.id !== id)) return jsonResponse(400, { message: 'Barcode sudah dipakai' });
      if (nb) x.barcode = nb;
    }
    if (body.name !== undefined) x.name = sanitizeStr(body.name, 100);
    if (body.category !== undefined) x.category = sanitizeStr(body.category, 50);
    if (body.price !== undefined) { const p = Number(body.price); if (!Number.isFinite(p) || p <= 0) return jsonResponse(400, { message: 'Harga harus > 0' }); x.price = p; }
    if (body.cost !== undefined) { const c = Number(body.cost); if (!Number.isFinite(c) || c < 0) return jsonResponse(400, { message: 'Modal tidak valid' }); x.cost = c; }
    if (body.stock !== undefined) x.stock = Math.max(0, Number(body.stock));
    if (body.minStock !== undefined) x.minStock = Math.max(0, Number(body.minStock));
    await saveDb(d);
    return jsonResponse(200, x);
  }
  if (method === 'POST' && /^\/api\/products\/[^/]+\/restock$/.test(path)) {
    const id = path.split('/')[3];
    const d = await getDb();
    const x = d.products.find(i => i.id === id || i.barcode === id);
    if (!x) return jsonResponse(404, { message: 'Produk tidak ditemukan' });
    const qty = Number(body.qty || 0);
    if (!Number.isFinite(qty) || qty <= 0) return jsonResponse(400, { message: 'Qty harus > 0' });
    x.stock += qty;
    await saveDb(d);
    return jsonResponse(200, x);
  }
  if (method === 'DELETE' && /^\/api\/products\/[^/]+$/.test(path)) {
    const id = path.split('/')[3];
    const d = await getDb();
    const idx = d.products.findIndex(x => x.id === id);
    if (idx === -1) return jsonResponse(404, { message: 'Not found' });
    d.products.splice(idx, 1);
    await saveDb(d);
    return jsonResponse(200, { message: 'Produk dihapus' });
  }

  // CUSTOMERS
  if (method === 'GET' && path === '/api/customers') {
    const d = await getDb();
    return jsonResponse(200, d.customers);
  }
  if (method === 'POST' && path === '/api/customers') {
    const d = await getDb();
    const name = sanitizeStr(body.name, 50);
    const phone = sanitizeStr(body.phone, 20);
    if (!name || !phone) return jsonResponse(400, { message: 'Nama & no. HP wajib' });
    if (d.customers.find(c => c.phone === phone)) return jsonResponse(400, { message: 'No. HP sudah terdaftar' });
    const c = { id: genId('C'), name, phone, points: Math.max(0, Number(body.points || 0)), createdAt: new Date().toISOString() };
    d.customers.push(c);
    await saveDb(d);
    return jsonResponse(200, c);
  }
  if (method === 'PUT' && /^\/api\/customers\/[^/]+$/.test(path)) {
    const id = path.split('/')[3];
    const d = await getDb();
    const c = d.customers.find(x => x.id === id);
    if (!c) return jsonResponse(404, { message: 'Member tidak ditemukan' });
    if (body.name) c.name = sanitizeStr(body.name, 50);
    if (body.phone) c.phone = sanitizeStr(body.phone, 20);
    if (body.points != null) c.points = Math.max(0, Math.floor(Number(body.points)));
    await saveDb(d);
    return jsonResponse(200, c);
  }
  if (method === 'DELETE' && /^\/api\/customers\/[^/]+$/.test(path)) {
    const id = path.split('/')[3];
    const d = await getDb();
    const idx = d.customers.findIndex(x => x.id === id);
    if (idx === -1) return jsonResponse(404, { message: 'Not found' });
    d.customers.splice(idx, 1);
    await saveDb(d);
    return jsonResponse(200, { message: 'Member dihapus' });
  }

  // SALES
  if (method === 'GET' && path === '/api/sales') {
    const d = await getDb();
    return jsonResponse(200, d.sales.slice().reverse());
  }
  if (method === 'POST' && path === '/api/sales') {
    const d = await getDb();
    const items = body.items || [];
    if (!items.length) return jsonResponse(400, { message: 'Keranjang kosong' });
    let subtotal = 0, profitTotal = 0;
    const saleItems = [];
    for (const it of items) {
      const qty = Math.floor(Number(it.qty));
      if (!Number.isFinite(qty) || qty <= 0) return jsonResponse(400, { message: 'Qty tidak valid' });
      const prod = d.products.find(x => x.barcode === String(it.barcode) || x.id === it.barcode);
      if (!prod) return jsonResponse(400, { message: 'Produk tidak ditemukan' });
      if (prod.stock < qty) return jsonResponse(400, { message: `Stok ${prod.name} kurang (sisa ${prod.stock})` });
      const unitCost = Number(prod.cost || 0);
      subtotal += prod.price * qty;
      profitTotal += (prod.price - unitCost) * qty;
      saleItems.push({ barcode: prod.barcode, name: prod.name, price: prod.price, cost: unitCost, qty, subtotal: prod.price * qty, profit: (prod.price - unitCost) * qty });
    }
    let discountAmount = 0, discountType = null, discountValue = null, pointsUsed = 0;
    const cust = body.customerId ? d.customers.find(c => c.id === body.customerId) : null;
    const disc = body.discount || {};
    const dv = Number(disc.value);
    if (disc.type === 'percent' && Number.isFinite(dv) && dv > 0) { discountType = 'percent'; discountValue = Math.min(dv, 100); discountAmount = Math.round(subtotal * discountValue / 100); }
    else if (disc.type === 'points' && Number.isFinite(dv) && dv > 0) {
      if (!cust) return jsonResponse(400, { message: 'Diskon poin butuh member' });
      pointsUsed = Math.min(Math.floor(dv), cust.points);
      if (pointsUsed > 0) { discountType = 'points'; discountValue = pointsUsed; discountAmount = pointsUsed * POINT_RP; }
    } else if (disc.type === 'nominal' && Number.isFinite(dv) && dv > 0) { discountType = 'nominal'; discountValue = dv; discountAmount = dv; }
    discountAmount = Math.min(discountAmount, subtotal);
    const total = Math.round(subtotal - discountAmount);
    const paid = Number(body.paidAmount != null ? body.paidAmount : total);
    if (!Number.isFinite(paid)) return jsonResponse(400, { message: 'Nominal bayar tidak valid' });
    if (paid < total) return jsonResponse(400, { message: 'Uang bayar kurang dari total' });
    for (const si of saleItems) d.products.find(x => x.barcode === si.barcode).stock -= si.qty;
    let pointsEarned = 0;
    if (cust) { if (pointsUsed > 0) cust.points -= pointsUsed; pointsEarned = Math.floor(total / EARN_PER); cust.points += pointsEarned; }
    const curShift = d.shifts.find(s => s.status === 'open');
    const sale = { id: genId('TRX'), number: 'INV/' + todayStr().replace(/-/g, '') + '/' + String(d.sales.length + 1).padStart(4, '0'), date: new Date().toISOString(), items: saleItems, subtotal, totalProfit: Math.round(profitTotal), discount: discountType ? { type: discountType, value: discountValue, amount: discountAmount } : null, total, payment: body.payment || 'cash', paidAmount: paid, change: paid - total, customerId: cust ? cust.id : null, memberName: cust ? cust.name : null, pointsUsed, pointsEarned, cashier: user.name, shiftId: curShift ? curShift.id : null, status: 'ok', store: { ...d.settings } };
    d.sales.push(sale);
    await saveDb(d);
    return jsonResponse(200, sale);
  }
  if (method === 'POST' && /^\/api\/sales\/[^/]+\/void$/.test(path)) {
    const id = path.split('/')[3];
    const d = await getDb();
    const sale = d.sales.find(s => s.id === id);
    if (!sale) return jsonResponse(404, { message: 'Transaksi tidak ditemukan' });
    if (sale.status === 'void') return jsonResponse(400, { message: 'Sudah dibatalkan' });
    for (const it of sale.items) { const prod = d.products.find(x => x.barcode === it.barcode); if (prod) prod.stock += it.qty; }
    if (sale.customerId) { const cust = d.customers.find(c => c.id === sale.customerId); if (cust) { cust.points -= (sale.pointsEarned || 0); cust.points += (sale.pointsUsed || 0); if (cust.points < 0) cust.points = 0; } }
    sale.status = 'void'; sale.voidReason = sanitizeStr(body.reason, 200) || '-'; sale.voidedBy = user.name; sale.voidedAt = new Date().toISOString();
    await saveDb(d);
    return jsonResponse(200, { message: 'Transaksi dibatalkan, stok dikembalikan' });
  }

  // SHIFTS
  if (method === 'GET' && path === '/api/shifts') {
    const d = await getDb();
    return jsonResponse(200, d.shifts.slice().reverse());
  }
  if (method === 'GET' && path === '/api/shifts/current') {
    const d = await getDb();
    const raw = d.shifts.find(s => s.status === 'open');
    if (!raw) return jsonResponse(200, null);
    const sales = d.sales.filter(s => s.shiftId === raw.id && s.status === 'ok');
    return jsonResponse(200, { ...raw, liveCash: sales.filter(s => s.payment === 'cash').reduce((a, s) => a + s.total, 0), liveTotal: sales.reduce((a, s) => a + s.total, 0), trxCount: sales.length });
  }
  if (method === 'POST' && path === '/api/shifts/open') {
    const d = await getDb();
    if (d.shifts.find(s => s.status === 'open')) return jsonResponse(400, { message: 'Masih ada shift aktif. Tutup dulu.' });
    const openingCash = Number(body.openingCash || 0);
    if (!Number.isFinite(openingCash) || openingCash < 0) return jsonResponse(400, { message: 'Saldo awal tidak valid' });
    const shift = { id: genId('SH'), openedBy: user.name, openedAt: new Date().toISOString(), openingCash, status: 'open' };
    d.shifts.push(shift);
    await saveDb(d);
    return jsonResponse(200, shift);
  }
  if (method === 'POST' && path === '/api/shifts/close') {
    const d = await getDb();
    const cur = d.shifts.find(s => s.status === 'open');
    if (!cur) return jsonResponse(400, { message: 'Tidak ada shift aktif' });
    const cashSales = d.sales.filter(s => s.shiftId === cur.id && s.status === 'ok' && s.payment === 'cash').reduce((a, s) => a + s.total, 0);
    cur.expectedCash = cur.openingCash + cashSales;
    cur.closingCash = Number(body.closingCash || 0);
    cur.difference = cur.closingCash - cur.expectedCash;
    cur.closedBy = user.name; cur.closedAt = new Date().toISOString(); cur.status = 'closed';
    cur.totalSales = d.sales.filter(s => s.shiftId === cur.id && s.status === 'ok').reduce((a, s) => a + s.total, 0);
    await saveDb(d);
    return jsonResponse(200, cur);
  }

  // REPORTS
  if (method === 'GET' && path === '/api/reports') {
    const d = await getDb();
    const valid = d.sales.filter(s => s.status !== 'void');
    const today = todayStr();
    const monthPrefix = today.slice(0, 7);
    const last14 = [];
    for (let i = 13; i >= 0; i--) { const dt = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); last14.push({ date: dt, revenue: valid.filter(s => dayStr(s.date) === dt).reduce((a, s) => a + s.total, 0) }); }
    const topMap = {};
    for (const s of valid) for (const it of s.items) { topMap[it.name] = topMap[it.name] || { name: it.name, qty: 0, revenue: 0, profit: 0 }; topMap[it.name].qty += it.qty; topMap[it.name].revenue += it.subtotal; topMap[it.name].profit += Number(it.profit || 0); }
    return jsonResponse(200, {
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
  }

  // DASHBOARD
  if (method === 'GET' && path === '/api/dashboard') {
    const d = await getDb();
    const valid = d.sales.filter(s => s.status !== 'void');
    const today = todayStr();
    const monthPrefix = today.slice(0, 7);
    const todays = valid.filter(s => dayStr(s.date) === today);
    const last7 = [];
    for (let i = 6; i >= 0; i--) { const dt = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); last7.push({ date: dt, revenue: valid.filter(s => dayStr(s.date) === dt).reduce((a, s) => a + s.total, 0) }); }
    const topMap = {};
    for (const s of valid) for (const it of s.items) { topMap[it.name] = topMap[it.name] || { name: it.name, qty: 0, revenue: 0 }; topMap[it.name].qty += it.qty; topMap[it.name].revenue += it.subtotal; }
    const lowStock = d.products.filter(p => p.stock <= p.minStock);
    const curShift = d.shifts.find(s => s.status === 'open') || null;
    return jsonResponse(200, {
      todayRevenue: todays.reduce((a, s) => a + s.total, 0), todayProfit: todays.reduce((a, s) => a + (s.totalProfit || 0), 0), todayCount: todays.length,
      todayItemsSold: todays.reduce((a, s) => a + s.items.reduce((x, i) => x + i.qty, 0), 0),
      monthRevenue: valid.filter(s => dayStr(s.date).startsWith(monthPrefix)).reduce((a, s) => a + s.total, 0),
      monthProfit: valid.filter(s => dayStr(s.date).startsWith(monthPrefix)).reduce((a, s) => a + (s.totalProfit || 0), 0),
      memberCount: d.customers.length, productCount: d.products.length, last7,
      topProducts: Object.values(topMap).sort((a, b) => b.qty - a.qty).slice(0, 5),
      lowStockTop: lowStock.slice(0, 5), lowStockCount: lowStock.length,
      recentSales: valid.slice(-8).reverse().map(s => ({ id: s.id, number: s.number, date: s.date, cashier: s.cashier, memberName: s.memberName, total: s.total, payment: s.payment })),
      shift: curShift ? { openedBy: curShift.openedBy, openedAt: curShift.openedAt } : null
    });
  }

  // BACKUP
  if (method === 'GET' && path === '/api/backup') {
    if (user.role !== 'admin') return jsonResponse(403, { message: 'Khusus admin' });
    const d = await getDb();
    return jsonResponse(200, JSON.stringify(d, null, 2), { 'Content-Disposition': `attachment; filename="arkx-backup-${todayStr()}.json"` });
  }
  if (method === 'POST' && path === '/api/restore') {
    if (user.role !== 'admin') return jsonResponse(403, { message: 'Khusus admin' });
    const data = body.data;
    if (!data || !Array.isArray(data.users) || !Array.isArray(data.products)) return jsonResponse(400, { message: 'File backup tidak valid' });
    const migrated = require('./utils/db').migrate(data);
    await saveDb(migrated);
    return jsonResponse(200, { message: 'Data berhasil direstore' });
  }

  return jsonResponse(404, { message: 'Endpoint tidak ditemukan' });
}

// ---------- Netlify Function Handler ----------
exports.handler = async (event, context) => {
  const method = event.httpMethod;
  let path;
  try { path = decodeURIComponent(event.path); } catch { return jsonResponse(400, { message: 'Bad request' }); }

  // Strip /.netlify/functions/api prefix if present
  path = path.replace(/^\/\.netlify\/functions\/api/, '') || '/';
  if (!path.startsWith('/api/')) path = '/api' + path;

  // Auth check (skip for login/signup/settings GET)
  const publicRoutes = ['/api/login', '/api/signup', '/api/settings'];
  let user = null;
  if (!publicRoutes.includes(path) || method !== 'GET') {
    const authHeader = event.headers?.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (token) user = verifyToken(token);
    if (!user && !publicRoutes.includes(path)) return jsonResponse(401, { message: 'Silakan login dulu' });
  }

  try {
    return await handleRoute(method, path, event, user);
  } catch (e) {
    console.error('[ARKX Error]', e);
    return jsonResponse(500, { message: 'Terjadi kesalahan server' });
  }
};
