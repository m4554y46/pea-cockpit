let portfolio = [];
let filteredPortfolio = [];
let activeFilter = 'all';
let currentSort = { column: 'valeur', direction: -1 };
let sectorChart, divChart;

// Éléments DOM
const fileInput = document.getElementById('excelFile');
const refreshBtn = document.getElementById('refreshBtn');
const searchInput = document.getElementById('searchInput');
const tableHeader = document.getElementById('tableHeader');
const tableBody = document.getElementById('tableBody');

// Upload fichier
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('excel', file);
  showLoading('Import et enrichissement...');
  try {
    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    portfolio = data.portfolio;
    filteredPortfolio = [...portfolio];
    refreshBtn.disabled = false;
    buildAll();
    hideLoading();
    document.getElementById('apiStatus').innerText = `${portfolio.length} titres importés`;
  } catch (err) {
    hideLoading();
    alert('Erreur : ' + err.message);
  }
});

// Actualisation (re-upload ? non, on garde les données actuelles mais on pourrait re-fetch)
refreshBtn.addEventListener('click', () => {
  alert('Pour actualiser les cours, réimportez le fichier (le serveur recontacte yfinance)');
});

// Filtres
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    applyFilter();
  });
});
searchInput.addEventListener('input', applyFilter);

// Tabs
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

function computeConseil(p) {
  let ratio = p.pru ? (p.cours - p.pru) / p.pru : 0;
  let score = 0;
  if (p.var < -0.02) score--;
  if (p.var > 0.02) score++;
  if (ratio < -0.1) score -= 2;
  if (ratio > 0.2) score += 2;
  if (p.exDivDate && new Date(p.exDivDate) > new Date()) score--;
  if (p.divYield > 0.05) score--;
  if (p.beta && p.beta > 1.2) score++;
  if (score <= -2) return 'vendre';
  if (score <= 0) return 'conserver';
  if (score <= 1) return 'renforcer';
  return 'acheter';
}

function buildKPIs() {
  if (!portfolio.length) {
    document.getElementById('kpiGrid').innerHTML = '<div class="kpi-card blue">Importez un fichier Excel</div>';
    return;
  }
  const totalVal = portfolio.reduce((s,p)=>s+p.valeur,0);
  const totalCost = portfolio.reduce((s,p)=>s+p.qty*p.pru,0);
  const totalPV = totalVal - totalCost;
  const totalDiv = portfolio.reduce((s,p)=>s+(p.expectedDivAmount||0),0);
  const inProfit = portfolio.filter(p=>p.pv>0).length;
  const inLoss = portfolio.filter(p=>p.pv<0).length;
  const best = portfolio.reduce((a,b)=>b.pvpct>a.pvpct?b:a, portfolio[0]);
  const worst = portfolio.reduce((a,b)=>b.pvpct<a.pvpct?b:a, portfolio[0]);
  const wBeta = totalVal ? portfolio.reduce((s,p)=>s+(p.beta||1)*p.valeur,0)/totalVal : 0;
  const cards = [
    { label:'Actif Net', value: fmtEur(totalVal), sub: `Investi ${fmtEur(totalCost)}`, cls:'blue', trend: totalPV>=0?'up':'down', trendVal: fmtPct(totalPV/totalCost), tip:"Valeur totale du portefeuille." },
    { label:'P&L Total', value: fmtEur(totalPV), sub: fmtPct(totalCost?totalPV/totalCost:0), cls: totalPV>=0?'green':'red', tip:"Plus-value latente." },
    { label:'P&L Jour', value: fmtEur(portfolio.reduce((s,p)=>s+p.qty*p.cours*(p.var||0),0)), sub: 'estimation', cls:'amber', tip:"Variation estimée du jour." },
    { label:'Dividendes/an', value: fmtEur(totalDiv), sub: `Yield ${(totalDiv/totalVal*100).toFixed(1)}%`, cls:'amber', tip:"Dividendes bruts annuels." },
    { label:'Positions', value: `${inProfit}⬆ ${inLoss}⬇`, sub: `${portfolio.length} titres`, cls:'purple', tip:"Gagnantes / perdantes." },
    { label:'Meilleure', value: best ? fmtPct(best.pvpct) : '—', sub: best?.name, cls:'green', tip:"Meilleure performance." },
    { label:'Pire', value: worst ? fmtPct(worst.pvpct) : '—', sub: worst?.name, cls:'red', tip:"Pire performance." },
    { label:'Beta Pondéré', value: wBeta.toFixed(2), sub: 'risque marché', cls:'cyan', tip:"Sensibilité au marché." },
    { label:'Signaux', value: `${portfolio.filter(p=>computeConseil(p)==='acheter'||computeConseil(p)==='renforcer').length}🟢 / ${portfolio.filter(p=>computeConseil(p)==='vendre').length}🔴`, sub: 'achat/vente', cls:'blue', tip:"Recommandations internes." }
  ];
  document.getElementById('kpiGrid').innerHTML = cards.map(c => `<div class="kpi-card ${c.cls} tip" data-tip="${c.tip}"><div class="kpi-accent"></div>${c.trend?`<div class="kpi-trend ${c.trend}">${c.trendVal}</div>`:''}<div class="kpi-label">${c.label}</div><div class="kpi-value">${c.value}</div><div class="kpi-sub">${c.sub}</div></div>`).join('');
}

