const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const YahooFinance = require('yahoo-finance2');
const yahooFinance = new YahooFinance();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const storage = multer.memoryStorage();
const upload = multer({ storage });

app.use(express.static('public'));
app.use(express.json());

function extractTicker(libelle) {
  if (!libelle) return null;
  const match = libelle.match(/\(([A-Z0-9]{2,6})\)/);
  if (match) return match[1];
  const words = libelle.split(/[\s,\(\)]+/);
  for (let w of words) {
    if (w.length >= 2 && w.length <= 5 && /^[A-Z]{2,5}$/.test(w)) return w;
  }
  return libelle.split(/[\s,\(\)]/)[0].toUpperCase().slice(0,5);
}

function getSuffix(ticker) {
  return '.PA';
}

function detectSector(name, ticker) {
  const low = (name + ' ' + ticker).toLowerCase();
  if (low.includes('etf') || low.includes('tracker') || low.includes('amundi')) return 'ETF';
  if (low.includes('bnp') || low.includes('credit') || low.includes('axa')) return 'Finance';
  if (low.includes('total') || low.includes('engie')) return 'Énergie';
  if (low.includes('renault') || low.includes('stellantis')) return 'Auto';
  if (low.includes('sanofi') || low.includes('essilor')) return 'Santé';
  if (low.includes('lvmh') || low.includes('kering')) return 'Luxe';
  if (low.includes('capgemini') || low.includes('atos')) return 'Tech';
  return 'Autre';
}

app.post('/upload', upload.single('excel'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) return res.status(400).json({ error: 'Fichier vide' });

    const headers = Object.keys(rows[0]).map(h => h.toLowerCase());
    const getCol = (possibles) => {
      const idx = headers.findIndex(h => possibles.some(p => h.includes(p)));
      return idx !== -1 ? Object.keys(rows[0])[idx] : null;
    };

    const colLibelle = getCol(['libellé', 'libelle', 'titre', 'nom']);
    const colCours = getCol(['cours', 'prix', 'dernier']);
    const colQty = getCol(['qté', 'qte', 'quantité', 'nombre']);
    const colPru = getCol(['pru', 'prix revient', 'prix moyen']);
    const colValo = getCol(['valorisation', 'valeur', 'montant']);

    if (!colLibelle) return res.status(400).json({ error: 'Colonne "Libellé" introuvable' });

    let portfolio = [];
    for (const row of rows) {
      const libelle = row[colLibelle]?.toString().trim();
      if (!libelle) continue;

      const ticker = extractTicker(libelle);
      if (!ticker) continue;

      let cours = colCours ? parseFloat(row[colCours]) : 0;
      let qty = colQty ? parseFloat(row[colQty]) : 0;
      let pru = colPru ? parseFloat(row[colPru]) : cours;
      let valeur = colValo ? parseFloat(row[colValo]) : qty * cours;

      if (isNaN(cours)) cours = 0;
      if (isNaN(qty)) qty = 0;
      if (isNaN(pru)) pru = cours;
      if (isNaN(valeur)) valeur = qty * cours;

      if (qty === 0 && cours === 0) continue;

      portfolio.push({
        name: libelle,
        ticker: ticker,
        qty: qty,
        pru: pru,
        cours: cours,
        valeur: valeur,
        pv: valeur - qty * pru,
        pvpct: (qty * pru) ? (valeur - qty * pru) / (qty * pru) : 0,
        sector: '?',
        etf: libelle.toLowerCase().includes('etf') || libelle.toLowerCase().includes('tracker')
      });
    }

    if (portfolio.length === 0) return res.status(400).json({ error: 'Aucune ligne valide (ticker manquant)' });

    const enriched = [];
    for (let i = 0; i < portfolio.length; i++) {
      const p = portfolio[i];
      const fullTicker = p.ticker + getSuffix(p.ticker);
      try {
        const quote = await yahooFinance.quote(fullTicker);
        const realPrice = quote.regularMarketPrice || quote.currentPrice || p.cours;
        const prevClose = quote.regularMarketPreviousClose || quote.previousClose;
        const changePercent = prevClose ? (realPrice - prevClose) / prevClose : 0;

        // Récupération des infos supplémentaires (dividendes, etc.)
let annualDiv = 0, exDivDate = null, divYield = 0, beta = null, trailingPE = null;
try {
    // Récupère les modules nécessaires
    const summary = await yahooFinance.quoteSummary(fullTicker, { modules: ['summaryDetail', 'defaultKeyStatistics'] });
    if (summary.summaryDetail) {
        annualDiv = summary.summaryDetail.trailingAnnualDividendRate || 0;
        exDivDate = summary.summaryDetail.exDividendDate ? new Date(summary.summaryDetail.exDividendDate * 1000).toISOString().slice(0,10) : null;
        divYield = summary.summaryDetail.dividendYield || (annualDiv && realPrice ? annualDiv / realPrice : 0);
        beta = summary.summaryDetail.beta;
        trailingPE = summary.summaryDetail.trailingPE;
    }
} catch(e) { /* ignore */ }

        enriched.push({
          ...p,
          cours: realPrice,
          var: changePercent,
          valeur: p.qty * realPrice,
          pv: p.qty * realPrice - p.qty * p.pru,
          pvpct: p.qty * p.pru ? (p.qty * realPrice - p.qty * p.pru) / (p.qty * p.pru) : 0,
          annualDiv: annualDiv,
          divYield: divYield,
          exDivDate: exDivDate,
          expectedDivAmount: p.qty * annualDiv,
          beta: beta,
          trailingPE: trailingPE,
          sector: detectSector(p.name, p.ticker)
        });
      } catch (err) {
        console.error(`Erreur pour ${p.ticker}:`, err.message);
        enriched.push(p);
      }
      await new Promise(r => setTimeout(r, 150));
    }

    res.json({ success: true, portfolio: enriched });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur prêt sur http://localhost:${PORT}`);
});
