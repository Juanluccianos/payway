/* =============================================================================
 *  Lector de PDFs Payway (Resumen Mensual de Liquidaciones) — Lucciano's
 *  Es la versión JavaScript de extraer_payway.py: corre en el navegador con
 *  pdf.js, así los 130 PDFs se leen en la compu en segundos y sin IA.
 *  Devuelve los mismos campos que el script de Python; el Worker hace después
 *  la clasificación (local → cuenta) y arma el comprobante para Shares.
 *
 *  Uso:  const r = await PaywayLector.leer(pdfjsLib, bytes, nombreArchivo)
 *        → { ok, datos, faltan[], paginas }
 * ============================================================================= */
(function (root) {
  'use strict';

  const NUM = '-?[\\d\\.]+,\\d{2}';
  const aFloat = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'));
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  // ---------------------------------------------------------------------------
  //  Texto por líneas a partir de los fragmentos de pdf.js (x, y de la base).
  //  Equivale al extract_text de pdfplumber: agrupa por renglón y ordena por x.
  //  filtro(item) permite "recortar" una zona de la página (columna izq./der.).
  // ---------------------------------------------------------------------------
  function textoPagina(pag, filtro) {
    const items = pag.items.filter(it => it.s !== '' && (!filtro || filtro(it)));
    items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const lineas = [];
    for (const it of items) {
      const l = lineas[lineas.length - 1];
      if (l && Math.abs(l.y - it.y) <= 3) l.items.push(it);
      else lineas.push({ y: it.y, items: [it] });
    }
    return lineas.map(l => {
      l.items.sort((a, b) => a.x - b.x);
      let out = '', fin = null;
      for (const it of l.items) {
        if (fin !== null && it.x - fin > 1 && !/\s$/.test(out)) out += ' ';
        out += it.s;
        fin = it.x + it.w;
      }
      return out.replace(/\s+/g, ' ').trim();
    }).filter(Boolean).join('\n');
  }

  // Pasa un PDF (bytes) a una estructura simple: [{ w, h, items:[{s,x,y,w}] }]
  async function paginasDesdePdf(pdfjsLib, bytes) {
    const doc = await pdfjsLib.getDocument({ data: bytes, disableFontFace: true, isEvalSupported: false }).promise;
    const paginas = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i);
        const vp = p.getViewport({ scale: 1 });
        const tc = await p.getTextContent();
        paginas.push({
          w: vp.width, h: vp.height,
          items: tc.items.filter(it => typeof it.str === 'string').map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 })),
        });
        p.cleanup();
      }
    } finally {
      doc.destroy();
    }
    return paginas;
  }

  const buscar = (re, txt, g = 1) => { const m = re.exec(txt); return m ? m[g].trim() : null; };

  // ---------------------------------------------------------------------------
  //  Extracción: mismos criterios que extraer_pdf() del script de Python
  // ---------------------------------------------------------------------------
  function extraer(paginas, archivo) {
    if (!paginas.length) throw new Error('El PDF no tiene páginas.');
    const p1 = paginas[0];
    const t1 = textoPagina(p1);
    const d = { archivo };

    if (!/Resumen Mensual de Liquidaciones/i.test(t1)) {
      throw new Error('No parece un "Resumen Mensual de Liquidaciones" de Payway.');
    }

    d.fecha_emision = buscar(/FECHA DE EMISION:\s*(\S+)/, t1);
    d.pagador = buscar(/PAGADOR:\s*(.+)/, t1);
    d.codigo_banco = buscar(/PAGADOR:\s*(\d{3})\s+/, t1);
    d.cuit_proveedor = buscar(/Nº DE CUIT:\s*([\d\s-]+)/, t1);
    d.cuit_empresa = buscar(/Nº CUIT ESTABLEC\.:\s*([\d\s-]+)/, t1);
    d.razon_social_empresa = buscar(/Razón Social\s*\n(.+)/, t1);
    d.nro_resumen = buscar(/Nº DE RESUMEN:\s*(\d+)/, t1);
    d.nro_establecimiento = buscar(/Nº DE ESTABLECIMIENTO:\s*(\d+)/, t1);
    // "30 50001008 4" → solo dígitos
    for (const k of ['cuit_proveedor', 'cuit_empresa']) if (d[k]) d[k] = d[k].split('\n')[0].replace(/\D/g, '');

    // ---- Bloque Establecimiento: columna izquierda de la página 1 (45% de arriba) ----
    const corteY = p1.h * 0.55;   // pdf.js mide la y desde abajo
    const izq = textoPagina(p1, it => it.x < p1.w * 0.52 && it.y > corteY);
    const lineas = izq.split('\n').map(s => s.trim()).filter(Boolean);
    const i = lineas.findIndex(l => l.startsWith('Establecimiento'));
    const bloque = i >= 0 ? lineas.slice(i + 1, i + 5) : [];
    d.establecimiento = bloque[0] || null;
    d.direccion = bloque[1] || null;
    d.cp = null; d.localidad = null;
    if (bloque[2] && bloque[2].startsWith('C.P.')) {
      const m = /^C\.P\.\s*(\S+)\s+(.*)$/.exec(bloque[2]);
      if (m) { d.cp = m[1]; d.localidad = m[2].trim(); }
    }
    d.provincia = bloque[3] || null;

    // ---- Totales: columna derecha de la página 1 ----
    const der = textoPagina(p1, it => it.x >= p1.w * 0.5 && it.y > corteY);
    let m = new RegExp('TOTAL DESCUENTO \\$.*?\\n\\s*(' + NUM + ')').exec(der);
    d.total_descuento = m ? aFloat(m[1]) : null;
    m = new RegExp('TOTAL PRESENTADO \\$.*?\\n\\s*(' + NUM + ')').exec(der);
    d.total_presentado = m ? aFloat(m[1]) : null;
    m = new RegExp('SALDO \\$.*?\\n\\s*(' + NUM + ')').exec(der);
    d.saldo = m ? aFloat(m[1]) : null;

    // ---- Desglose de Descuentos: último bloque del documento ----
    const texto = paginas.map(p => textoPagina(p)).join('\n');
    const partes = texto.split('DESGLOSE DE DESCUENTOS');
    let desg = partes.length > 1 ? partes[partes.length - 1] : '';
    desg = desg.split('SR. COMERCIANTE')[0];
    d.tiene_desglose = partes.length > 1;

    m = new RegExp('Tasa\\s+([\\d,]+)\\s*%\\s+\\$\\s*(' + NUM + ')').exec(desg);
    d.alicuota_iva = m ? aFloat(m[1]) : null;
    d.monto_gravado = m ? aFloat(m[2]) : null;

    m = new RegExp('\\bIVA\\s+[\\d,]+\\s*%\\s+\\$\\s*(' + NUM + ')').exec(desg);
    d.iva = m ? aFloat(m[1]) : null;

    m = new RegExp('Ret\\.IB SIRTAC\\s*\\n?\\s*[\\d,]+\\s*%\\s+\\$\\s*(' + NUM + ')').exec(desg);
    d.ret_sirtac = m ? aFloat(m[1]) : null;

    // Otras Ret.IB jurisdiccionales (CAP.FED., provincias, etc.)
    const reJur = new RegExp('Ret\\.IB (?!SIRTAC)([^\\n%]+?)\\s+[\\d,]+\\s*%\\s+\\$\\s*(' + NUM + ')', 'g');
    d.ret_iibb_jurisdiccional = [];
    while ((m = reJur.exec(desg))) d.ret_iibb_jurisdiccional.push({ jurisdiccion: m[1].trim(), importe: aFloat(m[2]) });

    m = new RegExp('Percep\\./Retenc\\.AFIP - DGI\\s+\\$\\s*(' + NUM + ')').exec(desg);
    d.percep_afip = m ? aFloat(m[1]) : null;

    // Devolución de descuento por ventas en campaña (crédito del banco). Viene negativa.
    const reAj = new RegExp('Ajuste CR[^\\n$]*\\$\\s*(' + NUM + ')', 'g');
    let aj = 0, hayAj = false;
    while ((m = reAj.exec(desg))) { aj += aFloat(m[1]); hayAj = true; }
    d.devol_campania = hayAj ? r2(aj) : null;

    // Renglones del desglose que no reconocemos (para avisar, no para cargar)
    d.desglose_texto = desg.trim().slice(0, 3000);
    return d;
  }

  // Campos sin los cuales no se puede armar el comprobante
  const OBLIGATORIOS = {
    fecha_emision: 'Fecha de emisión', nro_resumen: 'N° de resumen', nro_establecimiento: 'N° de establecimiento',
    cuit_proveedor: 'CUIT del banco', cuit_empresa: 'CUIT de la empresa', direccion: 'Dirección del local', total_descuento: 'Total descuento $',
  };

  async function leer(pdfjsLib, bytes, archivo) {
    const paginas = await paginasDesdePdf(pdfjsLib, bytes);
    const datos = extraer(paginas, archivo);
    const faltan = Object.entries(OBLIGATORIOS).filter(([k]) => datos[k] === null || datos[k] === undefined || datos[k] === '').map(([, v]) => v);
    return { ok: !faltan.length, datos, faltan, paginas: paginas.length };
  }

  const api = { leer, extraer, textoPagina, paginasDesdePdf, OBLIGATORIOS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaywayLector = api;
})(typeof self !== 'undefined' ? self : this);
