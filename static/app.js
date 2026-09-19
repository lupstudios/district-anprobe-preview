/* Tattoo-Anprobe im Browser.
 * Die Kamera läuft nur auf dem Handy. Ans Studio geht erst ein Standbild, wenn jemand
 * «So sieht's echt aus» tippt. Arbeitsfläche immer 960 × 1280 (3:4), wie das Echt-Bild. */
(() => {
  'use strict';

  const K = JSON.parse(document.getElementById('konfig').textContent);
  const T = K.texte;
  const W = 960;
  const H = 1280;
  const $ = (wahl, el = document) => el.querySelector(wahl);
  const $$ = (wahl, el = document) => [...el.querySelectorAll(wahl)];
  const klemmen = (x, min, max) => Math.min(max, Math.max(min, x));
  const fuellen = (text, werte) => text.replace(/\{(\w+)\}/g, (roh, k) => (k in werte ? werte[k] : roh));
  const reduziert = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Vorschau auf GitHub Pages: kein Server dahinter, also nichts zählen, nichts speichern, nichts senden.
  const VORSCHAU = Boolean(K.vorschau);

  // Gleiche Regel wie telefon_normalisieren() im Server: CH-Nummer mit 9 Ziffern oder internationale Nummer.
  function telefonOk(roh) {
    let n = roh.replace(/[\s\-/().]/g, '');
    if (n.startsWith('00')) n = '+' + n.slice(2);
    else if (n.startsWith('0')) n = '+41' + n.slice(1);
    else if (/^41\d{9}$/.test(n)) n = '+' + n;
    return /^\+[1-9]\d{7,14}$/.test(n) && (!n.startsWith('+41') || n.length === 12);
  }

  /* ---------------------------------------------------------- Zählung (ohne Namen, ohne IP) */
  const zufall = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
  const sitzung = (() => {
    try {
      let s = sessionStorage.getItem('anprobe-sitzung');
      if (!s) { s = zufall(); sessionStorage.setItem('anprobe-sitzung', s); }
      return s;
    } catch { return zufall(); }
  })();
  const kopf = { 'X-Anprobe-Sitzung': sitzung };
  const gezaehlt = new Set();
  function zaehlen(art) {
    if (VORSCHAU || gezaehlt.has(art)) return;
    gezaehlt.add(art);
    const daten = JSON.stringify({ art, sitzung });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/api/ereignis', new Blob([daten], { type: 'application/json' }))) return;
    } catch { /* weiter mit fetch */ }
    fetch('/api/ereignis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: daten, keepalive: true }).catch(() => {});
  }

  /* ---------------------------------------------------------- Meldungen */
  const toast = $('#toast');
  let toastUhr;
  function melden(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastUhr);
    toastUhr = setTimeout(() => { toast.hidden = true; }, 6500);
  }

  /* ---------------------------------------------------------- Zustand */
  const S = {
    motiv: null,        // { bild: Canvas, titel, stilprobe, datei }
    strom: null,        // Kamera
    quelle: null,       // 'kamera' | 'foto'
    standbild: null,    // angehaltenes Kamerabild oder Foto, W × H
    x: W / 2, y: H / 2, groesse: 0.45, winkel: 0,
    rahmen: false,
    schablone: null, schabloneUrl: null,
    token: null, bildUrl: null, schabloneAnsicht: null,
    kontakt: K.kontakt,
  };

  /* ---------------------------------------------------------- Schritte */
  let aktuell = 'start';
  function zeige(name) {
    aktuell = name;
    $$('.schritt').forEach(s => s.classList.toggle('aktiv', s.dataset.schritt === name));
    window.scrollTo(0, 0);
    if (name === 'anprobe') anprobeRein(); else anprobeRaus();
    if (name === 'anfrage') $('#anfrage-vorschau').src = S.bildUrl;
  }
  document.addEventListener('click', e => {
    const ziel = e.target.closest('[data-geh]');
    if (ziel) { e.preventDefault(); zeige(ziel.dataset.geh); }
  });

  /* ---------------------------------------------------------- Bilder laden */
  function bildLaden(quelle) {
    return new Promise((fertig, fehler) => {
      const bild = new Image();
      const url = typeof quelle === 'string' ? quelle : URL.createObjectURL(quelle);
      const aufraeumen = () => { if (typeof quelle !== 'string') URL.revokeObjectURL(url); };
      bild.onload = () => { aufraeumen(); fertig(bild); };
      bild.onerror = () => { aufraeumen(); fehler(new Error('Bild nicht lesbar')); };
      bild.src = url;
    });
  }
  function leinwandNeu(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function verkleinern(bild, laengste) {
    const f = Math.min(1, laengste / Math.max(bild.naturalWidth || bild.width, bild.naturalHeight || bild.height));
    const c = leinwandNeu(Math.round((bild.naturalWidth || bild.width) * f), Math.round((bild.naturalHeight || bild.height) * f));
    c.getContext('2d').drawImage(bild, 0, 0, c.width, c.height);
    return c;
  }
  const alsBlob = (c, typ, q) => new Promise(fertig => c.toBlob(fertig, typ, q));

  // Füllt das 3:4-Format und schneidet über, was nicht reinpasst.
  function abdeckenAuf(g, quelle, sw, sh, w, h) {
    const ziel = w / h;
    let x = 0, y = 0, bw = sw, bh = sh;
    if (sw / sh > ziel) { bw = sh * ziel; x = (sw - bw) / 2; } else { bh = sw / ziel; y = (sh - bh) / 2; }
    g.drawImage(quelle, x, y, bw, bh, 0, 0, w, h);
  }
  function abdecken(quelle, sw, sh) {
    const c = leinwandNeu(W, H);
    abdeckenAuf(c.getContext('2d'), quelle, sw, sh, W, H);
    return c;
  }

  // Eigene Motive: Papier wird rein weiss, der Rand fällt weg. Weiss verschwindet später
  // auf der Haut, weil das Motiv multipliziert wird (wie Tinte, die nur dunkler machen kann).
  function motivAufbereiten(bild) {
    const c = verkleinern(bild, 1200);
    const g = c.getContext('2d', { willReadFrequently: true });
    const daten = g.getImageData(0, 0, c.width, c.height);
    const p = daten.data;
    const verlauf = new Uint32Array(256);
    for (let i = 0; i < p.length; i += 4) {
      const a = p[i + 3] / 255;
      p[i] = p[i] * a + 255 * (1 - a);
      p[i + 1] = p[i + 1] * a + 255 * (1 - a);
      p[i + 2] = p[i + 2] * a + 255 * (1 - a);
      p[i + 3] = 255;
      verlauf[Math.round(0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2])]++;
    }
    let weiss = 255;
    for (let v = 255, summe = 0; v >= 0; v--) {
      summe += verlauf[v];
      if (summe >= 0.03 * c.width * c.height) { weiss = Math.max(v, 128); break; }
    }
    const f = 255 / weiss;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      p[i] *= f; p[i + 1] *= f; p[i + 2] *= f;
      if (Math.min(p[i], p[i + 1], p[i + 2]) < 235) {
        const px = j % c.width, py = (j / c.width) | 0;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
    }
    g.putImageData(daten, 0, 0);
    if (x1 < 0) return c;
    const luft = Math.round(0.03 * Math.max(c.width, c.height));
    x0 = Math.max(0, x0 - luft); y0 = Math.max(0, y0 - luft);
    x1 = Math.min(c.width - 1, x1 + luft); y1 = Math.min(c.height - 1, y1 + luft);
    const zu = leinwandNeu(x1 - x0 + 1, y1 - y0 + 1);
    zu.getContext('2d').drawImage(c, x0, y0, zu.width, zu.height, 0, 0, zu.width, zu.height);
    return zu;
  }

  /* ---------------------------------------------------------- Motiv wählen */
  function motivGesetzt(motiv) {
    const erstes = !S.motiv;
    S.motiv = motiv;
    if (erstes) { S.x = W / 2; S.y = H / 2; S.groesse = 0.45; S.winkel = 0; }
    reglerSetzen();
    zaehlen('motiv');
    zeige('anprobe');
    rahmenKurz();
  }
  $$('[data-motiv]').forEach(kachel => kachel.addEventListener('click', async () => {
    const m = K.motive[Number(kachel.dataset.motiv)];
    try {
      const bild = await bildLaden(m.bild);
      motivGesetzt({ bild: verkleinern(bild, 1200), titel: m.titel, stilprobe: m.name, datei: null });
    } catch { melden(T.fehler_bild); }
  }));
  $('#motiv-datei').addEventListener('change', async e => {
    const datei = e.target.files[0];
    e.target.value = '';
    if (!datei) return;
    try {
      const c = motivAufbereiten(await bildLaden(datei));
      motivGesetzt({ bild: c, titel: T.motiv_eigenes, stilprobe: null, datei: await alsBlob(c, 'image/png') });
    } catch { melden(T.fehler_bild); }
  });

  /* ---------------------------------------------------------- Kamera und Foto */
  const video = $('#video');
  const leinwand = $('#leinwand');
  const ctx = leinwand.getContext('2d');
  let schleifeLaeuft = false;

  function anprobeRein() {
    leinwandGroesse();
    if (!S.standbild && !S.strom) kameraStart();
    if (!schleifeLaeuft) { schleifeLaeuft = true; requestAnimationFrame(schleife); }
    knoepfe();
  }
  function anprobeRaus() { schleifeLaeuft = false; kameraStop(); }

  async function kameraStart() {
    kameraFehler(false);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { kameraFehler(true); return; }
    $('#kamera-laedt').hidden = false;
    try {
      const strom = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      if (aktuell !== 'anprobe' || S.standbild) { strom.getTracks().forEach(spur => spur.stop()); return; }
      S.strom = strom;
      S.quelle = 'kamera';
      video.srcObject = strom;
      await video.play().catch(() => {});
      zaehlen('schablone');
    } catch {
      kameraFehler(true);
    } finally {
      $('#kamera-laedt').hidden = true;
      knoepfe();
    }
  }
  function kameraStop() {
    if (!S.strom) return;
    S.strom.getTracks().forEach(spur => spur.stop());
    S.strom = null;
    video.srcObject = null;
  }
  function kameraFehler(an) {
    $('#kamera-fehler').hidden = !an;
    if (!an) return;
    const ua = navigator.userAgent;
    const inApp = /Instagram|FBAN|FBAV|FB_IAB|TikTok|musical_ly|Bytedance|Snapchat|LinkedInApp/i.test(ua);
    $('#inapp-hinweis').hidden = !inApp;
    const knopf = $('#knopf-im-browser');
    knopf.hidden = !(inApp && /Android/i.test(ua));
    if (!knopf.hidden) {
      const schema = location.protocol.replace(':', '');
      knopf.href = `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=${schema};package=com.android.chrome;end`;
    }
  }
  function kameraBildAnhalten() {
    if (!S.strom || video.readyState < 2 || !video.videoWidth) return false;
    S.standbild = abdecken(video, video.videoWidth, video.videoHeight);
    kameraStop();
    return true;
  }

  $$('[data-foto]').forEach(b => b.addEventListener('click', () => $(b.dataset.foto === 'kamera' ? '#foto-kamera' : '#foto-galerie').click()));
  $('#knopf-foto-statt').addEventListener('click', () => $('#foto-galerie').click());
  ['#foto-kamera', '#foto-galerie'].forEach(wahl => $(wahl).addEventListener('change', async e => {
    const datei = e.target.files[0];
    e.target.value = '';
    if (!datei) return;
    try {
      const bild = await bildLaden(datei);
      kameraStop();
      S.standbild = abdecken(bild, bild.naturalWidth, bild.naturalHeight);
      S.quelle = 'foto';
      kameraFehler(false);
      zaehlen('schablone');
      knoepfe();
      rahmenKurz();
    } catch { melden(T.fehler_bild); }
  }));

  $('#knopf-anhalten').addEventListener('click', () => {
    if (!S.standbild) kameraBildAnhalten();
    else if (S.quelle === 'foto') { $('#foto-galerie').click(); return; }
    else { S.standbild = null; kameraStart(); }
    knoepfe();
  });
  function knoepfe() {
    const anhalten = $('#knopf-anhalten');
    anhalten.textContent = !S.standbild ? T.knopf_anhalten : (S.quelle === 'foto' ? T.knopf_neues_foto : T.knopf_live);
    anhalten.disabled = !S.standbild && !S.strom;
    $('#knopf-echt').disabled = !(S.motiv && (S.standbild || S.strom));
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) kameraStop();
    else if (aktuell === 'anprobe' && !S.standbild) kameraStart();
  });

  /* ---------------------------------------------------------- Zeichnen */
  function leinwandGroesse() {
    const breite = leinwand.getBoundingClientRect().width;
    const pixel = Math.round(breite * Math.min(window.devicePixelRatio || 1, 2));
    if (pixel && leinwand.width !== pixel) { leinwand.width = pixel; leinwand.height = Math.round(pixel * H / W); }
  }
  window.addEventListener('resize', leinwandGroesse);

  function zeichnen(g, w, h, mitRahmen) {
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#111';
    g.fillRect(0, 0, w, h);
    if (S.standbild) g.drawImage(S.standbild, 0, 0, w, h);
    else if (S.strom && video.readyState >= 2 && video.videoWidth) abdeckenAuf(g, video, video.videoWidth, video.videoHeight, w, h);
    if (!S.motiv) return;
    const m = S.motiv.bild;
    const f = w / W;
    const s = (S.groesse * W * f) / Math.max(m.width, m.height);
    g.save();
    g.translate(S.x * f, S.y * f);
    g.rotate(S.winkel);
    g.scale(s, s);
    g.globalCompositeOperation = 'multiply';
    g.drawImage(m, -m.width / 2, -m.height / 2);
    if (mitRahmen) {
      g.globalCompositeOperation = 'source-over';
      g.strokeStyle = 'rgba(255,255,255,.9)';
      g.lineWidth = 2 / s;
      g.setLineDash([10 / s, 8 / s]);
      g.strokeRect(-m.width / 2, -m.height / 2, m.width, m.height);
    }
    g.restore();
  }
  function schleife() {
    if (!schleifeLaeuft) return;
    zeichnen(ctx, leinwand.width, leinwand.height, S.rahmen);
    requestAnimationFrame(schleife);
  }
  let rahmenUhr;
  function rahmenKurz() {
    S.rahmen = true;
    clearTimeout(rahmenUhr);
    rahmenUhr = setTimeout(() => { S.rahmen = false; }, 1400);
  }

  /* ---------------------------------------------------------- Gesten und Regler */
  const zeiger = new Map();
  let geste = null;
  const punkt = e => {
    const r = leinwand.getBoundingClientRect();
    return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height };
  };
  function gesteBeginnen() {
    const p = [...zeiger.values()];
    if (p.length === 1) geste = { finger: 1, px: p[0].x, py: p[0].y, x: S.x, y: S.y };
    else if (p.length >= 2) {
      const [a, b] = p;
      geste = {
        finger: 2, abstand: Math.hypot(b.x - a.x, b.y - a.y) || 1, winkel0: Math.atan2(b.y - a.y, b.x - a.x),
        mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, x: S.x, y: S.y, groesse: S.groesse, winkel: S.winkel,
      };
    } else geste = null;
  }
  leinwand.addEventListener('pointerdown', e => {
    leinwand.setPointerCapture(e.pointerId);
    zeiger.set(e.pointerId, punkt(e));
    gesteBeginnen();
    S.rahmen = true;
    clearTimeout(rahmenUhr);
  });
  leinwand.addEventListener('pointermove', e => {
    if (!zeiger.has(e.pointerId) || !geste) return;
    zeiger.set(e.pointerId, punkt(e));
    const p = [...zeiger.values()];
    if (geste.finger === 1 && p.length === 1) {
      S.x = klemmen(geste.x + p[0].x - geste.px, 0, W);
      S.y = klemmen(geste.y + p[0].y - geste.py, 0, H);
    } else if (geste.finger === 2 && p.length >= 2) {
      const [a, b] = p;
      S.groesse = klemmen(geste.groesse * Math.hypot(b.x - a.x, b.y - a.y) / geste.abstand, 0.08, 1.6);
      S.winkel = geste.winkel + Math.atan2(b.y - a.y, b.x - a.x) - geste.winkel0;
      S.x = klemmen(geste.x + (a.x + b.x) / 2 - geste.mx, 0, W);
      S.y = klemmen(geste.y + (a.y + b.y) / 2 - geste.my, 0, H);
      reglerSetzen();
    }
  });
  ['pointerup', 'pointercancel'].forEach(art => leinwand.addEventListener(art, e => {
    zeiger.delete(e.pointerId);
    gesteBeginnen();
    if (!zeiger.size) rahmenKurz();
  }));
  leinwand.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.shiftKey || e.altKey) S.winkel += e.deltaY * 0.004;
    else S.groesse = klemmen(S.groesse * Math.exp(-e.deltaY * 0.0015), 0.08, 1.6);
    reglerSetzen();
    rahmenKurz();
  }, { passive: false });

  const reglerGroesse = $('#regler-groesse');
  const reglerDrehen = $('#regler-drehen');
  function reglerSetzen() {
    reglerGroesse.value = Math.round(S.groesse * 100);
    let grad = (S.winkel * 180 / Math.PI) % 360;
    if (grad > 180) grad -= 360;
    if (grad < -180) grad += 360;
    reglerDrehen.value = Math.round(grad);
  }
  reglerGroesse.addEventListener('input', () => { S.groesse = reglerGroesse.value / 100; rahmenKurz(); });
  reglerDrehen.addEventListener('input', () => { S.winkel = reglerDrehen.value * Math.PI / 180; rahmenKurz(); });

  /* ---------------------------------------------------------- Echt-Bild */
  $('#knopf-echt').addEventListener('click', async () => {
    if (!S.motiv) return;
    if (!S.standbild && !kameraBildAnhalten()) return;
    knoepfe();
    const c = leinwandNeu(W, H);
    zeichnen(c.getContext('2d'), W, H, false);
    S.schabloneLeinwand = c;
    S.schablone = await alsBlob(c, 'image/jpeg', 0.9);
    if (S.schabloneUrl) URL.revokeObjectURL(S.schabloneUrl);
    S.schabloneUrl = URL.createObjectURL(S.schablone);
    if (!S.kontakt) formularAuf(); else echtRechnen();
  });

  function laden(an) {
    $('#laden').hidden = !an;
    $('#knopf-echt').disabled = an || !(S.motiv && (S.standbild || S.strom));
    $('#knopf-anhalten').disabled = an;
  }

  // Vorschau ohne Server: die Schablone mit Stempel, klar als Vorschau erkennbar.
  async function vorschauErgebnis() {
    laden(true);
    const c = leinwandNeu(W, H);
    const g = c.getContext('2d');
    g.drawImage(S.schabloneLeinwand, 0, 0);
    // Stempel oben: unten liegt auf der Ergebnisseite der Umschalter Echt-Bild/Schablone.
    g.fillStyle = 'rgba(0,0,0,.78)';
    g.fillRect(0, 0, W, 96);
    g.fillStyle = '#ffffff';
    g.font = '600 30px Inter, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('VORSCHAU · hier rechnet später die KI', W / 2, 48);
    const url = URL.createObjectURL(await alsBlob(c, 'image/jpeg', 0.9));
    // Die Ladeanzeige kurz stehen lassen, damit sie in der Vorschau mitgetestet werden kann.
    await new Promise(fertig => setTimeout(fertig, 1200));
    laden(false);
    ergebnisZeigen({ token: null, bild_url: url, schablone_url: S.schabloneUrl, hinweis: T.vorschau_echtbild }, S.schabloneUrl);
  }

  async function echtRechnen() {
    if (VORSCHAU) return vorschauErgebnis();
    laden(true);
    const daten = new FormData();
    daten.append('schablone', S.schablone, 'schablone.jpg');
    if (S.motiv.stilprobe) daten.append('stilprobe', S.motiv.stilprobe);
    else if (S.motiv.datei) daten.append('motiv', S.motiv.datei, 'motiv.png');
    try {
      const antwort = await fetch('/api/echtbild', { method: 'POST', headers: kopf, body: daten });
      const j = await antwort.json().catch(() => ({}));
      if (antwort.status === 401 && j.formular) { S.kontakt = null; formularAuf(); return; }
      if (!antwort.ok || !j.ok) { melden(j.fehler || T.fehler_allgemein); return; }
      if (S.kontakt) S.kontakt.bestaetigt = Boolean(j.bestaetigt);
      ergebnisZeigen(j, S.schabloneUrl);
    } catch {
      melden(T.fehler_netz);
    } finally {
      laden(false);
    }
  }

  /* ---------------------------------------------------------- Formular */
  const blatt = $('#formular-blatt');
  const formular = $('#formular');
  const formularFehler = $('#formular-fehler');

  function formularAuf() {
    $('#formular-vorschau').src = S.schabloneUrl || '';
    formularFehler.hidden = true;
    blatt.hidden = false;
    zaehlen('formular');
  }
  function formularZu() { blatt.hidden = true; }
  blatt.addEventListener('click', e => { if (e.target === blatt || e.target.closest('[data-zu]')) formularZu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !blatt.hidden) formularZu(); });

  function feldFalsch(name, falsch = true) { formular.elements[name].closest('.feld, .haekchen').classList.toggle('falsch', falsch); }
  function formularMeldung(text) { formularFehler.textContent = text; formularFehler.hidden = !text; }

  formular.addEventListener('submit', async e => {
    e.preventDefault();
    const f = formular.elements;
    const daten = {
      vorname: f.vorname.value.trim(), name: f.name.value.trim(), email: f.email.value.trim(),
      telefon: f.telefon.value.trim(), ist_18: f.ist_18.checked, einwilligung: f.einwilligung.checked,
    };
    ['vorname', 'name', 'email', 'telefon', 'ist_18', 'einwilligung'].forEach(n => feldFalsch(n, false));
    const leer = ['vorname', 'name', 'email', 'telefon'].filter(n => !daten[n]);
    leer.forEach(n => feldFalsch(n));
    if (leer.length) return formularMeldung(T.fehler_felder);
    if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(daten.email)) { feldFalsch('email'); return formularMeldung(T.fehler_email); }
    if (!telefonOk(daten.telefon)) { feldFalsch('telefon'); return formularMeldung(T.fehler_telefon); }
    if (!daten.ist_18 || !daten.einwilligung) {
      if (!daten.ist_18) feldFalsch('ist_18');
      if (!daten.einwilligung) feldFalsch('einwilligung');
      return formularMeldung(T.fehler_checks);
    }
    if (VORSCHAU) {
      S.kontakt = { vorname: daten.vorname, bestaetigt: false };
      formularMeldung('');
      formularZu();
      echtRechnen();
      return;
    }
    const knopf = formular.querySelector('[type=submit]');
    knopf.disabled = true;
    try {
      const antwort = await fetch('/api/kontakt', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...kopf }, body: JSON.stringify(daten),
      });
      const j = await antwort.json().catch(() => ({}));
      if (!antwort.ok || !j.ok) {
        if (j.code === 'fehler_telefon') feldFalsch('telefon');
        if (j.code === 'fehler_email') feldFalsch('email');
        return formularMeldung(j.fehler || T.fehler_allgemein);
      }
      S.kontakt = { vorname: j.vorname, bestaetigt: j.bestaetigt };
      formularMeldung('');
      formularZu();
      echtRechnen();
    } catch {
      formularMeldung(T.fehler_netz);
    } finally {
      knopf.disabled = false;
    }
  });

  /* ---------------------------------------------------------- Ergebnis */
  function ansicht(welche) {
    $('#ergebnis-bild').src = welche === 'echt' ? S.bildUrl : S.schabloneAnsicht;
    $$('.umschalter button').forEach(b => b.classList.toggle('aktiv', b.dataset.ansicht === welche));
  }
  $$('.umschalter button').forEach(b => b.addEventListener('click', () => ansicht(b.dataset.ansicht)));

  function ergebnisZeigen(j, schabloneUrl) {
    S.token = j.token;
    S.bildUrl = j.bild_url;
    S.schabloneAnsicht = schabloneUrl || j.schablone_url;
    ansicht('echt');
    $('#knopf-speichern').href = j.bild_url;
    const meldung = $('#ergebnis-meldung');
    meldung.textContent = j.hinweis || '';
    meldung.hidden = !j.hinweis;
    $('#bestaetigen-hinweis').hidden = VORSCHAU || !S.kontakt || S.kontakt.bestaetigt;
    const nichtDu = $('#knopf-nicht-du');
    nichtDu.hidden = !S.kontakt;
    if (S.kontakt) nichtDu.textContent = fuellen(T.nicht_du, { vorname: S.kontakt.vorname });
    $('#knopf-neu-platzieren').hidden = !(S.standbild && S.motiv);
    zeige('ergebnis');
  }
  $('#knopf-neu-platzieren').addEventListener('click', () => zeige('anprobe'));
  $('#knopf-speichern').addEventListener('click', () => zaehlen('speichern'));
  $('#knopf-nicht-du').addEventListener('click', async () => {
    if (!VORSCHAU) await fetch('/api/sitzung-beenden', { method: 'POST', headers: kopf }).catch(() => {});
    S.kontakt = null;
    $('#knopf-nicht-du').hidden = true;
    $('#bestaetigen-hinweis').hidden = true;
    melden(T.abgemeldet_geraet);
  });

  /* ---------------------------------------------------------- Anfrage */
  const anfrage = $('#anfrage');
  anfrage.addEventListener('submit', async e => {
    e.preventDefault();
    const f = anfrage.elements;
    const fehlerFeld = $('#anfrage-fehler');
    const pflicht = ['koerperstelle', 'groesse', 'zeitraum'];
    pflicht.forEach(n => f[n].closest('.feld').classList.toggle('falsch', !f[n].value));
    if (pflicht.some(n => !f[n].value)) { fehlerFeld.textContent = T.fehler_felder; fehlerFeld.hidden = false; return; }
    fehlerFeld.hidden = true;
    if (VORSCHAU) { $('#knopf-whatsapp').href = '#'; zeige('danke'); return; }
    const knopf = anfrage.querySelector('[type=submit]');
    knopf.disabled = true;
    try {
      const antwort = await fetch('/api/anfrage', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...kopf },
        body: JSON.stringify({
          token: S.token, koerperstelle: f.koerperstelle.value, groesse: f.groesse.value,
          zeitraum: f.zeitraum.value, nachricht: f.nachricht.value.trim(),
        }),
      });
      const j = await antwort.json().catch(() => ({}));
      if (!antwort.ok || !j.ok) { fehlerFeld.textContent = j.fehler || T.fehler_allgemein; fehlerFeld.hidden = false; return; }
      $('#knopf-whatsapp').href = j.whatsapp_url;
      zeige('danke');
    } catch {
      fehlerFeld.textContent = T.fehler_netz;
      fehlerFeld.hidden = false;
    } finally {
      knopf.disabled = false;
    }
  });
  $('#knopf-whatsapp').addEventListener('click', e => {
    // In der Vorschau nie einen Chat mit der echten Studio-Nummer öffnen: Tester würden Thiago schreiben.
    if (VORSCHAU) { e.preventDefault(); melden(T.vorschau_whatsapp); return; }
    zaehlen('whatsapp');
  });

  /* ---------------------------------------------------------- Vorher/Nachher auf der Startseite */
  const vergleich = $('#vergleich');
  if (vergleich) {
    const regler = $('.vergleich-regler', vergleich);
    const chipLinks = $('.chip-links', vergleich);
    const chipRechts = $('.chip-rechts', vergleich);
    // Die Schilder zeigen nur, was gerade zu sehen ist.
    const schilder = prozent => {
      chipLinks.classList.toggle('weg', prozent < 12);
      chipRechts.classList.toggle('weg', prozent > 88);
    };
    const setzen = (prozent, mitSchildern = true) => {
      vergleich.style.setProperty('--teilung', `${klemmen(prozent, 0, 100)}%`);
      regler.value = Math.round(prozent);
      if (mitSchildern) schilder(prozent);
    };
    let zieht = false;
    let angefasst = false;
    const ausZeiger = e => {
      const r = vergleich.getBoundingClientRect();
      setzen((e.clientX - r.left) / r.width * 100);
    };
    vergleich.addEventListener('pointerdown', e => {
      zieht = true;
      angefasst = true;
      vergleich.classList.remove('faehrt');
      vergleich.setPointerCapture(e.pointerId);
      ausZeiger(e);
    });
    vergleich.addEventListener('pointermove', e => { if (zieht) ausZeiger(e); });
    ['pointerup', 'pointercancel'].forEach(art => vergleich.addEventListener(art, () => { zieht = false; }));
    regler.addEventListener('input', () => { angefasst = true; setzen(Number(regler.value)); });

    // Einmaliger Auftritt als kleine Geschichte: ganz Schablone, dann ganz Echt-Bild, dann halb-halb.
    // Wer vorher selbst zieht, übernimmt sofort.
    const pause = ms => new Promise(fertig => setTimeout(fertig, ms));
    const fahren = async (ziel, dauer) => {
      if (angefasst) return;
      vergleich.style.setProperty('--dauer', `${dauer}ms`);
      vergleich.classList.add('faehrt');
      schilder(50);
      setzen(ziel, false);
      await pause(dauer + 40);
      vergleich.classList.remove('faehrt');
      if (!angefasst) schilder(ziel);
    };
    if (reduziert) setzen(50);
    else {
      setzen(100);
      (async () => {
        await pause(900);
        await fahren(0, 1700);
        await pause(1100);
        await fahren(50, 900);
      })();
    }
  }

  /* ---------------------------------------------------------- Link aus der Mail (?bild=…) */
  const bildAusMail = new URLSearchParams(location.search).get('bild');
  if (bildAusMail && !VORSCHAU) {
    history.replaceState(null, '', location.pathname);
    fetch(`/api/bild/${encodeURIComponent(bildAusMail)}`, { headers: kopf })
      .then(r => r.json())
      .then(j => (j.ok ? ergebnisZeigen(j, j.schablone_url) : melden(j.fehler || T.fehler_bild_weg)))
      .catch(() => melden(T.fehler_netz));
  }

  zaehlen('besuch');
})();
