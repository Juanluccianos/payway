/* =============================================================================
 *  Liquidaciones Payway → Shares — Lucciano's (frontend)
 *  Vanilla JS, sin build. Habla con el Worker (window.PAYWAY_API).
 *  Los PDFs se leen ACÁ, en el navegador, con pdf.js (lector-payway.js).
 *  Rutas: #/inicio, #/mes/AAAA-MM, #/liq/ID, #/locales, #/admin, #/guia, #/cuenta
 * ============================================================================= */
'use strict';

// ---------------------------------------------------------------------------
//  Estado y utilidades
// ---------------------------------------------------------------------------
const API = (() => {
  // ?api=http://localhost:8787 permite apuntar a otro Worker (pruebas)
  try {
    const q = new URLSearchParams(location.search).get('api');
    if (q) localStorage.setItem('payway_api', q);
    return (localStorage.getItem('payway_api') || window.PAYWAY_API).replace(/\/$/, '');
  } catch { return String(window.PAYWAY_API).replace(/\/$/, ''); }
})();

const S = { token: null, user: null, simulacion: true, cuentas: null };
try { S.token = localStorage.getItem('payway_token'); } catch { /* sin storage */ }

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NIVEL = { carga: 1, aprobador: 2, admin: 3 };
const puede = (rol) => S.user && NIVEL[S.user.rol] >= NIVEL[rol];
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

const fmtNum = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const $$m = (n) => { if (n === null || n === undefined || n === '') return '—'; const x = Number(n); return Number.isFinite(x) ? '$ ' + fmtNum.format(x) : '—'; };
const $$corto = (n) => { n = Number(n) || 0; return Math.abs(n) >= 1e6 ? '$ ' + (n / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' M' : $$m(n); };
const fmtF = (v) => { if (!v) return '—'; const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v); };
// Las fechas de la base vienen en UTC "AAAA-MM-DD HH:MM:SS"
const fechaDb = (s) => { if (!s) return null; const d = new Date(String(s).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z')); return Number.isNaN(d.getTime()) ? null : d; };
const fmtFH = (s) => { const d = fechaDb(s); return d ? d.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—'; };
const fmtHora = (s) => { const d = fechaDb(s); return d ? d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '--:--:--'; };
const fmtCuit = (c) => { c = String(c || ''); return c.length === 11 ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : (c || '—'); };
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nombreMes = (p) => { const [y, m] = String(p).split('-'); return `${MESES[Number(m) - 1] || '?'} ${y}`; };
const NombreMes = (p) => { const s = nombreMes(p); return s.charAt(0).toUpperCase() + s.slice(1); };
const mesAnterior = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const ESTADOS = { excepcion: 'Para revisar', lista: 'Lista para Shares', cargada: 'Cargada en Shares', error_shares: 'Error de Shares', excluida: 'Excluida' };
const badgeEstado = (e, extra = '') => `<span class="badge b-${e === 'excluida' ? 'aviso' : esc(e)}">${esc(ESTADOS[e] || e)}${extra}</span>`;
const nombreLocal = (f) => f.alias || (f.denominacion ? f.denominacion.replace(/^COMISIONES PAGADAS L\.?\s*/i, '') : '') || f.direccion || 'Sin local';
const refLiq = (f) => `${f.nro_establecimiento}-${f.nro_resumen}`;

function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'ver' + (error ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = ''; }, error ? 6000 : 3000);
}

async function api(path, { method = 'GET', body, raw = false, reintentos = null } = {}) {
  // "Failed to fetch" = no llegó respuesta. Los GET se reintentan solos; el resto según "reintentos".
  let res;
  const max = reintentos ?? (method === 'GET' ? 2 : 0);
  for (let intento = 0; ; intento++) {
    try {
      res = await fetch(API + path, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if ([502, 503, 504].includes(res.status) && intento < max) throw new TypeError('HTTP ' + res.status);
      break;
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      if (intento >= max) throw new Error(method === 'GET' ? 'No hay conexión con el servidor. Probá de nuevo en unos segundos.' : 'Se cortó la conexión con el servidor.');
      await dormir(800 * (intento + 1));
    }
  }
  if (res.status === 401 && S.token && !path.startsWith('/api/login')) {
    salir(false);
    throw new Error('La sesión venció. Volvé a ingresar.');
  }
  if (raw) { if (!res.ok) throw new Error('HTTP ' + res.status); return res; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'HTTP ' + res.status); e.status = res.status; throw e; }
  return data;
}

async function conBoton(btn, fn) {
  const txt = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="cargando"></span>'; }
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = txt; } }
}

function modal(html, { ancho = false, alMontar, fijo = false } = {}) {
  const m = $('#modal');
  $('.modal-box', m).classList.toggle('ancho', ancho);
  $('.modal-cuerpo', m).innerHTML = html;
  $('.modal-cerrar', m).hidden = fijo;
  m.hidden = false;
  const cerrar = () => { m.hidden = true; $('.modal-cuerpo', m).innerHTML = ''; };
  $('.modal-cerrar', m).onclick = cerrar;
  m.onclick = (e) => { if (e.target === m && !fijo) cerrar(); };
  if (alMontar) alMontar($('.modal-cuerpo', m), cerrar);
  const primero = $('input:not([type=checkbox]), textarea, select', m);
  if (primero) setTimeout(() => primero.focus(), 30);
  return cerrar;
}

function confirmar(texto, { boton = 'Sí, seguir', peligro = false, titulo = '¿Confirmás?' } = {}) {
  return new Promise((resolve) => {
    let hecho = false;
    modal(`<h2 style="margin-bottom:6px">${esc(titulo)}</h2><p class="muted" style="white-space:pre-line;margin:0 0 18px">${esc(texto)}</p>
      <div class="acciones" style="justify-content:flex-end"><button class="btn" data-no>Cancelar</button><button class="btn ${peligro ? 'btn-rojo' : 'btn-acento'}" data-si>${esc(boton)}</button></div>`, {
      alMontar: (el, cerrar) => {
        const fin = (v) => { if (hecho) return; hecho = true; cerrar(); resolve(v); };
        $('[data-si]', el).onclick = () => fin(true);
        $('[data-no]', el).onclick = () => fin(false);
        setTimeout(() => $('[data-si]', el)?.focus(), 0);
        const obs = new MutationObserver(() => { if ($('#modal').hidden) { obs.disconnect(); if (!hecho) { hecho = true; resolve(false); } } });
        obs.observe($('#modal'), { attributes: true });
      },
    });
  });
}

function pedirTexto({ titulo, ayuda = '', etiqueta = 'Comentario', boton = 'Confirmar', minimo = 5, valor = '' }) {
  return new Promise((resolve) => {
    let listo = false;
    modal(`<h2>${esc(titulo)}</h2>${ayuda ? `<p class="muted">${esc(ayuda)}</p>` : ''}
      <div class="campo"><label>${esc(etiqueta)}</label><textarea id="pt-txt">${esc(valor)}</textarea></div>
      <div class="acciones"><button class="btn btn-negro" id="pt-ok">${esc(boton)}</button><button class="btn" id="pt-no">Cancelar</button></div>`, {
      alMontar: (el, cerrar) => {
        $('#pt-ok', el).onclick = () => {
          const v = $('#pt-txt', el).value.trim();
          if (v.length < minimo) { toast(`Escribí al menos ${minimo} caracteres.`, true); return; }
          listo = true; cerrar(); resolve(v);
        };
        $('#pt-no', el).onclick = () => { cerrar(); resolve(null); };
        const obs = new MutationObserver(() => { if ($('#modal').hidden) { obs.disconnect(); if (!listo) resolve(null); } });
        obs.observe($('#modal'), { attributes: true });
      },
    });
  });
}

function descargar(nombre, contenido, tipo = 'text/plain;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(contenido instanceof Blob ? contenido : new Blob([contenido], { type: tipo }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function cargarScript(src) {
  return new Promise((ok, mal) => {
    if ($(`script[src="${src}"]`)) { const s = $(`script[src="${src}"]`); if (s.dataset.ok) return ok(); s.addEventListener('load', () => ok()); s.addEventListener('error', mal); return; }
    const sc = document.createElement('script');
    sc.src = src; sc.onload = () => { sc.dataset.ok = '1'; ok(); }; sc.onerror = () => { sc.remove(); mal(new Error('No cargó ' + src.split('/').pop() + '. Revisá la conexión.')); };
    document.head.appendChild(sc);
  });
}

// ---------------------------------------------------------------------------
//  Sesión
// ---------------------------------------------------------------------------
function guardarToken(t) { S.token = t; try { t ? localStorage.setItem('payway_token', t) : localStorage.removeItem('payway_token'); } catch { } }
async function salir(llamarApi = true) {
  if (PROC.activo && !await confirmar('Hay un proceso corriendo. Si salís se corta.', { boton: 'Salir igual', peligro: true })) return;
  if (llamarApi) await api('/api/logout', { method: 'POST' }).catch(() => null);
  guardarToken(null); S.user = null; S.cuentas = null;
  location.hash = '';
  vistaLogin();
}

