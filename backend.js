/* SwiftRun - backend connector (drop-in). Load LAST, after categories.js and performance.js.
   Replaces the in-memory demo data with the real API: accounts, orders, M-Pesa, admin.
   Same server:   nothing to configure.
   GitHub Pages:  add  <script>window.SWIFTRUN_API='https://your-api.example.com'</script>  before this file. */
(function () {
  'use strict';
  var API = (window.SWIFTRUN_API || '').replace(/\/$/, '');
  function $(id) { return document.getElementById(id); }

  /* ── storage (guarded: some browsers block it) ─────────────── */
  function sget(store, k) { try { return window[store].getItem(k); } catch (e) { return null; } }
  function sset(store, k, v) { try { if (v == null) window[store].removeItem(k); else window[store].setItem(k, v); } catch (e) {} }
  var token = sget('localStorage', 'sr_token');

  /* ── HTML safety: the existing UI builds pages with innerHTML, so escape
        everything that comes from the server (customer-typed text included) ── */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function clean(v) {
    if (typeof v === 'string') return v.replace(/[&<>"']/g, function (c) { return ESC[c]; });
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') { var o = {}; for (var k in v) o[k] = clean(v[k]); return o; }
    return v;
  }

  /* ── API helper ────────────────────────────────────────────── */
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(API + path, {
      method: opts.method || 'GET', headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok) return j;
        if (r.status === 401 && token && path.indexOf('/api/auth/') !== 0) { dropSession(); j.error = 'Your session expired. Please log in again.'; }
        throw new Error(j.error || 'Request failed (' + r.status + ')');
      });
    }, function () { throw new Error("Can't reach the server. Check your connection and try again."); });
  }
  function fail(e) { showToast(e.message || 'Something went wrong', 'error'); }
  function lock(id, on) { var b = $(id); if (b) { b.disabled = !!on; b.style.opacity = on ? '.6' : ''; } }

  /* ── session ───────────────────────────────────────────────── */
  function setSession(res) {
    token = res.token; sset('localStorage', 'sr_token', token);
    DB.currentUser = res.user; updateUserUI();
  }
  function dropSession() {
    token = null; sset('localStorage', 'sr_token', null); sset('sessionStorage', 'sr_lookup', null);
    DB.currentUser = null; DB.orders = []; updateUserUI();
  }
  function isAdmin() { return !!(DB.currentUser && DB.currentUser.role === 'admin'); }

  /* ── data sync ─────────────────────────────────────────────── */
  function setOrders(list) { DB.orders = clean(list || []); }
  function upsert(o) {
    o = clean(o);
    var i = DB.orders.findIndex(function (x) { return x.id === o.id; });
    if (i >= 0) DB.orders[i] = o; else DB.orders.unshift(o);
  }
  function refreshOrders() {
    var p;
    if (token) p = api('/api/orders').then(function (r) { return r.orders; });
    else if (sget('sessionStorage', 'sr_lookup')) p = api('/api/orders/track?q=' + encodeURIComponent(sget('sessionStorage', 'sr_lookup'))).then(function (r) { return r.orders; });
    else p = Promise.resolve([]);
    return p.then(function (list) { setOrders(list); renderTrack(); updateAdminBadge(); }, function () { renderTrack(); });
  }
  function refreshAdmin() {
    return Promise.all([api('/api/admin/orders'), api('/api/admin/riders'), api('/api/admin/payments')]).then(function (r) {
      DB.orders = clean(r[0].orders); DB.riders = clean(r[1].riders); DB.payments = clean(r[2].payments);
      initAdmin();
    }, fail);
  }

  // Start clean: drop the demo data baked into index.html
  DB.orders = []; DB.riders = []; DB.payments = [];

  /* ── auth ──────────────────────────────────────────────────── */
  window.handleLogin = function () {
    var email = $('lEmail').value.trim(), pass = $('lPass').value;
    if (!email || !pass) { showToast('Please fill in all fields', 'error'); return; }
    lock('loginSubmitBtn', true);
    api('/api/auth/login', { method: 'POST', body: { email: email, password: pass } }).then(function (r) {
      setSession(r); $('lPass').value = '';
      showToast('Welcome back! 👋', 'success');
      setPage(isAdmin() ? 'admin' : 'home');
    }, fail).then(function () { lock('loginSubmitBtn', false); });
  };
  window.handleRegister = function () {
    var first = $('rFirst').value.trim(), last = $('rLast').value.trim(),
        email = $('rRegEmail').value.trim(), pass = $('rRegPass').value;
    if (!first || !last || !email || !pass) { showToast('Please fill in all fields', 'error'); return; }
    if (pass.length < 8) { showToast('Password must be at least 8 characters', 'error'); return; }
    lock('registerSubmitBtn', true);
    api('/api/auth/register', { method: 'POST', body: { first: first, last: last, email: email, password: pass } }).then(function (r) {
      setSession(r); $('rRegPass').value = '';
      showToast('Welcome, ' + first + '! Account created 🎉', 'success');
      setPage('home');
    }, fail).then(function () { lock('registerSubmitBtn', false); });
  };
  window.logout = function () { dropSession(); renderTrack(); showToast('Logged out', 'default'); };

  /* ── page changes: load fresh data, guard the admin page ───── */
  var prevSetPage = window.setPage;
  window.setPage = function (page) {
    if (page === 'admin' && !isAdmin()) {
      showToast(token ? 'Admin access only' : 'Please log in with an admin account', 'error');
      return prevSetPage.call(this, token ? 'home' : 'login');
    }
    var r = prevSetPage.apply(this, arguments);
    if (page === 'track') refreshOrders();
    if (page === 'admin') refreshAdmin();
    return r;
  };

  /* ── pricing: the server decides the price ─────────────────── */
  function chosenService() { var c = document.querySelector('.svc-card.selected'); return c ? c.dataset.svc : null; }
  var prevCalc = window.calculateCost;
  window.calculateCost = function () {
    var ready = ['rName', 'rPhone', 'rDesc', 'rPickup', 'rDropoff'].every(function (id) { return $(id).value.trim(); });
    var rnd = Math.random; Math.random = function () { return 0; };   // hide the demo's random fee
    try { prevCalc.apply(this, arguments); } finally { Math.random = rnd; }
    if (!ready || $('costPanel').style.display !== 'block') return;
    lock('calcBtn', true);
    api('/api/quote', { method: 'POST', body: { service: chosenService() || undefined, type: $('rType').value, goodsValue: parseFloat($('rValue').value) || 0 } })
      .then(function (q) {
        $('cDistance').textContent = 'KES ' + q.distFee.toLocaleString();
        $('cGoods').textContent = 'KES ' + q.goodsFee.toLocaleString();
        $('cTotal').textContent = 'KES ' + q.total.toLocaleString();
      }, function (e) { $('costPanel').style.display = 'none'; fail(e); })
      .then(function () { lock('calcBtn', false); });
  };

  /* ── place an order ────────────────────────────────────────── */
  window.submitOrder = function () {
    var method = DB.selectedPay;
    if ($('costPanel').style.display !== 'block') { showToast('Please calculate the cost first', 'error'); return; }
    if (method === 'card') { showToast('Card payments are not available yet. Please choose M-Pesa or cash.', 'error'); return; }
    var mp = $('mpesaPhone').value.trim();
    if (method === 'mpesa' && !mp) { showToast('Enter your M-Pesa phone number', 'error'); return; }
    lock('confirmPayBtn', true);
    api('/api/orders', { method: 'POST', body: {
      name: $('rName').value.trim(), phone: $('rPhone').value.trim(), email: $('rEmail').value.trim(),
      desc: $('rDesc').value.trim(), pickup: $('rPickup').value.trim(), dropoff: $('rDropoff').value.trim(),
      goodsValue: parseFloat($('rValue').value) || 0, notes: $('rNotes').value.trim(),
      type: $('rType').value, service: chosenService() || undefined, payMethod: method
    } }).then(function (r) {
      var o = r.order;
      upsert(o); updateAdminBadge();
      if (!token) sset('sessionStorage', 'sr_lookup', o.customer.phone);
      if (method === 'mpesa') showPayModal(o.id, mp, o.total);
      else {
        showToast('Order ' + o.id + ' confirmed! Rider will collect cash 🚴', 'success');
        resetForm(); setPage('track');
      }
    }, fail).then(function () { lock('confirmPayBtn', false); });
  };

  /* ── real M-Pesa payment ───────────────────────────────────── */
  var payRun = 0;
  var prevClosePay = window.closePayModal;
  window.closePayModal = function () { payRun++; return prevClosePay.apply(this, arguments); };

  window.showPayModal = function (orderId, phone, amount) {
    var run = ++payRun, box = $('payModalContent');
    function steps(n) {
      var names = ['STK Push sent to ' + phone, 'Waiting for customer PIN...', 'Processing payment...', 'Order confirmed'];
      return '<div class="pay-steps">' + names.map(function (s, i) {
        return '<div class="pay-step' + (i < n ? ' done' : '') + '"><div class="ps-dot"></div>' + s + '</div>';
      }).join('') + '</div>';
    }
    function waiting(n) {
      box.innerHTML = '<div class="pay-spinner"></div><div class="pay-modal-title">Waiting for M-Pesa PIN</div>' +
        '<div class="pay-modal-sub">A payment prompt has been sent to:</div><div class="pay-phone-big">' + clean(phone) + '</div>' + steps(n) +
        '<p style="font-size:.8rem;color:var(--muted)">Enter your M-Pesa PIN on your phone to pay <strong style="color:var(--text)">KES ' + amount.toLocaleString() + '</strong></p>';
    }
    function problem(title, msg, retry) {
      box.innerHTML = '<div class="pay-success-icon">⚠️</div><div class="pay-modal-title" style="color:var(--orange)">' + title + '</div>' +
        '<div class="pay-modal-sub">' + clean(msg) + '</div>' +
        (retry ? '<button class="btn-confirm-pay" id="payRetryBtn" style="margin-top:8px">Try again</button>' : '') +
        '<button class="btn-outline" id="payLaterBtn" style="margin-top:8px;width:100%">' + (retry ? 'Pay later' : 'View my orders') + '</button>';
      var rb = $('payRetryBtn'); if (rb) rb.addEventListener('click', function () { showPayModal(orderId, phone, amount); });
      $('payLaterBtn').addEventListener('click', function () { closePayModal(); resetForm(); setPage('track'); });
    }
    function success(ref) {
      box.innerHTML = '<div class="pay-success-icon">✅</div><div class="pay-modal-title" style="color:var(--green)">Payment Successful!</div>' +
        '<div class="pay-modal-sub">KES ' + amount.toLocaleString() + ' paid via M-Pesa.<br/>A rider has been assigned to your errand.</div>' +
        '<div class="pay-ref">Ref: ' + clean(ref || '—') + '</div>' +
        '<button class="btn-confirm-pay" id="paySuccessBtn" style="margin-top:8px">View My Orders →</button>';
      $('paySuccessBtn').addEventListener('click', function () { closePayModal(); resetForm(); setPage('track'); });
    }

    waiting(1);
    $('payModal').style.display = 'flex';
    api('/api/orders/' + encodeURIComponent(orderId) + '/pay/mpesa', { method: 'POST', body: { phone: phone } }).then(function () {
      if (run !== payRun) return;
      waiting(2);
      var started = Date.now();
      (function poll() {
        setTimeout(function () {
          if (run !== payRun) return;
          api('/api/orders/' + encodeURIComponent(orderId) + '/payment').then(function (s) {
            if (run !== payRun) return;
            if (s.state === 'completed') {
              waiting(3);
              api('/api/orders/track?q=' + encodeURIComponent(orderId)).then(function (r) { if (r.orders[0]) upsert(r.orders[0]); updateAdminBadge(); }).catch(function () {});
              setTimeout(function () { if (run === payRun) success(s.mpesaRef); }, 700);
            } else if (s.state === 'failed' || s.state === 'cancelled') {
              problem('Payment not completed', s.message || 'The M-Pesa request was cancelled or declined.', true);
            } else if (Date.now() - started > 120000) {
              problem('Still waiting', 'We have not received a confirmation yet. If you already paid, your order will update shortly. Check My Orders.', false);
            } else poll();
          }, function () { if (run === payRun) poll(); });
        }, 2500);
      })();
    }, function (e) { if (run === payRun) problem("Couldn't send the M-Pesa prompt", e.message, true); });
  };

  /* ── track page search ─────────────────────────────────────── */
  window.searchOrders = function () {
    var q = ($('trackQ').value || '').trim();
    if (!q) { refreshOrders(); return; }
    lock('searchBtn', true);
    api('/api/orders/track?q=' + encodeURIComponent(q)).then(function (r) {
      setOrders(r.orders);
      if (!token && r.orders.length) sset('sessionStorage', 'sr_lookup', q);
      if (!r.orders.length) {
        $('trackResults').innerHTML = '<div class="empty-state"><h3>No orders found</h3><p>Try a different phone number, email or order ID.</p></div>';
      } else renderTrack();
    }, fail).then(function () { lock('searchBtn', false); });
  };

  /* ── actions on the order modal and the admin table ────────── */
  var modalId = null, prevOpen = window.openOrderModal;
  window.openOrderModal = function (id) { modalId = id; return prevOpen.apply(this, arguments); };

  var ADMIN_MSG = {
    confirm: ['accepted ✓', 'success'], dispatch: ['dispatched 🚴', 'success'],
    complete: ['completed ✅', 'success'], cancel: ['cancelled', 'default']
  };
  document.addEventListener('click', function (e) {
    var cancel = e.target.closest && e.target.closest('#mdlCancelBtn');
    if (cancel) {
      e.stopPropagation(); e.preventDefault();
      var id = modalId, o = DB.orders.find(function (x) { return x.id === id; });
      if (!o) return;
      lock('mdlCancelBtn', true);
      api('/api/orders/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: { phone: o.customer.phone } }).then(function (r) {
        upsert(r.order); closeOrderModal(); renderTrack(); updateAdminBadge(); showToast('Order ' + id + ' cancelled');
      }, function (err) { lock('mdlCancelBtn', false); fail(err); });
      return;
    }
    var btn = e.target.closest && e.target.closest('.adm-action');
    if (btn) {
      e.stopPropagation(); e.preventDefault();
      var oid = btn.dataset.id, act = btn.dataset.action;
      btn.disabled = true;
      api('/api/admin/orders/' + encodeURIComponent(oid), { method: 'PATCH', body: { action: act } }).then(function (r) {
        upsert(r.order);
        showToast('Order ' + oid + ' ' + ADMIN_MSG[act][0], ADMIN_MSG[act][1]);
        updateAdminBadge(); renderAdmOverview(); renderAdmOrders();
        api('/api/admin/riders').then(function (x) { DB.riders = clean(x.riders); renderAdmRiders(); }).catch(function () {});
        api('/api/admin/payments').then(function (x) { DB.payments = clean(x.payments); renderAdmPayments(); }).catch(function () {});
      }, function (err) { btn.disabled = false; fail(err); });
    }
  }, true);

  /* ── on load: restore the session ──────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    if (token) {
      api('/api/auth/me').then(function (r) { DB.currentUser = r.user; updateUserUI(); return refreshOrders(); }, function () { dropSession(); renderTrack(); });
    } else refreshOrders();
  });
})();
