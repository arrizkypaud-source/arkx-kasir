/* ARKX Kasir v3 — Frontend Logic */
const API = '';
const POINT_RP = 100;
let TOKEN = localStorage.getItem('arkx_token') || null;
let ME = null;
let SETTINGS = {};
let PRODUCTS = [];
let CUSTOMERS = [];
let SALES = [];
let CART = [];
let MEMBER_SELECTED = null;
let scanner = null;
let scannerMode = null;

// ---------- utils ----------
const $ = id => document.getElementById(id);
const rupiah = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function validLogoUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:image/')) return esc(url);
  if (url.startsWith('https://') || url.startsWith('http://')) return esc(url);
  if (url.startsWith('/') && !url.startsWith('//')) return esc(url);
  return '';
}

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(API + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || 'Terjadi kesalahan');
  return data;
}
function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('toastWrap').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.4s'; setTimeout(() => t.remove(), 400); }, 3200);
}
function showModal(html) { $('modalContent').innerHTML = html; $('modalBg').classList.add('show'); }
function closeModal() { $('modalBg').classList.remove('show'); }
$('modalBg').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 1200; g.gain.value = 0.08;
    o.start(); o.stop(ctx.currentTime + 0.08);
  } catch {}
}

// ---------- AUTH ----------
function switchTab(tab) {
  $('tabLogin').classList.toggle('active', tab === 'login');
  $('tabSignup').classList.toggle('active', tab === 'signup');
  $('loginForm').classList.toggle('hidden', tab !== 'login');
  $('signupForm').classList.toggle('hidden', tab !== 'signup');
  $('authMsg').className = 'auth-msg';
}
function authMsg(msg, ok) { $('authMsg').textContent = msg; $('authMsg').className = 'auth-msg ' + (ok ? 'ok' : 'err'); }
async function doSignup() {
  try {
    const res = await api('/api/signup', 'POST', { name: $('suName').value.trim(), email: $('suEmail').value.trim(), password: $('suPass').value });
    authMsg(res.message + (res.needApproval ? ' 🕐' : ''), true);
    if (!res.needApproval) setTimeout(() => { switchTab('login'); $('liEmail').value = $('suEmail').value; }, 1500);
  } catch (e) { authMsg(e.message, false); }
}
async function doLogin() {
  try {
    const res = await api('/api/login', 'POST', { email: $('liEmail').value.trim(), password: $('liPass').value });
    TOKEN = res.token;
    localStorage.setItem('arkx_token', TOKEN);
    ME = res.user;
    enterApp();
  } catch (e) { authMsg(e.message, false); }
}
function logout() { localStorage.removeItem('arkx_token'); location.reload(); }

// ---------- APP INIT ----------
async function enterApp() {
  $('authPage').style.display = 'none';
  $('app').style.display = 'block';
  $('uName').textContent = ME.name;
  $('uEmail').textContent = ME.email;
  $('avatar').textContent = ME.name[0].toUpperCase();
  const rb = $('roleBadge');
  rb.textContent = ME.role.toUpperCase();
  rb.className = 'badge-role ' + ME.role;
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', ME.role !== 'admin'));

  SETTINGS = await api('/api/settings');
  applySettings();
  await Promise.all([loadProducts(), loadMembers()]);
  checkLowStock();
  renderCart();
  loadSales();
  loadDashboard();
  if (ME.role === 'admin') loadUsers();

  // auto-open shift reminder
  api('/api/shifts/current').then(cur => {
    if (!cur && !$('page-shift')) return;
    if (!cur) setTimeout(() => toast('⏱️ Belum ada shift aktif. Buka shift di menu Shift.', 'err'), 1200);
  }).catch(() => {});
}

function applySettings() {
  $('storeNameTop').textContent = SETTINGS.storeName;
  document.title = SETTINGS.storeName + ' — ARKX Kasir';
  $('setStoreName').value = SETTINGS.storeName;
  $('setStoreAddr').value = SETTINGS.storeAddress;
  $('setStorePhone').value = SETTINGS.storePhone;
  $('setFooterNote').value = SETTINGS.footerNote;
  updateReceiptPreviewSettings();
}
function checkLowStock() {
  const low = PRODUCTS.filter(p => p.stock <= p.minStock);
  if (low.length) {
    toast(`⚠️ ${low.length} produk stok menipis! Cek menu Laporan.`, 'err');
    const nav = $('navProducts');
    if (!nav.querySelector('.nav-badge')) nav.insertAdjacentHTML('beforeend', `<span class="nav-badge">${low.length}</span>`);
  }
}

// ---------- NAV ----------
document.querySelectorAll('#mainNav button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#mainNav button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ['dashboard', 'pos', 'products', 'sales', 'reports', 'members', 'shift', 'settings', 'users', 'backup']
      .forEach(p => $('page-' + p).classList.toggle('hidden', p !== btn.dataset.page));
    closeAllScanners();
    if (btn.dataset.page === 'dashboard') loadDashboard();
    if (btn.dataset.page === 'reports') loadReport();
    if (btn.dataset.page === 'shift') loadShiftPage();
  });
});
function goTo(page) {
  const btn = document.querySelector(`#mainNav button[data-page="${page}"]`);
  if (btn) btn.click();
}