// ---------------------------------------------------------------------------
//  Íconos (trazo de 2px, estilo feather)
// ---------------------------------------------------------------------------
const svgI = (p) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICO = {
  home: svgI('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>'),
  doc: svgI('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>'),
  send: svgI('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>'),
  users: svgI('<path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><circle cx="9" cy="8" r="4"/><path d="M17 11a3 3 0 1 0 0-6M21 21v-2a4 4 0 0 0-3-3.87"/>'),
  gear: svgI('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  search: svgI('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  upload: svgI('<path d="M12 15V3M8 7l4-4 4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  folder: svgI('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  refresh: svgI('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
  logout: svgI('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  check: svgI('<path d="M20 6 9 17l-5-5"/>'),
  arrow: svgI('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  back: svgI('<path d="M19 12H5M11 18l-6-6 6-6"/>'),
  x: svgI('<path d="M6 6l12 12M18 6 6 18"/>'),
  shield: svgI('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>'),
  sun: svgI('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svgI('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  info: svgI('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>'),
  alert: svgI('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  ojo: svgI('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  ojoNo: svgI('<path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20"/>'),
  calendar: svgI('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  store: svgI('<path d="M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6"/>'),
  book: svgI('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>'),
  terminal: svgI('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3M12 15h5"/>'),
  excel: svgI('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 12l4 6M12 12l-4 6"/>'),
  download: svgI('<path d="M12 3v12M8 11l4 4 4-4M4 21h16"/>'),
  copy: svgI('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  lock: svgI('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  unlock: svgI('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>'),
  play: svgI('<path d="M6 4l14 8-14 8z"/>'),
  stop: svgI('<rect x="6" y="6" width="12" height="12" rx="1"/>'),
  user: svgI('<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>'),
  flask: svgI('<path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/><path d="M7 15h10"/>'),
  trash: svgI('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  phone: svgI('<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>'),
};
const iniciales = (s) => String(s || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();

// Ojito para ver la contraseña
function ojosClave(root = document) {
  $$('input[type="password"]:not([data-ojo])', root).forEach(inp => {
    inp.dataset.ojo = '1';
    const caja = document.createElement('span');
    caja.className = 'clave-caja';
    inp.parentNode.insertBefore(caja, inp);
    caja.appendChild(inp);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'clave-ojo'; b.tabIndex = -1; b.title = 'Mostrar contraseña';
    b.innerHTML = ICO.ojo;
    b.onclick = () => { const ver = inp.type === 'password'; inp.type = ver ? 'text' : 'password'; b.innerHTML = ver ? ICO.ojoNo : ICO.ojo; inp.focus(); };
    caja.appendChild(b);
  });
}
new MutationObserver(() => ojosClave()).observe(document.documentElement, { childList: true, subtree: true });

function temaActual() { const t = document.documentElement.dataset.theme; return t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
function alternarTema() {
  const nuevo = temaActual() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nuevo;
  try { localStorage.setItem('payway_tema', nuevo); } catch { }
  const b = $('#b-tema'); if (b) b.innerHTML = nuevo === 'dark' ? ICO.sun : ICO.moon;
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => null));
}

// ---------------------------------------------------------------------------
//  pdf.js (lee los PDFs en la compu)
// ---------------------------------------------------------------------------
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let _pdfjsCarga = null;
function cargarPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!_pdfjsCarga) _pdfjsCarga = cargarScript(PDFJS + 'pdf.min.js').then(() => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
    return window.pdfjsLib;
  }).catch(e => { _pdfjsCarga = null; throw e; });
  return _pdfjsCarga;
}

// ---------------------------------------------------------------------------
//  PROCESO DE PDFs: se leen en el navegador y se mandan los DATOS (no el PDF)
//  de a 3 al Worker. Mientras corre se ve qué archivo se está leyendo; al
//  final aparece la lista de lo que hay que corregir.
// ---------------------------------------------------------------------------
const PROC = { activo: false, tipo: null, periodo: null, total: 0, hechos: 0, listas: 0, revisar: 0, duplicados: 0, errores: 0, cargadas: 0, ya_existian: 0, simuladas: 0, cancelar: false, inicio: 0, actuales: [], ultimos: [] };
const PARALELO = 3;

window.addEventListener('beforeunload', (e) => { if (PROC.activo) { e.preventDefault(); e.returnValue = ''; } });

// "comprobante-2026-09-30-844035-MONTHLY.pdf" → 2026-09
function periodoDeNombres(files) {
  const c = {};
  for (const f of files) { const m = /(20\d{2})-(\d{2})-\d{2}/.exec(f.name); if (m) c[`${m[1]}-${m[2]}`] = (c[`${m[1]}-${m[2]}`] || 0) + 1; }
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

// Junta archivos de un drop (incluye carpetas arrastradas)
async function archivosDeDrop(dt) {
  const out = [];
  const leerEntrada = (ent) => new Promise((ok) => {
    if (ent.isFile) ent.file(f => { out.push(f); ok(); }, () => ok());
    else if (ent.isDirectory) {
      const r = ent.createReader(); const todos = [];
      const sig = () => r.readEntries(async (lote) => { if (!lote.length) { for (const e of todos) await leerEntrada(e); ok(); } else { todos.push(...lote); sig(); } }, () => ok());
      sig();
    } else ok();
  });
  const items = [...(dt.items || [])].map(i => i.webkitGetAsEntry ? i.webkitGetAsEntry() : null).filter(Boolean);
  if (items.length) { for (const e of items) await leerEntrada(e); return out; }
  return [...(dt.files || [])];
}

function elegirArchivos({ carpeta = false } = {}) {
  return new Promise((ok) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.accept = 'application/pdf,.pdf';
    if (carpeta) inp.webkitdirectory = true;
    inp.onchange = () => ok([...inp.files]);
    inp.click();
  });
}

// PDFs que no se pudieron leer en la última corrida de cada mes (sobreviven a un F5)
const noLeidos = {
  get: (p) => { try { return JSON.parse(sessionStorage.getItem('pw_noleidos_' + p) || '[]'); } catch { return []; } },
  set: (p, l) => { try { sessionStorage.setItem('pw_noleidos_' + p, JSON.stringify(l)); } catch { } },
};

// Punto de entrada: archivos elegidos → confirmar mes → procesar
async function iniciarSubida(files, periodoSugerido = null) {
  if (PROC.activo) { toast('Ya hay un proceso corriendo: esperá a que termine.', true); return; }
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const otros = files.length - pdfs.length;
  if (!pdfs.length) { toast(files.length ? 'No hay PDFs entre los archivos elegidos.' : 'No elegiste archivos.', true); return; }
  const detectado = periodoDeNombres(pdfs);
  const periodo = await new Promise((resolve) => {
    let listo = false;
    modal(`<h2>Procesar ${pdfs.length} PDF${pdfs.length === 1 ? '' : 's'} de Payway</h2>
      <p class="muted">Se leen acá en tu compu (no se suben ni se guardan los PDFs: solo los datos), se controlan y quedan listas para Shares. ${otros ? `<br><b>${otros} archivo(s) que no son PDF se ignoran.</b>` : ''}</p>
      <div class="campo"><label for="p-mes">Mes de las liquidaciones</label><input type="month" id="p-mes" value="${esc(periodoSugerido || detectado || mesAnterior())}" max="2099-12"></div>
      ${detectado ? `<p class="ayuda" style="margin-top:-6px">Por el nombre de los archivos parecen de <b>${esc(nombreMes(detectado))}</b>.</p>` : ''}
      <div class="acciones" style="margin-top:16px"><button class="btn btn-acento btn-grande" id="p-ok">${ICO.play}Procesar</button><button class="btn" id="p-no">Cancelar</button></div>`, {
      alMontar: (el, cerrar) => {
        $('#p-ok', el).onclick = () => { const v = $('#p-mes', el).value; if (!/^\d{4}-\d{2}$/.test(v)) { toast('Elegí el mes.', true); return; } listo = true; cerrar(); resolve(v); };
        $('#p-no', el).onclick = () => { cerrar(); resolve(null); };
        const obs = new MutationObserver(() => { if ($('#modal').hidden) { obs.disconnect(); if (!listo) resolve(null); } });
        obs.observe($('#modal'), { attributes: true });
      },
    });
  });
  if (!periodo) return;
  try { await api('/api/lotes/' + periodo, { method: 'POST' }); } catch (e) { toast(e.message, true); return; }
  if (location.hash !== '#/mes/' + periodo) { location.hash = '#/mes/' + periodo; await dormir(50); }
  else await router();
  await procesarPdfs(pdfs, periodo);
}

async function huella(buf) {
  try { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join(''); } catch { return null; }
}

async function procesarPdfs(pdfs, periodo) {
  Object.assign(PROC, { activo: true, tipo: 'subida', periodo, total: pdfs.length, hechos: 0, listas: 0, revisar: 0, duplicados: 0, errores: 0, cancelar: false, inicio: Date.now(), actuales: [], ultimos: [] });
  const res = { noLeidos: [], revisar: [], duplicados: [] };
  pintarProceso();
  let pdfjs;
  try { pdfjs = await cargarPdfjs(); }
  catch (e) { PROC.activo = false; pintarProceso(); toast('No cargó el lector de PDF (pdf.js): ' + e.message, true); return; }

  let i = 0;
  const trabajador = async () => {
    while (i < pdfs.length && !PROC.cancelar) {
      const f = pdfs[i++];
      PROC.actuales.push(f.name); pintarProceso();
      let estado = 'error', detalle = '';
      try {
        if (f.size > 12e6) throw new Error('supera 12 MB');
        const buf = await f.arrayBuffer();
        const hash = await huella(buf);
        const r = await PaywayLector.leer(pdfjs, new Uint8Array(buf.slice(0)), f.name);
        if (!r.ok) throw new Error('no pude leer ' + r.faltan.join(', ') + '. ¿Es un Resumen Mensual de Liquidaciones de Payway?');
        r.datos.paginas = r.paginas;
        let x = null;
        for (let intento = 0; intento < 3 && !x; intento++) {
          try { x = await api('/api/liquidaciones', { method: 'POST', body: { periodo, datos: r.datos, archivo_hash: hash } }); }
          catch (e) {
            // Si se cortó la red, reintentamos: el Worker no duplica (controla establecimiento + resumen)
            if (intento === 2 || (e.status && e.status < 500)) throw e;
            await dormir(1500 * (intento + 1));
          }
        }
        if (x.duplicado) { PROC.duplicados++; estado = 'dup'; res.duplicados.push({ archivo: f.name, id: x.id, mensaje: x.mensaje }); }
        else if (x.estado === 'lista') { PROC.listas++; estado = 'ok'; }
        else {
          PROC.revisar++; estado = 'revisar';
          const e1 = (x.problemas || []).filter(p => p.nivel === 'error');
          res.revisar.push({ archivo: f.name, id: x.id, direccion: x.direccion, total: x.total_descuento, problemas: e1 });
          detalle = e1.map(p => p.mensaje).join(' ');
        }
      } catch (e) {
        PROC.errores++;
        // pdf.js responde en inglés: lo paso a criollo
        if (/Invalid PDF|PDF header|Missing PDF|bad XRef|FormatError|InvalidPDFException/i.test(e.message)) e.message = `El archivo está dañado o no es un PDF válido (${e.message.replace(/\.$/, '')}).`;
        else if (/password/i.test(e.message)) e.message = 'El PDF tiene contraseña.';
        detalle = e.message;
        res.noLeidos.push({ archivo: f.name, mensaje: e.message });
      }
      PROC.actuales = PROC.actuales.filter(n => n !== f.name);
      PROC.ultimos.unshift({ archivo: f.name, estado, detalle });
      PROC.ultimos = PROC.ultimos.slice(0, 6);
      PROC.hechos++;
      pintarProceso();
      refrescoVivo(periodo);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALELO, pdfs.length) }, trabajador));
  PROC.segundos = Math.round((Date.now() - PROC.inicio) / 1000);
  PROC.activo = false;
  noLeidos.set(periodo, res.noLeidos);
  pintarProceso();
  if (location.hash === '#/mes/' + periodo) await recargarMes();
  mostrarResultadoCorrida(periodo, res);
}

// ---- Al terminar: resumen + lista de lo que hay que corregir ----
// Cada error arranca por el NOMBRE DEL ARCHIVO, para buscarlo directo en la carpeta
function filaCorregir({ archivos = [], titulo, sub, motivo, acciones = '' }) {
  const arch = archivos.filter(Boolean);
  return `<li class="corr"><div class="corr-ico">${ICO.alert}</div><div class="corr-txt">
    ${arch.length ? `<div class="corr-arch">${arch.map(a => `<span class="arch" title="Copiar el nombre" data-copiar="${esc(a)}">${ICO.doc}${esc(a)}</span>`).join('')}</div>` : ''}
    ${titulo ? `<b>${esc(titulo)}</b>` : ''}${sub ? `<small>${esc(sub)}</small>` : ''}<p>${esc(motivo)}</p></div><div class="corr-acc">${acciones}</div></li>`;
}
// Clic en un nombre de archivo = se copia (para pegarlo en el buscador de Windows)
document.addEventListener('click', async (e) => {
  const x = e.target.closest('[data-copiar]');
  if (!x) return;
  e.preventDefault(); e.stopPropagation();
  try { await navigator.clipboard.writeText(x.dataset.copiar); toast('Copiado: ' + x.dataset.copiar); } catch { toast('No se pudo copiar', true); }
});

function mostrarResultadoCorrida(periodo, res) {
  const p = PROC;
  const hayErr = res.noLeidos.length || res.revisar.length;
  // Agrupo las direcciones sin cuenta: se arreglan de una sola vez
  const sinLocal = {};
  for (const r of res.revisar) if (r.problemas.some(x => x.codigo === 'SIN_LOCAL')) (sinLocal[r.direccion] = sinLocal[r.direccion] || []).push(r.archivo);
  const otros = res.revisar.filter(r => !r.problemas.some(x => x.codigo === 'SIN_LOCAL') || r.problemas.length > 1);
  modal(`<div class="res-cab ${hayErr ? 'mal' : 'bien'}">${hayErr ? ICO.alert : ICO.check}<div><h2>${p.cancelar ? 'Corrida detenida' : hayErr ? `Terminó: ${res.noLeidos.length + res.revisar.length} PDF(s) para corregir` : 'Terminó: todo OK'}</h2>
      <p>${p.hechos} de ${p.total} PDF(s) en ${p.segundos} s · <b>${p.listas}</b> listas para Shares${p.duplicados ? ` · ${p.duplicados} ya estaban cargadas` : ''}</p></div></div>
    ${Object.keys(sinLocal).length ? `<h3 class="res-h">Locales sin cuenta de comisiones</h3><ul class="corregir">${Object.entries(sinLocal).map(([dir, arch]) => filaCorregir({ archivos: arch, titulo: `Dirección en el PDF: ${dir || '(vacía)'}`, motivo: `Esta dirección no está en la lista de locales (${arch.length} PDF). Asignale la cuenta y se arreglan todos juntos.`, acciones: puede('aprobador') ? `<button class="btn btn-chico btn-negro" data-asig="${esc(dir)}">Asignar cuenta</button>` : '' })).join('')}</ul>` : ''}
    ${otros.length ? `<h3 class="res-h">No cerró algún control</h3><ul class="corregir">${otros.map(r => filaCorregir({ archivos: [r.archivo], sub: `${r.direccion || ''} · ${$$m(r.total)}`, motivo: r.problemas.filter(x => x.codigo !== 'SIN_LOCAL').map(x => x.mensaje).join(' '), acciones: `<a class="btn btn-chico" href="#/liq/${r.id}">Ver</a>` })).join('')}</ul>` : ''}
    ${res.noLeidos.length ? `<h3 class="res-h">No se pudieron leer</h3><ul class="corregir">${res.noLeidos.map(r => filaCorregir({ archivos: [r.archivo], motivo: r.mensaje })).join('')}</ul><p class="ayuda">Revisá que sean “Resumen Mensual de Liquidaciones” de Payway y volvé a arrastrar solo esos.</p>` : ''}
    ${res.duplicados.length ? `<details class="res-dup"><summary>${res.duplicados.length} ya estaban cargadas (no se duplicaron)</summary><ul>${res.duplicados.map(d => `<li class="small mono">${esc(d.archivo)}</li>`).join('')}</ul></details>` : ''}
    <div class="acciones" style="margin-top:18px;justify-content:flex-end"><button class="btn btn-acento" data-cerrar>${hayErr ? 'Entendido' : 'Listo'}</button></div>`, {
    ancho: true,
    alMontar: (el, cerrar) => {
      $('[data-cerrar]', el).onclick = cerrar;
      $$('a[href^="#/liq/"]', el).forEach(a => a.addEventListener('click', cerrar));
      $$('[data-asig]', el).forEach(b => b.onclick = () => { cerrar(); modalLocal({ direccion: b.dataset.asig }, recargarMes); });
    },
  });
}

// ---- Envío a Shares en tandas de 5 ----
async function enviarAShares(periodo, ids, { titulo } = {}) {
  if (PROC.activo) { toast('Ya hay un proceso corriendo.', true); return; }
  if (!ids.length) { toast('No hay liquidaciones listas para enviar.', true); return; }
  const yo = await api('/api/yo').catch(() => null);
  if (yo) S.simulacion = yo.modo_simulacion;
  const ok = await confirmar(S.simulacion
    ? `Modo SIMULACIÓN prendido: se arma cada comprobante y se controla, pero NO se manda nada a Shares.\n\n${ids.length} liquidación(es). Para cargar de verdad, apagá la simulación en Configuración → Ajustes.`
    : `Se van a cargar ${ids.length} liquidación(es) en Shares como comprobantes de Banco Macro / Nación.\nLas que ya existan en Shares vuelven con 409 y quedan marcadas, no se duplican.`,
    { titulo: titulo || (S.simulacion ? 'Simular envío a Shares' : 'Enviar a Shares'), boton: S.simulacion ? 'Simular' : `Enviar ${ids.length}` });
  if (!ok) return;
  Object.assign(PROC, { activo: true, tipo: 'shares', periodo, total: ids.length, hechos: 0, cargadas: 0, ya_existian: 0, simuladas: 0, errores: 0, cancelar: false, inicio: Date.now(), actuales: [], ultimos: [] });
  const errores = [];
  const liqDe = (id) => MES?.datos?.liquidaciones?.find(x => x.id === id);
  const nombre = (id) => { const f = liqDe(id); return f ? (f.archivo_nombre || nombreLocal(f)) : '#' + id; };
  pintarProceso();
  let fatal = null;
  for (let k = 0; k < ids.length && !PROC.cancelar && !fatal; k += 5) {
    const tanda = ids.slice(k, k + 5);
    PROC.actuales = tanda.map(nombre); pintarProceso();
    try {
      const r = await api('/api/shares/enviar', { method: 'POST', body: { ids: tanda } });
      for (const x of r.resultados) {
        let estado = 'ok';
        if (x.simulado) PROC.simuladas++;
        else if (x.ok && x.resultado === 'duplicado') { PROC.ya_existian++; estado = 'dup'; }
        else if (x.ok) PROC.cargadas++;
        else if (!x.omitida) { PROC.errores++; estado = 'error'; errores.push(x); }
        if (x.fatal) fatal = x.message;
        PROC.ultimos.unshift({ archivo: `${nombre(x.id)} · ${x.ref || ''}`, estado, detalle: estado === 'error' ? x.message : x.shares_ref ? 'nro_reg ' + x.shares_ref : '' });
      }
      PROC.ultimos = PROC.ultimos.slice(0, 6);
    } catch (e) {
      // Sin respuesta: no sabemos si la tanda entró. Cortamos; al reenviar, Shares contesta 409 en las que ya estén.
      fatal = e.message + ' (la última tanda pudo haber entrado: al reenviar, las que ya estén vuelven como "ya existía")';
    }
    PROC.hechos = Math.min(ids.length, k + tanda.length);
    pintarProceso();
    refrescoVivo(periodo);
  }
  PROC.segundos = Math.round((Date.now() - PROC.inicio) / 1000);
  PROC.activo = false; PROC.actuales = [];
  pintarProceso();
  if (location.hash === '#/mes/' + periodo) await recargarMes();
  const p = PROC;
  if (!errores.length && !fatal) { toast(S.simulacion ? `Simulación OK: ${p.simuladas} comprobantes armados bien (no se envió nada).` : `Listo: ${p.cargadas} cargadas en Shares${p.ya_existian ? `, ${p.ya_existian} ya existían` : ''}.`); return; }
  modal(`<div class="res-cab mal">${ICO.alert}<div><h2>${fatal ? 'Se cortó el envío' : `Terminó: ${errores.length} con error`}</h2>
      <p>${p.hechos} de ${p.total} en ${p.segundos} s · <b>${p.cargadas}</b> cargadas${p.ya_existian ? ` · ${p.ya_existian} ya existían` : ''}${p.simuladas ? ` · ${p.simuladas} simuladas` : ''}</p></div></div>
    ${fatal ? `<ul class="corregir">${filaCorregir({ titulo: 'Problema de conexión con Shares', motivo: fatal })}</ul>` : ''}
    ${errores.length ? `<h3 class="res-h">Shares no las aceptó</h3><ul class="corregir">${errores.map(x => filaCorregir({ archivos: [liqDe(x.id)?.archivo_nombre], sub: `${x.direccion || ''} · ${x.ref || ''}${x.http_status ? ' · HTTP ' + x.http_status : ''}`, motivo: x.message || 'Error sin detalle', acciones: `<a class="btn btn-chico" href="#/liq/${x.id}">Ver</a>` })).join('')}</ul>
      <p class="ayuda">Corregí lo que dice Shares y volvé a tocar “Enviar a Shares”: se reenvían solo las que dieron error.</p>` : ''}
    <div class="acciones" style="margin-top:18px;justify-content:flex-end"><button class="btn btn-acento" data-cerrar>Entendido</button></div>`, {
    ancho: true, alMontar: (el, cerrar) => { $('[data-cerrar]', el).onclick = cerrar; $$('a[href^="#/liq/"]', el).forEach(a => a.addEventListener('click', cerrar)); },
  });
}

// Mientras corre un proceso, los KPIs y la tabla del mes se actualizan solos (cada ~4 s)
let _ultRefresco = 0, _refrescando = false;
function refrescoVivo(periodo) {
  if (_refrescando || Date.now() - _ultRefresco < 4000 || location.hash !== '#/mes/' + periodo) return;
  _ultRefresco = Date.now(); _refrescando = true;
  recargarMes().finally(() => { _refrescando = false; });
}

// Panel de avance: barra, contadores, qué se está procesando ahora y los últimos terminados
function pintarProceso() {
  const pill = $('#proc-pill');
  const p = PROC;
  const pct = p.total ? Math.round(p.hechos / p.total * 100) : 0;
  if (pill) {
    pill.hidden = !p.activo;
    pill.innerHTML = p.activo ? `<span class="cargando"></span>${p.tipo === 'shares' ? 'Shares' : 'PDFs'} ${p.hechos}/${p.total}` : '';
    pill.href = '#/mes/' + p.periodo;
  }
  const box = $('#proceso');
  if (!box) return;
  if (!p.activo || p.periodo !== box.dataset.periodo) { box.innerHTML = ''; return; }
  const seg = Math.max(1, (Date.now() - p.inicio) / 1000);
  const resta = p.hechos ? Math.round((p.total - p.hechos) * seg / p.hechos) : 0;
  const chips = p.tipo === 'shares'
    ? (S.simulacion ? [['ok', p.simuladas, 'simuladas OK']] : [['ok', p.cargadas, 'cargadas'], ['aviso', p.ya_existian, 'ya existían'], ['error', p.errores, 'con error']])
    : [['ok', p.listas, 'listas'], ['error', p.revisar, 'para corregir'], ['error', p.errores, 'no se leyeron'], ['info', p.duplicados, 'ya estaban']];
  const ICON_EST = { ok: ICO.check, dup: ICO.info, revisar: ICO.alert, error: ICO.x };
  box.innerHTML = `<div class="proc activo">
    <div class="proc-t"><span class="cargando"></span><b>${p.tipo === 'shares' ? (S.simulacion ? 'Simulando envío a Shares' : 'Enviando a Shares') : 'Procesando PDFs'}</b>
      <span class="mono">${p.hechos} / ${p.total} · ${pct}%${resta ? ` · faltan ~${resta >= 60 ? Math.ceil(resta / 60) + ' min' : resta + ' s'}` : ''}</span>
      <button class="btn btn-chico" id="b-cortar">${ICO.stop}Detener</button></div>
    <div class="proc-barra"><i style="width:${pct}%"></i></div>
    <div class="proc-chips">${chips.filter(([n, v]) => n === 'ok' || v).map(([n, v, t]) => `<span class="pc pc-${n}"><b>${v}</b> ${t}</span>`).join('')}</div>
    <div class="proc-ahora">${p.actuales.length ? `<span class="muted">${p.tipo === 'shares' ? 'Enviando' : 'Leyendo'}:</span> ${p.actuales.map(n => `<span class="mono">${esc(n)}</span>`).join(' · ')}` : '&nbsp;'}</div>
    ${p.ultimos.length ? `<ul class="proc-ult">${p.ultimos.map(u => `<li class="pu-${u.estado}">${ICON_EST[u.estado] || ''}<span class="mono">${esc(u.archivo)}</span>${u.detalle ? `<small>${esc(u.detalle.length > 110 ? u.detalle.slice(0, 110) + '…' : u.detalle)}</small>` : ''}</li>`).join('')}</ul>` : ''}
    <p class="ayuda" style="margin:8px 0 0">${p.tipo === 'shares' ? 'Los errores te los muestro juntos al final.' : 'Seguí trabajando tranquilo; lo que haya que corregir te lo muestro todo junto al final. No cierres esta pestaña.'}</p></div>`;
  const bc = $('#b-cortar'); if (bc) bc.onclick = () => { PROC.cancelar = true; bc.disabled = true; bc.textContent = 'Deteniendo…'; };
}

// Historial de una liquidación (los pasos que quedaron registrados)
const TAG = { ok: 'OK', info: 'Info', aviso: 'Aviso', error: 'Error' };
function htmlPaso(e) {
  return `<li class="paso-${esc(e.nivel)}"><span class="mono small muted">${fmtFH(e.ts)}</span><span class="badge b-${{ ok: 'ok', info: 'recibida', aviso: 'warn', error: 'critica' }[e.nivel] || 'aviso'}">${esc(TAG[e.nivel] || e.nivel)}</span><span class="small">${esc(e.mensaje)}</span></li>`;
}
// ---------------------------------------------------------------------------
//  Login
// ---------------------------------------------------------------------------
async function vistaLogin() {
  let setup = false;
  try { setup = (await api('/api/estado')).setup_requerido; } catch (e) {
    $('#app').innerHTML = `<div class="login"><div class="login-arte"><img src="logo-negro.png" alt="Lucciano's"><div></div></div>
      <div class="login-form"><div class="caja"><h1>Sin conexión</h1><p>No pude conectar con el servidor (${esc(API)}).<br>${esc(e.message)}</p><button class="btn btn-acento btn-grande" onclick="location.reload()">${ICO.refresh}Reintentar</button></div></div></div>`;
    return;
  }
  $('#app').innerHTML = `<div class="login">
    <div class="login-arte"><img src="logo-negro.png" alt="Lucciano's">
      <div class="login-txt"><h2>Las liquidaciones de Payway, a Shares en un rato.</h2><p>Arrastrás los PDFs del mes, se leen solos, se controla que cada uno cuadre y se cargan en Shares. Si algo falla, te dice cuál y por qué.</p></div>
      <div class="pasos"><span>${ICO.upload}130 PDFs de un saque</span><span>${ICO.shield}Controles</span><span>${ICO.alert}Errores al final</span><span>${ICO.send}Va a Shares</span></div></div>
    <div class="login-form"><form id="f-login">
      <h1>${setup ? 'Primer ingreso' : 'Ingresar'}</h1>
      <p>${setup ? 'Creá el usuario administrador.' : "Usá tu mail de Lucciano's."}</p>
      ${setup ? '<div class="campo"><label for="lg-n">Nombre</label><input id="lg-n" name="nombre" required autocomplete="name"></div>' : ''}
      <div class="campo"><label for="lg-u">Mail</label><input id="lg-u" name="email" type="email" required autocomplete="username"></div>
      <div class="campo"><label for="lg-p">Contraseña</label><input id="lg-p" name="password" type="password" required autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="${setup ? 10 : 1}"></div>
      <div class="campo hidden" id="c-totp"><label for="lg-t">Código de verificación</label><input id="lg-t" name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" class="mono"></div>
      <button class="btn btn-acento btn-grande" type="submit">${setup ? 'Crear y entrar' : 'Entrar'} ${ICO.arrow}</button>
    </form></div></div>`;
  $('#f-login').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    await conBoton($('button[type=submit]', e.target), async () => {
      const r = await api(setup ? '/api/setup' : '/api/login', { method: 'POST', body: fd });
      if (r.requiere_totp) { $('#c-totp').classList.remove('hidden'); $('#c-totp input').focus(); toast('Ingresá el código de tu app autenticadora.'); return; }
      guardarToken(r.token); S.user = r.usuario;
      if (!location.hash) location.hash = '#/inicio';
      iniciar();
    });
  };
}

// ---------------------------------------------------------------------------
//  Shell y router
// ---------------------------------------------------------------------------
const RUTAS = [
  { re: /^#\/inicio$/, v: vistaInicio, nav: 'inicio', miga: () => '<b>Inicio</b>' },
  { re: /^#\/mes\/(\d{4}-\d{2})$/, v: vistaMes, nav: 'meses', miga: (p) => `Meses / <b>${esc(NombreMes(p))}</b>` },
  { re: /^#\/liq\/(\d+)$/, v: vistaLiquidacion, nav: 'meses', miga: () => 'Meses / <b>Liquidación</b>' },
  { re: /^#\/locales$/, v: vistaLocales, nav: 'locales', miga: () => 'Datos / <b>Locales y cuentas</b>' },
  { re: /^#\/admin$/, v: vistaAdmin, nav: 'admin', miga: () => 'Datos / <b>Configuración</b>' },
  { re: /^#\/guia$/, v: vistaGuia, nav: 'guia', miga: () => '<b>Cómo se usa</b>' },
  { re: /^#\/cuenta$/, v: vistaMiCuenta, nav: '', miga: () => '<b>Mi cuenta</b>' },
];

function shell(ruta, args) {
  const a = ruta.nav;
  const it = (k, href, ic, t, cnt = '') => `<a href="${href}" class="${k === a ? 'activo' : ''}" ${k === a ? 'aria-current="page"' : ''}>${ICO[ic]}<span>${t}</span>${cnt}</a>`;
  const rol = { admin: 'Administrador', aprobador: 'Aprobador', carga: 'Carga' }[S.user.rol] || S.user.rol;
  return `<div class="app">
    <aside class="side">
      <a class="brand" href="#/inicio"><img src="logo-negro.png" alt="Lucciano's"><span>Liquidaciones Payway</span></a>
      <div class="cargar-side"><button class="btn btn-acento" data-subir>${ICO.upload}Subir PDFs del mes</button></div>
      <nav class="nav" aria-label="Secciones">
        ${it('inicio', '#/inicio', 'home', 'Inicio')}
        <div class="grp-t">Meses</div>
        <div id="nav-meses"></div>
        <div class="grp-t">Datos</div>
        ${it('locales', '#/locales', 'store', 'Locales y cuentas', '<span class="cnt hot" data-cnt="sin_local"></span>')}
        ${puede('admin') ? it('admin', '#/admin', 'gear', 'Configuración') : ''}
        ${it('guia', '#/guia', 'book', 'Cómo se usa')}
      </nav>
      <div class="me"><a class="av" href="#/cuenta" title="Mi cuenta">${esc(iniciales(S.user.nombre))}</a>
        <a class="who" href="#/cuenta"><b>${esc(S.user.nombre)}</b><small>${esc(rol)}</small></a>
        <div class="ibtns"><button class="ibtn" id="b-tema" title="Claro / oscuro">${temaActual() === 'dark' ? ICO.sun : ICO.moon}</button><button class="ibtn" id="b-salir" title="Salir">${ICO.logout}</button></div></div>
    </aside>
    <div style="min-width:0">
      <header class="top"><img class="marca-m" src="logo-negro.png" alt="Lucciano's"><div class="crumbs">${ruta.miga(...args)}</div>
        <a class="proc-pill" id="proc-pill" hidden></a>
        ${S.simulacion ? `<a class="sim-pill" href="${puede('admin') ? '#/admin' : '#/guia'}" title="No se manda nada a Shares hasta apagarlo en Configuración → Ajustes">${ICO.flask}Modo simulación</a>` : ''}
        <label class="buscar">${ICO.search}<input id="buscar-global" placeholder="Buscar local, establecimiento o resumen…" aria-label="Buscar"><kbd>Ctrl K</kbd></label>
        <button class="ibtn" id="b-actualizar" title="Actualizar">${ICO.refresh}</button></header>
      <main id="vista" class="entra"><div class="vacio"><span class="cargando"></span></div></main>
    </div></div>
    <nav class="mnav" aria-label="Secciones">
      <a href="#/inicio" class="${a === 'inicio' ? 'activo' : ''}">${ICO.home}Inicio</a>
      <a href="#/mes/${esc(S.ultimoMes || mesAnterior())}" class="${a === 'meses' ? 'activo' : ''}">${ICO.calendar}Mes</a>
      <a href="#/locales" class="${a === 'locales' ? 'activo' : ''}">${ICO.store}Locales</a>
      <a href="#/guia" class="${a === 'guia' ? 'activo' : ''}">${ICO.book}Ayuda</a>
    </nav>`;
}

async function pintarNavMeses() {
  try {
    const r = await api('/api/lotes');
    S.lotes = r.lotes;
    if (r.lotes[0]) S.ultimoMes = r.lotes[0].periodo;
    const h = location.hash;
    const nav = $('#nav-meses');
    if (!nav) return;
    nav.innerHTML = r.lotes.slice(0, 6).map(l => {
      const act = h === '#/mes/' + l.periodo;
      const pend = (l.excepciones || 0) + (l.errores_shares || 0);
      return `<a href="#/mes/${l.periodo}" class="${act ? 'activo' : ''}">${ICO.calendar}<span>${esc(NombreMes(l.periodo))}</span>${pend ? `<span class="cnt hot">${pend}</span>` : l.listas ? `<span class="cnt">${l.listas}</span>` : l.estado === 'cerrado' ? `<span class="cnt">${ICO.lock}</span>` : ''}</a>`;
    }).join('') || '<span class="small muted" style="padding:4px 10px">Todavía no hay meses.</span>';
    const sl = await api('/api/locales').catch(() => null);
    if (sl) $$('[data-cnt="sin_local"]').forEach(x => { x.textContent = sl.sin_local.length || ''; });
  } catch { /* no es crítico */ }
}

async function router() {
  if (!S.token) return vistaLogin();
  const h = location.hash || '#/inicio';
  const r = RUTAS.find(x => x.re.test(h)) || RUTAS[0];
  const args = (h.match(r.re) || []).slice(1);
  $('#app').innerHTML = shell(r, args);
  $('#b-salir').onclick = () => salir();
  $('#b-tema').onclick = alternarTema;
  $('#b-actualizar').onclick = () => { const b = $('#b-actualizar'); b.classList.add('girando'); router().finally(() => toast('Actualizado')); };
  $$('[data-subir]').forEach(b => b.onclick = async () => iniciarSubida(await elegirArchivos(), (location.hash.match(/^#\/mes\/(\d{4}-\d{2})$/) || [])[1]));
  const bg = $('#buscar-global');
  bg.onkeydown = async (e) => {
    if (e.key !== 'Enter' || bg.value.trim().length < 2) return;
    try {
      const q = await api('/api/liquidaciones?q=' + encodeURIComponent(bg.value.trim()));
      if (!q.liquidaciones.length) { toast('No encontré nada con eso.', true); return; }
      if (q.liquidaciones.length === 1) { location.hash = '#/liq/' + q.liquidaciones[0].id; return; }
      modal(`<h2>${q.liquidaciones.length} resultado(s)</h2><div class="tabla-wrap"><table><thead><tr><th>Mes</th><th>Local</th><th>Est. - Resumen</th><th>Estado</th><th class="num">Total</th></tr></thead><tbody>
        ${q.liquidaciones.map(f => `<tr class="click" data-id="${f.id}"><td>${esc(NombreMes(f.periodo))}</td><td>${esc(f.direccion)}</td><td class="mono small">${esc(refLiq(f))}</td><td>${badgeEstado(f.estado)}</td><td class="num">${$$m(f.total_descuento)}</td></tr>`).join('')}</tbody></table></div>`,
      { ancho: true, alMontar: (el, cerrar) => $$('tr[data-id]', el).forEach(tr => tr.onclick = () => { cerrar(); location.hash = '#/liq/' + tr.dataset.id; }) });
    } catch (er) { toast(er.message, true); }
  };
  pintarProceso();
  window.scrollTo(0, 0);
  pintarNavMeses();
  try { await r.v($('#vista'), ...args); }
  catch (e) { if (S.token && $('#vista')) { $('#vista').innerHTML = `<div class="panel panel-pad"><h2>No se pudo cargar</h2><p class="muted">${esc(e.message)}</p><button class="btn btn-acento" id="b-reint">${ICO.refresh}Reintentar</button></div>`; $('#b-reint').onclick = router; } }
}

async function iniciar() {
  if (!S.token) return vistaLogin();
  try { const r = await api('/api/yo'); S.user = r.usuario; S.simulacion = r.modo_simulacion; } catch { return vistaLogin(); }
  await router();
}
window.addEventListener('hashchange', () => { if (S.token) router(); });
document.addEventListener('DOMContentLoaded', iniciar);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { const b = $('#buscar-global'); if (b) { e.preventDefault(); b.focus(); b.select(); } }
});

// Arrastrar PDFs (o una carpeta) a cualquier parte de la app
let _arrastre = 0;
document.addEventListener('dragenter', (e) => { if (!S.token || !e.dataTransfer?.types?.includes('Files')) return; _arrastre++; document.body.classList.add('arrastrando'); });
document.addEventListener('dragleave', () => { _arrastre = Math.max(0, _arrastre - 1); if (!_arrastre) document.body.classList.remove('arrastrando'); });
document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault(); _arrastre = 0; document.body.classList.remove('arrastrando');
  if (!S.token) return;
  const files = await archivosDeDrop(e.dataTransfer);
  iniciarSubida(files, (location.hash.match(/^#\/mes\/(\d{4}-\d{2})$/) || [])[1]);
});

// ---------------------------------------------------------------------------
//  Inicio
// ---------------------------------------------------------------------------
function zonaDrop() {
  return `<div class="drop drop-grande" id="drop">${ICO.upload}<b>Arrastrá acá los PDFs de Payway del mes</b><span>o la carpeta entera · también podés <button class="btn-link" id="b-elegir">elegir archivos</button> o <button class="btn-link" id="b-carpeta">elegir una carpeta</button></span><small>Se leen en tu compu y no se guardan en ningún lado: solo viajan los datos. 130 PDFs tardan alrededor de un minuto.</small></div>`;
}
function conectarDrop(el, periodo = null) {
  const b1 = $('#b-elegir', el), b2 = $('#b-carpeta', el), d = $('#drop', el);
  if (b1) b1.onclick = async (e) => { e.stopPropagation(); iniciarSubida(await elegirArchivos(), periodo); };
  if (b2) b2.onclick = async (e) => { e.stopPropagation(); iniciarSubida(await elegirArchivos({ carpeta: true }), periodo); };
  if (d) d.onclick = async () => iniciarSubida(await elegirArchivos(), periodo);
}

async function vistaInicio(el) {
  const r = await api('/api/lotes');
  const hora = new Date().getHours();
  const saludo = hora < 13 ? 'Buen día' : hora < 20 ? 'Buenas tardes' : 'Buenas noches';
  const ult = r.lotes[0];
  el.innerHTML = `<div class="encabezado"><div><h1>${saludo}, ${esc(String(S.user.nombre).split(' ')[0])}</h1><p>Cargá en Shares las liquidaciones mensuales de Payway (Banco Macro y Nación) de todos los locales.</p></div></div>
    ${zonaDrop()}
    ${ult ? `<div class="kpis" style="margin-top:16px">
      <a class="kpi" href="#/mes/${ult.periodo}"><div class="et">Último mes</div><div class="val">${esc(NombreMes(ult.periodo))}</div><div class="sub">${ult.n} PDF(s) · ${ult.estado === 'cerrado' ? 'cerrado' : 'abierto'}</div></a>
      <a class="kpi ${ult.excepciones ? 'alerta' : ''}" href="#/mes/${ult.periodo}?f=excepcion"><div class="et">Para revisar</div><div class="val">${ult.excepciones || 0}</div><div class="sub">${ult.errores_shares ? ult.errores_shares + ' con error de Shares' : 'controles que no cerraron'}</div></a>
      <a class="kpi ${ult.listas ? 'ok' : ''}" href="#/mes/${ult.periodo}?f=lista"><div class="et">Listas para Shares</div><div class="val">${ult.listas || 0}</div><div class="sub">esperando el envío</div></a>
      <a class="kpi" href="#/mes/${ult.periodo}?f=cargada"><div class="et">Cargadas en Shares</div><div class="val">${ult.cargadas || 0}</div><div class="sub">${$$corto(ult.total_cargado)}</div></a>
    </div>` : ''}
    <div class="panel" style="margin-top:16px"><div class="panel-titulo"><h2>Meses</h2><span class="ayuda">Un lote por mes. Si subís un PDF que ya estaba, no se duplica.</span></div>
      <div class="tabla-wrap"><table><thead><tr><th>Mes</th><th>Estado</th><th class="num">PDFs</th><th class="num">Listas</th><th class="num">Para revisar</th><th class="num">Cargadas</th><th class="num">Error Shares</th><th class="num">Total descuentos</th></tr></thead><tbody>
      ${r.lotes.map(l => `<tr class="click" data-p="${l.periodo}"><td><b>${esc(NombreMes(l.periodo))}</b><small class="sub-celda">abierto por ${esc(String(l.creado_por || '').split('@')[0])} · ${fmtFH(l.creado_at)}</small></td>
        <td>${l.estado === 'cerrado' ? `<span class="badge b-cargada">Cerrado</span>` : (l.n && l.cargadas === l.n - (l.excluidas || 0)) ? '<span class="badge b-ok">Todo cargado</span>' : '<span class="badge b-acc">Abierto</span>'}</td>
        <td class="num">${l.n || 0}</td><td class="num">${l.listas || 0}</td><td class="num">${l.excepciones ? `<b class="txt-neg">${l.excepciones}</b>` : 0}</td><td class="num">${l.cargadas || 0}</td><td class="num">${l.errores_shares ? `<b class="txt-neg">${l.errores_shares}</b>` : 0}</td><td class="num"><b>${$$m(l.total_descuento)}</b></td></tr>`).join('')
        || '<tr><td colspan="8" class="vacio"><span class="grande">Arrancá por el primer mes</span>Arrastrá los PDFs que bajás de Payway y listo.</td></tr>'}
      </tbody></table></div></div>`;
  conectarDrop(el);
  $$('tr[data-p]', el).forEach(tr => tr.onclick = () => { location.hash = '#/mes/' + tr.dataset.p; });
}

// ---------------------------------------------------------------------------
//  Mes (lote): KPIs, lo que hay que corregir, tabla y acciones
// ---------------------------------------------------------------------------
let MES = null;   // { periodo, datos, filtro, q }
async function vistaMes(el, periodo) {
  const filtroUrl = new URLSearchParams(location.hash.split('?')[1] || '').get('f');
  let datos;
  try { datos = await api('/api/lotes/' + periodo); }
  catch (e) {
    if (e.status !== 404) throw e;
    el.innerHTML = `<div class="encabezado"><div><h1>${esc(NombreMes(periodo))}</h1><p>Este mes todavía no tiene liquidaciones.</p></div></div>${zonaDrop()}`;
    conectarDrop(el, periodo);
    return;
  }
  MES = { periodo, datos, filtro: filtroUrl || (MES?.periodo === periodo ? MES.filtro : 'todas'), q: MES?.periodo === periodo ? MES.q : '' };
  S.simulacion = datos.modo_simulacion;
  pintarMes(el);
}

async function recargarMes() {
  const el = $('#vista');
  if (!el || !MES) return;
  try { MES.datos = await api('/api/lotes/' + MES.periodo); pintarMes(el, true); pintarNavMeses(); } catch (e) { toast(e.message, true); }
}

function pintarMes(el, soloDatos = false) {
  const { periodo, datos } = MES;
  const L = datos.liquidaciones, lote = datos.lote;
  const cuenta = (e) => L.filter(f => f.estado === e).length;
  const suma = (k, filtro = () => true) => L.filter(f => f.estado !== 'excluida' && filtro(f)).reduce((a, f) => a + (Number(f[k]) || 0), 0);
  const listas = L.filter(f => f.estado === 'lista' || f.estado === 'error_shares');
  const cerrado = lote.estado === 'cerrado';
  const kpis = `
    <div class="kpi"><div class="et">PDFs</div><div class="val">${L.length}</div><div class="sub">${new Set(L.map(f => f.direccion)).size} locales</div></div>
    <a class="kpi ${cuenta('excepcion') ? 'alerta' : ''}" href="javascript:void 0" data-kf="excepcion"><div class="et">Para revisar</div><div class="val">${cuenta('excepcion')}</div><div class="sub">no cerró algún control</div></a>
    <a class="kpi ${cuenta('lista') ? 'ok' : ''}" href="javascript:void 0" data-kf="lista"><div class="et">Listas para Shares</div><div class="val">${cuenta('lista')}</div><div class="sub">${$$corto(suma('total_items', f => f.estado === 'lista'))}</div></a>
    <a class="kpi" href="javascript:void 0" data-kf="cargada"><div class="et">Cargadas en Shares</div><div class="val">${cuenta('cargada')}</div><div class="sub">${$$corto(suma('total_items', f => f.estado === 'cargada'))}</div></a>
    ${cuenta('error_shares') ? `<a class="kpi alerta" href="javascript:void 0" data-kf="error_shares"><div class="et">Error de Shares</div><div class="val">${cuenta('error_shares')}</div><div class="sub">se pueden reenviar</div></a>` : ''}
    <div class="kpi"><div class="et">Total descuentos</div><div class="val">${$$corto(suma('total_descuento'))}</div><div class="sub">comisión ${$$corto(suma('neto') + suma('iva'))} · ret. ${$$corto(suma('ret_sirtac') + suma('ret_iibb'))} · perc. ${$$corto(suma('percep_iva'))}</div></div>`;
  if (!soloDatos || !$('#mes-kpis')) {
    el.innerHTML = `<div class="encabezado"><div><h1>${esc(NombreMes(periodo))} ${cerrado ? `<span class="badge b-cargada" style="vertical-align:middle">${ICO.lock}Cerrado</span>` : ''}</h1>
        <p>Liquidaciones Payway del mes. Lo que haya que corregir aparece arriba, con el motivo.</p></div>
      <div class="acciones" id="mes-acciones"></div></div>
      <div id="proceso" data-periodo="${esc(periodo)}"></div>
      <div class="kpis" id="mes-kpis"></div>
      <div id="mes-alerta"></div>
      <div class="panel" style="margin-top:16px">
        <div class="cola-bar"><label class="campo-buscar">${ICO.search}<input id="q" placeholder="Local, establecimiento o resumen" value="${esc(MES.q)}"></label><div class="seg" id="seg-f" style="margin:0"></div></div>
        <div class="tabla-wrap"><table class="tabla-liq"><thead><tr><th>Local</th><th>Establecimiento · Resumen</th><th>Estado</th><th class="num">Total descuento</th><th class="num">Comisión + IVA</th><th class="num">Retenciones</th><th class="num">Percep. IVA</th><th>Shares</th></tr></thead><tbody id="tb"></tbody><tfoot id="tf"></tfoot></table></div></div>`;
    $('#q').oninput = () => { MES.q = $('#q').value; pintarTabla(); };
  }
  $('#mes-kpis').innerHTML = kpis;
  $$('[data-kf]', el).forEach(k => k.onclick = () => { MES.filtro = k.dataset.kf; pintarTabla(); $('#tb').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  // Acciones
  const acc = [];
  if (!cerrado) acc.push(`<button class="btn" id="b-mas">${ICO.upload}Subir PDFs</button>`);
  if (!cerrado && puede('aprobador')) acc.push(`<button class="btn btn-negro" id="b-enviar" ${listas.length ? '' : 'disabled'}>${S.simulacion ? ICO.flask : ICO.send}${S.simulacion ? 'Simular envío' : 'Enviar a Shares'} (${listas.length})</button>`);
  acc.push(`<button class="btn" id="b-excel">${ICO.excel}Excel</button>`);
  if (!cerrado) acc.push(`<button class="btn btn-ghost" id="b-reval" title="Vuelve a clasificar y controlar con los locales y ajustes actuales">${ICO.refresh}Volver a controlar</button>`);
  if (puede('aprobador')) acc.push(cerrado ? `<button class="btn btn-ghost" id="b-reabrir">${ICO.unlock}Reabrir mes</button>` : `<button class="btn btn-ghost" id="b-cerrar">${ICO.lock}Cerrar mes</button>`);
  $('#mes-acciones').innerHTML = acc.join('');
  // Para corregir: todo junto, con el motivo y la acción para arreglarlo
  const al = [];
  const corr = [];
  for (const x of datos.sin_local) corr.push(filaCorregir({ archivos: x.archivos || [], titulo: `Dirección en el PDF: ${x.direccion}`, motivo: `Local sin cuenta de comisiones (${x.n} PDF). Asignale la cuenta y se arreglan todos juntos.`, acciones: puede('aprobador') && !cerrado ? `<button class="btn btn-chico btn-negro" data-asig="${esc(x.direccion)}">Asignar cuenta</button>` : '' }));
  for (const f of L.filter(f => f.estado === 'excepcion')) {
    const e1 = (f.problemas || []).filter(p => p.nivel === 'error' && p.codigo !== 'SIN_LOCAL');
    if (e1.length) corr.push(filaCorregir({ archivos: [f.archivo_nombre], sub: `${f.direccion || ''} · ${refLiq(f)} · ${$$m(f.total_descuento)}`, motivo: e1.map(p => p.mensaje).join(' '), acciones: `<a class="btn btn-chico" href="#/liq/${f.id}">Ver</a>` }));
  }
  for (const f of L.filter(f => f.estado === 'error_shares')) corr.push(filaCorregir({ archivos: [f.archivo_nombre], sub: `${f.direccion || ''} · Shares respondió HTTP ${f.shares_http || '—'}`, motivo: f.shares_msg || 'Error sin detalle', acciones: `<a class="btn btn-chico" href="#/liq/${f.id}">Ver</a>` }));
  const nl = noLeidos.get(periodo);
  const nPdf = datos.sin_local.reduce((a, x) => a + x.n, 0) + L.filter(f => f.estado === 'error_shares' || (f.estado === 'excepcion' && !(f.problemas || []).some(p => p.codigo === 'SIN_LOCAL'))).length + nl.length;
  for (const r of nl) corr.push(filaCorregir({ archivos: [r.archivo], sub: 'no se pudo leer (última corrida)', motivo: r.mensaje }));
  if (corr.length) al.push(`<div class="panel panel-corregir"><div class="panel-titulo"><h2>${ICO.alert}Para corregir <span class="cnt-corr">${nPdf} PDF${nPdf === 1 ? '' : 's'}</span></h2>${nl.length ? '<button class="btn btn-chico btn-ghost" id="b-olvidar">Ocultar los no leídos</button>' : ''}</div><ul class="corregir">${corr.join('')}</ul></div>`);
  else if (L.length && !L.some(f => ['lista', 'excepcion', 'error_shares'].includes(f.estado))) al.push(`<div class="aviso-mes ok">${ICO.check}<div><b>Todo cargado.</b> No queda nada pendiente en este mes.</div></div>`);
  if (S.simulacion && listas.length && puede('aprobador')) al.push(`<div class="aviso-mes sim">${ICO.flask}<div><b>Modo simulación prendido:</b> “Simular envío” arma y controla cada comprobante, pero no manda nada a Shares. ${puede('admin') ? '<a href="#/admin">Apagarlo en Configuración → Ajustes</a> cuando quieras cargar de verdad.' : 'Pedile a un admin que lo apague para cargar de verdad.'}</div></div>`);
  $('#mes-alerta').innerHTML = al.join('');
  // Conexiones
  const on = (id, fn) => { const b = $('#' + id); if (b) b.onclick = () => fn(b); };
  on('b-mas', async () => iniciarSubida(await elegirArchivos(), periodo));
  on('b-enviar', () => enviarAShares(periodo, listas.map(f => f.id)));
  on('b-excel', (b) => conBoton(b, () => exportarExcel(periodo)));
  on('b-reval', (b) => conBoton(b, async () => { const r = await api(`/api/lotes/${periodo}/revalidar`, { method: 'POST' }); toast(`Controladas ${r.revisadas}: ${r.cambiaron} cambiaron de estado.`); await recargarMes(); }));
  on('b-cerrar', async (b) => { const pend = L.filter(f => !['cargada', 'excluida'].includes(f.estado)).length; if (!await confirmar(pend ? `Quedan ${pend} liquidación(es) sin cargar. Cerrado no se pueden subir PDFs ni enviar hasta reabrirlo.` : 'Cerrado no se pueden subir PDFs ni enviar hasta reabrirlo.', { boton: 'Cerrar mes' })) return; conBoton(b, async () => { await api(`/api/lotes/${periodo}/cerrar`, { method: 'POST' }); await recargarMes(); router(); }); });
  on('b-reabrir', (b) => conBoton(b, async () => { await api(`/api/lotes/${periodo}/reabrir`, { method: 'POST' }); router(); }));
  on('b-olvidar', () => { noLeidos.set(periodo, []); pintarMes(el, true); });
  $$('[data-asig]', el).forEach(b => b.onclick = () => modalLocal({ direccion: b.dataset.asig }, recargarMes));
  pintarTabla();
  pintarProceso();
}

function pintarTabla() {
  if (!MES || !$('#tb')) return;
  const L = MES.datos.liquidaciones;
  const segs = [['todas', 'Todas', L.length], ['excepcion', 'Para revisar', 0], ['lista', 'Listas', 0], ['cargada', 'Cargadas', 0], ['error_shares', 'Error Shares', 0], ['excluida', 'Excluidas', 0]];
  for (const s of segs) if (s[0] !== 'todas') s[2] = L.filter(f => f.estado === s[0]).length;
  $('#seg-f').innerHTML = segs.filter(s => s[0] === 'todas' || s[2] || s[0] === MES.filtro).map(([k, t, n]) => `<button data-f="${k}" class="${MES.filtro === k ? 'on' : ''}">${t} <b>${n}</b></button>`).join('');
  $$('#seg-f button').forEach(b => b.onclick = () => { MES.filtro = b.dataset.f; pintarTabla(); });
  const q = (MES.q || '').trim().toUpperCase();
  const vis = L.filter(f => (MES.filtro === 'todas' || f.estado === MES.filtro) && (!q || `${f.direccion} ${f.nro_establecimiento} ${f.nro_resumen} ${f.denominacion || ''} ${f.alias || ''} ${f.shares_ref || ''}`.toUpperCase().includes(q)));
  const ret = (f) => (Number(f.ret_sirtac) || 0) + (Number(f.ret_iibb) || 0);
  const comis = (f) => (Number(f.neto) || 0) + (Number(f.iva) || 0) + (Number(f.devol) || 0);
  $('#tb').innerHTML = vis.map(f => {
    const errs = (f.problemas || []).filter(p => p.nivel === 'error'), avs = (f.problemas || []).filter(p => p.nivel === 'aviso');
    const sh = f.estado === 'cargada' ? `<span class="mono small">${f.shares_resultado === 'duplicado' ? 'ya existía (409)' : 'nro_reg ' + esc(f.shares_ref || '—')}</span>`
      : f.estado === 'error_shares' ? `<span class="small txt-neg" title="${esc(f.shares_msg)}">HTTP ${esc(f.shares_http || '—')} · ${esc(String(f.shares_msg || '').slice(0, 60))}</span>`
      : f.estado === 'excluida' ? `<span class="small muted">${esc(String(f.excluida_motivo || '').slice(0, 60))}</span>`
      : f.simulado_at ? '<span class="small muted">simulada OK</span>' : '<span class="small muted">—</span>';
    return `<tr class="click" data-id="${f.id}">
      <td><b>${esc(nombreLocal(f))}</b><small class="sub-celda">${esc(f.direccion || '')}${f.codigo_concepto ? ' · ' + f.codigo_concepto : ''}</small></td>
      <td class="mono small">${esc(f.nro_establecimiento)}<small class="sub-celda">${esc(f.nro_resumen)} · ${esc(String(f.banco || '').replace(/^BANCO (DE LA )?/, '').slice(0, 18))}</small></td>
      <td>${badgeEstado(f.estado)}${errs.length ? `<small class="sub-celda txt-neg" title="${esc(errs.map(e => e.mensaje).join('\n'))}">${esc(errs[0].mensaje.slice(0, 54))}${errs[0].mensaje.length > 54 ? '…' : ''}</small>` : avs.length ? `<small class="sub-celda" title="${esc(avs.map(e => e.mensaje).join('\n'))}">${ICO.info.replace('class="i"', 'class="i mini"')} ${avs.length} aviso(s)</small>` : ''}</td>
      <td class="num"><b>${$$m(f.total_descuento)}</b></td><td class="num">${$$m(comis(f))}</td><td class="num">${$$m(ret(f))}</td><td class="num">${$$m(f.percep_iva)}</td><td>${sh}</td></tr>`;
  }).join('') || `<tr><td colspan="8" class="vacio">${L.length ? 'Nada con este filtro.' : 'Todavía no hay liquidaciones en este mes.'}</td></tr>`;
  const tot = (fn) => vis.filter(f => f.estado !== 'excluida').reduce((a, f) => a + fn(f), 0);
  $('#tf').innerHTML = vis.length ? `<tr><td colspan="3"><b>${vis.length} liquidación(es)</b></td><td class="num"><b>${$$m(tot(f => Number(f.total_descuento) || 0))}</b></td><td class="num"><b>${$$m(tot(comis))}</b></td><td class="num"><b>${$$m(tot(ret))}</b></td><td class="num"><b>${$$m(tot(f => Number(f.percep_iva) || 0))}</b></td><td></td></tr>` : '';
  $$('#tb tr[data-id]').forEach(tr => tr.onclick = () => { location.hash = '#/liq/' + tr.dataset.id; });
}

// ---- Excel igual al Liquidaciones_Payway.xlsx del script (más estado y Shares) ----
async function exportarExcel(periodo) {
  const r = await api(`/api/lotes/${periodo}/export`);
  await cargarScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
  const cols = ['Archivo', 'Fecha Emisión', 'Pagador (Banco)', 'N° Resumen', 'N° Establecimiento', 'Establecimiento', 'Dirección', 'C.P.', 'Localidad', 'Provincia',
    'Total Descuento $', 'Monto Gravado IVA', 'IVA s/Descuentos', 'Ret. IIBB SIRTAC', 'Jurisdicción (texto)', 'Ret. IIBB Jurisdiccional $', 'Percep./Retenc. AFIP-DGI', 'Devol. Dto. Campaña $',
    'N° de Concepto de gasto', 'Concepto de gasto', 'Estado', 'Shares nro_reg', 'Shares respuesta', 'Observaciones'];
  const numCols = new Set([10, 11, 12, 13, 15, 16, 17]);
  const filas = r.filas.map(x => {
    const d = x.datos || {};
    const jur = d.ret_iibb_jurisdiccional || [];
    const sh = x.estado === 'cargada' ? (x.shares_resultado === 'duplicado' ? 'Ya existía (409)' : `OK HTTP ${x.shares_http || 201}`) : x.estado === 'error_shares' ? `HTTP ${x.shares_http || '—'}: ${x.shares_msg || ''}` : '';
    return [x.archivo_nombre, d.fecha_emision, d.pagador, d.nro_resumen, d.nro_establecimiento, d.establecimiento, d.direccion, d.cp, d.localidad, d.provincia,
      d.total_descuento, d.monto_gravado, d.iva, d.ret_sirtac, jur.map(j => j.jurisdiccion).join(' / ') || null, jur.reduce((a, j) => a + (j.importe || 0), 0) || null, d.percep_afip, d.devol_campania,
      x.codigo_concepto || 'DETERMINAR', x.denominacion || null, ESTADOS[x.estado] || x.estado, x.shares_ref, sh, x.estado === 'excluida' ? 'Excluida: ' + (x.excluida_motivo || '') : x.problemas || null];
  });
  const ws = XLSX.utils.aoa_to_sheet([cols, ...filas]);
  const n = filas.length;
  // Totales con fórmula (Excel en español la muestra como SUMA)
  const tot = cols.map((_, c) => numCols.has(c) && n ? { f: `SUM(${XLSX.utils.encode_col(c)}2:${XLSX.utils.encode_col(c)}${n + 1})` } : (c === 0 ? 'TOTAL' : null));
  XLSX.utils.sheet_add_aoa(ws, [tot], { origin: n + 1 });
  for (let rr = 1; rr <= n + 1; rr++) for (const c of numCols) { const ref = XLSX.utils.encode_cell({ r: rr, c }); if (ws[ref]) ws[ref].z = '#,##0.00'; }
  ws['!cols'] = [38, 12, 24, 14, 17, 16, 30, 8, 18, 18, 15, 15, 14, 14, 18, 14, 14, 14, 20, 38, 18, 12, 30, 50].map(w => ({ wch: w }));
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  ws['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(cols.length - 1)}${n + 1}` };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Liquidaciones Payway');
  XLSX.writeFile(wb, `Liquidaciones_Payway_${periodo}.xlsx`);
}

// ---------------------------------------------------------------------------
//  Detalle de una liquidación
// ---------------------------------------------------------------------------
async function vistaLiquidacion(el, id) {
  const f = await api('/api/liquidaciones/' + id);
  pintarLiquidacion(el, f);
}

function pintarLiquidacion(el, f) {
  const d = f.datos || {}, p = f.payload || {};
  const errs = f.problemas.filter(x => x.nivel === 'error'), avs = f.problemas.filter(x => x.nivel === 'aviso');
  const editable = ['excepcion', 'lista', 'error_shares'].includes(f.estado) && f.lote_estado !== 'cerrado';
  const bots = [];
  if (editable && ['lista', 'error_shares'].includes(f.estado) && puede('aprobador')) bots.push(['b-env', `${S.simulacion ? ICO.flask : ICO.send}${S.simulacion ? 'Simular envío' : f.estado === 'error_shares' ? 'Reintentar envío' : 'Enviar a Shares'}`, 'btn-negro principal']);
  if (editable) bots.push(['b-rev', `${ICO.refresh}Volver a controlar`, '']);
  if (editable && puede('aprobador')) bots.push(['b-exc', 'Excluir (no se carga)', 'btn-rojo']);
  if (f.estado === 'excluida' && f.lote_estado !== 'cerrado') bots.push(['b-reab', `${ICO.refresh}Reabrir`, '']);
  if (f.estado !== 'cargada' && puede('admin')) bots.push(['b-del', `${ICO.trash}Borrar`, 'btn-rojo']);
  const filaKV = (k, v, mono = false) => `<dt>${esc(k)}</dt><dd${mono ? '' : ' style="font-family:var(--sans)"'}>${v}</dd>`;
  const jur = d.ret_iibb_jurisdiccional || [];
  el.innerHTML = `
  <div class="encabezado" style="margin-bottom:16px"><div class="navfact"><a class="btn btn-ghost btn-chico" href="#/mes/${esc(f.periodo)}">${ICO.back}${esc(NombreMes(f.periodo))}</a><span class="tag mono">#${f.id}</span><span class="tag mono">${esc(f.ref_externa || '')}</span></div></div>
  <div class="detalle sin-visor">
    <div class="lado">
      <section class="panel ficha">
        <div class="fila1">${badgeEstado(f.estado)}<span class="tag">${esc(f.banco || '')}</span></div>
        <div class="corr-arch" style="margin-top:10px"><span class="arch arch-grande" title="Copiar el nombre para buscarlo en la carpeta" data-copiar="${esc(f.archivo_nombre || '')}">${ICO.doc}${esc(f.archivo_nombre || '—')}${ICO.copy}</span></div>
        <h2>${esc(f.local?.alias || (f.local?.denominacion || '').replace(/^COMISIONES PAGADAS L\.?\s*/i, '') || f.direccion || 'Liquidación')}</h2>
        <div class="meta"><span>${esc(f.direccion || '')}</span><span>${esc([d.localidad, d.provincia].filter(Boolean).join(', '))}</span><span class="mono">Est. ${esc(f.nro_establecimiento)} · Res. ${esc(f.nro_resumen)}</span><span>Emitida ${fmtF(f.fecha_emision)}</span>
          <span>Subida por ${esc(String(f.creado_por || '').split('@')[0])} · ${fmtFH(f.creado_at)}</span>${f.shares_ref ? `<span>Shares nro_reg <b class="mono">${esc(f.shares_ref)}</b></span>` : ''}</div>
        <div class="total"><b>${$$m(f.total_descuento)}</b><span class="tag">Total descuento</span>${f.local ? `<span class="tag mono">${esc(f.local.codigo_concepto)} · ${esc(f.local.denominacion || '')}</span>` : ''}</div>
        ${f.estado === 'excluida' ? `<p class="small txt-neg" style="margin:10px 0 0">Excluida: ${esc(f.excluida_motivo || '')}</p>` : ''}
        ${f.estado === 'error_shares' ? `<p class="small txt-neg" style="margin:10px 0 0"><b>Shares respondió HTTP ${esc(f.shares_http || '—')}:</b> ${esc(f.shares_msg || '')}</p>` : ''}
        ${f.estado === 'cargada' && f.shares_resultado === 'duplicado' ? `<p class="small" style="margin:10px 0 0">Ya existía en Shares (409): ${esc(f.shares_msg || '')}</p>` : ''}
      </section>
      ${errs.length ? `<section class="tarea critica"><div class="panel-titulo"><h2>Qué no cerró</h2><span class="badge b-critica">${errs.length}</span></div><div class="cuerpo">
        ${errs.map(e => `<div class="excepcion critica"><div class="txt"><span class="cod">${esc(e.codigo)}</span><br>${esc(e.mensaje)}</div>${e.codigo === 'SIN_LOCAL' && puede('aprobador') && editable ? '<button class="btn btn-chico btn-negro" id="b-asig">Asignar cuenta</button>' : ''}</div>`).join('')}</div></section>`
      : f.estado === 'lista' ? `<section class="tarea bien"><div class="panel-titulo"><h2>Todo cuadra</h2><span class="badge b-ok">Lista para Shares</span></div></section>` : ''}
      ${avs.length ? `<section class="panel panel-pad small">${avs.map(e => `<div class="con-ico muted">${ICO.info}<span><b class="mono">${esc(e.codigo)}</b> · ${esc(e.mensaje)}</span></div>`).join('')}</section>` : ''}
      <section class="panel">
        <div class="tabs" id="tabs"><button class="activo" data-tab="shares">Cómo va a Shares</button><button data-tab="pdf">Leído del PDF</button><button data-tab="json">JSON</button><button data-tab="hist">Historial</button></div>
        <div class="tab" data-tab="shares"><div class="tabla-wrap"><table><thead><tr><th>Concepto</th><th>Cuenta</th><th class="num">Importe</th><th class="num">IVA</th><th class="num">Total</th></tr></thead><tbody>
          ${(f.items_explicados || []).map(it => `<tr><td>${esc(it.que)}<small class="sub-celda mono">id_concepto_fc ${it.id_concepto_fc}</small></td><td class="small">${esc(it.cuenta)}</td><td class="num">${$$m(it.importe)}</td><td class="num">${it.iva !== undefined ? $$m(it.iva) : '—'}</td><td class="num"><b>${$$m(it.total)}</b></td></tr>`).join('') || '<tr><td colspan="5" class="vacio">Sin ítems.</td></tr>'}
          </tbody><tfoot><tr><td colspan="4"><b>Total del comprobante</b> <span class="small muted">vs. Total Descuento del PDF ${$$m(d.total_descuento)}</span></td><td class="num"><b class="${Math.abs((p.totales?.importe_total || 0) - (d.total_descuento || 0)) <= 0.02 ? 'txt-pos' : 'txt-neg'}">${$$m(p.totales?.importe_total)}</b></td></tr></tfoot></table></div>
          <div class="seccion small muted">Comprobante <b>F ${esc(p.cabecera?.numero_punto_de_venta || '')}-${esc(p.cabecera?.numero_comprobante || '')}</b> del ${esc(p.cabecera?.fecha_comprobante || '')} · proveedor <b>${esc(p.proveedor?.razon_social || '')}</b> (${esc(fmtCuit(p.proveedor?.cuit))}) · empresa ${esc(fmtCuit(p.cabecera?.cuit_empresa))}</div></div>
        <div class="tab hidden" data-tab="pdf"><div class="seccion"><dl class="kv">
          ${filaKV('Archivo', esc(f.archivo_nombre), true)}${filaKV('Fecha de emisión', esc(d.fecha_emision || '—'), true)}${filaKV('Pagador', esc(d.pagador || '—'))}${filaKV('CUIT banco', esc(fmtCuit(d.cuit_proveedor)), true)}
          ${filaKV('Empresa', esc((d.razon_social_empresa || '') + ' · ' + fmtCuit(d.cuit_empresa)))}${filaKV('Establecimiento', esc(`${d.establecimiento || ''} · ${d.direccion || ''} · C.P. ${d.cp || ''} ${d.localidad || ''} · ${d.provincia || ''}`))}
          ${filaKV('Total presentado', $$m(d.total_presentado), true)}${filaKV('Total descuento', $$m(d.total_descuento), true)}${filaKV('Saldo', $$m(d.saldo), true)}
          ${filaKV('Monto gravado IVA', `${$$m(d.monto_gravado)} (${String(d.alicuota_iva ?? '—').replace('.', ',')}%)`, true)}${filaKV('IVA s/descuentos', $$m(d.iva), true)}${filaKV('Ret. IIBB SIRTAC', $$m(d.ret_sirtac), true)}
          ${filaKV('Ret. IIBB jurisdiccional', jur.length ? jur.map(j => `${esc(j.jurisdiccion)} ${$$m(j.importe)}`).join(' · ') : '—', true)}${filaKV('Percep./Retenc. AFIP-DGI', $$m(d.percep_afip), true)}${filaKV('Devol. dto. campaña', $$m(d.devol_campania), true)}${filaKV('Páginas', esc(d.paginas || '—'), true)}
        </dl></div>${d.desglose_texto ? `<div class="seccion"><h3>Desglose de descuentos (texto del PDF)</h3><pre class="json">${esc(d.desglose_texto)}</pre></div>` : ''}</div>
        <div class="tab hidden" data-tab="json"><div class="seccion"><h3>${f.estado === 'cargada' ? 'Enviado a Shares' : 'Así se va a enviar'} (POST /supplier-invoices/receive)</h3><pre class="json">${esc(JSON.stringify(p, null, 2))}</pre>
          ${f.shares_respuesta ? `<h3 style="margin-top:12px">Respuesta de Shares</h3><pre class="json">${esc(JSON.stringify(f.shares_respuesta, null, 2))}</pre>` : ''}</div></div>
        <div class="tab hidden" data-tab="hist"><ul class="pasos-liq">${f.eventos.slice().reverse().map(htmlPaso).join('') || '<li class="muted small">Sin movimientos.</li>'}</ul>
          <div class="tabla-wrap"><table><thead><tr><th>Cuándo</th><th>Quién</th><th>Acción</th><th>Antes → Después</th></tr></thead><tbody>
          ${f.auditoria.map(a => `<tr><td class="small mono">${fmtFH(a.ts)}</td><td class="small">${esc(a.usuario)}</td><td class="small">${esc(a.accion)}</td><td class="small mono">${esc(a.valor_anterior ?? '')} → ${esc(a.valor_nuevo ?? '')}</td></tr>`).join('') || '<tr><td colspan="4" class="vacio">Sin cambios.</td></tr>'}</tbody></table></div></div>
      </section>
      ${bots.length ? `<div class="barra-acciones">${bots.map(([bid, html, cls]) => `<button class="btn ${cls}" id="${bid}">${html}</button>`).join('')}</div>` : ''}
    </div>
  </div>`;
  $$('#tabs button').forEach(b => b.onclick = () => { $$('#tabs button').forEach(x => x.classList.toggle('activo', x === b)); $$('.tab', el).forEach(t => t.classList.toggle('hidden', t.dataset.tab !== b.dataset.tab)); });
  const recargar = async (nuevo) => pintarLiquidacion(el, nuevo || await api('/api/liquidaciones/' + f.id));
  const b = (sel, fn) => { const x = $(sel); if (x) x.onclick = () => conBoton(x, fn); };
  b('#b-rev', async () => { await recargar(await api(`/api/liquidaciones/${f.id}/revalidar`, { method: 'POST' })); toast('Controlada de nuevo'); });
  b('#b-reab', async () => recargar(await api(`/api/liquidaciones/${f.id}/reabrir`, { method: 'POST' })));
  b('#b-env', async () => {
    const r = (await api('/api/shares/enviar', { method: 'POST', body: { ids: [f.id] } })).resultados[0];
    toast(r.simulado ? 'Simulación OK: el comprobante se armó bien (no se envió).' : r.ok ? (r.resultado === 'duplicado' ? 'Ya existía en Shares (409): quedó marcada como cargada.' : `Cargada en Shares (nro_reg ${r.shares_ref || '—'})`) : `Shares: ${r.message}`, !r.ok);
    await recargar();
  });
  const bx = $('#b-exc');
  if (bx) bx.onclick = async () => { const motivo = await pedirTexto({ titulo: 'Excluir liquidación', ayuda: 'No se carga en Shares. Queda registrado el motivo y se puede reabrir.', etiqueta: 'Motivo', boton: 'Excluir', minimo: 3 }); if (motivo) conBoton(bx, async () => recargar(await api(`/api/liquidaciones/${f.id}/excluir`, { method: 'POST', body: { motivo } }))); };
  const bd = $('#b-del');
  if (bd) bd.onclick = async () => { if (!await confirmar('Se borra de la app y podés volver a subir el PDF.', { boton: 'Borrar', peligro: true })) return; conBoton(bd, async () => { await api('/api/liquidaciones/' + f.id, { method: 'DELETE' }); toast('Borrada'); location.hash = '#/mes/' + f.periodo; }); };
  const ba = $('#b-asig');
  if (ba) ba.onclick = () => modalLocal({ direccion: f.direccion }, () => recargar());
}

// ---------------------------------------------------------------------------
//  Locales: dirección del PDF → cuenta de comisiones
// ---------------------------------------------------------------------------
async function cuentasComisiones(forzar = false) {
  if (!S.cuentas || forzar) S.cuentas = (await api('/api/cuentas')).cuentas;
  return S.cuentas;
}

async function modalLocal(local, alGuardar) {
  await cuentasComisiones().catch(() => null);
  const com = (S.cuentas || []).filter(c => /COMISION/i.test(c.denominacion));
  modal(`<h2>${local.id ? 'Editar local' : 'Asignar cuenta al local'}</h2>
    <p class="muted">La dirección tiene que ser <b>tal cual sale en el PDF</b> (no importan mayúsculas ni espacios). Al guardar, se vuelven a controlar solas las liquidaciones de esa dirección que no se cargaron.</p>
    <form id="f-loc">
      <div class="campo"><label>Dirección en el PDF</label><input name="direccion" class="mono" required value="${esc(local.direccion || '')}"></div>
      <div class="fila"><div class="campo"><label>Cuenta de comisiones (código Shares)</label><input name="codigo_concepto" class="mono" required inputmode="numeric" list="dl-com" value="${esc(local.codigo_concepto || '')}" placeholder="Ej.: 432022"></div>
        <div class="campo"><label>Nombre corto (opcional)</label><input name="alias" value="${esc(local.alias || '')}" placeholder="Ej.: Galerías Pacífico"></div></div>
      <datalist id="dl-com">${com.map(c => `<option value="${c.codigo_concepto}">${esc(c.denominacion)}</option>`).join('')}</datalist>
      <div class="campo"><label>Denominación</label><input name="denominacion" id="loc-den" value="${esc(local.denominacion || '')}" placeholder="Se completa sola si la cuenta está sincronizada"></div>
      ${!com.length ? `<p class="ayuda">${ICO.info} No hay cuentas sincronizadas de Shares todavía: escribí el código a mano o sincronizalas en Locales.</p>` : ''}
      <div class="acciones" style="margin-top:12px"><button class="btn btn-negro" type="submit">Guardar</button>${local.id ? '<button class="btn btn-rojo" type="button" id="loc-del">Desactivar</button>' : ''}</div></form>`, {
    alMontar: (el, cerrar) => {
      const cod = $('[name=codigo_concepto]', el), den = $('#loc-den', el);
      cod.oninput = () => { const c = (S.cuentas || []).find(x => String(x.codigo_concepto) === cod.value.trim()); if (c) den.value = c.denominacion; };
      $('#f-loc', el).onsubmit = (e) => {
        e.preventDefault();
        conBoton($('button[type=submit]', e.target), async () => {
          const body = Object.fromEntries(new FormData(e.target));
          const r = await api(local.id ? '/api/locales/' + local.id : '/api/locales', { method: local.id ? 'PUT' : 'POST', body });
          cerrar();
          toast(`Guardado${r.revalidadas ? `: se controlaron ${r.revalidadas} liquidación(es), ${r.cambiaron} cambiaron` : ''}.`);
          if (alGuardar) await alGuardar();
          pintarNavMeses();
        });
      };
      const bd = $('#loc-del', el);
      if (bd) bd.onclick = async () => { if (!await confirmar('Las liquidaciones de esta dirección que no estén cargadas van a quedar "para revisar".', { boton: 'Desactivar', peligro: true })) return; await api('/api/locales/' + local.id, { method: 'DELETE' }); toast('Desactivado'); if (alGuardar) await alGuardar(); };
    },
  });
}

async function vistaLocales(el) {
  const r = await api('/api/locales');
  el.innerHTML = `<div class="encabezado"><div><h1>Locales y cuentas</h1><p>Cada dirección del PDF va a una cuenta de comisiones de Shares (era el diccionario CONCEPTOS del script). Si aparece un local nuevo, se asigna acá una vez y queda para siempre.</p></div>
      <div class="acciones">${puede('aprobador') ? `<button class="btn" id="b-sync">${ICO.refresh}Sincronizar cuentas de Shares</button><button class="btn btn-negro" id="b-nuevo">Nuevo local</button>` : ''}</div></div>
    ${r.sin_local.length ? `<div class="panel" style="margin-bottom:16px;border-color:var(--neg)"><div class="panel-titulo"><h2 class="txt-neg">Direcciones sin cuenta</h2><span class="ayuda">Aparecieron en PDFs y no están en la lista</span></div>
      <ul class="feed">${r.sin_local.map(x => `<li><div style="min-width:0"><div class="t mono">${esc(x.direccion)}</div><div class="d">${x.n} PDF(s) para revisar · ${esc(NombreMes(x.periodo))}</div></div><div></div>${puede('aprobador') ? `<button class="btn btn-chico btn-negro" data-asig="${esc(x.direccion)}">Asignar cuenta</button>` : ''}</li>`).join('')}</ul></div>` : ''}
    <div class="panel"><div class="cola-bar"><label class="campo-buscar">${ICO.search}<input id="q-loc" placeholder="Buscar dirección, cuenta o nombre"></label><span class="small muted">${r.locales.filter(l => l.activo).length} activos</span></div>
      <div class="tabla-wrap"><table><thead><tr><th>Local</th><th>Dirección en el PDF</th><th>Cuenta</th><th class="num">PDFs</th><th>Último mes</th><th></th></tr></thead><tbody id="tb-loc"></tbody></table></div></div>`;
  const pintar = () => {
    const q = ($('#q-loc').value || '').toUpperCase();
    $('#tb-loc').innerHTML = r.locales.filter(l => !q || `${l.direccion} ${l.codigo_concepto} ${l.denominacion} ${l.alias || ''}`.toUpperCase().includes(q)).map(l => `<tr class="${l.activo ? '' : 'muted'}">
      <td><b>${esc(l.alias || String(l.denominacion || '').replace(/^COMISIONES PAGADAS L\.?\s*/i, '') || '—')}</b>${l.activo ? '' : ' <span class="badge b-aviso">inactivo</span>'}</td>
      <td class="mono small">${esc(l.direccion)}</td><td class="small"><span class="mono">${esc(l.codigo_concepto)}</span><small class="sub-celda">${esc(l.denominacion || '')}</small></td>
      <td class="num">${l.usos || 0}</td><td class="small">${l.ultimo_periodo ? esc(NombreMes(l.ultimo_periodo)) : '—'}</td>
      <td>${puede('aprobador') ? `<button class="btn btn-chico" data-ed="${l.id}">Editar</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="vacio">Sin resultados.</td></tr>';
    $$('[data-ed]', el).forEach(b => b.onclick = () => modalLocal(r.locales.find(x => String(x.id) === b.dataset.ed), () => vistaLocales(el)));
  };
  $('#q-loc').oninput = pintar;
  pintar();
  $$('[data-asig]', el).forEach(b => b.onclick = () => modalLocal({ direccion: b.dataset.asig }, () => vistaLocales(el)));
  const bn = $('#b-nuevo'); if (bn) bn.onclick = () => modalLocal({}, () => vistaLocales(el));
  const bs = $('#b-sync'); if (bs) bs.onclick = () => conBoton(bs, async () => { const x = await api('/api/cuentas/sincronizar', { method: 'POST' }); await cuentasComisiones(true); toast(`${x.cantidad} cuentas traídas de Shares.`); });
}

// ---------------------------------------------------------------------------
//  Configuración (admin)
// ---------------------------------------------------------------------------
async function vistaAdmin(el) {
  if (!puede('admin')) throw new Error('Necesitás rol admin.');
  const tab0 = sessionStorage.getItem('pw_admin_tab');
  const tab = ['ajustes', 'usuarios', 'auditoria'].includes(tab0) ? tab0 : 'ajustes';
  el.innerHTML = `<div class="encabezado"><div><h1>Configuración</h1><p>Ajustes, usuarios y auditoría.</p></div></div>
    <div class="panel"><div class="tabs" id="tabs-adm">${[['ajustes', 'Ajustes'], ['usuarios', 'Usuarios'], ['auditoria', 'Auditoría']].map(([k, t]) => `<button data-t="${k}" class="${k === tab ? 'activo' : ''}">${t}</button>`).join('')}</div><div id="adm" class="panel-pad"></div></div>`;
  const ir = (t) => { sessionStorage.setItem('pw_admin_tab', t); $$('#tabs-adm button').forEach(b => b.classList.toggle('activo', b.dataset.t === t)); (({ ajustes: adminAjustes, usuarios: adminUsuarios, auditoria: adminAuditoria })[t] || adminAjustes)($('#adm')).catch(e => { $('#adm').innerHTML = `<p class="txt-neg">${esc(e.message)}</p>`; }); };
  $$('#tabs-adm button').forEach(b => b.onclick = () => ir(b.dataset.t));
  ir(tab);
}

const CFG_UI = [
  { k: 'modo_simulacion', tipo: 'switch', t: 'Modo simulación', d: 'Prendido: “Enviar a Shares” arma y muestra cada comprobante pero NO lo manda (como --dry-run). Apagalo para cargar de verdad.', si: 'Prendido (no se envía nada)', no: 'Apagado: se carga en Shares', confirmarNo: 'A partir de ahora "Enviar a Shares" carga los comprobantes de verdad. ¿Seguimos?' },
];

async function adminAjustes(el) {
  const r = await api('/api/config');
  const cfg = r.config;
  el.innerHTML = CFG_UI.map(it => `<div class="cfg-row"><div><div class="t">${esc(it.t)}</div><div class="d">${esc(it.d)}</div></div><div class="cfg-ctrl">
    ${it.tipo === 'switch' ? `<label class="switch"><input type="checkbox" data-sw="${it.k}" ${cfg[it.k] ? 'checked' : ''}><span></span></label><span class="sw-txt" data-swtxt="${it.k}">${esc(cfg[it.k] ? it.si : it.no)}</span>`
      : `<span class="muted">${it.pre || ''}</span><input type="number" data-num="${it.k}" value="${esc(cfg[it.k])}" min="0" step="${it.step || 1}" style="width:110px">`}</div></div>`).join('')
    + '<p class="small muted" style="margin-top:14px">Los cambios se guardan solos y quedan en Auditoría.</p>';
  $$('[data-sw]', el).forEach(c => c.onchange = async () => {
    const it = CFG_UI.find(x => x.k === c.dataset.sw);
    const msg = c.checked ? it.confirmarSi : it.confirmarNo;
    if (msg && !await confirmar(msg)) { c.checked = !c.checked; return; }
    try {
      await api('/api/config', { method: 'PUT', body: { clave: it.k, valor: c.checked } });
      $(`[data-swtxt="${it.k}"]`, el).textContent = c.checked ? it.si : it.no;
      if (it.k === 'modo_simulacion') { S.simulacion = c.checked; router(); }
      toast('Guardado');
    } catch (e) { c.checked = !c.checked; toast(e.message, true); }
  });
  $$('[data-num]', el).forEach(i => i.onchange = async () => {
    try { await api('/api/config', { method: 'PUT', body: { clave: i.dataset.num, valor: Number(String(i.value).replace(',', '.')) } }); toast('Guardado'); }
    catch (e) { toast(e.message, true); }
  });
}

async function adminUsuarios(el) {
  const r = await api('/api/usuarios');
  el.innerHTML = `<div class="acciones" style="margin-bottom:12px"><button class="btn btn-negro" id="b-nu">Nuevo usuario</button></div>
    <div class="tabla-wrap"><table><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>2FA</th><th>Estado</th><th></th></tr></thead><tbody>
    ${r.usuarios.map(u => `<tr><td>${esc(u.nombre)}</td><td>${esc(u.email)}</td>
      <td><select data-rol="${u.id}">${['carga', 'aprobador', 'admin'].map(x => `<option ${u.rol === x ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
      <td>${u.totp_activo ? '<span class="badge b-ok">activo</span>' : '<span class="badge b-aviso">no</span>'}</td>
      <td>${u.activo ? 'Activo' : '<span class="muted">Inactivo</span>'}</td>
      <td class="acciones"><button class="btn btn-chico" data-pass="${u.id}">Resetear clave</button>${u.totp_activo ? `<button class="btn btn-chico" data-totp="${u.id}">Resetear 2FA</button>` : ''}<button class="btn btn-chico" data-act="${u.id}" data-v="${u.activo ? 0 : 1}">${u.activo ? 'Desactivar' : 'Activar'}</button></td></tr>`).join('')}
    </tbody></table></div><p class="small muted">Roles: <b>carga</b> sube PDFs y mira · <b>aprobador</b> además envía a Shares, asigna locales, excluye y cierra meses · <b>admin</b> todo, incluida la configuración.</p>`;
  const put = (id, body) => api('/api/usuarios/' + id, { method: 'PUT', body }).then(() => { toast('Guardado'); adminUsuarios(el); }).catch(e => toast(e.message, true));
  $$('[data-rol]', el).forEach(s => s.onchange = () => put(s.dataset.rol, { rol: s.value }));
  $$('[data-act]', el).forEach(b => b.onclick = () => put(b.dataset.act, { activo: b.dataset.v === '1' }));
  $$('[data-totp]', el).forEach(b => b.onclick = async () => await confirmar('¿Resetear el doble factor de este usuario?') && put(b.dataset.totp, { reset_totp: true }));
  $$('[data-pass]', el).forEach(b => b.onclick = async () => { const p = await pedirTexto({ titulo: 'Nueva contraseña', etiqueta: 'Contraseña (mínimo 10 caracteres)', boton: 'Guardar', minimo: 10 }); if (p) put(b.dataset.pass, { password: p }); });
  $('#b-nu', el).onclick = () => modal(`<h2>Nuevo usuario</h2><form id="f-nu">
      <div class="campo"><label>Nombre</label><input name="nombre" required></div>
      <div class="campo"><label>Email</label><input name="email" type="email" required></div>
      <div class="campo"><label>Rol</label><select name="rol"><option selected>carga</option><option>aprobador</option><option>admin</option></select></div>
      <div class="campo"><label>Contraseña inicial</label><input name="password" type="text" minlength="10" required><div class="ayuda">Pasásela por un canal seguro; la puede cambiar en “Mi cuenta”.</div></div>
      <button class="btn btn-negro" type="submit">Crear</button></form>`, {
    alMontar: (m, cerrar) => { $('#f-nu', m).onsubmit = (e) => { e.preventDefault(); conBoton($('button', e.target), async () => { await api('/api/usuarios', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); cerrar(); toast('Usuario creado'); adminUsuarios(el); }); }; },
  });
}

async function adminAuditoria(el) {
  const r = await api('/api/auditoria');
  el.innerHTML = `<div class="tabla-wrap" style="max-height:65vh"><table><thead><tr><th>Cuándo</th><th>Quién</th><th>Qué</th><th>Acción</th><th>Antes → Después</th></tr></thead><tbody>
    ${r.auditoria.map(a => `<tr><td class="small mono">${fmtFH(a.ts)}</td><td class="small">${esc(a.usuario)}</td><td class="small">${a.entidad === 'liquidacion' ? `<a href="#/liq/${esc(a.entidad_id)}">liquidación #${esc(a.entidad_id)}</a>` : esc(`${a.entidad} ${a.entidad_id}`)}</td><td class="small">${esc(a.accion)}</td><td class="small mono">${esc(String(a.valor_anterior ?? '').slice(0, 80))} → ${esc(String(a.valor_nuevo ?? '').slice(0, 80))}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------------------------------------------------------------------------
//  Mi cuenta
// ---------------------------------------------------------------------------
async function vistaMiCuenta(el) {
  el.innerHTML = `<div class="encabezado"><div><h1>Mi cuenta</h1><p>${esc(S.user.email)} · rol ${esc(S.user.rol)}</p></div></div>
    <div class="panel panel-pad" style="max-width:560px"><h2 style="margin-bottom:12px">Doble factor</h2>
      ${S.user.totp_activo ? '<p><span class="badge b-ok">Activo</span> Te vamos a pedir el código de tu app autenticadora al ingresar.</p>'
      : '<p class="muted">Usá Google Authenticator, Microsoft Authenticator o similar.</p><button class="btn btn-negro" id="b-2fa">Activar doble factor</button><div id="c-2fa"></div>'}
    </div>
    <form class="panel panel-pad" style="max-width:560px" id="f-pass"><h2 style="margin-bottom:12px">Cambiar contraseña</h2>
      <div class="campo"><label>Actual</label><input type="password" name="actual" required autocomplete="current-password"></div>
      <div class="campo"><label>Nueva (mínimo 10 caracteres)</label><input type="password" name="nueva" minlength="10" required autocomplete="new-password"></div>
      <button class="btn btn-negro" type="submit">Cambiar</button></form>`;
  $('#f-pass').onsubmit = (e) => { e.preventDefault(); conBoton($('button', e.target), async () => { await api('/api/yo/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast('Contraseña cambiada'); }); };
  const b = $('#b-2fa');
  if (b) b.onclick = () => conBoton(b, async () => {
    const r = await api('/api/yo/totp/iniciar', { method: 'POST' });
    $('#c-2fa').innerHTML = `<p>1. Escaneá este QR con la app:</p><div id="qr" style="background:#fff;padding:12px;display:inline-block;border-radius:8px"></div>
      <p class="small muted">o cargá la clave a mano: <span class="mono">${esc(r.secret)}</span></p>
      <p>2. Escribí el código de 6 dígitos que muestra la app:</p><div class="fila"><input id="code" inputmode="numeric" maxlength="6" class="mono"><button class="btn btn-negro" id="b-conf">Confirmar</button></div>`;
    try { await cargarScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'); new QRCode($('#qr'), { text: r.otpauth, width: 180, height: 180 }); } catch { $('#qr').textContent = r.otpauth; }
    b.remove();
    $('#b-conf').onclick = () => conBoton($('#b-conf'), async () => { await api('/api/yo/totp/confirmar', { method: 'POST', body: { code: $('#code').value } }); S.user.totp_activo = true; toast('Doble factor activado'); vistaMiCuenta(el); });
  });
}

// ---------------------------------------------------------------------------
//  Guía
// ---------------------------------------------------------------------------
async function vistaGuia(el) {
  const paso = (ic, n, t, d) => `<li><div class="num-paso">${ICO[ic]}<b>PASO ${n}</b></div><div class="t">${t}</div><p>${d}</p></li>`;
  el.innerHTML = `<div class="encabezado"><div><h1>Cómo se usa</h1><p>Lo mismo que hacían los scripts de Python, pero desde el navegador y con todo a la vista.</p></div></div>
    <div class="panel"><ol class="pasos-guia">
      ${paso('download', 1, 'Bajá los PDFs de Payway', 'Los “Resumen Mensual de Liquidaciones” de cada establecimiento (unos 130 por mes). Dejalos todos en una carpeta.')}
      ${paso('upload', 2, 'Arrastralos a la app', 'Todos juntos o la carpeta entera. Se leen en tu compu con pdf.js, sin IA: mismos criterios que extraer_payway.py. Los PDFs no se suben ni se guardan: solo viajan los datos.')}
      ${paso('shield', 3, 'Controles', 'Que la suma de ítems dé el Total Descuento, que el local tenga cuenta, CUITs, IVA, saldo, fecha del mes y duplicados.')}
      ${paso('alert', 4, 'Corregí lo que falte', 'Mientras procesa ves qué archivo está leyendo. Al final aparece la lista “Para corregir” con el motivo de cada una y el botón para arreglarla.')}
      ${paso('send', 5, 'Enviá a Shares', 'Van de a 5 a /supplier-invoices/receive. Si alguna ya existía, Shares contesta 409 y queda marcada, sin duplicar.')}
    </ol></div>
    <div class="dos" style="margin-top:16px">
      <div class="panel panel-pad guia-txt"><h2 style="margin-bottom:10px">¿Dónde quedan los PDFs?</h2>
        <p>En ningún lado: quedan en tu compu, donde los bajaste de Payway. La app lee cada PDF en el navegador y manda solo los datos (y una huella para reconocerlo).</p>
        <p>Cuando algo no cierra, cada error arranca con el <b>nombre del archivo</b>: hacés clic y se copia, para pegarlo en el buscador de la carpeta y abrirlo vos.</p>
        <h2 style="margin:16px 0 10px">¿Qué pasa si subo dos veces el mismo PDF?</h2>
        <p>Nada: la app reconoce el par <b>establecimiento + N° de resumen</b> y avisa “ya estaba registrada”. Y aunque se mandara dos veces a Shares, Shares contesta 409 por el <span class="mono">id_referencia_externa</span> (<span class="mono">PAYWAY-establecimiento-resumen</span>, el mismo que usaba el script).</p></div>
      <div class="panel panel-pad guia-txt"><h2 style="margin-bottom:10px">Qué significa cada error</h2>
        <p><b>SIN_LOCAL</b> · la dirección del PDF no tiene cuenta de comisiones. Asignala (botón “Asignar cuenta”) y se vuelve a controlar sola.</p>
        <p><b>NO_CUADRA</b> · los ítems no suman el Total Descuento: falta leer algún concepto del desglose. Abrí el PDF y avisale a Juan.</p>
        <p><b>JURIS_NO_MAPEADA</b> · retención de IIBB de una provincia que no tiene cuenta en el catálogo de Shares (ej.: Misiones).</p>
        <p><b>FALTAN_DATOS / CUIT_INVALIDO</b> · el PDF no se leyó bien o no es un resumen de Payway.</p>
        <p><b>Error de Shares</b> · Shares rechazó el comprobante (el mensaje dice por qué). Se corrige y se reenvía.</p>
        <p class="small">Los avisos (IVA con redondeo, fecha de otro mes, saldo) no frenan el envío: son para mirar.</p></div>
    </div>`;
}
