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
    events: [],
    inventory: [],
    inventorySelected: new Set(),   // Set<deviceId> for bulk operations on Inventory view
    bulkGradeOpen: false,            // bulk grade modal visibility
    catalog: [],                     // sku_catalog rows
    catalogUpload: null,             // { fileName, rows, report, summary } during preview
    manualReceiveOpen: false,        // manual-receive (no manifest) modal
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
      return;
    }
    const r = await api.get(`/manifests/${state.activeManifestId}`);
    state.activeManifest = r.manifest;
    state.expected = r.expected || [];
    state.unreconciled = r.unreconciled || [];
    state.summary = r.summary || { expected_count: 0, received_count: 0 };
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
  // Minimal dev/demo login: exchanges a seeded user's email for a JWT via
  // POST /api/auth/dev-login (see src/routes/auth.ts — there is no password
  // yet since this app has no real IdP). The token is stored via
  // setAuthToken() and every subsequent api.* call attaches it.
  function LoginView() {
    const doLogin = async (email) => {
      state.authError = null;
      state.authBusy = true;
      render();
      try {
        const r = await api.post('/auth/dev-login', email ? { email } : {});
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
    return h('div', { class: 'min-h-screen flex items-center justify-center px-4' },
      h('div', { class: 'card p-8 w-full max-w-sm' },
        h('div', { class: 'flex items-center gap-3 mb-6' },
          h('div', { class: 'w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-400 to-indigo-500 flex items-center justify-center shadow-lg shadow-cyan-500/20' },
            h('i', { class: 'fas fa-box-open text-slate-900' })
          ),
          h('div', {},
            h('div', { class: 'text-sm font-bold tracking-wide' }, 'GOODS IN'),
            h('div', { class: 'text-[10px] text-slate-500 -mt-0.5' }, 'Sign in to continue')
          )
        ),
        h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Email'),
        h('input', {
          class: 'input mb-3', type: 'email', placeholder: 'admin@goodsin.local',
          oninput: (e) => { emailValue = e.target.value; },
          onkeydown: (e) => { if (e.key === 'Enter') doLogin(emailValue.trim()); },
        }),
        state.authError ? h('div', { class: 'mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200' },
          h('i', { class: 'fas fa-triangle-exclamation mr-2' }), state.authError) : null,
        h('button', {
          class: 'btn btn-primary w-full justify-center' + (state.authBusy ? ' opacity-60 cursor-not-allowed' : ''),
          disabled: state.authBusy ? 'disabled' : null,
          onclick: () => doLogin(emailValue.trim()),
        }, state.authBusy ? h('i', { class: 'fas fa-spinner fa-spin' }) : h('i', { class: 'fas fa-right-to-bracket' }), state.authBusy ? 'Signing in…' : 'Sign in'),
        h('div', { class: 'text-[11px] text-slate-500 mt-4 text-center' },
          'Leave blank and press Sign in to use the seeded admin account.')
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
        : state.view === 'opr' ? OprView()
        : state.view === 'settings' ? SettingsView()
        : h('div', {}, 'Not found')
      ),
      state.pendingMatch ? ConfirmSkuModal() : null,
      state.pendingUnrec ? UnreconciledModal() : null,
      state.labelPreview ? LabelPreviewModal() : null,
      state.deleteDevice ? DeleteDeviceModal() : null,
      state.manualReceiveOpen ? ManualReceiveModal() : null,
      state.oprNewOpen ? OprNewShipmentModal() : null,
      state.oprFinaliseOpen ? OprFinaliseModal() : null,
      state.oprDraftDoc ? OprDraftDocModal() : null,
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
          Tab('dashboard', 'Dashboard', 'gauge-high'),
          Tab('manifests', 'Manifests', 'file-invoice'),
          Tab('receive', 'Receive', 'barcode'),
          Tab('inventory', 'Inventory', 'warehouse'),
          Tab('catalog', 'Catalog', 'tags'),
          Tab('print', 'Print Queue', 'print'),
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
                  h('td', { class: 'px-4 py-2 mono text-xs' },
                    s.procedure_code + (s.additional_procedure_code ? ' + ' + s.additional_procedure_code : '')),
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
    const f = { direction: 'export', reference: '', authorisation_id: state.oprAuths[0]?.id || '',
                procedure_code: '2100', additional_procedure_code: '', consignee_name: '',
                related_export_shipment_id: '', ship_date: '' };
    const close = () => { state.oprNewOpen = false; render(); };
    const finalisedExports = state.oprShipments.filter(s => s.direction === 'export' && s.status === 'FINALISED');
    const doCreate = async () => {
      const body = {
        direction: f.direction,
        reference: f.reference.trim(),
        authorisation_id: Number(f.authorisation_id) || null,
        procedure_code: f.direction === 'import' ? '6121' : f.procedure_code,
      };
      if (f.direction === 'export' && f.additional_procedure_code) body.additional_procedure_code = f.additional_procedure_code;
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
    const fields = () => h('div', { class: 'space-y-3' },
      h('div', { class: 'grid grid-cols-2 gap-3' },
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Direction'),
          h('select', { id: 'opr-new-direction', class: 'input', onchange: (e) => { f.direction = e.target.value; bodyWrap.replaceChildren(fields()); } },
            h('option', { value: 'export', selected: f.direction === 'export' ? 'selected' : null }, 'Export (send for repair)'),
            h('option', { value: 'import', selected: f.direction === 'import' ? 'selected' : null }, 'Import (return from repair)'))
        ),
        h('div', {},
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Reference *'),
          h('input', { id: 'opr-new-reference', class: 'input mono', placeholder: f.direction === 'export' ? 'EXP 2026 001' : 'IMP 2026 001',
            value: f.reference, oninput: (e) => { f.reference = e.target.value; } })
        )
      ),
      h('div', {},
        h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'OPR authorisation *'),
        h('select', { class: 'input', onchange: (e) => { f.authorisation_id = e.target.value; } },
          state.oprAuths.map(a => h('option', { value: a.id, selected: String(f.authorisation_id) === String(a.id) ? 'selected' : null },
            `${a.holder_name} — ${a.cds_number}`)),
          !state.oprAuths.length ? h('option', { value: '' }, 'No authorisations — create one via the API first') : null)
      ),
      f.direction === 'export' ? h('div', { class: 'grid grid-cols-2 gap-3' },
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
      ) : h('div', {},
        h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Discharges export consignment'),
        h('select', { class: 'input', onchange: (e) => { f.related_export_shipment_id = e.target.value; } },
          h('option', { value: '' }, '(none — link later)'),
          finalisedExports.map(s => h('option', { value: s.id, selected: String(f.related_export_shipment_id) === String(s.id) ? 'selected' : null },
            `${s.reference} (${s.line_count} devices)`))),
        h('p', { class: 'text-[11px] text-slate-500 mt-1' }, 'Import procedure code is fixed at 6121 (re-import after OP repair).')
      ),
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

    const openDoc = (path) => {
      const win = window.open(withAuthToken(`/api/opr/shipments/${s.id}/${path}`), '_blank');
      if (!win) toast('Popup blocked — allow popups for this site', 'warn');
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
          // Documents: export → invoice/scan-out/prealert; import → ce1154/clearance
          isExport
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
                 h('i', { class: 'fas fa-paper-plane' }), 'Send clearance')],
          isDraft ? h('button', {
            id: 'opr-finalise-btn',
            class: 'btn btn-primary text-xs' + (v && v.result === 'red' ? ' opacity-60' : ''),
            title: v && v.result === 'red' ? 'Blocked — resolve the red validation results first' : (isExport ? 'Finalise the export (devices become EXPORTED_UNDER_OPR)' : 'Receive the return (devices become RETURNED_UNDER_OPR)'),
            onclick: () => { state.oprFinaliseOpen = true; render(); },
          }, h('i', { class: 'fas fa-flag-checkered' }), isExport ? 'Finalise export' : 'Receive return') : null,
          !isDraft && !isExport ? h('button', { id: 'opr-restock-btn', class: 'btn btn-primary text-xs', onclick: doRestock,
            title: 'Move RETURNED_UNDER_OPR devices back to ACTIVE_INVENTORY (idempotent)' },
            h('i', { class: 'fas fa-warehouse' }), 'Restock') : null
        )
      ),

      // Header facts
      h('div', { class: 'grid grid-cols-2 md:grid-cols-4 gap-4' },
        OprFact('Authorisation', b.authorisation ? b.authorisation.holder_name : '—', 'id-card'),
        OprFact('Procedure', s.procedure_code + (s.additional_procedure_code ? ' + ' + s.additional_procedure_code : ''), 'stamp'),
        OprFact(isExport ? 'Export MRN' : 'Import MRN', (isExport ? s.export_mrn : s.import_mrn) || '—', 'barcode'),
        OprFact('Declared value', fmtMoney(b.total_value, s.currency), 'coins'),
      ),

      // Validation traffic lights
      v ? h('div', { class: 'card p-4', id: 'opr-validation' },
        h('div', { class: 'flex items-center gap-2 mb-2' },
          h('span', { class: 'badge ' + (v.result === 'green' ? 'badge-green' : v.result === 'amber' ? 'badge-amber' : 'badge-red') },
            h('i', { class: 'fas fa-' + (v.result === 'green' ? 'check' : v.result === 'amber' ? 'triangle-exclamation' : 'ban') + ' mr-1' }),
            v.result.toUpperCase()),
          h('span', { class: 'text-xs text-slate-400' },
            `${v.checks.length} checks — red blocks ${isExport ? 'finalisation' : 'receipt'}, amber passes with a warning`)
        ),
        h('div', { class: 'space-y-1' },
          v.checks.filter(c2 => c2.level !== 'green').map(c2 =>
            h('div', { class: 'flex items-start gap-2 text-xs' },
              h('span', { class: 'badge ' + (c2.level === 'amber' ? 'badge-amber' : 'badge-red') + ' shrink-0' }, c2.level),
              h('span', { class: 'text-slate-300' }, c2.message))),
          v.checks.every(c2 => c2.level === 'green')
            ? h('div', { class: 'text-xs text-slate-500' }, 'All checks green.')
            : null
        )
      ) : null,

      // Repair-invoice / C&E1154 inputs (import DRAFT only) — receipt is
      // blocked server-side until repair_cost + duty_rate_pct are recorded.
      isDraft && !isExport ? OprRepairInvoiceCard(s) : null,

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
          h('span', { class: 'text-[11px] text-slate-500' }, 'Real send attempts only — nothing is logged until Gmail secrets are configured and a send is attempted.')
        ),
        !state.oprEmails.length
          ? h('div', { class: 'text-xs text-slate-500 py-2' }, 'No emails sent for this consignment.')
          : h('div', { class: 'divide-y divide-slate-800' },
              state.oprEmails.map(e => h('div', { class: 'py-2 flex items-center gap-3 text-xs' },
                h('span', { class: 'badge ' + (e.status === 'sent' ? 'badge-green' : 'badge-red') }, e.status),
                h('span', { class: 'badge badge-slate' }, e.kind),
                h('span', { class: 'mono text-slate-300' }, e.to_email),
                h('span', { class: 'text-slate-400 truncate flex-1' }, e.subject),
                h('span', { class: 'text-slate-500' }, fmtDate(e.created_at))
              )))
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
            ['GBP', 'USD', 'EUR', 'CNY', 'HKD'].map(cur =>
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
    const f = { export_mrn: '', ducr: '', ead_mrn: '', import_mrn: '' };
    const close = () => { state.oprFinaliseOpen = false; render(); };
    const doFinalise = async () => {
      const body = isExport
        ? Object.fromEntries(Object.entries({ export_mrn: f.export_mrn, ducr: f.ducr, ead_mrn: f.ead_mrn }).filter(([, v2]) => v2.trim()))
        : (f.import_mrn.trim() ? { import_mrn: f.import_mrn.trim() } : {});
      try {
        const r = await api.post(`/opr/shipments/${s.id}/finalise`, body);
        state.oprFinaliseOpen = false;
        const ambers = (r.validation?.checks || []).filter(c2 => c2.level === 'amber');
        toast(
          (isExport ? `Export finalised — ${r.devices_exported} devices EXPORTED_UNDER_OPR` : `Return received — ${r.devices_returned ?? b.lines.length} devices RETURNED_UNDER_OPR`) +
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
        h('p', { class: 'text-xs text-slate-400 mb-4' }, isExport
          ? 'Declaration references are optional here — they can be recorded later via export proof. Red validation results block finalisation server-side.'
          : 'Receipt moves every device to RETURNED_UNDER_OPR and freezes declared values. Import MRN is optional (record later via import proof).'),
        h('div', { class: 'space-y-3' },
          isExport
            ? [Field('Export MRN', 'export_mrn', '26GB34F7Y1AB8CDE12'),
               Field('DUCR', 'ducr', '6GB369979995000-EXP2026001'),
               Field('EAD MRN', 'ead_mrn', '(optional)')]
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
      try { await navigator.clipboard.writeText(text); toast(`${what} copied`, 'ok'); }
      catch { toast('Clipboard unavailable — select and copy manually', 'warn'); }
    };
    const isPre = d.kind === 'prealert';
    return h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target.classList.contains('modal-backdrop')) close(); } },
      h('div', { class: 'modal p-6 max-w-2xl' },
        h('div', { class: 'flex items-center justify-between mb-3' },
          h('h2', { class: 'text-lg font-semibold' }, isPre ? 'Pre-alert email draft' : 'Clearance instruction draft'),
          h('button', { class: 'btn btn-ghost text-xs', onclick: close }, h('i', { class: 'fas fa-xmark' }))
        ),
        h('div', { class: 'space-y-2 text-xs' },
          h('div', { class: 'flex gap-2' },
            h('span', { class: 'text-slate-500 w-14 shrink-0' }, 'To'),
            h('span', { class: 'mono text-slate-200' }, d.data.to || '(not configured on the authorisation)')),
          d.data.cutoff ? h('div', { class: 'flex gap-2' },
            h('span', { class: 'text-slate-500 w-14 shrink-0' }, 'Cut-off'),
            h('span', { class: 'text-slate-200' }, d.data.cutoff)) : null,
          h('div', { class: 'flex gap-2' },
            h('span', { class: 'text-slate-500 w-14 shrink-0' }, 'Subject'),
            h('span', { class: 'mono text-slate-200' }, d.data.subject)),
          d.note ? h('div', { class: 'px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200' },
            h('i', { class: 'fas fa-triangle-exclamation mr-2' }), d.note) : null,
          h('pre', { class: 'mt-2 p-3 rounded-lg bg-slate-900/70 border border-slate-800 whitespace-pre-wrap text-slate-300 max-h-[45vh] overflow-auto mono' },
            d.data.body)
        ),
        h('div', { class: 'flex justify-end gap-2 mt-4' },
          h('button', { class: 'btn btn-ghost text-sm', onclick: () => copy(d.data.subject, 'Subject') }, h('i', { class: 'fas fa-copy' }), 'Copy subject'),
          h('button', { class: 'btn btn-primary text-sm', onclick: () => copy(d.data.body, 'Body') }, h('i', { class: 'fas fa-copy' }), 'Copy body')
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
                  h('td', { class: 'px-4 py-3 font-semibold mono text-cyan-300' }, m.reference),
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
    { key: 'capacity',    label: 'Storage *',      hint: '128GB, 256G… (normalised to 128GB form)' },
    { key: 'color',       label: 'Color *',        hint: 'Phantom Black… (case-insensitive)' },
    { key: 'grade',       label: 'Grade *',        hint: 'A | B | C (anything else → UG)' },
    { key: 'description', label: 'Description',    hint: 'optional · human label only' },
    { key: 'condition',   label: 'Condition',      hint: 'New / Used' },
    { key: 'unit_cost',   label: 'Unit cost',      hint: 'numeric' },
  ];
  function openManifestUpload() {
    uploadCtx = {
      reference: '', supplier: '', notes: '',
      fileName: '',
      rawRows: [],     // every row of the sheet, including header
      headers: [],     // normalised header row (lowercased strings)
      headerIdx: -1,   // index of the detected header row in rawRows
      mapping: {},     // { fieldKey: columnIndex | -1 }
      rows: [],        // parsed rows (the payload we POST)
    };
    renderUploadModal();
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
              class: 'input', id: 'mf-sup', placeholder: 'e.g. Saigates Limited',
              value: uploadCtx.supplier,
              oninput: (e) => uploadCtx.supplier = e.target.value,
            })
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
      unit_cost: find(h => ['unit cost','cost','price','unit_cost','unit price'].includes(h)),
    };
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
             condition: -1, capacity: -1, color: -1, unit_cost: -1 };
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
      });
      toast(`Manifest created · ${r.count} devices loaded`, 'ok');
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
        buy_price: '',
        currency: 'GBP',
        vat_type: '',
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
        // Receive immediately
        await confirmIt();
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

    const confirmIt = async () => {
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
          notes: ctx.notes, auto_print: state.autoPrint,
          buy_price: ctx.buy_price, currency: ctx.currency || 'GBP', vat_type: ctx.vat_type,
          supplier_id: ctx.supplier_id ? Number(ctx.supplier_id) : undefined,
        });
        toast(`Received <span class="mono">${r.received.imei}</span> · ${r.received.sku}${state.autoPrint ? ' · 🖨️ label queued' : ''}`, 'ok');
        beep('ok');
        state.pendingMatch = null; state._confirmCtx = null;
        // Flash the just-received row
        await refreshActiveManifest();
        render();
        const row = $(`#exp-${expected.id}`);
        if (row) { row.classList.add('row-ok-flash'); setTimeout(() => row.classList.remove('row-ok-flash'), 1500); }
        // Show label preview if user wants
        if (state.autoPrint && r.print_job_id) {
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
              h('button', { class: 'btn btn-ghost text-[11px]', onclick: () => pickCandidate(row) },
                h('i', { class: 'fas fa-check' }), 'Use this')
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
          h('label', { class: 'flex items-center gap-2 text-sm text-slate-300 select-none' },
            h('input', { type: 'checkbox', class: 'accent-cyan-500', checked: state.autoPrint ? 'checked' : null,
              onchange: (e) => { state.autoPrint = e.target.checked; } }),
            'Auto-queue print label'
          ),
        ),
        // Valuation / VAT (Priority 4) — required server-side on confirm.
        h('div', { class: 'mt-3 card p-3 bg-slate-900/40' },
          h('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500 mb-2' }, 'Valuation & VAT'),
          h('div', { class: 'grid grid-cols-3 gap-3' },
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Buy price *'),
              h('input', {
                class: 'input mono', type: 'number', step: '0.01', min: '0',
                value: ctx.buy_price, placeholder: '0.00',
                oninput: (e) => { ctx.buy_price = e.target.value; state._confirmCtx = ctx; },
              })
            ),
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Currency'),
              h('input', {
                class: 'input mono uppercase', maxlength: 3, value: ctx.currency || 'GBP',
                oninput: (e) => { ctx.currency = e.target.value.toUpperCase(); state._confirmCtx = ctx; },
              })
            ),
            h('div', {},
              h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'VAT type *'),
              h('select', {
                class: 'input',
                onchange: (e) => { ctx.vat_type = e.target.value; state._confirmCtx = ctx; },
              },
                h('option', { value: '', selected: !ctx.vat_type ? 'selected' : null }, '— select —'),
                ['MARGIN', 'STANDARD', 'ZERO'].map(v =>
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
            h('button', {
              class: 'btn ' + (matched ? 'btn-primary' : 'btn-ghost opacity-50 cursor-not-allowed'),
              onclick: confirmIt,
              disabled: !matched ? 'disabled' : null,
            },
              h('i', { class: 'fas fa-check' }), 'Confirm & Print')
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
                ['MARGIN', 'STANDARD', 'ZERO'].map(v =>
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
                ['MARGIN', 'STANDARD', 'ZERO'].map(v =>
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
  // Browser-mode label URLs (GET /api/print/label/:id, /api/print/labels)
  // are opened via window.open(), which is a plain browser navigation and
  // can't carry our Authorization header. The backend's extractToken()
  // falls back to a `?token=` query param for exactly this case.
  function withAuthToken(url) {
    if (!authToken) return url;
    return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(authToken);
  }
  async function sendPrint(id) {
    try {
      const r = await api.post(`/print/send/${id}?size=${state.labelSize}${state.labelRotate ? '&rotate=1' : ''}`);
      if (r.mode === 'browser') {
        const win = window.open(withAuthToken(r.url), '_blank', 'width=720,height=520');
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
        const win = window.open(withAuthToken(r.url), '_blank', 'width=720,height=520');
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
    if (e.key === 'Escape' && state.view === 'receive' && !state.pendingMatch && !state.pendingUnrec) {
      $('#scan-input')?.focus();
    }
  });

  // Keep scan input focused (HID scanner safety net)
  document.addEventListener('click', (e) => {
    if (state.view !== 'receive') return;
    if (state.pendingMatch || state.pendingUnrec || state.labelPreview) return;
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
