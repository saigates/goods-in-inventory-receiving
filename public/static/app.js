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
  const gradeBadgeClass = (g) => g === 'UG' ? 'badge badge-violet text-[10px]' : 'badge badge-cyan text-[10px]';

  // ───────── State ─────────
  const state = {
    view: 'receive',     // dashboard | manifests | receive | inventory | print
    manifests: [],
    activeManifestId: null,
    activeManifest: null,
    expected: [],
    unreconciled: [],
    summary: { expected_count: 0, received_count: 0 },
    events: [],
    inventory: [],
    printQueue: [],
    stats: {},
    pendingMatch: null,   // { expected, suggested_sku }
    pendingUnrec: null,   // { imei }
    soundOn: true,
    autoPrint: true,
    labelSize: localStorage.getItem('labelSize') || 'large', // 'large' (DYMO 50x30mm) | 'small' (DYMO 32x57mm)
    printSettings: null,         // { print_mode, printnode_api_key_set, printnode_printer_id_large, printnode_printer_id_small }
    printnodePrinters: null,     // [] from /printnode/printers
    settingsSaving: false,
  };
  function setLabelSize(v) { state.labelSize = v; localStorage.setItem('labelSize', v); }

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

  // ───────── API helpers ─────────
  const api = {
    get: (p) => axios.get(API + p).then(r => r.data),
    post: (p, d) => axios.post(API + p, d).then(r => r.data),
    del: (p) => axios.delete(API + p).then(r => r.data),
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
  }
  async function refreshPrint() {
    const r = await api.get('/print/queue');
    state.printQueue = r.queue || [];
  }
  async function refreshStats() {
    const r = await api.get('/inventory/stats');
    state.stats = r.stats || {};
  }

  // ───────── Layout / Shell ─────────
  function render() {
    const root = $('#app');
    root.innerHTML = '';
    root.appendChild(Shell());
    // Restore focus to scan input if on receive view
    if (state.view === 'receive') {
      setTimeout(() => $('#scan-input')?.focus(), 30);
    }
  }

  function Shell() {
    return h('div', { class: 'min-h-screen flex flex-col' },
      Topbar(),
      h('main', { class: 'flex-1 px-6 py-6 max-w-[1600px] mx-auto w-full' },
        state.view === 'dashboard' ? DashboardView()
        : state.view === 'manifests' ? ManifestsView()
        : state.view === 'receive' ? ReceiveView()
        : state.view === 'inventory' ? InventoryView()
        : state.view === 'print' ? PrintView()
        : state.view === 'settings' ? SettingsView()
        : h('div', {}, 'Not found')
      ),
      state.pendingMatch ? ConfirmSkuModal() : null,
      state.pendingUnrec ? UnreconciledModal() : null,
      state.labelPreview ? LabelPreviewModal() : null,
      state.deleteDevice ? DeleteDeviceModal() : null,
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
          Tab('print', 'Print Queue', 'print'),
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
            }, h('i', { class: 'fas fa-tag mr-1' }), 'DYMO 50×30'),
            h('button', {
              class: 'px-2 py-1 rounded-md text-xs font-medium transition ' +
                (state.labelSize === 'small' ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-400 hover:text-slate-200'),
              onclick: () => { setLabelSize('small'); render(); },
            }, h('i', { class: 'fas fa-receipt mr-1' }), 'DYMO 32×57'),
          ),
          h('button', {
            class: 'btn btn-ghost text-xs',
            title: 'Toggle scanner sound',
            onclick: () => { state.soundOn = !state.soundOn; render(); },
          }, h('i', { class: `fas fa-${state.soundOn ? 'volume-high' : 'volume-xmark'}` }))
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
    else if (v === 'print') refreshPrint().then(render);
    else if (v === 'settings') refreshSettings().then(render);
    render();
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
    if (!confirm('Delete this manifest and all expected lines? Received devices will remain in inventory.')) return;
    await api.del(`/manifests/${id}`);
    if (state.activeManifestId === id) state.activeManifestId = null;
    toast('Manifest deleted');
    await refreshManifests(); render();
  }

  // ───────── Manifest upload modal ─────────
  let uploadCtx = null;
  function openManifestUpload() {
    uploadCtx = { reference: '', supplier: '', notes: '', rows: [], fileName: '' };
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
          h('div', { class: 'text-xs text-slate-500 mt-1' }, 'Expected columns: OEM, Condition, Description, Grade, MODEL NO., IMEI'),
          h('input', {
            type: 'file', id: 'mf-file', class: 'hidden',
            accept: '.csv,.xls,.xlsx',
            onchange: (e) => handleFile(e.target.files[0]),
          })
        ),
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
                  h('th', { class: 'text-left px-3 py-2' }, 'Grade'),
                  h('th', { class: 'text-left px-3 py-2' }, 'Model No.'),
                  h('th', { class: 'text-left px-3 py-2' }, 'IMEI'),
                )
              ),
              h('tbody', { class: 'divide-y divide-slate-800' },
                uploadCtx.rows.slice(0, 5).map(r => h('tr', {},
                  h('td', { class: 'px-3 py-2' }, r.oem || '—'),
                  h('td', { class: 'px-3 py-2' }, r.description || '—'),
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
        const parsed = parseRows(rows);
        uploadCtx.rows = parsed;
        if (!uploadCtx.supplier) {
          // Try to grab supplier from filename
          const m = file.name.match(/-(.+?)_/);
          if (m) uploadCtx.supplier = m[1].trim();
        }
        toast(`Parsed ${parsed.length} devices`, 'ok');
        renderUploadModal();
      } catch (err) {
        console.error(err);
        toast('Failed to parse file', 'err');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // Normalise spreadsheet rows. Accepts headers like:
  //   OEM, Condition, Description, [grade col D unnamed], MODEL NO., IMEI, ...
  function parseRows(rows) {
    if (!rows || !rows.length) return [];
    // Find header row (first row that contains "IMEI" case-insensitive)
    let headerIdx = -1;
    let headers = null;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const r = rows[i] || [];
      if (r.some(c => c && String(c).toLowerCase().trim() === 'imei')) {
        headerIdx = i;
        headers = r.map(c => c == null ? '' : String(c).toLowerCase().trim());
        break;
      }
    }
    if (headerIdx < 0) return [];
    const colIdx = {
      oem: headers.findIndex(h => ['oem','brand','manufacturer'].includes(h)),
      condition: headers.findIndex(h => h === 'condition'),
      description: headers.findIndex(h => ['description','desc','model'].includes(h)),
      grade: headers.findIndex(h => h === 'grade'),
      model_no: headers.findIndex(h => ['model no.','model no','model number','model_no'].includes(h)),
      imei: headers.findIndex(h => h === 'imei'),
      unit_cost: headers.findIndex(h => ['unit cost','cost','price','unit_cost'].includes(h)),
    };
    // Handle the common case where column D (index 3) is grade but unnamed
    if (colIdx.grade < 0 && colIdx.description >= 0 && colIdx.model_no >= 0
        && colIdx.model_no - colIdx.description === 2) {
      colIdx.grade = colIdx.description + 1;
    }
    const out = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const imeiVal = colIdx.imei >= 0 ? r[colIdx.imei] : null;
      if (imeiVal == null || imeiVal === '') continue;
      const imei = String(imeiVal).trim();
      if (!/^\d{14,17}$/.test(imei)) continue;
      out.push({
        oem: colIdx.oem >= 0 ? (r[colIdx.oem] ?? null) : null,
        condition: colIdx.condition >= 0 ? (r[colIdx.condition] ?? null) : null,
        description: colIdx.description >= 0 ? (r[colIdx.description] ?? null) : null,
        grade: colIdx.grade >= 0 ? (r[colIdx.grade] ?? null) : null,
        model_no: colIdx.model_no >= 0 ? (r[colIdx.model_no] ?? null) : null,
        imei,
        unit_cost: colIdx.unit_cost >= 0 ? (Number(r[colIdx.unit_cost]) || null) : null,
      });
    }
    return out;
  }

  async function submitManifest() {
    if (!uploadCtx.reference || !uploadCtx.supplier) { toast('Reference and supplier are required', 'warn'); return; }
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
    if (!state.manifests.length) {
      return h('div', { class: 'card p-10 text-center' },
        h('i', { class: 'fas fa-file-invoice text-5xl text-slate-700 mb-4' }),
        h('h2', { class: 'text-xl font-semibold mb-2' }, 'No manifests yet'),
        h('p', { class: 'text-slate-400 mb-4' }, 'Upload a shipping manifest first, then come back to start scanning.'),
        h('button', { class: 'btn btn-primary', onclick: () => switchView('manifests') },
          h('i', { class: 'fas fa-cloud-arrow-up' }), 'Upload Manifest')
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
                  matched: 'badge-green', duplicate: 'badge-amber',
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
                e.grade ? h('span', { class: gradeBadgeClass(e.grade) }, e.grade) : null,
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
        beep('ok');
        state.pendingMatch = { expected: r.expected, suggested_sku: r.suggested_sku };
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
  function ConfirmSkuModal() {
    const { expected, suggested_sku } = state.pendingMatch;
    const ctx = state._confirmCtx ||= {
      sku: suggested_sku.sku,
      brand: suggested_sku.brand,
      model: suggested_sku.model,
      capacity: suggested_sku.capacity || '',
      color: suggested_sku.color,
      grade: expected.grade || '',
      notes: '',
    };
    const close = () => { state.pendingMatch = null; state._confirmCtx = null; render(); };
    const confirmIt = async () => {
      try {
        const r = await api.post('/scan/confirm', {
          expected_device_id: expected.id,
          sku: ctx.sku, brand: ctx.brand, model: ctx.model,
          capacity: ctx.capacity, color: ctx.color, grade: ctx.grade,
          notes: ctx.notes, auto_print: state.autoPrint,
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
        toast(err.response?.data?.error || 'Failed to confirm', 'err');
      }
    };
    const update = (k, v) => { ctx[k] = v; state._confirmCtx = ctx; render(); };

    return h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target.classList.contains('modal-backdrop')) close(); } },
      h('div', { class: 'modal p-6' },
        h('div', { class: 'flex items-center gap-3 mb-1' },
          h('div', { class: 'w-10 h-10 rounded-xl bg-green-500/10 text-green-400 flex items-center justify-center' },
            h('i', { class: 'fas fa-check' })),
          h('div', {},
            h('h2', { class: 'text-lg font-semibold' }, 'Matched on manifest'),
            h('p', { class: 'text-xs text-slate-400' }, 'Confirm the SKU mapping for this device.')
          )
        ),
        h('div', { class: 'mt-4 grid grid-cols-3 gap-3 text-sm' },
          h('div', { class: 'col-span-2 card p-3 bg-slate-900/40' },
            h('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500 mb-1' }, 'Manifest line'),
            h('div', { class: 'font-medium' }, expected.description || '(no description)'),
            h('div', { class: 'text-xs text-slate-400 mt-1' },
              h('span', { class: 'mono' }, expected.model_no || '—'),
              ' · ', expected.oem || '—', ' · grade ', expected.grade || '—')
          ),
          h('div', { class: 'card p-3 bg-slate-900/40' },
            h('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500 mb-1' }, 'IMEI'),
            h('div', { class: 'mono font-semibold' }, expected.imei)
          )
        ),
        h('div', { class: 'mt-4' },
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'SKU (auto-generated)'),
          h('input', { class: 'input mono text-lg font-bold', value: ctx.sku, oninput: (e) => update('sku', e.target.value) })
        ),
        h('div', { class: 'mt-3 grid grid-cols-2 gap-3' },
          field('Brand', ctx.brand, (v) => update('brand', v)),
          field('Model', ctx.model, (v) => update('model', v)),
          field('Capacity', ctx.capacity, (v) => update('capacity', v), 'mono'),
          h('div', {},
            h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Color'),
            h('select', {
              class: 'input',
              onchange: (e) => update('color', e.target.value),
            },
              ['Phantom Black','Phantom Gray','Graphite','Cream','Lavender','Violet','Mint','Cloud Navy','Silver','White'].map(o =>
                h('option', { value: o, selected: o === ctx.color ? 'selected' : null }, o))
            )
          ),
          h('div', {},
            h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Grade'),
            h('select', {
              class: 'input mono',
              onchange: (e) => update('grade', e.target.value),
            },
              ['','A+','A','B+','B','C+','C','D','UG'].map(o =>
                h('option', { value: o, selected: o === ctx.grade ? 'selected' : null }, o || '— none —'))
            )
          ),
          h('label', { class: 'flex items-center gap-2 text-sm text-slate-300 select-none' },
            h('input', { type: 'checkbox', class: 'accent-cyan-500', checked: state.autoPrint ? 'checked' : null,
              onchange: (e) => { state.autoPrint = e.target.checked; } }),
            'Auto-queue print label'
          ),
        ),
        h('div', { class: 'mt-5 flex items-center justify-between' },
          h('div', { class: 'text-xs text-slate-500' },
            'Press ', h('span', { class: 'kbd' }, 'Enter'), ' to confirm · ',
            h('span', { class: 'kbd' }, 'Esc'), ' to cancel'),
          h('div', { class: 'flex gap-2' },
            h('button', { class: 'btn btn-ghost', onclick: close }, 'Cancel'),
            h('button', { class: 'btn btn-primary', onclick: confirmIt },
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
    const ctx = state._unrecCtx ||= { oem: 'SMSG', description: '', grade: 'B', color: 'Phantom Black', notes: '' };
    const close = () => { state.pendingUnrec = null; state._unrecCtx = null; render(); };
    const reject = async () => {
      await api.post('/scan/reject', { manifest_id: state.activeManifestId, imei, reason: 'Not on manifest — rejected by operator' });
      toast('Device rejected', 'warn');
      state.pendingUnrec = null; state._unrecCtx = null;
      await refreshActiveManifest(); render();
    };
    const forceAdd = async () => {
      try {
        const r = await api.post('/scan/force-add', { manifest_id: state.activeManifestId, imei, ...ctx });
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
            h('select', { class: 'input mono', onchange: (e) => update('grade', e.target.value) },
              ['','A+','A','B+','B','C+','C','D','UG'].map(o =>
                h('option', { value: o, selected: o === ctx.grade ? 'selected' : null }, o || '— none —')))
          ),
        ),
        h('div', { class: 'mt-3' },
          h('label', { class: 'text-xs text-slate-400 mb-1 block' }, 'Notes for manager'),
          h('textarea', { class: 'input', rows: 2, value: ctx.notes, oninput: (e) => update('notes', e.target.value) })
        ),
        h('div', { class: 'mt-5 flex justify-end gap-2' },
          h('button', { class: 'btn btn-danger', onclick: reject }, h('i', { class: 'fas fa-ban' }), 'Reject Device'),
          h('button', { class: 'btn btn-ghost', onclick: close }, 'Cancel'),
          h('button', { class: 'btn btn-primary', onclick: forceAdd },
            h('i', { class: 'fas fa-plus' }), 'Force-add to Unreconciled')
        )
      )
    );
  }

  // ───────── Label preview ─────────
  const LABEL_SIZES = {
    large: { id: 'large', name: 'DYMO 50×30mm', printer: 'DYMO LabelWriter 450' },
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
      // DYMO 50×30mm — landscape, two-column with dual QRs
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
    return h('div', { class: 'space-y-5' },
      h('div', { class: 'flex items-center justify-between' },
        h('div', {},
          h('h1', { class: 'text-2xl font-bold' }, 'Inventory'),
          h('p', { class: 'text-slate-400 text-sm' }, 'Devices that have been physically received. Grading happens downstream.')
        ),
        h('div', { class: 'flex gap-2' },
          h('input', {
            class: 'input', placeholder: 'Search IMEI / SKU / UUID',
            oninput: (e) => debouncedSearch(e.target.value),
          }),
        )
      ),
      h('div', { class: 'card overflow-hidden' },
        h('table', { class: 'w-full text-sm' },
          h('thead', { class: 'bg-slate-900/50 text-xs uppercase text-slate-400' },
            h('tr', {},
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
              ? h('tr', {}, h('td', { colspan: 9, class: 'text-center py-10 text-slate-500' }, 'No devices yet.'))
              : state.inventory.map(d => h('tr', { class: 'row-strip' },
                h('td', { class: 'px-4 py-2 mono text-xs text-slate-300' }, d.uuid),
                h('td', { class: 'px-4 py-2 mono text-xs' }, d.imei),
                h('td', { class: 'px-4 py-2 mono text-xs font-semibold text-cyan-300' }, d.sku),
                h('td', { class: 'px-4 py-2 text-xs' },
                  h('div', { class: 'font-medium' }, [d.brand, d.model].filter(Boolean).join(' ')),
                  h('div', { class: 'text-slate-500' }, [d.capacity, d.color].filter(Boolean).join(' · '))
                ),
                h('td', { class: 'px-4 py-2' },
                  d.grade ? h('span', { class: gradeBadgeClass(d.grade) }, d.grade) : h('span', { class: 'text-slate-600' }, '—')),
                h('td', { class: 'px-4 py-2' },
                  d.source === 'manifest'
                    ? h('span', { class: 'badge badge-green text-[10px]' }, 'manifest')
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
          h('li', {}, 'Make sure the loaded label stock matches the selected size in the topbar (DYMO 50×30 or DYMO 32×57).'),
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
          h('label', { class: 'text-xs text-slate-400' }, 'DYMO 50×30 mm (large label)'),
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
      const r = await api.post(`/print/send/${id}?size=${state.labelSize}`);
      if (r.mode === 'browser') {
        const win = window.open(r.url, '_blank', 'width=720,height=520');
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
      const r = await api.post(`/print/send-all?size=${state.labelSize}`);
      if (r.mode === 'browser') {
        const win = window.open(r.url, '_blank', 'width=720,height=520');
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
