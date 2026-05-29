const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fetch = require('node-fetch'); // à installer si nécessaire

const app = express();
const PORT = process.env.PORT || 3000;

// Ta clé API Alpha Vantage (à mettre dans Render "Environment Variables")
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || 'demo'; // 'demo' pour test

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

// Récupère les cours via Yahoo Finance (simple, fiable)
async function fetchPrice(ticker) {
  const fullTicker = ticker + getSuffix(ticker);
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${fullTicker}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const quote = data?.quoteResponse?.result?.[0];
    if (quote && quote.regularMarketPrice) {
      return {
        price: quote.regularMarketPrice,
        changePercent: (quote.regularMarketPrice - (quote.regularMarketPreviousClose || quote.previousClose)) / (quote.regularMarketPreviousClose || quote.previousClose),
        beta: quote.beta,
        trailingPE: quote.trailingPE
      };
    }
  } catch(e) {}
  return null;
}

// Récupère les dividendes via Alpha Vantage (fiable)
async function fetchDividendAlphaVantage(ticker) {
  const fullTicker = ticker + getSuffix(ticker);
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${fullTicker}&apikey=${ALPHA_VANTAGE_KEY}`;
  try {
    // D'abord, on récupère le dividende annuel via l'overview
    const overviewUrl = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${fullTicker}&apikey=${ALPHA_VANTAGE_KEY}`;
    const overviewRes = await fetch(overviewUrl);
    const overview = await overviewRes.json();
    let annualDiv = parseFloat(overview.DividendPerShare) || 0;
    let exDivDate = overview.DividendDate || null;

    // Si pas trouvé, on tente l'endpoint "DIVIDENDS" (historique)
    if (annualDiv === 0) {
      const divUrl = `https://www.alphavantage.co/query?function=DIVIDENDS&symbol=${fullTicker}&apikey=${ALPHA_VANTAGE_KEY}`;
      const divRes = await fetch(divUrl);
      const divData = await divRes.json();
      if (divData.data && divData.data.length > 0) {
        // Le plus récent dividende
        const lastDiv = divData.data[0];
        annualDiv = parseFloat(lastDiv.amount) || 0;
        exDivDate = lastDiv.ex_dividend_date || null;
      }
    }
    return { annualDiv, exDivDate };
  } catch(e) {
    console.error(`Alpha Vantage error for ${ticker}:`, e.message);
    return { annualDiv: 0, exDivDate: null };
  }
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
      
      // 1. Récupération du cours
      const priceData = await fetchPrice(p.ticker);
      let realPrice = p.cours;
      let changePercent = 0;
      if (priceData) {
        realPrice = priceData.price;
        changePercent = priceData.changePercent;
      }
      
      // 2. Récupération du dividende (Alpha Vantage)
      const divData = await fetchDividendAlphaVantage(p.ticker);
      const annualDiv = divData.annualDiv || 0;
      const exDivDate = divData.exDivDate || null;
      const divYield = realPrice ? annualDiv / realPrice : 0;
      
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
        beta: priceData?.beta || null,
        trailingPE: priceData?.trailingPE || null,
        sector: detectSector(p.name, p.ticker)
      });
      
      // Respecter le rate limit d'Alpha Vantage (5 appels/minute)
      await new Promise(r => setTimeout(r, 12000)); // 12 secondes = 5 par minute
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