function buildTableHeader() {
  const cols = [
    { key:'name', label:'Titre' }, { key:'ticker', label:'Ticker' }, { key:'qty', label:'Qté' }, { key:'pru', label:'PRU' },
    { key:'cours', label:'Cours' }, { key:'var', label:'Var/J' }, { key:'valeur', label:'Valeur' }, { key:'pvpct', label:'P&L %' },
    { key:'pv', label:'P&L €' }, { key:'annualDiv', label:'Div/an' }, { key:'divYield', label:'Rendement' },
    { key:'expectedDivAmount', label:'Div €' }, { key:'exDivDate', label:'Détachement' }, { key:'beta', label:'Beta' },
    { key:'trailingPE', label:'P/E' }, { key:'conseil', label:'Signal' }
  ];
  tableHeader.innerHTML = `<tr>${cols.map(c => `<th data-col="${c.key}" onclick="window.sortTable('${c.key}')">${c.label}<span class="sort-icon"></span></th>`).join('')}</tr>`;
}

window.sortTable = (col) => {
  if (currentSort.column === col) currentSort.direction *= -1;
  else { currentSort.column = col; currentSort.direction = -1; }
  applyFilter();
};

function buildTable() {
  const signalMap = { acheter:'🟢 Acheter', renforcer:'🔵 Renforcer', conserver:'🟡 Conserver', alleger:'🟠 Alléger', vendre:'🔴 Vendre' };
  tableBody.innerHTML = filteredPortfolio.map(p => {
    const conseil = computeConseil(p);
    const daysToDiv = p.exDivDate ? fmtDaysTo(p.exDivDate) : null;
    return `<tr>
      <td style="max-width:200px; overflow:hidden; text-overflow:ellipsis" title="${p.name}">${p.name}${p.etf?' <span class="etf-badge">ETF</span>':''}</td>
      <td><span class="ticker-badge">${p.ticker}</span></td>
      <td>${p.qty}</td><td>${fmt(p.pru)}€</td><td><strong>${fmt(p.cours)}€</strong></td>
      <td class="${p.var>0?'var-pos':p.var<0?'var-neg':''}">${p.var?fmtPct(p.var):'—'}</td>
      <td>${fmtEur(p.valeur)}</td><td class="${p.pvpct>0?'pv-pos':p.pvpct<0?'pv-neg':''}">${fmtPct(p.pvpct)}</td>
      <td class="${p.pv>0?'pv-pos':p.pv<0?'pv-neg':''}">${p.pv>0?'+':''}${fmt(p.pv)}€</td>
      <td>${p.annualDiv?fmt(p.annualDiv)+'€':'—'}</td><td>${p.divYield?(p.divYield*100).toFixed(2)+'%':'—'}</td>
      <td>${p.expectedDivAmount?fmtEur(p.expectedDivAmount):'—'}</td>
      <td>${p.exDivDate?`<span title="${fmtDate(p.exDivDate)}">${daysToDiv}</span>`:'—'}</td>
      <td>${p.beta?p.beta.toFixed(2):'—'}</td><td>${p.trailingPE?p.trailingPE.toFixed(1):'—'}</td>
      <td><span class="conseil-badge ${conseil}">${signalMap[conseil]}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="16">Aucune donnée</td></tr>';
}

function buildHeatmap() {
  if(!portfolio.length) return;
  const sorted = [...portfolio].sort((a,b)=>b.pvpct - a.pvpct);
  const maxAbs = Math.max(...sorted.map(p=>Math.abs(p.pvpct)));
  document.getElementById('heatmapGrid').innerHTML = sorted.map(p => {
    const intensity = maxAbs ? Math.abs(p.pvpct)/maxAbs : 0;
    const bg = p.pvpct>=0 ? `rgba(16,185,129,${0.1+intensity*0.4})` : `rgba(239,68,68,${0.1+intensity*0.4})`;
    const col = p.pvpct>=0 ? 'var(--green)' : 'var(--red)';
    return `<div class="heatmap-cell" style="background:${bg}" title="${p.name} : ${fmtPct(p.pvpct)}"><div class="heatmap-name">${shortName(p.name,12)}</div><div class="heatmap-pct" style="color:${col}">${(p.pvpct*100).toFixed(1)}%</div></div>`;
  }).join('');
}

function buildAllocBars() {
  if(!portfolio.length) return;
  const total = portfolio.reduce((s,p)=>s+p.valeur,0);
  const top10 = [...portfolio].sort((a,b)=>b.valeur-a.valeur).slice(0,10);
  const colors = ['#3b82f6','#06b6d4','#10b981','#8b5cf6','#f59e0b','#ef4444','#ec4899','#6366f1','#14b8a6','#f97316'];
  document.getElementById('allocBars').innerHTML = top10.map((p,i) => {
    const pct = total ? (p.valeur/total)*100 : 0;
    return `<div class="alloc-bar-wrap"><div class="alloc-bar-label"><span title="${p.name}">${shortName(p.name,20)}</span><span>${pct.toFixed(1)}%</span></div><div class="alloc-bar-track"><div class="alloc-bar-fill" style="width:${pct}%; background:${colors[i%colors.length]}"></div></div></div>`;
  }).join('');
}

function buildSectorChart() {
  if(!portfolio.length) return;
  const map = {};
  portfolio.forEach(p => map[p.sector] = (map[p.sector]||0) + p.valeur);
  const sorted = Object.entries(map).sort((a,b)=>b[1]-a[1]);
  const total = sorted.reduce((s,e)=>s+e[1],0);
  const colors = ['#3b82f6','#06b6d4','#10b981','#8b5cf6','#f59e0b','#ef4444','#ec4899','#6366f1'];
  if(sectorChart) sectorChart.destroy();
  const ctx = document.getElementById('sectorChart').getContext('2d');
  sectorChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: sorted.map(s=>s[0]), datasets: [{ data: sorted.map(s=>s[1]), backgroundColor: colors.slice(0,sorted.length), borderColor: 'var(--bg1)', borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.label}: ${fmtEur(c.raw)} (${(c.raw/total*100).toFixed(1)}%)` } } }, cutout: '60%' }
  });
  document.getElementById('sectorLegend').innerHTML = sorted.map((s,i) => `<div style="display:flex; justify-content:space-between;"><span><span style="color:${colors[i]}">■</span> ${s[0]}</span><span>${(s[1]/total*100).toFixed(1)}%</span></div>`).join('');
}

