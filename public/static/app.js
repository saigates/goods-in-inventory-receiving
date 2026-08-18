/* Goods In — Inventory Receiving SPA */
(() => {
  const API = '/api';
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const h = (tag, attrs={}, ...children) => {
    const el = document.createElement(tag);
    for (const [k,v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      // <textarea> has no `value` CONTENT ATTRIBUTE — its displayed text only
      // comes from the `.value` PROPERTY (or child text nodes at parse time).
      // setAttribute('value', ...) is a silent no-op for textareas, so text
      // typed/pasted in would vanish on the very next re-render (every
      // keystroke re-creates the element via oninput -> render()). Set the
      // property directly for textarea; keep setAttribute for every other
      // tag (inputs mirror the attribute to the property fine).
      else if (k === 'value' && tag === 'textarea') el.value = v ?? '';
      else if (v !== undefined && v !== null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
    return el;
  };
  const fmtDate = (s) => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString() : '—';
  // Clipboard write with a fallback path for contexts where the async
  // Clipboard API is unavailable or rejects (non-secure context, denied
  // Permissions-Policy in an embedded/iframed preview, focus-loss at
  // click time, or an older browser). navigator.clipboard.writeText can
  // fail for reasons that have nothing to do with the code that calls it
  // (e.g. document not focused, permission not granted) — the fallback
  // uses the legacy execCommand('copy') path via a temporary offscreen
  // textarea, which works in more of those cases. Returns true if either
  // path succeeded, false if both failed (caller shows the manual-copy
  // toast only in that case).
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through to legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.left = '-1000px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  // ───────── Bulk-paste IMEI parsing (shared by BulkTransitionModal and
  // BulkScanModal) ─────────
  // Bug fix (2026-08-15): both bulk modals used to dedupe pasted/scanned
  // IMEIs via a Set BEFORE checking the batch-size cap. If an operator
  // pasted e.g. 205 lines where 5 were duplicates, the unique count came
  // out to 200 — under the cap — so the cap warning never fired AND the
  // UI only ever displayed the post-dedup "200 unique" count, with zero
  // indication that 5 lines had been silently merged away. This is the
  // exact defect reported in production: "205 scanned, 200 shown, five
  // silently dropped." The backend never deduplicates (confirmed:
  // zero-match grep for `new Set` in src/routes/*.ts) — the count
  // mismatch was purely a client-side rendering gap.
  //
  // Fix: return both the raw (non-empty, trimmed) token count and the
  // deduped list, so callers can surface a duplicate-removal notice
  // whenever the two counts differ — never silently.
  const BULK_IMEI_CAP = 500;
  function parseBulkImeis(raw) {
    const tokens = raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    const unique = Array.from(new Set(tokens));
    return { raw: tokens.length, unique, duplicates: tokens.length - unique.length };
  }

  // ───────── Grade helpers (strict A | B | C | UG) ─────────
  // UG is stored as 'UG' but displayed as 'Ungraded' in human-facing copy.
  const GRADES = ['A', 'B', 'C', 'UG'];
  const gradeLabel = (g) => !g ? 'Ungraded' : g === 'UG' ? 'Ungraded' : g;
  const gradeBadgeClass = (g) =>
    g === 'UG' || !g
      ? 'badge badge-violet text-[10px]'
      : 'badge badge-cyan text-[10px]';
  // Dropdown rendered as a <select> with the strict 4 options.
  function gradeSelect(currentValue, onChange, extraAttrs = {}) {
    const sel = h('select', Object.assign({
      class: 'input mono',
      onchange: (e) => onChange(e.target.value),
    }, extraAttrs));
    GRADES.forEach(g => {
      const opt = h('option', { value: g }, gradeLabel(g));
      if (g === currentValue) opt.setAttribute('selected', 'selected');
      sel.appendChild(opt);
    });
    return sel;
  }

  // ───────── State ─────────
  const state = {
    authUser: null,       // { id, email, name, role, organisation_id } once logged in
    authBusy: false,
    authError: null,
    view: 'receive',     // dashboard | manifests | receive | inventory | catalog | print
    manifests: [],
    activeManifestId: null,
    activeManifest: null,
    expected: [],
    unreconciled: [],
    summary: { expected_count: 0, received_count: 0 },
    // Manifest → bill reconciliation (0029) for the active manifest —
    // { verdict: 'awaiting_manifest'|'balanced'|'variance', ... } from
    // GET /api/manifests/:id's bill_reconciliation field.
    billReconciliation: null,
    events: [],
    inventory: [],
    inventorySelected: new Set(),   // Set<deviceId> for bulk operations on Inventory view
    bulkGradeOpen: false,            // bulk grade modal visibility
    catalog: [],                     // sku_catalog rows
    catalogUpload: null,             // { fileName, rows, report, summary } during preview
    manualReceiveOpen: false,        // manual-receive (no manifest) modal
    bulkScanOpen: false,              // bulk-scan (many IMEIs at once) modal
    printQueue: [],
    stats: {},
    pendingMatch: null,   // { expected, catalog_match: { status, row? , candidates?, reason? } }
    pendingUnrec: null,   // { imei }
    soundOn: true,
    autoPrint: true,
    // 'large' (DYMO 57x32mm landscape, default) | 'small' (DYMO 32x57mm portrait)
    // v2 key — bumps any user still cached on 'small' back to landscape default
    labelSize: (['large','small'].includes(localStorage.getItem('labelSize.v2')) ? localStorage.getItem('labelSize.v2') : 'large'),
    // Some DYMO LabelWriter setups feed labels with the short edge first, so a
    // 57×32 landscape page comes out rotated 90° and runs over onto the next
    // sticker. Turning this on swaps the @page dimensions and CSS-rotates the
    // label content 90° so the printer sees a 32×57 page but the content still
    // renders landscape. Persisted in localStorage.
    labelRotate: localStorage.getItem('labelRotate.v1') === '1',
    printSettings: null,         // { print_mode, printnode_api_key_set, printnode_printer_id_large, printnode_printer_id_small }
    printnodePrinters: null,     // [] from /printnode/printers
    settingsSaving: false,
    // ───── OPR (Outward Processing Relief) UI state ─────
    oprTab: 'shipments',         // 'shipments' | 'discharge'
    oprShipments: [],            // list rows (with line_count/total_value)
    oprAuths: [],                // opr_authorisations for the org
    oprShipmentId: null,         // open detail view when set
    oprBundle: null,             // { shipment, lines, authorisation, total_value }
    oprValidation: null,         // { result, checks[] } for the open shipment
    oprEmails: [],               // sent_emails outbox for the open shipment
    oprDischarge: null,          // { discharge[], summary } for the tracker tab
    oprNewOpen: false,           // new-consignment modal
    oprFinaliseOpen: false,      // finalise modal (export MRN capture)
    oprDraftDoc: null,           // { kind: 'prealert'|'clearance', data } text-draft panel
    oprBusy: false,              // in-flight guard for OPR mutations
    // ───── Devices tab (status-movement / repair queue / QC / removal flags) ─────
    devicesSubview: 'all',       // 'all' | 'repair' | 'qc-failed' | 'ready-zoho' | 'removal-flags'
    deviceStatuses: null,        // { statuses, transitions } from GET /api/devices/meta/statuses
    devicesAll: [],              // GET /api/devices?status=... rows for the current filter (All Devices sub-view)
    devicesAllFilter: '',        // status filter for All Devices ('' = no filter, show a curated default set)
    devicesAllSearch: '',        // q= search box for All Devices
    repairQueue: [],             // GET /api/devices/repair-queue rows
    qcFailedDevices: [],         // GET /api/devices?status=QC_FAILED
    readyForZohoDevices: [],     // GET /api/devices?status=READY_FOR_ZOHO
    removalFlags: [],            // GET /api/inventory/removal-flags
    removalFlagsShowResolved: false,
    devicesBusy: false,          // in-flight guard for device-lifecycle mutations
    bulkTransitionOpen: false,   // bulk-transition-by-scan modal visibility
    // ───── Bills tab (Sprint B §1 — ONE builder for purchase|repair) ─────
    bills: [],                   // GET /api/bills list rows
    billsFilterType: '',         // '' | 'purchase' | 'repair'
    billsFilterStatus: '',       // '' | 'draft' | 'closed'
    billId: null,                // open detail view when set
    billDetail: null,            // { bill, lines, close_overrides, serials } for the open bill
    billNewOpen: false,          // new-bill modal visibility
    billForceCloseOpen: false,   // force-close reason modal visibility (holds the bill id)
    billBusy: false,             // in-flight guard for bill mutations
  };
  function setLabelSize(v) { state.labelSize = v; localStorage.setItem('labelSize.v2', v); }
  function setLabelRotate(on) { state.labelRotate = !!on; localStorage.setItem('labelRotate.v1', on ? '1' : '0'); }

  // ───────── Toast ─────────
  const toastWrap = h('div', { class: 'toast-wrap' });
  document.body.appendChild(toastWrap);
  function toast(msg, kind='ok', ms=2500) {
    const icon = { ok: 'check-circle', warn: 'exclamation-triangle', err: 'times-circle' }[kind] || 'info';
    const el = h('div', { class: `toast ${kind}` },
      h('div', { class: 'flex items-start gap-2' },
        h('i', { class: `fas fa-${icon} mt-0.5 ${kind==='ok'?'text-green-400':kind==='warn'?'text-amber-400':'text-red-400'}` }),
        h('div', { class: 'text-sm text-slate-100', html: msg })
      )
    );
    toastWrap.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, ms);
  }

  // ───────── Sounds (WebAudio bleeps) ─────────
  let audioCtx;
  function beep(kind='ok') {
    if (!state.soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      const freq = kind === 'ok' ? 880 : kind === 'warn' ? 440 : 220;
      o.frequency.value = freq;
      o.type = 'sine';
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
      o.start(); o.stop(audioCtx.currentTime + 0.2);
      if (kind !== 'ok') {
        // double-beep for warning
        const o2 = audioCtx.createOscillator();
        const g2 = audioCtx.createGain();
        o2.connect(g2); g2.connect(audioCtx.destination);
        o2.frequency.value = freq;
        o2.type = 'sine';
        g2.gain.setValueAtTime(0.0001, audioCtx.currentTime + 0.22);
        g2.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.23);
        g2.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.4);
        o2.start(audioCtx.currentTime + 0.22); o2.stop(audioCtx.currentTime + 0.42);
      }
    } catch(e) {}
  }

  // ───────── Auth token store ─────────
  // JWT minted by POST /api/auth/dev-login. Persisted in localStorage so a
  // page refresh doesn't force a re-login. Every /api/* call below attaches
  // it as `Authorization: Bearer <token>`; a 401 response clears it and
  // drops the app back to the login screen.
  const AUTH_TOKEN_KEY = 'goodsin.auth_token.v1';
  let authToken = localStorage.getItem(AUTH_TOKEN_KEY) || null;
  function setAuthToken(token) {
    authToken = token || null;
    if (authToken) localStorage.setItem(AUTH_TOKEN_KEY, authToken);
    else localStorage.removeItem(AUTH_TOKEN_KEY);
  }

  const http = axios.create({ baseURL: API });
  http.interceptors.request.use((cfg) => {
    if (authToken) cfg.headers.Authorization = `Bearer ${authToken}`;
    return cfg;
  });
  http.interceptors.response.use(
    (r) => r,
    (err) => {
      if (err.response?.status === 401) {
        // Token missing/invalid/expired — force back to the login screen.
        setAuthToken(null);
        state.authUser = null;
        render();
      }
      return Promise.reject(err);
    }
  );

  // ───────── API helpers ─────────
  const api = {
    get: (p) => http.get(p).then(r => r.data),
    post: (p, d) => http.post(p, d).then(r => r.data),
    del: (p) => http.delete(p).then(r => r.data),
  };

  // Browser-mode label/document URLs (GET /api/print/label/:id,
  // /api/print/labels, /api/opr/shipments/:id/invoice, .../ce1154) are
  // opened via window.open(), which is a plain browser navigation and
  // can't carry our Authorization header.
  //
  // 2026-07-30 hardening: this used to append the full 12h session token as
  // `?token=` — a leaked URL (browser history, proxy/access logs, Referer)
  // would then grant full API access for hours. Fixed by minting a fresh,
  // 5-minute, route-scoped "doc token" (POST /api/auth/doc-token) right
  // before opening the window, instead of reusing the long-lived session
  // token. See src/lib/auth.ts for the server-side enforcement.
  //
  // window.open() must be called SYNCHRONOUSLY inside the click handler or
  // popup blockers kill it — but minting the doc token is an async API
  // call. Fix: open a blank window synchronously (preserves the "user
  // gesture" the browser needs to allow it), then navigate it once the doc
  // token comes back.
  async function openWithDocToken(url, features) {
    const win = window.open('', '_blank', features);
    if (!win) return null; // popup blocked before we even had a token
    try {
      const { token } = await api.post('/auth/doc-token');
      win.location = url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    } catch (e) {
      win.close();
      throw e;
    }
    return win;
  }

  async function refreshManifests() {
    const r = await api.get('/manifests');
    state.manifests = r.manifests || [];
    if (state.activeManifestId == null) {
      const open = state.manifests.find(m => m.status === 'open');
      if (open) state.activeManifestId = open.id;
    }
  }
  async function refreshActiveManifest() {
    if (!state.activeManifestId) {
      state.activeManifest = null; state.expected = []; state.unreconciled = [];
      state.summary = { expected_count: 0, received_count: 0 };
      state.billReconciliation = null;
      return;
    }
    const r = await api.get(`/manifests/${state.activeManifestId}`);
    state.activeManifest = r.manifest;
    state.expected = r.expected || [];
    state.unreconciled = r.unreconciled || [];
    state.summary = r.summary || { expected_count: 0, received_count: 0 };
    state.billReconciliation = r.bill_reconciliation || null;
    const ev = await api.get(`/scan/events/${state.activeManifestId}`);
    state.events = ev.events || [];
  }
  async function refreshInventory() {
    const r = await api.get('/inventory?limit=200');
    state.inventory = r.devices || [];
    // Drop any selected ids that are no longer present (e.g. deleted in another tab).
    const present = new Set(state.inventory.map(d => d.id));
    for (const id of Array.from(state.inventorySelected)) {
      if (!present.has(id)) state.inventorySelected.delete(id);
    }
  }
  async function refreshCatalog(q) {
    const url = q ? `/catalog?q=${encodeURIComponent(q)}` : '/catalog';
    const r = await api.get(url);
    state.catalog = r.catalog || [];
  }
  async function refreshPrint() {
    const r = await api.get('/print/queue');
    state.printQueue = r.queue || [];
  }
  async function refreshStats() {
    const r = await api.get('/inventory/stats');
    state.stats = r.stats || {};
  }
  // ───── OPR refreshers ─────
  async function refreshOprShipments() {
    const [s, a] = await Promise.all([api.get('/opr/shipments'), api.get('/opr/authorisations')]);
    state.oprShipments = s.shipments || [];
    state.oprAuths = a.authorisations || [];
  }
  async function refreshOprDetail() {
    if (!state.oprShipmentId) { state.oprBundle = null; state.oprValidation = null; state.oprEmails = []; return; }
    const id = state.oprShipmentId;
    state.oprBundle = await api.get(`/opr/shipments/${id}`);
    const [v, e] = await Promise.all([
      api.get(`/opr/shipments/${id}/validation`).catch(() => null),
      api.get(`/opr/shipments/${id}/emails`).catch(() => ({ emails: [] })),
    ]);
    state.oprValidation = v ? v.validation : null;
    state.oprEmails = e.emails || [];
  }
  async function refreshOprDischarge() {
    state.oprDischarge = await api.get('/opr/discharge');
  }

  // ───── Devices tab refreshers ─────
  async function refreshDeviceStatuses() {
    if (state.deviceStatuses) return; // static for the session — fetch once
    state.deviceStatuses = await api.get('/devices/meta/statuses');
  }
  // Curated default status set for "All Devices" when no explicit filter is
  // chosen — the generic-transition-eligible statuses (excludes the
  // OPR/repair-workflow-only statuses, which have their own sub-views/tabs,
  // and terminal SOLD/REJECTED, which have nowhere left to go).
  const ALL_DEVICES_DEFAULT_STATUSES = ['RECEIVED', 'SORTING', 'ACTIVE_INVENTORY', 'READY_FOR_EXPORT'];
  async function refreshDevicesAll() {
    const statusParam = state.devicesAllFilter || ALL_DEVICES_DEFAULT_STATUSES.join(',');
    const params = new URLSearchParams({ status: statusParam, page_size: '200' });
    if (state.devicesAllSearch) params.set('q', state.devicesAllSearch);
    const r = await api.get(`/devices?${params.toString()}`);
    state.devicesAll = r.devices || [];
  }
  async function refreshRepairQueue() {
    const r = await api.get('/devices/repair-queue');
    state.repairQueue = r.devices || [];
  }
  async function refreshQcFailedDevices() {
    const r = await api.get('/devices?status=QC_FAILED&page_size=200');
    state.qcFailedDevices = r.devices || [];
  }
  async function refreshReadyForZohoDevices() {
    const r = await api.get('/devices?status=READY_FOR_ZOHO&page_size=200');
    state.readyForZohoDevices = r.devices || [];
  }
  async function refreshRemovalFlags() {
    const r = await api.get(`/inventory/removal-flags?resolved=${state.removalFlagsShowResolved ? '1' : '0'}`);
    state.removalFlags = r.removal_flags || [];
  }
  async function refreshDevicesSubview() {
    await refreshDeviceStatuses();
    if (state.devicesSubview === 'all') await refreshDevicesAll();
    else if (state.devicesSubview === 'repair') await refreshRepairQueue();
    else if (state.devicesSubview === 'qc-failed') await refreshQcFailedDevices();
    else if (state.devicesSubview === 'ready-zoho') await refreshReadyForZohoDevices();
    else if (state.devicesSubview === 'removal-flags') await refreshRemovalFlags();
  }

  // ───────── Layout / Shell ─────────
  function render() {
    const root = $('#app');
    root.innerHTML = '';
    if (!state.authUser) {
      root.appendChild(LoginView());
      return;
    }
    root.appendChild(Shell());
    // Restore focus to scan input if on receive view
    if (state.view === 'receive') {
      setTimeout(() => $('#scan-input')?.focus(), 30);
    }
  }

  // ───────── Login ─────────
  // Real credentialed login (2026-07-28, replaces the email-only dev-login):
  // POST /api/auth/login with email + password. Two per-person accounts under
  // Saigates Limited — each person's writes are attributed to their own user
  // id. The token is stored via setAuthToken() and every subsequent api.*
  // call attaches it; wrong credentials surface the server's 401 message.
  function LoginView() {
    const doLogin = async (email, password) => {
      state.authError = null;
      state.authBusy = true;
      render();
      try {
        const r = await api.post('/auth/login', { email, password });
        setAuthToken(r.token);
        state.authUser = r.user;
        state.authBusy = false;
        await boot();
      } catch (err) {
        state.authBusy = false;
        state.authError = err.response?.data?.error || err.message;
        render();
      }
    };
    let emailValue = '';
    let passwordValue = '';
    const submit = () => doLogin(emailValue.trim(), passwordValue);
    return h('div', { class: 'min-h-screen flex items-center justify-center px-4' },
      h('div', { class: 'card p-8 w-full max-w-sm' },
        h('div', { class: 'flex items-center gap-3 mb-6' },
          h('div', { class: 'w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-400 to-indigo-500 flex items-center justify-center shadow-lg shadow-cyan-500/20' },
            h('i', { class: 'fas fa-box-open text-slate-900' })
          ),
          h('div', {},
            h('div', { class: 'text-sm font-bold tracking-wide' }, 'GOODS IN'),
            h('div', { class: 'text-[10px] text-slate-500 -mt-0.5' }, 'Saigates Limited · sign in to continue')
          )
        ),
        h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Email'),
        h('input', {
          id: 'login-email', class: 'input mb-3', type: 'email', placeholder: 'you@saigates.com',
          autocomplete: 'username',
          oninput: (e) => { emailValue = e.target.value; },
          onkeydown: (e) => { if (e.key === 'Enter') submit(); },
        }),
        h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Password'),
        h('input', {
          id: 'login-password', class: 'input mb-3', type: 'password', placeholder: '••••••••••',
          autocomplete: 'current-password',
          oninput: (e) => { passwordValue = e.target.value; },
          onkeydown: (e) => { if (e.key === 'Enter') submit(); },
        }),
        state.authError ? h('div', { class: 'mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200' },
          h('i', { class: 'fas fa-triangle-exclamation mr-2' }), state.authError) : null,
        h('button', {
          id: 'login-submit',
          class: 'btn btn-primary w-full justify-center' + (state.authBusy ? ' opacity-60 cursor-not-allowed' : ''),
          disabled: state.authBusy ? 'disabled' : null,
          onclick: submit,
        }, state.authBusy ? h('i', { class: 'fas fa-spinner fa-spin' }) : h('i', { class: 'fas fa-right-to-bracket' }), state.authBusy ? 'Signing in…' : 'Sign in'),
        h('div', { class: 'text-[11px] text-slate-500 mt-4 text-center' },
          'Per-person accounts — every action is attributed to the signed-in user.')
      )
    );
  }

  // ───────── Change password (self-service, in-session) ─────────
  // POST /api/auth/change-password — server re-verifies the CURRENT password
  // before accepting the new one, so a leftover token alone can't rotate a
  // credential. Only the signed-in user's own password; no admin reset here.
  function ChangePasswordModal() {
    const ctx = state._pwCtx ||= { current: '', next: '', confirm: '' };
    const close = () => { state.showChangePw = false; state._pwCtx = null; render(); };
    const submit = async () => {
      if (!ctx.current) { toast('Enter your current password', 'warn'); return; }
      if (ctx.next.length < 10) { toast('New password must be at least 10 characters', 'warn'); return; }
      if (ctx.next !== ctx.confirm) { toast('New passwords do not match', 'warn'); return; }
      try {
        await api.post('/auth/change-password', { current_password: ctx.current, new_password: ctx.next });
        toast('Password changed', 'ok');
        close();
      } catch (err) {
        toast(err.response?.data?.error || 'Failed to change password', 'err');
      }
    };
    return h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target.classList.contains('modal-backdrop')) close(); } },
      h('div', { class: 'modal p-6 max-w-sm' },
        h('div', { class: 'flex items-center gap-3 mb-4' },
          h('div', { class: 'w-10 h-10 rounded-xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center' },
            h('i', { class: 'fas fa-key' })),
          h('div', {},
            h('h2', { class: 'text-lg font-semibold' }, 'Change password'),
            h('p', { class: 'text-xs text-slate-400' }, (state.authUser?.email || '') + ' · min 10 characters')
          )
        ),
        h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Current password'),
        h('input', { id: 'pw-current', class: 'input mb-3', type: 'password', autocomplete: 'current-password',
          oninput: (e) => { ctx.current = e.target.value; } }),
        h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'New password'),
        h('input', { id: 'pw-next', class: 'input mb-3', type: 'password', autocomplete: 'new-password',
          oninput: (e) => { ctx.next = e.target.value; } }),
        h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Confirm new password'),
        h('input', { id: 'pw-confirm', class: 'input mb-3', type: 'password', autocomplete: 'new-password',
          oninput: (e) => { ctx.confirm = e.target.value; },
          onkeydown: (e) => { if (e.key === 'Enter') submit(); } }),
        h('div', { class: 'mt-2 flex justify-end gap-2' },
          h('button', { class: 'btn btn-ghost', onclick: close }, 'Cancel'),
          h('button', { id: 'pw-submit', class: 'btn btn-primary', onclick: submit },
            h('i', { class: 'fas fa-check' }), 'Change password')
        )
      )
    );
  }

  function logout() {
    setAuthToken(null);
    state.authUser = null;
    render();
  }

  function Shell() {
    return h('div', { class: 'min-h-screen flex flex-col' },
      Topbar(),
      h('main', { class: 'flex-1 px-6 py-6 max-w-[1600px] mx-auto w-full' },
        state.view === 'dashboard' ? DashboardView()
        : state.view === 'manifests' ? ManifestsView()
        : state.view === 'receive' ? ReceiveView()
        : state.view === 'inventory' ? InventoryView()
        : state.view === 'catalog' ? CatalogView()
        : state.view === 'print' ? PrintView()
        : state.view === 'devices' ? DevicesView()
        : state.view === 'bills' ? BillsView()
        : state.view === 'opr' ? OprView()
        : state.view === 'settings' ? SettingsView()
        : h('div', {}, 'Not found')
      ),
      state.showChangePw ? ChangePasswordModal() : null,
      state.pendingMatch ? ConfirmSkuModal() : null,
      state.pendingUnrec ? UnreconciledModal() : null,
      state.labelPreview ? LabelPreviewModal() : null,
      state.deleteDevice ? DeleteDeviceModal() : null,
      state.manualReceiveOpen ? ManualReceiveModal() : null,
      state.bulkScanOpen ? BulkScanModal() : null,
      state.oprNewOpen ? OprNewShipmentModal() : null,
      state.oprFinaliseOpen ? OprFinaliseModal() : null,
      state.oprDraftDoc ? OprDraftDocModal() : null,
      state.bulkTransitionOpen ? BulkTransitionModal() : null,
      state.billNewOpen ? BillNewModal() : null,
      state.billForceCloseOpen ? BillForceCloseModal() : null,
    );
  }

  function Topbar() {
    const Tab = (id, label, icon) => h('div', {
      class: 'tab-btn ' + (state.view === id ? 'active' : ''),
      onclick: () => switchView(id),
    },
      h('i', { class: `fas fa-${icon} mr-2 text-xs` }),
      label
    );
    return h('header', { class: 'border-b border-slate-800 bg-slate-950/60 backdrop-blur sticky top-0 z-30' },
      h('div', { class: 'max-w-[1600px] mx-auto px-6 py-3 flex items-center gap-4' },
        h('div', { class: 'flex items-center gap-3' },
          h('div', { class: 'w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-400 to-indigo-500 flex items-center justify-center shadow-lg shadow-cyan-500/20' },
            h('i', { class: 'fas fa-box-open text-slate-900' })
          ),
          h('div', {},
            h('div', { class: 'text-sm font-bold tracking-wide' }, 'GOODS IN'),
            h('div', { class: 'text-[10px] text-slate-500 -mt-0.5' }, 'Inventory Receiving · Wholesale Devices')
          )
        ),
        h('nav', { class: 'flex items-center gap-1 ml-6' },
          // Order follows the actual work flow (2026-08-18 reorder — Bills used
          // to sit eighth purely because it was built last): a bill arrives,
          // its manifest is uploaded/linked, goods are received against it,
          // land in inventory, get catalogued, printed, and tracked as
          // devices; OPR (export/repair round-trip) runs alongside/after.
          Tab('dashboard', 'Dashboard', 'gauge-high'),
          Tab('bills', 'Bills', 'file-invoice-dollar'),
          Tab('manifests', 'Manifests', 'file-invoice'),
          Tab('receive', 'Receive', 'barcode'),
          Tab('inventory', 'Inventory', 'warehouse'),
          Tab('catalog', 'Catalog', 'tags'),
          Tab('print', 'Print Queue', 'print'),
          Tab('devices', 'Devices', 'mobile-screen-button'),
          Tab('opr', 'OPR', 'plane-departure'),
          Tab('settings', 'Settings', 'gear'),
        ),
        h('div', { class: 'ml-auto flex items-center gap-3' },
          state.activeManifest ? h('div', { class: 'text-xs text-slate-400 hidden md:flex items-center gap-2' },
            h('span', { class: 'text-slate-500' }, 'Active manifest:'),
            h('span', { class: 'text-cyan-300 font-semibold mono' }, state.activeManifest.reference),
            h('span', { class: 'badge ' + (state.activeManifest.status === 'open' ? 'badge-green' : 'badge-slate') }, state.activeManifest.status)
          ) : null,
          h('div', { class: 'flex items-center gap-1 bg-slate-900/60 border border-slate-800 rounded-lg p-1', title: 'DYMO label format' },
            h('button', {
              class: 'px-2 py-1 rounded-md text-xs font-medium transition ' +
                (state.labelSize === 'large' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-slate-200'),
              onclick: () => { setLabelSize('large'); render(); },
            }, h('i', { class: 'fas fa-tag mr-1' }), 'DYMO 57×32'),
            h('button', {
              class: 'px-2 py-1 rounded-md text-xs font-medium transition ' +
                (state.labelSize === 'small' ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-400 hover:text-slate-200'),
              onclick: () => { setLabelSize('small'); render(); },
            }, h('i', { class: 'fas fa-receipt mr-1' }), 'DYMO 32×57'),
          ),
          h('button', {
            class: 'btn btn-ghost text-xs ' + (state.labelRotate ? '!bg-amber-500/20 !text-amber-300 !border-amber-500/40' : ''),
            title: state.labelRotate
              ? 'Label rotation ON — content rotated 90° to match DYMO feed direction. Click to disable.'
              : 'Label rotation OFF. Turn on if labels print sideways across two stickers.',
            onclick: () => { setLabelRotate(!state.labelRotate); render(); toast(`Label rotation ${state.labelRotate ? 'enabled' : 'disabled'}`, 'ok'); },
          }, h('i', { class: 'fas fa-rotate' + (state.labelRotate ? '' : '-right') })),
          h('button', {
            class: 'btn btn-ghost text-xs',
            title: 'Toggle scanner sound',
            onclick: () => { state.soundOn = !state.soundOn; render(); },
          }, h('i', { class: `fas fa-${state.soundOn ? 'volume-high' : 'volume-xmark'}` })),
          state.authUser ? h('div', { class: 'flex items-center gap-2 pl-2 border-l border-slate-800' },
            h('div', { class: 'text-xs text-slate-400 hidden md:block' }, state.authUser.name || state.authUser.email),
            h('button', { id: 'change-pw-btn', class: 'btn btn-ghost text-xs', title: 'Change password',
              onclick: () => { state.showChangePw = true; render(); } },
              h('i', { class: 'fas fa-key' })),
            h('button', { class: 'btn btn-ghost text-xs', title: 'Sign out', onclick: logout },
              h('i', { class: 'fas fa-right-from-bracket' }))
          ) : null
        )
      )
    );
  }

  function switchView(v) {
    state.view = v;
    if (v === 'dashboard') refreshStats().then(() => refreshManifests()).then(render);
    else if (v === 'manifests') refreshManifests().then(render);
    else if (v === 'receive') refreshManifests().then(refreshActiveManifest).then(render);
    else if (v === 'inventory') refreshInventory().then(render);
    else if (v === 'catalog') refreshCatalog().then(render);
    else if (v === 'print') refreshPrint().then(render);
    else if (v === 'devices') refreshDevicesSubview().then(render);
    else if (v === 'bills') refreshBillsList().then(render);
    else if (v === 'opr') refreshOprAll().then(render);
    else if (v === 'settings') refreshSettings().then(render);
    render();
  }

  // ───────── OPR (Outward Processing Relief) ─────────
  // API-backed UI over /api/opr/* — consignment builder (scan-first),
  // validation traffic lights, finalise, customs documents (invoice,
  // scan-out, pre-alert, C&E1154, clearance), email outbox + send buttons
  // (honesty-gated server-side: 503 gmail_not_configured until secrets are
  // set), receipt/restock for returns, and the discharge tracker.
  async function refreshOprAll() {
    await refreshOprShipments();
    if (state.oprShipmentId) await refreshOprDetail();
    if (state.oprTab === 'discharge') await refreshOprDischarge();
  }
  function oprStatusBadge(s) {
    return h('span', { class: 'badge ' + (s === 'DRAFT' ? 'badge-amber' : s === 'FINALISED' ? 'badge-green' : 'badge-slate') }, s);
  }
  function oprDirBadge(d) {
    return d === 'export'
      ? h('span', { class: 'badge badge-cyan' }, h('i', { class: 'fas fa-plane-departure mr-1' }), 'export')
      : h('span', { class: 'badge badge-violet' }, h('i', { class: 'fas fa-plane-arrival mr-1' }), 'import');
  }
  const fmtMoney = (v, cur) => `${cur || 'GBP'} ${Number(v || 0).toFixed(2)}`;

  // ───────── Devices (status-movement / repair queue / QC / removal flags) ─────────
  // One Topbar tab, five sub-views (2026-08-12 placement decision — not five
  // separate tabs). TEMP_EXPORT_STANDARD screens live under the OPR tab
  // instead (reusing OprView's consignment UI), not here.
  function isManagerOrAdmin() {
    const role = state.authUser && state.authUser.role;
    return role === 'manager' || role === 'admin';
  }
  function deviceStatusBadge(s) {
    const cls = {
      RECEIVED: 'badge-slate', SORTING: 'badge-slate', ACTIVE_INVENTORY: 'badge-green',
      IN_HOUSE_REPAIR: 'badge-amber', QC_FAILED: 'badge-red', READY_FOR_ZOHO: 'badge-cyan',
      READY_FOR_EXPORT: 'badge-violet', SOLD: 'badge-green', REJECTED: 'badge-red',
    }[s] || 'badge-slate';
    return h('span', { class: `badge ${cls} text-[10px]` }, s);
  }
  function deviceLabel(d) {
    return [d.brand, d.model].filter(Boolean).join(' ') || d.sku || '—';
  }

  function DevicesView() {
    const SubTab = (id, label, icon) => h('button', {
      class: 'btn text-sm ' + (state.devicesSubview === id ? 'btn-primary' : 'btn-ghost'),
      onclick: () => { state.devicesSubview = id; refreshDevicesSubview().then(render); },
    }, h('i', { class: `fas fa-${icon}` }), label);
    return h('div', { class: 'space-y-5' },
      h('div', { class: 'flex items-center justify-between flex-wrap gap-3' },
        h('div', {},
          h('h1', { class: 'text-2xl font-bold' }, 'Devices'),
          h('p', { class: 'text-slate-400 text-sm' }, 'Status movement, in-house repair queue, QC and removal-flag review.')
        ),
        h('div', { class: 'flex items-center gap-2 flex-wrap' },
          SubTab('all', 'All Devices', 'layer-group'),
          SubTab('repair', 'Repair Queue', 'screwdriver-wrench'),
          SubTab('qc-failed', 'QC Failed', 'triangle-exclamation'),
          SubTab('ready-zoho', 'Ready for Zoho', 'cloud-arrow-up'),
          SubTab('removal-flags', 'Removal Flags', 'flag'),
        )
      ),
      state.devicesSubview === 'all' ? AllDevicesSubview()
        : state.devicesSubview === 'repair' ? RepairQueueSubview()
        : state.devicesSubview === 'qc-failed' ? QcFailedSubview()
        : state.devicesSubview === 'ready-zoho' ? ReadyForZohoSubview()
        : state.devicesSubview === 'removal-flags' ? RemovalFlagsSubview()
        : null
    );
  }

  // ─── All Devices — status + legal transitions ───
  async function doTransition(device, toStatus) {
    if (state.devicesBusy) return;
    state.devicesBusy = true; render();
    try {
      await api.post(`/devices/${device.id}/transition`, { to_status: toStatus });
      toast(`<span class="mono">${device.imei}</span> · ${device.status} → ${toStatus}`, 'ok');
      await refreshDevicesSubview(); render();
    } catch (err) {
      toast(err.response?.data?.error || err.message, 'err', 5000);
    } finally {
      state.devicesBusy = false; render();
    }
  }
  async function doStartRepair(device) {
    const fault = prompt(`Fault code for ${device.imei} (${deviceLabel(device)}):`);
    if (fault == null) return; // cancelled
    if (!fault.trim()) { toast('Fault code is required', 'warn'); return; }
    try {
      await api.post(`/devices/${device.id}/repair/start`, { fault_code: fault.trim() });
      toast(`<span class="mono">${device.imei}</span> sent to in-house repair`, 'ok');
      await refreshDevicesSubview(); render();
    } catch (err) {
      toast(err.response?.data?.error || err.message, 'err', 5000);
    }
  }

  function AllDevicesSubview() {
    const statuses = (state.deviceStatuses && state.deviceStatuses.statuses) || [];
    const transitions = (state.deviceStatuses && state.deviceStatuses.transitions) || {};
    const REPAIR_STARTABLE = ['SORTING', 'ACTIVE_INVENTORY'];

    return h('div', { class: 'space-y-4' },
      h('div', { class: 'flex items-center gap-2 flex-wrap' },
        h('select', {
          class: 'input text-sm w-auto',
          onchange: (e) => { state.devicesAllFilter = e.target.value; refreshDevicesAll().then(render); },
        },
          h('option', { value: '', selected: !state.devicesAllFilter ? 'selected' : null }, 'Default (active statuses)'),
          h('option', { value: statuses.join(','), selected: state.devicesAllFilter === statuses.join(',') ? 'selected' : null }, 'All statuses'),
          statuses.map(s => h('option', { value: s, selected: state.devicesAllFilter === s ? 'selected' : null }, s)),
        ),
        h('input', {
          class: 'input text-sm flex-1 max-w-xs', placeholder: 'Search IMEI / SKU / UUID',
          value: state.devicesAllSearch,
          oninput: (e) => { state.devicesAllSearch = e.target.value; refreshDevicesAll().then(render); },
        }),
        h('button', { class: 'btn btn-primary text-xs ml-auto', onclick: () => { state.bulkTransitionOpen = true; render(); } },
          h('i', { class: 'fas fa-layer-group' }), 'Bulk transition by scan'),
      ),
      h('div', { class: 'card overflow-hidden' },
        h('table', { class: 'w-full text-sm' },
          h('thead', { class: 'bg-slate-900/50 text-xs uppercase text-slate-400' },
            h('tr', {},
              h('th', { class: 'text-left px-4 py-3' }, 'IMEI'),
              h('th', { class: 'text-left px-4 py-3' }, 'SKU / Device'),
              h('th', { class: 'text-left px-4 py-3' }, 'Status'),
              h('th', { class: 'text-right px-4 py-3' }, 'Move to'),
            )
          ),
          h('tbody', { class: 'divide-y divide-slate-800' },
            !state.devicesAll.length
              ? h('tr', {}, h('td', { colspan: 4, class: 'text-center py-10 text-slate-500' }, 'No devices match this filter.'))
              : state.devicesAll.map(d => {
                  const nextStatuses = transitions[d.status] || [];
                  const canStartRepair = REPAIR_STARTABLE.includes(d.status);
                  return h('tr', { class: 'row-strip' },
                    h('td', { class: 'px-4 py-2 mono text-xs' }, d.imei),
                    h('td', { class: 'px-4 py-2 text-xs' },
                      h('div', { class: 'font-medium text-cyan-300 mono' }, d.sku),
                      h('div', { class: 'text-slate-500' }, deviceLabel(d))),
                    h('td', { class: 'px-4 py-2' }, deviceStatusBadge(d.status)),
                    h('td', { class: 'px-4 py-2 text-right' },
                      h('div', { class: 'flex items-center justify-end gap-2' },
                        canStartRepair ? h('button', {
                          class: 'btn btn-ghost text-xs', title: 'Send to in-house repair',
                          onclick: () => doStartRepair(d),
                        }, h('i', { class: 'fas fa-screwdriver-wrench' }), 'Repair') : null,
                        nextStatuses.length ? h('select', {
                          class: 'input text-xs py-1 px-2 w-auto',
                          onchange: (e) => { if (e.target.value) { doTransition(d, e.target.value); e.target.value = ''; } },
                        },
                          h('option', { value: '' }, 'Move to…'),
                          nextStatuses.map(s => h('option', { value: s }, s))
                        ) : (!canStartRepair ? h('span', { class: 'text-xs text-slate-600' }, 'No moves') : null)
                      ))
                  );
                })
          )
        )
      )
    );
  }

  // ─── Repair Queue ───
  async function doScanBack(device) {
    try {
      await api.post(`/devices/${device.id}/repair/scan-back`, {});
      toast(`<span class="mono">${device.imei}</span> scanned back — awaiting QC`, 'ok');
      await refreshRepairQueue(); render();
    } catch (err) {
      toast(err.response?.data?.error || err.message, 'err', 5000);
    }
  }
  async function doRecordQc(device, result) {
    let reason = null;
    if (result === 'FAILED') {
      reason = prompt(`Reason QC failed for ${device.imei}:`);
      if (reason == null) return;
      if (!reason.trim()) { toast('A reason is required for a FAILED result', 'warn'); return; }
    }
    try {
      await api.post(`/devices/${device.id}/repair/qc`, { result, reason: reason ? reason.trim() : undefined });
      toast(`<span class="mono">${device.imei}</span> QC ${result === 'PASSED' ? 'passed → Ready for Zoho' : 'failed'}`, result === 'PASSED' ? 'ok' : 'warn');
      await refreshRepairQueue(); render();
    } catch (err) {
      toast(err.response?.data?.error || err.message, 'err', 5000);
    }
  }
  async function doReopenRepair(device) {
    try {
      await api.post(`/devices/${device.id}/repair/reopen`, {});
      toast(`<span class="mono">${device.imei}</span> reopened for repair`, 'ok');
      await refreshRepairQueue(); render();
    } catch (err) {
      toast(err.response?.data?.error || err.message, 'err', 5000);
    }
  }
  async function doRecordCost(device) {
    const cost = prompt(`Repair cost (GBP) for ${device.imei}:`);
    if (cost == null) return;
    const n = Number(cost);
    if (!Number.isFinite(n) || n < 0) { toast('Enter a valid non-negative number', 'warn'); return; }
    try {
      await api.post(`/devices/${device.id}/repair/cost`, { repair_cost_gbp: n, cost_source: 'in_house' });
      toast(`Repair cost £${n.toFixed(2)} recorded for <span class="mono">${device.imei}</span>`, 'ok');
      await refreshRepairQueue(); render();
    } catch (err) {
      toast(err.response?.data?.error || err.message, 'err', 5000);
    }
  }

  function RepairQueueSubview() {
    const managerOk = isManagerOrAdmin();
    return h('div', { class: 'space-y-4' },
      h('div', { class: 'text-sm text-slate-400' }, `${state.repairQueue.length} device${state.repairQueue.length === 1 ? '' : 's'} in the repair workflow`),
      h('div', { class: 'card overflow-hidden' },
        h('table', { class: 'w-full text-sm' },
          h('thead', { class: 'bg-slate-900/50 text-xs uppercase text-slate-400' },
            h('tr', {},
              h('th', { class: 'text-left px-4 py-3' }, 'IMEI'),
              h('th', { class: 'text-left px-4 py-3' }, 'Device'),
              h('th', { class: 'text-left px-4 py-3' }, 'Status'),
              h('th', { class: 'text-left px-4 py-3' }, 'Fault'),
              h('th', { class: 'text-left px-4 py-3' }, 'Job status'),
              h('th', { class: 'text-right px-4 py-3' }, 'Actions'),
            )
          ),
          h('tbody', { class: 'divide-y divide-slate-800' },
            !state.repairQueue.length
              ? h('tr', {}, h('td', { colspan: 6, class: 'text-center py-10 text-slate-500' }, 'Repair queue is empty.'))
              : state.repairQueue.map(d => h('tr', { class: 'row-strip' },
                  h('td', { class: 'px-4 py-2 mono text-xs' }, d.imei),
                  h('td', { class: 'px-4 py-2 text-xs' }, deviceLabel(d)),
                  h('td', { class: 'px-4 py-2' }, deviceStatusBadge(d.status)),
                  h('td', { class: 'px-4 py-2 text-xs text-slate-300' }, d.fault_code || '—'),
                  h('td', { class: 'px-4 py-2' },
                    h('span', { class: 'badge badge-slate text-[10px]' }, d.repair_job_status || '—'),
                    d.repair_job_status === 'open' && d.status === 'QC_FAILED'
                      ? h('div', { class: 'text-[11px] text-red-400 mt-0.5' }, d.qc_fail_reason || '') : null),
                  h('td', { class: 'px-4 py-2 text-right' },
                    h('div', { class: 'flex items-center justify-end gap-2 flex-wrap' },
                      d.status === 'IN_HOUSE_REPAIR' && d.repair_job_status === 'open'
                        ? h('button', { class: 'btn btn-ghost text-xs', onclick: () => doScanBack(d) }, h('i', { class: 'fas fa-rotate-left' }), 'Scan back') : null,
                      d.status === 'IN_HOUSE_REPAIR' && d.repair_job_status === 'awaiting_qc' && managerOk
                        ? [h('button', { class: 'btn text-xs !bg-green-600/20 !text-green-300', onclick: () => doRecordQc(d, 'PASSED') }, h('i', { class: 'fas fa-check' }), 'QC pass'),
                           h('button', { class: 'btn text-xs !bg-red-600/20 !text-red-300', onclick: () => doRecordQc(d, 'FAILED') }, h('i', { class: 'fas fa-xmark' }), 'QC fail')] : null,
                      d.status === 'IN_HOUSE_REPAIR' && d.repair_job_status === 'awaiting_qc' && !managerOk
                        ? h('span', { class: 'text-[11px] text-slate-500' }, 'QC is manager-only') : null,
                      d.status === 'QC_FAILED'
                        ? h('button', { class: 'btn btn-ghost text-xs', onclick: () => doReopenRepair(d) }, h('i', { class: 'fas fa-arrow-rotate-right' }), 'Reopen') : null,
                      managerOk ? h('button', { class: 'btn btn-ghost text-xs', title: 'Record repair cost', onclick: () => doRecordCost(d) }, h('i', { class: 'fas fa-sterling-sign' })) : null,
                    ))
                ))
          )
        )
      )
    );
  }

  // ─── QC Failed ───
  function QcFailedSubview() {
    return h('div', { class: 'space-y-4' },
      h('div', { class: 'text-sm text-slate-400' }, `${state.qcFailedDevices.length} device${state.qcFailedDevices.length === 1 ? '' : 's'} failed QC`),
      h('div', { class: 'card overflow-hidden' },
        h('table', { class: 'w-full text-sm' },
          h('thead', { class: 'bg-slate-900/50 text-xs uppercase text-slate-400' },
            h('tr', {},
              h('th', { class: 'text-left px-4 py-3' }, 'IMEI'),
              h('th', { class: 'text-left px-4 py-3' }, 'Device'),
              h('th', { class: 'text-left px-4 py-3' }, 'Grade'),
              h('th', { class: 'text-right px-4 py-3' }, ''),
            )
          ),
          h('tbody', { class: 'divide-y divide-slate-800' },
            !state.qcFailedDevices.length
              ? h('tr', {}, h('td', { colspan: 4, class: 'text-center py-10 text-slate-500' }, 'Nothing here — no devices currently failed QC.'))
              : state.qcFailedDevices.map(d => h('tr', { class: 'row-strip' },
                  h('td', { class: 'px-4 py-2 mono text-xs' }, d.imei),
                  h('td', { class: 'px-4 py-2 text-xs' }, deviceLabel(d)),
                  h('td', { class: 'px-4 py-2' }, h('span', { class: gradeBadgeClass(d.grade) }, gradeLabel(d.grade))),
                  h('td', { class: 'px-4 py-2 text-right' },
                    h('button', { class: 'btn btn-ghost text-xs', onclick: () => { state.devicesSubview = 'repair'; refreshRepairQueue().then(render); } },
                      h('i', { class: 'fas fa-screwdriver-wrench' }), 'Go to Repair Queue'))
                ))
          )
        )
      )
    );
  }

  // ─── Ready for Zoho ───
  function ReadyForZohoSubview() {
    return h('div', { class: 'space-y-4' },
      h('div', { class: 'text-sm text-slate-400' }, `${state.readyForZohoDevices.length} device${state.readyForZohoDevices.length === 1 ? '' : 's'} ready for Zoho upload`),
      h('div', { class: 'card overflow-hidden' },
        h('table', { class: 'w-full text-sm' },
          h('thead', { class: 'bg-slate-900/50 text-xs uppercase text-slate-400' },
            h('tr', {},
              h('th', { class: 'text-left px-4 py-3' }, 'IMEI'),
              h('th', { class: 'text-left px-4 py-3' }, 'SKU / Device'),
              h('th', { class: 'text-left px-4 py-3' }, 'Grade'),
              h('th', { class: 'text-left px-4 py-3' }, 'Received'),
            )
          ),
          h('tbody', { class: 'divide-y divide-slate-800' },
            !state.readyForZohoDevices.length
              ? h('tr', {}, h('td', { colspan: 4, class: 'text-center py-10 text-slate-500' }, 'No devices are ready for Zoho upload yet.'))
              : state.readyForZohoDevices.map(d => h('tr', { class: 'row-strip' },
                  h('td', { class: 'px-4 py-2 mono text-xs' }, d.imei),
                  h('td', { class: 'px-4 py-2 text-xs' },
                    h('div', { class: 'font-medium text-cyan-300 mono' }, d.sku),
                    h('div', { class: 'text-slate-500' }, deviceLabel(d))),
                  h('td', { class: 'px-4 py-2' }, h('span', { class: gradeBadgeClass(d.grade) }, gradeLabel(d.grade))),
                  h('td', { class: 'px-4 py-2 text-xs text-slate-400' }, fmtDate(d.created_at)),
                ))
          )
        )
      )
    );
  }

  // ─── Removal Flags ───
  async function doResolveRemovalFlag(flag) {
    const note = prompt(`Resolution note for ${flag.imei} (optional):`) || undefined;
    try {
      await api.post(`/inventory/removal-flags/${flag.id}/resolve`, { note });
      toast(`<span class="mono">${flag.imei}</span> removal flag resolved`, 'ok');
      await refreshRemovalFlags(); render();
    } catch (err) {
      toast(err.response?.data?.error || err.message, 'err', 5000);
    }
  }
  function RemovalFlagsSubview() {
    return h('div', { class: 'space-y-4' },
      h('div', { class: 'flex items-center justify-between' },
        h('div', { class: 'text-sm text-slate-400' }, `${state.removalFlags.length} ${state.removalFlagsShowResolved ? 'total' : 'open'} removal flag${state.removalFlags.length === 1 ? '' : 's'}`),
        h('label', { class: 'flex items-center gap-2 text-xs text-slate-300 select-none' },
          h('input', {
            type: 'checkbox', class: 'accent-cyan-500', checked: state.removalFlagsShowResolved ? 'checked' : null,
            onchange: (e) => { state.removalFlagsShowResolved = e.target.checked; refreshRemovalFlags().then(render); },
          }),
          'Show resolved'
        )
      ),
      h('div', { class: 'card overflow-hidden' },
        h('table', { class: 'w-full text-sm' },
          h('thead', { class: 'bg-slate-900/50 text-xs uppercase text-slate-400' },
            h('tr', {},
              h('th', { class: 'text-left px-4 py-3' }, 'IMEI'),
              h('th', { class: 'text-left px-4 py-3' }, 'SKU'),
              h('th', { class: 'text-left px-4 py-3' }, 'Grade change'),
              h('th', { class: 'text-left px-4 py-3' }, 'Reason'),
              h('th', { class: 'text-left px-4 py-3' }, 'Flagged'),
              h('th', { class: 'text-right px-4 py-3' }, '')
            )
          ),
          h('tbody', { class: 'divide-y divide-slate-800' },
            !state.removalFlags.length
              ? h('tr', {}, h('td', { colspan: 6, class: 'text-center py-10 text-slate-500' }, 'No removal flags.'))
              : state.removalFlags.map(f => h('tr', { class: 'row-strip' },
                  h('td', { class: 'px-4 py-2 mono text-xs' }, f.imei),
                  h('td', { class: 'px-4 py-2 mono text-xs text-cyan-300' }, f.sku),
                  h('td', { class: 'px-4 py-2 text-xs' },
                    h('span', { class: gradeBadgeClass(f.old_grade) }, gradeLabel(f.old_grade)), ' → ',
                    h('span', { class: gradeBadgeClass(f.new_grade) }, gradeLabel(f.new_grade))),
                  h('td', { class: 'px-4 py-2 text-xs text-slate-400' }, f.reason),
                  h('td', { class: 'px-4 py-2 text-xs text-slate-400' }, fmtDate(f.flagged_at)),
                  h('td', { class: 'px-4 py-2 text-right' },
                    f.resolved_at
                      ? h('span', { class: 'badge badge-green text-[10px]' }, 'resolved')
                      : h('button', { class: 'btn btn-ghost text-xs', onclick: () => doResolveRemovalFlag(f) }, h('i', { class: 'fas fa-check' }), 'Resolve'))
                ))
          )
        )
      )
    );
  }

  // ─── Bulk transition by scan ───
  function BulkTransitionModal() {
    const ctx = state._bulkTransCtx ||= {
      raw: '', target_status: '', busy: false,
      resultsByImei: new Map(),
    };
    const close = () => { state.bulkTransitionOpen = false; state._bulkTransCtx = null; render(); };
    const parsedImeis = () => parseBulkImeis(ctx.raw).unique;
    const statuses = (state.deviceStatuses && state.deviceStatuses.statuses) || [];

    const run = async () => {
      const parsed = parseBulkImeis(ctx.raw);
      const imeis = parsed.unique;
      if (!ctx.target_status) { toast('Pick a target status first', 'warn'); return; }
      if (imeis.length === 0) { toast('Nothing to scan — add an IMEI', 'warn'); return; }
      if (imeis.length > BULK_IMEI_CAP) { toast(`${imeis.length} unique IMEIs — maximum is ${BULK_IMEI_CAP} per batch.`, 'warn'); return; }
      if (parsed.duplicates > 0) {
        toast(`${parsed.raw} lines pasted/scanned, ${parsed.duplicates} duplicate${parsed.duplicates === 1 ? '' : 's'} removed — sending ${imeis.length} unique IMEI${imeis.length === 1 ? '' : 's'}`, 'warn', 5000);
      }
      ctx.busy = true; state._bulkTransCtx = ctx; render();
      try {
        const r = await api.post('/devices/bulk-transition', { target_status: ctx.target_status, imeis });
        for (const row of r.results) ctx.resultsByImei.set(row.imei, row);
        // drop settled (successfully transitioned) IMEIs so a retry only resends the outstanding ones
        ctx.raw = parsedImeis().filter(i => ctx.resultsByImei.get(i)?.outcome !== 'transitioned').join('\n');
        beep(r.failed === 0 ? 'ok' : (r.transitioned === 0 ? 'err' : 'warn'));
        toast(`This run: ${r.transitioned} transitioned, ${r.failed} not (of ${r.requested} scanned)`, r.failed === 0 ? 'ok' : 'warn', 4000);
        await refreshDevicesSubview();
      } catch (err) {
        toast(err.response?.data?.error || 'Bulk transition failed', 'err', 5000);
      } finally {
        ctx.busy = false; state._bulkTransCtx = ctx; render();
      }
    };

    const outcomeCls = { transitioned: 'badge-green', skipped: 'badge-amber', error: 'badge-red' };
    const allResults = Array.from(ctx.resultsByImei.values());
    const totalOk = allResults.filter(r => r.outcome === 'transitioned').length;

    return h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target.classList.contains('modal-backdrop')) close(); } },
      h('div', { class: 'modal p-6 max-w-2xl' },
        h('div', { class: 'flex items-center gap-3 mb-1' },
          h('div', { class: 'w-10 h-10 rounded-xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center' },
            h('i', { class: 'fas fa-layer-group' })),
          h('div', {},
            h('h2', { class: 'text-lg font-semibold' }, 'Bulk transition by scan'),
            h('p', { class: 'text-xs text-slate-400' }, `Pick a target status, then scan or paste many IMEIs (one per line) — up to ${BULK_IMEI_CAP} unique per batch. Each device is validated against the allowed-transition map independently; one bad or ineligible IMEI never blocks the rest. Duplicate lines are merged and always reported, never silently dropped.`)
          )
        ),
        h('div', { class: 'mt-3' },
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Target status *'),
          h('select', {
            class: 'input', onchange: (e) => { ctx.target_status = e.target.value; state._bulkTransCtx = ctx; },
          },
            h('option', { value: '', selected: !ctx.target_status ? 'selected' : null }, '— select —'),
            statuses.map(s => h('option', { value: s, selected: s === ctx.target_status ? 'selected' : null }, s))
          )
        ),
        h('div', { class: 'mt-3' },
          h('label', { class: 'text-xs text-slate-400 mb-1 block flex items-center justify-between' },
            h('span', {}, 'IMEIs *'),
            (() => {
              const p = parseBulkImeis(ctx.raw);
              return p.duplicates > 0
                ? h('span', { class: 'text-amber-400' }, `${p.raw} pasted, ${p.duplicates} duplicate${p.duplicates === 1 ? '' : 's'} removed — ${p.unique.length} unique`)
                : h('span', { class: 'text-slate-500' }, `${p.unique.length} unique IMEI${p.unique.length === 1 ? '' : 's'}`);
            })()
          ),
          h('textarea', {
            id: 'bulk-transition-textarea', class: 'input mono text-sm', rows: 8, autofocus: 'true',
            placeholder: 'Scan IMEIs here, one per line…', value: ctx.raw,
            oninput: (e) => { ctx.raw = e.target.value; state._bulkTransCtx = ctx; render(); },
          })
        ),
        allResults.length > 0 ? h('div', { class: 'mt-4 card p-3 bg-slate-900/40' },
          h('div', { class: 'flex items-center justify-between mb-2' },
            h('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500' }, 'Progress (all runs this session)'),
            h('div', { class: 'text-xs' },
              h('span', { class: 'text-green-400 font-semibold' }, totalOk), ' transitioned · ',
              h('span', { class: 'text-red-400 font-semibold' }, allResults.length - totalOk), ' outstanding')
          ),
          h('div', { class: 'max-h-64 overflow-y-auto divide-y divide-slate-800' },
            allResults.map(r => h('div', { class: 'py-1.5 px-1 text-xs flex items-center gap-3' },
              h('span', { class: 'badge ' + (outcomeCls[r.outcome] || 'badge-slate') }, r.outcome),
              h('code', { class: 'mono flex-1' }, r.imei),
              r.from_status ? h('span', { class: 'text-slate-500' }, r.from_status) : null,
              r.message ? h('span', { class: 'text-slate-400 truncate max-w-xs' }, r.message) : null
            ))
          )
        ) : null,
        h('div', { class: 'mt-5 flex justify-end gap-2' },
          h('button', { class: 'btn btn-ghost', onclick: close }, allResults.length > 0 ? 'Close' : 'Cancel'),
          h('button', {
            class: 'btn btn-primary' + (ctx.busy ? ' opacity-60 cursor-not-allowed' : ''),
            id: 'bulk-transition-run-btn', onclick: run, disabled: ctx.busy ? 'disabled' : null,
          }, ctx.busy ? [h('i', { class: 'fas fa-spinner fa-spin' }), 'Processing…'] : [h('i', { class: 'fas fa-check-double' }), 'Transition batch'])
        )
      )
    );
  }

  // ───────── Bills (Sprint B §1 — ONE builder for purchase|repair) ─────────
  // API-backed UI over /api/bills/* — list + filters, create (header fields
  // incl. currency_code/exchange_rate/rate_date/rate_source + per-IMEI
  // line entry), detail with sum(lines) vs declared_total_gbp
  // reconciliation, close / force-close (variance + reason + user).
  //
  // This UI works entirely off received_devices resolution
  // (bill_line_serials.received_device_id) — bill-to-manifest consumption
  // status is tracked in test/browser/README.md's process notes, not here.
  function billStatusBadge(s) {
    return h('span', { class: 'badge ' + (s === 'closed' ? 'badge-green' : 'badge-amber') }, s);
  }
  function billTypeBadge(t) {
    return t === 'repair'
      ? h('span', { class: 'badge badge-violet' }, h('i', { class: 'fas fa-screwdriver-wrench mr-1' }), 'repair')
      : h('span', { class: 'badge badge-cyan' }, h('i', { class: 'fas fa-cart-shopping mr-1' }), 'purchase');
  }
  async function refreshBillsList() {
    const params = new URLSearchParams();
    if (state.billsFilterType) params.set('bill_type', state.billsFilterType);
    if (state.billsFilterStatus) params.set('status', state.billsFilterStatus);
    const qs = params.toString();
    const r = await api.get(`/bills${qs ? '?' + qs : ''}`);
    state.bills = r.bills || [];
  }
  async function refreshBillDetail() {
    if (!state.billId) { state.billDetail = null; return; }
    state.billDetail = await api.get(`/bills/${state.billId}`);
  }
  function BillsView() {
    return h('div', { class: 'space-y-5' },
      h('div', { class: 'flex items-center justify-between flex-wrap gap-3' },
        h('div', {},
          h('h1', { class: 'text-2xl font-bold' }, 'Bills'),
          h('p', { class: 'text-slate-400 text-sm' }, 'One builder for purchase and repair invoices — header fields, per-IMEI pricing, close/force-close.')
        )
      ),
      state.billId ? BillDetailView() : BillsListView()
    );
  }

  // ─── Bills list ───
  function BillsListView() {
    return h('div', { class: 'space-y-4' },
      h('div', { class: 'flex items-center gap-2 flex-wrap' },
        h('select', {
          id: 'bills-filter-type', class: 'input text-sm w-auto',
          onchange: (e) => { state.billsFilterType = e.target.value; refreshBillsList().then(render); },
        },
          h('option', { value: '', selected: !state.billsFilterType ? 'selected' : null }, 'All bill types'),
          h('option', { value: 'purchase', selected: state.billsFilterType === 'purchase' ? 'selected' : null }, 'Purchase'),
          h('option', { value: 'repair', selected: state.billsFilterType === 'repair' ? 'selected' : null }, 'Repair'),
        ),
        h('select', {
          id: 'bills-filter-status', class: 'input text-sm w-auto',
          onchange: (e) => { state.billsFilterStatus = e.target.value; refreshBillsList().then(render); },
        },
          h('option', { value: '', selected: !state.billsFilterStatus ? 'selected' : null }, 'All statuses'),
          h('option', { value: 'draft', selected: state.billsFilterStatus === 'draft' ? 'selected' : null }, 'Draft'),
          h('option', { value: 'closed', selected: state.billsFilterStatus === 'closed' ? 'selected' : null }, 'Closed'),
        ),
        h('div', { class: 'text-sm text-slate-400 ml-2' },
          `${state.bills.length} bill${state.bills.length === 1 ? '' : 's'}`),
        h('button', { id: 'bill-new-btn', class: 'btn btn-primary text-sm ml-auto', onclick: () => { state.billNewOpen = true; render(); } },
          h('i', { class: 'fas fa-plus' }), 'New bill')
      ),
      h('div', { class: 'card overflow-hidden' },
        h('table', { class: 'w-full text-sm' },
          h('thead', { class: 'bg-slate-900/50 text-xs uppercase text-slate-400' },
            h('tr', {},
              h('th', { class: 'text-left px-4 py-3' }, 'Vendor'),
              h('th', { class: 'text-left px-4 py-3' }, 'Invoice #'),
              h('th', { class: 'text-left px-4 py-3' }, 'Type'),
              h('th', { class: 'text-left px-4 py-3' }, 'Status'),
              h('th', { class: 'text-right px-4 py-3' }, 'Units'),
              h('th', { class: 'text-right px-4 py-3' }, 'Declared'),
              h('th', { class: 'text-right px-4 py-3' }, 'GBP total'),
              h('th', { class: 'text-right px-4 py-3' }, '')
            )
          ),
          h('tbody', { class: 'divide-y divide-slate-800' },
            !state.bills.length
              ? h('tr', {}, h('td', { colspan: 8, class: 'text-center py-10 text-slate-500' },
                  'No bills yet — create one to start recording a purchase or repair invoice.'))
              : state.bills.map(b => h('tr', { class: 'row-strip bill-row', 'data-bill-id': b.id },
                  h('td', { class: 'px-4 py-2 font-medium' }, b.vendor_name),
                  h('td', { class: 'px-4 py-2 mono text-xs text-cyan-300' }, b.invoice_number),
                  h('td', { class: 'px-4 py-2' }, billTypeBadge(b.bill_type)),
                  h('td', { class: 'px-4 py-2' }, billStatusBadge(b.status)),
                  h('td', { class: 'px-4 py-2 text-right mono' }, b.unit_count),
                  h('td', { class: 'px-4 py-2 text-right mono text-xs' }, fmtMoney(b.declared_total, b.currency_code)),
                  h('td', { class: 'px-4 py-2 text-right mono text-xs' }, b.gbp_total != null ? fmtMoney(b.gbp_total, 'GBP') : '—'),
                  h('td', { class: 'px-4 py-2 text-right' },
                    h('button', {
                      class: 'btn btn-ghost text-xs bill-open-btn',
                      onclick: () => { state.billId = b.id; refreshBillDetail().then(render); },
                    }, h('i', { class: 'fas fa-folder-open' }), 'Open'))
                ))
          )
        )
      )
    );
  }

  // ─── New bill modal — header fields + per-IMEI rows ───
  function BillNewModal() {
    const f = {
      bill_type: 'purchase', vendor_name: '', bill_date: new Date().toISOString().slice(0, 10),
      invoice_number: '', currency_code: 'GBP', exchange_rate: '', rate_date: '', rate_source: 'manual',
      price_source: 'per_imei', declared_total: '', unit_count: '',
      rowsText: '', // one row per line: sku,description,imei,unit_price
    };
    const close = () => { state.billNewOpen = false; render(); };
    let bodyWrap;
    const isGbp = () => f.currency_code.trim().toUpperCase() === 'GBP';

    function parseRows(text) {
      // sku,description,imei,unit_price — one per line. Blank sku+
      // description+unit_price with a non-blank imei is a valid
      // continuation row per billBuilder.ts's documented pick-and-note
      // rule; the builder handles grouping server-side, this is just a
      // thin CSV-ish parse.
      return text.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
        const [sku, description, imei, unit_price] = line.split(',').map(s => (s ?? '').trim());
        return {
          sku: sku || null,
          description: description || null,
          imei: imei || null,
          unit_price: unit_price !== '' && unit_price != null ? Number(unit_price) : null,
        };
      });
    }

    const doCreate = async () => {
      if (state.billBusy) return;
      if (!f.vendor_name.trim()) { toast('Vendor name is required', 'warn'); return; }
      if (!f.invoice_number.trim()) { toast('Invoice number is required', 'warn'); return; }
      if (!isGbp() && !(Number(f.exchange_rate) > 0)) { toast('exchange_rate is required and must be positive for a non-GBP bill', 'warn'); return; }
      const declaredTotal = Number(f.declared_total);
      if (!Number.isFinite(declaredTotal) || declaredTotal < 0) { toast('Declared total must be a non-negative number', 'warn'); return; }
      const unitCount = Number(f.unit_count);
      if (!Number.isFinite(unitCount) || unitCount < 0) { toast('Unit count must be a non-negative number', 'warn'); return; }

      const body = {
        bill_type: f.bill_type,
        vendor_name: f.vendor_name.trim(),
        bill_date: f.bill_date,
        invoice_number: f.invoice_number.trim(),
        currency_code: f.currency_code.trim().toUpperCase(),
        price_source: f.price_source,
        declared_total: declaredTotal,
        unit_count: unitCount,
      };
      if (!isGbp()) {
        body.exchange_rate = Number(f.exchange_rate);
        if (f.rate_date) body.rate_date = f.rate_date;
        body.rate_source = f.rate_source;
      } else if (f.rate_source) {
        body.rate_source = f.rate_source;
      }
      if (f.price_source !== 'header') {
        body.rows = parseRows(f.rowsText);
      }

      state.billBusy = true; render();
      try {
        const r = await api.post('/bills', body);
        if (r.dropped_non_imei_rows) toast(`${r.dropped_non_imei_rows} row(s) dropped (no usable IMEI)`, 'warn', 4000);
        if (r.cross_bill_duplicate_imeis && r.cross_bill_duplicate_imeis.length) {
          toast(`${r.cross_bill_duplicate_imeis.length} IMEI(s) already appear on another bill — flagged for manager review`, 'warn', 5000);
        }
        toast(`Bill <span class="mono">${body.invoice_number}</span> created — GBP total ${fmtMoney(r.gbp_total, 'GBP')}`, 'ok');
        state.billNewOpen = false;
        state.billId = r.bill_id;
        await refreshBillsList();
        await refreshBillDetail();
        render();
      } catch (err) {
        const data = err.response?.data;
        if (data?.within_bill_duplicate_imeis?.length) {
          toast(`Rejected — duplicate IMEI(s) within this bill: ${data.within_bill_duplicate_imeis.join(', ')}`, 'err', 6000);
        } else {
          toast(data?.error || err.message, 'err', 5000);
        }
      } finally {
        state.billBusy = false; render();
      }
    };

    const fields = () => h('div', { class: 'space-y-3' },
      h('div', { class: 'grid grid-cols-2 gap-3' },
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Bill type'),
          h('select', { id: 'bill-new-type', class: 'input', onchange: (e) => { f.bill_type = e.target.value; } },
            h('option', { value: 'purchase', selected: f.bill_type === 'purchase' ? 'selected' : null }, 'Purchase'),
            h('option', { value: 'repair', selected: f.bill_type === 'repair' ? 'selected' : null }, 'Repair'))
        ),
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Pricing mode'),
          h('select', { id: 'bill-new-price-source', class: 'input', onchange: (e) => { f.price_source = e.target.value; bodyWrap.replaceChildren(fields()); } },
            h('option', { value: 'per_imei', selected: f.price_source === 'per_imei' ? 'selected' : null }, 'Per-IMEI (one price per device)'),
            h('option', { value: 'per_line', selected: f.price_source === 'per_line' ? 'selected' : null }, 'Per-line (priced groups)'),
            h('option', { value: 'header', selected: f.price_source === 'header' ? 'selected' : null }, 'Header only (no breakdown)'))
        )
      ),
      h('div', { class: 'grid grid-cols-2 gap-3' },
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Vendor *'),
          h('input', { id: 'bill-new-vendor', class: 'input', placeholder: 'LW001', value: f.vendor_name,
            oninput: (e) => { f.vendor_name = e.target.value; } })
        ),
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Invoice number *'),
          h('input', { id: 'bill-new-invoice', class: 'input mono', placeholder: 'INV-2026-001', value: f.invoice_number,
            oninput: (e) => { f.invoice_number = e.target.value; } })
        )
      ),
      h('div', {},
        h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Bill date'),
        h('input', { id: 'bill-new-date', class: 'input mono', type: 'date', value: f.bill_date,
          oninput: (e) => { f.bill_date = e.target.value; } })
      ),
      h('div', { class: 'grid grid-cols-3 gap-3' },
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Currency'),
          h('select', { id: 'bill-new-currency', class: 'input mono', onchange: (e) => { f.currency_code = e.target.value; bodyWrap.replaceChildren(fields()); } },
            h('option', { value: 'GBP', selected: f.currency_code === 'GBP' ? 'selected' : null }, 'GBP'),
            h('option', { value: 'USD', selected: f.currency_code === 'USD' ? 'selected' : null }, 'USD'),
            h('option', { value: 'AED', selected: f.currency_code === 'AED' ? 'selected' : null }, 'AED'))
        ),
        !isGbp() ? h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Exchange rate *'),
          h('input', { id: 'bill-new-exrate', class: 'input mono', type: 'number', step: '0.0001', placeholder: 'e.g. 1.29 (foreign units per £1)',
            value: f.exchange_rate, oninput: (e) => { f.exchange_rate = e.target.value; } })
        ) : null,
        !isGbp() ? h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Rate date'),
          h('input', { id: 'bill-new-ratedate', class: 'input mono', type: 'date', value: f.rate_date,
            oninput: (e) => { f.rate_date = e.target.value; } })
        ) : null
      ),
      h('div', {},
        h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Rate source'),
        h('select', { id: 'bill-new-ratesource', class: 'input', onchange: (e) => { f.rate_source = e.target.value; } },
          h('option', { value: 'manual', selected: f.rate_source === 'manual' ? 'selected' : null }, 'Manual'),
          h('option', { value: 'zoho', selected: f.rate_source === 'zoho' ? 'selected' : null }, 'Zoho'),
          h('option', { value: 'hmrc_monthly', selected: f.rate_source === 'hmrc_monthly' ? 'selected' : null }, 'HMRC monthly'))
      ),
      h('div', { class: 'grid grid-cols-2 gap-3' },
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Declared total *'),
          h('input', { id: 'bill-new-declared', class: 'input mono', type: 'number', step: '0.01', placeholder: '39386.00',
            value: f.declared_total, oninput: (e) => { f.declared_total = e.target.value; } })
        ),
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Unit count *'),
          h('input', { id: 'bill-new-unitcount', class: 'input mono', type: 'number', step: '1', placeholder: '162',
            value: f.unit_count, oninput: (e) => { f.unit_count = e.target.value; } })
        )
      ),
      f.price_source !== 'header' ? h('div', {},
        h('label', { class: 'text-xs text-slate-400 mb-1 block' },
          'Lines — one per row: sku,description,imei,unit_price'),
        h('textarea', {
          id: 'bill-new-rows', class: 'input mono text-xs', rows: 6,
          placeholder: 'APL-I17-256-BLK-A,iPhone 17 256GB Black A,356965410000001,160.00\nAPL-I17-256-BLK-A,iPhone 17 256GB Black A,356965410000018,182.00',
          value: f.rowsText, oninput: (e) => { f.rowsText = e.target.value; },
        }),
        h('p', { class: 'text-[11px] text-slate-500 mt-1' },
          'A row with blank sku/description/unit_price but a non-blank IMEI is treated as a continuation of the row above it (same price, extra serial) — the same rule billBuilder.ts documents.')
      ) : h('p', { class: 'text-[11px] text-slate-500' },
        'Header-only mode: one implicit line covering the whole declared total, no serials attached.')
    );
    bodyWrap = h('div', {}, fields());
    return h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target.classList.contains('modal-backdrop')) close(); } },
      h('div', { class: 'modal p-6 max-w-xl' },
        h('div', { class: 'flex items-center gap-3 mb-4' },
          h('div', { class: 'w-10 h-10 rounded-xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center' },
            h('i', { class: 'fas fa-file-invoice-dollar' })),
          h('div', {},
            h('h2', { class: 'text-lg font-semibold' }, 'New bill'),
            h('p', { class: 'text-xs text-slate-500' }, 'Purchase or repair — one builder, bill_type selects only the downstream cost_ledger type.'))
        ),
        bodyWrap,
        h('div', { class: 'mt-5 flex justify-end gap-2' },
          h('button', { class: 'btn btn-ghost', onclick: close }, 'Cancel'),
          h('button', {
            id: 'bill-new-create-btn', class: 'btn btn-primary' + (state.billBusy ? ' opacity-60 cursor-not-allowed' : ''),
            onclick: doCreate, disabled: state.billBusy ? 'disabled' : null,
          }, state.billBusy ? [h('i', { class: 'fas fa-spinner fa-spin' }), 'Creating…'] : [h('i', { class: 'fas fa-check' }), 'Create bill'])
        )
      )
    );
  }

  // ─── Bill detail — reconciliation + close/force-close ───
  async function doCloseBill(billId) {
    if (state.billBusy) return;
    state.billBusy = true; render();
    try {
      await api.post(`/bills/${billId}/close`, {});
      toast('Bill closed', 'ok');
      await refreshBillsList();
      await refreshBillDetail();
      render();
    } catch (err) {
      const data = err.response?.data;
      if (data?.code === 'bill_unbalanced') {
        toast(`Cannot close — variance £${Number(data.variance_gbp).toFixed(2)}. Use Force-close with a reason to override.`, 'warn', 6000);
      } else {
        toast(data?.error || err.message, 'err', 5000);
      }
    } finally {
      state.billBusy = false; render();
    }
  }
  async function doWriteCostLedger(billId) {
    if (state.billBusy) return;
    state.billBusy = true; render();
    try {
      const r = await api.post(`/bills/${billId}/write-cost-ledger`, {});
      toast(`${r.posted} cost_ledger row(s) posted${r.skipped_already_posted ? `, ${r.skipped_already_posted} already posted (skipped)` : ''}`, 'ok', 4000);
      await refreshBillDetail();
      render();
    } catch (err) {
      toast(err.response?.data?.error || err.message, 'err', 5000);
    } finally {
      state.billBusy = false; render();
    }
  }
  function BillForceCloseModal() {
    const ctx = { reason: '' };
    const billId = state.billForceCloseOpen;
    const close = () => { state.billForceCloseOpen = false; render(); };
    const submit = async () => {
      if (!ctx.reason.trim()) { toast('A reason is required to force-close an unbalanced bill', 'warn'); return; }
      if (state.billBusy) return;
      state.billBusy = true; render();
      try {
        const r = await api.post(`/bills/${billId}/force-close`, { reason: ctx.reason.trim() });
        toast(`Force-closed — variance £${Number(r.variance_gbp).toFixed(2)} recorded against your account`, 'warn', 5000);
        state.billForceCloseOpen = false;
        await refreshBillsList();
        await refreshBillDetail();
        render();
      } catch (err) {
        toast(err.response?.data?.error || err.message, 'err', 5000);
      } finally {
        state.billBusy = false; render();
      }
    };
    return h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target.classList.contains('modal-backdrop')) close(); } },
      h('div', { class: 'modal p-6 max-w-md' },
        h('div', { class: 'flex items-center gap-3 mb-4' },
          h('div', { class: 'w-10 h-10 rounded-xl bg-red-500/10 text-red-400 flex items-center justify-center' },
            h('i', { class: 'fas fa-triangle-exclamation' })),
          h('div', {},
            h('h2', { class: 'text-lg font-semibold' }, 'Force-close unbalanced bill'),
            h('p', { class: 'text-xs text-slate-500' }, 'Writes an append-only override recording the variance, this reason, and your user.'))
        ),
        h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Reason *'),
        h('textarea', {
          id: 'bill-force-close-reason', class: 'input text-sm', rows: 3, autofocus: 'true',
          placeholder: 'e.g. Owner confirmed £999 declared total was a typo; lines are correct',
          oninput: (e) => { ctx.reason = e.target.value; },
        }),
        h('div', { class: 'mt-4 flex justify-end gap-2' },
          h('button', { class: 'btn btn-ghost', onclick: close }, 'Cancel'),
          h('button', {
            id: 'bill-force-close-submit', class: 'btn text-sm !bg-red-600/20 !text-red-300' + (state.billBusy ? ' opacity-60 cursor-not-allowed' : ''),
            onclick: submit, disabled: state.billBusy ? 'disabled' : null,
          }, h('i', { class: 'fas fa-triangle-exclamation' }), 'Force-close')
        )
      )
    );
  }
  function BillDetailView() {
    const d = state.billDetail;
    if (!d) return h('div', { class: 'text-slate-500 text-sm' }, 'Loading…');
    const bill = d.bill;
    const lines = d.lines || [];
    const overrides = d.close_overrides || [];
    const serials = d.serials || [];
    const serialsByLine = {};
    serials.forEach(s => { (serialsByLine[s.bill_line_id] = serialsByLine[s.bill_line_id] || []).push(s); });

    // Reconciliation: sum(lines) vs declared_total_gbp — the actual §1
    // close-rule comparison (NOT vs gbp_total, which is itself the sum of
    // lines and would make this display circular/meaningless).
    //
    // NAMED PROCESS SMELL — "vacuous same-side reconciliation": a
    // 'header'-mode bill (src/lib/billBuilder.ts) has exactly ONE synthetic
    // bill_lines row whose unit_price_gbp is DERIVED FROM declared_total.
    // sumLines therefore equals declaredTotalGbp BY CONSTRUCTION — this is
    // not "a different question answered correctly", it is arithmetically
    // incapable of returning anything but Balanced. Same shape as the
    // historical c5e5f25 circular gbp_total defect, reproduced here in the
    // display layer (3rd occurrence of this smell in this build — see
    // test/browser/README.md Process Notes). Any reconciliation where one
    // side is derived from the other is vacuous and MUST NOT render a
    // verdict. Two-armed gate below: price_source === 'header' covers the
    // real cause; lines.length === 0 is a defensive second arm for the
    // opposite-direction case (a per-line/per-imei bill that somehow has
    // no real lines yet) — it costs nothing and closes that false-green too.
    const vacuousSameDocCheck = bill.price_source === 'header' || lines.length === 0;
    const sumLines = Math.round(lines.reduce((s, l) => s + (l.unit_price_gbp || 0), 0) * 100) / 100;
    const declaredTotalGbp = bill.declared_total_gbp;
    const variance = declaredTotalGbp != null ? Math.round((sumLines - declaredTotalGbp) * 100) / 100 : null;
    // `balanced` stays the REAL arithmetic result (variance === 0) — it
    // still drives whether the normal Close button's own server-side check
    // will succeed and whether Force-close is offered. Gating only the
    // BADGE/verdict text (below) would leave Force-close wrongly offered
    // on every header-mode bill (they are always mathematically balanced
    // by construction, so normal Close always succeeds — there is nothing
    // to force). Only the DISPLAYED verdict is suppressed when vacuous.
    const balanced = variance === 0;
    // Manifest-linked branch delegates to the SAME badge/verdict function
    // the Receive view uses (ManifestBillReconciliationBadge) rather than
    // duplicating comparison logic — one badge, one code path.
    const manifestLinked = d.linked_manifest_id != null;

    return h('div', { class: 'space-y-5' },
      h('div', { class: 'flex items-center justify-between flex-wrap gap-3' },
        h('button', { id: 'bill-back-btn', class: 'btn btn-ghost text-sm', onclick: () => { state.billId = null; state.billDetail = null; render(); } },
          h('i', { class: 'fas fa-arrow-left' }), 'Back to bills'),
        h('div', { class: 'flex items-center gap-2' },
          billTypeBadge(bill.bill_type), billStatusBadge(bill.status)
        )
      ),
      h('div', { class: 'card p-5' },
        h('div', { class: 'grid grid-cols-2 md:grid-cols-4 gap-4 text-sm' },
          h('div', {}, h('div', { class: 'text-xs text-slate-500' }, 'Vendor'), h('div', { class: 'font-semibold' }, bill.vendor_name)),
          h('div', {}, h('div', { class: 'text-xs text-slate-500' }, 'Invoice #'), h('div', { class: 'mono text-cyan-300' }, bill.invoice_number)),
          h('div', {}, h('div', { class: 'text-xs text-slate-500' }, 'Bill date'), h('div', {}, bill.bill_date)),
          h('div', {}, h('div', { class: 'text-xs text-slate-500' }, 'Currency'), h('div', { class: 'mono' }, bill.currency_code)),
          bill.currency_code !== 'GBP' ? h('div', {}, h('div', { class: 'text-xs text-slate-500' }, 'Exchange rate'), h('div', { class: 'mono' }, bill.exchange_rate)) : null,
          bill.currency_code !== 'GBP' ? h('div', {}, h('div', { class: 'text-xs text-slate-500' }, 'Rate date'), h('div', {}, bill.rate_date || '—')) : null,
          h('div', {}, h('div', { class: 'text-xs text-slate-500' }, 'Rate source'), h('div', {}, bill.rate_source || '—')),
          h('div', {}, h('div', { class: 'text-xs text-slate-500' }, 'Pricing mode'), h('div', {}, bill.price_source)),
          h('div', {}, h('div', { class: 'text-xs text-slate-500' }, 'Unit count'), h('div', { class: 'mono' }, bill.unit_count)),
        )
      ),
      // ── Reconciliation panel: sum(lines) vs declared_total_gbp ──
      h('div', { id: 'bill-reconciliation', class: 'card p-5' },
        h('h3', { class: 'text-sm font-semibold mb-3 flex items-center gap-2' },
          h('i', { class: 'fas fa-scale-balanced' }), 'Reconciliation'),
        h('div', { class: 'grid grid-cols-2 md:grid-cols-4 gap-4 text-sm' },
          h('div', {}, h('div', { class: 'text-xs text-slate-500' }, 'Declared total'), h('div', { class: 'mono' }, fmtMoney(bill.declared_total, bill.currency_code))),
          h('div', {}, h('div', { class: 'text-xs text-slate-500' }, 'Declared total (GBP)'), h('div', { id: 'bill-declared-total-gbp', class: 'mono' }, declaredTotalGbp != null ? fmtMoney(declaredTotalGbp, 'GBP') : '—')),
          h('div', {}, h('div', { class: 'text-xs text-slate-500' }, 'Sum of lines (GBP)'), h('div', { id: 'bill-sum-lines-gbp', class: 'mono' }, fmtMoney(sumLines, 'GBP'))),
          h('div', {}, h('div', { class: 'text-xs text-slate-500' }, 'gbp_total (stored)'), h('div', { class: 'mono' }, bill.gbp_total != null ? fmtMoney(bill.gbp_total, 'GBP') : '—')),
        ),
        bill.header_residual_gbp != null ? h('div', { class: 'text-xs text-slate-500 mt-2' },
          `Header residual: ${fmtMoney(bill.header_residual_gbp, 'GBP')} (independent per-line rounding vs. direct header conversion — never apportioned across lines)`) : null,
        // Vacuous same-document check (header-mode / zero real lines):
        // never render a same-document Balanced/Variance verdict here —
        // it is arithmetically incapable of being anything else. Delegate
        // to the manifest↔bill reconciliation (a genuinely independent
        // comparison) when a manifest is linked; otherwise show a neutral
        // "not applicable" state — never green, never a fabricated verdict.
        h('div', { id: 'bill-variance-indicator', class: 'mt-3 flex flex-col items-start gap-2' },
          vacuousSameDocCheck
            ? (manifestLinked
                ? ManifestBillReconciliationBadge(d.bill_reconciliation)
                : h('span', { class: 'badge badge-slate' }, h('i', { class: 'fas fa-ban mr-1' }),
                    'UNPRICED — NO LINE DETAIL; RECONCILIATION NOT APPLICABLE'))
            : (variance == null ? h('span', { class: 'badge badge-slate' }, 'No declared_total_gbp yet')
                : balanced ? h('span', { class: 'badge badge-green' }, h('i', { class: 'fas fa-check mr-1' }), 'Balanced — sum(lines) = declared total')
                : h('span', { class: 'badge badge-red' }, h('i', { class: 'fas fa-triangle-exclamation mr-1' }), `Variance: ${fmtMoney(variance, 'GBP')}`))
        ),
        h('div', { class: 'mt-4 flex items-center gap-2 flex-wrap' },
          bill.status === 'draft' ? h('button', {
            id: 'bill-close-btn', class: 'btn btn-primary text-sm' + (state.billBusy ? ' opacity-60 cursor-not-allowed' : ''),
            onclick: () => doCloseBill(bill.id), disabled: state.billBusy ? 'disabled' : null,
          }, h('i', { class: 'fas fa-lock' }), 'Close') : null,
          bill.status === 'draft' && !balanced ? h('button', {
            id: 'bill-force-close-btn', class: 'btn text-sm !bg-red-600/20 !text-red-300',
            onclick: () => { state.billForceCloseOpen = bill.id; render(); },
          }, h('i', { class: 'fas fa-triangle-exclamation' }), 'Force-close…') : null,
          bill.status === 'closed' ? h('button', {
            id: 'bill-write-ledger-btn', class: 'btn btn-ghost text-sm' + (state.billBusy ? ' opacity-60 cursor-not-allowed' : ''),
            onclick: () => doWriteCostLedger(bill.id), disabled: state.billBusy ? 'disabled' : null,
            title: 'Write one cost_ledger row per serial resolved to a received device',
          }, h('i', { class: 'fas fa-book' }), 'Write cost ledger') : null,
        )
      ),
      // ── Force-close overrides (append-only) ──
      overrides.length ? h('div', { id: 'bill-close-overrides', class: 'card p-5' },
        h('h3', { class: 'text-sm font-semibold mb-3 flex items-center gap-2' },
          h('i', { class: 'fas fa-clock-rotate-left' }), 'Force-close history (append-only)'),
        h('div', { class: 'space-y-2' },
          overrides.map(o => h('div', { class: 'text-xs border-l-2 border-red-500/40 pl-3 py-1' },
            h('div', { class: 'flex items-center gap-2' },
              h('span', { class: 'badge badge-red' }, `variance ${fmtMoney(o.variance_gbp, 'GBP')}`),
              h('span', { class: 'text-slate-500' }, fmtDate(o.overridden_at)),
              h('span', { class: 'text-slate-500' }, 'by'),
              h('span', { class: 'text-slate-300' }, o.overridden_by_name || o.overridden_by_email || `user #${o.overridden_by_user_id}`)
            ),
            h('div', { class: 'text-slate-400 mt-1' }, o.reason)
          ))
        )
      ) : null,
      // ── Lines table ──
      h('div', { class: 'card overflow-hidden' },
        h('table', { class: 'w-full text-sm' },
          h('thead', { class: 'bg-slate-900/50 text-xs uppercase text-slate-400' },
            h('tr', {},
              h('th', { class: 'text-left px-4 py-3' }, 'Line'),
              h('th', { class: 'text-left px-4 py-3' }, 'SKU / description'),
              h('th', { class: 'text-right px-4 py-3' }, 'Qty'),
              h('th', { class: 'text-right px-4 py-3' }, 'Unit price'),
              h('th', { class: 'text-right px-4 py-3' }, 'Unit price (GBP)'),
              h('th', { class: 'text-left px-4 py-3' }, 'IMEIs'),
            )
          ),
          h('tbody', { class: 'divide-y divide-slate-800' },
            !lines.length
              ? h('tr', {}, h('td', { colspan: 6, class: 'text-center py-10 text-slate-500' }, 'No lines on this bill.'))
              : lines.map(l => h('tr', { class: 'row-strip' },
                  h('td', { class: 'px-4 py-2 mono text-xs' }, l.line_no),
                  h('td', { class: 'px-4 py-2 text-xs' },
                    h('div', { class: 'font-medium text-cyan-300 mono' }, l.sku || '—'),
                    h('div', { class: 'text-slate-500' }, l.description || '—')),
                  h('td', { class: 'px-4 py-2 text-right mono' }, l.quantity),
                  h('td', { class: 'px-4 py-2 text-right mono text-xs' }, l.unit_price != null ? Number(l.unit_price).toFixed(2) : '—'),
                  h('td', { class: 'px-4 py-2 text-right mono text-xs' }, l.unit_price_gbp != null ? fmtMoney(l.unit_price_gbp, 'GBP') : '—'),
                  h('td', { class: 'px-4 py-2 text-xs mono text-slate-400' },
                    (serialsByLine[l.id] || []).map(s => s.imei).join(', ') || '—'),
                ))
          )
        )
      )
    );
  }

  function OprView() {
    const TabBtn = (id, label, icon) => h('button', {
      class: 'btn text-sm ' + (state.oprTab === id ? 'btn-primary' : 'btn-ghost'),
      onclick: () => {
        state.oprTab = id;
        (id === 'discharge' ? refreshOprDischarge() : Promise.resolve()).then(render);
      },
    }, h('i', { class: `fas fa-${icon}` }), label);
    return h('div', { class: 'space-y-5' },
      h('div', { class: 'flex items-center justify-between flex-wrap gap-3' },
        h('div', {},
          h('h1', { class: 'text-2xl font-bold' }, 'Outward Processing Relief'),
          h('p', { class: 'text-slate-400 text-sm' }, 'Export consignments to overseas repairers and their duty-relieved returns.')
        ),
        h('div', { class: 'flex items-center gap-2' },
          TabBtn('shipments', 'Consignments', 'boxes-stacked'),
          TabBtn('discharge', 'Discharge tracker', 'clipboard-check'),
        )
      ),
      state.oprTab === 'discharge' ? OprDischargeView()
        : state.oprShipmentId ? OprShipmentDetail()
        : OprShipmentsList()
    );
  }

  // ─── Consignment list ───
  function OprShipmentsList() {
    return h('div', { class: 'space-y-4' },
      h('div', { class: 'flex items-center justify-between' },
        h('div', { class: 'text-sm text-slate-400' },
          `${state.oprShipments.length} consignment${state.oprShipments.length === 1 ? '' : 's'}`),
        h('button', { id: 'opr-new-btn', class: 'btn btn-primary text-sm', onclick: () => { state.oprNewOpen = true; render(); } },
          h('i', { class: 'fas fa-plus' }), 'New consignment')
      ),
      h('div', { class: 'card overflow-hidden' },
        h('table', { class: 'w-full text-sm' },
          h('thead', { class: 'bg-slate-900/50 text-xs uppercase text-slate-400' },
            h('tr', {},
              h('th', { class: 'text-left px-4 py-3' }, 'Reference'),
              h('th', { class: 'text-left px-4 py-3' }, 'Direction'),
              h('th', { class: 'text-left px-4 py-3' }, 'Status'),
              h('th', { class: 'text-left px-4 py-3' }, 'Procedure'),
              h('th', { class: 'text-right px-4 py-3' }, 'Devices'),
              h('th', { class: 'text-right px-4 py-3' }, 'Value'),
              h('th', { class: 'text-left px-4 py-3' }, 'MRN'),
              h('th', { class: 'text-right px-4 py-3' }, '')
            )
          ),
          h('tbody', { class: 'divide-y divide-slate-800' },
            !state.oprShipments.length
              ? h('tr', {}, h('td', { colspan: 8, class: 'text-center py-10 text-slate-500' },
                  'No OPR consignments yet — create one to start scanning devices out for repair.'))
              : state.oprShipments.map(s => h('tr', { class: 'row-strip' },
                  h('td', { class: 'px-4 py-2 mono text-cyan-300 font-semibold' }, s.reference),
                  h('td', { class: 'px-4 py-2' }, oprDirBadge(s.direction)),
                  h('td', { class: 'px-4 py-2' }, oprStatusBadge(s.status)),
                  h('td', { class: 'px-4 py-2 mono text-xs' + (s.procedure_code ? '' : ' text-slate-500') },
                    // TEMP_EXPORT_STANDARD carries no procedure code (customs-only field) —
                    // render the neutral "no customs declaration" label, not a literal "null".
                    s.procedure_code
                      ? s.procedure_code + (s.additional_procedure_code ? ' + ' + s.additional_procedure_code : '')
                      : 'n/a — no customs declaration'),
                  h('td', { class: 'px-4 py-2 text-right mono' }, s.line_count),
                  h('td', { class: 'px-4 py-2 text-right mono text-xs' }, fmtMoney(s.total_value, s.currency)),
                  h('td', { class: 'px-4 py-2 mono text-xs text-slate-400' },
                    s.direction === 'import' ? (s.import_mrn || '—') : (s.export_mrn || '—')),
                  h('td', { class: 'px-4 py-2 text-right' },
                    h('button', {
                      class: 'btn btn-ghost text-xs opr-open-btn',
                      onclick: () => { state.oprShipmentId = s.id; refreshOprDetail().then(render); },
                    }, h('i', { class: 'fas fa-folder-open' }), 'Open'))
                ))
          )
        )
      )
    );
  }

  // ─── New consignment modal ───
  function OprNewShipmentModal() {
    const f = { direction: 'export', shipment_type: 'OPR_REPAIR', reference: '', authorisation_id: state.oprAuths[0]?.id || '',
                procedure_code: '2100', additional_procedure_code: '', consignee_name: '',
                related_export_shipment_id: '', ship_date: '' };
    const close = () => { state.oprNewOpen = false; render(); };
    // A return can only usefully link to a FINALISED export of the SAME
    // shipment_type — the backend has no such cross-check at creation
    // time (link is accepted regardless), but scanning a device onto a
    // mismatched return always 409s (the device's post-export status
    // never matches what that return's shipment_type expects), so a
    // cross-type link is a guaranteed dead end. Filtering it out of the
    // picker avoids walking into that dead end. (Pick-and-note: a
    // same-shipment_type guard at creation, mirroring the direction
    // check already there, would be the tidier backend fix — left as a
    // UI-side filter for this sprint, matching the scope of "screens".)
    const finalisedExports = () => state.oprShipments.filter(s =>
      s.direction === 'export' && s.status === 'FINALISED' && s.shipment_type === f.shipment_type);
    const doCreate = async () => {
      const isStandardTemp = f.shipment_type === 'TEMP_EXPORT_STANDARD';
      const body = {
        direction: f.direction,
        shipment_type: f.shipment_type,
        reference: f.reference.trim(),
      };
      // authorisation_id / procedure_code are customs-only fields, 422-rejected
      // by the backend on a TEMP_EXPORT_STANDARD shipment — omit entirely.
      if (!isStandardTemp) {
        body.authorisation_id = Number(f.authorisation_id) || null;
        body.procedure_code = f.direction === 'import' ? '6121' : f.procedure_code;
        if (f.direction === 'export' && f.additional_procedure_code) body.additional_procedure_code = f.additional_procedure_code;
      }
      if (f.consignee_name.trim()) body.consignee_name = f.consignee_name.trim();
      if (f.ship_date) body.ship_date = f.ship_date;
      if (f.direction === 'import' && f.related_export_shipment_id) {
        body.related_export_shipment_id = Number(f.related_export_shipment_id);
      }
      try {
        const r = await api.post('/opr/shipments', body);
        toast(`Consignment <span class="mono">${r.shipment.reference}</span> created`, 'ok');
        state.oprNewOpen = false;
        state.oprShipmentId = r.shipment.id;
        await refreshOprShipments();
        await refreshOprDetail();
        render();
      } catch (err) {
        toast(err.response?.data?.error || err.message, 'err', 5000);
      }
    };
    // Local re-render of the modal body on direction flip (keeps field state in f)
    let bodyWrap;
    const isStandardTemp = () => f.shipment_type === 'TEMP_EXPORT_STANDARD';
    const fields = () => h('div', { class: 'space-y-3' },
      h('div', { class: 'grid grid-cols-2 gap-3' },
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Direction'),
          h('select', { id: 'opr-new-direction', class: 'input', onchange: (e) => { f.direction = e.target.value; bodyWrap.replaceChildren(fields()); } },
            h('option', { value: 'export', selected: f.direction === 'export' ? 'selected' : null }, 'Export (send for repair)'),
            h('option', { value: 'import', selected: f.direction === 'import' ? 'selected' : null }, 'Import (return from repair)'))
        ),
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Shipment type'),
          h('select', { id: 'opr-new-shipment-type', class: 'input', onchange: (e) => { f.shipment_type = e.target.value; bodyWrap.replaceChildren(fields()); } },
            h('option', { value: 'OPR_REPAIR', selected: f.shipment_type === 'OPR_REPAIR' ? 'selected' : null }, 'OPR_REPAIR — customs outward processing'),
            h('option', { value: 'TEMP_EXPORT_STANDARD', selected: f.shipment_type === 'TEMP_EXPORT_STANDARD' ? 'selected' : null }, 'TEMP_EXPORT_STANDARD — no customs declaration'))
        )
      ),
      h('div', {},
        h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Reference *'),
        h('input', { id: 'opr-new-reference', class: 'input mono', placeholder: f.direction === 'export' ? 'EXP 2026 001' : 'IMP 2026 001',
          value: f.reference, oninput: (e) => { f.reference = e.target.value; } })
      ),
      // Authorisation and procedure-code fields are customs-only — TEMP_EXPORT_STANDARD
      // has no customs declaration at all, and the backend 422-rejects these fields
      // for that shipment_type, so they're omitted from the form entirely (not just
      // disabled) rather than shown greyed-out.
      isStandardTemp() ? null : h('div', {},
        h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'OPR authorisation *'),
        h('select', { class: 'input', onchange: (e) => { f.authorisation_id = e.target.value; } },
          state.oprAuths.map(a => h('option', { value: a.id, selected: String(f.authorisation_id) === String(a.id) ? 'selected' : null },
            `${a.holder_name} — ${a.cds_number}`)),
          !state.oprAuths.length ? h('option', { value: '' }, 'No authorisations — create one via the API first') : null)
      ),
      isStandardTemp() ? null : (f.direction === 'export' ? h('div', { class: 'grid grid-cols-2 gap-3' },
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Procedure code'),
          h('select', { class: 'input mono', onchange: (e) => { f.procedure_code = e.target.value; } },
            h('option', { value: '2100', selected: f.procedure_code === '2100' ? 'selected' : null }, '2100 — outward processing'),
            h('option', { value: '2200', selected: f.procedure_code === '2200' ? 'selected' : null }, '2200 — OP (warranty et al.)'))
        ),
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Additional procedure'),
          h('select', { class: 'input mono', onchange: (e) => { f.additional_procedure_code = e.target.value; } },
            h('option', { value: '', selected: !f.additional_procedure_code ? 'selected' : null }, '(none)'),
            h('option', { value: 'B02', selected: f.additional_procedure_code === 'B02' ? 'selected' : null }, 'B02 — repair'),
            h('option', { value: 'B51', selected: f.additional_procedure_code === 'B51' ? 'selected' : null }, 'B51 — warranty (pairs with 2200)'))
        )
      ) : null),
      // "Discharges export consignment" applies to both shipment types (a
      // TEMP_EXPORT_STANDARD return still needs to link to its export), but
      // the "fixed at 6121" helper text only applies to OPR_REPAIR imports —
      // TEMP_EXPORT_STANDARD has no procedure code at all.
      f.direction === 'import' ? h('div', {},
        h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Discharges export consignment'),
        h('select', { class: 'input', onchange: (e) => { f.related_export_shipment_id = e.target.value; } },
          h('option', { value: '' }, '(none — link later)'),
          finalisedExports().map(s => h('option', { value: s.id, selected: String(f.related_export_shipment_id) === String(s.id) ? 'selected' : null },
            `${s.reference} (${s.line_count} devices)`))),
        isStandardTemp() ? null : h('p', { class: 'text-[11px] text-slate-500 mt-1' }, 'Import procedure code is fixed at 6121 (re-import after OP repair).')
      ) : null,
      h('div', { class: 'grid grid-cols-2 gap-3' },
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, f.direction === 'export' ? 'Consignee (overseas repairer)' : 'Consignor label (optional)'),
          h('input', { class: 'input', placeholder: 'Shenzhen Repair Co', value: f.consignee_name, oninput: (e) => { f.consignee_name = e.target.value; } })
        ),
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Ship date'),
          h('input', { class: 'input mono', type: 'date', value: f.ship_date, oninput: (e) => { f.ship_date = e.target.value; } })
        )
      )
    );
    bodyWrap = h('div', {}, fields());
    return h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target.classList.contains('modal-backdrop')) close(); } },
      h('div', { class: 'modal p-6 max-w-lg' },
        h('div', { class: 'flex items-center gap-3 mb-4' },
          h('div', { class: 'w-10 h-10 rounded-xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center' },
            h('i', { class: 'fas fa-plane-departure' })),
          h('div', {},
            h('h2', { class: 'text-lg font-semibold' }, 'New OPR consignment'),
            h('p', { class: 'text-xs text-slate-400' }, 'Reference flows onto customs declarations — letters, numbers and spaces only.')
          )
        ),
        bodyWrap,
        h('div', { class: 'flex justify-end gap-2 mt-5' },
          h('button', { class: 'btn btn-ghost text-sm', onclick: close }, 'Cancel'),
          h('button', { id: 'opr-new-create', class: 'btn btn-primary text-sm', onclick: doCreate },
            h('i', { class: 'fas fa-plus' }), 'Create')
        )
      )
    );
  }

  // ─── Shipment detail ───
  function OprShipmentDetail() {
    const b = state.oprBundle;
    if (!b) return h('div', { class: 'card p-8 text-center text-slate-500' }, 'Loading…');
    const s = b.shipment;
    const isDraft = s.status === 'DRAFT';
    const isExport = s.direction === 'export';
    // TEMP_EXPORT_STANDARD has no customs declaration at all — no
    // authorisation, no procedure code, no MRN/DUCR/EAD/MUCR, no C&E1154,
    // no repair-cost/duty arithmetic. Every customs-only block in this
    // screen is gated on this flag rather than removed from the backend
    // (the backend already 422-rejects the fields; this is purely UI
    // decluttering so an operator on this shipment_type never sees a
    // field, button or document that doesn't apply to it).
    const isStandardTemp = s.shipment_type === 'TEMP_EXPORT_STANDARD';
    const v = state.oprValidation;

    const backBtn = h('button', {
      class: 'btn btn-ghost text-xs', id: 'opr-back-btn',
      onclick: () => { state.oprShipmentId = null; state.oprBundle = null; refreshOprShipments().then(render); },
    }, h('i', { class: 'fas fa-arrow-left' }), 'All consignments');

    // scan-to-add box (DRAFT only)
    const doScan = async (imei, inputEl) => {
      const val = (imei || '').trim();
      if (!val) return;
      try {
        await api.post(`/opr/shipments/${s.id}/scan`, { imei: val });
        beep('ok');
        toast(`Added <span class="mono">${val}</span>`, 'ok');
      } catch (err) {
        beep('err');
        toast(err.response?.data?.error || err.message, 'err', 5000);
      }
      if (inputEl) inputEl.value = '';
      await refreshOprDetail(); render();
      setTimeout(() => $('#opr-scan-input')?.focus(), 30);
    };

    const removeLine = async (line) => {
      try {
        await api.del(`/opr/shipments/${s.id}/lines/${line.id}`);
        toast(`Removed <span class="mono">${line.imei}</span>`, 'warn');
        await refreshOprDetail(); render();
      } catch (err) {
        toast(err.response?.data?.error || err.message, 'err', 5000);
      }
    };

    const openDoc = async (path) => {
      try {
        const win = await openWithDocToken(`/api/opr/shipments/${s.id}/${path}`);
        if (!win) toast('Popup blocked — allow popups for this site', 'warn');
      } catch (err) {
        toast(err.response?.data?.error || err.message, 'err', 4000);
      }
    };
    const showDraftDoc = async (kind) => {
      try {
        const r = await api.get(`/opr/shipments/${s.id}/${kind}`);
        state.oprDraftDoc = { kind, data: kind === 'prealert' ? r.prealert : r.clearance, note: r.ce1154_note || null };
        render();
      } catch (err) {
        toast(err.response?.data?.error || err.message, 'err', 5000);
      }
    };
    const sendEmail = async (kind) => {
      if (state.oprBusy) return;
      state.oprBusy = true; render();
      try {
        const r = await api.post(`/opr/shipments/${s.id}/${kind}/send`, {});
        toast(`${kind === 'prealert' ? 'Pre-alert' : 'Clearance instruction'} sent — message ${r.provider_message_id || r.message_id || ''}`, 'ok', 4000);
      } catch (err) {
        const code = err.response?.data?.code;
        toast(
          (code === 'gmail_not_configured' ? '<b>Email not configured.</b> ' : '') +
          (err.response?.data?.error || err.message),
          code === 'gmail_not_configured' ? 'warn' : 'err', 6000);
      } finally {
        state.oprBusy = false;
        await refreshOprDetail(); render();
      }
    };
    const doRestock = async () => {
      try {
        const r = await api.post(`/opr/shipments/${s.id}/restock`, {});
        toast(`Restocked ${r.restocked} device${r.restocked === 1 ? '' : 's'}${(r.skipped?.length) ? ` (${r.skipped.length} skipped — already restocked or missing)` : ''}`, 'ok');
        await refreshOprDetail(); render();
      } catch (err) {
        toast(err.response?.data?.error || err.message, 'err', 5000);
      }
    };

    return h('div', { class: 'space-y-5' },
      h('div', { class: 'flex items-center justify-between flex-wrap gap-3' },
        h('div', { class: 'flex items-center gap-3' },
          backBtn,
          h('h2', { class: 'text-xl font-bold mono text-cyan-300', id: 'opr-detail-ref' }, s.reference),
          oprDirBadge(s.direction), oprStatusBadge(s.status)
        ),
        h('div', { class: 'flex items-center gap-2 flex-wrap' },
          // Documents: export → invoice/scan-out/prealert; import → ce1154/clearance.
          // None of these apply to TEMP_EXPORT_STANDARD (no customs declaration,
          // no C&E1154 duty-relief basis) — hidden entirely rather than shown
          // disabled, matching the "no customs arithmetic" constraint.
          isStandardTemp ? null : (isExport
            ? [h('button', { class: 'btn btn-ghost text-xs', onclick: () => openDoc('invoice'), title: 'Print-ready commercial invoice (A4)' },
                 h('i', { class: 'fas fa-file-invoice' }), 'Invoice'),
               h('button', { class: 'btn btn-ghost text-xs', onclick: () => showDraftDoc('prealert'), title: 'Carrier customs pre-alert email draft' },
                 h('i', { class: 'fas fa-envelope-open-text' }), 'Pre-alert draft'),
               h('button', { id: 'opr-send-prealert', class: 'btn btn-amber text-xs' + (state.oprBusy ? ' opacity-60' : ''), onclick: () => sendEmail('prealert'),
                 title: 'Send the pre-alert email with invoice + scan-out attached (requires Gmail secrets)' },
                 h('i', { class: 'fas fa-paper-plane' }), 'Send pre-alert')]
            : [h('button', { class: 'btn btn-ghost text-xs', onclick: () => openDoc('ce1154'), title: 'C&E1154 duty-relief form (A4)' },
                 h('i', { class: 'fas fa-file-lines' }), 'C&E1154'),
               h('button', { class: 'btn btn-ghost text-xs', onclick: () => showDraftDoc('clearance'), title: 'Broker clearance-instruction draft' },
                 h('i', { class: 'fas fa-envelope-open-text' }), 'Clearance draft'),
               h('button', { id: 'opr-send-clearance', class: 'btn btn-amber text-xs' + (state.oprBusy ? ' opacity-60' : ''), onclick: () => sendEmail('clearance'),
                 title: 'Send the clearance instruction with C&E1154 attached (requires Gmail secrets)' },
                 h('i', { class: 'fas fa-paper-plane' }), 'Send clearance')]),
          isDraft ? h('button', {
            id: 'opr-finalise-btn',
            class: 'btn btn-primary text-xs' + (v && v.result === 'red' ? ' opacity-60' : ''),
            title: v && v.result === 'red' ? 'Blocked — resolve the red validation results first' :
              (isExport
                ? `Finalise the export (devices become ${isStandardTemp ? 'TEMP_EXPORTED_STANDARD' : 'EXPORTED_UNDER_OPR'})`
                : `Receive the return (devices become ${isStandardTemp ? 'RETURNED_UNDER_STANDARD' : 'RETURNED_UNDER_OPR'})`),
            onclick: () => { state.oprFinaliseOpen = true; render(); },
          }, h('i', { class: 'fas fa-flag-checkered' }), isExport ? 'Finalise export' : 'Receive return') : null,
          !isDraft && !isExport ? h('button', { id: 'opr-restock-btn', class: 'btn btn-primary text-xs', onclick: doRestock,
            title: `Move ${isStandardTemp ? 'RETURNED_UNDER_STANDARD' : 'RETURNED_UNDER_OPR'} devices back to ACTIVE_INVENTORY (idempotent)` },
            h('i', { class: 'fas fa-warehouse' }), 'Restock') : null
        )
      ),

      // Header facts. Authorisation / Procedure / MRN are all customs-declaration
      // facts that don't exist on a TEMP_EXPORT_STANDARD shipment — shown as a
      // neutral "n/a" rather than blank/"null", consistent with the validation
      // badges and the consignments-list Procedure column.
      h('div', { class: 'grid grid-cols-2 md:grid-cols-4 gap-4' },
        isStandardTemp
          ? OprFact('Authorisation', 'n/a — no customs declaration', 'id-card')
          : OprFact('Authorisation', b.authorisation ? b.authorisation.holder_name : '—', 'id-card'),
        isStandardTemp
          ? OprFact('Procedure', 'n/a', 'stamp')
          : OprFact('Procedure', s.procedure_code + (s.additional_procedure_code ? ' + ' + s.additional_procedure_code : ''), 'stamp'),
        isStandardTemp
          ? OprFact(isExport ? 'Export MRN' : 'Import MRN', 'n/a', 'barcode')
          : OprFact(isExport ? 'Export MRN' : 'Import MRN', (isExport ? s.export_mrn : s.import_mrn) || '—', 'barcode'),
        OprFact('Declared value', fmtMoney(b.total_value, s.currency), 'coins'),
      ),

      // Export proof card (FINALISED exports) — record/replace MRN / DUCR /
      // EAD / MUCR after the fact (e.g. when the carrier's declaration or
      // consolidation reference lands later). The only mutation a FINALISED
      // export accepts.
      // Hidden for TEMP_EXPORT_STANDARD — MRN/DUCR/EAD/MUCR are all customs
      // declaration references and this shipment_type has no declaration to
      // reference (pick-and-note: hide entirely rather than keep-as-generic-
      // tracking-ref or relabel, for consistency with every other customs-only
      // block on this screen).
      !isDraft && isExport && !isStandardTemp ? OprExportProofCard(s) : null,

      // Validation traffic lights. The backend reports customs-only checks
      // that don't apply to this shipment_type (e.g. TEMP_EXPORT_STANDARD
      // has no authorisation/procedure code) as level='green' with a
      // "Not applicable — …" message, so a red/amber result never blocks
      // on a field the shipment is forbidden from having. But a green tick
      // reads as "customs check passed" to an operator — misleading on a
      // shipment with no customs obligation at all. So in the UI (not the
      // backend data) we re-badge those as a neutral grey "n/a" state,
      // visually distinct from both pass (green) and fail (amber/red).
      v ? (() => {
        const isNotApplicable = (c2) => c2.message.startsWith('Not applicable');
        const checkBadgeCls = (c2) => isNotApplicable(c2) ? 'badge-slate' : c2.level === 'amber' ? 'badge-amber' : 'badge-red';
        const checkBadgeText = (c2) => isNotApplicable(c2) ? 'n/a' : c2.level;
        const visibleChecks = v.checks.filter(c2 => c2.level !== 'green' || isNotApplicable(c2));
        return h('div', { class: 'card p-4', id: 'opr-validation' },
          h('div', { class: 'flex items-center gap-2 mb-2' },
            h('span', { class: 'badge ' + (v.result === 'green' ? 'badge-green' : v.result === 'amber' ? 'badge-amber' : 'badge-red') },
              h('i', { class: 'fas fa-' + (v.result === 'green' ? 'check' : v.result === 'amber' ? 'triangle-exclamation' : 'ban') + ' mr-1' }),
              v.result.toUpperCase()),
            h('span', { class: 'text-xs text-slate-400' },
              `${v.checks.length} checks — red blocks ${isExport ? 'finalisation' : 'receipt'}, amber passes with a warning`)
          ),
          h('div', { class: 'space-y-1' },
            visibleChecks.map(c2 =>
              h('div', { class: 'flex items-start gap-2 text-xs' },
                h('span', { class: 'badge ' + checkBadgeCls(c2) + ' shrink-0' }, checkBadgeText(c2)),
                h('span', { class: isNotApplicable(c2) ? 'text-slate-500' : 'text-slate-300' }, c2.message))),
            v.checks.every(c2 => c2.level === 'green' && !isNotApplicable(c2))
              ? h('div', { class: 'text-xs text-slate-500' }, 'All checks green.')
              : null
          )
        );
      })() : null,

      // Repair-invoice / C&E1154 inputs (import DRAFT only) — receipt is
      // blocked server-side until repair_cost + duty_rate_pct are recorded.
      // Mandatory hide for TEMP_EXPORT_STANDARD — no customs arithmetic
      // (repair_cost/duty_rate_pct/exchange_rate) on this shipment_type at all.
      isDraft && !isExport && !isStandardTemp ? OprRepairInvoiceCard(s) : null,

      // Scan-to-add (DRAFT only)
      isDraft ? h('div', { class: 'card p-4' },
        h('div', { class: 'flex items-center gap-3' },
          h('i', { class: 'fas fa-barcode text-cyan-400 text-xl' }),
          h('input', {
            id: 'opr-scan-input', class: 'input mono flex-1',
            placeholder: isExport
              ? 'Scan IMEI to add — device must be READY_FOR_EXPORT with a buy price'
              : 'Scan IMEI to add to the return — device must be EXPORTED_UNDER_OPR on the linked export',
            onkeydown: (e) => { if (e.key === 'Enter') doScan(e.target.value, e.target); },
          }),
          h('button', { class: 'btn btn-primary text-sm', onclick: () => { const el = $('#opr-scan-input'); doScan(el?.value, el); } },
            h('i', { class: 'fas fa-plus' }), 'Add')
        )
      ) : null,

      // Lines table
      h('div', { class: 'card overflow-hidden' },
        h('table', { class: 'w-full text-sm', id: 'opr-lines-table' },
          h('thead', { class: 'bg-slate-900/50 text-xs uppercase text-slate-400' },
            h('tr', {},
              h('th', { class: 'text-left px-4 py-3' }, '#'),
              h('th', { class: 'text-left px-4 py-3' }, 'IMEI'),
              h('th', { class: 'text-left px-4 py-3' }, 'Device'),
              h('th', { class: 'text-left px-4 py-3' }, 'Grade'),
              h('th', { class: 'text-right px-4 py-3' }, 'Declared value'),
              isDraft ? h('th', { class: 'text-right px-4 py-3' }, '') : null
            )
          ),
          h('tbody', { class: 'divide-y divide-slate-800' },
            !b.lines.length
              ? h('tr', {}, h('td', { colspan: 6, class: 'text-center py-8 text-slate-500' },
                  isDraft ? 'No devices yet — scan an IMEI above.' : 'No lines.'))
              : b.lines.map((l, i) => h('tr', { class: 'row-strip opr-line-row' },
                  h('td', { class: 'px-4 py-2 text-xs text-slate-500' }, i + 1),
                  h('td', { class: 'px-4 py-2 mono text-xs' }, l.imei),
                  h('td', { class: 'px-4 py-2 text-xs' }, [l.brand, l.model, l.capacity].filter(Boolean).join(' ') || l.sku || '—'),
                  h('td', { class: 'px-4 py-2' }, h('span', { class: gradeBadgeClass(l.grade) }, gradeLabel(l.grade))),
                  h('td', { class: 'px-4 py-2 text-right mono text-xs' }, fmtMoney(l.unit_value, l.currency)),
                  isDraft ? h('td', { class: 'px-4 py-2 text-right' },
                    h('button', { class: 'btn btn-ghost text-xs opr-line-remove', title: 'Remove from consignment', onclick: () => removeLine(l) },
                      h('i', { class: 'fas fa-xmark' }))) : null
                ))
          )
        )
      ),

      // Email outbox
      h('div', { class: 'card p-4', id: 'opr-emails' },
        h('div', { class: 'flex items-center gap-2 mb-2' },
          h('h3', { class: 'font-semibold text-sm' }, 'Email outbox'),
          h('span', { class: 'text-[11px] text-slate-500' }, 'System send attempts (sent/failed) and operator-recorded manual sends (manual). Nothing is auto-sent until Gmail is configured.')
        ),
        !state.oprEmails.length
          ? h('div', { class: 'text-xs text-slate-500 py-2' }, 'No emails recorded for this consignment.')
          : h('div', { class: 'divide-y divide-slate-800' },
              state.oprEmails.map(e => h('div', { class: 'py-2 flex items-center gap-3 text-xs opr-email-row' },
                h('span', { class: 'badge ' + (e.status === 'sent' ? 'badge-green' : e.status === 'manual' ? 'badge-cyan' : 'badge-red'),
                  title: e.status === 'manual' ? 'Recorded by an operator as sent from their own mail client — NOT sent by the system' : undefined },
                  e.status === 'manual' ? 'manual' : e.status),
                h('span', { class: 'badge badge-slate' }, e.kind),
                h('span', { class: 'mono text-slate-300' }, e.to_email),
                h('span', { class: 'text-slate-400 truncate flex-1' }, e.subject),
                h('span', { class: 'text-slate-500' }, fmtDate(e.created_at))
              )))
      )
    );
  }
  function OprExportProofCard(s) {
    const f = { export_mrn: '', ducr: '', ead_mrn: '', mucr: '' };
    const save = async () => {
      const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim()));
      if (!Object.keys(body).length) { toast('Enter at least one reference to record', 'warn'); return; }
      try {
        await api.post(`/opr/shipments/${s.id}/export-proof`, body);
        toast('Export proof recorded', 'ok');
        await refreshOprDetail(); render();
      } catch (err) {
        toast(err.response?.data?.error || err.message, 'err', 5000);
      }
    };
    const Field = (label, key, current, placeholder) => h('div', {},
      h('label', { class: 'text-[10px] uppercase text-slate-500 mb-1 block' }, label,
        current ? h('span', { class: 'ml-2 mono text-cyan-300 normal-case' }, current) : null),
      h('input', { id: `opr-proof-${key}`, class: 'input mono text-xs', placeholder: current ? 'replace…' : placeholder,
        oninput: (e) => { f[key] = e.target.value; } }));
    return h('div', { class: 'card p-4', id: 'opr-proof-card' },
      h('div', { class: 'flex items-center gap-2 mb-3' },
        h('h3', { class: 'font-semibold text-sm' }, h('i', { class: 'fas fa-stamp mr-2 text-cyan-400' }), 'Export proof references'),
        h('span', { class: 'text-[11px] text-slate-500' }, 'Record declaration references as they land — MRN, DUCR, EAD, MUCR. Existing values shown beside each label.')
      ),
      h('div', { class: 'grid grid-cols-2 md:grid-cols-4 gap-3' },
        Field('Export MRN', 'export_mrn', s.export_mrn, '26GB34F7Y1AB8CDE12'),
        Field('DUCR', 'ducr', s.ducr, '6GB369979995000-EXP…'),
        Field('EAD MRN', 'ead_mrn', s.ead_mrn, '(optional)'),
        Field('MUCR', 'mucr', s.mucr, 'GB/SGAT-12345678')
      ),
      h('div', { class: 'flex justify-end mt-3' },
        h('button', { id: 'opr-proof-save', class: 'btn btn-primary text-xs', onclick: save },
          h('i', { class: 'fas fa-floppy-disk' }), 'Record proof')
      )
    );
  }

  function OprFact(label, value, icon) {
    return h('div', { class: 'card p-4' },
      h('div', { class: 'text-[10px] uppercase text-slate-500 mb-1' }, h('i', { class: `fas fa-${icon} mr-1` }), label),
      h('div', { class: 'text-sm font-semibold mono truncate', title: String(value) }, value)
    );
  }

  // Repair-invoice inputs for the C&E1154 (import DRAFT). PATCHes the
  // shipment header; server rejects these fields on exports.
  function OprRepairInvoiceCard(s) {
    const f = {
      repair_cost: s.repair_cost ?? '',
      repair_cost_currency: s.repair_cost_currency || 'GBP',
      customs_exchange_rate: s.customs_exchange_rate ?? '',
      duty_rate_pct: s.duty_rate_pct ?? '',
    };
    const save = async () => {
      const body = {};
      if (String(f.repair_cost).trim() !== '') body.repair_cost = Number(f.repair_cost);
      body.repair_cost_currency = f.repair_cost_currency;
      if (String(f.customs_exchange_rate).trim() !== '') body.customs_exchange_rate = Number(f.customs_exchange_rate);
      if (String(f.duty_rate_pct).trim() !== '') body.duty_rate_pct = Number(f.duty_rate_pct);
      try {
        await http.patch(`/opr/shipments/${s.id}`, body);
        toast('Repair invoice details saved', 'ok');
        await refreshOprDetail(); render();
      } catch (err) {
        toast(err.response?.data?.error || err.message, 'err', 5000);
      }
    };
    const Num = (label, key, placeholder, idAttr) => h('div', {},
      h('label', { class: 'text-xs text-slate-400 mb-1 block' }, label),
      h('input', { id: idAttr, class: 'input mono', inputmode: 'decimal', placeholder, value: f[key],
        oninput: (e) => { f[key] = e.target.value; } }));
    return h('div', { class: 'card p-4', id: 'opr-repair-card' },
      h('div', { class: 'flex items-center gap-2 mb-3' },
        h('i', { class: 'fas fa-file-invoice-dollar text-amber-400' }),
        h('h3', { class: 'font-semibold text-sm' }, 'Repair invoice (C&E1154 inputs)'),
        h('span', { class: 'text-[11px] text-slate-500' }, 'Receipt is blocked until repair cost and duty rate are recorded — duty is relieved on everything except the repair charge.')
      ),
      h('div', { class: 'grid grid-cols-2 md:grid-cols-4 gap-3' },
        Num('Repair cost *', 'repair_cost', '350.00', 'opr-repair-cost'),
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Invoice currency'),
          h('select', { class: 'input mono', onchange: (e) => { f.repair_cost_currency = e.target.value; } },
            ['GBP', 'USD', 'EUR', 'CNY', 'HKD', 'AED'].map(cur =>
              h('option', { value: cur, selected: f.repair_cost_currency === cur ? 'selected' : null }, cur)))),
        Num('Exchange rate (per £1)', 'customs_exchange_rate', 'blank for GBP', 'opr-exchange-rate'),
        Num('Duty rate % *', 'duty_rate_pct', '0 for duty-free', 'opr-duty-rate')
      ),
      h('div', { class: 'flex justify-end mt-3' },
        h('button', { id: 'opr-repair-save', class: 'btn btn-primary text-xs', onclick: save },
          h('i', { class: 'fas fa-floppy-disk' }), 'Save invoice details')
      )
    );
  }

  // ─── Finalise / receive modal ───
  function OprFinaliseModal() {
    const b = state.oprBundle;
    const s = b.shipment;
    const isExport = s.direction === 'export';
    // TEMP_EXPORT_STANDARD has no declaration references to capture here —
    // the export target is TEMP_EXPORTED_STANDARD (not EXPORTED_UNDER_OPR)
    // and the return target is RETURNED_UNDER_STANDARD (not RETURNED_UNDER_OPR).
    const isStandardTemp = s.shipment_type === 'TEMP_EXPORT_STANDARD';
    const exportTarget = isStandardTemp ? 'TEMP_EXPORTED_STANDARD' : 'EXPORTED_UNDER_OPR';
    const returnTarget = isStandardTemp ? 'RETURNED_UNDER_STANDARD' : 'RETURNED_UNDER_OPR';
    const f = { export_mrn: '', ducr: '', ead_mrn: '', mucr: '', import_mrn: '' };
    const close = () => { state.oprFinaliseOpen = false; render(); };
    const doFinalise = async () => {
      const body = isStandardTemp ? {} : (isExport
        ? Object.fromEntries(Object.entries({ export_mrn: f.export_mrn, ducr: f.ducr, ead_mrn: f.ead_mrn, mucr: f.mucr }).filter(([, v2]) => v2.trim()))
        : (f.import_mrn.trim() ? { import_mrn: f.import_mrn.trim() } : {}));
      try {
        const r = await api.post(`/opr/shipments/${s.id}/finalise`, body);
        state.oprFinaliseOpen = false;
        const ambers = (r.validation?.checks || []).filter(c2 => c2.level === 'amber');
        toast(
          (isExport ? `Export finalised — ${r.devices_exported} devices ${exportTarget}` : `Return received — ${r.devices_returned ?? b.lines.length} devices ${returnTarget}`) +
          (ambers.length ? `<br><span class="text-xs">${ambers.length} amber warning${ambers.length === 1 ? '' : 's'} noted</span>` : ''),
          'ok', 4500);
        await refreshOprDetail(); await refreshOprShipments(); render();
      } catch (err) {
        state.oprFinaliseOpen = false;
        const detail = err.response?.data;
        toast(detail?.error || err.message, 'err', 6000);
        render();
      }
    };
    const Field = (label, key, placeholder) => h('div', {},
      h('label', { class: 'text-xs text-slate-400 mb-1 block' }, label),
      h('input', { class: 'input mono', placeholder, oninput: (e) => { f[key] = e.target.value; } }));
    return h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target.classList.contains('modal-backdrop')) close(); } },
      h('div', { class: 'modal p-6 max-w-md' },
        h('h2', { class: 'text-lg font-semibold mb-1' }, isExport ? 'Finalise export consignment' : 'Receive return consignment'),
        h('p', { class: 'text-xs text-slate-400 mb-4' },
          isStandardTemp
            ? (isExport
                ? 'No customs declaration on TEMP_EXPORT_STANDARD — finalising moves every device straight to TEMP_EXPORTED_STANDARD.'
                : 'No customs declaration on TEMP_EXPORT_STANDARD — receipt moves every device to RETURNED_UNDER_STANDARD and freezes declared values.')
            : (isExport
                ? 'Declaration references are optional here — they can be recorded later via export proof. Red validation results block finalisation server-side.'
                : 'Receipt moves every device to RETURNED_UNDER_OPR and freezes declared values. Import MRN is optional (record later via import proof).')),
        // Declaration-reference fields (MRN/DUCR/EAD/MUCR) don't apply to
        // TEMP_EXPORT_STANDARD — hidden entirely, matching the OprExportProofCard
        // pick-and-note decision (no declaration to reference on this shipment_type).
        isStandardTemp ? null : h('div', { class: 'space-y-3' },
          isExport
            ? [Field('Export MRN', 'export_mrn', '26GB34F7Y1AB8CDE12'),
               Field('DUCR', 'ducr', '6GB369979995000-EXP2026001'),
               Field('EAD MRN', 'ead_mrn', '(optional)'),
               Field('MUCR (master UCR)', 'mucr', 'GB/SGAT-12345678 (optional)')]
            : Field('Import MRN (6121 declaration)', 'import_mrn', '26GB89E4Q2CD7FGH34')
        ),
        h('div', { class: 'flex justify-end gap-2 mt-5' },
          h('button', { class: 'btn btn-ghost text-sm', onclick: close }, 'Cancel'),
          h('button', { id: 'opr-finalise-confirm', class: 'btn btn-primary text-sm', onclick: doFinalise },
            h('i', { class: 'fas fa-flag-checkered' }), isExport ? 'Finalise' : 'Receive')
        )
      )
    );
  }

  // ─── Draft-document modal (pre-alert / clearance text drafts) ───
  function OprDraftDocModal() {
    const d = state.oprDraftDoc;
    const close = () => { state.oprDraftDoc = null; render(); };
    const copy = async (text, what) => {
      const ok = await copyToClipboard(text);
      if (ok) toast(`${what} copied`, 'ok');
      else toast('Clipboard unavailable — select and copy manually', 'warn');
    };
    const isPre = d.kind === 'prealert';
    const to = d.data.to || null;
    const s = state.oprBundle?.shipment;
    // Manual dispatch: operator sends from their own mail client, then
    // records it. The server rebuilds the draft to log the true to/subject.
    const markSent = async () => {
      if (!s) return;
      try {
        const body = to ? {} : { to: (d.manualTo || '').trim() };
        if (!to && !body.to) { toast('Enter the mailbox you sent it to first', 'warn'); return; }
        const r = await api.post(`/opr/shipments/${s.id}/${d.kind}/mark-sent`, body);
        toast(`Recorded as manually sent to ${r.to} — outbox entry #${r.email_id} (provider: manual)`, 'ok', 4500);
        state.oprDraftDoc = null;
        await refreshOprDetail(); render();
      } catch (err) {
        toast(err.response?.data?.error || err.message, 'err', 5000);
      }
    };
    const mailtoHref = () => {
      const rcpt = to || (d.manualTo || '').trim();
      return `mailto:${encodeURIComponent(rcpt)}?subject=${encodeURIComponent(d.data.subject)}&body=${encodeURIComponent(d.data.body)}`;
    };
    const CopyBtn = (text, what) => h('button', {
      class: 'btn btn-ghost text-[11px] px-2 py-0.5 shrink-0', title: `Copy ${what.toLowerCase()}`,
      onclick: () => copy(text, what),
    }, h('i', { class: 'fas fa-copy' }));
    return h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target.classList.contains('modal-backdrop')) close(); } },
      h('div', { class: 'modal p-6 max-w-2xl' },
        h('div', { class: 'flex items-center justify-between mb-3' },
          h('h2', { class: 'text-lg font-semibold' }, isPre ? 'Pre-alert email draft' : 'Clearance instruction draft'),
          h('button', { class: 'btn btn-ghost text-xs', onclick: close }, h('i', { class: 'fas fa-xmark' }))
        ),
        h('div', { class: 'px-3 py-2 mb-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-200 text-xs' },
          h('i', { class: 'fas fa-hand mr-2' }),
          'Manual dispatch: copy the fields below into your own mail client, send, then record it with “Mark as manually sent”. Nothing is sent by the system.'),
        h('div', { class: 'space-y-2 text-xs' },
          h('div', { class: 'flex items-center gap-2' },
            h('span', { class: 'text-slate-500 w-14 shrink-0' }, 'To'),
            to
              ? [h('span', { class: 'mono text-slate-200 flex-1', id: 'opr-draft-to' }, to), CopyBtn(to, 'To')]
              : h('input', { class: 'input mono flex-1 text-xs', id: 'opr-draft-to',
                  placeholder: 'not configured on the authorisation — enter the mailbox you will send to',
                  value: d.manualTo || '', oninput: (e) => { d.manualTo = e.target.value; } })),
          d.data.cutoff ? h('div', { class: 'flex gap-2' },
            h('span', { class: 'text-slate-500 w-14 shrink-0' }, 'Cut-off'),
            h('span', { class: 'text-slate-200' }, d.data.cutoff)) : null,
          h('div', { class: 'flex items-center gap-2' },
            h('span', { class: 'text-slate-500 w-14 shrink-0' }, 'Subject'),
            h('span', { class: 'mono text-slate-200 flex-1', id: 'opr-draft-subject' }, d.data.subject),
            CopyBtn(d.data.subject, 'Subject')),
          d.note ? h('div', { class: 'px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200' },
            h('i', { class: 'fas fa-triangle-exclamation mr-2' }), d.note) : null,
          h('pre', { class: 'mt-2 p-3 rounded-lg bg-slate-900/70 border border-slate-800 whitespace-pre-wrap text-slate-300 max-h-[38vh] overflow-auto mono' },
            d.data.body)
        ),
        h('div', { class: 'flex justify-end items-center gap-2 mt-4 flex-wrap' },
          h('button', { class: 'btn btn-ghost text-sm', onclick: () => copy(d.data.subject, 'Subject') }, h('i', { class: 'fas fa-copy' }), 'Copy subject'),
          h('button', { class: 'btn btn-ghost text-sm', onclick: () => copy(d.data.body, 'Body') }, h('i', { class: 'fas fa-copy' }), 'Copy body'),
          h('a', { class: 'btn btn-ghost text-sm', href: mailtoHref(), title: 'Open a pre-filled email in your default mail client' },
            h('i', { class: 'fas fa-envelope' }), 'Open in mail app'),
          h('button', { id: 'opr-mark-sent', class: 'btn btn-primary text-sm', onclick: markSent,
            title: 'Record that you sent this email manually — logged in the outbox as provider: manual (distinct from real system sends)' },
            h('i', { class: 'fas fa-check-double' }), 'Mark as manually sent')
        )
      )
    );
  }

  // ─── Discharge tracker ───
  function OprDischargeView() {
    const d = state.oprDischarge;
    if (!d) return h('div', { class: 'card p-8 text-center text-slate-500' }, 'Loading…');
    const badge = (st) => {
      const map = { discharged: 'badge-green', open: 'badge-cyan', closing: 'badge-amber', overdue: 'badge-red', no_export_date: 'badge-slate' };
      return h('span', { class: 'badge ' + (map[st] || 'badge-slate') }, st.replace(/_/g, ' '));
    };
    return h('div', { class: 'space-y-4', id: 'opr-discharge' },
      h('div', { class: 'grid grid-cols-2 md:grid-cols-5 gap-4' },
        StatCard('Finalised exports', d.summary.exports, 'plane-departure', 'cyan'),
        StatCard('Discharged', d.summary.discharged, 'check', 'green'),
        StatCard('Open', d.summary.open ?? (d.summary.exports - d.summary.discharged - d.summary.overdue - d.summary.closing), 'hourglass-half', 'indigo'),
        StatCard('Closing (<30d)', d.summary.closing, 'triangle-exclamation', 'amber'),
        StatCard('Overdue', d.summary.overdue, 'ban', 'red'),
      ),
      h('div', { class: 'card overflow-hidden' },
        h('table', { class: 'w-full text-sm' },
          h('thead', { class: 'bg-slate-900/50 text-xs uppercase text-slate-400' },
            h('tr', {},
              h('th', { class: 'text-left px-4 py-3' }, 'Export'),
              h('th', { class: 'text-left px-4 py-3' }, 'MRN'),
              h('th', { class: 'text-left px-4 py-3' }, 'Export date'),
              h('th', { class: 'text-left px-4 py-3' }, 'Deadline'),
              h('th', { class: 'text-right px-4 py-3' }, 'Days left'),
              h('th', { class: 'text-right px-4 py-3' }, 'Exported'),
              h('th', { class: 'text-right px-4 py-3' }, 'Returned'),
              h('th', { class: 'text-right px-4 py-3' }, 'Outstanding'),
              h('th', { class: 'text-left px-4 py-3' }, 'Status')
            )
          ),
          h('tbody', { class: 'divide-y divide-slate-800' },
            !d.discharge.length
              ? h('tr', {}, h('td', { colspan: 9, class: 'text-center py-10 text-slate-500' },
                  'No finalised exports — the tracker starts counting once an export consignment finalises.'))
              : d.discharge.map(r => h('tr', { class: 'row-strip' },
                  h('td', { class: 'px-4 py-2 mono text-cyan-300 text-xs font-semibold' }, r.reference),
                  h('td', { class: 'px-4 py-2 mono text-xs text-slate-400' }, r.export_mrn || '—'),
                  h('td', { class: 'px-4 py-2 mono text-xs' }, r.export_date || '—'),
                  h('td', { class: 'px-4 py-2 mono text-xs' }, r.discharge_deadline || '—'),
                  h('td', { class: 'px-4 py-2 text-right mono text-xs ' + (r.days_remaining != null && r.days_remaining < 0 ? 'text-red-400' : r.days_remaining != null && r.days_remaining <= 30 ? 'text-amber-300' : '') },
                    r.days_remaining ?? '—'),
                  h('td', { class: 'px-4 py-2 text-right mono' }, r.exported),
                  h('td', { class: 'px-4 py-2 text-right mono' }, r.returned),
                  h('td', { class: 'px-4 py-2 text-right mono font-semibold ' + (r.outstanding > 0 ? 'text-amber-300' : 'text-slate-500') }, r.outstanding),
                  h('td', { class: 'px-4 py-2' }, badge(r.status))
                ))
          )
        )
      )
    );
  }

  // ───────── Settings ─────────
  async function refreshSettings() {
    try {
      state.printSettings = await api.get('/print/settings');
    } catch (e) {
      console.error(e);
      toast('Failed to load settings: ' + e.message, 'err');
    }
  }
  async function refreshPrintnodePrinters() {
    try {
      const r = await api.get('/print/printnode/printers');
      state.printnodePrinters = r.printers || [];
    } catch (e) {
      state.printnodePrinters = [];
      toast('PrintNode: ' + (e.response?.data?.error || e.message), 'err');
    }
  }
  async function saveSettings(patch) {
    state.settingsSaving = true; render();
    try {
      await api.post('/print/settings', patch);
      await refreshSettings();
      toast('Settings saved', 'ok');
    } catch (e) {
      toast('Save failed: ' + (e.response?.data?.error || e.message), 'err');
    } finally {
      state.settingsSaving = false;
      render();
    }
  }

  // ───────── Dashboard ─────────
  function StatCard(label, value, icon, accent='cyan') {
    const colors = {
      cyan: 'from-cyan-500/20 to-cyan-500/0 text-cyan-300',
      indigo: 'from-indigo-500/20 to-indigo-500/0 text-indigo-300',
      amber: 'from-amber-500/20 to-amber-500/0 text-amber-300',
      green: 'from-green-500/20 to-green-500/0 text-green-300',
      red: 'from-red-500/20 to-red-500/0 text-red-300',
    }[accent];
    return h('div', { class: 'card p-5 relative overflow-hidden' },
      h('div', { class: `absolute -top-4 -right-4 w-32 h-32 rounded-full bg-gradient-to-br ${colors} opacity-40 blur-2xl` }),
      h('div', { class: 'flex items-start justify-between relative' },
        h('div', {},
          h('div', { class: 'text-xs text-slate-400 uppercase tracking-wider' }, label),
          h('div', { class: 'text-3xl font-bold mt-2 mono' }, String(value ?? 0))
        ),
        h('div', { class: `w-10 h-10 rounded-xl bg-slate-800/60 flex items-center justify-center ${colors.split(' ').pop()}` },
          h('i', { class: `fas fa-${icon}` })
        )
      )
    );
  }

  function DashboardView() {
    const s = state.stats;
    return h('div', { class: 'space-y-6' },
      h('div', {},
        h('h1', { class: 'text-2xl font-bold' }, 'Operations Dashboard'),
        h('p', { class: 'text-slate-400 text-sm' }, 'Live status of inbound device receiving.')
      ),
      h('div', { class: 'grid grid-cols-2 md:grid-cols-5 gap-4' },
        StatCard('Open Manifests', s.open_manifests, 'file-invoice', 'cyan'),
        StatCard('Pending Devices', s.pending_devices, 'inbox', 'amber'),
        StatCard('Received Total', s.received_total, 'box-archive', 'green'),
        StatCard('Unreconciled', s.unreconciled_total, 'triangle-exclamation', 'red'),
        StatCard('Print Queue', s.print_queue, 'print', 'indigo'),
      ),
      h('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-6' },
        h('div', { class: 'card p-5' },
          h('div', { class: 'flex items-center justify-between mb-4' },
            h('h2', { class: 'font-semibold' }, 'Active Manifests'),
            h('button', { class: 'btn btn-primary text-sm', onclick: () => switchView('manifests') },
              h('i', { class: 'fas fa-plus' }), 'New')
          ),
          ManifestList(state.manifests.slice(0, 6))
        ),
        h('div', { class: 'card p-5' },
          h('h2', { class: 'font-semibold mb-4' }, 'Quick Actions'),
          h('div', { class: 'grid grid-cols-2 gap-3' },
            QuickAction('Upload Manifest', 'cloud-arrow-up', 'cyan', () => switchView('manifests')),
            QuickAction('Start Receiving', 'barcode', 'indigo', () => switchView('receive')),
            QuickAction('Print Queue', 'print', 'amber', () => switchView('print')),
            QuickAction('Browse Inventory', 'warehouse', 'green', () => switchView('inventory')),
          )
        )
      )
    );
  }
  function QuickAction(label, icon, accent, onclick) {
    return h('button', {
      class: 'p-4 rounded-xl bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/50 text-left transition',
      onclick,
    },
      h('i', { class: `fas fa-${icon} text-${accent}-400 text-xl mb-2` }),
      h('div', { class: 'text-sm font-medium' }, label)
    );
  }

  function ManifestList(items) {
    if (!items.length) return h('div', { class: 'text-sm text-slate-500 py-6 text-center' }, 'No manifests yet.');
    return h('div', { class: 'divide-y divide-slate-800' },
      items.map(m => {
        const pct = m.expected_count ? Math.round((m.received_count / m.expected_count) * 100) : 0;
        return h('div', { class: 'py-3 flex items-center gap-4' },
          h('div', { class: 'flex-1 min-w-0' },
            h('div', { class: 'flex items-center gap-2' },
              h('span', { class: 'font-semibold mono text-cyan-300' }, m.reference),
              h('span', { class: 'badge ' + (m.status === 'open' ? 'badge-green' : 'badge-slate') }, m.status),
              m.unreconciled_count > 0 ? h('span', { class: 'badge badge-red' },
                h('i', { class: 'fas fa-triangle-exclamation mr-1' }), `${m.unreconciled_count} unreconciled`) : null
            ),
            h('div', { class: 'text-xs text-slate-400 mt-0.5 truncate' }, m.supplier)
          ),
          h('div', { class: 'w-40' },
            h('div', { class: 'flex justify-between text-xs text-slate-400 mb-1' },
              h('span', {}, `${m.received_count}/${m.expected_count}`),
              h('span', { class: 'mono' }, `${pct}%`)
            ),
            h('div', { class: 'progress' }, h('div', { style: `width:${pct}%` }))
          ),
          h('button', {
            class: 'btn btn-ghost text-xs',
            onclick: () => { state.activeManifestId = m.id; switchView('receive'); },
          }, h('i', { class: 'fas fa-barcode' }), 'Open')
        );
      })
    );
  }

  // ───────── Manifests view ─────────
  // ── Manifest → bill reconciliation panel (0029) ──
  // sum(manifest unit costs) vs. the linked bill's declared_total_gbp,
  // with unit count checked against row count. 'awaiting_manifest'
  // replaces the historical header-only false green — it is NOT a
  // Balanced verdict, just "nothing to compare yet".
  function ManifestBillReconciliationBadge(r) {
    // Optional param so BillDetailView() can pass d.bill_reconciliation
    // explicitly (the manifest-linked branch of its own display) while
    // ReceiveView()'s existing no-arg call site keeps reading
    // state.billReconciliation unchanged — same function, same verdict
    // logic, no duplicated comparison code either place.
    if (r === undefined) r = state.billReconciliation;
    if (!r) return null;
    if (r.verdict === 'awaiting_manifest') {
      return h('div', { id: 'manifest-bill-reconciliation', class: 'card p-3 flex items-center gap-2 text-sm' },
        h('span', { class: 'badge badge-slate' }, h('i', { class: 'fas fa-hourglass-half mr-1' }), 'Awaiting manifest'),
        h('span', { class: 'text-xs text-slate-500' }, r.reason)
      );
    }
    const balanced = r.verdict === 'balanced';
    return h('div', { id: 'manifest-bill-reconciliation', class: 'card p-3 flex items-center gap-3 text-sm flex-wrap' },
      h('span', { class: 'badge ' + (balanced ? 'badge-green' : 'badge-red') },
        h('i', { class: `fas fa-${balanced ? 'check' : 'triangle-exclamation'} mr-1` }),
        balanced ? 'Balanced — manifest matches bill' : `Variance: ${fmtMoney(r.variance_gbp, 'GBP')}`),
      h('span', { class: 'text-xs text-slate-400' }, `Manifest sum: ${fmtMoney(r.sum_manifest_gbp, 'GBP')}`),
      h('span', { class: 'text-xs text-slate-400' }, `Bill declared: ${fmtMoney(r.declared_total_gbp, 'GBP')}`),
      !balanced && r.unit_count_mismatch ? h('span', { class: 'badge badge-amber text-[10px]' },
        h('i', { class: 'fas fa-hashtag mr-1' }), `${r.unit_count_manifest} priced lines vs ${r.unit_count_bill} bill units`) : null
    );
  }

  function ManifestsView() {
    return h('div', { class: 'space-y-6' },
      h('div', { class: 'flex items-center justify-between' },
        h('div', {},
          h('h1', { class: 'text-2xl font-bold' }, 'Shipping Manifests'),
          h('p', { class: 'text-slate-400 text-sm' }, 'Upload an Advanced Shipping Notice (ASN) to start receiving.')
        ),
        h('button', { class: 'btn btn-primary', onclick: openManifestUpload },
          h('i', { class: 'fas fa-cloud-arrow-up' }), 'Upload Manifest')
      ),
      h('div', { class: 'card overflow-hidden' },
        h('table', { class: 'w-full text-sm' },
          h('thead', { class: 'bg-slate-900/50 text-xs uppercase text-slate-400' },
            h('tr', {},
              h('th', { class: 'text-left px-4 py-3' }, 'Reference'),
              h('th', { class: 'text-left px-4 py-3' }, 'Supplier'),
              h('th', { class: 'text-left px-4 py-3' }, 'Progress'),
              h('th', { class: 'text-left px-4 py-3' }, 'Status'),
              h('th', { class: 'text-left px-4 py-3' }, 'Created'),
              h('th', { class: 'text-right px-4 py-3' }, '')
            )
          ),
          h('tbody', { class: 'divide-y divide-slate-800' },
            state.manifests.length === 0
              ? h('tr', {}, h('td', { colspan: 6, class: 'text-center py-10 text-slate-500' }, 'No manifests yet. Upload one to get started.'))
              : state.manifests.map(m => {
                const pct = m.expected_count ? Math.round((m.received_count / m.expected_count) * 100) : 0;
                return h('tr', { class: 'row-strip' },
                  h('td', { class: 'px-4 py-3 font-semibold mono text-cyan-300' },
                    h('div', { class: 'flex items-center gap-2' },
                      m.reference,
                      // Linked-bill indicator (0029) — a manifest with bill_id
                      // set has a supplier invoice to reconcile against; one
                      // with bill_id null was received with no bill, which is
                      // a normal, fully-supported case, not shown as a warning.
                      m.bill_id != null
                        ? h('span', { class: 'badge badge-slate text-[10px]', title: `Linked to bill #${m.bill_id}` },
                            h('i', { class: 'fas fa-link mr-1' }), 'bill')
                        : null
                    )
                  ),
                  h('td', { class: 'px-4 py-3' }, m.supplier),
                  h('td', { class: 'px-4 py-3' },
                    h('div', { class: 'flex items-center gap-3' },
                      h('div', { class: 'progress w-32' }, h('div', { style: `width:${pct}%` })),
                      h('span', { class: 'text-xs text-slate-400 mono' }, `${m.received_count}/${m.expected_count}`),
                      m.unreconciled_count > 0 ? h('span', { class: 'badge badge-red text-[10px]' },
                        h('i', { class: 'fas fa-triangle-exclamation mr-1' }), m.unreconciled_count) : null
                    )
                  ),
                  h('td', { class: 'px-4 py-3' },
                    h('span', { class: 'badge ' + (m.status === 'open' ? 'badge-green' : 'badge-slate') }, m.status)
                  ),
                  h('td', { class: 'px-4 py-3 text-xs text-slate-400' }, fmtDate(m.created_at)),
                  h('td', { class: 'px-4 py-3 text-right' },
                    h('div', { class: 'flex justify-end gap-2' },
                      h('button', {
                        class: 'btn btn-primary text-xs',
                        onclick: () => { state.activeManifestId = m.id; switchView('receive'); }
                      }, h('i', { class: 'fas fa-barcode' }), 'Receive'),
                      m.status === 'open'
                        ? h('button', { class: 'btn btn-ghost text-xs', onclick: () => closeManifest(m.id) },
                            h('i', { class: 'fas fa-lock' }), 'Close')
                        : h('button', { class: 'btn btn-ghost text-xs', onclick: () => reopenManifest(m.id) },
                            h('i', { class: 'fas fa-lock-open' }), 'Reopen'),
                      h('button', { class: 'btn btn-danger text-xs', onclick: () => deleteManifest(m.id) },
                        h('i', { class: 'fas fa-trash' }))
                    )
                  )
                );
              })
          )
        )
      )
    );
  }

  async function closeManifest(id) {
    await api.post(`/manifests/${id}/close`);
    toast('Manifest closed');
    await refreshManifests(); render();
  }
  async function reopenManifest(id) {
    await api.post(`/manifests/${id}/reopen`);
    toast('Manifest reopened');
    await refreshManifests(); render();
  }
  async function deleteManifest(id) {
    // Find a friendly name + the receive count for the confirm dialog.
    const m = state.manifests.find(x => x.id === id);
    const recvCount = m?.received_count || 0;
    const lines = [
      `Delete manifest ${m?.reference || `#${id}`}?`,
      '',
      'This treats the manifest as if it never happened:',
      `  · ${m?.expected_count ?? '?'} expected lines will be removed`,
    ];
    if (recvCount > 0) {
      lines.push(`  · ${recvCount} already-received device${recvCount === 1 ? '' : 's'} will be DELETED from inventory`);
      lines.push('  · Their labels, print jobs and grade history go too');
    }
    lines.push('', 'This cannot be undone.');
    if (!confirm(lines.join('\n'))) return;
    try {
      const r = await api.del(`/manifests/${id}`);
      if (state.activeManifestId === id) state.activeManifestId = null;
      const dr = r?.deleted_received || 0;
      toast(dr > 0
        ? `Manifest deleted · ${dr} received device${dr === 1 ? '' : 's'} removed from inventory`
        : 'Manifest deleted', 'ok');
      // Inventory may have shrunk — refresh both lists so the dashboard
      // and inventory views stay in sync.
      await Promise.all([refreshManifests(), refreshInventory()]);
      render();
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to delete manifest', 'err');
    }
  }

  // ───────── Manifest upload modal ─────────
  let uploadCtx = null;
  // Fields marked * are needed for catalogue SKU lookup at scan time.
  // Description is optional now — model_no + capacity + color + grade are what
  // the catalog is keyed on. Description is just a human-readable label.
  const MAPPABLE_FIELDS = [
    { key: 'imei',        label: 'IMEI *',         hint: 'serial / IMEI' },
    { key: 'oem',         label: 'OEM / Brand',    hint: 'Apple, Samsung…' },
    { key: 'model_no',    label: 'Model No. *',    hint: 'iPhone 15 Pro, Galaxy S24… (used for catalogue lookup)' },
    { key: 'capacity',    label: 'Storage *',      hint: '128GB, 256G, 1TB… (1024GB folds to 1TB)' },
    { key: 'color',       label: 'Color *',        hint: 'Phantom Black… (case-insensitive)' },
    { key: 'grade',       label: 'Grade *',        hint: 'A | B | C (anything else → UG)' },
    { key: 'description', label: 'Description',    hint: 'optional · human label only' },
    { key: 'condition',   label: 'Condition',      hint: 'Raw | Used | Refurbished | New' },
    { key: 'unit_cost',   label: 'Unit cost',      hint: 'numeric · pre-fills the confirm modal' },
    { key: 'currency',    label: 'Currency',       hint: 'ISO 4217 (USD, GBP…) · optional' },
    { key: 'vat_type',    label: 'VAT type',       hint: 'MARGIN | STANDARD | ZERO | PVAT · optional' },
  ];

  // ───────── AI cleanup prompt (Copilot in Excel / Claude in Excel) ─────────
  // Supplier manifests arrive in wildly varied shapes. This prompt walks an
  // in-Excel AI assistant through reorganising one into our exact
  // MAPPABLE_FIELDS header set (so the upload mapper below auto-detects
  // every column with zero manual remapping) — and, critically, tells it to
  // ASK the operator rather than silently guess whenever information
  // genuinely isn't in the file (currency, VAT type, condition, grade,
  // brand). Keep the accepted Condition / VAT Type / currency-format rules
  // below in sync with src/lib/validate.ts and this file's own
  // MAPPABLE_FIELDS hints if either ever changes.
  // MANIFEST_CLEANUP_PROMPT_VERSION: v2-2026-08-18 — bump this (and the
  // "(v2 — 2026-08-18)" line inside the prompt text itself, just below)
  // every time the prompt's rules change, so a cleaned sheet someone
  // hands us can be traced back to the ruleset that produced it. See
  // test/manifestCleanupPrompt.spec.ts, which pins this version string
  // and cross-checks the STEP 2 header line against MAPPABLE_FIELDS so
  // the two can't silently drift apart again.
  const MANIFEST_CLEANUP_PROMPT_VERSION = 'v2-2026-08-18';
  const MANIFEST_CLEANUP_PROMPT = `MANIFEST CLEANUP PROMPT (v2 — 2026-08-18)

STEP 1 — Before touching anything, scan the whole file and ask me any
clarifying questions you need BEFORE reorganizing it. In particular, check
for and ask about:

- Currency: if there is no Currency column and no currency symbol/code
  anywhere in the cost header (e.g. "Price (USD)"), ASK ME what currency
  the prices are in rather than defaulting to anything.
- VAT Type: if there is no VAT/tax column anywhere in the file, ASK ME
  which of MARGIN, STANDARD, ZERO, or PVAT applies to this whole shipment
  (explain briefly: MARGIN = margin scheme for used/second-hand phones,
  STANDARD = full VAT on sale price, ZERO = zero-rated, PVAT = Postponed
  VAT/import accounting) — most second-hand phone shipments use MARGIN,
  but don't assume, ask.
- Grade: if there is no grade/condition/quality column at all (not even
  under a different name), ask me whether every device in this file
  should be treated as the same grade, or whether grading needs to happen
  later (in which case leave Grade blank rather than guessing UG for
  everything).
- OEM/Brand: if there is no brand column and the model names don't make
  the brand obvious (e.g. generic model codes), ask me for the brand
  rather than guessing.
- Any column you genuinely cannot map with confidence to IMEI, OEM, Model
  No., Storage, Color, Grade, Description, Condition, Unit Cost, Currency,
  or VAT Type — tell me what that column's header/sample values are and
  ask what it should map to, instead of dropping it silently.

Wait for my answers before proceeding to Step 2. If everything IS present
and unambiguous in the file already, skip straight to Step 2 and tell me
you didn't need to ask anything.

STEP 2 — Once you have my answers (or determined nothing is missing),
reorganize the spreadsheet into a clean, standardized device manifest with
exactly these column headers, in this order, starting in row 1 (delete any
title/instruction/logo rows above the real header):

IMEI | OEM | Model No. | Storage | Color | Grade | Description | Condition | Unit Cost | Currency | VAT Type

Map my existing columns onto these using your best judgment — my file may
label things differently (e.g. "Serial"/"IMEI1"/"SN" → IMEI; "Brand"/
"Manufacturer"/"Make" → OEM; "Memory"/"Capacity"/"Size"/"ROM" → Storage;
"Colour" → Color; "Model"/"Model Name"/"Product Name"/"Item" → Description
if there's no separate model-number column; "Cost"/"Price"/"Buy Price" →
Unit Cost; "Ccy" → Currency; "VAT"/"VAT Scheme" → VAT Type).

Apply these exact rules per column:

1. IMEI (required, must not be blank):
   - Format the column as TEXT before filling it in, so Excel never
     truncates digits or shows scientific notation, and never drops a
     leading zero.
   - Strip spaces, dashes, and any trailing ".0".
   - Valid values are either exactly 15 digits that pass the standard
     GSMA Luhn (mod-10) checksum, or exactly 10 alphanumeric characters
     (for non-cellular serials — no checksum applies to these). Flag any
     row that doesn't satisfy this in a new column called "Flag": use
     "Bad IMEI length" for a value that is neither 15 digits nor 10
     alphanumeric characters, and "Bad IMEI checksum" for a value that IS
     15 digits but fails the Luhn check.
   - Do NOT delete duplicate IMEI rows yourself. If the same IMEI appears
     on more than one row, leave every occurrence in the sheet, flag each
     one in the "Flag" column with "Duplicate IMEI", and list the
     affected row numbers in your closing summary so I can decide what to
     do — a repeated IMEI is sometimes a genuine data-entry error, but it
     can also mean two rows describe the same physical device with
     different details on each, which silently deleting one would hide.

2. OEM: brand name only (e.g. Apple, Samsung, Google). Title-case it. If
   you had to ask me for this in Step 1, apply my answer to every row.

3. Model No.: the manufacturer's model identifier/name (e.g. "iPhone 15
   Pro", "Galaxy S24 Ultra"). If my file only has a combined "Model +
   Storage + Color" description in one cell (e.g. "iPhone 15 Pro 256GB
   Black"), split it: put the model name here, the storage into Storage,
   and the color into Color.

4. Storage: our catalogue only ever stores GB-notation BELOW 1024 and
   TB-notation AT OR ABOVE 1024 — it never stores "1024GB" or "2048GB".
   Normalize to match:
      - A plain number under 1024, with or without "GB"/"G" — e.g.
        "64", "128G", "256 GB" → keep as GB form: "64GB", "128GB",
        "256GB". Remove all other text/units.
      - A value equal to 1024 in any GB spelling ("1024", "1024G",
        "1024GB", "1024 GB") → convert to "1TB".
      - A value equal to 2048 in any GB spelling ("2048", "2048GB", …)
        → convert to "2TB".
      - A value already given in TB ("1TB", "1 TB", "2TB") → keep as TB,
        just tidied to "1TB"/"2TB" (no space, uppercase TB).
   Do NOT do the reverse (do not expand an existing TB value out into a
   4/5-digit GB number) — that produces a value the catalogue can never
   match.

5. Color: just the color name, no extra text. Normalize obvious spelling
   variants (e.g. "Space Grey"/"Space Gray" → pick one consistently).

6. Grade: capture the vendor's own grade letter as literally as you can
   rather than guessing it away. Map common supplier terms as follows —
   "Grade A"/"Excellent"/"Like New" → A; "Grade B"/"Good" → B; "Grade C"/
   "Fair"/"Acceptable" → C; "Grade D"/"Poor" → D; "Grade E"/"Scrap"/"For
   Parts" → E. Only use UG when the file genuinely gives NO grade
   information at all for a row — never as a stand-in for a D or E you
   weren't sure how to map. A real vendor D or E must be passed through
   as literal D or E here, not coerced to UG in this cleanup step: our
   system has its own downstream policy for handling grades outside our
   internal A/B/C scale, and that policy needs to see the vendor's actual
   claim to record it correctly. If you had to ask me in Step 1 whether
   to apply one grade to everything, apply my answer; if I said grading
   happens later, leave this column blank for every row instead of
   defaulting to UG.

7. Description: short free-text label only — do not duplicate what's
   already captured in Model No./Storage/Color.

8. Condition: OPTIONAL — this column is a cross-check against Grade, not
   an independent input, so leave a row blank if the file simply doesn't
   say rather than asking me or guessing. Where you do fill it in, it
   must be exactly one of these four values (UPPERCASE):
      - RAW          — untested / as received, not yet inspected
      - USED         — tested/working, previously owned
      - REFURBISHED  — repaired/restored to a working standard
      - NEW          — unused, sealed (we rarely receive NEW stock, but
                       it is still a valid value — keep it as an option)
   Map common supplier wording as: "Raw"/"Untested"/"As-is"/"Bulk"/
   "Grade U" → RAW; "Used"/"Pre-owned"/"Second Hand"/"2nd Hand" → USED;
   "Refurb"/"Refurbished"/"Renewed"/"Reconditioned" → REFURBISHED; "New"/
   "Brand New"/"Sealed"/"Unused" → NEW. If a value doesn't clearly match
   one of these four, ask me rather than guessing — do not leave this
   column inconsistently filled.

9. Unit Cost: plain number only — no currency symbols, no thousands
   separators, no text. Leave blank if unknown (do not enter 0).

10. Currency: must be a valid 3-letter ISO 4217 currency code, UPPERCASE
    — e.g. GBP, USD, EUR, CNY, HKD, AED, JPY. Not a symbol ("$", "£", "€"),
    not a country name, not lowercase. If my file shows the currency
    inside the cost header instead of its own column (e.g. "Price (USD)"),
    extract that 3-letter code into this column. If you had to ask me for
    the currency in Step 1 because it wasn't in the file, apply my answer
    to every row that has a Unit Cost.
    STOP if you find more than one distinct currency across the rows
    (even after Step 1) — do not clean up and hand me back a single sheet
    mixing currencies. Tell me which rows are in which currency and ask
    me how to proceed; our system treats one uploaded manifest as having
    a single currency, so a mixed file needs to be split before upload,
    and that split is my call, not yours.

11. VAT Type: must be exactly one of these four values (uppercase, no
    others are accepted):
      - MARGIN   — margin scheme (VAT charged on profit margin only, the
                   standard scheme for used/second-hand phones)
      - STANDARD — standard-rated VAT (full VAT on the sale price)
      - ZERO     — zero-rated VAT
      - PVAT     — Postponed VAT (import VAT accounting for goods brought
                   into the country under postponed accounting)
    Map common supplier wording as: "Margin"/"Margin Scheme"/"2nd hand
    margin" → MARGIN; "Standard"/"Std"/"20%"/"Standard Rate" → STANDARD;
    "Zero"/"Zero Rate"/"0%"/"Exempt" → ZERO; "Postponed"/"PVA"/"Import
    VAT"/"Deferred VAT" → PVAT. If you had to ask me for the VAT type in
    Step 1 because it wasn't in the file, apply my answer to every row.

General cleanup:
- Remove any merged cells — unmerge and repeat the value into every
  affected row.
- Remove blank rows in the middle of the data.
- Remove trailing "Total"/"Summary"/"Count" rows at the bottom.
- One row = one physical device. If a row represents a quantity greater
  than 1 (e.g. a "Qty" column shows 5 for one IMEI-less line), do NOT
  duplicate it — flag it in the "Flag" column as "No IMEI — qty row" since
  every device needs its own unique IMEI to be received.
- Extra columns: if the file has other genuinely useful information
  beyond the 11 columns above (e.g. an invoice/PO number, a warehouse or
  batch code, a supplier's own line reference), keep it — but add it as
  its own column to the RIGHT of the 11 canonical headers, never
  interleaved between them and never renamed to look like one of the 11.
  Our upload tool only auto-maps columns it recognises by header name;
  anything past column 11 is simply ignored by the importer and left for
  me to read manually, so it's always safe to keep rather than delete.
  In particular, if the file's cost/header area names an invoice or PO
  number for this shipment, add it as its own operational column named
  "Invoice No." (one value repeated on every row if it's shipment-wide,
  or per-row if the file already varies it) — leave it out entirely if
  the file has no such reference; do not invent one.
- Put the cleaned result on a new sheet named "Manifest Import", with the
  11 canonical headers (plus any extra operational columns to their
  right, per the rule above) in row 1 and one device per row below, and
  nothing else on that sheet (no extra title rows, no summary rows, no
  merged cells).
- Add the "Flag" column only if any row still needed one after Step 1;
  otherwise omit it.

Show me a short summary at the end: total rows processed, how many were
flagged and why (broken out by flag reason, including duplicate IMEIs —
list their row numbers, do not just give a count of rows "removed" since
none should have been removed), and a breakdown of how many rows fell
into each Condition, each VAT Type, and each Currency.`;
  // Bill-vendor precedence (batch item 5): when a manifest upload has a
  // bill selected via #mf-bill, Supplier is pre-filled from THAT bill's
  // own vendor_name (already fetched into uploadCtx.openBills) and the
  // Supplier input is locked read-only — see #mf-sup's own comment.
  // Unlinking (back to "— no bill —") does NOT clear a manually-typed
  // supplier from before linking; it simply unlocks the field again.
  function applyBillVendorPrecedence() {
    if (uploadCtx.billId == null) return;
    const b = uploadCtx.openBills.find(x => x.id === uploadCtx.billId);
    if (b && b.vendor_name) uploadCtx.supplier = b.vendor_name;
  }
  async function openManifestUpload() {
    uploadCtx = {
      reference: '', supplier: '', notes: '',
      billId: null,    // optional link to an OPEN bill (0029) — empty is fine
      fileName: '',
      rawRows: [],     // every row of the sheet, including header
      headers: [],     // normalised header row (lowercased strings)
      headerIdx: -1,   // index of the detected header row in rawRows
      mapping: {},     // { fieldKey: columnIndex | -1 }
      rows: [],        // parsed rows (the payload we POST)
      showPrompt: false, // toggles the AI cleanup prompt preview panel
      openBills: [],   // GET /api/bills?status=draft — the picker's options
    };
    renderUploadModal();
    try {
      const r = await api.get('/bills?status=draft');
      uploadCtx.openBills = r.bills || [];
      renderUploadModal();
    } catch { /* picker just stays empty — bill link is optional */ }
  }
  function renderUploadModal() {
    const m = $('#upload-modal');
    if (m) m.remove();
    const modal = h('div', { id: 'upload-modal', class: 'modal-backdrop' },
      h('div', { class: 'modal p-6' },
        h('div', { class: 'flex items-center justify-between mb-4' },
          h('h2', { class: 'text-lg font-semibold' }, 'Upload Shipping Manifest'),
          h('button', { class: 'btn btn-ghost text-xs', onclick: () => $('#upload-modal').remove() },
            h('i', { class: 'fas fa-times' }))
        ),
        // ── AI cleanup prompt (Copilot in Excel / Claude in Excel) ──
        h('div', { class: 'card p-4 mb-4', style: 'border-color:#3b4a63' },
          h('div', { class: 'flex items-center justify-between gap-3' },
            h('div', { class: 'text-sm' },
              h('i', { class: 'fas fa-wand-magic-sparkles text-indigo-400 mr-2' }),
              h('span', { class: 'font-medium' }, 'Manifest in a different format? '),
              h('span', { class: 'text-slate-400' },
                'Copy this prompt into Copilot in Excel or Claude in Excel to reorganise it first.')
            ),
            h('div', { class: 'flex gap-2 shrink-0' },
              h('button', {
                class: 'btn btn-ghost text-xs',
                onclick: () => { uploadCtx.showPrompt = !uploadCtx.showPrompt; renderUploadModal(); },
              },
                h('i', { class: `fas fa-chevron-${uploadCtx.showPrompt ? 'up' : 'down'} mr-1` }),
                uploadCtx.showPrompt ? 'Hide prompt' : 'Show prompt'),
              h('button', {
                class: 'btn btn-primary text-xs',
                onclick: async () => {
                  const ok = await copyToClipboard(MANIFEST_CLEANUP_PROMPT);
                  if (ok) toast('Prompt copied', 'ok');
                  else toast('Clipboard unavailable — select and copy manually', 'warn');
                },
              },
                h('i', { class: 'fas fa-copy mr-1' }), 'Copy Prompt')
            )
          ),
          uploadCtx.showPrompt ? h('pre', {
            class: 'text-xs text-slate-400 mt-3 p-3 rounded-lg overflow-auto',
            style: 'max-height:260px; white-space:pre-wrap; background:#0d1520; border:1px solid #263449',
          }, MANIFEST_CLEANUP_PROMPT) : null
        ),
        h('div', { class: 'grid grid-cols-2 gap-3 mb-4' },
          h('div', {},
            h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Reference *'),
            h('input', {
              class: 'input mono', id: 'mf-ref', placeholder: 'e.g. ASN-2026-00123',
              value: uploadCtx.reference,
              oninput: (e) => uploadCtx.reference = e.target.value,
            })
          ),
          h('div', {},
            h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Supplier *'),
            h('input', {
              class: 'input', id: 'mf-sup', placeholder: 'e.g. LW001',
              value: uploadCtx.supplier,
              // Bill-vendor precedence: once a bill is linked (via #mf-bill
              // above), the Supplier field is FILLED FROM and LOCKED TO that
              // bill's own vendor_name — a linked bill's vendor is already an
              // authoritative fact, so letting the operator also free-type a
              // (possibly different) supplier name here would just create a
              // second, disagreeing source of truth for the same field.
              readonly: uploadCtx.billId != null ? 'readonly' : null,
              oninput: (e) => { if (uploadCtx.billId == null) uploadCtx.supplier = e.target.value; },
            }),
            uploadCtx.billId != null ? h('div', { class: 'text-[10px] text-slate-500 mt-1' },
              'Pre-filled from the linked bill\u2019s vendor \u2014 unlink the bill to edit.') : null
          )
        ),
        h('div', { class: 'mb-4' },
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Notes'),
          h('textarea', {
            class: 'input', id: 'mf-notes', rows: 2,
            value: uploadCtx.notes,
            oninput: (e) => uploadCtx.notes = e.target.value,
          })
        ),
        // Optional link to an OPEN bill (0029). Manifests carry the
        // itemisation, bills carry the header — this is a reconciliation
        // pointer only, never a source of manifest lines. Leaving it on
        // "— no bill —" is fully supported: goods received without a bill
        // must keep working exactly as before.
        h('div', { class: 'mb-4' },
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Link to bill (optional)'),
          h('select', {
            class: 'input', id: 'mf-bill',
            onchange: (e) => {
              uploadCtx.billId = e.target.value ? Number(e.target.value) : null;
              applyBillVendorPrecedence();
              renderUploadModal();
            },
          },
            // <select>'s `value` is a DOM property, not an HTML content
            // attribute — h()'s catch-all setAttribute('value', ...) is a
            // silent no-op for <select> (same class of gotcha its own
            // comment documents for <textarea>). renderUploadModal() tears
            // down and rebuilds this whole modal on every re-render (file
            // parse, mapping change, etc.), so relying on a `value` attr
            // here meant the picker visually snapped back to "— no bill —"
            // after ANY re-render even though uploadCtx.billId was still
            // correctly set underneath — a real, user-visible bug, not
            // just cosmetic. Fixed using this file's OWN established
            // pattern for stateful <select>s (see MAPPABLE_FIELDS' mkOpt
            // below): mark the matching <option> with `selected` directly.
            h('option', { value: '', ...(uploadCtx.billId == null ? { selected: 'selected' } : {}) }, '— no bill —'),
            ...uploadCtx.openBills.map(b => h('option', {
              value: String(b.id),
              ...(uploadCtx.billId === b.id ? { selected: 'selected' } : {}),
            },
              `${b.vendor_name || 'Unknown vendor'} · ${b.invoice_number || 'no ref'} · ${b.currency_code || 'GBP'} ${Number(b.declared_total ?? 0).toFixed(2)}`
            ))
          ),
          h('div', { class: 'text-[11px] text-slate-500 mt-1' },
            uploadCtx.openBills.length === 0
              ? 'No open bills found — this is fine for goods received without a bill.'
              : `${uploadCtx.openBills.length} open bill${uploadCtx.openBills.length === 1 ? '' : 's'} available.`)
        ),
        h('div', { class: 'dropzone rounded-xl p-8 text-center cursor-pointer mb-4',
          id: 'dz',
          onclick: () => $('#mf-file').click(),
          ondragover: (e) => { e.preventDefault(); $('#dz').classList.add('is-over'); },
          ondragleave: () => $('#dz').classList.remove('is-over'),
          ondrop: (e) => { e.preventDefault(); $('#dz').classList.remove('is-over'); handleFile(e.dataTransfer.files[0]); },
        },
          h('i', { class: 'fas fa-cloud-arrow-up text-3xl text-slate-500 mb-2' }),
          h('div', { class: 'text-sm text-slate-300' }, uploadCtx.fileName || 'Drop CSV or Excel file, or click to browse'),
          h('div', { class: 'text-xs text-slate-500 mt-1' }, 'CSV or Excel. Columns are auto-detected — you can remap any of them below.'),
          h('input', {
            type: 'file', id: 'mf-file', class: 'hidden',
            accept: '.csv,.xls,.xlsx',
            onchange: (e) => handleFile(e.target.files[0]),
          })
        ),
        // ── Column mapping panel ──
        uploadCtx.headers.length > 0 ? h('div', { class: 'card p-4 mb-4' },
          h('div', { class: 'flex items-center justify-between mb-3' },
            h('div', { class: 'text-sm font-medium' },
              h('i', { class: 'fas fa-columns text-slate-400 mr-2' }),
              'Column mapping'),
            h('div', { class: 'text-xs text-slate-500' },
              `Detected ${uploadCtx.headers.filter(Boolean).length} columns in row ${uploadCtx.headerIdx + 1}`)
          ),
          h('div', { class: 'grid grid-cols-2 md:grid-cols-3 gap-3' },
            MAPPABLE_FIELDS.map(f => {
              const cur = uploadCtx.mapping[f.key] ?? -1;
              const mkOpt = (val, label) => {
                const attrs = { value: String(val) };
                if (val === cur) attrs.selected = 'selected';
                return h('option', attrs, label);
              };
              return h('div', {},
                h('label', { class: 'text-xs text-slate-400 mb-1 block' }, f.label),
                h('select', {
                  class: 'input text-xs',
                  onchange: (e) => {
                    uploadCtx.mapping[f.key] = Number(e.target.value);
                    reparseFromMapping();
                    renderUploadModal();
                  },
                },
                  mkOpt(-1, '— not in file —'),
                  uploadCtx.headers.map((hd, idx) =>
                    mkOpt(idx, hd ? `${colLetter(idx)} · ${hd}` : `${colLetter(idx)} · (blank)`))
                ),
                h('div', { class: 'text-[10px] text-slate-500 mt-1' }, f.hint),
              );
            })
          ),
          // Warn if IMEI not mapped
          (uploadCtx.mapping.imei ?? -1) < 0
            ? h('div', { class: 'mt-3 text-xs text-amber-300 bg-amber-900/20 border border-amber-800/40 rounded px-3 py-2' },
                h('i', { class: 'fas fa-triangle-exclamation mr-2' }),
                'An IMEI column must be selected before this manifest can be created.')
            : null
        ) : null,
        uploadCtx.rows.length > 0 ? h('div', { class: 'mb-4' },
          h('div', { class: 'flex items-center justify-between mb-2' },
            h('div', { class: 'text-sm font-medium' },
              `Parsed ${uploadCtx.rows.length} devices`,
              h('span', { class: 'text-xs text-slate-400 ml-2' }, 'preview first 5'),
            ),
          ),
          h('div', { class: 'border border-slate-800 rounded-lg overflow-hidden' },
            h('table', { class: 'w-full text-xs' },
              h('thead', { class: 'bg-slate-900/50 text-slate-400' },
                h('tr', {},
                  h('th', { class: 'text-left px-3 py-2' }, 'OEM'),
                  h('th', { class: 'text-left px-3 py-2' }, 'Description'),
                  h('th', { class: 'text-left px-3 py-2' }, 'Storage'),
                  h('th', { class: 'text-left px-3 py-2' }, 'Color'),
                  h('th', { class: 'text-left px-3 py-2' }, 'Grade'),
                  h('th', { class: 'text-left px-3 py-2' }, 'Model No.'),
                  h('th', { class: 'text-left px-3 py-2' }, 'IMEI'),
                )
              ),
              h('tbody', { class: 'divide-y divide-slate-800' },
                uploadCtx.rows.slice(0, 5).map(r => h('tr', {},
                  h('td', { class: 'px-3 py-2' }, r.oem || '—'),
                  h('td', { class: 'px-3 py-2' }, r.description || '—'),
                  h('td', { class: 'px-3 py-2' }, r.capacity || '—'),
                  h('td', { class: 'px-3 py-2' }, r.color || '—'),
                  h('td', { class: 'px-3 py-2' }, r.grade || '—'),
                  h('td', { class: 'px-3 py-2 mono' }, r.model_no || '—'),
                  h('td', { class: 'px-3 py-2 mono' }, r.imei),
                ))
              )
            )
          )
        ) : null,
        h('div', { class: 'flex justify-end gap-2' },
          h('button', { class: 'btn btn-ghost', onclick: () => $('#upload-modal').remove() }, 'Cancel'),
          h('button', {
            class: 'btn btn-primary',
            onclick: submitManifest,
          }, h('i', { class: 'fas fa-check' }), `Create Manifest${uploadCtx.rows.length ? ` (${uploadCtx.rows.length})` : ''}`)
        )
      )
    );
    document.body.appendChild(modal);
    setTimeout(() => $('#mf-ref')?.focus(), 30);
  }

  // Spreadsheet column letter helper (0 → A, 25 → Z, 26 → AA…)
  function colLetter(i) {
    let s = '';
    let n = i;
    while (n >= 0) {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    }
    return s;
  }

  function handleFile(file) {
    if (!file) return;
    uploadCtx.fileName = file.name;
    // Default reference suggestion based on filename
    if (!uploadCtx.reference) {
      const base = file.name.replace(/\.(csv|xlsx|xls)$/i, '');
      uploadCtx.reference = `ASN-${base}`.slice(0, 64);
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
        // Detect header row + auto-map columns
        const { headerIdx, headers, mapping } = detectHeadersAndMapping(rows);
        uploadCtx.rawRows = rows;
        uploadCtx.headerIdx = headerIdx;
        uploadCtx.headers = headers;
        uploadCtx.mapping = mapping;
        uploadCtx.rows = applyMapping(rows, headerIdx, mapping);
        if (!uploadCtx.supplier) {
          // Try to grab supplier from filename
          const m = file.name.match(/-(.+?)_/);
          if (m) uploadCtx.supplier = m[1].trim();
        }
        if (headerIdx < 0) {
          toast('No header row found — pick the IMEI column manually', 'warn');
        } else {
          toast(`Parsed ${uploadCtx.rows.length} devices`, 'ok');
        }
        renderUploadModal();
      } catch (err) {
        console.error(err);
        toast('Failed to parse file', 'err');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // Re-derive parsed rows from the current mapping (called when the user
  // changes a column in the mapping panel).
  function reparseFromMapping() {
    if (!uploadCtx.rawRows.length) return;
    uploadCtx.rows = applyMapping(uploadCtx.rawRows, uploadCtx.headerIdx, uploadCtx.mapping);
  }

  // Find header row (first row that contains "imei", or the first non-empty
  // row if none found) and auto-detect each known field's column index.
  function detectHeadersAndMapping(rows) {
    if (!rows || !rows.length) {
      return { headerIdx: -1, headers: [], mapping: emptyMapping() };
    }
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const r = rows[i] || [];
      if (r.some(c => c && String(c).toLowerCase().trim() === 'imei')) {
        headerIdx = i; break;
      }
    }
    // Fallback: first non-empty row
    if (headerIdx < 0) {
      for (let i = 0; i < Math.min(rows.length, 15); i++) {
        const r = rows[i] || [];
        if (r.some(c => c != null && String(c).trim() !== '')) { headerIdx = i; break; }
      }
    }
    if (headerIdx < 0) return { headerIdx: -1, headers: [], mapping: emptyMapping() };
    const rawHeaders = rows[headerIdx] || [];
    const headers = rawHeaders.map(c => c == null ? '' : String(c).toLowerCase().trim());
    const find = (preds) => {
      for (let i = 0; i < headers.length; i++) {
        if (preds(headers[i], i)) return i;
      }
      return -1;
    };
    const mapping = {
      imei: find(h => h === 'imei' || h === 'imei1' || h === 'imei/sn' || h === 'serial' || h === 'sn'),
      oem: find(h => ['oem','brand','manufacturer','make'].includes(h)),
      description: find(h => ['description','desc','model','model name','product','product name','item'].includes(h)),
      grade: find(h => h === 'grade' || h === 'quality' || h === 'cosmetic grade'),
      model_no: find(h => ['model no.','model no','model number','model_no','model code','sku','part no','part number'].includes(h)),
      condition: find(h => h === 'condition' || h === 'status'),
      capacity: find(h => ['storage','capacity','memory','size','rom','gb'].includes(h)),
      color: find(h => ['color','colour'].includes(h)),
      unit_cost: find(h => ['unit cost','cost','price','unit_cost','unit price','buy price','buy_price'].includes(h)),
      currency: find(h => ['currency','curr','ccy'].includes(h)),
      vat_type: find(h => ['vat type','vat_type','vat','vat scheme'].includes(h)),
      currency_from_header: null,
    };
    // Supplier files often put the currency INSIDE the price header instead
    // of a separate column — e.g. "Price (USD)", "Unit Cost (GBP)". Recognise
    // those as the unit_cost column and infer the currency from the header.
    if (mapping.unit_cost < 0) {
      const priceCcy = /^(?:unit\s*)?(?:cost|price|buy\s*price|value)\s*[（(]\s*([a-z]{3})\s*[）)]$/;
      for (let i = 0; i < headers.length; i++) {
        const m = headers[i].match(priceCcy);
        if (m) {
          mapping.unit_cost = i;
          if (mapping.currency < 0) mapping.currency_from_header = m[1].toUpperCase();
          break;
        }
      }
    }
    // Heuristic: if grade isn't found but there's a 1-col gap between
    // description and model_no, that gap is usually an unnamed grade col.
    if (mapping.grade < 0 && mapping.description >= 0 && mapping.model_no >= 0
        && mapping.model_no - mapping.description === 2) {
      mapping.grade = mapping.description + 1;
    }
    return { headerIdx, headers, mapping };
  }

  function emptyMapping() {
    return { imei: -1, oem: -1, description: -1, grade: -1, model_no: -1,
             condition: -1, capacity: -1, color: -1, unit_cost: -1, currency: -1, vat_type: -1,
             currency_from_header: null };
  }

  // Apply a column-mapping to raw rows. Skips rows whose identifier isn't a
  // 15-digit IMEI or 10-char alphanumeric serial, so header noise and
  // trailing summary rows fall away.
  function applyMapping(rows, headerIdx, mapping) {
    if (!rows.length || headerIdx < 0 || (mapping.imei ?? -1) < 0) return [];
    const pick = (r, idx) => idx >= 0 ? (r[idx] ?? null) : null;
    const out = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const imeiVal = pick(r, mapping.imei);
      if (imeiVal == null || imeiVal === '') continue;
      const imei = String(imeiVal).trim();
      if (!/^\d{15}$/.test(imei) && !/^[A-Za-z0-9]{10}$/.test(imei)) continue;
      out.push({
        oem: pick(r, mapping.oem),
        condition: pick(r, mapping.condition),
        description: pick(r, mapping.description),
        grade: pick(r, mapping.grade),
        model_no: pick(r, mapping.model_no),
        capacity: pick(r, mapping.capacity),
        color: pick(r, mapping.color),
        imei,
        unit_cost: mapping.unit_cost >= 0 ? (Number(r[mapping.unit_cost]) || null) : null,
        currency: mapping.currency >= 0
          ? (String(pick(r, mapping.currency) || '').trim() || null)
          : (mapping.currency_from_header && mapping.unit_cost >= 0 && (Number(r[mapping.unit_cost]) || null) != null
              ? mapping.currency_from_header : null),
        vat_type: mapping.vat_type >= 0 ? (String(pick(r, mapping.vat_type) || '').trim() || null) : null,
      });
    }
    return out;
  }

  async function submitManifest() {
    if (!uploadCtx.reference || !uploadCtx.supplier) { toast('Reference and supplier are required', 'warn'); return; }
    if ((uploadCtx.mapping?.imei ?? -1) < 0) { toast('Map the IMEI column before continuing', 'warn'); return; }
    if (!uploadCtx.rows.length) { toast('No valid rows found in file', 'warn'); return; }
    try {
      const r = await api.post('/manifests', {
        reference: uploadCtx.reference,
        supplier: uploadCtx.supplier,
        notes: uploadCtx.notes,
        rows: uploadCtx.rows,
        bill_id: uploadCtx.billId,
      });
      const skipped = (r.invalid_valuations || []).length;
      toast(`Manifest created · ${r.count} devices loaded` +
        (skipped ? `<br><span class="text-xs">${skipped} row${skipped === 1 ? '' : 's'} skipped — bad price/currency/VAT (fix the file and re-upload, or receive those units without prefill)</span>` : ''),
        skipped ? 'warn' : 'ok', skipped ? 6000 : 3000);
      $('#upload-modal').remove();
      state.activeManifestId = r.manifest_id;
      await refreshManifests();
      render();
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to create manifest', 'err');
    }
  }

  // ───────── Receive (scan) view ─────────
  function ReceiveView() {
    // No manifests is no longer a dead end — operators can quick-receive
    // devices without an ASN/manifest at all.
    if (!state.manifests.length) {
      return h('div', { class: 'space-y-5' },
        h('div', { class: 'card p-10 text-center' },
          h('i', { class: 'fas fa-file-invoice text-5xl text-slate-700 mb-4' }),
          h('h2', { class: 'text-xl font-semibold mb-2' }, 'No manifests yet'),
          h('p', { class: 'text-slate-400 mb-4' },
            'You can upload a shipping manifest to scan against, or just receive devices directly without one.'),
          h('div', { class: 'flex gap-2 justify-center flex-wrap' },
            h('button', { class: 'btn btn-primary', onclick: () => switchView('manifests') },
              h('i', { class: 'fas fa-cloud-arrow-up' }), 'Upload Manifest'),
            h('button', {
              class: 'btn btn-ghost',
              onclick: () => { state.manualReceiveOpen = true; render(); }
            }, h('i', { class: 'fas fa-plus' }), 'Quick receive (no manifest)')
          )
          // Bulk scan needs an active manifest to receive against — not offered
          // in the zero-manifest empty state above.
        )
      );
    }

    const m = state.activeManifest;
    const pct = state.summary.expected_count
      ? Math.round((state.summary.received_count / state.summary.expected_count) * 100)
      : 0;

    return h('div', { class: 'grid grid-cols-12 gap-6' },
      // LEFT: Scan input + activity
      h('div', { class: 'col-span-12 lg:col-span-7 space-y-4' },
        // Manifest selector
        h('div', { class: 'card p-4 flex items-center gap-3' },
          h('div', { class: 'flex-1' },
            h('label', { class: 'text-[10px] uppercase tracking-wider text-slate-500' }, 'Active Manifest'),
            h('select', {
              class: 'input mt-1',
              onchange: async (e) => {
                state.activeManifestId = Number(e.target.value);
                await refreshActiveManifest();
                render();
              },
            },
              state.manifests.map(opt => h('option', {
                value: opt.id,
                selected: opt.id === state.activeManifestId ? 'selected' : null,
              }, `${opt.reference} · ${opt.supplier} · ${opt.received_count}/${opt.expected_count}`))
            )
          ),
          h('button', {
            class: 'btn btn-ghost text-xs',
            onclick: () => { state.manualReceiveOpen = true; render(); },
            title: 'Receive a device without a manifest',
          }, h('i', { class: 'fas fa-plus' }), 'Quick receive'),
          m ? h('button', {
            class: 'btn btn-ghost text-xs',
            onclick: () => { state.bulkScanOpen = true; render(); },
            title: 'Scan/paste many IMEIs at once and receive them in one shot',
          }, h('i', { class: 'fas fa-layer-group' }), 'Bulk scan') : null,
          m ? h('div', { class: 'text-right' },
            h('div', { class: 'text-3xl font-bold mono' },
              h('span', { class: 'text-cyan-300' }, state.summary.received_count),
              h('span', { class: 'text-slate-500 mx-1' }, '/'),
              h('span', {}, state.summary.expected_count)
            ),
            h('div', { class: 'progress w-48 mt-1' }, h('div', { style: `width:${pct}%` })),
            h('div', { class: 'text-xs text-slate-400 mt-1 mono' }, `${pct}% received`)
          ) : null,
        ),

        // ── Manifest → bill reconciliation (0029) ──
        // Manifests carry the itemisation, bills carry the header — this
        // is never a header-only false-green: with no bill linked (or an
        // unpriced manifest/bill) it reads "Awaiting manifest", resolving
        // to a real Balanced/Variance verdict only once linked and priced.
        m ? ManifestBillReconciliationBadge() : null,

        // Scan input
        h('div', { class: 'card scan-ring p-6' },
          h('div', { class: 'flex items-center justify-between mb-3' },
            h('div', { class: 'flex items-center gap-2 text-xs text-slate-400' },
              h('span', { class: 'dot bg-cyan-400' }),
              'Scanner ready — point your barcode scanner at any IMEI'
            ),
            h('div', { class: 'text-xs text-slate-500' },
              'Press ', h('span', { class: 'kbd' }, 'Esc'), ' to refocus'
            )
          ),
          h('input', {
            id: 'scan-input',
            class: 'input mono text-2xl py-5 text-center tracking-widest',
            placeholder: 'Scan IMEI…',
            autocomplete: 'off',
            autofocus: 'true',
            onkeydown: onScanKey,
            disabled: m?.status === 'closed' ? 'disabled' : null,
          }),
          m?.status === 'closed'
            ? h('div', { class: 'mt-3 text-xs text-amber-400 text-center' }, 'This manifest is closed. Reopen it to keep scanning.')
            : null,
        ),

        // Activity feed
        h('div', { class: 'card' },
          h('div', { class: 'px-4 py-3 border-b border-slate-800 flex items-center justify-between' },
            h('h3', { class: 'font-semibold text-sm' },
              h('i', { class: 'fas fa-bolt text-amber-400 mr-2' }), 'Recent scans'),
            h('div', { class: 'text-xs text-slate-500' }, `${state.events.length} events`)
          ),
          h('div', { class: 'max-h-72 overflow-auto' },
            state.events.length === 0
              ? h('div', { class: 'p-6 text-center text-sm text-slate-500' }, 'No scans yet. Start by scanning an IMEI.')
              : state.events.map(ev => {
                const cls = {
                  matched: 'badge-green', received: 'badge-cyan',
                  duplicate: 'badge-amber',
                  unreconciled: 'badge-red', rejected: 'badge-slate',
                }[ev.outcome] || 'badge-slate';
                return h('div', { class: 'flex items-center gap-3 px-4 py-2 border-b border-slate-800/50 row-strip' },
                  h('span', { class: 'badge ' + cls }, ev.outcome),
                  h('code', { class: 'mono text-xs flex-1' }, ev.imei),
                  ev.message ? h('span', { class: 'text-xs text-slate-400 truncate max-w-xs' }, ev.message) : null,
                  h('span', { class: 'text-xs text-slate-500 mono' }, new Date(ev.created_at.replace(' ','T') + 'Z').toLocaleTimeString())
                );
              })
          )
        )
      ),

      // RIGHT: Pending queue + unreconciled
      h('div', { class: 'col-span-12 lg:col-span-5 space-y-4' },
        h('div', { class: 'card' },
          h('div', { class: 'px-4 py-3 border-b border-slate-800 flex items-center justify-between' },
            h('h3', { class: 'font-semibold text-sm' },
              h('i', { class: 'fas fa-list-check text-cyan-400 mr-2' }), 'Pending Receipt Queue'),
            h('div', { class: 'text-xs text-slate-500' },
              `${state.expected.filter(e => e.status === 'pending').length} pending`)
          ),
          h('div', { class: 'max-h-[460px] overflow-auto' },
            state.expected.length === 0
              ? h('div', { class: 'p-6 text-center text-sm text-slate-500' }, 'No expected devices on this manifest.')
              : state.expected.map(e => h('div', {
                class: 'flex items-center gap-3 px-4 py-2 border-b border-slate-800/50 row-strip',
                id: `exp-${e.id}`,
              },
                e.status === 'received'
                  ? h('i', { class: 'fas fa-check-circle text-green-400 w-5 text-center' })
                  : h('i', { class: 'far fa-circle text-slate-600 w-5 text-center' }),
                h('div', { class: 'flex-1 min-w-0' },
                  h('div', { class: 'text-sm font-medium truncate' }, e.description || '(no description)'),
                  h('div', { class: 'text-xs text-slate-400 mono truncate' }, e.imei)
                ),
                e.grade ? h('span', { class: gradeBadgeClass(e.grade), title: gradeLabel(e.grade) }, e.grade) : null,
                e.status === 'received'
                  ? h('span', { class: 'badge badge-green text-[10px]' }, 'received')
                  : h('span', { class: 'badge badge-slate text-[10px]' }, 'pending')
              ))
          )
        ),
        state.unreconciled.length > 0 ? h('div', { class: 'card border-red-500/30' },
          h('div', { class: 'px-4 py-3 border-b border-slate-800 flex items-center justify-between' },
            h('h3', { class: 'font-semibold text-sm text-red-300' },
              h('i', { class: 'fas fa-triangle-exclamation mr-2' }), 'Unreconciled (manager review)'),
            h('div', { class: 'text-xs text-slate-500' }, `${state.unreconciled.length}`)
          ),
          h('div', { class: 'max-h-60 overflow-auto' },
            state.unreconciled.map(u => h('div', { class: 'px-4 py-2 border-b border-slate-800/50' },
              h('div', { class: 'text-sm font-medium' }, u.brand + ' ' + (u.model || '') + ' ' + (u.capacity || '')),
              h('div', { class: 'text-xs text-slate-400 mono' }, u.imei),
              h('div', { class: 'text-xs text-slate-500 mt-1' }, u.notes || '')
            ))
          )
        ) : null,
      )
    );
  }

  let lastScanAt = 0;
  async function onScanKey(e) {
    if (e.key === 'Escape') { e.target.value = ''; e.target.focus(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const imei = e.target.value.trim();
    e.target.value = '';
    if (!imei) return;
    if (Date.now() - lastScanAt < 100) return;  // double-fire guard
    lastScanAt = Date.now();
    if (!state.activeManifestId) { toast('Select a manifest first', 'warn'); return; }

    // Optimistic UI: pulse the input
    const box = $('#scan-input');
    box?.classList.remove('scan-pulse');
    void box?.offsetWidth;
    box?.classList.add('scan-pulse');

    try {
      const r = await api.post('/scan', { manifest_id: state.activeManifestId, imei });
      if (r.outcome === 'matched') {
        // Two cases:
        //  - catalog_match.status === 'match'  → green path, SKU is locked from catalogue
        //  - status === 'no_match' | 'ambiguous' → red banner with candidates; operator
        //    can edit fields (live re-lookup) or mint a new catalog row
        beep(r.catalog_match?.status === 'match' ? 'ok' : 'warn');
        state.pendingMatch = { expected: r.expected, catalog_match: r.catalog_match };
        render();
      } else if (r.outcome === 'duplicate') {
        beep('warn');
        toast(`Already received: <span class="mono">${imei}</span><br><span class="text-xs text-slate-400">SKU ${r.received.sku} · UUID ${r.received.uuid}</span>`, 'warn', 3500);
      } else if (r.outcome === 'unreconciled') {
        beep('warn');
        box?.classList.add('warn-pulse');
        setTimeout(() => box?.classList.remove('warn-pulse'), 1000);
        state.pendingUnrec = { imei };
        render();
      } else if (r.outcome === 'rejected') {
        beep('err');
        toast(r.message || 'Rejected', 'err');
      }
    } catch (err) {
      toast('Scan failed: ' + (err.response?.data?.error || err.message), 'err');
    }
  }

  // ───────── Confirm SKU modal (matched scan) ─────────
  // The catalog is the source of truth. Backend response shape:
  //   { outcome: 'matched', expected, catalog_match: { status, row?, candidates?, reason? } }
  // - status === 'match'     → green path; SKU is read-only with "from catalogue" badge.
  // - status === 'no_match'  → red banner; show candidates the operator can pick from,
  //                            edit fields for live re-lookup, or mint a new catalog row.
  // - status === 'ambiguous' → red banner; multiple matches — operator must pick one.
  function ConfirmSkuModal() {
    const { expected, catalog_match } = state.pendingMatch;

    // Seed ctx. Priority: persisted edits > catalog row (if matched) > expected manifest fields.
    if (!state._confirmCtx) {
      const cm = catalog_match || {};
      const matchRow = cm.status === 'match' ? cm.row : null;
      state._confirmCtx = {
        // SKU is only meaningful when we have a catalogue match
        sku: matchRow?.sku || '',
        brand: matchRow?.brand || expected.oem || '',
        model: matchRow?.model || expected.model_no || expected.description || '',
        capacity: matchRow?.capacity || expected.capacity || '',
        color: matchRow?.color || expected.color || '',
        grade: matchRow?.grade || expected.grade || 'UG',
        notes: '',
        // Valuation/VAT (Priority 4) — required server-side on /scan/confirm.
        // PRE-FILLED from the manifest line when the supplier file carried
        // them (0015) — hints only; the operator confirms/overrides here.
        buy_price: expected.unit_cost != null ? String(expected.unit_cost) : '',
        currency: expected.currency || 'GBP',
        vat_type: expected.vat_type || '',
        supplier_id: '',
        // Live lookup state — re-resolved as operator edits fields below
        live: cm,            // { status, row?, candidates?, reason? }
        liveBusy: false,
      };
    }
    const ctx = state._confirmCtx;
    const live = ctx.live || { status: 'no_match', candidates: [], reason: 'No match' };
    const matched = live.status === 'match';

    const close = () => { state.pendingMatch = null; state._confirmCtx = null; render(); };

    // Re-resolve via POST /catalog/lookup whenever the operator edits a field.
    // Debounced via a sequence counter so a slow earlier request can't overwrite
    // a later one.
    let lookupSeq = (state._lookupSeq || 0);
    const reLookup = async () => {
      state._lookupSeq = ++lookupSeq;
      const mySeq = lookupSeq;
      ctx.liveBusy = true;
      try {
        const r = await api.post('/catalog/lookup', {
          model: ctx.model, capacity: ctx.capacity, color: ctx.color, grade: ctx.grade,
        });
        if (mySeq !== state._lookupSeq) return; // a later edit superseded us
        ctx.live = r;
        if (r.status === 'match') ctx.sku = r.row.sku;
        else ctx.sku = '';
      } catch (err) {
        // ignore — leave previous result in place
      } finally {
        if (mySeq === state._lookupSeq) ctx.liveBusy = false;
        render();
      }
    };

    const update = (k, v) => {
      ctx[k] = v;
      state._confirmCtx = ctx;
      if (['model', 'capacity', 'color', 'grade'].includes(k)) {
        reLookup();
      } else {
        render();
      }
    };

    // Pick one of the candidate rows — copies its fields back into ctx.
    const pickCandidate = (row) => {
      ctx.sku = row.sku;
      ctx.brand = row.brand;
      ctx.model = row.model;
      ctx.capacity = row.capacity || '';
      ctx.color = row.color || '';
      ctx.grade = row.grade || 'UG';
      ctx.live = { status: 'match', row };
      state._confirmCtx = ctx;
      render();
    };

    // Pick a candidate AND apply its SKU to every other pending line on this
    // manifest sharing the same (model, capacity, color, grade) signature —
    // avoids repeating "Use this" one device at a time for a batch of
    // identical units. Uses the CURRENT manifest line as the signature
    // source (source_expected_device_id) rather than re-deriving it from the
    // editable fields, so it can't accidentally widen to an unrelated line.
    const applyBatchBusy = { current: false };
    const pickCandidateForBatch = async (row) => {
      if (applyBatchBusy.current) return;
      applyBatchBusy.current = true;
      pickCandidate(row);
      try {
        const r = await api.post(`/manifests/${state.activeManifestId}/apply-sku-to-batch`, {
          sku: row.sku,
          source_expected_device_id: expected.id,
        });
        if (r.applied > 0) {
          toast(`Applied <span class="mono">${r.sku}</span> to ${r.applied} other pending line${r.applied === 1 ? '' : 's'} in this batch`, 'ok');
          await refreshActiveManifest();
          render();
        } else {
          toast('No other pending lines share this signature', 'warn');
        }
      } catch (err) {
        toast(err.response?.data?.error || 'Failed to apply SKU to batch', 'err');
      } finally {
        applyBatchBusy.current = false;
      }
    };

    // Mint a new catalogue row from the current fields, then continue receiving.
    const addToCatalogAndReceive = async () => {
      try {
        const r = await api.post('/catalog', {
          brand: ctx.brand, model: ctx.model,
          capacity: ctx.capacity, color: ctx.color, grade: ctx.grade,
        });
        toast(`Added <span class="mono">${r.row.sku}</span> to catalogue`, 'ok');
        ctx.sku = r.row.sku;
        ctx.live = { status: 'match', row: r.row };
        state._confirmCtx = ctx;
        render();
        // Receive immediately — keeps the historical default of queueing a
        // label (the two-button choice applies on the normal confirm path).
        await confirmIt(true);
      } catch (err) {
        const data = err.response?.data;
        if (data?.existing) {
          // Server says this combination already exists — adopt it
          toast('Combination already in catalogue — using existing SKU', 'warn');
          pickCandidate(data.existing);
        } else {
          toast(data?.error || 'Failed to add to catalogue', 'err');
        }
      }
    };

    // withPrint decides whether the server queues a print label for this
    // receive — printing is OPTIONAL (owner request 2026-07-28): the modal
    // offers "Confirm only" (withPrint=false) and "Confirm & Print"
    // (withPrint=true) as two explicit buttons instead of a checkbox.
    const confirmIt = async (withPrint) => {
      if (!ctx.sku) { toast('No catalogue SKU — pick a candidate or add to catalogue first', 'warn'); return; }
      // Optimistic client-side checks only — the server (Priority 4/5) is the
      // authoritative validator and will 422 with a specific message if these
      // are missing or malformed; this just saves an obviously-wasted round trip.
      if (ctx.buy_price === '' || ctx.buy_price == null) { toast('Buy price is required', 'warn'); return; }
      if (!ctx.vat_type) { toast('VAT type is required', 'warn'); return; }
      try {
        const r = await api.post('/scan/confirm', {
          expected_device_id: expected.id,
          sku: ctx.sku, brand: ctx.brand, model: ctx.model,
          capacity: ctx.capacity, color: ctx.color, grade: ctx.grade,
          notes: ctx.notes, auto_print: withPrint === true,
          buy_price: ctx.buy_price, currency: ctx.currency || 'GBP', vat_type: ctx.vat_type,
          supplier_id: ctx.supplier_id ? Number(ctx.supplier_id) : undefined,
        });
        toast(`Received <span class="mono">${r.received.imei}</span> · ${r.received.sku}${withPrint === true ? ' · 🖨️ label queued' : ' · no label'}`, 'ok');
        beep('ok');
        state.pendingMatch = null; state._confirmCtx = null;
        // Flash the just-received row
        await refreshActiveManifest();
        render();
        const row = $(`#exp-${expected.id}`);
        if (row) { row.classList.add('row-ok-flash'); setTimeout(() => row.classList.remove('row-ok-flash'), 1500); }
        // Show label preview only when a label was actually queued
        if (withPrint === true && r.print_job_id) {
          state.labelPreview = { jobId: r.print_job_id, payload: {
            uuid: r.received.uuid, sku: r.received.sku, imei: r.received.imei,
            brand: r.received.brand, model: r.received.model,
            capacity: r.received.capacity, color: r.received.color, grade: r.received.grade,
          }};
          render();
          // Auto-close preview after 2.5s
          setTimeout(() => { if (state.labelPreview?.jobId === r.print_job_id) { state.labelPreview = null; render(); } }, 2500);
        }
      } catch (err) {
        const data = err.response?.data;
        if (data?.code === 'sku_not_in_catalog') {
          toast(`SKU ${ctx.sku} not in catalogue — re-resolve or add it first`, 'err');
          reLookup();
        } else {
          toast(data?.error || 'Failed to confirm', 'err');
        }
      }
    };

    // ── Header (state-dependent: green if matched, red if not) ──
    const headerIcon = matched
      ? h('div', { class: 'w-10 h-10 rounded-xl bg-green-500/10 text-green-400 flex items-center justify-center' },
          h('i', { class: 'fas fa-check' }))
      : h('div', { class: 'w-10 h-10 rounded-xl bg-red-500/10 text-red-400 flex items-center justify-center' },
          h('i', { class: 'fas fa-triangle-exclamation' }));
    const headerTitle = matched
      ? h('h2', { class: 'text-lg font-semibold' }, 'Matched on manifest')
      : h('h2', { class: 'text-lg font-semibold text-red-300' },
          live.status === 'ambiguous' ? 'Multiple catalogue matches' : 'No catalogue SKU');
    const headerSub = matched
      ? h('p', { class: 'text-xs text-slate-400' },
          'SKU resolved from the catalogue. Confirm to receive and print the label.')
      : h('p', { class: 'text-xs text-slate-400' },
          'Pick a candidate below, tweak the fields to re-resolve, or add a new catalogue entry.');

    // ── Live status banner ──
    const banner = matched
      ? h('div', { class: 'mt-3 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/30 text-xs text-green-200 flex items-center gap-2' },
          h('i', { class: 'fas fa-circle-check' }),
          h('span', {}, 'Catalogue SKU '),
          h('span', { class: 'mono font-semibold text-green-100' }, ctx.sku),
          h('span', { class: 'badge badge-green text-[10px] ml-auto' }, 'from catalogue'))
      : h('div', { class: 'mt-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200' },
          h('i', { class: 'fas fa-triangle-exclamation mr-2' }),
          h('span', {}, live.reason || 'No catalogue SKU for this combination.'),
          ctx.liveBusy ? h('span', { class: 'ml-2 text-slate-400' }, h('i', { class: 'fas fa-spinner fa-spin mr-1' }), 're-resolving…') : null
        );

    // ── Candidate picker (only when not matched) ──
    const candidates = (!matched && Array.isArray(live.candidates) && live.candidates.length > 0)
      ? h('div', { class: 'mt-3 card p-3 bg-slate-900/40' },
          h('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500 mb-2' },
            `Closest catalogue rows (${live.candidates.length})`),
          h('div', { class: 'max-h-40 overflow-y-auto divide-y divide-slate-800' },
            live.candidates.slice(0, 30).map(row => h('div', {
              class: 'flex items-center justify-between gap-3 py-2 px-1 hover:bg-slate-800/40 rounded',
            },
              h('div', { class: 'flex-1 min-w-0' },
                h('div', { class: 'mono text-sm text-cyan-300' }, row.sku),
                h('div', { class: 'text-[11px] text-slate-400 truncate' },
                  [row.brand, row.model, row.capacity, row.color, `grade ${row.grade || '?'}`].filter(Boolean).join(' · '))
              ),
              h('div', { class: 'flex gap-1.5 flex-shrink-0' },
                h('button', { class: 'btn btn-ghost text-[11px]', onclick: () => pickCandidate(row) },
                  h('i', { class: 'fas fa-check' }), 'Use this'),
                h('button', {
                  class: 'btn btn-ghost text-[11px]',
                  onclick: () => pickCandidateForBatch(row),
                  title: 'Apply this SKU to every other pending line on this manifest with the same model/capacity/color/grade',
                },
                  h('i', { class: 'fas fa-layer-group' }), 'Use for all in batch')
              )
            ))
          )
        )
      : null;

    return h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target.classList.contains('modal-backdrop')) close(); } },
      h('div', { class: 'modal p-6' + (matched ? '' : ' border-2 border-red-500/30') },
        h('div', { class: 'flex items-center gap-3 mb-1' },
          headerIcon,
          h('div', {}, headerTitle, headerSub)
        ),
        banner,
        // Manifest line / IMEI summary card
        h('div', { class: 'mt-4 grid grid-cols-3 gap-3 text-sm' },
          h('div', { class: 'col-span-2 card p-3 bg-slate-900/40' },
            h('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500 mb-1' }, 'Manifest line'),
            h('div', { class: 'font-medium' },
              expected.model_no || expected.description || '(no model)'),
            h('div', { class: 'text-xs text-slate-400 mt-1' },
              h('span', {}, expected.oem || '—'),
              ' · ', h('span', { class: 'mono' }, expected.capacity || '?'),
              ' · ', expected.color || '?',
              ' · grade ', gradeLabel(expected.grade))
          ),
          h('div', { class: 'card p-3 bg-slate-900/40' },
            h('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500 mb-1' }, 'IMEI'),
            h('div', { class: 'mono font-semibold' }, expected.imei)
          )
        ),
        // Candidate picker (only if not matched)
        candidates,
        // SKU display (read-only when matched; hidden until we have one when not)
        h('div', { class: 'mt-4' },
          h('label', { class: 'text-xs text-slate-400 mb-1 block flex items-center gap-2' },
            h('span', {}, matched ? 'Catalogue SKU' : 'SKU (resolved from catalogue)'),
            matched ? h('span', { class: 'badge badge-green text-[10px]' }, 'from catalogue') : null
          ),
          h('input', {
            class: 'input mono text-lg font-bold' + (matched ? ' opacity-90' : ' text-slate-500'),
            value: ctx.sku || '(no match yet — edit fields below to re-resolve)',
            readonly: 'readonly',
            tabindex: '-1',
          })
        ),
        // Editable lookup fields — change any of these to trigger live re-lookup
        h('div', { class: 'mt-3 grid grid-cols-2 gap-3' },
          field('Brand', ctx.brand, (v) => update('brand', v)),
          field('Model *', ctx.model, (v) => update('model', v)),
          field('Capacity *', ctx.capacity, (v) => update('capacity', v), 'mono'),
          field('Color *', ctx.color, (v) => update('color', v)),
          h('div', {},
            h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Grade *'),
            gradeSelect(ctx.grade || 'UG', (v) => update('grade', v))
          ),
          // (Auto-queue checkbox removed 2026-07-28 — replaced by the explicit
          // "Confirm only" / "Confirm & Print" footer buttons.)
        ),
        // Valuation / VAT (Priority 4) — required server-side on confirm.
        h('div', { class: 'mt-3 card p-3 bg-slate-900/40' },
          h('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500 mb-2' }, 'Valuation & VAT'),
          h('div', { class: 'grid grid-cols-3 gap-3' },
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Buy price *'),
              h('input', {
                id: 'confirm-buy-price', class: 'input mono', type: 'number', step: '0.01', min: '0',
                value: ctx.buy_price, placeholder: '0.00',
                oninput: (e) => { ctx.buy_price = e.target.value; state._confirmCtx = ctx; },
              })
            ),
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Currency'),
              h('input', {
                id: 'confirm-currency', class: 'input mono uppercase', maxlength: 3, value: ctx.currency || 'GBP',
                oninput: (e) => { ctx.currency = e.target.value.toUpperCase(); state._confirmCtx = ctx; },
              })
            ),
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'VAT type *'),
              h('select', {
                id: 'confirm-vat-type', class: 'input',
                onchange: (e) => { ctx.vat_type = e.target.value; state._confirmCtx = ctx; },
              },
                h('option', { value: '', selected: !ctx.vat_type ? 'selected' : null }, '— select —'),
                ['MARGIN', 'STANDARD', 'ZERO', 'PVAT'].map(v =>
                  h('option', { value: v, selected: v === ctx.vat_type ? 'selected' : null }, v))
              )
            ),
          ),
          h('div', { class: 'mt-2' },
            h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Supplier ID (optional)'),
            h('input', {
              class: 'input mono', type: 'number', min: '1', value: ctx.supplier_id,
              placeholder: 'Leave blank if unknown',
              oninput: (e) => { ctx.supplier_id = e.target.value; state._confirmCtx = ctx; },
            })
          ),
        ),
        // Optional notes
        h('div', { class: 'mt-3' },
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Notes (optional)'),
          h('textarea', { class: 'input', rows: 2, value: ctx.notes,
            oninput: (e) => { ctx.notes = e.target.value; state._confirmCtx = ctx; } })
        ),
        // Footer
        h('div', { class: 'mt-5 flex items-center justify-between' },
          h('div', { class: 'text-xs text-slate-500' },
            'Press ', h('span', { class: 'kbd' }, 'Esc'), ' to cancel'),
          h('div', { class: 'flex gap-2' },
            h('button', { class: 'btn btn-ghost', onclick: close }, 'Cancel'),
            !matched
              ? h('button', { class: 'btn btn-amber', onclick: addToCatalogAndReceive,
                  title: 'Mint a new catalogue row for this combination, then receive' },
                  h('i', { class: 'fas fa-plus' }), 'Add to catalogue & receive')
              : null,
            // Printing is optional (owner request 2026-07-28): "Confirm only"
            // receives WITHOUT queueing a label; "Confirm & Print" also queues one.
            h('button', {
              id: 'confirm-only-btn',
              class: 'btn ' + (matched ? 'btn-ghost border border-slate-600' : 'btn-ghost opacity-50 cursor-not-allowed'),
              onclick: () => confirmIt(false),
              disabled: !matched ? 'disabled' : null,
              title: 'Receive the device without queueing a print label',
            },
              h('i', { class: 'fas fa-check' }), 'Confirm only'),
            h('button', {
              id: 'confirm-receive-btn',
              class: 'btn ' + (matched ? 'btn-primary' : 'btn-ghost opacity-50 cursor-not-allowed'),
              onclick: () => confirmIt(true),
              disabled: !matched ? 'disabled' : null,
              title: 'Receive the device and queue a print label',
            },
              h('i', { class: 'fas fa-print' }), 'Confirm & Print')
          )
        )
      )
    );
  }
  function field(label, val, oninput, extra='') {
    return h('div', {},
      h('label', { class: 'text-xs text-slate-400 mb-1 block' }, label),
      h('input', { class: 'input ' + extra, value: val || '', oninput: (e) => oninput(e.target.value) })
    );
  }

  // ───────── Unreconciled modal ─────────
  function UnreconciledModal() {
    const { imei } = state.pendingUnrec;
    const ctx = state._unrecCtx ||= { oem: 'SMSG', description: '', grade: 'UG', color: 'Phantom Black', notes: '',
      buy_price: '', currency: 'GBP', vat_type: '' };
    const close = () => { state.pendingUnrec = null; state._unrecCtx = null; render(); };
    const reject = async () => {
      await api.post('/scan/reject', { manifest_id: state.activeManifestId, imei, reason: 'Not on manifest — rejected by operator' });
      toast('Device rejected', 'warn');
      state.pendingUnrec = null; state._unrecCtx = null;
      await refreshActiveManifest(); render();
    };
    const forceAdd = async () => {
      // Optimistic client-side checks only — the server enforces the same
      // valuation rules on /scan/force-add as on /scan/confirm (422 with a
      // specific message); this just saves an obviously-wasted round trip.
      if (ctx.buy_price === '' || ctx.buy_price == null) { toast('Buy price is required', 'warn'); return; }
      if (!ctx.vat_type) { toast('VAT type is required', 'warn'); return; }
      try {
        const r = await api.post('/scan/force-add', {
          manifest_id: state.activeManifestId, imei, ...ctx,
          currency: ctx.currency || 'GBP',
        });
        toast(`Force-added <span class="mono">${imei}</span> · ${r.received.sku}<br><span class="text-xs text-amber-300">Pending manager review</span>`, 'warn', 3500);
        state.pendingUnrec = null; state._unrecCtx = null;
        await refreshActiveManifest(); render();
      } catch (err) {
        toast(err.response?.data?.error || 'Failed to force-add', 'err');
      }
    };
    const update = (k,v) => { ctx[k]=v; state._unrecCtx = ctx; render(); };
    return h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target.classList.contains('modal-backdrop')) close(); } },
      h('div', { class: 'modal p-6 border-2 border-red-500/30' },
        h('div', { class: 'flex items-center gap-3 mb-3' },
          h('div', { class: 'w-10 h-10 rounded-xl bg-red-500/10 text-red-400 flex items-center justify-center' },
            h('i', { class: 'fas fa-triangle-exclamation' })),
          h('div', {},
            h('h2', { class: 'text-lg font-semibold' }, 'IMEI not on manifest'),
            h('p', { class: 'text-xs text-slate-400' }, 'Reject the device, or force-add it to the Unreconciled bucket for manager review.')
          )
        ),
        h('div', { class: 'card p-3 bg-slate-900/40 mt-3' },
          h('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500 mb-1' }, 'Scanned IMEI'),
          h('div', { class: 'mono text-xl font-bold' }, imei)
        ),
        h('div', { class: 'mt-4 grid grid-cols-2 gap-3' },
          field('OEM', ctx.oem, (v) => update('oem', v)),
          field('Description (best guess)', ctx.description, (v) => update('description', v), 'placeholder:text-slate-600'),
          h('div', {},
            h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Color'),
            h('select', { class: 'input', onchange: (e) => update('color', e.target.value) },
              ['Phantom Black','Phantom Gray','Graphite','Cream','Lavender','Violet','Mint','Cloud Navy','Silver','White'].map(o =>
                h('option', { value: o, selected: o === ctx.color ? 'selected' : null }, o)))
          ),
          h('div', {},
            h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Grade'),
            gradeSelect(ctx.grade || 'UG', (v) => update('grade', v))
          ),
        ),
        // Valuation & VAT — required on force-add exactly like the manifest
        // confirm path; the exception branch is not a required-field bypass.
        h('div', { class: 'card p-3 bg-slate-900/40 mt-3', id: 'unrec-valuation' },
          h('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500 mb-2' },
            h('i', { class: 'fas fa-sterling-sign mr-1' }), 'Valuation & VAT (required)'),
          h('div', { class: 'grid grid-cols-3 gap-3' },
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Buy price *'),
              h('input', {
                class: 'input mono', id: 'unrec-buy-price', type: 'number', step: '0.01', min: '0',
                value: ctx.buy_price, placeholder: '0.00',
                oninput: (e) => { ctx.buy_price = e.target.value; state._unrecCtx = ctx; },
              })
            ),
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Currency'),
              h('input', {
                class: 'input mono uppercase', id: 'unrec-currency', maxlength: 3, value: ctx.currency || 'GBP',
                oninput: (e) => { ctx.currency = e.target.value.toUpperCase(); state._unrecCtx = ctx; },
              })
            ),
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'VAT type *'),
              h('select', {
                class: 'input', id: 'unrec-vat-type',
                onchange: (e) => { ctx.vat_type = e.target.value; state._unrecCtx = ctx; },
              },
                h('option', { value: '', selected: !ctx.vat_type ? 'selected' : null }, '— select —'),
                ['MARGIN', 'STANDARD', 'ZERO', 'PVAT'].map(v =>
                  h('option', { value: v, selected: v === ctx.vat_type ? 'selected' : null }, v))
              )
            ),
          ),
        ),
        h('div', { class: 'mt-3' },
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Notes for manager'),
          h('textarea', { class: 'input', rows: 2, value: ctx.notes, oninput: (e) => update('notes', e.target.value) })
        ),
        h('div', { class: 'mt-5 flex justify-end gap-2' },
          h('button', { class: 'btn btn-danger', onclick: reject }, h('i', { class: 'fas fa-ban' }), 'Reject Device'),
          h('button', { class: 'btn btn-ghost', onclick: close }, 'Cancel'),
          h('button', { class: 'btn btn-primary', id: 'unrec-force-add-btn', onclick: forceAdd },
            h('i', { class: 'fas fa-plus' }), 'Force-add to Unreconciled')
        )
      )
    );
  }

  // ───────── Label preview ─────────
  const LABEL_SIZES = {
    large: { id: 'large', name: 'DYMO 57×32mm', printer: 'DYMO LabelWriter 450' },
    small: { id: 'small', name: 'DYMO 32×57mm', printer: 'DYMO LabelWriter 450' },
  };

  function LabelPreviewModal() {
    const lp = state.labelPreview;
    const sizeInfo = LABEL_SIZES[state.labelSize] || LABEL_SIZES.large;
    return h('div', { class: 'modal-backdrop', onclick: () => { state.labelPreview = null; render(); } },
      h('div', { class: 'modal p-6 max-w-md', onclick: (e) => e.stopPropagation() },
        h('div', { class: 'flex items-center justify-between mb-4' },
          h('h2', { class: 'text-lg font-semibold' },
            h('i', { class: 'fas fa-print mr-2 text-indigo-400' }), 'Label sent to printer'),
          h('button', { class: 'btn btn-ghost text-xs', onclick: () => { state.labelPreview = null; render(); } },
            h('i', { class: 'fas fa-times' }))
        ),
        h('div', { class: 'flex justify-center min-h-[240px] items-center' }, renderLabel(lp.payload, `lbl-${lp.jobId}`, state.labelSize)),
        h('div', { class: 'mt-4 text-center text-xs text-slate-400' },
          `${sizeInfo.printer} · ${sizeInfo.name} · Job #${lp.jobId}`,
          h('br'),
          'In production this is sent via PrintNode / QZ Tray to the warehouse printer.')
      )
    );
  }

  function renderLabel(p, canvasId, size) {
    size = size || state.labelSize || 'large';
    const isSmall = size === 'small';
    const wrap = h('div', { class: 'label-preview ' + (isSmall ? 'label-small' : 'label-large') });
    const mainQrPx = isSmall ? 100 : 90;
    const imeiQrPx = isSmall ? 88 : 70;
    const mainQrId = canvasId + '-main';
    const imeiQrId = canvasId + '-imei';

    if (isSmall) {
      // DYMO 32×57mm — portrait orientation, stacked layout
      // Real ratio 32:57 ≈ 0.561; preview at 200x356
      const subtitle = p.brand || '';
      const variant = [p.capacity, p.color].filter(Boolean).join(' · ');
      wrap.appendChild(h('div', { class: 'dymo-header' },
        h('div', { class: 'dymo-brand' }, 'GOODS IN'),
        p.grade ? h('div', { class: 'dymo-grade' }, p.grade) : null,
      ));
      wrap.appendChild(h('div', { class: 'dymo-sku' }, p.sku));
      if (subtitle) wrap.appendChild(h('div', { class: 'dymo-sub' }, subtitle));
      if (variant) wrap.appendChild(h('div', { class: 'dymo-variant' }, variant));
      // Main QR (uuid + sku + imei) — caption shows the actual UUID value
      wrap.appendChild(h('div', { class: 'dymo-qr' },
        h('canvas', { id: mainQrId, width: mainQrPx, height: mainQrPx })
      ));
      wrap.appendChild(h('div', { class: 'dymo-qr-cap mono' }, p.uuid));
      // Dedicated IMEI QR
      wrap.appendChild(h('div', { class: 'dymo-imei-block' },
        h('canvas', { id: imeiQrId, width: imeiQrPx, height: imeiQrPx }),
        h('div', { class: 'dymo-imei-num mono' }, p.imei),
        h('div', { class: 'dymo-imei-cap' }, 'IMEI')
      ));
    } else {
      // DYMO 57×32mm — landscape, two-column with dual QRs
      // Left: SKU + brand info on top, IMEI QR + IMEI digits below
      // Right: Main QR (UUID/SKU/IMEI), UUID, grade
      wrap.appendChild(h('div', { class: 'lg-left' },
        h('div', {},
          h('div', { class: 'lg-sku' }, p.sku),
          h('div', { class: 'lg-sub' }, [p.brand, p.capacity, p.color].filter(Boolean).join(' · '))
        ),
        h('div', { class: 'lg-imei-block' },
          h('canvas', { id: imeiQrId, width: imeiQrPx, height: imeiQrPx }),
          h('div', { class: 'lg-imei-side' },
            h('div', { class: 'lg-imei-cap' }, 'IMEI'),
            h('div', { class: 'lg-imei-num mono' }, p.imei)
          )
        ),
      ));
      wrap.appendChild(h('div', { class: 'lg-right' },
        h('canvas', { id: mainQrId, width: mainQrPx, height: mainQrPx }),
        h('div', { class: 'lg-uuid mono' }, p.uuid),
        p.grade ? h('div', { class: 'lg-grade' }, p.grade) : null,
      ));
    }

    // Render both QR codes after DOM insertion (uses QRious library)
    setTimeout(() => {
      const mainCanvas = document.getElementById(mainQrId);
      const imeiCanvas = document.getElementById(imeiQrId);
      if (!window.QRious) {
        console.error('QRious library not loaded');
        return;
      }
      if (mainCanvas) {
        const payload = JSON.stringify({ uuid: p.uuid, sku: p.sku, imei: p.imei });
        new QRious({ element: mainCanvas, value: payload, size: mainQrPx, level: 'M', background: '#fff', foreground: '#000' });
      }
      if (imeiCanvas) {
        // IMEI-only QR — plain text so a basic IMEI-only barcode scanner reads it cleanly
        new QRious({ element: imeiCanvas, value: p.imei, size: imeiQrPx, level: 'M', background: '#fff', foreground: '#000' });
      }
    }, 30);
    return wrap;
  }

  // ───────── Inventory ─────────
  function InventoryView() {
    const selected = state.inventorySelected;
    const allIds = state.inventory.map(d => d.id);
    const allSelected = allIds.length > 0 && allIds.every(id => selected.has(id));
    const someSelected = selected.size > 0;

    const toggleOne = (id) => {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      render();
    };
    const toggleAll = () => {
      if (allSelected) selected.clear();
      else allIds.forEach(id => selected.add(id));
      render();
    };

    return h('div', { class: 'space-y-5' },
      h('div', { class: 'flex items-center justify-between flex-wrap gap-3' },
        h('div', {},
          h('h1', { class: 'text-2xl font-bold' }, 'Inventory'),
          h('p', { class: 'text-slate-400 text-sm' }, 'Devices that have been physically received. Grade overrides write to the audit log.')
        ),
        h('div', { class: 'flex gap-2 items-center flex-wrap' },
          h('button', {
            class: 'btn btn-primary text-xs',
            onclick: () => { state.manualReceiveOpen = true; render(); },
            title: 'Receive a device without a manifest',
          }, h('i', { class: 'fas fa-plus' }), 'Quick receive'),
          h('input', {
            class: 'input', placeholder: 'Search IMEI / SKU / UUID',
            oninput: (e) => debouncedSearch(e.target.value),
          }),
        )
      ),

      // Bulk action toolbar (visible whenever rows are selected)
      someSelected ? h('div', { class: 'card p-3 bg-cyan-500/5 border border-cyan-500/30 flex items-center gap-3 flex-wrap' },
        h('div', { class: 'text-sm font-medium text-cyan-200' },
          h('i', { class: 'fas fa-square-check mr-1' }),
          `${selected.size} selected`
        ),
        h('div', { class: 'flex items-center gap-2 text-xs' },
          h('span', { class: 'text-slate-400' }, 'Set grade to:'),
          ...GRADES.map(g => h('button', {
            class: 'btn btn-ghost text-xs',
            onclick: () => bulkSetGrade(g),
          }, gradeLabel(g))),
        ),
        h('button', {
          class: 'btn btn-ghost text-xs ml-auto',
          onclick: () => { selected.clear(); render(); },
        }, 'Clear selection')
      ) : null,

      h('div', { class: 'card overflow-hidden' },
        h('table', { class: 'w-full text-sm' },
          h('thead', { class: 'bg-slate-900/50 text-xs uppercase text-slate-400' },
            h('tr', {},
              h('th', { class: 'px-3 py-3 w-8' },
                h('input', {
                  type: 'checkbox',
                  class: 'accent-cyan-500',
                  checked: allSelected ? 'checked' : null,
                  onchange: toggleAll,
                  title: allSelected ? 'Deselect all' : 'Select all',
                })
              ),
              h('th', { class: 'text-left px-4 py-3' }, 'UUID'),
              h('th', { class: 'text-left px-4 py-3' }, 'IMEI'),
              h('th', { class: 'text-left px-4 py-3' }, 'SKU'),
              h('th', { class: 'text-left px-4 py-3' }, 'Device'),
              h('th', { class: 'text-left px-4 py-3' }, 'Grade'),
              h('th', { class: 'text-left px-4 py-3' }, 'Source'),
              h('th', { class: 'text-left px-4 py-3' }, 'Received'),
              h('th', { class: 'text-left px-4 py-3' }, 'Label'),
              h('th', { class: 'text-right px-4 py-3' }, '')
            )
          ),
          h('tbody', { class: 'divide-y divide-slate-800' },
            state.inventory.length === 0
              ? h('tr', {}, h('td', { colspan: 10, class: 'text-center py-10 text-slate-500' }, 'No devices yet.'))
              : state.inventory.map(d => h('tr', { class: 'row-strip ' + (selected.has(d.id) ? 'bg-cyan-500/5' : '') },
                h('td', { class: 'px-3 py-2' },
                  h('input', {
                    type: 'checkbox',
                    class: 'accent-cyan-500',
                    checked: selected.has(d.id) ? 'checked' : null,
                    onchange: () => toggleOne(d.id),
                  })
                ),
                h('td', { class: 'px-4 py-2 mono text-xs text-slate-300' }, d.uuid),
                h('td', { class: 'px-4 py-2 mono text-xs' }, d.imei),
                h('td', { class: 'px-4 py-2 mono text-xs font-semibold text-cyan-300' }, d.sku),
                h('td', { class: 'px-4 py-2 text-xs' },
                  h('div', { class: 'font-medium' }, [d.brand, d.model].filter(Boolean).join(' ')),
                  h('div', { class: 'text-slate-500' }, [d.capacity, d.color].filter(Boolean).join(' · '))
                ),
                // Grade: inline dropdown override (writes one audit row per change)
                h('td', { class: 'px-4 py-2' },
                  gradeSelect(d.grade || 'UG', (v) => singleSetGrade(d, v), {
                    class: 'input mono text-xs py-1 px-2 w-28',
                    title: 'Change grade (writes audit log)',
                  })
                ),
                h('td', { class: 'px-4 py-2' },
                  d.source === 'manifest'
                    ? h('span', { class: 'badge badge-green text-[10px]' }, 'manifest')
                    : d.source === 'manual'
                      ? h('span', { class: 'badge badge-cyan text-[10px]' }, 'manual')
                      : h('span', { class: 'badge badge-red text-[10px]' }, 'unreconciled')),
                h('td', { class: 'px-4 py-2 text-xs text-slate-400' }, fmtDate(d.created_at)),
                h('td', { class: 'px-4 py-2 text-xs' },
                  d.label_printed_at
                    ? h('span', { class: 'badge badge-green text-[10px]' },
                        h('i', { class: 'fas fa-check mr-1' }), 'printed')
                    : h('span', { class: 'badge badge-amber text-[10px]' }, 'queued')),
                h('td', { class: 'px-4 py-2 text-right' },
                  h('button', {
                    class: 'btn btn-danger text-xs',
                    title: 'Delete received device — manifest line will be restored to pending',
                    onclick: () => openDeleteDeviceModal(d),
                  }, h('i', { class: 'fas fa-trash' })))
              ))
          )
        )
      )
    );
  }

  // ───────── Grade override (single + bulk) ─────────
  async function singleSetGrade(device, newGrade) {
    if (device.grade === newGrade) return;
    try {
      const r = await api.post('/inventory/grade', {
        ids: [device.id],
        grade: newGrade,
        actor: 'operator',
        reason: 'Inline override from Inventory grid',
      });
      if (r.updated_count > 0) {
        toast(`<span class="mono">${device.imei}</span> · ${gradeLabel(device.grade)} → ${gradeLabel(newGrade)}`, 'ok');
        await refreshInventory(); render();
      } else {
        toast('No change applied', 'warn');
      }
    } catch (err) {
      toast('Failed to update grade: ' + (err.response?.data?.error || err.message), 'err');
    }
  }

  async function bulkSetGrade(newGrade) {
    const ids = Array.from(state.inventorySelected);
    if (!ids.length) return;
    if (!confirm(`Set ${ids.length} device${ids.length === 1 ? '' : 's'} to grade "${gradeLabel(newGrade)}"?\nThis writes one audit log row per device.`)) return;
    try {
      const r = await api.post('/inventory/grade', {
        ids,
        grade: newGrade,
        actor: 'operator',
        reason: `Bulk grade override (${ids.length} devices)`,
      });
      toast(
        `Updated <b>${r.updated_count}</b> · skipped ${r.skipped.length}` +
        (r.bulk_id ? `<br><span class="text-xs text-slate-400 mono">${r.bulk_id}</span>` : ''),
        'ok', 3500
      );
      state.inventorySelected.clear();
      await refreshInventory(); render();
    } catch (err) {
      toast('Bulk update failed: ' + (err.response?.data?.error || err.message), 'err');
    }
  }

  // Delete-device confirmation modal
  function openDeleteDeviceModal(d) {
    state.deleteDevice = d;
    render();
  }
  function DeleteDeviceModal() {
    const d = state.deleteDevice;
    const close = () => { state.deleteDevice = null; render(); };
    const doDelete = async () => {
      try {
        const r = await api.del(`/inventory/${d.id}`);
        toast(
          `Deleted <span class="mono">${d.imei}</span>` +
            (r.restored_expected ? '<br><span class="text-xs text-slate-400">Manifest line restored to pending</span>' : ''),
          'warn'
        );
        state.deleteDevice = null;
        await Promise.all([refreshInventory(), refreshActiveManifest(), refreshStats()]);
        render();
      } catch (err) {
        toast(err.response?.data?.error || 'Failed to delete', 'err');
      }
    };
    return h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target.classList.contains('modal-backdrop')) close(); } },
      h('div', { class: 'modal p-6 max-w-md border border-red-500/30' },
        h('div', { class: 'flex items-center gap-3 mb-3' },
          h('div', { class: 'w-10 h-10 rounded-xl bg-red-500/10 text-red-400 flex items-center justify-center' },
            h('i', { class: 'fas fa-triangle-exclamation' })),
          h('div', {},
            h('h2', { class: 'text-lg font-semibold' }, 'Delete received device?'),
            h('p', { class: 'text-xs text-slate-400' }, 'This removes the device from inventory and any queued label.')
          )
        ),
        h('div', { class: 'card p-3 bg-slate-900/40 mt-3 space-y-1' },
          h('div', { class: 'flex justify-between text-xs' },
            h('span', { class: 'text-slate-500' }, 'UUID'),
            h('span', { class: 'mono' }, d.uuid)),
          h('div', { class: 'flex justify-between text-xs' },
            h('span', { class: 'text-slate-500' }, 'IMEI'),
            h('span', { class: 'mono font-semibold' }, d.imei)),
          h('div', { class: 'flex justify-between text-xs' },
            h('span', { class: 'text-slate-500' }, 'SKU'),
            h('span', { class: 'mono font-semibold text-cyan-300' }, d.sku)),
          h('div', { class: 'flex justify-between text-xs' },
            h('span', { class: 'text-slate-500' }, 'Source'),
            h('span', {}, d.source)),
        ),
        d.source === 'manifest'
          ? h('div', { class: 'mt-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-200' },
              h('i', { class: 'fas fa-circle-info mr-2' }),
              'The manifest line will be restored to pending so this IMEI can be scanned again.')
          : d.source === 'manual'
            ? h('div', { class: 'mt-3 p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-xs text-cyan-200' },
                h('i', { class: 'fas fa-circle-info mr-2' }),
                'This was added via Quick receive (no manifest). Deletion is permanent.')
            : h('div', { class: 'mt-3 p-3 rounded-lg bg-slate-800/40 border border-slate-700/40 text-xs text-slate-400' },
                h('i', { class: 'fas fa-circle-info mr-2' }),
                'This was force-added (unreconciled). Deletion is permanent.'),
        h('div', { class: 'mt-5 flex justify-end gap-2' },
          h('button', { class: 'btn btn-ghost', onclick: close }, 'Cancel'),
          h('button', { class: 'btn btn-danger', onclick: doDelete },
            h('i', { class: 'fas fa-trash' }), 'Delete Device')
        )
      )
    );
  }

  // ───────── Manual receive modal (no manifest required) ─────────
  // Lets the operator enter an IMEI + pick/define a SKU and book the device
  // straight into inventory with source='manual'. Used when there's no
  // manifest for the incoming pallet, or for one-off receives.
  function ManualReceiveModal() {
    const ctx = state._manualCtx ||= {
      imei: '',
      sku_pick: '',         // chosen sku_code from catalogue (empty = custom)
      brand: '',
      model: '',
      capacity: '',
      color: 'Phantom Black',
      grade: 'UG',
      notes: '',
      buy_price: '', currency: 'GBP', vat_type: '',
    };
    const close = () => {
      state.manualReceiveOpen = false;
      state._manualCtx = null;
      render();
    };
    const update = (k, v) => { ctx[k] = v; state._manualCtx = ctx; render(); };

    // When the operator picks a catalogue SKU, prefill the brand/model/capacity/color fields.
    const onPickSku = (sku) => {
      ctx.sku_pick = sku;
      if (sku) {
        const row = state.catalog.find(c => c.sku === sku);
        if (row) {
          ctx.brand = row.brand;
          ctx.model = row.model;
          ctx.capacity = row.capacity || '';
          ctx.color = row.color || ctx.color;
        }
      }
      state._manualCtx = ctx; render();
    };

    const submit = async () => {
      const imei = ctx.imei.trim();
      if (!/^\d{15}$/.test(imei) && !/^[A-Za-z0-9]{10}$/.test(imei)) { toast('IMEI must be strictly 15 digits (or a 10-character alphanumeric serial for non-cellular devices)', 'warn'); return; }
      // Optimistic client-side checks only — the server enforces the same
      // valuation rules on /scan/manual as on /confirm and /force-add.
      if (ctx.buy_price === '' || ctx.buy_price == null) { toast('Buy price is required', 'warn'); return; }
      if (!ctx.vat_type) { toast('VAT type is required', 'warn'); return; }
      try {
        const body = {
          imei,
          grade: ctx.grade,
          notes: ctx.notes || null,
          auto_print: state.autoPrint,
          buy_price: ctx.buy_price, currency: ctx.currency || 'GBP', vat_type: ctx.vat_type,
        };
        if (ctx.sku_pick) {
          // Use catalogue SKU as-is. Server will enrich brand/model/etc.
          body.sku = ctx.sku_pick;
        } else {
          // Custom row — send fields and let the server derive a SKU.
          body.brand = ctx.brand;
          body.model = ctx.model;
          body.capacity = ctx.capacity;
          body.color = ctx.color;
        }
        const r = await api.post('/scan/manual', body);
        toast(
          `Received <span class="mono">${r.received.imei}</span> · ${r.received.sku}` +
          (state.autoPrint ? ' · 🖨️ label queued' : ''),
          'ok'
        );
        beep('ok');
        close();
        await Promise.all([refreshInventory(), refreshPrint(), refreshStats()]);
        render();
        if (state.autoPrint && r.print_job_id) {
          state.labelPreview = { jobId: r.print_job_id, payload: {
            uuid: r.received.uuid, sku: r.received.sku, imei: r.received.imei,
            brand: r.received.brand, model: r.received.model,
            capacity: r.received.capacity, color: r.received.color, grade: r.received.grade,
          }};
          render();
          setTimeout(() => { if (state.labelPreview?.jobId === r.print_job_id) { state.labelPreview = null; render(); } }, 2500);
        }
      } catch (err) {
        toast(err.response?.data?.error || 'Failed to receive', 'err');
      }
    };

    // Lazy-load catalog the first time the modal opens so the SKU dropdown
    // has something to show.
    if (state.catalog.length === 0) {
      refreshCatalog().then(render);
    }

    return h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target.classList.contains('modal-backdrop')) close(); } },
      h('div', { class: 'modal p-6 max-w-xl' },
        h('div', { class: 'flex items-center gap-3 mb-3' },
          h('div', { class: 'w-10 h-10 rounded-xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center' },
            h('i', { class: 'fas fa-plus' })),
          h('div', {},
            h('h2', { class: 'text-lg font-semibold' }, 'Quick receive (no manifest)'),
            h('p', { class: 'text-xs text-slate-400' }, 'Add a device straight to inventory. Source will be marked "manual".')
          )
        ),

        h('div', { class: 'mt-3' },
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'IMEI *'),
          h('input', {
            class: 'input mono text-lg tracking-widest text-center', autofocus: 'true',
            placeholder: 'Scan or type IMEI…',
            value: ctx.imei,
            oninput: (e) => update('imei', e.target.value),
            onkeydown: (e) => { if (e.key === 'Enter') submit(); },
          })
        ),

        h('div', { class: 'mt-3' },
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'SKU — pick from catalogue'),
          h('select', {
            class: 'input mono',
            onchange: (e) => onPickSku(e.target.value),
          },
            h('option', { value: '' }, '— enter brand/model below instead —'),
            state.catalog.map(c => h('option', {
              value: c.sku,
              selected: c.sku === ctx.sku_pick ? 'selected' : null,
            }, `${c.sku} · ${c.brand} ${c.model}${c.capacity ? ' ' + c.capacity : ''}`))
          ),
          h('div', { class: 'text-[11px] text-slate-500 mt-1' },
            state.catalog.length === 0
              ? 'Catalogue is empty — fill brand/model/capacity below to derive a SKU.'
              : 'Pick a known SKU, or leave as "— enter brand/model below —" to define a new one inline.')
        ),

        // Per-field fallback (used when no SKU is picked, or to override picked one)
        h('div', { class: 'mt-3 grid grid-cols-2 gap-3' },
          field('Brand', ctx.brand, (v) => update('brand', v)),
          field('Model', ctx.model, (v) => update('model', v)),
          field('Capacity', ctx.capacity, (v) => update('capacity', v), 'mono'),
          h('div', {},
            h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Color'),
            h('select', { class: 'input', onchange: (e) => update('color', e.target.value) },
              ['Phantom Black','Phantom Gray','Graphite','Cream','Lavender','Violet','Mint','Cloud Navy','Silver','White'].map(o =>
                h('option', { value: o, selected: o === ctx.color ? 'selected' : null }, o)))
          ),
          h('div', {},
            h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Grade'),
            gradeSelect(ctx.grade, (v) => update('grade', v))
          ),
          h('label', { class: 'flex items-center gap-2 text-sm text-slate-300 select-none mt-6' },
            h('input', { type: 'checkbox', class: 'accent-cyan-500', checked: state.autoPrint ? 'checked' : null,
              onchange: (e) => { state.autoPrint = e.target.checked; } }),
            'Auto-queue print label'
          ),
        ),

        // Valuation & VAT — required on manual receive exactly like the
        // confirm and force-add paths; quick receive is not a bypass.
        h('div', { class: 'card p-3 bg-slate-900/40 mt-3', id: 'manual-valuation' },
          h('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500 mb-2' },
            h('i', { class: 'fas fa-sterling-sign mr-1' }), 'Valuation & VAT (required)'),
          h('div', { class: 'grid grid-cols-3 gap-3' },
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Buy price *'),
              h('input', {
                class: 'input mono', id: 'manual-buy-price', type: 'number', step: '0.01', min: '0',
                value: ctx.buy_price, placeholder: '0.00',
                oninput: (e) => { ctx.buy_price = e.target.value; state._manualCtx = ctx; },
              })
            ),
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Currency'),
              h('input', {
                class: 'input mono uppercase', id: 'manual-currency', maxlength: 3, value: ctx.currency || 'GBP',
                oninput: (e) => { ctx.currency = e.target.value.toUpperCase(); state._manualCtx = ctx; },
              })
            ),
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'VAT type *'),
              h('select', {
                class: 'input', id: 'manual-vat-type',
                onchange: (e) => { ctx.vat_type = e.target.value; state._manualCtx = ctx; },
              },
                h('option', { value: '', selected: !ctx.vat_type ? 'selected' : null }, '— select —'),
                ['MARGIN', 'STANDARD', 'ZERO', 'PVAT'].map(v =>
                  h('option', { value: v, selected: v === ctx.vat_type ? 'selected' : null }, v))
              )
            ),
          ),
        ),

        h('div', { class: 'mt-3' },
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Notes (optional)'),
          h('textarea', { class: 'input', rows: 2, value: ctx.notes, oninput: (e) => update('notes', e.target.value) })
        ),

        h('div', { class: 'mt-5 flex justify-end gap-2' },
          h('button', { class: 'btn btn-ghost', onclick: close }, 'Cancel'),
          h('button', { class: 'btn btn-primary', id: 'manual-receive-btn', onclick: submit },
            h('i', { class: 'fas fa-check' }), 'Receive & Print')
        )
      )
    );
  }

  // ───────── Bulk scan modal ─────────
  // Paste/scan many IMEIs at once against the active manifest and receive
  // them in one POST /scan/bulk call. Deliberately conservative: only IMEIs
  // that are on the manifest, still pending, and resolve to EXACTLY ONE
  // catalogue SKU (trusting a pre-filled expected_devices.sku from "Use for
  // all in batch", or falling back to the normal model/capacity/color/grade
  // match) get received automatically. Anything else (no match, ambiguous,
  // duplicate, off-manifest, malformed) is reported back per-IMEI so the
  // operator can fix those individually through the normal single-scan flow.
  function BulkScanModal() {
    const ctx = state._bulkCtx ||= {
      raw: '',              // textarea contents — one IMEI per line (or whitespace-separated)
      buy_price: '', currency: 'GBP', vat_type: '', supplier_id: '',
      busy: false,
      // Cumulative outcome per IMEI across ALL runs in this modal session,
      // keyed by imei — NOT replaced by the latest run's response. A bulk
      // scan is typically iterative (run → pick SKUs for the failures → run
      // again for just the outstanding ones), and re-sending an
      // already-received IMEI on a later run correctly comes back as
      // 'duplicate' from the server — replacing the whole results view with
      // that later run alone would make previously-received devices look
      // like they vanished / were never received. Map preserves insertion
      // order so rows stay in first-seen order across runs.
      resultsByImei: new Map(),
    };
    const close = () => { state.bulkScanOpen = false; state._bulkCtx = null; render(); };

    const parsedImeis = () => parseBulkImeis(ctx.raw).unique;

    // Outcomes that mean "nothing left to do here" — stripped from the
    // textarea after a run so a follow-up click only resends IMEIs that
    // still need action (a fix, or simply haven't been tried yet).
    const isSettled = (outcome) => outcome === 'received' || outcome === 'duplicate';

    const run = async (imeisOverride) => {
      const imeis = imeisOverride || parsedImeis();
      if (imeis.length === 0) { toast('Nothing to scan — add an IMEI or you\u2019re all done', 'warn'); return; }
      if (imeis.length > BULK_IMEI_CAP) { toast(`${imeis.length} unique IMEIs — maximum is ${BULK_IMEI_CAP} per batch. Split into smaller batches.`, 'warn'); return; }
      if (!imeisOverride) {
        const parsed = parseBulkImeis(ctx.raw);
        if (parsed.duplicates > 0) {
          toast(`${parsed.raw} lines pasted/scanned, ${parsed.duplicates} duplicate${parsed.duplicates === 1 ? '' : 's'} removed — sending ${imeis.length} unique IMEI${imeis.length === 1 ? '' : 's'}`, 'warn', 5000);
        }
      }
      if (ctx.buy_price === '' || ctx.buy_price == null) { toast('Buy price is required — it applies to every device received in this batch', 'warn'); return; }
      if (!ctx.vat_type) { toast('VAT type is required', 'warn'); return; }
      ctx.busy = true; state._bulkCtx = ctx; render();
      try {
        const r = await api.post('/scan/bulk', {
          manifest_id: state.activeManifestId,
          imeis,
          buy_price: ctx.buy_price, currency: ctx.currency || 'GBP', vat_type: ctx.vat_type,
          supplier_id: ctx.supplier_id ? Number(ctx.supplier_id) : undefined,
          auto_print: state.autoPrint,
        });
        // Merge this run's per-IMEI outcomes into the cumulative map — see
        // comment on resultsByImei above for why this must be a merge, not
        // a replace.
        for (const row of r.results) ctx.resultsByImei.set(row.imei, row);
        // Drop settled IMEIs from the textarea so the next click (whether
        // "Receive batch" again or an auto-retry after picking a SKU below)
        // only resends what's still outstanding.
        ctx.raw = parsedImeis().filter(i => !isSettled(ctx.resultsByImei.get(i)?.outcome)).join('\n');
        beep(r.failed === 0 ? 'ok' : (r.received === 0 ? 'err' : 'warn'));
        toast(`This run: ${r.received} received, ${r.failed} not received (of ${r.requested} scanned)`,
          r.failed === 0 ? 'ok' : 'warn', 4000);
        await refreshActiveManifest();
        await Promise.all([refreshPrint().catch(() => {}), refreshStats().catch(() => {})]);
      } catch (err) {
        toast(err.response?.data?.error || 'Bulk scan failed', 'err');
      } finally {
        ctx.busy = false; state._bulkCtx = ctx; render();
      }
    };

    // Apply a suggested SKU (from a no_match/ambiguous row's candidates) to
    // this manifest line AND every other pending line sharing the same
    // signature — same call the single-scan Confirm-SKU modal's "Use for
    // all in batch" button makes — then immediately re-scan every IMEI
    // still outstanding so the now-resolved lines get received without a
    // second manual click.
    const applyBusy = { current: false };
    const useSuggestedSku = async (row, candidate) => {
      if (applyBusy.current) return;
      applyBusy.current = true;
      render();
      try {
        const r = await api.post(`/manifests/${state.activeManifestId}/apply-sku-to-batch`, {
          sku: candidate.sku,
          source_expected_device_id: row.expected_device_id,
        });
        toast(`Applied <span class="mono">${r.sku}</span> to ${r.applied} pending line${r.applied === 1 ? '' : 's'} — re-scanning…`, 'ok');
        await run(parsedImeis());
      } catch (err) {
        toast(err.response?.data?.error || 'Failed to apply SKU', 'err');
      } finally {
        applyBusy.current = false;
        render();
      }
    };

    // Outcome badge styling mirrors the Recent scans feed on the main Receive view.
    const outcomeCls = {
      received: 'badge-cyan', duplicate: 'badge-amber', unreconciled: 'badge-red',
      rejected: 'badge-slate', no_match: 'badge-red', ambiguous: 'badge-red', error: 'badge-red',
    };

    const allResults = Array.from(ctx.resultsByImei.values());
    const totalReceived = allResults.filter(r => r.outcome === 'received').length;
    const totalOutstanding = allResults.length - totalReceived;

    const resultsPanel = allResults.length > 0 ? h('div', { class: 'mt-4 card p-3 bg-slate-900/40' },
      h('div', { class: 'flex items-center justify-between mb-2' },
        h('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500' }, 'Progress (all runs this session)'),
        h('div', { class: 'text-xs' },
          h('span', { class: 'text-green-400 font-semibold' }, totalReceived), ' received · ',
          h('span', { class: 'text-red-400 font-semibold' }, totalOutstanding), ' outstanding',
          ' (of ', allResults.length, ' scanned)')
      ),
      h('div', { class: 'max-h-64 overflow-y-auto divide-y divide-slate-800' },
        allResults.map(r => h('div', { class: 'py-1.5 px-1 text-xs' },
          h('div', { class: 'flex items-center gap-3' },
            h('span', { class: 'badge ' + (outcomeCls[r.outcome] || 'badge-slate') }, r.outcome),
            h('code', { class: 'mono flex-1' }, r.imei),
            r.sku ? h('span', { class: 'mono text-cyan-300' }, r.sku) : null,
            r.message ? h('span', { class: 'text-slate-400 truncate max-w-xs' }, r.message) : null
          ),
          // Suggested-SKU picker — only for rows the server returned
          // candidates for (no_match / ambiguous), same idea as the
          // Confirm-SKU modal's candidate list.
          (Array.isArray(r.candidates) && r.candidates.length > 0) ? h('div', {
            class: 'mt-1.5 ml-1 pl-2 border-l border-slate-700 flex flex-wrap gap-1.5',
          },
            r.candidates.slice(0, 5).map(cand => h('button', {
              class: 'btn btn-ghost text-[11px]' + (applyBusy.current ? ' opacity-50 cursor-not-allowed' : ''),
              disabled: applyBusy.current ? 'disabled' : null,
              onclick: () => useSuggestedSku(r, cand),
              title: `${cand.brand} ${cand.model} ${cand.capacity || ''} ${cand.color || ''} · grade ${cand.grade || '?'}`,
            },
              h('i', { class: 'fas fa-layer-group' }),
              h('span', { class: 'mono' }, cand.sku), ' — use for batch')
            )
          ) : null
        ))
      )
    ) : null;

    return h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target.classList.contains('modal-backdrop')) close(); } },
      h('div', { class: 'modal p-6 max-w-2xl' },
        h('div', { class: 'flex items-center gap-3 mb-1' },
          h('div', { class: 'w-10 h-10 rounded-xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center' },
            h('i', { class: 'fas fa-layer-group' })),
          h('div', {},
            h('h2', { class: 'text-lg font-semibold' }, 'Bulk scan'),
            h('p', { class: 'text-xs text-slate-400' },
              `Scan or paste many IMEIs (one per line) — up to ${BULK_IMEI_CAP} unique per batch. IMEIs that resolve to exactly one catalogue SKU are received automatically. Anything else appears below with suggested SKUs you can apply to the whole batch — pick one and the outstanding IMEIs are re-scanned automatically. Duplicate lines are merged and always reported, never silently dropped.`)
          )
        ),

        h('div', { class: 'mt-3' },
          h('label', { class: 'text-xs text-slate-400 mb-1 block flex items-center justify-between' },
            h('span', {}, 'IMEIs *'),
            (() => {
              const p = parseBulkImeis(ctx.raw);
              return p.duplicates > 0
                ? h('span', { class: 'text-amber-400' }, `${p.raw} pasted, ${p.duplicates} duplicate${p.duplicates === 1 ? '' : 's'} removed — ${p.unique.length} unique`)
                : h('span', { class: 'text-slate-500' }, `${p.unique.length} unique IMEI${p.unique.length === 1 ? '' : 's'}`);
            })()
          ),
          h('textarea', {
            id: 'bulk-scan-textarea',
            class: 'input mono text-sm',
            rows: 8,
            autofocus: 'true',
            placeholder: 'Scan IMEIs here, one per line…',
            value: ctx.raw,
            oninput: (e) => { ctx.raw = e.target.value; state._bulkCtx = ctx; render(); },
          })
        ),

        // Shared valuation — applies to EVERY device received in this batch,
        // same required-fields rule as the single confirm/manual/force-add paths.
        h('div', { class: 'mt-3 card p-3 bg-slate-900/40' },
          h('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500 mb-2' },
            h('i', { class: 'fas fa-sterling-sign mr-1' }), 'Valuation & VAT — shared across this whole batch'),
          h('div', { class: 'grid grid-cols-3 gap-3' },
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Buy price *'),
              h('input', {
                id: 'bulk-buy-price', class: 'input mono', type: 'number', step: '0.01', min: '0',
                value: ctx.buy_price, placeholder: '0.00',
                oninput: (e) => { ctx.buy_price = e.target.value; state._bulkCtx = ctx; },
              })
            ),
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Currency'),
              h('input', {
                id: 'bulk-currency', class: 'input mono uppercase', maxlength: 3, value: ctx.currency || 'GBP',
                oninput: (e) => { ctx.currency = e.target.value.toUpperCase(); state._bulkCtx = ctx; },
              })
            ),
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'VAT type *'),
              h('select', {
                id: 'bulk-vat-type', class: 'input',
                onchange: (e) => { ctx.vat_type = e.target.value; state._bulkCtx = ctx; },
              },
                h('option', { value: '', selected: !ctx.vat_type ? 'selected' : null }, '— select —'),
                ['MARGIN', 'STANDARD', 'ZERO', 'PVAT'].map(v =>
                  h('option', { value: v, selected: v === ctx.vat_type ? 'selected' : null }, v))
              )
            ),
          ),
          h('div', { class: 'mt-2' },
            h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Supplier ID (optional)'),
            h('input', {
              class: 'input mono', type: 'number', min: '1', value: ctx.supplier_id,
              placeholder: 'Leave blank if unknown',
              oninput: (e) => { ctx.supplier_id = e.target.value; state._bulkCtx = ctx; },
            })
          ),
        ),

        resultsPanel,

        h('div', { class: 'mt-5 flex items-center justify-between' },
          h('label', { class: 'flex items-center gap-2 text-sm text-slate-300 select-none' },
            h('input', { type: 'checkbox', class: 'accent-cyan-500', checked: state.autoPrint ? 'checked' : null,
              onchange: (e) => { state.autoPrint = e.target.checked; } }),
            'Auto-queue print labels for received devices'
          ),
          h('div', { class: 'flex gap-2' },
            h('button', { class: 'btn btn-ghost', onclick: close }, allResults.length > 0 ? 'Close' : 'Cancel'),
            h('button', {
              class: 'btn btn-primary' + (ctx.busy ? ' opacity-60 cursor-not-allowed' : ''),
              id: 'bulk-scan-run-btn',
              // Wrapped in an arrow fn — run() takes an optional imeisOverride
              // array; binding it directly as onclick would pass the click
              // Event as that argument instead (truthy, so the `|| parsedImeis()`
              // fallback never kicks in), silently sending the DOM Event as
              // the `imeis` field in the POST body.
              onclick: () => run(),
              disabled: ctx.busy ? 'disabled' : null,
            }, ctx.busy
              ? [h('i', { class: 'fas fa-spinner fa-spin' }), 'Processing…']
              : [h('i', { class: 'fas fa-check-double' }), 'Receive batch'])
          )
        )
      )
    );
  }

  // ───────── Catalog view ─────────
  function CatalogView() {
    return h('div', { class: 'space-y-5' },
      h('div', { class: 'flex items-center justify-between flex-wrap gap-3' },
        h('div', {},
          h('h1', { class: 'text-2xl font-bold' }, 'SKU Catalogue'),
          h('p', { class: 'text-slate-400 text-sm' },
            'The shared spine for product identity. Upload your master list in bulk — duplicates are flagged, never silently merged.')
        ),
        h('div', { class: 'flex gap-2 items-center' },
          h('input', {
            class: 'input', placeholder: 'Search SKU / brand / model',
            oninput: (e) => debouncedCatalogSearch(e.target.value),
          }),
          h('button', { class: 'btn btn-primary', onclick: openCatalogUpload },
            h('i', { class: 'fas fa-cloud-arrow-up' }), 'Upload Catalogue')
        )
      ),
      h('div', { class: 'card overflow-hidden' },
        h('table', { class: 'w-full text-sm' },
          h('thead', { class: 'bg-slate-900/50 text-xs uppercase text-slate-400' },
            h('tr', {},
              h('th', { class: 'text-left px-4 py-3' }, 'SKU'),
              h('th', { class: 'text-left px-4 py-3' }, 'Brand'),
              h('th', { class: 'text-left px-4 py-3' }, 'Model'),
              h('th', { class: 'text-left px-4 py-3' }, 'Capacity'),
              h('th', { class: 'text-left px-4 py-3' }, 'Color'),
              h('th', { class: 'text-left px-4 py-3' }, 'Grade'),
              h('th', { class: 'text-right px-4 py-3' }, '')
            )
          ),
          h('tbody', { class: 'divide-y divide-slate-800' },
            state.catalog.length === 0
              ? h('tr', {}, h('td', { colspan: 7, class: 'text-center py-10 text-slate-500' },
                  'Catalogue is empty — upload a CSV to populate it.'))
              : state.catalog.map(c => h('tr', { class: 'row-strip' },
                  h('td', { class: 'px-4 py-2 mono text-xs font-semibold text-cyan-300' }, c.sku),
                  h('td', { class: 'px-4 py-2 text-xs' }, c.brand),
                  h('td', { class: 'px-4 py-2 text-xs' }, c.model),
                  h('td', { class: 'px-4 py-2 text-xs mono' }, c.capacity || '—'),
                  h('td', { class: 'px-4 py-2 text-xs' }, c.color || '—'),
                  h('td', { class: 'px-4 py-2 text-xs' },
                    h('span', { class: gradeBadgeClass(c.grade) }, gradeLabel(c.grade))),
                  h('td', { class: 'px-4 py-2 text-right' },
                    h('button', {
                      class: 'btn btn-danger text-xs',
                      title: 'Remove SKU from catalogue (received devices keep their copy)',
                      onclick: () => deleteCatalogEntry(c),
                    }, h('i', { class: 'fas fa-trash' })))
                ))
          )
        )
      )
    );
  }

  let catalogSearchTimer;
  function debouncedCatalogSearch(q) {
    clearTimeout(catalogSearchTimer);
    catalogSearchTimer = setTimeout(async () => {
      await refreshCatalog(q);
      render();
    }, 200);
  }

  async function deleteCatalogEntry(c) {
    if (!confirm(`Remove "${c.sku}" from the catalogue?\nReceived devices that already reference this SKU will not be affected.`)) return;
    try {
      await api.del(`/catalog/${c.id}`);
      toast(`Removed ${c.sku}`, 'warn');
      await refreshCatalog(); render();
    } catch (err) {
      toast(err.response?.data?.error || 'Failed to delete', 'err');
    }
  }

  // ───────── Catalog upload modal ─────────
  function openCatalogUpload() {
    state.catalogUpload = { fileName: '', rows: [], report: null, summary: null };
    renderCatalogUploadModal();
  }

  function renderCatalogUploadModal() {
    const m = $('#cat-upload-modal');
    if (m) m.remove();
    const ctx = state.catalogUpload;

    const handleFile = (file) => {
      if (!file) return;
      ctx.fileName = file.name;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const wb = XLSX.read(data, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
          const parsed = parseCatalogRows(rows);
          ctx.rows = parsed;
          ctx.report = null;
          ctx.summary = null;
          toast(`Parsed ${parsed.length} rows`, 'ok');
          renderCatalogUploadModal();
        } catch (err) {
          console.error(err);
          toast('Failed to parse file', 'err');
        }
      };
      reader.readAsArrayBuffer(file);
    };

    const previewOrCommit = async (dryRun) => {
      if (!ctx.rows.length) { toast('No rows to upload', 'warn'); return; }
      try {
        const url = dryRun ? '/catalog/upload?dry_run=1' : '/catalog/upload';
        const r = await api.post(url, { rows: ctx.rows });
        ctx.report = r.report;
        ctx.summary = r.summary;
        if (!dryRun && r.summary.inserted > 0) {
          toast(`Inserted ${r.summary.inserted} SKU${r.summary.inserted === 1 ? '' : 's'}`, 'ok');
          await refreshCatalog();
        }
        renderCatalogUploadModal();
      } catch (err) {
        toast(err.response?.data?.error || 'Upload failed', 'err');
      }
    };

    const modal = h('div', { id: 'cat-upload-modal', class: 'modal-backdrop' },
      h('div', { class: 'modal p-6 max-w-3xl' },
        h('div', { class: 'flex items-center justify-between mb-4' },
          h('h2', { class: 'text-lg font-semibold' }, 'Upload SKU Catalogue'),
          h('button', { class: 'btn btn-ghost text-xs', onclick: () => { state.catalogUpload = null; $('#cat-upload-modal').remove(); } },
            h('i', { class: 'fas fa-times' }))
        ),
        h('div', { class: 'text-xs text-slate-400 mb-3' },
          'Expected columns (case-insensitive, any order): ',
          h('code', { class: 'text-cyan-300' }, 'brand'), ', ',
          h('code', { class: 'text-cyan-300' }, 'model'), ', ',
          h('code', { class: 'text-cyan-300' }, 'capacity'), ', ',
          h('code', { class: 'text-cyan-300' }, 'color'), ', ',
          h('code', { class: 'text-cyan-300' }, 'grade'), '. ',
          'An optional ', h('code', { class: 'text-cyan-300' }, 'sku'), ' column overrides the auto-derived code.'
        ),

        // Dropzone
        h('div', {
          class: 'dropzone rounded-xl p-6 text-center cursor-pointer mb-4',
          id: 'cat-dz',
          onclick: () => $('#cat-file').click(),
          ondragover: (e) => { e.preventDefault(); $('#cat-dz').classList.add('is-over'); },
          ondragleave: () => $('#cat-dz').classList.remove('is-over'),
          ondrop: (e) => { e.preventDefault(); $('#cat-dz').classList.remove('is-over'); handleFile(e.dataTransfer.files[0]); },
        },
          h('i', { class: 'fas fa-cloud-arrow-up text-2xl text-slate-500 mb-2' }),
          h('div', { class: 'text-sm text-slate-300' }, ctx.fileName || 'Drop CSV or Excel file, or click to browse'),
          h('input', {
            type: 'file', id: 'cat-file', class: 'hidden',
            accept: '.csv,.xls,.xlsx',
            onchange: (e) => handleFile(e.target.files[0]),
          })
        ),

        // Parsed preview
        ctx.rows.length > 0 ? h('div', { class: 'mb-4' },
          h('div', { class: 'flex items-center justify-between mb-2' },
            h('div', { class: 'text-sm font-medium' },
              `Parsed ${ctx.rows.length} rows`,
              h('span', { class: 'text-xs text-slate-400 ml-2' }, 'preview first 5')
            ),
            h('div', { class: 'flex gap-2' },
              h('button', { class: 'btn btn-ghost text-xs', onclick: () => previewOrCommit(true) },
                h('i', { class: 'fas fa-magnifying-glass' }), 'Dry-run preview'),
              h('button', { class: 'btn btn-primary text-xs', onclick: () => previewOrCommit(false) },
                h('i', { class: 'fas fa-check' }), `Commit ${ctx.rows.length}`)
            )
          ),
          h('div', { class: 'border border-slate-800 rounded-lg overflow-hidden' },
            h('table', { class: 'w-full text-xs' },
              h('thead', { class: 'bg-slate-900/50 text-slate-400' },
                h('tr', {},
                  h('th', { class: 'text-left px-3 py-2' }, 'Brand'),
                  h('th', { class: 'text-left px-3 py-2' }, 'Model'),
                  h('th', { class: 'text-left px-3 py-2' }, 'Capacity'),
                  h('th', { class: 'text-left px-3 py-2' }, 'Color'),
                  h('th', { class: 'text-left px-3 py-2' }, 'Grade'),
                  h('th', { class: 'text-left px-3 py-2' }, 'SKU (override)')
                )
              ),
              h('tbody', { class: 'divide-y divide-slate-800' },
                ctx.rows.slice(0, 5).map(r => h('tr', {},
                  h('td', { class: 'px-3 py-2' }, r.brand || '—'),
                  h('td', { class: 'px-3 py-2' }, r.model || '—'),
                  h('td', { class: 'px-3 py-2 mono' }, r.capacity || '—'),
                  h('td', { class: 'px-3 py-2' }, r.color || '—'),
                  h('td', { class: 'px-3 py-2 mono' }, r.grade || '—'),
                  h('td', { class: 'px-3 py-2 mono' }, r.sku || '—')
                ))
              )
            )
          )
        ) : null,

        // Server report (after dry-run or commit)
        ctx.report ? h('div', { class: 'mb-4' },
          h('div', { class: 'text-sm font-medium mb-2 flex items-center gap-3 flex-wrap' },
            ctx.summary.dry_run
              ? h('span', { class: 'badge badge-amber text-[10px]' }, 'DRY RUN — nothing written')
              : h('span', { class: 'badge badge-green text-[10px]' }, 'COMMITTED'),
            h('span', {}, `${ctx.summary.total} total`),
            h('span', { class: 'text-green-400' }, `${ctx.summary.inserted} would-insert / inserted`),
            ctx.summary.duplicate > 0 ? h('span', { class: 'text-slate-400' }, `${ctx.summary.duplicate} duplicate (skipped)`) : null,
            ctx.summary.collision > 0 ? h('span', { class: 'text-red-400 font-semibold' }, `${ctx.summary.collision} COLLISION`) : null,
            ctx.summary.invalid > 0 ? h('span', { class: 'text-amber-400' }, `${ctx.summary.invalid} invalid`) : null
          ),
          ctx.summary.collision > 0 ? h('div', { class: 'mb-2 p-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200' },
            h('i', { class: 'fas fa-triangle-exclamation mr-2' }),
            'Collisions are NOT merged. Rename or remove the existing/conflicting SKU and try again.'
          ) : null,
          // Show only the rows that need operator attention
          h('div', { class: 'border border-slate-800 rounded-lg overflow-hidden max-h-72 overflow-y-auto' },
            h('table', { class: 'w-full text-xs' },
              h('thead', { class: 'bg-slate-900/50 text-slate-400 sticky top-0' },
                h('tr', {},
                  h('th', { class: 'text-left px-3 py-2' }, 'Row'),
                  h('th', { class: 'text-left px-3 py-2' }, 'Outcome'),
                  h('th', { class: 'text-left px-3 py-2' }, 'SKU'),
                  h('th', { class: 'text-left px-3 py-2' }, 'Detail')
                )
              ),
              h('tbody', { class: 'divide-y divide-slate-800' },
                ctx.report.filter(r => r.outcome !== 'inserted').length === 0
                  ? h('tr', {}, h('td', { colspan: 4, class: 'px-3 py-3 text-center text-green-400' },
                      'All rows clean — no duplicates, collisions, or invalid entries.'))
                  : ctx.report.filter(r => r.outcome !== 'inserted').map(r => h('tr', {},
                    h('td', { class: 'px-3 py-2 mono text-slate-500' }, '#' + (r.row_index + 1)),
                    h('td', { class: 'px-3 py-2' },
                      h('span', { class: 'badge text-[10px] ' + (
                        r.outcome === 'collision' ? 'badge-red'
                        : r.outcome === 'duplicate' ? 'badge-slate'
                        : 'badge-amber'
                      ) }, r.outcome)
                    ),
                    h('td', { class: 'px-3 py-2 mono text-cyan-300' }, r.sku || '—'),
                    h('td', { class: 'px-3 py-2 text-slate-300' },
                      r.message || '—',
                      r.existing ? h('div', { class: 'text-[10px] text-slate-500 mt-0.5' },
                        `existing: ${r.existing.brand} / ${r.existing.model}${r.existing.capacity ? ' / ' + r.existing.capacity : ''}${r.existing.color ? ' / ' + r.existing.color : ''}`
                      ) : null
                    )
                  ))
              )
            )
          )
        ) : null,

        h('div', { class: 'flex justify-end gap-2' },
          h('button', {
            class: 'btn btn-ghost',
            onclick: () => { state.catalogUpload = null; $('#cat-upload-modal').remove(); }
          }, 'Close')
        )
      )
    );
    document.body.appendChild(modal);
  }

  // Normalise spreadsheet rows for catalogue upload.
  // Accepts headers: brand, model, capacity, color, sku (any case, any order)
  function parseCatalogRows(rows) {
    if (!rows || !rows.length) return [];
    let headerIdx = -1;
    let headers = null;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const r = rows[i] || [];
      const lower = r.map(c => c == null ? '' : String(c).toLowerCase().trim());
      if (lower.includes('brand') && lower.includes('model')) {
        headerIdx = i;
        headers = lower;
        break;
      }
    }
    if (headerIdx < 0) {
      toast('Could not find header row with "brand" and "model" columns', 'warn', 4000);
      return [];
    }
    const idx = {
      brand: headers.indexOf('brand'),
      model: headers.indexOf('model'),
      capacity: headers.findIndex(h => h === 'capacity' || h === 'storage'),
      color: headers.findIndex(h => h === 'color' || h === 'colour'),
      grade: headers.findIndex(h => h === 'grade' || h === 'condition'),
      sku: headers.indexOf('sku'),
    };
    const out = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const brand = idx.brand >= 0 ? r[idx.brand] : null;
      const model = idx.model >= 0 ? r[idx.model] : null;
      if (!brand || !model) continue;
      out.push({
        brand: String(brand).trim(),
        model: String(model).trim(),
        capacity: idx.capacity >= 0 && r[idx.capacity] != null ? String(r[idx.capacity]).trim() : null,
        color: idx.color >= 0 && r[idx.color] != null ? String(r[idx.color]).trim() : null,
        grade: idx.grade >= 0 && r[idx.grade] != null ? String(r[idx.grade]).trim() : null,
        sku: idx.sku >= 0 && r[idx.sku] != null ? String(r[idx.sku]).trim() : null,
      });
    }
    return out;
  }

  let searchTimer;
  function debouncedSearch(q) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const r = await api.get(`/inventory?q=${encodeURIComponent(q)}&limit=200`);
      state.inventory = r.devices || [];
      render();
    }, 200);
  }

  // ───────── Settings view ─────────
  function SettingsView() {
    const s = state.printSettings;
    if (!s) {
      return h('div', { class: 'card p-10 text-center text-slate-400' },
        h('i', { class: 'fas fa-spinner fa-spin text-2xl mb-3' }),
        h('div', {}, 'Loading settings…')
      );
    }

    const ModeCard = (mode, title, subtitle, icon) => h('label', {
      class: 'card p-4 cursor-pointer border-2 transition ' +
        (s.print_mode === mode ? 'border-cyan-500/60 bg-cyan-500/5' : 'border-slate-800 hover:border-slate-700'),
    },
      h('div', { class: 'flex items-start gap-3' },
        h('input', {
          type: 'radio', name: 'print-mode', value: mode,
          checked: s.print_mode === mode ? 'checked' : null,
          class: 'mt-1 accent-cyan-500',
          onchange: () => saveSettings({ print_mode: mode }),
        }),
        h('div', { class: 'flex-1' },
          h('div', { class: 'flex items-center gap-2 mb-1' },
            h('i', { class: `fas fa-${icon} text-cyan-300` }),
            h('div', { class: 'font-semibold' }, title)
          ),
          h('div', { class: 'text-xs text-slate-400 leading-relaxed' }, subtitle)
        )
      )
    );

    return h('div', { class: 'space-y-6 max-w-3xl' },
      h('div', {},
        h('h1', { class: 'text-2xl font-bold' }, 'Settings'),
        h('p', { class: 'text-slate-400 text-sm' }, 'Configure how labels reach your physical DYMO LabelWriter.')
      ),

      // Print mode selector
      h('div', { class: 'space-y-3' },
        h('div', { class: 'text-sm font-semibold text-slate-300 uppercase tracking-wider' }, 'Print mode'),
        h('div', { class: 'grid grid-cols-1 md:grid-cols-3 gap-3' },
          ModeCard('browser', 'Browser Print',
            'Opens a print dialog with the label sized to real DYMO dimensions (50×30 mm or 32×57 mm). Use your OS print queue / DYMO Web Service. Easiest to set up — no extra software needed beyond the DYMO driver.',
            'window-restore'),
          ModeCard('printnode', 'PrintNode (cloud)',
            'Server-side dispatch via the PrintNode REST API. Install the PrintNode agent on the warehouse PC and the printer becomes reachable from this app — no operator interaction required.',
            'cloud-arrow-up'),
          ModeCard('manual', 'Manual / Off',
            'Don\'t actually print — just mark jobs as sent. Useful if you print labels via another path or during testing.',
            'hand'),
        )
      ),

      // Label orientation (handles DYMOs that feed labels sideways)
      h('div', { class: 'card p-5 space-y-3' },
        h('div', { class: 'flex items-center gap-2 text-cyan-300 font-semibold' },
          h('i', { class: 'fas fa-rotate' }),
          'Label orientation'
        ),
        h('div', { class: 'text-xs text-slate-400 leading-relaxed' },
          'If the printed label comes out rotated 90° and the content spills onto a second sticker, turn this on. ',
          'It tells the printer the page is portrait (32×57 mm) and rotates the landscape content 90° to fit the feed direction of your DYMO roll.'
        ),
        h('label', { class: 'flex items-center gap-3 cursor-pointer select-none' },
          h('input', {
            type: 'checkbox',
            class: 'w-4 h-4 accent-cyan-500',
            checked: state.labelRotate ? 'checked' : null,
            onchange: (e) => { setLabelRotate(e.target.checked); render(); toast(`Label rotation ${e.target.checked ? 'enabled' : 'disabled'}`, 'ok'); },
          }),
          h('div', { class: 'flex-1' },
            h('div', { class: 'text-sm font-medium' }, 'Rotate label 90° to match DYMO feed direction'),
            h('div', { class: 'text-[11px] text-slate-500 mt-0.5' },
              state.labelRotate
                ? 'On — page sent as ' + (state.labelSize === 'small' ? '57×32' : '32×57') + ' mm, content rotated 90°'
                : 'Off — page sent as ' + (state.labelSize === 'small' ? '32×57' : '57×32') + ' mm, content not rotated'
            )
          )
        )
      ),

      // PrintNode config
      s.print_mode === 'printnode' ? PrintNodeConfig(s) : null,

      // Browser-print help
      s.print_mode === 'browser' ? h('div', { class: 'card p-5 space-y-3' },
        h('div', { class: 'flex items-center gap-2 text-cyan-300 font-semibold' },
          h('i', { class: 'fas fa-circle-info' }),
          'Browser Print setup'
        ),
        h('ol', { class: 'list-decimal list-inside text-sm text-slate-300 space-y-1.5' },
          h('li', {}, 'Install the DYMO LabelWriter driver on the workstation that runs the browser.'),
          h('li', {}, 'Plug in the DYMO LW550 / LW450 / etc. via USB. Make sure it shows up in your OS Printers list.'),
          h('li', {}, 'Make sure the loaded label stock matches the selected size in the topbar (DYMO 57×32 or DYMO 32×57).'),
          h('li', {}, 'Allow pop-ups for this site — each "Send" button opens a print window.'),
          h('li', {}, 'Click Send on a print job; in the print dialog, choose the DYMO printer and click Print.'),
        ),
        h('div', { class: 'text-xs text-slate-500 mt-2' },
          h('i', { class: 'fas fa-lightbulb mr-1' }),
          'Tip: in the print dialog, set "Margins: None" and "Scale: 100%" to avoid distortion. Modern browsers honour the @page size embedded in the label HTML.'
        )
      ) : null,

      // Manual help
      s.print_mode === 'manual' ? h('div', { class: 'card p-5' },
        h('div', { class: 'text-sm text-slate-300' },
          h('i', { class: 'fas fa-circle-info text-cyan-300 mr-2' }),
          'In manual mode the "Send" button only marks the job as printed in the database — nothing actually goes to a printer. Use this for testing the receiving workflow without spending labels.'
        )
      ) : null,
    );
  }

  function PrintNodeConfig(s) {
    const apiKeyInput = h('input', {
      type: 'password',
      class: 'input w-full mono text-xs',
      placeholder: s.printnode_api_key_set ? '••••••••••• (configured — leave blank to keep)' : 'Paste your PrintNode API key',
      id: 'printnode-api-key',
    });
    const printerSelect = (which, current) => {
      if (!state.printnodePrinters) {
        return h('div', { class: 'text-xs text-slate-500' },
          h('button', {
            class: 'btn btn-ghost text-xs',
            onclick: async () => { await refreshPrintnodePrinters(); render(); },
          }, h('i', { class: 'fas fa-rotate' }), 'Load printers from PrintNode')
        );
      }
      if (state.printnodePrinters.length === 0) {
        return h('div', { class: 'text-xs text-amber-400' }, 'No printers reported by PrintNode — is the agent running on the warehouse PC?');
      }
      return h('select', {
        class: 'input w-full text-sm',
        onchange: (e) => {
          const val = e.target.value === '' ? null : Number(e.target.value);
          const patch = which === 'large' ? { printnode_printer_id_large: val } : { printnode_printer_id_small: val };
          saveSettings(patch);
        },
      },
        h('option', { value: '' }, '— select printer —'),
        state.printnodePrinters.map(p => h('option', {
          value: p.id,
          selected: current === p.id ? 'selected' : null,
        }, `#${p.id} · ${p.name}${p.computer?.name ? ' (' + p.computer.name + ')' : ''}`))
      );
    };

    return h('div', { class: 'card p-5 space-y-4' },
      h('div', { class: 'flex items-center gap-2 text-cyan-300 font-semibold' },
        h('i', { class: 'fas fa-cloud' }),
        'PrintNode configuration'
      ),
      h('div', { class: 'text-xs text-slate-400' },
        'Sign up at ',
        h('a', { href: 'https://www.printnode.com/', target: '_blank', class: 'text-cyan-400 underline' }, 'printnode.com'),
        ', install the PrintNode agent on the warehouse PC, plug in the DYMO printer, then paste the API key here.'
      ),

      // API key
      h('div', { class: 'space-y-1.5' },
        h('label', { class: 'text-xs font-semibold text-slate-300 uppercase tracking-wider' }, 'API key'),
        h('div', { class: 'flex gap-2' },
          apiKeyInput,
          h('button', {
            class: 'btn btn-primary text-xs whitespace-nowrap',
            disabled: state.settingsSaving ? 'disabled' : null,
            onclick: async () => {
              const v = apiKeyInput.value.trim();
              if (!v) { toast('Enter an API key first (or click Clear to remove)', 'warn'); return; }
              await saveSettings({ printnode_api_key: v });
              apiKeyInput.value = '';
              state.printnodePrinters = null; // force reload
            },
          }, h('i', { class: 'fas fa-save' }), 'Save key'),
          s.printnode_api_key_set ? h('button', {
            class: 'btn btn-ghost text-xs',
            onclick: async () => {
              if (!confirm('Clear stored PrintNode API key?')) return;
              await saveSettings({ printnode_api_key: null });
              state.printnodePrinters = null;
            },
          }, 'Clear') : null
        ),
        s.printnode_api_key_set
          ? h('div', { class: 'text-[11px] text-green-400' }, h('i', { class: 'fas fa-check mr-1' }), 'API key is configured')
          : h('div', { class: 'text-[11px] text-amber-400' }, h('i', { class: 'fas fa-triangle-exclamation mr-1' }), 'No API key on file — PrintNode mode will fail')
      ),

      // Printer selection
      s.printnode_api_key_set ? h('div', { class: 'space-y-3 pt-2 border-t border-slate-800' },
        h('div', { class: 'flex items-center justify-between' },
          h('div', { class: 'text-xs font-semibold text-slate-300 uppercase tracking-wider' }, 'Printer mapping'),
          h('button', {
            class: 'btn btn-ghost text-xs',
            onclick: async () => { state.printnodePrinters = null; render(); await refreshPrintnodePrinters(); render(); },
          }, h('i', { class: 'fas fa-rotate' }), 'Reload printers')
        ),
        h('div', { class: 'space-y-1.5' },
          h('label', { class: 'text-xs text-slate-400' }, 'DYMO 57×32 mm (large label)'),
          printerSelect('large', s.printnode_printer_id_large)
        ),
        h('div', { class: 'space-y-1.5' },
          h('label', { class: 'text-xs text-slate-400' }, 'DYMO 32×57 mm (small label)'),
          printerSelect('small', s.printnode_printer_id_small)
        ),
      ) : null
    );
  }

  // ───────── Print queue ─────────
  function PrintView() {
    return h('div', { class: 'space-y-5' },
      h('div', { class: 'flex items-center justify-between' },
        h('div', {},
          h('h1', { class: 'text-2xl font-bold' }, 'Print Queue'),
          h('p', { class: 'text-slate-400 text-sm' }, 'Pending label print jobs. In production these stream to PrintNode / QZ Tray on the warehouse floor.')
        ),
        state.printQueue.length > 0 ? h('button', { class: 'btn btn-primary', onclick: sendAllPrint },
          h('i', { class: 'fas fa-paper-plane' }), `Send all (${state.printQueue.length})`) : null
      ),
      state.printQueue.length === 0
        ? h('div', { class: 'card p-10 text-center text-slate-500' },
            h('i', { class: 'fas fa-check-circle text-4xl text-green-400 mb-3' }),
            h('div', {}, 'Queue is empty — all labels are printed.'))
        : h('div', { class: 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4' },
            state.printQueue.map(j => {
              const payload = JSON.parse(j.payload_json);
              return h('div', { class: 'card p-4' },
                h('div', { class: 'flex items-center justify-between mb-3' },
                  h('div', {},
                    h('div', { class: 'text-xs text-slate-500 mono' }, 'Job #' + j.id),
                    h('div', { class: 'text-xs text-slate-400' }, j.printer)
                  ),
                  h('button', { class: 'btn btn-primary text-xs', onclick: () => sendPrint(j.id) },
                    h('i', { class: 'fas fa-paper-plane' }), 'Send')
                ),
                h('div', { class: 'flex justify-center' }, renderLabel(payload, `q-${j.id}`))
              );
            })
          )
    );
  }
  async function sendPrint(id) {
    try {
      const r = await api.post(`/print/send/${id}?size=${state.labelSize}${state.labelRotate ? '&rotate=1' : ''}`);
      if (r.mode === 'browser') {
        const win = await openWithDocToken(r.url, 'width=720,height=520');
        if (!win) {
          toast('Pop-up blocked — please allow pop-ups for this site', 'err', 4000);
          return;
        }
        toast('Print window opened — review and confirm in the dialog', 'ok');
      } else if (r.mode === 'printnode') {
        toast(`Label sent to PrintNode (job #${r.printnode_job_id})`, 'ok');
        await refreshPrint(); render();
      } else {
        toast('Label sent', 'ok');
        await refreshPrint(); render();
      }
    } catch (e) {
      toast('Send failed: ' + (e.response?.data?.error || e.message), 'err', 4000);
    }
  }
  async function sendAllPrint() {
    try {
      const r = await api.post(`/print/send-all?size=${state.labelSize}${state.labelRotate ? '&rotate=1' : ''}`);
      if (r.mode === 'browser') {
        const win = await openWithDocToken(r.url, 'width=720,height=520');
        if (!win) {
          toast('Pop-up blocked — please allow pop-ups for this site', 'err', 4000);
          return;
        }
        toast(`Print window opened for ${r.count} labels`, 'ok');
      } else if (r.mode === 'printnode') {
        toast(`Sent ${r.sent} labels to PrintNode`, 'ok');
        await refreshPrint(); render();
      } else {
        toast(`Sent ${r.sent || 0} labels`, 'ok');
        await refreshPrint(); render();
      }
    } catch (e) {
      toast('Send all failed: ' + (e.response?.data?.error || e.message), 'err', 4000);
    }
  }

  // Listen for the print window telling us labels have been printed
  window.addEventListener('message', async (ev) => {
    if (!ev.data || ev.data.type !== 'labels-printed') return;
    const ids = Array.isArray(ev.data.ids) ? ev.data.ids : [];
    if (!ids.length) return;
    try {
      await api.post('/print/mark-sent-batch', { ids });
      if (state.view === 'print') { await refreshPrint(); render(); }
      else { await refreshStats(); }
      toast(`Marked ${ids.length} label${ids.length === 1 ? '' : 's'} as printed`, 'ok');
    } catch (e) {
      console.error('mark-sent-batch failed', e);
    }
  });

  // ───────── Boot ─────────
  document.addEventListener('keydown', (e) => {
    // Global Esc refocuses scan input on receive view
    if (e.key === 'Escape' && state.view === 'receive' && !state.pendingMatch && !state.pendingUnrec && !state.bulkScanOpen) {
      $('#scan-input')?.focus();
    }
  });

  // Keep scan input focused (HID scanner safety net)
  document.addEventListener('click', (e) => {
    if (state.view !== 'receive') return;
    if (state.pendingMatch || state.pendingUnrec || state.labelPreview || state.bulkScanOpen) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input','select','textarea','button','option','label'].includes(tag)) return;
    setTimeout(() => $('#scan-input')?.focus(), 10);
  });

  async function boot() {
    // No stored token at all — show the login screen immediately, no need
    // to round-trip to the server first.
    if (!authToken) {
      state.authUser = null;
      render();
      return;
    }
    // We have a stored token — validate it via GET /api/auth/me before
    // loading any app data. A 401 here is handled by the axios response
    // interceptor above (clears the token and re-renders the login view).
    if (!state.authUser) {
      try {
        const r = await api.get('/auth/me');
        state.authUser = r.user;
      } catch (e) {
        // Interceptor already cleared the token + re-rendered login on 401.
        return;
      }
    }
    try {
      await refreshManifests();
      await refreshStats();
      if (state.activeManifestId) await refreshActiveManifest();
      // Land on receive if there's an open manifest, else dashboard
      state.view = state.activeManifestId ? 'receive' : 'dashboard';
      render();
    } catch (e) {
      console.error(e);
      toast('Failed to load app: ' + e.message, 'err');
    }
  }
  boot();
})();