// ---------- DASHBOARD ----------
async function loadDashboard() {
  try {
    const r = await api('/api/dashboard');
    $('dashWelcome').textContent = `Halo, ${ME.name.split(' ')[0]}! 👋`;
    $('dashStoreLine').textContent = `Selamat datang di ${SETTINGS.storeName} — ${new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;
    $('dashShiftInfo').innerHTML = r.shift
      ? `<span class="shift-pill on">🟢 Shift aktif · dibuka ${esc(r.shift.openedBy)} pukul ${new Date(r.shift.openedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</span>`
      : `<span class="shift-pill off" style="cursor:pointer" onclick="goTo('shift')">⚪ Belum ada shift aktif — klik untuk buka</span>`;
    $('dsTodayRev').textContent = rupiah(r.todayRevenue);
    $('dsTodayProfit').textContent = rupiah(r.todayProfit);
    $('dsTodayCount').textContent = `${r.todayCount} transaksi`;
    $('dsMonthRev').textContent = rupiah(r.monthRevenue);
    $('dsItemsSold').textContent = r.todayItemsSold;

    const max = Math.max(...r.last7.map(x => x.revenue), 1);
    $('dashChart').innerHTML = r.last7.map(x => `
      <div class="bar-col" title="${x.date}: ${rupiah(x.revenue)}">
        <div class="bar-val">${x.revenue >= 1000 ? (x.revenue / 1000).toFixed(0) + 'k' : x.revenue}</div>
        <div class="bar ${x.date === new Date().toISOString().slice(0, 10) ? 'today' : ''}" style="height:${Math.max(3, x.revenue / max * 82)}%"></div>
        <span>${['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'][new Date(x.date).getDay()]}</span>
      </div>`).join('');

    $('dashTopProducts').innerHTML = r.topProducts.length ? r.topProducts.map((p, i) => `
      <tr><td>${['🥇', '🥈', '🥉'][i] || (i + 1)}</td>
      <td style="color:#fff;font-weight:600">${esc(p.name)}</td><td>${p.qty}</td>
      <td style="color:#ffd166">${rupiah(p.revenue)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty-state">Belum ada penjualan</td></tr>';

    $('dashRecentSales').innerHTML = r.recentSales.length ? r.recentSales.map(s => `
      <tr>
        <td><code style="color:#7bed9f">${esc(s.number || s.id)}</code><br><small style="color:#776fa8">${esc(s.cashier)}${s.memberName ? ' · ' + esc(s.memberName) : ''}</small></td>
        <td>${new Date(s.date).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</td>
        <td><b style="color:#ffd166">${rupiah(s.total)}</b></td>
      </tr>`).join('')
      : '<tr><td colspan="3" class="empty-state">Belum ada transaksi hari ini</td></tr>';

    const badge = $('dashLowBadge');
    badge.textContent = r.lowStockCount;
    badge.classList.toggle('hidden', !r.lowStockCount);
    $('dashLowStock').innerHTML = r.lowStockTop.map(p => `
      <tr class="lowstock-row"><td style="color:#fff">${esc(p.name)}</td>
      <td>${p.stock}</td><td>${p.minStock}</td></tr>`).join('');
    $('dashLowEmpty').classList.toggle('hidden', r.lowStockCount > 0);
  } catch (e) { console.error('Dashboard error:', e); }
}

// ---------- PROFILE ----------
function openProfile() {
  showModal(`
    <h3>👤 Profil Saya</h3>
    <div class="form-row"><label>Email</label><input class="inp" value="${esc(ME.email)}" disabled></div>
    <div class="form-row"><label>Nama</label><input class="inp" id="pfName2" value="${esc(ME.name)}"></div>
    <hr style="border:none;border-top:1px solid rgba(255,255,255,.1);margin:16px 0;">
    <h3 style="color:#fff;font-size:14px;">🔑 Ganti Password (opsional)</h3>
    <div class="form-row"><label>Password Lama</label><input class="inp" id="pwOld" type="password"></div>
    <div class="form-row"><label>Password Baru</label><input class="inp" id="pwNew" type="password"></div>
    <div class="form-row"><label>Konfirmasi Password Baru</label><input class="inp" id="pwNew2" type="password"></div>
    <div class="modal-actions">
      <button class="btn btn-red" onclick="closeModal()">Batal</button>
      <button class="btn btn-green" onclick="saveProfile()">💾 Simpan</button>
    </div>`);
}
async function saveProfile() {
  try {
    const newName = $('pfName2').value.trim();
    if (!newName) return toast('Nama tidak boleh kosong', 'err');
    const r1 = await api('/api/me', 'PUT', { name: newName });
    ME.name = r1.name;
    $('uName').textContent = ME.name;
    $('avatar').textContent = ME.name[0].toUpperCase();
    if ($('pwNew').value) {
      if ($('pwNew').value !== $('pwNew2').value) return toast('Konfirmasi password tidak sama', 'err');
      await api('/api/me/password', 'PUT', { oldPassword: $('pwOld').value, newPassword: $('pwNew').value });
    }
    closeModal();
    toast('Profil tersimpan ✓');
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- PRODUCTS ----------
async function loadProducts() {
  PRODUCTS = await api('/api/products');
  renderQuickProducts();
  renderProductsTable();
}
function renderQuickProducts() {
  $('quickProducts').innerHTML = PRODUCTS.map(p => `
    <div class="chip ${p.stock <= 0 ? 'out' : ''}" onclick="addById('${p.id}')">
      <b>${esc(p.name)}</b>
      <span class="chip-price">${rupiah(p.price)}</span> · stok ${p.stock}
    </div>`).join('');
}
function addById(id) {
  const p = PRODUCTS.find(x => x.id === id);
  if (p) addToCart(p.barcode);
}
function renderProductsTable() {
  const q = ($('prodSearch').value || '').toLowerCase();
  const list = PRODUCTS.filter(p =>
    !q || p.name.toLowerCase().includes(q) || p.barcode.includes(q) || (p.category || '').toLowerCase().includes(q));
  $('productsEmpty').classList.toggle('hidden', list.length > 0);
  $('productsBody').innerHTML = list.map(p => {
    const unitProfit = p.price - (p.cost || 0);
    return `
    <tr class="${p.stock <= p.minStock ? 'lowstock-row' : ''}">
      <td><code style="color:#7bed9f">${esc(p.barcode)}</code></td>
      <td style="color:#fff;font-weight:600">${esc(p.name)}</td>
      <td>${esc(p.category)}</td>
      <td>${rupiah(p.cost)}</td>
      <td>${rupiah(p.price)}</td>
      <td><b style="color:${unitProfit > 0 ? '#7bed9f' : unitProfit < 0 ? '#ff6b81' : '#776fa8'}">${unitProfit >= 0 ? '+' : ''}${rupiah(unitProfit)}</b></td>
      <td><span class="badge-role ${p.stock > p.minStock ? 'approved' : p.stock > 0 ? 'pending' : 'rejected'}" style="font-size:11px">${p.stock}</span></td>
      <td style="color:#776fa8">${p.minStock}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-blue btn-sm" onclick="openRestock('${p.id}')">+ Stok</button>
        <button class="btn btn-orange btn-sm" title="Cetak label barcode" onclick="printLabel('${p.id}')">🏷️</button>
        <button class="btn btn-primary btn-sm" title="Edit" onclick="openProductForm('${p.id}')">✏️</button>
        ${ME.role === 'admin' ? `<button class="btn btn-red btn-sm" onclick="deleteProduct('${p.id}')">🗑️</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}
function openProductForm(id) {
  const p = id ? PRODUCTS.find(x => x.id === id) : {};
  showModal(`
    <h3>${id ? '✏️ Edit Produk' : '➕ Produk Baru'}</h3>
    <div class="form-row"><label>Nama Produk</label><input class="inp" id="pfName" value="${esc(p.name || '')}"></div>
    <div class="form-row"><label>Barcode</label><input class="inp" id="pfBarcode" value="${esc(p.barcode || '')}"></div>
    <div class="form-row"><label>Kategori</label><input class="inp" id="pfCategory" value="${esc(p.category || 'Umum')}"></div>
    <div class="form-row"><label>Harga Modal (Rp)</label><input class="inp" id="pfCost" type="number" value="${p.cost ?? ''}" placeholder="0" oninput="updateMarginHint()"></div>
    <div class="form-row"><label>Harga Jual (Rp)</label><input class="inp" id="pfPrice" type="number" value="${p.price ?? ''}" oninput="updateMarginHint()">
      <div id="marginHint" style="font-size:12px;margin-top:6px;color:#776fa8;">Isi modal & harga jual untuk hitung untung otomatis</div>
    </div>
    <div class="form-row"><label>Stok</label><input class="inp" id="pfStock" type="number" value="${p.stock ?? 0}"></div>
    <div class="form-row"><label>Stok Minimum (alert)</label><input class="inp" id="pfMinStock" type="number" value="${p.minStock ?? 5}"></div>
    <div class="modal-actions">
      <button class="btn btn-red" onclick="closeModal()">Batal</button>
      <button class="btn btn-green" onclick="saveProduct('${id || ''}')">💾 Simpan</button>
    </div>`);
}
function updateMarginHint() {
  const cost = Number($('pfCost').value || 0);
  const price = Number($('pfPrice').value || 0);
  const hint = $('marginHint');
  if (!price && !cost) { hint.textContent = 'Isi modal & harga jual untuk hitung untung otomatis'; hint.style.color = '#776fa8'; return; }
  if (price <= 0) { hint.textContent = '⚠️ Harga jual belum diisi'; hint.style.color = '#ff6b81'; return; }
  const margin = price - cost;
  if (margin < 0) {
    hint.textContent = `❌ RUGI Rp ${(-margin).toLocaleString('id-ID')} /unit! Harga jual lebih kecil dari modal.`;
    hint.style.color = '#ff6b81';
  } else {
    const pct = Math.round(margin / price * 100);
    hint.textContent = `✅ Untung Rp ${margin.toLocaleString('id-ID')} /unit (${pct}% margin)`;
    hint.style.color = '#7bed9f';
  }
}
async function saveProduct(id) {
  try {
    const body = {
      name: $('pfName').value.trim(), barcode: $('pfBarcode').value.trim(),
      category: $('pfCategory').value.trim(),
      cost: Number($('pfCost').value || 0),
      price: Number($('pfPrice').value),
      stock: Number($('pfStock').value), minStock: Number($('pfMinStock').value)
    };
    if (!body.name || !body.barcode) return toast('Nama & barcode wajib diisi', 'err');
    id ? await api('/api/products/' + id, 'PUT', body) : await api('/api/products', 'POST', body);
    closeModal();
    toast('Produk tersimpan ✓');
    await loadProducts();
  } catch (e) { toast(e.message, 'err'); }
}
function openRestock(id) {
  const p = PRODUCTS.find(x => x.id === id);
  showModal(`
    <h3>📦 Restock: ${esc(p.name)}</h3>
    <p style="color:#9a94c7;font-size:13px;margin-bottom:12px;">Stok sekarang: <b style="color:#fff">${p.stock}</b></p>
    <div class="form-row"><label>Jumlah tambah</label><input class="inp" id="rsQty" type="number" min="1" value="10"></div>
    <div class="modal-actions">
      <button class="btn btn-red" onclick="closeModal()">Batal</button>
      <button class="btn btn-green" onclick="doRestock('${id}')">➕ Tambah Stok</button>
    </div>`);
}
async function doRestock(id) {
  try {
    const qty = Number($('rsQty').value);
    await api(`/api/products/${id}/restock`, 'POST', { qty });
    closeModal();
    toast(`Stok bertambah ${qty} ✓`);
    await loadProducts();
  } catch (e) { toast(e.message, 'err'); }
}
async function deleteProduct(id) {
  if (!confirm('Hapus produk ini?')) return;
  try { await api('/api/products/' + id, 'DELETE'); toast('Produk dihapus'); await loadProducts(); }
  catch (e) { toast(e.message, 'err'); }
}

// ---------- BARCODE LABEL PRINT ----------
function printLabel(id) {
  const p = PRODUCTS.find(x => x.id === id);
  if (typeof JsBarcode === 'undefined') return toast('Library barcode belum termuat (cek internet)', 'err');
  showModal(`
    <h3>🏷️ Label Barcode — ${esc(p.name)}</h3>
    <div class="receipt-preview center label-receipt" id="labelBox">
      <div style="font-weight:900;font-size:14px;">${esc(SETTINGS.storeName)}</div>
      <div style="font-size:12px;">${esc(p.name)}</div>
      <svg id="labelSvg"></svg>
      <div style="font-size:15px;font-weight:900;">${rupiah(p.price)}</div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-red" onclick="closeModal()">Tutup</button>
      <button class="btn btn-green" onclick="doPrint($('labelBox').outerHTML)">🖨️ Cetak Label</button>
    </div>`);
  JsBarcode('#labelSvg', p.barcode, { format: 'CODE128', width: 2, height: 60, fontSize: 14, margin: 4 });
}
function doPrint(html) {
  $('printArea').innerHTML = html;
  window.print();
}

// ---------- CART / POS ----------
function findProduct(code) {
  return PRODUCTS.find(p => p.barcode === code || p.id === code || p.name.toLowerCase() === String(code).toLowerCase());
}
function addToCart(code) {
  const p = findProduct(String(code).trim());
  if (!p) { toast('Produk tidak ditemukan: ' + code, 'err'); return false; }
  if (p.stock <= 0) { toast(`Stok ${p.name} habis!`, 'err'); return false; }
  const item = CART.find(c => c.barcode === p.barcode);
  if (item) {
    if (item.qty + 1 > p.stock) { toast(`Stok ${p.name} hanya ${p.stock}`, 'err'); return false; }
    item.qty++;
  } else CART.push({ pid: p.id, barcode: p.barcode, name: p.name, price: p.price, qty: 1, stock: p.stock });
  renderCart(); beep();
  return true;
}
function addByBarcode(code) { if (code) { addToCart(code); $('barcodeInput').value = ''; $('barcodeInput').focus(); } }
function changeQty(pid, delta) {
  const item = CART.find(c => c.pid === pid);
  if (!item) return;
  const fresh = PRODUCTS.find(p => p.id === pid);
  const maxStock = fresh ? fresh.stock : item.stock;
  item.qty += delta;
  if (item.qty <= 0) CART = CART.filter(c => c.pid !== pid);
  else if (item.qty > maxStock) { item.qty = maxStock; toast(`Maksimal stok ${maxStock}`, 'err'); }
  renderCart();
}
function removeItem(pid) { CART = CART.filter(c => c.pid !== pid); renderCart(); }
function clearCart(manual) {
  CART = []; MEMBER_SELECTED = null;
  $('memberPhone').value = ''; $('memberResult').innerHTML = '';
  $('ddType').value = 'none'; $('ddVal').value = ''; $('ddVal').disabled = true;
  $('paidInput').value = '';
  renderCart();
  if (manual) toast('Keranjang dikosongkan');
}
function cartTotals() {
  return { subtotal: CART.reduce((s, c) => s + c.price * c.qty, 0), count: CART.reduce((s, c) => s + c.qty, 0) };
}
function currentDiscount() {
  const { subtotal } = cartTotals();
  const type = $('ddType').value;
  const val = Number($('ddVal').value || 0);
  if (type === 'none' || !val || val <= 0 || !CART.length) return { amount: 0, type: null, value: null };
  if (type === 'percent') {
    const pct = Math.min(val, 100);
    return { type: 'percent', value: pct, amount: Math.round(subtotal * pct / 100) };
  }
  if (type === 'points') {
    if (!MEMBER_SELECTED) return { err: true, msg: 'Pilih member dulu untuk pakai poin!' };
    const pts = Math.min(Math.floor(val), MEMBER_SELECTED.points);
    return { type: 'points', value: pts, amount: Math.min(pts * POINT_RP, subtotal) };
  }
  return { type: 'nominal', value: val, amount: Math.min(val, subtotal) };
}
function onDiscountTypeChange() {
  const t = $('ddType').value;
  $('ddVal').disabled = t === 'none';
  if (t === 'points' && MEMBER_SELECTED) $('ddVal').value = MEMBER_SELECTED.points;
  recalcTotals();
}
function recalcTotals() {
  const { subtotal } = cartTotals();
  const disc = currentDiscount();
  if (disc.err) { toast(disc.msg, 'err'); $('ddType').value = 'none'; $('ddVal').disabled = true; }
  const d = disc.err ? { amount: 0 } : disc;
  const total = Math.max(0, subtotal - (d.amount || 0));
  $('tSubtotal').textContent = rupiah(subtotal);
  $('discRow').style.display = d.amount ? 'flex' : 'none';
  $('tDiscount').textContent = '- ' + rupiah(d.amount || 0);
  $('tTotal').textContent = rupiah(total);
  const paid = Number($('paidInput').value || 0);
  $('tChange').textContent = rupiah(Math.max(0, paid - total));
}
function renderCart() {
  $('cartList').innerHTML = CART.map(c => `
    <div class="cart-item">
      <div class="ci-info">
        <div class="ci-name">${esc(c.name)}</div>
        <div class="ci-price">${rupiah(c.price)} × ${c.qty} = <b style="color:#ffd166">${rupiah(c.price * c.qty)}</b></div>
      </div>
      <button class="qty-btn" onclick="changeQty('${c.pid}',-1)">−</button>
      <span class="qty-num">${c.qty}</span>
      <button class="qty-btn" onclick="changeQty('${c.pid}',1)">+</button>
      <button class="qty-btn" style="background:var(--danger)" onclick="removeItem('${c.pid}')">✕</button>
    </div>`).join('');
  $('cartEmpty').classList.toggle('hidden', CART.length > 0);
  recalcTotals();
}

// ---------- MEMBER AT POS ----------
function lookupMember() {
  const phone = $('memberPhone').value.trim();
  const cust = CUSTOMERS.find(c => c.phone === phone);
  if (!cust) {
    MEMBER_SELECTED = null;
    $('memberResult').innerHTML = `<div class="member-found" style="background:rgba(255,71,87,.15)">❌ Member tidak ditemukan</div>`;
    recalcTotals();
    return;
  }
  MEMBER_SELECTED = cust;
  $('memberResult').innerHTML = `
    <div class="member-found">
      <span>👤 <b>${esc(cust.name)}</b></span>
      <span class="points-pill">${cust.points} poin (${rupiah(cust.points * POINT_RP)})</span>
      <button class="btn btn-orange btn-sm" onclick="useMemberPoints(${cust.points})">Pakai Poin</button>
    </div>`;
  recalcTotals();
}
function useMemberPoints(pts) {
  $('ddType').value = 'points';
  onDiscountTypeChange();
  $('ddVal').value = pts;
  recalcTotals();
}

// ---------- CHECKOUT ----------
async function checkout() {
  if (!CART.length) return toast('Keranjang kosong!', 'err');
  const disc = currentDiscount();
  if (disc.err) return toast(disc.msg, 'err');
  const total = Math.max(0, cartTotals().subtotal - (disc.amount || 0));
  const paid = Number($('paidInput').value || 0);
  if (paid < total) return toast('Uang diterima kurang dari total!', 'err');
  try {
    const sale = await api('/api/sales', 'POST', {
      items: CART.map(c => ({ barcode: c.barcode, qty: c.qty })),
      payment: $('payMethod').value,
      paidAmount: paid,
      discount: disc.type ? { type: disc.type, value: disc.value } : null,
      customerId: MEMBER_SELECTED ? MEMBER_SELECTED.id : null
    });
    const hadMember = !!MEMBER_SELECTED;
    clearCart();
    showReceipt(sale);
    await loadProducts();
    loadSales();
    if (hadMember) loadMembers();
    toast('Transaksi berhasil! 🎉' + (sale.pointsEarned ? ` Member dapat +${sale.pointsEarned} poin` : ''));
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- RECEIPT ----------
function receiptHTML(sale) {
  const s = sale.store || SETTINGS;
  const logo = s.logoUrl ? `<img src="${validLogoUrl(s.logoUrl)}" style="max-width:90px;max-height:60px;margin-bottom:4px;">` : '';
  const rows = sale.items.map(it => `
    <tr><td colspan="3">${esc(it.name)}</td></tr>
    <tr><td>${it.qty} x ${rupiah(it.price)}</td><td colspan="2" style="text-align:right"><b>${rupiah(it.subtotal)}</b></td></tr>`).join('');
  let discRows = '';
  if (sale.discount) {
    const label = sale.discount.type === 'percent' ? `Diskon ${sale.discount.value}%`
      : sale.discount.type === 'points' ? `Diskon ${sale.discount.value} poin` : 'Diskon';
    discRows = `<tr><td>${label}</td><td style="text-align:right">- ${rupiah(sale.discount.amount)}</td></tr>`;
  }
  const memberRows = sale.memberName ? `
    <tr><td>Member</td><td colspan="2" style="text-align:right">${esc(sale.memberName)}</td></tr>
    ${sale.pointsUsed ? `<tr><td>Poin dipakai</td><td colspan="2" style="text-align:right">-${sale.pointsUsed}</td></tr>` : ''}
    ${sale.pointsEarned ? `<tr><td>Poin didapat</td><td colspan="2" style="text-align:right">+${sale.pointsEarned}</td></tr>` : ''}` : '';
  const voidStamp = sale.status === 'void'
    ? `<div style="color:#d63031;font-weight:900;font-size:22px;margin:8px 0;">*** VOID ***</div>
       <div style="color:#d63031;">Alasan: ${esc(sale.voidReason)} · oleh ${esc(sale.voidedBy)}</div>` : '';
  return `
    <div class="receipt-preview center">
      ${logo}
      <div style="font-size:16px;font-weight:900;letter-spacing:1px;">${esc(s.storeName)}</div>
      <div>${esc(s.storeAddress)}</div>
      <div>Telp: ${esc(s.storePhone)}</div>
      <hr>
      <table>
        <tr><td>No</td><td colspan="2" style="text-align:right">${sale.number || sale.id}</td></tr>
        <tr><td>Tanggal</td><td colspan="2" style="text-align:right">${new Date(sale.date).toLocaleString('id-ID')}</td></tr>
        <tr><td>Kasir</td><td colspan="2" style="text-align:right">${esc(sale.cashier)}</td></tr>
      </table>
      <hr><table>${rows}</table><hr>
      <table>
        <tr><td>Subtotal</td><td style="text-align:right">${rupiah(sale.subtotal ?? sale.total)}</td></tr>
        ${discRows}${memberRows}
        <tr><td><b>TOTAL</b></td><td style="text-align:right"><b>${rupiah(sale.total)}</b></td></tr>
        <tr><td>Bayar (${esc(sale.payment)})</td><td style="text-align:right">${rupiah(sale.paidAmount)}</td></tr>
        <tr><td>Kembali</td><td style="text-align:right">${rupiah(sale.change)}</td></tr>
      </table>
      <hr>${voidStamp}
      <div>${esc(s.footerNote)}</div>
      <div style="margin-top:6px;font-size:10px;">Powered by ARKX Kasir</div>
    </div>`;
}
function showReceipt(sale) {
  showModal(`
    <h3>🧾 Struk Pembayaran</h3>
    ${receiptHTML(sale)}
    <div class="modal-actions">
      <button class="btn btn-red" onclick="closeModal()">Tutup</button>
      <button class="btn btn-green" onclick="doPrint($('modalContent').querySelector('.receipt-preview').outerHTML)">🖨️ Cetak Struk</button>
    </div>`);
}

// ---------- SETTINGS ----------
function updateReceiptPreviewSettings() {
  const box = $('receiptPreviewSettings');
  if (!box) return;
  const logo = SETTINGS.logoUrl ? `<img src="${validLogoUrl(SETTINGS.logoUrl)}" style="max-width:70px;max-height:45px;margin-bottom:4px;">` : '';
  box.innerHTML = `
    ${logo}
    <div style="font-size:15px;font-weight:900;">${esc(SETTINGS.storeName)}</div>
    <div>${esc(SETTINGS.storeAddress)}</div>
    <div>Telp: ${esc(SETTINGS.storePhone)}</div>
    <hr><i>… contoh item …</i><hr>
    <div><b>TOTAL: Rp xx.xxx</b></div>
    <div style="margin-top:6px;">${esc(SETTINGS.footerNote)}</div>`;
}
function onLogoFilePick(input) {
  const f = input.files[0];
  if (!f) return;
  if (!f.type.startsWith('image/') || f.type === 'image/svg+xml') { toast('Hanya file gambar (JPG/PNG/GIF/WebP) yang diizinkan.', 'err'); input.value = ''; return; }
  if (f.size > 300 * 1024) { toast('File terlalu besar! Maksimal ~300KB.', 'err'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    SETTINGS.logoUrl = reader.result;
    updateReceiptPreviewSettings();
    toast('Logo dimuat. Jangan lupa klik Simpan Pengaturan.');
  };
  reader.readAsDataURL(f);
}
function removeLogo() { SETTINGS.logoUrl = ''; $('setLogoFile').value = ''; updateReceiptPreviewSettings(); toast('Logo dihapus (klik Simpan)'); }
async function saveSettings() {
  try {
    SETTINGS = await api('/api/settings', 'PUT', {
      storeName: $('setStoreName').value.trim(),
      storeAddress: $('setStoreAddr').value,
      storePhone: $('setStorePhone').value,
      footerNote: $('setFooterNote').value,
      logoUrl: SETTINGS.logoUrl || ''
    });
    applySettings();
    toast('Pengaturan disimpan ✓');
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- SALES ----------
async function loadSales() {
  SALES = await api('/api/sales').catch(() => []);
  renderSalesTable();
}
function filteredSales() {
  const from = $('salesFrom').value, to = $('salesTo').value;
  const q = ($('salesSearch').value || '').toLowerCase();
  return SALES.filter(s => {
    const d = s.date.slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (q) {
      const hay = ((s.number || '') + ' ' + s.cashier + ' ' + (s.memberName || '') + ' ' +
        s.items.map(i => i.name).join(' ')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
function renderSalesTable() {
  const list = filteredSales();
  $('salesEmpty').classList.toggle('hidden', list.length > 0);
  $('salesBody').innerHTML = list.map(s => `
    <tr>
      <td><code style="color:${s.status === 'void' ? '#ff6b81' : '#7bed9f'}">${esc(s.number || s.id)}</code></td>
      <td>${new Date(s.date).toLocaleString('id-ID')}</td>
      <td>${esc(s.cashier)}</td>
      <td>${esc(s.memberName || '-')}</td>
      <td><b style="color:#ffd166">${rupiah(s.total)}</b></td>
      <td>${s.status === 'void' ? '<span class="void-badge">VOID</span>' : '<span class="ok-badge">OK</span>'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-primary btn-sm" onclick="reprint('${s.id}')">🖨️</button>
        ${ME.role === 'admin' && s.status !== 'void'
          ? `<button class="btn btn-red btn-sm" onclick="voidSaleModal('${s.id}')">🚫 Void</button>` : ''}
      </td>
    </tr>`).join('');
}
function clearSalesFilter() {
  $('salesFrom').value = ''; $('salesTo').value = ''; $('salesSearch').value = '';
  renderSalesTable();
}
function reprint(id) {
  const s = SALES.find(x => x.id === id);
  if (!s) return toast('Transaksi tidak ditemukan', 'err');
  showModal(`
    <h3>🧾 Struk ${esc(s.number || s.id)}</h3>
    ${receiptHTML(s)}
    <div class="modal-actions">
      <button class="btn btn-red" onclick="closeModal()">Tutup</button>
      <button class="btn btn-green" onclick="doPrint($('modalContent').querySelector('.receipt-preview').outerHTML)">🖨️ Cetak Ulang</button>
    </div>`);
}
function voidSaleModal(id) {
  showModal(`
    <h3>🚫 Batalkan Transaksi (Void)</h3>
    <p style="color:#9a94c7;font-size:13px;margin-bottom:12px;">Stok akan dikembalikan & transaksi tidak dihitung di laporan.</p>
    <div class="form-row"><label>Alasan pembatalan</label>
      <textarea class="inp" id="voidReason" rows="3" placeholder="Contoh: salah input kasir..."></textarea></div>
    <div class="modal-actions">
      <button class="btn btn-red" onclick="closeModal()">Batal</button>
      <button class="btn btn-orange" onclick="doVoid('${id}')">🚫 Ya, Batalkan</button>
    </div>`);
}
async function doVoid(id) {
  try {
    await api(`/api/sales/${id}/void`, 'POST', { reason: $('voidReason').value });
    closeModal();
    toast('Transaksi dibatalkan, stok dikembalikan ✓');
    await loadSales();
    await loadProducts();
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- MEMBERS ----------
async function loadMembers() {
  CUSTOMERS = await api('/api/customers').catch(() => []);
  renderMembers();
}
function renderMembers() {
  const q = ($('memberSearch').value || '').toLowerCase();
  const list = CUSTOMERS.filter(c => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q));
  $('membersEmpty').classList.toggle('hidden', list.length > 0);
  $('membersBody').innerHTML = list.map(c => `
    <tr>
      <td style="color:#fff;font-weight:600">${esc(c.name)}</td>
      <td>${esc(c.phone)}</td>
      <td><span class="points-pill">${c.points} poin</span></td>
      <td>${rupiah(c.points * POINT_RP)}</td>
      <td>${new Date(c.createdAt).toLocaleDateString('id-ID')}</td>
      <td>
        <button class="btn btn-primary btn-sm" onclick="openMemberForm('${c.id}')">✏️</button>
        <button class="btn btn-red btn-sm" onclick="deleteMember('${c.id}')">🗑️</button>
      </td>
    </tr>`).join('');
}
function openMemberForm(id) {
  const c = id ? CUSTOMERS.find(x => x.id === id) : {};
  showModal(`
    <h3>${id ? '✏️ Edit Member' : '➕ Member Baru'}</h3>
    <div class="form-row"><label>Nama</label><input class="inp" id="mbName" value="${esc(c.name || '')}"></div>
    <div class="form-row"><label>No. HP</label><input class="inp" id="mbPhone" value="${esc(c.phone || '')}"></div>
    ${id ? `<div class="form-row"><label>Poin (manual adjust)</label><input class="inp" id="mbPoints" type="number" min="0" value="${c.points ?? 0}"></div>` : ''}
    <div class="modal-actions">
      <button class="btn btn-red" onclick="closeModal()">Batal</button>
      <button class="btn btn-green" onclick="saveMember('${id || ''}')">💾 Simpan</button>
    </div>`);
}
async function saveMember(id) {
  try {
    const body = { name: $('mbName').value.trim(), phone: $('mbPhone').value.trim() };
    if (!body.name || !body.phone) return toast('Nama & No. HP wajib diisi', 'err');
    if (id && $('mbPoints')) body.points = Number($('mbPoints').value);
    id ? await api('/api/customers/' + id, 'PUT', body) : await api('/api/customers', 'POST', body);
    closeModal();
    toast('Member tersimpan ✓');
    await loadMembers();
  } catch (e) { toast(e.message, 'err'); }
}
async function deleteMember(id) {
  if (!confirm('Hapus member ini?')) return;
  try { await api('/api/customers/' + id, 'DELETE'); toast('Member dihapus'); await loadMembers(); }
  catch (e) { toast(e.message, 'err'); }
}

// ---------- REPORTS ----------
async function loadReport() {
  try {
    const r = await api('/api/reports');
    $('reportStats').innerHTML = `
      <div class="stat-card stat-1"><p>Omzet Hari Ini</p><h3>${rupiah(r.todayRevenue)}</h3><p>${r.todayCount} transaksi</p></div>
      <div class="stat-card" style="background:linear-gradient(135deg,#11998e,#38ef7d);color:#fff;"><p>💚 Untung Bersih Hari Ini</p><h3>${rupiah(r.todayProfit)}</h3></div>
      <div class="stat-card stat-2"><p>Omzet Bulan Ini</p><h3>${rupiah(r.monthRevenue)}</h3><p>Untung: ${rupiah(r.monthProfit)}</p></div>
      <div class="stat-card" style="background:linear-gradient(135deg,#f7971e,#ffd200);color:#5b3a00;"><p>💰 Total Untung Bersih</p><h3>${rupiah(r.allTimeProfit)}</h3><p>dari omzet ${rupiah(r.allTimeRevenue)}</p></div>
      <div class="stat-card stat-3"><p>Produk · Member · Trx</p><h3 style="font-size:20px">${r.counts.products} · ${r.counts.members} · ${r.counts.sales}</h3></div>`;

    const max = Math.max(...r.last14.map(d => d.revenue), 1);
    $('chartBars').innerHTML = r.last14.map(d => `
      <div class="bar-col" title="${d.date}: ${rupiah(d.revenue)}">
        <div class="bar-val">${d.revenue >= 1000 ? (d.revenue / 1000).toFixed(0) + 'k' : d.revenue}</div>
        <div class="bar ${d.date === new Date().toISOString().slice(0, 10) ? 'today' : ''}" style="height:${Math.max(2, d.revenue / max * 85)}%"></div>
        <span>${d.date.slice(8)}/${d.date.slice(5, 7)}</span>
      </div>`).join('');

    $('topProductsBody').innerHTML = r.topProducts.map((p, i) => `
      <tr>
        <td>${['🥇', '🥈', '🥉'][i] || (i + 1)}</td>
        <td style="color:#fff;font-weight:600">${esc(p.name)}</td>
        <td>${p.qty}</td>
        <td style="color:#ffd166">${rupiah(p.revenue)}</td>
        <td style="color:#7bed9f">+${rupiah(p.profit)}</td>
      </tr>`).join('');

    $('lowStockBody').innerHTML = r.lowStock.map(p => `
      <tr class="lowstock-row"><td style="color:#fff">${esc(p.name)}</td><td>${p.stock}</td><td>${p.minStock}</td></tr>`).join('');
    $('lowStockEmpty').classList.toggle('hidden', r.lowStock.length > 0);
  } catch (e) { toast(e.message, 'err'); }
}
function downloadCSV(filename, rows) {
  const csv = '\ufeff' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = filename; a.click();
}
function exportSalesCSV() {
  downloadCSV(`arkx-penjualan-${new Date().toISOString().slice(0, 10)}.csv`,
    [['No Invoice', 'Tanggal', 'Kasir', 'Member', 'Metode', 'Subtotal', 'Diskon', 'Total', 'Status'],
     ...filteredSales().map(s => [
       s.number || s.id,
       new Date(s.date).toLocaleString('id-ID'),
       s.cashier, s.memberName || '', s.payment,
       s.subtotal ?? s.total,
       s.discount ? s.discount.amount : 0,
       s.total,
       s.status === 'void' ? 'VOID' : 'OK'])]);
  toast('CSV penjualan didownload ✓');
}
function exportProductsCSV() {
  downloadCSV(`arkx-produk-${new Date().toISOString().slice(0, 10)}.csv`,
    [['Barcode', 'Nama', 'Kategori', 'Harga Modal', 'Harga Jual', 'Untung/Unit', 'Stok', 'Min Stok'],
     ...PRODUCTS.map(p => [p.barcode, p.name, p.category, p.cost, p.price, p.price - (p.cost || 0), p.stock, p.minStock])]);
  toast('CSV produk didownload ✓');
}

// ---------- SHIFT ----------
async function loadShiftPage() {
  const cur = await api('/api/shifts/current').catch(() => null);
  const box = $('shiftActiveBox');
  if (cur) {
    const expected = cur.openingCash + cur.liveCash;
    box.innerHTML = `
      <div class="shift-card shift-open">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
          <h3 style="font-size:18px;">🟢 SHIFT AKTIF</h3>
          <button class="btn btn-orange" onclick="closeShiftModal()">🔒 Tutup Shift</button>
        </div>
        <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:12px;">
          <div><small style="opacity:.8">Dibuka oleh</small><br><b>${esc(cur.openedBy)}</b></div>
          <div><small style="opacity:.8">Waktu buka</small><br><b>${new Date(cur.openedAt).toLocaleString('id-ID')}</b></div>
          <div><small style="opacity:.8">Modal awal</small><br><b>${rupiah(cur.openingCash)}</b></div>
          <div><small style="opacity:.8">Penjualan tunai</small><br><b>${rupiah(cur.liveCash)}</b></div>
          <div><small style="opacity:.8">Total semua metode</small><br><b>${rupiah(cur.liveTotal)}</b></div>
          <div><small style="opacity:.8">Transaksi</small><br><b>${cur.trxCount}</b></div>
          <div><small style="opacity:.8">Estimasi kas di drawer</small><br><b>${rupiah(expected)}</b></div>
        </div>
      </div>`;
  } else {
    box.innerHTML = `
      <div class="shift-card" style="background:#1e1b3a;border:1px solid rgba(255,255,255,.08);">
        <h3 style="color:#fff;">⚪ Tidak ada shift aktif</h3>
        <p style="color:#9a94c7;font-size:13px;margin:8px 0 14px;">Buka shift dulu agar penjualan tercatat per shift & mudah setor kas.</p>
        <button class="btn btn-green" onclick="openShiftModal()">▶️ Buka Shift Baru</button>
      </div>`;
  }
  const shifts = await api('/api/shifts').catch(() => []);
  const closed = shifts.filter(s => s.status === 'closed');
  $('shiftHistoryEmpty').classList.toggle('hidden', closed.length > 0);
  $('shiftHistoryBody').innerHTML = closed.map(s => {
    const cls = s.difference > 0 ? 'diff-pos' : s.difference < 0 ? 'diff-neg' : 'diff-zero';
    return `
      <tr>
        <td>${new Date(s.openedAt).toLocaleString('id-ID')}</td>
        <td>${esc(s.openedBy)}</td>
        <td>${rupiah(s.openingCash)}</td>
        <td>${rupiah(s.totalSales || 0)}</td>
        <td>${rupiah(s.closingCash)}</td>
        <td class="${cls}">${s.difference >= 0 ? '+' : ''}${rupiah(s.difference)}</td>
        <td>${new Date(s.closedAt).toLocaleString('id-ID')}</td>
      </tr>`;
  }).join('');
}
function openShiftModal() {
  showModal(`
    <h3>▶️ Buka Shift</h3>
    <div class="form-row"><label>Modal kas awal (uang di drawer)</label>
      <input class="inp" id="shOpenCash" type="number" min="0" placeholder="0"></div>
    <div class="modal-actions">
      <button class="btn btn-red" onclick="closeModal()">Batal</button>
      <button class="btn btn-green" onclick="doOpenShift()">Buka Shift</button>
    </div>`);
}
async function doOpenShift() {
  try {
    await api('/api/shifts/open', 'POST', { openingCash: Number($('shOpenCash').value || 0) });
    closeModal();
    toast('Shift dibuka ✓ Selamat bekerja!');
    loadShiftPage();
  } catch (e) { toast(e.message, 'err'); }
}
function closeShiftModal() {
  api('/api/shifts/current').then(cur => {
    const expected = cur.openingCash + cur.liveCash;
    showModal(`
      <h3>🔒 Tutup Shift</h3>
      <div class="cart-total-row"><span>Estimasi kas (modal + tunai)</span><b>${rupiah(expected)}</b></div>
      <div class="form-row"><label>Uang fisik di drawer</label>
        <input class="inp" id="shCloseCash" type="number" min="0" placeholder="0"></div>
      <div class="modal-actions">
        <button class="btn btn-red" onclick="closeModal()">Batal</button>
        <button class="btn btn-orange" onclick="doCloseShift()">Tutup Shift</button>
      </div>`);
  });
}
async function doCloseShift() {
  try {
    const r = await api('/api/shifts/close', 'POST', { closingCash: Number($('shCloseCash').value || 0) });
    closeModal();
    const cls = r.difference > 0 ? 'diff-pos' : r.difference < 0 ? 'diff-neg' : 'diff-zero';
    showModal(`
      <h3>✅ Shift Ditutup</h3>
      <div class="receipt-preview center">
        <table>
          <tr><td>Total penjualan</td><td style="text-align:right">${rupiah(r.totalSales || 0)}</td></tr>
          <tr><td>Estimasi kas</td><td style="text-align:right">${rupiah(r.expectedCash)}</td></tr>
          <tr><td>Setoran fisik</td><td style="text-align:right">${rupiah(r.closingCash)}</td></tr>
          <tr><td><b>Selisih</b></td><td style="text-align:right" class="${cls}">${r.difference >= 0 ? '+' : ''}${rupiah(r.difference)}</td></tr>
        </table>
      </div>
      <div class="modal-actions"><button class="btn btn-green" onclick="closeModal();loadShiftPage()">Selesai</button></div>`);
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- BACKUP / RESTORE ----------
async function downloadBackup() {
  try {
    const r = await fetch(API + '/api/backup', { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!r.ok) throw new Error('Gagal backup');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `arkx-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    toast('Backup didownload ✓');
  } catch (e) { toast(e.message, 'err'); }
}
function restoreBackup() {
  const f = $('restoreFile').files[0];
  if (!f) return toast('Pilih file backup dulu!', 'err');
  const reader = new FileReader();
  reader.onload = async () => {
    if (!confirm('⚠️ SEMUA data saat ini akan DIGANTI dengan file backup. Lanjutkan?')) return;
    try {
      const data = JSON.parse(reader.result);
      await api('/api/restore', 'POST', { data });
      toast('Restore berhasil! Memuat ulang...');
      setTimeout(() => location.reload(), 1200);
    } catch (e) { toast('Restore gagal: ' + e.message, 'err'); }
  };
  reader.readAsText(f);
}

// ---------- USERS (admin) ----------
async function loadUsers() {
  if (ME.role !== 'admin') return;
  try {
    const users = await api('/api/users');
    const pending = users.filter(u => u.status === 'pending').length;
    $('userStats').innerHTML = `
      <div class="stat-card stat-1"><p>Total User</p><h3>${users.length}</h3></div>
      <div class="stat-card stat-2"><p>⏳ Menunggu Approval</p><h3>${pending}</h3></div>
      <div class="stat-card stat-3"><p>✅ Disetujui</p><h3>${users.filter(u => u.status === 'approved').length}</h3></div>
      <div class="stat-card stat-4"><p>👑 Admin</p><h3>${users.filter(u => u.role === 'admin').length}</h3></div>`;
    $('usersBody').innerHTML = users.map(u => `
      <tr>
        <td style="color:#fff;font-weight:600">${esc(u.name)}</td>
        <td>${esc(u.email)}</td>
        <td><span class="badge-role ${u.role}">${u.role}</span></td>
        <td><span class="badge-role ${u.status}">${u.status}</span></td>
        <td>
          ${u.status !== 'approved' ? `<button class="btn btn-green btn-sm" onclick="setUserStatus('${u.id}','approved')">✓ Approve</button>` : ''}
          ${u.status === 'pending' ? `<button class="btn btn-orange btn-sm" onclick="setUserStatus('${u.id}','rejected')">✕ Reject</button>` : ''}
          ${u.email.toLowerCase() !== 'nuallakoko@gmail.com' ? `<button class="btn btn-red btn-sm" onclick="deleteUser('${u.id}')">🗑️</button>` : ''}
        </td>
      </tr>`).join('');
  } catch {}
}
async function setUserStatus(id, status) {
  try {
    await api(`/api/users/${id}/status`, 'PUT', { status });
    toast(status === 'approved' ? 'User di-approve ✓' : 'User di-reject');
    loadUsers();
  } catch (e) { toast(e.message, 'err'); }
}
async function deleteUser(id) {
  if (!confirm('Hapus user ini?')) return;
  try { await api('/api/users/' + id, 'DELETE'); toast('User dihapus'); loadUsers(); }
  catch (e) { toast(e.message, 'err'); }
}

// ---------- BARCODE SCANNER ----------
async function openScanner(mode) {
  scannerMode = mode;
  const readerEl = mode === 'stok' ? 'reader-stok' : 'reader-pay';
  const resultEl = mode === 'stok' ? 'scanStokResult' : 'scanPayResult';
  $(resultEl).textContent = 'Arahkan kamera ke barcode…';
  if (mode === 'stok') $('scanStokPanel').classList.remove('hidden');
  if (typeof Html5Qrcode === 'undefined') {
    $(resultEl).innerHTML = '<span style="color:#ff6b81">⚠️ Library scanner belum termuat. Perlu internet untuk pertama kali, atau gunakan input manual.</span>';
    return;
  }
  try {
    scanner = new Html5Qrcode(readerEl);
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 150 } },
      async decoded => {
        if (scannerMode === 'pay') {
          if (addToCart(decoded)) { toast('Ditambahkan: ' + decoded + ' ✓'); pauseScan(); }
        } else if (scannerMode === 'stok') {
          $(resultEl).textContent = 'Barcode terdeteksi: ' + decoded;
          const p = PRODUCTS.find(x => x.barcode === decoded);
          if (p) { closeScanner('stok'); openRestock(p.id); }
          else {
            $(resultEl).innerHTML = `Barcode <b>${decoded}</b> belum terdaftar. Membuka form produk baru...`;
            setTimeout(() => {
              closeScanner('stok');
              openProductForm(null);
              $('pfBarcode').value = decoded;
            }, 700);
          }
        }
      },
      () => {}
    );
  } catch (e) {
    $(resultEl).innerHTML = `<span style="color:#ff6b81">⚠️ Kamera tidak bisa diakses: ${esc(e.message || e)}<br>Berikan izin kamera atau gunakan input manual / USB scanner.</span>`;
  }
}
function pauseScan() {
  if (!scanner) return;
  scanner.pause(true);
  setTimeout(() => { if (scanner) scanner.resume(); }, 1200);
}
function closeScanner(mode) {
  if (scanner) { scanner.stop().catch(() => {}); scanner.clear(); scanner = null; }
  scannerMode = null;
  if (mode === 'stok') $('scanStokPanel').classList.add('hidden');
  else closeModal();
}
function closeAllScanners() {
  if (scanner) { scanner.stop().catch(() => {}); scanner.clear(); scanner = null; scannerMode = null; }
  $('scanStokPanel')?.classList.add('hidden');
}
function openScanPayModal() {
  showModal(`
    <h3>📷 Scan Barcode Item</h3>
    <div id="reader-pay"></div>
    <div class="scan-status" id="scanPayResult">Arahkan kamera ke barcode produk untuk menambah ke keranjang…</div>
    <div class="modal-actions">
      <button class="btn btn-red" onclick="closeScanner('pay')">✕ Tutup Scanner</button>
    </div>`);
  setTimeout(() => openScanner('pay'), 200);
}

// keyboard: USB barcode scanner ends with Enter while input focused
document.addEventListener('keydown', e => {
  if (document.activeElement === $('barcodeInput') && e.key === 'Enter') addByBarcode($('barcodeInput').value);
});

// ---------- BOOT ----------
(async function boot() {
  if (!TOKEN) return;
  try {
    ME = await api('/api/me');
    if (ME.status !== 'approved') { localStorage.removeItem('arkx_token'); TOKEN = null; return; }
    enterApp();
  } catch { localStorage.removeItem('arkx_token'); }
})();