function buildDividendTimeline() {
  const now = new Date();
  const events = portfolio.filter(p => p.exDivDate || p.annualDiv>0).map(p => {
    let date = p.exDivDate ? new Date(p.exDivDate) : null;
    if (!date && p.annualDiv>0) {
      date = new Date(now.getFullYear(), 4, 15);
      if (date < now) date.setFullYear(now.getFullYear()+1);
    }
    return { date, ticker: p.ticker, name: p.name, amount: p.expectedDivAmount };
  }).filter(e => e.date).sort((a,b)=>a.date-b.date).slice(0,20);
  if(!events.length) { document.getElementById('dividendTimeline').innerHTML = '<div class="empty-state">Aucune donnée dividende</div>'; return; }
  document.getElementById('dividendTimeline').innerHTML = events.map(e => {
    const days = Math.round((e.date-now)/86400000);
    const cls = days<0 ? 'past' : days<=30 ? 'near' : 'future';
    return `<div class="timeline-item"><div><div class="timeline-dot-inner ${cls}"></div></div><div class="timeline-content"><div class="timeline-date">${e.date.toLocaleDateString('fr-FR')} (${fmtDaysTo(e.date)})</div><div class="timeline-company">${shortName(e.name,25)}</div></div><div class="timeline-amount">${fmtEur(e.amount)}</div></div>`;
  }).join('');
  const byMonth = Array(12).fill(0);
  events.forEach(e => { if(e.amount) byMonth[e.date.getMonth()] += e.amount; });
  if(divChart) divChart.destroy();
  divChart = new Chart(document.getElementById('divChart'), {
    type: 'bar',
    data: { labels: ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'], datasets: [{ data: byMonth, backgroundColor: 'rgba(16,185,129,0.6)', borderRadius: 6 }] },
    options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtEur(c.raw) } } } }
  });
}

function buildRiskMetrics() {
  if(!portfolio.length) return;
  const total = portfolio.reduce((s,p)=>s+p.valeur,0);
  const wBeta = total ? portfolio.reduce((s,p)=>s+(p.beta||1)*p.valeur,0)/total : 0;
  const maxConc = total ? Math.max(...portfolio.map(p=>p.valeur))/total*100 : 0;
  const top5 = total ? [...portfolio].sort((a,b)=>b.valeur-a.valeur).slice(0,5).reduce((s,p)=>s+p.valeur,0)/total*100 : 0;
  const nbSectors = new Set(portfolio.map(p=>p.sector)).size;
  const etfPct = total ? portfolio.filter(p=>p.etf).reduce((s,p)=>s+p.valeur,0)/total*100 : 0;
  const divCount = portfolio.filter(p=>p.annualDiv>0).length;
  document.getElementById('riskMetrics').innerHTML = `<table class="risk-table"><tr><td class="risk-row-label">Beta Pondéré</td><td>${wBeta.toFixed(2)}</td><td>${wBeta>1.2?'⚠ élevé':wBeta<0.7?'✅ défensif':'✅ modéré'}</td></tr>
    <tr><td class="risk-row-label">Concentration max</td><td>${maxConc.toFixed(1)}%</td><td>${maxConc>20?'⚠ élevée':'✅ OK'}</td></tr>
    <tr><td class="risk-row-label">Top 5</td><td>${top5.toFixed(1)}%</td><td>${top5>60?'⚠ concentré':'✅ diversifié'}</td></tr>
    <tr><td class="risk-row-label">Secteurs</td><td>${nbSectors}</td><td>${nbSectors<4?'⚠ peu diversifié':'✅ bien'}</td></tr>
    <tr><td class="risk-row-label">ETF</td><td>${etfPct.toFixed(1)}%</td><td>—</td></tr>
    <tr><td class="risk-row-label">Titres à dividende</td><td>${divCount}/${portfolio.length}</td><td>${divCount/portfolio.length>0.5?'✅ bon rendement':'ℹ faible revenu'}</td></tr>
    <tr><td class="risk-row-label">Drawdown estimé (-35% marché)</td><td>-${(wBeta*35).toFixed(1)}%</td><td>${wBeta>1.2?'⚠ sensible':'✅ résilient'}</td></tr></table>`;
  const losers = portfolio.filter(p=>p.pvpct<-0.1);
  document.getElementById('riskPositions').innerHTML = losers.length ? losers.map(p=>`<div class="risk-card"><span class="ticker-badge">${p.ticker}</span> ${shortName(p.name,20)}<br><span style="color:var(--red)">${fmtPct(p.pvpct)}</span> (${fmtEur(p.pv)})</div>`).join('') : '<div class="risk-card">✅ Aucune perte >10%</div>';
}

function applyFilter() {
  const q = searchInput.value.toLowerCase();
  filteredPortfolio = portfolio.filter(p => {
    const match = !q || p.name.toLowerCase().includes(q) || p.ticker.toLowerCase().includes(q);
    const conseil = computeConseil(p);
    let filterOk = activeFilter==='all' || conseil===activeFilter || (activeFilter==='acheter'&&conseil==='renforcer') || (activeFilter==='vendre'&&conseil==='alleger');
    return match && filterOk;
  });
  filteredPortfolio.sort((a,b) => {
    let av = a[currentSort.column], bv = b[currentSort.column];
    if (currentSort.column==='conseil') { av=computeConseil(a); bv=computeConseil(b); }
    if (typeof av === 'string') return currentSort.direction * av.localeCompare(bv);
    return currentSort.direction * ((av||0)-(bv||0));
  });
  buildTable();
}

function buildAll() {
  buildKPIs();
  applyFilter();
  buildHeatmap();
  buildAllocBars();
  buildSectorChart();
  buildDividendTimeline();
  buildRiskMetrics();
  document.getElementById('footerTime').innerText = new Date().toLocaleTimeString();
}

// Utils
function fmt(n,d=2) { return (n===null||isNaN(n))?'—':n.toLocaleString('fr-FR',{minimumFractionDigits:d}); }
function fmtEur(n) { return fmt(n,2)+' €'; }
function fmtPct(n) { return (n>=0?'+':'')+fmt(n*100,2)+'%'; }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('fr-FR') : '—'; }
function fmtDaysTo(d) { if(!d) return null; const days=Math.round((new Date(d)-new Date())/86400000); if(days<0) return `il y a ${-days}j`; if(days===0) return "auj."; return `dans ${days}j`; }
function shortName(name,max=18) { return name.length>max ? name.substring(0,max-2)+'..' : name; }
function showLoading(msg) { const div = document.createElement('div'); div.id='loading'; div.className='loading-overlay'; div.innerHTML=`<div class="loading-box"><div class="spinner"></div><div>${msg}</div></div>`; document.body.appendChild(div); }
function hideLoading() { const el = document.getElementById('loading'); if(el) el.remove(); }

// Reco externe simple
document.getElementById('scrollRecosBtn').addEventListener('click', () => {
  const out = document.getElementById('aiOutput');
  out.innerHTML = `<div class="reco-card"><div class="card-title">📈 Opportunités externes</div>
    <div>• TotalEnergies (TTE) : pétrole élevé, rendement >6%, ex-div juin → objectif 68€</div>
    <div>• LVMH (MC) : rebond luxe Chine → objectif 850€</div>
    <div>• Air Liquide (AI) : hydrogène, résilience → conserver</div>
    <div class="card-title" style="margin-top:12px;">⚠️ Alertes marché</div>
    <div>BCE baisse taux juin → financières<br>Pétrole OPEP+ → TotalEnergies<br>Luxe: reprise timide Chine</div></div>`;
  document.getElementById('recoSection').scrollIntoView({behavior:'smooth'});
});