// ════════════════════════════════════════════════════════════════════
// MOTOR DE «DISFRUTA LA VIDA» · v169
// ════════════════════════════════════════════════════════════════════
// Este archivo es el mismo para las dos apps. La app de siempre (index.html)
// lo carga tal cual y pinta con él; la versión nueva (nueva.html) lo lee como
// texto y lo ejecuta encerrado, sin pantalla, para importar y calcular con
// exactamente las mismas funciones. Antes había una copia dentro de cada
// HTML y cada arreglo había que hacerlo dos veces.
//
// Si se sube una app sin su motor (o al revés), las dos lo detectan por
// MOTOR_VERSION y no arrancan a medias.
const MOTOR_VERSION='v169';
// ═══════════════════════════════════════════════════════════════════════
// DATA MODEL
// ═══════════════════════════════════════════════════════════════════════
const MN=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const fmt=v=>Math.round(v).toLocaleString('es-ES');
const fmt2=v=>(Number(v)||0).toLocaleString('es-ES',{minimumFractionDigits:2,maximumFractionDigits:2});
    const fmtR=v=>(Number(v)||0).toLocaleString('es-ES',{maximumFractionDigits:6});
const fmtK=v=>v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?Math.round(v/1e3)+'k':Math.round(v)+'';
const fmtE=v=>(v>=0?'+':'')+Math.round(v).toLocaleString('es-ES')+'€';
const n=id=>parseFloat(document.getElementById(id)?.value)||0;
const s=id=>document.getElementById(id)?.value||'';

// v169 · Lo que antes se tragaba un catch vacío queda apuntado aquí (los 50
// últimos) para verlo en Diagnóstico y en la Revisión de la versión nueva. No
// cambia lo que hace la app: solo deja rastro de lo que no salió bien.
const FALLOS=[];
function fallo(donde,e){
  try{
    FALLOS.push({donde:String(donde||''),m:String((e&&e.message)||e||'').slice(0,160),cuando:new Date().toISOString()});
    if(FALLOS.length>50)FALLOS.shift();
    if(typeof console!=='undefined'&&console.debug)console.debug('fallo',donde,e);
  }catch(_){fallo('FALLOS.push',_)}
}

// Default config
const DEF_GASTOS_FIJOS=[
  {id:'gf_luz',   name:'💡 Luz'},
  {id:'gf_agua',  name:'💧 Agua'},
  {id:'gf_movil', name:'📱 Móvil'},
  {id:'gf_inet',  name:'🌐 Internet'},
  {id:'gf_suscr', name:'📺 Suscripciones'},
  {id:'gf_rsu',   name:'🏛️ Impuesto RSU'},
];

// v169 · Una app recién instalada empieza vacía: tus cuentas, fondos y
// acciones están en tus datos, no en el código (que es público).
const DEF_ACCOUNTS=[
  {id:'cuenta',name:'Cuenta corriente'},
  {id:'efect',name:'Efectivo en casa'},
];
const DEF_FUNDS=[];
const DEF_STOCKS=[];

// SEED monthly records [label,year,month,pat,ing,gas,aho,ap,aamt,cash,fondos,acc]
const SEED=[];

function parseSeed(r){
  return{id:r[0].toLowerCase(),label:r[0],year:r[1],month:r[2],
    pat:r[3],ing:r[4],gas:r[5],aho:r[6],ap:!!r[7],aamt:r[8],
    cash:r[9],fondos:r[10],acc:r[11],deuda:0,
    nomina:r[4],ipt:0,otros_ing:0,
    accounts_data:null,funds_data:null,stocks_data:null,debts_data:null,new_aports:0,
    nomina_data:null};
}

// ═══════════════════════════════════════════════════════════════════════
// TAX CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════
// Spain IRPF on capital savings (capital gains from funds/stocks) 2024 brackets
// ─── STOCK AGGREGATION ───────────────────────────────────────────────
// Group all buy/sell transactions per stock company
// ─── FIFO COST BASIS ─────────────────────────────────────────────────
// Recompute costBasis + gainLoss for every SELL using FIFO (Spanish legal
// method for identical shares): oldest lots are consumed first. Buy cost
// includes purchase commissions; sell proceeds (total) are already net of
// sell commissions.
// Remove orphan stocks from config: no transactions AND no registered value.
// (Leftovers from old versions or sells that created a phantom stock.)
function cleanupOrphanStocks(){
  const txStockIds=new Set(transactions.filter(t=>t.type==='buy'||t.type==='sell').map(t=>t.stockId));
  const valStockIds=new Set((typeof balanceLog!=='undefined'?balanceLog:[]).filter(b=>b.refType==='stock').map(b=>b.refId));
  const before=(cfg.stocks||[]).length;
  cfg.stocks=(cfg.stocks||[]).filter(s=>txStockIds.has(s.id)||valStockIds.has(s.id));
  return before-(cfg.stocks||[]).length;
}

function recomputeAllStockGains(){
  const byStock={};
  transactions.forEach(t=>{
    if(t.type==='buy'||t.type==='sell'){
      (byStock[t.stockId]=byStock[t.stockId]||[]).push(t);
    }
  });
  Object.values(byStock).forEach(txs=>{
    txs.sort((a,b)=>{
      const d=(a.date||'').localeCompare(b.date||'');
      if(d!==0)return d;
      if(a.type!==b.type)return a.type==='buy'?-1:1; // same date: buys first
      return 0;
    });
    // v169 · Regla de los dos meses (art. 33.5.f LIRPF): una pérdida no cuenta
    // si has comprado acciones iguales en los dos meses anteriores o
    // posteriores a la venta y siguen en tu poder. Esa parte de la pérdida se
    // aplaza y cuenta cuando vendas esas acciones. Antes solo se avisaba.
    // gainLoss sigue siendo lo que de verdad ganaste o perdiste; lo que cuenta
    // para Hacienda es gainLoss + perdidaAplazada + perdidaIntegrada.
    const lots=[]; // FIFO: {shares, perShare, date, aplz (pérdida aplazada por título)}
    const pend=new Map();   // compras posteriores que cargan con una pérdida aplazada
    txs.forEach((t,idx)=>{
      if(t.type==='buy'){
        const sh=t.shares||0;
        const perShare=sh>0?((t.total||0)+(t.costs||0))/sh:0;
        lots.push({shares:sh,perShare,date:String(t.date||''),aplz:sh>0?(pend.get(t)||0)/sh:0});
      } else {
        let toSell=t.shares||0;
        let cost=0, integ=0;
        while(toSell>1e-9&&lots.length){
          const lot=lots[0];
          const take=Math.min(toSell,lot.shares);
          cost+=take*lot.perShare; integ+=take*(lot.aplz||0);
          lot.shares-=take;toSell-=take;
          if(lot.shares<=1e-9)lots.shift();
        }
        t.costBasis=Math.round(cost*100)/100;
        // v146 · Fiscalmente el valor de transmisión va NETO de los gastos
        // inherentes a la venta. Antes la comisión no se restaba y la plusvalía
        // —y con ella la previsión de IRPF— salía inflada.
        const proceeds=(t.total||0)-(t.costs||0);
        t.gainLoss=Math.round((proceeds-cost)*100)/100;
        delete t.perdidaAplazada; delete t.perdidaIntegrada;
        if(integ>0.004)t.perdidaIntegrada=-Math.round(integ*100)/100;
        if(t.gainLoss<0&&t.date&&(t.shares||0)>0){
          const desde=isoMasMeses(t.date,-2), hasta=isoMasMeses(t.date,2);
          const rest=lots.filter(l=>l.shares>1e-9&&l.date>=desde&&l.date<=t.date);
          const fut=txs.slice(idx+1).filter(u=>u.type==='buy'&&u.date>t.date&&u.date<=hasta&&(u.shares||0)>0);
          const disp=rest.reduce((a,l)=>a+l.shares,0)+fut.reduce((a,u)=>a+u.shares,0);
          const afect=Math.min(t.shares,disp);
          if(afect>1e-9){
            const aplz=-t.gainLoss*afect/t.shares;
            t.perdidaAplazada=Math.round(aplz*100)/100;
            const porTit=aplz/afect; let quedan=afect;
            rest.forEach(l=>{ if(quedan<=1e-9)return; const k=Math.min(quedan,l.shares); l.aplz=(l.aplz||0)+porTit*k/l.shares; quedan-=k; });
            fut.forEach(u=>{ if(quedan<=1e-9)return; const k=Math.min(quedan,u.shares); pend.set(u,(pend.get(u)||0)+porTit*k); quedan-=k; });
          }
        }
        if(!t.year&&t.date)t.year=parseInt(t.date.slice(0,4));
      }
    });
  });
}

// ════════════════════════════════════════════════════════════════════
// v125 · UN SOLO SITIO DONDE SE DECIDE CUÁL ES EL ÚLTIMO SALDO
// ════════════════════════════════════════════════════════════════════
// Había SIETE funciones distintas resolviendo "¿cuál es el saldo más
// reciente de esto?", cada una con su propio orden. Cinco ordenaban por
// fecha descendente y cogían el primero. El problema aparece cuando hay dos
// apuntes DEL MISMO DÍA: como Array.sort es estable, esas cinco devolvían el
// que se metió ANTES, y getBalanceEntries —la buena— devuelve el que se metió
// DESPUÉS, que es la corrección.
//
// El caso real: el importador viejo de Bankinter dejó X € el 27/08, se
// corrigió a mano a X € el mismo día, y a partir de ahí el desglose de
// liquidez enseñaba X € mientras el cuadre enseñaba Y €. Dos
// mil euros de diferencia según la pantalla que mirases.
//
// Ahora todo pasa por aquí. Si algún día hay que cambiar el criterio de
// desempate, se cambia en un sitio y cambia en toda la app.
function balUltimo(refType,refId){
  if(typeof getBalanceEntries!=='function')return null;
  const e=getBalanceEntries(refType,refId);
  return e.length?e[0]:null;
}

// v146 · Las plusvalías realizadas se calculan por FIFO (que es lo que exige
// Hacienda) pero el P/L latente se calculaba prorrateando el coste medio. Con
// una sola compra da igual; en cuanto promedias a la baja y vendes una parte,
// las dos cifras dejan de cuadrar entre sí. El coste de lo que TE QUEDA también
// sale ahora de la cola FIFO: los lotes que no se han vendido.
function fifoRestante(stockId){
  const txs=transactions.filter(t=>t.stockId===stockId&&(t.type==='buy'||t.type==='sell'))
    .slice().sort((a,b)=>{
      const d=(a.date||'').localeCompare(b.date||'');
      if(d!==0)return d;
      if(a.type!==b.type)return a.type==='buy'?-1:1;
      return 0;
    });
  const lots=[];
  txs.forEach(t=>{
    if(t.type==='buy'){
      const sh=t.shares||0;
      lots.push({shares:sh,perShare:sh>0?((t.total||0)+(t.costs||0))/sh:0});
    } else {
      let q=t.shares||0;
      while(q>1e-9&&lots.length){
        const l=lots[0], take=Math.min(q,l.shares);
        l.shares-=take; q-=take;
        if(l.shares<=1e-9)lots.shift();
      }
    }
  });
  const shares=lots.reduce((s,l)=>s+l.shares,0);
  const cost=lots.reduce((s,l)=>s+l.shares*l.perShare,0);
  return {shares,cost};
}
// Dividendos: un ingreso marcado como dividendo pertenece a una acción si tú
// se lo has asignado (stockId) o si el concepto del banco nombra a la empresa.
function dividendosDe(stockId){
  const s=(cfg.stocks||[]).find(x=>x.id===stockId);
  if(!s)return [];
  const cn=_pfNorm(s.name);
  return (typeof incomeLog!=='undefined'?incomeLog:[]).filter(x=>{
    if(x.cat!=='dividendo')return false;
    if(x.stockId)return x.stockId===stockId;
    if(!cn||cn.length<4)return false;
    const d=_pfNorm(x.desc||'');
    return d.includes(cn)||(cn.split(' ')[0].length>=5&&d.includes(cn.split(' ')[0]));
  });
}
function dividendosSinAsignar(){
  return (typeof incomeLog!=='undefined'?incomeLog:[]).filter(x=>x.cat==='dividendo'&&
    !(cfg.stocks||[]).some(s=>dividendosDe(s.id).some(d=>d.id===x.id)));
}
function asignarDividendo(incId){
  const x=incomeLog.find(e=>e.id===incId); if(!x)return;
  const L=(cfg.stocks||[]).filter(s=>!soldStocks.has(s.id)||true);
  if(!L.length){toast('No tienes acciones registradas');return;}
  const r=prompt('¿De qué acción es este dividendo?\n\n'+fmtDate(x.date)+' · '+(x.desc||'')+' · '+fmt2(x.amt)+'€\n\n'+
    L.map((s,i)=>'  '+(i+1)+') '+s.name).join('\n')+'\n\nEscribe el número (en blanco = dejarlo sin asignar).','');
  if(r==null||!String(r).trim())return;
  const i=parseInt(String(r).trim(),10);
  if(!(i>=1&&i<=L.length)){toast('Ese número no existe');return;}
  x.stockId=L[i-1].id;
  save(); renderRentabilidad(); try{renderAnalisis();}catch(e){fallo('renderAnalisis',e)}
  toast('Dividendo asignado a '+L[i-1].name);
}
function getStockAggregates(){
  const agg={};
  cfg.stocks.forEach(s=>{
    const buys=transactions.filter(t=>t.stockId===s.id&&t.type==='buy');
    const sells=transactions.filter(t=>t.stockId===s.id&&t.type==='sell');
    const totalBoughtShares=buys.reduce((sum,t)=>sum+(t.shares||0),0);
    const totalBoughtValue=buys.reduce((sum,t)=>sum+(t.total||0)+(t.costs||0),0);
    const totalSoldShares=sells.reduce((sum,t)=>sum+(t.shares||0),0);
    const remainingShares=totalBoughtShares-totalSoldShares;
    const avgPrice=totalBoughtShares>0?totalBoughtValue/totalBoughtShares:0;
    // Get current value: prefer date-stamped balance log, then records, then buy mktval
    let currentVal=0;
    const balEntry=(typeof balanceLog!=='undefined')?balUltimo('stock',s.id):null;
    if(balEntry){
      // v162 · el valor de una acción es la suma de lo que vale en CADA bróker
      // (stockValor), no el último apunte suelto: con una misma acción en DEGIRO y en XTB
      // esto cogía solo la parte de XTB y el análisis por compra, la ventana de
      // pérdidas y la concentración la daban por un 60 % menos de lo que vale.
      const tv=(typeof stockValor==='function')?stockValor(s.id):null;
      currentVal=(tv!=null?tv:balEntry.amount)||0;}
    else{
      for(let i=records.length-1;i>=0;i--){
        if(records[i].stocks_data&&records[i].stocks_data[s.id]!=null){
          currentVal=records[i].stocks_data[s.id]||0;break;
        }
      }
    }
    const rest=fifoRestante(s.id);                       // v146 · coste de los lotes vivos
    const avgPriceRest=rest.shares>1e-9?rest.cost/rest.shares:avgPrice;
    agg[s.id]={
      id:s.id,name:s.name,existing:s.existing,
      buys,sells,
      totalShares:remainingShares,
      totalBoughtShares,totalBoughtValue,avgPrice,
      costeRestante:rest.cost, avgPriceRest,
      currentVal,
      unrealizedPL:currentVal>0&&rest.cost>0?currentVal-rest.cost:null,
      isClosed:soldStocks.has(s.id)||totalBoughtShares>0&&remainingShares<=0,
    };
  });
  return agg;
}


// Value + date + source for each item, preferring the date-stamped balance log
function getFundVLInfo(fundId){
  // balanceLog needs to be defined; guard for hoisting order
  if(typeof balanceLog!=='undefined'){
    const e=balUltimo('fund',fundId);
    if(e) return {amount:e.amount,date:e.date,source:'log'};
  }
  for(let i=records.length-1;i>=0;i--){
    const fd=records[i].funds_data?.[fundId];
    if(fd&&fd.vl>0)return {amount:fd.vl,date:records[i].label,source:'record'};
  }
  return {amount:0,date:null,source:'none'};
}
function getAccountInfo(accId){
  if(typeof balanceLog!=='undefined'){
    const e=balUltimo('acc',accId);
    if(e) return {amount:e.amount,date:e.date,source:'log'};
  }
  for(let i=records.length-1;i>=0;i--){
    const v=records[i].accounts_data?.[accId];
    if(v!=null)return {amount:v,date:records[i].label,source:'record'};
  }
  return {amount:0,date:null,source:'none'};
}
// ─── BROKER LIQUIDITY (cash sitting in the broker, counts as CASH) ──
function getBrokerInfo(brokerId){
  if(typeof balanceLog!=='undefined'){
    const e=balUltimo('broker',brokerId);
    if(e) return {amount:e.amount,date:e.date,source:'log'};
  }
  return {amount:0,date:null,source:'none'};
}
function getBrokerLiquidityNow(){
  return (cfg.brokers||[]).reduce((s,b)=>s+(getBrokerInfo(b.id).amount||0),0);
}
function getBrokerLiquidityAsOf(year,month){
  return (cfg.brokers||[]).reduce((s,b)=>{
    const v=getBalanceAsOf('broker',b.id,year,month);
    return s+(v!==null?v:0);
  },0);
}

function getStockInfo(stockId){
  // Prefer date-stamped balance log
  if(typeof balanceLog!=='undefined'){
    const p=stockPartes(stockId);
    if(p.total!=null) return {amount:p.total,date:p.date,source:'log',partes:p.partes};
  }
  // Latest record with a value for this stock
  for(let i=records.length-1;i>=0;i--){
    const v=records[i].stocks_data?.[stockId];
    if(v!=null&&v>0)return {amount:v,date:records[i].label,source:'record'};
  }
  // Or the mktval from the most recent buy transaction
  const buys=transactions.filter(t=>t.stockId===stockId&&t.type==='buy'&&t.mktval>0)
    .sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  if(buys.length)return {amount:buys[0].mktval,date:buys[0].date,source:'compra'};
  return {amount:0,date:null,source:'none'};
}

// Format a date string (YYYY-MM-DD) to DD/MM/YY, or pass through labels
function fmtDate(d){
  if(!d)return '—';
  if(/^\d{4}-\d{2}-\d{2}/.test(d)){
    const[y,m,day]=d.slice(0,10).split('-');
    return day+'/'+m+'/'+y.slice(2);
  }
  return d;
}
function fmtDateFull(d){
  if(!d)return '—';
  if(/^\d{4}-\d{2}-\d{2}/.test(d)){
    const[y,m,day]=d.slice(0,10).split('-');
    return day+'/'+m+'/'+y;
  }
  return d;
}
function fmtMonth(m){
  if(!m)return '—';
  const mm=/^(\d{4})-(\d{2})/.exec(m);
  if(mm)return mm[2]+'/'+mm[1];
  return m;
}

function calcIRPFGain(gain){
  if(gain<=0)return 0;
  // Brackets: [max_of_tramo, rate]
  const brackets=[[6000,.19],[44000,.21],[150000,.23],[100000,.27],[Infinity,.30]];
  let tax=0,remaining=gain;
  for(const[size,rate] of brackets){
    const taxable=Math.min(remaining,size);
    tax+=taxable*rate;remaining-=taxable;
    if(remaining<=0)break;
  }
  return tax;
}

// Effective IRPF rate on a gain
function effectiveIRPFRate(gain){
  if(gain<=0)return 0;
  return calcIRPFGain(gain)/gain;
}

// Total invested in a fund (initial config + all monthly aportaciones)
function getFundInvested(fundId){
  const fc=cfg.funds.find(f=>f.id===fundId);
  const initial=fc?.invested||0;
  // Aportaciones registered as transactions (the new, immediately-saved way)
  const txAports=transactions.filter(t=>t.type==='fund_aport'&&t.fundId===fundId)
    .reduce((s,t)=>s+(t.amount||0),0);
  return initial+txAports;
}

// Get tax data for current year
function getTaxData(){
  const lr=last();
  const cy=lr.year;
  const yearRecs=records.filter(r=>r.year===cy);

  const nd=lr.nomina_data||{};
  // Monthly capital income retention from account rendimientos
  const monthRendRet=(lr.rendimientos||[]).reduce((s,r)=>s+(r.retencion||0),0);
  const monthly={
    irpf: nd.irpf_importe||0,
    muface: nd.muface||0,
    c_pasivas: nd.c_pasivas||0,
    prorr: nd.prorr||0,
    rend_ret: monthRendRet,
    total:0
  };
  monthly.total=monthly.irpf+monthly.muface+monthly.c_pasivas+monthly.prorr+monthly.rend_ret;

  const cumul=yearRecs.reduce((acc,r)=>{
    const d=r.nomina_data||{};
    const rendRet=(r.rendimientos||[]).reduce((s,rn)=>s+(rn.retencion||0),0);
    return{
      irpf: acc.irpf+(d.irpf_importe||0),
      muface: acc.muface+(d.muface||0),
      c_pasivas: acc.c_pasivas+(d.c_pasivas||0),
      prorr: acc.prorr+(d.prorr||0),
      rend_ret: acc.rend_ret+rendRet,
      rend_bruto: acc.rend_bruto+(r.rendimientos||[]).reduce((s,rn)=>s+(rn.bruto||0),0),
    };
  },{irpf:0,muface:0,c_pasivas:0,prorr:0,rend_ret:0,rend_bruto:0});
  cumul.total=cumul.irpf+cumul.muface+cumul.c_pasivas+cumul.prorr+cumul.rend_ret;

  // Stock gains from sells this year
  // All sell transactions, with year fallback from date or tx.year field
  const allSells=transactions.filter(t=>t.type==='sell');
  allSells.forEach(t=>{if(!t.year&&t.date)t.year=parseInt(t.date.slice(0,4));});
  const yearSells=allSells.filter(t=>(t.year||0)===cy||(String(t.date||'').startsWith(String(cy))));
  const totalGain=yearSells.reduce((s,t)=>s+(t.gainLoss??0),0);
  const stockIRPF=calcIRPFGain(Math.max(0,totalGain));
  const negLosses=yearSells.filter(t=>(t.gainLoss??0)<0).reduce((s,t)=>s+(t.gainLoss??0),0);
  // All sells grouped by year (for historical view)
  const sellsByYear={};
  allSells.forEach(t=>{
    const y=t.year||(t.date?parseInt(t.date.slice(0,4)):cy);
    if(!sellsByYear[y])sellsByYear[y]=[];
    sellsByYear[y].push(t);
  });

  return{monthly,cumul,totalGain,stockIRPF,negLosses,yearSells,sellsByYear,cy,months:yearRecs.length};
}


// ═══════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════
let cfg={accounts:[...DEF_ACCOUNTS],funds:[...DEF_FUNDS],stocks:[...DEF_STOCKS],debts:[],brokers:[],
  gastos_fijos:[...DEF_GASTOS_FIJOS]};
let records=[];
let transactions=[];
let soldStocks=new Set(); // ids of fully sold stock positions
let balanceLog=[]; // [{id, refType:'acc'|'fund', refId, date, amount}] — date-stamped balance history
let expandedKPI=null;
let chartPat=null,chartIG=null,chartPie=null;
let dashViewIdx=-1; // -1 = latest record, -2 = live record, -999 = no data
let _liveRecord=null;

function getDashRecord(){
  if(dashViewIdx===-2&&_liveRecord) return _liveRecord;
  // v131 · Sin ningún mes guardado el dashboard devolvía un registro vacío, y
  // el patrimonio se quedaba en 0 € por mucho saldo que hubieras apuntado.
  if(!records.length){
    const n=new Date();
    const viva=buildLiveRecord(n.getFullYear(),n.getMonth()+1);
    if(viva&&viva.hasData){ _liveRecord=viva; return viva; }
  }
  if(dashViewIdx===-999) return last(); // sin datos: se devuelve el último para no romper las gráficas
  if(dashViewIdx<0||dashViewIdx>=records.length) return last();
  return records[dashViewIdx];
}

// Build a "live" record from the most recent balance-log entries, fund aportaciones,
// and stock values — used to show current patrimony without a formally saved month.
function buildLiveRecord(year,month){
  const accounts_data={};
  cfg.accounts.forEach(a=>{
    const bal=getBalanceAsOf('acc',a.id,year,month);
    if(bal!==null) accounts_data[a.id]=bal;
    else {
      const prevR=[...records].reverse().find(r=>r.accounts_data&&r.accounts_data[a.id]!=null);
      if(prevR) accounts_data[a.id]=prevR.accounts_data[a.id];
    }
  });
  const funds_data={};
  cfg.funds.forEach(f=>{
    let vl=getBalanceAsOf('fund',f.id,year,month);
    if(vl===null){
      const prevR=[...records].reverse().find(r=>r.funds_data&&r.funds_data[f.id]&&r.funds_data[f.id].vl>0);
      vl=prevR?prevR.funds_data[f.id].vl:0;
    }
    const monthPrefix=year+'-'+String(month).padStart(2,'0');
    const aport=transactions.filter(t=>t.type==='fund_aport'&&t.fundId===f.id&&String(t.date||'').startsWith(monthPrefix))
      .reduce((s,t)=>s+(t.amount||0),0);
    funds_data[f.id]={vl:vl||0,aport};
  });
  // v147 · Los cierres guardados restan la deuda del patrimonio; el patrimonio
  // de HOY no la restaba en ninguna parte, así que el día que registres una
  // hipoteca el panel te enseñaría el patrimonio bruto y los históricos el
  // neto, y el salto entre ambos parecería una revalorización.
  const debts_data={};
  (cfg.debts||[]).forEach(d=>{
    let v=(typeof getBalanceAsOf==='function')?getBalanceAsOf('debt',d.id,year,month):null;
    if(v===null){
      const prevR=[...records].reverse().find(r=>r.debts_data&&r.debts_data[d.id]!=null);
      v=prevR?prevR.debts_data[d.id]:0;
    }
    if(v)debts_data[d.id]=v;
  });
  const _deudaViva=Object.values(debts_data).reduce((s,v)=>s+(Number(v)||0),0);
  const stocks_data={};
  const agg=getStockAggregates();
  Object.values(agg).forEach(a=>{
    if(a.isClosed) return;
    // Prefer a stock value registered on or before this month
    const asOf=getBalanceAsOf('stock',a.id,year,month);
    const v=asOf!==null?asOf:(a.currentVal||0);
    if(v>0) stocks_data[a.id]=v;
  });

  const cash=Object.values(accounts_data).reduce((s,v)=>s+(v||0),0);
  const fondos=Object.values(funds_data).reduce((s,f)=>s+(f.vl||0),0);
  const brokerLiq=getBrokerLiquidityAsOf(year,month);
  const acc=Object.values(stocks_data).reduce((s,v)=>s+(v||0),0)+brokerLiq;
  const monthPrefix=year+'-'+String(month).padStart(2,'0');
  const label=MN[month-1]+'-'+String(year).slice(2);

  // Income for the month from incomeLog
  const _ciL=compIncomeIds(),_ceL=compExpenseIds();
  const monthIncome=incomeLog.filter(e=>String(e.date||'').startsWith(monthPrefix)&&!_ciL.has(e.id));
  const ing_transactions=monthIncome.map(e=>({fecha:e.date,desc:e.desc,cat:e.cat,amt:e.amt,nd:e.nd}));
  const _MC=mesCifras(monthPrefix);
  const ing=_MC.ing;
  const nomina=monthIncome.filter(e=>e.cat==='nomina').reduce((s,e)=>s+e.amt,0);
  const ipt=monthIncome.filter(e=>e.cat==='ipt').reduce((s,e)=>s+e.amt,0);
  // Nomina breakdown: use the last nomina entry's nd this month, if any
  const lastNom=monthIncome.filter(e=>e.cat==='nomina'&&e.nd).slice(-1)[0];
  const nomina_data=lastNom?lastNom.nd:{};

  // Expenses for the month from expenseLog
  const monthExp=expenseLog.filter(e=>String(e.date||'').startsWith(monthPrefix)&&!_ceL.has(e.id));
  const fijos={};
  monthExp.filter(e=>e.kind==='fijo').forEach(e=>{fijos[e.fijoId]=e.amt;});
  const estructurales=monthExp.filter(e=>e.kind==='estructural')
    .map(e=>({id:e.id,name:e.name,amt:e.amt,cat:e.cat,date:e.date}));
  const ocio=monthExp.filter(e=>e.kind==='ocio')
    .map(e=>({id:e.id,name:e.name,amt:e.amt,cat:e.cat}));
  const gastos_data={fijos,estructurales,ocio};
  // v126 · el gasto del mes sale de mesCifras, no de sumar solo lo que tiene
  // "kind": así ni se pierde nada por el camino ni se cuenta lo que te deben.
  const gas=_MC.gas;

  // Aportaciones this month (for ahorro)
  const monthAports=transactions.filter(t=>t.type==='fund_aport'&&String(t.date||'').startsWith(monthPrefix))
    .reduce((s,t)=>s+(t.amount||0),0);
  // Ahorro = ingresos − gastos (if both present), else Δcash + aportaciones
  const aho=_MC.aho;

  // Has any meaningful data?
  const hasData=Object.keys(accounts_data).length>0||Object.keys(funds_data).some(k=>funds_data[k].vl>0)
    ||acc>0||ing>0||gas>0;
  return{
    id:label.toLowerCase(),label,year,month,
    accounts_data,funds_data,stocks_data,
    cash,fondos,acc,broker_liq:brokerLiq,debts_data,deuda:_deudaViva,
    pat:cash+fondos+acc-_deudaViva,
    ing,gas,aho,nomina,ipt,nomina_data,gastos_data,ing_transactions,
    ap:monthAports>0,aamt:monthAports,new_aports:monthAports,
    isLive:true,hasData,
  };
}

// ════════════════════════════════════════════
// v110 · EL DASHBOARD SE QUEDABA CONGELADO
// ════════════════════════════════════════════
// _liveRecord (la foto del mes en curso: saldos, fondos, acciones) se construía
// UNA sola vez, al cargar la página, y ya no se volvía a tocar. Actualizabas un
// saldo — a mano o importando el extracto —, se guardaba correctamente, y el
// dashboard seguía enseñando la foto del arranque hasta que recargabas.
// Ese es el motivo de que bajaras el extracto y la liquidez no se moviera, y la
// causa más probable de que tu suma a mano y la cifra de arriba no cuadraran:
// no estabas comparando dos cálculos, estabas comparando dos momentos.
function refreshLiveRecord(){
  if(!records.length){
    const n=new Date();
    const viva=buildLiveRecord(n.getFullYear(),n.getMonth()+1);
    if(viva&&viva.hasData)_liveRecord=viva;
    return;
  }
  if(dashViewIdx!==-2||!_liveRecord)return;
  const y=_liveRecord.year,m=_liveRecord.month;
  if(!y||!m)return;
  const built=buildLiveRecord(y,m);
  if(built&&built.hasData)_liveRecord=built;
}
// ════════════════════════════════════════════
// v110 · CUADRE — CADA CIFRA CON SU FECHA
// ════════════════════════════════════════════
// Cuando tu suma a mano y la cifra de arriba no coinciden, el problema casi
// nunca es la aritmética: es que estás sumando una foto distinta. Aquí está
// TODO lo que entra en el total, una línea por posición, con el día en que se
// tomó ese valor. Si algo sobra o falta, se ve a simple vista.
let _cuadreOpen=false;
try{_cuadreOpen=ALM.getItem('dlv_cuadreopen')==='1';}catch(e){fallo('_cuadreOpen',e)}
function toggleCuadre(){
  _cuadreOpen=!_cuadreOpen;
  try{ALM.setItem('dlv_cuadreopen',_cuadreOpen?'1':'0');}catch(e){fallo('ALM.setItem',e)}
  renderCuadre();
}
function cuadreFilas(){
  const lr=getDashRecord();
  const hoy=Date.parse(todayISO()+'T00:00:00');
  const edad=d=>d?Math.round((hoy-Date.parse(d+'T00:00:00'))/864e5):null;
  const nom=(arr,id)=>{const o=(arr||[]).find(x=>x.id===id);return o?o.name:id;};
  const F=[];
  const push=(grupo,refType,refId,nombre,valor)=>{
    const e=(typeof getBalanceEntries==='function')?getBalanceEntries(refType,refId)[0]:null;
    const d=e?e.date:null;
    F.push({grupo,nombre,refType,refId,valor:Number(valor)||0,fecha:d,dias:edad(d),
      viejo:e?null:'sin fecha registrada',
      conciso:(e&&Math.abs((e.amount||0)-(Number(valor)||0))>0.005)?'el dashboard usa '+fmt2(valor)+'€, el último apunte dice '+fmt2(e.amount)+'€':null});
  };
  Object.entries(lr.accounts_data||{}).forEach(([id,v])=>push('Cuentas','acc',id,nom(cfg.accounts,id),v));
  const bl=(typeof getBrokerLiq==='function')?getBrokerLiq(lr):0;
  if(bl) (cfg.brokers||[{id:'',name:'Bróker'}]).slice(0,1).forEach(b=>push('Cuentas','broker',b.id,'Liquidez en '+b.name,bl));
  Object.entries(lr.funds_data||{}).forEach(([id,v])=>push('Fondos','fund',id,nom(cfg.funds,id),(v&&v.vl)||0));
  Object.entries(lr.stocks_data||{}).forEach(([id,v])=>push('Acciones','stock',id,nom(cfg.stocks,id),v));
  Object.entries(lr.debts_data||{}).forEach(([id,v])=>push('Deudas','debt',id,nom(cfg.debts,id),-(Number(v)||0)));
  return F;
}
// "X" no es 163,972: en España el punto son los miles. parseNum solo
// acierta si hay coma decimal, así que aquí se resuelve el caso de los puntos.
// "X" no es 163,972: en España el punto son los miles. parseNum solo
// acierta si hay coma decimal, así que aquí se resuelve el caso de los puntos.
function cuadreNum(t){
  const s=String(t||'').replace(/[^0-9.,-]/g,'');
  if(!s)return NaN;
  if(s.indexOf(',')>=0) return parseFloat(s.replace(/\./g,'').replace(',','.'));
  if(/^-?\d{1,3}(\.\d{3})+$/.test(s)) return parseFloat(s.replace(/\./g,''));
  return parseFloat(s);
}
// v111 · Tus cifras, línea a línea. Preguntar "¿cuánto te sale a ti?" y dar un
// número global no sirve de nada: hay que saber QUÉ línea es la que baila.
// Aquí pegas tus valores y la app te dice exactamente cuál no cuadra y por qué
// — casi siempre porque la suya es de hace dos días y la tuya es de hoy.
let _cuadreMio={};
function cuadreKey(x){return x.refType+':'+x.refId;}
function cuadreFila(el){
  const k=el.dataset.k, v=cuadreNum(el.value);
  if(!isFinite(v)) delete _cuadreMio[k]; else _cuadreMio[k]=v;
  cuadrePintarDiffs();
}
function cuadreLimpiar(){_cuadreMio={};renderCuadre();}
function cuadrePintarDiffs(){
  const F=cuadreFilas();
  let mio=0, hayAlguno=false, difs=[];
  F.forEach(x=>{
    const k=cuadreKey(x), cell=document.getElementById('cd-'+k);
    const tiene=Object.prototype.hasOwnProperty.call(_cuadreMio,k);
    const v=tiene?_cuadreMio[k]:x.valor;
    mio+=v; if(tiene)hayAlguno=true;
    if(!cell)return;
    if(!tiene){cell.innerHTML='';return;}
    const d=v-x.valor;
    if(Math.abs(d)<0.005){cell.innerHTML='<span style="color:var(--teal)">✓ igual</span>';return;}
    const pct=x.valor?(d/x.valor*100):0;
    difs.push({x,d,pct});
    cell.innerHTML='<span style="color:var(--amber);font-weight:600">'+(d>0?'+':'')+fmt2(d)+'€</span> '+
      '<span style="color:var(--faint)">'+(pct>0?'+':'')+pct.toFixed(2).replace('.',',')+'%</span>';
  });
  const res=document.getElementById('cuadre-res'); if(!res)return;
  if(!hayAlguno){res.innerHTML='<span style="color:var(--muted)">Ve pegando tus cifras en la columna «tu valor». '+
    'Las que dejes en blanco se dan por buenas.</span>';return;}
  const T=F.reduce((s,x)=>s+x.valor,0), d=mio-T;
  let h='<div style="font-size:12px"><strong>Tu suma: '+fmt2(mio)+'€</strong> · la app: '+fmt2(T)+'€ · '+
    (Math.abs(d)<0.5?'<span style="color:var(--teal);font-weight:600">cuadra</span>'
      :'<span style="color:var(--amber);font-weight:600">diferencia '+(d>0?'+':'')+fmt2(d)+'€</span>')+'</div>';
  if(difs.length){
    difs.sort((a,b)=>Math.abs(b.d)-Math.abs(a.d));
    h+='<div style="font-size:11.5px;color:var(--muted);margin-top:.3rem">No cuadran '+difs.length+' línea(s): '+
      difs.slice(0,4).map(o=>'<strong>'+escapeHtml(o.x.nombre)+'</strong> '+(o.d>0?'+':'')+fmt2(o.d)+'€ '+
        '<span style="color:var(--faint)">(el valor de la app es del '+fmtDate(o.x.fecha)+')</span>').join(' · ')+
      (difs.length>4?' y '+(difs.length-4)+' más':'')+'</div>';
    h+='<div style="margin-top:.45rem"><button type="button" class="btn-xs" style="background:var(--navy);color:#fff;border-color:var(--navy)" '+
      'onclick="cuadreAplicar()">Actualizar esas '+difs.length+' posición(es) con mis cifras</button> '+
      '<button type="button" class="btn-xs" onclick="cuadreLimpiar()">Borrar lo que he escrito</button>'+
      '<div style="font-size:10.5px;color:var(--faint);margin-top:3px">Se registran con la fecha de hoy, igual que si las tecleases en Datos entrada. Se puede deshacer.</div></div>';
  }
  res.innerHTML=h;
}
function cuadreAplicar(){
  const F=cuadreFilas();
  const cambios=F.filter(x=>{
    const k=cuadreKey(x);
    return Object.prototype.hasOwnProperty.call(_cuadreMio,k)&&Math.abs(_cuadreMio[k]-x.valor)>0.005
      &&['acc','fund','stock','broker'].includes(x.refType);
  });
  if(!cambios.length){toast('No hay nada que actualizar');return;}
  const lista=cambios.map(x=>'· '+x.nombre+': '+fmt2(x.valor)+'€ → '+fmt2(_cuadreMio[cuadreKey(x)])+'€').join('\n');
  if(!confirm('Se registrarán estos valores con la fecha de hoy ('+fmtDate(todayISO())+'):\n\n'+lista+
    '\n\nEl histórico anterior no se borra: se añade un apunte nuevo.\n\n¿Actualizar?'))return;
  if(typeof guardedAction==='function'&&!guardedAction('actualizar '+cambios.length+' posiciones desde el cuadre'))return;
  const hoy=todayISO();
  cambios.forEach((x,i)=>{
    balanceLog.push({id:'bal_'+Date.now()+'_cua'+i,refType:x.refType,refId:x.refId,
      date:hoy,amount:Math.round(_cuadreMio[cuadreKey(x)]*100)/100,src:'cuadre'});
  });
  _cuadreMio={};
  save();
  try{renderFormLists();}catch(e){fallo('renderFormLists',e)}
  renderAll();
  toast('✅ '+cambios.length+' posición(es) actualizadas a día de hoy');
}
function renderCuadre(){
  const body=document.getElementById('cuadre-body');
  const badge=document.getElementById('cuadre-badge');
  const arrow=document.getElementById('cuadre-arrow');
  if(!body)return;
  const F=cuadreFilas();
  const T=F.reduce((s,x)=>s+x.valor,0);
  const viejas=F.filter(x=>x.dias==null||x.dias>2).length;
  if(arrow)arrow.innerHTML=_cuadreOpen?'&#9662;':'&#9656;';
  if(badge)badge.innerHTML=F.length+' posiciones · total '+fmt2(T)+'€'+
    (viejas?' · <span style="color:var(--amber)">'+viejas+' valoradas hace más de 2 días</span>':'');
  if(!_cuadreOpen){body.innerHTML='';return;}
  const grupos=['Cuentas','Fondos','Acciones','Deudas'];
  let h='<div style="font-size:11.5px;color:var(--muted);margin:.2rem 0 .6rem">'+
    'Todo lo que entra en la cifra de arriba, con la <strong>fecha del valor</strong> de cada línea. '+
    'Si tu suma no coincide, escribe tus cifras en la columna de la derecha: la app te dirá qué línea baila. '+
    'Casi siempre es una posición valorada hace dos días contra un valor de hoy.</div>';
  h+='<div class="tbl-scroll"><table class="detail-table" style="font-size:11.5px">'+
     '<colgroup><col><col class="cq-v"><col class="cq-t"></colgroup>'+
     '<thead><tr><th style="text-align:left">Posición · fecha del valor</th><th>Valor</th>'+
     '<th>Tu valor</th></tr></thead><tbody>';
  grupos.forEach(g=>{
    const filas=F.filter(x=>x.grupo===g);
    if(!filas.length)return;
    const st=filas.reduce((s,x)=>s+x.valor,0);
    h+='<tr style="background:var(--surface2)"><td style="text-align:left;font-weight:700">'+g+'</td>'+
       '<td style="font-weight:700">'+fmt2(st)+'€</td><td></td></tr>';
    filas.sort((a,b)=>b.valor-a.valor).forEach(x=>{
      const k=cuadreKey(x);
      const cuando=x.dias==null?'sin fecha':(x.dias<=0?'hoy':(x.dias===1?'ayer':'hace '+x.dias+' días'));
      const col=x.dias==null?'--red':(x.dias>2?'--amber':'--faint');
      const av='<div style="font-size:9.5px;color:var('+col+')">'+(x.fecha?fmtDate(x.fecha)+' · ':'')+cuando+'</div>';
      h+='<tr><td style="text-align:left">'+escapeHtml(String(x.nombre))+av+
         (x.conciso?'<div style="font-size:9.5px;color:var(--red)">'+escapeHtml(x.conciso)+'</div>':'')+'</td>'+
         '<td style="white-space:nowrap">'+fmt2(x.valor)+'€</td>'+
         '<td><input type="text" inputmode="decimal" data-k="'+k+'" oninput="cuadreFila(this)" '+
         'value="'+(Object.prototype.hasOwnProperty.call(_cuadreMio,k)?String(_cuadreMio[k]).replace('.',','):'')+'" '+
         'placeholder="—" style="width:88px;font-size:11px;padding:1px 4px;text-align:right">'+
         '<div id="cd-'+k+'" class="cq-d" style="font-size:10px;text-align:right;line-height:1.25"></div></td></tr>';
    });
  });
  h+='<tr style="border-top:2px solid var(--navy)"><td style="text-align:left;font-weight:700">PATRIMONIO TOTAL</td>'+
     '<td style="font-weight:700;color:var(--navy);white-space:nowrap">'+fmt2(T)+'€</td><td></td></tr>';
  h+='</tbody></table></div>';
  h+='<div id="cuadre-res" style="margin-top:.6rem;padding-top:.5rem;border-top:1px solid var(--line);font-size:11.5px"></div>';
  body.innerHTML=h;
  markScrollables(body);
  cuadrePintarDiffs();
}
function initDashSelectors(){
  const ysel=document.getElementById('dash-year');
  if(!ysel) return;
  const years=[...new Set(records.map(r=>r.year))].sort((a,b)=>b-a);
  ysel.innerHTML=years.map(y=>`<option value="${y}">${y}</option>`).join('');
  // Always default to latest record when dashViewIdx=-1
  if(dashViewIdx<0){
    const lr=last();
    ysel.value=lr.year;
    const msel=document.getElementById('dash-month');
    if(msel) msel.value=lr.month;
  }
}


function setDashToLatest(){
  dashViewIdx=-1;
  initDashSelectors();
  renderKPIs();
}

function renderKPIsNoData(year,month){
  // Update header to show the selected (empty) period
  const MN2=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const label=MN2[month-1]+'-'+String(year).slice(2);
  const lbl=document.getElementById('dash-period-label');
  if(lbl) lbl.textContent=label+' · sin datos registrados';
  document.getElementById('hdr-pat').textContent='—';
  document.getElementById('hdr-date').textContent=label;

  // Show empty state in KPI grid
  const lr=last(); // for comparison reference
  document.getElementById('kpi-grid').innerHTML=`
    <div style="grid-column:1/-1;padding:1.5rem;text-align:center;background:var(--surface);
      border-radius:var(--r);box-shadow:var(--shadow)">
      <div style="font-size:16px;margin-bottom:.5rem">📭</div>
      <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:.375rem">
        Sin datos para ${label}
      </div>
      <div style="font-size:12.5px;color:var(--muted);margin-bottom:.875rem">
        No hay ningún registro guardado para este mes.<br>
        Último registro disponible: <strong>${lr.label}</strong>
      </div>
      <div style="display:flex;gap:.5rem;justify-content:center;flex-wrap:wrap">
        <button class="btn-sm" onclick="setDashToLatest()" style="font-size:12px">
          Ver ${lr.label} (último disponible)
        </button>
        <button class="btn-sm" onclick="setTab('entrada')" style="font-size:12px;color:var(--navy);border-color:var(--navy)">
          ➕ Ir a Datos entrada
        </button>
      </div>
    </div>`;

  document.getElementById('kpi-details').innerHTML='';
}

// v169 · TEXTOS QUE VIENEN DE FUERA, SIN HTML
// Los conceptos del banco a veces los escribe otra persona: el de un Bizum o
// una transferencia lo pone quien te paga. Esta app los pinta en pantalla, y
// un concepto con «<» y «>» podía colar código en la página. Se cambian por
// ‹ y ›, que se leen igual pero no son HTML: al cargar y antes de cada
// guardado. Además, las listas que enseñan esos conceptos los escapan.
const _CAMPOS_TXT=['name','desc','note','notes','nota','label','stockName','concepto','comentario'];
function _saneaObj(o){
  if(!o||typeof o!=='object')return 0;
  let n=0;
  _CAMPOS_TXT.forEach(k=>{ const v=o[k]; if(typeof v==='string'&&/[<>]/.test(v)){ o[k]=v.replace(/</g,'‹').replace(/>/g,'›'); n++; } });
  return n;
}
function sanearTextos(){
  let n=0;
  try{
    [incomeLog,expenseLog,transactions,reembolsos,brokerFlows,records].forEach(L=>{ if(Array.isArray(L))L.forEach(o=>{n+=_saneaObj(o);}); });
    if(cfg&&typeof cfg==='object')['accounts','funds','stocks','brokers','debts','gastos_fijos'].forEach(k=>{ (cfg[k]||[]).forEach(o=>{n+=_saneaObj(o);}); });
    if(cfg&&cfg.customCats&&typeof cfg.customCats==='object')Object.keys(cfg.customCats).forEach(k=>{
      const v=cfg.customCats[k]; if(typeof v==='string'&&/[<>]/.test(v)){ cfg.customCats[k]=v.replace(/</g,'‹').replace(/>/g,'›'); n++; } });
  }catch(e){fallo('motor',e)}
  return n;
}
function save(){
  sanearTextos();
  try{
    ALM.setItem('dlv_cfg',JSON.stringify(cfg));
    ALM.setItem('dlv_records',JSON.stringify(records));
    ALM.setItem('dlv_tx',JSON.stringify(transactions));
    ALM.setItem('dlv_sold',JSON.stringify([...soldStocks]));
    ALM.setItem('dlv_ballog',JSON.stringify(balanceLog));
    ALM.setItem('dlv_income',JSON.stringify(incomeLog));
    ALM.setItem('dlv_expense',JSON.stringify(expenseLog));
    ALM.setItem('dlv_brokerflows',JSON.stringify(brokerFlows));
    ALM.setItem('dlv_reembolsos',JSON.stringify(reembolsos));
    ALM.setItem('dlv_personal',JSON.stringify(personal));
    // v133 · Cuándo cambiaron por última vez los datos de ESTE aparato. Sirve
    // para avisar si vas a restaurar encima un archivo más viejo que ellos.
    ALM.setItem('dlv_lastchange',new Date().toISOString());
    _saveFailed=false;
  }catch(e){
    console.warn('save error',e);
    // Sin esto el fallo era mudo: seguías trabajando creyendo que se guardaba.
    if(!_saveFailed){
      _saveFailed=true;
      const quota=/quota|exceeded|full|NS_ERROR_DOM_QUOTA/i.test(String(e&&(e.name+' '+e.message)));
      try{toast(quota?'⚠ Almacenamiento lleno: NO se están guardando los cambios':'⚠ No se han podido guardar los cambios');}catch(_){fallo('toast',_)}
      setTimeout(()=>alert(quota
        ? 'El navegador no admite más datos y tus últimos cambios NO se han guardado.\n\nGenera ahora un archivo de copia (botón «Generar archivo») y libera espacio: puedes borrar la copia interna de deshacer desde Revisión de datos.'
        : 'No se han podido guardar los cambios en este navegador.\n\nSi estás en modo incógnito o has bloqueado el almacenamiento local, la app no puede conservar nada. Genera un archivo de copia para no perder el trabajo.'),300);
    }
  }
}
let _saveFailed=false;

// ─── BACKUP: export / import all data to a file ──────────────────────
function exportData(){
  const data={
    _app:'DisfrutaLaVida-Patrimonio',
    _version:37,
    _exported:new Date().toISOString(),
    cfg,records,transactions,
    soldStocks:[...soldStocks],
    balanceLog,incomeLog,expenseLog,brokerFlows,reembolsos,personal,
  };
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  // v133 · Antes solo llevaba la fecha: dos copias el mismo día chocaban y el
  // sistema las renombraba a "-1", con lo que ya no se sabía cuál era la buena.
  // Con hora y nombre de aparato, el orden alfabético ES el orden cronológico.
  const _d=new Date(), _p=n=>String(n).padStart(2,'0');
  const today=_d.getFullYear()+'-'+_p(_d.getMonth()+1)+'-'+_p(_d.getDate())+
    '_'+_p(_d.getHours())+_p(_d.getMinutes())+
    '_'+String((typeof syncDeviceName==='function')?syncDeviceName():'')
        .normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9]/g,'').slice(0,12);
  a.href=url;
  a.download='patrimonio_datos_'+today+'.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  try{ALM.setItem('dlv_lastexport',new Date().toISOString());}catch(e){fallo('ALM.setItem',e)}
  renderBackupReminder();
  toast('Archivo de datos generado: patrimonio_datos_'+today+'.json');
}

// Days-since-last-backup reminder banner
function renderBackupReminder(){
  const el=document.getElementById('backup-reminder');
  if(!el)return;
  let last=null;
  try{last=ALM.getItem('dlv_lastexport');}catch(e){fallo('last',e)}
  if(!last){
    el.innerHTML='— <span style="color:var(--red);font-weight:600">nunca has hecho copia. Genera un archivo ahora ⚠</span>';
    return;
  }
  const days=Math.floor((Date.now()-new Date(last).getTime())/864e5);
  const color=days<=7?'var(--teal)':(days<=14?'var(--amber)':'var(--red)');
  const warn=days>14?' ⚠ Haz copia':'';
  el.innerHTML='— <span style="color:'+color+'">última copia hace '+(days===0?'hoy':days+' día'+(days!==1?'s':''))+warn+'</span>';
}

// Merge a file into current data (by id, incoming wins on conflict) — no data loss
function mergeData(ev){
  const file=ev.target.files&&ev.target.files[0];
  if(!file)return;
  const reader=new FileReader();
  reader.onload=function(e){
    try{
      const data=JSON.parse(e.target.result);
      if(!data||(!data.balanceLog&&!data.transactions&&!data.incomeLog)){
        toast('El archivo no parece un backup válido');ev.target.value='';return;
      }
      const mergeById=(cur,inc)=>{
        const map={};(cur||[]).forEach(x=>{if(x&&x.id)map[x.id]=x;});
        (inc||[]).forEach(x=>{if(x&&x.id)map[x.id]=x;});
        return Object.values(map);
      };
      let added={tx:0,bal:0,inc:0,exp:0};
      const curTxIds=new Set(transactions.map(t=>t.id));
      const curBalIds=new Set(balanceLog.map(t=>t.id));
      const curIncIds=new Set(incomeLog.map(t=>t.id));
      const curExpIds=new Set(expenseLog.map(t=>t.id));
      (data.transactions||[]).forEach(t=>{if(t.id&&!curTxIds.has(t.id))added.tx++;});
      (data.balanceLog||[]).forEach(t=>{if(t.id&&!curBalIds.has(t.id))added.bal++;});
      (data.incomeLog||[]).forEach(t=>{if(t.id&&!curIncIds.has(t.id))added.inc++;});
      (data.expenseLog||[]).forEach(t=>{if(t.id&&!curExpIds.has(t.id))added.exp++;});
      if(!confirm('Fusionar el archivo con tus datos actuales.\n\nSe añadirán/actualizarán:\n· '+added.tx+' operaciones\n· '+added.bal+' saldos\n· '+added.inc+' ingresos\n· '+added.exp+' gastos\n\nLo actual se conserva. ¿Continuar?')){
        ev.target.value='';return;
      }
      if(!guardedAction('fusionar archivo')){ev.target.value='';return;}
      transactions=mergeById(transactions,data.transactions);
      balanceLog=mergeById(balanceLog,data.balanceLog);
      incomeLog=mergeById(incomeLog,data.incomeLog);
      expenseLog=mergeById(expenseLog,data.expenseLog);
      brokerFlows=mergeById(brokerFlows,data.brokerFlows);
      if(data.reembolsos)reembolsos=mergeById(reembolsos,data.reembolsos);
      if(data.personal)setPersonal(data.personal,'merge');
      migrateFundIdent();
      if(data.soldStocks)soldStocks=new Set([...soldStocks,...data.soldStocks]);
      // Merge cfg lists (stocks, funds, accounts, brokers, gastos_fijos) by id
      if(data.cfg){
        ['stocks','funds','accounts','brokers','gastos_fijos'].forEach(k=>{
          cfg[k]=mergeById(cfg[k]||[],data.cfg[k]||[]);
        });
      }
      recomputeAllStockGains();
      save();renderAll();goToCurrentMonth();
      toast('✅ Fusionado: +'+added.tx+' op · +'+added.bal+' saldos · +'+added.inc+' ing · +'+added.exp+' gastos');
    }catch(err){
      toast('Error al fusionar: '+err.message);
    }
    ev.target.value='';
  };
  reader.readAsText(file);
}

// Dark mode
function toggleDark(){
  const on=document.body.classList.toggle('dark');
  try{ALM.setItem('dlv_dark',on?'1':'0');}catch(e){fallo('ALM.setItem',e)}
  const btn=document.getElementById('dark-btn');if(btn)btn.textContent=on?'☀️':'🌙';
  if(typeof initCharts==='function'&&document.getElementById('cPat'))initCharts();
}
function applyDarkPref(){
  let on=false;try{on=ALM.getItem('dlv_dark')==='1';}catch(e){fallo('on',e)}
  if(on){document.body.classList.add('dark');const btn=document.getElementById('dark-btn');if(btn)btn.textContent='☀️';}
}
function restoreSectionStates(){
  try{
    const s=JSON.parse(ALM.getItem('dlv_sections')||'{}');
    if(s.open!=null)_stockSections.open=s.open;
    if(s.movs!=null)_stockSections.movs=s.movs;
    if(s.closed!=null)_stockSections.closed=s.closed;
    if(s.broker!=null)_stockSections.broker=s.broker;
    if(s.income!=null)_incomeOpen=s.income;
  }catch(e){fallo('s',e)}
  try{
    if(ALM.getItem('dlv_rentab_open')==='1'){
      _rentabOpen=true;
      const div=document.getElementById('rentab-collapse');const arr=document.getElementById('rentab-arrow');
      if(div)div.style.display='block';if(arr)arr.textContent='▾';
    }
  }catch(e){fallo('if',e)}
}
function applySectionVisuals(){
  const map={open:['stock-positions','toggle-open-btn','posiciones abiertas y valores'],
    movs:['stock-tx-wrap','toggle-movs-btn','movimientos registrados'],
    closed:['stock-closed-list','toggle-closed-btn','operaciones cerradas'],
    broker:['broker-liq-list','toggle-broker-btn','liquidez en broker']};
  Object.entries(map).forEach(([k,[divId,btnId,label]])=>{
    const on=_stockSections[k];
    const div=document.getElementById(divId);const btn=document.getElementById(btnId);
    if(div)div.style.display=on?'block':'none';
    if(btn)btn.textContent=(on?'▾ Ocultar ':'▸ Ver ')+label;
  });
  const idiv=document.getElementById('income-content');const ibtn=document.getElementById('toggle-income-btn');
  if(idiv)idiv.style.display=_incomeOpen?'block':'none';
  if(ibtn)ibtn.textContent=_incomeOpen?'▾ Ocultar ingresos':'▸ Ver / añadir ingresos';
}

// ─── DEGIRO portfolio CSV import ─────────────────────────────────────

// ─── BANK movements CSV import (Bankinter / Trade Republic) ──────────
const BANK_EXP_RULES=[
  [/mercadona|consum|carrefour|lidl|aldi|supercor|alcampo|corte ingles|hipercor|charter|mas y mas|dialprix|coviran|\bspar\b|panaderia|fruteria|carniceria|pescaderia/i,'alimentacion'],
  [/endesa|curenerg|iberdrola|naturgy|repsol luz|electrica|edp|holaluz|totalenergies|som energia/i,'luz'],
  [/hidraqua|\baguas\b|emuasa|aquona|canal isabel|hidrogea|facsa|aigues|suministro de agua/i,'agua'],
  [/gas natural|nedgia|redexis|gas\b|internet|fibra/i,'suministros'],
  [/estanco|expenduria|tabac/i,'estanco'],
  [/itunes|google one|google chatgpt|paypal \*google|paypal \*itunes|apple\.com|netflix|spotify|surfshark|claude\.ai|anthropic|openai|chatgpt|disney\+|hbo|prime video|amazon prime|patreon|google google one/i,'suscripciones'],
  [/digi |movistar|vodafone|orange|jazztel|telecom|allianz|seguros|leroy merlin|brico depot|ferreteria|\bikea\b/i,'hogar'],
  [/easypark|telpark|gasexpress|plenergy|est\.serv|estacion de servicio|gasolin|cepsa|repsol|galp|aparcamiento|parking|iteuve|movilidad|taxi/i,'vehiculo'],
  [/farmacia|clinica|dental|hospital|\bhosp\b|pharma|dentista|optica/i,'salud'],
  [/restaurante|cafeteria|delikia|mcdonald|burger|cerveceria|taberna|dunkin|confiteria|pizzeria|kebab|heladeria|haagen/i,'restaurante'],
  [/zara|cortefiel|massimo|springfield|levis|primark|makeup|perfum|druni|deporvillage|calzado/i,'ropa'],
  [/hotel|booking|airbnb|iberia|vueling|ryanair/i,'viaje'],
  [/netflix|spotify|loterias|apuestas|estanco|amazon prime|surfshark|claude|chatgpt|google one|itunes|apple|disney/i,'ocio'],
];
// v169 · Quién te paga la nómina ya no va aquí: está en tus datos (titular).
const BANK_INC_RULES=[
  [/nomin/i,'nomina'],
  [/prestaciones seguridad soci|prestaciones s\.s|incapacidad|inss/i,'ipt'],
  [/dividend/i,'dividendo'],
  [/ints|interes|interest|rendimiento/i,'rend'],
];
// v169 · Lo genérico. Tu nombre (las transferencias a ti mismo) y tus fondos
// salen de tus datos: ver bankSkip() y titularCfg().
const BANK_SKIP=/payout to transit|cash reward|buy trade|sell trade|\boperar\b|v\.m\.dia|trans inm\/|liq\. propia cta|outgoing transfer|incoming transfer|\btraspaso\b/i;
// v168 · «traspaso» es como llaman los bancos al dinero que pasa entre dos
// cuentas del mismo titular (de la corriente a la remunerada, por ejemplo):
// no es ni ingreso ni gasto, como las transferencias a tu nombre.
// ════════════════════════════════════════════════════════════════════
// v169 · TUS DATOS PERSONALES, FUERA DEL CÓDIGO
// ════════════════════════════════════════════════════════════════════
// La app está en un repositorio público: cualquiera puede leer su código. Tu
// nombre, tu fecha de nacimiento, tu declaración o los sitios donde compras
// no pueden ir escritos en él. Ahora están en tus datos (cfg.titular y tus
// reglas de categorías), que viajan en tus copias y no salen de tus aparatos:
//   · propios:       cómo te nombran los bancos en las transferencias a ti
//                    mismo («TRF. NOMBRE…»): no son ni ingreso ni gasto.
//   · pagadores:     quién te paga la nómina, para reconocerla en el banco.
//   · nominaIgnorar: palabras de la cabecera de tu nómina que no son conceptos.
// En cada lista, un «?» vale por cualquier letra (por las tildes que algunos
// bancos convierten en un símbolo raro).
function titularCfg(){
  if(!cfg.titular||typeof cfg.titular!=='object')cfg.titular={};
  const t=cfg.titular;
  ['propios','pagadores','nominaIgnorar'].forEach(k=>{ if(!Array.isArray(t[k]))t[k]=[]; });
  if(t.nombre==null)t.nombre='';
  if(t.apellidos==null)t.apellidos='';
  return t;
}
function titularFalta(){ const t=titularCfg(); return !t.nombre&&!t.propios.length; }
function _rxDeLista(L){
  const v=(L||[]).map(x=>String(x||'').trim().toLowerCase()).filter(x=>x.length>=3)
    .map(x=>x.replace(/[.*+^${}()|[\]\\\/]/g,'\\$&').replace(/\?/g,'.').replace(/\s+/g,'\\s?'));
  return v.length?new RegExp(v.join('|'),'i'):null;
}
// palabras que no distinguen a un fondo de otro
const _FONDO_COMUN=/^(fondo|fund|fondos|plan|planes|pensiones|pension|cartera|indexado|index|global|internacional|renta|bolsa|ahorro|mixto|fi|fp)$/;
let _rxCache={k:null};
function _rxTitular(){
  const t=titularCfg();
  const fondos=(typeof cfg!=='undefined'&&cfg.funds||[]).map(f=>_pfNorm(f.name||'').toLowerCase().split(' ')[0])
    .filter(w=>w&&w.length>=4&&!_FONDO_COMUN.test(w));
  const k=JSON.stringify([t.nombre,t.apellidos,t.propios,t.pagadores,t.nominaIgnorar,fondos]);
  if(_rxCache.k===k)return _rxCache;
  const nom=String(t.nombre||'').trim(), aps=String(t.apellidos||'').trim().split(/\s+/).filter(Boolean);
  const propios=t.propios.slice(); if(nom&&aps[0])propios.push(nom+' '+aps[0]);
  const fichas=[nom].concat(aps).filter(x=>x&&x.length>=3);
  _rxCache={k,propios:_rxDeLista(propios),fondos:_rxDeLista(fondos),pagadores:_rxDeLista(t.pagadores),
    nomina:_rxDeLista(t.nominaIgnorar.concat(fichas))};
  return _rxCache;
}
// ¿Es un traspaso entre tus cuentas o hacia tus fondos? No es ni ingreso ni gasto.
function bankSkip(s){
  if(BANK_SKIP.test(s))return true;
  const R=_rxTitular();
  return !!((R.propios&&R.propios.test(s))||(R.fondos&&R.fondos.test(s)));
}
function _nomIgnora(s){ const R=_rxTitular(); return !!(R.nomina&&R.nomina.test(s)); }
function setTitular(o){
  const t=titularCfg(); o=o||{};
  const lista=v=>(Array.isArray(v)?v:String(v||'').split(/\n|;/)).map(x=>String(x).trim()).filter(Boolean);
  if(o.nombre!=null)t.nombre=String(o.nombre).trim();
  if(o.apellidos!=null)t.apellidos=String(o.apellidos).trim();
  ['propios','pagadores','nominaIgnorar'].forEach(k=>{ if(o[k]!=null)t[k]=lista(o[k]); });
  _rxCache={k:null};
  return t;
}
// El archivo de ajustes personales: tu nombre y tus reglas, para cargarlo una
// vez en cada aparato. Solo rellena lo que falta: nunca pisa lo que ya tienes.
function aplicarAjustesPersonales(j){
  if(!j||j._tipo!=='dlv-ajustes-personales')return {err:'No es un archivo de ajustes personales.'};
  const r={titular:0,reglas:0,pension:0,decl:0};
  const t=titularCfg(), T=j.titular||{};
  ['nombre','apellidos'].forEach(k=>{ if(!t[k]&&T[k]){ t[k]=String(T[k]).trim(); r.titular++; } });
  ['propios','pagadores','nominaIgnorar'].forEach(k=>{ (T[k]||[]).forEach(x=>{ x=String(x).trim();
    if(x&&!t[k].some(y=>String(y).toLowerCase()===x.toLowerCase())){ t[k].push(x); r.titular++; } }); });
  cfg.catRules=cfg.catRules||[];
  (j.catRules||[]).forEach(x=>{ if(x&&x.m&&x.cat&&!cfg.catRules.some(y=>String(y.m||'').toLowerCase()===String(x.m).toLowerCase())){
    cfg.catRules.push({m:String(x.m),cat:String(x.cat)}); r.reglas++; } });
  const pc=cfg.pension=cfg.pension||{};
  Object.entries(j.pension||{}).forEach(([k,v])=>{ if((pc[k]==null||pc[k]==='')&&v!=null&&v!==''){ pc[k]=v; r.pension++; } });
  if(j.pension&&j.pension.nacimientoFecha&&pc.nacDerivada){ pc.nacimientoFecha=j.pension.nacimientoFecha; pc.nacDerivada=false; r.pension++; }
  if(j.decl&&typeof fiscalCfg==='function'){
    const fc=fiscalCfg(); fc.decl=fc.decl||{};
    Object.entries(j.decl).forEach(([a,d])=>{ if(!fc.decl[a]&&d&&typeof d==='object'){ fc.decl[a]=d; r.decl++; } });
  }
  _rxCache={k:null};
  return r;
}
function slugCat(label){
  let s=label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  return 'c_'+(s||'cat')+'_'+Math.random().toString(36).slice(2,6);
}
function addCustomCat(){
  const name=(document.getElementById('cc-name')?.value||'').trim();
  if(!name){toast('Escribe el nombre de la categoría');return;}
  const exists=Object.values(CAT_LABELS).some(v=>v.toLowerCase()===name.toLowerCase());
  if(exists){toast('Ya existe una categoría con ese nombre');return;}
  const key=slugCat(name);
  if(!cfg.customCats)cfg.customCats={};
  cfg.customCats[key]=name;
  CAT_LABELS[key]=name;
  save();
  document.getElementById('cc-name').value='';
  renderCatRules();renderGastosList();
  toast('✅ Categoría «'+name+'» creada');
}
function delCustomCat(key){
  const label=CAT_LABELS[key]||key;
  const inUse=expenseLog.filter(x=>x.cat===key).length;
  if(!confirm('Eliminar la categoría «'+label+'»'+(inUse?' ('+inUse+' gastos la usan y pasarán a «Otro»)':'')+'?'))return;
  expenseLog.forEach(x=>{if(x.cat===key)x.cat='otro';});
  if(cfg.catRules)cfg.catRules=cfg.catRules.filter(r=>r.cat!==key);
  if(cfg.customCats)delete cfg.customCats[key];
  delete CAT_LABELS[key];
  save();renderCatRules();renderGastosList();renderAll();
  toast('Categoría eliminada');
}
function renderCatRules(){
  const sel=document.getElementById('cr-cat');
  if(sel){const cur=sel.value;sel.innerHTML=Object.entries(CAT_LABELS).map(([k,v])=>'<option value="'+k+'">'+v+'</option>').join('');if(cur&&CAT_LABELS[cur])sel.value=cur;}
  // list of user-created categories (deletable)
  const cc=document.getElementById('cc-list');
  if(cc){const keys=Object.keys(cfg.customCats||{});
    cc.innerHTML=keys.length?('Tus categorías: '+keys.map(k=>'<span style="display:inline-block;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:1px 8px;margin:2px;font-size:11px">'+CAT_LABELS[k]+' <a href="#" onclick="event.preventDefault();delCustomCat(\''+k+'\')" style="color:var(--red);text-decoration:none">✕</a></span>').join('')):'';
  }
  const list=document.getElementById('cr-list');if(!list)return;
  const cr=cfg.catRules||[];
  if(!cr.length){list.innerHTML='<div style="font-size:11px;color:var(--faint)">Aún no tienes reglas propias.</div>';return;}
  list.innerHTML=cr.map((r,i)=>'<div style="display:flex;align-items:center;gap:.4rem;font-size:11.5px;padding:.2rem 0">'+
    '<span style="flex:1">"'+r.m+'" → <strong>'+(CAT_LABELS[r.cat]||r.cat)+'</strong></span>'+
    '<a href="#" onclick="event.preventDefault();delCatRule('+i+')" style="color:var(--red);text-decoration:none">✕</a></div>').join('');
}
function addCatRule(){
  const t=(document.getElementById('cr-text')?.value||'').trim();
  const c=document.getElementById('cr-cat')?.value||'otro';
  if(!t){toast('Escribe el texto a detectar');return;}
  if(!cfg.catRules)cfg.catRules=[];
  cfg.catRules.push({m:t,cat:c});
  save();document.getElementById('cr-text').value='';renderCatRules();
  toast('Regla añadida: "'+t+'" → '+(CAT_LABELS[c]||c));
}
function delCatRule(i){
  if(!cfg.catRules)return;
  cfg.catRules.splice(i,1);save();renderCatRules();toast('Regla eliminada');
}
function cleanDesc(d){return String(d||'').replace(/^pago en el d[ií]a tj-?/i,'').replace(/^(rcbo\.|recibo ?\/|recib ?\/|pago movil en |pago en |transf ?\/|transf nomin ?\/|trans ?\/)/i,'').replace(/^tj-/i,'').trim();}
function catExpense(desc){desc=cleanDesc(desc);
  const cr=(cfg.catRules||[]);for(const r of cr){if(r.m&&desc.toLowerCase().includes(r.m.toLowerCase()))return r.cat;}
  for(const p of BANK_EXP_RULES) if(p[0].test(desc)) return p[1]; return 'otro';}
function catIncome(desc){desc=cleanDesc(desc);
  const R=_rxTitular(); if(R.pagadores&&R.pagadores.test(desc))return 'nomina';
  for(const p of BANK_INC_RULES) if(p[0].test(desc)) return p[1]; return 'otro2';}
function bankDateISO(s){s=String(s||'').trim();let m=s.match(/(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})/);if(m)return m[3]+'-'+m[2]+'-'+m[1];m=s.match(/(\d{4})[\/\-.](\d{2})[\/\-.](\d{2})/);if(m)return m[1]+'-'+m[2]+'-'+m[3];return null;}
function dedupKey(kind,date,amt,desc){return kind+'|'+date+'|'+Math.round(amt*100)+'|'+String(desc).slice(0,18).toLowerCase().replace(/[^a-z0-9]/g,'');}
function parseCsvLineD(line,delim){const out=[];let cur='',inQ=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(inQ&&line[i+1]==='"'){cur+='"';i++;}else inQ=!inQ;}else if(c===delim&&!inQ){out.push(cur);cur='';}else cur+=c;}out.push(cur);return out;}
function parseNum(s){
  if(s==null)return NaN;
  if(typeof s==='number')return s;
  s=String(s).trim(); if(!s)return NaN;
  if(s.indexOf(',')>=0){ // has comma
    if(s.lastIndexOf(',')>s.lastIndexOf('.')) return parseFloat(s.replace(/\./g,'').replace(',','.')); // European: 1.234,56
    return parseFloat(s.replace(/,/g,'')); // en-US: 1,234.56
  }
  return parseFloat(s); // dot-decimal or integer
}
// ════════════════════════════════════════════════════════════════════
// v136 · EL EXTRACTO DEL BANCO, VENGA COMO VENGA
// ════════════════════════════════════════════════════════════════════
// Bankinter llama .xls a un archivo que muchas veces no es un Excel sino una
// tabla de HTML con otro nombre. La versión anterior decidía por la extensión
// y le pedía a la librería de Excel que leyera algo que no lo era, así que no
// había manera: o lo convertías tú a CSV o no entraba.
//
// Ahora no se mira el nombre del archivo, se miran sus primeros bytes, que es
// lo único que no miente:
//
//   "PK"            → un .xlsx (por dentro es un zip)
//   D0 CF 11 E0     → un .xls de los de verdad (formato OLE de Microsoft)
//   <table…>        → una página web disfrazada: se lee la tabla y ya está
//   cualquier otra  → texto suelto: CSV, punto y coma, o tabulaciones
//
// Y como los bancos españoles siguen mandando acentos en ISO-8859-1, si el
// texto sale con caracteres rotos se vuelve a decodificar en Windows-1252.
function bankTexto(buf){
  const dec=et=>{try{return new TextDecoder(et,{fatal:false}).decode(buf);}catch(e){return null;}};
  let t=dec('utf-8');
  if(t==null||t.indexOf('\uFFFD')>=0){ const l=dec('windows-1252')||dec('iso-8859-1'); if(l)t=l; }
  return String(t||'').replace(/^\uFEFF/,'');
}
function bankFilasHtml(txt){
  const doc=new DOMParser().parseFromString(txt,'text/html');
  const tablas=[...doc.querySelectorAll('table')];
  if(!tablas.length)throw new Error('el archivo es una página web pero no trae ninguna tabla');
  // con tablas anidadas, la buena es siempre la que más filas tiene
  const t=tablas.slice().sort((a,b)=>b.rows.length-a.rows.length)[0];
  return [...t.rows].map(tr=>[...tr.cells].map(td=>
    String(td.textContent||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim()));
}
function bankFilasTexto(txt){
  const L=txt.replace(/\r/g,'').split('\n').filter(l=>l.trim());
  if(!L.length)throw new Error('el archivo está vacío');
  // el separador es el que más aparece en las primeras líneas, no el de la
  // primera: los extractos traen un encabezado suelto antes de la tabla
  const muestra=L.slice(0,25);
  const cuenta=c=>muestra.reduce((n,l)=>n+(l.split(c).length-1),0);
  const delim=[';',',','\t'].map(c=>({c,n:cuenta(c)})).sort((a,b)=>b.n-a.n)[0];
  if(!delim.n)throw new Error('no encuentro columnas: ni punto y coma, ni comas, ni tabulaciones');
  return L.map(l=>parseCsvLineD(l,delim.c));
}
function bankFilasExcel(buf){
  if(typeof XLSX==='undefined')throw new Error('no se pudo cargar el lector de Excel');
  const wb=XLSX.read(buf,{type:'array',cellDates:true});
  // la hoja buena es la que tiene más filas, no necesariamente la primera
  let mejor=null;
  wb.SheetNames.forEach(n=>{
    const f=XLSX.utils.sheet_to_json(wb.Sheets[n],{header:1,raw:true,defval:''});
    if(!mejor||f.length>mejor.length)mejor=f;
  });
  const p=n=>String(n).padStart(2,'0');
  // todo a texto: processBankRows recorta y compara cadenas, y una celda de
  // fecha o un número le harían saltar
  return (mejor||[]).map(r=>(r||[]).map(c=>{
    if(c==null)return '';
    if(c instanceof Date&&!isNaN(c))return c.getFullYear()+'-'+p(c.getMonth()+1)+'-'+p(c.getDate());
    return String(c);
  }));
}
function bankFilas(buf){
  const zip = buf[0]===0x50&&buf[1]===0x4B;                                    // PK
  const ole = buf[0]===0xD0&&buf[1]===0xCF&&buf[2]===0x11&&buf[3]===0xE0;      // .xls real
  if(zip||ole)return bankFilasExcel(buf);
  const txt=bankTexto(buf);
  if(/<\s*table/i.test(txt))return bankFilasHtml(txt);
  return bankFilasTexto(txt);
}
// ════════════════════════════════════════════════════════════════════
// v141 · EL EXTRACTO DE TRADE REPUBLIC, QUE VIENE EN PDF
// ════════════════════════════════════════════════════════════════════
// Trade Republic no da CSV ni Excel: da un PDF. El importador no leía PDFs y
// por eso no había manera de subirlo. La app ya sabe leer PDFs —lo hace con
// las nóminas—, así que aquí se reutiliza el mismo lector.
//
// El PDF tiene una trampa: cada movimiento ocupa TRES renglones, porque la
// fecha se parte en dos ("08 sept" arriba, "2026" abajo) y el tipo también
// ("Transacción con" / "tarjeta"). En medio va la línea con el concepto y los
// importes. Así que no se lee renglón a renglón, se buscan tríos.
//
// Y hay otra trampa peor: el importe y el saldo salen como dos números
// seguidos, sin decir cuál es entrada y cuál salida. Adivinarlo por la
// columna sería frágil. Lo que no falla es el SALDO: si baja, fue un gasto;
// si sube, un ingreso. La magnitud se toma del importe y el signo del saldo.
const TR_MESES={ene:1,feb:2,mar:3,abr:4,may:5,jun:6,jul:7,ago:8,sep:9,sept:9,oct:10,nov:11,dic:12,
  jan:1,apr:4,aug:8,dec:12};
// Con \b a los lados a propósito: sin el de la derecha, «Interés» se comía la
// primera parte de «Interest payment» y el concepto quedaba en «t payment».
const TR_TIPOS=/\b(?:transacci[oó]n con\s*tarjeta|transacci[oó]n con|tarjeta|inter[eé]s|transferencia|recompensa|comisi[oó]n|dividendo|recarga|reembolso)\b/gi;
const TR_INGRESO=/inter[eé]s|recompensa|dividendo|abono|ingreso|incoming/i;

function trEsExtracto(L){
  return L.some(x=>/TRANSACCIONES DE CUENTA/i.test(x))
      || (L.some(x=>/trade republic/i.test(x))&&L.some(x=>/SALIDA DE|ENTRADA DE/i.test(x)));
}
// Todos los importes de una línea, en orden. El último siempre es el saldo.
function trImportes(s){
  const m=String(s||'').match(/-?\d{1,3}(?:\.\d{3})*,\d{2}\s*€/g);
  return m?m.map(x=>parseNum(x.replace('€','').trim())):[];
}
function trExtractoFilas(lines){
  const L=(lines||[]).map(x=>String(x||'').replace(/ /g,' ').replace(/\s+/g,' ').trim());
  if(!trEsExtracto(L))return null;
  // el saldo de partida sale del resumen de arriba: sin él, el primer
  // movimiento no tendría con qué comparar y no sabríamos su signo
  let saldoPrev=null;
  const resumen=L.find(x=>/^cuenta corriente\b/i.test(x));
  if(resumen){ const n=trImportes(resumen); if(n.length)saldoPrev=n[0]; }

  const MES='(?:ene|feb|mar|abr|may|jun|jul|ago|sept|sep|oct|nov|dic|jan|apr|aug|dec)';
  const reDia=new RegExp('^(\\d{1,2})\\s+('+MES+')\\.?\\s*(.*)$','i');
  const reAnio=/^(\d{4})\b\s*(.*)$/;
  const filas=[['Fecha','Tipo','Descripción','Entrada de dinero','Salida de dinero','Saldo']];
  const p2=n=>String(n).padStart(2,'0');
  const esp=v=>Math.abs(v).toFixed(2).replace('.',',');

  let i=0;
  while(i<L.length){
    const m=reDia.exec(L[i]);
    if(!m){ i++; continue; }
    const mes=TR_MESES[String(m[2]).toLowerCase()];
    if(!mes){ i++; continue; }
    const extra1=m[3]||'';
    // la línea de los números, en los tres renglones siguientes
    let j=-1, nums=null;
    for(let k=i+1;k<Math.min(i+4,L.length);k++){
      const n=trImportes(L[k]);
      if(n.length>=1){ j=k; nums=n; break; }
    }
    if(j<0){ i++; continue; }
    // y el año, justo después
    let anio=null, extra2='';
    for(let k=j+1;k<Math.min(j+3,L.length);k++){
      const a=reAnio.exec(L[k]);
      if(a){ anio=a[1]; extra2=a[2]||''; break; }
    }
    if(!anio){ i=j+1; continue; }

    const saldo=nums[nums.length-1];
    const explicito=nums.length>=2?Math.abs(nums[nums.length-2]):null;
    // el concepto es la línea de los números sin los números
    let desc=L[j].replace(/-?\d{1,3}(?:\.\d{3})*,\d{2}\s*€/g,'').trim();
    const tipoTxt=(extra1+' '+desc+' '+extra2);
    const tipo=(tipoTxt.match(TR_TIPOS)||[]).join(' ').replace(/\s+/g,' ').trim();
    desc=desc.replace(TR_TIPOS,'').replace(/\s+/g,' ').trim();
    if(desc.length<3) desc=(extra1+' '+extra2).replace(TR_TIPOS,'').replace(/\s+/g,' ').trim();
    if(!desc) desc=tipo||'Movimiento';

    let signo=0;
    if(saldoPrev!=null&&isFinite(saldo)) signo=(saldo>saldoPrev)?1:((saldo<saldoPrev)?-1:0);
    if(!signo) signo=TR_INGRESO.test(tipoTxt)?1:-1;
    const imp=(explicito!=null?explicito:Math.abs(saldo-(saldoPrev==null?saldo:saldoPrev)));
    saldoPrev=saldo;
    if(!(imp>0)){ i=j+1; continue; }

    filas.push([p2(m[1])+'/'+p2(mes)+'/'+anio, tipo, desc,
      signo>0?esp(imp):'', signo<0?esp(imp):'',
      isFinite(saldo)?esp(saldo):'']);
    i=j+1;
  }
  return filas.length>1?filas:null;
}
// ════════════════════════════════════════════════════════════════════
// v168 · EL EXTRACTO DE OPENBANK, QUE VIENE EN PDF
// ════════════════════════════════════════════════════════════════════
// Openbank da los movimientos en un PDF con forma de certificado («HACE
// CONSTAR: … se realizaron los siguientes movimientos») y una tabla de cinco
// columnas: fecha de operación, fecha valor, concepto, importe y saldo.
//
// No se puede leer renglón a renglón como el de Trade Republic: el concepto
// ocupa dos renglones, o más, y va centrado en su celda, medio por encima de
// la línea de las fechas y los importes y medio por debajo. Con dos
// movimientos seguidos, el renglón de abajo de uno y el de arriba del
// siguiente quedan juntos, y por el orden no se sabe de quién es cada uno.
// Se sabe por la posición en la página: cada movimiento tiene tantos renglones
// de concepto por encima de su línea como por debajo.
//
// El PDF dice además de qué cuenta es (corriente o remunerada, y su número), y
// con eso se propone bien adónde va el saldo: a esa cuenta de Openbank, o a una
// nueva con su nombre si todavía no la tienes en la app.
function obEsExtracto(L){
  const T=(L||[]).join('\n');
  return /open\s?bank/i.test(T)&&/hace constar|siguientes movimientos/i.test(T)&&
    (L||[]).some(x=>/concepto/i.test(x)&&/importe/i.test(x)&&/saldo/i.test(x));
}
// «1.000,00 EUR», «-25,00 EUR» o «25,00- EUR» → número; cualquier otra cosa → null
function obImporte(s){
  const m=/^([-−+]?)\s*(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})\s*(-?)\s*(?:EUR|€)?$/i
    .exec(String(s||'').replace(/\s+/g,' ').trim());
  if(!m)return null;
  const v=parseFloat(m[2].replace(/\./g,'')+'.'+m[3]);
  return (m[1]==='-'||m[1]==='−'||m[4]==='-')?-v:v;
}
// Los trozos de una línea, con el signo o el «EUR» pegados a su número si el
// PDF los trae sueltos
function obCeldas(items){
  const out=[];
  items.forEach(o=>{
    const s=String(o.s||'').trim(), prev=out[out.length-1];
    const cerca=prev&&(o.x-(prev.x+prev.w))<6;
    if(cerca&&/^[-−]$/.test(prev.s)&&/^\d/.test(s)){ prev.s+=s; prev.w=o.x+o.w-prev.x; return; }
    if(cerca&&/\d,\d{2}$/.test(prev.s)&&/^(EUR|€|-)$/i.test(s)){ prev.s+=' '+s; prev.w=o.x+o.w-prev.x; return; }
    out.push({x:o.x,y:o.y,w:o.w||0,s});
  });
  return out;
}
function obExtractoFilas(items){
  const IT=(items||[]).filter(o=>o&&String(o.s||'').trim());
  const texto=IT.map(o=>String(o.s).trim()).join(' ').replace(/\s+/g,' ');
  if(!/open\s?bank/i.test(texto))return null;
  // de qué cuenta es: «la Cuenta (CUENTA CORRIENTE OPEN) 0073 0100 …»
  let tipo='Cuenta', fin4='';
  const mc=/la cuenta\s*\(([^)]{2,60})\)\s*((?:[A-Z]{2}\d{2})?[\d ]{8,40})/i.exec(texto);
  if(mc){
    const t=mc[1].replace(/\bopen\b/ig,'').replace(/\s+/g,' ').trim().toLowerCase();
    if(t)tipo=t.charAt(0).toUpperCase()+t.slice(1);
    fin4=mc[2].replace(/\D/g,'').slice(-4);
  }
  const cuenta={banco:'Openbank',patron:'open\\s?bank',tipo,fin4,nombre:'Openbank · '+tipo};
  const DIA=/^\d{2}\/\d{2}\/\d{4}$/;
  const filas=[];
  const paginas=[...new Set(IT.map(o=>o.p))].sort((a,b)=>a-b);
  for(const p of paginas){
    // renglones: los trozos que están a la misma altura
    const R=[];
    IT.filter(o=>o.p===p).sort((a,b)=>b.y-a.y||a.x-b.x).forEach(o=>{
      const r=R.find(r=>Math.abs(r.y-o.y)<1);
      if(r)r.it.push(o); else R.push({y:o.y,it:[o]});
    });
    R.forEach(r=>r.it.sort((a,b)=>a.x-b.x));
    // la cabecera de la tabla: lo que hay por encima no es de la tabla
    const cab=R.find(r=>r.it.some(o=>/^concepto$/i.test(String(o.s).trim()))&&r.it.some(o=>/^importe$/i.test(String(o.s).trim())));
    const techo=cab?cab.y-1:Infinity;
    // cada línea con su fecha y dos importes (el del movimiento y el saldo) es un movimiento
    const A=[];
    R.forEach(r=>{
      if(r.y>techo)return;
      const cel=obCeldas(r.it);
      const fechas=cel.filter(c=>DIA.test(c.s));
      const imps=cel.filter(c=>obImporte(c.s)!=null);
      if(!fechas.length||imps.length<2)return;
      const imp=imps[imps.length-2], sal=imps[imps.length-1];
      if(!(fechas[0].x<imp.x))return;
      A.push({y:r.y,fo:fechas[0].s,fv:(fechas[1]||fechas[0]).s,imp:obImporte(imp.s),sal:obImporte(sal.s),
        finFechas:Math.max(...fechas.slice(0,2).map(c=>c.x+c.w)),iniImp:imp.x,lin:[]});
    });
    if(!A.length)continue;
    // los renglones del concepto: lo que cae entre las fechas y los importes
    const desde=Math.max(...A.map(a=>a.finFechas))-1, hasta=Math.min(...A.map(a=>a.iniImp))-0.5;
    const C=[];
    R.forEach(r=>{
      if(r.y>techo)return;
      const t=r.it.filter(o=>o.x>=desde&&o.x<hasta);
      const s=t.map(o=>String(o.s).trim()).filter(Boolean).join(' ').replace(/\s+/g,' ');
      if(s)C.push({y:r.y,s,h:Math.max(0,...t.map(o=>o.h||0))});
    });
    const hs=C.map(c=>c.h).filter(v=>v>0).sort((a,b)=>a-b);
    const salto=(hs.length?hs[hs.length>>1]:8.2)*1.2;     // de un renglón al siguiente
    A.sort((a,b)=>b.y-a.y); C.sort((a,b)=>b.y-a.y);
    // De arriba abajo: los renglones que hay entre dos movimientos son primero
    // los de debajo del de arriba (tantos como tenía por encima) y luego los de
    // encima del de abajo. Si son impares, uno va en la misma línea.
    const reparto=()=>{
      let i=0;
      while(i<C.length&&C[i].y-A[0].y>salto*4)i++;      // muy por encima: no es de la tabla
      for(let k=0;k<A.length;k++){
        const a=A[k], enc=[];
        while(i<C.length&&C[i].y>a.y+0.75){enc.push(C[i]);i++;}
        if(k>0){
          const prev=A[k-1];
          if(enc.length<prev.arriba)return false;
          prev.lin.push(...enc.splice(0,prev.arriba));
        }
        a.arriba=enc.length; a.lin.push(...enc);
        while(i<C.length&&Math.abs(C[i].y-a.y)<=0.75){a.lin.push(C[i]);i++;}
      }
      const u=A[A.length-1];
      for(let n=0;n<u.arriba;n++){
        if(i>=C.length||u.y-C[i].y>salto*4)return false;
        u.lin.push(C[i]); i++;
      }
      return true;
    };
    if(!reparto()){
      // si la cuenta no cuadra (otra maquetación), cada renglón con el movimiento más cercano
      A.forEach(a=>{a.lin=[];});
      C.forEach(c=>{
        let mejor=null, d=Infinity;
        A.forEach(a=>{const dd=Math.abs(a.y-c.y); if(dd<d){d=dd;mejor=a;}});
        if(mejor&&d<=salto*3)mejor.lin.push(c);
      });
    }
    A.forEach(a=>{
      a.c=a.lin.slice().sort((x,y)=>y.y-x.y).map(x=>x.s).join(' ').replace(/\s+/g,' ').trim();
      filas.push(a);
    });
  }
  // De más antiguo a más reciente: así el saldo final es el de la última fila
  // aunque haya dos movimientos el mismo día. El orden del PDF se deduce de la
  // aritmética del saldo, y si no basta, de las fechas.
  let desc=0, asc=0;
  for(let k=0;k+1<filas.length;k++){
    const a=filas[k], b=filas[k+1];
    if(Math.abs(a.sal-a.imp-b.sal)<0.011)desc++;
    if(Math.abs(a.sal+b.imp-b.sal)<0.011)asc++;
  }
  const iso=f=>f.slice(6,10)+f.slice(3,5)+f.slice(0,2);
  if(filas.length>1&&(desc>asc||(desc===asc&&iso(filas[0].fo)>iso(filas[filas.length-1].fo))))filas.reverse();
  const esp=v=>(v<0?'-':'')+Math.abs(v).toFixed(2).replace('.',',');
  const out=[['Fecha','Fecha valor','Descripción','Importe','Saldo']];
  filas.forEach(a=>out.push([a.fo,a.fv,a.c||'Movimiento',esp(a.imp),esp(a.sal)]));
  return {filas:out,cuenta};
}
// El PDF, por el mismo lector que ya usan las nóminas
// v142 · isTR de más abajo mira las columnas del CSV de Trade Republic, que el
// PDF no tiene: sin esta marca, el saldo de TR se ofrecía por defecto a la
// cuenta del otro banco y bastaba con darle a Enter para meterlo donde no era.
let _bankTR=false;
// v168 · El banco y la cuenta del extracto, cuando el propio archivo lo dice
// (el PDF de Openbank lo dice): con eso se propone bien adónde va el saldo.
let _bankHint=null;
async function bankFilasPdf(file){
  await loadPdfJs();
  const lines=await extractPdfLines(file);
  const F=trExtractoFilas(lines);
  if(F){ _bankTR=true; return F; }
  if(obEsExtracto(lines)){
    const O=obExtractoFilas(await extractPdfItems(file));
    if(!O||O.filas.length<2)throw new Error('es un extracto de Openbank, pero no he encontrado ningún movimiento dentro');
    _bankHint=O.cuenta;
    return O.filas;
  }
  throw new Error('es un PDF pero no reconozco el formato. Sé leer los extractos en PDF de Trade Republic y de Openbank; '+
    'si es de otro banco, pide el CSV o el Excel');
}

function importBankCsv(ev){
  const file=ev.target.files&&ev.target.files[0];
  if(!file)return;
  const reader=new FileReader();
  reader.onload=async function(e){
    try{
      const buf=new Uint8Array(e.target.result);
      _bankTR=false; _bankHint=null;
      // v141 · "%PDF" al principio: hay que pasar por el lector de PDF, que es
      // asíncrono y se descarga la primera vez que se usa.
      const esPdf=buf[0]===0x25&&buf[1]===0x50&&buf[2]===0x44&&buf[3]===0x46;
      if(esPdf)toast('Leyendo el PDF…');
      // v169 · si en realidad es de DEGIRO o un histórico de un fondo, va a su sitio
      if(!esPdf&&archivoNoBanco(bankTexto(buf),buf,file.name,file.lastModified)){ ev.target.value=''; return; }
      const filas=esPdf?await bankFilasPdf(file):bankFilas(buf);
      if(!filas||!filas.length)throw new Error('no he encontrado ninguna fila');
      processBankRows(filas);
    }catch(err){
      const off=/offline|cargar/i.test(String(err&&err.message));
      alert(off
        ? 'Para leer un PDF hace falta cargar el lector la primera vez, y ahora mismo no hay conexión.\n\nConéctate a internet y vuelve a intentarlo: después ya funciona sin conexión.'
        : 'No pude leer el extracto: '+(err&&err.message||err));
      console.warn('extracto',err);
    }
    ev.target.value='';
  };
  reader.onerror=function(){toast('No se pudo abrir el archivo');ev.target.value='';};
  reader.readAsArrayBuffer(file);
}

// ════════════════════════════════════════════
// v110 · EL EXTRACTO TRAE EL SALDO Y SE TIRABA
// ════════════════════════════════════════════
// Descargabas el extracto, se importaban los movimientos, y la liquidez de la
// cuenta seguía con el saldo de la última vez que lo tecleaste a mano. El dato
// estaba en el CSV, en la columna "Saldo", y no lo miraba nadie.
// v119 · Bankinter descarga los movimientos del MÁS RECIENTE al más antiguo, y
// el saldo va bajando según lees hacia abajo. Coger "la última fila con la
// fecha más alta" daba el saldo de la operación más antigua de ese día: con
// tres movimientos el 27/08 proponía X€ cuando el saldo real era
// X€. El orden no se adivina por el banco: se deduce de la aritmética
// del propio saldo, que no falla — saldo − importe del mismo apunte tiene que
// dar el saldo del apunte contiguo.
function bankOrden(rows,hi,idxDate,idxAmt,idxS){
  let desc=0,asc=0;
  for(let i=hi+1;i+1<rows.length;i++){
    const a=rows[i],b=rows[i+1]; if(!a||!b)continue;
    const sa=parseNum(a[idxS]), sb=parseNum(b[idxS]);
    const ia=parseNum(a[idxAmt]), ib=parseNum(b[idxAmt]);
    if(!isFinite(sa)||!isFinite(sb))continue;
    if(isFinite(ia)&&Math.abs(sa-ia-sb)<0.011)desc++;
    if(isFinite(ib)&&Math.abs(sa+ib-sb)<0.011)asc++;
  }
  if(desc>asc&&desc>=2)return 'desc';
  if(asc>desc&&asc>=2)return 'asc';
  // sin aritmética suficiente, mirar las fechas de los extremos
  const p=bankDateISO(rows[hi+1]&&rows[hi+1][idxDate>=0?idxDate:0]);
  const u=bankDateISO(rows[rows.length-1]&&rows[rows.length-1][idxDate>=0?idxDate:0]);
  return (p&&u&&p>u)?'desc':'asc';
}
function bankSaldoFinal(rows,hi,header,idxDate,idxAmt){
  const idxS=header.findIndex(c=>/^saldo\b/i.test(c)||/saldo\s*(posterior|disponible|contable|final|resultante)/i.test(c)||/^balance$/i.test(c));
  if(idxS<0)return null;
  const orden=bankOrden(rows,hi,idxDate,idxAmt,idxS);
  let best=null;
  for(let i=hi+1;i<rows.length;i++){
    const r=rows[i]; if(!r||r.length<=idxS)continue;
    const d=bankDateISO(r[idxDate>=0?idxDate:0]); if(!d)continue;
    const v=parseNum(r[idxS]); if(!isFinite(v))continue;
    // en un archivo descendente, la fila MÁS ARRIBA de la fecha más alta es la
    // más reciente; en uno ascendente, la más abajo
    const mejor=!best||d>best.date||(d===best.date&&(orden==='desc'?i<best.i:i>best.i));
    if(mejor) best={date:d,saldo:v,i,orden};
  }
  return best;
}
// v145 · Esto devolvía SIEMPRE una cuenta: si no reconocía el banco, la
function bankGuessAccountInfo(isTR){
  const A=cfg.accounts||[];
  // v168 · Si el propio extracto dice de qué banco y de qué cuenta es (el PDF
  // de Openbank lo dice), solo se proponen cuentas de ESE banco. Sin esto se
  // proponía la primera cuyo nombre sonara a banco, y el saldo de Openbank iba
  // a parar a «EVO / Bankinter». Si esa cuenta no está en la app, se propone
  // crearla con su nombre: «Openbank · Cuenta corriente».
  const H=isTR?null:_bankHint;
  if(H){
    const banco=new RegExp(H.patron||H.banco,'i');
    // la que ya quedó ligada a ese número de cuenta otra vez
    const ligada=H.fin4?A.find(a=>a.fin4===H.fin4):null;
    if(ligada)return {acc:ligada,seguro:true};
    const del=A.filter(a=>banco.test(a.name||'')&&!(a.fin4&&H.fin4&&a.fin4!==H.fin4));
    // la de su tipo: «corriente», «remunerada»…
    const palabra=String(H.tipo||'').toLowerCase().replace(/^cuenta\s*/,'').split(/\s+/)[0]||'';
    const delTipo=palabra?del.find(a=>String(a.name||'').toLowerCase().indexOf(palabra)>=0):null;
    if(delTipo)return {acc:delTipo,seguro:true};
    // o la única de ese banco, si su nombre no dice que sea de otro tipo
    const OTRO=/corriente|remunerada|ahorro|n[oó]mina|plazo|dep[oó]sito/i;
    if(del.length===1&&!OTRO.test(del[0].name||''))return {acc:del[0],seguro:true};
    return {acc:null,seguro:false,nuevo:H.nombre};
  }
  const re=isTR?/trade|republic/i:/evo|bankinter|banco|caixa|santander|bbva|sabadell|\bing\b|openbank|abanca|unicaja|kutxa|imagin|revolut|n26/i;
  const claro=A.find(a=>re.test(a.name||''));
  if(claro)return {acc:claro,seguro:true};
  const otra=A.find(a=>!/efectivo|casa|metálico/i.test(a.name||''))||A[0]||null;
  return {acc:otra,seguro:false};
}
// Nunca se adivina la cuenta a solas: un saldo puesto en la cuenta equivocada
// es peor que no ponerlo. Se propone la más probable y decides tú.
function bankAplicarSaldo(info,isTR){
  if(!info)return false;
  if(!cfg.accounts)cfg.accounts=[];
  const A=cfg.accounts;
  const g=bankGuessAccountInfo(isTR);
  const H=isTR?null:_bankHint;
  if(!A.length&&!g.nuevo)return false;
  const gi=Math.max(0,A.indexOf(g.acc));
  // v168 · cuando el extracto es de una cuenta que aún no está en la app, la
  // última opción es crearla con su nombre
  const nNuevo=g.nuevo?A.length+1:0;
  const lista=A.map((a,n)=>{
    const e=getBalanceEntries('acc',a.id)[0];
    return '  '+(n+1)+') '+a.name+(e?'  → ahora '+fmt2(e.amount)+'€ a '+fmtDate(e.date):'  → sin saldo registrado');
  }).join('\n')+(nNuevo?'\n  '+nNuevo+') Crear la cuenta «'+g.nuevo+'»':'');
  const r=prompt((H?'El extracto de '+H.banco+' ('+String(H.tipo||'cuenta').toLowerCase()+(H.fin4?', acabada en '+H.fin4:'')+') termina':'El extracto termina')+
    ' con un saldo de '+fmt2(info.saldo)+'€ el '+fmtDate(info.date)+
    (info.orden==='desc'?'\n(el archivo viene del movimiento más reciente al más antiguo)':'')+'.\n\n'+
    (g.seguro
      ? '¿A qué cuenta corresponde? Escribe el número. Deja en blanco para no tocar la liquidez.'
      : nNuevo
        ? 'Esa cuenta no está en la app: te propongo crearla (la '+nNuevo+'). Si ya la tienes con otro nombre, escribe su número. '+
          'Deja en blanco para no tocar la liquidez.'
        : 'NO he podido identificar el banco del extracto, así que no propongo ninguna cuenta.\n'+
          'Escribe el número de la que sea. Deja en blanco para no tocar la liquidez.')+
    '\n\n'+lista, g.seguro?String(gi+1):(nNuevo?String(nNuevo):''));
  if(r==null||!String(r).trim())return false;
  const n=parseInt(String(r).trim(),10);
  let acc;
  if(nNuevo&&n===nNuevo){
    acc={id:'acc_'+Date.now(),name:g.nuevo};
    if(H&&H.fin4)acc.fin4=H.fin4;
    A.push(acc);
  }else{
    if(!(n>=1&&n<=A.length)){toast('Ese número de cuenta no existe: no he tocado la liquidez.');return false;}
    acc=A[n-1];
    // la cuenta de ese banco queda ligada a ese número: el próximo extracto va solo
    if(H&&H.fin4&&!acc.fin4&&new RegExp(H.patron||H.banco,'i').test(acc.name||'')&&!A.some(a=>a.fin4===H.fin4))acc.fin4=H.fin4;
  }
  const e0=getBalanceEntries('acc',acc.id)[0];
  if(e0&&e0.date>info.date){
    if(!confirm('En «'+acc.name+'» ya tienes un saldo MÁS RECIENTE: '+fmt2(e0.amount)+'€ a '+fmtDate(e0.date)+'.\n\n'+
      'Si sigo, el saldo del extracto queda por detrás y tu liquidez actual NO cambia.\n\n¿Lo registro igualmente?'))return false;
  }
  if(e0&&e0.date===info.date&&Math.abs((e0.amount||0)-info.saldo)<0.005){
    toast('La liquidez de «'+acc.name+'» ya estaba al día.');return false;
  }
  balanceLog.push({id:'bal_'+Date.now()+'_ext',refType:'acc',refId:acc.id,
    date:info.date,amount:Math.round(info.saldo*100)/100,src:'extracto'});
  toast('💶 '+acc.name+': '+fmt2(info.saldo)+'€ a '+fmtDate(info.date));
  return true;
}
function processBankRows(rows){
      let hi=rows.findIndex(r=>r.some(c=>/descrip|description/i.test(c))&&r.some(c=>/importe|salida|entrada|amount/i.test(c)));
      if(hi<0)hi=0;
      const header=rows[hi].map(c=>c.trim().toLowerCase());
      const isTR=header.includes('transaction_id')||header.includes('asset_class');
      let idxDate=header.findIndex(c=>c==='date'); if(idxDate<0)idxDate=header.findIndex(c=>/fecha|date/i.test(c));
      const idxDesc=header.findIndex(c=>/descrip|concepto|description/i.test(c));
      const idxName=header.findIndex(c=>c==='name');
      const idxType=header.findIndex(c=>c==='type');
      const idxAsset=header.findIndex(c=>/asset_class/.test(c));
      const idxCP=header.findIndex(c=>/counterparty_name/.test(c));
      const idxAmt=header.findIndex(c=>/^amount$/.test(c)||/importe/.test(c));
      const idxIn=header.findIndex(c=>/entrada/i.test(c));
      const idxOut=header.findIndex(c=>/salida/i.test(c));
      const saldoInfo=bankSaldoFinal(rows,hi,header,idxDate,idxAmt>=0?idxAmt:3); // v110/v119
      // v109 · El antiduplicados comparaba la clave del apunte GUARDADO (nombre ya
      // pasado por cleanDesc) contra la del CSV EN CRUDO. "RCBO. ENDESA ENERGIA"
      // frente a "ENDESA ENERGIA" son claves distintas, así que cada importación
      // repetía todas las domiciliaciones y las nóminas. Ahora se indexan ambas
      // formas y la fila nueva se comprueba contra las dos.
      // v145 · Antes esto era un conjunto de claves: si la clave existía, la
      // fila se descartaba. Pero dos compras iguales el mismo día por el mismo
      // importe son un caso normal — dos cafés, dos veces al estanco — y la
      // segunda se perdía en silencio. Ahora cada apunte guardado se puede
      // gastar UNA vez: si tienes uno y el extracto trae dos, entra el que
      // falta; si el extracto trae los mismos que ya tienes, no entra ninguno.
      const _entradas=[], _idx=new Map();
      const _claves=(kind,date,amt,raw)=>{
        const bruto=dedupKey(kind,date,amt,raw);
        const limpio=dedupKey(kind,date,amt,cleanDesc(raw)||raw);
        return limpio===bruto?[bruto]:[bruto,limpio];
      };
      // v161 · además de por descripción, cada apunte queda localizable por
      // día e importe: si lo anotaste a mano con otra descripción, el extracto
      // no tiene por qué saberlo, pero el día y el importe sí coinciden.
      const _porFI=new Map();
      const _registrar=(kind,date,amt,raw,alias)=>{
        const e={usado:false};
        const fk=kind+'|'+date+'|'+Math.round(amt*100);
        if(!_porFI.has(fk))_porFI.set(fk,[]); _porFI.get(fk).push(e);
        // v164 · también por el nombre con el que vino del banco, si se lo
        // cambiaste después (alias): si no, el siguiente extracto lo volvía a meter
        [raw].concat(alias||[]).forEach(r=>_claves(kind,date,amt,r).forEach(k=>{
          if(!_idx.has(k))_idx.set(k,[]);
          if(!_idx.get(k).includes(e))_idx.get(k).push(e);
        }));
        _entradas.push(e);
      };
      incomeLog.forEach(x=>_registrar('i',x.date,x.amt,x.desc||'',x.alias));
      expenseLog.forEach(x=>_registrar('e',x.date,x.amt,x.name||'',x.alias));
      // «gastar» un apunte ya guardado: solo entonces la fila es un duplicado
      const yaEsta=(kind,date,amt,raw)=>{
        for(const k of _claves(kind,date,amt,raw)){
          const arr=_idx.get(k); if(!arr)continue;
          const e=arr.find(x=>!x.usado);
          if(e){e.usado=true;return true;}
        }
        return false;
      };
      const marcar=()=>{};   // lo que entra nuevo ya no bloquea a su gemelo
      let addI=0,addE=0,skip=0,dup=0;const newInc=[],newExp=[];const skippedNames=[];
      const dupDetalle=[];   // para poder decirte CUÁLES se han quedado fuera
      for(let i=hi+1;i<rows.length;i++){
        const r=rows[i];if(!r||r.length<2)continue;
        const date=bankDateISO(r[idxDate>=0?idxDate:0]);
        if(!date)continue;
        let merchant,amt,incCat=null;
        if(isTR){
          const type=((idxType>=0?r[idxType]:'')||'').toUpperCase();
          const asset=((idxAsset>=0?r[idxAsset]:'')||'').trim();
          // Skip stock ops always
          if(asset||/BUY|SELL|SAVINGS_PLAN|TRADE/.test(type)){skip++;continue;}
          const isDirectDebit=/DIRECT_DEBIT/.test(type);
          // Skip internal transfers/migrations — but NOT SEPA direct debits (domiciliaciones = gastos/ingresos reales)
          if(!isDirectDebit && /TRANSFER|MIGRATION|CUSTOMER/.test(type)){skip++;continue;}
          const trDesc=((idxDesc>=0?r[idxDesc]:'')||'').trim();
          if(isDirectDebit){
            // payee is in the description: "... transfer to <BENEFICIARIO> (IBAN)"
            const m=trDesc.match(/transfer to\s+(.+?)(\s*\(|$)/i);
            merchant=(m?m[1]:trDesc||'Domiciliación').trim();
          } else {
            merchant=(((idxName>=0?r[idxName]:'')||(idxCP>=0?r[idxCP]:'')||trDesc)||'').trim();
          }
          amt=parseNum(r[idxAmt]);
          if(/INTEREST/.test(type))incCat='rend'; else if(/DIVIDEND/.test(type))incCat='dividendo'; else if(/REFERRAL/.test(type))incCat='otro2';
        } else {
          merchant=((idxDesc>=0?r[idxDesc]:(r[2]||''))||'').trim();
          if(idxIn>=0&&idxOut>=0){const inn=parseNum(r[idxIn]),out=parseNum(r[idxOut]);amt=(!isNaN(inn)&&inn>0)?inn:((!isNaN(out)&&out>0)?-out:NaN);}
          else{amt=parseNum(r[idxAmt>=0?idxAmt:3]);}
        }
        if(!merchant||isNaN(amt)||amt===0)continue;
        if(bankSkip(merchant)){skip++;skippedNames.push(merchant.slice(0,40));continue;}
        if(amt>0){if(yaEsta('i',date,amt,merchant)){dup++;dupDetalle.push(fmtDate(date)+'  '+fmt2(amt)+'€  '+String(merchant).slice(0,28));continue;}marcar('i',date,amt,merchant);newInc.push({id:'inc_'+Date.now()+'_'+i,date,desc:(cleanDesc(merchant)||merchant).slice(0,60),cat:incCat||catIncome(merchant),amt:Math.round(amt*100)/100});addI++;}
        else{const a=Math.abs(amt);if(yaEsta('e',date,a,merchant)){dup++;dupDetalle.push(fmtDate(date)+'  −'+fmt2(a)+'€  '+String(merchant).slice(0,28));continue;}marcar('e',date,a,merchant);newExp.push({id:'exp_'+Date.now()+'_'+i,date,name:(cleanDesc(merchant)||merchant).slice(0,60),amt:Math.round(a*100)/100,cat:catExpense(merchant),kind:'estructural'});addE++;}
      }
      // v161 · Segunda vuelta, solo para ingresos: un ingreso que en el extracto
      // tiene el mismo día y el mismo importe que uno que ya tienes —y que no se
      // ha emparejado con nada en la primera vuelta— es ese mismo ingreso con la
      // descripción cambiada a mano. Pasaba con la paga extra del IPT de junio:
      // la anotaste tú al cotejar la renta y el extracto la volvía a meter.
      // Solo ingresos: son pocos y grandes, y dos distintos el mismo día por el
      // mismo importe no pasan; con gastos sí (dos cafés), y ahí no se toca.
      for(let k=newInc.length-1;k>=0;k--){
        const x=newInc[k];
        const L=_porFI.get('i|'+x.date+'|'+Math.round(x.amt*100))||[];
        const libre=L.find(e=>!e.usado);
        if(libre){
          libre.usado=true; newInc.splice(k,1); addI--; dup++;
          dupDetalle.push(fmtDate(x.date)+'  '+fmt2(x.amt)+'€  '+String(x.desc).slice(0,20)+' (ya lo tenías con otra descripción)');
        }
      }
      // v164 · La nómina que entró antes desde el PDF lleva fecha del día 28 y su
      // propio concepto; el cobro del banco llega el 27 o el 29 como «SERVICIO
      // PUBLICO». Es el mismo dinero: el apunte del banco no entra y el de la
      // nómina se queda con la fecha y el concepto del banco (así el siguiente
      // extracto ya lo reconoce), sin perder su desglose. Pasó en agosto y
      // septiembre de 2026: X € contados dos veces cada mes.
      for(let k=newInc.length-1;k>=0;k--){
        const x=newInc[k]; if(x.cat!=='nomina')continue;
        const t=incomeLog.find(e=>String(e.id||'').startsWith('inc_nom_')&&(e.cat==='nomina'||e.cat==='extra')&&!e.deBanco
          &&String(e.date||'').slice(0,7)===String(x.date).slice(0,7)&&Math.abs((Number(e.amt)||0)-x.amt)<0.02
          &&Math.abs(Date.parse(e.date)-Date.parse(x.date))<=6*864e5);
        if(t){ t.alias=t.alias||[]; if(t.desc&&!t.alias.includes(t.desc))t.alias.push(t.desc);
          t.date=x.date; t.desc=x.desc; t.deBanco=true;
          newInc.splice(k,1); addI--; dup++;
          dupDetalle.push(fmtDate(x.date)+'  '+fmt2(x.amt)+'€  la nómina que ya tenías del PDF'); }
      }
      // v164 · Trade Republic da los intereses en bruto en el extracto y en neto
      // (sin el 19 %) en la exportación: el mismo pago no entra dos veces.
      for(let k=newInc.length-1;k>=0;k--){
        const x=newInc[k]; if(!/interest|inter[eé]s/i.test(x.desc||''))continue;
        const t=incomeLog.find(e=>e.date===x.date&&/interest|inter[eé]s/i.test(e.desc||'')&&
          [1,0.81,1/0.81].some(f=>Math.abs((Number(e.amt)||0)*f-x.amt)<0.03));
        if(t){ newInc.splice(k,1); addI--; dup++; dupDetalle.push(fmtDate(x.date)+'  '+fmt2(x.amt)+'€  intereses que ya tenías'); }
      }
      // v119 · Antes, si no había nada nuevo, salía un aviso de una línea y ya.
      // Con un archivo que no se lee bien el resultado es idéntico al de un
      // archivo entero de duplicados, así que no había forma de distinguirlos.
      // Ahora siempre se dice qué se ha leído: filas, fechas y en qué se ha ido.
      const leidas=rows.length-hi-1;
      const fechasOK=[];
      for(let i=hi+1;i<rows.length;i++){const d=bankDateISO(rows[i]&&rows[i][idxDate>=0?idxDate:0]);if(d)fechasOK.push(d);}
      fechasOK.sort();
      const resumenLectura='He leído '+leidas+' fila(s) del archivo'+
        (fechasOK.length?(', del '+fmtDate(fechasOK[0])+' al '+fmtDate(fechasOK[fechasOK.length-1])):
                         ' pero NO he reconocido ninguna fecha')+'.'+
        // v169 · sin tu nombre no se reconocen las transferencias a ti mismo
        (titularFalta()?'\n\n⚠ No sé cómo te llamas: las transferencias entre tus cuentas a tu nombre no se reconocen y pueden '+
          'entrar como ingresos o gastos. Carga tu archivo de ajustes personales, o escribe tu nombre en la versión nueva (Buzón → Tus datos).':'');
      if(!addI&&!addE){
        const skipTxt0=skippedNames.length?('\n\nOmitidos como traspaso propio:\n   '+
          [...new Set(skippedNames)].slice(0,12).join('\n   ')+(skippedNames.length>12?'\n   …y más':'')):'';
        alert(resumenLectura+'\n\n'+
          '· '+dup+' ya los tenías (duplicados)\n'+
          '· '+skip+' omitidos por ser traspasos entre tus cuentas o bolsa\n'+
          '· 0 movimientos nuevos\n\n'+
          (fechasOK.length
            ? (dup
                ? 'El archivo se ha leído bien: sencillamente ya lo tenías todo. Para la próxima, pide el extracto desde el '+
                  fmtDate(fechasOK[fechasOK.length-1])+'.'
                : skip
                  ? 'El archivo se ha leído bien: lo que trae son traspasos entre tus cuentas, que no son ni ingreso ni gasto.'
                  : 'El archivo se ha leído bien, pero no trae ningún ingreso ni gasto.')
            : 'No he sabido leer las fechas. Comprueba que la hoja tenga una fila de cabecera con «Fecha», «Descripción» e «Importe».')+
          skipTxt0);
        let tocado=false;
        try{tocado=bankAplicarSaldo(saldoInfo,isTR||_bankTR);}catch(e){console.warn('saldo',e);}
        if(tocado){save();renderFormLists();renderAll();}
        return;
      }
      const catCount={};newExp.forEach(x=>{catCount[x.cat]=(catCount[x.cat]||0)+1;});
      const catTxt=Object.entries(catCount).sort((a,b)=>b[1]-a[1]).map(([c,n])=>'   '+(CAT_LABELS[c]||c)+': '+n).join('\n');
      const skipTxt=skippedNames.length?('\n\nOmitidos como traspaso propio (revisa que ninguno sea un gasto/ingreso real):\n   '+[...new Set(skippedNames)].slice(0,12).join('\n   ')+(skippedNames.length>12?'\n   …y '+(skippedNames.length-12)+' más':'')):'';
      const saldoTxt=saldoInfo?('\n\nSaldo al final del extracto: '+fmt2(saldoInfo.saldo)+'€ a '+fmtDate(saldoInfo.date)+' (te preguntaré a qué cuenta aplicarlo)'):'\n\n⚠ Este archivo no trae columna de saldo: la liquidez habrá que ponerla a mano.';
      const dupTxt=dup?('\n\nYa los tenías, no se importan:\n'+
        dupDetalle.slice(0,10).map(x=>'\u00b7 '+x).join('\n')+
        (dupDetalle.length>10?('\n\u00b7 … y '+(dupDetalle.length-10)+' más'):'')+
        '\n(si alguno era una compra distinta del mismo día y el mismo importe, añádelo a mano)'):'';
      const msg=resumenLectura+'\n\nImportar movimientos ('+(isTR?'Trade Republic':'banco')+'):\n\n\u00b7 '+addI+' ingresos\n\u00b7 '+addE+' gastos\n\u00b7 '+skip+' traspasos/bolsa omitidos\n\u00b7 '+dup+' ya registrados\n\nGastos por categoría:\n'+catTxt+skipTxt+dupTxt+saldoTxt+'\n\n¿Continuar? (luego puedes recategorizar en la lista de gastos)';
      if(!confirm(msg)){return;}
      incomeLog.push(...newInc);expenseLog.push(...newExp);
      let tocado=false;
      try{tocado=bankAplicarSaldo(saldoInfo,isTR||_bankTR);}catch(e){console.warn('saldo',e);}
      save();renderFormLists();renderTxIngList();renderGastosList();renderAll();renderBankCutoff();
      toast('\u2705 +'+addI+' ingresos \u00b7 +'+addE+' gastos'+(tocado?' \u00b7 liquidez actualizada':'')+' ('+skip+' omitidos)');
}
function renderBankCutoff(){
  const el=document.getElementById('bank-cutoff');
  if(!el)return;
  // latest date among bank-imported movements (ids inc_/exp_)
  const impInc=incomeLog.filter(x=>(x.id||'').startsWith('inc_')).map(x=>x.date).filter(Boolean);
  const impExp=expenseLog.filter(x=>(x.id||'').startsWith('exp_')).map(x=>x.date).filter(Boolean);
  const all=[...impInc,...impExp].sort();
  if(!all.length){el.innerHTML='📭 Aún no has importado movimientos de banco por CSV.';return;}
  const maxD=all[all.length-1], minD=all[0];
  const fmtD=d=>{const p=d.split('-');return p[2]+'/'+p[1]+'/'+p[0];};
  // v110 · Aviso en el sitio donde importas, no escondido en Diagnóstico.
  // Un ingreso duplicado de X€ te sube la tasa de ahorro trece puntos.
  let aviso='';
  try{
    const D=findDupes();
    const G=[...D.exp,...D.inc];
    if(G.length){
      const nX=G.reduce((s,g)=>s+g.length-1,0);
      const money=G.reduce((s,g)=>s+(Number(g[0].amt)||0)*(g.length-1),0);
      const mIng=D.inc.reduce((s,g)=>s+(Number(g[0].amt)||0)*(g.length-1),0);
      aviso='<div style="background:#FDECEA;border:1px solid #E8A79E;border-radius:6px;padding:.55rem .65rem;margin-bottom:.5rem;color:#8A2A1A;font-size:11.5px">'+
        '<strong>⚠ '+nX+' apunte(s) repetidos, '+fmt2(money)+'€.</strong>'+
        (mIng>0?' De ellos <strong>'+fmt2(mIng)+'€ son ingresos duplicados</strong>, que inflan tu tasa de ahorro sin que hayas ahorrado nada.':'')+
        ' <button type="button" class="btn-xs" style="background:#B03020;color:#fff;border-color:#B03020" onclick="diagCleanDupes()">Revisar y borrar</button>'+
        '<div style="font-size:10.5px;margin-top:3px;color:#A0503A">Verás la lista antes de borrar nada, y se puede deshacer.</div></div>';
    }
  }catch(e){console.warn('dupes banner',e);}
  el.innerHTML=aviso+'📅 Datos de banco registrados: <strong>'+fmtD(minD)+'</strong> → <strong>'+fmtD(maxD)+'</strong> ('+(impInc.length+impExp.length)+' movimientos). Pide el próximo extracto <strong>desde el '+fmtD(maxD)+'</strong> para no duplicar.';
}
// ── Importar histórico desde CSV de Numbers (DATOS_DISFRUTANDO) ──────
const MESES_HIST={'ENERO':1,'FEBRERO':2,'MARZO':3,'ABRIL':4,'MAYO':5,'JUNIO':6,'JULIO':7,'AGOSTO':8,'SEPTIEMBRE':9,'OCTUBRE':10,'NOVIEMBRE':11,'DICIEMBRE':12};
function histNum(s){s=(s||'').trim().replace(/\s*€/,'').replace(/\./g,'').replace(',','.');const v=parseFloat(s);return isNaN(v)?null:v;}
const NOMINAS_HIST=[];
// ── Importar nóminas con desglose de conceptos ──────────────────────
// Dedup por mes: si el mes ya tiene una nómina, se enriquece con el
// desglose (sin tocar el importe); si no, se añade. Idempotente.
// ═══ IMPORTAR POSICIONES DEGIRO (Portfolio) ═════════════════════════
function _pfNorm(s){return String(s).toUpperCase().replace(/[^A-Z0-9& ]/g,'').replace(/\s+/g,' ').trim();}
// v145 · «Alphabet Class A» y «Alphabet Class C» son dos acciones distintas,
// con precios distintos y plusvalías distintas. Los normalizadores de nombres
// borran la palabra CLASS y la letra, así que las dos quedaban en «ALPHABET» y
// cualquier valoración se emparejaba con la primera que apareciera. La letra se
// lee aparte y manda: si las dos la tienen y no coinciden, no son la misma.
function _claseAccion(s){
  const t=String(s||'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ');
  let m=t.match(/\b(?:CLASS|CLASE|SERIES|SERIE|CL)\s+([A-C])\b/);
  if(m)return m[1];
  m=t.match(/\s([A-C])\s+(?:SHARES?|ACCIONES)\b/);
  return m?m[1]:null;
}
function mismaClase(a,b){
  const ca=_claseAccion(a), cb=_claseAccion(b);
  return !ca||!cb||ca===cb;
}

// ═══ SUBIDA DIRECTA DE NÓMINAS EN PDF ═══════════════════════════════
const _NOM_MESES={enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12};
const _DED_RX=[/retenci[oó]n\s*i\.?r\.?p\.?f/i,/muface/i,/derechos\s*pasivos/i];
const _SKIP_RX=/totales|total\s*devengado|total\s*deducir|l[ií]quido|base\b|prorrata|percepciones|deducciones|concepto|devengos|coste\s*ss|recibi|transferencia|n[uú]m|nivel|grupo|unidad|o\.p\.|ayudante|auxiliar|c\.\s*general|revisiones|n\.i\.f|g\.cotiza|imponible|exenta/i;
function _pN(s){return parseFloat(String(s).replace(/\./g,'').replace(',','.'));}
function _nomCanon(name){
  const n=name.toLowerCase();
  if(/sentencia|regul\.?\s*sent/.test(n))return 'Regul. Sentencia';
  if(/^sueldo\b/.test(n)&&!/extra|liquidaci/.test(n))return 'Sueldo base';
  if(/^trienios\b/.test(n)&&!/extra|liquidaci/.test(n))return 'Trienios';
  if(/complemento\s*destino\b/.test(n)&&!/extra/.test(n))return 'Complemento Destino';
  if(/complemento\s*espec[ií]fico\b/.test(n)&&!/adic/.test(n))return 'Complemento Específico';
  // v157 · Una nómina de la Administración distingue «Productividad por Objetivos» de
  // «Productividad Remanente», y yo las estaba metiendo en el mismo cajón. En
  // octubre de 2025 venían las dos en la misma nómina (X + Y) y
  // salían sumadas en un único apunte de X€, que es justo la distinción
  // que hacía falta para saber qué parte es aleatoria.
  if(/prod\.?\s*objetivos\s*a\s*cuenta/.test(n))return 'Prod. Objetivos a cuenta';
  if(/productividad.*remanente|remanente.*productividad/.test(n))return 'Productividad Remanente';
  if(/productividad.*objetivos|objetivos.*productividad/.test(n))return 'Productividad por Objetivos';
  if(/productividad/.test(n))return 'Productividad';
  if(/extra|adicional|liquidaci/.test(n))return 'Paga extra / liquidación';
  return name.trim();
}
function parseNominaLines(lines){
  let ym=null,irpf_pct=null,liquido=null,A=null,B=null;
  const dev={},ded={};
  for(const raw of lines){
    const l=raw.replace(/\s+/g,' ').trim();
    let m=l.match(/N[óo]mina\s+mensual\s+de\s+(\w+)\s+del\s+(\d{4})/i);
    if(m){const mo=_NOM_MESES[m[1].toLowerCase()];if(mo)ym=m[2]+'-'+String(mo).padStart(2,'0');}
    if(!ym){let mr=l.match(/RETROACTIVA\s+DE\s+(\w+)\s+(?:DE\s+)?(\d{4})/i);if(mr){const mo=_NOM_MESES[mr[1].toLowerCase()];if(mo)ym=mr[2]+'-'+String(mo).padStart(2,'0');}}
    const pm=l.match(/i\.?r\.?p\.?f\.?[^(]*\((\d+[.,]\d+)\s*%?\)/i);if(pm)irpf_pct=parseFloat(pm[1].replace(',','.'));
    let lm=l.match(/l[ií]quido\s*percibir\s*\(a-?b\)\s*:?\s*(-?\d[\d.]*,\d{2})/i);if(lm)liquido=_pN(lm[1]);
    let am=l.match(/a[-.]total\s*devengado\s*:?\s*(-?\d[\d.]*,\d{2})/i);if(am)A=_pN(am[1]);
    let bm=l.match(/b[-.]total\s*deducir\s*:?\s*(-?\d[\d.]*,\d{2})/i);if(bm)B=_pN(bm[1]);
    const clean=l.replace(/\([^)]*\)/g,' ');
    const nums=[...clean.matchAll(/(-?\d{1,3}(?:\.\d{3})*,\d{2})/g)].map(x=>x[1]);
    if(nums.length!==1)continue;
    let name=clean.replace(/(-?\d{1,3}(?:\.\d{3})*,\d{2})/g,'').replace(/:/g,'').trim();
    if(!name||_SKIP_RX.test(name)||_nomIgnora(name))continue;
    const val=_pN(nums[0]);
    const bucket=_DED_RX.some(rx=>rx.test(name))?ded:dev;
    const key=_nomCanon(name);
    bucket[key]=(bucket[key]||0)+val;
  }
  const devengos=Object.entries(dev).map(([name,amount])=>({name,amount:Math.round(amount*100)/100})).filter(d=>Math.abs(d.amount)>0.001);
  const deducciones=Object.entries(ded).map(([name,amount])=>({name,amount:Math.round(amount*100)/100})).filter(d=>Math.abs(d.amount)>0.001);
  if(A==null)A=Math.round(devengos.reduce((s,d)=>s+d.amount,0)*100)/100;
  if(B==null)B=Math.round(deducciones.reduce((s,d)=>s+d.amount,0)*100)/100;
  if(liquido==null)liquido=Math.round((A-B)*100)/100;
  const muface=deducciones.filter(d=>/muface/i.test(d.name)).reduce((s,d)=>s+d.amount,0);
  const dp=deducciones.filter(d=>/pasivos/i.test(d.name)).reduce((s,d)=>s+d.amount,0);
  const irpf=Math.round((B-muface-dp)*100)/100;
  return {ym,liquido,nd:{total_dev:A,total_ded:B,devengos,deducciones,irpf_pct,irpf_importe:irpf}};
}
let _pdfjsReady=false;
function loadPdfJs(){
  return new Promise((resolve,reject)=>{
    if(_pdfjsReady&&window.pdfjsLib){resolve();return;}
    const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload=()=>{try{window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';_pdfjsReady=true;resolve();}catch(e){reject(e);}};
    s.onerror=()=>reject(new Error('offline'));
    document.head.appendChild(s);
  });
}
async function extractPdfLines(file){
  const buf=await file.arrayBuffer();
  const pdf=await pdfjsLib.getDocument({data:new Uint8Array(buf)}).promise;
  const lines=[];
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p);
    const tc=await page.getTextContent();
    const rows={};
    tc.items.forEach(it=>{const y=Math.round(it.transform[5]);(rows[y]=rows[y]||[]).push({x:it.transform[4],s:it.str});});
    Object.keys(rows).map(Number).sort((a,b)=>b-a).forEach(y=>{
      const line=rows[y].sort((a,b)=>a.x-b.x).map(o=>o.s).join(' ').replace(/\s+/g,' ').trim();
      if(line)lines.push(line);
    });
  }
  return lines;
}
// v168 · Los trozos de texto del PDF con su posición en la página (x, y en
// puntos, la y hacia arriba), para las tablas que no se leen por renglones
async function extractPdfItems(file){
  const buf=await file.arrayBuffer();
  const pdf=await pdfjsLib.getDocument({data:new Uint8Array(buf)}).promise;
  const out=[];
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p);
    const tc=await page.getTextContent();
    tc.items.forEach(it=>{
      const t=it.transform||[], s=String(it.str||'').replace(/\u00a0/g,' ').trim();
      if(!s)return;
      // el texto girado del margen (los datos del registro mercantil) no es de la tabla
      if(Math.abs(t[1]||0)>0.01||Math.abs(t[2]||0)>0.01)return;
      out.push({p,x:t[4],y:t[5],w:it.width||0,h:Math.abs(t[3]||0)||it.height||0,s});
    });
  }
  return out;
}
// v158 · Antes, si el mes ya tenía desglose, la nómina se daba por buena y se
// omitía. Eso impedía justo lo que hacía falta hoy: volver a leer una nómina
// que se importó con un lector peor. El PDF es la fuente, así que si vuelves a
// subirlo, manda él. Se busca el apunte del mismo mes que corresponda a ESA
// nómina —por el devengado o por el líquido, que es lo que las distingue
// cuando hay dos en un mes— y se le refresca el desglose. El importe cobrado
// no se toca: eso ya está en tu cuenta y en tus totales.
function nominaAddOrEnrich(ym,desc,liquido,nd){
  const existing=incomeLog.filter(e=>String(e.date||'').startsWith(ym)&&e.cat==='nomina');
  if(existing.length){
    const tot=nd&&nd.total_dev;
    let t=null;
    if(tot!=null) t=existing.find(e=>e.nd&&Math.abs((e.nd.total_dev||0)-tot)<0.02);
    if(!t&&liquido!=null) t=existing.find(e=>Math.abs((e.amt||0)-liquido)<0.02);
    if(!t) t=existing.find(e=>!e.nd||!e.nd.devengos||!e.nd.devengos.length);
    if(t){
      const tenia=!!(t.nd&&t.nd.devengos&&t.nd.devengos.length);
      const igual=tenia&&JSON.stringify(t.nd)===JSON.stringify(nd);
      if(igual)return 'ya estaba igual';
      // El líquido de una nómina puede estar repartido en varios apuntes de
      // ingreso (la paga llega en varias transferencias). Todos cuelgan del
      // mismo desglose, así que se refrescan todos: dejar uno viejo significa
      // que los cálculos siguen leyendo la versión antigua.
      const tot=Number(nd&&nd.total_dev);
      let tocados=0;
      existing.forEach(e=>{
        const mismo=(e===t)||(e.nd&&tot!=null&&Math.abs((Number(e.nd.total_dev)||0)-tot)<0.02);
        if(mismo){e.nd=nd;tocados++;}
      });
      nominaSyncHist(ym,nd,t.amt);
      return (tenia?'actualizada':'enriquecida')+(tocados>1?(' ×'+tocados):'');
    }
    // mismo mes pero ninguna casa: es otra nómina de ese mes (una retroactiva,
    // una liquidación), así que entra como apunte nuevo en vez de perderse
    incomeLog.push({id:'inc_nom_'+ym.replace('-','')+'_'+Date.now(),date:ym+'-28',desc:desc,cat:'nomina',amt:liquido,nd:nd});
    return 'añadida (otra nómina del mismo mes)';
  }
  incomeLog.push({id:'inc_nom_'+ym.replace('-','')+'_'+Date.now(),date:ym+'-28',desc:desc,cat:'nomina',amt:liquido,nd:nd});
  return 'añadida';
}
// el histórico de «personal» se deja igual que el ingreso, para que no haya
// dos versiones de la misma nómina contándose cosas distintas
function nominaSyncHist(ym,nd,amt){
  try{
    const H=NOM_HIST();
    const tot=Number(nd&&nd.total_dev)||0;
    let t=H.find(x=>String(x.ym||'').slice(0,7)===ym&&Math.abs((Number(x.nd&&x.nd.total_dev)||0)-tot)<0.02);
    if(!t)t=H.find(x=>String(x.ym||'').slice(0,7)===ym&&Math.abs((Number(x.amt)||0)-(Number(amt)||0))<0.02);
    if(t)t.nd=nd; else H.push({ym,amt,nd});
    personal.nominasHist=H; savePersonal();
  }catch(e){console.warn('sync nóminas',e);}
}
async function handleNominaPdfs(ev){
  const files=[...(ev.target.files||[])]; ev.target.value='';
  if(!files.length)return;
  toast('Leyendo '+files.length+' PDF'+(files.length>1?'s':'')+'…');
  try{ await loadPdfJs(); }
  catch(e){ alert('No se pudo cargar el lector de PDF.\n\nEsta función necesita conexión a internet la primera vez (para cargar pdf.js). Conéctate y vuelve a intentarlo, o pásame el PDF por el chat y lo proceso yo.'); return; }
  const res=[]; let ok=0;
  const extractos=[];
  for(const f of files){
    try{
      const lines=await extractPdfLines(f);
      // v168 · Si no es una nómina sino el extracto del banco en PDF (Trade
      // Republic, Openbank), se importa como extracto en vez de dar error: al
      // soltar un PDF, lo primero que se ofrece es leerlo como nómina.
      if(trEsExtracto(lines)||obEsExtracto(lines)){
        extractos.push(f); res.push('→ '+f.name+': no es una nómina, es un extracto del banco. Se importa como tal.'); continue;
      }
      const r=parseNominaLines(lines);
      if(!r.ym){res.push('✗ '+f.name+': no se detectó el mes');continue;}
      const st=nominaAddOrEnrich(r.ym,'Nómina '+r.ym,r.liquido,r.nd);
      res.push('✓ '+r.ym+' — líquido '+fmt(r.liquido)+'€ ('+st+')'); ok++;
    }catch(err){ res.push('✗ '+f.name+': error leyendo el PDF'); }
  }
  if(ok>0){ save(); if(typeof renderAll==='function')renderAll(); }
  if(res.length>extractos.length)
    alert('Nóminas PDF procesadas:\n\n'+res.join('\n')+'\n\nRevisa la pestaña Impuestos y el detalle de ingresos.');
  for(const f of extractos){
    try{ _bankTR=false; _bankHint=null; processBankRows(await bankFilasPdf(f)); }
    catch(err){ alert('No pude leer el extracto '+f.name+': '+(err&&err.message||err)); }
  }
}




// ── Reconstruir patrimonio 2015-2018 en records (Dashboard) ─────────

function importData(ev){
  const file=ev.target.files&&ev.target.files[0];
  if(!file)return;
  const reader=new FileReader();
  reader.onload=function(e){
    try{
      const data=JSON.parse(e.target.result);
      if(!data||(!data.cfg&&!data.records&&!data.balanceLog)){
        toast('El archivo no parece un backup válido');return;
      }
      const resumen='El archivo trae: '+((data.records||[]).length)+' meses · '+((data.expenseLog||[]).length)+' gastos · '+
        ((data.incomeLog||[]).length)+' ingresos · '+((data.transactions||[]).length)+' operaciones'+
        (data._exported?'\nExportado el '+data._exported.slice(0,10):'');
      const ahora='Ahora tienes: '+records.length+' meses · '+expenseLog.length+' gastos · '+incomeLog.length+' ingresos · '+transactions.length+' operaciones';
      // v133 · El fallo del método "el archivo de la carpeta manda" es olvidarse
      // de generarlo al terminar en el otro aparato. Entonces restauras encima
      // una foto anterior a tu propio trabajo y lo borras sin enterarte. Aquí
      // se compara la fecha del archivo con la del último cambio local.
      let _avisoViejo='';
      try{
        const _lc=ALM.getItem('dlv_lastchange'), _fe=data._exported||null;
        if(_lc&&_fe&&_fe<_lc&&(records.length||expenseLog.length||incomeLog.length)){
          const _h=Math.round((Date.parse(_lc)-Date.parse(_fe))/36e5);
          _avisoViejo='\n\n⚠️  OJO: ESTE ARCHIVO ES MÁS ANTIGUO QUE LO QUE TIENES AQUÍ.\n'+
            'El archivo se generó el '+_fe.slice(0,10)+' y en este aparato hay cambios posteriores'+
            (_h>0?' ('+(_h<48?_h+' horas':Math.round(_h/24)+' días')+' después)':'')+'.\n'+
            'Si continúas, perderás lo que hiciste aquí desde entonces.\n'+
            'Si no estás seguro, cancela y usa «Sincronizar»: junta los dos lados sin borrar nada.';
        }
      }catch(e){fallo('motor',e)}
      if(!confirm('Esto SUSTITUIRÁ todos tus datos actuales por los del archivo.\n\n'+ahora+'\n'+resumen+_avisoViejo+'\n\n¿Continuar?')){
        ev.target.value='';return;
      }
      if(!guardedAction('restaurar copia'+(data._exported?' del '+data._exported.slice(0,10):''))){ev.target.value='';return;}
      if(data.cfg)cfg=data.cfg;
      if(!cfg.gastos_fijos||!cfg.gastos_fijos.length)cfg.gastos_fijos=[...DEF_GASTOS_FIJOS];
      if(cfg.customCats)Object.assign(CAT_LABELS,cfg.customCats);
      if(!cfg.brokers)cfg.brokers=[];
      if(data.records)records=data.records;
      if(data.transactions)transactions=data.transactions;
      if(data.soldStocks)soldStocks=new Set(data.soldStocks);
      if(data.balanceLog)balanceLog=data.balanceLog;
      if(data.incomeLog)incomeLog=data.incomeLog;
      if(data.expenseLog)expenseLog=data.expenseLog;
      if(data.brokerFlows)brokerFlows=data.brokerFlows;
      if(data.reembolsos)reembolsos=data.reembolsos;
      if(data.personal)setPersonal(data.personal,'replace');
      migrateFundIdent();
      recomputeAllStockGains();
      save();
      renderAll();
      goToCurrentMonth();
      // El aparato queda con la antigüedad del archivo, no con la de hoy: si no,
      // el siguiente archivo bueno parecería viejo y avisaría sin motivo.
      try{ if(data._exported)ALM.setItem('dlv_lastchange',data._exported); }catch(e){fallo('if',e)}
      toast('✅ Datos restaurados desde el archivo'+(data._exported?' ('+data._exported.slice(0,10)+')':''));
    }catch(err){
      toast('Error al leer el archivo: '+err.message);
    }
    ev.target.value='';
  };
  reader.readAsText(file);
}
function load(){
  loadPersonal();
  try{
    const c=ALM.getItem('dlv_cfg');
    const r=ALM.getItem('dlv_records');
    const tx=ALM.getItem('dlv_tx');
    const sol=ALM.getItem('dlv_sold');
    if(c)cfg=JSON.parse(c);
    // Ensure gastos_fijos exists (backward compat)
    if(!cfg.gastos_fijos||!cfg.gastos_fijos.length) cfg.gastos_fijos=[...DEF_GASTOS_FIJOS];
    // Merge user-defined categories into the effective labels
    if(cfg.customCats) Object.assign(CAT_LABELS,cfg.customCats);
    if(r&&JSON.parse(r).length>0)records=JSON.parse(r);
    else records=SEED.map(parseSeed);
    if(tx)transactions=JSON.parse(tx);
    if(sol)soldStocks=new Set(JSON.parse(sol));
    const bl=ALM.getItem('dlv_ballog');
    if(bl)balanceLog=JSON.parse(bl);
    const il=ALM.getItem('dlv_income');
    if(il)incomeLog=JSON.parse(il);
    const el=ALM.getItem('dlv_expense');
    if(el)expenseLog=JSON.parse(el);
    const bf=ALM.getItem('dlv_brokerflows');
    if(bf)brokerFlows=JSON.parse(bf);
    const rb=ALM.getItem('dlv_reembolsos');
    if(rb)reembolsos=JSON.parse(rb);
  }catch(e){records=SEED.map(parseSeed);}
  sanearTextos();      // v169 · lo que ya estuviera guardado con «<» o «>»
  // Migrate/repair: recompute all stock sell cost bases with FIFO
  try{recomputeAllStockGains();}catch(e){console.warn('recompute error',e);}
  // One-time rename: Plan Pensiones Cobas → AZ Valor Internacional
  try{
    if(!ALM.getItem('dlv_mig_azvalor')){
      const f=cfg.funds.find(x=>x.id==='pp_cobas');
      if(f&&/plan\s*pensiones\s*cobas/i.test(f.name)){ f.name='AZ Valor Internacional'; save(); }
      ALM.setItem('dlv_mig_azvalor','1');
    }
  }catch(e){fallo('if',e)}
  // v150 · Deshacer el reparto por bróker que hizo la v149, que se basaba en un
  // src en el que no se podía confiar. Los apuntes que escribe la v149 en
  // adelante llevan el bróker dentro del propio id ('bal_pf_<acción>_<bróker>_
  // <fecha>'), así que los que tienen bróker pero no lo llevan en el id son
  // justo los que estampó aquella migración: se les quita y vuelven a ser lo
  // que eran, apuntes heredados sin bróker.
  try{
    if(!ALM.getItem('dlv_mig_brk2')){
      let deshechos=0;
      balanceLog.forEach(b=>{
        if(b.refType!=='stock'||!b.brk)return;
        if(String(b.id||'').indexOf(b.brk)<0){ delete b.brk; deshechos++; }
      });
      if(deshechos)save();
      ALM.setItem('dlv_mig_brk2','1');
      ALM.removeItem('dlv_mig_brk');
    }
  }catch(e){console.warn('mig brk2',e);}
  // Remove phantom stocks left over from old versions (no ops, no value)
  try{const n=cleanupOrphanStocks();if(n>0){save();}}catch(e){console.warn('cleanup error',e);}
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════
// v110 · Con la app recién estrenada (sin ningún mes guardado) last() devolvía
// undefined y renderFormLists reventaba al abrir "Datos entrada": pantalla en
// blanco y ni un aviso. Ahora devuelve un mes vacío, siempre uno nuevo para que
// nadie pueda ensuciarlo por accidente.
function recordVacio(){
  const t=new Date();
  return {id:'',label:'',year:t.getFullYear(),month:t.getMonth()+1,
    accounts_data:{},funds_data:{},stocks_data:{},debts_data:{},rendimientos:[],
    cash:0,fondos:0,acc:0,deuda:0,ing:0,gas:0,aho:0,pat:0,vacio:true};
}
const last=()=>records.length?records[records.length-1]:recordVacio();
const prevRec=()=>records.length>1?records[records.length-2]:null;

// ─── BALANCE LOG (date-stamped balances for accounts & funds) ────────
// v110 · Con DOS apuntes del mismo día ganaba el más antiguo. sort() es estable
// en JavaScript, así que a igualdad de fecha se quedaba arriba el primero que
// se insertó: corregías el saldo de hoy, se guardaba bien, y la app seguía
// enseñando el de antes. Ahora, a igual fecha, manda el último registrado.
// ════════════════════════════════════════════════════════════════════
// v149 · LA MISMA ACCIÓN EN VARIOS BRÓKERS
// ════════════════════════════════════════════════════════════════════
// Hasta aquí una acción tenía UNA valoración por fecha. Con una misma acción en DEGIRO
// y en XTB eso se rompía sin avisar: importabas DEGIRO y quedaban X€,
// importabas XTB y el mismo apunte se sobrescribía con X€. No se sumaban:
// el segundo borraba al primero, y el patrimonio salía X€ corto con
// toda la pinta de estar bien.
//
// Ahora cada valoración lleva el bróker del que viene (brk) y el valor de la
// acción es la SUMA de la última valoración de cada bróker. Una valoración
// escrita a mano no lleva bróker: si es posterior a todas las de los brókers
// se entiende que es el total y manda ella, que es lo que uno espera cuando
// escribe una cifra a mano.
// v150 · Aquí metí la pata en la v149 y el resultado fue una acción al +92%.
// Las valoraciones viejas no dicen de qué bróker vienen: el importador escribía
// src:'degiro' a pelo, viniera de donde viniera. Al repartirlas por ese src,
// las de XTB acabaron en el saco de DEGIRO; después una importación de XTB
// añadía su propio saco y la misma valoración se contaba DOS VECES —X
// más X sobre Y invertido son exactamente ese +92%.
//
// Ya no se adivina nada. Un apunte sin bróker que venga de una importación
// vieja es historia: en cuanto la acción tiene aunque sea un saco con bróker
// del mismo día o posterior, ese apunte heredado deja de contar. Un apunte
// escrito a mano es otra cosa —lo escribiste tú— y si es el más reciente, manda
// como total.
const SRC_IMPORT=/^(degiro|xtb|portfolio)$/i;
function stockPartes(stockId,hasta){
  const e=getBalanceEntries('stock',stockId).filter(x=>!hasta||(x.date||'')<=hasta);
  if(!e.length)return {total:null,partes:[],date:null};
  const grupos={};
  e.forEach(x=>{const k=x.brk||'';if(!grupos[k])grupos[k]=x;});   // ya vienen de más nueva a más vieja
  const conBrk=Object.keys(grupos).filter(k=>k);
  let suelta=grupos[''];
  if(!conBrk.length)return {total:suelta.amount,partes:[{brk:'',name:'',amount:suelta.amount,date:suelta.date,src:suelta.src}],date:suelta.date};
  const masNueva=conBrk.reduce((d,k)=>(grupos[k].date>d?grupos[k].date:d),'');
  const heredado=suelta&&SRC_IMPORT.test(String(suelta.src||''));
  if(heredado&&suelta.date<=masNueva)suelta=null;    // ya lo sustituyen los sacos por bróker
  if(suelta&&suelta.date>=masNueva&&!heredado)       // cifra a mano: es el total
    return {total:suelta.amount,partes:[{brk:'',name:'a mano',amount:suelta.amount,date:suelta.date,src:suelta.src}],date:suelta.date,manual:true};
  if(suelta&&suelta.date>masNueva)
    return {total:suelta.amount,partes:[{brk:'',name:'a mano',amount:suelta.amount,date:suelta.date,src:suelta.src}],date:suelta.date,manual:true};
  const partes=conBrk.map(k=>({brk:k,name:((cfg.brokers||[]).find(b=>b.id===k)||{}).name||'bróker',
                               amount:grupos[k].amount,date:grupos[k].date,src:grupos[k].src}))
                     .sort((a,b)=>b.amount-a.amount);
  return {total:partes.reduce((s,x)=>s+(x.amount||0),0),partes,date:masNueva};
}
function stockValor(stockId,hasta){ const p=stockPartes(stockId,hasta); return p.total; }
function getBalanceEntries(refType,refId){
  const out=[];
  balanceLog.forEach((e,i)=>{if(e.refType===refType&&e.refId===refId)out.push([e,i]);});
  out.sort((a,b)=>(b[0].date||'').localeCompare(a[0].date||'')||(b[1]-a[1]));
  return out.map(x=>x[0]);
}
function getBalanceAsOf(refType,refId,year,month){
  const end=year+'-'+String(month).padStart(2,'0')+'-31';
  if(refType==='stock')return stockValor(refId,end);    // v149 · suma de brókers
  const e=getBalanceEntries(refType,refId).filter(x=>(x.date||'')<=end); // v110 · mismo desempate
  return e.length?e[0].amount:null;
}

function getBrokerLiq(r){
  // Efectivo en el bróker. Cuenta SIEMPRE como cash, nunca como parte de la cartera de acciones.
  if(r.broker_liq!=null) return r.broker_liq;
  if(r.year&&r.month) return getBrokerLiquidityAsOf(r.year,r.month);
  return getBrokerLiquidityNow();
}
function getCash(r){
  const base=r.accounts_data?Object.values(r.accounts_data).reduce((s,v)=>s+(v||0),0):(r.cash||0);
  return base+getBrokerLiq(r); // la liquidez del bróker es cash
}
function getFondos(r){
  if(r.funds_data){return Object.values(r.funds_data).reduce((s,v)=>s+(v.vl||0),0);}
  return r.fondos||0;
}
function getAcc(r){
  // Solo posiciones de acciones. La liquidez del bróker NO se cuenta aquí (es cash, ver getCash).
  if(r.stocks_data){return Object.values(r.stocks_data).reduce((s,v)=>s+(v||0),0);}
  return (r.acc||0)-((r.broker_liq!=null)?r.broker_liq:0);
}
function getDeuda(r){
  if(r.debts_data){return Object.values(r.debts_data).reduce((s,v)=>s+(v||0),0);}
  return r.deuda||0;
}
function avgAho(n_=24){
  // v126 · desde los apuntes, no desde los números guardados a mano
  const M=(typeof ahorroMonthly==='function')?ahorroMonthly():[];
  if(M.length){const sl=M.slice(-n_);return sl.reduce((s,x)=>s+x.savings,0)/sl.length;}
  const sl=records.slice(-n_);
  return sl.length?sl.reduce((s,r)=>s+(r.aho||0),0)/sl.length:0;
}
// v147 · El tipo mensual era anual/12, que compuesto doce veces da MÁS del
// anual que has escrito: un 8% se convertía en un 8,30% real. Parece poco y no
// lo es — sobre 100.000€ a 25 años son 49.000€ que no existen. El mensual
// equivalente de verdad es la raíz doceava, no la doceava parte.
function project(pat,aho,rate,months){
  const r=Math.pow(1+rate,1/12)-1;
  return Array.from({length:months},(_,i)=>{
    const n_=i+1;
    return Math.round(pat*Math.pow(1+r,n_)+aho*(Math.pow(1+r,n_)-1)/r);
  });
}
function nextLabel(l){
  const[ab,yy]=l.split('-');const m=MN.indexOf(ab);const nm=(m+1)%12;
  return MN[nm]+'-'+(nm===0?String(+yy+1):yy);
}

// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD — KPIs & CHARTS
// ═══════════════════════════════════════════════════════════════════════
function renderKPIs(){
  const lr=getDashRecord();
  const isLatest=(dashViewIdx<0||dashViewIdx===records.length-1);
  // Find comparison record: same month previous year
  const prevYear=records.find(r=>r.year===lr.year-1&&r.month===lr.month)
    ||records.find(r=>r.year*100+r.month<lr.year*100+lr.month);
  const cash=getCash(lr),fondos=getFondos(lr),acc=getAcc(lr),deuda=getDeuda(lr);
  // Recompute from components so broker liquidity (part of acc) is always included
  const pat=cash+fondos+acc-deuda;
  const prevPat=prevYear?(getCash(prevYear)+getFondos(prevYear)+getAcc(prevYear)-getDeuda(prevYear)):null;
  const dpat=prevPat!==null?pat-prevPat:null;
  const pct=prevPat?Math.round(dpat/prevPat*100):null;
  // v104: los apuntes mandan. records[] se quedó en Ene-26 y hacía pasar
  // feb-25/ene-26 por "los últimos 12 meses".
  let aho12,aho12sub;
  (function(){
    const R=(typeof ahorroReal12==='function')?ahorroReal12():null;
    if(R&&R.n>=3){
      aho12=R.total;
      const P=ahorroPartido();
      aho12sub=fmt(Math.round(R.total/R.n))+'€/mes · '+fmt(Math.round(P?P.recMes:R.total/R.n))+'€ recurrente';
      const _e=(typeof ahorroExtraCorta==='function')?ahorroExtraCorta(R.desde,R.hasta):'';
      if(_e)aho12sub+=' · '+_e;
    }else{
      const end=dashViewIdx<0?records.length-1:dashViewIdx;
      const start=Math.max(0,end-11);
      aho12=records.slice(start,end+1).reduce((s,r)=>s+(r.aho||0),0);
      aho12sub=fmt(Math.round(aho12/12))+'€/mes media';
    }
  })();

  document.getElementById('hdr-pat').textContent=fmt(pat)+'€';
  try{
    const bn=bienesNetos(), el=document.getElementById('hdr-pat-total');
    if(el)el.textContent=bn.total>0?('con vivienda y coche: '+fmt(pat+bn.total)+'€'):'';
  }catch(e){fallo('bn',e)}
  try{renderCuadre();}catch(e){console.warn('cuadre',e);}
  document.getElementById('hdr-date').textContent=lr.label+(isLatest?' · actual':'');

  // Update selectors to match current view
  const ysel=document.getElementById('dash-year');
  const msel=document.getElementById('dash-month');
  if(ysel){
    const years=[...new Set(records.map(r=>r.year))].sort((a,b)=>b-a);
    if(ysel.children.length===0||ysel.children.length!==years.length){
      ysel.innerHTML=years.map(y=>`<option value="${y}">${y}</option>`).join('');
    }
    ysel.value=lr.year;
  }
  if(msel) msel.value=lr.month;

  const lbl=document.getElementById('dash-period-label');
  const today=new Date();
  const isCurrentMonth=(lr.year===today.getFullYear()&&lr.month===today.getMonth()+1);
  let periodNote='';
  if(lr.isLive){
    periodNote=' · datos actuales (saldos sin cerrar el mes)';
  } else if(isLatest&&!isCurrentMonth){
    periodNote=' · último registro disponible';
  } else if(isLatest&&isCurrentMonth){
    periodNote=' · mes actual';
  }
  if(lbl) lbl.textContent=lr.label+periodNote;

  const patSub=dpat!==null
    ?((dpat>=0?'+':'')+fmt(dpat)+'€  ·  '+(pct>=0?'+':'')+pct+'%  vs mismo mes año ant.')
    :'primer registro';
  const patSc=dpat!==null?(dpat>=0?'pos':'neg'):'';

  const kpis=[
    {id:'patrimonio',l:'Patrimonio financiero',v:fmt(pat)+'€',
      sub:patSub,sc:patSc,col:'navy',detail:'patrimonio'},
    {id:'cash',l:'Liquidez cash',v:fmt(cash)+'€',
      sub:Math.round(cash/(pat||1)*100)+'% del total',col:'teal',detail:'cash'},
    {id:'inv',l:'Fondos + acciones',v:fmt(fondos+acc)+'€',
      sub:'fondos '+fmt(fondos)+'€ · acc '+fmt(acc)+'€',col:'purple',detail:'inv'},
    {id:'ing',l:'Ingresos mes',v:fmt(lr.ing||0)+'€',
      sub:'gastos: '+fmt(lr.gas||0)+'€',col:'gold',detail:null},
    {id:'aho12',l:'Ahorro 12 meses',v:fmt(aho12)+'€',
      sub:aho12sub,col:'teal',detail:null},
    {id:'aho1',l:'Ahorro mes',v:fmt(lr.aho||0)+'€',
      sub:(function(){
        const ym=lr.year+'-'+String(lr.month).padStart(2,'0');
        const e=(typeof ahorroExtraCorta==='function')?ahorroExtraCorta(ym,ym):'';
        const ap=lr.ap?'♦ Aportación: +'+fmt(lr.aamt||0)+'€':'';
        return e?(ap?ap+' · '+e:e):ap;
      })(),col:'amber',detail:null},
  ];

  document.getElementById('kpi-grid').innerHTML=kpis.map(k=>`
    <div class="kpi ${k.col}${expandedKPI===k.id?' expanded':''}"
      onclick="toggleKPI('${k.id}','${k.detail||''}')">
      <div class="kpi-lbl">${k.l}
        ${k.detail?'<span class="kpi-arrow">▾</span>':''}
      </div>
      <div class="kpi-val">${k.v}</div>
      <div class="kpi-sub ${k.sc||''}">${k.sub}</div>
    </div>`).join('');

  renderKPIDetail(expandedKPI);
}

function toggleKPI(id,detail){
  if(!detail){return;}
  expandedKPI=(expandedKPI===id)?null:id;
  renderKPIs();
}

function renderKPIDetail(id){
  const box=document.getElementById('kpi-details');
  if(!id){box.innerHTML='';return;}
  const lr=getDashRecord();
  const lrIdx=dashViewIdx<0?records.length-1:dashViewIdx;
  const cash=getCash(lr),fondos=getFondos(lr),acc=getAcc(lr),total=getCash(lr)+getFondos(lr)+getAcc(lr)||1;
  const pr=(dashViewIdx===-2)?last():(lrIdx>0?records[lrIdx-1]:null);
  const prevCash=pr?getCash(pr):0,prevFondos=pr?getFondos(pr):0,prevAcc=pr?getAcc(pr):0;

  let rows='',title='';

  const today=new Date();
  const staleThreshold=isoLocal(new Date(today.getTime()-35*864e5));

  if(id==='cash'||id==='patrimonio'){
    title='Desglose de liquidez';
    cfg.accounts.forEach(a=>{
      const info=getAccountInfo(a.id);
      const prev=pr?.accounts_data?.[a.id]||0;
      const delta=info.amount-prev;
      const dateStr=fmtDate(info.date);
      const isStale=info.source==='log'?(info.date<staleThreshold):true;
      const dateColor=info.source==='none'?'var(--red)':(isStale?'var(--amber)':'var(--teal)');
      const dateNote=info.source==='none'?'sin registrar':(dateStr+(isStale?' ⚠':''));
      rows+=`<tr>
        <td>${a.name}</td>
        <td><strong>${info.amount>0?fmt(info.amount)+'€':'—'}</strong></td>
        <td colspan="2" style="font-size:11px;color:${dateColor}">Actualizado: ${dateNote}</td>
        <td style="color:var(--faint);font-size:11px">liquidez</td>
        <td class="${delta>=0?'pos':'neg'}">${delta!==0?fmtE(delta):'—'}</td>
      </tr>`;
    });
  }

  if(id==='inv'||id==='patrimonio'){
    if(id==='patrimonio') rows+='<tr><td colspan="6" style="background:var(--surface2);padding:.4rem 1rem;font-size:10.5px;font-weight:700;text-transform:uppercase;color:var(--muted)">FONDOS DE INVERSIÓN</td></tr>';
    // ── FUNDS: always show from cfg.funds, VL from latest record ──────────
    cfg.funds.forEach(f=>{
      const info=getFundVLInfo(f.id);
      const vl=info.amount||0;
      const invested=getFundInvested(f.id);
      const gain=vl-invested;
      const gainPct=invested>0?Math.round(gain/invested*100):0;
      const taxOnGain=calcIRPFGain(Math.max(0,gain));
      const effRate=gain>0?Math.round(effectiveIRPFRate(gain)*100):0;
      const vlAfterTax=vl-taxOnGain;
      const prevVL=pr?.funds_data?.[f.id]?.vl||0;
      const delta=vl-prevVL;
      const dateStr=fmtDate(info.date);
      const isStale=info.source==='log'?(info.date<staleThreshold):true;
      const dateColor=info.source==='none'?'var(--red)':(isStale?'var(--amber)':'var(--teal)');
      const dateNote=info.source==='none'?'sin registrar':('VL '+dateStr+(isStale?' ⚠':''));
      rows+=`<tr>
        <td>${f.name}<br><small style="color:var(--faint)">Invertido: ${fmt(invested)}€</small></td>
        <td>
          <strong>${vl>0?fmt(vl)+'€':'—'}</strong><br><small style="color:${dateColor}">${dateNote}</small>
        </td>
        <td class="${gain>=0?'pos':'neg'}">${fmtE(gain)}<br><small>${gainPct>0?'+':''}${gainPct}%</small></td>
        <td style="color:var(--red);font-size:12px">${effRate>0?effRate+'%<br><small>'+fmt(taxOnGain)+'€</small>':'—'}</td>
        <td class="${vlAfterTax>=invested?'pos':'neg'}">${vl>0?fmt(vlAfterTax)+'€':'—'}</td>
        <td class="${delta>=0?'pos':'neg'}">${delta!==0?fmtE(delta):'—'}</td>
      </tr>`;
    });

    if(id==='patrimonio') rows+='<tr><td colspan="6" style="background:var(--surface2);padding:.4rem 1rem;font-size:10.5px;font-weight:700;text-transform:uppercase;color:var(--muted)">ACCIONES — POSICIONES ABIERTAS</td></tr>';
    // ── STOCKS: grouped by company, open positions ────────────────────────
    const agg=getStockAggregates();
    const openStocks=cfg.stocks.filter(s=>agg[s.id]&&agg[s.id].totalShares>1e-6&&!agg[s.id].isClosed);
    openStocks.forEach(s=>{
      const a=agg[s.id];
      const sInfo=getStockInfo(s.id);
      const val=sInfo.amount||a.currentVal||0;
      const prevVal=pr?.stocks_data?.[s.id]||0;
      const delta=val-prevVal;
      const hasBuys=a.totalBoughtShares>0;
      const costBasis=hasBuys?a.totalBoughtValue*(a.totalShares/a.totalBoughtShares):0;
      const gain=hasBuys&&val>0?val-costBasis:null;
      const taxOnGain=gain!==null&&gain>0?calcIRPFGain(gain):0;
      const valAfterTax=val-taxOnGain;
      const dateStr=fmtDate(sInfo.date);
      const isStale=sInfo.source==='record'?true:(sInfo.date?sInfo.date<staleThreshold:true);
      const dateColor=sInfo.source==='none'?'var(--red)':(isStale?'var(--amber)':'var(--teal)');
      const dateNote=sInfo.source==='none'?'sin valorar':(dateStr+(isStale?' ⚠':''));
      rows+=`<tr>
        <td>${s.name}${s.existing?'<br><small style="color:var(--faint)">sin datos de compra</small>':
          hasBuys?`<br><small style="color:var(--muted)">${fmt(a.totalShares)} acc × ${fmt(a.avgPriceRest||a.avgPrice)}€ medio · ${fmt(a.costeRestante||a.totalBoughtValue)}€ de coste vivo</small>`:''}
        </td>
        <td>
          <strong>${val>0?fmt(val)+'€':'—'}</strong><br><small style="color:${dateColor}">${dateNote}</small>
        </td>
        <td>${gain!==null?`<span class="${gain>=0?'pos':'neg'}">${fmtE(gain)}</span><br><small>${Math.round(gain/(costBasis||1)*100)}%</small>`:
          '<span style="color:var(--faint)">—</span>'}</td>
        <td style="color:var(--red);font-size:12px">${gain!==null&&gain>0?
          Math.round(effectiveIRPFRate(gain)*100)+'%<br><small>'+fmt(taxOnGain)+'€</small>':'—'}</td>
        <td>${gain!==null?fmt(valAfterTax)+'€':'—'}</td>
        <td class="${delta>=0?'pos':'neg'}">${delta!==0?fmtE(delta):'—'}</td>
      </tr>`;
    });

    // ── BROKER LIQUIDITY (counts as cash) ───────────────────────
    const brokers=cfg.brokers||[];
    const brokerTotal=getBrokerLiquidityNow();
    if(brokers.length&&brokerTotal>0){
      rows+='<tr><td colspan="6" style="background:#E6F4F1;padding:.4rem 1rem;font-size:10.5px;font-weight:700;text-transform:uppercase;color:var(--teal)">LIQUIDEZ EN BROKER (cuenta como cash)</td></tr>';
      brokers.forEach(b=>{
        const info=getBrokerInfo(b.id);
        const val=info.amount||0;
        if(val<=0)return;
        const dateStr=fmtDate(info.date);
        const isStale=info.source==='none'||(info.date&&info.date<staleThreshold);
        const dateColor=info.source==='none'?'var(--red)':(isStale?'var(--amber)':'var(--teal)');
        rows+=`<tr>
          <td>🏦 ${b.name}<br><small style="color:var(--faint)">liquidez sin invertir</small></td>
          <td><strong>${fmt(val)}€</strong><br><small style="color:${dateColor}">${info.source==='none'?'sin registrar':dateStr}</small></td>
          <td style="color:var(--faint)">—</td>
          <td style="color:var(--faint)">—</td>
          <td>${fmt(val)}€</td>
          <td style="color:var(--faint)">—</td>
        </tr>`;
      });
    }

    // ── CLOSED / SOLD POSITIONS grouped by year ───────────────────────────
    const closedStocks=cfg.stocks.filter(s=>agg[s.id]?.isClosed);
    const allSellTx=transactions.filter(t=>t.type==='sell');
    if(allSellTx.length>0){
      if(id==='patrimonio'||id==='inv'){
        rows+='<tr><td colspan="6" style="background:#FEF5E0;padding:.4rem 1rem;font-size:10.5px;font-weight:700;text-transform:uppercase;color:var(--amber)">OPERACIONES CERRADAS — por año de venta</td></tr>';
        // Group by year
        const byYear={};
        allSellTx.forEach(t=>{
          const y=t.year||(t.date?parseInt(t.date.slice(0,4)):0)||'?';
          if(!byYear[y])byYear[y]={txs:[],totalGain:0,irpf:0};
          byYear[y].txs.push(t);
          byYear[y].totalGain+=(t.gainLoss||0);
        });
        Object.entries(byYear).sort(([a],[b])=>b-a).forEach(([year,ydata])=>{
          const irpfY=calcIRPFGain(Math.max(0,ydata.totalGain));
          rows+=`<tr style="background:#FFFBE8"><td colspan="6" style="padding:.3rem 1rem;font-size:11px;font-weight:600;color:var(--amber)">
            Año ${year} · Plusvalías: <span class="${ydata.totalGain>=0?'pos':'neg'}">${fmtE(ydata.totalGain)}</span>
            · IRPF estimado: <span class="neg">${fmt(irpfY)}€</span>
          </td></tr>`;
          ydata.txs.forEach(t=>{
            const sname=t.stockName||(cfg.stocks.find(s=>s.id===t.stockId)?.name)||t.stockId;
            const costB=t.costBasis||0;
            const gl=t.gainLoss??0;
            rows+=`<tr>
              <td style="padding-left:1.5rem">↳ ${sname}<br><small style="color:var(--faint)">${t.date||''} · ${fmt(t.shares||0)} acc × ${fmt(t.price||0)}€</small></td>
              <td>${fmt(t.total||0)}€<br><small style="color:var(--faint)">ingreso neto</small></td>
              <td>${costB>0?`<small style="color:var(--muted)">coste ${fmt(costB)}€</small>`:'<small style="color:var(--faint)">sin coste base</small>'}</td>
              <td class="${gl>=0?'pos':'neg'}" style="font-weight:700">${fmtE(gl)}<br><small>${costB>0?Math.round(gl/costB*100)+'%':''}</small></td>
              <td style="color:var(--red);font-size:12px">${gl>0?fmt(calcIRPFGain(gl))+'€':gl<0?'Pérdida compensable':''}</td>
              <td style="color:var(--faint);font-size:11px">cerrada</td>
            </tr>`;
          });
        });
      }
    }
  }

  if(id==='patrimonio'){
    rows+=`<tr>
      <td><strong>TOTAL PATRIMONIO FINANCIERO</strong></td>
      <td><strong>${fmt(total)}€</strong></td>
      <td colspan="3" style="font-size:11px;color:var(--muted)"></td>
      <td class="${(total-(prevCash+prevFondos+prevAcc))>=0?'pos':'neg'}">
        <strong>${fmtE(total-(prevCash+prevFondos+prevAcc))}</strong>
      </td>
    </tr>`;
  }

  box.innerHTML=`
    <div class="kpi-detail open">
      <div class="detail-hdr">
        <span class="detail-title">${title||'Desglose'}</span>
        <span style="font-size:11px;color:var(--muted)">${lr.label} · Solo lectura · Cada valor muestra su fecha de actualización · Datos fiscales automáticos</span>
      </div>
      <div style="overflow-x:auto">
        <table class="detail-table">
          <thead><tr>
            <th style="text-align:left">Activo</th>
            <th>Valor actual</th>
            <th>Ganancia no realizada</th>
            <th>IRPF si se vende hoy</th>
            <th>VL neto de impuestos</th>
            <th>Var. vs mes ant.</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}


// ─── PROJECTION COMPONENT SELECTION ──────────────────────────────────
let projSel=null; // Set of selected component ids; null until first init (then all)

function getProjComponents(){
  const comps=[];
  const palette=['#0B3D91','#006D65','#7A1FA0','#B03060','#2A7A2A','#8A6D1A'];
  let ci=0;
  cfg.funds.forEach(f=>{
    comps.push({id:'fund:'+f.id,label:f.name,amount:getFundVLInfo(f.id).amount||0,color:palette[ci++%palette.length]});
  });
  const agg=getStockAggregates();
  let stocksVal=0;
  Object.values(agg).forEach(a=>{if(!a.isClosed)stocksVal+=(getStockInfo(a.id).amount||0);});
  comps.push({id:'stocks',label:'Acciones',amount:stocksVal,color:'#C0392B'});
  let cashVal=getBrokerLiquidityNow(); // la liquidez del bróker es cash
  cfg.accounts.forEach(a=>{cashVal+=(getAccountInfo(a.id).amount||0);});
  comps.push({id:'cash',label:'Liquidez cash',amount:cashVal,color:'#117A65'});   // v169 · con letra blanca encima se lee
  return comps;
}

function ensureProjSel(){
  const comps=getProjComponents();
  if(projSel===null) projSel=new Set(comps.map(c=>c.id)); // default: everything (real line = full patrimony)
  return comps;
}

function getProjBase(){
  const comps=ensureProjSel();
  return comps.filter(c=>projSel.has(c.id)).reduce((s,c)=>s+c.amount,0);
}

// Portion of a given record's patrimony that matches the current chip selection.
// Used to filter BOTH the historical (real) line and the projection base.
function selectedPortion(r){
  ensureProjSel();
  let sum=0;
  // Funds
  const anyFundSel=cfg.funds.some(f=>projSel.has('fund:'+f.id));
  if(r.funds_data){
    cfg.funds.forEach(f=>{ if(projSel.has('fund:'+f.id)) sum+=(r.funds_data[f.id]?.vl||0); });
  } else if(anyFundSel){
    sum+=(r.fondos||0); // old record without per-fund breakdown: include aggregate
  }
  // Stocks (solo posiciones; la liquidez del bróker cuenta como cash)
  if(projSel.has('stocks')){
    let st=r.stocks_data?Object.values(r.stocks_data).reduce((s,v)=>s+(v||0),0):((r.acc||0)-((r.broker_liq!=null)?r.broker_liq:0));
    sum+=st;
  }
  // Cash (incluye la liquidez del bróker)
  if(projSel.has('cash')){
    let cs=r.accounts_data?Object.values(r.accounts_data).reduce((s,v)=>s+(v||0),0):(r.cash||0);
    cs+=getBrokerLiq(r);
    sum+=cs;
  }
  return sum;
}

function renderProjChips(){
  const comps=ensureProjSel();
  const el=document.getElementById('proj-chips');
  if(!el)return;
  el.innerHTML=comps.map(c=>{
    const on=projSel.has(c.id);
    return '<button type="button" onclick="toggleProjComp(\''+c.id+'\')" style="'+
      'font-size:11px;padding:4px 10px;border-radius:14px;cursor:pointer;border:1.5px solid '+c.color+';'+
      (on?('background:'+c.color+';color:#fff'):('background:transparent;color:'+c.color))+'">'+
      (on?'✓ ':'')+c.label+' · '+fmt(c.amount)+'€</button>';
  }).join('');
  const base=getProjBase();
  const bl=document.getElementById('proj-base-label');
  if(bl){
    const cc=comps.find(c=>c.id==='cash');
    const enCash=(projSel&&projSel.has('cash')&&cc)?cc.amount:0;
    bl.textContent='Total seleccionado (línea real y base de proyección): '+fmt(base)+'€'+
      (enCash>0?('  ·  de los cuales '+fmt(enCash)+'€ en liquidez, que se proyectan al 2%, no al rendimiento de la bolsa'):'');
  }
}

function toggleProjComp(id){
  ensureProjSel();
  if(projSel.has(id))projSel.delete(id); else projSel.add(id);
  renderProjChips();
  initCharts();
}

// ─── CHART ZOOM CONTROLS ─────────────────────────────────────────────
function resetChartZoom(){
  if(chartPat&&chartPat.resetZoom){chartPat.resetZoom();}
}
function zoomChart(factor){
  if(chartPat&&chartPat.zoom){chartPat.zoom(factor);}
}
function zoomLastYear(){
  // Zoom the x-axis to roughly the last 13 months of actual data (up to current point)
  if(!chartPat||!chartPat.scales||!chartPat.scales.x)return;
  const labels=chartPat.data.labels||[];
  // Find index of the last non-null real patrimony point
  const patData=chartPat.data.datasets[0].data;
  let lastReal=0;
  for(let i=0;i<patData.length;i++){if(patData[i]!=null)lastReal=i;}
  const start=Math.max(0,lastReal-12);
  if(chartPat.zoomScale){
    chartPat.zoomScale('x',{min:start,max:lastReal+1},'default');
  }
}

// ─── DESCOMPOSICIÓN DEL AUMENTO PATRIMONIAL ──────────────────────────
let _patBreakChart=null;
function pbMonthBefore(ym){const[y,m]=ym.split('-').map(Number);const d=new Date(y,m-1,1);d.setMonth(d.getMonth()-1);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
function pbCurYM(){const n=new Date();return n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0');}
function pbStockVal(ym){ // valor de las acciones a fin de mes
  // v128 · misma serie que usa la tabla de rentabilidad por bloque. Antes cada
  // una resolvía por su cuenta y podían dar valores distintos del mismo mes.
  try{
    const ser=stockPortfolioSeries().filter(x=>x.date.slice(0,7)<=ym);
    if(ser.length)return ser[ser.length-1].value;
  }catch(e){fallo('ser',e)}
  let v=0;((typeof STK_DAILY==='function')?STK_DAILY():[]).forEach(r=>{if(r[0].slice(0,7)<=ym)v=r[1];});
  return v;
}
function pbSnap(ym){ // {cash,fondos,stocks,pat} al final del mes ym
  if(ym>=pbCurYM()){
    const n=new Date();const lv=buildLiveRecord(n.getFullYear(),n.getMonth()+1);
    let brk=0;(cfg.brokers||[]).forEach(bk=>{const e=getBalanceEntries('broker',bk.id);if(e&&e[0])brk+=e[0].amount||0;});
    const stocksOnly=(lv.acc||0)-brk; // la liquidez ociosa del bróker es cash, no ganancia de acciones
    return {cash:(lv.cash||0)+brk,fondos:lv.fondos||0,stocks:stocksOnly,
            pat:(lv.cash||0)+(lv.fondos||0)+(lv.acc||0)-(lv.deuda||0)};
  }
  let rec=null,recM='';records.forEach(r=>{const m=r.year+'-'+String(r.month).padStart(2,'0');if(m<=ym&&m>=recM){rec=r;recM=m;}});
  const stk=pbStockVal(ym);
  // v128 · misma serie de fondos que la tabla de bloques
  let fon=rec?(rec.fondos||0):0;
  try{
    const sf=fondosSerieAgregada().filter(x=>x.date.slice(0,7)<=ym);
    if(sf.length)fon=sf[sf.length-1].val;
  }catch(e){fallo('sf',e)}
  if(!rec&&!fon)return {cash:0,fondos:0,stocks:stk,pat:stk};
  const csh=rec?(rec.cash||0):0;
  return {cash:csh,fondos:fon,stocks:stk,pat:csh+fon+stk};
}
function pbFlows(fromYM,toYM){ // ahorro, aportaciones a fondos, despliegue neto en acciones
  // v128 · el MISMO ahorro que enseñan Ahorro y Consultas. Antes aquí se usaba
  // una variante "pura" sin intereses y salían X € donde las otras dos
  // pantallas decían X €: la misma palabra para dos números distintos.
  // Los intereses caen en tu cuenta corriente, así que forman parte del ahorro
  // y no hay doble cómputo: la revalorización de fondos y acciones se mide
  // sobre sus propios valores, no sobre el efectivo.
  let S=0;ahorroMonthly().forEach(x=>{if(x.month>=fromYM&&x.month<=toYM)S+=x.savings;});
  let Cf=0;transactions.filter(t=>t.type==='fund_aport').forEach(t=>{const m=(t.date||'').slice(0,7);if(m>=fromYM&&m<=toYM)Cf+=(t.amount||0);});
  // v128 · las comisiones también son dinero que sale de tu bolsillo hacia la
  // cartera. Sin ellas esto daba X € menos que la tabla de bloques para
  // el mismo periodo. Se usa la misma función que el resto de la app.
  let Dk=0;
  if(typeof stkFlujoDia==='function'){
    const F=stkFlujoDia();
    Object.keys(F).forEach(d=>{const m=d.slice(0,7);if(m>=fromYM&&m<=toYM)Dk+=F[d];});
  }else{
    transactions.filter(t=>t.type==='buy'||t.type==='sell').forEach(t=>{const m=(t.date||'').slice(0,7);if(m>=fromYM&&m<=toYM)Dk+=(t.type==='buy'?1:-1)*(t.total||0);});
  }
  return {S,Cf,Dk};
}
const PB_MESES=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
function pbInitSelects(){
  ['from','to'].forEach(w=>{
    const ms=document.getElementById('pb-'+w+'-m'), ys=document.getElementById('pb-'+w+'-y');
    if(ms&&!ms.dataset.init){ms.innerHTML=PB_MESES.map((n,i)=>'<option value="'+String(i+1).padStart(2,'0')+'">'+n+'</option>').join('');ms.dataset.init='1';}
    if(ys&&!ys.dataset.init){const cy=new Date().getFullYear();let o='';for(let y=cy;y>=2015;y--)o+='<option value="'+y+'">'+y+'</option>';ys.innerHTML=o;ys.dataset.init='1';}
  });
}
function pbReflect(w){ // input oculto (YYYY-MM) -> selects
  const hid=document.getElementById('pb-'+w);if(!hid||!hid.value)return;
  const[y,m]=hid.value.split('-');
  const ms=document.getElementById('pb-'+w+'-m'),ys=document.getElementById('pb-'+w+'-y');
  if(ms&&m)ms.value=m; if(ys&&y)ys.value=y;
}
function pbSync(w){ // selects -> input oculto -> redibuja
  const m=document.getElementById('pb-'+w+'-m')?.value, y=document.getElementById('pb-'+w+'-y')?.value;
  const hid=document.getElementById('pb-'+w);
  if(hid&&m&&y)hid.value=y+'-'+m;
  renderPatBreakdown();
}
function pbEnsureRange(){
  const fi=document.getElementById('pb-from'),ti=document.getElementById('pb-to');
  if(!fi||!ti)return null;
  pbInitSelects();
  if(!ti.value)ti.value=pbCurYM();
  if(!fi.value){const[y,m]=ti.value.split('-').map(Number);const d=new Date(y,m-1,1);d.setMonth(d.getMonth()-12);fi.value=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
  pbReflect('from');pbReflect('to');
  return {from:fi.value,to:ti.value};
}
function pbQuick(kind){
  const ti=document.getElementById('pb-to'),fi=document.getElementById('pb-from');if(!ti||!fi)return;
  pbInitSelects();
  const cur=pbCurYM();const[cy]=cur.split('-').map(Number);
  if(kind==='12m'){ti.value=cur;const[y,m]=cur.split('-').map(Number);const d=new Date(y,m-1,1);d.setMonth(d.getMonth()-12);fi.value=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
  else if(kind==='anio'){fi.value=cy+'-01';ti.value=cur;}
  else if(kind==='anterior'){fi.value=(cy-1)+'-01';ti.value=(cy-1)+'-12';}
  else if(kind==='todo'){let earliest=cur;records.forEach(r=>{const m=r.year+'-'+String(r.month).padStart(2,'0');if(m<earliest)earliest=m;});fi.value=earliest;ti.value=cur;}
  pbReflect('from');pbReflect('to');
  renderPatBreakdown();
}
function renderPatBreakdown(){
  const cv=document.getElementById('cPatBreak');if(!cv||typeof Chart==='undefined')return;
  const rg=pbEnsureRange();if(!rg)return;
  const start=pbSnap(pbMonthBefore(rg.from)), end=pbSnap(rg.to);
  const {S,Cf,Dk}=pbFlows(rg.from,rg.to);
  const Gf=(end.fondos-start.fondos)-Cf;      // revalorización fondos
  const Gs=(end.stocks-start.stocks)-Dk;      // ganancias acciones (realizadas+latentes)
  const dPat=end.pat-start.pat;
  const otros=dPat-S-Gf-Gs;                    // dividendos, intereses, deuda, ruido
  const NAVY='#0B3D91',TEAL='#12A594',BLUE='#2a78d6',AMBER='#C77D20',GRAY='#8A97AB',RED='#C0392B';
  const dark=document.body.classList.contains('dark');
  const steps=[['Ahorro',S,TEAL],['Rev. fondos',Gf,BLUE],['Acciones',Gs,AMBER],['Otros',otros,GRAY]];
  const labels=['Inicial'],bars=[[0,start.pat]],cols=[NAVY],deltas=[start.pat];
  let run=start.pat;
  steps.forEach(([lbl,d,c])=>{const from=run,to=run+d;labels.push(lbl);bars.push([Math.min(from,to),Math.max(from,to)]);cols.push(d>=0?c:RED);deltas.push(d);run=to;});
  labels.push('Final');bars.push([0,end.pat]);cols.push(NAVY);deltas.push(end.pat);
  if(_patBreakChart)_patBreakChart.destroy();
  _patBreakChart=new Chart(cv,{type:'bar',
    data:{labels,datasets:[{data:bars,backgroundColor:cols,borderWidth:0,borderRadius:3}]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},
        tooltip:{callbacks:{label:c=>{const d=deltas[c.dataIndex];return (d>=0?'+':'')+fmt(d)+'€';}}}},
      scales:{x:{grid:{display:false},ticks:{color:dark?'#A0AEC0':'#5A6A80',font:{size:10}}},
              y:{grid:{color:dark?'rgba(255,255,255,.06)':'rgba(0,0,0,.06)'},ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:10},callback:v=>fmt(v)+'€'}}}}
  });
  const note=document.getElementById('pb-note');
  if(note){
    const sign=v=>(v>=0?'+':'')+fmt(v)+'€';
    const _nx=(typeof ahorroExtraNota==='function')?ahorroExtraNota(rg.from,rg.to):'';
    note.innerHTML=(_nx?'<div style="margin-bottom:.35rem">'+_nx+'</div>':'')+
      'En <strong>'+fmtMonth(rg.from)+' → '+fmtMonth(rg.to)+'</strong> tu patrimonio pasó de <strong>'+fmt(start.pat)+'€</strong> a <strong>'+fmt(end.pat)+'€</strong> ('+sign(dPat)+'). '+
      'De ese cambio: <strong style="color:#12A594">ahorro puro '+sign(S)+'</strong>, '+
      '<strong style="color:#2a78d6">revalorización de fondos '+sign(Gf)+'</strong>, '+
      '<strong style="color:#C77D20">acciones '+sign(Gs)+'</strong>, '+
      '<strong style="color:#8A97AB">otros '+sign(otros)+'</strong> (dividendos, intereses, deuda y ruido de estimación).';
  }
}
function initCharts(){
  renderProjChips();
  // Build a current-month snapshot so the projection starts from TODAY, not an old record
  const nowD=new Date();
  const curSnap=buildLiveRecord(nowD.getFullYear(),nowD.getMonth()+1);
  const lastSaved=last();
  let liveExtra=null;
  if(curSnap.hasData&&(curSnap.year*100+curSnap.month)>(lastSaved.year*100+lastSaved.month)){
    liveExtra=curSnap;
  } else if(_liveRecord&&_liveRecord.hasData&&(_liveRecord.year*100+_liveRecord.month)>(lastSaved.year*100+lastSaved.month)){
    liveExtra=_liveRecord;
  }
  initRangeSelects('patev',(records[0]?records[0].year:2015));
  const _pev=rangeBounds('patev');
  const histRecordsFull=liveExtra?[...records,liveExtra]:records;
  // v110 · Sin ningún mes registrado no hay serie que dibujar. Antes seguía
  // adelante y reventaba en el primer histRecordsFull[último].pat.
  if(!histRecordsFull.length)return;
  const _rym=r=>r.year+'-'+String(r.month).padStart(2,'0')+'-15';
  let histRecords=histRecordsFull.filter(r=>inRange(_rym(r),_pev));
  if(histRecords.length<1) histRecords=histRecordsFull;
  const _lastFull=histRecordsFull[histRecordsFull.length-1];
  const rangeCutsFuture=!!(_pev.to && _pev.to < _rym(_lastFull));
  const N=histRecords.length,lp=histRecords[histRecords.length-1].pat,
    aho=Math.round((typeof aportacionProyeccion==='function')?aportacionProyeccion().v:avgAho());
  const lastRec=histRecords[histRecords.length-1];
  // Projection base = selected portion of the current patrimony (so the dashed lines
  // start exactly where the filtered real line ends); no monthly contributions
  // v146 · Antes el escenario del 8% se aplicaba también a la liquidez de la
  // cuenta corriente, y en veinte años eso es un montón de dinero que no va a
  // existir. La parte en cash crece a lo que de verdad renta el efectivo.
  const projBase=selectedPortion(lastRec),projAho=0;
  const PROJ_CASH=0.02;
  let projCash=0;
  try{
    if(projSel&&projSel.has('cash')){
      const cc=getProjComponents().find(c=>c.id==='cash');
      projCash=Math.max(0,Math.min(projBase,cc?cc.amount:0));
    }
  }catch(e){fallo('if',e)}
  const projInv=Math.max(0,projBase-projCash);
  const proyecta=(rate)=>{
    const a=project(projInv,projAho,rate,PROJ), b=project(projCash,0,PROJ_CASH,PROJ);
    return a.map((v,i)=>v+(b[i]||0));
  };
  // v159 · hasta el mes de jubilación del escenario elegido
  const JP=jubPlan();
  const RETIRE_END_YEAR=JP.anio;
  const monthsToRetire=(JP.anio-lastRec.year)*12+(JP.mes-lastRec.month);
  try{
    const t1=document.getElementById('pat-evol-title'); if(t1)t1.textContent='Evolución patrimonial 2019 → '+JP.anio;
    const t2=document.getElementById('proj-esc-title'); if(t2)t2.innerHTML='Proyección por escenario (jubilación '+JP.nombre+', '+fmtDate(JP.fecha)+') '+jubSelectorHTML();
  }catch(e){fallo('t1',e)}
  const PROJ=rangeCutsFuture?0:Math.max(48,monthsToRetire);
  const cons=proyecta(0.03),base=proyecta(0.05),opt=proyecta(0.08),sup=proyecta(0.11);
  const histL=histRecords.map(r=>r.label),projL=[];
  let lbl=histRecords[histRecords.length-1].label;
  for(let i=0;i<PROJ;i++){lbl=nextLabel(lbl);projL.push(lbl);}
  const allL=[...histL,...projL];
  // Real line filtered by the current chip selection
  const patD=[...histRecords.map(r=>selectedPortion(r)),...Array(PROJ).fill(null)];
  const nullH=Array(N-1).fill(null);
  const projC=[...nullH,projBase,...cons],projB=[...nullH,projBase,...base],projO=[...nullH,projBase,...opt],projS=[...nullH,projBase,...sup];
  const ptR=histRecords.map(r=>r.isLive?5:(r.ap?4:0));
  const ptS=histRecords.map(()=>'circle');
  const ptC=histRecords.map(r=>r.isLive?'#1A7A3A':(r.ap?'#D35400':'#0B3D91'));

  if(chartPat)chartPat.destroy();
  // Register zoom plugin if available (embebido, offline)
  try{
    if(window.ChartZoom&&Chart&&!Chart._zoomRegistered){Chart.register(window.ChartZoom);Chart._zoomRegistered=true;}
    else if(window.chartjsPluginZoom&&Chart&&!Chart._zoomRegistered){Chart.register(window.chartjsPluginZoom);Chart._zoomRegistered=true;}
  }catch(e){console.warn('zoom plugin register',e);}
  chartPat=new Chart(document.getElementById('cPat'),{
    type:'line',
    data:{labels:allL,datasets:[
      {label:'Patrimonio real',data:patD,borderColor:'#0B3D91',borderWidth:2.5,
       fill:true,backgroundColor:'rgba(11,61,145,.07)',tension:.35,spanGaps:false,
       pointRadius:ptR,pointStyle:ptS,pointBackgroundColor:ptC,pointBorderColor:ptC,
       pointHoverRadius:6,pointBorderWidth:1.5,pointHoverBorderColor:"#fff"},
      {label:'3% anual',data:projC,borderColor:'#94A3B8',borderWidth:1.5,borderDash:[7,4],pointRadius:0,fill:false,tension:.35},
      {label:'5% anual',data:projB,borderColor:'#006D65',borderWidth:1.5,borderDash:[7,4],pointRadius:0,fill:false,tension:.35},
      {label:'8% anual',data:projO,borderColor:'#A05800',borderWidth:1.5,borderDash:[7,4],pointRadius:0,fill:false,tension:.35},
      {label:'11% anual',data:projS,borderColor:'#7A1FA0',borderWidth:1.5,borderDash:[7,4],pointRadius:0,fill:false,tension:.35},
    ]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:400},
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},
        zoom:{
          zoom:{
            wheel:{enabled:true},
            pinch:{enabled:true},
            drag:{enabled:false},
            mode:'x',
          },
          pan:{enabled:true,mode:'x',modifierKey:null},
          limits:{x:{minRange:3}},
        },
        tooltip:{backgroundColor:'rgba(15,25,35,.92)',
        titleColor:'#F9FAFB',bodyColor:'#CBD5E1',padding:12,cornerRadius:8,
        callbacks:{label(c){return c.parsed.y===null?null:c.dataset.label+': '+fmt(c.parsed.y)+'€'},
          afterBody(items){const i=items[0].dataIndex;
            if(i<records.length&&records[i].ap)return['','♦ Aportación: +'+fmt(records[i].aamt)+'€'];}}}},
      scales:{
        x:{grid:{color:'rgba(0,0,0,.04)'},ticks:{color:'#8A97AB',font:{size:10},maxRotation:0,autoSkip:true,
            callback(v){
              // v is the category (data) index — use it directly, NOT the tick position,
              // so labels stay aligned with their real month when zoomed
              const l=(typeof this.getLabelForValue==='function')?this.getLabelForValue(v):allL[v];
              if(chartPat&&chartPat.scales&&chartPat.scales.x){
                const range=chartPat.scales.x.max-chartPat.scales.x.min;
                if(range<=14)return l; // zoomed to ~1 year: show every month
                if(range<=40)return(l&&(l.startsWith('Ene')||l.startsWith('Jul')))?l:null;
              }
              return(l&&l.startsWith('Ene'))?l.replace('Ene-',"'"):null;}}},
        y:{grid:{color:'rgba(0,0,0,.04)'},ticks:{color:'#8A97AB',font:{size:10},callback:v=>fmtK(v)+'€'}}
      }
    }
  });

  const sl=records.slice(-18);
  if(chartIG)chartIG.destroy();
  chartIG=new Chart(document.getElementById('cIG'),{
    type:'bar',data:{labels:sl.map(r=>r.label),datasets:[
      {label:'Ingresos',data:sl.map(r=>r.ing||0),backgroundColor:'#006D65',barPercentage:.85},
      {label:'Gastos',data:sl.map(r=>r.gas||0),backgroundColor:'#B03020',barPercentage:.85},
    ]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(15,25,35,.92)',
        titleColor:'#F9FAFB',bodyColor:'#CBD5E1',
        callbacks:{label(c){return c.dataset.label+': '+fmt(c.parsed.y)+'€';}}}},
      scales:{x:{grid:{display:false},ticks:{color:'#8A97AB',font:{size:9},maxRotation:45,autoSkip:true}},
        y:{grid:{color:'rgba(0,0,0,.04)'},ticks:{color:'#8A97AB',font:{size:9},callback:v=>fmtK(v)+'€'}}}}
  });

  const nowP=new Date();
  const liveP=buildLiveRecord(nowP.getFullYear(),nowP.getMonth()+1);
  const lr=(liveP&&liveP.hasData)?liveP:last();
  const ca=getCash(lr),fo=getFondos(lr),ac=getAcc(lr),tot=ca+fo+ac||1; // getCash ya incluye bróker; getAcc solo acciones
  if(chartPie)chartPie.destroy();
  chartPie=new Chart(document.getElementById('cPie'),{
    type:'doughnut',
    data:{labels:['Cash','Fondos','Acciones'],
      datasets:[{data:[ca,fo,ac],backgroundColor:['#006D65','#0B3D91','#A05800'],
        borderWidth:2,borderColor:'#fff',hoverOffset:4}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'68%',
      plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(15,25,35,.92)',
        titleColor:'#F9FAFB',bodyColor:'#CBD5E1',
        callbacks:{label(c){return c.label+': '+fmt(c.parsed)+'€ ('+Math.round(c.parsed/tot*100)+'%)';}}}}}
  });

  document.getElementById('pie-legend').innerHTML=
    [['Cash','#006D65',ca],['Fondos','#0B3D91',fo],['Acciones','#A05800',ac]]
    .filter(([,,v])=>v>0)
    .map(([l,c,v])=>`<div class="pie-item">
      <span class="pie-dot" style="background:${c}"></span>
      <span style="flex:1;color:var(--muted)">${l}</span>
      <span style="font-weight:600">${fmt(v)}€</span>
      <span style="color:var(--faint);font-size:10.5px;margin-left:4px">${Math.round(v/tot*100)}%</span>
    </div>`).join('');

  try{renderPatBreakdown();}catch(e){fallo('renderPatBreakdown',e)}

  // Build dynamic checkpoints: end of selected years up to 2045 (retirement)
  const startLabel=histRecords[histRecords.length-1].label; // e.g. Jun-26
  const startY=histRecords[histRecords.length-1].year;
  const startM=histRecords[histRecords.length-1].month;
  const checkYears=[];
  [2027,2030,2035,2040].forEach(y=>{if(y>=startY&&y<RETIRE_END_YEAR)checkYears.push(y);});
  if(RETIRE_END_YEAR>=startY)checkYears.push(RETIRE_END_YEAR);
  // Map each checkpoint year (December) to an index in the projection array
  const chk=[],chl=[];
  checkYears.forEach(y=>{
    // a diciembre de cada año, salvo el de la jubilación, que va a su mes
    const monthsFromStart=(y-startY)*12+((y===RETIRE_END_YEAR?JP.mes:12)-startM);
    if(monthsFromStart>0&&monthsFromStart<=PROJ){
      chk.push(monthsFromStart-1); // project() arrays are 0-indexed from first projected month
      chl.push('Dic-'+String(y).slice(2));
    }
  });
  // Render header
  const thead=document.getElementById('proj-thead');
  if(thead){
    thead.innerHTML='<th>Escenario</th><th>Valor fondos hoy</th>'+chl.map(l=>'<th>'+l+'</th>').join('');
  }
  document.getElementById('proj-tbody').innerHTML=
    [['Conservador 3%',cons,'row-cons'],['Base 5%',base,'row-base'],['Optimista 8%',opt,'row-opt'],['Muy optimista 11%',sup,'row-sup']]
    .map(([nm,d,cls])=>`<tr class="${cls}"><td>${nm}</td><td>${fmt(projBase)}€</td>
      ${chk.map(i=>`<td><strong>${fmt(d[i])}€</strong></td>`).join('')}</tr>`).join('');
}

// ═══════════════════════════════════════════════════════════════════════
// ENTRY FORM — DYNAMIC LISTS
// ═══════════════════════════════════════════════════════════════════════
function renderFormLists(){
  const lr=last();

  // ACCOUNTS
  document.getElementById('list-accounts').innerHTML=cfg.accounts.map(a=>{
    const latestEntry=getBalanceEntries('acc',a.id)[0];
    const val=latestEntry?latestEntry.amount:(lr.accounts_data?.[a.id]||0);
    const valDate=latestEntry?latestEntry.date:'';
    const rends=(lr.rendimientos||[]).filter(r=>r.accountId===a.id);
    const rendNeto=rends.reduce((s,r)=>s+(r.neto||0),0);
    const rendRet=rends.reduce((s,r)=>s+(r.retencion||0),0);
    const hist=getBalanceEntries('acc',a.id);
    const histHtml=hist.length?('<div style="font-size:10px;color:var(--muted);margin-top:3px;padding-left:2px">Histórico: '+
      hist.slice(0,6).map(e=>'<span style="white-space:nowrap">'+(e.date||'')+': <strong>'+fmt(e.amount)+'€</strong> '+
        '<a href="#" onclick="editBalance(event,&quot;'+e.id+'&quot;)" style="text-decoration:none">✏️</a>'+
        '<a href="#" onclick="deleteBalance(event,&quot;'+e.id+'&quot;)" style="text-decoration:none">✕</a></span>').join(' · ')+
      (hist.length>6?' …':'')+'</div>'):'';
    return`<div>
      <div class="dyn-row" id="acc-row-${a.id}">
        <div style="flex:1;min-width:0">
          <div class="dyn-row-name">${a.name}</div>
          <div style="font-size:10px;color:var(--navy)">Saldo actual: <strong>${fmt(val)}€</strong>${valDate?' · '+valDate:''}</div>
          ${rendNeto>0?`<div style="font-size:10px;color:var(--teal)">Rendimiento neto: +${fmt(rendNeto)}€ (ret. ${fmt(rendRet)}€)</div>`:''}
          ${histHtml}
        </div>
        <input type="hidden" class="acc-input" data-id="${a.id}" value="${val}">
        <div class="dyn-row-actions">
          <button type="button" class="btn-xs" style="color:var(--navy);border-color:var(--navy)"
            onclick="toggleBalPanel('acc','${a.id}')">+ Saldo</button>
          <button type="button" class="btn-xs" style="color:var(--teal);border-color:var(--teal)"
            onclick="toggleRendPanel('${a.id}')">+ Rend.</button>
          <button type="button" class="btn-xs danger" onclick="removeAccount('${a.id}')">✕</button>
        </div>
      </div>
      <div class="add-panel" id="bal-acc-${a.id}" style="background:#EBF0FA;border-color:#B8CAEE">
        <div class="add-panel-title" style="color:var(--navy)">Registrar saldo — ${a.name}</div>
        <div class="add-panel-row">
          <div class="fld"><label>Fecha</label>
            <input type="date" id="bal-acc-date-${a.id}" value="${todayISO()}"></div>
          <div class="fld"><label>Importe en cuenta (€)</label>
            <input type="number" id="bal-acc-amt-${a.id}" placeholder="0" step="0.01"></div>
          <div class="add-panel-btns">
            <button type="button" class="btn-xs" style="background:var(--navy);color:#fff;border-color:var(--navy)"
              onclick="addBalance('acc','${a.id}')">Guardar</button>
            <button type="button" class="btn-xs" onclick="toggleBalPanel('acc','${a.id}')">Cerrar</button>
          </div>
        </div>
      </div>
      <div class="rend-panel" id="rend-${a.id}">
        <div class="rend-panel-title">Rendimiento de ${a.name} este mes</div>
        <div class="add-panel-row">
          <div class="fld"><label>Fecha</label>
            <input type="date" id="rend-date-${a.id}" value="${todayISO()}"></div>
          <div class="fld"><label>Importe bruto (€)</label>
            <input type="number" id="rend-bruto-${a.id}" placeholder="0" step="0.01" min="0"
              oninput="calcRend('${a.id}')"></div>
          <div class="fld"><label>Retención IRPF (€)</label>
            <input type="number" id="rend-ret-${a.id}" placeholder="0" step="0.01" min="0"
              oninput="calcRend('${a.id}')"></div>
          <div class="fld"><label>Neto <small style="color:var(--teal)">[auto]</small></label>
            <input type="number" id="rend-neto-${a.id}" placeholder="0" step="0.01" readonly
              style="background:#F0FAF0;font-weight:600;color:var(--teal)"></div>
          <div class="add-panel-btns">
            <button type="button" class="btn-xs" style="background:var(--teal);color:#fff;border-color:var(--teal)"
              onclick="addRend('${a.id}')">Añadir</button>
            <button type="button" class="btn-xs" onclick="toggleRendPanel('${a.id}')">Cerrar</button>
          </div>
        </div>
        ${rends.length>0?`<div class="rend-calc">
          ${rends.map(r=>`<span><strong>${fmt(r.bruto)}€</strong> bruto → ret. <strong class="neg">${fmt(r.retencion)}€</strong> → neto <strong class="pos">${fmt(r.neto)}€</strong> <small style="color:var(--faint)">${r.date||''}</small></span>`).join('<br>')}
        </div>`:''}
      </div>
    </div>`;
  }).join('');

  // FUNDS
  document.getElementById('list-funds').innerHTML=cfg.funds.map(f=>{
    const latestVL=getBalanceEntries('fund',f.id)[0];
    const fd=lr.funds_data?.[f.id]||{vl:0,aport:0};
    const vlVal=latestVL?latestVL.amount:(fd.vl||0);
    const vlDate=latestVL?latestVL.date:'';
    const invested=getFundInvested(f.id);
    const gain=vlVal>0&&invested>0?vlVal-invested:null;
    const gainTxt=gain!==null?` <small class="${gain>=0?'pos':'neg'}" style="font-weight:600">${fmtE(gain)}</small>`:'';
    const histVL=getBalanceEntries('fund',f.id);
    const histHtml=histVL.length?('<div style="font-size:10px;color:var(--muted);margin-top:3px">VL histórico: '+
      histVL.slice(0,6).map(e=>'<span style="white-space:nowrap">'+(e.date||'')+': <strong>'+fmt(e.amount)+'€</strong> '+
        '<a href="#" onclick="editBalance(event,&quot;'+e.id+'&quot;)" style="text-decoration:none">✏️</a>'+
        '<a href="#" onclick="deleteBalance(event,&quot;'+e.id+'&quot;)" style="text-decoration:none">✕</a></span>').join(' · ')+
      (histVL.length>6?' …':'')+'</div>'):'';
    return`<div>
      <div class="dyn-row" id="fund-row-${f.id}">
        <div style="flex:1;min-width:0">
          <div class="dyn-row-name">${f.name}${gainTxt}</div>
          <div style="font-size:10px;color:var(--faint);margin-top:1px">ISIN
            <input type="text" value="${f.isin||''}" placeholder="sin ISIN"
              onchange="setFundIsin('${f.id}',this.value)"
              style="font-size:10px;width:120px;padding:0 4px;border:1px solid var(--border);border-radius:3px;background:var(--surface2);font-family:monospace"></div>
          <div style="font-size:10px;color:var(--navy)">VL actual: <strong>${fmt(vlVal)}€</strong>${vlDate?' · '+vlDate:''} · Invertido: ${fmt(invested)}€</div>
          ${histHtml}
        </div>
        <input type="hidden" class="fund-vl-input" data-id="${f.id}" value="${vlVal}">
        <input type="hidden" class="fund-aport-input" data-id="${f.id}" value="${fd.aport||0}">
        <div class="dyn-row-actions">
          <button type="button" class="btn-xs" style="color:var(--navy);border-color:var(--navy)"
            onclick="toggleBalPanel('fund','${f.id}')">+ VL</button>
          <button type="button" class="btn-xs sell" onclick="toggleFundAport('${f.id}')">+ Aport.</button>
          <button type="button" class="btn-xs danger" onclick="removeFund('${f.id}')">✕</button>
        </div>
      </div>
      <div class="add-panel" id="bal-fund-${f.id}" style="background:#EBF0FA;border-color:#B8CAEE">
        <div class="add-panel-title" style="color:var(--navy)">Actualizar valor — ${f.name}</div>
        <div class="add-panel-row">
          <div class="fld"><label>Fecha</label>
            <input type="date" id="bal-fund-date-${f.id}" value="${todayISO()}"></div>
          <div class="fld"><label>Valor total (€)</label>
            <input type="number" id="bal-fund-amt-${f.id}" placeholder="0" step="0.01"></div>
          <div class="add-panel-btns">
            <button type="button" class="btn-xs" style="background:var(--navy);color:#fff;border-color:var(--navy)"
              onclick="addBalance('fund','${f.id}')">Guardar total</button>
            <button type="button" class="btn-xs" onclick="toggleBalPanel('fund','${f.id}')">Cerrar</button>
          </div>
        </div>
        <div class="add-panel-row" style="margin-top:.35rem;border-top:1px dashed #B8CAEE;padding-top:.45rem">
          <div class="fld"><label>o por cotización — VL (€/participación)</label>
            <input type="number" id="bal-fund-vl-${f.id}" placeholder="p. ej. 194,606" step="0.0001" oninput="calcFundByVL('${f.id}')"></div>
          <div class="fld"><label>Participaciones</label>
            <input type="number" id="bal-fund-parts-${f.id}" value="${fundParts(f.id)||''}" step="0.000001" oninput="calcFundByVL('${f.id}')"></div>
          <div class="add-panel-btns">
            <button type="button" class="btn-xs" style="background:var(--teal);color:#fff;border-color:var(--teal)"
              onclick="addFundByVL('${f.id}')">Guardar por cotización</button>
          </div>
        </div>
        <div style="font-size:11px;color:var(--navy);padding:.15rem 0 0" id="bal-fund-vlprev-${f.id}"></div>
      </div>
      <div class="add-panel" id="faport-${f.id}" style="border-color:#B8CAEE;background:#EBF0FA;margin-top:-4px;border-radius:0 0 var(--r-sm) var(--r-sm)">
        <div class="add-panel-title" style="color:var(--navy)">Nueva aportación — ${f.name}</div>
        <div class="add-panel-row">
          <div class="fld"><label>Fecha</label>
            <input type="date" id="faport-date-${f.id}" value="${todayISO()}"></div>
          <div class="fld"><label>Importe aportado (€)</label>
            <input type="number" id="faport-amt-${f.id}" placeholder="0" step="0.01" min="0" oninput="calcFaportParts('${f.id}')"></div>
          <div class="fld"><label>VL de adquisición (€/participación)</label>
            <input type="number" id="faport-vl-${f.id}" placeholder="opcional" step="0.0001" min="0" oninput="calcFaportParts('${f.id}')"></div>
          <div class="add-panel-btns">
            <button type="button" class="btn-xs" style="background:var(--navy);color:#fff;border-color:var(--navy)"
              onclick="addFundAport('${f.id}')">Guardar aportación</button>
            <button type="button" class="btn-xs" onclick="toggleFundAport('${f.id}')">Cerrar</button>
          </div>
        </div>
        <div style="font-size:11px;color:var(--navy);padding:0 0 .25rem" id="faport-parts-${f.id}"></div>
        ${(function(){
          const aports=transactions.filter(t=>t.type==='fund_aport'&&t.fundId===f.id)
            .sort((a,b)=>(b.date||'').localeCompare(a.date||''));
          if(!aports.length) return '<div style="font-size:10.5px;color:var(--faint);margin-top:.5rem">Sin aportaciones registradas para este fondo.</div>';
          const totalParts=aports.reduce((s,t)=>s+(t.vlAdq>0?(t.amount/t.vlAdq):0),0);
          const curVal=getFundVLInfo(f.id).amount||0;
          const curNAV=totalParts>0?curVal/totalParts:null;
          const rows=aports.map(t=>{
            const parts=t.vlAdq>0?(t.amount/t.vlAdq):null;
            const valNow=(parts!==null&&curNAV!==null)?parts*curNAV:null;
            const retPct=(t.vlAdq>0&&curNAV!==null)?((curNAV/t.vlAdq-1)*100):null;
            const retTxt=retPct!==null?('<span class="'+(retPct>=0?'pos':'neg')+'" style="font-weight:600">'+(retPct>=0?'+':'')+retPct.toFixed(1)+'%</span>'):'<span style="color:var(--faint)">—</span>';
            return '<div style="display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;padding:.35rem .5rem;background:#fff;border:.5px solid var(--border);border-radius:var(--r-xs);margin-bottom:3px">'+
              '<span style="font-size:10.5px;color:var(--faint);min-width:70px">'+(t.date||'')+'</span>'+
              '<span style="font-size:11.5px;font-weight:600;min-width:70px">'+fmt2(t.amount)+'€</span>'+
              '<span style="font-size:10.5px;color:var(--muted)">'+(t.vlAdq>0?('VL '+fmt2(t.vlAdq)+'€ · '+fmt2(parts)+' part.'):'sin VL')+'</span>'+
              (valNow!==null?'<span style="font-size:10.5px;color:var(--navy)">→ '+fmt2(valNow)+'€</span>':'')+
              '<span style="font-size:11px;flex:1;text-align:right">'+retTxt+'</span>'+
              '<a href="#" onclick="editFundAport(event,&quot;'+t.id+'&quot;)" style="text-decoration:none" title="Editar">✏️</a>'+
              '<a href="#" onclick="deleteFundAport(event,&quot;'+t.id+'&quot;)" style="text-decoration:none" title="Eliminar">✕</a>'+
            '</div>';
          }).join('');
          return '<div style="margin-top:.5rem;font-size:11px">'+
            '<strong style="color:var(--navy)">Aportaciones ('+aports.length+'):</strong>'+
            (curNAV!==null?' <small style="color:var(--muted)">VL actual estimado: '+fmt2(curNAV)+'€/part.</small>':' <small style="color:var(--faint)">registra el VL total con "+ VL" para ver rentabilidades</small>')+
            '<div style="margin-top:.35rem">'+rows+'</div>'+
            '<div style="color:var(--navy);margin-top:.25rem">Total invertido: <strong>'+fmt2(getFundInvested(f.id))+'€</strong>'+
            (totalParts>0?' · Participaciones: <strong>'+fmt2(totalParts)+'</strong>':'')+
            (curVal>0?' · Valor actual: <strong>'+fmt2(curVal)+'€</strong>':'')+'</div></div>';
        })()}
      </div>
    </div>`;
  }).join('');

  // STOCKS (active only)
  renderStockTxList();

  // DEBTS
  document.getElementById('list-debts').innerHTML=cfg.debts.length>0?
    cfg.debts.map(d=>{
      const val=lr.debts_data?.[d.id]||0;
      return`<div class="dyn-row">
        <span class="dyn-row-name">${d.name}</span>
        <input type="number" class="debt-input" data-id="${d.id}" value="${val}" step="0.01"
          placeholder="0" step="0.01" oninput="calcSummary()">
        <div class="dyn-row-actions">
          <button type="button" class="btn-xs danger" onclick="removeDebt('${d.id}')">✕</button>
        </div>
      </div>`;
    }).join(''):
    '<p style="font-size:12px;color:var(--faint);padding:.375rem 0">Sin deudas registradas.</p>';

  calcSummary();
}

// ─── CALCULATIONS ────────────────────────────────────────────────────
function calcSummary(){
  // Use transaction list totals if user has entered transactions; else fall back to hidden fields
  const txTotal=sumaNeta(_ingresos);
  const rendNeto=(last().rendimientos||[]).reduce((s,r)=>s+(r.neto||0),0);
  const ing=txTotal>0?(txTotal+rendNeto):((n('fi-nom'))+(n('fi-ipt'))+(n('fi-otros'))+rendNeto);
  const cashCur=Array.from(document.querySelectorAll('.acc-input')).reduce((s,i)=>s+(parseFloat(i.value)||0),0);
  const fondosCur=Array.from(document.querySelectorAll('.fund-vl-input')).reduce((s,i)=>s+(parseFloat(i.value)||0),0);
  // Aportaciones for the selected month come from fund_aport transactions
  const fy=parseInt(document.getElementById('fy')?.value)||last().year;
  const fmth=parseInt(document.getElementById('fm')?.value)||last().month;
  const monthPrefix=fy+'-'+String(fmth).padStart(2,'0');
  const aportsCur=transactions.filter(t=>t.type==='fund_aport'&&String(t.date||'').startsWith(monthPrefix))
    .reduce((s,t)=>s+(t.amount||0),0);
  // Stock values come from last record's stocks_data, not form inputs
  const accCur=getAcc(last());
  const deudaCur=Array.from(document.querySelectorAll('.debt-input')).reduce((s,i)=>s+(parseFloat(i.value)||0),0);
  const pat=cashCur+fondosCur+accCur;
  const pr=prevRec();
  const cashPrev=pr?getCash(pr):0;
  const deltaCash=cashCur-cashPrev;
  const newAports=aportsCur;
  // Gastos totales: fijos + estructurales + ocio
  const gastosFijos=getGastosFijosTotal();
  const gastosEst=sumaNeta(_gastosEst);
  const gastosOcio=sumaNeta(_gastosOcio);
  const gastosTotal=gastosFijos+gastosEst+gastosOcio;
  // If user has filled in gastos detail, use that; otherwise estimate from Δcash
  const gas=gastosTotal>0?gastosTotal:Math.max(0,ing-deltaCash-newAports);
  const aho=deltaCash+newAports;
  // Update gasto total display
  const gtEl=document.getElementById('gasto-total-display');
  if(gtEl)gtEl.textContent=gastosTotal>0?fmt(gastosTotal)+'€':'—';

  const set=(id,v,cls)=>{const el=document.getElementById(id);if(el){el.textContent=v;el.className=cls||'';}};
  const ingLbl=rendNeto>0?`${fmt(ing)}€ <small style="color:var(--teal)">(incl. ${fmt(rendNeto)}€ rendimientos)</small>`:(ing>0?fmt(ing)+'€':'—');
  const ingEl=document.getElementById('s-ing');if(ingEl)ingEl.innerHTML=ingLbl;
  set('s-cash-delta',pr?(fmtE(deltaCash)+'€  ('+fmt(cashPrev)+'€ → '+fmt(cashCur)+'€)'):'primer registro');
  set('s-aports',newAports>0?fmt(newAports)+'€':'—',newAports>0?'pos':'');
  set('s-gas',gas>0?fmt(gas)+'€':'—','neg');
  set('s-aho',ing>0?fmtE(aho):'—','pos');
  set('s-pat',fmt(pat)+'€');
}


function calcBuyTotal(){
  const shares=parseFloat(document.getElementById('ns-shares')?.value)||0;
  const priceRaw=parseFloat(document.getElementById('ns-price')?.value)||0;
  const costs=parseFloat(document.getElementById('ns-costs')?.value)||0;
  const cur=document.getElementById('ns-cur')?.value||'EUR';
  const rate=parseFloat(document.getElementById('ns-rate')?.value)||0;
  // Toggle currency UI
  const isEur=cur==='EUR';
  const rateFld=document.getElementById('ns-rate-fld');if(rateFld)rateFld.style.display=isEur?'none':'';
  const lbl=document.getElementById('ns-cur-lbl');if(lbl)lbl.textContent=isEur?'€':cur;
  document.querySelectorAll('.ns-cur-lbl2').forEach(el=>el.textContent=cur);
  // Price in EUR: rate is "1 € = X foreign", so EUR = foreign / rate
  const price=isEur?priceRaw:(rate>0?priceRaw/rate:0);
  const total=shares*price+costs;
  const prev=document.getElementById('buy-preview');
  if(prev&&shares>0&&priceRaw>0&&(isEur||rate>0)){
    prev.style.display='block';
    prev.innerHTML='Total invertido: <strong>'+fmt2(total)+'€</strong> ('+fmt2(shares)+' acc × '+
      (isEur?fmt2(price)+'€':fmt2(priceRaw)+' '+cur+' ÷ '+fmtR(rate)+' = '+fmt2(price)+'€')+' + '+fmt2(costs)+'€ gastos)';
  } else if(prev){prev.style.display='none';}
}

// ─── ADD/REMOVE ───────────────────────────────────────────────────────
function addAccount(){
  const name=document.getElementById('new-acc-name').value.trim();
  if(!name)return;
  const id='acc_'+Date.now();
  cfg.accounts.push({id,name});
  save();togglePanel('add-account');renderFormLists();toast('Cuenta añadida');
}
function removeAccount(id){
  cfg.accounts=cfg.accounts.filter(a=>a.id!==id);
  save();renderFormLists();toast('Cuenta eliminada');
}
function addFund(){
  const name=document.getElementById('new-fund-name').value.trim();
  const invested=parseFloat(document.getElementById('new-fund-invested').value)||0;
  const date=document.getElementById('new-fund-date').value||todayISO();
  if(!name)return;
  const id='fund_'+Date.now();
  cfg.funds.push({id,name,invested,date});
  save();togglePanel('add-fund');renderFormLists();toast('Fondo añadido');
}
function removeFund(id){
  cfg.funds=cfg.funds.filter(f=>f.id!==id);
  save();renderFormLists();toast('Fondo eliminado');
}
function onIdeaChange(){
  const v=document.getElementById('ns-idea')?.value;
  const fld=document.getElementById('ns-idea-otros-fld');
  if(fld)fld.style.display=(v==='otros')?'':'none';
}
function addStockBuy(){
  const name=document.getElementById('ns-name')?.value.trim()||'';
  const shares=parseFloat(document.getElementById('ns-shares')?.value)||0;
  const priceRaw=parseFloat(document.getElementById('ns-price')?.value)||0;
  const costs=parseFloat(document.getElementById('ns-costs')?.value)||0;
  const cur=document.getElementById('ns-cur')?.value||'EUR';
  const rate=parseFloat(document.getElementById('ns-rate')?.value)||0;
  const date=document.getElementById('ns-date')?.value||todayISO();
  const mktval=parseFloat(document.getElementById('ns-mktval')?.value)||0;
  const idea=document.getElementById('ns-idea')?.value||'';
  const ideaOtros=document.getElementById('ns-idea-otros')?.value.trim()||'';
  const setup=document.getElementById('ns-setup')?.value.trim()||'';
  const editId=document.getElementById('ns-edit-id')?.value||'';
  if(!name||!shares||!priceRaw){toast('Rellena empresa, nº acciones y precio');return;}
  if(cur!=='EUR'&&rate<=0){toast('Introduce el tipo de cambio');return;}
  const price=cur==='EUR'?priceRaw:Math.round((priceRaw/rate)*1e6)/1e6; // price per share in EUR
  // If editing, remove old transaction
  if(editId) transactions=transactions.filter(t=>t.id!==editId);
  // Group under same stock id if company exists
  const existing=cfg.stocks.find(s=>s.name.toLowerCase()===name.toLowerCase());
  const sid=existing?existing.id:'stk_'+Date.now();
  if(!existing) cfg.stocks.push({id:sid,name,existing:false,currency:cur!=='EUR'?cur:undefined});
  // Remember the idea + setup on the stock too (thesis is per-position)
  const stk=cfg.stocks.find(s=>s.id===sid);
  if(stk){if(idea){stk.idea=idea;stk.ideaOtros=idea==='otros'?ideaOtros:undefined;} if(setup)stk.setup=setup;}
  const txId='tx_'+Date.now();
  const cxtra=cur!=='EUR'?{currency:cur,rate,priceForeign:priceRaw}:{};
  const ixtra=idea?{idea,ideaOtros:idea==='otros'?ideaOtros:undefined}:{};
  if(setup)ixtra.setup=setup;
  transactions.push({id:txId,stockId:sid,stockName:name,type:'buy',date,shares,price,
    costs,total:shares*price,name,mktval,year:date?parseInt(date.slice(0,4)):last().year,...cxtra,...ixtra});
  // Update mktval in last record's stocks_data
  if(mktval>0){
    const lr=last();
    if(!lr.stocks_data) lr.stocks_data={};
    lr.stocks_data[sid]=mktval;
  }
  recomputeAllStockGains(); // FIFO — a new buy changes cost basis of later sells
  save();openStockOp(null);renderStockTxList();renderAll();
  toast('Compra guardada: '+name+' · '+fmt(shares)+' acc × '+fmt(price)+'€');
}
function addDebt(){
  const name=document.getElementById('new-debt-name').value.trim();
  const bal=parseFloat(document.getElementById('new-debt-balance').value)||0;
  if(!name)return;
  const id='dbt_'+Date.now();
  cfg.debts.push({id,name});
  // Store initial balance in last record
  const lr=last();if(!lr.debts_data)lr.debts_data={};
  lr.debts_data[id]=bal;
  save();togglePanel('add-debt');renderFormLists();toast('Deuda añadida');
}
function removeDebt(id){
  cfg.debts=cfg.debts.filter(d=>d.id!==id);
  save();renderFormLists();toast('Deuda eliminada');
}

function editFundAport(ev,txId){
  if(ev)ev.preventDefault();
  const t=transactions.find(x=>x.id===txId);
  if(!t)return;
  const fid=t.fundId;
  const p=document.getElementById('faport-'+fid);
  if(p&&!p.classList.contains('open'))p.classList.add('open');
  const g=(id,v)=>{const el=document.getElementById(id);if(el)el.value=(v!=null?v:'');};
  g('faport-date-'+fid,t.date);
  g('faport-amt-'+fid,t.amount);
  g('faport-vl-'+fid,t.vlAdq||'');
  let ef=document.getElementById('faport-edit-'+fid);
  if(!ef){ef=document.createElement('input');ef.type='hidden';ef.id='faport-edit-'+fid;p.appendChild(ef);}
  ef.value=txId;
  calcFaportParts(fid);
  toast('Editando aportación — modifica y Guardar');
}

function toggleFundAport(fid){
  const p=document.getElementById('faport-'+fid);
  if(p){p.classList.toggle('open');
    if(p.classList.contains('open')){
      const inp=document.getElementById('faport-amt-'+fid);
      if(inp){inp.value='';inp.focus();}
    }
  }
}


function calcFaportParts(fid){
  const amt=parseFloat(document.getElementById('faport-amt-'+fid)?.value)||0;
  const vl=parseFloat(document.getElementById('faport-vl-'+fid)?.value)||0;
  const prev=document.getElementById('faport-parts-'+fid);
  if(!prev)return;
  if(amt>0&&vl>0){
    prev.innerHTML='= <strong>'+fmt2(amt/vl)+' participaciones</strong> a '+fmt2(vl)+'€/part.';
  } else {
    prev.textContent='';
  }
}

function addFundAport(fid){
  const amt=parseFloat(document.getElementById('faport-amt-'+fid)?.value)||0;
  if(amt<=0){toast('Introduce un importe mayor que 0');return;}
  const date=document.getElementById('faport-date-'+fid)?.value||todayISO();
  const vlAdq=parseFloat(document.getElementById('faport-vl-'+fid)?.value)||0;
  const editId=document.getElementById('faport-edit-'+fid)?.value||'';
  const parts=vlAdq>0?Math.round(amt/vlAdq*1e6)/1e6:undefined;
  if(editId){
    const t=transactions.find(x=>x.id===editId);
    if(t){t.date=date;t.amount=amt;t.vlAdq=vlAdq>0?vlAdq:undefined;t.participaciones=parts;}
    document.getElementById('faport-edit-'+fid).value='';
    toast('Aportación modificada');
  } else {
    transactions.push({id:'tx_'+Date.now(),stockId:fid,type:'fund_aport',date,amount:amt,fundId:fid,
      vlAdq:vlAdq>0?vlAdq:undefined,participaciones:parts});
    toast('Aportación guardada: +'+fmt2(amt)+'€'+(vlAdq>0?' ('+fmt2(amt/vlAdq)+' part. @ '+fmt2(vlAdq)+'€)':'')+' a '+(cfg.funds.find(f=>f.id===fid)?.name||fid));
  }
  save();
  // Clear fields
  const amtEl=document.getElementById('faport-amt-'+fid);if(amtEl)amtEl.value='';
  const vlEl=document.getElementById('faport-vl-'+fid);if(vlEl)vlEl.value='';
  const prev=document.getElementById('faport-parts-'+fid);if(prev)prev.textContent='';
  renderFormLists();renderAll();
}

function deleteFundAport(ev,txId){
  if(ev)ev.preventDefault();
  if(!confirm('¿Eliminar esta aportación?'))return;
  transactions=transactions.filter(t=>t.id!==txId);
  save();renderFormLists();renderAll();toast('Aportación eliminada');
}


// ═══════════════════════════════════════════════════════════════════════
// BALANCE LOG — date-stamped balances for accounts & funds
// ═══════════════════════════════════════════════════════════════════════
function toggleBalPanel(refType,refId){
  const p=document.getElementById('bal-'+refType+'-'+refId);
  if(p)p.classList.toggle('open');
}
// ─── STOCK VALUE with foreign-currency conversion ────────────────────
function onStockCurChange(id){
  const cur=document.getElementById('svcur-'+id)?.value||'EUR';
  const isEur=cur==='EUR';
  const em=document.getElementById('svcur-eurmode-'+id);
  const fm=document.getElementById('svcur-fxmode-'+id);
  if(em)em.style.display=isEur?'':'none';
  if(fm)fm.style.display=isEur?'none':'';
  document.querySelectorAll('.svcur-lbl-'+id).forEach(el=>el.textContent=cur);
  calcStockValueEUR(id);
}
function calcStockValueEUR(id){
  const cur=document.getElementById('svcur-'+id)?.value||'EUR';
  const prev=document.getElementById('svcur-preview-'+id);
  if(cur==='EUR'){if(prev)prev.textContent='';return null;}
  const price=parseFloat(document.getElementById('svcur-price-'+id)?.value)||0;
  const shares=parseFloat(document.getElementById('svcur-shares-'+id)?.value)||0;
  const rate=parseFloat(document.getElementById('svcur-rate-'+id)?.value)||0;
  const eur=rate>0?(price*shares/rate):0;
  if(prev){
    prev.innerHTML=(price>0&&shares>0&&rate>0)
      ?('= '+fmt2(price)+' '+cur+' × '+fmt2(shares)+' acc ÷ '+fmtR(rate)+' = <strong>'+fmt2(eur)+' €</strong>')
      :'<span style="color:var(--faint)">Introduce precio, acciones y tipo de cambio</span>';
  }
  return eur;
}
function addStockValue(id){
  const date=document.getElementById('bal-stock-date-'+id)?.value||todayISO();
  const cur=document.getElementById('svcur-'+id)?.value||'EUR';
  let eur=0,extra={};
  if(cur==='EUR'){
    eur=parseFloat(document.getElementById('bal-stock-amt-'+id)?.value);
    if(isNaN(eur)){toast('Introduce el valor en €');return;}
  } else {
    const price=parseFloat(document.getElementById('svcur-price-'+id)?.value)||0;
    const shares=parseFloat(document.getElementById('svcur-shares-'+id)?.value)||0;
    const rate=parseFloat(document.getElementById('svcur-rate-'+id)?.value)||0;
    if(price<=0||shares<=0||rate<=0){toast('Rellena precio, acciones y tipo de cambio');return;}
    eur=Math.round(price*shares/rate*100)/100;
    extra={currency:cur,rate,foreignPrice:price,shares};
    // Remember currency+rate on the stock for next time
    const st=cfg.stocks.find(x=>x.id===id);if(st){st.currency=cur;}
  }
  balanceLog.push({id:'bal_'+Date.now(),refType:'stock',refId:id,date,amount:eur,...extra});
  save();renderStockTxList();renderAll();
  toast('Valor registrado: '+fmt2(eur)+'€'+(cur!=='EUR'?' ('+cur+')':'')+' a '+date);
}

function addBalance(refType,refId){
  const date=document.getElementById('bal-'+refType+'-date-'+refId)?.value||todayISO();
  const amt=parseFloat(document.getElementById('bal-'+refType+'-amt-'+refId)?.value);
  if(isNaN(amt)){toast('Introduce un importe');return;}
  balanceLog.push({id:'bal_'+Date.now(),refType,refId,date,amount:amt});
  save();renderFormLists();renderAll();
  const tn=refType==='acc'?'Saldo':(refType==='fund'?'VL':(refType==='broker'?'Liquidez':'Valor'));
  toast(tn+' registrado: '+fmt(amt)+'€ a '+date);
}
// ─── Actualizar fondo por cotización (VL × participaciones) ──────────
// v169 · Las participaciones de cada fondo están en tus datos (fondo.parts y
// cada valoración por VL); ya no hay cifras tuyas escritas aquí.
const DEFAULT_FUND_PARTS={};
function fundParts(id){const f=cfg.funds.find(x=>x.id===id);return (f&&f.parts>0)?f.parts:(DEFAULT_FUND_PARTS[id]||0);}
function calcFundByVL(id){
  const vl=parseFloat(document.getElementById('bal-fund-vl-'+id)?.value)||0;
  const parts=parseFloat(document.getElementById('bal-fund-parts-'+id)?.value)||0;
  const prev=document.getElementById('bal-fund-vlprev-'+id);
  if(prev)prev.innerHTML=(vl>0&&parts>0)?('= '+fmtR(vl)+' € × '+fmtR(parts)+' part = <strong>'+fmt2(vl*parts)+' €</strong>'):'<span style="color:var(--faint)">Introduce VL y participaciones para calcular el valor total</span>';
}
function addFundByVL(id){
  const date=document.getElementById('bal-fund-date-'+id)?.value||todayISO();
  const vl=parseFloat(document.getElementById('bal-fund-vl-'+id)?.value);
  const parts=parseFloat(document.getElementById('bal-fund-parts-'+id)?.value);
  if(isNaN(vl)||vl<=0){toast('Introduce el VL (€/participación)');return;}
  if(isNaN(parts)||parts<=0){toast('Introduce las participaciones');return;}
  const total=Math.round(vl*parts*100)/100;
  const f=cfg.funds.find(x=>x.id===id); if(f)f.parts=parts;
  balanceLog.push({id:'bal_'+Date.now(),refType:'fund',refId:id,date,amount:total,vl:vl,parts:parts});
  save();renderFormLists();renderAll();
  toast('VL '+fmtR(vl)+'€ × '+fmtR(parts)+' part = '+fmt(total)+'€ a '+date);
}
function editBalance(ev,balId){
  if(ev)ev.preventDefault();
  const e=balanceLog.find(b=>b.id===balId);
  if(!e)return;
  const newAmt=prompt('Editar importe (€) para '+(e.date||''),e.amount);
  if(newAmt===null)return;
  const v=parseFloat(newAmt);
  if(isNaN(v)){toast('Importe no válido');return;}
  e.amount=v;
  save();renderFormLists();renderAll();toast('Saldo modificado');
}
function deleteBalance(ev,balId){
  if(ev)ev.preventDefault();
  if(!confirm('¿Eliminar este registro de saldo?'))return;
  balanceLog=balanceLog.filter(b=>b.id!==balId);
  save();renderFormLists();renderAll();toast('Registro eliminado');
}

// ═══════════════════════════════════════════════════════════════════════
// RENDIMIENTOS DE CUENTAS
// ═══════════════════════════════════════════════════════════════════════
function toggleRendPanel(aid){
  const p=document.getElementById('rend-'+aid);
  if(p)p.classList.toggle('open');
}
function calcRend(aid){
  const bruto=parseFloat(document.getElementById('rend-bruto-'+aid)?.value)||0;
  const ret=parseFloat(document.getElementById('rend-ret-'+aid)?.value)||0;
  const netoEl=document.getElementById('rend-neto-'+aid);
  if(netoEl)netoEl.value=Math.max(0,bruto-ret).toFixed(2);
}
function addRend(aid,aname){
  if(aname==null){ const a=(cfg.accounts||[]).find(x=>x.id===aid); aname=a?a.name:''; }
  const bruto=parseFloat(document.getElementById('rend-bruto-'+aid)?.value)||0;
  const ret=parseFloat(document.getElementById('rend-ret-'+aid)?.value)||0;
  if(bruto<=0){toast('Introduce el importe bruto');return;}
  const neto=Math.max(0,bruto-ret);
  const date=document.getElementById('rend-date-'+aid)?.value||todayISO();
  const lr=last();
  if(!lr.rendimientos)lr.rendimientos=[];
  lr.rendimientos.push({accountId:aid,accountName:aname,bruto,retencion:ret,neto,date});
  ['rend-bruto-','rend-ret-','rend-neto-'].forEach(p=>{const el=document.getElementById(p+aid);if(el)el.value='';});
  calcSummary();renderFormLists();
  toast('Rendimiento +'+fmt(neto)+'€ neto añadido');
}

// ═══════════════════════════════════════════════════════════════════════
// GASTOS
// ═══════════════════════════════════════════════════════════════════════
let _gastosEst=[];
let _gastosOcio=[];
let _ingresos=[];  // working copy for the selected month (mirrors incomeLog entries of that month)

// Persistent date-stamped logs (replace the old "save month" snapshot system)
let incomeLog=[];   // [{id, date, desc, cat, amt, nd?}]
let expenseLog=[];  // [{id, date, name, amt, cat, kind:'fijo'|'estructural'|'ocio', fijoId?}]
let reembolsos=[];  // [{id, incomeId, expenseIds:[], notes:{eid:txt}, created}] — compensaciones Bizum
let brokerFlows=[]; // [{id, date, brokerId, type:'aporta'|'retira', amount, accountId?}] — deposits/withdrawals to broker


// Load the working arrays from the persistent logs for the selected month
function loadMonthEntries(){
  // v144 · Los apuntes compensados (el Bizum y los gastos que reembolsa) se
  // siguen viendo en la lista —son movimientos reales del banco— pero llevan
  // marca y NO suman en ningún total. Antes salían del ahorro y de "en qué
  // gastas" pero seguían contando aquí, y los dos sitios no cuadraban.
  const _ci=(typeof compIncomeIds==='function')?compIncomeIds():new Set();
  const _ce=(typeof compExpenseIds==='function')?compExpenseIds():new Set();
  // No month filter: load ALL entries, each carries its own date
  _ingresos=incomeLog.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||''))
    .map(e=>({id:e.id,fecha:e.date,desc:e.desc,cat:e.cat,amt:e.amt,nd:e.nd,comp:_ci.has(e.id)}));
  _gastosEst=expenseLog.filter(e=>e.kind==='estructural').sort((a,b)=>(b.date||'').localeCompare(a.date||''))
    .map(e=>({id:e.id,name:e.name,amt:e.amt,cat:e.cat,date:e.date,comp:_ce.has(e.id)}));
  _gastosOcio=expenseLog.filter(e=>e.kind==='ocio').sort((a,b)=>(b.date||'').localeCompare(a.date||''))
    .map(e=>({id:e.id,name:e.name,amt:e.amt,cat:e.cat,date:e.date,comp:_ce.has(e.id)}));
}
// suma que ignora lo compensado — la que vale para cualquier total
function sumaNeta(arr){ return (arr||[]).reduce((s,x)=>s+(x.comp?0:(x.amt||0)),0); }
function nComp(arr){ return (arr||[]).filter(x=>x.comp).length; }
function sumaComp(arr){ return (arr||[]).reduce((s,x)=>s+(x.comp?(x.amt||0):0),0); }
const COMP_TAG='<span title="compensado: no cuenta en los totales" style="font-size:9.5px;background:var(--amber);color:#fff;border-radius:3px;padding:0 4px;margin-left:3px">comp</span>';

function initGastosForm(){loadMonthEntries();renderGastosList();renderTxIngList();}

// ─── INCOME TRANSACTIONS ────────────────────────────────────────────
const ING_CATS={nomina:'Nómina',ipt:'IPT/Pensión',rend:'Rendimiento',extra:'Extraordinario',otro2:'Otro'};
const ING_CSS={nomina:'cat-nomina',ipt:'cat-ipt',rend:'cat-rend',extra:'cat-extra',otro2:'cat-otro2'};

let _incomeOpen=false;
function toggleIncomeSection(){
  _incomeOpen=!_incomeOpen;
  try{ALM.setItem('dlv_sections',JSON.stringify({..._stockSections,income:_incomeOpen}));}catch(e){fallo('ALM.setItem',e)}
  const div=document.getElementById('income-content');
  const btn=document.getElementById('toggle-income-btn');
  if(div)div.style.display=_incomeOpen?'block':'none';
  if(btn)btn.textContent=_incomeOpen?'▾ Ocultar ingresos':'▸ Ver / añadir ingresos';
}
function renderIncomeSummary(){
  const el=document.getElementById('income-summary');
  if(!el)return;
  const _ci=(typeof compIncomeIds==='function')?compIncomeIds():new Set();
  const n=incomeLog.length;
  const total=incomeLog.reduce((s,e)=>s+(_ci.has(e.id)?0:(e.amt||0)),0);
  const nowY=new Date().getFullYear();
  const yearTotal=incomeLog.filter(e=>String(e.date||'').startsWith(String(nowY)))
    .reduce((s,e)=>s+(_ci.has(e.id)?0:(e.amt||0)),0);
  el.innerHTML='<div style="background:#E6F4F1;border:1px solid #9CD3C8;border-radius:var(--r-sm);padding:.5rem .75rem">'+
    '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:.5rem;align-items:baseline">'+
      '<strong style="font-size:12px;color:var(--teal)">Ingresos ('+n+' apunte'+(n!==1?'s':'')+')</strong>'+
      '<span style="font-size:11.5px">'+nowY+': <strong>'+fmt(yearTotal)+'€</strong></span>'+
      '<span style="font-size:11.5px">Total: <strong>'+fmt(total)+'€</strong></span>'+
    '</div></div>';
}
function renderTxIngList(){
  renderIncomeSummary();
  const el=document.getElementById('tx-ing-list');
  if(!el)return;
  const total=sumaNeta(_ingresos);
  const nC=nComp(_ingresos), sC=sumaComp(_ingresos);
  el.innerHTML=_ingresos.length?
    _ingresos.map((t,i)=>`
      <div class="tx-item"${t.comp?' style="opacity:.55"':''}>
        <span class="tx-date">${t.fecha||''}</span>
        <span class="tx-cat ${ING_CSS[t.cat]||'cat-otro2'}">${ING_CATS[t.cat]||t.cat}</span>
        <span class="tx-desc">${escapeHtml(t.desc)}${t.comp?COMP_TAG:''}${t.nd?` <span class="tx-sub">(dev:${fmt(t.nd.total_dev||0)}€ / ded:${fmt(t.nd.total_ded||0)}€)</span>`:''}</span>
        <span class="tx-amt">${fmt2(t.amt)}€</span>
        ${t.nd?`<button type="button" class="btn-xs" onclick="viewNominaDesglose(this.dataset.id)" data-id="${t.id}" title="Consultar desglose">🔍</button>`:''}
        ${nrBtn('i',t.id)}
        <button type="button" class="btn-xs" onclick="editIngTx(this.dataset.i)" data-i="${i}" title="Editar">✏️</button>
        <button type="button" class="btn-xs danger" onclick="deleteIngTx(this.dataset.id)" data-id="${t.id}" title="Eliminar">✕</button>
      </div>`).join('')
    +`<div style="display:flex;justify-content:space-between;padding:.4rem .75rem;background:var(--surface2);border-radius:var(--r-xs);font-size:12.5px;font-weight:700;border:.5px solid var(--border)">
        <span>Total ingresos${nC?` <span style="font-weight:400;font-size:11px;color:var(--muted)">· ${nC} compensado${nC!==1?'s':''} fuera (${fmt(sC)}€)</span>`:''}</span><span class="pos">${fmt(total)}€</span>
      </div>`
    :'<p style="font-size:11.5px;color:var(--faint);padding:.25rem 0">Sin ingresos introducidos. Usa el formulario de abajo para añadir.</p>';
  // Sync hidden fields for calcSummary
  const nom=sumaNeta(_ingresos.filter(t=>t.cat==='nomina'));
  const ipt=sumaNeta(_ingresos.filter(t=>t.cat==='ipt'));
  const otros=sumaNeta(_ingresos.filter(t=>!['nomina','ipt'].includes(t.cat)));
  const hf=id=>document.getElementById(id);
  if(hf('fi-nom'))hf('fi-nom').value=nom.toFixed(2);
  if(hf('fi-ipt'))hf('fi-ipt').value=ipt.toFixed(2);
  if(hf('fi-otros'))hf('fi-otros').value=otros.toFixed(2);
  calcSummary();
}

function addIngTx(){
  const fecha=document.getElementById('ing-fecha')?.value||todayISO();
  const desc=document.getElementById('ing-desc')?.value.trim()||'Ingreso';
  const cat=document.getElementById('ing-cat')?.value||'otro2';
  const amt=parseFloat(document.getElementById('ing-amt')?.value)||0;
  if(amt<=0){toast('Introduce un importe');return;}
  const editId=document.getElementById('ing-edit-idx')?.value;
  if(editId){
    const entry=incomeLog.find(e=>e.id===editId);
    if(entry){entry.date=fecha;entry.desc=desc;entry.cat=cat;entry.amt=amt;}
    document.getElementById('ing-edit-idx').value='';
    toast('Ingreso modificado');
  } else {
    incomeLog.push({id:'ing_'+Date.now(),date:fecha,desc,cat,amt});
    toast('Ingreso guardado: '+fmt(amt)+'€ ('+fecha+')');
  }
  save();
  document.getElementById('ing-desc').value='';
  document.getElementById('ing-amt').value='';
  const btn=document.getElementById('ing-add-btn');
  if(btn)btn.textContent='+ Añadir';
  loadMonthEntries();renderTxIngList();renderAll();
}

function editIngTx(idx){
  const t=_ingresos[parseInt(idx)];
  if(!t)return;
  const g=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v||'';};
  g('ing-fecha',t.fecha);
  g('ing-desc',t.desc);
  g('ing-amt',t.amt);
  const catSel=document.getElementById('ing-cat');if(catSel)catSel.value=t.cat;
  // Si la entrada tiene desglose de nómina, cargarlo en el formulario
  const full=incomeLog.find(e=>e.id===t.id)||t;
  if(full&&full.nd&&(full.nd.devengos||full.nd.deducciones)){
    loadNominaData(full.nd);
  }
  let idxField=document.getElementById('ing-edit-idx');
  if(!idxField){
    idxField=document.createElement('input');
    idxField.type='hidden';idxField.id='ing-edit-idx';
    document.getElementById('add-ing-panel')?.appendChild(idxField);
  }
  idxField.value=t.id; // store the persistent entry id
  const btn=document.getElementById('ing-add-btn');
  if(btn)btn.textContent='✓ Guardar cambios';
  document.getElementById('ing-desc')?.focus();
  toast('Editando — modifica y pulsa Guardar cambios');
}

function deleteIngTx(entryId){
  incomeLog=incomeLog.filter(e=>e.id!==entryId);
  save();loadMonthEntries();renderTxIngList();renderAll();toast('Ingreso eliminado');
}

function addNominaAsTx(){
  const liq=parseFloat(document.getElementById('n-liq')?.textContent?.replace(/[^\d,.]/g,'').replace(',','.'))||0;
  if(liq<=0){toast('Calcula primero la nómina arriba');return;}
  const fecha=document.getElementById('nom-fecha')?.value||todayISO();
  const nd=getNominaData();
  incomeLog.push({id:'nom_'+Date.now(),date:fecha,desc:'Nómina',cat:'nomina',amt:liq,nd});
  save();loadMonthEntries();renderTxIngList();renderAll();
  document.getElementById('nom-box')?.classList.remove('open');
  document.getElementById('nom-toggle-btn')?.classList.remove('open');
  toast('Nómina guardada: '+fmt(liq)+'€ líquidos ('+fecha+')');
}

const CAT_LABELS={hogar:'Hogar',alimentacion:'Alimentación',luz:'Luz',agua:'Agua',suministros:'Suministros',suscripciones:'Suscripciones',estanco:'Estanco',vehiculo:'Vehículo',salud:'Salud',
  restaurante:'Restaurante',ropa:'Ropa',viaje:'Viaje',ocio:'Ocio',otro:'Otro'};
const CAT_CSS={hogar:'cat-hogar',alimentacion:'cat-alimentacion',luz:'cat-luz',agua:'cat-agua',suministros:'cat-suministros',suscripciones:'cat-suscripciones',estanco:'cat-estanco',vehiculo:'cat-vehiculo',salud:'cat-salud',
  restaurante:'cat-restaurante',ropa:'cat-ropa',viaje:'cat-viaje',ocio:'cat-ocio',otro:'cat-otro'};

function renderGastosList(){
  renderFijosList();
  // Populate category selects with all categories (incl. new ones)
  ['gest-cat','gocio-cat'].forEach(id=>{const sel=document.getElementById(id);if(sel){const cur=sel.value;sel.innerHTML=Object.entries(CAT_LABELS).map(([k,v])=>'<option value="'+k+'">'+v+'</option>').join('');if(cur)sel.value=cur;}});
  const mkRows=(arr,kind)=>arr.length?arr.map((g)=>`
    <div class="gasto-item"${g.comp?' style="opacity:.55"':''}>
      <span class="tx-date" style="min-width:58px">${fmtDate(g.date)}</span>
      <span class="gasto-item-cat ${CAT_CSS[g.cat]||'cat-otro'}">${CAT_LABELS[g.cat]||g.cat}</span>
      <span class="gasto-item-name">${escapeHtml(g.name)}${g.comp?COMP_TAG:''}</span>
      <span class="gasto-item-amt">${fmt2(g.amt)}€</span>
      ${nrBtn('e',g.id)}
      <button type="button" class="btn-xs" onclick="editExpense('${kind}',this.dataset.id)" data-id="${g.id}" title="Editar">✏️</button>
      <button type="button" class="btn-xs danger" onclick="deleteExpense(this.dataset.id)" data-id="${g.id}" title="Eliminar">✕</button>
    </div>`).join('')
    :'<p style="font-size:11.5px;color:var(--faint);padding:.25rem 0">Ninguno registrado.</p>';
  const mkColl=(arr,kind)=>{
    if(arr.length<=6) return mkRows(arr,kind);
    const total=sumaNeta(arr);const nC=nComp(arr);const cid='coll-'+kind;
    return `<div class="coll-head" onclick="toggleColl('${cid}')">
      <span style="font-size:12px;font-weight:600">${arr.length} movimientos${nC?' · '+nC+' comp.':''}</span>
      <span style="font-size:12px"><strong>${fmt(total)}€</strong> <span id="${cid}-arr" class="coll-arr">▾</span></span></div>
      <div id="${cid}" style="display:none;margin-top:.3rem">${mkRows(arr,kind)}</div>`;
  };
  const el1=document.getElementById('list-gastos-est');
  const el2=document.getElementById('list-gastos-ocio');
  // Populate filter category dropdown (once + keep selection)
  const fcat=document.getElementById('gf-cat');
  if(fcat){const cur=fcat.value;fcat.innerHTML='<option value="">Todas las categorías</option>'+Object.entries(CAT_LABELS).map(([k,v])=>'<option value="'+k+'">'+v+'</option>').join('');if(cur)fcat.value=cur;}
  // Read filter values
  const fText=(document.getElementById('gf-text')?.value||'').trim().toLowerCase();
  const fC=document.getElementById('gf-cat')?.value||'';
  const fFrom=document.getElementById('gf-from')?.value||'';
  const fTo=document.getElementById('gf-to')?.value||'';
  const active=fText||fC||fFrom||fTo;
  const estFiltered=_gastosEst.filter(g=>{
    if(fText&&!((g.name||'').toLowerCase().includes(fText)))return false;
    if(fC&&g.cat!==fC)return false;
    if(fFrom&&(g.date||'')<fFrom)return false;
    if(fTo&&(g.date||'')>fTo)return false;
    return true;
  });
  if(el1){
    let html='';
    if(active){
      const tot=sumaNeta(estFiltered);
      html='<div style="font-size:11.5px;color:var(--navy);font-weight:600;padding:.3rem .1rem">'+estFiltered.length+' resultados · '+fmt(tot)+'€ <a href="#" onclick="event.preventDefault();clearGestFilter()" style="font-weight:400;color:var(--muted);margin-left:.4rem">✕ quitar filtro</a></div>';
      html+=mkRows(estFiltered,'estructural');
    } else {
      html=mkColl(_gastosEst,'estructural');
    }
    el1.innerHTML=html;
  }
  if(el2)el2.innerHTML=mkColl(_gastosOcio,'ocio');
  const tot=getGastosFijosTotal()+sumaNeta(_gastosEst)+sumaNeta(_gastosOcio);
  const el=document.getElementById('gasto-total-display');
  if(el)el.textContent=fmt(tot)+'€';
  calcSummary();
}
function clearGestFilter(){
  ['gf-text','gf-cat','gf-from','gf-to'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  renderGastosList();
}
function toggleColl(id){
  const b=document.getElementById(id);const a=document.getElementById(id+'-arr');
  if(!b)return;const open=b.style.display!=='none';
  b.style.display=open?'none':'';if(a)a.textContent=open?'▾':'▴';
}

function deleteExpense(entryId){
  expenseLog=expenseLog.filter(e=>e.id!==entryId);
  save();loadMonthEntries();renderGastosList();renderAll();toast('Gasto eliminado');
}
function recatByConcept(name,cat){
  const first=(String(name||'').trim().split(/\s+/)[0]||'').toLowerCase();
  const kw=prompt('Aplicar la categoría «'+(CAT_LABELS[cat]||cat)+'» a TODOS los gastos que contengan este texto (edítalo si quieres; Cancelar = solo este gasto):', first);
  if(kw==null)return 0;
  const k=kw.trim().toLowerCase();
  if(!k)return 0;
  let n=0; expenseLog.forEach(x=>{if((x.name||'').toLowerCase().includes(k)){x.cat=cat;n++;}});
  if(!cfg.catRules)cfg.catRules=[];
  if(!cfg.catRules.some(r=>(r.m||'').toLowerCase()===k)) cfg.catRules.push({m:kw.trim(),cat});
  toast(n+' gastos → '+(CAT_LABELS[cat]||cat)+' · regla creada para futuras importaciones');
  return n;
}
function addGastoEst(){
  const name=document.getElementById('gest-name')?.value.trim();
  const amt=parseFloat(document.getElementById('gest-amt')?.value)||0;
  const cat=document.getElementById('gest-cat')?.value||'otro';
  const date=document.getElementById('gest-date')?.value||todayISO();
  const editId=document.getElementById('gest-edit-id')?.value||'';
  if(!name||amt<=0){toast('Introduce descripción e importe');return;}
  if(editId){const e=expenseLog.find(x=>x.id===editId);const oldCat=e?e.cat:null;if(e){if(e.name&&e.name!==name&&/^exp_/.test(String(e.id))){e.alias=e.alias||[];if(!e.alias.includes(e.name))e.alias.push(e.name);}e.name=name;e.amt=amt;e.cat=cat;e.date=date;}   /* v164 · el nombre del banco se recuerda */document.getElementById('gest-edit-id').value='';
    if(e&&oldCat!==cat)recatByConcept(name,cat);}
  else expenseLog.push({id:'ge_'+Date.now(),date,name,amt,cat,kind:'estructural'});
  save();
  document.getElementById('gest-name').value='';document.getElementById('gest-amt').value='';
  togglePanel('add-est',true);loadMonthEntries();renderGastosList();renderAll();toast('Gasto estructural guardado');
}
function addGastoOcio(){
  const name=document.getElementById('gocio-name')?.value.trim();
  const amt=parseFloat(document.getElementById('gocio-amt')?.value)||0;
  const cat=document.getElementById('gocio-cat')?.value||'ocio';
  const date=document.getElementById('gocio-date')?.value||todayISO();
  const editId=document.getElementById('gocio-edit-id')?.value||'';
  if(!name||amt<=0){toast('Introduce descripción e importe');return;}
  if(editId){const e=expenseLog.find(x=>x.id===editId);const oldCat=e?e.cat:null;if(e){if(e.name&&e.name!==name&&/^exp_/.test(String(e.id))){e.alias=e.alias||[];if(!e.alias.includes(e.name))e.alias.push(e.name);}e.name=name;e.amt=amt;e.cat=cat;e.date=date;}   /* v164 · el nombre del banco se recuerda */document.getElementById('gocio-edit-id').value='';
    if(e&&oldCat!==cat)recatByConcept(name,cat);}
  else expenseLog.push({id:'go_'+Date.now(),date,name,amt,cat,kind:'ocio'});
  save();
  document.getElementById('gocio-name').value='';document.getElementById('gocio-amt').value='';
  togglePanel('add-ocio',true);loadMonthEntries();renderGastosList();renderAll();toast('Gasto de ocio guardado');
}
function getGastosFijosTotal(){
  // Sum of all fijo entries currently shown (for the summary total in the form)
  const _ce=(typeof compExpenseIds==='function')?compExpenseIds():new Set();
  return expenseLog.filter(e=>e.kind==='fijo').reduce((s,e)=>s+(_ce.has(e.id)?0:(e.amt||0)),0);
}

// Populate the fijo-type dropdown and list all fijo payments (dated)
function renderFijosList(){
  const sel=document.getElementById('gfijo-tipo');
  if(sel){
    sel.innerHTML=(cfg.gastos_fijos||[]).map(f=>'<option value="'+f.id+'">'+f.name+'</option>').join('')
      ||'<option value="">— crea un concepto abajo —</option>';
  }
  const el=document.getElementById('list-gastos-fijos');
  if(!el) return;
  const fijos=expenseLog.filter(e=>e.kind==='fijo').sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  if(!fijos.length){
    el.innerHTML='<p style="font-size:11.5px;color:var(--faint);padding:.25rem 0">Sin pagos fijos registrados. Usa "+ Añadir pago".</p>';
  } else {
    el.innerHTML=fijos.map(function(e){
      return '<div class="gasto-item">'+
        '<span class="tx-date" style="min-width:58px">'+fmtDate(e.date)+'</span>'+
        '<span class="gasto-item-cat cat-hogar">'+escapeHtml(e.name)+'</span>'+
        '<span class="gasto-item-name"></span>'+
        '<span class="gasto-item-amt">'+fmt2(e.amt)+'€</span>'+
        '<button type="button" class="btn-xs" onclick="editExpenseFijo(this.dataset.id)" data-id="'+e.id+'" title="Editar">✏️</button>'+
        '<button type="button" class="btn-xs danger" onclick="deleteExpense(this.dataset.id)" data-id="'+e.id+'" title="Eliminar">✕</button>'+
      '</div>';
    }).join('');
  }
  calcSummary();
}

function addGastoFijoPago(){
  const fijoId=document.getElementById('gfijo-tipo')?.value||'';
  const amt=parseFloat(document.getElementById('gfijo-amt')?.value)||0;
  const date=document.getElementById('gfijo-date')?.value||todayISO();
  const editId=document.getElementById('gfijo-edit-id')?.value||'';
  if(!fijoId){toast('Elige un concepto (o crea uno)');return;}
  if(amt<=0){toast('Introduce el importe');return;}
  const fname=(cfg.gastos_fijos||[]).find(f=>f.id===fijoId)?.name||fijoId;
  if(editId){const e=expenseLog.find(x=>x.id===editId);if(e){e.fijoId=fijoId;e.name=fname;e.amt=amt;e.date=date;}document.getElementById('gfijo-edit-id').value='';}
  else expenseLog.push({id:'gf_'+Date.now(),date,name:fname,amt,cat:'hogar',kind:'fijo',fijoId});
  save();
  document.getElementById('gfijo-amt').value='';
  togglePanel('add-fijo-pago',true);loadMonthEntries();renderGastosList();renderAll();toast('Pago fijo guardado: '+fname+' '+fmt(amt)+'€');
}

function editExpenseFijo(id){
  const e=expenseLog.find(x=>x.id===id);if(!e)return;
  const p=document.getElementById('add-fijo-pago');if(p&&!p.classList.contains('open'))p.classList.add('open');
  const g=(i,v)=>{const el=document.getElementById(i);if(el)el.value=v;};
  g('gfijo-tipo',e.fijoId);g('gfijo-amt',e.amt);g('gfijo-date',e.date);
  let f=document.getElementById('gfijo-edit-id');
  if(!f){f=document.createElement('input');f.type='hidden';f.id='gfijo-edit-id';p.appendChild(f);}
  f.value=id;toast('Editando pago fijo — modifica y Añadir');
}
function reclassifyAllExpenses(){
  if(!expenseLog.length){toast('No hay gastos que reclasificar');return;}
  if(!confirm('Reclasificar los '+expenseLog.length+' gastos aplicando tus reglas propias y las automáticas (Mercadona→Alimentación, Endesa→Luz, Hidraqua→Agua, Estanco→Estanco, iTunes/Google/PayPal→Suscripciones, etc.).\n\nSe reasigna la categoría según el comercio. ¿Continuar?'))return;
  if(!guardedAction('reclasificar todos los gastos'))return;
  let changed=0;const byCat={};
  expenseLog.forEach(x=>{if(x.kind==='fijo')return;const nc=catExpense(x.name||'');if(nc!==x.cat){x.cat=nc;changed++;}byCat[nc]=(byCat[nc]||0)+1;});
  save();renderGastosList();renderAll();
  const resumen=Object.entries(byCat).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([c,n])=>(CAT_LABELS[c]||c)+': '+n).join(' · ');
  toast('✅ '+changed+' gastos reclasificados');
  setTimeout(()=>alert('Reclasificación terminada.\n\n'+changed+' gastos cambiaron de categoría.\n\nReparto actual:\n'+resumen),200);
}
function editExpense(kind,id){
  const e=expenseLog.find(x=>x.id===id);if(!e)return;
  const pre=kind==='estructural'?'gest':'gocio';
  const panel=document.getElementById(kind==='estructural'?'add-est':'add-ocio');
  if(panel&&!panel.classList.contains('open'))panel.classList.add('open');
  const g=(i,v)=>{const el=document.getElementById(i);if(el)el.value=v;};
  g(pre+'-name',e.name);g(pre+'-amt',e.amt);g(pre+'-cat',e.cat);g(pre+'-date',e.date);
  let f=document.getElementById(pre+'-edit-id');
  if(!f){f=document.createElement('input');f.type='hidden';f.id=pre+'-edit-id';panel.appendChild(f);}
  f.value=id;
  if(panel){panel.scrollIntoView({behavior:'smooth',block:'center'});const nm=document.getElementById(pre+'-name');if(nm)setTimeout(()=>nm.focus(),300);}
  toast('✏️ Editando «'+(e.name||'').slice(0,24)+'» — cambia y pulsa Añadir');
}

function addGastoFijo(){
  const name=document.getElementById('new-fijo-name')?.value.trim();
  if(!name){toast('Introduce el nombre del concepto');return;}
  if(!cfg.gastos_fijos) cfg.gastos_fijos=[];
  cfg.gastos_fijos.push({id:'gf_'+Date.now(),name});
  document.getElementById('new-fijo-name').value='';
  save();renderFijosList();toast('Concepto creado: '+name);
}

function removeGastoFijo(id){
  cfg.gastos_fijos=(cfg.gastos_fijos||[]).filter(f=>f.id!==id);
  save();renderFijosList();renderAll();toast('Concepto eliminado');
}
function collectGastosData(){
  const fijos={};
  expenseLog.filter(e=>e.kind==='fijo').forEach(e=>{fijos[e.fijoId]=(fijos[e.fijoId]||0)+e.amt;});
  return{fijos,estructurales:[..._gastosEst],ocio:[..._gastosOcio]};
}

// ═══════════════════════════════════════════════════════════════════════
// GASTOS DASHBOARD
// ═══════════════════════════════════════════════════════════════════════
let chartGastosPie=null,chartGastosBar=null;
function renderGastosDashboard(){
  // v130 · esto leía last().gastos_data, que es el último registro mensual
  // GUARDADO (enero de 2026) y venía vacío. Ahora sale del registro de gastos
  // de verdad, y se agrupa por categoría, que es como los tienes clasificados:
  // el reparto fijo/estructural/ocio no dice nada cuando más de mil gastos
  // están marcados como estructurales.
  const M=(typeof mesesConDatos==='function')?mesesConDatos():[];
  const ymAct=M.length?M[M.length-1]:String(todayISO()).slice(0,7);
  const G=gastosMes(ymAct);
  const ult12=M.slice(-12);
  const serie=ult12.map(m=>({m,g:gastosMes(m)}));
  const avg12=serie.length?serie.reduce((s,x)=>s+x.g.total,0)/serie.length:0;
  const mesAnt=M.length>1?gastosMes(M[M.length-2]):null;
  const periodoEl=document.getElementById('gastos-periodo');
  if(periodoEl)periodoEl.textContent=(typeof fmtMonth==='function'?fmtMonth(ymAct):ymAct)+' · '+G.lista.length+' apuntes';
  const sumEl=document.getElementById('gastos-summary');
  if(sumEl){
    const top=G.cats.slice(0,3);
    const delta=mesAnt?G.total-mesAnt.total:null;
    sumEl.innerHTML=
      top.map((c,i)=>'<div class="gastos-kpi"><div class="gastos-kpi-lbl">'+escapeHtml(c.nombre)+'</div>'+
        '<div class="gastos-kpi-val" style="color:'+['var(--navy)','var(--amber)','var(--purple)'][i]+'">'+fmt(c.v)+'€</div>'+
        '<div class="gastos-kpi-sub">'+Math.round(c.v/(G.total||1)*100)+'% del mes</div></div>').join('')+
      '<div class="gastos-kpi" style="border-color:var(--navy)"><div class="gastos-kpi-lbl">Total del mes</div>'+
        '<div class="gastos-kpi-val" style="color:var(--navy)">'+fmt(G.total)+'€</div>'+
        '<div class="gastos-kpi-sub">media 12m: '+fmt(Math.round(avg12))+'€'+
        (delta!=null?' · '+(delta>=0?'+':'−')+fmt(Math.abs(Math.round(delta)))+'€ vs mes anterior':'')+'</div></div>';
  }
  if(chartGastosPie)chartGastosPie.destroy();
  const pieCv=document.getElementById('cGastosPie');
  const PAL=['#0B3D91','#D35400','#6C3483','#12A594','#C0392B','#2a78d6','#C77D20','#8A97AB','#0E6B57','#7D3C98'];
  if(G.total>0){
    const top=G.cats.slice(0,8);
    const resto=G.cats.slice(8).reduce((s,c)=>s+c.v,0);
    const labs=top.map(c=>c.nombre).concat(resto>0?['Resto']:[]);
    const vals=top.map(c=>c.v).concat(resto>0?[resto]:[]);
    chartGastosPie=new Chart(pieCv,{type:'doughnut',
      data:{labels:labs,
        datasets:[{data:vals,backgroundColor:PAL.slice(0,vals.length),borderWidth:2,borderColor:'#fff'}]},
      options:{responsive:true,maintainAspectRatio:false,cutout:'65%',
        plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(15,25,35,.9)',titleColor:'#F9FAFB',bodyColor:'#CBD5E1',
          callbacks:{label(c){return c.label+': '+fmt(c.parsed)+'€';}}}}}
    });
    const legEl=document.getElementById('gastos-pie-legend');
    if(legEl)legEl.innerHTML=labs.map((l,i)=>'<span style="display:flex;align-items:center;gap:4px">'+
      '<span style="width:9px;height:9px;background:'+PAL[i]+';border-radius:2px;flex-shrink:0;display:inline-block"></span>'+
      escapeHtml(l)+': <strong>'+fmt(vals[i])+'€</strong></span>').join('');
  }else{
    const legEl=document.getElementById('gastos-pie-legend');
    if(legEl)legEl.innerHTML='<span style="color:var(--muted)">Sin gastos apuntados en '+ymAct+'.</span>';
  }
  if(chartGastosBar)chartGastosBar.destroy();
  // las cinco categorías más gordas del último mes, seguidas a lo largo del año
  const topCats=G.cats.slice(0,5).map(c=>c.cat);
  const dsCats=topCats.map((c,i)=>({label:catNombre(c),backgroundColor:PAL[i],barPercentage:.85,
    data:serie.map(x=>{const f=x.g.cats.find(z=>z.cat===c);return f?Math.round(f.v):0;})}));
  dsCats.push({label:'Resto',backgroundColor:'#8A97AB',barPercentage:.85,
    data:serie.map(x=>Math.round(x.g.cats.filter(z=>!topCats.includes(z.cat)).reduce((s,z)=>s+z.v,0)))});
  chartGastosBar=new Chart(document.getElementById('cGastosBar'),{type:'bar',
    data:{labels:serie.map(x=>(typeof fmtMonth==='function'?fmtMonth(x.m):x.m)),datasets:dsCats},
    options:{responsive:true,maintainAspectRatio:false,
      scales:{x:{stacked:true,grid:{display:false},ticks:{color:'#8A97AB',font:{size:9},maxRotation:45,autoSkip:true}},
        y:{stacked:true,grid:{color:'rgba(0,0,0,.04)'},ticks:{color:'#8A97AB',font:{size:9},callback:v=>fmtK(v)+'€'}}},
      plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(15,25,35,.9)',titleColor:'#F9FAFB',bodyColor:'#CBD5E1',
        mode:'index',callbacks:{label(c){return c.dataset.label+': '+fmt(c.parsed.y)+'€';}}}}}
  });
  const detEl=document.getElementById('gastos-detalle');
  if(detEl){
    detEl.innerHTML=G.lista.length
      ?'<div style="font-size:12px;font-weight:600;margin-bottom:.4rem">Los mayores de '+(typeof fmtMonth==='function'?fmtMonth(ymAct):ymAct)+'</div>'+
       '<div class="tbl-scroll"><table class="detail-table" style="font-size:11.5px"><tbody>'+
       G.lista.slice(0,12).map(x=>'<tr><td style="text-align:left">'+escapeHtml(String(x.name).slice(0,40))+
         '</td><td style="text-align:left"><span class="gasto-item-cat '+((typeof CAT_CSS!=='undefined'&&CAT_CSS[x.cat])||'cat-otro')+'">'+
         escapeHtml(catNombre(x.cat))+'</span></td><td style="text-align:right">'+fmtDate(x.date)+
         '</td><td style="text-align:right" class="neg">'+fmt2(x.amt)+'€</td></tr>').join('')+
       '</tbody></table></div>'+
       (G.lista.length>12?'<div style="font-size:10.5px;color:var(--faint);margin-top:.3rem">y '+(G.lista.length-12)+' apuntes más</div>':'')
      :'<div style="font-size:11.5px;color:var(--muted)">Sin gastos apuntados este mes.</div>';
    if(typeof markScrollables==='function')markScrollables(detEl);
  }
}



// ─── NEW STOCK OPERATION FUNCTIONS ──────────────────────────────────
function openStockOp(type){
  // Close both panels first
  document.getElementById('stock-op-buy')?.classList.remove('open');
  document.getElementById('stock-op-sell')?.classList.remove('open');
  // Clear edit IDs
  const eid1=document.getElementById('ns-edit-id');if(eid1)eid1.value='';
  const eid2=document.getElementById('sv-edit-id');if(eid2)eid2.value='';
  if(type==='buy'){
    document.getElementById('stock-op-buy')?.classList.add('open');
    // Set today's date as default
    const dEl=document.getElementById('ns-date');
    if(dEl&&!dEl.value) dEl.value=todayISO();
    document.getElementById('ns-name')?.focus();
  } else if(type==='sell'){
    document.getElementById('stock-op-sell')?.classList.add('open');
    const dEl=document.getElementById('sv-date');
    if(dEl&&!dEl.value) dEl.value=todayISO();
    // Populate dropdown with stocks currently in portfolio (open positions with remaining shares)
    const sel=document.getElementById('sv-stock');
    if(sel){
      const agg=getStockAggregates();
      const open=cfg.stocks.filter(s=>agg[s.id]&&agg[s.id].totalShares>1e-6&&!agg[s.id].isClosed);
      sel.innerHTML='<option value="">— Elige una acción —</option>'+
        open.map(s=>{
          const a=agg[s.id];
          return '<option value="'+s.id+'">'+s.name+' ('+fmt(a.totalShares)+' acc disponibles)</option>';
        }).join('');
      if(!open.length){
        sel.innerHTML='<option value="">No hay acciones en cartera</option>';
      }
    }
    document.getElementById('sv-stock')?.focus();
  }
}

function calcSellOp(){
  const sid=document.getElementById('sv-stock')?.value||'';
  const shares=parseFloat(document.getElementById('sv-shares')?.value)||0;
  const priceRaw=parseFloat(document.getElementById('sv-price')?.value)||0;
  const costs=parseFloat(document.getElementById('sv-costs')?.value)||0;
  const cur=document.getElementById('sv-cur')?.value||'EUR';
  const rate=parseFloat(document.getElementById('sv-rate')?.value)||0;
  const isEur=cur==='EUR';
  const rateFld=document.getElementById('sv-rate-fld');if(rateFld)rateFld.style.display=isEur?'none':'';
  const lbl=document.getElementById('sv-cur-lbl');if(lbl)lbl.textContent=isEur?'€':cur;
  document.querySelectorAll('.sv-cur-lbl2').forEach(el=>el.textContent=cur);
  const price=isEur?priceRaw:(rate>0?priceRaw/rate:0);
  const total=shares*price-costs;
  const prev=document.getElementById('sv-preview');
  if(!(prev&&sid&&shares>0&&priceRaw>0&&(isEur||rate>0))){if(prev)prev.style.display='none';return;}
  let costBasis=null,avail=0;
  const stock=cfg.stocks.find(s=>s.id===sid);
  if(stock){
    const editId=document.getElementById('sv-edit-id')?.value||'';
    // Build FIFO lots from buys minus shares already sold (excluding the sell being edited)
    const txs=transactions.filter(t=>t.stockId===stock.id&&(t.type==='buy'||t.type==='sell')&&t.id!==editId)
      .slice().sort((a,b)=>{const d=(a.date||'').localeCompare(b.date||'');return d!==0?d:(a.type==='buy'?-1:1);});
    const lots=[];
    txs.forEach(t=>{
      if(t.type==='buy'){const sh=t.shares||0;lots.push({shares:sh,perShare:sh>0?((t.total||0)+(t.costs||0))/sh:0});}
      else{let ts=t.shares||0;while(ts>1e-9&&lots.length){const lot=lots[0];const take=Math.min(ts,lot.shares);lot.shares-=take;ts-=take;if(lot.shares<=1e-9)lots.shift();}}
    });
    avail=lots.reduce((s,l)=>s+l.shares,0);
    let toSell=shares,cost=0;
    while(toSell>1e-9&&lots.length){const lot=lots[0];const take=Math.min(toSell,lot.shares);cost+=take*lot.perShare;lot.shares-=take;toSell-=take;if(lot.shares<=1e-9)lots.shift();}
    costBasis=Math.round(cost*100)/100;
  }
  const gl=costBasis!==null?Math.round((total-costBasis)*100)/100:null;
  const irpf=gl!==null&&gl>0?calcIRPFGain(gl):0;
  prev.style.display='block';
  prev.innerHTML='Ingreso neto venta: <strong>'+fmt(total)+'€</strong>'
    +(costBasis!==null?'<br>Coste FIFO de '+fmt(shares)+' acc: <strong>'+fmt(costBasis)+'€</strong>':'')
    +(gl!==null?'<br>Plusvalía/minusvalía: <strong class="'+(gl>=0?'pos':'neg')+'">'+(gl>=0?'+':'')+fmt(gl)+'€</strong>':'')
    +(irpf>0?' · IRPF est.: <strong class="neg">'+fmt(irpf)+'€</strong>':'')
    +(shares>avail+1e-6?'<br><span style="color:var(--red)">⚠ Vendes '+fmt(shares)+' pero solo tienes '+fmt(avail)+' acc disponibles</span>':'');
}

function addStockSell(){
  const sid=document.getElementById('sv-stock')?.value||'';
  const shares=parseFloat(document.getElementById('sv-shares')?.value)||0;
  const priceRaw=parseFloat(document.getElementById('sv-price')?.value)||0;
  const costs=parseFloat(document.getElementById('sv-costs')?.value)||0;
  const cur=document.getElementById('sv-cur')?.value||'EUR';
  const rate=parseFloat(document.getElementById('sv-rate')?.value)||0;
  const date=document.getElementById('sv-date')?.value||todayISO();
  const fullySold=document.getElementById('sv-full')?.checked;
  const exitReason=document.getElementById('sv-exit')?.value||'';
  const editId=document.getElementById('sv-edit-id')?.value||'';
  if(!sid){toast('Elige una acción de la cartera');return;}
  if(!shares||!priceRaw){toast('Rellena nº acciones y precio');return;}
  if(cur!=='EUR'&&rate<=0){toast('Introduce el tipo de cambio');return;}
  const price=cur==='EUR'?priceRaw:Math.round((priceRaw/rate)*1e6)/1e6; // EUR per share
  const stock=cfg.stocks.find(s=>s.id===sid);
  if(!stock){toast('Acción no encontrada');return;}
  // Verify available shares (excluding the sell being edited)
  const agg=getStockAggregates();
  let avail=agg[sid]?agg[sid].totalShares:0;
  if(editId){const prevSell=transactions.find(t=>t.id===editId);if(prevSell)avail+=prevSell.shares||0;}
  if(shares>avail+1e-6){
    toast('No puedes vender '+fmt(shares)+' acc — solo tienes '+fmt(avail)+' en cartera');return;
  }
  if(editId) transactions=transactions.filter(t=>t.id!==editId);
  const total=shares*price-costs;
  const txYear=date?parseInt(date.slice(0,4)):last().year;
  const txId='tx_'+Date.now();
  const cxtra=cur!=='EUR'?{currency:cur,rate,priceForeign:priceRaw}:{};
  transactions.push({id:txId,stockId:sid,stockName:stock.name,type:'sell',date,shares,price,
    costs,total,costBasis:0,gainLoss:0,year:txYear,fullyLiquidated:fullySold,exitReason:exitReason||undefined,...cxtra});
  recomputeAllStockGains();
  if(fullySold) soldStocks.add(sid);
  save();openStockOp(null);renderStockTxList();renderAll();
  const savedTx=transactions.find(t=>t.id===txId);
  const gl=savedTx?savedTx.gainLoss:0;
  toast((fullySold?'✅ Posición cerrada':'Venta registrada')+' · '+stock.name
    +' · P/L (FIFO): '+(gl>=0?'+':'')+fmt(gl)+'€');
}

// Section collapse state
let _stockSections={open:false,movs:false,closed:false,broker:false};

function renderBrokerLiquiditySummary(){
  const el=document.getElementById('broker-liq-summary');
  if(!el)return;
  const brokers=cfg.brokers||[];
  const total=getBrokerLiquidityNow();
  if(!brokers.length){
    el.innerHTML='<div style="font-size:11.5px;color:var(--faint);padding:.375rem .625rem;background:var(--surface2);border-radius:var(--r-xs)">Sin brokers. Añade uno para registrar tu liquidez sin invertir (cuenta como cash).</div>';
    return;
  }
  el.innerHTML='<div style="background:#E6F4F1;border:1px solid #9CD3C8;border-radius:var(--r-sm);padding:.5rem .75rem">'+
    '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:.5rem;align-items:baseline">'+
      '<strong style="font-size:12px;color:var(--teal)">Liquidez en broker ('+brokers.length+')</strong>'+
      '<span style="font-size:12.5px">Total: <strong>'+fmt(total)+'€</strong> <small style="color:var(--faint)">(cuenta como cash)</small></span>'+
    '</div></div>';
}

function renderBrokerLiquidityList(){
  const el=document.getElementById('broker-liq-list');
  if(!el)return;
  const brokers=cfg.brokers||[];
  if(!brokers.length){el.innerHTML='<p style="font-size:11.5px;color:var(--faint)">Sin brokers registrados.</p>';return;}
  const today=new Date();
  const staleThreshold=isoLocal(new Date(today.getTime()-35*864e5));
  el.innerHTML=brokers.map(function(b){
    const info=getBrokerInfo(b.id);
    const val=info.amount||0;
    const dateStr=info.source==='none'?'sin registrar':fmtDate(info.date);
    const isStale=info.source==='none'||(info.date<staleThreshold);
    const dateColor=info.source==='none'?'var(--red)':(isStale?'var(--amber)':'var(--teal)');
    const hist=(typeof balanceLog!=='undefined')?balanceLog.filter(x=>x.refType==='broker'&&x.refId===b.id)
      .sort((x,y)=>(y.date||'').localeCompare(x.date||'')):[];
    const histHtml=hist.length?('<div style="font-size:10px;color:var(--muted);margin-top:3px">Saldos: '+
      hist.slice(0,5).map(e=>'<span style="white-space:nowrap">'+fmtDate(e.date)+': <strong>'+fmt2(e.amount)+'€</strong> '+
        '<a href="#" onclick="deleteBalance(event,&quot;'+e.id+'&quot;)" style="text-decoration:none">✕</a></span>').join(' · ')+
      (hist.length>5?' …':'')+'</div>'):'';
    return '<div style="background:var(--surface2);border:.5px solid var(--border);border-radius:var(--r-xs);padding:.5rem .625rem;margin-bottom:5px">'+
      '<div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">'+
        '<span style="flex:1;min-width:110px;font-size:12.5px;font-weight:600">🏦 '+b.name+'</span>'+
        '<span style="font-size:11.5px">Liquidez: <strong>'+(val>0?fmt2(val)+'€':'—')+'</strong></span>'+
        '<button type="button" class="btn-xs" style="color:var(--teal);border-color:var(--teal);flex-shrink:0" onclick="toggleBalPanel(&quot;broker&quot;,&quot;'+b.id+'&quot;)">+ Saldo</button>'+
        '<button type="button" class="btn-xs" style="color:var(--navy);border-color:var(--navy);flex-shrink:0" onclick="toggleBrokerFlowPanel(&quot;'+b.id+'&quot;)">+ Aporta/Retira</button>'+
        '<button type="button" class="btn-xs danger" style="flex-shrink:0" onclick="removeBroker(&quot;'+b.id+'&quot;)">✕</button>'+
      '</div>'+
      '<div style="font-size:10px;color:'+dateColor+';margin-top:2px">Actualizado: '+dateStr+(isStale&&info.source!=='none'?' ⚠':'')+'</div>'+
      histHtml+
      brokerFlowsHtml(b.id)+
      '<div class="add-panel" id="bal-broker-'+b.id+'" style="background:#E6F4F1;border-color:#9CD3C8;margin-top:.4rem">'+
        '<div class="add-panel-title" style="color:var(--teal)">Registrar liquidez — '+b.name+'</div>'+
        '<div class="add-panel-row">'+
          '<div class="fld"><label>Fecha</label><input type="date" id="bal-broker-date-'+b.id+'" value="'+todayISO()+'"></div>'+
          '<div class="fld"><label>Saldo en liquidez (€)</label><input type="number" id="bal-broker-amt-'+b.id+'" placeholder="0" step="0.01"></div>'+
          '<div class="add-panel-btns">'+
            '<button type="button" class="btn-xs" style="background:var(--teal);color:#fff;border-color:var(--teal)" onclick="addBalance(&quot;broker&quot;,&quot;'+b.id+'&quot;)">Guardar</button>'+
            '<button type="button" class="btn-xs" onclick="toggleBalPanel(&quot;broker&quot;,&quot;'+b.id+'&quot;)">Cerrar</button>'+
          '</div>'+
        '</div>'+
      '</div>'+
      // Aportación / Retirada panel
      '<div class="add-panel" id="bflow-'+b.id+'" style="background:#EBF0FA;border-color:#B8CAEE;margin-top:.4rem">'+
        '<div class="add-panel-title" style="color:var(--navy)">Aportación / retirada de efectivo — '+b.name+'</div>'+
        '<div class="add-panel-row">'+
          '<div class="fld"><label>Fecha</label><input type="date" id="bflow-date-'+b.id+'" value="'+todayISO()+'"></div>'+
          '<div class="fld"><label>Tipo</label><select id="bflow-type-'+b.id+'">'+
            '<option value="aporta">Aportación (metes dinero al broker)</option>'+
            '<option value="retira">Retirada (sacas dinero del broker)</option>'+
          '</select></div>'+
          '<div class="fld"><label>Importe (€)</label><input type="number" id="bflow-amt-'+b.id+'" placeholder="0" step="0.01" min="0"></div>'+
          '<div class="fld"><label>Cuenta origen/destino (opcional)</label><select id="bflow-acc-'+b.id+'">'+
            '<option value="">— sin especificar —</option>'+
            (cfg.accounts||[]).map(a=>'<option value="'+a.id+'">'+a.name+'</option>').join('')+
          '</select></div>'+
          '<div class="add-panel-btns">'+
            '<button type="button" class="btn-xs" style="background:var(--navy);color:#fff;border-color:var(--navy)" onclick="addBrokerFlow(&quot;'+b.id+'&quot;)">Guardar</button>'+
            '<button type="button" class="btn-xs" onclick="toggleBrokerFlowPanel(&quot;'+b.id+'&quot;)">Cerrar</button>'+
          '</div>'+
        '</div>'+
        '<div style="font-size:10px;color:var(--muted);padding:.15rem 0 0">Sirve para calcular la rentabilidad sobre tu dinero aportado. No cambia los saldos (esos los registras con "+ Saldo").</div>'+
      '</div>'+
    '</div>';
  }).join('');
}

function brokerFlowsHtml(brokerId){
  const flows=(brokerFlows||[]).filter(f=>f.brokerId===brokerId)
    .sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  if(!flows.length)return '';
  const aporta=flows.filter(f=>f.type==='aporta').reduce((s,f)=>s+(f.amount||0),0);
  const retira=flows.filter(f=>f.type==='retira').reduce((s,f)=>s+(f.amount||0),0);
  const neto=aporta-retira;
  return '<div style="font-size:10px;color:var(--muted);margin-top:3px;background:#EBF0FA;border-radius:var(--r-xs);padding:.35rem .5rem">'+
    '<strong style="color:var(--navy)">Movimientos de efectivo:</strong> aportado '+fmt2(aporta)+'€ · retirado '+fmt2(retira)+'€ · neto aportado <strong>'+fmt2(neto)+'€</strong><br>'+
    flows.slice(0,8).map(f=>'<span style="white-space:nowrap;display:inline-block;margin:2px 6px 2px 0">'+fmtDate(f.date)+': '+
      (f.type==='aporta'?'<span style="color:var(--green)">+':'<span style="color:var(--red)">−')+fmt2(f.amount)+'€</span>'+
      (f.accountId?(' <small>('+((cfg.accounts||[]).find(a=>a.id===f.accountId)||{}).name+')</small>'):'')+' '+
      '<a href="#" onclick="deleteBrokerFlow(event,&quot;'+f.id+'&quot;)" style="text-decoration:none">✕</a></span>').join(' · ')+
    (flows.length>8?' …':'')+'</div>';
}

function toggleBrokerFlowPanel(brokerId){
  const p=document.getElementById('bflow-'+brokerId);
  if(p)p.classList.toggle('open');
}
function addBrokerFlow(brokerId){
  const date=document.getElementById('bflow-date-'+brokerId)?.value||todayISO();
  const type=document.getElementById('bflow-type-'+brokerId)?.value||'aporta';
  const amount=parseFloat(document.getElementById('bflow-amt-'+brokerId)?.value)||0;
  const accountId=document.getElementById('bflow-acc-'+brokerId)?.value||'';
  if(amount<=0){toast('Introduce un importe mayor que 0');return;}
  brokerFlows.push({id:'bf_'+Date.now(),date,brokerId,type,amount,accountId:accountId||undefined});
  save();renderStockTxList();
  toast((type==='aporta'?'Aportación':'Retirada')+' registrada: '+fmt2(amount)+'€ a '+date);
}
function deleteBrokerFlow(ev,id){
  if(ev)ev.preventDefault();
  if(!confirm('¿Eliminar este movimiento?'))return;
  brokerFlows=brokerFlows.filter(f=>f.id!==id);
  save();renderStockTxList();toast('Movimiento eliminado');
}

function addBroker(){
  const name=document.getElementById('new-broker-name')?.value.trim();
  if(!name){toast('Introduce el nombre del broker');return;}
  if(!cfg.brokers)cfg.brokers=[];
  cfg.brokers.push({id:'brk_'+Date.now(),name});
  document.getElementById('new-broker-name').value='';
  save();togglePanel('add-broker',true);
  _stockSections.broker=true;
  const div=document.getElementById('broker-liq-list');if(div)div.style.display='block';
  const btn=document.getElementById('toggle-broker-btn');if(btn)btn.textContent='▾ Ocultar liquidez en broker';
  renderStockTxList();renderAll();toast('Broker creado: '+name);
}
function removeBroker(id){
  if(!confirm('¿Eliminar este broker y sus saldos de liquidez?'))return;
  cfg.brokers=(cfg.brokers||[]).filter(b=>b.id!==id);
  balanceLog=balanceLog.filter(e=>!(e.refType==='broker'&&e.refId===id));
  save();renderStockTxList();renderAll();toast('Broker eliminado');
}
function toggleStockSection(which){
  _stockSections[which]=!_stockSections[which];
  try{ALM.setItem('dlv_sections',JSON.stringify({..._stockSections,income:_incomeOpen}));}catch(e){fallo('ALM.setItem',e)}
  const map={open:['stock-positions','toggle-open-btn','posiciones abiertas y valores'],
    movs:['stock-tx-wrap','toggle-movs-btn','movimientos registrados'],
    closed:['stock-closed-list','toggle-closed-btn','operaciones cerradas'],
    broker:['broker-liq-list','toggle-broker-btn','liquidez en broker']};
  const [divId,btnId,label]=map[which];
  const div=document.getElementById(divId);
  const btn=document.getElementById(btnId);
  const on=_stockSections[which];
  if(div)div.style.display=on?'block':'none';
  if(btn)btn.textContent=(on?'▾ Ocultar ':'▸ Ver ')+label;
}

function renderStockOpenSummary(){
  const el=document.getElementById('stock-open-summary');
  if(!el)return;
  const agg=getStockAggregates();
  const open=cfg.stocks.filter(s=>agg[s.id]&&agg[s.id].totalShares>1e-6&&!agg[s.id].isClosed);
  let totalInv=0,totalVal=0,anyVal=false;
  open.forEach(s=>{
    const a=agg[s.id];
    totalInv+=a.totalBoughtValue||0;
    const v=getStockInfo(s.id).amount||0;
    if(v>0){totalVal+=v;anyVal=true;}
  });
  const pl=anyVal?totalVal-totalInv:null;
  const plPct=totalInv>0&&pl!==null?Math.round(pl/totalInv*100):null;
  if(!open.length){
    el.innerHTML='<div style="font-size:11.5px;color:var(--faint);padding:.375rem .625rem;background:var(--surface2);border-radius:var(--r-xs)">Sin posiciones abiertas.</div>';
    return;
  }
  el.innerHTML='<div style="background:#EBF0FA;border:1px solid #B8CAEE;border-radius:var(--r-sm);padding:.5rem .75rem">'+
    '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:.5rem;align-items:baseline">'+
      '<strong style="font-size:12px;color:var(--navy)">Cartera de acciones abierta ('+open.length+')</strong>'+
      '<span style="font-size:11.5px">Invertido: <strong>'+fmt(totalInv)+'€</strong></span>'+
      '<span style="font-size:11.5px">Valor actual: <strong>'+(anyVal?fmt(totalVal)+'€':'—')+'</strong></span>'+
      (pl!==null?'<span style="font-size:12.5px">Revalorización: <strong class="'+(pl>=0?'pos':'neg')+'">'+(pl>=0?'+':'')+fmt(pl)+'€'+(plPct!==null?' ('+(plPct>=0?'+':'')+plPct+'%)':'')+'</strong></span>':'<span style="font-size:11px;color:var(--faint)">Actualiza valores con "+ Valor"</span>')+
    '</div></div>';
}

function renderStockClosedSummary(){
  const el=document.getElementById('stock-closed-summary');
  if(!el)return;
  const nowY=new Date().getFullYear();
  const closedSells=transactions.filter(t=>t.type==='sell');
  const yearSells=closedSells.filter(t=>(t.year||parseInt((t.date||'').slice(0,4)))===nowY);
  const yearPL=yearSells.reduce((s,t)=>s+(t.gainLoss||0),0);
  if(!closedSells.length){
    el.innerHTML='';
    return;
  }
  el.innerHTML='<div style="background:#FEF5E0;border:1px solid #E0C060;border-radius:var(--r-sm);padding:.5rem .75rem">'+
    '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:.5rem;align-items:baseline">'+
      '<strong style="font-size:12px;color:var(--amber)">Operaciones cerradas '+nowY+'</strong>'+
      '<span style="font-size:11.5px">'+yearSells.length+' venta'+(yearSells.length!==1?'s':'')+'</span>'+
      '<span style="font-size:12.5px">Resultado '+nowY+': <strong class="'+(yearPL>=0?'pos':'neg')+'">'+(yearPL>=0?'+':'')+fmt(yearPL)+'€</strong></span>'+
    '</div></div>';
}

function renderStockClosedList(){
  const el=document.getElementById('stock-closed-list');
  if(!el)return;
  const sells=transactions.filter(t=>t.type==='sell')
    .sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  if(!sells.length){el.innerHTML='<p style="font-size:11.5px;color:var(--faint)">Sin operaciones cerradas.</p>';return;}
  // Group by year
  const byYear={};
  sells.forEach(t=>{const y=t.year||parseInt((t.date||'').slice(0,4))||'?';(byYear[y]=byYear[y]||[]).push(t);});
  el.innerHTML=Object.entries(byYear).sort(([a],[b])=>b-a).map(([y,txs])=>{
    const yPL=txs.reduce((s,t)=>s+(t.gainLoss||0),0);
    const rows=txs.map(t=>{
      const gl=t.gainLoss||0;
      return '<div style="display:flex;align-items:center;gap:.5rem;padding:.4rem .625rem;background:var(--surface2);border-radius:var(--r-xs);border:.5px solid var(--border);margin-bottom:4px">'+
        '<span style="font-size:11px;color:var(--faint);flex-shrink:0">'+fmtDate(t.date)+'</span>'+
        '<span style="flex:1;font-size:12px;font-weight:500">'+(t.stockName||t.stockId)+'</span>'+
        stockIdeaSelect(t.stockId)+
        '<span style="font-size:10.5px;color:var(--faint)">'+fmt2(t.shares||0)+' acc · venta '+fmt2(t.total||0)+'€ · coste '+fmt2(t.costBasis||0)+'€</span>'+
        '<span style="font-size:12px">P/L: <strong class="'+(gl>=0?'pos':'neg')+'">'+(gl>=0?'+':'')+fmt(gl)+'€</strong></span>'+
        '</div>';
    }).join('');
    return '<div style="margin-bottom:.5rem">'+
      '<div style="font-size:11px;font-weight:700;color:var(--amber);padding:.25rem 0">Año '+y+' · Resultado: <span class="'+(yPL>=0?'pos':'neg')+'">'+(yPL>=0?'+':'')+fmt(yPL)+'€</span></div>'+
      rows+'</div>';
  }).join('');
}

function populateSetupList(){
  const dl=document.getElementById('setup-list');
  if(!dl)return;
  const setups=[...new Set([
    ...cfg.stocks.map(s=>s.setup).filter(Boolean),
    ...transactions.map(t=>t.setup).filter(Boolean)
  ])].sort();
  dl.innerHTML=setups.map(s=>'<option value="'+s.replace(/"/g,'&quot;')+'">').join('');
}

function stockIdeaSelect(stockId){
  const s=cfg.stocks.find(x=>x.id===stockId)||{};
  const v=s.idea||'';
  const color=v==='value'?'var(--green)':v==='tecnico'?'var(--navy)':v==='otros'?'var(--gold)':'var(--faint)';
  const opts=[['','— idea —'],['value','Value'],['tecnico','Técnico'],['otros','Otros']];
  const setupVal=(s.setup||'').replace(/"/g,'&quot;');
  return '<select onchange="setStockIdea(&quot;'+stockId+'&quot;,this.value)" '+
    'style="font-size:11px;color:'+color+';font-weight:600;border:1px solid var(--border);border-radius:var(--r-xs);padding:2px 4px;flex-shrink:0">'+
    opts.map(o=>'<option value="'+o[0]+'"'+(v===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+
    '</select>'+
    '<input type="text" list="setup-list" value="'+setupVal+'" placeholder="setup…" '+
    'onchange="setStockSetup(&quot;'+stockId+'&quot;,this.value)" '+
    'style="font-size:11px;width:130px;border:1px solid var(--border);border-radius:var(--r-xs);padding:2px 4px;flex-shrink:0">';
}
function setStockIdea(stockId,idea){
  const s=cfg.stocks.find(x=>x.id===stockId);
  if(!s)return;
  s.idea=idea||undefined;
  if(idea!=='otros')s.ideaOtros=undefined;
  transactions.forEach(t=>{if(t.stockId===stockId&&t.type==='buy'){t.idea=idea||undefined;if(idea!=='otros')t.ideaOtros=undefined;}});
  save();renderStockTxList();
  toast('Idea actualizada: '+(idea?({value:'Value',tecnico:'Técnico',otros:'Otros'}[idea]):'sin idea'));
}
function setStockSetup(stockId,setup){
  const s=cfg.stocks.find(x=>x.id===stockId);
  if(!s)return;
  setup=(setup||'').trim();
  s.setup=setup||undefined;
  transactions.forEach(t=>{if(t.stockId===stockId&&t.type==='buy'){t.setup=setup||undefined;}});
  save();populateSetupList();renderStockTxList();
  toast('Setup actualizado'+(setup?': '+setup:''));
}

function renderStockPositions(){
  const el=document.getElementById('stock-positions');
  if(!el) return;
  const agg=getStockAggregates();
  const open=cfg.stocks.filter(s=>agg[s.id]&&agg[s.id].totalShares>1e-6&&!agg[s.id].isClosed);
  if(!open.length){
    el.innerHTML='<p style="font-size:11.5px;color:var(--faint);padding:.25rem 0">Sin posiciones abiertas. Registra una compra para empezar.</p>';
    return;
  }
  const today=new Date();
  const staleThreshold=isoLocal(new Date(today.getTime()-35*864e5));
  el.innerHTML=open.map(function(s){
    const a=agg[s.id];
    const sInfo=getStockInfo(s.id);
    const val=sInfo.amount||0;
    const invested=a.totalBoughtValue||0;
    const hasBuys=a.totalBoughtShares>0;
    // proportional cost basis for remaining shares
    const costBasis=hasBuys?invested*(a.totalShares/a.totalBoughtShares):invested;
    const pl=val>0?(val-costBasis):null;
    const plPct=costBasis>0&&pl!==null?Math.round(pl/costBasis*100):null;
    const dateStr=fmtDate(sInfo.date);
    const isStale=sInfo.source==='log'?(sInfo.date<staleThreshold):true;
    const dateColor=sInfo.source==='none'?'var(--red)':(isStale?'var(--amber)':'var(--teal)');
    const dateNote=sInfo.source==='none'?'sin valorar — pulsa + Valor':(dateStr+(isStale?' ⚠':''));
    const hist=(typeof balanceLog!=='undefined')?balanceLog.filter(x=>x.refType==='stock'&&x.refId===s.id)
      .sort((x,y)=>(y.date||'').localeCompare(x.date||'')):[];
    const lastCurEntry=hist.find(e=>e.currency&&e.currency!=='EUR');
    const defCur=lastCurEntry?lastCurEntry.currency:(s.currency||'EUR');
    const defRate=lastCurEntry?lastCurEntry.rate:'';
    const histHtml=hist.length?('<div style="font-size:10px;color:var(--muted);margin-top:3px">Valores: '+
      hist.slice(0,5).map(e=>'<span style="white-space:nowrap">'+fmtDate(e.date)+': <strong>'+fmt(e.amount)+'€</strong> '+
        '<a href="#" onclick="deleteBalance(event,&quot;'+e.id+'&quot;)" style="text-decoration:none">✕</a></span>').join(' · ')+
      (hist.length>5?' …':'')+'</div>'):'';
    return '<div style="background:var(--surface2);border:.5px solid var(--border);border-radius:var(--r-xs);padding:.5rem .625rem;margin-bottom:5px">'+
      '<div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">'+
        '<span style="flex:1;min-width:120px;font-size:12.5px;font-weight:600">'+s.name+'</span>'+
        stockIdeaSelect(s.id)+
        '<span style="font-size:11px;color:var(--faint)">Invertido: <strong style="color:var(--text)">'+fmt(invested)+'€</strong></span>'+
        '<span style="font-size:11px">Valor: <strong>'+(val>0?fmt(val)+'€':'—')+'</strong></span>'+
        (pl!==null?'<span style="font-size:11px">P/L: <strong class="'+(pl>=0?'pos':'neg')+'">'+(pl>=0?'+':'')+fmt(pl)+'€'+(plPct!==null?' ('+(plPct>=0?'+':'')+plPct+'%)':'')+'</strong></span>':'')+
        '<button type="button" class="btn-xs" style="color:var(--navy);border-color:var(--navy);flex-shrink:0" onclick="toggleBalPanel(&quot;stock&quot;,&quot;'+s.id+'&quot;)">+ Valor</button>'+
      '</div>'+
      '<div style="font-size:10px;color:'+dateColor+';margin-top:2px">Actualizado: '+dateNote+'</div>'+
      histHtml+
      '<div class="add-panel" id="bal-stock-'+s.id+'" style="background:#EBF0FA;border-color:#B8CAEE;margin-top:.4rem">'+
        '<div class="add-panel-title" style="color:var(--navy)">Registrar valor de mercado — '+s.name+'</div>'+
        '<div class="add-panel-row">'+
          '<div class="fld"><label>Fecha</label><input type="date" id="bal-stock-date-'+s.id+'" value="'+todayISO()+'"></div>'+
          '<div class="fld"><label>Moneda</label><select id="svcur-'+s.id+'" onchange="onStockCurChange(&quot;'+s.id+'&quot;)">'+
            ['EUR','USD','GBP','CHF','JPY','SEK','NOK','DKK','CAD'].map(c=>'<option value="'+c+'"'+(defCur===c?' selected':'')+'>'+c+'</option>').join('')+
          '</select></div>'+
        '</div>'+
        // EUR mode
        '<div class="add-panel-row" id="svcur-eurmode-'+s.id+'" style="'+(defCur==='EUR'?'':'display:none')+'">'+
          '<div class="fld"><label>Valor de mercado total (€)</label><input type="number" id="bal-stock-amt-'+s.id+'" placeholder="0" step="0.01" oninput="calcStockValueEUR(&quot;'+s.id+'&quot;)"></div>'+
        '</div>'+
        // Foreign mode
        '<div id="svcur-fxmode-'+s.id+'" style="'+(defCur==='EUR'?'display:none':'')+'">'+
          '<div class="add-panel-row">'+
            '<div class="fld"><label>Precio por acción (<span class="svcur-lbl-'+s.id+'">'+defCur+'</span>)</label><input type="number" id="svcur-price-'+s.id+'" placeholder="0" step="0.0001" oninput="calcStockValueEUR(&quot;'+s.id+'&quot;)"></div>'+
            '<div class="fld"><label>Nº acciones</label><input type="number" id="svcur-shares-'+s.id+'" value="'+(a.totalShares||0)+'" step="0.0001" oninput="calcStockValueEUR(&quot;'+s.id+'&quot;)"></div>'+
            '<div class="fld"><label>Cambio (1 € = <span class="svcur-lbl-'+s.id+'">'+defCur+'</span>)</label><input type="number" id="svcur-rate-'+s.id+'" value="'+(defRate||'')+'" placeholder="ej: 1,0876" step="0.000001" oninput="calcStockValueEUR(&quot;'+s.id+'&quot;)"></div>'+
          '</div>'+
          '<div style="font-size:11px;color:var(--navy);padding:0 0 .35rem" id="svcur-preview-'+s.id+'"></div>'+
        '</div>'+
        '<div class="add-panel-btns">'+
          '<button type="button" class="btn-xs" style="background:var(--navy);color:#fff;border-color:var(--navy)" onclick="addStockValue(&quot;'+s.id+'&quot;)">Guardar</button>'+
          '<button type="button" class="btn-xs" onclick="toggleBalPanel(&quot;stock&quot;,&quot;'+s.id+'&quot;)">Cerrar</button>'+
        '</div>'+
      '</div>'+
    '</div>';
  }).join('');
}

function renderStockTxList(){
  populateSetupList();
  renderStockPositions();
  renderStockOpenSummary();
  renderStockClosedSummary();
  renderStockClosedList();
  renderBrokerLiquiditySummary();
  renderBrokerLiquidityList();
  const el=document.getElementById('stock-tx-list');
  if(!el) return;
  // Populate the filter dropdown with stocks that have movements (preserve selection)
  const sel=document.getElementById('mov-filter');
  const movStockIds=[...new Set(transactions.filter(t=>t.type==='buy'||t.type==='sell').map(t=>t.stockId))];
  const movStocks=movStockIds.map(id=>({id,name:(cfg.stocks.find(s=>s.id===id)||{}).name||id}))
    .sort((a,b)=>a.name.localeCompare(b.name));
  const curFilter=sel?sel.value:'';
  if(sel){
    sel.innerHTML='<option value="">Todas las acciones</option>'+
      movStocks.map(s=>'<option value="'+s.id+'"'+(s.id===curFilter?' selected':'')+'>'+s.name+'</option>').join('');
  }
  let allTx=transactions.filter(t=>t.type==='buy'||t.type==='sell');
  if(curFilter)allTx=allTx.filter(t=>t.stockId===curFilter);
  allTx=allTx.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const cnt=document.getElementById('mov-count');
  if(cnt)cnt.textContent=allTx.length+' movimiento'+(allTx.length!==1?'s':'');
  if(!allTx.length){
    el.innerHTML='<p style="font-size:11.5px;color:var(--faint)">'+(curFilter?'Sin movimientos de esta acción.':'Sin operaciones registradas aún.')+'</p>';
    return;
  }
  el.innerHTML=allTx.map(function(t){
    const isBuy=t.type==='buy';
    const name=t.stockName||t.name||t.stockId||'?';
    const gl=isBuy?null:(t.gainLoss??null);
    const glHtml=gl!==null?(' · <span style="color:var(--faint)">coste FIFO '+fmt(t.costBasis||0)+'€</span> · P/L: <strong class="'+(gl>=0?'pos':'neg')+'">'+(gl>=0?'+':'')+fmt(gl)+'€</strong>'):'';
    const irpf=gl!==null&&gl>0?(' · IRPF est.: <span class="neg">'+fmt(calcIRPFGain(gl))+'€</span>'):'';
    return '<div style="display:flex;align-items:center;gap:.5rem;padding:.45rem .625rem;'+
      'background:var(--surface2);border-radius:var(--r-xs);border:.5px solid var(--border);margin-bottom:4px">'+
      '<span style="font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;flex-shrink:0;'+
        'background:'+(isBuy?'#D0F0E0':'#FEE0E0')+';color:'+(isBuy?'var(--teal)':'var(--red)')+'">'+
        (isBuy?'COMPRA':'VENTA')+'</span>'+
      '<span style="font-size:11px;color:var(--faint);flex-shrink:0">'+( t.date||'')+'</span>'+
      '<span style="flex:1;font-size:12.5px;font-weight:500">'+name+'</span>'+
      '<span style="font-size:11.5px">'+fmt(t.shares||0)+' acc × '+fmt(t.price||0)+'€'+
        (t.costs?' + '+fmt(t.costs)+'€ gas.':'')+'</span>'+
      glHtml+irpf+
      '<div style="display:flex;gap:3px;flex-shrink:0">'+
        '<button type="button" class="btn-xs" onclick="editStockTx(this.dataset.id)" data-id="'+t.id+'" title="Editar">✏️</button>'+
        '<button type="button" class="btn-xs danger" onclick="deleteStockTx(this.dataset.id)" data-id="'+t.id+'" title="Eliminar">✕</button>'+
      '</div>'+
    '</div>';
  }).join('');
}

function editStockTx(txId){
  const t=transactions.find(tx=>tx.id===txId);
  if(!t) return;
  if(t.type==='buy'){
    openStockOp('buy');
    setTimeout(function(){
      const g=function(id,v){const el=document.getElementById(id);if(el)el.value=v||'';};
      g('ns-name',t.stockName||t.name||'');
      g('ns-date',t.date||'');
      g('ns-shares',t.shares||'');
      g('ns-price',t.price||'');
      g('ns-costs',t.costs||'');
      g('ns-mktval',t.mktval||'');
      g('ns-idea',t.idea||'');
      g('ns-idea-otros',t.ideaOtros||'');
      g('ns-setup',t.setup||'');
      populateSetupList();
      onIdeaChange();
      g('ns-edit-id',t.id);
      calcBuyTotal();
    },50);
  } else {
    openStockOp('sell');
    setTimeout(function(){
      const g=function(id,v){const el=document.getElementById(id);if(el)el.value=v||'';};
      // Ensure the sold stock is present in the dropdown even if now fully closed
      const sel=document.getElementById('sv-stock');
      if(sel&&t.stockId){
        if(![...sel.options].some(o=>o.value===t.stockId)){
          const opt=document.createElement('option');
          opt.value=t.stockId;opt.textContent=(t.stockName||t.name||t.stockId);
          sel.appendChild(opt);
        }
        sel.value=t.stockId;
      }
      g('sv-date',t.date||'');
      g('sv-shares',t.shares||'');
      g('sv-price',t.price||'');
      g('sv-costs',t.costs||'');
      g('sv-exit',t.exitReason||'');
      g('sv-edit-id',t.id);
      calcSellOp();
    },50);
  }
}

function deleteStockTx(txId){
  if(!confirm('¿Eliminar esta operación?')) return;
  const t=transactions.find(tx=>tx.id===txId);
  transactions=transactions.filter(tx=>tx.id!==txId);
  // If it was a sell that marked stock as liquidated, reopen
  if(t&&t.type==='sell'&&t.fullyLiquidated) soldStocks.delete(t.stockId);
  recomputeAllStockGains();
  save();renderStockTxList();renderAll();
  toast('Operación eliminada');
}


// ─── SUBMIT ───────────────────────────────────────────────────────────


// ═══════════════════════════════════════════════════════════════════════
// HISTORICAL TABLE
// ═══════════════════════════════════════════════════════════════════════
function renderTable(){
  document.getElementById('hist-count').textContent=records.length+' meses registrados';
  const rows=[...records].reverse();
  document.getElementById('hist-tbody').innerHTML=rows.map((r,i)=>{
    const prev=rows[i+1];
    const delta=prev?r.pat-prev.pat:null;
    const dc=delta!==null?(delta>=0?'pos':'neg'):'';
    const ds=delta!==null?((delta>=0?'+':'')+fmt(delta)+'€'):'—';
    const _c=recCifras(r)||{ing:r.ing||0,gas:r.gas||0,aho:r.aho||0,difiere:false};
    // v129 · si el ahorro de ese mes lleva algo que no se repetirá, se marca
    const _ex=(function(){
      try{
        const ym=r.year+'-'+String(r.month).padStart(2,'0');
        const E=ahorroExtra(ym,ym);
        if(!E||!E.hay)return null;
        const d=[].concat(E.marcadosIng.map(x=>String(x.desc||'').slice(0,26)+' '+fmt2(x.imp)+'€'),
                          E.marcadosGas.map(x=>String(x.name||'').slice(0,26)+' −'+fmt2(x.imp)+'€'));
        return {n:(E.neto>0?'':'−')+fmt(Math.abs(Math.round(E.neto)))+'€ extraord.',
                t:'Ordinario: '+fmt2(E.ahoOrd)+'€. '+d.join(' · ')};
      }catch(e){return null;}
    })();
    return`<tr>
      <td>${r.label}${r.ap?`<span class="badge">+${fmt(r.aamt||0)}€</span>`:''}</td>
      <td><strong>${fmt(r.pat)}€</strong></td>
      <td class="${dc}">${ds}</td>
      <td class="pos">${fmt(_c.ing)}€${_c.difiere?`<span class="badge" style="background:#FFF6E0;color:var(--amber)" title="El registro guardado decía ${fmt2(_c.guardado.ing)}€">≠</span>`:''}</td>
      <td class="neg">${fmt(_c.gas)}€</td>
      <td>${fmt(_c.aho)}€${_ex?`<span style="font-size:9.5px;color:var(--amber);display:block" title="${_ex.t}">▲ ${_ex.n}</span>`:''}${_c.difiere?`<span style="font-size:9.5px;color:var(--faint);display:block">guardado: ${fmt2(_c.guardado.aho)}€</span>`:''}</td>
      <td>${fmt(getCash(r))}€</td>
      <td>${fmt(getFondos(r)+getAcc(r))}€</td>
      <td><button class="btn-sm" onclick="deleteRec('${r.id}')" style="color:var(--red)">✕</button></td>
    </tr>`;
  }).join('');
}

function deleteRec(id){
  if(records.length<=5){toast('Mínimo 5 registros');return;}
  if(!confirm('¿Borrar '+id+'?'))return;
  records=records.filter(r=>r.id!==id);save();renderAll();toast('Eliminado');
}

function exportCSV(){
  const cols=['label','year','month','pat','ing','gas','aho','cash','fondos','acc'];
  const blob=new Blob([[cols.join(','),...records.map(r=>cols.map(c=>r[c]??'').join(','))].join('\n')],
    {type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='patrimonio_'+todayISO()+'.csv';
  a.click();URL.revokeObjectURL(a.href);
}

function resetSeed(){
  if(!confirm('¿Vaciar y empezar de cero? Se borran TODOS tus registros.\n\nDesde la v96 el programa no lleva ningún histórico dentro, así que esto deja la aplicación en blanco: recupera después desde tu copia de seguridad.'))return;
  if(!guardedAction('restaurar datos de ejemplo'))return;
  records=SEED.map(parseSeed);cfg={accounts:[...DEF_ACCOUNTS],funds:[...DEF_FUNDS],stocks:[...DEF_STOCKS],debts:[],brokers:[],gastos_fijos:[...DEF_GASTOS_FIJOS]};brokerFlows=[];
  transactions=[];soldStocks=new Set();balanceLog=[];save();renderAll();toast("Datos restaurados");
}

// ═══════════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════════
// ═══ AHORRO — tasa de ahorro puro + proyección ═══════════════════════
let _ahBars=null,_ahCum=null,_ahProjChart=null;
function ahResetZoom(which){
  const ch=which==='bars'?_ahBars:which==='cum'?_ahCum:_ahProjChart;
  if(ch&&typeof ch.resetZoom==='function')ch.resetZoom();
}
let _ahPeriod='12m', _ahCatPeriod='12m';
let _ahFrom='', _ahTo='';
// v110 · El rango por defecto acababa HOY, así que metía el mes en curso —
// medio mes de gastos contra medio mes de ingresos — dentro de una media de 12
// meses. El dashboard ya usaba solo meses CERRADOS (ahorroReal12); aquí no, y
// por eso las dos pantallas daban cifras distintas de lo mismo.
function ultimoDiaMesAnterior(){
  const t=new Date();
  const d=new Date(t.getFullYear(),t.getMonth(),0); // día 0 del mes actual = último día del anterior
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function primerDiaHaceNMeses(n){
  const t=new Date();
  const f=new Date(t.getFullYear(),t.getMonth()-n,1);
  return f.getFullYear()+'-'+String(f.getMonth()+1).padStart(2,'0')+'-01';
}
function ahEnsureRange(){
  if(_ahFrom&&_ahTo)return;
  _ahFrom=primerDiaHaceNMeses(12);
  _ahTo=ultimoDiaMesAnterior();
}
function ahSyncInputs(){
  const a=document.getElementById('ah-from'),b=document.getElementById('ah-to');
  if(a)a.value=_ahFrom; if(b)b.value=_ahTo;
}
function ahSetRange(){
  const a=document.getElementById('ah-from'),b=document.getElementById('ah-to');
  if(a&&a.value)_ahFrom=a.value; if(b&&b.value)_ahTo=b.value;
  renderAhorro();
}
function ahQuickRange(which){
  const t=new Date();const y=t.getFullYear();
  let from,to;
  if(which==='12m'){from=primerDiaHaceNMeses(12);to=ultimoDiaMesAnterior();} // v110 · 12 meses CERRADOS
  else if(which==='anio'){from=y+'-01-01';to=y+'-12-31';}
  else if(which==='anterior'){from=(y-1)+'-01-01';to=(y-1)+'-12-31';}
  else {const M=ahorroMonthly();from=(M.length?M[0].month:'2015-01')+'-01';to=isoLocal(t);}
  _ahFrom=from;_ahTo=to;ahSyncInputs();renderAhorro();
}
let _ahCatFrom='', _ahCatTo='';
function ahCatEnsureRange(){
  if(_ahCatFrom&&_ahCatTo)return;
  const t=new Date();
  _ahCatFrom=isoLocal(new Date(t.getFullYear(),t.getMonth()-11,1));
  _ahCatTo=isoLocal(t);
}
function ahCatSyncInputs(){
  const a=document.getElementById('ah-cat-from'),b=document.getElementById('ah-cat-to');
  if(a)a.value=_ahCatFrom; if(b)b.value=_ahCatTo;
}
function ahCatSetRange(){
  const a=document.getElementById('ah-cat-from'),b=document.getElementById('ah-cat-to');
  if(a&&a.value)_ahCatFrom=a.value; if(b&&b.value)_ahCatTo=b.value;
  renderAhorroCats();
}
function ahCatQuickRange(which){
  const t=new Date();const y=t.getFullYear();
  let from,to;
  if(which==='12m'){from=isoLocal(new Date(y,t.getMonth()-11,1));to=isoLocal(t);}
  else if(which==='anio'){from=y+'-01-01';to=y+'-12-31';}
  else if(which==='anterior'){from=(y-1)+'-01-01';to=(y-1)+'-12-31';}
  else {const firstExp=expenseLog.map(x=>x.date).filter(Boolean).sort()[0];from=(firstExp||'2015-01-01').slice(0,10);to=isoLocal(t);}
  _ahCatFrom=from;_ahCatTo=to;ahCatSyncInputs();renderAhorroCats();
}
function compIncomeIds(){const s=new Set();reembolsos.forEach(r=>{if(r.incomeId)s.add(r.incomeId);(r.incomeIds||[]).forEach(i=>s.add(i));});return s;}  // v163 · una compensación puede llevar varios ingresos
function compExpenseIds(){const s=new Set();reembolsos.forEach(r=>{(r.expenseIds||[]).forEach(e=>s.add(e));});return s;}

// ════════════════════════════════════════════════════════════════════
// v126 · UN SOLO SITIO DONDE SE CALCULA EL MES
// ════════════════════════════════════════════════════════════════════
// Mismo problema que con los saldos, pero con el dinero que entra y sale.
// Había CUATRO cálculos distintos del ahorro de un mes:
//
//   · ahorroMonthly()      quitaba intereses y dividendos, restaba lo que te
//                          deben (pendDev)  → X € en junio de 2026
//   · buildLiveRecord()    sumaba intereses, NO restaba lo que te deben
//                          → X € el mismo mes
//   · runConsulta()        sumaba intereses, NO restaba lo que te deben
//   · el registro guardado números redondos escritos a mano hace meses
//                          → Y € en julio de 2025 cuando fueron X
//
// Cuatro pantallas, cuatro respuestas a "¿cuánto ahorré?". La de junio de
// 2026 se diferenciaba en Y €, que son los X € de la renta que
// pagaste a mano y que Hacienda te va a devolver.
//
// A partir de aquí, todo pasa por mesCifras(). Los criterios, explícitos:
//
//   INGRESOS  · todo lo cobrado, incluidos intereses y dividendos: son dinero
//               que entró en tu cuenta y se quedó. Se contabilizan además
//               por separado (ingInv) porque en la cascada patrimonial no
//               cuentan como ahorro sino como rentabilidad, y contarlos
//               dos veces sería mentir.
//             · fuera lo que ya está compensado con un reembolso.
//   GASTOS    · todo lo pagado, MENOS lo que te tienen que devolver. Un pago
//               duplicado que has reclamado no es tu gasto.
//             · fuera lo compensado.
//   AHORRO    · ingresos − gastos. Sin más.
// Apuntes que la propia app se inventó al dar de alta el histórico antiguo:
// un ingreso y un gasto por mes, deducidos del registro. No son movimientos
// reales, así que un mes que solo tenga esto sigue mandando por su registro.
function _esSintetico(x){
  const id=String((x&&x.id)||'');
  return id.startsWith('histexp_')||id.startsWith('histinc_');
}
function mesCifras(ym){
  ym=String(ym||'').slice(0,7);
  const _ci=(typeof compIncomeIds==='function')?compIncomeIds():new Set();
  const _ce=(typeof compExpenseIds==='function')?compExpenseIds():new Set();
  let ing=0, ingInv=0, gas=0, gasBruto=0, devuelto=0, nApuntes=0;
  (typeof incomeLog!=='undefined'?incomeLog:[]).forEach(x=>{
    if(String(x.date||'').slice(0,7)!==ym)return;
    if(_ci.has(x.id))return;
    const v=Number(x.amt)||0;
    ing+=v;
    // los apuntes sintéticos del histórico no cuentan como "tener datos":
    // se generaron a partir del propio registro y no son movimientos reales
    if(!_esSintetico(x))nApuntes++;
    if(x.cat==='rend'||x.cat==='dividendo')ingInv+=v;
  });
  (typeof expenseLog!=='undefined'?expenseLog:[]).forEach(x=>{
    if(String(x.date||'').slice(0,7)!==ym)return;
    if(_ce.has(x.id))return;
    const v=Number(x.amt)||0;
    const dev=(typeof pendDev==='function')?(Number(pendDev(x))||0):0;
    gasBruto+=v; devuelto+=Math.min(dev,v);
    gas+=Math.max(0,v-dev);
    if(!_esSintetico(x))nApuntes++;
  });
  const r2=v=>Math.round(v*100)/100;
  return {ym, ing:r2(ing), ingInv:r2(ingInv), gas:r2(gas), gasBruto:r2(gasBruto),
    devuelto:r2(devuelto), aho:r2(ing-gas),
    // ahorro "puro": sin la rentabilidad de las inversiones. Es el que usa la
    // cascada patrimonial, donde intereses y dividendos ya entran por su lado.
    ahoPuro:r2(ing-ingInv-gas), nApuntes};
}
// Todos los meses que tienen algún apunte, ya calculados.
function mesesConDatos(){
  const S=new Set();
  (typeof incomeLog!=='undefined'?incomeLog:[]).forEach(x=>{const m=String(x.date||'').slice(0,7);if(m)S.add(m);});
  (typeof expenseLog!=='undefined'?expenseLog:[]).forEach(x=>{const m=String(x.date||'').slice(0,7);if(m)S.add(m);});
  return [...S].sort();
}
// Un registro guardado puede llevar cifras escritas a mano de antes de
// importar el banco. Si ese mes tiene apuntes, mandan los apuntes.
function recCifras(r){
  if(!r)return null;
  const ym=r.year+'-'+String(r.month).padStart(2,'0');
  const C=mesCifras(ym);
  if(C.nApuntes>0){
    const guardado={ing:Number(r.ing)||0,gas:Number(r.gas)||0,aho:Number(r.aho)||0};
    const difiere=Math.abs(guardado.aho-C.aho)>0.011||Math.abs(guardado.ing-C.ing)>0.011;
    return {...C, fuente:'apuntes', guardado, difiere};
  }
  return {ym, ing:Number(r.ing)||0, gas:Number(r.gas)||0, aho:Number(r.aho)||0,
    ingInv:0, ahoPuro:Number(r.aho)||0, nApuntes:0, fuente:'guardado', difiere:false};
}
// Reescribe en los registros las cifras deducidas de los apuntes, para que
// las copias y la sincronización lleven los números buenos.
function recPonerAlDia(){
  const desfasados=records.map(r=>({r,c:recCifras(r)})).filter(x=>x.c&&x.c.difiere);
  if(!desfasados.length){toast('Todos los meses guardados ya coinciden con tus apuntes');return;}
  const lista=desfasados.slice(0,12).map(x=>'  · '+x.r.label+':  ahorro '+fmt2(x.c.guardado.aho)+'€ → '+fmt2(x.c.aho)+'€').join('\n');
  if(!confirm('Hay '+desfasados.length+' mes(es) cuyo registro guardado no coincide con los apuntes '+
    'de ingresos y gastos:\n\n'+lista+(desfasados.length>12?'\n  · …':'')+
    '\n\nSon cifras que escribiste a mano antes de importar el banco. Se sustituyen por las '+
    'calculadas a partir de tus apuntes, que es lo que la app ya te enseña en Ahorro.\n\n¿Ponerlos al día?'))return;
  if(!guardedAction('poner al día '+desfasados.length+' meses guardados'))return;
  desfasados.forEach(({r,c})=>{ r.ing=c.ing; r.gas=c.gas; r.aho=c.aho; });
  save(); renderAll();
  toast('✅ '+desfasados.length+' mes(es) puestos al día');
}
function recDesfasadosHTML(){
  let D=[];
  try{ D=records.map(r=>({r,c:recCifras(r)})).filter(x=>x.c&&x.c.difiere); }catch(e){ return ''; }
  if(!D.length)return '';
  return D.slice(0,6).map(x=>escapeHtml(x.r.label)+': guardado '+fmt2(x.c.guardado.aho)+'€ · real '+
      fmt2(x.c.aho)+'€').join('<br>')+(D.length>6?'<br>y '+(D.length-6)+' más…':'');
}

function ahorroMonthly(){
  // v126 · un solo cálculo. savings incluye intereses y dividendos porque son
  // dinero que entró y se quedó; savingsPuro los deja fuera, para la cascada
  // patrimonial, donde ya entran contados como rentabilidad.
  return mesesConDatos().map(m=>{
    const c=mesCifras(m);
    return {month:m,income:c.ing,expense:c.gas,savings:c.aho,
      savingsPuro:c.ahoPuro,incomeInv:c.ingInv};
  });
}
// ── Recibos no mensuales (agua, IBI, seguros, Hacienda) ──────────────
// Cada patrón: [regex, tipoPorDefecto si sólo hay 1 cargo]
const RECEIPT_KW=[
  [/hidraqua|\baguas\b|aig[uü]es|emuasa|aquona|hidrogea|\bfacsa\b|canal isabel/i,'Trimestral'],
  [/seguro|\bprima\b|allianz|mapfre|l[ií]nea directa|zurich|\baxa\b|generali|mutua|reaseguro|pelayo|\bverti\b|catalana occidente|\bcaser\b|\breale\b|fiatc|balumba/i,'Anual'],
  [/\bibi\b|tributaria|hacienda|\baeat\b|suma gesti|\btributo\b|impuesto|catastro|\bitv\b|\btasa\b|basura|vado|diputaci/i,'Anual'],
];
function receiptType(name){for(const [re,def] of RECEIPT_KW) if(re.test(name||'')) return def; return null;}
function normReceiptKey(name){
  let s=cleanDesc(name||'').toLowerCase();
  s=s.replace(/[0-9]+/g,' ').replace(/[*\/.,#·:]/g,' ').replace(/\s+/g,' ').trim();
  return s.split(' ').filter(w=>w.length>1).slice(0,3).join(' ');
}
function detectReceipts(){
  const groups={};
  const _ceR=compExpenseIds();
  expenseLog.forEach(x=>{if(x.kind==='fijo')return;if(_ceR.has(x.id))return;if(!receiptType(x.name))return;const k=normReceiptKey(x.name);if(!k)return;(groups[k]=groups[k]||[]).push(x);});
  const out=[];
  Object.values(groups).forEach(arr=>{
    arr.sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    const last=arr[arr.length-1];
    const avgAmt=arr.reduce((s,x)=>s+(x.amt||0),0)/arr.length;
    const def=receiptType(last.name);
    let avgGap=null;
    if(arr.length>=2){let g=[];for(let i=1;i<arr.length;i++)g.push((new Date(arr[i].date)-new Date(arr[i-1].date))/864e5);avgGap=g.reduce((s,x)=>s+x,0)/g.length;}
    let periodDays, label;
    if(avgGap!=null && avgGap>=25 && avgGap<=430){periodDays=avgGap;label=avgGap<115?'Trimestral':avgGap<250?'Semestral':'Anual';}
    else {label=def; periodDays=def==='Trimestral'?91:def==='Semestral'?182:365;}
    const next=new Date(new Date(last.date).getTime()+periodDays*864e5).toISOString().slice(0,10);
    out.push({name:last.name,cat:last.cat,count:arr.length,lastDate:last.date,lastAmt:last.amt,avgAmt,label,next});
  });
  out.sort((a,b)=>a.next.localeCompare(b.next));
  return out;
}
function renderRecibos(){
  const box=document.getElementById('ah-recibos');if(!box)return;
  const R=detectReceipts();
  if(!R.length){box.innerHTML='<p style="font-size:12px;color:var(--muted)">Aún no detecto recibos no mensuales. Importa varios meses de banco para que aparezcan (agua, IBI, seguros, Hacienda…).</p>';return;}
  const badge=l=>{const c=l==='Anual'?'#5A2A8A':l==='Semestral'?'#0A5A7A':'#2A6A18';return '<span style="font-size:10px;background:'+c+'22;color:'+c+';padding:1px 7px;border-radius:8px">'+l+'</span>';};
  const anualTot=R.filter(r=>r.label==='Anual').reduce((s,r)=>s+r.avgAmt,0);
  box.innerHTML='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;min-width:520px;background:transparent">'+
    '<tr style="color:var(--muted);font-size:10.5px;text-align:left"><td style="padding:.3rem .4rem">Concepto</td><td>Periodicidad</td><td style="text-align:right">Último cargo</td><td style="text-align:right">Importe</td><td style="text-align:right">Próximo aprox.</td></tr>'+
    R.map(r=>{
      const soon=r.next<=isoLocal(new Date(Date.now()+60*864e5));
      return '<tr style="border-top:1px solid var(--border)">'+
        '<td style="padding:.35rem .4rem"><span class="gasto-item-cat '+(CAT_CSS[r.cat]||'cat-otro')+'" style="margin-right:5px">'+(CAT_LABELS[r.cat]||r.cat)+'</span>'+r.name.slice(0,28)+(r.count>1?' <small style="color:var(--faint)">×'+r.count+'</small>':'')+'</td>'+
        '<td>'+badge(r.label)+'</td>'+
        '<td style="text-align:right">'+fmtDate(r.lastDate)+'</td>'+
        '<td style="text-align:right"><strong>'+fmt2(r.lastAmt)+'€</strong></td>'+
        '<td style="text-align:right'+(soon?';color:var(--red);font-weight:600':'')+'">'+fmtDate(r.next)+(soon?' ⚠':'')+'</td>'+
      '</tr>';
    }).join('')+'</table></div>'+
    '<div style="font-size:10.5px;color:var(--muted);margin-top:.5rem">Detectados por concepto (agua, seguros, impuestos). El próximo cargo es una estimación por la separación de los anteriores; los ⚠ vencen en menos de 60 días. Los anuales suman ≈ '+fmt(anualTot)+'€/año.</div>';
}
// ═══ COMPENSACIONES / REEMBOLSOS (Bizum) ════════════════════════════
let _reembForm=null;
let _reembListOpen=false; try{_reembListOpen=ALM.getItem('dlv_reemblistopen')==='1';}catch(e){fallo('_reembListOpen',e)}
function toggleReembList(){ _reembListOpen=!_reembListOpen; try{ALM.setItem('dlv_reemblistopen',_reembListOpen?'1':'0');}catch(e){fallo('ALM.setItem',e)} applyReembListVis(); }
function applyReembListVis(){
  const div=document.getElementById('reemb-list');
  const btn=document.getElementById('toggle-reemb-btn');
  const n=reembolsos.length;
  if(div)div.style.display=_reembListOpen?'block':'none';
  if(btn)btn.textContent=(_reembListOpen?'▾ Ocultar compensaciones':'▸ Ver compensaciones')+(n?' ('+n+')':'');
}
function reembNew(){ _reembForm={incomeId:null,sel:{},notes:{},incFilter:'bizum',ftxt:'',ffrom:'',fto:''}; renderReembForm(); document.getElementById('reemb-form').scrollIntoView({behavior:'smooth',block:'nearest'}); }
function reembCancel(){ _reembForm=null; renderReembForm(); }
function _incLabel(x){ return fmtDate(x.date)+' · '+(x.desc||'(sin concepto)').slice(0,40)+' · '+fmt2(x.amt||0)+'€'; }
function reembIncFilter(v){ _reembForm.incFilter=v; reembFillIncSel(); }
function reembFillIncSel(){
  const sel=document.getElementById('reemb-incsel'); if(!sel)return;
  const used=compIncomeIds();
  const f=(_reembForm.incFilter||'').toLowerCase();
  let list=incomeLog.filter(x=>!used.has(x.id));
  if(f) list=list.filter(x=>((x.desc||'')+' '+(x.cat||'')).toLowerCase().includes(f));
  list.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  list=list.slice(0,300);
  sel.innerHTML='<option value="">— elige un ingreso —</option>'+list.map(x=>'<option value="'+x.id+'"'+(x.id===_reembForm.incomeId?' selected':'')+'>'+_incLabel(x).replace(/"/g,'&quot;')+'</option>').join('');
}
function reembPickIncome(id){
  _reembForm.incomeId=id||null;
  const inc=incomeLog.find(x=>x.id===id);
  if(inc&&inc.date){ // ventana por defecto alrededor de la fecha del ingreso
    const d=new Date(inc.date+'T00:00:00');
    const from=new Date(d); from.setDate(from.getDate()-75);
    const to=new Date(d); to.setDate(to.getDate()+20);
    _reembForm.ffrom=isoLocal(from);
    _reembForm.fto=isoLocal(to);
  }
  renderReembForm();
}
function reembFilter(){
  _reembForm.ftxt=document.getElementById('reemb-expfilter')?.value||'';
  _reembForm.ffrom=document.getElementById('reemb-from')?.value||'';
  _reembForm.fto=document.getElementById('reemb-to')?.value||'';
  reembFillExpList();
}
function reembToggleExp(eid,checked){
  if(checked)_reembForm.sel[eid]=true; else delete _reembForm.sel[eid];
  reembTotals();
}
function reembSetNote(eid,val){ _reembForm.notes[eid]=val; }
function reembFillExpList(){
  const box=document.getElementById('reemb-explist'); if(!box)return;
  const used=compExpenseIds();
  const ft=(_reembForm.ftxt||'').toLowerCase(), ff=_reembForm.ffrom||'', fto=_reembForm.fto||'';
  let list=expenseLog.filter(x=>!used.has(x.id)||_reembForm.sel[x.id]);
  if(ft) list=list.filter(x=>(x.name||'').toLowerCase().includes(ft));
  if(ff) list=list.filter(x=>(x.date||'')>=ff);
  if(fto) list=list.filter(x=>(x.date||'')<=fto);
  list.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const total=list.length; const shown=list.slice(0,120);
  if(!total){ box.innerHTML='<p style="font-size:12px;color:var(--muted);padding:.4rem 0">No hay gastos sin compensar en ese filtro. Amplía el rango de fechas o borra el texto.</p>'; return; }
  box.innerHTML='<div style="max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:8px">'+
    '<table style="width:100%;font-size:12px;background:transparent"><tbody>'+
    shown.map(x=>{
      const on=!!_reembForm.sel[x.id];
      const note=_reembForm.notes[x.id]!=null?_reembForm.notes[x.id]:'';
      return '<tr style="border-bottom:1px solid var(--line)">'+
        '<td style="padding:.3rem .4rem;width:26px;text-align:center"><input type="checkbox" '+(on?'checked':'')+' onchange="reembToggleExp(\''+x.id+'\',this.checked)"></td>'+
        '<td style="padding:.3rem .4rem;white-space:nowrap;color:var(--muted)">'+fmtDate(x.date)+'</td>'+
        '<td style="padding:.3rem .4rem">'+(x.name||'').slice(0,32)+' <span class="gasto-item-cat '+(CAT_CSS[x.cat]||'cat-otro')+'">'+(CAT_LABELS[x.cat]||x.cat||'otro')+'</span></td>'+
        '<td style="padding:.3rem .4rem;text-align:right;white-space:nowrap"><strong>'+fmt2(x.amt||0)+'€</strong></td>'+
        '<td style="padding:.3rem .4rem"><input type="text" placeholder="nota (p.ej. secador)" value="'+String(note).replace(/"/g,'&quot;')+'" oninput="reembSetNote(\''+x.id+'\',this.value)" style="width:120px;font-size:11px;padding:2px 5px;border:1px solid var(--line);border-radius:5px"></td>'+
      '</tr>';
    }).join('')+'</tbody></table></div>'+
    (total>shown.length?'<div style="font-size:10.5px;color:var(--muted);margin-top:.3rem">Mostrando '+shown.length+' de '+total+'. Afina el filtro para ver el resto.</div>':'');
  reembTotals();
}
function reembTotals(){
  const box=document.getElementById('reemb-totals'); if(!box)return;
  const inc=incomeLog.find(x=>x.id===_reembForm.incomeId);
  const incAmt=inc?(inc.amt||0):0;
  let sum=0,n=0; Object.keys(_reembForm.sel).forEach(eid=>{const e=expenseLog.find(x=>x.id===eid);if(e){sum+=(e.amt||0);n++;}});
  const diff=incAmt-sum;
  box.innerHTML='<div style="display:flex;gap:1.2rem;flex-wrap:wrap;font-size:12.5px;padding:.5rem .2rem">'+
    '<span>Ingreso: <strong>'+fmt2(incAmt)+'€</strong></span>'+
    '<span>Gastos seleccionados ('+n+'): <strong>'+fmt2(sum)+'€</strong></span>'+
    '<span>Diferencia: <strong class="'+(Math.abs(diff)<0.005?'':(diff>0?'pos':'neg'))+'">'+(diff>0?'+':'')+fmt2(diff)+'€</strong></span>'+
    '</div>'+(Math.abs(diff)>0.005?'<div style="font-size:10.5px;color:var(--muted);padding:0 .2rem">La diferencia no importa: las cantidades no tienen por qué cuadrar al céntimo. Al compensar, cada apunte deja de contar por su importe real.</div>':'');
}
function reembSave(){
  if(!_reembForm.incomeId){toast('Elige primero el ingreso.');return;}
  const eids=Object.keys(_reembForm.sel).filter(e=>_reembForm.sel[e]);
  if(!eids.length){toast('Selecciona al menos un gasto.');return;}
  const notes={}; eids.forEach(e=>{const n=(_reembForm.notes[e]||'').trim();if(n)notes[e]=n;});
  reembolsos.push({id:'rb_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),incomeId:_reembForm.incomeId,expenseIds:eids,notes,created:new Date().toISOString()});
  _reembForm=null; _reembListOpen=true; try{ALM.setItem('dlv_reemblistopen','1');}catch(e){fallo('ALM.setItem',e)} save();
  renderReembolsos(); loadMonthEntries(); renderTxIngList(); renderGastosList(); renderAll();
  toast('✅ Compensación guardada: '+eids.length+' gasto(s) fuera de los totales');
}
function reembUndo(id){
  const rb=reembolsos.find(r=>r.id===id); if(!rb)return;
  if(!confirm('Deshacer esta compensación. El ingreso y sus gastos volverán a contar en ingresos, gastos y ahorro. ¿Continuar?'))return;
  reembolsos=reembolsos.filter(r=>r.id!==id);
  // v163 · si al compensar quedó una diferencia apuntada aparte, se va con ella
  if(rb.resto&&rb.resto.id){ expenseLog=expenseLog.filter(x=>x.id!==rb.resto.id); incomeLog=incomeLog.filter(x=>x.id!==rb.resto.id); }
  save();
  renderReembolsos(); loadMonthEntries(); renderTxIngList(); renderGastosList(); renderAll();
  toast('Compensación deshecha');
}
function renderReembForm(){
  const box=document.getElementById('reemb-form'); if(!box)return;
  if(!_reembForm){ box.innerHTML=''; return; }
  let html='<div style="border:1px solid var(--navy);border-radius:10px;padding:.7rem .8rem;margin-bottom:.7rem;background:var(--surface)">'+
    '<div style="font-weight:600;margin-bottom:.4rem">Nueva compensación</div>'+
    '<div style="margin-bottom:.5rem"><label style="font-size:12px;color:var(--muted)">1 · Ingreso a compensar</label><br>'+
      '<input type="text" id="reemb-incfilter" placeholder="filtrar (p.ej. bizum, antonio)" value="'+String(_reembForm.incFilter||'').replace(/"/g,'&quot;')+'" oninput="reembIncFilter(this.value)" style="font-size:12px;padding:3px 7px;border:1px solid var(--line);border-radius:6px;margin:.2rem 0;width:220px"><br>'+
      '<select id="reemb-incsel" onchange="reembPickIncome(this.value)" style="font-size:12px;padding:4px 7px;border:1px solid var(--line);border-radius:6px;max-width:100%;min-width:280px"></select></div>';
  if(_reembForm.incomeId){
    html+='<div style="margin-bottom:.4rem"><label style="font-size:12px;color:var(--muted)">2 · Gastos que reembolsa (marca uno o varios; añade una nota a cada uno)</label></div>'+
      '<div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.4rem;align-items:center">'+
        '<input type="text" id="reemb-expfilter" placeholder="texto (p.ej. amazon)" value="'+String(_reembForm.ftxt||'').replace(/"/g,'&quot;')+'" oninput="reembFilter()" style="font-size:12px;padding:3px 7px;border:1px solid var(--line);border-radius:6px;width:150px">'+
        '<span style="font-size:11px;color:var(--muted)">desde</span><input type="date" id="reemb-from" value="'+(_reembForm.ffrom||'')+'" onchange="reembFilter()" style="font-size:12px;padding:2px 5px;border:1px solid var(--line);border-radius:6px">'+
        '<span style="font-size:11px;color:var(--muted)">hasta</span><input type="date" id="reemb-to" value="'+(_reembForm.fto||'')+'" onchange="reembFilter()" style="font-size:12px;padding:2px 5px;border:1px solid var(--line);border-radius:6px">'+
      '</div>'+
      '<div id="reemb-explist"></div>'+
      '<div id="reemb-totals"></div>'+
      '<div style="margin-top:.5rem;display:flex;gap:.5rem"><button type="button" class="btn-sm" style="background:var(--navy);color:#fff;border-color:var(--navy)" onclick="reembSave()">Guardar compensación</button>'+
      '<button type="button" class="btn-sm" onclick="reembCancel()">Cancelar</button></div>';
  } else {
    html+='<div style="margin-top:.3rem"><button type="button" class="btn-sm" onclick="reembCancel()">Cancelar</button></div>';
  }
  html+='</div>';
  box.innerHTML=html;
  reembFillIncSel();
  if(_reembForm.incomeId) reembFillExpList();
}
function renderReembList(){
  const box=document.getElementById('reemb-list'); if(!box)return;
  if(!reembolsos.length){ box.innerHTML='<p style="font-size:12px;color:var(--muted)">Aún no has creado compensaciones. Úsalas para que los Bizum de reembolso y los gastos que pagas por otra persona no distorsionen tu ahorro.</p>'; return; }
  const rows=reembolsos.slice().sort((a,b)=>{
    const ia=incomeLog.find(x=>x.id===a.incomeId), ib=incomeLog.find(x=>x.id===b.incomeId);
    return ((ib?ib.date:'')||'').localeCompare((ia?ia.date:'')||'');
  });
  let totInc=0,totExp=0;
  const html=rows.map(rb=>{
    // v163 · puede haber varios ingresos (cada uno te paga su parte de una comida)
    const incs=((rb.incomeIds&&rb.incomeIds.length)?rb.incomeIds:[rb.incomeId]).map(i=>incomeLog.find(x=>x.id===i)).filter(Boolean);
    const inc=incs.length===1?incs[0]:(incs.length?{date:incs[0].date,desc:incs.length+' ingresos: '+incs.map(x=>x.desc||'').join(', '),amt:incs.reduce((s,x)=>s+(x.amt||0),0)}:null);
    const incAmt=inc?(inc.amt||0):0; totInc+=incAmt;
    const exps=(rb.expenseIds||[]).map(eid=>expenseLog.find(x=>x.id===eid)).filter(Boolean);
    const sum=exps.reduce((s,e)=>s+(e.amt||0),0); totExp+=sum;
    const diff=incAmt-sum;
    const incTxt=inc?(fmtDate(inc.date)+' · '+escapeHtml(inc.desc||'(sin concepto)')+' · '+fmt2(incAmt)+'€'):'(ingreso no encontrado)';
    const expList=exps.map(e=>{
      const note=rb.notes&&rb.notes[e.id]?' — <em>'+rb.notes[e.id]+'</em>':'';
      return '<li style="margin:.1rem 0">'+fmtDate(e.date)+' · '+escapeHtml(e.name||'')+' · '+fmt2(e.amt||0)+'€'+note+'</li>';
    }).join('')+(rb.expenseIds.length>exps.length?'<li style="color:var(--faint)">(algún gasto ya no existe)</li>':'');
    return '<div style="border:1px solid var(--line);border-radius:9px;padding:.55rem .7rem;margin-bottom:.5rem">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">'+
        '<div style="font-size:12.5px"><span style="color:var(--green);font-weight:600">↧ Ingreso</span> '+incTxt+'</div>'+
        '<button type="button" class="btn-sm" style="font-size:10.5px;padding:2px 8px" onclick="reembUndo(\''+rb.id+'\')">Deshacer</button>'+
      '</div>'+
      '<ul style="font-size:12px;margin:.35rem 0 .2rem 1.1rem;padding:0;color:var(--text)">'+expList+'</ul>'+
      '<div style="font-size:11px;color:var(--muted)">'+exps.length+' gasto(s) · '+fmt2(sum)+'€ compensados · diferencia '+(diff>0?'+':'')+fmt2(diff)+'€</div>'+
    '</div>';
  }).join('');
  box.innerHTML=html+'<div style="font-size:11px;color:var(--muted);margin-top:.3rem;padding-top:.4rem;border-top:1px solid var(--line)">'+reembolsos.length+' compensaciones · '+fmt2(totInc)+'€ de ingresos y '+fmt2(totExp)+'€ de gastos excluidos del ahorro.</div>';
}
function renderReembolsos(){ renderReembForm(); renderReembList(); applyReembListVis(); }
function renderAhorro(){


  const box=document.getElementById('ah-kpi');if(!box)return;
  const note=document.getElementById('ah-note');
  const M=ahorroMonthly();
  if(M.length<1){box.innerHTML='';if(note)note.innerHTML='<p style="font-size:12px;color:var(--muted)">Importa movimientos del banco (Datos entrada) para calcular tu tasa de ahorro. Se usan ingresos de sueldo, IPT y extras (no las rentas de inversión) menos tus gastos.</p>';return;}
  const sum=a=>a.reduce((s,x)=>s+x,0);
  ahEnsureRange(); ahSyncInputs();
  const fromM=_ahFrom.slice(0,7), toM=_ahTo.slice(0,7);
  const sel=M.filter(x=>x.month>=fromM && x.month<=toM);
  const perLbl=fromM+' → '+toM;
  const incP=sum(sel.map(x=>x.income)),expP=sum(sel.map(x=>x.expense)),savP=incP-expP;
  const rateP=incP>0?savP/incP:0;
  const nMonths=sel.length||1;
  const avgSavP=savP/nMonths, avgIncP=incP/nMonths, avgExpP=expP/nMonths;
  // v146 · El mes en curso está a medias: si la nómina entra el día 25 y hoy es
  // día 10, ese mes son todo gastos y ningún ingreso. Metido en la media
  // histórica hundía la tasa y encima no cuadraba con el KPI de al lado, que sí
  // termina en el último mes cerrado. Fuera hasta que el mes acabe.
  const _mesActual=new Date().getFullYear()+'-'+String(new Date().getMonth()+1).padStart(2,'0');
  const MH=M.filter(x=>x.month<_mesActual);
  const _baseH=MH.length?MH:M;
  const incAll=sum(_baseH.map(x=>x.income)),expAll=sum(_baseH.map(x=>x.expense)),savAll=incAll-expAll;
  const rateAll=incAll>0?savAll/incAll:0;
  // v147 · el mes en curso está a medias y rebajaba la aportación proyectada
  const _m12=_baseH.slice(-12);
  const avgSav12=(_m12.reduce((s,x)=>s+x.savings,0))/(_m12.length||1);
  const kc=(t,v,s,c)=>'<div class="kpi"><div class="kpi-lbl">'+t+'</div><div class="kpi-val '+(c||'')+'" style="font-size:16px">'+v+'</div>'+(s?'<div style="font-size:10.5px;color:var(--muted)">'+s+'</div>':'')+'</div>';
  // v110 · La cifra grande es SIN extraordinarios: es la que se repetirá el mes
  // que viene y la única sobre la que puedes hacer planes. Debajo, en gris, la
  // misma cifra contándolo todo, para que la diferencia esté siempre a la vista.
  const R=ahorroRango(fromM,toM);
  const nR=Math.max(1,sel.length||R.n);
  const sub=(txt)=>'<span style="color:var(--faint)">'+txt+'</span>';
  const conExtra=R.hayExtra;
  const avgSavOrd=R.ahoOrd/nR, avgIncOrd=R.ingOrd/nR, avgExpOrd=R.gasOrd/nR;
  box.innerHTML=
    kc('Tasa de ahorro',Math.round(R.tasaOrd*100)+'%',
       (conExtra?'sin extraordinarios · '+perLbl+'<br>'+sub('con extraordinarios: '+Math.round(R.tasa*100)+'%')
                :perLbl+' · de cada 100€'),
       R.tasaOrd>=0?'pos':'neg')+
    kc('Tasa de ahorro (histórico)',Math.round(rateAll*100)+'%','sobre '+_baseH.length+' meses cerrados',rateAll>=0?'pos':'neg')+
    kc('Ahorro medio mensual',(avgSavOrd>=0?'+':'')+fmt(avgSavOrd)+'€',
       (conExtra?'sin extraordinarios · '+perLbl+'<br>'+sub('con extraordinarios: '+(avgSavP>=0?'+':'')+fmt(avgSavP)+'€')
                :perLbl),
       avgSavOrd>=0?'pos':'neg')+
    kc('Ingreso medio mensual',fmt(avgIncOrd)+'€',
       (conExtra?'sin extraordinarios · sueldo + IPT + extras<br>'+sub('con extraordinarios: '+fmt(avgIncP)+'€')
                :'sueldo + IPT + extras'),'')+
    kc('Gasto medio mensual',fmt(avgExpOrd)+'€',
       (R.gasNoRec>0.005?'sin gastos extraordinarios<br>'+sub('con extraordinarios: '+fmt(avgExpP)+'€')
                :'todos los gastos'),'')+
    kc('Ahorrado ('+perLbl+')',(R.ahoOrd>=0?'+':'')+fmt(R.ahoOrd)+'€',
       'ingresos '+fmt(R.ingOrd)+'€ − gastos '+fmt(R.gasOrd)+'€'+
       (conExtra?'<br>'+sub('con extraordinarios: '+(savP>=0?'+':'')+fmt(savP)+'€'):''),
       R.ahoOrd>=0?'pos':'neg');
  let notaExtra='';
  if(conExtra){
    const li=[];
    if(R.ingNoRec>0.005) li.push('<li><strong>'+fmt2(R.ingNoRec)+'€</strong> de ingresos que no se repetirán: '+
      R.marcadosIng.slice(0,4).map(x=>escapeHtml(String(x.desc).slice(0,28))+' ('+fmtDate(x.date)+', '+fmt2(x.imp)+'€'+(x.auto?', detectado del desglose':'')+')').join('; ')+
      (R.marcadosIng.length>4?' y '+(R.marcadosIng.length-4)+' más':'')+'</li>');
    if(R.gasNoRec>0.005) li.push('<li><strong>'+fmt2(R.gasNoRec)+'€</strong> de gastos extraordinarios: '+
      R.marcadosGas.slice(0,4).map(x=>escapeHtml(String(x.name).slice(0,28))+' ('+fmtDate(x.date)+', '+fmt2(x.imp)+'€)').join('; ')+
      (R.marcadosGas.length>4?' y '+(R.marcadosGas.length-4)+' más':'')+'</li>');
    notaExtra='<div style="background:var(--surface2);border-radius:6px;padding:.5rem .6rem;margin-top:.5rem;font-size:11px;color:var(--muted)">'+
      'Fuera del cálculo principal:<ul style="margin:.3rem 0 0 1rem;padding:0">'+li.join('')+'</ul>'+
      '<div style="margin-top:.35rem">Las <strong>pagas extra y la productividad siguen contando como ordinarias</strong>: son tu sueldo, repartido de forma desigual.</div></div>';
  } else {
    notaExtra='<div style="font-size:11px;color:var(--faint);margin-top:.4rem">No hay nada marcado como extraordinario en este periodo, así que las dos cifras coinciden. '+
      'Las pagas extra y la productividad cuentan como ordinarias a propósito: son tu sueldo, repartido de forma desigual.</div>';
  }
  const mesActual=todayISO().slice(0,7);
  const avisoParcial=(toM>=mesActual)
    ? '<div style="background:#FFF6E0;border:1px solid #E8C97A;border-radius:6px;padding:.45rem .6rem;margin-top:.45rem;font-size:11px;color:var(--amber)">'+
      '⚠ El periodo llega hasta <strong>'+fmtMonth(mesActual)+'</strong>, que todavía no ha terminado. Ese mes entra a medias '+
      'en la media mensual y la tira hacia abajo. Para comparar de verdad, termina el rango en el mes anterior.</div>'
    : '';
  if(note)note.innerHTML=avisoParcial+'<div style="font-size:11.5px;color:var(--muted);margin-top:.4rem">La cifra grande va <strong>sin extraordinarios</strong>: es la que se va a repetir el mes que viene. En gris, debajo, la misma cifra contándolo todo. El <strong>ahorro puro</strong> es lo que no te gastas de tus ingresos por sueldo, IPT y extras; no incluye las rentas de tus inversiones (intereses, dividendos): esas son el fruto de lo ya ahorrado, y su rentabilidad la ves en Análisis.</div>'+notaExtra;
  // Bars: income vs expense per month
  const dark=document.body.classList.contains('dark');
  const labels=M.map(x=>fmtMonth(x.month));
  if(_ahBars)_ahBars.destroy();
  _ahBars=new Chart(document.getElementById('ah-bars'),{type:'bar',
    data:{labels,datasets:[
      {label:'Ingresos',data:M.map(x=>x.income),backgroundColor:'#1A7A3A'},
      {label:'Gastos',data:M.map(x=>x.expense),backgroundColor:'#B03020'}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:11},color:dark?'#A0AEC0':'#5A6A80'}},zoom:{zoom:{wheel:{enabled:true},pinch:{enabled:true},drag:{enabled:false},mode:'x'},pan:{enabled:true,mode:'x',modifierKey:null},limits:{x:{minRange:3}}},tooltip:{callbacks:{label:c=>c.dataset.label+': '+fmt(c.raw)+'€'}}},
      scales:{x:{grid:{display:false},ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:9},maxTicksLimit:12}},y:{grid:{color:dark?'rgba(255,255,255,.08)':'rgba(0,0,0,.05)'},ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:10},callback:v=>fmt(v)+'€'}}}}});
  // Cumulative savings
  let acc=0;const cum=M.map(x=>{acc+=x.savings;return Math.round(acc*100)/100;});
  if(_ahCum)_ahCum.destroy();
  _ahCum=new Chart(document.getElementById('ah-cum'),{type:'line',
    data:{labels,datasets:[{data:cum,borderColor:'#0B3D91',backgroundColor:'rgba(11,61,145,.08)',borderWidth:2,fill:true,tension:.2,pointRadius:M.length>24?0:2}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},zoom:{zoom:{wheel:{enabled:true},pinch:{enabled:true},drag:{enabled:false},mode:'x'},pan:{enabled:true,mode:'x',modifierKey:null},limits:{x:{minRange:3}}},tooltip:{callbacks:{label:c=>fmt(c.raw)+'€ acumulado'}}},
      scales:{x:{grid:{display:false},ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:9},maxTicksLimit:10}},y:{grid:{color:dark?'rgba(255,255,255,.08)':'rgba(0,0,0,.05)'},ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:10},callback:v=>fmt(v)+'€'}}}}});
  // Projection
  renderAhorroProjection(avgSav12);
  renderAhorroCats();
  renderRecibos();
  try{renderSalud();}catch(e){console.warn('salud',e);}
  try{renderPercepcion();}catch(e){console.warn('percepcion',e);}
  try{renderPendDev();}catch(e){console.warn('penddev',e);}
  try{renderFiscal();}catch(e){console.warn('fiscal',e);}
}
function renderAhorroCats(){
  const box=document.getElementById('ah-cats');if(!box)return;
  ahCatEnsureRange(); ahCatSyncInputs();
  const fromS=_ahCatFrom, toS=_ahCatTo;
  const cur={},prev={};
  const dayMs=86400000;
  const fromD=new Date(fromS+'T00:00:00'), toD=new Date(toS+'T00:00:00');
  const durMs=Math.max(0,toD-fromD);
  // v169 · el periodo anterior, contado en días y no en horas (sin UTC ni horario de verano)
  const prevToS=isoMasDias(fromS,-1), prevFromS=isoMasDias(prevToS,-isoDias(fromS,toS));
  const _ceC=compExpenseIds();
  expenseLog.forEach(x=>{if(_ceC.has(x.id))return;const d=x.date||'';if(!d)return;const c=x.cat||'otro';
    if(d>=fromS&&d<=toS){cur[c]=(cur[c]||0)+(x.amt||0);}
    else if(d>=prevFromS&&d<=prevToS){prev[c]=(prev[c]||0)+(x.amt||0);}});
  const perTxt=fromS.slice(0,7)+' → '+toS.slice(0,7);
  const cats=Object.keys(cur).sort((a,b)=>cur[b]-cur[a]);
  if(!cats.length){box.innerHTML='<p style="font-size:12px;color:var(--muted)">Sin gastos en el periodo ('+perTxt+').</p>';return;}
  const total=cats.reduce((s,c)=>s+cur[c],0);
  const palette={hogar:'#1A4A9A',alimentacion:'#2A6A18',luz:'#8A6A08',agua:'#0A6A9A',suministros:'#0A5A7A',suscripciones:'#5A2A8A',estanco:'#7A4A10',vehiculo:'#7A4A08',salud:'#1A6A3A',restaurante:'#8A6808',ropa:'#8A4A1A',viaje:'#0A5A9A',ocio:'#6A1A8A',otro:'#5A5A5A'};
  box.innerHTML=cats.map(c=>{
    const v=cur[c],p=prev[c]||0,pctTotal=Math.round(v/total*100);
    const trend=p>0?((v-p)/p):null;
    const trendTxt=trend==null?'<span style="color:var(--faint)">—</span>':
      (trend>0.03?'<span class="neg">▲ '+Math.round(trend*100)+'%</span>':trend<-0.03?'<span class="pos">▼ '+Math.round(Math.abs(trend)*100)+'%</span>':'<span style="color:var(--muted)">≈</span>');
    return '<div style="margin-bottom:.55rem">'+
      '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px">'+
        '<span><strong>'+(CAT_LABELS[c]||c)+'</strong> <span style="color:var(--muted)">'+pctTotal+'%</span></span>'+
        '<span><strong>'+fmt(v)+'€</strong> · '+trendTxt+'</span></div>'+
      '<div style="height:8px;background:#EEE;border-radius:4px;overflow:hidden"><div style="height:100%;width:'+pctTotal+'%;background:'+(palette[c]||'#888')+'"></div></div>'+
    '</div>';
  }).join('')+
  '<div style="font-size:10.5px;color:var(--muted);margin-top:.4rem">Total gastado ('+perTxt+'): '+fmt(total)+'€. La tendencia (▲/▼) compara con el periodo anterior equivalente; si no hay histórico previo, sale "—".</div>';
}
// v147 · Dos arreglos aquí. Uno: arrancaba del último CIERRE guardado, que
// puede ser de hace semanas, mientras el panel arranca del patrimonio de hoy —
// dos proyecciones de la misma app partiendo de sitios distintos. Dos: sumaba
// tu ahorro mensual durante los 40 años del gráfico, jubilado incluido. Las
// aportaciones paran cuando dejas de cobrar una nómina.
// v159 · ya no es un número fijo: sale del escenario de jubilación elegido
function renderAhorroProjection(avgSav){
  const proj=document.getElementById('ah-proj');if(!proj)return;
  const years=Math.max(1,Math.min(40,parseInt(document.getElementById('ah-years')?.value)||10));
  const rAnnual=Math.max(0,(parseFloat(document.getElementById('ah-return')?.value)||0)/100);
  const rm=Math.pow(1+rAnnual,1/12)-1, n=years*12;   // v147 · equivalente mensual real
  let start=0;
  try{
    const nd=new Date(), lv=buildLiveRecord(nd.getFullYear(),nd.getMonth()+1);
    const lr=(lv&&lv.hasData)?lv:last();
    start=patOf(lr);
  }catch(e){ try{const lr=last();start=patOf(lr);}catch(_){fallo('lr',_)} }
  // meses que te quedan aportando, desde hoy hasta el mes en que te jubilas
  const hoyD=new Date(), JP=jubPlan(), JUB_FIN_ANIO=JP.anio;
  const mesesAportando=Math.max(0,(JP.anio-hoyD.getFullYear())*12+(JP.mes-(hoyD.getMonth()+1)));
  const labels=[],data=[],aportData=[];
  let bal=start, aportAcc=start;
  for(let mo=0;mo<=n;mo++){
    if(mo>0){
      const ap=(mo<=mesesAportando)?avgSav:0;
      bal=bal*(1+rm)+ap; aportAcc+=ap;
    }
    if(mo%12===0){labels.push('Año '+(mo/12));data.push(Math.round(bal));aportData.push(Math.round(aportAcc));}
  }
  const finalV=data[data.length-1], aportadoTotal=aportAcc, interes=finalV-aportadoTotal;
  const cortaAportes=(n>mesesAportando);
  const kc=(t,v,s,c)=>'<div class="kpi"><div class="kpi-lbl">'+t+'</div><div class="kpi-val '+(c||'')+'" style="font-size:16px">'+v+'</div>'+(s?'<div style="font-size:10.5px;color:var(--muted)">'+s+'</div>':'')+'</div>';
  proj.innerHTML=
    kc('Patrimonio en '+years+' años',fmt(finalV)+'€','partiendo de '+fmt(start)+'€','pos')+
    kc('Total aportado',fmt(aportadoTotal)+'€','ahorro medio '+fmt(avgSav)+'€/mes'+
       (cortaAportes?'<br><span style="color:var(--faint)">aportas '+Math.round(mesesAportando/12)+' años más, hasta tu jubilación '+JP.nombre+' ('+fmtDate(JP.fecha)+')</span>':''),'')+
    kc('Generado por rentabilidad',(interes>=0?'+':'')+fmt(interes)+'€','al '+(rAnnual*100).toFixed(1)+'% anual',interes>=0?'pos':'neg');
  const dark=document.body.classList.contains('dark');
  if(_ahProjChart)_ahProjChart.destroy();
  _ahProjChart=new Chart(document.getElementById('ah-proj-chart'),{type:'line',
    data:{labels,datasets:[
      {label:'Con rentabilidad',data,borderColor:'#0B3D91',backgroundColor:'rgba(11,61,145,.08)',borderWidth:2,fill:true,tension:.2,pointRadius:0},
      {label:'Solo aportado',data:aportData,borderColor:'#8A97AB',borderWidth:1.5,borderDash:[5,4],fill:false,tension:.2,pointRadius:0}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{font:{size:11},color:dark?'#A0AEC0':'#5A6A80'}},zoom:{zoom:{wheel:{enabled:true},pinch:{enabled:true},drag:{enabled:false},mode:'x'},pan:{enabled:true,mode:'x',modifierKey:null},limits:{x:{minRange:3}}},tooltip:{callbacks:{label:c=>c.dataset.label+': '+fmt(c.raw)+'€'}}},
      scales:{x:{grid:{display:false},ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:10}}},y:{grid:{color:dark?'rgba(255,255,255,.08)':'rgba(0,0,0,.05)'},ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:10},callback:v=>fmt(v)+'€'}}}}});
}

// ═══════════════════════════════════════════════════════════════════════
// ANÁLISIS (Expectativa integrada) — lee directamente de los datos
// ═══════════════════════════════════════════════════════════════════════
const AN_IDEA_LABELS={value:'Value',tecnico:'Técnico',otros:'Otros','':'Sin idea'};
const AN_EXIT_LABELS={objetivo:'Objetivo alcanzado',stop:'Stop / pérdida',tesis:'Cambió la tesis',rotacion:'Rotación',panico:'Pánico / emocional',otro:'Otro','':'Sin especificar'};
const _cls=v=>v>=0?'pos':'neg';
const _eurS=v=>(v==null||isNaN(v))?'—':(v>=0?'+':'')+fmt(v)+'€';
const _pctS=v=>(v==null||isNaN(v))?'—':(v>=0?'+':'')+Math.round(v*100)+'%';

function buildTradeOps(){
  const tx=transactions.filter(t=>t.type==='buy'||t.type==='sell');
  const byStock={}; tx.forEach(t=>{(byStock[t.stockId]=byStock[t.stockId]||[]).push(t);});
  const nameOf=id=>(cfg.stocks.find(s=>s.id===id)||{}).name||id;
  const ideaOf=id=>{const s=cfg.stocks.find(x=>x.id===id);return s&&s.idea?s.idea:'';};
  const setupOf=id=>{const s=cfg.stocks.find(x=>x.id===id);return s&&s.setup?s.setup:'';};
  const exitOf=id=>{const sells=tx.filter(t=>t.stockId===id&&t.type==='sell'&&t.date).sort((a,b)=>(b.date||'').localeCompare(a.date||''));return sells.length?(sells[0].exitReason||''):'';};
  const closed=[],open=[];
  Object.keys(byStock).forEach(id=>{
    const ops=byStock[id].slice().sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    const buys=ops.filter(o=>o.type==='buy'),sells=ops.filter(o=>o.type==='sell');
    const rem=buys.reduce((s,o)=>s+(o.shares||0),0)-sells.reduce((s,o)=>s+(o.shares||0),0);
    const boughtCost=buys.reduce((s,o)=>s+((o.total||0)+(o.costs||0)),0);
    const soldCB=sells.reduce((s,o)=>s+(o.costBasis||0),0);
    const rz=sells.reduce((s,o)=>s+(o.gainLoss||0),0);
    const entry=buys.length?buys[0].date:(ops[0]&&ops[0].date)||null;
    const exit=sells.length?sells[sells.length-1].date:null;
    const isClosed=soldStocks.has(id)||rem<1e-6;
    if(isClosed) closed.push({id,name:nameOf(id),entry,exit,invested:soldCB>0?soldCB:boughtCost,pnl:rz,idea:ideaOf(id),setup:setupOf(id),exitReason:exitOf(id)});
    else{ const val=getStockInfo(id).amount||0; const inv=boughtCost-soldCB;
      // v119 · para poder cuadrar contra DEGIRO hace falta saber de dónde sale
      // cada número: títulos, cada compra y la fecha y el origen de la valoración
      const vb=balUltimo('stock',id);
      const pp=stockPartes(id);
      open.push({id,name:nameOf(id),entry,invested:inv,value:val,pnl:val-inv,
        idea:ideaOf(id),setup:setupOf(id),
        shares:rem,buys,sells,partes:pp.partes,
        valDate:pp.date||(vb?vb.date:null), valSrc:vb?(vb.src||'a mano'):'—'}); }
  });
  const flows=[];
  tx.forEach(t=>{if(!t.date)return;const idea=ideaOf(t.stockId);
    if(t.type==='buy'){const out=(t.total||0)+(t.costs||0);flows.push({date:t.date,cf:-out,cost:out,idea});}
    else{const inn=(t.total||0)-(t.costs||0);flows.push({date:t.date,cf:inn,cost:-(t.costBasis||0),idea});}});
  flows.sort((a,b)=>a.date.localeCompare(b.date));
  return {closed,open,flows,brokerCash:getBrokerLiquidityNow()};
}

// v169 · El valor final de la TIR se fecha el día de la última valoración, no
// hoy. Si la última valoración es de hace seis semanas, contarla como de hoy
// estira el plazo y la rentabilidad sale más baja de lo que es (con los datos
// del 29/9 vistos el 10/11: 7,3 % en vez de 8,2 % en acciones). Si después de
// la valoración hay una aportación, el final no se adelanta a ella.
function fechaFinTIR(flows,refType,fecha){
  const hoy=todayISO();
  let f=fecha||null;
  if(!f&&typeof balanceLog!=='undefined')balanceLog.forEach(b=>{ if(b.refType===refType&&b.date&&(!f||b.date>f))f=b.date; });
  if(!f)f=hoy;
  const ult=(flows&&flows.length)?flows[flows.length-1].date:null;
  if(ult&&ult>f)f=ult;
  return f>hoy?hoy:f;
}
function _metricsFor(flows,holdings,realized,unreal){
  flows=(flows||[]).filter(f=>f.date).slice().sort((a,b)=>a.date.localeCompare(b.date));
  if(!flows.length)return null;
  const today=fechaFinTIR(flows,'stock');
  const cf=flows.map(f=>({date:f.date,amount:f.cf})); cf.push({date:today,amount:holdings});
  const rate=xirr(cf);
  let dep=0,area=0,prev=flows[0].date,peak=0;
  flows.forEach(f=>{const dd=(new Date(f.date)-new Date(prev))/864e5;area+=dep*dd;prev=f.date;dep+=f.cost;if(dep>peak)peak=dep;});
  area+=dep*((new Date(today)-new Date(prev))/864e5);
  const td=(new Date(today)-new Date(flows[0].date))/864e5;
  const avg=td>0?area/td:dep; const tp=(realized||0)+(unreal||0);
  return {rate,avgCapital:avg,peak,totalProfit:tp,realized:realized||0,unreal:unreal||0,retOnAvg:avg>0?tp/avg:null,firstDate:flows[0].date,totalDays:td};
}

// ── Fondos: aportaciones (fund_aport) + valor liquidativo actual ──
function buildFundOps(){
  const funds=(cfg.funds||[]).map(f=>{
    const aports=transactions.filter(t=>t.type==='fund_aport'&&t.fundId===f.id&&t.date)
      .sort((a,b)=>(a.date||'').localeCompare(b.date||''));
    const invested=aports.reduce((s,t)=>s+(t.amount||0),0);
    const VI=getFundVLInfo(f.id), value=VI.amount||0;
    const pnl=value-invested;
    const simple=invested>0?pnl/invested:null;
    const flows=aports.map(t=>({date:t.date,cf:-(t.amount||0),cost:(t.amount||0)}));
    return {id:f.id,name:f.name,invested,value,pnl,simple,flows,firstDate:aports.length?aports[0].date:null,nAport:aports.length,
      valDate:/^\d{4}-\d{2}-\d{2}$/.test(String(VI.date||''))?VI.date:null};
  }).filter(f=>f.invested>0||f.value>0);
  const allFlows=[]; funds.forEach(f=>allFlows.push(...f.flows));
  allFlows.sort((a,b)=>a.date.localeCompare(b.date));
  const totalInvested=funds.reduce((s,f)=>s+f.invested,0);
  const totalValue=funds.reduce((s,f)=>s+f.value,0);
  return {funds,allFlows,totalInvested,totalValue,totalPnl:totalValue-totalInvested};
}
function fundMetrics(fund){
  if(!fund.flows.length)return null;
  const today=fechaFinTIR(fund.flows.slice().sort((a,b)=>a.date.localeCompare(b.date)),'fund',fund.valDate);
  const cf=fund.flows.map(f=>({date:f.date,amount:f.cf})); cf.push({date:today,amount:fund.value});
  const rate=xirr(cf);
  let dep=0,area=0,prev=fund.flows[0].date,peak=0;
  fund.flows.forEach(f=>{const dd=(new Date(f.date)-new Date(prev))/864e5;area+=dep*dd;prev=f.date;dep+=f.cost;if(dep>peak)peak=dep;});
  area+=dep*((new Date(today)-new Date(prev))/864e5);
  const td=(new Date(today)-new Date(fund.flows[0].date))/864e5;
  const avg=td>0?area/td:dep;
  return {rate,avgCapital:avg,peak,totalProfit:fund.pnl,retOnAvg:avg>0?fund.pnl/avg:null,simple:fund.simple,firstDate:fund.flows[0].date,totalDays:td};
}

let _anScope='acciones';
function setAnScope(s){
  _anScope=s;
  document.querySelectorAll('.an-scope').forEach(b=>b.classList.toggle('active',b.dataset.scope===s));
  // toggle stock-only cards when viewing fondos
  // v135 · an-cuadrepos faltaba: la ficha seguía a la vista en la pantalla de
  // fondos, enseñando acciones, y ahí no se refresca nunca.
  const stockOnly=['an-disposition','an-evol-chart','an-chart','an-rec-chart','an-compras','an-closed','an-open','an-cuadrepos'];
  document.querySelectorAll('#panel-analisis .card').forEach(c=>{
    const isStockCard=c.querySelector('#an-disposition,#an-evol-chart,#an-chart,#an-rec-chart,#an-compras,#an-closed,#an-open,#an-cuadrepos');
    if(isStockCard) c.style.display=(s==='fondos')?'none':'';
  });
  renderAnalisis();
}


// ════════════════════════════════════════════════════════════════════
// v126 · RENTABILIDAD POR BLOQUE, CON PERIODO
// ════════════════════════════════════════════════════════════════════
// Hasta ahora esta tabla solo sabía decir "desde el principio". Está bien
// para saber cómo va la cosa en total, pero no responde a "¿qué tal ha ido
// este año?". Con periodo, cada bloque se mide entre dos fechas:
//
//   beneficio del periodo = (valor al final − valor al principio) − lo que
//                           metiste o sacaste por el medio
//   rentabilidad          = TWR encadenada, que neutraliza el momento de las
//                           aportaciones: es la del ACTIVO, no la tuya
//
// En "todo" se mantiene el cálculo de siempre, con su TIR anualizada, porque
// ahí sí tiene sentido: hay años de historia detrás.
let _anBloquePer='todo';
function setAnBloquePer(p){
  _anBloquePer=p;
  document.querySelectorAll('.an-bl-per').forEach(b=>b.classList.toggle('active',b.dataset.per===p));
  renderAnalisisBlocks();
}
function anBloqueRango(){
  const hoy=todayISO();
  if(_anBloquePer==='todo')return {desde:null,hasta:hoy,label:'desde el principio',todo:true};
  if(_anBloquePer==='ytd')return {desde:hoy.slice(0,4)+'-01-01',hasta:hoy,label:'en lo que va de '+hoy.slice(0,4)};
  const d=new Date(hoy+'T00:00:00');
  if(_anBloquePer==='1m')return {desde:isoMasMeses(hoy,-1),hasta:hoy,label:'en el último mes'};
  return {desde:isoMasAnios(hoy,-1),hasta:hoy,label:'en el último año'};
}
// TWR sobre una serie de valores con sus entradas de dinero.
// La rentabilidad encadenada exige que TODAS las valoraciones vengan del mismo
// sitio. Mezclarlas mide diferencias de método, no de mercado, y sale
// cualquier cosa: con las fuentes mezcladas los fondos daban -56 % teniendo
// +X € de beneficio, porque los totales mensuales del histórico saltan
// entre X € y Y € de un mes a otro. Es el mismo sesgo que ya costó
// una versión entera con la cartera de acciones.
//
// Así que se encadena sobre UNA fuente —la que más valoraciones aporte dentro
// del periodo— y se devuelve qué trozo del periodo cubre de verdad, para que
// la pantalla pueda decirlo en vez de dar un número que no es lo que dice.
function twrSerie(puntos,flujos,desde,hasta){
  const porSrc={};
  (puntos||[]).forEach(p=>{const k=p.src||'unico';(porSrc[k]=porSrc[k]||[]).push(p);});
  // No todas las fuentes valen lo mismo. La reconstrucción diaria y tus saldos
  // con fecha son mediciones; el total mensual del histórico es un apunte a
  // mano que en tu caso salta entre X € y Y € de un mes para otro.
  // Se prefiere la fiable aunque tenga menos puntos.
  const RANGO={recon:3,saldo:3,unico:2,registro:1};
  let mejor=null;
  Object.entries(porSrc).forEach(([k,arr])=>{
    const cand={k,arr,tier:RANGO[k]||1};
    if(!mejor||cand.tier>mejor.tier||(cand.tier===mejor.tier&&arr.length>mejor.arr.length))mejor=cand;
  });
  if(!mejor||mejor.arr.length<2)return {rent:null,src:null,cobertura:0};
  const A=mejor.arr;
  let f=1,ok=false,raros=0;
  for(let i=1;i<A.length;i++){
    const ap=(flujos||[]).filter(c=>c.date>A[i-1].date&&c.date<=A[i].date)
      .reduce((s,c)=>s+(c.amount||0),0);
    const base=(A[i-1].val||0)+ap;
    if(base>0){
      const r=(A[i].val||0)/base;
      // un salto de más de la mitad en un tramo sin flujo que lo explique no
      // es mercado: es un dato mal metido
      if(Math.abs(r-1)>0.5)raros++;
      f*=r;ok=true;
    }
  }
  const d0=A[0].date, d1=A[A.length-1].date;
  const pedido=(desde&&hasta)?Math.max(1,(Date.parse(hasta)-Date.parse(desde))/864e5):null;
  const medido=Math.max(0,(Date.parse(d1)-Date.parse(d0))/864e5);
  return {rent:ok?f-1:null, src:mejor.k, desde:d0, hasta:d1, n:A.length,
    raros, incoherente:raros>Math.max(1,A.length*0.03),
    cobertura:pedido?Math.min(1,medido/pedido):1};
}
// Corta una serie por el periodo, arrastrando el último valor anterior como
// punto de partida: sin él, el primer día del periodo saldría como si
// hubieses empezado de cero.
function _corta(S,desde,hasta,campo){
  const v=p=>({date:p.date,val:Number(p[campo])||0,src:p.src||null});
  const antes=desde?S.filter(p=>p.date<desde):[];
  const dentro=S.filter(p=>(!desde||p.date>=desde)&&(!hasta||p.date<=hasta));
  if(!dentro.length)return null;
  const partida=(desde&&antes.length)?v(antes[antes.length-1]):null;
  // v126 · si no hay valoración ANTES del periodo, poner cero de partida
  // convertiría toda la cartera en "beneficio". Se arranca en la primera
  // valoración que sí existe y se dice desde cuándo se está midiendo.
  const arranque=partida||v(dentro[0]);
  const puntos=partida?[partida].concat(dentro.map(v)):dentro.map(v);
  // Si la valoración de partida es MUY anterior al periodo pedido, la cifra
  // abarca más tiempo del que dice. Pasa cuando llevas meses sin apuntar el
  // valor de un fondo: el "último año" acaba midiendo diecisiete meses.
  const dias=(desde&&partida)?Math.round((Date.parse(desde)-Date.parse(partida.date))/864e5):0;
  return {partida,arranque,puntos,recortado:!partida&&!!desde,
    desfase:dias>40?dias:0,
    desdeReal:arranque.date, valIni:arranque.val, valFin:v(dentro[dentro.length-1]).val};
}
function stkBloquePeriodo(desde,hasta){
  let S=[];
  try{ S=stockPortfolioSeries(); }catch(e){ return null; }
  const c=_corta(S,desde,hasta,'value');
  if(!c)return null;
  const F=(typeof stkFlujoDia==='function')?stkFlujoDia():{};
  const d0=c.desdeReal;
  let flujo=0;
  Object.keys(F).forEach(d=>{ if(d>d0&&(!hasta||d<=hasta))flujo+=F[d]; });
  const flujos=Object.keys(F).map(d=>({date:d,amount:F[d]}));
  return {valIni:c.valIni,valFin:c.valFin,flujo,recortado:c.recortado,desdeReal:d0,desfase:c.desfase,
    ben:(c.valFin-c.valIni)-flujo, twr:twrSerie(c.puntos,flujos,desde||c.desdeReal,hasta)};
}

// v128 · La serie agregada de fondos, en un solo sitio.
// Tenías el valor de tus fondos en DOS lugares: los saldos con fecha
// (balanceLog + la serie heredada) y el total mensual que guarda cada
// registro del histórico. La tabla de bloques solo miraba los primeros y la
// cascada patrimonial solo los segundos, así que para "este año" una decía
// X € de revalorización y la otra Y €. La diferencia entera era el
// punto de partida: X € (marzo de 2025, el último saldo con fecha) frente
// a X € (diciembre de 2025, el total del registro).
// Manda el saldo con fecha cuando existe; el registro rellena los meses que no.
function fondosSerieAgregada(){
  const m=new Map();
  (typeof records!=='undefined'?records:[]).forEach(r=>{
    const v=Number(r.fondos)||0;
    if(v>0&&r.year&&r.month){
      const fin=new Date(r.year,r.month,0);
      m.set(fin.getFullYear()+'-'+String(fin.getMonth()+1).padStart(2,'0')+'-'+String(fin.getDate()).padStart(2,'0'),
        {v:Math.round(v*100)/100,src:'registro'});
    }
  });
  const fechas=new Set(), series={};
  (cfg.funds||[]).forEach(f=>{
    const S=(typeof fundValueSeries==='function')?fundValueSeries(f.id):[];
    if(S.length){series[f.id]=S;S.forEach(x=>fechas.add(x.date));}
  });
  [...fechas].sort().forEach(d=>{
    let t=0,hay=false;
    Object.values(series).forEach(S=>{
      let v=null; for(const q of S){ if(q.date<=d)v=q.val; else break; }
      if(v!=null){t+=v;hay=true;}
    });
    if(hay)m.set(d,{v:Math.round(t*100)/100,src:'saldo'});
  });
  return [...m.entries()].map(([date,o])=>({date,val:o.v,src:o.src})).sort((a,b)=>a.date.localeCompare(b.date));
}

function fondosBloquePeriodo(desde,hasta){
  const agg=fondosSerieAgregada();
  if(!agg.length)return null;
  const c=_corta(agg,desde,hasta,'val');
  if(!c)return null;
  const flujos=[];
  (cfg.funds||[]).forEach(f=>{
    ((typeof fundContribs==='function')?fundContribs(f.id):[]).forEach(x=>flujos.push(x));
  });
  const d0=c.desdeReal;
  const flujo=flujos.filter(x=>x.date>d0&&(!hasta||x.date<=hasta))
    .reduce((s,x)=>s+(x.amount||0),0);
  return {valIni:c.valIni,valFin:c.valFin,flujo,recortado:c.recortado,desdeReal:d0,desfase:c.desfase,
    ben:(c.valFin-c.valIni)-flujo, twr:twrSerie(c.puntos,flujos,desde||c.desdeReal,hasta)};
}


// Un porcentaje de rentabilidad con el signo contrario al beneficio es
// imposible: si aparece, las valoraciones no dan para medirlo.
function _twrContradice(X){
  if(!X||!X.twr||X.twr.rent==null||X.ben==null)return false;
  return (X.ben>1&&X.twr.rent<0)||(X.ben<-1&&X.twr.rent>0);
}
function _twrNota(X){
  if(!X||!X.twr)return '';
  const t=X.twr;
  if(t.rent==null)return ' · sin valoraciones suficientes para medir la rentabilidad';
  if(_twrContradice(X)||t.incoherente)
    return ' · rentabilidad no medible: tus valoraciones de este periodo no son coherentes entre sí';
  if(t.cobertura<0.7)
    return ' · solo hay valoraciones del '+fmtDate(t.desde)+' al '+fmtDate(t.hasta)+
           ' ('+Math.round(t.cobertura*100)+'% del periodo): en ese trozo, '+
           ((t.rent>=0?'+':'')+(t.rent*100).toFixed(1))+'%';
  return '';
}

function renderAnalisisBlocks(){
  const box=document.getElementById('an-blocks'); if(!box)return;
  const {closed,open,flows,brokerCash}=buildTradeOps();
  // v127 · el efectivo del bróker es cash, no cartera: fuera del bloque.
  const sHold=open.reduce((s,o)=>s+(o.value||0),0);
  const sReal=closed.reduce((s,o)=>s+(o.pnl||0),0), sUn=open.reduce((s,o)=>s+(o.pnl||0),0);
  const sM=flows.length?_metricsFor(flows,sHold,sReal,sUn):null;
  const F=buildFundOps();
  const fM=F.allFlows.length?fundMetrics({flows:F.allFlows,value:F.totalValue,pnl:F.totalPnl,simple:F.totalInvested>0?F.totalPnl/F.totalInvested:null}):null;
  const RG=anBloqueRango();
  let rowsData, colRent='Rentab.', colTir='TIR anual', pie='TIR = rentabilidad anual ponderada por dinero y tiempo. Rentab. de fondos = valor actual vs total aportado.';
  if(RG.todo){
    rowsData=[
      {n:'Acciones',val:sHold,ben:(sReal+sUn),rate:sM?sM.rate:null,simple:null,col:'var(--teal)'},
      {n:'Fondos',val:F.totalValue,ben:F.totalPnl,rate:fM?fM.rate:null,simple:F.totalInvested>0?F.totalPnl/F.totalInvested:null,col:'var(--gold)'},
    ];
  }else{
    // v126 · en un periodo no vale mirar el beneficio acumulado: hay que
    // comparar el valor de entrada con el de salida y descontar lo que metiste
    // o sacaste por el medio. Y la rentabilidad es TWR, no TIR anualizada:
    // anualizar un mes multiplica el ruido por doce.
    const A=stkBloquePeriodo(RG.desde,RG.hasta), Fp=fondosBloquePeriodo(RG.desde,RG.hasta);
    rowsData=[
      {n:'Acciones',val:A?A.valFin:sHold,ben:A?A.ben:null,rate:null,
       simple:(A&&A.twr&&A.twr.cobertura>=0.7&&!A.twr.incoherente&&!_twrContradice(A))?A.twr.rent:null,col:'var(--teal)',
       nota:A?(fmt(A.valIni)+'€ → '+fmt(A.valFin)+'€'+
         (Math.abs(A.flujo)>1?(A.flujo>0?' · metiste '+fmt(A.flujo)+'€':' · sacaste '+fmt(-A.flujo)+'€'):'')+
         (A.recortado?' · solo desde el '+fmtDate(A.desdeReal)+', tu primera valoración':'')+
         (A.desfase?' · ojo: parte del '+fmtDate(A.desdeReal)+', tu última valoración anterior':'')+
         _twrNota(A)):''},
      {n:'Fondos',val:Fp?Fp.valFin:F.totalValue,ben:Fp?Fp.ben:null,rate:null,
       simple:(Fp&&Fp.twr&&Fp.twr.cobertura>=0.7&&!Fp.twr.incoherente&&!_twrContradice(Fp))?Fp.twr.rent:null,col:'var(--gold)',
       nota:Fp?(fmt(Fp.valIni)+'€ → '+fmt(Fp.valFin)+'€'+(Fp.flujo>1?' · aportaste '+fmt(Fp.flujo)+'€':'')+
         (Fp.recortado?' · solo desde el '+fmtDate(Fp.desdeReal)+', tu primera valoración':'')+
         (Fp.desfase?' · ojo: parte del '+fmtDate(Fp.desdeReal)+', tu última valoración anterior':'')+
         _twrNota(Fp)):''},
    ];
    colRent='Rentab. '+(_anBloquePer==='1m'?'del mes':_anBloquePer==='ytd'?'del año':'12 meses');
    colTir='';
    pie='Periodo: <strong>'+RG.desde+' → '+RG.hasta+'</strong>. El beneficio descuenta lo que metiste o sacaste durante el periodo, '+
      'y la rentabilidad es TWR encadenada: mide cómo se han portado los activos, no cuándo pusiste el dinero. '+
      'Si un bloque no tenía valoración cuando empieza el periodo, se mide desde la primera que sí tienes y se avisa debajo del nombre.';
  }
  const totVal=rowsData.reduce((s,r)=>s+(r.val||0),0);
  const totBen=rowsData.every(r=>r.ben==null)?null:rowsData.reduce((s,r)=>s+(r.ben||0),0);
  const cell=(v)=>'<td style="text-align:right;padding:.3rem .5rem;color:#fff">'+v+'</td>';
  const rowHtml=r=>'<tr>'+
    '<td style="text-align:left;padding:.3rem .5rem;color:#fff"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'+r.col+';margin-right:6px"></span>'+r.n+
      (r.nota?'<div style="font-size:9.5px;color:rgba(255,255,255,.55)">'+r.nota+'</div>':'')+'</td>'+
    cell(fmt(r.val)+'€')+
    cell(r.ben==null?'—':'<span style="color:'+(r.ben>=0?'#7EE0A8':'#F4A79B')+'">'+(r.ben>=0?'+':'')+fmt(r.ben)+'€</span>')+
    cell(r.simple!=null?'<strong>'+((r.simple>=0?'+':'')+(Math.abs(r.simple)<0.1?(r.simple*100).toFixed(1):Math.round(r.simple*100))+'%')+'</strong>':'—')+
    (colTir?cell(r.rate!=null?'<strong>'+(r.rate>=0?'+':'')+(r.rate*100).toFixed(1)+'%</strong>':'—'):'')+'</tr>';
  box.innerHTML='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:460px;background:transparent">'+
    '<tr style="color:rgba(255,255,255,.7);font-size:11px"><td style="text-align:left;padding:.3rem .5rem">Bloque</td><td style="text-align:right;padding:.3rem .5rem">Valor'+(RG.todo?' actual':' al final')+'</td><td style="text-align:right;padding:.3rem .5rem">Beneficio'+(RG.todo?'':' '+RG.label.replace(/^(desde|en) /,''))+'</td><td style="text-align:right;padding:.3rem .5rem">'+colRent+'</td><td style="text-align:right;padding:.3rem .5rem">'+colTir+'</td></tr>'+
    rowsData.map(rowHtml).join('')+
    '<tr style="border-top:1px solid rgba(255,255,255,.25)">'+
    '<td style="text-align:left;padding:.4rem .5rem;color:#fff;font-weight:700">TOTAL</td>'+
    cell('<strong>'+fmt(totVal)+'€</strong>')+
    cell(totBen==null?'—':'<strong style="color:'+(totBen>=0?'#7EE0A8':'#F4A79B')+'">'+(totBen>=0?'+':'')+fmt(totBen)+'€</strong>')+
    cell('')+(colTir?cell(''):'')+'</tr>'+
    '</table></div>'+
    '<div style="font-size:10.5px;color:rgba(255,255,255,.6);margin-top:.4rem">'+pie+'</div>';
}

function renderAnalisisFunds(){
  const box=document.getElementById('an-capital');
  const note=document.getElementById('an-capital-note');
  if(!box)return;
  const F=buildFundOps();
  if(!F.funds.length){box.innerHTML='';if(note)note.innerHTML='<p style="font-size:12px;color:var(--muted)">No hay aportaciones a fondos registradas. Añádelas en Datos entrada (Fondos → +Aport).</p>';return;}
  const agg=fundMetrics({flows:F.allFlows,value:F.totalValue,pnl:F.totalPnl,simple:F.totalInvested>0?F.totalPnl/F.totalInvested:null});
  const years=agg?agg.totalDays/365.25:0;
  const perFund=F.funds.map(f=>({f,m:fundMetrics(f)})).filter(x=>x.m);
  const sub=fn=>perFund.length?('<div style="margin-top:.4rem;padding-top:.35rem;border-top:1px dashed var(--border);font-size:12px;line-height:1.5">'+perFund.map(x=>'<div style="display:flex;justify-content:space-between;gap:.5rem"><span style="color:var(--muted)">'+x.f.name+'</span><span>'+fn(x)+'</span></div>').join('')+'</div>'):'';
  const cardX=(t,v,s,c,fn)=>'<div class="kpi"><div class="kpi-lbl">'+t+'</div><div class="kpi-val '+(c||'')+'" style="font-size:15px">'+v+'</div>'+(s?'<div style="font-size:10.5px;color:var(--muted)">'+s+'</div>':'')+sub(fn)+'</div>';
  box.innerHTML=
    cardX('TIR (rentab. anual)',agg&&agg.rate!=null?((agg.rate>=0?'+':'')+(agg.rate*100).toFixed(1)+'%/año'):'—','ponderada por dinero y tiempo',agg&&agg.rate!=null?_cls(agg.rate):'',x=>x.m.rate!=null?'<span class="'+_cls(x.m.rate)+'">'+(x.m.rate>=0?'+':'')+(x.m.rate*100).toFixed(1)+'%</span>':'—')+
    cardX('Rentabilidad simple',F.totalInvested>0?_pctS(F.totalPnl/F.totalInvested):'—','valor actual vs total aportado',F.totalPnl>=0?'pos':'neg',x=>x.f.simple!=null?'<span class="'+_cls(x.f.simple)+'">'+_pctS(x.f.simple)+'</span>':'—')+
    cardX('Beneficio total',_eurS(F.totalPnl),'valor '+fmt(F.totalValue)+'€ − aportado '+fmt(F.totalInvested)+'€',_cls(F.totalPnl),x=>'<span class="'+_cls(x.f.pnl)+'">'+_eurS(x.f.pnl)+'</span>')+
    cardX('Total aportado',fmt(F.totalInvested)+'€','suma de tus aportaciones','',x=>fmt(x.f.invested)+'€')+
    cardX('Valor actual',fmt(F.totalValue)+'€','últimos valores liquidativos','',x=>fmt(x.f.value)+'€')+
    cardX('Capital medio empleado',agg?fmt(agg.avgCapital)+'€':'—','media ponderada por tiempo','',x=>fmt(x.m.avgCapital)+'€');
  if(note)note.innerHTML='<div style="font-size:11.5px;color:var(--muted);margin-top:.4rem">Los fondos se actualizan a mano (no hay fuente automática de valor liquidativo). Cuanto más al día tengas el VL en Datos entrada, más exacta será la rentabilidad. La <strong>rentabilidad simple</strong> compara el valor actual con lo aportado; la <strong>TIR</strong> tiene en cuenta cuándo aportaste cada cantidad.</div>';
}

const COBAS_REAL_ANCHORS=[];
const FUND_SERIES={};
let _fondoMode='eur';
const _fondoSel={cobas:true,magal:true,azvalor:true};
let _fondosChart=null;
function setFondoMode(m){_fondoMode=m;document.querySelectorAll('.fondo-mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===m));renderFondos();}
function toggleFondo(f){
  const on=Object.values(_fondoSel).filter(Boolean).length;
  if(_fondoSel[f]&&on<=1)return;
  _fondoSel[f]=!_fondoSel[f];
  document.querySelectorAll('.fondo-pill').forEach(b=>b.classList.toggle('active',_fondoSel[b.dataset.fund]));
  renderFondos();
}
function renderFondos(){
  const cv=document.getElementById('fondos-chart'); if(!cv||typeof Chart==='undefined')return;
  initRangeSelects('fondo',2017);
  const b=rangeBounds('fondo');
  const isRent=_fondoMode==='rent';
  const dark=document.body.classList.contains('dark');
  const ds=[];
  cfg.funds.forEach(fu=>{
    const fid=fu.id;
    if(_fondoSel[fid]===false)return;
    const leg=fundSeriesLegacy(fid)||{};
    const F={name:fu.name,color:leg.color||'#0B3D91'};
    // serie viva: tus saldos, y la rentabilidad recalculada sobre ellos
    const vs=fundValueSeries(fid);
    const src=(isRent
        ? vs.map(p=>{const t=fundTWR(fid,vs[0].date,p.date);return [p.date,t==null?0:t*100];})
        : vs.map(p=>[p.date,p.val])
      ).filter(p=>inRange(p[0],b));
    ds.push({label:F.name,data:src.map(p=>({x:Date.parse(p[0]),y:p[1]})),borderColor:F.color,backgroundColor:F.color+'20',borderWidth:2,fill:false,tension:.15,pointRadius:0,pointHoverRadius:4});
    if(!isRent){
      const vs2=fundValueSeries(fid);
      const cf=fundContribs(fid).filter(c=>inRange(c.date,b)).map(c=>{
        const near=vs2.reduce((acc,q)=>Math.abs(Date.parse(q.date)-Date.parse(c.date))<Math.abs(Date.parse(acc.date)-Date.parse(c.date))?q:acc,vs2[0]||{date:c.date,val:0});
        return [c.date,c.amount,near.val];});
      ds.push({label:F.name+' · aportaciones',data:cf.map(c=>({x:Date.parse(c[0]),y:c[2],amt:c[1]})),type:'scatter',borderColor:F.color,backgroundColor:'#fff',pointStyle:'triangle',radius:6,hoverRadius:8,borderWidth:2,showLine:false});
    }
  });
  if(_fondosChart)_fondosChart.destroy();
  _fondosChart=new Chart(cv,{type:'line',
    data:{datasets:ds},
    options:{responsive:true,maintainAspectRatio:false,parsing:false,interaction:{mode:'nearest',intersect:false},
      plugins:{legend:{display:true,labels:{filter:i=>!/aportaciones/.test(i.text),color:dark?'#A0AEC0':'#5A6A80',font:{size:11},usePointStyle:true,boxWidth:8}},
        tooltip:{callbacks:{
          title:i=>i.length?fmtDateFull(new Date(i[0].parsed.x).toISOString().slice(0,10)):'',
          label:c=>{const amt=c.raw&&c.raw.amt;if(amt)return c.dataset.label.replace(' · aportaciones','')+' — aportación +'+fmt(amt)+'€';return c.dataset.label+': '+(isRent?((c.parsed.y>=0?'+':'')+c.parsed.y.toFixed(2)+'%'):(fmt(c.parsed.y)+'€'));}
        }},
        zoom:{zoom:{wheel:{enabled:true},pinch:{enabled:true},mode:'x'},pan:{enabled:true,mode:'x'}}},
      scales:{
        x:{type:'linear',grid:{display:false},ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:9},maxTicksLimit:8,callback:v=>fmtDateFull(new Date(v).toISOString().slice(0,10))}},
        y:{grid:{color:dark?'rgba(255,255,255,.06)':'rgba(0,0,0,.06)'},ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:10},callback:v=>isRent?(v.toFixed(0)+'%'):(fmt(v)+'€')}}
      }
    }
  });
  const note=document.getElementById('fondos-note');
  if(note){const bits=[];cfg.funds.forEach(fu=>{const fid=fu.id;if(_fondoSel[fid]===false)return;const vs=fundValueSeries(fid);if(!vs.length)return;const lp=vs[vs.length-1];const tw=fundTWR(fid);const F={name:fu.name};const last=isRent?[lp.date,tw==null?0:tw*100]:[lp.date,lp.val];bits.push('<strong>'+F.name+'</strong>: '+(isRent?((last[1]>=0?'+':'')+last[1]+'%'):(fmt(last[1])+'€')));});note.innerHTML=bits.join(' · ');}
  try{renderFundCards();}catch(e){console.warn('fichas fondos',e);}
}

function injectCobasRealHistory(){
  const existing=new Set(balanceLog.filter(b=>b.refType==='fund'&&b.refId==='cobas').map(b=>b.date));
  let added=0;
  FUND_ANCHORS().forEach(r=>{
    if(existing.has(r[0]))return;
    balanceLog.push({id:'bal_cobasreal_'+r[0].replace(/-/g,''),refType:'fund',refId:'cobas',date:r[0],amount:r[1],src:'cobas_real'});
    added++;
  });
  save();
  alert(added>0
    ? (added+' anclajes de valor real de Cobas añadidos al histórico. Ahora el valor real de mercado queda disponible para cualquier mes pasado. Los valores actuales y el patrimonio histórico NO se han tocado.')
    : 'Los anclajes de valor real de Cobas ya estaban en tus datos. Nada que añadir.');
  renderFondos();
}
function renderAnalisis(){
  renderAnalisisBlocks();
  renderFondos();
  if(_anScope==='fondos'){ renderAnalisisFunds(); return; }
  renderAnalisisStocks();
}
function renderAnalisisStocks(){
  const {closed,open,flows,brokerCash}=buildTradeOps();
  const box=document.getElementById('an-capital');
  const note=document.getElementById('an-capital-note');
  const disp=document.getElementById('an-disposition');
  if(!box)return;
  if(!flows.length){box.innerHTML='';if(note)note.innerHTML='<p style="font-size:12px;color:var(--muted)">Registra compras y ventas de acciones para ver el análisis.</p>';if(disp)disp.innerHTML='';return;}
  const holdings=open.reduce((s,o)=>s+(o.value||0),0);
  const realized=closed.reduce((s,o)=>s+(o.pnl||0),0);
  const unreal=open.reduce((s,o)=>s+(o.pnl||0),0);
  const a=_metricsFor(flows,holdings,realized,unreal);
  const years=a.totalDays/365.25;
  const ideas=[...new Set(flows.map(f=>f.idea||''))];
  const byIdea={};
  ideas.forEach(k=>{const ifl=flows.filter(f=>(f.idea||'')===k);const iH=open.filter(o=>(o.idea||'')===k).reduce((s,o)=>s+(o.value||0),0);const iR=closed.filter(o=>(o.idea||'')===k).reduce((s,o)=>s+(o.pnl||0),0);const iU=open.filter(o=>(o.idea||'')===k).reduce((s,o)=>s+(o.pnl||0),0);const m=_metricsFor(ifl,iH,iR,iU);if(m)byIdea[k]=m;});
  const ik=Object.keys(byIdea).sort((x,y)=>{const o={value:0,tecnico:1,otros:2,'':3};return (o[x]??9)-(o[y]??9);});
  const sub=fn=>ik.length?('<div style="margin-top:.4rem;padding-top:.35rem;border-top:1px dashed var(--border);font-size:12px;line-height:1.5">'+ik.map(k=>'<div style="display:flex;justify-content:space-between;gap:.5rem"><span style="color:var(--muted)">'+(AN_IDEA_LABELS[k]||k)+'</span><span>'+fn(byIdea[k])+'</span></div>').join('')+'</div>'):'';
  const cardX=(t,v,s,c,fn)=>'<div class="kpi"><div class="kpi-lbl">'+t+'</div><div class="kpi-val '+(c||'')+'" style="font-size:15px">'+v+'</div>'+(s?'<div style="font-size:10.5px;color:var(--muted)">'+s+'</div>':'')+sub(fn)+'</div>';
  const rateTxt=a.rate!=null?((a.rate>=0?'+':'')+(a.rate*100).toFixed(1)+'%/año'):'—';
  box.innerHTML=
    cardX('TIR (rentab. anual del capital)',rateTxt,'ponderada por dinero y tiempo',a.rate!=null?_cls(a.rate):'',m=>m.rate!=null?'<span class="'+_cls(m.rate)+'">'+(m.rate>=0?'+':'')+(m.rate*100).toFixed(1)+'%</span>':'—')+
    cardX('Beneficio total',_eurS(a.totalProfit),'realizado '+_eurS(a.realized)+' · latente '+_eurS(a.unreal),_cls(a.totalProfit),m=>'<span class="'+_cls(m.totalProfit)+'">'+_eurS(m.totalProfit)+'</span>')+
    cardX('Capital medio empleado',fmt(a.avgCapital)+'€','media ponderada por tiempo','',m=>fmt(m.avgCapital)+'€')+
    cardX('Rentab. sobre capital medio',a.retOnAvg!=null?_pctS(a.retOnAvg):'—','en '+years.toFixed(1)+' años',a.retOnAvg!=null?_cls(a.retOnAvg):'',m=>m.retOnAvg!=null?'<span class="'+_cls(m.retOnAvg)+'">'+_pctS(m.retOnAvg)+'</span>':'—')+
    cardX('Capital máximo desplegado',fmt(a.peak)+'€','tu mayor exposición simultánea','',m=>fmt(m.peak)+'€')+
    cardX('Periodo analizado',years.toFixed(1)+' años','desde '+a.firstDate,'',()=>'');
  const groups={};
  closed.forEach(o=>{if(o.pnl==null||!o.invested||!o.entry||!o.exit)return;const k=(o.idea||'')+'||'+(o.setup||'');(groups[k]=groups[k]||[]).push(o);});
  const grp=Object.entries(groups).map(([k,ops])=>{const [idea,setup]=k.split('||');const n=ops.length;const wins=ops.filter(o=>o.pnl>0),losses=ops.filter(o=>o.pnl<=0);const benef=ops.reduce((s,o)=>s+o.pnl,0);const avgRet=ops.reduce((s,o)=>s+o.pnl/o.invested,0)/n;const avgWin=wins.length?wins.reduce((s,o)=>s+o.pnl/o.invested,0)/wins.length:null;const avgLoss=losses.length?losses.reduce((s,o)=>s+o.pnl/o.invested,0)/losses.length:null;const payoff=(avgWin!=null&&avgLoss!=null&&avgLoss!==0)?Math.abs(avgWin/avgLoss):null;const avgDays=ops.reduce((s,o)=>s+((new Date(o.exit)-new Date(o.entry))/864e5),0)/n;return {idea,setup,n,winRate:wins.length/n,benef,avgRet,avgWin,avgLoss,payoff,avgDays};}).sort((a,b)=>b.benef-a.benef);
  let grpHtml='';
  if(grp.length){grpHtml='<div style="margin-top:1rem"><strong style="font-size:12px">Análisis por idea y setup</strong><div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;margin-top:.4rem;font-size:12px;min-width:640px"><tr style="color:var(--muted);text-align:right"><td style="text-align:left">Idea · Setup</td><td>Ops</td><td>Acierto</td><td>Beneficio</td><td>Ret.medio</td><td>Media gan.</td><td>Media pérd.</td><td>Ratio</td><td>Días</td></tr>'+grp.map(g=>'<tr><td style="text-align:left"><strong>'+(AN_IDEA_LABELS[g.idea]||'—')+'</strong>'+(g.setup?' · <span style="color:var(--muted)">'+g.setup+'</span>':' · <span style="color:var(--faint)">(sin setup)</span>')+'</td><td style="text-align:right">'+g.n+(g.n<5?' <span title="muestra pequeña" style="color:var(--amber)">⚠</span>':'')+'</td><td style="text-align:right">'+Math.round(g.winRate*100)+'%</td><td style="text-align:right" class="'+_cls(g.benef)+'">'+_eurS(g.benef)+'</td><td style="text-align:right" class="'+_cls(g.avgRet)+'">'+_pctS(g.avgRet)+'</td><td style="text-align:right" class="pos">'+(g.avgWin!=null?_pctS(g.avgWin):'—')+'</td><td style="text-align:right" class="neg">'+(g.avgLoss!=null?_pctS(g.avgLoss):'—')+'</td><td style="text-align:right">'+(g.payoff!=null?g.payoff.toFixed(2):'—')+'</td><td style="text-align:right">'+Math.round(g.avgDays)+'</td></tr>').join('')+'</table></div><p style="font-size:11px;color:var(--amber);margin-top:.4rem">⚠ Las categorías con menos de 5 operaciones tienen muy poca muestra: sus porcentajes pueden ser fruto del azar, no de tu método. Tómalos como pista, no como conclusión.</p></div>';}
  if(note)note.innerHTML=(brokerCash>0?'<div style="font-size:11.5px;color:var(--teal);margin-top:.5rem">💶 Tienes '+fmt(brokerCash)+'€ de efectivo parado en el bróker. No entra en estos números: es liquidez, y ya cuenta como cash en el dashboard.</div>':'')+'<div style="font-size:11.5px;color:var(--muted);margin-top:.4rem">La TIR es el beneficio real de tu capital: cuenta la rotación y que a veces tienes más o menos invertido.</div>'+grpHtml;
  const co=closed.filter(o=>o.entry&&o.exit&&o.pnl!=null);
  const daysOf=o=>(new Date(o.exit)-new Date(o.entry))/864e5;
  const wins=co.filter(o=>o.pnl>0),losses=co.filter(o=>o.pnl<=0);
  const avgd=arr=>arr.length?arr.reduce((s,o)=>s+daysOf(o),0)/arr.length:null;
  const dw=avgd(wins),dl=avgd(losses);
  let dHtml='<strong style="font-size:12px">Días en cartera: ganadoras vs perdedoras</strong><div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-top:.4rem;font-size:12.5px"><div>Ganadoras ('+wins.length+'): <strong class="pos">'+(dw!=null?Math.round(dw)+' días':'—')+'</strong></div><div>Perdedoras ('+losses.length+'): <strong class="neg">'+(dl!=null?Math.round(dl)+' días':'—')+'</strong></div>'+((dw!=null&&dl!=null)?'<div>Ratio: <strong>'+(dl/dw).toFixed(2)+'×</strong></div>':'')+'</div>';
  if(losses.length===0&&wins.length>0) dHtml+='<p style="font-size:11.5px;color:var(--amber);margin-top:.35rem">⚠ Todas tus operaciones cerradas son ganadoras y no has cerrado ninguna perdedora: las perdedoras siguen abiertas. Es el efecto disposición en su forma más clara.</p>';
  else if(dw!=null&&dl!=null&&dl>dw*1.15) dHtml+='<p style="font-size:11.5px;color:var(--red);margin-top:.35rem">⚠ Aguantas las perdedoras '+(dl/dw).toFixed(1)+'× más que las ganadoras.</p>';
  const exg={}; co.forEach(o=>{const k=o.exitReason||'';(exg[k]=exg[k]||[]).push(o);});
  const ek=Object.keys(exg);
  if(ek.length&&!(ek.length===1&&ek[0]==='')){
    const rows=ek.map(k=>{const ops=exg[k];const n=ops.length;const benef=ops.reduce((s,o)=>s+o.pnl,0);const w=ops.filter(o=>o.pnl>0).length;const ad=ops.reduce((s,o)=>s+daysOf(o),0)/n;const ar=ops.reduce((s,o)=>s+(o.invested?o.pnl/o.invested:0),0)/n;return {k,n,benef,winRate:w/n,ad,ar};}).sort((a,b)=>b.benef-a.benef);
    dHtml+='<div style="margin-top:1rem"><strong style="font-size:12px">Análisis por motivo de salida</strong><table style="width:100%;border-collapse:collapse;margin-top:.4rem;font-size:12px"><tr style="color:var(--muted);text-align:right"><td style="text-align:left">Motivo</td><td>Ops</td><td>Acierto</td><td>Beneficio</td><td>Ret.medio</td><td>Días</td></tr>'+rows.map(r=>'<tr><td style="text-align:left">'+(AN_EXIT_LABELS[r.k]||r.k)+'</td><td style="text-align:right">'+r.n+'</td><td style="text-align:right">'+Math.round(r.winRate*100)+'%</td><td style="text-align:right" class="'+_cls(r.benef)+'">'+_eurS(r.benef)+'</td><td style="text-align:right" class="'+_cls(r.ar)+'">'+_pctS(r.ar)+'</td><td style="text-align:right">'+Math.round(r.ad)+'</td></tr>').join('')+'</table></div>';
  } else { dHtml+='<p style="font-size:11.5px;color:var(--muted);margin-top:.75rem">Registra el <strong>motivo de salida</strong> en tus ventas para ver si vendes por método o por emoción.</p>'; }
  if(disp)disp.innerHTML=dHtml;

  // ── Chart: P/L per operation (closed solid, open translucent) ──
  renderAnalisisChart(closed,open);
  try{renderRecorridoChart(closed,open);}catch(e){console.warn('recorrido',e);}
  try{renderAnalisisCompras();}catch(e){console.warn('compras',e);}
  renderAnalisisEvolution();

  // ── Registro de cierres (read-only table) ──
  const cbox=document.getElementById('an-closed');
  if(cbox){
    const cc=closed.slice().sort((a,b)=>(b.exit||'').localeCompare(a.exit||''));
    if(!cc.length) cbox.innerHTML='<p style="font-size:12px;color:var(--muted)">Sin operaciones cerradas.</p>';
    else cbox.innerHTML='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;min-width:640px">'+
      '<tr style="color:var(--muted);text-align:right"><td style="text-align:left">Acción</td><td style="text-align:left">Idea · Setup</td><td>Entrada</td><td>Salida</td><td>Días</td><td>Invertido</td><td>G/P</td><td>Ret.</td><td style="text-align:left">Motivo</td></tr>'+
      cc.map(o=>{const days=(o.entry&&o.exit)?Math.round((new Date(o.exit)-new Date(o.entry))/864e5):null;const ret=o.invested?o.pnl/o.invested:null;
        return '<tr><td style="text-align:left;font-weight:500">'+escapeHtml(o.name)+'</td>'+
        '<td style="text-align:left;color:var(--muted)">'+(AN_IDEA_LABELS[o.idea]||'—')+(o.setup?' · '+o.setup:'')+'</td>'+
        '<td style="text-align:right">'+(o.entry||'—')+'</td><td style="text-align:right">'+(o.exit||'—')+'</td>'+
        '<td style="text-align:right">'+(days!=null?days:'—')+'</td>'+
        '<td style="text-align:right">'+fmt2(o.invested||0)+'€</td>'+
        '<td style="text-align:right;font-weight:600" class="'+_cls(o.pnl)+'">'+_eurS(o.pnl)+'</td>'+
        '<td style="text-align:right" class="'+_cls(ret||0)+'">'+(ret!=null?_pctS(ret):'—')+'</td>'+
        '<td style="text-align:left;color:var(--muted)">'+(AN_EXIT_LABELS[o.exitReason]||'—')+'</td></tr>';}).join('')+'</table></div>';
  }
  try{renderCuadrePos(open);}catch(e){console.warn('cuadrepos',e);}
  // ── Posiciones abiertas (read-only table) ──
  const obox=document.getElementById('an-open');
  if(obox){
    const oo=open.slice().sort((a,b)=>(b.value||0)-(a.value||0));
    const today=new Date();
    if(!oo.length) obox.innerHTML='<p style="font-size:12px;color:var(--muted)">Sin posiciones abiertas.</p>';
    else obox.innerHTML='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;min-width:560px">'+
      '<tr style="color:var(--muted);text-align:right"><td style="text-align:left">Acción</td><td style="text-align:left">Idea · Setup</td><td>Entrada</td><td>Días</td><td>Invertido</td><td>Valor</td><td>P/L latente</td><td>Rentab.</td></tr>'+
      oo.map(o=>{const days=o.entry?Math.round((today-new Date(o.entry))/864e5):null;const ret=o.invested?o.pnl/o.invested:null;
        return '<tr><td style="text-align:left;font-weight:500">'+escapeHtml(o.name)+'</td>'+
        '<td style="text-align:left;color:var(--muted)">'+(AN_IDEA_LABELS[o.idea]||'—')+(o.setup?' · '+o.setup:'')+'</td>'+
        '<td style="text-align:right">'+(o.entry||'—')+'</td><td style="text-align:right">'+(days!=null?days:'—')+'</td>'+
        '<td style="text-align:right">'+fmt2(o.invested||0)+'€</td><td style="text-align:right">'+fmt2(o.value||0)+'€</td>'+
        '<td style="text-align:right;font-weight:600" class="'+_cls(o.pnl)+'">'+_eurS(o.pnl)+'</td>'+
        '<td style="text-align:right" class="'+_cls(ret||0)+'">'+(ret!=null?_pctS(ret):'—')+'</td></tr>';}).join('')+'</table></div>';
  }
}

let _anChart=null;
const STOCK_DAILY_RECON=[];
let _anEvolChart=null;
let _evolMode='eur';
function setEvolMode(m){_evolMode=m;
  document.querySelectorAll('.evol-mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===m));
  renderAnalisisEvolution();
}
// v127 · CORREGIDO. Esta serie metía el efectivo parado en el bróker dentro
// del valor de la cartera de acciones. Consecuencia: cada transferencia que
// hacías del banco al bróker subía el "valor" sin que hubiese comprado nada,
// y como los flujos que se descontaban eran solo compras y ventas, ese dinero
// aparecía como RENTABILIDAD. Transferir no es ganar.
//
// El resto de la app ya lo tenía claro: getAcc() dice literalmente que la
// liquidez del bróker es cash y la deja fuera de las acciones. Esta serie era
// la única que no seguía ese criterio, y de ella cuelgan la gráfica de
// rentabilidad de la cartera y la tabla de rentabilidad por bloque.
// v128 · Esta serie solo miraba balanceLog, y tus saldos de acciones empiezan
// el 19/07/2026. Por eso "1 mes", "1 año" y "este año" daban exactamente lo
// mismo: los tres periodos arrancaban el mismo día, el primero que había.
// Pero la reconstrucción diaria (STK_DAILY) cubre desde junio de 2025 —309
// días— y la cascada patrimonial ya la usaba. Dos fuentes para la misma
// pregunta y cada pantalla cogiendo una. Ahora se fusionan aquí, una sola vez:
// manda tu saldo registrado y la reconstrucción rellena lo que falta.
function stockPortfolioSeries(){
  const m=new Map();
  ((typeof STK_DAILY==='function')?STK_DAILY():[]).forEach(r=>{
    if(r&&r[0])m.set(String(r[0]),{v:Math.round((Number(r[1])||0)*100)/100,src:'recon'});
  });
  const dates=[...new Set(balanceLog.filter(b=>b.refType==='stock'&&b.date).map(b=>b.date))].sort();
  dates.forEach(d=>{
    let total=0;
    cfg.stocks.forEach(s=>{
      const es=balanceLog.filter(b=>b.refType==='stock'&&b.refId===s.id&&b.date<=d).sort((a,b)=>a.date.localeCompare(b.date));
      if(es.length) total+=es[es.length-1].amount||0;
    });
    m.set(d,{v:Math.round(total*100)/100,src:'saldo'});   // el tuyo pisa a la reconstrucción
  });
  return [...m.entries()].map(([date,o])=>({date,value:o.v,src:o.src}))
    .sort((a,b)=>a.date.localeCompare(b.date));
}
// ── Selectores de rango de fecha reutilizables (mes+año) ────────────
const RANGE_MESES=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
function initRangeSelects(prefix,minYear){
  ['from','to'].forEach(w=>{
    const ms=document.getElementById(prefix+'-'+w+'-m'), ys=document.getElementById(prefix+'-'+w+'-y');
    if(ms&&!ms.dataset.init){ms.innerHTML='<option value="">—</option>'+RANGE_MESES.map((n,i)=>'<option value="'+String(i+1).padStart(2,'0')+'">'+n+'</option>').join('');ms.dataset.init='1';}
    if(ys&&!ys.dataset.init){const cy=new Date().getFullYear();let o='<option value="">—</option>';for(let y=cy;y>=minYear;y--)o+='<option value="'+y+'">'+y+'</option>';ys.innerHTML=o;ys.dataset.init='1';}
  });
}
function rangeBounds(prefix){
  const fm=document.getElementById(prefix+'-from-m'), fy=document.getElementById(prefix+'-from-y');
  const tm=document.getElementById(prefix+'-to-m'), ty=document.getElementById(prefix+'-to-y');
  let from=null,to=null;
  if(fm&&fy&&fm.value&&fy.value) from=fy.value+'-'+fm.value+'-01';
  if(tm&&ty&&tm.value&&ty.value) to=ty.value+'-'+tm.value+'-31';
  return {from,to};
}
function inRange(dateStr,b){ if(b.from&&dateStr<b.from)return false; if(b.to&&dateStr>b.to)return false; return true; }
function clearRange(prefix){
  ['from-m','from-y','to-m','to-y'].forEach(s=>{const el=document.getElementById(prefix+'-'+s);if(el)el.value='';});
}
// v115 · Antes esto era la serie congelada de ProRealTime, prolongada a saltos
// con las valoraciones de DEGIRO. Ahora, si hay precios importados, la serie se
// reconstruye día a día con tus propias operaciones.
//
// v118 · Y la RENTABILIDAD estaba mal de raíz. Se calculaba dividiendo el valor
// de hoy entre el del primer día: eso daba +756%, que no es ninguna
// rentabilidad — es cuánto dinero has ido metiendo. Empezaste con X€ en una
// sola acción y hoy tienes X€ repartidos en nueve, pero es que has ido
// aportando capital. Medirlo así es como decir que tu cuenta corriente "rinde"
// un 700% porque ingresas la nómina.
//
// Lo correcto con aportaciones y retiradas es la rentabilidad ENCADENADA (TWR):
// cada día se mide cuánto se movió la cartera descontando el dinero que entró o
// salió ese día, y se van encadenando esos rendimientos diarios. Así el capital
// que metes no cuenta como ganancia. Tu TWR real es +14,2%, no +756%.
let _evolFuente='', _evolRotas=0;

// Dinero neto que entra (compras) o sale (ventas) de la cartera cada día,
// comisiones incluidas: es lo que hay que descontar para no contarlo como
// rentabilidad.
function stkFlujoDia(){
  const f={};
  transactions.filter(t=>(t.type==='buy'||t.type==='sell')&&t.date).forEach(t=>{
    const imp=Number(t.total)||0, c=Number(t.costs)||0;
    f[t.date]=(f[t.date]||0)+(t.type==='buy'?(imp+c):-(imp-c));
  });
  return f;
}
// Encadena los rendimientos diarios sobre UNA SOLA fuente de valoración.
//
// Mezclar fuentes para medir rentabilidad no funciona: entre un día valorado
// por la reconstrucción y el siguiente valorado por DEGIRO hay una diferencia
// de método, no de mercado, y encadenarla mete un sesgo. Saltarse ese día
// tampoco basta, porque el siguiente se encadena igualmente contra el valor
// ajeno. Así que la cadena se calcula sobre la serie reconstruida —que usa el
// mismo método todos los días— y se proyecta sobre el resto de puntos.
function stkEncadenaSerie(puntos){
  const F=stkFlujoDia();
  const fechas=Object.keys(F).sort();
  // Entre dos puntos de la cadena puede haber días que la serie no cubre —
  // justo los días en que compras una acción nueva, que todavía no tiene
  // precio. Si solo se descuenta el flujo del día exacto, esas compras se
  // cuelan como rentabilidad: aquí eran ocho puntos de más.
  const flujoEntre=(desde,hasta)=>{
    let t=0;
    for(const f of fechas){ if(f>desde&&f<=hasta)t+=F[f]; else if(f>hasta)break; }
    return t;
  };
  let acc=1, prev=null, prevD=null;
  const out=[];
  puntos.forEach(p=>{
    if(prev!=null&&prev>0){
      const fl=flujoEntre(prevD,p.date);
      const r=(p.eur-fl)/prev-1;
      acc*=(1+r);
    }
    prev=p.eur; prevD=p.date;
    out.push({date:p.date,rent:Math.round((acc-1)*10000)/100});
  });
  return out;
}
function stkEncadena(todos){
  const base=todos.filter(p=>p.src==='calc');
  const usaCalc=base.length>=Math.max(20,todos.length*0.5);
  const serieBase=usaCalc?base:todos;
  _evolRotas=usaCalc?(todos.length-base.length):0;
  const R=stkEncadenaSerie(serieBase);
  // proyectar sobre todos los puntos: cada día hereda la última rentabilidad
  // calculada hasta esa fecha
  let i=0, ult=0;
  todos.forEach(p=>{
    while(i<R.length&&R[i].date<=p.date){ult=R[i].rent;i++;}
    p.rent=ult;
  });
  return todos;
}
function evolSeries(){
  const viejo=STK_DAILY().map(r=>({date:r[0],eur:r[1],src:'hist'}));
  const nuevo=(typeof stkCarteraDiaria==='function')?stkCarteraDiaria():[];
  const utiles=nuevo.filter(x=>x.completo&&x.val>0);
  const m=new Map();
  viejo.forEach(p=>m.set(p.date,p));
  utiles.forEach(p=>m.set(p.date,{date:p.date,eur:Math.round(p.val),src:'calc'}));
  const fechasBal=[...new Set(balanceLog.filter(b=>b.refType==='stock'&&b.date).map(b=>b.date))].sort();
  fechasBal.forEach(d=>{
    let total=0;
    cfg.stocks.forEach(s=>{const es=balanceLog.filter(b=>b.refType==='stock'&&b.refId===s.id&&b.date<=d)
      .sort((a,b)=>a.date.localeCompare(b.date));if(es.length)total+=es[es.length-1].amount||0;});
    if(total>0)m.set(d,{date:d,eur:Math.round(total),src:'degiro'});
  });
  const out=[...m.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const nCalc=out.filter(x=>x.src==='calc').length, nDeg=out.filter(x=>x.src==='degiro').length;
  _evolFuente=out.length
    ? [nCalc?nCalc+' días reconstruidos con precios importados':'',
       nDeg?nDeg+' valoraciones de DEGIRO':'',
       out.filter(x=>x.src==='hist').length+' del histórico anterior'].filter(Boolean).join(' · ')
    : '';
  return stkEncadena(out);
}
function renderAnalisisEvolution(){
  const cv=document.getElementById('an-evol-chart');
  const empty=document.getElementById('an-evol-empty');
  if(!cv||typeof Chart==='undefined')return;
  initRangeSelects('evol',2025);
  const b=rangeBounds('evol');
  const s=evolSeries().filter(p=>inRange(p.date,b));
  if(s.length<2){ if(empty){empty.style.display='block';empty.textContent=(b.from||b.to)?'No hay datos en ese rango de fechas.':'Importa tu cartera de DEGIRO (botón en Datos entrada) varias veces para ir dibujando la evolución diaria.';} cv.style.display='none'; if(_anEvolChart){_anEvolChart.destroy();_anEvolChart=null;} return; }
  if(empty)empty.style.display='none'; cv.style.display='';
  const fu=document.getElementById('an-evol-fuente');
  if(fu)fu.innerHTML=(isRent
    ? '<strong>Rentabilidad encadenada (TWR)</strong>: cada día se mide cómo se movió la cartera descontando el dinero '+
      'que entró o salió ese día, y se encadenan. Tus aportaciones NO cuentan como ganancia. '+
      (_evolRotas?'<span style="color:var(--faint)">La cadena se calcula solo sobre los días reconstruidos, que usan el mismo '+
        'método siempre; los otros '+_evolRotas+' heredan la última rentabilidad en vez de mezclar valoraciones.</span> ':'')
    : '')+
    (_evolFuente?('Origen de los puntos: '+_evolFuente+'.'):'');
  const dark=document.body.classList.contains('dark');
  const isRent=_evolMode==='rent';
  const rows=isRent? s.filter(p=>p.rent!=null): s;
  const labels=rows.map(p=>fmtDateFull(p.date));
  const data=rows.map(p=>isRent?p.rent:p.eur);
  const color=isRent?'#1baf7a':'#0B3D91';
  const bg=isRent?'rgba(27,175,122,.09)':'rgba(11,61,145,.08)';
  if(_anEvolChart)_anEvolChart.destroy();
  _anEvolChart=new Chart(cv,{
    type:'line',
    data:{labels,datasets:[{data,borderColor:color,backgroundColor:bg,borderWidth:2,fill:true,tension:.15,pointRadius:0,pointHoverRadius:4,pointBackgroundColor:color}]},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},
        tooltip:{callbacks:{title:i=>i[0].label,label:c=>isRent?((c.raw>=0?'+':'')+c.raw.toFixed(2)+'%'):(fmt(c.raw)+'€')}},
        zoom:{zoom:{wheel:{enabled:true},pinch:{enabled:true},mode:'x'},pan:{enabled:true,mode:'x'},limits:{x:{minRange:5}}}},
      scales:{
        x:{grid:{display:false},ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:9}},
        y:{grid:{color:dark?'rgba(255,255,255,.08)':'rgba(0,0,0,.05)'},ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:10},callback:v=>isRent?(v.toFixed(0)+'%'):(fmt(v)+'€')}}
      }
    }
  });
}

// ════════════════════════════════════════════════════════════════════
// v119 · CUADRE DE POSICIONES CONTRA DEGIRO
// ════════════════════════════════════════════════════════════════════
// «En esta acción me pone que pierdo X € cuando en realidad pierdo
// X». Los dos números pueden ser correctos y venir de datos distintos:
// el resultado de una posición son sólo tres cifras —títulos, lo que te costó y
// lo que vale hoy— y basta con que una baile. En vez de discutir el total, aquí
// se enseñan las tres y se deja que escribas la de DEGIRO: la app despeja cuál
// de las tres tendría que ser para que salga tu número.
let _cpOpen=false, _cpMio={};
function toggleCuadrePos(){_cpOpen=!_cpOpen;renderCuadrePos();}
let _cpUltimas=[];
function cuadrePosMio(el){
  const v=cuadreNum(el.value);
  if(!isFinite(v))delete _cpMio[el.dataset.id]; else _cpMio[el.dataset.id]=v;
  renderCuadrePos();
}
function renderCuadrePos(open){
  // v135 · Esta ficha se pintaba con la última lista que alguien le hubiera
  // pasado. Si cambiabas las valoraciones y no se repintaba entera la pestaña
  // de Análisis, se quedaba con los números viejos mientras las tablas de al
  // lado ya tenían los nuevos: dos cifras distintas para lo mismo, en la misma
  // pantalla. Ahora, si no le dan datos frescos, se los busca ella. La fuente
  // sigue siendo una sola, buildTradeOps(), la misma que usa todo lo demás.
  if(open==null){ try{ open=buildTradeOps().open; }catch(e){ open=_cpUltimas; } }
  _cpUltimas=open||[];
  const box=document.getElementById('an-cuadrepos'); if(!box)return;
  const O=(_cpUltimas||[]).filter(o=>o.shares>0).slice().sort((a,b)=>(b.value||0)-(a.value||0));
  const arrow=document.getElementById('cp-arrow');
  if(arrow)arrow.innerHTML=_cpOpen?'&#9662;':'&#9656;';
  const badge=document.getElementById('cp-badge');
  const nMio=Object.keys(_cpMio).length;
  if(badge)badge.textContent=O.length+' posiciones abiertas'+(nMio?' · '+nMio+' comparada(s) con DEGIRO':'');
  if(!_cpOpen){box.innerHTML='';return;}
  if(!O.length){box.innerHTML='<div style="font-size:12px;color:var(--muted)">Sin posiciones abiertas.</div>';return;}
  let h='<div style="font-size:11.5px;color:var(--muted);margin-bottom:.55rem">'+
    'El resultado de una posición son tres cifras: <strong>títulos × lo que te costó</strong> contra <strong>lo que vale hoy</strong>. '+
    'Si tu bróker te da otro número, una de las tres no coincide. Escribe el resultado que ves en DEGIRO y te digo cuál.</div>';
  // La fecha de las valoraciones, a la vista: si no es la de hoy, lo que ves
  // aquí no es lo que ves en el bróker y no hay ningún misterio que resolver.
  (function(){
    const F=O.map(o=>o.valDate).filter(Boolean).sort();
    if(!F.length)return;
    const ult=F[F.length-1], viejas=O.filter(o=>o.valDate&&o.valDate<ult).length;
    h+='<div style="font-size:11px;margin-bottom:.55rem;color:'+(ult<todayISO()?'var(--amber)':'var(--teal)')+'">'+
      'Valorado con los precios del <strong>'+fmtDate(ult)+'</strong>'+
      (ult<todayISO()?' (no es de hoy: vuelve a importar el Portfolio de DEGIRO para refrescarlo)':'')+
      (viejas?' · '+viejas+' posición(es) con una valoración anterior a esa fecha':'')+'.</div>';
  })();
  h+='<div class="tbl-scroll"><table class="detail-table" style="font-size:11.5px">'+
    '<thead><tr><th style="text-align:left">Acción</th><th>Títulos</th><th>Coste</th><th class="cp-x">Precio medio</th>'+
    '<th>Valor hoy</th><th>Resultado</th><th>Tu cifra</th><th style="text-align:left">Qué no cuadra</th></tr></thead><tbody>';
  O.forEach(o=>{
    const pm=o.shares>0?o.invested/o.shares:0;
    const mio=_cpMio[o.id];
    let diag='<span style="color:var(--faint)">—</span>';
    if(mio!=null&&isFinite(mio)){
      const d=mio-o.pnl;
      if(Math.abs(d)<1) diag='<span style="color:var(--teal)">cuadra ✓</span>';
      else{
        const costeNec=o.value-mio, valorNec=o.invested+mio;
        const titNec=(pm>0)?((o.value-mio)/pm):null;
        diag='<span style="color:var(--amber);font-weight:600">'+(d>0?'+':'')+fmt2(d)+'€ de diferencia</span>'+
          '<div style="font-size:9.5px;color:var(--faint);line-height:1.35">para que salga tu cifra tendría que ser:<br>'+
          '· coste '+fmt2(costeNec)+'€ (tengo '+fmt2(o.invested)+'€)<br>'+
          '· o valor '+fmt2(valorNec)+'€ (tengo '+fmt2(o.value)+'€)'+
          (titNec&&titNec>0?'<br>· o '+fmt(Math.round(titNec))+' títulos (tengo '+fmt(o.shares)+')':'')+'</div>';
      }
    }
    h+='<tr><td style="text-align:left">'+escapeHtml(o.name)+
      '<div style="font-size:9px;color:var(--faint)">'+(o.buys?o.buys.length:0)+' compra(s)'+
        (o.sells&&o.sells.length?' · '+o.sells.length+' venta(s)':'')+'</div></td>'+
      '<td>'+fmt(o.shares)+'</td>'+
      '<td>'+fmt2(o.invested)+'€</td>'+
      '<td class="cp-x">'+fmt2(pm)+'€</td>'+
      '<td>'+fmt2(o.value)+'€<div style="font-size:9px;color:var(--faint)">'+
        (o.partes&&o.partes.length>1
          ? o.partes.map(x=>escapeHtml(x.name)+' '+fmt2(x.amount)+'€').join(' + ')
          : (o.valDate?fmtDate(o.valDate)+' · '+escapeHtml(String(o.valSrc)):'sin fecha'))+'</div></td>'+
      '<td style="font-weight:700" class="'+(o.pnl>=0?'pos':'neg')+'">'+(o.pnl>=0?'+':'')+fmt2(o.pnl)+'€</td>'+
      '<td><input type="text" inputmode="decimal" data-id="'+o.id+'" oninput="cuadrePosMio(this)" '+
        'value="'+(_cpMio[o.id]!=null?String(_cpMio[o.id]).replace('.',','):'')+'" placeholder="—" '+
        'style="width:78px;font-size:11px;padding:1px 4px;text-align:right"></td>'+
      '<td style="text-align:left">'+diag+'</td></tr>';
  });
  h+='</tbody></table></div>';
  h+='<details style="margin-top:.55rem"><summary style="font-size:11.5px;font-weight:600;cursor:pointer">Dónde suelen estar las diferencias con DEGIRO</summary>'+
    '<div style="font-size:11px;color:var(--muted);margin-top:.4rem;line-height:1.6">'+
    '<strong>El coste.</strong> Aquí es la suma de tus compras más las comisiones que tengas anotadas. Si alguna compra no está '+
    'registrada, o le faltan los gastos de la orden, el coste sale corto y la pérdida parece menor de lo que es. Compara el número '+
    'de compras de cada fila con las que veas en tu histórico de DEGIRO.'+
    '<br><br><strong>El valor.</strong> Es la última valoración que tengas guardada, con su fecha y su origen a la vista. Si es de '+
    'hace días, no es lo que ves ahora en el bróker. Vuelve a importar el Portfolio para refrescarlo.'+
    '<br><br><strong>Los títulos.</strong> Salen de sumar tus compras y restar tus ventas. Si no coinciden con DEGIRO, falta o '+
    'sobra una operación, y entonces no cuadra nada de lo demás.'+
    '<br><br><strong>Y una que no depende de ti:</strong> DEGIRO incluye en el resultado de la posición los dividendos cobrados y '+
    'el efecto de la divisa si la acción no cotiza en euros. Esta app no: aquí el resultado es sólo precio contra precio.'+
    '</div></details>';
  box.innerHTML=h;
  markScrollables(box);
}

// v148 · Dos lecturas del mismo gráfico. En euros ves dónde has ganado dinero
// de verdad; en porcentaje ves lo bien o mal que ha ido cada operación con
// independencia de cuánto metiste. Son preguntas distintas y las dos importan:
// 2.000€ ganados sobre 40.000 es un 5%, y 800€ sobre 1.000 es un 80%. La barra
// más larga en euros suele ser la peor operación en porcentaje.
let _anChartMode=(function(){try{return ALM.getItem('dlv_anchart_mode')||'eur';}catch(e){return 'eur';}})();
let _anLastOps=null;
function setAnChartMode(m){
  _anChartMode=m;
  try{ALM.setItem('dlv_anchart_mode',m);}catch(e){fallo('ALM.setItem',e)}
  document.querySelectorAll('.an-chart-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===m));
  if(_anLastOps){renderAnalisisChart(_anLastOps.closed,_anLastOps.open);
    try{renderRecorridoChart(_anLastOps.closed,_anLastOps.open);}catch(e){console.warn('recorrido',e);}}
}
// ════════════════════════════════════════════════════════════════════
// v149 · HASTA DÓNDE LLEGÓ CADA OPERACIÓN
// ════════════════════════════════════════════════════════════════════
// El resultado final de una operación esconde por dónde ha pasado. Una que
// acaba en +2% pero llegó a estar en −35% no es la misma operación que una que
// nunca bajó del 0, aunque en el gráfico de resultado se vean iguales. Esto
// reconstruye, con las valoraciones que tienes guardadas, cuánto llegó a ganar
// y cuánto llegó a perder cada posición mientras la tuviste.
//
// La reconstrucción solo ve lo que hay: si solo tienes valoraciones desde que
// empezaste a importar carteras, el recorrido anterior no existe y la barra
// sale corta. Por eso cada barra dice de cuántas valoraciones sale.
// v151 · Las operaciones cerradas no salían aquí. Casi todas las tuyas se
// vendieron antes de que empezaras a importar carteras, así que no tienen ni
// una valoración intermedia guardada y el recorrido salía vacío. Pero dos
// puntos sí se conocen siempre sin mirar ninguna valoración: el día que
// compraste estabas en 0% y el día que vendiste acabaste donde acabaste. Con
// eso la barra ya existe, y se dice claramente que de esa operación no hay
// recorrido intermedio registrado: es lo que se sabe, ni más ni menos.
function recorridoOperacion(o){
  const id=o.id||((cfg.stocks.find(s=>s.name===o.name)||{}).id);
  if(!id)return null;
  const desde=o.entry||'', hasta=o.exit||todayISO();
  const fechas=[...new Set(getBalanceEntries('stock',id)
    .map(x=>x.date).filter(d=>d&&d>=desde&&d<=hasta))].sort();
  const finPct=(o.invested>0)?((o.pnl||0)/o.invested*100):null;
  if(!fechas.length){
    if(finPct==null)return null;
    return {maxPct:Math.max(0,finPct),minPct:Math.min(0,finPct),
            maxEur:Math.max(0,o.pnl||0),minEur:Math.min(0,o.pnl||0),
            n:0,desde:o.entry,hasta:o.exit||todayISO(),soloExtremos:true};
  }
  const tx=transactions.filter(t=>t.stockId===id&&(t.type==='buy'||t.type==='sell'));
  let maxP=null,minP=null,maxE=null,minE=null;
  fechas.forEach(d=>{
    // lo invertido vivo a esa fecha: compras menos el coste de lo ya vendido
    let inv=0;
    tx.forEach(t=>{ if((t.date||'')>d)return;
      if(t.type==='buy')inv+=(t.total||0)+(t.costs||0);
      else inv-=(t.costBasis||0); });
    if(inv<=0)return;
    const v=stockValor(id,d);
    if(v==null)return;
    const eur=v-inv, pct=eur/inv*100;
    if(maxP==null||pct>maxP){maxP=pct;maxE=eur;}
    if(minP==null||pct<minP){minP=pct;minE=eur;}
  });
  // el punto de partida (0%) y el de llegada siempre cuentan
  if(finPct!=null){
    if(maxP==null||finPct>maxP){maxP=finPct;maxE=o.pnl||0;}
    if(minP==null||finPct<minP){minP=finPct;minE=o.pnl||0;}
  }
  if(maxP==null)return null;
  if(maxP<0){maxP=0;maxE=0;}     // el día de la compra estabas en cero
  if(minP>0){minP=0;minE=0;}
  return {maxPct:maxP,minPct:minP,maxEur:maxE,minEur:minE,n:fechas.length,
          desde:fechas[0],hasta:fechas[fechas.length-1]};
}
// ════════════════════════════════════════════════════════════════════
// v151 · CADA COMPRA POR SEPARADO
// ════════════════════════════════════════════════════════════════════
// Una acción con varias compras no es una operación: son varias. Evonik es el
// ejemplo — una compra que cerró perdiendo y otra que cerró ganando, y el
// conjunto aparentando un empate que no cuenta nada de lo que pasó. Aquí cada
// compra es una fila con su resultado, y las ventas se reparten por FIFO, que
// además es el orden que exige Hacienda.
//
// Y la pregunta que hay detrás de promediar a la baja tiene respuesta exacta
// sin necesidad de valoraciones guardadas: el precio al que compraste ESE día
// es el precio de mercado de ese día. Comparado con el coste medio de lo que ya
// tenías, sale cuánto perdía la posición justo cuando decidiste ampliarla.
function lotesFIFO(stockId){
  const txs=transactions.filter(t=>t.stockId===stockId&&(t.type==='buy'||t.type==='sell'))
    .slice().sort((a,b)=>{
      const d=(a.date||'').localeCompare(b.date||'');
      if(d!==0)return d;
      if(a.type!==b.type)return a.type==='buy'?-1:1;
      return 0;
    });
  const lotes=[], vivos=[];
  txs.forEach(t=>{
    if(t.type==='buy'){
      const sh=t.shares||0; if(sh<=0)return;
      const cps=((t.total||0)+(t.costs||0))/sh;
      // cómo estaba la posición JUSTO ANTES de esta compra
      const shAntes=vivos.reduce((s,l)=>s+l.shares,0);
      const cAntes=vivos.reduce((s,l)=>s+l.shares*l.cps,0);
      const medioAntes=shAntes>0?cAntes/shAntes:null;
      const L={date:t.date,shares:sh,shOrig:sh,cps,coste:sh*cps,vendidas:[],
               shAntes,costeAntes:cAntes,medioAntes,
               // el precio de esta compra contra tu coste medio de entonces
               difMedio:medioAntes?((t.price||cps)/medioAntes-1)*100:null,
               n:lotes.length+1};
      lotes.push(L); vivos.push(L);
    } else {
      let q=t.shares||0;
      const pps=q>0?(((t.total||0)-(t.costs||0))/q):0;   // neto por título
      while(q>1e-9&&vivos.length){
        const l=vivos[0], take=Math.min(q,l.shares);
        l.vendidas.push({date:t.date,shares:take,pps,
                         resultado:take*(pps-l.cps),motivo:t.exitReason||''});
        l.shares-=take; q-=take;
        if(l.shares<=1e-9)vivos.shift();
      }
    }
  });
  const agg=getStockAggregates()[stockId];
  const vivasTotal=agg?agg.totalShares:0;
  const precioHoy=(vivasTotal>1e-9&&agg&&agg.currentVal)?agg.currentVal/vivasTotal:null;
  lotes.forEach(L=>{
    L.realizado=L.vendidas.reduce((s,v)=>s+v.resultado,0);
    L.vendidasSh=L.vendidas.reduce((s,v)=>s+v.shares,0);
    L.abiertas=L.shares;
    L.latente=(L.abiertas>1e-9&&precioHoy!=null)?L.abiertas*(precioHoy-L.cps):0;
    L.total=L.realizado+L.latente;
    L.pct=L.coste>0?(L.total/L.coste*100):null;
    L.estado=L.abiertas<=1e-9?'cerrada':(L.vendidasSh>1e-9?'parcial':'abierta');
    L.salida=L.vendidas.length?L.vendidas[L.vendidas.length-1].date:null;
  });
  return lotes;
}
// v152 · El recorrido por COMPRA. Hasta ahora el máximo y el mínimo eran de la
// posición entera, que con varias compras no dice nada: la de julio pudo estar
// un 20% abajo mientras la de noviembre nunca vio el rojo, y las dos salían con
// el mismo recorrido. La valoración guardada es del total de la posición, así
// que se convierte a precio por título —valor entre títulos vivos ese día— y
// ese precio se compara con el coste de CADA lote. El mismo dato, leído por
// compra en vez de en bloque.
function recorridoLotes(stockId){
  const L=lotesFIFO(stockId);
  if(!L.length)return L;
  const hoy=todayISO();
  const tx=transactions.filter(t=>t.stockId===stockId&&(t.type==='buy'||t.type==='sell'));
  const vivasEn=d=>tx.reduce((s,t)=>(t.date||'')<=d
    ? s+(t.type==='buy'?(t.shares||0):-(t.shares||0)) : s,0);
  const serie=[...new Set(getBalanceEntries('stock',stockId).map(x=>x.date).filter(Boolean))]
    .sort().map(d=>{
      const tit=vivasEn(d), val=stockValor(stockId,d);
      return (tit>1e-9&&val!=null)?{date:d,precio:val/tit}:null;
    }).filter(Boolean);
  L.forEach(x=>{
    const fin=x.vendidas.length&&x.abiertas<=1e-9
      ? x.vendidas[x.vendidas.length-1].date : hoy;
    // títulos del lote vivos en cada fecha, para poder dar el euro exacto
    const vivasLote=d=>x.shOrig-x.vendidas.reduce((s,v)=>s+((v.date||'')<=d?v.shares:0),0);
    let maxP=0,minP=0,maxE=0,minE=0,nv=0;     // el día de la compra estabas en cero
    serie.forEach(p=>{
      if(p.date<x.date||p.date>fin)return;
      const sh=vivasLote(p.date); if(sh<=1e-9)return;
      const pct=(p.precio/x.cps-1)*100, eur=sh*(p.precio-x.cps);
      nv++;
      if(pct>maxP){maxP=pct;maxE=eur;}
      if(pct<minP){minP=pct;minE=eur;}
    });
    // y el resultado final también es un punto del recorrido
    if(x.pct!=null){
      if(x.pct>maxP){maxP=x.pct;maxE=x.total;}
      if(x.pct<minP){minP=x.pct;minE=x.total;}
    }
    x.r={maxPct:maxP,minPct:minP,maxEur:maxE,minEur:minE,n:nv,soloExtremos:nv===0};
  });
  return L;
}
function renderAnalisisCompras(){
  const box=document.getElementById('an-compras');
  if(!box)return;
  const conVarias=cfg.stocks.filter(s=>{
    const b=transactions.filter(t=>t.stockId===s.id&&t.type==='buy').length;
    const v=transactions.filter(t=>t.stockId===s.id&&t.type==='sell').length;
    return b>1||(b>=1&&v>0);
  });
  if(!conVarias.length){
    box.innerHTML='<p style="font-size:11.5px;color:var(--muted)">Aquí aparecerán las acciones en las que hayas comprado más de una vez o hayas vendido algo. '+
      'Con una sola compra sin ventas, la ficha de la posición ya lo dice todo.</p>';
    return;
  }
  const eur=v=>(v>=0?'+':'')+fmt2(v)+'€';
  const pc=v=>(v>=0?'+':'')+v.toFixed(1)+'%';
  let h='';
  conVarias.forEach(s=>{
    const L=recorridoLotes(s.id); if(!L.length)return;
    const tot=L.reduce((a,x)=>a+x.total,0), coste=L.reduce((a,x)=>a+x.coste,0);
    const gan=L.filter(x=>x.total>0).length, per=L.filter(x=>x.total<0).length;
    const bajadas=L.filter(x=>x.difMedio!=null&&x.difMedio<0);
    h+='<div style="margin-bottom:.9rem;border:1px solid var(--border);border-radius:7px;padding:.55rem .6rem">'+
      '<div style="display:flex;justify-content:space-between;gap:.5rem;align-items:baseline;flex-wrap:wrap">'+
        '<strong style="font-size:12.5px">'+escapeHtml(s.name)+'</strong>'+
        '<span style="font-size:12px" class="'+(tot>=0?'pos':'neg')+'">'+eur(tot)+' · '+(coste>0?pc(tot/coste*100):'—')+'</span></div>'+
      '<div style="font-size:10.5px;color:var(--muted);margin-bottom:.35rem">'+L.length+' compra(s) · '+
        gan+' en verde · '+per+' en rojo'+
        (bajadas.length?(' · promediaste a la baja '+bajadas.length+' vez(ces)'):'')+
        (gan&&per?' <span style="color:var(--amber)">— el conjunto esconde que unas ganan y otras pierden</span>':'')+
      '</div>'+
      '<div class="tbl-scroll" style="overflow-x:auto"><table class="detail-table" style="font-size:11px;min-width:560px">'+
      '<thead><tr><th style="text-align:left">Compra</th><th>Títulos</th><th>Precio</th>'+
      '<th>Al comprar</th><th>Estado</th><th>Recorrido</th><th>Resultado</th></tr></thead><tbody>';
    L.forEach(x=>{
      const alComprar=x.difMedio==null
        ? '<span style="color:var(--faint)">primera</span>'
        : '<span class="'+(x.difMedio<0?'neg':'pos')+'">'+pc(x.difMedio)+'</span>'+
          '<div style="font-size:9px;color:var(--faint)">'+(x.difMedio<0?'por debajo':'por encima')+' de tu coste medio<br>'+
          fmt(x.shAntes)+' tít. a '+fmt2(x.medioAntes)+'€</div>';
      const estado=x.estado==='cerrada'
        ? 'vendida<div style="font-size:9px;color:var(--faint)">'+(x.salida?fmtDate(x.salida):'')+'</div>'
        : (x.estado==='parcial'
            ? 'parcial<div style="font-size:9px;color:var(--faint)">quedan '+fmt(x.abiertas)+'</div>'
            : 'abierta');
      const rec=!x.r?'—':(x.r.soloExtremos
        ? '<span style="color:var(--faint)" title="no hay valoraciones guardadas mientras estuvo viva">sin datos</span>'
        : '<span class="pos">'+pc(x.r.maxPct)+'</span> / <span class="neg">'+pc(x.r.minPct)+'</span>'+
          '<div style="font-size:9px;color:var(--faint)">'+
          (x.r.minPct>=-0.05?'nunca estuvo en rojo':'llegó a perder '+fmt2(Math.abs(x.r.minEur))+'€')+
          ' · '+x.r.n+' val.</div>');
      h+='<tr><td style="text-align:left">'+fmtDate(x.date)+
        '<div style="font-size:9px;color:var(--faint)">'+fmt2(x.coste)+'€</div></td>'+
        '<td>'+fmt(x.shOrig)+'</td><td>'+fmt2(x.cps)+'€</td>'+
        '<td>'+alComprar+'</td><td>'+estado+'</td><td>'+rec+'</td>'+
        '<td style="font-weight:700" class="'+(x.total>=0?'pos':'neg')+'">'+eur(x.total)+
        (x.pct!=null?'<div style="font-size:9px;font-weight:400">'+pc(x.pct)+'</div>':'')+
        (x.realizado&&x.latente?'<div style="font-size:9px;color:var(--faint);font-weight:400">'+eur(x.realizado)+' cerrado · '+eur(x.latente)+' vivo</div>':'')+
        '</td></tr>';
    });
    h+='</tbody></table></div></div>';
  });
  h+='<p style="font-size:10.5px;color:var(--muted)">"Recorrido" es lo máximo y lo mínimo que llegó a estar <em>esa compra</em>, '+
     'no la posición entera: la valoración guardada se convierte a precio por título y se compara con el coste de cada lote. '+
     'Las ventas se reparten por FIFO: la primera venta cierra la primera compra, '+
     'que es el orden que usa Hacienda. "Al comprar" compara el precio que pagaste ese día con el coste medio de lo que ya tenías: '+
     'es lo que perdía tu posición justo cuando decidiste ampliarla.</p>';
  box.innerHTML=h;
  markScrollables(box);
}
let _anRecChart=null;
let _anRecModo=(function(){try{return ALM.getItem('dlv_anrec_modo')||'accion';}catch(e){return 'accion';}})();
function setRecModo(m){
  _anRecModo=m;
  try{ALM.setItem('dlv_anrec_modo',m);}catch(e){fallo('ALM.setItem',e)}
  document.querySelectorAll('.an-rec-btn').forEach(b=>b.classList.toggle('active',b.dataset.rec===m));
  if(_anLastOps)renderRecorridoChart(_anLastOps.closed,_anLastOps.open);
}
// Cada compra como una barra: mismo gráfico, lupa más fina.
function opsPorCompra(){
  const out=[];
  (cfg.stocks||[]).forEach(s=>{
    let L; try{L=recorridoLotes(s.id);}catch(e){return;}
    (L||[]).forEach(x=>{
      if(!(x.coste>0))return;
      out.push({o:{id:s.id,name:s.name+' #'+x.n+' '+fmtDate(x.date),
                   invested:x.coste,pnl:x.total},
                cerrada:x.estado==='cerrada',sinSufijo:true,r:x.r});
    });
  });
  return out;
}
function renderRecorridoChart(closed,open){
  const cv=document.getElementById('an-rec-chart');
  if(!cv||typeof Chart==='undefined')return;
  document.querySelectorAll('.an-rec-btn').forEach(b=>b.classList.toggle('active',b.dataset.rec===_anRecModo));
  const pct=_anChartMode==='pct';
  const ops=(_anRecModo==='compra')
    ? opsPorCompra().filter(x=>x.r)
    : [...closed.map(o=>({o,cerrada:true})),...open.map(o=>({o,cerrada:false}))]
        .map(x=>({...x,r:recorridoOperacion(x.o)}))
        .filter(x=>x.r&&x.o.invested>0);
  const box=document.getElementById('an-rec-note');
  if(!ops.length){
    if(_anRecChart){_anRecChart.destroy();_anRecChart=null;}
    if(box)box.innerHTML='Todavía no hay nada que dibujar aquí. '+
      'Cada vez que importes una cartera se guarda una valoración con su fecha, y a partir de la segunda esto empieza a tener recorrido que enseñar.';
    return;
  }
  const val=(x,cual)=>pct?x.r[cual+'Pct']:x.r[cual+'Eur'];
  const fin=x=>pct?((x.o.pnl||0)/x.o.invested*100):(x.o.pnl||0);
  ops.sort((a,b)=>fin(a)-fin(b));
  const labels=ops.map(x=>x.o.name+((x.cerrada||x.sinSufijo)?'':' (abierta)'));
  // el recorrido real, de su peor momento a su mejor momento. Si una posición
  // nunca estuvo en verde, la barra no toca el cero y eso también se ve.
  const rango=ops.map(x=>{
    let a=val(x,'min'), b=val(x,'max');
    if(Math.abs(b-a)<1e-9){a=Math.min(a,0);b=Math.max(b,0);}   // una sola valoración: que se vea algo
    return [a,b];
  });
  const colores=ops.map(x=>x.cerrada?'rgba(90,106,128,.22)':'rgba(90,106,128,.13)');
  const puntos=ops.map((x,i)=>({x:fin(x),y:i}));
  const colFin=ops.map(x=>fin(x)>=0?'#1A7A3A':'#B03020');
  if(_anRecChart)_anRecChart.destroy();
  const dark=document.body.classList.contains('dark');
  const wrap=cv.parentElement;
  if(wrap)wrap.style.height=Math.max(280,labels.length*26+70)+'px';
  _anRecChart=new Chart(cv,{
    data:{labels,datasets:[
      {type:'bar',data:rango,backgroundColor:colores,borderWidth:0,order:2},
      {type:'scatter',data:puntos,backgroundColor:colFin,borderColor:colFin,
       pointRadius:5,pointStyle:'rectRot',order:1}
    ]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{
        title:i=>labels[i[0].dataIndex],
        label:c=>{
          const x=ops[c.dataIndex]; if(!x)return '';
          const e=n=>(n>=0?'+':'')+fmt2(n)+'€';
          const q=n=>(n>=0?'+':'')+n.toFixed(1)+'%';
          // si nunca estuvo en verde, decir "llegó a ganar −0,1%" sería absurdo
          const alto=x.r.maxPct>=0?('llegó a ganar '+q(x.r.maxPct)):('lo mejor que estuvo: '+q(x.r.maxPct));
          const bajo=x.r.minPct<=0?('llegó a perder '+q(x.r.minPct)):('lo peor que estuvo: '+q(x.r.minPct));
          if(x.r.soloExtremos)return [(x.cerrada?'cerró en ':'ahora en ')+q((x.o.pnl||0)/x.o.invested*100)+' ('+e(x.o.pnl||0)+')',
                  'sin valoraciones guardadas de ese periodo:',
                  'solo se conoce el principio y el final'];
          return [alto+' ('+e(x.r.maxEur)+')',
                  bajo+' ('+e(x.r.minEur)+')',
                  (x.cerrada?'cerró en ':'ahora en ')+q((x.o.pnl||0)/x.o.invested*100)+' ('+e(x.o.pnl||0)+')',
                  'sobre '+x.r.n+' valoración(es) desde '+fmtDate(x.r.desde)];
        }}}},
      scales:{
        x:{grid:{color:dark?'rgba(255,255,255,.08)':'rgba(0,0,0,.05)'},
           ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:10},
                  callback:v=>pct?(v.toFixed(0)+'%'):(fmt(v)+'€')}},
        y:{type:'category',grid:{display:false},
           ticks:{color:dark?'#A0AEC0':'#5A6A80',font:{size:10.5},autoSkip:false,maxRotation:0,
                  callback:function(v){const t=this.getLabelForValue(v);return t&&t.length>30?t.slice(0,29)+'…':t;}}}
      }
    }
  });
  if(box){
    const pocas=ops.filter(x=>x.r.n<3&&!x.r.soloExtremos).length;
    const sinRec=ops.filter(x=>x.r.soloExtremos).length;
    box.innerHTML='La barra clara es el recorrido: desde lo máximo que llegó a perder hasta lo máximo que llegó a ganar. '+
      'El rombo es dónde acabó (o dónde está, si sigue abierta). Sale de las valoraciones guardadas, '+
      'así que solo ve lo que hubieras importado ese día.'+
      (_anRecModo==='compra'?' <strong>Por compra:</strong> cada barra es una compra suelta, con las ventas repartidas por FIFO.':'')+
      (pocas?' <span style="color:var(--amber)">'+pocas+' operación(es) con menos de 3 valoraciones: su recorrido es casi una suposición.</span>':'')+
      (sinRec?' <span style="color:var(--amber)">'+sinRec+' operación(es) cerradas antes de que empezaras a importar carteras: de esas solo se conoce el principio y el final, no el camino.</span>':'');
  }
}
function renderAnalisisChart(closed,open){
  const cv=document.getElementById('an-chart');
  if(!cv||typeof Chart==='undefined')return;
  _anLastOps={closed,open};
  document.querySelectorAll('.an-chart-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===_anChartMode));
  const pct=_anChartMode==='pct';
  // En porcentaje, una operación sin coste registrado no se puede dividir: se
  // queda fuera del gráfico en vez de pintarse como un cero que no significa
  // nada, y se dice cuántas son debajo.
  const usable=o=>!pct||(o.invested>0&&o.pnl!=null);
  const valor=o=>pct?((o.pnl||0)/o.invested*100):(o.pnl||0);
  const cc=closed.filter(usable).slice().sort((a,b)=>valor(a)-valor(b));
  const oo=open.filter(usable).slice().sort((a,b)=>valor(a)-valor(b));
  const fuera=(closed.length-cc.length)+(open.length-oo.length);
  const nota=document.getElementById('an-chart-note');
  if(nota)nota.innerHTML=(pct
      ? 'Rentabilidad sobre el coste de cada operación. Ojo: un +80% sobre 1.000€ son 800€, y un +5% sobre 40.000€ son 2.000€. Para saber dónde has ganado dinero, mira los euros.'
      : 'Beneficio en euros de cada operación. Para saber lo bien que ha ido cada una, mira el porcentaje.')+
    (fuera?' <span style="color:var(--amber)">'+fuera+' operación(es) sin coste registrado quedan fuera de esta vista.</span>':'');
  const labels=[...cc.map(o=>o.name), ...oo.map(o=>o.name+' (abierta)')];
  const data=[...cc.map(valor), ...oo.map(valor)];
  const eur=[...cc.map(o=>o.pnl||0), ...oo.map(o=>o.pnl||0)];
  const inv=[...cc.map(o=>o.invested||0), ...oo.map(o=>o.invested||0)];
  const colors=data.map((v,i)=> i<cc.length
    ? (v>=0?'#1A7A3A':'#B03020')
    : (v>=0?'rgba(26,122,58,.4)':'rgba(176,48,32,.4)'));
  if(_anChart)_anChart.destroy();
  const dark=document.body.classList.contains('dark');
  // v119 · Aquí estaba el lío de los nombres. Con 22 operaciones y una altura
  // fija, Chart.js se saltaba una etiqueta de cada dos (autoSkip por defecto) y
  // pintaba 22 barras con 11 nombres: cada nombre acababa al lado de la barra
  // equivocada. Ahora se fuerza a pintarlas TODAS y la altura crece con el
  // número de operaciones.
  const wrap=cv.parentElement;
  if(wrap)wrap.style.height=Math.max(280,labels.length*26+70)+'px';
  _anChart=new Chart(cv,{
    type:'bar',
    data:{labels,datasets:[{data,backgroundColor:colors,borderWidth:0}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{
        title:i=>i[0].label,
        // el tooltip enseña SIEMPRE las dos caras, estés en el modo que estés
        label:c=>{
          const i=c.dataIndex, e=eur[i], v=inv[i];
          const pe=(e>=0?'+':'')+fmt2(e)+'€';
          const pp=v>0?((e/v*100>=0?'+':'')+(e/v*100).toFixed(1)+'%'):'—';
          return pe+'  ·  '+pp+(v>0?'  (coste '+fmt(v)+'€)':'');
        }}}},
      scales:{
        x:{grid:{color:dark?'rgba(255,255,255,.08)':'rgba(0,0,0,.05)'},ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:10},
           callback:v=>pct?(v.toFixed(0)+'%'):(fmt(v)+'€')}},
        y:{grid:{display:false},ticks:{color:dark?'#A0AEC0':'#5A6A80',font:{size:10.5},
           autoSkip:false,maxRotation:0,
           callback:function(v){const t=this.getLabelForValue(v);return t.length>30?t.slice(0,29)+'…':t;}}}
      }
    }
  });
}



// ════════════════════════════════════════════════════════════════════
// v114 · COMPARATIVA DE PUESTOS RECONSTRUIDA DESDE LA NÓMINA
// ════════════════════════════════════════════════════════════════════
// La tabla anterior traía ocho cifras sueltas de origen desconocido y las
// llamaba "salario neto". No lo eran: son BRUTOS anuales de una tabla de 2025.
// Peor: comparar brutos no te sirve, porque tu discapacidad y tu IPT cambian
// tu IRPF respecto al de un compañero con la misma nómina.
//
// Ahora todo se calcula desde los componentes oficiales, y tu puesto cuadra al
// céntimo con tu nómina de julio de 2026:
//   sueldo base + trienios + destino + específico
//   + productividad = devengos. Exacto.
//
// Retribuciones 2026 — RD-ley 14/2025, tablas de la Secretaría de Estado de
// Presupuestos. Importes MENSUALES en euros.
const RET_SB={A1:1387.24,A2:1199.52,B:1048.55,C1:900.63,C2:749.58,E:686.71};
const RET_TRI={A1:53.39,A2:43.54,B:38.20,C1:32.96,C2:22.44,E:16.86};
const RET_CD={1:114.81,2:135.84,3:156.91,4:177.92,5:198.97,6:213.02,7:227.07,8:241.09,9:255.17,
  10:269.20,11:297.24,12:325.35,13:353.44,14:381.57,15:409.59,16:437.73,17:465.75,18:493.86,
  19:521.94,20:550.01,21:592.11,22:637.73,23:683.48,24:729.14,25:774.86,26:873.38,27:995.47,
  28:1041.22,29:1086.89,30:1211.77};
const RET_GRUPOS=['A1','A2','B','C1','C2','E'];

function puestosCfg(){
  const c=cfg.puestosCfg=cfg.puestosCfg||{};
  // v169 · Sin cifras tuyas por defecto: están en tus datos.
  // Trienios: lo que cobras al mes por todos ellos (cada uno conserva el valor
  // del grupo en que se ganó).
  if(c.trienios==null)c.trienios=0;
  if(c.prodMes==null)c.prodMes=0;
  if(c.prodExtraAnio==null)c.prodExtraAnio=0;   // la variable de diciembre
  // Qué parte del específico entra en cada paga extra: (paga extra − sueldo −
  // trienios − destino) / específico, con los importes de la nómina de junio.
  if(c.factorCE==null)c.factorCE=0.6774;
  if(c.conIpt==null)c.conIpt=Number((cfg.pension||{}).iptMes)>0;
  if(c.conDisc==null)c.conDisc=Number((cfg.pension||{}).discapacidad)>0;
  if(c.verNeto==null)c.verNeto=true;
  if(!c.lista||!c.lista.length){
    c.lista=[
      {id:'p1',nombre:'Tu puesto',grupo:(cfg.pension&&cfg.pension.grupo)||'C1',nivel:18,ce:0,propio:true,real:true}
    ];
  }
  return c;
}
function setPuestoCfg(k,v){
  const c=puestosCfg();
  const bool=['conIpt','conDisc','verNeto'];
  const num=['trienios','prodMes','prodExtraAnio','factorCE'];
  c[k]=bool.includes(k)?!!v:(num.includes(k)?(parseFloat(String(v).replace(',','.'))||0):v);
  save(); renderPuestos();
}
function setPuestoCampo(id,k,v){
  const c=puestosCfg(), p=c.lista.find(x=>x.id===id); if(!p)return;
  if(k==='nivel')p.nivel=Math.max(1,Math.min(30,parseInt(v,10)||p.nivel));
  else if(k==='ce'){p.ce=parseFloat(String(v).replace(',','.'))||0; p.real=false;}
  else if(k==='grupo')p.grupo=v;
  else p[k]=v;
  save(); renderPuestos();
}
function setPuestoActual(id){
  const c=puestosCfg();
  if(!c.lista.some(p=>p.id===id))return;
  c.lista.forEach(p=>{p.propio=(p.id===id);});
  delete cfg.puestoActual;          // el dato de la v103, que ya no se usa
  save(); renderPuestos();
}

// ─── Bruto anual de un puesto ───────────────────────────────────────
// 12 mensualidades completas + 2 pagas extra (sueldo, trienios, destino y la
// parte del específico que corresponda) + la productividad.
function puestoBruto(p){
  const c=puestosCfg();
  const sb=RET_SB[p.grupo]||0, cd=RET_CD[p.nivel]||0, ce=Number(p.ce)||0, tri=Number(c.trienios)||0;
  const mes=sb+tri+cd+ce;
  const extra=sb+tri+cd+ce*(Number(c.factorCE)||0);
  const prodAnio=(Number(c.prodMes)||0)*12+(Number(c.prodExtraAnio)||0);
  return {sb,tri,cd,ce,mes,extra,prodAnio,
    anual:mes*12+extra*2+prodAnio,
    mesMedio:(mes*12+extra*2+prodAnio)/12};
}
// Cotización del funcionario: derechos pasivos 3,86% + MUFACE 1,69% sobre el
// haber regulador de cotización de su subgrupo, en 14 pagas. No depende del
// sueldo real: por eso subir de nivel no te cuesta más cotización.
function puestoCotiza(grupo){
  const base=CP_COTIZ[grupo]||0;
  return {dp:base*0.0386,muface:base*0.0169,total:base*0.0555,base};
}
// ─── Neto de un puesto ──────────────────────────────────────────────
// Aquí está el motivo de todo esto: tu IPT es renta gravable y empuja tu sueldo
// a tramos más altos, mientras que tu discapacidad te da 3.500€ de gastos
// deducibles (art. 19.2.f, solo para TRABAJADORES ACTIVOS) y 3.000€ más de
// mínimo exento. Comparar brutos con un compañero sin discapacidad no dice nada.
function puestoNeto(p,opt){
  opt=opt||{};
  const c=puestosCfg(), pc=pensionCfg();
  const B=puestoBruto(p);
  const C=puestoCotiza(p.grupo);
  const conIpt=(opt.conIpt!=null)?opt.conIpt:c.conIpt;
  const disc=opt.disc!=null?opt.disc:(c.conDisc?(pc.discapacidad||0):0);
  const iptAnual=conIpt?((Number(pc.iptMes)||0)*(Number(pc.iptPagas)||14)):0;
  const edad=pc.nacimientoFecha?Math.floor(jubMeses(pc.nacimientoFecha,todayISO())/12):48;
  // gastos por discapacidad de trabajador activo — art. 19.2.f LIRPF
  const gastosDisc=(disc>=65||pc.asistencia)?7750:(disc>=33?3500:0);
  const F=irpfCalc(B.anual+iptAnual,edad,
    {ccaa:pc.ccaa,discapacidad:disc,asistencia:pc.asistencia,
     cotizaciones:C.total,gastosExtra:gastosDisc});
  const brutoTotal=B.anual+iptAnual;
  const neto=brutoTotal-C.total-F.cuota;
  return {p,B,C,iptAnual,brutoTotal,irpf:F,disc,gastosDisc,
    neto,netoMes:neto/12,brutoMes:brutoTotal/12,
    tipo:brutoTotal>0?F.cuota/brutoTotal:0};
}

// ════════════════════════════════════════════════════════════════════
// v153 · EL BRUTO DEL PUESTO NO ES EL BRUTO DE TU RENTA
// ════════════════════════════════════════════════════════════════════
// La tabla de puestos calcula lo que da un puesto en régimen normal: doce
// mensualidades iguales, dos extras y la productividad. Nunca va a cuadrar con
// la renta, y no porque esté mal: es que mide otra cosa. Un año real lleva
// atrasos, regularizaciones, un cambio de grupo a mitad de año, una sentencia.
// Tu 2025 es justo eso — empezaste el año como C2 y cobraste los atrasos del
// C1 después.
//
// Como las nóminas están guardadas una a una, el bruto real de cada año se
// puede sumar de verdad, y con el IPT al lado sale exactamente la casilla de
// la renta. Eso es lo que hace esta tarjeta: no estima nada.
// v158 · Las nóminas viven en dos sitios: el histórico de «personal» y el
// desglose que cuelga de cada ingreso. El lector de PDF escribía solo en el
// segundo, así que volver a subir una nómina no cambiaba nada de lo que se
// calcula aquí. Se leen los dos y se quedan sin repetir, prefiriendo el
// desglose más detallado —que es justamente el releído con el lector nuevo.
// Entre dos lecturas de la misma nómina gana la que separa los conceptos de
// productividad, no la que tenga más líneas: es la distinción que hace falta.
function _ndScore(nd){
  const D=(nd&&nd.devengos)||[];
  const fino=D.some(d=>/productividad\s*(por\s*objetivos|remanente)/i.test(String(d.name||'')));
  return (fino?1000:0)+D.length;
}
function NOMINAS_TODAS(){
  const out=[], idx=new Map();
  const add=(ym,nd,amt)=>{
    if(!/^\d{4}-\d{2}/.test(String(ym||''))||!nd||!(nd.devengos&&nd.devengos.length))return;
    const k=ym.slice(0,7)+'|'+Math.round((Number(nd.total_dev)||0)*100);
    const prev=idx.get(k);
    if(prev){
      if(_ndScore(nd)>_ndScore(prev.nd))prev.nd=nd;
      return;
    }
    const o={ym:ym.slice(0,7),nd,amt}; idx.set(k,o); out.push(o);
  };
  NOM_HIST().forEach(x=>add(String(x.ym||x.date||''),x.nd,x.amt));
  // v162 · Un cobro del banco que en el histórico ya está partido en dos
  // (la nómina y la sentencia, con splitFrom) no es otra nómina: se sumaba
  // además de sus dos partes y junio de 2026 contaba dos veces en el bruto.
  const partidos=NOM_HIST().filter(z=>z&&z.splitFrom);
  (typeof incomeLog!=='undefined'?incomeLog:[]).forEach(e=>{
    if(e.cat!=='nomina')return;
    const ym=String(e.date||'').slice(0,7);
    if(partidos.some(z=>String(z.ym||z.date||'').slice(0,7)===ym&&Math.abs((Number(e.amt)||0)-(Number(z.splitFrom)||0))<1))return;
    add(String(e.date||''),e.nd,e.amt);
  });
  return out;
}
function brutoRealAnios(){
  const H=NOMINAS_TODAS(), por={};
  H.forEach(x=>{
    const y=String(x.ym||x.date||'').slice(0,4); if(!/^\d{4}$/.test(y))return;
    const nd=x.nd||{};
    const P=por[y]||(por[y]={anio:y,sueldo:0,ipt:0,nominas:0,ded:0,extras:0});
    P.sueldo+=Number(nd.total_dev)||0;
    P.ded+=Number(nd.total_ded)||0;
    P.nominas++;
    (nd.devengos||[]).forEach(dv=>{
      if(/atras|regulariz|sentencia/i.test(dv.name||''))P.extras+=Number(dv.amount)||0;
    });
  });
  (typeof incomeLog!=='undefined'?incomeLog:[]).forEach(x=>{
    if(x.cat!=='ipt')return;
    const y=String(x.date||'').slice(0,4); if(!por[y])return;
    por[y].ipt+=Number(x.amt)||0;
  });
  return Object.values(por).sort((a,b)=>b.anio.localeCompare(a.anio))
    .map(P=>({...P,total:P.sueldo+P.ipt}));
}
// v155 · Aquí me equivoqué y él lo vio: el remanente no es UN pago al año.
// En 2025 hubo cuatro —abril, septiembre, octubre y diciembre— y yo estaba
// cogiendo solo el último. Hay que sumar todos los pagos de productividad del
// ejercicio, sin contar el «a cuenta» mensual, que es otra cosa y ya va aparte.
const MESES_C=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
function fmtMes(ym){
  const m=String(ym||'').match(/^(\d{4})-(\d{2})/);
  return m?(MESES_C[+m[2]-1]+' '+m[1].slice(2)):String(ym||'');
}
function prodPagosPorAnio(){
  const por={};
  NOMINAS_TODAS().forEach(x=>{
    const y=String(x.ym||x.date||'').slice(0,4); if(!/^\d{4}$/.test(y))return;
    (x.nd&&x.nd.devengos||[]).forEach(d=>{
      const nom=String(d.name||'').trim();
      if(!/productividad/i.test(nom))return;
      if(/a\s*cuenta|objetivos\s*a\s*cuenta/i.test(nom))return;   // el mensual no cuenta aquí
      const P=por[y]||(por[y]={anio:y,total:0,pagos:[]});
      const imp=Number(d.amount)||0;
      P.total+=imp; P.pagos.push({ym:x.ym,importe:imp,nombre:nom});
    });
  });
  return Object.values(por).sort((a,b)=>b.anio.localeCompare(a.anio));
}
// v156 · No todos los pagos de productividad son iguales y meterlos en el mismo
// saco tapaba justo lo que interesa ver. Son tres cosas distintas:
//   · la fija mensual, que se cobra todos los meses a cuenta
//   · los pagos grandes por objetivos, dos al año, que oscilan algo
//   · el remanente, que es un reparto de lo que sobra y puede ser cero
// La nómina los llama a todos «Productividad», así que la máquina no puede
// distinguirlos sola. Propone los dos mayores del año como objetivos y el resto
// como remanente, y cada pago se puede cambiar de saco con un toque.
function prodKey(x,i){ return String(x.ym||'')+'#'+i; }
function prodTipos(){ const c=puestosCfg(); return c.prodTipos||{}; }
// v157 · Si la nómina lo dice, se cree a la nómina. Los botones quedan solo
// para los apuntes antiguos, leídos cuando el lector todavía los mezclaba.
function prodTipoPorNombre(nom){
  const s=String(nom||'').toLowerCase();
  if(/remanente/.test(s))return 'rem';
  if(/objetivos/.test(s))return 'obj';
  return null;
}
function prodClasifAnio(P){
  if(!P)return null;
  const T=prodTipos();
  const orden=P.pagos.map((x,i)=>({...x,k:prodKey(x,i),idx:i}))
    .sort((a,b)=>b.importe-a.importe);
  const grandes=new Set(orden.slice(0,2).map(x=>x.k));   // los dos mayores, si no hay nada mejor
  const pagos=P.pagos.map((x,i)=>{
    const k=prodKey(x,i);
    const deNom=prodTipoPorNombre(x.nombre);
    const tipo=T[k]||deNom||(grandes.has(k)?'obj':'rem');
    return {...x,k,tipo,origen:T[k]?'manual':(deNom?'nomina':'propuesto')};
  });
  return {anio:P.anio,pagos,
    obj:pagos.filter(x=>x.tipo==='obj').reduce((s,x)=>s+x.importe,0),
    rem:pagos.filter(x=>x.tipo==='rem').reduce((s,x)=>s+x.importe,0),
    total:P.total};
}
function setProdTipo(k,tipo){
  const T={...prodTipos()}; T[k]=tipo;
  setPuestoCfg('prodTipos',T);
  renderPuestos();
}
function toggleProdTipo(k){
  const C=prodClasifAnio(prodAnioRef()); if(!C)return;
  const p=C.pagos.find(x=>x.k===k); if(!p)return;
  setProdTipo(k,p.tipo==='obj'?'rem':'obj');
}
// El año de referencia es el último COMPLETO: el que está en curso todavía
// puede recibir más pagos y compararlo sería engañarse a la baja.
function prodAnioRef(){
  const A=prodPagosPorAnio(); if(!A.length)return null;
  const meses={};
  NOMINAS_TODAS().forEach(x=>{const y=String(x.ym||'').slice(0,4);meses[y]=(meses[y]||0)+1;});
  return A.find(x=>(meses[x.anio]||0)>=12)||A[0];
}
function aplicarProdReal(){
  const r=prodAnioRef(); if(!r)return;
  setPuestoCfg('prodExtraAnio',Math.round(r.total*100)/100);
  toast('Remanente actualizado a '+fmt2(r.total)+'€ ('+r.pagos.length+' pagos de '+r.anio+')');
  renderPuestos(); renderBrutoReal();
}
function renderBrutoReal(){
  const box=document.getElementById('bruto-real'); if(!box)return;
  const A=brutoRealAnios();
  if(!A.length){ box.innerHTML='<p style="font-size:11.5px;color:var(--muted)">Cuando subas nóminas aparecerá aquí el bruto real de cada año.</p>'; return; }
  const c=puestosCfg(), pc=pensionCfg();
  const propio=(c.lista||[]).find(x=>x.propio);
  const teor=propio?puestoBruto(propio).anual:null;
  const iptAnio=(Number(pc.iptMes)||0)*(Number(pc.iptPagas)||14);
  let h='<div class="tbl-scroll" style="overflow-x:auto"><table class="detail-table" style="font-size:11.5px;min-width:520px">'+
    '<thead><tr><th style="text-align:left">Año</th><th>Sueldo bruto</th><th>IPT</th><th>Bruto total</th><th>Nóminas</th><th>De las cuales atrasos</th></tr></thead><tbody>';
  A.forEach(P=>{
    const completo=P.nominas>=12;
    h+='<tr><td style="text-align:left"><strong>'+P.anio+'</strong>'+
      (completo?'':'<div style="font-size:9px;color:var(--amber)">año incompleto</div>')+'</td>'+
      '<td>'+fmt2(P.sueldo)+'€</td>'+
      '<td>'+(P.ipt?fmt2(P.ipt)+'€':'<span style="color:var(--faint)">—</span>')+'</td>'+
      '<td style="font-weight:700">'+fmt2(P.total)+'€</td>'+
      '<td>'+P.nominas+'</td>'+
      '<td>'+(P.extras?fmt2(P.extras)+'€':'<span style="color:var(--faint)">—</span>')+'</td></tr>';
  });
  h+='</tbody></table></div>';
  if(teor!=null){
    const ult=A.find(x=>x.nominas>=12)||A[0];
    const teorTotal=teor+iptAnio;
    const dif=ult.total-teorTotal;
    h+='<div style="margin-top:.6rem;padding:.5rem .6rem;border:1px solid var(--border);border-radius:6px;font-size:11.5px;line-height:1.5">'+
      '<strong>Por qué no cuadra con la tabla de puestos.</strong><br>'+
      'Tu puesto («'+escapeHtml(propio.nombre)+'») da <strong>'+fmt2(teor)+'€</strong> de sueldo en un año normal, '+
      'más <strong>'+fmt2(iptAnio)+'€</strong> de IPT al ritmo de hoy: <strong>'+fmt2(teorTotal)+'€</strong>.<br>'+
      'En '+ult.anio+' cobraste <strong>'+fmt2(ult.total)+'€</strong>, '+
      '<span class="'+(dif>=0?'pos':'neg')+'">'+(dif>=0?'+':'')+fmt2(dif)+'€</span> de diferencia. '+
      (ult.extras?('De esa diferencia, <strong>'+fmt2(ult.extras)+'€</strong> son atrasos y regularizaciones que solo se cobran una vez. '):'')+
      'El resto es que el IPT se revaloriza cada año y que un año real no son doce mensualidades iguales.<br>'+
      '<span style="color:var(--muted);font-size:10.5px">La tabla de puestos sirve para comparar puestos entre sí. Para cuadrar con Hacienda, la cifra es la de arriba.</span>'+
    '</div>';
  }
  const pr=prodAnioRef();
  if(pr&&Math.abs(pr.total-(Number(c.prodExtraAnio)||0))>1){
    h+='<div style="margin-top:.5rem;padding:.45rem .6rem;border:1px solid var(--amber);border-radius:6px;font-size:11px">'+
      '<strong style="color:var(--amber)">El remanente de la tabla está desfasado.</strong> '+
      'En la tabla de puestos hay '+fmt2(Number(c.prodExtraAnio)||0)+'€, pero en '+pr.anio+' cobraste <strong>'+
      fmt2(pr.total)+'€</strong> en '+pr.pagos.length+' pago(s): '+
      pr.pagos.map(x=>fmtMes(x.ym)+' '+fmt2(x.importe)+'€').join(' · ')+'. '+
      'Todos los puestos salen '+fmt2(Math.abs(pr.total-(Number(c.prodExtraAnio)||0)))+'€ '+
      (pr.total>(Number(c.prodExtraAnio)||0)?'por debajo':'por encima')+' de lo real. '+
      '<button type="button" class="btn-xs" onclick="aplicarProdReal()">Usar '+fmt2(pr.total)+'€</button></div>';
  }
  box.innerHTML=h;
  markScrollables(box);
}

// ════════════════════════════════════════════════════════════════════
// v154 · LA PARTE DEL SUELDO QUE NO ESTÁ ASEGURADA
// ════════════════════════════════════════════════════════════════════
// Todas las cifras de la tabla de arriba llevan dentro dos conceptos que no
// son derecho consolidado: la productividad por objetivos que cobras a cuenta
// cada mes y el remanente que se reparte una vez al año. La administración
// puede dejar de pagarlos de un ejercicio para otro sin que cambie tu puesto
// ni tu nivel. Conviene tener a la vista cuánto son y qué parte de la nómina
// representan, porque es exactamente lo que desaparecería.
function netoSinProd(p){
  const c=puestosCfg();
  const pm=c.prodMes, pe=c.prodExtraAnio;
  c.prodMes=0; c.prodExtraAnio=0;
  let r=null;
  try{ r=perfilYo(p); } finally { c.prodMes=pm; c.prodExtraAnio=pe; }
  return r;
}
function renderPuestosProd(){
  const box=document.getElementById('puestos-prod'); if(!box)return;
  const c=puestosCfg();
  const p=(c.lista||[]).find(x=>x.propio)||(c.lista||[])[0];
  if(!p){box.innerHTML='';return;}
  const B=puestoBruto(p);
  const objAnio=(Number(c.prodMes)||0)*12;
  const remAnio=Number(c.prodExtraAnio)||0;
  const totAnio=objAnio+remAnio;
  const pct=v=>B.anual>0?(v/B.anual*100):0;
  const pc2=v=>pct(v).toFixed(2).replace('.',',');   // coma, como el resto de la tabla
  const fila=(nom,anio,nota)=>'<tr><td style="text-align:left">'+nom+
    (nota?'<div style="font-size:9px;color:var(--faint)">'+nota+'</div>':'')+'</td>'+
    '<td>'+fmt2(anio)+'€</td><td>'+fmt2(anio/12)+'€</td><td>'+pc2(anio)+'%</td></tr>';
  // el reparto entre objetivos y remanente sale de cómo tengas clasificados los
  // pagos del año de referencia; si la tabla usa otra cifra total, se prorratea
  const C=prodClasifAnio(prodAnioRef());
  let objExtra=remAnio, remSolo=0;
  if(C&&C.total>0){
    objExtra=remAnio*(C.obj/C.total);
    remSolo =remAnio*(C.rem/C.total);
  }
  const Y=perfilYo(p), Ysin=netoSinProd(p);
  const caida=Y.netoMes-Ysin.netoMes;
  const ref=prodAnioRef();
  box.innerHTML=
    '<div style="border:1px solid var(--border);border-radius:7px;padding:.55rem .6rem">'+
    '<div style="font-size:11.5px;font-weight:600;margin-bottom:.35rem">Lo que va dentro de estas cifras y no es derecho consolidado</div>'+
    '<div class="tbl-scroll" style="overflow-x:auto"><table class="detail-table" style="font-size:11px;min-width:420px">'+
      '<thead><tr><th style="text-align:left">Concepto</th><th>Al año</th><th>Entre 12</th><th>% del bruto</th></tr></thead><tbody>'+
      fila('Productividad fija mensual',objAnio,fmt2(Number(c.prodMes)||0)+'€ a cuenta todos los meses')+
      fila('Productividad por objetivos',objExtra,
           C?(C.pagos.filter(x=>x.tipo==='obj').length+' pago(s) grandes al año · oscila'):'pagos grandes, oscilan')+
      fila('Remanente',remSolo,'reparto de lo que sobra · aleatorio, puede ser cero')+
      '<tr style="font-weight:700;border-top:1px solid var(--border)">'+
        '<td style="text-align:left">Total</td><td>'+fmt2(totAnio)+'€</td><td>'+fmt2(totAnio/12)+'€</td>'+
        '<td>'+pc2(totAnio)+'%</td></tr>'+
    '</tbody></table></div>'+
    '<div style="font-size:10.5px;color:var(--muted);margin-top:.4rem;line-height:1.45">'+
      'Porcentajes sobre el bruto anual de nómina de «'+escapeHtml(p.nombre)+'» ('+fmt2(B.anual)+'€), sin contar el IPT. '+
      'Si la administración dejara de pagar los tres conceptos, tu neto pasaría de <strong>'+fmt2(Y.netoMes)+
      '€</strong> a <strong>'+fmt2(Ysin.netoMes)+'€</strong> al mes: <span class="neg">−'+fmt2(caida)+'€</span> cada mes, '+
      '−'+fmt2(caida*12)+'€ al año. El sueldo base, los trienios y los complementos de destino y específico no se tocan.'+
      (remSolo>1?('<br>Solo con que no hubiera remanente —que es lo más fácil que pase— serían <strong>'+
        fmt2(remSolo/12)+'€</strong> menos al mes en bruto, '+fmt2(remSolo)+'€ al año.'):'')+
    '</div>'+
    (C?('<div style="margin-top:.5rem;border-top:1px solid var(--border);padding-top:.45rem">'+
      '<div style="font-size:10.5px;color:var(--muted);margin-bottom:.3rem">'+
        (C.pagos.every(x=>x.origen==='nomina')
          ? 'Pagos de productividad de '+C.anio+', tal y como los nombra tu nómina.'
          : 'Pagos de productividad de '+C.anio+'. Los que tu nómina no distingue van marcados con ~ y son una propuesta: toca para cambiarlos.')+'</div>'+
      '<div style="display:flex;flex-wrap:wrap;gap:.35rem">'+
      C.pagos.map(x=>'<button type="button" class="btn-xs" onclick="toggleProdTipo(this.dataset.k)" data-k="'+x.k+'" '+
        'style="border-color:'+(x.tipo==='obj'?'var(--navy)':'var(--amber)')+';color:'+(x.tipo==='obj'?'var(--navy)':'var(--amber)')+'">'+
        fmtMes(x.ym)+' · '+fmt2(x.importe)+'€ · '+(x.origen==='nomina'?'':'~')+
        (x.tipo==='obj'?'objetivos':'remanente')+'</button>').join('')+
      '</div>'+
      '<div style="font-size:10px;color:var(--faint);margin-top:.3rem">'+
        'Objetivos '+fmt2(C.obj)+'€ · Remanente '+fmt2(C.rem)+'€ · Total '+fmt2(C.total)+'€'+
        (Math.abs(C.total-remAnio)>1?(' — la tabla está usando '+fmt2(remAnio)+'€ en total, así que estas cifras se quedan cortas.'):'')+
      '</div></div>'):'')+
    '</div>';
  markScrollables(box);
}

// ════════════════════════════════════════════════════════════════════
// v159 · VIVIENDA Y VEHÍCULO
// ════════════════════════════════════════════════════════════════════
// Una casa y un coche no son patrimonio financiero: no se venden en un día, no
// rentan como un fondo y un coche solo pierde valor. Por eso van aparte y no se
// meten en ninguna rentabilidad ni en la evolución de la cartera; solo suman en
// el «patrimonio total», que es lo que de verdad tienes.
//
// Y la calculadora de vivienda hace lo que haría un banco: mira tu ingreso
// ESTABLE —sin productividad ni remanente, que es justo lo que no garantiza
// nadie—, limita la cuota al esfuerzo que marques, el préstamo al 80% del
// precio (70% si no vendes la actual) y el plazo a tu edad. Lo que falte lo pone
// la entrada, y la entrada también tiene que cubrir impuestos y gastos.
function bienesCfg(){
  const b=cfg.bienes=cfg.bienes||{};
  b.viv=b.viv||{valor:0,fecha:'',pct:100,pendiente:0,gastosVenta:3.5};
  b.veh=b.veh||{nombre:'',anio:'',valor:0};
  b.calc=b.calc||{};
  const c=b.calc;
  if(c.tipo==null)c.tipo=3.0;
  if(c.esfuerzo==null)c.esfuerzo=35;
  if(c.plazoMax==null)c.plazoMax=30;
  if(c.edadFin==null)c.edadFin=75;
  // v160 · Tu discapacidad es del 33% física: el ITP reducido valenciano exige
  // un 65% si es física, así que esa opción no te sirve y no se ofrece.
  if(c.impuesto==null||c.impuesto==='itpdisc')c.impuesto='itp9';
  if(c.gastosCompra==null)c.gastosCompra=1.2;
  if(c.vender==null)c.vender=true;
  if(c.conProd==null)c.conProd=false;
  if(c.parejaNeto==null)c.parejaNeto=0;
  if(c.parejaAhorro==null)c.parejaAhorro=0;
  if(c.parejaEdad==null)c.parejaEdad='';
  if(c.otrasCuotas==null)c.otrasCuotas=0;
  b.gastos=b.gastos||{};
  b.coche=b.coche||{precio:0,entregar:true,contado:0,tipo:6.5,plazo:6,costeAnual:null};
  return b;
}
function setBien(ruta,v,tipo){
  const b=bienesCfg(); const k=ruta.split('.'); let o=b;
  for(let i=0;i<k.length-1;i++)o=o[k[i]]=o[k[i]]||{};
  let val=v;
  if(tipo==='num'){ const s=String(v).trim(); val=s===''?null:dgNum(s); }
  if(tipo==='bool') val=!!v;
  o[k[k.length-1]]=val;
  save(); renderVivienda();
  try{renderKPIs();}catch(e){fallo('renderKPIs',e)}
}
function _edad(fnac){
  if(!fnac)return null;
  const d=new Date(fnac), h=new Date();
  let e=h.getFullYear()-d.getFullYear();
  if(h.getMonth()<d.getMonth()||(h.getMonth()===d.getMonth()&&h.getDate()<d.getDate()))e--;
  return e;
}
function bienesNetos(){
  const b=bienesCfg();
  const viv=Math.max(0,(Number(b.viv.valor)||0)*(Number(b.viv.pct)||0)/100-(Number(b.viv.pendiente)||0));
  const veh=Math.max(0,Number(b.veh.valor)||0);
  return {viv,veh,total:viv+veh};
}
// cuota del sistema francés y su inversa
function cuotaPrestamo(capital,tipoAnual,anios){
  const i=tipoAnual/100/12, n=anios*12;
  if(capital<=0||n<=0)return 0;
  return i>0?capital*i/(1-Math.pow(1+i,-n)):capital/n;
}
function capitalPorCuota(cuota,tipoAnual,anios){
  const i=tipoAnual/100/12, n=anios*12;
  if(cuota<=0||n<=0)return 0;
  return i>0?cuota*(1-Math.pow(1+i,-n))/i:cuota*n;
}
// el impuesto de la compra en la Comunitat Valenciana, según el caso
function impuestoCompra(tipo,precio){
  // v169 · Ley 5/2026 de la Generalitat (DOGV 10/8/2026): desde el 11 de agosto
  // de 2026 el AJD de la escritura de compra de la vivienda habitual es del 0,1 %
  // (antes, 1,4 %). Esta cuenta es para la vivienda en la que vas a vivir.
  if(tipo==='nueva')return {pct:10.1,txt:'IVA 10% + AJD 0,1%'};
  if(tipo==='itpdisc'){const p=precio<=180000?3:4;return {pct:p,txt:'ITP reducido '+p+'%'};}
  return {pct:9,txt:'ITP 9%'};
}
// Lo que de verdad cobras cada mes y un banco daría por seguro
function ingresoEstable(conProd){
  try{
    const c=puestosCfg(), p=(c.lista||[]).find(x=>x.propio)||(c.lista||[])[0];
    if(!p)return 0;
    return conProd?perfilYo(p).netoMes:netoSinProd(p).netoMes;
  }catch(e){return 0;}
}
function liquidezHoy(){
  try{
    const nd=new Date(), lv=buildLiveRecord(nd.getFullYear(),nd.getMonth()+1);
    return (lv&&lv.cash)||0;
  }catch(e){return 0;}
}
// Neto que dejaría vender la vivienda actual
function netoVentaActual(){
  const b=bienesCfg(), v=b.viv;
  const bruto=(Number(v.valor)||0)*(Number(v.pct)||0)/100;
  const gastos=bruto*(Number(v.gastosVenta)||0)/100;
  return Math.max(0,bruto-gastos-(Number(v.pendiente)||0));
}
// El núcleo: precio máximo con unos ingresos, una entrada, un plazo y unas cuotas
function capacidadCompra(o){
  const c=bienesCfg().calc;
  const ltv=c.vender?0.80:0.70;
  const cuotaMax=Math.max(0,o.ingreso*(Number(c.esfuerzo)||0)/100-(o.otrasCuotas||0));
  const anios=Math.max(1,Math.min(Number(c.plazoMax)||30,(Number(c.edadFin)||75)-(o.edadMayor||48)));
  const prestMax=capitalPorCuota(cuotaMax,Number(c.tipo)||0,anios);
  const entrada=o.entrada;
  // el impuesto depende del precio (3% o 4%), así que se ajusta en dos vueltas
  let precio=0, imp=impuestoCompra(c.impuesto,0);
  for(let k=0;k<3;k++){
    const g=(imp.pct+(Number(c.gastosCompra)||0))/100;
    const porCuota=(prestMax+entrada)/(1+g);
    const porEntrada=entrada/((1-ltv)+g);
    precio=Math.max(0,Math.min(porCuota,porEntrada));
    imp=impuestoCompra(c.impuesto,precio);
  }
  const g=(imp.pct+(Number(c.gastosCompra)||0))/100;
  const limita=((prestMax+entrada)/(1+g))<=(entrada/((1-ltv)+g))?'cuota':'entrada';
  const gastos=precio*g;
  const prestamo=Math.max(0,precio+gastos-entrada);
  const cuota=cuotaPrestamo(prestamo,Number(c.tipo)||0,anios);
  const intereses=cuota*anios*12-prestamo;
  return {ingreso:o.ingreso,cuotaMax,anios,prestMax,entrada,ltv,precio,gastos,imp,prestamo,cuota,intereses,limita,
          edadFin:(o.edadMayor||48)+anios};
}
// Gastos de la vivienda: por defecto los tuyos reales de los últimos 12 meses
function gastosViviendaReales(){
  const hoy=new Date(), fin=hoy.getFullYear()+'-'+String(hoy.getMonth()+1).padStart(2,'0');
  const ini=new Date(hoy.getFullYear()-1,hoy.getMonth(),1);
  const desde=ini.getFullYear()+'-'+String(ini.getMonth()+1).padStart(2,'0');
  const ce=(typeof compExpenseIds==='function')?compExpenseIds():new Set();
  // las categorías propias se guardan como mapa {id:{label…}} o como lista, según versión
  const cc=cfg.customCats||{};
  const labelOf=id=>{
    const x=Array.isArray(cc)?cc.find(z=>z&&z.id===id):cc[id];
    if(!x)return '';
    return typeof x==='string'?x:String(x.label||x.name||'');
  };
  const E=expenseLog.filter(e=>{const ym=String(e.date||'').slice(0,7);return ym>=desde&&ym<fin&&!ce.has(e.id);});
  const suma=f=>E.filter(f).reduce((s,e)=>s+(e.amt||0),0);
  const nm=e=>String(e.name||'');
  return {
    ibi:suma(e=>/\bibi\b|suma gesti|catastro/i.test(nm(e))),
    seguro:suma(e=>/seguro.*hogar|hogar.*seguro/i.test(nm(e))||/seguro/i.test(labelOf(e.cat))),
    comunidad:suma(e=>/comunidad de propiet|\bcomunidad\b/i.test(nm(e))),
    luz:suma(e=>e.cat==='luz'),
    agua:suma(e=>e.cat==='agua'),
    gas:suma(e=>/naturgy|butano|gas natural|\bgas\b/i.test(nm(e))),
    internet:suma(e=>/internet|tel[eé]f|fibra/i.test(labelOf(e.cat))||/movistar|vodafone|orange|\bdigi\b|jazztel|masmovil|pepephone|lowi|simyo/i.test(nm(e))),
    vehiculo:suma(e=>e.cat==='vehiculo'),
    meses:12
  };
}
const GASTO_VIV=[
  ['ibi','IBI y tasas municipales','el recibo de Suma: IBI y basura (del impuesto del coche estás exento)'],
  ['comunidad','Comunidad de propietarios','si es un piso o una urbanización con zonas comunes'],
  ['seguro','Seguro de hogar',''],
  ['vida','Seguro de vida','si el banco lo pide con la hipoteca'],
  ['luz','Luz',''],['agua','Agua',''],['gas','Gas',''],
  ['internet','Internet y teléfono',''],
];
// v160 · Pagos que no son de todas las casas y que solo tú sabes si tendrás:
// una cochera para un segundo coche o para el tuyo, un trastero, una
// alarma… Se añaden a mano, en euros al mes, y entran en el total.
function vivExtras(){ const g=bienesCfg().gastos; g.extra=g.extra||[]; return g.extra; }
function vivExtraAdd(nombre){
  vivExtras().push({id:'vx_'+Date.now(),nombre:nombre||'',mes:0});
  save(); renderVivienda();
}
function vivExtraSet(id,campo,v){
  const x=vivExtras().find(z=>z.id===id); if(!x)return;
  if(campo==='mes'){ const s=String(v).trim(); x.mes=s===''?0:(dgNum(s)||0); } else x.nombre=v;
  save(); renderVivienda();
}
function vivExtraDel(id){
  const g=bienesCfg().gastos; g.extra=(g.extra||[]).filter(z=>z.id!==id);
  save(); renderVivienda();
}
function gastoViv(k,real){
  const g=bienesCfg().gastos;
  if(g[k]!=null)return {v:Number(g[k])||0,deTus:false};
  if(k==='vida')return {v:0,deTus:false};
  return {v:real[k]||0,deTus:true};
}
function inputNum(ruta,val,w,extra){
  return '<input type="text" inputmode="decimal" value="'+(val==null||val===''?'':fmt2(val))+'" '+
    'onchange="setBien(\''+ruta+'\',this.value,\'num\')" style="width:'+(w||80)+'px;font-size:11.5px;text-align:right;padding:2px 5px"'+(extra||'')+'>';
}
function renderVivienda(){
  const b=bienesCfg(), c=b.calc, pc=pensionCfg();
  const edadYo=_edad(pc.nacimientoFecha)||48;
  const eur=v=>fmt2(v)+'€';
  // ── 1 · Tus bienes ──────────────────────────────────────────────
  const bn=bienesNetos();
  let patFin=0; try{const nd=new Date();patFin=patOf(buildLiveRecord(nd.getFullYear(),nd.getMonth()+1));}catch(e){fallo('nd',e)}
  const B1=document.getElementById('viv-bienes');
  if(B1){
    B1.innerHTML=
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.7rem">'+
      '<div style="border:1px solid var(--border);border-radius:7px;padding:.55rem .6rem;font-size:11.5px;line-height:1.9">'+
        '<strong>Vivienda actual</strong><br>'+
        'Valor estimado '+inputNum('viv.valor',b.viv.valor,95)+' €<br>'+
        'Estimado el <input type="date" value="'+(b.viv.fecha||'')+'" onchange="setBien(\'viv.fecha\',this.value)" style="font-size:11px">'+
        '<br>Tu parte '+inputNum('viv.pct',b.viv.pct,50)+' %'+
        '<br>Hipoteca pendiente '+inputNum('viv.pendiente',b.viv.pendiente,90)+' €'+
        '<br>Gastos si la vendes '+inputNum('viv.gastosVenta',b.viv.gastosVenta,45)+' %'+
        '<div style="font-size:10px;color:var(--faint);line-height:1.35;margin-top:.2rem">agencia, plusvalía municipal, cancelación… un 3-4% es lo normal. '+
        'Si la hipoteca ya la tienes en Deudas, no la repitas aquí.</div>'+
        '<div style="margin-top:.3rem">Neto tuyo: <strong>'+eur(bn.viv)+'</strong></div>'+
      '</div>'+
      '<div style="border:1px solid var(--border);border-radius:7px;padding:.55rem .6rem;font-size:11.5px;line-height:1.9">'+
        '<strong>Vehículo</strong><br>'+
        'Cuál <input type="text" value="'+escapeHtml(b.veh.nombre||'')+'" onchange="setBien(\'veh.nombre\',this.value)" placeholder="modelo / matrícula" style="width:130px;font-size:11px">'+
        '<br>Año de matriculación <input type="text" inputmode="numeric" value="'+escapeHtml(String(b.veh.anio||''))+'" onchange="setBien(\'veh.anio\',this.value)" style="width:50px;font-size:11px">'+
        '<br>Valor hoy '+inputNum('veh.valor',b.veh.valor,80)+' €'+
        '<div style="font-size:10px;color:var(--faint);line-height:1.35;margin-top:.2rem">lo que te darían hoy por él, no lo que costó. '+
        'Un coche con muchos años vale poco y cada año algo menos: actualízalo de vez en cuando.</div>'+
      '</div></div>'+
      '<div style="margin-top:.7rem;padding:.55rem .6rem;border-radius:7px;background:var(--surface2);font-size:12px;line-height:1.7">'+
        'Patrimonio financiero <strong>'+eur(patFin)+'</strong>'+
        (bn.viv?(' + vivienda <strong>'+eur(bn.viv)+'</strong>'):'')+
        (bn.veh?(' + coche <strong>'+eur(bn.veh)+'</strong>'):'')+
        '<br><span style="font-size:13.5px">Patrimonio total: <strong>'+eur(patFin+bn.total)+'</strong></span>'+
        '<div style="font-size:10.5px;color:var(--muted)">La vivienda y el coche no entran en ninguna rentabilidad ni en la evolución de la cartera: solo suman aquí y en la cabecera.</div>'+
      '</div>';
  }
  // ── 2 · Qué vivienda te puedes permitir ─────────────────────────
  const ingYo=ingresoEstable(!!c.conProd);
  const cuotaCoche=cocheSimulado().cuota;
  const otras=(Number(c.otrasCuotas)||0);
  const liq=liquidezHoy();
  const ventaNeta=c.vender?netoVentaActual():0;
  const ahorroYo=(c.ahorroEntrada!=null?Number(c.ahorroEntrada):liq);
  const solo=capacidadCompra({ingreso:ingYo,otrasCuotas:otras,edadMayor:edadYo,entrada:ahorroYo+ventaNeta});
  const edadPar=Number(c.parejaEdad)||edadYo;
  const par=(Number(c.parejaNeto)>0)?capacidadCompra({ingreso:ingYo+Number(c.parejaNeto),otrasCuotas:otras,
      edadMayor:Math.max(edadYo,edadPar),entrada:ahorroYo+ventaNeta+(Number(c.parejaAhorro)||0)}):null;
  const B2=document.getElementById('viv-calc');
  if(B2){
    const col=(t,r)=>!r?('<td colspan="1" style="color:var(--faint);font-size:10.5px">pon abajo el neto de tu pareja</td>'):
      '<td>'+t(r)+'</td>';
    const fila=(nom,t,nota)=>'<tr><td style="text-align:left">'+nom+(nota?'<div style="font-size:9px;color:var(--faint)">'+nota+'</div>':'')+'</td>'+
      '<td>'+t(solo)+'</td>'+col(t,par)+'</tr>';
    B2.innerHTML=
      '<div class="tbl-scroll" style="overflow-x:auto"><table class="detail-table" style="font-size:11.5px;min-width:430px">'+
      '<thead><tr><th style="text-align:left"></th><th>Solo</th><th>En pareja</th></tr></thead><tbody>'+
      fila('Ingreso neto mensual',r=>eur(r.ingreso),c.conProd?'con productividad':'sin productividad ni remanente')+
      fila('Cuota máxima',r=>eur(r.cuotaMax),(c.esfuerzo)+'% del ingreso'+(otras||cuotaCoche?' menos otras cuotas':''))+
      fila('Plazo',r=>r.anios+' años',"acabarías con "+'…')+
      fila('Préstamo máximo',r=>eur(r.prestMax),'al '+fmt2(c.tipo)+'%')+
      fila('Entrada disponible',r=>eur(r.entrada),c.vender?'ahorro + venta de la actual':'solo ahorro')+
      '<tr style="font-weight:700;border-top:1px solid var(--border)"><td style="text-align:left">Precio máximo</td>'+
        '<td class="pos">'+eur(solo.precio)+'</td>'+(par?'<td class="pos">'+eur(par.precio)+'</td>':'<td></td>')+'</tr>'+
      fila('Impuestos y gastos',r=>eur(r.gastos),solo.imp.txt+' + '+fmt2(c.gastosCompra)+'% de gastos')+
      fila('Te prestan',r=>eur(r.prestamo)+'<div style="font-size:9px;color:var(--faint)">'+(r.precio>0?Math.round(r.prestamo/r.precio*100):0)+'% del precio</div>','')+
      fila('Cuota resultante',r=>'<strong>'+eur(r.cuota)+'</strong>','')+
      fila('Intereses totales',r=>eur(r.intereses),'')+
      fila('Te limita',r=>(r.limita==='cuota'?'la cuota':'la entrada'),'lo que antes se agota')+
      '</tbody></table></div>'+
      '<div style="font-size:10.5px;color:var(--muted);margin-top:.4rem;line-height:1.5">'+
        'En pareja la vivienda sería vuestra a medias: tu parte en el patrimonio sería la mitad. '+
        'Plazo limitado a que el mayor termine de pagar a los '+c.edadFin+'. '+
        (solo.limita==='entrada'?'<strong>Te limita la entrada, no el sueldo</strong>: más ahorro sube el precio mucho más que más ingresos.':
          '<strong>Te limita la cuota</strong>: con más entrada comprarías igual, pero con menos hipoteca.')+
      '</div>'+
      '<details style="margin-top:.5rem"><summary style="font-size:11.5px;cursor:pointer">Ajustes</summary>'+
      '<div style="font-size:11.5px;line-height:2;margin-top:.3rem">'+
        '<label><input type="checkbox" '+(c.vender?'checked':'')+' onchange="setBien(\'calc.vender\',this.checked,\'bool\')"> Vendo la actual para comprar</label>'+
        ' <span style="font-size:10px;color:var(--faint)">(si no, sería segunda vivienda: el banco presta el 70%, no el 80%)</span><br>'+
        '<label><input type="checkbox" '+(c.conProd?'checked':'')+' onchange="setBien(\'calc.conProd\',this.checked,\'bool\')"> Contar la productividad y el remanente</label>'+
        ' <span style="font-size:10px;color:var(--faint)">(un banco prudente no los cuenta enteros)</span><br>'+
        'Ahorro que pones '+inputNum('calc.ahorroEntrada',c.ahorroEntrada!=null?c.ahorroEntrada:null,90,' placeholder="'+fmt2(liq)+'"')+' € '+
        '<span style="font-size:10px;color:var(--faint)">vacío = tu liquidez de hoy ('+eur(liq)+'); fondos y acciones no cuentan salvo que los vendas</span><br>'+
        'Neto de tu pareja '+inputNum('calc.parejaNeto',c.parejaNeto,80)+' €/mes · su ahorro '+inputNum('calc.parejaAhorro',c.parejaAhorro,80)+
        ' € · su edad <input type="text" inputmode="numeric" value="'+escapeHtml(String(c.parejaEdad||''))+'" onchange="setBien(\'calc.parejaEdad\',this.value)" style="width:40px;font-size:11px"><br>'+
        'Tipo de interés '+inputNum('calc.tipo',c.tipo,45)+' % <span style="font-size:10px;color:var(--faint)">(pon el que te ofrezcan)</span> · '+
        'esfuerzo máximo '+inputNum('calc.esfuerzo',c.esfuerzo,40)+' %<br>'+
        'Plazo máximo '+inputNum('calc.plazoMax',c.plazoMax,40)+' años · terminar de pagar antes de los '+inputNum('calc.edadFin',c.edadFin,40)+'<br>'+
        'Otras cuotas que ya pagas '+inputNum('calc.otrasCuotas',c.otrasCuotas,70)+' €/mes'+(cuotaCoche?(' <span style="font-size:10px;color:var(--amber)">+ '+eur(cuotaCoche)+' del coche simulado abajo</span>'):'')+'<br>'+
        'Vivienda <select onchange="setBien(\'calc.impuesto\',this.value)" style="font-size:11px">'+
          '<option value="itp9"'+(c.impuesto==='itp9'?' selected':'')+'>Usada · ITP 9%</option>'+
          '<option value="nueva"'+(c.impuesto==='nueva'?' selected':'')+'>Nueva · IVA 10% + AJD 0,1%</option>'+
        '</select> · otros gastos '+inputNum('calc.gastosCompra',c.gastosCompra,40)+' %'+
        '<div style="font-size:10px;color:var(--faint);line-height:1.4">ITP general valenciano del 9% desde junio de 2026. '+
        'El reducido por discapacidad pide un 65% física, así que con tu 33% no aplica. Los tipos cambian: compruébalo antes de firmar.</div>'+
      '</div></details>';
    // el plazo con la edad al terminar
    B2.innerHTML=B2.innerHTML.replace("acabarías con …","acabarías con "+solo.edadFin+" años"+(par?(' / '+par.edadFin):''));
  }
  // ── 3 · Lo que cuesta mantenerla ────────────────────────────────
  const real=gastosViviendaReales();
  const B3=document.getElementById('viv-gastos');
  if(B3){
    let tot=0, h3='';
    GASTO_VIV.forEach(([k,nom,nota])=>{
      const g=gastoViv(k,real); tot+=g.v;
      h3+='<tr><td style="text-align:left">'+nom+
        (nota?'<div style="font-size:9px;color:var(--faint)">'+nota+'</div>':'')+
        (g.deTus&&g.v>0?'<div style="font-size:9px;color:var(--faint)">de tus gastos reales</div>':'')+'</td>'+
        '<td>'+inputNum('gastos.'+k,g.v,80)+'</td><td>'+eur(g.v/12)+'</td></tr>';
    });
    // pagos añadidos a mano
    vivExtras().forEach(x=>{
      const anual=(Number(x.mes)||0)*12; tot+=anual;
      h3+='<tr><td style="text-align:left">'+
        '<input type="text" value="'+escapeHtml(x.nombre||'')+'" placeholder="concepto" '+
          'onchange="vivExtraSet(\''+x.id+'\',\'nombre\',this.value)" style="width:130px;font-size:11px"> '+
        '<button type="button" class="btn-xs" onclick="vivExtraDel(\''+x.id+'\')" title="quitar">✕</button></td>'+
        '<td>'+eur(anual)+'</td>'+
        '<td><input type="text" inputmode="decimal" value="'+(x.mes?fmt2(x.mes):'')+'" placeholder="€/mes" '+
          'onchange="vivExtraSet(\''+x.id+'\',\'mes\',this.value)" style="width:70px;font-size:11.5px;text-align:right;padding:2px 5px"></td></tr>';
    });
    const precioRef=(par&&par.precio)||solo.precio||0;
    const mantPct=Number(b.gastos.mantPct!=null?b.gastos.mantPct:1);
    const mant=precioRef*mantPct/100; tot+=mant;
    h3+='<tr><td style="text-align:left">Mantenimiento y reparaciones<div style="font-size:9px;color:var(--faint)">'+
      inputNum('gastos.mantPct',mantPct,36)+'% del precio al año</div></td><td>'+eur(mant)+'</td><td>'+eur(mant/12)+'</td></tr>';
    const cuotaRef=(par&&par.cuota)||solo.cuota||0;
    const mensual=cuotaRef+tot/12;
    const ingRef=(par?par.ingreso:solo.ingreso)||1;
    B3.innerHTML='<div class="tbl-scroll" style="overflow-x:auto"><table class="detail-table" style="font-size:11.5px;min-width:360px">'+
      '<thead><tr><th style="text-align:left">Gasto</th><th>Al año</th><th>Al mes</th></tr></thead><tbody>'+h3+
      '<tr><td colspan="3" style="text-align:left">'+
        '<button type="button" class="btn-xs" onclick="vivExtraAdd(\'Cochera\')">+ Cochera</button> '+
        '<button type="button" class="btn-xs" onclick="vivExtraAdd(\'\')">+ Otro pago</button>'+
        '<span style="font-size:9.5px;color:var(--faint)"> en euros al mes</span></td></tr>'+
      '<tr style="font-weight:700;border-top:1px solid var(--border)"><td style="text-align:left">Total sin hipoteca</td><td>'+eur(tot)+'</td><td>'+eur(tot/12)+'</td></tr>'+
      '<tr style="font-weight:700"><td style="text-align:left">+ cuota de la hipoteca</td><td>'+eur(cuotaRef*12)+'</td><td>'+eur(cuotaRef)+'</td></tr>'+
      '<tr style="font-weight:700;border-top:1px solid var(--border)"><td style="text-align:left">Lo que te cuesta la casa</td><td>'+eur(mensual*12)+'</td><td>'+eur(mensual)+'</td></tr>'+
      '</tbody></table></div>'+
      '<div style="font-size:10.5px;color:var(--muted);margin-top:.4rem;line-height:1.5">'+
        'Sobre la vivienda de '+eur(precioRef)+(par?' en pareja':'')+'. Eso es el <strong>'+Math.round(mensual/ingRef*100)+'%</strong> de '+
        (par?'vuestros ingresos':'tu ingreso')+(par?(', unos '+eur(mensual/2)+' al mes cada uno si vais a medias'):'')+'. '+
        'Los importes salen de lo que has gastado de verdad en los últimos 12 meses en tu casa actual; una casa más grande gastará más. '+
        'Toca cualquier cifra para cambiarla: en las filas de siempre se escribe el importe al año; en los pagos añadidos, al mes.'+
      '</div>';
  }
  // ── 4 · Coche ────────────────────────────────────────────────────
  const B4=document.getElementById('viv-coche');
  if(B4){
    const k=b.coche, S=cocheSimulado();
    const costeReal=real.vehiculo||0;
    const sinCoche=capacidadCompra({ingreso:ingYo,otrasCuotas:otras,edadMayor:edadYo,entrada:ahorroYo+ventaNeta});
    const soloSin=(function(){const cc=bienesCfg().calc;return capacidadCompra({ingreso:ingYo,otrasCuotas:otras-0,edadMayor:edadYo,
      entrada:ahorroYo+ventaNeta+(S.desembolso||0)});})();
    const conCoche=capacidadCompra({ingreso:ingYo,otrasCuotas:otras+S.cuota,edadMayor:edadYo,entrada:ahorroYo+ventaNeta-(S.desembolso||0)});
    B4.innerHTML=
      '<div style="font-size:11.5px;line-height:2">'+
        'Precio del coche nuevo '+inputNum('coche.precio',k.precio,90)+' € '+
        '<label><input type="checkbox" '+(k.entregar?'checked':'')+' onchange="setBien(\'coche.entregar\',this.checked,\'bool\')"> entrego el actual ('+eur(Number(b.veh.valor)||0)+')</label><br>'+
        'Pago al contado '+inputNum('coche.contado',k.contado,80)+' € · financio el resto al '+inputNum('coche.tipo',k.tipo,40)+' % a '+inputNum('coche.plazo',k.plazo,32)+' años<br>'+
        'Coste anual de tenerlo '+inputNum('coche.costeAnual',k.costeAnual!=null?k.costeAnual:null,80,' placeholder="'+fmt2(costeReal)+'"')+' € '+
        '<span style="font-size:10px;color:var(--faint)">vacío = lo que gastas hoy con el tuyo ('+eur(costeReal)+'/año: gasolina, seguro, taller…)</span>'+
      '</div>'+
      (S.precio>0?(
      '<div class="tbl-scroll" style="overflow-x:auto;margin-top:.4rem"><table class="detail-table" style="font-size:11.5px;min-width:360px"><tbody>'+
        '<tr><td style="text-align:left">Sale de tu liquidez</td><td>'+eur(S.desembolso)+'</td></tr>'+
        '<tr><td style="text-align:left">Financias</td><td>'+eur(S.financiado)+'</td></tr>'+
        '<tr><td style="text-align:left">Cuota</td><td><strong>'+eur(S.cuota)+'</strong>/mes · '+eur(S.intereses)+' de intereses</td></tr>'+
        '<tr><td style="text-align:left">Lo que valdrá</td><td>'+S.valores.map((v,i)=>'año '+(i+1)+': '+eur(v)).filter((x,i)=>[0,2,4].includes(i)).join(' · ')+'</td></tr>'+
        '<tr><td style="text-align:left">Lo que pierde en 5 años</td><td class="neg">−'+eur(S.precio-S.valores[4])+'</td></tr>'+
        '<tr style="font-weight:700;border-top:1px solid var(--border)"><td style="text-align:left">Vivienda máxima sin el coche</td><td>'+eur(sinCoche.precio)+'</td></tr>'+
        '<tr style="font-weight:700"><td style="text-align:left">Vivienda máxima con el coche</td><td>'+eur(conCoche.precio)+
          ' <span class="neg">(−'+eur(Math.max(0,sinCoche.precio-conCoche.precio))+')</span></td></tr>'+
      '</tbody></table></div>'+
      '<div style="font-size:10.5px;color:var(--muted);margin-top:.4rem;line-height:1.5">'+
        'La depreciación es una regla general: −20% el primer año y −12% cada año después. '+
        'La cuota del coche cuenta para el banco como una deuda más y resta de la cuota de hipoteca que te conceden; '+
        'y lo que pagas al contado sale de la entrada. Por eso comprar el coche <strong>antes</strong> que la casa encarece la casa.'+
      '</div>'):'<div style="font-size:10.5px;color:var(--muted);margin-top:.3rem">Pon un precio para ver qué supondría.</div>');
  }
}
// El coche simulado: lo que cuesta, lo que se financia y lo que vale con los años
function cocheSimulado(){
  const b=bienesCfg(), k=b.coche;
  const precio=Number(k.precio)||0;
  if(precio<=0)return {precio:0,cuota:0,desembolso:0,financiado:0,intereses:0,valores:[0,0,0,0,0]};
  const entrega=k.entregar?Math.min(precio,Number(b.veh.valor)||0):0;
  const contado=Math.min(Math.max(0,Number(k.contado)||0),precio-entrega);
  const financiado=Math.max(0,precio-entrega-contado);
  const cuota=cuotaPrestamo(financiado,Number(k.tipo)||0,Number(k.plazo)||1);
  const intereses=cuota*(Number(k.plazo)||1)*12-financiado;
  const valores=[]; let v=precio;
  for(let i=0;i<5;i++){ v=v*(i===0?0.80:0.88); valores.push(v); }
  return {precio,entrega,contado,financiado,cuota,intereses,desembolso:contado,valores};
}

let _puestoMode='ipt', _puestoPer='mes', _puestosChart=null;
function setPuestoPer(p){_puestoPer=p;document.querySelectorAll('.puesto-per-btn').forEach(b=>b.classList.toggle('active',b.dataset.per===p));renderPuestos();}

// v116 · La comparación es entre PERSONAS, no entre puestos.
//   · Compañero: soltero, sin hijos, sin discapacidad y sin IPT. Solo el sueldo.
//   · Tú: el mismo sueldo + tu IPT, con los 3.500€ de gastos del art. 19.2.f y
//     los 3.000€ de más de mínimo exento.
// Los dos con su IRPF calculado aparte, para ver cuánto paga cada uno.
function perfilCompanero(p){ return puestoNeto(p,{disc:0,conIpt:false}); }
function perfilYo(p){ const pc=pensionCfg(); return puestoNeto(p,{disc:pc.discapacidad||0,conIpt:true}); }

function renderPuestos(){
  try{renderPension();}catch(e){console.warn('pension',e);}
  const c=puestosCfg(), pc=pensionCfg();
  const anual=_puestoPer==='anio';
  const div=v=>anual?v:v/12;
  const eur=v=>fmt(Math.round(v))+'€';
  const A=c.lista.map(perfilCompanero);   // el compañero
  const Y=c.lista.map(perfilYo);          // tú
  const cur=c.lista.findIndex(p=>p.propio);
  const curIdx=cur>=0?cur:0;
  const valor=(r)=>c.verNeto?r.neto:r.brutoTotal;

  // ── gráfica: dos barras por puesto
  const cv=document.getElementById('cPuestos');
  if(cv&&typeof Chart!=='undefined'){
    const dark=document.body.classList.contains('dark');
    const labels=c.lista.map(p=>p.nombre);
    if(_puestosChart)_puestosChart.destroy();
    _puestosChart=new Chart(cv,{type:'bar',
      data:{labels,datasets:[
        {label:'Compañero: soltero, sin hijos, sin discapacidad',
         data:A.map(r=>Math.round(div(valor(r)))),
         backgroundColor:c.lista.map((p,i)=>i===curIdx?'#8A97AB':'#C3CCDA'),borderWidth:0},
        {label:'Tú: mismo puesto + tu IPT + tu discapacidad',
         data:Y.map(r=>Math.round(div(valor(r)))),
         backgroundColor:c.lista.map((p,i)=>i===curIdx?'#0B3D91':(p.sentencia?'#12A594':'#5B7BB4')),borderWidth:0}]},
      options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:true,labels:{font:{size:10.5},color:dark?'#A0AEC0':'#5A6A80',boxWidth:10}},
          tooltip:{callbacks:{afterBody:items=>{const i=items[0].dataIndex;
            return 'Tú cobras '+fmt(Math.round(div(valor(Y[i])-valor(A[i]))))+'€ más\n'+
              'IRPF: él '+fmt(Math.round(div(A[i].irpf.cuota)))+'€ · tú '+fmt(Math.round(div(Y[i].irpf.cuota)))+'€';}}}},
        scales:{x:{grid:{color:dark?'rgba(255,255,255,.06)':'rgba(0,0,0,.06)'},
            ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:10},callback:v=>fmt(v)+'€'}},
          y:{grid:{display:false},ticks:{color:dark?'#A0AEC0':'#5A6A80',font:{size:10}}}}}});
  }

  const note=document.getElementById('puestos-note');
  if(note){
    const mejor=Y.reduce((a,b)=>valor(b)>valor(a)?b:a);
    const dif=valor(mejor)-valor(Y[curIdx]);
    note.innerHTML=
      '<div style="margin-bottom:.45rem">'+
        '<button type="button" class="btn-xs'+(c.verNeto?' fmode-on':'')+'" onclick="setPuestoCfg(\'verNeto\',true)">Neto</button> '+
        '<button type="button" class="btn-xs'+(!c.verNeto?' fmode-on':'')+'" onclick="setPuestoCfg(\'verNeto\',false)">Bruto</button>'+
      '</div>'+
      'La barra clara es <strong>un compañero soltero, sin hijos y sin discapacidad</strong> en ese mismo puesto: solo su sueldo. '+
      'La oscura eres <strong>tú</strong>, con el mismo sueldo más tu IPT de '+fmt2(pc.iptMes)+'€ × '+(pc.iptPagas||14)+' pagas, '+
      'y con las deducciones que te da tu discapacidad. '+
      'En tu puesto actual ('+escapeHtml(c.lista[curIdx].nombre)+') la diferencia es de <strong>'+
      eur(div(valor(Y[curIdx])-valor(A[curIdx])))+'</strong> '+(anual?'al año':'al mes')+'.'+
      (dif>0?' El puesto que más te dejaría es <strong>'+escapeHtml(mejor.p.nombre)+'</strong>: +'+eur(div(dif))+'.':'')+
      '<div style="margin-top:.4rem">Puesto actual: <select onchange="setPuestoActual(this.value)" style="font-size:11px">'+
      c.lista.map((p,i)=>'<option value="'+p.id+'"'+(i===curIdx?' selected':'')+'>'+escapeHtml(p.nombre)+'</option>').join('')+
      '</select></div>';
  }
  renderPuestosTabla(A,Y,curIdx,anual);
  try{renderPuestosProd();}catch(e){console.warn('prod',e);}
  try{renderBrutoReal();}catch(e){console.warn('bruto real',e);}
}

function renderPuestosTabla(A,Y,curIdx,anual){
  const tb=document.getElementById('puestos-tabla'); if(!tb)return;
  const c=puestosCfg(), pc=pensionCfg();
  const div=v=>anual?v:v/12;
  const eur=v=>fmt(Math.round(v))+'€';
  const per=anual?'/año':'/mes';
  let h='<thead>'+
    '<tr class="pu-x"><th></th><th></th>'+
      '<th colspan="3" style="border-left:2px solid var(--border);color:var(--muted)">COMPAÑERO · soltero, sin hijos, sin discapacidad</th>'+
      '<th colspan="4" style="border-left:2px solid var(--navy);color:var(--navy)">TÚ · mismo puesto + IPT + discapacidad</th>'+
      '<th></th></tr>'+
    '<tr><th style="text-align:left">Puesto</th><th class="pu-x">Grupo / nivel</th>'+
      '<th class="pu-x" style="border-left:2px solid var(--border)">Bruto'+per+'</th><th class="pu-x">IRPF</th>'+
      '<th style="border-left:2px solid var(--border)"><span class="pu-x">Neto'+per+'</span><span class="pu-m">Neto compañero</span></th>'+
      '<th class="pu-x" style="border-left:2px solid var(--navy)">Bruto'+per+'</th><th class="pu-x">+ IPT</th><th class="pu-x">IRPF</th>'+
      '<th style="border-left:2px solid var(--navy)"><span class="pu-x">Neto'+per+'</span><span class="pu-m">Neto tuyo</span></th>'+
      '<th><span class="pu-x">Diferencia</span><span class="pu-m">+</span></th></tr></thead><tbody>';
  A.forEach((a,i)=>{
    const y=Y[i], p=a.p;
    const dif=y.neto-a.neto;
    h+='<tr'+(i===curIdx?' style="background:rgba(11,61,145,.07);font-weight:600"':(p.sentencia?' style="background:color-mix(in srgb,var(--teal) 8%,transparent)"':''))+'>'+
      '<td style="text-align:left">'+escapeHtml(p.nombre)+(i===curIdx?' ★':'')+
        (p.real?'<div style="font-size:9px;color:var(--teal)">de tu nómina</div>':'')+
        (p.sentencia?'<div style="font-size:9px;color:var(--teal)">escenario sentencia</div>':'')+
        '<div class="pu-m">'+p.grupo+' N'+p.nivel+' · bruto '+eur(div(a.brutoTotal))+
          '<br>IRPF: él '+eur(div(a.irpf.cuota))+' · tú '+eur(div(y.irpf.cuota))+' (+IPT '+eur(div(y.iptAnual))+')</div></td>'+
      '<td class="pu-x" style="white-space:nowrap">'+
        '<select onchange="setPuestoCampo(\''+p.id+'\',\'grupo\',this.value)" style="font-size:10px">'+
          RET_GRUPOS.map(g=>'<option'+(g===p.grupo?' selected':'')+'>'+g+'</option>').join('')+'</select> '+
        '<input type="number" min="1" max="30" value="'+p.nivel+'" onchange="setPuestoCampo(\''+p.id+'\',\'nivel\',this.value)" style="width:38px;font-size:10px;text-align:right"></td>'+
      // compañero
      '<td class="pu-x" style="border-left:2px solid var(--border)">'+eur(div(a.brutoTotal))+'</td>'+
      '<td class="pu-x" style="color:var(--red)">−'+eur(div(a.irpf.cuota))+
        '<div style="font-size:9px;color:var(--faint)">'+(a.tipo*100).toFixed(1).replace('.',',')+'%</div></td>'+
      '<td style="font-weight:600;border-left:2px solid var(--border)">'+eur(div(a.neto))+'</td>'+
      // tú
      '<td class="pu-x" style="border-left:2px solid var(--navy)">'+eur(div(y.B.anual))+'</td>'+
      '<td class="pu-x" style="color:var(--teal)">+'+eur(div(y.iptAnual))+'</td>'+
      '<td class="pu-x" style="color:var(--red)">−'+eur(div(y.irpf.cuota))+
        '<div style="font-size:9px;color:var(--faint)">'+(y.tipo*100).toFixed(1).replace('.',',')+'%</div></td>'+
      '<td style="font-weight:700;color:var(--teal);border-left:2px solid var(--navy)">'+eur(div(y.neto))+'</td>'+
      '<td class="pos" style="font-weight:600">+'+eur(div(dif))+'</td></tr>';
  });
  h+='</tbody>';
  tb.innerHTML=h;

  // ── el desglose del puesto actual, línea a línea
  const box=document.getElementById('puestos-detalle');
  if(box){
    const a=A[curIdx], y=Y[curIdx];
    const F=y.irpf, G=a.irpf;
    const fila=(l,va,vy,sub,res)=>'<tr'+(res?' style="border-top:2px solid var(--navy);font-weight:700"':'')+'>'+
      '<td style="text-align:left">'+l+(sub?'<div style="font-size:9.5px;color:var(--faint);font-weight:400">'+sub+'</div>':'')+'</td>'+
      '<td style="color:var(--muted)">'+va+'</td><td>'+vy+'</td></tr>';
    let d='<div style="font-size:12px;font-weight:700;margin:.2rem 0 .35rem">Tu puesto, euro a euro</div>';
    d+='<div style="font-size:11.5px;color:var(--muted);margin-bottom:.45rem">'+
      escapeHtml(y.p.nombre)+'. A la izquierda, un compañero soltero, sin hijos y sin discapacidad. '+
      'A la derecha, tú. Mismo sueldo, dos declaraciones distintas.</div>';
    d+='<div class="tbl-scroll"><table class="detail-table" style="font-size:11.5px">'+
      '<thead><tr><th style="text-align:left">Concepto (al año)</th><th style="color:var(--muted)">Compañero</th><th style="color:var(--navy)">Tú</th></tr></thead><tbody>'+
      fila('Retribuciones brutas',fmt2(a.B.anual),fmt2(y.B.anual),'sueldo base, trienios, destino, específico y productividad')+
      fila('+ Tu IPT','—','<span style="color:var(--teal)">'+fmt2(y.iptAnual)+'</span>',
        pc.iptMes?fmt2(pc.iptMes)+'€ × '+(pc.iptPagas||14)+' pagas · tributa, no está exenta':'')+
      fila('<strong>= Ingresos brutos</strong>','<strong>'+fmt2(a.brutoTotal)+'</strong>','<strong>'+fmt2(y.brutoTotal)+'</strong>','')+
      fila('− Derechos pasivos y MUFACE','−'+fmt2(G.cotiz),'−'+fmt2(F.cotiz),'art. 19.2.a · iguales para los dos')+
      fila('− Otros gastos','−'+fmt2(IRPF_GASTOS),'−'+fmt2(IRPF_GASTOS),'art. 19.2.f · fijos')+
      fila('− Gastos por discapacidad','—','<span style="color:var(--teal)">−'+fmt2(y.gastosDisc)+'</span>',
        'art. 19.2.f · solo para trabajadores activos')+
      (F.red>0||G.red>0?fila('− Reducción por rendimientos del trabajo','−'+fmt2(G.red),'−'+fmt2(F.red),'art. 20'):'')+
      fila('= Base liquidable',fmt2(G.baseLiq),fmt2(F.baseLiq),'')+
      fila('Mínimo personal y familiar',fmt2(G.minEstatal),'<span style="color:var(--teal)">'+fmt2(F.minEstatal)+'</span>',
        'soltero sin hijos: 5.550€'+(F.disc?'; tú sumas '+fmt(F.disc)+'€ por tu discapacidad':''))+
      fila('<strong>IRPF del año</strong>','<span style="color:var(--red)">'+fmt2(G.cuota)+'</span>',
        '<span style="color:var(--red)">'+fmt2(F.cuota)+'</span>',
        'tipo medio: él '+(a.tipo*100).toFixed(1).replace('.',',')+'% · tú '+(y.tipo*100).toFixed(1).replace('.',',')+'%',true)+
      fila('<strong>Le queda al año</strong>',fmt2(a.neto),'<span style="color:var(--teal)">'+fmt2(y.neto)+'</span>','')+
      fila('<strong>Al mes</strong>',fmt2(a.neto/12),'<span style="color:var(--teal)">'+fmt2(y.neto/12)+'</span>','')+
      '</tbody></table></div>';

    // ── de dónde sale la diferencia
    const difTotal=y.neto-a.neto;
    const soloIpt=puestoNeto(y.p,{disc:0,conIpt:true});
    const porIpt=soloIpt.neto-a.neto;              // lo que aporta cobrar la IPT
    const porFiscal=y.neto-soloIpt.neto;           // lo que aporta la fiscalidad
    d+='<div style="background:#E8F5EE;border:1px solid #9ED4B4;border-radius:6px;padding:.55rem .65rem;font-size:11.5px;color:var(--teal);margin-top:.5rem">'+
      '<strong>Cobras '+fmt2(difTotal)+'€ más al año que él</strong> ('+fmt2(difTotal/12)+'€/mes) en el mismo puesto, y son dos cosas distintas:'+
      '<ul style="margin:.35rem 0 0 1rem;padding:0">'+
      '<li><strong>'+fmt2(porIpt)+'€</strong> porque cobras la IPT. Ojo: bruta son '+fmt2(y.iptAnual)+'€, pero al sumarse '+
        'a tu sueldo tributa en tu tramo alto, así que se te quedan '+fmt2(porIpt)+'€. '+
        'Hacienda se lleva '+fmt2(y.iptAnual-porIpt)+'€ de esa IPT, el '+
        ((y.iptAnual>0?(y.iptAnual-porIpt)/y.iptAnual*100:0)).toFixed(1).replace('.',',')+'%.</li>'+
      '<li><strong>'+fmt2(porFiscal)+'€</strong> porque tu discapacidad te baja el impuesto: '+fmt(y.gastosDisc)+
        '€ de gastos deducibles y '+fmt(IRPF_MIN_DISC[pc.discapacidad]||0)+'€ más de mínimo exento.</li>'+
      '</ul>'+
      '<div style="margin-top:.35rem;color:var(--amber)"><strong>Al jubilarte pierdes la mitad de eso.</strong> '+
      'Los '+fmt(y.gastosDisc)+'€ del art. 19.2.f son solo para <em>trabajadores activos</em>. El mínimo exento sí se '+
      'mantiene de por vida (TEAC 19-07-2024), pero los gastos no.</div></div>';
    box.innerHTML=d+_puestosExtra(A,Y,curIdx);
    markScrollables(box);
  }
}

// El resto del detalle: sentencia, retenciones y parámetros comunes
function _puestosExtra(A,Y,curIdx){
  const c=puestosCfg(), pc=pensionCfg();
  const y=Y[curIdx];
  let d='';
  // ── retención real contra impuesto real
  (function(){
    const nh=(typeof NOM_HIST==='function')?NOM_HIST():[];
    const con12=nh.filter(x=>x.nd&&x.nd.irpf_importe!=null)
      .sort((a,b)=>String(b.ym||b.date).localeCompare(String(a.ym||a.date))).slice(0,12);
    if(con12.length<6)return;
    const ret=con12.reduce((t,x)=>t+(Number(x.nd.irpf_importe)||0),0);
    const escala=ret*12/con12.length;
    const dif=y.irpf.cuota-escala;
    d+='<div style="background:'+(dif>200?'#FFF6E0':'var(--surface2)')+';border:1px solid '+
      (dif>200?'#E8C97A':'var(--border)')+';border-radius:6px;padding:.55rem .65rem;font-size:11.5px;color:'+
      (dif>200?'var(--amber)':'var(--muted)')+';margin-top:.5rem">'+
      '<strong>Lo que te retienen contra lo que de verdad debes.</strong> En tus últimas '+con12.length+
      ' nóminas te han retenido '+fmt2(ret)+'€, que a año completo son <strong>'+fmt2(escala)+'€</strong>. '+
      'El impuesto real de tu sueldo más tu IPT es <strong>'+fmt2(y.irpf.cuota)+'€</strong>.'+
      (dif>0?(' Faltan <strong>'+fmt2(dif)+'€</strong>, y eso es lo que acabas pagando en junio: no es un error de Hacienda, '+
        'es que tu pagador retiene como si la IPT no existiera. Puedes pedir en tu habilitación que te suban el tipo.')
       :(' Te sobran '+fmt2(-dif)+'€: te saldrá a devolver.'))+'</div>';
  })();
  // ── la sentencia del nivel 20
  const sent=c.lista.find(p=>p.sentencia), mio=c.lista[curIdx];
  if(sent&&mio&&!mio.sentencia){
    const rs=perfilYo(sent), rm=Y[curIdx];
    const dB=rs.brutoTotal-rm.brutoTotal, dN=rs.neto-rm.neto;
    d+='<div style="font-size:12px;font-weight:700;margin:.7rem 0 .35rem">Si te reconocieran el nivel '+sent.nivel+'</div>'+
      '<div style="background:var(--surface2);border-radius:6px;padding:.55rem .65rem;font-size:11.5px">'+
      'El complemento de destino pasa de '+fmt2(RET_CD[mio.nivel])+'€ a <strong>'+fmt2(RET_CD[sent.nivel])+'€</strong> al mes. '+
      'Con tus 14 pagas son <strong>'+fmt2(dB)+'€ brutos</strong> al año, que después de impuestos se quedan en '+
      '<strong style="color:var(--teal)">'+fmt2(dN)+'€ netos</strong> ('+fmt2(dN/12)+'€/mes). '+
      'Te quitan '+fmt2(dB-dN)+'€ por el camino: tu marginal, el '+
      ((dB>0?(dB-dN)/dB*100:0)).toFixed(1).replace('.',',')+'%.'+
      '<div style="margin-top:.35rem;color:var(--amber)"><strong>Lo que NO cambia: tu pensión.</strong> '+
      'En Clases Pasivas sale del haber regulador de tu <em>subgrupo</em>, no de tu nivel de destino. '+
      'Subir a nivel '+sent.nivel+' es más sueldo hoy y más ahorro, pero ni un euro más de pensión.</div></div>';
  }
  // ── parámetros comunes
  d+='<details style="margin-top:.6rem"><summary style="font-size:11.5px;font-weight:600;cursor:pointer">Ajustar los datos comunes a todos los puestos</summary>'+
    '<div style="display:flex;flex-wrap:wrap;gap:.45rem .9rem;font-size:11.5px;margin-top:.4rem">'+
    '<label>Trienios <input type="text" value="'+fmt2(c.trienios)+'" onchange="setPuestoCfg(\'trienios\',this.value)" style="width:60px;font-size:11px;text-align:right">€/mes</label>'+
    '<label>Productividad <input type="text" value="'+fmt2(c.prodMes)+'" onchange="setPuestoCfg(\'prodMes\',this.value)" style="width:56px;font-size:11px;text-align:right">€/mes</label>'+
    '<label>+ variable anual <input type="text" value="'+fmt2(c.prodExtraAnio)+'" onchange="setPuestoCfg(\'prodExtraAnio\',this.value)" style="width:60px;font-size:11px;text-align:right">€</label>'+
    '<label>Específico en pagas extra <input type="text" value="'+(c.factorCE*100).toFixed(2)+'" onchange="setPuestoCfg(\'factorCE\',(parseFloat(String(this.value).replace(\',\',\'.\'))||0)/100)" style="width:52px;font-size:11px;text-align:right">%</label>'+
    '</div>'+
    '<div style="font-size:11px;color:var(--muted);margin-top:.45rem;line-height:1.55">'+
    'Los dos perfiles comparten sueldo, trienios, productividad y cotizaciones: lo único que cambia es que tú cobras la IPT '+
    'y tienes discapacidad reconocida. El compañero se calcula como <strong>declaración individual, soltero, sin hijos y '+
    'sin ninguna otra renta</strong>; si el tuyo tiene hijos o vivienda, su neto sería otro.'+
    '<br><br>Los <strong>trienios</strong> conservan el valor del grupo en que se ganaron: pon lo que cobras al mes por todos. '+
    'El <strong>'+(c.factorCE*100).toFixed(2)+'%</strong> del específico en las pagas extra se deduce de la nómina de junio. '+
    'Los <strong>complementos específicos</strong> de los demás puestos están deducidos de la tabla que traía la app y '+
    'actualizados a 2026; el tuyo es el real. Sueldo base, trienios y complemento de destino son las tablas oficiales de 2026 '+
    '(RD-ley 14/2025) y cuadran con tu nómina al céntimo.</div></details>';
  return d;
}

function setTab(t){
  ['dash','entrada','hist','vista','analisis','ahorro','puestos','viv'].forEach(id=>{
    document.getElementById('panel-'+id)?.classList.toggle('active',id===t);
    document.getElementById('tab-'+id)?.classList.toggle('active',id===t);
  });
  if(t==='entrada'){loadMonthEntries();renderFormLists();renderGastosList();renderFijosList();renderTxIngList();renderStockTxList();applySectionVisuals();renderBankCutoff();renderReembolsos();renderRecatPanel();renderDegiroPanel();}
  if(t==='vista'){initVistaMes();}
  if(t==='analisis'){renderAnalisis();}
  if(t==='ahorro'){renderAhorro();}
  if(t==='puestos'){renderPuestos();}
  if(t==='viv'){try{renderVivienda();}catch(e){console.warn('vivienda',e);}}
  if(t==='analisis'){try{renderPrecios();}catch(e){console.warn('precios',e);}}
}
function togglePanel(id,forceClose){
  const p=document.getElementById(id);if(!p)return;
  if(forceClose)p.classList.remove('open'); else p.classList.toggle('open');
}


let toastT;
function toast(msg){
  const el=document.getElementById('toast');el.textContent=msg;el.classList.add('show');
  clearTimeout(toastT);toastT=setTimeout(()=>el.classList.remove('show'),2400);
}

// ═══════════════════════════════════════════════════════════════════════
// NÓMINA BREAKDOWN
// ═══════════════════════════════════════════════════════════════════════
function toggleNomina(){
  const btn=document.getElementById('nom-toggle-btn');
  const box=document.getElementById('nom-box');
  btn.classList.toggle('open');box.classList.toggle('open');
  // Render concept lists on first open if empty
  if(box.classList.contains('open')&&!_nominaDev.length&&!_nominaDed.length){
    resetNominaConcepts();
  }
  renderNominaConcepts();
}

// Default concepts (editable, removable, extensible)
const DEF_NOM_DEV=['Salario base','C. Destino','C. Específico','Trienios','Prod. Objetivos a cuenta','Productividad por Objetivos','Productividad Remanente','C. Esp. Adicional','Horas extras','Otros devengos'];
const DEF_NOM_DED=['MUFACE','Derechos Pasivos','Prorrateo IRPF','Anticipo','Otras deducciones'];
let _nominaDev=[]; // [{id,name,amount}]
let _nominaDed=[];

function resetNominaConcepts(){
  _nominaDev=DEF_NOM_DEV.map((nm,i)=>({id:'nd_'+i,name:nm,amount:0}));
  _nominaDed=DEF_NOM_DED.map((nm,i)=>({id:'nx_'+i,name:nm,amount:0}));
}

// Modal genérico de solo lectura
function showModal(title,html){
  let ov=document.getElementById('dlv-modal');
  if(!ov){
    ov=document.createElement('div');ov.id='dlv-modal';
    ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
    ov.onclick=e=>{if(e.target===ov)ov.remove();};
    document.body.appendChild(ov);
  }
  ov.innerHTML='<div style="background:var(--surface,#fff);border-radius:12px;max-width:440px;width:100%;max-height:85vh;overflow:auto;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.25)">'+
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">'+
    '<div style="font-weight:700;color:var(--navy)">'+title+'</div>'+
    '<button onclick="document.getElementById(\'dlv-modal\').remove()" style="border:none;background:none;font-size:22px;cursor:pointer;color:var(--muted);line-height:1">×</button></div>'+html+'</div>';
}
// Consulta de solo lectura del desglose de una nómina
function viewNominaDesglose(entryId){
  const e=incomeLog.find(x=>x.id===entryId);
  if(!e||!e.nd){toast('Esta entrada no tiene desglose');return;}
  const nd=e.nd;
  const row=(name,amount,neg)=>'<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:12.5px"><span>'+name+'</span><span class="'+(neg?'neg':'pos')+'">'+(neg?'−':'')+fmt2(amount)+'€</span></div>';
  const sub=t=>'<div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:.55rem 0 .15rem">'+t+'</div>';
  let html=(nd.devengos||[]).length?sub('Devengos')+(nd.devengos||[]).map(c=>row(c.name,c.amount,false)).join(''):'';
  html+='<div style="display:flex;justify-content:space-between;padding:3px 0;border-top:1px solid var(--border);font-weight:600;margin-top:3px;font-size:12.5px"><span>Total devengado</span><span class="pos">'+fmt2(nd.total_dev||0)+'€</span></div>';
  html+=sub('Deducciones'+(nd.irpf_pct?' · IRPF '+nd.irpf_pct+'%':''));
  html+=(nd.deducciones||[]).map(c=>row(c.name,c.amount,true)).join('');
  html+='<div style="display:flex;justify-content:space-between;padding:3px 0;border-top:1px solid var(--border);font-weight:600;margin-top:3px;font-size:12.5px"><span>Total deducciones</span><span class="neg">−'+fmt2(nd.total_ded||0)+'€</span></div>';
  html+='<div style="display:flex;justify-content:space-between;padding:7px 0 2px;border-top:2px solid var(--navy);font-weight:700;font-size:14px;margin-top:6px"><span>Líquido percibido</span><span class="pos">'+fmt2(e.amt||0)+'€</span></div>';
  showModal((e.desc||'Nómina')+' · '+(e.date||''),html);
}
// Carga un desglose de nómina guardado (nd) en el formulario, para editarlo/verlo
function loadNominaData(nd){
  const el=id=>document.getElementById(id);
  if(nd&&(nd.devengos||nd.deducciones)){
    _nominaDev=(nd.devengos||[]).map((c,i)=>({id:'nd_'+i,name:c.name,amount:c.amount||0}));
    // Las deducciones IRPF van al campo IRPF aparte; el resto (MUFACE, D. Pasivos…) a la lista
    _nominaDed=(nd.deducciones||[]).filter(c=>!/i\.?\s*r\.?\s*p\.?\s*f|irpf|retenci/i.test(c.name||''))
      .map((c,i)=>({id:'nx_'+i,name:c.name,amount:c.amount||0}));
    if(el('n-irpf-pct'))el('n-irpf-pct').value=nd.irpf_pct||0;
    if(el('n-irpf-imp'))el('n-irpf-imp').value=(nd.irpf_importe||0).toFixed(2);
  } else { resetNominaConcepts(); }
  // Abrir el panel
  const btn=el('nom-toggle-btn'), box=el('nom-box');
  if(btn)btn.classList.add('open'); if(box)box.classList.add('open');
  renderNominaConcepts();
  // Refresco de display SIN recalcular el IRPF desde el % (preserva el importe real)
  const totalDev=_nominaDev.reduce((s,c)=>s+(c.amount||0),0);
  const irpfImp=(nd&&nd.irpf_importe)||0;
  const otherDed=_nominaDed.reduce((s,c)=>s+(c.amount||0),0);
  const totalDed=irpfImp+otherDed;
  if(el('n-total-dev'))el('n-total-dev').textContent=fmt(totalDev)+'€';
  if(el('n-total-ded'))el('n-total-ded').textContent=fmt(totalDed)+'€';
  if(el('n-liq'))el('n-liq').textContent=fmt(totalDev-totalDed)+'€';
}

function renderNominaConcepts(){
  const mk=(arr,kind)=>arr.map(c=>
    '<div style="display:flex;align-items:center;gap:.4rem;margin-bottom:4px">'+
      '<input type="text" value="'+(c.name||'').replace(/"/g,'&quot;')+'" placeholder="Concepto" '+
        'style="flex:1;min-width:80px;font-size:11.5px;padding:4px 6px;border:1px solid var(--border);border-radius:var(--r-xs)" '+
        'onchange="updateNominaConcept(\''+kind+'\',\''+c.id+'\',\'name\',this.value)">'+
      '<input type="number" value="'+(c.amount||'')+'" placeholder="0" step="0.01" '+
        'style="width:90px;font-size:11.5px;padding:4px 6px;border:1px solid var(--border);border-radius:var(--r-xs)" '+
        'oninput="updateNominaConcept(\''+kind+'\',\''+c.id+'\',\'amount\',this.value)">'+
      '<button type="button" class="btn-xs danger" style="flex-shrink:0" '+
        'onclick="removeNominaConcept(\''+kind+'\',\''+c.id+'\')">✕</button>'+
    '</div>'
  ).join('');
  const dl=document.getElementById('nom-devengos-list');
  const xl=document.getElementById('nom-deduc-list');
  if(dl)dl.innerHTML=mk(_nominaDev,'dev');
  if(xl)xl.innerHTML=mk(_nominaDed,'ded');
  calcNomina();
}

function addNominaConcept(kind){
  const arr=kind==='dev'?_nominaDev:_nominaDed;
  arr.push({id:(kind==='dev'?'nd_':'nx_')+Date.now(),name:'',amount:0});
  renderNominaConcepts();
}
function removeNominaConcept(kind,id){
  if(kind==='dev')_nominaDev=_nominaDev.filter(c=>c.id!==id);
  else _nominaDed=_nominaDed.filter(c=>c.id!==id);
  renderNominaConcepts();
}
function updateNominaConcept(kind,id,field,val){
  const arr=kind==='dev'?_nominaDev:_nominaDed;
  const c=arr.find(x=>x.id===id);
  if(!c)return;
  if(field==='name')c.name=val;
  else c.amount=parseFloat(val)||0;
  calcNomina();
}

function calcNomina(){
  const totalDev=_nominaDev.reduce((s,c)=>s+(c.amount||0),0);
  const irpfPct=n('n-irpf-pct');
  let irpfImp=parseFloat(document.getElementById('n-irpf-imp')?.value)||0;
  // If user typed a %, compute the IRPF amount from it (unless they typed an explicit importe)
  if(irpfPct>0){irpfImp=Math.round(totalDev*irpfPct/100*100)/100;}
  const otherDed=_nominaDed.reduce((s,c)=>s+(c.amount||0),0);
  const totalDed=irpfImp+otherDed;
  const liq=totalDev-totalDed;

  const el=id=>document.getElementById(id);
  if(el('n-irpf-imp')&&irpfPct>0)el('n-irpf-imp').value=irpfImp.toFixed(2);
  if(el('n-total-dev'))el('n-total-dev').textContent=fmt(totalDev)+'€';
  if(el('n-total-ded'))el('n-total-ded').textContent=fmt(totalDed)+'€';
  if(el('n-liq'))el('n-liq').textContent=fmt(liq)+'€';
  if(el('fi-nom'))el('fi-nom').value=liq.toFixed(2);
  calcSummary();
}

function getNominaData(){
  const irpfImp=parseFloat(document.getElementById('n-irpf-imp')?.value)||0;
  // Map known concept names to legacy fields for the Impuestos card
  const findAmt=(arr,name)=>arr.find(c=>(c.name||'').toLowerCase().includes(name))?.amount||0;
  return{
    total_dev:_nominaDev.reduce((s,c)=>s+(c.amount||0),0),
    total_ded:_nominaDed.reduce((s,c)=>s+(c.amount||0),0)+irpfImp,
    devengos:_nominaDev.map(c=>({name:c.name,amount:c.amount})),
    deducciones:_nominaDed.map(c=>({name:c.name,amount:c.amount})),
    irpf_pct:n('n-irpf-pct'),irpf_importe:irpfImp,
    // Legacy fields (used by Impuestos card)
    s_base:findAmt(_nominaDev,'salario'),
    muface:findAmt(_nominaDed,'muface'),
    c_pasivas:findAmt(_nominaDed,'pasiv'),
    prorr:findAmt(_nominaDed,'prorrateo'),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// IMPUESTOS DASHBOARD CARD
// ═══════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// v130 · LAS TRES FICHAS DEL DASHBOARD LEÍAN DEL SITIO EQUIVOCADO
// ════════════════════════════════════════════════════════════════════
// Impuestos decía "introduce nóminas con el formulario" teniendo veintiuna
// cargadas, y el análisis de gastos salía en blanco con 1.034 gastos
// apuntados. Las dos miraban `records` —los registros mensuales guardados—
// en vez de los datos reales. Y el último registro guardado es de enero de
// 2026, así que el dashboard llevaba siete meses enseñando el vacío.
// Es el mismo patrón que ya arreglamos en saldos y en flujos: dos fuentes
// para la misma pregunta y la pantalla cogiendo la que no era.

// El nombre legible de una categoría, sean las de serie o las tuyas.
function catNombre(c){
  if(!c)return 'Sin clasificar';
  if(typeof CAT_LABELS!=='undefined'&&CAT_LABELS[c])return CAT_LABELS[c];
  const cc=(cfg.customCats||{})[c];
  return cc?cc:String(c);
}
// Gastos de un mes, agrupados por categoría, desde el registro real de gastos.
function gastosMes(ym){
  const _ce=(typeof compExpenseIds==='function')?compExpenseIds():new Set();
  const porCat={}; const lista=[];
  let total=0;
  (typeof expenseLog!=='undefined'?expenseLog:[]).forEach(x=>{
    if(String(x.date||'').slice(0,7)!==ym)return;
    if(_ce.has(x.id))return;
    const dev=(typeof pendDev==='function')?(Number(pendDev(x))||0):0;
    const v=Math.max(0,(Number(x.amt)||0)-dev);
    if(v<=0)return;
    const c=x.cat||'otro';
    porCat[c]=(porCat[c]||0)+v;
    lista.push({name:x.name||'(sin concepto)',amt:v,cat:c,date:x.date});
    total+=v;
  });
  const cats=Object.entries(porCat).map(([c,v])=>({cat:c,nombre:catNombre(c),v}))
    .sort((a,b)=>b.v-a.v);
  lista.sort((a,b)=>b.amt-a.amt);
  return {ym,total:Math.round(total*100)/100,cats,lista};
}

// ── Retenciones e impuestos del año, desde las nóminas de verdad ─────
function impuestosAnio(anio){
  anio=Number(anio);
  const H=((typeof NOM_HIST==='function')?NOM_HIST():[])
    .filter(n=>String(n.ym||'').slice(0,4)===String(anio))
    .sort((a,b)=>String(a.ym).localeCompare(String(b.ym)));
  const trozo=nm=>{
    const nd=nm.nd||{}, ded=nd.deducciones||[];
    const busca=re=>ded.filter(d=>re.test(String(d.name||'').toLowerCase()))
      .reduce((s,d)=>s+(Number(d.amount)||0),0);
    return {irpf:Number(nd.irpf_importe)||0,
      muface:busca(/muface/), pasivas:busca(/pasiv|clases/),
      otras:Math.max(0,(Number(nd.total_ded)||0)-(Number(nd.irpf_importe)||0)-busca(/muface/)-busca(/pasiv|clases/)),
      dev:Number(nd.total_dev)||0};
  };
  const cero={irpf:0,muface:0,pasivas:0,otras:0,dev:0};
  const suma=(a,b)=>({irpf:a.irpf+b.irpf,muface:a.muface+b.muface,pasivas:a.pasivas+b.pasivas,
    otras:a.otras+b.otras,dev:a.dev+b.dev});
  const acum=H.reduce((a,n)=>suma(a,trozo(n)),cero);
  const ultimo=H.length?H[H.length-1]:null;
  const mes=ultimo?trozo(ultimo):cero;
  // retención de intereses y dividendos declarada en la ficha fiscal
  const fc=(typeof fiscalCfg==='function')?fiscalCfg():{};
  const K=(typeof fiscalCapMob==='function')?fiscalCapMob(anio):{cobrado:0,total:0};
  const retCap=(Number(K.retEs)||0)+(Number(K.sinDato)||0)*((fc.capRetPct==null?19:Number(fc.capRetPct)||0)/100);
  acum.rendRet=retCap; acum.rendBruto=K.cobrado||0;
  mes.rendRet=0; mes.rendBruto=0;
  acum.total=acum.irpf+acum.muface+acum.pasivas+acum.otras+acum.rendRet;
  mes.total=mes.irpf+mes.muface+mes.pasivas+mes.otras;
  return {anio,meses:H.length,mes,acum,
    etiquetaMes:ultimo?(ultimo.desc||ultimo.ym):null, hay:H.length>0};
}

// ── Calendario fiscal: solo lo que está por venir ────────────────────
// Antes listaba el inicio y el fin de la campaña de la Renta del año pasado
// aunque ya hubieran pasado. Lo pasado no sirve para nada aquí: esta ficha
// existe para que no te pille ningún pago por sorpresa. Ahora junta los
// plazos del IRPF que la app ya calcula, los recibos que se repiten (IBI,
// basura, agua, seguros) con su importe y su fecha aproximada, y las fechas
// del calendario tributario que todavía no han pasado.
function calendarioFiscal(){
  const hoy=todayISO();
  const ev=[];
  const push=(fecha,titulo,nota,imp,tipo)=>{
    if(!fecha||fecha<hoy)return;
    ev.push({fecha,titulo,nota:nota||'',imp:(imp==null?null:Math.round(imp*100)/100),tipo});
  };
  // 1 · lo que la app ya sabe que vas a pagar a Hacienda
  try{
    (typeof fiscalPrevisiones==='function'?fiscalPrevisiones():[]).forEach(p=>{
      push(p.fecha,p.concepto,p.nota||'',Number(p.importe)||0,'irpf');
    });
  }catch(e){fallo('motor',e)}
  // 2 · recibos que se repiten: IBI, basura, seguros, agua…
  try{
    // La declaración de la Renta ya viene calculada de las previsiones. Si
    // además la colásemos aquí como "recibo que se repite", saldría tres veces:
    // el cargo de junio, el de julio y el segundo plazo, cada uno detectado
    // como un recibo distinto. Se filtran, salvo SUMA, que es el IBI y la
    // basura del ayuntamiento y sí es un recibo de verdad.
    const ES_RENTA=/(agencia\s+(estatal\s+)?(de\s+la\s+)?admin|agencia\s+tributaria|^tributo\b|\baeat\b|autoliquidac)/i;
    (typeof detectReceipts==='function'?detectReceipts():[]).forEach(r=>{
      const nm=String(r.name||'');
      if(ES_RENTA.test(nm)&&!/suma/i.test(nm))return;
      const esTributo=/\bibi\b|tributaria|hacienda|suma gesti|impuesto|catastro|\bitv\b|\btasa\b|basura|vado|diputaci/i.test(nm);
      push(r.next, nm.slice(0,38),
        r.label.toLowerCase()+' · último cargo '+fmtDate(r.lastDate)+' de '+fmt2(r.lastAmt)+'€',
        r.avgAmt, esTributo?'tributo':'recibo');
    });
  }catch(e){fallo('motor',e)}
  // 3 · fechas del calendario tributario que aún no han pasado
  const y=Number(hoy.slice(0,4));
  [[y,3,2,'Se abre la campaña de la Renta '+(y-1),'Desde primeros de abril ya se puede presentar','campana'],
   [y,5,30,'Último día para presentar la Renta '+(y-1),'Si domicilias, el cargo del primer plazo es ese mismo día','campana'],
   [y,10,5,'Segundo plazo de la Renta (40%)','Solo si fraccionaste el pago en junio','campana'],
   [y,11,31,'Cierre fiscal '+y,'Último día para aflorar pérdidas que compensen tus plusvalías del año','campana']
  ].forEach(([yy,mm,dd,t,n,tp])=>{
    push(yy+'-'+String(mm+1).padStart(2,'0')+'-'+String(dd).padStart(2,'0'),t,n,null,tp);
  });
  // el mismo calendario del año que viene, para que junio no aparezca vacío en otoño
  [[y+1,3,2,'Se abre la campaña de la Renta '+y,'Desde primeros de abril','campana'],
   [y+1,5,30,'Último día para presentar la Renta '+y,'','campana']
  ].forEach(([yy,mm,dd,t,n,tp])=>{
    push(yy+'-'+String(mm+1).padStart(2,'0')+'-'+String(dd).padStart(2,'0'),t,n,null,tp);
  });
  ev.sort((a,b)=>a.fecha.localeCompare(b.fecha));
  // Las fechas genéricas del calendario tributario sobran si ya hay una
  // previsión tuya con importe para esos días: la tuya lleva la cifra.
  const conImporte=ev.filter(e=>e.tipo==='irpf');
  const out=[], vistos=new Set();
  ev.forEach(e=>{
    if(e.tipo==='campana'&&conImporte.some(x=>Math.abs(Date.parse(x.fecha)-Date.parse(e.fecha))<=10*864e5))return;
    const k=e.fecha+'|'+e.titulo.toLowerCase().slice(0,14);
    if(vistos.has(k))return; vistos.add(k); out.push(e);
  });
  return out;
}

function renderImpuestos(){
  const td=getTaxData();
  // v130 · las nóminas viven en personal.nominasHist, no en los registros
  // mensuales. Preguntando a `records` esta ficha decía que no había ninguna
  // teniendo veintiuna cargadas.
  const IA=impuestosAnio(new Date().getFullYear());
  const hasNomData=IA.hay;

  // Header
  const lbl=document.getElementById('tax-period-label');
  if(lbl)lbl.textContent='Año '+IA.anio+' · '+IA.meses+' nómina'+(IA.meses===1?'':'s')+' cargada'+(IA.meses===1?'':'s');

  const taxRows=(data,title)=>`
    <div class="tax-block">
      <div class="tax-block-title">${title}</div>
      ${[
        ['IRPF retenido nómina',data.irpf],
        ['MUFACE',data.muface],
        ['Derechos Pasivos / Clases Pasivas',data.c_pasivas],
        ['Prorrateo IRPF pagas extra',data.prorr],
        ['Retención rendimientos capital',data.rend_ret||0],
      ].map(([l,v])=>`<div class="tax-row"><span class="lbl">${l}</span><span class="${v>0?'neg':''}">${v>0?fmt(v)+'€':'—'}</span></div>`).join('')}
      ${(data.rend_bruto||0)>0?`<div class="tax-row" style="font-size:11px"><span class="lbl" style="color:var(--teal)">Rendimientos brutos (capital mobiliario)</span><span class="pos">${fmt(data.rend_bruto)}€</span></div>`:''}
      <div class="tax-row"><span>Total retenciones</span><span class="neg"><strong>${fmt(data.total)}€</strong></span></div>
    </div>`;

  const grid=document.getElementById('tax-grid');
  if(grid){
    if(hasNomData){
      const mapa=x=>({irpf:x.irpf,muface:x.muface,c_pasivas:x.pasivas,prorr:x.otras,
        rend_ret:x.rendRet||0,rend_bruto:x.rendBruto||0,total:x.total});
      grid.innerHTML=taxRows(mapa(IA.mes),'Última nómina'+(IA.etiquetaMes?' ('+escapeHtml(String(IA.etiquetaMes))+')':''))+
        taxRows(mapa(IA.acum),'Acumulado '+IA.anio);
    } else {
      grid.innerHTML=`<div class="tax-block" style="grid-column:1/-1">
        <p style="color:var(--faint);font-size:12px;text-align:center;padding:.5rem">
          Introduce nóminas con el formulario de entrada para ver aquí los datos fiscales desglosados.
        </p>
      </div>`;
    }
  }

  // Stock IRPF projection — use ALL sell transactions regardless of whether month record saved
  const projBox=document.getElementById('tax-proj-box');
  if(projBox){
    const nowY=new Date().getFullYear();
    const prevY=nowY-1;

    // Compute IRPF summary for a given year from sell transactions (FIFO gains)
    function yearIRPF(year){
      const sells=transactions.filter(function(t){
        if(t.type!=='sell')return false;
        const ty=t.year||(t.date?parseInt(t.date.slice(0,4)):null);
        return ty===year;
      });
      const totalGain=sells.reduce((s,t)=>s+(t.gainLoss??0),0);
      const gainPos=Math.max(0,totalGain);
      const lossNeg=Math.min(0,sells.reduce((s,t)=>s+Math.min(0,t.gainLoss??0),0));
      const irpf=calcIRPFGain(gainPos);
      const effRate=gainPos>0?Math.round(irpf/gainPos*100):0;
      return {year,sells,totalGain,gainPos,lossNeg,irpf,effRate};
    }

    const prev=yearIRPF(prevY);
    const cur=yearIRPF(nowY);

    // Operation rows for a year
    function opTable(sum){
      if(!sum.sells.length)return '<p style="font-size:11.5px;color:var(--muted);padding:.25rem 0">Sin ventas registradas en '+sum.year+'.</p>';
      const rows=sum.sells.map(function(t){
        const sname=t.stockName||(cfg.stocks.find(s=>s.id===t.stockId)||{}).name||t.stockId||'?';
        const gl=t.gainLoss??0,cb=t.costBasis??0;
        return '<tr>'+
          '<td style="padding-left:0">'+sname+(t.date?' <small style="color:var(--faint)">'+fmtDate(t.date)+'</small>':'')+'</td>'+
          '<td style="text-align:right"><small style="color:var(--faint)">venta '+fmt(t.total||0)+'€ · coste '+fmt(cb)+'€</small></td>'+
          '<td style="text-align:right"><strong class="'+(gl>=0?'pos':'neg')+'">'+(gl>=0?'+':'')+fmt(gl)+'€</strong></td>'+
        '</tr>';
      }).join('');
      const rowsHtml='<table style="width:100%;border-collapse:collapse;font-size:11.5px;margin-bottom:.25rem">'+
        '<tr style="color:var(--muted);font-size:10px"><td>Operación</td><td style="text-align:right">Detalle</td><td style="text-align:right">P/L</td></tr>'+
        rows+'</table>';
      if(sum.sells.length<=6) return rowsHtml;
      const cid='coll-plus-'+sum.year;
      return '<div class="coll-head" onclick="toggleColl(\''+cid+'\')" style="padding:.35rem .5rem">'+
          '<span style="font-size:11.5px;font-weight:600">Ver '+sum.sells.length+' operaciones</span>'+
          '<span class="coll-arr" id="'+cid+'-arr">▾</span></div>'+
        '<div id="'+cid+'" style="display:none;margin-top:.3rem">'+rowsHtml+'</div>';
    }

    // Summary block for a year
    function yearBlock(sum,payNote,highlight){
      return '<div style="background:'+(highlight?'#FEF5E0':'var(--surface2)')+';border:1px solid '+(highlight?'#E0C060':'var(--border)')+';border-radius:var(--r-sm);padding:.625rem .75rem;margin-bottom:.625rem">'+
        '<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:.25rem">'+
          '<strong style="font-size:12.5px;color:var(--navy)">Plusvalías '+sum.year+'</strong>'+
          '<span style="font-size:11px;color:var(--muted)">'+payNote+'</span>'+
        '</div>'+
        '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:.25rem;flex-wrap:wrap;gap:.5rem">'+
          '<span style="font-size:12.5px">Plusvalía neta: <strong class="'+(sum.totalGain>=0?'pos':'neg')+'">'+(sum.totalGain>=0?'+':'')+fmt(sum.totalGain)+'€</strong>'+
            ' <small style="color:var(--faint)">('+sum.sells.length+' op.)</small></span>'+
          '<span style="font-size:13px">IRPF: <strong class="neg">'+fmt(sum.irpf)+'€</strong>'+
            (sum.gainPos>0?' <small style="color:var(--faint)">('+sum.effRate+'%)</small>':'')+'</span>'+
        '</div>'+
        (sum.lossNeg<0?'<div style="font-size:11px;color:var(--muted);margin-top:.2rem">Minusvalías: <strong class="neg">'+fmt(sum.lossNeg)+'€</strong> (compensables 4 años)</div>':'')+
        '<div style="margin-top:.4rem">'+opTable(sum)+'</div>'+
      '</div>';
    }

    const totalPending=prev.irpf+cur.irpf;
    projBox.innerHTML=
      '<div class="proj-tax-title">IRPF por plusvalías de acciones</div>'+
      '<div style="background:var(--navy);color:#fff;border-radius:var(--r-sm);padding:.625rem .875rem;margin-bottom:.75rem">'+
        '<div style="font-size:11px;opacity:.85;text-transform:uppercase;letter-spacing:.05em">Total IRPF pendiente por plusvalías</div>'+
        '<div style="font-size:22px;font-weight:700;margin:.1rem 0">'+fmt(totalPending)+'€</div>'+
        '<div style="font-size:10.5px;opacity:.8">'+prevY+' ('+fmt(prev.irpf)+'€, se paga en la Renta de '+nowY+') + '+nowY+' ('+fmt(cur.irpf)+'€, se paga en '+(nowY+1)+')</div>'+
      '</div>'+
      yearBlock(prev,'⚠ A pagar en la Renta de '+nowY,true)+
      yearBlock(cur,'Se pagará en la Renta de '+(nowY+1),false)+
      '<p style="font-size:10.5px;color:var(--faint);margin-top:.25rem">'+
        'Coste de adquisición calculado por FIFO. Estimación orientativa según tramos del ahorro IRPF. '+
        'Las minusvalías compensan plusvalías del mismo año y, el resto, en los 4 años siguientes. Consulta con tu asesor fiscal.</p>';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VISTA MES — read-only view of a selected month
// ═══════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════
// CONSULTAS — rango de fechas con sumatorios
// ═══════════════════════════════════════════════════════════════════════
function initVistaMes(){
  // Default range: current month
  if(!document.getElementById('q-from').value){ setQuickRange('mes'); }
  else runConsulta();
}

function setQuickRange(which){
  const t=new Date();
  const y=t.getFullYear(),m=t.getMonth()+1;
  const pad=n=>String(n).padStart(2,'0');
  let from,to;
  if(which==='mes'){from=y+'-'+pad(m)+'-01';to=y+'-'+pad(m)+'-'+pad(new Date(y,m,0).getDate());}
  else if(which==='anio'){from=y+'-01-01';to=y+'-12-31';}
  else if(which==='anterior'){from=(y-1)+'-01-01';to=(y-1)+'-12-31';}
  else {from='2019-01-01';to=y+'-12-31';}
  document.getElementById('q-from').value=from;
  document.getElementById('q-to').value=to;
  runConsulta();
}

function runConsulta(){
  const from=document.getElementById('q-from')?.value||'';
  const to=document.getElementById('q-to')?.value||'';
  const cnt=document.getElementById('consulta-content');
  if(!cnt)return;
  if(!from||!to){cnt.innerHTML='<div class="vista-empty">Elige fecha desde y hasta</div>';return;}
  const inRange=d=>d&&d>=from&&d<=to;
  const _ci=compIncomeIds(),_ce=compExpenseIds();

  // Income
  const inc=incomeLog.filter(e=>inRange(e.date)&&!_ci.has(e.id)).sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  const incByCat={};
  inc.forEach(e=>{incByCat[e.cat]=(incByCat[e.cat]||0)+e.amt;});
  const totInc=inc.reduce((s,e)=>s+e.amt,0);

  // Expenses
  const exp=expenseLog.filter(e=>inRange(e.date)&&!_ce.has(e.id)).sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  const expFijos=exp.filter(e=>e.kind==='fijo');
  const expEst=exp.filter(e=>e.kind==='estructural');
  const expOcio=exp.filter(e=>e.kind==='ocio');
  const sum=arr=>arr.reduce((s,e)=>s+e.amt,0);
  const totFijos=sum(expFijos),totEst=sum(expEst),totOcio=sum(expOcio);
  // v126 · el total NO es la suma de los tres bloques: un gasto sin clasificar
  // se quedaba fuera, y lo que te tienen que devolver se contaba como gasto
  // tuyo. Mismo criterio que en Ahorro y en el dashboard.
  const totExp=exp.reduce((s,e)=>{
    const dev=(typeof pendDev==='function')?(Number(pendDev(e))||0):0;
    return s+Math.max(0,(Number(e.amt)||0)-dev);
  },0);

  // Stock operations in range
  const stkOps=transactions.filter(t=>(t.type==='buy'||t.type==='sell')&&inRange(t.date))
    .sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  // v128 · OJO con el nombre: esto son SOLO las plusvalías afloradas al vender.
  // La ganancia del bloque de acciones en Análisis incluye además lo que han
  // subido o bajado las que sigues teniendo, así que son dos números distintos
  // midiendo cosas distintas y ninguno está mal. Los nombres lo dicen.
  const realizedPL=stkOps.filter(t=>t.type==='sell').reduce((s,t)=>s+(t.gainLoss||0),0);

  // Fund contributions in range
  const aports=transactions.filter(t=>t.type==='fund_aport'&&inRange(t.date));
  const totAport=aports.reduce((s,t)=>s+(t.amount||0),0);

  const ahorro=totInc-totExp;

  const ING_CAT={nomina:'Nómina',ipt:'IPT/Pensión',dividendo:'Dividendo',rend:'Rendimiento',extra:'Extraordinario',otro2:'Otro'};
  const card=(l,v,c,sub)=>'<div class="vista-sum-card"><div class="vista-sum-lbl">'+l+'</div><div class="vista-sum-val" style="color:'+c+'">'+fmt(v)+'€</div>'+
    (sub?'<div style="font-size:10px;color:var(--muted);margin-top:.2rem;line-height:1.4">'+sub+'</div>':'')+'</div>';

  const listRows=(arr,fmtRow)=>arr.length?arr.map(fmtRow).join(''):'<div class="vista-row"><span class="lbl" style="color:var(--faint)">Ninguno en el rango</span></div>';

  const CR=(typeof crecimientoPeriodo==='function')?crecimientoPeriodo(from,to):null;
  // v138 · Lo que vendes con ganancia no es todo tuyo: nadie retiene al vender,
  // pero el IRPF del ahorro se debe desde ese mismo día y se paga en la
  // declaración del año siguiente. Aquí va ya descontado.
  const PV=(typeof plusvaliasNetas==='function')
    ? plusvaliasNetas(stkOps.filter(t=>t.type==='sell'))
    : {bruto:realizedPL,irpf:0,neto:realizedPL,tipo:0};
  let html='<div class="vista-summary-grid">'+
    card('Ingresos',totInc,'var(--teal)')+
    card('Gastos',totExp,'var(--red)')+
    card('Ahorro (ing−gas)',ahorro,ahorro>=0?'var(--navy)':'var(--red)')+
    card('Aportaciones fondos',totAport,'var(--purple)')+
    (CR&&CR.fondos?card('Revalorización de fondos',Math.round(CR.fondos.ben),
        CR.fondos.ben>=0?'var(--purple)':'var(--red)',
        'lo que han subido solos, sin contar lo que metiste'):'')+
    (stkOps.some(t=>t.type==='sell')?card('Plusvalías realizadas, ya sin el IRPF',Math.round(PV.neto),
        PV.neto>=0?'var(--teal)':'var(--red)',
        PV.irpf>0
          ? 'bruto '+fmt(Math.round(PV.bruto))+'€ − '+fmt(Math.round(PV.irpf))+'€ de IRPF ('+
            (PV.tipo*100).toFixed(1).replace('.',',')+'%)'
          : (PV.bruto<0?'en pérdidas: no pagas y compensan futuras ganancias':'sin IRPF que pagar')):'')+
    (CR?card('Ha crecido tu dinero',CR.total,CR.total>=0?'var(--gold)':'var(--red)'):'')+
  '</div>';
  // qué parte del ahorro no se va a repetir
  if(typeof ahorroExtraNota==='function'){
    const M=_mesesDe(from,to);
    const nota=ahorroExtraNota(M.f,M.t,{siempre:true});
    if(nota)html+='<div style="font-size:11.5px;color:var(--muted);margin:.1rem 0 .5rem;padding:.4rem .55rem;'+
      'background:var(--surface);border:1px dashed var(--line);border-radius:7px">'+nota+'</div>';
  }
  // de qué se compone lo que ha crecido
  if(CR){
    const sg=v=>(v>=0?'+':'−')+fmt(Math.abs(Math.round(v)))+'€';
    html+='<div style="font-size:11.5px;color:var(--muted);margin:.1rem 0 .5rem;padding:.45rem .55rem;'+
      'background:var(--surface);border:1px dashed var(--line);border-radius:7px">'+
      '<strong>Ha crecido tu dinero '+sg(CR.total)+'</strong> = ahorro '+sg(CR.aho)+
      ' + plusvalías realizadas al vender acciones '+sg(CR.plus)+
      (PV.irpf>0?' <span style="color:var(--amber)">(de las que '+fmt(Math.round(PV.irpf))+
        '€ se los llevará Hacienda: netas son '+sg(PV.neto)+')</span>':'')+
      (CR.fondos?' + revalorización de fondos '+sg(CR.fondos.ben):'')+'.'+
      (CR.fondos&&(CR.fondos.recortado||CR.fondos.desfase)?
        ' <span style="color:var(--amber)">La parte de fondos se mide desde el '+fmtDate(CR.fondos.desdeReal)+
        ', que es tu última valoración anterior al periodo.</span>':'')+
      (CR.latente!=null&&Math.abs(CR.latente)>1?
        ' No incluye lo que han subido o bajado las acciones que sigues teniendo sin vender ('+sg(CR.latente)+
        '): eso lo tienes en Análisis → Rentabilidad por bloque.':'')+
      '</div>';
  }

  // Nota de compensados excluidos en el rango
  const incComp=incomeLog.filter(e=>inRange(e.date)&&_ci.has(e.id));
  const expComp=expenseLog.filter(e=>inRange(e.date)&&_ce.has(e.id));
  if(incComp.length||expComp.length){
    const ci=incComp.reduce((s,e)=>s+(e.amt||0),0), ce=expComp.reduce((s,e)=>s+(e.amt||0),0);
    html+='<div style="font-size:11.5px;color:var(--muted);margin:.1rem 0 .5rem;padding:.4rem .55rem;background:var(--surface);border:1px dashed var(--line);border-radius:7px">⇄ Compensados y excluidos en este rango: '+incComp.length+' ingreso(s) ('+fmt(ci)+'€) y '+expComp.length+' gasto(s) ('+fmt(ce)+'€). No cuentan en los totales de arriba ni en los listados.</div>';
  }

  // Income section
  html+='<div class="vista-section"><div class="vista-section-title">💰 Ingresos ('+fmt(totInc)+'€)</div><div class="vista-block">';
  html+=Object.entries(incByCat).map(([c,v])=>'<div class="vista-row"><span class="lbl">'+(ING_CAT[c]||c)+'</span><span class="val pos">'+fmt(v)+'€</span></div>').join('');
  html+='<div style="border-top:.5px solid var(--border)"></div>';
  html+=listRows(inc,e=>'<div class="vista-tx-row"><span class="vista-tx-date">'+fmtDate(e.date)+'</span><span class="vista-tx-cat cat-nomina">'+(ING_CAT[e.cat]||e.cat)+'</span><span class="vista-tx-name">'+escapeHtml(e.desc)+'</span><span class="vista-tx-amt pos">'+fmt2(e.amt)+'€</span></div>');
  html+='</div></div>';

  // Expenses section
  const catSummary=(arr)=>{
    const by={}; arr.forEach(e=>{const c=e.cat||'otro';(by[c]=by[c]||{n:0,t:0});by[c].n++;by[c].t+=(e.amt||0);});
    const rows=Object.entries(by).sort((a,b)=>b[1].t-a[1].t);
    if(!rows.length)return '';
    return '<div style="margin-bottom:.45rem">'+
      '<div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:.1rem 0 .3rem">Por categoría</div>'+
      rows.map(([c,o])=>'<div class="vista-row"><span class="lbl"><span class="gasto-item-cat '+(CAT_CSS[c]||'cat-otro')+'">'+(CAT_LABELS[c]||c)+'</span> <span style="color:var(--faint);font-size:11px">'+o.n+' mov.</span></span><span class="val neg">'+fmt2(o.t)+'€</span></div>').join('')+
      '<div style="border-top:.5px solid var(--border);margin:.4rem 0 .3rem"></div>'+
    '</div>';
  };
  const expBlock=(title,arr,tot,showCats)=>'<div class="vista-section"><div class="vista-section-title">'+title+' ('+fmt(tot)+'€)</div><div class="vista-block">'+
    (showCats?catSummary(arr):'')+
    listRows(arr,e=>'<div class="vista-tx-row"><span class="vista-tx-date">'+fmtDate(e.date)+'</span><span class="vista-tx-cat '+(showCats?(CAT_CSS[e.cat]||'cat-otro'):'cat-hogar')+'">'+(showCats?(CAT_LABELS[e.cat]||e.cat||'otro'):(e.name||e.cat))+'</span><span class="vista-tx-name">'+(showCats?(e.name||''):'')+'</span><span class="vista-tx-amt neg">'+fmt2(e.amt)+'€</span></div>')+
    '</div></div>';
  html+=expBlock('🏠 Gastos fijos',expFijos,totFijos);
  html+=expBlock('🔧 Gastos estructurales',expEst,totEst,true);
  html+=expBlock('🎉 Ocio y consumo',expOcio,totOcio);

  // Stock operations
  if(stkOps.length){
    html+='<div class="vista-section"><div class="vista-section-title">📈 Operaciones de acciones</div><div class="vista-block">';
    html+=stkOps.map(t=>{
      const isBuy=t.type==='buy';
      const gl=isBuy?null:(t.gainLoss||0);
      return '<div class="vista-tx-row"><span class="vista-tx-date">'+fmtDate(t.date)+'</span>'+
        '<span class="vista-tx-cat '+(isBuy?'cat-rend':'cat-extra')+'">'+(isBuy?'COMPRA':'VENTA')+'</span>'+
        '<span class="vista-tx-name">'+(t.stockName||t.stockId)+' · '+fmt(t.shares||0)+' acc</span>'+
        '<span class="vista-tx-amt '+(isBuy?'':((gl>=0)?'pos':'neg'))+'">'+(isBuy?fmt2(t.total||0)+'€':((gl>=0?'+':'')+fmt2(gl)+'€'))+'</span></div>';
    }).join('');
    html+='</div></div>';
  }

  cnt.innerHTML=html;
}

// ═══════════════════════════════════════════════════════════════════════
// RENTABILIDAD ANUALIZADA (XIRR), CALENDARIO FISCAL, COMPENSACIÓN DE MINUSVALÍAS
// ═══════════════════════════════════════════════════════════════════════

// XIRR via Newton-Raphson. flows: [{date:'YYYY-MM-DD', amount:number}]
// (negative = money in / invested, positive = money out / current value)
function xirr(flows){
  if(flows.length<2)return null;
  const t0=new Date(flows[0].date).getTime();
  const yrs=f=>(new Date(f.date).getTime()-t0)/(365.25*864e5);
  const npv=r=>flows.reduce((s,f)=>s+f.amount/Math.pow(1+r,yrs(f)),0);
  const dnpv=r=>flows.reduce((s,f)=>{const y=yrs(f);return s-y*f.amount/Math.pow(1+r,y+1);},0);
  let r=0.1;
  for(let i=0;i<80;i++){
    const v=npv(r),d=dnpv(r);
    if(Math.abs(d)<1e-9)break;
    const nr=r-v/d;
    if(!isFinite(nr))return null;
    if(Math.abs(nr-r)<1e-7){r=nr;break;}
    r=nr;
    if(r<-0.9999)r=-0.9999;
  }
  return (r>-1&&r<100&&isFinite(r))?r:null;
}

let _rentabOpen=false;
function toggleRentab(){
  _rentabOpen=!_rentabOpen;
  const div=document.getElementById('rentab-collapse');
  const arr=document.getElementById('rentab-arrow');
  if(div)div.style.display=_rentabOpen?'block':'none';
  if(arr)arr.textContent=_rentabOpen?'▾':'▸';
  try{ALM.setItem('dlv_rentab_open',_rentabOpen?'1':'0');}catch(e){fallo('ALM.setItem',e)}
}

function renderRentabilidad(){
  const box=document.getElementById('rentab-box');
  if(!box)return;
  const today=todayISO();
  const rows=[];
  // Funds: aportaciones (negative flows) + current VL (positive)
  cfg.funds.forEach(f=>{
    const vl=getFundVLInfo(f.id).amount||0;
    const aports=transactions.filter(t=>t.type==='fund_aport'&&t.fundId===f.id&&t.date)
      .map(t=>({date:t.date,amount:-(t.amount||0)}));
    // Initial invested from cfg (if no aport tx, approximate as a single flow — skip if unknown)
    const invested=getFundInvested(f.id);
    if(vl<=0&&!aports.length)return;
    let flows=aports.slice();
    if(!flows.length&&invested>0){
      // No dated aportaciones: can't compute XIRR reliably; show simple return only
      const gain=vl-invested;const pct=invested>0?gain/invested*100:0;
      rows.push({name:f.name,vl,invested,xirr:null,simple:pct});
      return;
    }
    flows.push({date:today,amount:vl});
    const r=xirr(flows.sort((a,b)=>a.date.localeCompare(b.date)));
    const gain=vl-invested;const pct=invested>0?gain/invested*100:0;
    rows.push({name:f.name,vl,invested,xirr:r,simple:pct});
  });
  // v146 · Aquí había el error más gordo de la app. La "rentabilidad total"
  // comparaba el valor de lo que te queda contra TODO lo que habías comprado,
  // sin sumar lo que cobraste al vender. Una posición de la que hubieras
  // vendido la mitad salía en pérdidas aunque hubieras ganado dinero: compras
  // 1.000€, vendes la mitad por 700€, lo que queda vale 600€ → lo real es
  // +30% y la tabla decía −40%. Y en la misma fila la TIR sí contaba las
  // ventas, así que las dos columnas se contradecían. Ahora la rentabilidad
  // total es (valor + ventas + dividendos − invertido) / invertido, que es lo
  // que de verdad ha pasado con tu dinero. Las posiciones ya cerradas también
  // aparecen: su resultado es tan real como el de las abiertas.
  const agg=getStockAggregates();
  cfg.stocks.filter(s=>agg[s.id]&&agg[s.id].totalBoughtShares>1e-6).forEach(s=>{
    const A=agg[s.id];
    const abierta=A.totalShares>1e-6&&!A.isClosed;
    const val=abierta?(getStockInfo(s.id).amount||0):0;
    const buys=transactions.filter(t=>t.type==='buy'&&t.stockId===s.id&&t.date)
      .map(t=>({date:t.date,amount:-((t.total||0)+(t.costs||0))}));
    // lo que entra por una venta es neto de comisión, igual que en la plusvalía
    const sells=transactions.filter(t=>t.type==='sell'&&t.stockId===s.id&&t.date)
      .map(t=>({date:t.date,amount:(t.total||0)-(t.costs||0)}));
    const divs=dividendosDe(s.id).filter(d=>d.date).map(d=>({date:d.date,amount:d.amt||0}));
    if(val<=0&&!buys.length)return;
    const invested=A.totalBoughtValue||0;
    const cobradoV=sells.reduce((a,x)=>a+x.amount,0);
    const cobradoD=divs.reduce((a,x)=>a+x.amount,0);
    let flows=[...buys,...sells,...divs];
    if(val>0)flows.push({date:today,amount:val});
    let r=flows.length>=2?xirr(flows.sort((a,b)=>a.date.localeCompare(b.date))):null;
    // v147 · Anualizar tres semanas de un +4% da +98%/año. Es correcto y es
    // mentira: no dice nada de lo que rinde la posición, solo que el periodo es
    // demasiado corto para anualizar nada. Por debajo de medio año no se enseña.
    const prim=flows.length?flows[0].date:null;
    const dias=prim?Math.round((Date.parse(today)-Date.parse(prim))/864e5):0;
    const corta=dias<180;
    if(corta)r=null;
    const gain=val+cobradoV+cobradoD-invested;
    const pct=invested>0?gain/invested*100:0;
    rows.push({name:s.name,vl:val,invested,xirr:r,simple:pct,corta,dias,
               vendido:cobradoV,divid:cobradoD,cerrada:!abierta});
  });
  if(!rows.length){box.innerHTML='<p style="font-size:12px;color:var(--muted)">Sin datos suficientes. Registra aportaciones y valores con fecha.</p>';return;}
  box.innerHTML='<table style="width:100%;border-collapse:collapse;font-size:12px">'+
    '<tr style="color:var(--muted);font-size:10.5px;text-align:right"><td style="text-align:left">Activo</td><td>Invertido</td><td>Valor</td><td>Rent. total</td><td>Anualizada (TIR)</td></tr>'+
    rows.map(r=>{
      const totClass=r.simple>=0?'pos':'neg';
      const extra=[];
      if(r.vendido>0.005)extra.push(fmt(r.vendido)+'€ vendidos');
      if(r.divid>0.005)extra.push(fmt(r.divid)+'€ en dividendos');
      const sub=extra.length?('<br><small style="color:var(--muted);font-size:9.5px">'+
        (r.cerrada?'cerrada · ':'')+extra.join(' · ')+'</small>'):
        (r.cerrada?'<br><small style="color:var(--muted);font-size:9.5px">cerrada</small>':'');
      const xClass=(r.xirr!=null&&r.xirr>=0)?'pos':'neg';
      return '<tr>'+
        '<td style="text-align:left">'+r.name+(sub||'')+'</td>'+
        '<td style="text-align:right">'+fmt(r.invested)+'€</td>'+
        '<td style="text-align:right">'+fmt(r.vl)+'€</td>'+
        '<td style="text-align:right" class="'+totClass+'">'+(r.simple>=0?'+':'')+Math.round(r.simple)+'%</td>'+
        '<td style="text-align:right" class="'+xClass+'">'+(r.xirr!=null?((r.xirr>=0?'+':'')+(r.xirr*100).toFixed(1)+'%/año')
          :('<span style="color:var(--faint)" title="'+(r.corta?'lleva '+r.dias+' días: muy poco para anualizar':'faltan fechas')+'">'+
            (r.corta?'&lt;6 meses':'—')+'</span>'))+'</td>'+
      '</tr>';
    }).join('')+'</table>'+
    '<p style="font-size:10px;color:var(--faint);margin-top:.4rem">Rent. total = (valor actual + lo vendido + dividendos − invertido) / invertido. '+
    'La TIR (XIRR) anualiza eso mismo según las fechas reales de cada movimiento. '+
    '"&lt;6 meses" = lleva demasiado poco tiempo para anualizar sin decir una barbaridad; "—" = faltan fechas.</p>'+
    (function(){
      const sin=(typeof dividendosSinAsignar==='function')?dividendosSinAsignar():[];
      if(!sin.length)return '';
      return '<div style="margin-top:.5rem;padding:.45rem .6rem;border:1px solid var(--border);border-radius:6px">'+
        '<div style="font-size:11px;font-weight:600;margin-bottom:.25rem">Dividendos sin asignar ('+sin.length+')</div>'+
        '<div style="font-size:10.5px;color:var(--muted);margin-bottom:.3rem">No he sabido de qué acción son, así que no cuentan en ninguna rentabilidad. Asígnalos y entran.</div>'+
        sin.slice(0,8).map(x=>'<div style="display:flex;justify-content:space-between;gap:.4rem;align-items:center;font-size:11px;padding:.15rem 0">'+
          '<span>'+fmtDate(x.date)+' · '+escapeHtml(String(x.desc||'').slice(0,26))+'</span>'+
          '<span style="white-space:nowrap">'+fmt2(x.amt)+'€ <button type="button" class="btn-xs" onclick="asignarDividendo(this.dataset.id)" data-id="'+x.id+'">asignar</button></span></div>').join('')+
        (sin.length>8?'<div style="font-size:10px;color:var(--faint)">y '+(sin.length-8)+' más</div>':'')+
        '</div>';
    })();
}

function renderFiscalCalendar(){
  const box=document.getElementById('fiscal-box');
  if(!box)return;
  const hoy=todayISO();
  let E=[];
  try{ E=calendarioFiscal(); }catch(e){ console.warn('calendario',e); }
  if(!E.length){
    box.innerHTML='<div style="font-size:11.5px;color:var(--muted)">No hay ningún pago previsto por delante. '+
      'En cuanto importes unos meses de banco aparecerán aquí el IBI, la basura, los seguros y el agua con su fecha aproximada.</div>';
    return;
  }
  const ICONO={irpf:'🧾',tributo:'🏛',recibo:'📄',campana:'📅'};
  const total=E.filter(x=>x.imp!=null&&x.fecha<=isoLocal(new Date(Date.now()+365*864e5)))
    .reduce((s,x)=>s+x.imp,0);
  let h='';
  if(total>0){
    h+='<div style="background:var(--navy);color:#fff;border-radius:var(--r-sm);padding:.55rem .8rem;margin-bottom:.6rem">'+
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;opacity:.85">Impuestos y recibos de los próximos 12 meses</div>'+
      '<div style="font-size:20px;font-weight:700;margin:.1rem 0">'+fmt(Math.round(total))+'€</div>'+
      '<div style="font-size:10.5px;opacity:.8">son '+fmt(Math.round(total/12))+'€/mes que conviene tener apartados</div></div>';
  }
  h+=E.slice(0,14).map(e=>{
    const dias=Math.round((Date.parse(e.fecha)-Date.parse(hoy))/864e5);
    const pronto=dias<=45;
    const col=pronto?'var(--amber)':'var(--navy)';
    return '<div style="display:flex;justify-content:space-between;gap:.5rem;padding:.4rem 0;border-bottom:.5px solid var(--border)">'+
      '<div style="min-width:0"><strong style="font-size:12px;color:'+col+'">'+(ICONO[e.tipo]||'•')+' '+escapeHtml(e.titulo)+'</strong>'+
        (e.nota?'<br><small style="color:var(--muted)">'+escapeHtml(e.nota)+'</small>':'')+'</div>'+
      '<div style="text-align:right;white-space:nowrap">'+
        (e.imp!=null?'<strong style="font-size:12.5px">'+fmt(Math.round(e.imp))+'€</strong><br>':'')+
        '<small style="color:'+col+'">'+fmtDate(e.fecha)+' · '+(dias===0?'hoy':'en '+dias+' d')+'</small>'+
      '</div></div>';
  }).join('');
  if(E.length>14)h+='<div style="font-size:10.5px;color:var(--faint);margin-top:.3rem">y '+(E.length-14)+' más por delante</div>';
  h+='<div style="font-size:10px;color:var(--faint);margin-top:.5rem">Los recibos que se repiten (IBI, basura, seguros, agua) '+
    'salen de tu propio histórico: la fecha es aproximada y el importe es la media de lo que has pagado. '+
    'Los plazos del IRPF vienen de la previsión de Ahorro.</div>';
  const nowY=Number(hoy.slice(0,4));
  const divYear=incomeLog.filter(e=>e.cat==='dividendo'&&String(e.date||'').startsWith(String(nowY)))
    .reduce((s,e)=>s+(e.amt||0),0);
  if(divYear>0){
    h+='<div style="margin-top:.5rem;padding:.4rem .625rem;background:#E6F4F1;border-radius:var(--r-xs);font-size:11.5px">'+
      '💶 Dividendos cobrados '+nowY+': <strong>'+fmt2(divYear)+'€</strong> '+
      '<small style="color:var(--muted)">(tributan como renta del ahorro; retención habitual 19%)</small></div>';
  }
  box.innerHTML=h;
  if(typeof markScrollables==='function')markScrollables(box);
}
function renderLossComp(){
  const box=document.getElementById('loss-comp-box');
  if(!box)return;
  // Net gain/loss per year from sells
  const byYear={};
  transactions.filter(t=>t.type==='sell').forEach(t=>{
    const y=t.year||parseInt((t.date||'').slice(0,4))||0;
    byYear[y]=(byYear[y]||0)+(t.gainLoss||0);
  });
  const years=Object.keys(byYear).map(Number).sort();
  const lossYears=years.filter(y=>byYear[y]<0);
  if(!lossYears.length){box.innerHTML='';return;}
  const nowY=new Date().getFullYear();
  const rows=lossYears.map(y=>{
    const loss=byYear[y];
    const expires=y+4; // compensable durante los 4 años siguientes
    const yearsLeft=expires-nowY;
    const status=yearsLeft<0?'caducada':(yearsLeft===0?'último año':'hasta '+expires);
    const color=yearsLeft<0?'var(--red)':(yearsLeft<=1?'var(--amber)':'var(--muted)');
    return '<div style="display:flex;justify-content:space-between;font-size:11.5px;padding:.25rem 0">'+
      '<span>Minusvalía '+y+': <strong class="neg">'+fmt(loss)+'€</strong></span>'+
      '<span style="color:'+color+'">Compensable '+status+'</span>'+
    '</div>';
  }).join('');
  box.innerHTML='<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:.5rem .75rem">'+
    '<strong style="font-size:11.5px;color:var(--muted)">Minusvalías compensables</strong>'+rows+
    '<p style="font-size:10px;color:var(--faint);margin-top:.25rem">Las pérdidas compensan plusvalías del mismo año y de los 4 ejercicios siguientes.</p></div>';
}

// v169 · Tu nombre y tus reglas ya no están en el código: hay que cargarlos una
// vez. Mientras falten, aviso arriba del todo, porque sin ellos un extracto
// metería como ingresos o gastos las transferencias entre tus cuentas.
function renderTitularBanner(){
  const el=document.getElementById('titular-banner'); if(!el)return;
  const usa=(incomeLog.length+expenseLog.length)>0;
  if(!usa||!titularFalta()){ el.style.display='none'; return; }
  el.style.display='flex';
  el.innerHTML='<div style="font-size:11.5px;color:var(--amber);line-height:1.5"><strong>Falta tu archivo de ajustes personales.</strong> '+
    'Desde la v169 tu nombre y tus reglas no van dentro de la app (su código es público). Cárgalo una vez en este aparato '+
    'antes de importar extractos: sin él, las transferencias entre tus cuentas entrarían como ingresos o gastos.</div>'+
    '<button class="btn-sm" onclick="document.getElementById(\'personal-file\').click()" '+
    'style="font-size:11.5px;background:var(--amber);color:#fff;border-color:var(--amber)">⬆ Cargar ajustes</button>';
}
function renderAll(){
  try{renderTitularBanner();}catch(e){fallo('renderTitularBanner',e)}
  // Ensure valid state
  if(dashViewIdx>=records.length) dashViewIdx=-1;
  if(dashViewIdx===-999) dashViewIdx=-1; // reset no-data sentinel on full re-render
  initDashSelectors();
  refreshLiveRecord(); // v110 · antes de pintar nada, rehacer la foto del mes en curso
  renderKPIs();renderTable();initCharts();renderImpuestos();renderGastosDashboard();
  renderRentabilidad();renderFiscalCalendar();renderLossComp();
  // v135 · Análisis no se refrescaba nunca desde aquí. Importabas la cartera de
  // DEGIRO, se guardaban las valoraciones nuevas, se repintaba el dashboard…
  // y las tablas de Análisis seguían con las de antes hasta que salías de la
  // pestaña y volvías a entrar. Se repinta solo si está a la vista, que es
  // cuando importa y cuando no cuesta nada.
  if(!_enRenderAnalisis){
    _enRenderAnalisis=true;
    try{ if(document.getElementById('panel-analisis')?.classList.contains('active'))renderAnalisis(); }
    catch(e){ console.warn('analisis',e); }
    _enRenderAnalisis=false;
  }
}
let _enRenderAnalisis=false;

// On load, point the dashboard at the CURRENT calendar month (today)
function goToCurrentMonth(){
  const today=new Date();
  const cy=today.getFullYear();
  const cm=today.getMonth()+1;
  const idx=records.findIndex(r=>r.year===cy&&r.month===cm);
  // Ensure the current year exists in the year selector even if no records yet
  const ysel=document.getElementById('dash-year');
  if(ysel){
    const years=[...new Set([cy,...records.map(r=>r.year)])].sort((a,b)=>b-a);
    ysel.innerHTML=years.map(y=>'<option value="'+y+'">'+y+'</option>').join('');
    ysel.value=cy;
  }
  const msel=document.getElementById('dash-month');
  if(msel) msel.value=cm;
  if(idx>=0){
    dashViewIdx=idx;
    renderKPIs();
  } else {
    // No saved record for current month — try a live record from balance log / transactions
    const live=buildLiveRecord(cy,cm);
    if(live.hasData&&live.pat>0){
      _liveRecord=live;
      dashViewIdx=-2;
      renderKPIs();
      initCharts(); // refresh chart to include the live point
    } else {
      dashViewIdx=-999;
      renderKPIsNoData(cy,cm);
    }
  }
}


// ════════════════════════════════════════════
// v94 · RED DE SEGURIDAD: instantánea + deshacer antes de tocar datos en bloque
// ════════════════════════════════════════════
function currentStateObj(){
  return {_app:'DisfrutaLaVida-Patrimonio',_version:37,_exported:new Date().toISOString(),
    cfg,records,transactions,soldStocks:[...soldStocks],
    balanceLog,incomeLog,expenseLog,brokerFlows,reembolsos,personal};
}
// Guarda el estado ANTES de una operación destructiva. Devuelve false si no cabe.
function snapshotState(label){
  try{
    ALM.setItem('dlv_undo',JSON.stringify({label,at:new Date().toISOString(),data:currentStateObj()}));
    renderUndoBar();
    return true;
  }catch(e){
    console.warn('snapshot',e);
    return false;
  }
}
function guardedAction(label){
  if(snapshotState(label)) return true;
  return confirm('No hay espacio para guardar una copia de seguridad interna, así que esta acción NO se podrá deshacer.\n\nGenera antes un archivo de copia si quieres estar cubierto.\n\n¿Continuar de todas formas?');
}
function getUndo(){
  try{const raw=ALM.getItem('dlv_undo');return raw?JSON.parse(raw):null;}catch(e){return null;}
}
function renderUndoBar(){
  const bar=document.getElementById('undo-bar'),txt=document.getElementById('undo-txt');
  if(!bar)return;
  const u=getUndo();
  if(!u){bar.style.display='none';return;}
  const mins=Math.round((Date.now()-new Date(u.at).getTime())/60000);
  const when=mins<1?'hace un momento':(mins<60?'hace '+mins+' min':'hace '+Math.round(mins/60)+' h');
  bar.style.display='flex';
  if(txt)txt.innerHTML='Puedes deshacer: <strong>'+escapeHtml(u.label)+'</strong> ('+when+')';
}
function undoLast(){
  const u=getUndo();
  if(!u){toast('No hay nada que deshacer');return;}
  if(!confirm('Volver al estado anterior a «'+u.label+'»?\n\nSe perderá lo hecho después de esa operación.'))return;
  const d=u.data;
  try{
    cfg=d.cfg; records=d.records; transactions=d.transactions;
    soldStocks=new Set(d.soldStocks||[]);
    balanceLog=d.balanceLog||[]; incomeLog=d.incomeLog||[]; expenseLog=d.expenseLog||[];
    brokerFlows=d.brokerFlows||[]; reembolsos=d.reembolsos||[];
    if(cfg.customCats)Object.assign(CAT_LABELS,cfg.customCats);
    migrateFundIdent();
    recomputeAllStockGains();
    _recatIndex=null;
    ALM.removeItem('dlv_undo');
    save(); renderAll(); goToCurrentMonth(); renderUndoBar(); renderDiag();
    toast('↩ Estado restaurado');
  }catch(e){toast('No se pudo deshacer: '+e.message);}
}

// ════════════════════════════════════════════
// v94 · REVISIÓN DE DATOS
// ════════════════════════════════════════════
let _diagOpen=false;
function toggleDiag(){
  _diagOpen=!_diagOpen;
  const b=document.getElementById('diag-body'),a=document.getElementById('diag-arrow');
  if(b)b.style.display=_diagOpen?'':'none';
  if(a)a.textContent=_diagOpen?'▾':'▸';
  if(_diagOpen)renderDiag();
}
// v166 · Lo que ocupan tus datos, estén en IndexedDB o en ALM
function lsBytes(){
  try{ return ALM.tamano(); }catch(e){ return 0; }
}
function dupKeyOf(x,isInc){
  const nm=recatNorm(isInc?x.desc:x.name).slice(0,18);
  return (x.date||'')+'|'+Math.round((Number(x.amt)||0)*100)+'|'+nm;
}
function findDupes(todos){
  const out={exp:[],inc:[]};
  const ok=new Set(todos?[]:((cfg.dupOk)||[]));
  [['exp',expenseLog,false],['inc',incomeLog,true]].forEach(([k,list,isInc])=>{
    const map={};
    list.forEach(x=>{if(isHistExp(x))return;const key=dupKeyOf(x,isInc);(map[key]||(map[key]=[])).push(x);});
    Object.values(map).forEach(g=>{
      if(g.length<2)return;
      // v124 · dos cobros iguales el mismo día no siempre son un error: la
      // IPT paga mensualidad y extra juntas en junio y noviembre.
      if(!todos&&typeof dupEsperado==='function'&&dupEsperado(g,isInc))return;
      if(!todos&&ok.has(dupGroupKey(g,isInc)))return;
      out[k].push(g);
    });
  });
  return out;
}

// ── v124 · DUPLICADOS QUE NO LO SON ─────────────────────────────────
// El detector marcaba como repetidos los dos cobros de la IPT de junio y de
// noviembre. No lo son: son la mensualidad y la paga extraordinaria, que
// llegan el mismo día y por el mismo importe. Y además solo había un botón,
// "borrar", así que la única salida era cargarse un ingreso legítimo.
//
// Dos arreglos. Uno automático: la app ya sabe cuántas pagas tiene tu IPT,
// así que en junio y noviembre espera dos y no se queja. Y otro manual, que
// vale para cualquier caso futuro: cada grupo tiene su botón de "es válido"
// y se recuerda para siempre.
function dupOkList(){ cfg.dupOk=cfg.dupOk||[]; return cfg.dupOk; }
function dupGroupKey(g,isInc){
  return (isInc?'i|':'e|')+dupKeyOf(g[0],isInc)+'|'+g.length;
}
// Repeticiones que la propia estructura del dato explica.
function dupEsperado(g,isInc){
  if(!isInc)return false;
  const x=g[0]||{};
  if(x.cat==='ipt'){
    const m=String(x.date||'').slice(5,7);
    const pagas=(typeof iptNumPagas==='function')?iptNumPagas():14;
    const esperadas=((pagas>=14&&(m==='06'||m==='11'))||(pagas===13&&m==='06'))?2:1;
    return g.length<=esperadas;
  }
  return false;
}
function dupMarcarValido(key){
  const L=dupOkList();
  if(!L.includes(key))L.push(key);
  save(); renderDiag();
  try{renderAll();}catch(e){fallo('renderAll',e)}
  toast('Anotado: eso no es un duplicado');
}
function dupOlvidarValidos(){
  if(!dupOkList().length){toast('No hay ninguno marcado');return;}
  if(!confirm('Se volverán a revisar '+dupOkList().length+' grupo(s) que habías dado por válidos. ¿Seguir?'))return;
  cfg.dupOk=[]; save(); renderDiag();
  try{renderAll();}catch(e){fallo('renderAll',e)}
}
// Borra los repetidos de UN grupo, dejando el primero.
function dupBorrarGrupo(key){
  const D=findDupes(true);
  const g=[...D.exp.map(x=>[x,false]),...D.inc.map(x=>[x,true])]
    .find(([grp,isInc])=>dupGroupKey(grp,isInc)===key);
  if(!g){toast('Ese grupo ya no existe');return;}
  const [grp,isInc]=g;
  const sobran=grp.slice(1);
  if(!confirm('Se borrarán '+sobran.length+' apunte(s) de:\n\n'+
    (grp[0].name||grp[0].desc||'')+'\n'+fmtDate(grp[0].date)+' · '+fmt2(grp[0].amt)+'€\n\n'+
    'Quedará uno. ¿Borrar?'))return;
  if(!guardedAction('borrar '+sobran.length+' repetido(s)'))return;
  const kill=new Set(sobran.map(x=>x.id));
  expenseLog=expenseLog.filter(x=>!kill.has(x.id));
  incomeLog=incomeLog.filter(x=>!kill.has(x.id));
  _recatIndex=null;
  save();renderAll();renderDiag();
  try{renderGastosList();renderTxIngList();}catch(e){fallo('renderGastosList',e)}
  toast('🗑 '+sobran.length+' borrado(s) · puedes deshacerlo');
}
// Pinta un grupo con sus dos salidas: darlo por bueno o borrar el sobrante.
function dupFilaHTML(g,isInc){
  const key=dupGroupKey(g,isInc);
  const t=escapeHtml(g[0].name||g[0].desc||'(sin concepto)').slice(0,46);
  return '<div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;'+
    'padding:.2rem 0;border-bottom:.5px dotted var(--border)">'+
    '<span style="flex:1;min-width:0">'+t+' · '+fmtDate(g[0].date)+' · '+fmt2(g[0].amt)+'€ <strong>×'+g.length+'</strong></span>'+
    '<span style="white-space:nowrap">'+
      '<button type="button" class="btn-xs" onclick="dupMarcarValido(\''+key+'\')">es válido</button> '+
      '<button type="button" class="btn-xs" style="background:var(--red);color:#fff;border-color:var(--red)" '+
        'onclick="dupBorrarGrupo(\''+key+'\')">borrar</button>'+
    '</span></div>';
}


// ── v125 · SALDOS DEL MISMO DÍA QUE SE CONTRADICEN ──────────────────
// Dos apuntes de la misma cuenta, el mismo día, con importes distintos. La
// app se queda con el último que metiste, que es lo razonable: si lo
// corregiste a mano después de importar el extracto, la corrección manda.
// Pero el apunte viejo se queda ahí, viaja en cada copia y en cada sync, y
// basta que una pantalla ordene distinto para que reaparezca. Mejor borrarlo.
function balContradicciones(){
  const porClave={};
  (typeof balanceLog!=='undefined'?balanceLog:[]).forEach((e,i)=>{
    if(!e.date)return;
    const k=e.refType+'|'+e.refId+'|'+e.date;
    (porClave[k]=porClave[k]||[]).push([e,i]);
  });
  const nom=(t,id)=>{
    const L=t==='acc'?cfg.accounts:t==='fund'?cfg.funds:t==='stock'?cfg.stocks:(cfg.brokers||[]);
    const o=(L||[]).find(x=>x.id===id); return o?o.name:id;
  };
  const out=[];
  Object.entries(porClave).forEach(([k,arr])=>{
    if(arr.length<2)return;
    if(new Set(arr.map(([e])=>Math.round((Number(e.amount)||0)*100))).size<2)return;
    const orden=arr.slice().sort((a,b)=>b[1]-a[1]);      // el último metido, primero
    const [tipo,refId,date]=k.split('|');
    out.push({tipo,refId,date,nombre:nom(tipo,refId),
      gana:orden[0][0], pierden:orden.slice(1).map(x=>x[0]),
      importes:arr.map(([e])=>Number(e.amount)||0)});
  });
  return out.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
}
function balLimpiarContradicciones(){
  const C=balContradicciones();
  if(!C.length){toast('No hay saldos contradictorios');return;}
  const n=C.reduce((s,c)=>s+c.pierden.length,0);
  const lista=C.slice(0,12).map(c=>'  · '+c.nombre+' · '+fmtDate(c.date)+':  se queda '+
    fmt2(c.gana.amount)+'€, se borra '+c.pierden.map(x=>fmt2(x.amount)+'€').join(', ')).join('\n');
  if(!confirm('Se van a borrar '+n+' apunte(s) de saldo que quedaron sustituidos por una '+
    'corrección posterior del mismo día:\n\n'+lista+(C.length>12?'\n  · …':'')+
    '\n\nEn cada caso se conserva el último que metiste, que es el que la app ya estaba usando. '+
    'No cambia ninguna cifra: solo quita la ambigüedad.\n\n¿Borrar?'))return;
  if(!guardedAction('borrar '+n+' saldos sustituidos'))return;
  const kill=new Set();
  C.forEach(c=>c.pierden.forEach(e=>{ if(e.id)kill.add(e.id); }));
  balanceLog=balanceLog.filter(e=>!kill.has(e.id));
  save();
  if(typeof refreshLiveRecord==='function')refreshLiveRecord();
  renderAll();renderDiag();
  toast('🧹 '+n+' saldo(s) sustituido(s) borrado(s) · puedes deshacerlo');
}
function balContradiccionesHTML(){
  let C=[];
  try{ C=balContradicciones(); }catch(e){ return ''; }
  if(!C.length)return '';
  return C.slice(0,6).map(c=>escapeHtml(c.nombre)+' · '+fmtDate(c.date)+' → '+
      c.importes.map(v=>fmt2(v)+'€').join(' / ')+
      ' <span style="color:var(--teal)">(se usa '+fmt2(c.gana.amount)+'€)</span>').join('<br>')+
    (C.length>6?'<br>y '+(C.length-6)+' más…':'');
}


// ── v127 · APUNTES CON FECHA FUTURA ─────────────────────────────────
// Un dedazo al teclear el año y el apunte se va a un mes que todavía no ha
// llegado. No da error en ningún sitio: simplemente queda fuera de todos los
// periodos, así que el dinero desaparece de los cálculos sin avisar.
function apuntesFuturos(){
  const hoy=todayISO();
  const out=[];
  const rev=(lista,tipo,campo)=>(lista||[]).forEach(x=>{
    const d=String(x.date||'');
    if(d&&d>hoy)out.push({tipo,date:d,desc:String(x[campo]||x.desc||x.name||x.type||'')+'',imp:Number(x.amount!=null?x.amount:x.amt)||0});
  });
  rev(typeof incomeLog!=='undefined'?incomeLog:[],'ingreso','desc');
  rev(typeof expenseLog!=='undefined'?expenseLog:[],'gasto','name');
  rev(typeof brokerFlows!=='undefined'?brokerFlows:[],'bróker','type');
  rev((typeof transactions!=='undefined'?transactions:[]).filter(t=>t.type==='buy'||t.type==='sell'||t.type==='fund_aport'),'inversión','type');
  rev(typeof balanceLog!=='undefined'?balanceLog:[],'saldo','refType');
  return out.sort((a,b)=>a.date.localeCompare(b.date));
}
function apuntesFuturosHTML(){
  let F=[];
  try{ F=apuntesFuturos(); }catch(e){ return ''; }
  if(!F.length)return '';
  return F.slice(0,8).map(x=>fmtDate(x.date)+' · '+x.tipo+' · '+escapeHtml(x.desc).slice(0,34)+' · '+fmt2(x.imp)+'€').join('<br>')+
    (F.length>8?'<br>y '+(F.length-8)+' más…':'');
}

function staleBalances(days){
  // v110 · getLatestBalance devuelve el IMPORTE, no la entrada. El código
  // anterior hacía new Date(2057.91).date → NaN, y NaN<lim es false: el aviso
  // de "saldo viejo" no saltaba NUNCA. La app te decía "todo en orden" con
  // fondos sin tocar desde hacía meses.
  const lim=Date.now()-days*864e5;
  const out=[];
  const chk=(tipo,refType,lista)=>{
    (lista||[]).forEach(o=>{
      const e=getBalanceEntries(refType,o.id)[0];
      const t=e&&e.date?Date.parse(e.date+'T00:00:00'):NaN;
      if(!e||!isFinite(t)||t<lim) out.push({t:tipo,n:o.name,d:e?e.date:null});
    });
  };
  chk('Cuenta','acc',cfg.accounts);
  chk('Fondo','fund',cfg.funds);
  return out;
}
function renderDiag(){
  const badge=document.getElementById('diag-badge'), body=document.getElementById('diag-body');
  if(!badge)return;
  const bytes=lsBytes();
  const kb=Math.round(bytes/1024);
  // v166 · en IndexedDB no hay tope de 5 MB: ya no hay límite del que avisar
  const sinTope=ALM.modo==='idb';
  const pct=sinTope?0:Math.min(100,Math.round(bytes/(5*1024*1024)*100));
  const dup=findDupes();
  const nDup=dup.exp.length+dup.inc.length;
  const sinCat=recatPending(false).length;
  const stale=staleBalances(75);
  let contra=[]; try{contra=balContradicciones();}catch(e){fallo('contra',e)}
  let desf=[]; try{desf=records.map(r=>({r,c:recCifras(r)})).filter(x=>x.c&&x.c.difiere);}catch(e){fallo('desf',e)}
  let futs=[]; try{futs=apuntesFuturos();}catch(e){fallo('futs',e)}
  const issues=(nDup?1:0)+(sinCat?1:0)+(stale.length?1:0)+(pct>=80?1:0)+(contra.length?1:0)+(desf.length?1:0)+(futs.length?1:0);
  badge.innerHTML=issues
    ? '<span style="color:var(--amber)">⚠ '+issues+' cosa'+(issues!==1?'s':'')+' que revisar</span>'
    : '<span style="color:var(--teal)">✓ todo en orden</span>';
  if(!body||!_diagOpen)return;
  const li=(icon,txt,extra)=>'<div style="display:flex;gap:.5rem;align-items:flex-start;padding:.3rem 0;font-size:11.5px;border-bottom:.5px solid var(--border)"><span>'+icon+'</span><div style="flex:1">'+txt+(extra?'<div style="font-size:10.5px;color:var(--faint);margin-top:2px">'+extra+'</div>':'')+'</div></div>';
  let h='';
  h+=li(pct>=80?'🔴':'💽','<strong>Almacenamiento</strong>: '+kb+' KB'+(sinTope
      ? ' en IndexedDB, sin el tope de 5 MB del navegador'+(ALM.persistente?', y marcados como permanentes':'')
      : ' usados ('+pct+'% del límite típico del navegador)'),
    pct>=80?'Estás cerca del límite. Genera un archivo de copia y considera archivar años antiguos.':'Margen de sobra. Aun así, el navegador puede borrar estos datos si limpias el historial: la copia en archivo es tu única red real.');
  const nOk=((cfg.dupOk)||[]).length;
  const gruposDup=[...dup.exp.map(g=>[g,false]),...dup.inc.map(g=>[g,true])];
  h+=li(nDup?'⚠️':'✓','<strong>Posibles duplicados</strong>: '+(nDup?nDup+' grupo(s) con misma fecha, importe y concepto':'ninguno')+
    (nDup>1?' <button type="button" class="btn-xs" style="background:var(--red);color:#fff;border-color:var(--red);margin-left:.4rem" onclick="diagCleanDupes()">Borrar todos los repetidos</button>':''),
    (nDup?'<div style="margin-top:.2rem">'+
        gruposDup.slice(0,8).map(([g,isInc])=>dupFilaHTML(g,isInc)).join('')+
        (gruposDup.length>8?'<div style="margin-top:.2rem">y '+(gruposDup.length-8)+' más…</div>':'')+
        '<div style="margin-top:.3rem;color:var(--faint)">Dos compras iguales el mismo día son legítimas, '+
        'y la IPT cobra mensualidad y extra juntas en junio y noviembre. Marca «es válido» y no se vuelve a preguntar.</div>'+
      '</div>':'')+
    (nOk?'<div style="margin-top:.25rem">'+nOk+' grupo(s) dados por válidos. '+
      '<a href="#" onclick="event.preventDefault();dupOlvidarValidos()" style="color:var(--navy)">volver a revisarlos</a></div>':''));
  h+=li(sinCat?'🏷':'✓','<strong>Gastos sin clasificar</strong>: '+(sinCat?sinCat+' en «Otro»':'ninguno')+
    (sinCat?' <a href="#" onclick="event.preventDefault();setTab(\'entrada\');setTimeout(()=>document.getElementById(\'recat-card\').scrollIntoView({behavior:\'smooth\'}),120)" style="color:var(--navy)">ir a clasificarlos</a>':''),'');
  h+=li(stale.length?'⏳':'✓','<strong>Saldos sin actualizar</strong> (más de 75 días): '+(stale.length?stale.length:'ninguno'),
    stale.length?stale.map(s=>s.t+' '+escapeHtml(s.n)+(s.d?' — último '+fmtDate(s.d):' — nunca')).join('<br>'):'');
  h+=li(contra.length?'⚠️':'✓','<strong>Saldos contradictorios</strong> (dos apuntes del mismo día con importes distintos): '+
    (contra.length?contra.length+' caso(s)'+
      ' <button type="button" class="btn-xs" onclick="balLimpiarContradicciones()" style="margin-left:.4rem">Quedarme con el último</button>':'ninguno'),
    contra.length?(balContradiccionesHTML()+
      '<div style="margin-top:.25rem">La app usa siempre el último que metiste, que es la corrección. '+
      'El viejo no cambia ninguna cifra, pero viaja en cada copia y en cada sincronización: mejor quitarlo.</div>'):'');
  h+=li(desf.length?'⚠️':'✓','<strong>Meses guardados desfasados</strong>: '+
    (desf.length?desf.length+' mes(es) con cifras que no coinciden con tus apuntes'+
      ' <button type="button" class="btn-xs" onclick="recPonerAlDia()" style="margin-left:.4rem">Ponerlos al día</button>':'ninguno'),
    desf.length?(recDesfasadosHTML()+
      '<div style="margin-top:.25rem">Son números que escribiste a mano antes de importar el banco. '+
      'Las pantallas ya te enseñan el cálculo real, pero el número viejo sigue guardado y viaja en cada copia.</div>'):'');
  h+=li(futs.length?'⚠️':'✓','<strong>Apuntes con fecha futura</strong>: '+(futs.length?futs.length:'ninguno'),
    futs.length?(apuntesFuturosHTML()+
      '<div style="margin-top:.25rem">Suele ser un año mal tecleado. Mientras la fecha esté por delante de hoy, '+
      'ese dinero no entra en ningún periodo y desaparece de los cálculos sin dar error. Corrígelos donde los diste de alta.</div>'):'');
  const u=getUndo();
  h+=li('↩','<strong>Deshacer disponible</strong>: '+(u?escapeHtml(u.label)+' ('+fmtDateFull(u.at.slice(0,10))+')':'nada pendiente')+
    (u?' <button type="button" class="btn-xs" onclick="undoLast()" style="margin-left:.4rem">Deshacer</button>'+
       ' <button type="button" class="btn-xs" onclick="discardUndo()" style="margin-left:.2rem">Descartar copia</button>':''),
    'Antes de cada importación, fusión o cambio en bloque se guarda una copia interna del estado anterior.'+(u?' Ocupa unos '+Math.round((ALM.getItem('dlv_undo')||'').length/1024)+' KB.':''));
  // v169 · lo que antes se perdía sin dejar rastro
  h+=li(FALLOS.length?'⚠️':'✓','<strong>Fallos internos desde que abriste la app</strong>: '+(FALLOS.length||'ninguno'),
    FALLOS.length?('<div style="font-size:11px;color:var(--muted);line-height:1.5">'+
      FALLOS.slice(-6).reverse().map(f=>escapeHtml(f.donde+': '+f.m)).join('<br>')+'</div>'+
      '<div style="margin-top:.25rem">No han parado la app, pero algo no ha salido como debía. Si una pantalla no se actualiza, '+
      'estas líneas dicen dónde mirar.</div>'):'');
  body.innerHTML=h;
}
function discardUndo(){
  if(!confirm('Borrar la copia interna de deshacer? Libera espacio, pero ya no podrás revertir la última operación.'))return;
  try{ALM.removeItem('dlv_undo');}catch(e){fallo('ALM.removeItem',e)}
  renderUndoBar();renderDiag();toast('Copia de deshacer borrada');
}
function diagCleanDupes(){
  const dup=findDupes();
  const groups=[...dup.exp,...dup.inc];
  if(!groups.length){toast('No hay duplicados');return;}
  const extra=groups.reduce((s,g)=>s+g.length-1,0);
  const money=groups.reduce((s,g)=>s+(Number(g[0].amt)||0)*(g.length-1),0);
  const list=groups.slice(0,10).map(g=>'· '+(g[0].name||g[0].desc||'')+' · '+g[0].date+' · '+fmt2(g[0].amt)+'€ ×'+g.length).join('\n');
  if(!confirm('Se borrarán '+extra+' apunte(s) repetidos ('+fmt2(money)+'€ en total), dejando uno de cada:\n\n'+list+(groups.length>10?'\n· …':'')+
    '\n\nOJO: dos compras iguales el mismo día en el mismo sitio son legítimas. Revisa la lista antes de aceptar.\n\n¿Borrar?'))return;
  if(!guardedAction('borrar '+extra+' duplicados'))return;
  const kill=new Set();
  groups.forEach(g=>g.slice(1).forEach(x=>kill.add(x.id)));
  expenseLog=expenseLog.filter(x=>!kill.has(x.id));
  incomeLog=incomeLog.filter(x=>!kill.has(x.id));
  _recatIndex=null;
  save();renderAll();renderDiag();
  try{renderGastosList();renderTxIngList();}catch(e){fallo('renderGastosList',e)}
  toast('🗑 '+extra+' duplicados borrados · puedes deshacerlo');
}

// ════════════════════════════════════════════
// v94 · SALUD FINANCIERA: colchón, caída desde máximos y deriva del gasto
// ════════════════════════════════════════════
// Categorías que puedes recortar mañana sin cambiar de vida.
// Se listan explícitamente para que sepas qué entra en el cálculo.
const CAT_DISCRECIONAL=new Set(['ocio','restaurante','viaje','ropa','estanco','suscripciones']);
function patOf(r){return getCash(r)+getFondos(r)+getAcc(r)-getDeuda(r);}
function saludNow(){return _liveRecord||last();}
// Serie mensual de patrimonio: cierres + el mes vivo si es posterior al último cierre
function saludPatSeries(){
  const out=records.map(r=>({ym:r.year+'-'+String(r.month).padStart(2,'0'),label:r.label,pat:patOf(r)}));
  const lv=_liveRecord;
  if(lv){
    const ym=lv.year+'-'+String(lv.month).padStart(2,'0');
    if(!out.length||ym>out[out.length-1].ym) out.push({ym,label:lv.label,pat:patOf(lv)});
  }
  return out.filter(x=>isFinite(x.pat));
}
// Gastos reales del usuario: fuera los agregados históricos deducidos 2015-2024
function saludRealExpenses(){
  const ce=compExpenseIds();
  return expenseLog.filter(x=>!isHistExp(x)&&!ce.has(x.id))
    .map(x=>{const dev=(typeof pendDev==='function')?pendDev(x):0;
      return dev>0?Object.assign({},x,{amt:Math.max(0,(Number(x.amt)||0)-dev)}):x;})
    .filter(x=>(Number(x.amt)||0)>0);
}
function saludMonthlyExp(){
  const m={};
  saludRealExpenses().forEach(x=>{const k=(x.date||'').slice(0,7);if(k)m[k]=(m[k]||0)+(Number(x.amt)||0);});
  return m;
}
function ymAdd(ym,n){
  const [y,mo]=ym.split('-').map(Number);
  const d=new Date(y,mo-1+n,1);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
}
function ymNow(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
// El mes en curso está a medias: para comparar se usa el último mes cerrado
function saludLastClosedYM(){
  const m=saludMonthlyExp();
  const cur=ymNow();
  const ks=Object.keys(m).filter(k=>k<cur).sort();
  return ks.length?ks[ks.length-1]:null;
}
function saludSumRange(m,fromYM,toYM){
  let s=0,n=0;
  Object.keys(m).forEach(k=>{if(k>=fromYM&&k<=toYM){s+=m[k];n++;}});
  return {sum:s,months:n};
}
// Primer mes con gasto registrado de verdad. Antes de esa fecha no hay
// movimientos importados, así que comparar contra ese periodo daría subidas
// del +400% que no son subidas: son huecos de datos.
// Tus importaciones arrancan poco a poco (6, 2, 5, 8, 12, 18, 32, 50... movimientos
// al mes). Se considera cubierto el primer mes que alcanza la mitad de tu volumen
// habitual y cuyo mes siguiente también lo alcanza, para no morder un pico suelto.
function saludCoverageStart(cnt){
  const ks=Object.keys(cnt).sort();
  if(!ks.length) return null;
  const vals=ks.map(k=>cnt[k]).sort((a,b)=>a-b);
  const med=vals[Math.floor(vals.length/2)]||0;
  const th=Math.max(5,med*0.5);
  for(let i=0;i<ks.length;i++){
    if(cnt[ks[i]]>=th&&(i+1>=ks.length||cnt[ks[i+1]]>=th)) return ks[i];
  }
  return ks[ks.length-1];
}
// Dos periodos sólo son comparables si el antiguo tiene un volumen de movimientos
// parecido al reciente. Si no, la "subida" sería el hueco de datos, no tu gasto.
function saludComparable(nOld,nNew){return nNew>0&&nOld>=nNew*0.6;}
function saludCountRange(cnt,fromYM,toYM){
  let n=0;Object.keys(cnt).forEach(k=>{if(k>=fromYM&&k<=toYM)n+=cnt[k];});return n;
}
function saludMetrics(){
  const m=saludMonthlyExp();
  const cnt={};
  saludRealExpenses().forEach(x=>{const k=(x.date||'').slice(0,7);if(k)cnt[k]=(cnt[k]||0)+1;});
  const covStart=saludCoverageStart(cnt);
  const cur=ymNow();
  const lastClosed=saludLastClosedYM();
  const endWin=lastClosed||ymAdd(cur,-1);
  // gasto medio: los últimos 12 meses cerrados, recortando lo anterior a la
  // cobertura de datos para no promediar meses vacíos
  let startWin=ymAdd(endWin,-11);
  if(covStart&&startWin<covStart) startWin=covStart;
  const w1=saludSumRange(m,startWin,endWin);
  const prevEnd=ymAdd(startWin,-1), prevStart=ymAdd(startWin,-w1.months);
  const w2=saludSumRange(m,prevStart,prevEnd);
  // sólo comparamos si la ventana anterior está igual de cubierta
  const nWin=saludCountRange(cnt,startWin,endWin), nPrev=saludCountRange(cnt,prevStart,prevEnd);
  const cmpOk=!!covStart&&prevStart>=covStart&&w2.months>=Math.max(3,w1.months-1)&&saludComparable(nPrev,nWin);
  const avg12=w1.months?w1.sum/w1.months:0;
  const r=saludNow();
  const cash=r?getCash(r):0, pat=r?patOf(r):0;
  const series=saludPatSeries();
  // caída desde máximos (sólo desde que el patrimonio es significativo: >5.000€,
  // si no los saltos de 2015 sobre saldos de 3 cifras dominan el cálculo)
  let peak=0,peakYM=null,curDD=0,worst=0,worstYM=null;
  series.forEach(p=>{
    if(p.pat>peak){peak=p.pat;peakYM=p.label;}
    if(peak>=5000){
      const dd=(p.pat-peak)/peak;
      if(dd<worst){worst=dd;worstYM=p.label;}
    }
  });
  if(peak>0) curDD=(series.length?series[series.length-1].pat-peak:0)/peak;
  // discrecional sobre la misma ventana
  let disc=0,tot=0;
  saludRealExpenses().forEach(x=>{
    const k=(x.date||'').slice(0,7);
    if(k>=startWin&&k<=endWin){
      tot+=Number(x.amt)||0;
      if(CAT_DISCRECIONAL.has(x.cat)) disc+=Number(x.amt)||0;
    }
  });
  // mismo mes del año anterior — sólo si ese mes tiene datos de verdad
  const yoyCur=lastClosed?(m[lastClosed]||0):0;
  const yoyPrevKey=lastClosed?ymAdd(lastClosed,-12):null;
  const yoyOk=!!(yoyPrevKey&&covStart&&yoyPrevKey>=covStart
    &&saludComparable(cnt[yoyPrevKey]||0,cnt[lastClosed]||0));
  const yoyPrev=yoyOk?m[yoyPrevKey]:undefined;
  return {avg12,months12:w1.months,sum12:w1.sum,sumPrev12:w2.sum,monthsPrev:w2.months,
    cash,pat,peak,peakYM,curDD,worst,worstYM,cmpOk,covStart,startWin,prevStart,prevEnd,
    nWin,nPrev,cntCur:cnt[lastClosed]||0,cntPrev:cnt[yoyPrevKey]||0,
    disc,totCat:tot,endWin,lastClosed,yoyCur,yoyPrev,yoyPrevKey,yoyOk,series};
}
function saludMonthsWord(v){
  if(!isFinite(v)||v<=0) return '—';
  if(v>=24) return (v/12).toFixed(1).replace('.',',')+' años';
  return v.toFixed(1).replace('.',',')+' meses';
}
function renderSalud(){
  const box=document.getElementById('salud-kpi');
  const note=document.getElementById('salud-note');
  if(!box)return;
  const d=saludMetrics();
  if(!d.months12){
    box.innerHTML='';
    if(note)note.innerHTML='<p style="font-size:12px;color:var(--muted)">Aún no hay suficientes meses de gastos registrados para calcular estas métricas.</p>';
    return;
  }
  const kc=(t,v,s,c)=>'<div class="kpi '+(c||'')+'"><div class="kpi-lbl">'+t+'</div><div class="kpi-val" style="font-size:16px">'+v+'</div>'+(s?'<div style="font-size:10.5px;color:var(--muted);margin-top:.25rem">'+s+'</div>':'')+'</div>';
  const pctTxt=(a,b)=>{
    if(!b) return {t:'—',c:''};
    const p=(a-b)/b*100;
    return {t:(p>=0?'+':'')+p.toFixed(1).replace('.',',')+'%',c:p<=0?'teal':'red'};
  };
  // v138 · El gasto medio, con exactamente un año de declaración dentro: se
  // descuenta la que hubiera caído en la ventana y se pone la previsión entera.
  // Así ni falta (el año que no tocó pagar) ni sobra (el año que cayeron dos).
  const IPT=iptNetaMes();
  const irpfAnual=irpfAnualPrevisto();
  let irpfEnVentana=0; const irpfPagos=[];
  try{ saludRealExpenses().forEach(x=>{
    const k=(x.date||'').slice(0,7);
    if(k>=d.startWin&&k<=d.endWin&&esPagoIRPF(x.name)){
      irpfEnVentana+=Number(x.amt)||0;
      irpfPagos.push({date:x.date,name:String(x.name||'').slice(0,28),amt:Number(x.amt)||0});
    }
  }); }catch(e){fallo('saludRealExpenses',e)}
  irpfPagos.sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const meses=d.months12||12;
  const gastoBaseMes=meses?(Math.max(0,d.sum12-irpfEnVentana)/meses):d.avg12;
  const avgTot=gastoBaseMes+(meses?irpfAnual/meses*(meses/12):0);
  const colchon=avgTot>0?d.cash/avgTot:0;
  // Lo que consume patrimonio no es el gasto, es el gasto menos la IPT, que
  // es vitalicia. Si la IPT cubre el gasto, el patrimonio no se toca: la
  // autonomía no es un número de meses, es indefinida.
  // v140 · La autonomía se mide sobre el gasto de VIVIR, sin la declaración:
  // en ese escenario no hay nómina y la IPT sola no tributa.
  const AU=autonomiaDetalle(gastoBaseMes,d.cash,d.pat);
  const autonomia=AU.meses;
  const autonomiaSinIpt=gastoBaseMes>0?d.pat/gastoBaseMes:0;
  const yoy=d.yoyOk?pctTxt(d.yoyCur,d.yoyPrev):null;
  const y12=d.cmpOk?pctTxt(d.sum12,d.sumPrev12):null;
  // el denominador lleva también su parte de declaración: si no, lo recortable
  // parece pesar más de lo que pesa
  const totConIRPF=Math.max(0,d.totCat-irpfEnVentana)+irpfAnual*(meses/12);
  const discPct=totConIRPF>0?d.disc/totConIRPF*100:0;
  const ddTxt=d.curDD>=-0.001?'en máximos':(d.curDD*100).toFixed(1).replace('.',',')+'%';
  const win=fmtMonth(d.startWin)+' → '+fmtMonth(d.endWin);
  const sinDato='<span style="color:var(--faint);font-size:13px">sin histórico</span>';

  box.innerHTML=
    kc('Colchón de liquidez',saludMonthsWord(colchon),
       'cash '+fmt(d.cash)+'€ ÷ '+fmt(avgTot)+'€/mes'+
       (irpfAnual>0?' = '+fmt(gastoBaseMes)+'€ de vida + '+fmt(irpfAnual/12)+'€ de renta':' de gasto'),
       colchon>=6?'teal':(colchon>=3?'amber':'red'))+
    kc('Autonomía total',
       isFinite(autonomia)?saludMonthsWord(autonomia)
         :'<span style="color:var(--teal)">indefinida</span>',
       IPT.hay
         ? (isFinite(autonomia)
             ? fmt(gastoBaseMes)+'€ de vida − '+fmt(IPT.mes)+'€ de IPT = '+fmt(AU.drenaje)+'€/mes'+
               ' · sin la IPT serían '+saludMonthsWord(autonomiaSinIpt)
             : 'tu IPT neta ('+fmt(IPT.mes)+'€/mes) cubre el gasto de '+fmt(gastoBaseMes)+'€: el patrimonio no se toca')
         : 'todo el patrimonio al ritmo de gasto actual, sin contar rentabilidad',
       isFinite(autonomia)?'navy':'teal')+
    kc('Desde tu máximo',ddTxt,
       'máximo '+fmt(d.peak)+'€'+(d.peakYM?' ('+d.peakYM+')':''),
       d.curDD>=-0.001?'teal':(d.curDD>-0.1?'amber':'red'))+
    kc('Gasto '+d.months12+'m vs '+d.months12+'m previos',y12?y12.t:sinDato,
       y12?(fmt(d.sum12)+'€ frente a '+fmt(d.sumPrev12)+'€')
          :('no hay gastos importados antes de '+fmtMonth(d.covStart||d.startWin)),
       y12?y12.c:'')+
    kc('Gasto vs mismo mes año ant.',yoy?yoy.t:sinDato,
       yoy?(fmtMonth(d.lastClosed)+': '+fmt(d.yoyCur)+'€ · '+fmtMonth(d.yoyPrevKey)+': '+fmt(d.yoyPrev)+'€')
          :(d.yoyPrevKey?fmtMonth(d.yoyPrevKey)+' sólo tiene '+d.cntPrev+' movimientos frente a '+d.cntCur+': no comparable':''),
       yoy?yoy.c:'')+
    kc('Gasto discrecional',Math.round(discPct)+'%',
       fmt(d.disc/Math.max(1,meses))+'€/mes de '+fmt(totConIRPF/Math.max(1,meses))+'€ · lo recortable','purple');

  if(note)note.innerHTML='<div style="font-size:11.5px;color:var(--muted);margin-top:.5rem;line-height:1.55">'+
    '<strong>Cómo se calcula:</strong> el gasto medio son los <strong>'+d.months12+' últimos meses cerrados</strong> ('+win+'); '+
    'el mes en curso se excluye porque está a medias y ensuciaría la media. '+
    'Los agregados históricos deducidos de 2015-2024 no entran, y los gastos ya compensados por un reembolso tampoco. '+
    (!d.cmpOk||!d.yoyOk?'Las comparaciones interanuales aparecerán cuando haya un año completo de movimientos importados por detrás (los tuyos empiezan en '+fmtMonth(d.covStart||d.startWin)+'): comparar contra meses sin datos daría subidas enormes que no son reales. ':'')+
    '<strong>Discrecional</strong> = '+[...CAT_DISCRECIONAL].map(c=>CAT_LABELS[c]||c).join(', ')+'. '+
    (d.worstYM?'Tu peor caída desde máximos fue del <strong>'+(d.worst*100).toFixed(1).replace('.',',')+'%</strong> en '+d.worstYM+'. ':'')+
    (irpfAnual>0?'El gasto medio incluye la <strong>declaración de la renta</strong> ('+fmt(irpfAnual)+
      '€ al año, '+fmt(irpfAnual/12)+'€/mes): es un pago anual y seguro, y dejarlo fuera alargaba el colchón y '+
      'la autonomía y encogía el peso de lo discrecional. '+
      (irpfEnVentana>0?'Dentro de esos meses ya pagaste <strong>'+fmt(irpfEnVentana)+'€</strong> a Hacienda ('+
        irpfPagos.map(x=>fmtDate(x.date)+' '+escapeHtml(x.name)+' '+fmt(x.amt)+'€').join(' · ')+
        '), y se descuentan para no contarlos dos veces con la previsión. ':''):'')+
    (IPT.hay?'<br><br><strong>La autonomía se mide en otro escenario</strong>: el de haber dejado de trabajar. '+
      'Ahí no hay nómina, así que la declaración de la renta no se repite y NO entra en el gasto; queda solo tu IPT, '+
      fmt2(IPT.brutoMes)+'€ × '+IPT.pagas+' pagas = '+fmt(IPT.anual)+'€ al año, '+
      (IPT.cuota>0?'de los que '+fmt(IPT.cuota)+'€ son IRPF, '
        :'que sola no llega al mínimo que tributa y por eso se cobra íntegra, ')+
      fmt(IPT.mes)+'€/mes. El patrimonio solo se consume por la diferencia: '+
      fmt(gastoBaseMes)+'€ − '+fmt(IPT.mes)+'€ = <strong>'+fmt(AU.drenaje)+'€/mes</strong>. '+
      (AU.deuda>0?'Se descuenta una vez la declaración que ya debes ('+fmt(AU.deuda)+'€): dejar de trabajar en enero no te libra de la del año anterior. ':'')+
      (AU.mesesInv>0&&AU.g>0.01?'Y se cuenta en dos tramos, porque el dinero no está todo en la cuenta: primero el efectivo, '+
        'que no tributa ('+saludMonthsWord(AU.mesesCash)+'), y después las inversiones ('+saludMonthsWord(AU.mesesInv)+'), '+
        'donde hay que vender '+(AU.factor).toFixed(2).replace('.',',')+'€ por cada euro que gastas: el '+
        Math.round(AU.g*100)+'% de su valor es plusvalía latente y tributa al 19%. ':'')+
      'Todo esto supone que el patrimonio no renta nada mientras lo gastas: es un suelo, no una previsión. '
      :'La <strong>autonomía</strong> supone gastar el patrimonio sin que rente nada: es un suelo, no una previsión.')+
    '</div>';
}


// ════════════════════════════════════════════════════════════════════
// v138 · LO QUE HACIENDA SE LLEVA, DENTRO DE LAS CUENTAS
// ════════════════════════════════════════════════════════════════════
// Tres números de la app se estaban contando en bruto y no lo son:
//
//   · Las plusvalías realizadas. Vendes con 5.000 € de ganancia y no son
//     5.000 € tuyos: nadie te retiene al vender, pero el 19-21% lo debes
//     desde ese mismo día. Enseñarlo en bruto es enseñar dinero prestado.
//   · El gasto medio, que ignoraba la declaración de la renta. Es un pago
//     anual, seguro y de los grandes: dejarlo fuera hace que el colchón y
//     la autonomía salgan más largos de lo que son, y que el porcentaje de
//     gasto discrecional salga más alto, porque el denominador va corto.
//   · La autonomía, que suponía cero ingresos. Falso en tu caso: la IPT es
//     vitalicia y se cobra pase lo que pase. Lo que consume patrimonio no
//     es el gasto, es el gasto MENOS la IPT.

// ── El IRPF de unas plusvalías, medido en el margen ──────────────────
// El tipo no es una constante: depende de dónde caiga la ganancia dentro de
// tu base del ahorro, donde ya están los intereses y los dividendos del año.
// Por eso se calcula como diferencia: lo que pagarías con ella menos lo que
// pagarías sin ella.
function irpfDePlusvalias(anio,ganancia){
  if(!(ganancia>0))return 0;
  let otros=0;
  try{ const K=fiscalCapMob(Number(anio)); otros=Math.max(0,Number(K&&K.total)||0); }catch(e){fallo('K',e)}
  return Math.max(0,calcIRPFGain(otros+ganancia)-calcIRPFGain(otros));
}
// Las ventas de un periodo, año por año: cada año fiscal tiene su propia
// base del ahorro y las pérdidas de un año no bajan el tipo de otro.
function plusvaliasNetas(ventas){
  const porAnio={};
  (ventas||[]).forEach(t=>{
    const a=String(t.date||'').slice(0,4); if(!a)return;
    porAnio[a]=(porAnio[a]||0)+(Number(t.gainLoss)||0);
  });
  let bruto=0,irpf=0;
  Object.keys(porAnio).forEach(a=>{ bruto+=porAnio[a]; irpf+=irpfDePlusvalias(a,porAnio[a]); });
  return {bruto,irpf,neto:bruto-irpf,porAnio,
    tipo:bruto>0?irpf/bruto:0};
}

// ── La IPT, neta y por meses ─────────────────────────────────────────
// Tributa (no está exenta: solo lo están la absoluta y la gran invalidez),
// así que lo que de verdad entra en casa es el bruto menos su IRPF. Y se
// calcula sobre la IPT sola, que es lo que quedaría si dejaras de trabajar.
function iptNetaMes(){
  const vacio={anual:0,neta:0,mes:0,cuota:0,hay:false};
  try{
    const c=pensionCfg(); const mes=Number(c.iptMes)||0;
    if(!(mes>0))return vacio;
    const pagas=(typeof iptNumPagas==='function')?iptNumPagas():(Number(c.iptPagas)||14);
    const anual=mes*pagas;
    let edad=55;
    if(c.nacimientoFecha){
      const e=Math.floor((Date.now()-Date.parse(c.nacimientoFecha))/(365.25*864e5));
      if(isFinite(e)&&e>0&&e<110)edad=e;
    }
    const F=irpfCalc(anual,edad,{ccaa:c.ccaa,discapacidad:c.discapacidad,asistencia:c.asistencia});
    return {anual,neta:F.neto,mes:F.neto/12,cuota:F.cuota,pagas,brutoMes:mes,hay:true};
  }catch(e){ return vacio; }
}

// ── La declaración del año que viene, como gasto ─────────────────────
function irpfAnualPrevisto(){
  try{
    const P=(typeof fiscalPrevisiones==='function'?fiscalPrevisiones():[])
      .filter(x=>/declaraci|irpf|renta/i.test(String(x.concepto||'')));
    // Ojo con coger la primera por fecha: la más próxima suele ser el segundo
    // plazo del año pasado, que es solo el 40% de aquella declaración. Lo que
    // se busca aquí es lo que cuesta un año entero, así que fuera los plazos
    // y, de lo que quede, la cifra mayor.
    const enteras=P.filter(x=>!/plazo/i.test(String(x.concepto||'')));
    const L=(enteras.length?enteras:P).map(x=>Math.max(0,Number(x.importe)||0));
    if(L.length)return Math.max.apply(null,L);
  }catch(e){fallo('motor',e)}
  return 0;
}
// ── Reconocer un pago de la renta ya hecho ───────────────────────────
// Hace falta para no contarlo dos veces junto a la previsión. Y no es trivial:
// el cargo de la AEAT no dice "IRPF" por ninguna parte, se llama "AGENCIA
// ESTATAL DE LA ADMINISTRACION TRIBUTAR", y el segundo plazo de noviembre
// aparece como "TRIBUTO" seguido de un número de referencia. La primera
// versión no pillaba ninguno de los dos y sumaba la previsión encima de lo ya
// pagado: el gasto medio salía inflado.
// La segunda lista es igual de necesaria: el IBI y la basura los cobra "SUMA
// GESTION TRIBUTARIA", que también lleva la palabra tributaria y no tiene nada
// que ver con la renta. Esos son gastos recurrentes de verdad y se quedan.
const RE_IRPF_GASTO=/agencia\s+estatal|administraci[oó]n\s+tributaria|\baeat\b|\bhacienda\b|\birpf\b|declaraci[oó]n|modelo\s*100|renta\s*20\d\d|\btributo\s+\d/i;
const RE_NO_IRPF=/suma\s+gesti|\bibi\b|basura|vado|catastro|circulaci|\bitv\b|\btasa\b|multa|\bdgt\b|diputaci|ayuntamiento/i;
function esPagoIRPF(nombre){
  const n=String(nombre||'');
  return RE_IRPF_GASTO.test(n)&&!RE_NO_IRPF.test(n);
}


// ── La autonomía, contada como se vive de verdad ─────────────────────
// v140 · Lo viste antes que yo: si la autonomía supone dejar de trabajar,
// la declaración de la renta que la app tiene prevista NO pinta nada ahí. Esa
// previsión está construida sobre tu nómina, y en ese escenario no hay nómina.
// Una IPT sola, de unos X € al año, no llega al mínimo que tributa: cero IRPF.
//
// Pero cero del todo tampoco. Quedan dos cosas:
//
//   · La declaración del último año trabajado, que se debe igual aunque dejes
//     de trabajar en enero. Se descuenta UNA vez del patrimonio, como la deuda
//     que es, en vez de arrastrarla todos los meses.
//   · El IRPF de lo que hay que vender para comer. El dinero no está todo en
//     la cuenta: para sacar 1.000 € de un fondo con plusvalía hay que vender
//     más de 1.000 €, porque una parte se la queda Hacienda. Por eso se cuenta
//     en dos tramos: primero el efectivo, que no tributa, y después las
//     inversiones, que sí.
function autonomiaDetalle(gastoVidaMes,cash,pat){
  const IPT=iptNetaMes();
  const drenaje=Math.max(0,(Number(gastoVidaMes)||0)-IPT.mes);
  const deuda=irpfAnualPrevisto();                 // la última declaración, se debe igual
  const inv=Math.max(0,(Number(pat)||0)-(Number(cash)||0));
  // Qué parte del valor de tus inversiones es plusvalía latente: es lo único
  // que tributa al vender. Las pérdidas no suman aquí (compensan, no pagan).
  let valor=0, ganancia=0;
  try{
    (cfg.funds||[]).forEach(f=>{
      const v=Number((getFundVLInfo(f.id)||{}).amount)||0;
      const c=Number(getFundInvested(f.id))||0;
      if(v>0){ valor+=v; ganancia+=Math.max(0,v-c); }
    });
  }catch(e){fallo('motor',e)}
  try{
    (buildTradeOps().open||[]).forEach(o=>{
      const v=Number(o.value)||0;
      if(v>0){ valor+=v; ganancia+=Math.max(0,v-(Number(o.invested)||0)); }
    });
  }catch(e){fallo('motor',e)}
  const g=valor>0?Math.min(1,ganancia/valor):0;
  const tipo=0.19;                                  // primer tramo de la base del ahorro
  const factor=1/Math.max(0.5,1-g*tipo);            // hay que vender esto por cada euro que gastas
  if(drenaje<=0)return {infinita:true,drenaje:0,ipt:IPT,deuda,g,factor,mesesCash:0,mesesInv:0,meses:Infinity};
  const cashUtil=Math.max(0,(Number(cash)||0)-deuda);
  const mesesCash=cashUtil/drenaje;
  const mesesInv=inv>0?inv/(drenaje*factor):0;
  return {infinita:false,drenaje,ipt:IPT,deuda,g,factor,valorInv:inv,
    mesesCash,mesesInv,meses:mesesCash+mesesInv};
}

// ════════════════════════════════════════════
// v94 · RECATEGORIZACIÓN EN BLOQUE DE GASTOS "OTRO"
// ════════════════════════════════════════════
const RECAT_STOP=new Set(['pago','pagos','movil','moviles','tarjeta','compra','compras','recibo','recib','transf','trans','del','las','los','por','con','sau','slu','com','www','online','espana','spain','eur','card','payment','operacion','cargo','importe']);
function recatNorm(s){
  return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
}
function recatTokens(name){
  return recatNorm(cleanDesc(name)).split(' ').filter(w=>w.length>2&&!/\d/.test(w)&&!RECAT_STOP.has(w));
}
// Agrupa "AMZN MKTP ES 8T68D94M5" y "AMZN MKTP ES T19RW1DB5" bajo la misma clave.
// Fuera pasarelas y topónimos: así "PAYPAL *TEMU" agrupa por "temu" y
// "DECATHLON MURCIA THADER" por "decathlon", que es lo que identifica el gasto.
function recatKey(name){
  const all=recatTokens(name);
  const t=all.filter(w=>!RECAT_PAY.has(w)&&!RECAT_GEO.has(w));
  const use=t.length?t:all;
  return use.slice(0,3).join(' ')||recatNorm(name).slice(0,24)||'(sin concepto)';
}
// Los agregados históricos 2015-2024 no son gastos reales que puedas clasificar
function isHistExp(x){return String(x.id||'').startsWith('histexp_');}
function recatIgnored(){return cfg.recatIgnored||(cfg.recatIgnored=[]);}
function recatPending(includeIgnored){
  const ig=new Set(recatIgnored());
  return expenseLog.filter(x=>(!x.cat||x.cat==='otro')&&!isHistExp(x)
    &&(includeIgnored||!ig.has(recatKey(x.name))));
}

// ─── Motor de sugerencias ────────────────────────────────────────────
let _recatIndex=null;
function recatBuildIndex(){
  const idx={};
  expenseLog.forEach(x=>{
    if(!x.cat||x.cat==='otro'||isHistExp(x))return;
    new Set(recatTokens(x.name)).forEach(tk=>{
      (idx[tk]||(idx[tk]={}))[x.cat]=(idx[tk][x.cat]||0)+1;
    });
  });
  _recatIndex=idx;
}
// Pasarelas de pago: aparecen en el concepto pero no dicen NADA del gasto.
// Sin esto, "PAYPAL *EURODEPOTES" acababa en Suscripciones sólo porque
// la mayoría de tus cargos de PayPal lo son.
const RECAT_PAY=new Set(['paypal','bizum','sumup','redsys','stripe','klarna','izettle','tpv','visa','mastercard','maestro','contactless','revolut','payu','adyen','verse','twyp','applepay','gpay','shopify','wallet']);
// Topónimos: "MEDIA MARKT MURCIA" no es Hogar por ser de Murcia.
const RECAT_GEO=new Set(['madrid','barcelona','valencia','sevilla','zaragoza','malaga','murcia','palma','bilbao','alicante','cordoba','valladolid','vigo','gijon','coruna','vitoria','granada','elche','oviedo','badalona','cartagena','terrassa','jerez','sabadell','mostoles','alcala','pamplona','almeria','fuenlabrada','leganes','donostia','santander','castellon','burgos','albacete','getafe','alcorcon','logrono','salamanca','huelva','marbella','lleida','tarragona','leon','cadiz','jaen','ourense','girona','lugo','caceres','melilla','ceuta','toledo','pontevedra','palencia','zamora','avila','segovia','soria','cuenca','teruel','huesca','merida','guadalajara','alcasser','picassent','thader','condomina','espinardo','alcantarilla','torrevieja','orihuela','molina','nueva','centro','sur','norte','este','oeste']);
// Sinónimos de comercio → se resuelven contra TUS categorías propias por nombre
const RECAT_ALIAS=[[/\bamzn\b|\bamazon\b/,'amazon'],[/aliexpress|\bali ?express\b/,'aliexpress']];
const RECAT_HINTS=[
  [/\bbar\b|taberna|tasca|meson|cafeter|cerveceri|pizzer|burger|kebab|churrer|bodegon|freidur|asador|gastrobar/,'restaurante'],
  [/aparc|parking|gasolin|neumatic|taller mecanic|autolav|carburant|peaje|\bgrua\b|\bitv\b/,'vehiculo'],
  [/\bcine\b|teatro|museo|bolera|juguet|concierto|festival/,'ocio'],
  [/decathlon|deporvillage|zapater|lenceri|merceri/,'ropa'],
  [/fontaner|electricist|cerrajer|albanil|ferreteri|bricolaj|climatiza|sat clima|caldera/,'hogar'],
  [/farmac|clinic|dentist|\boptic/,'salud'],
  [/hotel|hostal|camping|\brenfe\b|\balsa\b/,'viaje'],
];
function catKeyByLabel(lbl){
  const t=String(lbl).toLowerCase();
  return Object.keys(CAT_LABELS).find(k=>String(CAT_LABELS[k]).toLowerCase()===t)||null;
}
// Voto ponderado: el comercio casi siempre encabeza el concepto, y sólo cuentan
// las palabras que en TU historial apuntan a una categoría de forma consistente.
function recatVotes(g){
  if(!_recatIndex) recatBuildIndex();
  const votes={};
  recatTokens(g.sample).forEach((t,i)=>{
    if(RECAT_PAY.has(t)||RECAT_GEO.has(t))return;
    const m=_recatIndex[t]; if(!m)return;
    const tot=Object.values(m).reduce((a,b)=>a+b,0);
    const top=Object.entries(m).sort((a,b)=>b[1]-a[1])[0];
    if(top[1]/tot<0.7)return;                 // palabra ambigua: no cuenta
    if(!CAT_LABELS[top[0]])return;            // categoría borrada
    const w=i===0?3:(i===1?2:1);              // peso por posición
    votes[top[0]]=(votes[top[0]]||0)+w*Math.min(top[1],5);
    (votes._ev||(votes._ev={}))[top[0]]=Math.max((votes._ev||{})[top[0]]||0,top[1]);
  });
  const ev=votes._ev||{}; delete votes._ev;
  return {list:Object.entries(votes).sort((a,b)=>b[1]-a[1]),ev};
}
function recatSuggest(g){
  // 1) una regla tuya de importación (lo más fiable que hay)
  const auto=catExpense(g.sample);
  if(auto&&auto!=='otro'&&CAT_LABELS[auto]) return {cat:auto,why:'coincide con una regla tuya'};
  const nm=recatNorm(cleanDesc(g.sample));
  // 2) alias de comercio hacia una categoría tuya
  for(const [re,lbl] of RECAT_ALIAS){
    if(re.test(nm)){const k=catKeyByLabel(lbl); if(k) return {cat:k,why:'es '+lbl};}
  }
  // 3) voto de tus gastos ya clasificados
  const {list,ev}=recatVotes(g);
  if(list.length&&list[0][1]>=6&&(list.length===1||list[0][1]>=list[1][1]*1.5))
    return {cat:list[0][0],why:ev[list[0][0]]+' gasto'+(ev[list[0][0]]!==1?'s':'')+' tuyo'+(ev[list[0][0]]!==1?'s':'')+' con esa palabra'};
  // 4) palabra clave genérica
  for(const [re,c] of RECAT_HINTS) if(re.test(nm)&&CAT_LABELS[c]) return {cat:c,why:'palabra clave'};
  // 5) indicio flojo: se muestra pero no entra en el "aplicar todo"
  if(list.length) return {cat:list[0][0],why:'indicio débil, revísalo',weak:true};
  return null;
}

let _recatCache=[];
let _recatOpen=false; // v110 · plegado por defecto: no debe ocupar la pantalla a diario
let _recatShowIgnored=false;
function recatGroups(){
  const g={};
  recatPending(_recatShowIgnored).forEach(x=>{
    const k=recatKey(x.name);
    if(!g[k]) g[k]={key:k,items:[],total:0,sample:x.name,last:x.date};
    g[k].items.push(x); g[k].total+=Number(x.amt)||0;
    if(x.date>g[k].last){g[k].last=x.date;g[k].sample=x.name;}
  });
  return Object.values(g).sort((a,b)=>b.items.length-a.items.length||b.total-a.total);
}
function toggleRecat(){
  _recatOpen=!_recatOpen;
  try{ALM.setItem('dlv_recatopen',_recatOpen?'1':'0');}catch(e){fallo('ALM.setItem',e)}
  renderRecatPanel();
}
function recatToggleIgnored(){_recatShowIgnored=!_recatShowIgnored;renderRecatPanel();}
function catOptionsHtml(sel){
  // sin sugerencia se queda en blanco a propósito: nunca debe aplicarse una
  // categoría sólo porque sea la primera de la lista
  return '<option value=""'+(sel?'':' selected')+'>— elige categoría —</option>'+
    Object.entries(CAT_LABELS).map(([k,v])=>
      '<option value="'+k+'"'+(k===sel?' selected':'')+'>'+v+'</option>').join('');
}
function renderRecatPanel(){
  const body=document.getElementById('recat-body');
  const badge=document.getElementById('recat-badge');
  const arrow=document.getElementById('recat-arrow');
  if(!body)return;
  if(arrow)arrow.textContent=_recatOpen?'▾':'▸';
  const pend=recatPending(false);
  const tot=pend.reduce((s,x)=>s+(Number(x.amt)||0),0);
  const nIg=recatIgnored().length;
  if(badge) badge.innerHTML = pend.length
    ? pend.length+' gastos · '+fmt(tot)+'€ en «Otro»'
    : '<span style="color:var(--teal)">todo clasificado ✓</span>';
  if(!_recatOpen){body.innerHTML='';return;}
  _recatCache=recatGroups();
  if(!_recatCache.length){
    body.innerHTML='<div style="font-size:12px;color:var(--muted)">No queda ningún gasto en «Otro».'+
      (nIg?' <a href="#" onclick="event.preventDefault();recatToggleIgnored()" style="color:var(--navy)">Ver '+nIg+' concepto(s) marcados como Otro a propósito</a>':'')+'</div>';
    return;
  }
  const nSug=_recatCache.filter(g=>{const s=recatSuggest(g);return s&&!s.weak;}).length;
  let h='<div style="font-size:11.5px;color:var(--muted);margin-bottom:.6rem">'+
    'Agrupados por concepto. La sugerencia sale de tus propios gastos ya clasificados — revísala antes de aplicar. '+
    '<strong>'+nSug+'</strong> de '+_recatCache.length+' grupos tienen sugerencia fiable.'+
    (nIg?' · <a href="#" onclick="event.preventDefault();recatToggleIgnored()" style="color:var(--navy)">'+(_recatShowIgnored?'ocultar':'ver')+' '+nIg+' marcados como Otro</a>':'')+
    '</div>';
  h+='<div class="tbl-scroll"><table class="detail-table" style="font-size:12px">'+
     '<thead><tr><th>Concepto</th><th>Nº</th><th>Importe</th><th>Último</th><th style="text-align:left">Categoría</th><th></th></tr></thead><tbody>';
  const ig=new Set(recatIgnored());
  _recatCache.forEach((g,i)=>{
    const s=recatSuggest(g);
    const isIg=ig.has(g.key);
    const why=s?('<div style="font-size:10px;color:'+(s.weak?'var(--faint)':'var(--teal)')+'">'+(s.weak?'⚠ ':'✓ ')+s.why+'</div>'):
      '<div style="font-size:10px;color:var(--faint)">sin sugerencia</div>';
    h+='<tr'+(isIg?' style="opacity:.5"':'')+'>'+
      '<td style="max-width:230px"><div style="font-weight:600">'+escapeHtml(g.sample).slice(0,60)+'</div>'+
        '<div style="font-size:10px;color:var(--faint)">clave: '+escapeHtml(g.key)+'</div></td>'+
      '<td>'+g.items.length+'</td>'+
      '<td>'+fmt2(g.total)+'€</td>'+
      '<td style="white-space:nowrap">'+fmtDate(g.last)+'</td>'+
      '<td style="text-align:left">'+
        '<select id="recat-sel-'+i+'" style="font-size:11px;min-width:130px">'+catOptionsHtml(s?s.cat:'')+'</select>'+why+
        '<label style="display:block;font-size:10px;color:var(--muted);margin-top:3px">'+
          '<input type="checkbox" id="recat-rule-'+i+'" checked style="vertical-align:-1px"> crear regla para '+
          '<input type="text" id="recat-txt-'+i+'" value="'+escapeHtml(g.key)+'" style="font-size:10px;width:120px;padding:1px 4px">'+
        '</label>'+
      '</td>'+
      '<td style="white-space:nowrap">'+
        '<button type="button" class="btn-xs" style="background:var(--navy);color:#fff;border-color:var(--navy)" onclick="recatApplyGroup('+i+')">Aplicar</button> '+
        '<a href="#" onclick="event.preventDefault();recatIgnore('+i+')" style="font-size:10px;color:var(--muted);text-decoration:none" title="Es realmente Otro: no volver a preguntar">'+(isIg?'↩':'✕')+'</a>'+
      '</td></tr>';
  });
  h+='</tbody></table></div>';
  body.innerHTML=h;
  markScrollables(body);
}
function escapeHtml(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function recatRefreshViews(){
  _recatIndex=null; save(); renderRecatPanel();
  try{renderGastosList();}catch(e){fallo('renderGastosList',e)}
  try{renderGastosDashboard();}catch(e){fallo('renderGastosDashboard',e)}
}
function recatApplyGroup(i){
  const g=_recatCache[i]; if(!g)return;
  const cat=document.getElementById('recat-sel-'+i)?.value||'';
  if(!cat||cat==='otro'){toast('Elige una categoría distinta de «Otro»');return;}
  const mkRule=document.getElementById('recat-rule-'+i)?.checked;
  const txt=(document.getElementById('recat-txt-'+i)?.value||'').trim();
  g.items.forEach(x=>{x.cat=cat;});
  if(mkRule&&txt){
    if(!cfg.catRules)cfg.catRules=[];
    if(!cfg.catRules.some(r=>(r.m||'').toLowerCase()===txt.toLowerCase()&&r.cat===cat))
      cfg.catRules.push({m:txt,cat});
    try{renderCatRules();}catch(e){fallo('renderCatRules',e)}
  }
  recatRefreshViews();
  toast(g.items.length+' gasto'+(g.items.length!==1?'s':'')+' → '+(CAT_LABELS[cat]||cat)+(mkRule&&txt?' · regla guardada':''));
}
function recatIgnore(i){
  const g=_recatCache[i]; if(!g)return;
  const arr=recatIgnored();
  const at=arr.indexOf(g.key);
  if(at>=0){arr.splice(at,1);toast('«'+g.key+'» vuelve a la lista');}
  else{arr.push(g.key);toast('«'+g.key+'» marcado como Otro a propósito');}
  save();renderRecatPanel();
}
function recatApplyAllSuggestions(){
  if(!_recatCache.length)_recatCache=recatGroups();
  const list=_recatCache.map((g,i)=>({g,s:recatSuggest(g)}))
    .filter(o=>o.s&&!o.s.weak&&o.s.cat&&o.s.cat!=='otro'&&CAT_LABELS[o.s.cat]);
  if(!list.length){toast('No hay sugerencias fiables que aplicar');return;}
  const n=list.reduce((s,o)=>s+o.g.items.length,0);
  const resumen=list.slice(0,8).map(o=>'· '+o.g.key+' → '+CAT_LABELS[o.s.cat]).join('\n')+(list.length>8?'\n· … y '+(list.length-8)+' más':'');
  if(!confirm('Aplicar '+list.length+' sugerencias a '+n+' gastos?\n\n'+resumen+'\n\nPodrás corregir cualquiera después en la lista de gastos.'))return;
  if(!guardedAction('aplicar '+list.length+' sugerencias de categoría'))return;
  list.forEach(o=>o.g.items.forEach(x=>{x.cat=o.s.cat;}));
  recatRefreshViews();
  toast('✅ '+n+' gastos clasificados');
}

// ════════════════════════════════════════════
// v94 · USABILIDAD: fechas por defecto + tablas deslizables en móvil
// ════════════════════════════════════════════
function todayISO(){
  const t=new Date();
  return t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0');
}
// v169 · FECHAS SIN PASAR POR LA HORA UNIVERSAL
// toISOString() da la fecha en UTC. Con una fecha a medianoche de España, eso
// es el día anterior: sumar 65 años al 3/4/1980 daba el 2/4/2045, y de ahí el
// «a los 65… con 64 años» de la jubilación. Estas funciones trabajan con la
// fecha tal cual: las de sumar, en UTC de principio a fin (sin horarios de
// verano por medio), y isoLocal, con la fecha que ves en el reloj.
function isoLocal(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function _isoUTC(iso){ return new Date(String(iso).slice(0,10)+'T00:00:00Z'); }
function isoMasDias(iso,n){ const d=_isoUTC(iso); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function isoMasMeses(iso,n){
  const d=_isoUTC(iso), dia=d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth()+n);
  const ult=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
  d.setUTCDate(Math.min(dia,ult));              // 31 de marzo menos un mes: 28 o 29 de febrero
  return d.toISOString().slice(0,10);
}
function isoMasAnios(iso,n){ return isoMasMeses(iso,12*n); }
function isoDias(a,b){ return Math.round((_isoUTC(b)-_isoUTC(a))/864e5); }
// Rellena con la fecha de hoy cualquier input[data-today] que esté vacío.
// (v93 tenía 5 campos con un template literal sin interpolar → salían en blanco)
function initTodayDates(root){
  const scope=root||document;
  scope.querySelectorAll('input[type="date"][data-today]').forEach(el=>{
    if(!el.value) el.value=todayISO();
  });
}

let _wrapPending=false;
function markScrollables(scope){
  (scope||document).querySelectorAll('.tbl-scroll').forEach(w=>{
    w.classList.toggle('is-scrollable',w.scrollWidth-w.clientWidth>4);
  });
}
// Envuelve cada <table> en un contenedor con scroll horizontal propio, para que
// el desbordamiento se quede dentro de la tabla y no desplace la página entera.
function wrapTables(root){
  const scope=root||document;
  let touched=false;
  scope.querySelectorAll('table').forEach(t=>{
    if(t.closest('.tbl-scroll')) return;
    const p=t.parentElement; if(!p) return;
    const w=document.createElement('div');
    w.className='tbl-scroll';
    p.insertBefore(w,t); w.appendChild(t);
    touched=true;
  });
  markScrollables(scope);
  return touched;
}
function scheduleWrapTables(){
  if(_wrapPending) return;
  _wrapPending=true;
  requestAnimationFrame(()=>{ _wrapPending=false; wrapTables(); initTodayDates(); });
}
// Cualquier render que inyecte HTML nuevo queda cubierto sin tocar cada función.
function initLayoutObserver(){
  try{
    const obs=new MutationObserver(muts=>{
      for(const m of muts){
        for(const nd of m.addedNodes){
          if(nd.nodeType===1&&(nd.tagName==='TABLE'||nd.querySelector?.('table')||nd.matches?.('input[type="date"][data-today]')||nd.querySelector?.('input[type="date"][data-today]'))){
            scheduleWrapTables(); return;
          }
        }
      }
    });
    obs.observe(document.body,{childList:true,subtree:true});
  }catch(e){console.warn('observer',e)}
  window.addEventListener('resize',()=>markScrollables());
}

// ════════════════════════════════════════════
// v96 · DATOS PERSONALES FUERA DEL CÓDIGO
// ════════════════════════════════════════════
// Hasta la v95 tus nóminas desglosadas y la serie diaria de la cartera vivían
// dentro del propio archivo HTML. Eso significaba que cualquier copia del
// programa llevaba tu sueldo dentro, y que ese histórico no se podía editar
// desde la interfaz ni viajaba en tus copias de seguridad. Ahora son datos
// como los demás: se guardan, se exportan y se sincronizan.
let personal={nominasHist:[],stockDaily:[],fundAnchors:[]};
function NOM_HIST(){return personal.nominasHist||[];}
function STK_DAILY(){return personal.stockDaily||[];}
function FUND_ANCHORS(){return personal.fundAnchors||[];}
function FUND_SER(){return personal.fundSeries||{};}
function personalCount(){return NOM_HIST().length+STK_DAILY().length+FUND_ANCHORS().length+Object.keys(FUND_SER()).length+Object.keys(personal.navHistory||{}).length;}
function loadPersonal(){
  try{const r=ALM.getItem('dlv_personal');if(r){const p=JSON.parse(r);if(p&&typeof p==='object')personal=p;}}catch(e){fallo('r',e)}
  personal.nominasHist=personal.nominasHist||[];
  personal.stockDaily=personal.stockDaily||[];
  personal.fundAnchors=personal.fundAnchors||[];
  personal.fundSeries=personal.fundSeries||{};
  personal.navHistory=personal.navHistory||{};
  // Migración automática desde las versiones que los llevaban incrustados
  let mig=0;
  try{
    if(!personal.nominasHist.length&&typeof NOMINAS_HIST!=='undefined'&&NOMINAS_HIST.length){
      personal.nominasHist=JSON.parse(JSON.stringify(NOMINAS_HIST));mig++;}
    if(!personal.stockDaily.length&&typeof STOCK_DAILY_RECON!=='undefined'&&STOCK_DAILY_RECON.length){
      personal.stockDaily=JSON.parse(JSON.stringify(STOCK_DAILY_RECON));mig++;}
    if(!personal.fundAnchors.length&&typeof COBAS_REAL_ANCHORS!=='undefined'&&COBAS_REAL_ANCHORS.length){
      personal.fundAnchors=JSON.parse(JSON.stringify(COBAS_REAL_ANCHORS));mig++;}
    if(!Object.keys(personal.fundSeries).length&&typeof FUND_SERIES!=='undefined'&&Object.keys(FUND_SERIES).length){
      personal.fundSeries=JSON.parse(JSON.stringify(FUND_SERIES));mig++;}
  }catch(e){console.warn('migracion personal',e);}
  if(mig)savePersonal();
}
function savePersonal(){
  try{ALM.setItem('dlv_personal',JSON.stringify(personal));}
  catch(e){console.warn('savePersonal',e);}
}
function setPersonal(p,how){
  if(!p||typeof p!=='object')return 0;
  const byKey=(arr,kf)=>{const m=new Map();(arr||[]).forEach(x=>m.set(String(kf(x)),x));return m;};
  let n=0;
  if(Array.isArray(p.nominasHist)){
    const m=how==='replace'?new Map():byKey(personal.nominasHist,x=>x.id);
    p.nominasHist.forEach(x=>{if(x&&x.id){m.set(String(x.id),x);n++;}});
    personal.nominasHist=[...m.values()];
  }
  if(Array.isArray(p.stockDaily)){
    const kf=r=>Array.isArray(r)?r[0]:r.d;
    const m=how==='replace'?new Map():byKey(personal.stockDaily,kf);
    p.stockDaily.forEach(r=>{const k=kf(r);if(k){m.set(String(k),r);n++;}});
    personal.stockDaily=[...m.values()].sort((a,b)=>String(kf(a))<String(kf(b))?-1:1);
  }
  if(Array.isArray(p.fundAnchors)){
    const kf=r=>Array.isArray(r)?r[0]:r.d;
    const m=how==='replace'?new Map():byKey(personal.fundAnchors,kf);
    p.fundAnchors.forEach(r=>{const k=kf(r);if(k){m.set(String(k),r);n++;}});
    personal.fundAnchors=[...m.values()].sort((a,b)=>String(kf(a))<String(kf(b))?-1:1);
  }
  if(p.navHistory&&typeof p.navHistory==='object'){
    if(how==='replace')personal.navHistory={};
    Object.keys(p.navHistory).forEach(k=>{personal.navHistory[k]=p.navHistory[k];n++;});
  }
  if(p.fundSeries&&typeof p.fundSeries==='object'){
    if(how==='replace')personal.fundSeries={};
    Object.keys(p.fundSeries).forEach(k=>{personal.fundSeries[k]=p.fundSeries[k];n++;});
  }
  savePersonal();
  return n;
}
function importPersonalFile(ev){
  const f=ev.target.files&&ev.target.files[0];
  if(!f)return;
  const r=new FileReader();
  r.onload=e=>{
    try{
      const j=JSON.parse(e.target.result);
      // v169 · el archivo de ajustes personales (tu nombre y tus reglas)
      if(j&&j._tipo==='dlv-ajustes-personales'){
        if(!guardedAction('cargar tus ajustes personales')){ev.target.value='';return;}
        const R=aplicarAjustesPersonales(j);
        save(); try{renderAll();}catch(_){fallo('renderAll',_)}
        toast(R.err?R.err:('✅ Ajustes personales cargados: '+(R.titular+R.reglas+R.pension+R.decl)+' dato(s) nuevos'));
        ev.target.value=''; return;
      }
      const p=j.personal||j;
      if(!p.nominasHist&&!p.stockDaily&&!p.fundAnchors&&!p.fundSeries&&!p.navHistory){
        toast('Ese archivo no lleva datos personales');ev.target.value='';return;
      }
      const n=setPersonal(p,'merge');
      renderPersonalBanner();
      try{renderAll();}catch(_){fallo('renderAll',_)}
      toast('✅ '+n+' registros personales incorporados');
    }catch(err){toast('No se pudo leer: '+err.message);}
    ev.target.value='';
  };
  r.readAsText(f);
}
// Aviso si hay datos de uso pero falta el histórico personal
function renderPersonalBanner(){
  const el=document.getElementById('personal-banner');
  if(!el)return;
  const usa=(expenseLog.length+records.length)>0;
  if(!usa||personalCount()>0){el.style.display='none';return;}
  el.style.display='flex';
  el.innerHTML='<div style="font-size:11.5px;color:var(--amber)">'+
    '<strong>Faltan tus datos personales históricos</strong> — nóminas desglosadas y serie diaria de la cartera. '+
    'Desde la v96 ya no viajan dentro del programa: impórtalos una vez desde <em>patrimonio_personales.json</em> '+
    'y a partir de ahí se guardan y se sincronizan como todo lo demás.</div>'+
    '<button class="btn-sm" onclick="document.getElementById(\'personal-file\').click()" '+
    'style="font-size:11.5px;background:var(--amber);color:#fff;border-color:var(--amber)">⬆ Importar</button>';
}

// ════════════════════════════════════════════
// v95 · SINCRONÍA DE TRES VÍAS ENTRE DISPOSITIVOS (por archivo)
// ════════════════════════════════════════════
// El "Fusionar" clásico mete lo del archivo por id y siempre gana el que entra:
// si borraste algo aquí, el archivo del otro aparato lo resucita, y si tocaste
// lo mismo en los dos sitios uno de los cambios desaparece sin avisar.
// Aquí se guarda una HUELLA del estado en la última sincronía (sólo hashes, no
// una copia). Con esa base se distingue "esto lo añadió el otro" de "esto lo
// borré yo", que es lo único que hace falta para no perder nada.

// ─── Huella estable ──────────────────────────────────────────────────
function stableStr(v){
  if(v===undefined) return 'u';
  if(v===null||typeof v!=='object') return JSON.stringify(v);
  if(Array.isArray(v)) return '['+v.map(stableStr).join(',')+']';
  return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stableStr(v[k])).join(',')+'}';
}
function hash32(s){
  let h=0x811c9dc5;
  for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}
  return h.toString(36);
}
function itemHash(x){return hash32(stableStr(x));}

// ─── Qué colecciones se sincronizan y cómo se identifica cada elemento ──
const SYNC_NS=[
  {k:'records',      label:'meses',            get:s=>s.records||[],      set:(s,a)=>s.records=a,      key:x=>x.id,
   desc:x=>x.label||x.id},
  {k:'transactions', label:'operaciones',      get:s=>s.transactions||[], set:(s,a)=>s.transactions=a, key:x=>x.id,
   desc:x=>(x.type||'op')+' · '+(x.date||'')+' · '+(x.amount!=null?x.amount+'€':'')},
  {k:'balanceLog',   label:'saldos',           get:s=>s.balanceLog||[],   set:(s,a)=>s.balanceLog=a,   key:x=>x.id,
   desc:x=>(x.refType||'')+' '+(x.refId||'')+' · '+(x.date||'')+' · '+(x.amount!=null?Math.round(x.amount)+'€':'')},
  {k:'incomeLog',    label:'ingresos',         get:s=>s.incomeLog||[],    set:(s,a)=>s.incomeLog=a,    key:x=>x.id,
   desc:x=>(x.date||'')+' · '+String(x.desc||'').slice(0,32)+' · '+(x.amt!=null?x.amt+'€':'')},
  {k:'expenseLog',   label:'gastos',           get:s=>s.expenseLog||[],   set:(s,a)=>s.expenseLog=a,   key:x=>x.id,
   desc:x=>(x.date||'')+' · '+String(x.name||'').slice(0,32)+' · '+(x.amt!=null?x.amt+'€':'')},
  {k:'brokerFlows',  label:'flujos de bróker', get:s=>s.brokerFlows||[],  set:(s,a)=>s.brokerFlows=a,  key:x=>x.id,
   desc:x=>(x.type||'')+' · '+(x.date||'')+' · '+(x.amount!=null?x.amount+'€':'')},
  {k:'reembolsos',   label:'reembolsos',       get:s=>s.reembolsos||[],   set:(s,a)=>s.reembolsos=a,   key:x=>x.id,
   desc:x=>(x.created||'').slice(0,10)+' · '+((x.expenseIds||[]).length)+' gasto(s)'},
  {k:'cfg.accounts', label:'cuentas',          get:s=>s.cfg.accounts||[], set:(s,a)=>s.cfg.accounts=a, key:x=>x.id, desc:x=>x.name||x.id},
  {k:'cfg.funds',    label:'fondos',           get:s=>s.cfg.funds||[],    set:(s,a)=>s.cfg.funds=a,    key:x=>x.id, desc:x=>x.name||x.id},
  {k:'cfg.stocks',   label:'acciones',         get:s=>s.cfg.stocks||[],   set:(s,a)=>s.cfg.stocks=a,   key:x=>x.id, desc:x=>x.name||x.id},
  {k:'cfg.debts',    label:'deudas',           get:s=>s.cfg.debts||[],    set:(s,a)=>s.cfg.debts=a,    key:x=>x.id, desc:x=>x.name||x.id},
  {k:'cfg.gastos_fijos', label:'gastos fijos', get:s=>s.cfg.gastos_fijos||[], set:(s,a)=>s.cfg.gastos_fijos=a, key:x=>x.id, desc:x=>x.name||x.id},
  {k:'cfg.brokers',  label:'brókers',          get:s=>s.cfg.brokers||[],  set:(s,a)=>s.cfg.brokers=a,  key:x=>x.id, desc:x=>x.name||x.id},
  // sin id propio: la clave es el contenido
  {k:'cfg.catRules', label:'reglas de categoría', get:s=>s.cfg.catRules||[], set:(s,a)=>s.cfg.catRules=a,
   key:x=>String(x.m||'').toLowerCase()+'|'+String(x.cat||''), desc:x=>'"'+x.m+'" → '+(CAT_LABELS[x.cat]||x.cat)},
  {k:'cfg.customCats', label:'categorías propias',
   get:s=>Object.entries(s.cfg.customCats||{}).map(([k,v])=>({k,v})),
   set:(s,a)=>{s.cfg.customCats={};a.forEach(x=>{s.cfg.customCats[x.k]=x.v;});},
   key:x=>x.k, desc:x=>x.v},
  {k:'cfg.recatIgnored', label:'conceptos marcados como Otro',
   get:s=>(s.cfg.recatIgnored||[]).map(v=>({v})),
   set:(s,a)=>{s.cfg.recatIgnored=a.map(x=>x.v);},
   key:x=>String(x.v), desc:x=>x.v},
  {k:'personal.nominasHist', label:'nóminas con desglose',
   get:s=>((s.personal||{}).nominasHist)||[],
   set:(s,a)=>{s.personal=s.personal||{};s.personal.nominasHist=a;},
   key:x=>x.id, desc:x=>x.desc||x.id},
  {k:'personal.stockDaily', label:'serie diaria de cartera',
   get:s=>(((s.personal||{}).stockDaily)||[]).map(r=>Array.isArray(r)?{d:r[0],e:r[1],r:r[2]}:r),
   set:(s,a)=>{s.personal=s.personal||{};
     s.personal.stockDaily=a.map(x=>[x.d,x.e,x.r]).sort((p,q)=>p[0]<q[0]?-1:1);},
   key:x=>String(x.d), desc:x=>x.d+' · '+x.e+'€'},
  {k:'personal.fundAnchors', label:'anclajes de valor de fondos',
   get:s=>(((s.personal||{}).fundAnchors)||[]).map(r=>Array.isArray(r)?{d:r[0],v:r[1],i:r[2]}:r),
   set:(s,a)=>{s.personal=s.personal||{};
     s.personal.fundAnchors=a.map(x=>[x.d,x.v,x.i]).sort((p,q)=>p[0]<q[0]?-1:1);},
   key:x=>String(x.d), desc:x=>x.d+' · '+x.v+'€'},
  {k:'personal.fundSeries', label:'series de valor de fondos',
   get:s=>Object.entries(((s.personal||{}).fundSeries)||{}).map(([k,v])=>({k,v})),
   set:(s,a)=>{s.personal=s.personal||{};s.personal.fundSeries={};a.forEach(x=>{s.personal.fundSeries[x.k]=x.v;});},
   key:x=>x.k, desc:x=>(x.v&&x.v.name)||x.k},
  {k:'personal.navHistory', label:'históricos de VL',
   get:s=>Object.entries(((s.personal||{}).navHistory)||{}).map(([k,v])=>({k,v})),
   set:(s,a)=>{s.personal=s.personal||{};s.personal.navHistory={};a.forEach(x=>{s.personal.navHistory[x.k]=x.v;});},
   key:x=>x.k, desc:x=>(x.v&&x.v.n?x.v.n+' días':x.k)},
  // v115 · Sin esta entrada los precios importados en el iMac no llegarían
  // nunca al iPad: la sincronía solo mueve lo que está en esta tabla.
  {k:'personal.stockPrices', label:'precios históricos de acciones',
   get:s=>Object.entries(((s.personal||{}).stockPrices)||{}).map(([k,v])=>({k,v})),
   set:(s,a)=>{s.personal=s.personal||{};s.personal.stockPrices={};a.forEach(x=>{s.personal.stockPrices[x.k]=x.v;});},
   key:x=>x.k, desc:x=>(x.v&&x.v.n?x.v.n+' precios':x.k)},
  {k:'soldStocks',   label:'posiciones cerradas',
   get:s=>(s.soldStocks||[]).map(v=>({v})),
   set:(s,a)=>{s.soldStocks=a.map(x=>x.v);},
   key:x=>String(x.v), desc:x=>x.v},
];

// ─── Estado como objeto plano (mismo formato que el archivo de copia) ──
function syncLocalState(){
  return {personal:JSON.parse(JSON.stringify(personal)),
    cfg:JSON.parse(JSON.stringify(cfg)),
    records:JSON.parse(JSON.stringify(records)),
    transactions:JSON.parse(JSON.stringify(transactions)),
    soldStocks:[...soldStocks],
    balanceLog:JSON.parse(JSON.stringify(balanceLog)),
    incomeLog:JSON.parse(JSON.stringify(incomeLog)),
    expenseLog:JSON.parse(JSON.stringify(expenseLog)),
    brokerFlows:JSON.parse(JSON.stringify(brokerFlows)),
    reembolsos:JSON.parse(JSON.stringify(reembolsos))};
}
function syncNormalize(st){
  const s=st||{};
  return {personal:s.personal||{},cfg:s.cfg||{},records:s.records||[],transactions:s.transactions||[],
    soldStocks:s.soldStocks||[],balanceLog:s.balanceLog||[],incomeLog:s.incomeLog||[],
    expenseLog:s.expenseLog||[],brokerFlows:s.brokerFlows||[],reembolsos:s.reembolsos||[]};
}
function syncDigest(st){
  const s=syncNormalize(st), out={};
  SYNC_NS.forEach(ns=>{
    const m={};
    (ns.get(s)||[]).forEach(x=>{const k=String(ns.key(x));if(k!=='undefined'&&k!=='null')m[k]=itemHash(x);});
    out[ns.k]=m;
  });
  return out;
}
function loadSyncBase(){
  try{const r=ALM.getItem('dlv_syncbase');return r?JSON.parse(r):null;}catch(e){return null;}
}
function saveSyncBase(st,seq,peer){
  try{
    ALM.setItem('dlv_syncbase',JSON.stringify({
      at:new Date().toISOString(),seq:seq||0,peer:peer||null,d:syncDigest(st)}));
  }catch(e){console.warn('syncbase',e);toast('⚠ No se pudo guardar la huella de sincronía');}
}
function syncDeviceName(){
  let n=null;
  try{n=ALM.getItem('dlv_devname');}catch(e){fallo('n',e)}
  if(n)return n;
  const ua=navigator.userAgent||'';
  if(/iPad/i.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1))return 'iPad';
  if(/iPhone/i.test(ua))return 'iPhone';
  if(/Macintosh|Mac OS X/i.test(ua))return 'Mac';
  if(/Android/i.test(ua))return 'Android';
  if(/Windows/i.test(ua))return 'PC';
  return 'este dispositivo';
}
function setSyncDeviceName(v){
  try{ALM.setItem('dlv_devname',String(v||'').trim()||syncDeviceName());}catch(e){fallo('ALM.setItem',e)}
  renderSyncPanel();
}

// ─── Fusión de tres vías ─────────────────────────────────────────────
// base = huella {clave:hash} del estado en la última sincronía, o null la
// primera vez (sin base no se puede saber si algo falta porque el otro lo
// borró o porque yo lo añadí: en ese caso no se borra nada).
function mergeNs(ns,localArr,remoteArr,base,stale){
  const L=new Map(),R=new Map();
  (localArr||[]).forEach(x=>{const k=String(ns.key(x));if(k!=='undefined'&&k!=='null')L.set(k,x);});
  (remoteArr||[]).forEach(x=>{const k=String(ns.key(x));if(k!=='undefined'&&k!=='null')R.set(k,x);});
  const keys=new Set([...L.keys(),...R.keys()]);
  if(base)Object.keys(base).forEach(k=>keys.add(k));
  const final=new Map(), conflicts=[];
  const rep={add:[],del:[],upd:[]};
  // ARCHIVO YA INCORPORADO: su contador es menor que el de nuestra última
  // sincronía, así que ese archivo (o uno posterior) ya se fusionó aquí y todo
  // lo suyo pasó por el filtro entonces. Lo que tiene y nosotros no, lo
  // borramos después a propósito. No aporta nada: se deja el estado intacto.
  // (La huella guarda el último estado, no todo lo visto nunca, así que un
  // borrado viejo parecería "nuevo" si nos fiásemos sólo de ella.)
  if(stale){
    L.forEach((v,k)=>final.set(k,v));
    return {ns,final,conflicts,rep};
  }
  keys.forEach(k=>{
    const l=L.get(k), r=R.get(k);
    const has=v=>v!==undefined;
    const lh=has(l)?itemHash(l):null, rh=has(r)?itemHash(r):null;
    const inBase=!!base&&Object.prototype.hasOwnProperty.call(base,k);
    const bh=inBase?base[k]:null;
    if(has(l)&&has(r)){
      if(lh===rh){final.set(k,l);return;}
      if(!base||!inBase){conflicts.push({k,l,r,kind:'ambos-nuevo'});return;}
      if(bh===lh){final.set(k,r);rep.upd.push({k,item:r});return;}   // sólo cambió el otro
      if(bh===rh){final.set(k,l);return;}                             // sólo cambié yo
      conflicts.push({k,l,r,kind:'ambos-editado'});return;
    }
    if(has(l)&&!has(r)){
      if(!base||!inBase){final.set(k,l);return;}                      // lo añadí yo
      if(bh===lh){rep.del.push({k,item:l});return;}                   // lo borró el otro
      conflicts.push({k,l,r:null,kind:'edité-yo/borró-él'});return;
    }
    if(!has(l)&&has(r)){
      if(!base||!inBase){final.set(k,r);rep.add.push({k,item:r});return;} // lo añadió el otro
      if(bh===rh)return;                                              // lo borré yo, él no lo tocó
      conflicts.push({k,l:null,r,kind:'borré-yo/editó-él'});return;
    }
  });
  return {ns,final,conflicts,rep};
}
function syncPlan(localSt,remoteSt,base,stale){
  const L=syncNormalize(localSt), R=syncNormalize(remoteSt);
  const parts=SYNC_NS.map(ns=>mergeNs(ns,ns.get(L),ns.get(R),base?base.d[ns.k]:null,stale));
  const tot={add:0,del:0,upd:0,conf:0};
  parts.forEach(p=>{tot.add+=p.rep.add.length;tot.del+=p.rep.del.length;tot.upd+=p.rep.upd.length;tot.conf+=p.conflicts.length;});
  return {parts,tot,firstTime:!base,stale:!!stale};
}
// prefer: 'local' | 'remote' — qué lado gana en los choques
function syncBuild(plan,prefer){
  const st=syncNormalize(syncLocalState());
  plan.parts.forEach(p=>{
    const m=new Map(p.final);
    p.conflicts.forEach(c=>{
      const win=prefer==='remote'?c.r:c.l;
      if(win!==null&&win!==undefined)m.set(c.k,win);
      else m.delete(c.k);   // el lado ganador lo tenía borrado
    });
    p.ns.set(st,[...m.values()]);
  });
  return st;
}

// ─── Archivo de sincronía ────────────────────────────────────────────
// Mismo formato que tu copia de seguridad, más un contador que crece en cada
// fusión. Si abres un archivo con un contador MENOR que el de tu última
// sincronía, es más viejo que lo que ya tienes: se avisa y se pasa a modo unión
// (no se borra nada), porque sus ausencias no significan "borrado".
const SYNC_FILENAME='patrimonio_sync.json';
let _syncPending=null, _syncLastMerged=null, _syncHandle=null;

function syncFileObj(st,seq){
  const s=syncNormalize(st);
  return {_app:'DisfrutaLaVida-Patrimonio',_version:37,_exported:new Date().toISOString(),
    _sync:{seq:seq||0,origin:syncDeviceName(),at:new Date().toISOString()},
    personal:s.personal,cfg:s.cfg,records:s.records,transactions:s.transactions,soldStocks:s.soldStocks,
    balanceLog:s.balanceLog,incomeLog:s.incomeLog,expenseLog:s.expenseLog,
    brokerFlows:s.brokerFlows,reembolsos:s.reembolsos};
}
// ─ Acceso directo al archivo (Chrome/Edge en escritorio). Safari e iOS no lo
//   tienen, así que allí se usa selector de archivo + descarga.
function fsSupported(){return typeof window.showOpenFilePicker==='function';}
function idbHandle(mode,val,key){
  key=key||'file';
  return new Promise(res=>{
    try{
      const rq=indexedDB.open('dlv_sync',1);
      rq.onupgradeneeded=()=>{rq.result.createObjectStore('h');};
      rq.onerror=()=>res(null);
      rq.onsuccess=()=>{
        const db=rq.result;
        const tx=db.transaction('h',mode==='get'?'readonly':'readwrite');
        const os=tx.objectStore('h');
        const r=mode==='get'?os.get(key):os.put(val,key);
        r.onsuccess=()=>res(mode==='get'?r.result||null:true);
        r.onerror=()=>res(null);
      };
    }catch(e){res(null);}
  });
}
async function syncEnsureHandle(forcePick){
  if(!fsSupported())return null;
  if(!forcePick){
    if(_syncHandle)return _syncHandle;
    const h=await idbHandle('get');
    if(h){
      try{
        const perm=await h.queryPermission({mode:'readwrite'});
        if(perm==='granted'||(await h.requestPermission({mode:'readwrite'}))==='granted'){_syncHandle=h;return h;}
      }catch(e){fallo('perm',e)}
    }
    return null;
  }
  try{
    const [h]=await window.showOpenFilePicker({
      types:[{description:'Archivo de sincronía',accept:{'application/json':['.json']}}],
      multiple:false});
    _syncHandle=h; await idbHandle('put',h);
    return h;
  }catch(e){return null;}
}
function syncForgetHandle(){
  _syncHandle=null; idbHandle('put',null);
  toast('Archivo olvidado: la próxima vez te lo vuelvo a preguntar');
  renderSyncPanel();
}

// ─── Arranque: leer el archivo del otro dispositivo ──────────────────
async function syncStart(){
  if(fsSupported()){
    let h=await syncEnsureHandle(false);
    if(!h)h=await syncEnsureHandle(true);
    if(!h){toast('No se eligió ningún archivo');return;}
    try{
      const f=await h.getFile();
      syncReadText(await f.text(),f.name);
    }catch(e){toast('No se pudo leer el archivo: '+e.message);}
    return;
  }
  const _i=document.getElementById('sync-file');
  if(_i)_i.click(); else toast('La sincronía a tres bandas ya no está en esta versión');
}
function syncReadText(txt,fname){
  let data;
  try{data=JSON.parse(txt);}catch(e){toast('El archivo no es un JSON válido');return;}
  if(!data||(!data.expenseLog&&!data.records&&!data.balanceLog)){
    toast('Ese archivo no parece datos de Disfruta la Vida');return;
  }
  const base=loadSyncBase();
  const meta={seq:(data._sync&&data._sync.seq)||0,origin:(data._sync&&data._sync.origin)||null,
    at:(data._sync&&data._sync.at)||data._exported||null,fname:fname||'archivo'};
  // La base se conserva aunque el archivo sea viejo: es justo lo que permite
  // saber qué borramos nosotros y por tanto no dejar que vuelva.
  const stale=!!(base&&meta.seq<(base.seq||0));
  const plan=syncPlan(syncLocalState(),data,base,stale);
  _syncPending={plan,meta,baseSeq:base?(base.seq||0):0,stale,hadBase:!!base,remote:data};
  showSyncReport();
}

// ─── Informe ─────────────────────────────────────────────────────────
function showModalWide(title,html){
  showModal(title,html);
  const box=document.querySelector('#dlv-modal>div');
  if(box)box.style.maxWidth='680px';
}
function syncSample(list,ns,n){
  return list.slice(0,n).map(e=>'<li style="margin:1px 0">'+escapeHtml(String(ns.desc(e.item)||e.k)).slice(0,80)+'</li>').join('')+
    (list.length>n?'<li style="color:var(--faint)">… y '+(list.length-n)+' más</li>':'');
}
function showSyncReport(){
  const p=_syncPending; if(!p)return;
  const t=p.plan.tot;
  const me=escapeHtml(syncDeviceName()), other=escapeHtml(p.meta.origin||'el archivo');
  let h='';
  if(p.plan.firstTime&&!p.stale){
    h+='<div style="background:#EBF0FA;border-radius:6px;padding:.5rem .6rem;font-size:11.5px;color:var(--navy);margin-bottom:.6rem">'+
      '<strong>Primera sincronía.</strong> Todavía no hay huella de una fusión anterior, así que no puedo saber si algo falta porque lo borraste o porque aún no lo tenías. '+
      'Por eso esta vez <strong>no se borra nada</strong>: se unen los dos lados. A partir de la siguiente ya se detectarán borrados.</div>';
  }
  if(p.stale){
    h+='<div style="background:#FFF6E0;border:1px solid #E8C97A;border-radius:6px;padding:.5rem .6rem;font-size:11.5px;color:var(--amber);margin-bottom:.6rem">'+
      '<strong>Este archivo ya lo tienes incorporado</strong> (contador '+p.meta.seq+' frente a '+p.baseSeq+'). '+
      'Ese archivo, o uno posterior, ya se fusionó aquí, así que no puede traer nada nuevo: <strong>no se toca nada</strong>. '+
      'Lo que tiene y aquí no está, lo borraste tú después.<br>'+
      'Si esperabas cambios del otro aparato, es que allí no se ha guardado el archivo fusionado: sincroniza allí primero y tráete el resultante. '+
      'Y si de verdad quieres recuperar algo de este archivo viejo, usa <strong>Fusionar</strong>, que añade sin borrar.</div>';
  }
  const mismoAparato=p.meta.origin&&p.meta.origin===syncDeviceName();
  if(mismoAparato){
    h+='<div style="background:#FFF6E0;border:1px solid #E8C97A;border-radius:6px;padding:.5rem .6rem;font-size:11.5px;color:var(--amber);margin-bottom:.6rem">'+
      '<strong>Ese archivo lo generó este mismo aparato</strong> ('+me+'). Lo normal es abrir aquí el que dejó el OTRO: '+
      'si sincronizas contra el tuyo no traerás nada nuevo. Comprueba que has cogido el archivo correcto de iCloud.</div>';
  }
  h+='<div style="font-size:11.5px;color:var(--muted);margin-bottom:.5rem">'+
    'Archivo: <strong>'+escapeHtml(p.meta.fname)+'</strong>'+(p.meta.origin?' · viene de <strong>'+other+'</strong>':' · sin marca de origen (parece una copia normal, no un archivo de sincronía)')+
    (p.meta.at?' · '+escapeHtml(String(p.meta.at).slice(0,10)):'')+'</div>';
  h+='<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:.7rem">'+
    [['Entran',t.add,'var(--teal)'],['Se actualizan',t.upd,'var(--navy)'],
     ['Se borran',t.del,'var(--red)'],['Chocan',t.conf,'var(--amber)']]
    .map(([l,v,c])=>'<div style="background:var(--surface2);border-radius:6px;padding:.45rem .5rem;text-align:center">'+
      '<div style="font-size:17px;font-weight:700;color:'+c+'">'+v+'</div>'+
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)">'+l+'</div></div>').join('')+
    '</div>';
  if(!t.add&&!t.upd&&!t.del&&!t.conf){
    h+='<div style="font-size:12.5px;color:var(--teal);font-weight:600;margin-bottom:.6rem">Los dos lados ya dicen lo mismo. No hay nada que fusionar.</div>';
  }
  // detalle por colección
  const rows=p.plan.parts.filter(x=>x.rep.add.length||x.rep.upd.length||x.rep.del.length||x.conflicts.length);
  if(rows.length){
    h+='<div style="max-height:230px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:.4rem .55rem;margin-bottom:.7rem">';
    rows.forEach(r=>{
      h+='<div style="font-size:11.5px;font-weight:700;margin-top:.35rem">'+r.ns.label+'</div><ul style="margin:.15rem 0 .15rem 1rem;font-size:11px;color:var(--muted)">';
      if(r.rep.add.length)h+='<li style="color:var(--teal)">entran '+r.rep.add.length+':<ul style="margin-left:.6rem">'+syncSample(r.rep.add,r.ns,4)+'</ul></li>';
      if(r.rep.upd.length)h+='<li style="color:var(--navy)">se actualizan '+r.rep.upd.length+':<ul style="margin-left:.6rem">'+syncSample(r.rep.upd,r.ns,4)+'</ul></li>';
      if(r.rep.del.length)h+='<li style="color:var(--red)">se borran '+r.rep.del.length+' (los borraste en el otro aparato):<ul style="margin-left:.6rem">'+syncSample(r.rep.del,r.ns,4)+'</ul></li>';
      if(r.conflicts.length)h+='<li style="color:var(--amber)">chocan '+r.conflicts.length+':<ul style="margin-left:.6rem">'+
        r.conflicts.slice(0,4).map(c=>'<li>'+escapeHtml(String(r.ns.desc(c.l||c.r)||c.k)).slice(0,70)+' <span style="color:var(--faint)">('+c.kind+')</span></li>').join('')+
        (r.conflicts.length>4?'<li style="color:var(--faint)">… y '+(r.conflicts.length-4)+' más</li>':'')+'</ul></li>';
      h+='</ul>';
    });
    h+='</div>';
  }
  if(t.conf){
    h+='<div style="background:var(--surface2);border-radius:6px;padding:.5rem .6rem;margin-bottom:.7rem">'+
      '<div style="font-size:11.5px;font-weight:600;margin-bottom:.35rem">En los '+t.conf+' choques, quedarme con:</div>'+
      '<label style="display:block;font-size:11.5px;margin:2px 0"><input type="radio" name="syncpref" value="local" checked> lo de <strong>'+me+'</strong> (este aparato)</label>'+
      '<label style="display:block;font-size:11.5px;margin:2px 0"><input type="radio" name="syncpref" value="remote"> lo de <strong>'+other+'</strong> (el archivo)</label>'+
      '<div style="font-size:10.5px;color:var(--faint);margin-top:.3rem">Se aplica a todos por igual. Lo que no elijas queda en la copia de deshacer.</div></div>';
  }
  h+='<div style="display:flex;gap:.5rem;justify-content:flex-end;flex-wrap:wrap">'+
    '<button class="btn-sm" onclick="document.getElementById(\'dlv-modal\').remove()" style="font-size:12px">Cancelar</button>'+
    '<button class="btn-sm" onclick="syncCommit()" style="font-size:12px;background:var(--navy);color:#fff;border-color:var(--navy)">Fusionar</button></div>';
  showModalWide('🔄 Sincronizar con el otro dispositivo',h);
}

// ─── Aplicar ─────────────────────────────────────────────────────────
function syncCommit(){
  const p=_syncPending; if(!p){toast('No hay nada que sincronizar');return;}
  const sel=document.querySelector('input[name="syncpref"]:checked');
  const prefer=sel?sel.value:'local';
  if(!guardedAction('sincronizar con '+(p.meta.origin||p.meta.fname)))return;
  const st=syncBuild(p.plan,prefer);
  cfg=st.cfg;
  if(!cfg.gastos_fijos||!cfg.gastos_fijos.length)cfg.gastos_fijos=[...DEF_GASTOS_FIJOS];
  if(!cfg.brokers)cfg.brokers=[];
  // quitar de las etiquetas las categorías propias que ya no existan
  Object.keys(CAT_LABELS).forEach(k=>{if(k.startsWith('c_')&&!(cfg.customCats&&cfg.customCats[k]))delete CAT_LABELS[k];});
  if(cfg.customCats)Object.assign(CAT_LABELS,cfg.customCats);
  records=st.records; transactions=st.transactions;
  soldStocks=new Set(st.soldStocks);
  balanceLog=st.balanceLog; incomeLog=st.incomeLog; expenseLog=st.expenseLog;
  brokerFlows=st.brokerFlows; reembolsos=st.reembolsos;
  personal=st.personal||personal; savePersonal();
  migrateFundIdent();
  try{recomputeAllStockGains();}catch(e){console.warn('recompute',e);}
  _recatIndex=null;
  const newSeq=Math.max(p.baseSeq||0,p.meta.seq||0)+1;
  save();
  saveSyncBase(st,newSeq,p.meta.origin||null);
  _syncLastMerged={state:st,seq:newSeq};
  _syncPending=null;
  renderAll(); goToCurrentMonth(); renderSyncPanel(); renderDiag();
  const t=p.plan.tot;
  const h='<div style="font-size:12.5px;line-height:1.6">Fusionado: <strong>'+t.add+'</strong> entran · <strong>'+t.upd+
    '</strong> actualizados · <strong>'+t.del+'</strong> borrados · <strong>'+t.conf+'</strong> choques resueltos.</div>'+
    '<div style="background:#FFF6E0;border:1px solid #E8C97A;border-radius:6px;padding:.55rem .65rem;font-size:11.5px;color:var(--amber);margin:.6rem 0">'+
    '<strong>Falta un paso.</strong> El otro aparato todavía tiene la versión vieja. Guarda ahora el archivo fusionado '+
    'encima del que hay en iCloud, y ábrelo allí para cerrar el círculo.</div>'+
    '<div style="display:flex;gap:.5rem;justify-content:flex-end;flex-wrap:wrap">'+
    '<button class="btn-sm" onclick="document.getElementById(\'dlv-modal\').remove()" style="font-size:12px">Luego</button>'+
    '<button class="btn-sm" onclick="syncSaveMerged()" style="font-size:12px;background:var(--teal);color:#fff;border-color:var(--teal)">Guardar archivo fusionado</button></div>';
  showModalWide('✅ Sincronizado',h);
  toast('✅ Sincronizado · recuerda guardar el archivo fusionado');
}

// ─── Escribir el archivo fusionado de vuelta ─────────────────────────
async function syncSaveMerged(){
  const m=_syncLastMerged;
  if(!m){toast('No hay nada fusionado que guardar');return;}
  const txt=JSON.stringify(syncFileObj(m.state,m.seq),null,2);
  if(fsSupported()){
    let h=_syncHandle||await syncEnsureHandle(false);
    if(h){
      try{
        const w=await h.createWritable();
        await w.write(txt); await w.close();
        document.getElementById('dlv-modal')?.remove();
        renderSyncPanel();
        toast('💾 Archivo actualizado — ábrelo en el otro aparato');
        return;
      }catch(e){toast('No se pudo escribir: '+e.message);}
    }
    try{
      const nh=await window.showSaveFilePicker({suggestedName:SYNC_FILENAME,
        types:[{description:'Archivo de sincronía',accept:{'application/json':['.json']}}]});
      const w=await nh.createWritable(); await w.write(txt); await w.close();
      _syncHandle=nh; await idbHandle('put',nh);
      document.getElementById('dlv-modal')?.remove();
      renderSyncPanel();
      toast('💾 Archivo guardado');
      return;
    }catch(e){fallo('nh',e)}
  }
  // Safari / iPad: descarga normal
  const blob=new Blob([txt],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=SYNC_FILENAME;
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  document.getElementById('dlv-modal')?.remove();
  renderSyncPanel();
  toast('💾 Descargado '+SYNC_FILENAME+' — muévelo a iCloud sustituyendo el anterior');
}

// ─── Panel ───────────────────────────────────────────────────────────
function renderSyncPanel(){
  const el=document.getElementById('sync-body'); if(!el)return;
  const b=loadSyncBase();
  const dev=escapeHtml(syncDeviceName());
  const pend=_syncLastMerged?true:false;
  let h='<div style="font-size:11.5px;color:var(--muted);line-height:1.6;margin-bottom:.5rem">'+
    'Este aparato se identifica como <input type="text" value="'+dev+'" onchange="setSyncDeviceName(this.value)" '+
    'style="font-size:11px;width:90px;padding:1px 5px"> en los informes. '+
    'Guarda el archivo de sincronía en iCloud y ábrelo desde los dos sitios: cada fusión deja el archivo al día para el siguiente.</div>';
  h+='<div style="font-size:11.5px;margin-bottom:.5rem">'+
    (b?'Última sincronía: <strong>'+fmtDateFull(b.at.slice(0,10))+'</strong>'+(b.peer?' con <strong>'+escapeHtml(b.peer)+'</strong>':'')+' · contador '+(b.seq||0)
      :'<span style="color:var(--amber)">Aún no has sincronizado nunca. La primera vez sólo se unen los dos lados, sin borrar nada.</span>')+
    '</div>';
  if(pend)h+='<div style="background:#FFF6E0;border:1px solid #E8C97A;border-radius:6px;padding:.45rem .6rem;font-size:11.5px;color:var(--amber);margin-bottom:.5rem">'+
    'Tienes una fusión sin propagar: el otro aparato sigue con la versión vieja. '+
    '<button type="button" class="btn-xs" onclick="syncSaveMerged()" style="background:var(--amber);color:#fff;border-color:var(--amber)">Guardar archivo fusionado</button></div>';
  h+='<div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">'+
    '<button type="button" class="btn-sm" onclick="syncStart()" style="font-size:11.5px;background:var(--navy);color:#fff;border-color:var(--navy)">🔄 Sincronizar con archivo</button>'+
    (fsSupported()?'<button type="button" class="btn-sm" onclick="syncEnsureHandle(true).then(h=>{if(h){renderSyncPanel();toast(\'Archivo elegido\');}})" style="font-size:11.5px">Elegir otro archivo</button>'+
      (_syncHandle?'<button type="button" class="btn-sm" onclick="syncForgetHandle()" style="font-size:11.5px">Olvidar</button>':'')
      :'<span style="font-size:10.5px;color:var(--faint)">Este navegador no permite escribir directamente sobre el archivo: se descargará y tendrás que moverlo tú.</span>')+
    '</div>';
  el.innerHTML=h;
}


// ════════════════════════════════════════════
// v97 · IMPORTACIÓN DE DEGIRO: por ISIN, con vista previa y de un clic
// ════════════════════════════════════════════
// La versión anterior emparejaba por NOMBRE aproximado y, si no encontraba,
// creaba una acción nueva en silencio. Un cambio de denominación en DEGIRO
// bastaba para duplicar una posición e inflar el patrimonio sin avisar.
// Ahora manda el ISIN, que no cambia aunque cambie el símbolo o el nombre
// (Claranova pasó de CLA a ALCLA en febrero y su ISIN siguió igual), y nada
// se escribe hasta que ves exactamente qué va a pasar.

// Cabeceras del Portfolio.csv en los idiomas en que DEGIRO lo exporta
const DG_COLS={
  prod:[/^producto$/i,/^product$/i,/^produkt$/i,/^produit$/i,/^prodotto$/i],
  isin:[/symbol\s*\/?\s*isin/i,/^isin$/i,/^s[ií]mbolo/i],
  qty :[/^cantidad$/i,/^quantity$/i,/^aantal$/i,/^menge$/i,/^quantit[éa]/i,/^quantit[àa]$/i],
  eur :[/valor\s*en\s*eur/i,/value\s*in\s*eur/i,/waarde\s*in\s*eur/i,/wert\s*in\s*eur/i,/valeur\s*en\s*eur/i],
  loc :[/valor\s*local/i,/local\s*value/i,/lokale?\s*waarde/i],
};
function dgNum(s){
  if(s==null)return null;
  if(typeof s==='number')return isFinite(s)?s:null;
  s=String(s).trim().replace(/[€$£\s\u00a0]/g,'');
  if(!s)return null;
  // "1.234,56" o "1234,56" (europeo) frente a "1,234.56" (anglosajón): manda
  // el último separador, que es el de los decimales
  if(s.lastIndexOf(',')>s.lastIndexOf('.')) s=s.replace(/\./g,'').replace(',','.');
  else s=s.replace(/,/g,'');
  const v=parseFloat(s);
  return isFinite(v)?v:null;
}
function dgRows(text){
  text=String(text||'').replace(/^﻿/,'');
  // el separador puede ser coma o punto y coma según la exportación
  const head=text.split(/\r?\n/)[0]||'';
  const delim=(head.split(';').length>head.split(',').length)?';':',';
  const rows=[];let f=[],cur='',q=false;
  for(let i=0;i<text.length;i++){const c=text[i];
    if(q){ if(c=='"'){ if(text[i+1]=='"'){cur+='"';i++;} else q=false; } else cur+=c; }
    else{
      if(c=='"')q=true;
      else if(c===delim){f.push(cur);cur='';}
      else if(c=='\n'||c=='\r'){ if(c=='\r'&&text[i+1]=='\n')i++; if(cur!==''||f.length){f.push(cur);rows.push(f);} f=[];cur=''; }
      else cur+=c;
    }}
  if(cur!==''||f.length){f.push(cur);rows.push(f);}
  return rows;
}
function degiroParse(text){
  const rows=dgRows(text);
  if(rows.length<2) return {err:'El archivo no tiene filas de posiciones.'};
  const head=rows[0].map(x=>String(x||'').trim());
  const find=pats=>head.findIndex(h=>pats.some(p=>p.test(h)));
  const ci={prod:find(DG_COLS.prod),isin:find(DG_COLS.isin),qty:find(DG_COLS.qty),eur:find(DG_COLS.eur)};
  const porCabecera=ci.prod>=0&&ci.eur>=0;
  if(!porCabecera){
    // Sin cabecera reconocible: posiciones históricas de DEGIRO, y el importe
    // es la última columna con número (nunca un índice fijo, que era el fallo
    // de antes en cuanto el CSV traía una coma de más al final).
    ci.prod=0; ci.isin=1; ci.qty=2; ci.eur=-1;
  }
  const out=[];
  rows.slice(1).forEach(r=>{
    const prod=String(r[ci.prod]||'').trim();
    if(!prod)return;
    let eur;
    if(ci.eur>=0) eur=dgNum(r[ci.eur]);
    else { for(let k=r.length-1;k>=1;k--){const v=dgNum(r[k]); if(v!==null){eur=v;break;}} }
    if(eur==null)return;
    out.push({prod,
      isin:String(ci.isin>=0?(r[ci.isin]||''):'').trim().toUpperCase(),
      qty:ci.qty>=0?dgNum(r[ci.qty]):null,
      eur});
  });
  if(!out.length) return {err:'No se reconoció ninguna posición dentro del archivo.'};
  return {rows:out,porCabecera,head};
}

// ════════════════════════════════════════════════════════════════════
// v142 · XTB: EL MISMO BOTÓN, OTRO FORMATO
// ════════════════════════════════════════════════════════════════════
// DEGIRO da un CSV con una fila por posición. XTB da un .zip que dentro
// lleva un .xlsx con TRES hojas: posiciones abiertas, posiciones cerradas
// y operaciones de caja. No se parecen en nada, así que el importador
// reconoce el archivo por dentro y decide él solo con cuál de los dos
// lectores tiene que ir. Para ti es el mismo botón.
//
// Y hay una trampa que conviene tener presente: XTB NO da el saldo de la
// cuenta en ninguna casilla. Lo único que da son los movimientos de caja
// del periodo que hayas pedido. Sumarlos da el saldo SOLO si el extracto
// arranca en la apertura de la cuenta; si pides el último mes, la suma es
// lo que ha entrado y salido ese mes, no lo que tienes. Por eso el importe
// sale escrito en la vista previa y se puede corregir a mano antes de
// aplicar nada.
const XTB_MARCA=/account\s*number|cash\s*operations|open\s*positions|closed\s*positions/i;
function xtbNum(v){
  if(typeof v==='number')return isFinite(v)?v:null;
  return dgNum(v);
}
// Las fechas de XTB salen como fecha de Excel (SheetJS ya las convierte a
// Date). Se pasan a texto con la hora LOCAL, no en UTC: "22:00 del día 8"
// en UTC es el día 9 aquí, y una valoración fechada un día después se
// colaría por delante de saldos que sí son de ese día.
function xtbISO(v){
  const p2=x=>String(x).padStart(2,'0');
  if(v instanceof Date&&!isNaN(v))return v.getFullYear()+'-'+p2(v.getMonth()+1)+'-'+p2(v.getDate());
  const s=String(v==null?'':v).trim();
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m)return m[0];
  m=s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/); if(m)return m[3]+'-'+p2(m[1]*1)+'-'+p2(m[2]*1);
  const n=Number(s.replace(',','.'));
  if(isFinite(n)&&n>20000&&n<80000){ const d=new Date(Math.round((n-25569)*86400000));
    return d.getUTCFullYear()+'-'+p2(d.getUTCMonth()+1)+'-'+p2(d.getUTCDate()); }
  return null;
}
// v167 · Lo mismo pero con la hora, en milisegundos: hace falta para saber si
// una posición se abrió antes de que empiece el extracto y para ordenar los
// movimientos de un mismo día (el ingreso va antes que la compra que paga).
function xtbMs(v){
  if(v instanceof Date&&!isNaN(v))return v.getTime();
  const s=String(v==null?'':v).trim(); if(!s)return null;
  const n=Number(s.replace(',','.'));
  if(isFinite(n)&&n>20000&&n<80000)return Math.round((n-25569)*86400000);
  const t=Date.parse(s.replace(' ','T')); return isNaN(t)?null:t;
}
// El .xlsx es un zip; el archivo que descargas de XTB es OTRO zip con el
// .xlsx dentro. Se prueba primero como Excel y, si no lo es, se abre como
// zip y se busca la hoja de cálculo que lleve dentro.
function xtbLibro(buf){
  if(typeof XLSX==='undefined')throw new Error('no se pudo cargar el lector de Excel');
  const callado=console.error; console.error=function(){};   // el lector de zip habla de más
  try{
    try{ return XLSX.read(buf,{type:'array',cellDates:true}); }catch(e){fallo('return',e)}
    const cfb=XLSX.CFB.read(buf,{type:'array'});
    const i=(cfb.FullPaths||[]).findIndex(p=>/\.(xlsx|xlsm|xls)$/i.test(p));
    if(i<0)throw new Error('el .zip no trae ninguna hoja de cálculo dentro');
    return XLSX.read(cfb.FileIndex[i].content,{type:'array',cellDates:true});
  } finally { console.error=callado; }
}
function xtbFilas(wb,nombre){
  const s=wb.Sheets[nombre];
  return s?XLSX.utils.sheet_to_json(s,{header:1,raw:true,defval:''}):[];
}
// La hoja se busca por su nombre y, si XTB lo hubiera traducido, por el
// rótulo que lleva escrito en sus primeras filas.
function xtbHoja(wb,rx){
  const n=(wb.SheetNames||[]).find(x=>rx.test(x));
  if(n)return xtbFilas(wb,n);
  for(const s of (wb.SheetNames||[])){
    const A=xtbFilas(wb,s);
    if(A.slice(0,4).some(r=>rx.test(String((r||[])[0]||''))))return A;
  }
  return null;
}
// La cabecera no está en la fila 1: encima van el número de cuenta y las
// fechas del informe. Se localiza por las columnas que tiene que tener.
function xtbCab(A,claves){
  for(let i=0;i<(A||[]).length;i++){
    const row=(A[i]||[]).map(c=>String(c||'').trim());
    if(claves.every(rx=>row.some(c=>rx.test(c))))return i;
  }
  return -1;
}
function xtbCol(row,rx){ return (row||[]).findIndex(c=>rx.test(String(c||'').trim())); }
// El valor de una etiqueta de las de arriba ("Date to (UTC)" → la celda de al lado)
function xtbEtiqueta(A,rx){
  for(const r of (A||[])){
    if(rx.test(String((r||[])[0]||'')))return (r||[])[1];
  }
  return null;
}

function xtbParse(buf){
  let wb;
  try{ wb=xtbLibro(buf); }catch(e){ return {err:'No pude abrir el archivo: '+(e&&e.message||e)}; }
  const abiertas=xtbHoja(wb,/open\s*positions|posiciones\s*abiertas/i);
  const caja    =xtbHoja(wb,/cash\s*operations|operaciones\s*de\s*(caja|efectivo)/i);
  const cerradas=xtbHoja(wb,/closed\s*positions|posiciones\s*cerradas/i);
  if(!abiertas&&!caja)return {err:'No parece un extracto de XTB: no encuentro ni «Open Positions» ni «Cash Operations».'};

  // ─── Posiciones abiertas ───
  // XTB escribe CADA posición dos veces: una fila resumen con el nombre del
  // instrumento y, debajo, una fila por cada posición abierta cuyo «nombre» es
  // el número de posición (2804500611). Cogerlas todas contaba la acción dos
  // veces y creaba una posición fantasma llamada como el número. Manda la fila
  // resumen; las de número solo se usan si no hubiera resumen.
  const rows=[]; const crudas=[]; const abiertasEn=[]; const nombreTick={};
  if(abiertas){
    const hi=xtbCab(abiertas,[/instrument|posici/i,/^value$|^valor$/i,/^volume$|^volumen$/i]);
    if(hi>=0){
      const H=abiertas[hi];
      const ci={prod:xtbCol(H,/instrument|posici/i), tick:xtbCol(H,/^ticker$|^s[ií]mbolo$/i),
                qty:xtbCol(H,/^volume$|^volumen$/i), eur:xtbCol(H,/^value$|^valor$/i),
                px:xtbCol(H,/current\s*price|precio\s*actual/i),
                abre:xtbCol(H,/open\s*time|hora\s*de\s*apertura|fecha\s*de\s*apertura/i)};
      for(let i=hi+1;i<abiertas.length;i++){
        const r=abiertas[i]||[];
        const prod=String(r[ci.prod]||'').trim();
        if(!prod)continue;
        if(/^(note|nota|total|totales)$/i.test(prod))continue;
        // v167 · las filas de cada posición traen su hora de apertura; el nombre,
        // la fila resumen de encima
        const tk=ci.tick>=0?String(r[ci.tick]||'').trim().toUpperCase():'';
        if(!/^\d{5,}$/.test(prod)&&tk)nombreTick[tk]=prod;
        const ab=ci.abre>=0?xtbMs(r[ci.abre]):null;
        if(ab!=null)abiertasEn.push({nombre:nombreTick[tk]||tk||prod,t:ab});
        const eur=xtbNum(r[ci.eur]);
        if(eur==null)continue;
        crudas.push({prod,isin:'',qty:ci.qty>=0?xtbNum(r[ci.qty]):null,eur,
                   tick:ci.tick>=0?String(r[ci.tick]||'').trim():''});
      }
    }
    const esNum=x=>/^\d{5,}$/.test(String(x.prod||''));
    const conNombre=new Set(crudas.filter(x=>!esNum(x)).map(x=>(x.tick||x.prod).toUpperCase()));
    crudas.forEach(x=>{
      if(esNum(x)){
        if(conNombre.has((x.tick||x.prod).toUpperCase()))return;   // ya está la fila resumen
        x.prod=x.tick||x.prod;                                     // sin resumen, al menos el ticker
      }
      rows.push(x);
    });
  }

  // ─── Operaciones de caja ───
  let cash=null; const ops=[]; let nDep=0,nRet=0;
  if(caja){
    const hi=xtbCab(caja,[/^type$|^tipo$/i,/^amount$|^importe$/i,/^time$|^fecha$|^hora$/i]);
    if(hi>=0){
      const H=caja[hi];
      const ci={type:xtbCol(H,/^type$|^tipo$/i), time:xtbCol(H,/^time$|^fecha$|^hora$/i),
                amt:xtbCol(H,/^amount$|^importe$/i), id:xtbCol(H,/^id$/i),
                com:xtbCol(H,/^comment$|coment/i), instr:xtbCol(H,/^instrument$|instrumento/i),
                tick:xtbCol(H,/^ticker$|^s[ií]mbolo$/i), pos:xtbCol(H,/position\s*id/i)};
      cash=0;
      for(let i=hi+1;i<caja.length;i++){
        const r=caja[i]||[];
        const tipo=String(r[ci.type]||'').trim();
        if(!tipo)continue;
        if(/^(total|totales|suma)$/i.test(tipo))continue;      // la fila de la suma no se suma otra vez
        const amt=xtbNum(r[ci.amt]);
        if(amt==null)continue;
        cash+=amt;
        const o={tipo,fecha:xtbISO(r[ci.time]),t:xtbMs(r[ci.time]),amount:amt,
                 id:String(ci.id>=0?(r[ci.id]||''):'').trim(),
                 com:String(ci.com>=0?(r[ci.com]||''):'').trim(),
                 instr:String(ci.instr>=0?(r[ci.instr]||''):'').trim(),
                 tick:String(ci.tick>=0?(r[ci.tick]||''):'').trim(),
                 pos:String(ci.pos>=0?(r[ci.pos]||''):'').trim()};
        if(/deposit|ingreso|dep[oó]sito/i.test(tipo)&&amt>0){o.flujo='aporta';nDep++;}
        else if(/withdraw|retirada|reintegro/i.test(tipo)&&amt<0){o.flujo='retira';nRet++;}
        ops.push(o);
      }
      cash=Math.round(cash*100)/100;
    }
  }

  const opsBolsa=xtbOperaciones(ops);
  const rentas=xtbRentas(ops);

  // ─── Fechas del informe ───
  const gen  =xtbISO(xtbEtiqueta(abiertas,/data\s*as\s*of|generad/i));
  const hasta=xtbISO(xtbEtiqueta(caja||abiertas,/date\s*to|hasta/i));
  const desde=xtbISO(xtbEtiqueta(caja||abiertas,/date\s*from|desde/i));
  const desdeT=xtbMs(xtbEtiqueta(caja||abiertas,/date\s*from|desde/i));
  const fOps =ops.map(o=>o.fecha).filter(Boolean).sort();
  const fecha=gen||hasta||(fOps.length?fOps[fOps.length-1]:null);
  const cuenta=String(xtbEtiqueta(abiertas||caja,/account\s*number|n[uú]mero\s*de\s*cuenta/i)||'').trim();
  let nCerr=0; const cerradasEn=[];
  if(cerradas){
    const hc=xtbCab(cerradas,[/^instrument$|instrumento/i,/profit\s*\/?\s*loss|beneficio/i]);
    if(hc>=0){
      const abre=xtbCol(cerradas[hc],/open\s*time|hora\s*de\s*apertura|fecha\s*de\s*apertura/i);
      const tk=xtbCol(cerradas[hc],/^ticker$|^s[ií]mbolo$/i);
      for(let i=hc+1;i<cerradas.length;i++){
        const r=cerradas[i]||[];
        const p=String(r[0]||'').trim();
        if(p&&!/^(profit|p[eé]rdida|total)/i.test(p)){
          nCerr++;
          const ab=abre>=0?xtbMs(r[abre]):null;
          if(ab!=null)cerradasEn.push({nombre:(tk>=0?String(r[tk]||'').trim():'')||p,t:ab});
        }
      }
    }
  }
  // v167 · posiciones (abiertas o cerradas en el periodo) que se abrieron antes
  // de la fecha de inicio: su compra no está en el archivo
  const posAntes=desdeT==null?[]:abiertasEn.concat(cerradasEn).filter(p=>p.t<desdeT);
  return {rows,porCabecera:true,head:[],fuente:'xtb',
          cash,cashOps:ops,ops:opsBolsa,rentas,nDep,nRet,desde,desdeT,hasta,fecha,cuenta,nCerr,posAntes};
}

// ── v169 · Intereses y dividendos de XTB, con lo que se retuvo ──────
// XTB apunta cada cosa por separado en la hoja de caja: el interés de la
// liquidez («Free funds interest») y su retención («Free funds interest tax»),
// el dividendo («DIVIDENT» o «Dividend») y lo que se quedó el país de la
// empresa («Withholding tax», «… WHT 15%»). Aquí se juntan en un apunte por
// cobro, con el bruto, lo retenido y lo que de verdad llegó. Antes no entraban
// en ninguna parte: ni en lo que cobras ni en la previsión de la renta.
// Retención española: la del 19 %, o la de una empresa española.
function _retEsp(o,clave){
  const p=/(\d+(?:[.,]\d+)?)\s*%/.exec(String(o&&o.com||''));
  if(p)return Math.abs(parseFloat(p[1].replace(',','.'))-19)<0.01;
  return /\.ES$|^ES[A-Z0-9]{10}$/i.test(String(clave||''));
}
function xtbRentas(ops){
  const R=[], impInt=[], impDiv=[];
  (ops||[]).forEach(o=>{
    if(!o||!o.fecha||!isFinite(o.amount))return;
    const t=String(o.tipo||''), c=String(o.com||'');
    if(/\bftt\b|transaction\s*tax|stamp\s*duty/i.test(t+' '+c))return;   // impuestos de la compra, no del cobro
    const esInt=/interest|inter[eé]s/i.test(t);
    const esImp=/\btax\b|impuesto|retenci|withholding|\bwht\b/i.test(t)||/\bWHT\b|withholding/i.test(c);
    if(esInt&&esImp){ impInt.push(o); return; }
    if(esInt){ if(o.amount>0)R.push({cat:'rend',o,bruto:o.amount,ret:0,retExt:0}); return; }
    if(/divid/i.test(t)&&!esImp){ if(o.amount>0)R.push({cat:'dividendo',o,bruto:o.amount,ret:0,retExt:0}); return; }
    if(esImp&&(o.tick||o.instr))impDiv.push(o);
  });
  const per=o=>{ const m=/(\d{4}-\d{2})/.exec(String(o.com||'')); return m?m[1]:String(o.fecha).slice(0,7); };
  impInt.forEach(o=>{
    const r=R.find(x=>x.cat==='rend'&&per(x.o)===per(o))||R.find(x=>x.cat==='rend'&&x.o.fecha===o.fecha);
    if(r)r.ret+=Math.abs(o.amount);
  });
  impDiv.forEach(o=>{
    const k=String(o.tick||o.instr).toUpperCase();
    let mejor=null,dist=1e9;
    R.forEach(x=>{
      if(x.cat!=='dividendo'||String(x.o.tick||x.o.instr).toUpperCase()!==k)return;
      const d=Math.abs(isoDias(x.o.fecha,o.fecha)); if(d<=7&&d<dist){mejor=x;dist=d;}
    });
    if(!mejor)return;
    if(_retEsp(o,o.tick))mejor.ret+=Math.abs(o.amount); else mejor.retExt+=Math.abs(o.amount);
  });
  const r2=v=>Math.round(v*100)/100;
  return R.map(x=>{
    const nom=x.o.instr||x.o.tick||'';
    return {cat:x.cat,fecha:x.o.fecha,bruto:r2(x.bruto),ret:r2(x.ret),retExt:r2(x.retExt),
      neto:r2(x.bruto-x.ret-x.retExt),tick:x.o.tick||'',isin:'',nombre:nom,
      ext:'xtb:'+(x.o.id||(x.o.fecha+':'+x.bruto)),
      desc:x.cat==='rend'?('Intereses XTB '+per(x.o)):('Dividendo '+(nom||'XTB'))};
  });
}
// ── v169 · Registrar intereses y dividendos de un bróker como ingresos ──
// Cada apunte lleva lo que llegó (amt), el bruto, la retención española (ret)
// y la del país de la empresa (retExt). Reimportar no duplica: la clave 'ext'
// es la del propio bróker, y si ya lo apuntaste a mano (mismo importe, tres
// días arriba o abajo) tampoco entra.
function rentasAplicar(lista,fuente){
  let n=0,bruto=0,ret=0,retExt=0;
  const r2=v=>Math.round(v*100)/100;
  (lista||[]).forEach((x,k)=>{
    if(!x||!x.fecha||!(x.bruto>0))return;
    if(incomeLog.some(e=>e.ext&&e.ext===x.ext))return;
    if(incomeLog.some(e=>!e.ext&&e.cat===x.cat&&Math.abs((Number(e.amt)||0)-x.neto)<0.015&&
      e.date&&Math.abs(isoDias(e.date,x.fecha))<=3))return;
    let stk=null;
    if(x.cat==='dividendo'){
      const U=v=>String(v||'').toUpperCase();
      stk=(cfg.stocks||[]).find(s=>(x.isin&&U(s.isin)===U(x.isin))||(x.tick&&U(s.tick)===U(x.tick)))||null;
      if(!stk&&x.nombre){
        const nn=_pfNorm(x.nombre);
        stk=(cfg.stocks||[]).find(s=>{const cn=_pfNorm(s.name);
          return cn&&nn&&cn.length>=4&&nn.length>=4&&(nn===cn||nn.startsWith(cn)||cn.startsWith(nn));})||null;
      }
    }
    const e={id:'inc_'+(fuente||'brk')+'_'+Date.now().toString(36)+'_'+k,date:x.fecha,
      desc:String(x.desc||'').slice(0,60),cat:x.cat,amt:r2(x.neto),
      bruto:r2(x.bruto),ret:r2(x.ret||0),retExt:r2(x.retExt||0),ext:x.ext,src:fuente||''};
    if(stk)e.stockId=stk.id;
    incomeLog.push(e);
    n++; bruto+=x.bruto; ret+=x.ret||0; retExt+=x.retExt||0;
  });
  return {n,bruto:r2(bruto),ret:r2(ret),retExt:r2(retExt)};
}

// ── Las compras y ventas, que XTB mete en la misma hoja de caja ────
// No hay un archivo aparte como en DEGIRO: la compra de una acción aparece
// como un apunte de caja negativo cuyo comentario dice lo que se compró
// ("OPEN BUY 121/121.6545 @ 8.220"). De ahí salen títulos y precio.
// Una misma compra puede venir partida en dos apuntes —los títulos enteros
// por un lado y la fracción por otro—, así que se agrupan por número de
// posición: 121 acciones + 0,6545 acciones son UNA compra de 121,6545.
const XTB_OPRX=/(OPEN|CLOSE)\s+(BUY|SELL)\s+(?:[A-Za-z][A-Za-z0-9.\-]*\s+)?([\d.,]+)(?:\s*\/\s*([\d.,]+))?\s*@\s*([\d.,]+)/i;   // v165 · desde octubre de 2026 XTB mete el ticker: «OPEN BUY FMC.US 253/253.8851 @ 8.71»
function xtbOperaciones(ops){
  const g={}, comis={};
  (ops||[]).forEach(o=>{
    if(!o.fecha)return;
    if(/commission|comisi/i.test(o.tipo)&&o.pos){
      comis[o.pos]=(comis[o.pos]||0)+Math.abs(o.amount); return;
    }
    const m=XTB_OPRX.exec(o.com||'');
    if(!m)return;
    const nombre=o.instr||o.tick; if(!nombre)return;
    const accion=m[1].toUpperCase();
    const clave=(o.pos||nombre)+'|'+accion+'|'+o.fecha;
    const G=g[clave]||(g[clave]={date:o.fecha,prod:nombre,tick:o.tick||'',isin:'',
      tipo:accion==='OPEN'?'buy':'sell',n:0,valEUR:0,costes:0,pos:o.pos||'',
      orden:'xtb:'+(o.pos||nombre)+':'+accion,precioLocal:xtbNum(m[5])||0});
    G.n+=xtbNum(m[3])||0;
    G.valEUR+=Math.abs(o.amount);
  });
  const out=Object.values(g).filter(x=>x.n>0&&x.valEUR>0);
  out.forEach(x=>{ if(x.pos&&comis[x.pos])x.costes=Math.round(comis[x.pos]*100)/100;
                   x.precio=x.valEUR/x.n; });
  return out.sort((a,b)=>a.date.localeCompare(b.date));
}
// Se AÑADEN, nunca se sustituyen: con dos brókers a la vez, borrar y rehacer
// las operaciones de una acción (como hace el importador de DEGIRO) se llevaría
// por delante las del otro. La clave del apunte es la de XTB, así que reimportar
// el mismo extracto —o uno más largo— no duplica nada.
function xtbAplicarOps(lista){
  let creadas=0,acciones=0;
  (lista||[]).slice().sort((a,b)=>a.date.localeCompare(b.date)).forEach((o,k)=>{
    if(transactions.some(t=>t.ext===o.orden))return;
    let s=o.tick?cfg.stocks.find(x=>String(x.tick||'').toUpperCase()===o.tick.toUpperCase()):null;
    if(!s){
      const nn=_pfNorm(o.prod);
      s=cfg.stocks.find(x=>{const cn=_pfNorm(x.name);
        return cn&&nn&&mismaClase(o.prod,x.name)&&(nn===cn||nn.startsWith(cn)||cn.startsWith(nn));});
    }
    if(!s){
      s={id:'stk_xtb_'+Date.now()+'_'+k,name:dgTitulo(o.prod),existing:false};
      if(o.tick)s.tick=o.tick;
      cfg.stocks.push(s); acciones++;
    } else if(!s.tick&&o.tick){ s.tick=o.tick; }
    transactions.push({id:'tx_xtb_'+Date.now().toString(36)+'_'+k,
      stockId:s.id,stockName:s.name,name:s.name,type:o.tipo,date:o.date,
      shares:Math.round(o.n*1e6)/1e6,
      price:Math.round((o.valEUR/o.n)*1e6)/1e6,      // por título y ya en euros
      costs:Math.round((o.costes||0)*100)/100,
      total:Math.round(o.valEUR*100)/100,
      year:parseInt(String(o.date).slice(0,4)),
      ext:o.orden,src:'xtb'});
    creadas++;
  });
  if(creadas){ try{recomputeAllStockGains();}catch(e){console.warn('fifo',e);} }
  return {creadas,acciones};
}

const DG_CASH=/^cash|efectivo|liquidez|geldkonto|compte esp|cash\s*&\s*cash/i;
function dgLatestBal(stockId){
  return balUltimo('stock',stockId);
}
function degiroPlan(parsed,date){
  const agg=getStockAggregates();
  const byIsin={},byTick={};
  cfg.stocks.forEach(s=>{ if(s.isin) byIsin[String(s.isin).toUpperCase()]=s;
                          if(s.tick) byTick[String(s.tick).toUpperCase()]=s; });
  const vistos=new Set();
  const upd=[],nuevas=[],qtyDiff=[];
  // XTB no marca el efectivo como una fila más: viene calculado aparte
  let cash=(parsed.cash!=null&&isFinite(parsed.cash))?Number(parsed.cash):null;
  parsed.rows.forEach(r=>{
    if(DG_CASH.test(r.prod)){ cash=(cash||0)+r.eur; return; }
    let stk=null,how='';
    if(r.isin&&byIsin[r.isin]){ stk=byIsin[r.isin]; how='ISIN'; }
    // XTB no da ISIN: su clave estable es el ticker (p. ej. AIR.FR)
    if(!stk&&r.tick&&byTick[String(r.tick).toUpperCase()]){ stk=byTick[String(r.tick).toUpperCase()]; how='ticker'; }
    if(!stk){
      const pn=_pfNorm(r.prod);
      stk=cfg.stocks.find(s=>{const cn=_pfNorm(s.name);
        return cn&&mismaClase(r.prod,s.name)&&(pn===cn||pn.startsWith(cn)||cn.startsWith(pn));});
      if(stk)how='nombre';
    }
    if(!stk){ nuevas.push(r); return; }
    vistos.add(stk.id);
    const prev=dgLatestBal(stk.id);
    upd.push({stk,row:r,how,prev,ponIsin:(!stk.isin&&r.isin)?r.isin:null,
              ponTick:(!stk.tick&&r.tick)?r.tick:null});
    const mias=agg[stk.id]?agg[stk.id].totalShares:0;
    if(r.qty!=null&&Math.abs(r.qty-mias)>0.01) qtyDiff.push({stk,degiro:r.qty,mias});
  });
  // posiciones abiertas tuyas que el CSV no menciona
  const faltan=cfg.stocks.filter(s=>{
    const a=agg[s.id];
    return a&&a.totalShares>0.0001&&!vistos.has(s.id)&&!soldStocks.has(s.id);
  });
  return {upd,nuevas,qtyDiff,faltan,cash,date,porCabecera:parsed.porCabecera};
}

// ─── Archivo recordado: un clic en lugar de rebuscar en Descargas ────
let _dgHandle=null;
async function degiroHandle(forzarElegir){
  if(!fsSupported())return null;
  if(!forzarElegir){
    if(_dgHandle)return _dgHandle;
    const h=await idbHandle('get',null,'degiro');
    if(h){
      try{
        const perm=await h.queryPermission({mode:'read'});
        if(perm==='granted'||(await h.requestPermission({mode:'read'}))==='granted'){_dgHandle=h;return h;}
      }catch(e){fallo('perm',e)}
    }
    return null;
  }
  try{
    const [h]=await window.showOpenFilePicker({
      types:[{description:'Cartera del bróker (DEGIRO o XTB)',
        accept:{'text/csv':['.csv'],
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['.xlsx'],
                'application/zip':['.zip']}}],multiple:false});
    _dgHandle=h; await idbHandle('put',h,'degiro');
    return h;
  }catch(e){return null;}
}
function degiroForget(){ _dgHandle=null; idbHandle('put',null,'degiro'); toast('Archivo olvidado'); renderDegiroPanel(); }

async function degiroStart(forzarElegir){
  if(fsSupported()){
    let h=await degiroHandle(!!forzarElegir);
    if(!h)h=await degiroHandle(true);
    if(!h){toast('No se eligió ningún archivo');return;}
    try{
      const f=await h.getFile();
      brokerFile(new Uint8Array(await f.arrayBuffer()),f.name,f.lastModified);
    }catch(e){toast('No se pudo leer: '+e.message);}
    return;
  }
  // v136 · El selector duplicado que vivía junto al botón del extracto se
  // retiró; el bueno es el de la ficha de acciones.
  const _i=document.getElementById('degiro-file')||document.getElementById('degiro-pf-file');
  if(_i)_i.click(); else toast('No encuentro el selector de archivo de DEGIRO');
}
function handleDegiroPortfolio(ev){
  const f=(ev.target.files||[])[0]; ev.target.value='';
  if(!f)return;
  // v165 · XTB da un .zip con el Excel dentro. El lector de Excel lo abría en el
  // ordenador pero no siempre en el iPad: ahora lo abre el propio navegador.
  (async()=>{
    let buf=new Uint8Array(await f.arrayBuffer());
    try{ const dentro=await zipNativo(buf); if(dentro)buf=dentro; }catch(e){fallo('dentro',e)}
    brokerFile(buf,f.name,f.lastModified);
  })().catch(()=>toast('No se pudo abrir el archivo'));
}
async function zipNativo(buf){
  if(!(buf[0]===0x50&&buf[1]===0x4B))return null;
  let eocd=-1;
  for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--){ if(buf[i]===0x50&&buf[i+1]===0x4B&&buf[i+2]===0x05&&buf[i+3]===0x06){eocd=i;break;} }
  if(eocd<0)return null;
  const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength), td=new TextDecoder();
  const n=dv.getUint16(eocd+10,true); let p=dv.getUint32(eocd+16,true); const ent=[];
  for(let k=0;k<n;k++){ if(dv.getUint32(p,true)!==0x02014b50)break;
    const nl=dv.getUint16(p+28,true), xl=dv.getUint16(p+30,true), cl=dv.getUint16(p+32,true);
    ent.push({nombre:td.decode(buf.subarray(p+46,p+46+nl)),metodo:dv.getUint16(p+10,true),csz:dv.getUint32(p+20,true),loff:dv.getUint32(p+42,true)});
    p+=46+nl+xl+cl; }
  if(ent.some(e=>e.nombre==='[Content_Types].xml'))return null;
  const e=ent.find(x=>/\.(xlsx|xlsm|xls|csv)$/i.test(x.nombre)&&!/^__MACOSX\//.test(x.nombre)); if(!e)return null;
  const ini=e.loff+30+dv.getUint16(e.loff+26,true)+dv.getUint16(e.loff+28,true), datos=buf.subarray(ini,ini+e.csz);
  if(e.metodo===0)return datos.slice();
  if(e.metodo===8&&typeof DecompressionStream==='function')
    return new Uint8Array(await new Response(new Blob([datos]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  return null;
}
// v142 · El bróker se reconoce por los primeros bytes, no por la extensión:
// un .xlsx y el .zip de XTB empiezan igual ("PK"), y el CSV de DEGIRO es
// texto plano. Así el mismo botón vale para los dos y no hay que acertar.
function brokerFile(buf,fname,mtime){
  try{
    const zip=buf[0]===0x50&&buf[1]===0x4B;                                  // PK: xlsx o zip
    const ole=buf[0]===0xD0&&buf[1]===0xCF&&buf[2]===0x11&&buf[3]===0xE0;    // .xls antiguo
    if(zip||ole) brokerRead(xtbParse(buf),fname,mtime,'xtb');
    else         brokerRead(degiroParse(bankTexto(buf)),fname,mtime,'degiro');
  }catch(err){
    alert('No pude leer el archivo:\n\n'+(err&&err.message||err));
    console.warn('broker',err);
  }
}
let _dgPending=null;
function brokerRead(parsed,fname,mtime,fuente){
  if(!parsed||parsed.err){
    alert('No pude leer el archivo.\n\n'+((parsed&&parsed.err)||'Formato no reconocido')+'\n\n'+
      (fuente==='xtb'
        ? 'De XTB vale el .zip tal cual lo descargas, o el .xlsx que lleva dentro (Historial de la cuenta → Exportar).'
        : 'De DEGIRO tiene que ser el Portfolio.csv que exporta desde Cartera.'));
    return;
  }
  // la fecha por defecto es la del archivo, no la de hoy: si exportaste el
  // viernes y lo importas el domingo, el saldo es del viernes
  let d=todayISO();
  if(mtime){ const t=new Date(mtime); if(!isNaN(t)) d=t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0'); }
  // XTB fecha el informe por dentro, y eso manda sobre la fecha del archivo
  if(parsed.fecha) d=parsed.fecha;
  _dgPending={parsed,fuente:fuente||'degiro',
    fname:fname||(fuente==='xtb'?'extracto XTB':'Portfolio.csv'),date:d};
  showDegiroPreview();
}
// v167 · La liquidez de XTB sale SOLO del archivo, sin mirar saldos de antes.
// XTB no escribe el saldo en ninguna casilla: el efectivo es la suma de todas
// las operaciones de caja, siempre que el extracto empiece cuando abriste la
// cuenta. Eso se comprueba con el propio archivo, de dos maneras:
//   · si alguna posición se abrió antes de la fecha de inicio, su compra no
//     está en el archivo, y tampoco el dinero que la pagó;
//   · si, ordenando los movimientos por hora, el saldo quedara en negativo en
//     algún momento, es que ya había dinero antes que no aparece.
// En los dos casos la suma no es tu saldo: no se propone cifra, se explica por
// qué y cómo descargarlo para que salga exacta.
// Antes se encadenaba con el último saldo guardado anterior al extracto, y si
// entre ese saldo y el inicio había compras que el archivo no trae, salía mal:
// con el extracto del 16/9 al 17/10 daba X € en vez de Y €.
function xtbEfectivo(P){
  const X=(P&&P.parsed)||{};
  const suma=(X.cash!=null&&isFinite(X.cash))?Number(X.cash):null;
  if(suma==null)return {cash:null,modo:'nada'};
  const antes=(X.posAntes||[]).slice().sort((a,b)=>a.t-b.t);
  if(antes.length)return {cash:null,modo:'parcial',motivo:'antes',suma,primera:antes[0]};
  const clave=o=>o.t!=null?o.t:(o.fecha?Date.parse(o.fecha):0);
  const ops=(X.cashOps||[]).slice().sort((a,b)=>(clave(a)-clave(b))||(b.amount-a.amount));
  let s=0,min=0;
  ops.forEach(o=>{ s+=o.amount; if(s<min)min=s; });
  if(min<-0.01)return {cash:null,modo:'parcial',motivo:'negativo',suma};
  return {cash:Math.round(suma*100)/100,modo:'completo'};
}
// Por qué un extracto no basta para saber el saldo, en una frase
function xtbEfectivoMotivo(efe,X){
  if(!efe||efe.modo!=='parcial')return '';
  const suma=' La suma de sus operaciones ('+fmt2(efe.suma||0)+'€) no es tu saldo.';
  if(efe.motivo==='antes'&&efe.primera)
    return 'Empieza el '+fmtDate((X&&X.desde)||'')+' y tienes posiciones abiertas desde el '+
      fmtDate(xtbISO(new Date(efe.primera.t)))+' ('+efe.primera.nombre+'): el dinero que había antes no aparece en él.'+suma;
  return 'Con solo lo que trae, el saldo quedaría en negativo en algún momento: había dinero antes de la fecha de inicio que no aparece en él.'+suma;
}
function degiroSetBroker(v){
  if(!_dgPending)return;
  _dgPending.brokerSel=v;
  if(!_dgPending.cashManual)_dgPending.cash=undefined;   // se recalcula para el bróker elegido
  showDegiroPreview();
}
function degiroSetCash(v){
  if(_dgPending)_dgPending.cashManual=true;
  if(!_dgPending)return;
  const t=String(v||'').trim();
  _dgPending.cash=t===''?null:(dgNum(t));
}
// El bróker no se adivina a solas: se propone el que encaja con el archivo
// y se enseña en un desplegable, porque meter la liquidez de XTB en la
// ficha de DEGIRO es exactamente el tipo de error que no se ve luego.
function brokerSugerido(fuente){
  const B=cfg.brokers||[];
  const rx=fuente==='xtb'?/xtb/i:/degiro/i;
  return B.find(b=>rx.test(b.name||''))||null;
}
function brokerNombreFuente(fuente){ return fuente==='xtb'?'XTB':'DEGIRO'; }
function degiroSetDate(v){ if(_dgPending){_dgPending.date=v; showDegiroPreview();} }

function showDegiroPreview(){
  const P=_dgPending; if(!P)return;
  const plan=degiroPlan(P.parsed,P.date);
  P.plan=plan;
  const totalNuevo=plan.upd.reduce((s,u)=>s+u.row.eur,0);
  const totalAnt=plan.upd.reduce((s,u)=>s+(u.prev?u.prev.amount:0),0);
  const dif=totalNuevo-totalAnt;
  const porIsin=plan.upd.filter(u=>u.how==='ISIN').length+plan.upd.filter(u=>u.how==='ticker').length;
  const porNombre=plan.upd.filter(u=>u.how==='nombre').length;
  const esXtb=P.fuente==='xtb';
  let h='';
  h+='<div style="font-size:11.5px;color:var(--muted);margin-bottom:.5rem">'+
     '<strong style="color:var(--navy)">'+brokerNombreFuente(P.fuente)+'</strong> · '+
     escapeHtml(P.fname)+' · '+plan.upd.length+' posiciones reconocidas'+
     (esXtb&&P.parsed.desde&&P.parsed.hasta?(' · periodo '+fmtDate(P.parsed.desde)+' → '+fmtDate(P.parsed.hasta)):'')+
     (plan.porCabecera?'':' · <span style="color:var(--amber)">sin cabecera reconocible, leído por posición de columna</span>')+
     '</div>';
  h+='<div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.6rem">'+
     '<label style="font-size:11.5px">Fecha de la valoración '+
     '<input type="date" value="'+P.date+'" onchange="degiroSetDate(this.value)" style="font-size:11px;padding:1px 5px"></label>'+
     '<span style="font-size:10.5px;color:var(--faint)">(la del archivo, no la de hoy)</span></div>';
  h+='<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:.7rem">'+
     [['Valor cartera',fmt(totalNuevo)+'€','var(--navy)'],
      ['Cambio',(dif>=0?'+':'')+fmt(dif)+'€',dif>=0?'var(--teal)':'var(--red)'],
      ['Emparejadas',porIsin+' ISIN/ticker · '+porNombre+' nombre','var(--muted)']]
     .map(([l,v,c])=>'<div style="background:var(--surface2);border-radius:6px;padding:.45rem .5rem;text-align:center">'+
       '<div style="font-size:14px;font-weight:700;color:'+c+'">'+v+'</div>'+
       '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)">'+l+'</div></div>').join('')+'</div>';

  if(plan.qtyDiff.length){
    h+='<div style="background:#FFF6E0;border:1px solid #E8C97A;border-radius:6px;padding:.5rem .6rem;font-size:11.5px;color:var(--amber);margin-bottom:.6rem">'+
      '<strong>El número de acciones no cuadra</strong> con tus operaciones registradas. El valor se actualizará igual, pero revisa si falta anotar alguna compra o venta:<ul style="margin:.3rem 0 0 1rem">'+
      plan.qtyDiff.map(q=>'<li>'+escapeHtml(q.stk.name)+': DEGIRO dice <strong>'+q.degiro+'</strong>, tus operaciones suman <strong>'+q.mias+'</strong></li>').join('')+'</ul></div>';
  }
  if(plan.faltan.length){
    h+='<div style="background:#FFF6E0;border:1px solid #E8C97A;border-radius:6px;padding:.5rem .6rem;font-size:11.5px;color:var(--amber);margin-bottom:.6rem">'+
      '<strong>Tienes abiertas y no salen en el archivo:</strong> '+plan.faltan.map(s=>escapeHtml(s.name)).join(', ')+
      '. No se tocan.'+(P.fuente==='xtb'
        ? ' Es lo esperable: este extracto es de XTB y esas posiciones están en DEGIRO.'
        : ' Si las vendiste, anótalo; si están en otro bróker, es normal.')+'</div>';
  }
  if(plan.upd.length){
    h+='<div class="tbl-scroll" style="max-height:200px;overflow:auto;margin-bottom:.6rem"><table class="detail-table" style="font-size:11.5px">'+
      '<thead><tr><th>Posición</th><th>Antes</th><th>Ahora</th><th>Δ</th><th></th></tr></thead><tbody>';
    plan.upd.slice().sort((a,b)=>b.row.eur-a.row.eur).forEach(u=>{
      const ant=u.prev?u.prev.amount:null;
      const d=ant==null?null:u.row.eur-ant;
      h+='<tr><td>'+escapeHtml(u.stk.name).slice(0,34)+
        (u.how==='nombre'?' <span style="font-size:9px;color:var(--amber)" title="emparejada por nombre, no por ISIN">~nombre</span>':'')+
        (u.ponIsin?' <span style="font-size:9px;color:var(--teal)">+ISIN</span>':'')+'</td>'+
        '<td>'+(ant==null?'—':fmt(ant)+'€')+'</td><td>'+fmt(u.row.eur)+'€</td>'+
        '<td style="color:'+(d==null?'var(--faint)':(d>=0?'var(--teal)':'var(--red)'))+'">'+(d==null?'—':(d>=0?'+':'')+fmt(d)+'€')+'</td>'+
        '<td style="font-size:10px;color:var(--faint)">'+(u.row.qty!=null?u.row.qty+' acc':'')+'</td></tr>';
    });
    h+='</tbody></table></div>';
  }
  // ─── Efectivo y a qué bróker va ───────────────────────────────────
  const B=cfg.brokers||[];
  if(P.brokerSel===undefined){
    const sug=brokerSugerido(P.fuente);
    P.brokerSel=sug?sug.id:'__nuevo__';
  }
  const efe=esXtb?xtbEfectivo(P):null;
  P.efe=efe;
  if(P.cash===undefined) P.cash=esXtb?efe.cash:(plan.cash!=null?plan.cash:null);
  h+='<div style="border:1px solid var(--border);border-radius:6px;padding:.55rem .6rem;margin-bottom:.6rem">'+
    '<div style="font-size:11.5px;font-weight:600;margin-bottom:.35rem">Liquidez del bróker</div>'+
    '<div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;font-size:11.5px">'+
      '<label>Efectivo <input type="text" value="'+(P.cash==null?'':fmt2(P.cash))+'" '+
        'onchange="degiroSetCash(this.value)" style="width:96px;font-size:11px;padding:1px 5px;text-align:right"> €</label>'+
      '<label>en <select id="dg-broker" onchange="degiroSetBroker(this.value)" style="font-size:11px;padding:1px 5px">'+
        B.map(b=>'<option value="'+b.id+'"'+(P.brokerSel===b.id?' selected':'')+'>'+escapeHtml(b.name)+'</option>').join('')+
        '<option value="__nuevo__"'+(P.brokerSel==='__nuevo__'?' selected':'')+'>➕ crear «'+brokerNombreFuente(P.fuente)+'»</option>'+
        '<option value="">— no tocar la liquidez —</option>'+
      '</select></label>'+
    '</div>';
  if(esXtb){
    const per=P.parsed.desde?('('+fmtDate(P.parsed.desde)+' → '+fmtDate(P.parsed.hasta||P.date)+')'):'';
    if(efe.modo==='completo'){
      h+='<div style="font-size:10.5px;color:var(--muted);margin-top:.35rem;line-height:1.35">'+
        'Sale solo del archivo: es la suma de sus '+(P.parsed.cashOps||[]).length+' operaciones de caja '+per+'. '+
        'El extracto empieza antes de todo lo que hay en la cuenta, así que esa suma es tu saldo.</div>';
    } else if(efe.modo==='parcial'){
      h+='<div style="font-size:10.5px;color:var(--red);margin-top:.35rem;line-height:1.35">'+
        '<strong>Este extracto no trae todo lo de la cuenta.</strong> '+escapeHtml(xtbEfectivoMotivo(efe,P.parsed))+
        ' Descárgalo desde el día que abriste la cuenta y la liquidez saldrá exacta solo con el archivo. '+
        'Mientras, la liquidez no se toca (o escríbela a mano).</div>';
    }
    const flu=(P.parsed.cashOps||[]).filter(o=>o.flujo);
    if(flu.length){
      h+='<label style="display:block;font-size:11px;margin-top:.4rem">'+
        '<input type="checkbox" id="dg-flows" checked> Registrar también '+P.parsed.nDep+' ingreso(s)'+
        (P.parsed.nRet?' y '+P.parsed.nRet+' retirada(s)':'')+' como aportaciones al bróker'+
        ' <span style="color:var(--faint)">(no se duplican si vuelves a importar)</span></label>';
    }
    // v169 · intereses y dividendos, con su retención
    const ren=(P.parsed.rentas||[]).filter(x=>!incomeLog.some(e=>e.ext===x.ext));
    if(ren.length){
      const nI=ren.filter(x=>x.cat==='rend').length, nD=ren.length-nI;
      const b=ren.reduce((a,x)=>a+x.bruto,0), r=ren.reduce((a,x)=>a+x.ret+x.retExt,0);
      h+='<label style="display:block;font-size:11px;margin-top:.4rem">'+
        '<input type="checkbox" id="dg-divs" checked> Registrar '+
        [nI?nI+' cobro(s) de intereses':'',nD?nD+' dividendo(s)':''].filter(Boolean).join(' y ')+
        ' como ingresos: '+fmt2(b)+'€ brutos, '+fmt2(r)+'€ retenidos'+
        ' <span style="color:var(--faint)">(cuentan en la previsión de la renta)</span></label>';
    }
    if(P.parsed.nCerr){
      h+='<div style="font-size:10.5px;color:var(--muted);margin-top:.3rem">El extracto trae '+P.parsed.nCerr+
        ' posición(es) cerrada(s). Las compras y ventas <strong>no</strong> se importan de aquí: anótalas con + Compra / − Venta '+
        'para que el coste de adquisición y la plusvalía salgan bien.</div>';
    }
  }
  h+='</div>';
  // ─── Compras y ventas que trae el propio extracto (solo XTB) ──────
  const opsX=esXtb?(P.parsed.ops||[]):[];
  if(opsX.length){
    const yaEstan=opsX.filter(o=>transactions.some(t=>t.ext===o.orden));
    const faltan=opsX.filter(o=>!transactions.some(t=>t.ext===o.orden));
    h+='<div style="border:1px solid var(--border);border-radius:6px;padding:.55rem .6rem;margin-bottom:.6rem">'+
      '<div style="font-size:11.5px;font-weight:600;margin-bottom:.3rem">Compras y ventas en el extracto ('+opsX.length+')</div>';
    h+='<div class="tbl-scroll" style="max-height:150px;overflow:auto"><table class="detail-table" style="font-size:11px">'+
      '<thead><tr><th>Fecha</th><th>Op.</th><th>Acción</th><th>Títulos</th><th>Precio</th><th>Total</th></tr></thead><tbody>'+
      opsX.map(o=>'<tr'+(yaEstan.indexOf(o)>=0?' style="opacity:.5"':'')+'><td>'+fmtDate(o.date)+'</td>'+
        '<td style="color:'+(o.tipo==='buy'?'var(--teal)':'var(--red)')+'">'+(o.tipo==='buy'?'Compra':'Venta')+'</td>'+
        '<td>'+escapeHtml(o.prod).slice(0,26)+'</td><td>'+fmt2(o.n)+'</td>'+
        '<td>'+fmt2(o.valEUR/o.n)+'€</td><td>'+fmt2(o.valEUR)+'€</td></tr>').join('')+
      '</tbody></table></div>';
    if(faltan.length){
      h+='<label style="display:block;font-size:11px;margin-top:.4rem">'+
        '<input type="checkbox" id="dg-ops" checked> Registrar '+faltan.length+' operación(es) nueva(s)'+
        ' <span style="color:var(--faint)">(se añaden a las que ya tienes, no las sustituyen)</span></label>'+
        '<div style="font-size:10.5px;color:var(--muted);margin-top:.3rem">De aquí salen los títulos y el coste de adquisición, '+
        'que es lo que hace falta para la plusvalía. Si la acción no existe todavía, se crea.</div>';
    } else {
      h+='<div style="font-size:10.5px;color:var(--muted);margin-top:.35rem">Ya las tienes todas registradas.</div>';
    }
    h+='</div>';
  }
  if(plan.nuevas.length){
    h+='<div style="border:1px solid var(--border);border-radius:6px;padding:.5rem .6rem;margin-bottom:.6rem">'+
      '<div style="font-size:11.5px;font-weight:600;margin-bottom:.3rem">No las reconozco ('+plan.nuevas.length+')</div>'+
      '<div style="font-size:10.5px;color:var(--muted);margin-bottom:.35rem">Marca solo las que sean de verdad posiciones nuevas. '+
      'Si alguna es una que ya tienes con otro nombre, <strong>déjala sin marcar</strong> y corrige el nombre o el ISIN en Datos entrada: '+
      'crearla duplicaría la posición y te subiría el patrimonio a base de contar dos veces.</div>'+
      plan.nuevas.map((r,i)=>'<label style="display:block;font-size:11px;margin:2px 0">'+
        '<input type="checkbox" id="dg-new-'+i+'"> '+escapeHtml(r.prod)+
        ' <span style="color:var(--faint)">'+escapeHtml(r.isin||'sin ISIN')+' · '+fmt(r.eur)+'€</span></label>').join('')+
      '</div>';
  }
  h+='<div style="display:flex;gap:.5rem;justify-content:flex-end;flex-wrap:wrap">'+
    '<button class="btn-sm" onclick="document.getElementById(\'dlv-modal\').remove()" style="font-size:12px">Cancelar</button>'+
    '<button class="btn-sm" onclick="degiroCommit()" style="font-size:12px;background:var(--navy);color:#fff;border-color:var(--navy)">Aplicar</button></div>';
  showModalWide('📥 Posiciones de '+brokerNombreFuente(P.fuente),h);
}

function degiroCommit(){
  const P=_dgPending; if(!P||!P.plan){toast('Nada que aplicar');return;}
  const date=P.date;
  // las casillas se leen por NOMBRE, no por posición: si al registrar las
  // operaciones se crea la acción, la lista de "no las reconozco" cambia
  const crearNombres=new Set(P.plan.nuevas.filter((r,i)=>document.getElementById('dg-new-'+i)?.checked).map(r=>r.prod));
  const opsX=(P.fuente==='xtb'?(P.parsed.ops||[]):[]);
  const hacerOps=opsX.length&&document.getElementById('dg-ops')?.checked;
  if(!guardedAction('importar posiciones de '+brokerNombreFuente(P.fuente)+' de '+date))return;
  let act=0,nue=0,isins=0,ticks=0,nOps=0,nAccOps=0;
  // el bróker se resuelve aquí arriba porque de él depende dónde va cada
  // valoración, no solo la liquidez
  let bk=null, flujos=0;
  {
    const sel=(P.brokerSel===undefined?'':P.brokerSel);
    if(sel==='__nuevo__'){
      bk={id:'brk_'+Date.now(),name:brokerNombreFuente(P.fuente)};
      cfg.brokers=cfg.brokers||[]; cfg.brokers.push(bk);
    } else if(sel){ bk=(cfg.brokers||[]).find(b=>b.id===sel)||null; }
  }
  // Primero las compras y ventas: crean la acción, y así la valoración de la
  // hoja de posiciones abiertas ya tiene con qué emparejarse.
  if(hacerOps){ const r=xtbAplicarOps(opsX); nOps=r.creadas; nAccOps=r.acciones; }
  const plan=hacerOps?degiroPlan(P.parsed,date):P.plan;
  const crear=plan.nuevas.filter(r=>crearNombres.has(r.prod));
  // v149 · la valoración se guarda por bróker: dos carteras del mismo día ya no
  // se pisan, se suman. El apunte se busca por (acción + fecha + bróker).
  const ponerBal=(stockId,amount)=>{
    const brk=bk?bk.id:'';
    const i=balanceLog.findIndex(b=>b.refType==='stock'&&b.refId===stockId&&b.date===date&&(b.brk||'')===brk);
    if(i>=0){ balanceLog[i].amount=amount; balanceLog[i].src=P.fuente; }
    else balanceLog.push({id:'bal_pf_'+stockId+'_'+(brk||'x')+'_'+date.replace(/-/g,''),
      refType:'stock',refId:stockId,date,amount,src:P.fuente,brk});
  };
  plan.upd.forEach(u=>{
    if(u.ponIsin){u.stk.isin=u.ponIsin;isins++;}   // se cura solo: la próxima ya empareja por ISIN
    if(u.ponTick){u.stk.tick=u.ponTick;ticks++;}   // en XTB el que no falla es el ticker
    ponerBal(u.stk.id,u.row.eur); act++;
  });
  crear.forEach(r=>{
    const stk={id:'stk_pf_'+Date.now()+'_'+Math.floor(Math.random()*1000),name:dgTitulo(r.prod)};
    if(r.isin)stk.isin=r.isin;
    if(r.tick)stk.tick=r.tick;
    cfg.stocks.push(stk); ponerBal(stk.id,r.eur); nue++;
  });
  // ─── Liquidez: al bróker que hayas elegido, no siempre al primero ──
  const efectivo=(P.cash!=null&&isFinite(P.cash))?Math.round(P.cash*100)/100:null;
  if(bk&&efectivo!=null){
    const i=balanceLog.findIndex(b=>b.refType==='broker'&&b.refId===bk.id&&b.date===date);
    if(i>=0) balanceLog[i].amount=efectivo;
    else balanceLog.push({id:'bal_pfbrk_'+bk.id+'_'+date.replace(/-/g,''),refType:'broker',refId:bk.id,
      date,amount:efectivo,src:P.fuente});
  }
  // Ingresos y retiradas de XTB como aportaciones al bróker. La clave 'ext'
  // es la del propio movimiento en XTB: reimportar el mismo extracto no los
  // duplica, y si amplías el periodo solo entran los que faltaban.
  if(bk&&P.fuente==='xtb'&&document.getElementById('dg-flows')?.checked){
    if(typeof brokerFlows==='undefined')brokerFlows=[];
    (P.parsed.cashOps||[]).filter(o=>o.flujo&&o.fecha).forEach((o,k)=>{
      const key='xtb:'+(o.id||(o.fecha+':'+o.amount));
      if(brokerFlows.some(f=>f.ext===key))return;
      brokerFlows.push({id:'bf_x'+Date.now()+'_'+k,date:o.fecha,brokerId:bk.id,
        type:o.flujo,amount:Math.abs(o.amount),ext:key});
      flujos++;
    });
  }
  // v169 · intereses y dividendos de XTB, como ingresos con su retención
  let nRent=0;
  if(P.fuente==='xtb'&&document.getElementById('dg-divs')?.checked)nRent=rentasAplicar(P.parsed.rentas,'xtb').n;
  try{ALM.setItem('dlv_degiro_last',JSON.stringify({at:new Date().toISOString(),date,n:act,
    fuente:P.fuente,broker:bk?bk.name:null}));}catch(e){fallo('ALM.setItem',e)}
  _dgPending=null;
  save(); renderAll(); renderDegiroPanel();
  try{renderStockTxList();}catch(e){fallo('renderStockTxList',e)} try{renderFormLists();}catch(e){fallo('renderFormLists',e)} try{renderAnalisis();}catch(e){fallo('renderAnalisis',e)}
  document.getElementById('dlv-modal')?.remove();
  toast('✅ '+act+' posiciones al día'+(nue+nAccOps?' · '+(nue+nAccOps)+' nuevas':'')+
    (nOps?' · '+nOps+' operación(es)':'')+(isins?' · '+isins+' ISIN':'')+(ticks?' · '+ticks+' ticker':'')+
    (bk&&efectivo!=null?' · '+fmt2(efectivo)+'€ en '+bk.name:'')+(flujos?' · '+flujos+' movimiento(s)':'')+
    (nRent?' · '+nRent+' interés(es) o dividendo(s)':'')+' · puedes deshacerlo');
}

function renderDegiroPanel(){
  const el=document.getElementById('degiro-body'); if(!el)return;
  let last=null;
  try{last=JSON.parse(ALM.getItem('dlv_degiro_last')||'null');}catch(e){fallo('last',e)}
  const conIsin=cfg.stocks.filter(s=>s.isin).length;
  let h='<div style="font-size:11.5px;color:var(--muted);margin-bottom:.45rem">'+
    (last?'Última actualización: valores del <strong>'+fmtDate(last.date)+'</strong> ('+last.n+' posiciones'+
          (last.fuente?', desde '+(last.fuente==='xtb'?'XTB':'DEGIRO'):'')+').'
        :'Todavía no has importado posiciones con esta versión.')+
    ' '+conIsin+' de '+cfg.stocks.length+' acciones tienen ISIN guardado — el emparejamiento por ISIN es el que no se equivoca.</div>';
  h+='<div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">'+
    '<button type="button" class="btn-sm" onclick="degiroStart(false)" style="font-size:11.5px;background:var(--navy);color:#fff;border-color:var(--navy)">📥 Importar cartera del bróker</button>'+
    (fsSupported()
      ? '<button type="button" class="btn-sm" onclick="degiroStart(true)" style="font-size:11.5px">Elegir otro archivo</button>'+
        (_dgHandle?'<button type="button" class="btn-sm" onclick="degiroForget()" style="font-size:11.5px">Olvidar</button>'
                 :'<span style="font-size:10.5px;color:var(--faint)">La primera vez eliges el archivo; después basta con el botón.</span>')
      : '<span style="font-size:10.5px;color:var(--faint)">Este navegador pedirá el archivo cada vez.</span>')+
    '</div>';
  el.innerHTML=h;
}


// ════════════════════════════════════════════
// v98 · ISIN de los fondos (verificados contra tu propio valor liquidativo)
// ════════════════════════════════════════════
function setFundIsin(id,v){
  const f=cfg.funds.find(x=>x.id===id); if(!f)return;
  const t=String(v||'').toUpperCase().replace(/\s/g,'');
  if(t&&!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(t)){toast('Eso no parece un ISIN (2 letras + 10 caracteres)');return;}
  if(t)f.isin=t; else delete f.isin;
  save(); renderFormLists(); toast(t?'ISIN guardado':'ISIN borrado');
}
// Los tres se confirmaron cuadrando el VL publicado con el que se deduce de tus
// participaciones. Magallanes estaba mal etiquetado por partida doble: no existe
// ningún fondo "Magallanes Internacional" (eso es la categoría) y la clase es M,
// no C — la C real cotiza un 5,6% por encima.
// "malos" = etiquetas que se sabe que están equivocadas. El renombrado se ata al
// CONTENIDO, no a una marca de "ya hecho": así vuelve a corregirse si restauras
// una copia antigua, y en cuanto le pones un nombre tuyo deja de tocarlo, porque
// tu nombre ya no coincide con ninguno de los malos.
// v169 · Era una corrección de una sola vez para tus tres fondos (ISIN y
// nombre de la clase). Tus datos ya la llevan, y no tiene sentido que la lista
// de tus fondos esté en el código público.
const FUND_IDENT=[];
function migrateFundIdent(){
  let n=0;
  try{
    FUND_IDENT.forEach(m=>{
      const f=cfg.funds.find(x=>x.id===m.id);
      if(!f)return;
      const esSuyo=m.espera.test(f.name||'')||(m.nombre&&f.name===m.nombre);
      if(!esSuyo)return;
      // El ISIN se repone SIEMPRE que falte, sin marca de "ya migrado": restaurar
      // una copia anterior o fusionar un archivo viejo borra el campo, y con una
      // marca de una sola vez ya no volvía nunca. Reponer algo que falta es
      // inofensivo, así que se comprueba en cada arranque.
      if(!f.isin){f.isin=m.isin;n++;}
      // El nombre solo si sigue siendo una de las etiquetas equivocadas.
      if(m.nombre&&(m.malos||[]).some(rx=>rx.test(f.name||''))){f.name=m.nombre;n++;}
    });
    if(n)save();
  }catch(e){console.warn('mig fondos',e);}
  return n;
}


// ════════════════════════════════════════════
// v100 · FONDOS: UNA SOLA FUENTE DE VERDAD + FICHA POR FONDO
// ════════════════════════════════════════════
// Hasta la v99 la gráfica de fondos leía una serie CONGELADA guardada aparte,
// indexada además por unas claves ('azvalor') que no eran los ids de tus fondos
// ('pp_cobas'): esa línea nunca miró tus datos. Por eso azValor aparecía por
// debajo de 10.000€ aunque tú hubieras actualizado el precio.
// Ahora todo sale de balanceLog (lo que tú anotas) y de las aportaciones; la
// serie antigua se usa solo para rellenar fechas anteriores a tu primer saldo.

// La serie vieja usaba otras claves; se mapean a los ids reales
const FUND_SERIES_ALIAS={azvalor:'pp_cobas'};
function fundSeriesLegacy(fid){
  const S=FUND_SER();
  if(S[fid])return S[fid];
  for(const k of Object.keys(S)) if((FUND_SERIES_ALIAS[k]||k)===fid) return S[k];
  return null;
}
// Valor del fondo a lo largo del tiempo: tus saldos mandan; el histórico
// antiguo solo aporta fechas que tú no tengas.
function fundValueSeries(fid){
  const m=new Map();
  const leg=fundSeriesLegacy(fid);
  if(leg&&leg.val) leg.val.forEach(p=>{if(p&&p[0])m.set(p[0],Number(p[1])||0);});
  balanceLog.filter(b=>b.refType==='fund'&&b.refId===fid&&b.date)
    .forEach(b=>m.set(b.date,Number(b.amount)||0));   // el tuyo pisa al viejo
  return [...m.entries()].map(([date,val])=>({date,val}))
    .sort((a,b)=>a.date.localeCompare(b.date));
}
function fundContribs(fid){
  const out=transactions.filter(t=>t.type==='fund_aport'&&t.fundId===fid&&t.date)
    .map(t=>({date:t.date,amount:Number(t.amount)||0}));
  return out.sort((a,b)=>a.date.localeCompare(b.date));
}
function fundRange(fid,from,to){
  const S=fundValueSeries(fid).filter(p=>(!from||p.date>=from)&&(!to||p.date<=to));
  const C=S.length?fundContribs(fid).filter(c=>c.date>S[0].date&&c.date<=S[S.length-1].date):[];
  return {S,C};
}
// ─── Rentabilidad ───────────────────────────────────────────────────
// TWR (encadenada): la del FONDO. No le afecta cuándo metiste dinero, así que
// es la comparable con la ficha oficial. Cada aportación se imputa al principio
// de su tramo, que es la aproximación estándar cuando no consta la hora.
function fundTWR(fid,from,to){
  const {S,C}=fundRange(fid,from,to);
  if(S.length<2)return null;
  let f=1,ok=false;
  for(let i=1;i<S.length;i++){
    const ap=C.filter(c=>c.date>S[i-1].date&&c.date<=S[i].date).reduce((s,c)=>s+c.amount,0);
    const base=S[i-1].val+ap;
    if(base>0){f*=(S[i].val/base);ok=true;}
  }
  return ok?f-1:null;
}
// TIR anualizada: lo que TÚ has sacado, contando el momento de cada aportación.
function fundTIR(fid,from,to){
  const {S,C}=fundRange(fid,from,to);
  if(S.length<2)return null;
  const fl=[{date:S[0].date,amount:-S[0].val}];
  C.forEach(c=>fl.push({date:c.date,amount:-c.amount}));
  fl.push({date:S[S.length-1].date,amount:S[S.length-1].val});
  fl.sort((a,b)=>a.date.localeCompare(b.date));
  if(!fl.some(x=>x.amount<0)||!fl.some(x=>x.amount>0))return null;
  try{return xirr(fl);}catch(e){return null;}
}
function fundStats(fid,from,to){
  const {S,C}=fundRange(fid,from,to);
  if(!S.length)return null;
  const v0=S[0].val,v1=S[S.length-1].val;
  const ap=C.reduce((s,c)=>s+c.amount,0);
  const dias=(Date.parse(S[S.length-1].date)-Date.parse(S[0].date))/864e5;
  return {desde:S[0].date,hasta:S[S.length-1].date,v0,v1,ap,
    ganancia:v1-v0-ap, twr:fundTWR(fid,from,to), tir:fundTIR(fid,from,to),
    puntos:S.length, aportaciones:C.length, dias};
}

// ─── Fichas individuales ────────────────────────────────────────────
const _fCharts={};
let _fRange={}, _fMode={};
function fundSetMode(fid,m){_fMode[fid]=m;renderFundCard(fid);}
function fundRangeGet(fid){ return _fRange[fid]||(_fRange[fid]={from:'',to:''}); }
function fundSetRange(fid,k,v){ fundRangeGet(fid)[k]=v; renderFundCard(fid); }
function fundQuick(fid,which){
  const S=fundValueSeries(fid);
  if(!S.length)return;
  const last=S[S.length-1].date;
  let from='';
  if(which==='1m')from=isoMasMeses(last,-1);
  else if(which==='3m')from=isoMasMeses(last,-3);
  else if(which==='1a')from=isoMasAnios(last,-1);
  else if(which==='ytd'){from=last.slice(0,4)+'-01-01';}
  else if(which==='todo'){from='';}
  _fRange[fid]={from,to:which==='todo'?'':last};
  renderFundCard(fid);
}
function renderFundCards(){
  const box=document.getElementById('fund-cards');
  if(!box)return;
  box.innerHTML=cfg.funds.map(f=>{
    const col=(fundSeriesLegacy(f.id)||{}).color||'#0B3D91';
    return '<div class="card" id="fcard-'+f.id+'">'+
      '<div class="card-hdr"><div class="card-title">'+
        '<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:'+col+';margin-right:6px"></span>'+
        escapeHtml(f.name)+'</div>'+
        '<div style="font-size:10.5px;color:var(--faint)">'+(f.isin?escapeHtml(f.isin):'sin ISIN')+'</div></div>'+
      '<div id="fbody-'+f.id+'"></div>'+
      '<div style="position:relative;height:210px;margin-top:.5rem"><canvas id="fchart-'+f.id+'"></canvas></div>'+
      '</div>';
  }).join('');
  cfg.funds.forEach(f=>renderFundCard(f.id));
}
function renderFundCard(fid){
  const f=cfg.funds.find(x=>x.id===fid); if(!f)return;
  const body=document.getElementById('fbody-'+fid); if(!body)return;
  const R=fundRangeGet(fid);
  const all=fundValueSeries(fid);
  const st=fundStats(fid,R.from,R.to);
  const pct=v=>v==null?'—':((v>=0?'+':'')+(v*100).toFixed(2).replace('.',',')+'%');
  const col=v=>v==null?'var(--faint)':(v>=0?'var(--teal)':'var(--red)');
  let h='';
  if(!all.length){
    body.innerHTML='<div style="font-size:12px;color:var(--muted)">Aún no hay saldos anotados para este fondo. Añade un VL desde Datos entrada y aparecerá aquí.</div>';
    if(_fCharts[fid]){_fCharts[fid].destroy();delete _fCharts[fid];}
    return;
  }
  const NAV=navSeries(fid), meta=navMeta(fid);
  const modo=(_fMode&&_fMode[fid])||'valor';
  h+='<div style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;margin-bottom:.4rem">'+
    (NAV.length
      ? '<button type="button" class="btn-xs'+(modo==='valor'?' fmode-on':'')+'" onclick="fundSetMode(\''+fid+'\',\'valor\')">€ Tu posición</button>'+
        '<button type="button" class="btn-xs'+(modo==='vl'?' fmode-on':'')+'" onclick="fundSetMode(\''+fid+'\',\'vl\')">VL del fondo</button>'
      : '')+
    '<button type="button" class="btn-xs'+(NAV.length?'':' fmode-on')+'" onclick="document.getElementById(\'nav-file\').click()">📈 '+(NAV.length?'Reemplazar':'Importar')+' histórico VL</button>'+
    (meta?'<span style="font-size:10px;color:var(--faint)">'+meta.n+' días desde '+fmtDate(meta.desde)+
      (meta.dif!=null&&meta.dif>0.02?' · <span style="color:var(--amber)">otra clase, '+(meta.dif*100).toFixed(1).replace('.',',')+'% de diferencia</span>':'')+
      ' <a href="#" onclick="event.preventDefault();navBorrar(\''+fid+'\')" style="color:var(--red);text-decoration:none">✕</a></span>':'')+
    '</div>';
  if(!NAV.length){
    h+='<div style="background:#EBF0FA;border-radius:6px;padding:.5rem .6rem;font-size:11.5px;color:var(--navy);margin-bottom:.5rem">'+
      'Esta gráfica muestra <strong>tu posición</strong>, así que empieza el día que entraste. '+
      'Para ver el <strong>VL del fondo desde su nacimiento</strong> hay que importar su histórico: '+
      'descárgalo en Investing como «Datos históricos» del ISIN '+(f.isin?'<strong>'+escapeHtml(f.isin)+'</strong>':'de tu clase')+
      ' y súbelo con el botón de arriba, que admite el CSV de Investing y también un .json con varios fondos de golpe. Ojo con la clase: el VL de otra clase no es tu rentabilidad.</div>';
  }
  h+='<div style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;margin-bottom:.5rem">'+
    '<input type="date" value="'+(R.from||'')+'" onchange="fundSetRange(\''+fid+'\',\'from\',this.value)" style="font-size:11px;padding:1px 4px">'+
    '<span style="font-size:11px;color:var(--muted)">a</span>'+
    '<input type="date" value="'+(R.to||'')+'" onchange="fundSetRange(\''+fid+'\',\'to\',this.value)" style="font-size:11px;padding:1px 4px">'+
    ['1m','3m','1a','ytd','todo'].map(k=>'<button type="button" class="btn-xs" onclick="fundQuick(\''+fid+'\',\''+k+'\')">'+
      ({'1m':'1 mes','3m':'3 meses','1a':'1 año','ytd':'Este año','todo':'Todo'}[k])+'</button>').join('')+
    '</div>';
  if(st){
    const kc=(l,v,c,s)=>'<div style="background:var(--surface2);border-radius:6px;padding:.4rem .5rem;text-align:center">'+
      '<div style="font-size:14px;font-weight:700;color:'+(c||'var(--text)')+'">'+v+'</div>'+
      '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)">'+l+'</div>'+
      (s?'<div style="font-size:9.5px;color:var(--faint);margin-top:1px">'+s+'</div>':'')+'</div>';
    const parts=Number(f.parts)||0;
    const vl=parts>0?st.v1/parts:null;
    const escasa=st.dias>120&&st.puntos<Math.max(3,st.dias/45);
    h+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(115px,1fr));gap:6px">'+
      kc('Valor',fmt(st.v1)+'€','var(--navy)',fmtDate(st.hasta))+
      (vl?kc('VL implícito',vl.toFixed(2).replace('.',',')+'€','var(--text)','valor ÷ '+parts+' part.'):'')+
      (function(){
        const nr=NAV.length?navReturn(fid,R.from||NAV[0][0],R.to||NAV[NAV.length-1][0]):null;
        if(nr) return kc('Rentab. del fondo',pct(nr.ret),col(nr.ret),
          'exacta · VL '+nr.nav0.toFixed(2).replace('.',',')+' → '+nr.nav1.toFixed(2).replace('.',','))+
          (nr.anual!=null?kc('Anualizada',pct(nr.anual),col(nr.anual),'del fondo'):'');
        return kc('Rentab. del fondo'+(escasa?' *':''),pct(st.twr),col(st.twr),escasa?'aproximada':'del periodo');
      })()+
      kc('Tu TIR',pct(st.tir),col(st.tir),'anualizada')+
      kc('Ganancia',(st.ganancia>=0?'+':'')+fmt(st.ganancia)+'€',col(st.ganancia),'sin contar aportaciones')+
      (st.ap>0?kc('Aportado',fmt(st.ap)+'€','var(--muted)','en el periodo'):'')+
      '</div>';
    h+='<div style="font-size:10.5px;color:var(--faint);margin-top:.4rem">'+
      fmtDate(st.desde)+' → '+fmtDate(st.hasta)+' · '+st.puntos+' valoraciones'+
      (st.aportaciones?' · '+st.aportaciones+' aportación'+(st.aportaciones!==1?'es':''):'')+
      (st.ap>0?' · la <strong>rentabilidad del fondo</strong> descuenta las '+fmt(st.ap)+'€ que aportaste: comparar el valor final con el inicial a secas no sería rentabilidad, sería contar tu propio dinero como ganancia.':'')+
      (escasa&&!NAV.length?'<br><span style="color:var(--amber)">* Con '+st.puntos+' valoraciones repartidas en '+Math.round(st.dias/365)+' años, la rentabilidad encadenada es una estimación y puede alejarse de la oficial del fondo. Contrasta el <strong>VL implícito</strong> con el de la ficha: ese sí es exacto.</span>':'')+
      (vl?'<br>Compara el VL implícito con el publicado para '+(f.isin?escapeHtml(f.isin):'tu fondo')+': si no cuadra, o las participaciones están mal o la valoración es de otra fecha.':'')+
      '</div>';
  }
  body.innerHTML=h;
  // gráfica
  const S=fundRange(fid,R.from,R.to).S;
  const C=fundRange(fid,R.from,R.to).C;
  const cv=document.getElementById('fchart-'+fid);
  if(!cv||typeof Chart==='undefined')return;
  const dark=document.body.classList.contains('dark');
  const color=(fundSeriesLegacy(fid)||{}).color||'#0B3D91';
  const verVL=(modo==='vl'&&NAV.length);
  const puntos=verVL
    ? NAV.filter(p=>(!R.from||p[0]>=R.from)&&(!R.to||p[0]<=R.to)).map(p=>({date:p[0],val:p[1]}))
    : S;
  if(_fCharts[fid])_fCharts[fid].destroy();
  _fCharts[fid]=new Chart(cv,{type:'line',
    data:{datasets:[
      {label:verVL?'VL':'Valor',data:puntos.map(p=>({x:Date.parse(p.date),y:p.val})),borderColor:color,
       backgroundColor:color+'18',borderWidth:2,fill:true,tension:.15,
       pointRadius:puntos.length>60?0:2,pointHoverRadius:4},
      {label:'Aportación',type:'scatter',data:(verVL?[]:C).map(c=>{
         const near=S.reduce((a,p)=>Math.abs(Date.parse(p.date)-Date.parse(c.date))<Math.abs(Date.parse(a.date)-Date.parse(c.date))?p:a,S[0]||{date:c.date,val:0});
         return {x:Date.parse(c.date),y:near.val,amt:c.amount};}),
       borderColor:color,backgroundColor:'#fff',pointStyle:'triangle',radius:6,borderWidth:2}
    ]},
    options:{responsive:true,maintainAspectRatio:false,parsing:false,
      interaction:{mode:'nearest',intersect:false},
      plugins:{legend:{display:false},
        tooltip:{callbacks:{
          title:i=>i.length?fmtDateFull(new Date(i[0].parsed.x).toISOString().slice(0,10)):'',
          label:c=>c.raw&&c.raw.amt?('aportación +'+fmt(c.raw.amt)+'€'):(fmt(c.parsed.y)+'€')}},
        zoom:{zoom:{wheel:{enabled:true},pinch:{enabled:true},mode:'x'},pan:{enabled:true,mode:'x'}}},
      scales:{
        x:{type:'linear',grid:{display:false},
           min:puntos.length?Date.parse(puntos[0].date):undefined,
           max:puntos.length?Date.parse(puntos[puntos.length-1].date):undefined,
           ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:9},maxTicksLimit:6,
           callback:v=>fmtDateFull(new Date(v).toISOString().slice(0,10))}},
        y:{grid:{color:dark?'rgba(255,255,255,.06)':'rgba(0,0,0,.06)'},
           ticks:{color:dark?'#A0AEC0':'#8A97AB',font:{size:10},
           // con recorridos estrechos fmtK repetía "10k€" en todas las marcas
           callback:function(v){const t=this.chart.scales.y;const span=(t.max-t.min)||0;
             return (verVL?v.toFixed(span<5?2:0).replace('.',','):(span<20000?fmt(v):fmtK(v)))+'€';}}}}
    }});
  markScrollables(document.getElementById('fcard-'+fid));
}


// ════════════════════════════════════════════
// v101 · HISTÓRICO DE VALOR LIQUIDATIVO
// ════════════════════════════════════════════
// Con el VL oficial la rentabilidad deja de ser una estimación encadenada sobre
// tus valoraciones sueltas: pasa a ser exacta, VL final ÷ VL inicial, igual que
// la ficha del fondo. Y la gráfica arranca en el nacimiento del fondo, no en el
// día que entraste tú.
function navStore(){ personal.navHistory=personal.navHistory||{}; return personal.navHistory; }
function navOf(fid){ const h=navStore()[fid]; return (h&&h.serie)?h.serie:null; }
function navMeta(fid){ return navStore()[fid]||null; }

// Serie de VL lista para usar: la importada, prolongada con lo que se deduce de
// tus propios saldos para los días posteriores al archivo. Así sigue al día sola.
function navSeries(fid){
  const base=navOf(fid)||[];
  const f=cfg.funds.find(x=>x.id===fid);
  const parts=f?Number(f.parts)||0:0;
  // Sin histórico importado NO hay serie de VL. Antes se fabricaba una
  // dividiendo tus saldos entre tus participaciones, y eso no es el VL del
  // fondo: es tu posición con otro nombre, y arrancaba el día que compraste.
  if(!base.length) return [];
  const m=new Map(base.map(p=>[p[0],p[1]]));
  if(parts>0){
    const ultimo=base[base.length-1][0];
    fundValueSeries(fid).forEach(p=>{ if(p.date>ultimo) m.set(p.date,p.val/parts); });
  }
  return [...m.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
}
function navAt(fid,fecha,serie){
  const S=serie||navSeries(fid);
  if(!S.length)return null;
  let v=null;
  for(const p of S){ if(p[0]<=fecha)v=p[1]; else break; }
  return v!=null?v:S[0][1];   // antes del inicio: el primero
}
// Rentabilidad EXACTA entre dos fechas, sin que la contaminen tus aportaciones
function navReturn(fid,from,to){
  const S=navSeries(fid); if(S.length<2)return null;
  const d0=from||S[0][0], d1=to||S[S.length-1][0];
  const a=navAt(fid,d0,S), b=navAt(fid,d1,S);
  if(!a||!b||a<=0)return null;
  return {ret:b/a-1, nav0:a, nav1:b, d0, d1,
    anual:(function(){const y=(Date.parse(d1)-Date.parse(d0))/(365.25*864e5);
      return y>=1?Math.pow(b/a,1/y)-1:null;})()};
}

// ─── Importación del CSV (formato "Datos históricos" de Investing) ──
function navParseCSV(text){
  const t=String(text||'').replace(/^﻿/,'');
  const lines=t.split(/\r?\n/).filter(l=>l.trim());
  if(lines.length<2)return {err:'El archivo está vacío.'};
  const cut=l=>{const o=[];let c='',q=false;
    for(let i=0;i<l.length;i++){const ch=l[i];
      if(ch==='"'){ if(q&&l[i+1]==='"'){c+='"';i++;} else q=!q; }
      else if((ch===','||ch===';')&&!q){o.push(c);c='';}
      else c+=ch;}
    o.push(c);return o.map(x=>x.trim());};
  const head=cut(lines[0]).map(h=>h.toLowerCase());
  const iF=head.findIndex(h=>/fecha|date/.test(h));
  const iV=head.findIndex(h=>/último|ultimo|last|cierre|close|nav|liquidativo/.test(h));
  if(iF<0||iV<0)return {err:'No encuentro las columnas de fecha y valor. Se esperan "Fecha" y "Último".'};
  const num=s=>{s=String(s||'').replace(/[^0-9,.\-]/g,'');
    if(/,\d{1,6}$/.test(s))s=s.replace(/\./g,'').replace(',','.'); else s=s.replace(/,/g,'');
    const v=parseFloat(s); return isNaN(v)?null:v;};
  const fecha=s=>{s=String(s||'').trim();
    let m=s.match(/^(\d{2})[.\/-](\d{2})[.\/-](\d{4})$/); if(m)return m[3]+'-'+m[2]+'-'+m[1];
    m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m)return m[0];
    return null;};
  const out=[];
  lines.slice(1).forEach(l=>{const f=cut(l);
    const d=fecha(f[iF]), v=num(f[iV]);
    if(d&&v!=null&&v>0)out.push([d,v]);});
  if(!out.length)return {err:'No he podido leer ninguna fila con fecha y valor.'};
  out.sort((a,b)=>a[0].localeCompare(b[0]));
  const dedup=[];out.forEach(p=>{if(!dedup.length||dedup[dedup.length-1][0]!==p[0])dedup.push(p);else dedup[dedup.length-1]=p;});
  return {serie:dedup};
}
// Adivina a qué fondo pertenece comparando el VL del archivo con el que se
// deduce de tus participaciones. Es el mismo truco que usamos para identificar
// las clases. v169 · Se comparan los dos del MISMO día (el de tu última
// valoración) cuando el archivo lo trae; antes, el último del archivo contra
// tu última valoración, aunque fueran de semanas distintas.
function navGuessFund(serie){
  const fin=serie[serie.length-1];
  const cands=cfg.funds.map(f=>{
    const parts=fundParts(f.id);
    const vs=fundValueSeries(f.id);
    if(!parts||!vs.length)return null;
    const ult=vs[vs.length-1];
    const mio=ult.val/parts;
    let ref=null; for(const p of serie){ if(p[0]<=ult.date)ref=p; else break; }
    const suyo=(ref&&Math.abs(isoDias(ref[0],ult.date))<=7)?ref[1]:fin[1];
    return {fid:f.id,name:f.name,mio,dif:Math.abs(mio-suyo)/suyo,fecha:ult.date,mismoDia:!!(ref&&Math.abs(isoDias(ref[0],ult.date))<=7)};
  }).filter(Boolean).sort((a,b)=>a.dif-b.dif);
  return cands;
}
function navEsCSV(txt){
  const c=String(txt||'').replace(/^\uFEFF/,'').split(/\r?\n/,1)[0].toLowerCase().replace(/"/g,'');
  return /(fecha|date)/.test(c)&&/(último|ultimo|price|close|cierre)/.test(c)&&/(apertura|open)/.test(c)&&/(máximo|maximo|high)/.test(c);
}
// v169 · Guarda el histórico y, si el archivo es de tu clase (cuadra con tus
// participaciones a menos de un 2 %) y llega más allá de tu última valoración,
// pone el fondo al día: participaciones × último VL, en la fecha de ese VL.
// Antes el histórico solo servía para las gráficas y el fondo seguía con el
// valor que tecleaste la última vez.
function navAplicar(serie,fid,fname){
  const f=cfg.funds.find(x=>x.id===fid);
  if(!f||!serie||!serie.length)return {err:'Falta el fondo o el histórico'};
  const c=navGuessFund(serie).find(x=>x.fid===fid);
  navStore()[fid]={isin:f.isin||null,fuente:fname||'',dif:c?c.dif:null,n:serie.length,
    desde:serie[0][0],hasta:serie[serie.length-1][0],serie};
  const fin=serie[serie.length-1], parts=fundParts(fid), VI=getFundVLInfo(fid);
  const res={n:serie.length,dif:c?c.dif:null,valorado:null,motivo:''};
  if(!(parts>0))res.motivo='no sé cuántas participaciones tienes';
  else if(!c||c.dif>=0.02)res.motivo='el archivo es de otra clase del fondo (no cuadra con tus participaciones)';
  else if(VI.date&&String(fin[0])<=String(VI.date))res.motivo='tu última valoración ya es del '+fmtDate(VI.date)+' o posterior';
  else{
    const amount=Math.round(parts*fin[1]*100)/100;
    const i=balanceLog.findIndex(b=>b.refType==='fund'&&b.refId===fid&&b.date===fin[0]);
    const e={id:'bal_vl_'+fid+'_'+fin[0].replace(/-/g,''),refType:'fund',refId:fid,date:fin[0],amount,vl:fin[1],parts,src:'vl'};
    if(i>=0)balanceLog[i]=Object.assign(balanceLog[i],{amount,vl:fin[1],parts,src:'vl'}); else balanceLog.push(e);
    res.valorado={fecha:fin[0],amount,vl:fin[1],parts,antes:VI.amount,antesFecha:VI.date};
  }
  return res;
}

// ════════════════════════════════════════════════════════════════════
// v115 · PRECIOS HISTÓRICOS DE ACCIONES
// ════════════════════════════════════════════════════════════════════
// Hasta ahora la evolución diaria de la cartera dependía de que importaras el
// extracto de DEGIRO. Diez importaciones en tres meses: la gráfica es una
// escalera, no una curva.
//
// No hace falta. Tus compras y ventas ya están anotadas con fecha, títulos y
// precio, así que se sabe EXACTAMENTE cuántas acciones de cada valor tenías
// cualquier día. Lo único que falta es el precio de cada día, y eso se descarga
// una vez por acción de Investing, Yahoo o de la propia web del mercado.
// Con las dos cosas, la cartera se valora sola todos los días.

function stkStore(){ personal.stockPrices=personal.stockPrices||{}; return personal.stockPrices; }
function stkSerie(id){ const h=stkStore()[id]; return (h&&h.serie)?h.serie:null; }

// ─── Títulos que tenías cada día, reconstruidos de tus operaciones ──
function stkOps(id){
  return transactions.filter(t=>t.stockId===id&&(t.type==='buy'||t.type==='sell'))
    .filter(t=>t.date).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
}
function stkSharesAt(id,fecha){
  let n=0;
  stkOps(id).forEach(t=>{ if(t.date<=fecha) n+=(t.type==='buy'?1:-1)*(Number(t.shares)||0); });
  return Math.max(0,n);
}
// Los tramos en que el número de títulos no cambia: entre operación y operación
function stkTramos(id){
  const ops=stkOps(id), out=[];
  let n=0;
  ops.forEach((t,i)=>{
    n+=(t.type==='buy'?1:-1)*(Number(t.shares)||0);
    const hasta=(i+1<ops.length)?ops[i+1].date:null;
    if(n>0.0000001) out.push({desde:t.date,hasta,titulos:n});
  });
  return out;
}
// ─── Precio de una acción en una fecha ──────────────────────────────
// Por orden de fiabilidad: la serie importada, el precio de tus propias
// operaciones, y por último lo que se deduce de una valoración de DEGIRO
// (importe ÷ títulos de ese día).
function stkPrecioFuentes(id){
  const m=new Map();
  const S=stkSerie(id)||[];
  S.forEach(p=>m.set(p[0],{v:p[1],src:'serie'}));
  stkOps(id).forEach(t=>{ if(t.price>0&&!m.has(t.date))m.set(t.date,{v:Number(t.price),src:'operacion'}); });
  balanceLog.filter(b=>b.refType==='stock'&&b.refId===id&&b.date).forEach(b=>{
    if(m.has(b.date))return;
    const n=stkSharesAt(id,b.date);
    if(n>0&&b.amount>0)m.set(b.date,{v:b.amount/n,src:'degiro'});
  });
  return [...m.entries()].map(([d,o])=>({date:d,precio:o.v,src:o.src}))
    .sort((a,b)=>a.date.localeCompare(b.date));
}
// ─── Qué tengo y qué me falta, acción por acción ────────────────────
// Esta es la tabla que contesta "¿desde qué fecha necesito descargar?"
function stkCobertura(id){
  const ops=stkOps(id);
  if(!ops.length)return null;
  const s=cfg.stocks.find(x=>x.id===id)||{};
  const primera=ops[0].date;
  const tramos=stkTramos(id);
  const abierta=tramos.length&&!tramos[tramos.length-1].hasta;
  const ultima=abierta?todayISO():(tramos.length?tramos[tramos.length-1].hasta:ops[ops.length-1].date);
  const S=stkSerie(id)||[];
  const meta=stkStore()[id]||null;
  // días de mercado que necesito cubrir (aprox: días naturales entre primera y última)
  const dias=Math.max(1,Math.round((Date.parse(ultima)-Date.parse(primera))/864e5));
  const cubiertos=S.filter(p=>p[0]>=primera&&p[0]<=ultima).length;
  return {id,nombre:s.name||id,isin:s.isin||null,abierta,
    primera,ultima,dias,
    tienePrecios:S.length>0,
    desde:S.length?S[0][0]:null, hasta:S.length?S[S.length-1][0]:null,
    n:S.length, cubiertos, meta,
    faltaAntes:S.length?(S[0][0]>primera?primera:null):primera,
    faltaDespues:S.length?(S[S.length-1][0]<ultima?S[S.length-1][0]:null):ultima,
    titulosHoy:stkSharesAt(id,todayISO()),
    // qué porcentaje del periodo en que la tuviste está cubierto por precios reales
    cobertura:S.length?Math.min(1,cubiertos/(dias*5/7)):0};
}
function stkCoberturaTodas(){
  return cfg.stocks.map(s=>stkCobertura(s.id)).filter(Boolean)
    .sort((a,b)=>(b.abierta?1:0)-(a.abierta?1:0)||a.nombre.localeCompare(b.nombre));
}
// ─── La cartera valorada día a día ──────────────────────────────────
// Para cada día: Σ (títulos ese día × precio ese día). Si de alguna acción no
// hay precio ese día se arrastra el último conocido; si no hay ninguno todavía,
// esa acción no suma y el día se marca como incompleto para que no te creas
// una caída que no existió.
function stkCarteraDiaria(desde){
  const stocks=cfg.stocks.map(s=>({id:s.id,name:s.name,F:stkPrecioFuentes(s.id),T:stkTramos(s.id)}))
    .filter(x=>x.T.length);
  if(!stocks.length)return [];
  let ini=desde||null;
  stocks.forEach(x=>{ const d=x.T[0].desde; if(!ini||d<ini)ini=d; });
  const fin=todayISO();
  const out=[];
  const idx={}; stocks.forEach(x=>idx[x.id]=0);
  const ult={};
  // v115 · Un día solo cuenta como COMPLETO si el precio de cada acción abierta
  // es de ese día o de los pocos anteriores. Si se arrastra el precio de una
  // compra de hace ocho meses la curva es plana y mentirosa: se marca como
  // día "arrastrado" y no se usa para la gráfica diaria.
  const FRESCO=7;   // días naturales de margen (cubre fines de semana y festivos)
  const fech={};
  for(let t=Date.parse(ini);t<=Date.parse(fin);t+=864e5){
    const d=new Date(t).toISOString().slice(0,10);
    let total=0, conPrecio=0, sinPrecio=0, viejos=0, abiertas=0;
    stocks.forEach(x=>{
      const n=x.T.reduce((acc,tr)=>(d>=tr.desde&&(!tr.hasta||d<tr.hasta))?tr.titulos:acc,0);
      if(n<=0)return;
      abiertas++;
      while(idx[x.id]<x.F.length&&x.F[idx[x.id]].date<=d){ ult[x.id]=x.F[idx[x.id]].precio; fech[x.id]=x.F[idx[x.id]].date; idx[x.id]++; }
      const p=ult[x.id];
      if(p==null){sinPrecio++;return;}
      total+=n*p; conPrecio++;
      if((Date.parse(d)-Date.parse(fech[x.id]))/864e5>FRESCO)viejos++;
    });
    if(abiertas)out.push({date:d,val:Math.round(total*100)/100,abiertas,conPrecio,sinPrecio,viejos,
      completo:sinPrecio===0&&viejos===0});
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════
// v117 · ESCALA Y DIVISA DE LOS PRECIOS IMPORTADOS
// ════════════════════════════════════════════════════════════════════
// Investing te da el precio en la moneda del mercado donde cotiza la acción, y
// las bolsas de Londres cotizan en PENIQUES, no en libras. C&C Group aparecía a
// X cuando en realidad valía Y €: con Y títulos eso son X€ en vez
// de X€. De ahí el millón de euros del 23 de junio.
// Lo mismo, más suave, con las americanas: vienen en dólares.
//
// No hay que fiarse de adivinar por el nombre ni por el ISIN. Se compara el
// archivo contra un precio que ya conoces —lo que pagaste en una compra, o lo
// que valía en una valoración de DEGIRO— en la MISMA fecha. El cociente lo dice
// todo: 0,0115 son peniques, 0,87 son dólares, 1,00 es que está bien.

function stkRefs(id){
  const out=[];
  stkOps(id).forEach(t=>{ if(Number(t.price)>0) out.push({date:t.date,precio:Number(t.price),src:'tu '+(t.type==='buy'?'compra':'venta')}); });
  balanceLog.filter(b=>b.refType==='stock'&&b.refId===id&&b.date).forEach(b=>{
    const n=stkSharesAt(id,b.date);
    if(n>0&&b.amount>0) out.push({date:b.date,precio:b.amount/n,src:'valoración DEGIRO'});
  });
  return out.sort((a,b)=>a.date.localeCompare(b.date));
}
function stkDetectaEscala(id,serie){
  const refs=stkRefs(id);
  if(!refs.length||!serie||!serie.length)return null;
  const m=new Map(serie.map(p=>[p[0],p[1]]));
  const muestras=[];
  refs.forEach(r=>{
    let v=null,fd=null;
    for(let k=0;k<=5&&v==null;k++){                 // el archivo puede no traer ese día
      const d=isoMasDias(r.date,-k);
      if(m.has(d)){v=m.get(d);fd=d;}
    }
    if(v>0&&r.precio>0) muestras.push({fecha:r.date,fechaArch:fd,real:r.precio,arch:v,f:r.precio/v,src:r.src});
  });
  if(!muestras.length)return null;
  const fs=muestras.map(x=>x.f).sort((a,b)=>a-b);
  const med=fs.length%2?fs[(fs.length-1)/2]:(fs[fs.length/2-1]+fs[fs.length/2])/2;
  const p25=fs[Math.floor(fs.length*0.25)], p75=fs[Math.min(fs.length-1,Math.floor(fs.length*0.75))];
  // v117 · La DISPERSIÓN es lo que separa una divisa de un ruido. Un tipo de
  // cambio se mueve despacio: todas las muestras se agrupan. Si bailan un 10%
  // entre ellas no es la divisa, es que DEGIRO y el cierre de Investing no
  // coinciden — típico en valores muy ilíquidos de céntimos, donde el precio
  // de cierre y la valoración del bróker se separan un día sí y otro también.
  // Corregir ahí sería inventarse un 10%.
  const disp=med?(p75-p25)/med:0;
  const ordenado=(fs.length>=2&&disp<=0.08);
  let tipo,prop;
  if(med<=0.02||med>=50){ tipo='peniques'; prop=med; }          // ×100: no puede ser mercado
  else if(med>=0.75&&med<=0.93&&ordenado){ tipo='dolares'; prop=med; }
  else if(med>=1.07&&med<=1.35&&ordenado){ tipo='divisa'; prop=med; }
  else { tipo='ok'; prop=1; }
  return {f:med,prop,tipo,muestras,n:muestras.length,disp,p25,p75,ordenado};
}
function stkEscalaTexto(D){
  if(!D)return {titulo:'Sin referencia',
    cuerpo:'No tengo ningún precio tuyo con el que comparar este archivo, así que no puedo comprobar la escala. Revísalo a ojo.'};
  const m=D.muestras[0];
  const ev='Tu referencia: '+m.src+' del '+fmtDate(m.fecha)+' a '+fmt2(m.real)+'€.\n'+
           'El archivo dice '+fmt2(m.arch)+' ese día.'+
           (D.n>1?('\nComprobado en '+D.n+' fechas; el cociente se agrupa en '+D.f.toFixed(D.f<0.1?5:4)+
                   ' (dispersión '+(D.disp*100).toFixed(1).replace('.',',')+'%).'):'');
  if(D.tipo==='ok'){
    const lejos=Math.abs(D.f-1)>0.04;
    return {titulo:'Escala correcta',
      cuerpo:ev+(lejos
        ? ('\n\nLos precios bailan un '+Math.abs((D.f-1)*100).toFixed(0)+'% respecto a los tuyos, pero de forma '+
           'desordenada (dispersión '+(D.disp*100).toFixed(1).replace('.',',')+'%), no como un tipo de cambio. '+
           'Eso pasa en valores muy ilíquidos: el cierre de Investing y la valoración de DEGIRO no son el mismo precio. '+
           'No se toca nada: corregirlo sería inventarse una diferencia que no es de divisa.')
        : '\n\nCuadran. Se guarda tal cual.')};
  }
  if(D.tipo==='peniques'){
    const gbp=D.prop*100;
    return {titulo:'Vienen en PENIQUES',
      cuerpo:ev+'\n\nEl archivo es unas cien veces mayor: la Bolsa de Londres cotiza en peniques (GBX), no en libras.\n'+
      'El factor que cuadra es ×'+D.prop.toFixed(6)+', que es dividir entre 100 por los peniques y multiplicar por '+
      gbp.toFixed(3)+' por el cambio de la libra.\n\n'+
      'Sin corregir, esta acción sola infla la cartera en cientos de miles de euros.'};
  }
  if(D.tipo==='dolares')return {titulo:'Vienen en DÓLARES',
    cuerpo:ev+'\n\nTodas las muestras se agrupan alrededor de '+D.prop.toFixed(4)+', que es el cambio euro/dólar. '+
    'El archivo viene en dólares.'};
  return {titulo:'Vienen en otra divisa',
    cuerpo:ev+'\n\nLas muestras se agrupan alrededor de '+D.prop.toFixed(4)+', demasiado ordenadas para ser ruido de mercado: '+
    'parece un cambio de divisa.'};
}
// Aplica el factor a toda la serie. Se guarda el factor para poder verlo y
// deshacerlo: la serie original nunca se pierde del todo.
function stkAplicaFactor(serie,f){
  if(!(f>0)||Math.abs(f-1)<1e-9)return serie.slice();
  return serie.map(p=>[p[0],Math.round(p[1]*f*1e6)/1e6]);
}
// ─── Auditoría de todo lo ya importado ──────────────────────────────
// Para no tener que volver a bajar 22 archivos: se revisan las series
// guardadas, se detecta la escala de cada una y se corrigen de golpe.
function stkAuditar(){
  const out=[];
  Object.keys(stkStore()).forEach(id=>{
    const h=stkStore()[id]; if(!h||!h.serie)return;
    const s=cfg.stocks.find(x=>x.id===id)||{};
    const D=stkDetectaEscala(id,h.serie);
    out.push({id,nombre:s.name||id,n:h.serie.length,D,
      yaCorregida:!!(h.factor&&Math.abs(h.factor-1)>1e-9)});
  });
  return out.sort((a,b)=>{
    const r=x=>x.D?({raro:0,peniques:1,divisa:2,dolares:3,ok:5}[x.D.tipo]??4):4;
    return r(a)-r(b)||a.nombre.localeCompare(b.nombre);
  });
}
function stkCorregirTodas(){
  const A=stkAuditar().filter(x=>x.D&&x.D.tipo!=='ok');
  if(!A.length){toast('Todas las series están en euros y a la escala correcta');return;}
  const lista=A.map(x=>{
    const t=x.D.tipo==='peniques'?'peniques':(x.D.tipo==='dolares'?'dólares':(x.D.tipo==='raro'?'NO CUADRA':'otra divisa'));
    const m=x.D.muestras[0];
    return '· '+x.nombre+' — '+t+' · ×'+x.D.prop.toFixed(x.D.tipo==='peniques'?6:4)+
      '\n    el '+fmtDate(m.fecha)+' el archivo dice '+fmt2(m.arch)+' y tú tenías '+fmt2(m.real)+'€';
  }).join('\n');
  const raras=A.filter(x=>x.D.tipo==='raro');
  if(!confirm('Voy a corregir la escala de '+A.length+' serie(s):\n\n'+lista+
    (raras.length?('\n\n⚠ '+raras.length+' no corresponden a ninguna divisa conocida. Revísalas después.'):'')+
    '\n\nLos precios se multiplican por su factor. Se guarda cuál se ha aplicado, y se puede deshacer.\n\n¿Corregir?'))return;
  if(!guardedAction('corregir la escala de '+A.length+' series de precios'))return;
  A.forEach(x=>{
    const h=stkStore()[x.id];
    h.serie=stkAplicaFactor(h.serie,x.D.prop);
    h.factor=(Number(h.factor)||1)*x.D.prop;
    h.moneda=x.D.tipo;
    h.n=h.serie.length; h.desde=h.serie[0][0]; h.hasta=h.serie[h.serie.length-1][0];
  });
  save(); renderPrecios(); try{renderAnalisisEvolution();}catch(e){fallo('renderAnalisisEvolution',e)}
  toast('✅ '+A.length+' series corregidas');
}
// Red de seguridad: si un día de la serie diaria se dispara respecto a la
// última valoración real de DEGIRO, algo está mal y hay que avisar, no pintarlo.
function stkDiasAbsurdos(serie){
  const refs=[];
  const fechas=[...new Set(balanceLog.filter(b=>b.refType==='stock'&&b.date).map(b=>b.date))].sort();
  fechas.forEach(d=>{
    let t=0;
    cfg.stocks.forEach(s=>{const es=balanceLog.filter(b=>b.refType==='stock'&&b.refId===s.id&&b.date<=d)
      .sort((a,b)=>a.date.localeCompare(b.date)); if(es.length)t+=es[es.length-1].amount||0;});
    if(t>0)refs.push(t);
  });
  if(!refs.length)return [];
  const max=Math.max(...refs);
  return serie.filter(x=>x.val>max*4);
}

// ════════════════════════════════════════════════════════════════════
// v120 · IMPORTAR EL CSV DE TRANSACCIONES DE DEGIRO
// ════════════════════════════════════════════════════════════════════
// Hasta ahora la app leía el Portfolio de DEGIRO, que dice cuánto vale cada
// posición pero no cómo llegaste a ella. Las compras había que teclearlas, y
// teclear 60 operaciones sale mal: en una acción faltaban dos ejecuciones
// (los títulos y el precio) y por eso el resultado no cuadraba con el bróker.
//
// Este CSV lo trae todo y, lo mejor, YA CONVERTIDO A EUROS: la columna
// "Valor EUR" resuelve de un plumazo el lío de los peniques y los dólares.
// Además el "ID Orden" agrupa las ejecuciones parciales de una misma orden.
//
// Columnas (DEGIRO deja sin nombre las dos de divisa, así que se localizan por
// nombre las que lo tienen y por posición las que no):
//   Fecha, Hora, Producto, ISIN, Bolsa, Centro, Número, Precio, <moneda>,
//   Valor local, <moneda>, Valor EUR, Tipo de cambio, Comisión AutoFX,
//   Costes de transacción, Total EUR, ID Orden
// v169 · Aquí había una segunda dgNum que devolvía 0 en vez de «no es un
// número» y leía «1,234.56» como 1,23. Por ser la última, mandaba en todo el
// archivo y desarmaba a degiroParse (posiciones de 0 € en los CSV sin
// cabecera). Ahora hay una sola, la de arriba, que distingue los dos formatos.
function dgFecha(s){
  const m=String(s||'').trim().match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if(m)return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
  const i=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return i?i[0]:null;
}
// Los nombres de DEGIRO no son los tuyos: "BELLRING BRANDS, INC." contra
// "Bellring Brands Inc". Se quitan las formas societarias y la puntuación.
function dgNorm(s){
  return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'')   // fuera acentos
    .toUpperCase()
    .replace(/[.,'"()&]/g,' ')
    .replace(/\b(S\s*A|N\s*V|PLC|INC|AG|LTD|SE|SA|NV|CORP|CORPORATION|HOLDINGS?|GROUP|CLASS\s+[A-Z]|COMPANY|CO)\b/g,' ')
    .replace(/\s+/g,' ').trim();
}
// Los nombres que tú tecleaste no siempre son los del bróker: «Pernord Ricard»
// contra «PERNOD RICARD», «Dassault Systèmes» con acento contra sin él. Una
// distancia de edición pequeña sobre nombres largos es un error de tecleo, no
// dos empresas distintas — y crear una acción duplicada sería mucho peor.
function dgDist(a,b){
  if(a===b)return 0;
  const m=a.length,n=b.length;
  if(!m||!n)return Math.max(m,n);
  let prev=Array.from({length:n+1},(_,j)=>j), cur=new Array(n+1);
  for(let i=1;i<=m;i++){
    cur[0]=i;
    for(let j=1;j<=n;j++){
      cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
    }
    [prev,cur]=[cur,prev];
  }
  return prev[n];
}
function dgTxParse(text){
  const lineas=String(text).replace(/\r/g,'').split('\n').filter(l=>l.trim());
  if(!lineas.length)return {err:'El archivo está vacío.'};
  const delim=(lineas[0].split(';').length>lineas[0].split(',').length)?';':',';
  const filas=lineas.map(l=>parseCsvLineD(l,delim));
  const h=filas[0].map(c=>String(c||'').trim().toLowerCase());
  const col=re=>h.findIndex(c=>re.test(c));
  const iFecha=col(/^fecha/), iProd=col(/^producto/), iIsin=col(/^isin/),
        iNum=col(/^n[úu]mero/), iPrec=col(/^precio/),
        iValEur=col(/^valor\s*eur/), iAutoFx=col(/comisi[óo]n\s*autofx/),
        iCostes=col(/^costes\s*de\s*transacci/), iTotal=col(/^total\s*eur/), iOrden=col(/^id\s*orden/);
  if(iFecha<0||iProd<0||iNum<0||iValEur<0)
    return {err:'No reconozco este archivo. Tiene que ser el CSV de Transacciones de DEGIRO, con columnas «Producto», «Número» y «Valor EUR».'};
  const ops=[];
  for(let i=1;i<filas.length;i++){
    const r=filas[i]; if(!r||r.length<4)continue;
    const f=dgFecha(r[iFecha]); if(!f)continue;
    const n=dgNum(r[iNum]); if(!n)continue;
    const valEUR=Math.abs(dgNum(r[iValEur]));
    const costes=Math.abs(iCostes>=0?dgNum(r[iCostes]):0)+Math.abs(iAutoFx>=0?dgNum(r[iAutoFx]):0);
    ops.push({date:f, prod:String(r[iProd]||'').trim(), isin:String(r[iIsin]||'').trim().toUpperCase(),
      n:Math.abs(n), tipo:n>0?'buy':'sell',
      precioLocal:iPrec>=0?(dgNum(r[iPrec])||0):0,
      valEUR, costes, total:Math.abs(iTotal>=0?dgNum(r[iTotal]):valEUR),
      orden:iOrden>=0?String(r[iOrden]||'').trim():'',
      precio:valEUR/Math.abs(n)});          // precio POR TÍTULO en euros, ya convertido
  }
  if(!ops.length)return {err:'No he encontrado ninguna operación con fecha e importe.'};
  ops.sort((a,b)=>a.date.localeCompare(b.date)||a.orden.localeCompare(b.orden));
  return {ops};
}
// Empareja cada producto del CSV con una acción tuya: primero por ISIN (que no
// se equivoca), después por nombre normalizado.
function dgEmpareja(ops){
  const porProd={};
  ops.forEach(o=>{(porProd[o.prod]=porProd[o.prod]||{prod:o.prod,isin:o.isin,ops:[]}).ops.push(o);});
  Object.values(porProd).forEach(p=>{
    let s=p.isin?cfg.stocks.find(x=>String(x.isin||'').toUpperCase()===p.isin):null;
    if(!s){
      const nn=dgNorm(p.prod);
      s=cfg.stocks.find(x=>dgNorm(x.name)===nn)
        ||cfg.stocks.find(x=>{const a=dgNorm(x.name);return a&&nn&&a.length>3&&nn.length>3&&(a.startsWith(nn)||nn.startsWith(a));});
      if(!s&&nn.length>=6){
        // por parecido, sólo si el nombre es largo y la diferencia mínima
        let mejor=null,md=99;
        cfg.stocks.forEach(x=>{
          const a=dgNorm(x.name); if(!a||a.length<6)return;
          if(!mismaClase(x.name,p.prod))return;     // clases distintas: no son la misma acción
          const d=dgDist(a,nn);
          if(d<md){md=d;mejor=x;}
        });
        const umbral=Math.max(2,Math.floor(nn.length*0.15));
        if(mejor&&md<=umbral){s=mejor;p.porParecido=dgNorm(mejor.name)+' ≈ '+nn+' ('+md+')';}
      }
    }
    p.stock=s||null;
    p.nueva=!s;
  });
  return Object.values(porProd);
}
// Qué cambiaría: títulos y coste, lo que hay ahora contra lo que dice el CSV.
function dgDiff(ops){
  const P=dgEmpareja(ops);
  return P.map(p=>{
    const titCsv=p.ops.reduce((s,o)=>s+(o.tipo==='buy'?1:-1)*o.n,0);
    const compras=p.ops.filter(o=>o.tipo==='buy');
    const costeCsv=compras.reduce((s,o)=>s+o.valEUR+o.costes,0);
    let titApp=0,costeApp=0,opsApp=0;
    if(p.stock){
      transactions.filter(t=>t.stockId===p.stock.id&&(t.type==='buy'||t.type==='sell')).forEach(t=>{
        opsApp++;
        titApp+=(t.type==='buy'?1:-1)*(Number(t.shares)||0);
        if(t.type==='buy')costeApp+=(Number(t.total)||0)+(Number(t.costs)||0);
      });
    }
    const difTit=titCsv-titApp, difCoste=costeCsv-costeApp;
    return {...p,titCsv,costeCsv,titApp,costeApp,opsApp,opsCsv:p.ops.length,
      difTit,difCoste,cambia:(Math.abs(difTit)>0.5||Math.abs(difCoste)>0.05||p.ops.length!==opsApp)};
  }).sort((a,b)=>Math.abs(b.difCoste)-Math.abs(a.difCoste));
}

// ════════════════════════════════════════════════════════════════════
// v169 · EL ESTADO DE CUENTA DE DEGIRO (Account.csv)
// ════════════════════════════════════════════════════════════════════
// Trae, día a día, todo lo que pasa por la liquidez de DEGIRO: ingresos,
// retiradas, compras, comisiones, cambios de divisa... y los dividendos con
// su retención. Si lo subías como extracto del banco, sus compras y
// comisiones entraban como gastos tuyos. Ahora se reconoce, y de él salen los
// dividendos (con lo que retuvo el país de la empresa) y, si quieres, los
// ingresos y retiradas de dinero que todavía no tengas apuntados.
function dgcEs(text){
  const cab=String(text||'').replace(/^\uFEFF/,'').split(/\r?\n/,1)[0].toLowerCase();
  return /(fecha valor|value date)/.test(cab)&&/(id orden|order id)/.test(cab)&&/(descripci|description)/.test(cab);
}
function degiroCuentaParse(text){
  const t=String(text||'').replace(/^\uFEFF/,'');
  if(!dgcEs(t))return {err:'No es el estado de cuenta de DEGIRO.'};
  const lines=t.split(/\r?\n/).filter(l=>l.trim());
  const sep=(lines[0].split(';').length>lines[0].split(',').length)?';':',';
  const cut=l=>{const o=[];let c='',q=false;
    for(let i=0;i<l.length;i++){const ch=l[i];
      if(ch==='"'){ if(q&&l[i+1]==='"'){c+='"';i++;} else q=!q; }
      else if(ch===sep&&!q){o.push(c);c='';}
      else c+=ch;}
    o.push(c);return o.map(x=>x.trim());};
  const H=cut(lines[0]).map(h=>h.toLowerCase());
  const col=re=>H.findIndex(h=>re.test(h));
  const iF=col(/^fecha$|^date$/), iH=col(/^hora$|^time$/), iP=col(/^producto$|^product$/), iI=col(/^isin$/),
        iD=col(/descripci|description/), iX=col(/^tipo$|^fx$/), iV=col(/variaci|^change$/);
  if(iF<0||iD<0||iV<0)return {err:'Al estado de cuenta le faltan columnas (fecha, descripción o variación).'};
  const fecha=s=>{const m=String(s||'').match(/^(\d{2})[-\/.](\d{2})[-\/.](\d{4})/); return m?m[3]+'-'+m[2]+'-'+m[1]:null;};
  const F=[];
  lines.slice(1).forEach(l=>{
    const r=cut(l), f=fecha(r[iF]); if(!f)return;
    const div=String(r[iV]||'').trim().toUpperCase(), imp=dgNum(r[iV+1]);
    if(imp==null)return;
    F.push({fecha:f,hora:iH>=0?String(r[iH]||''):'',prod:iP>=0?String(r[iP]||'').trim():'',
      isin:iI>=0?String(r[iI]||'').trim().toUpperCase():'',desc:String(r[iD]||'').trim(),
      fx:iX>=0?dgNum(r[iX]):null,div:/^[A-Z]{3}$/.test(div)?div:'EUR',imp});
  });
  if(!F.length)return {err:'No he encontrado ningún movimiento en el estado de cuenta.'};
  const esFX=d=>/cambio de divisa|currency exchange|fx (?:credit|debit)/i.test(d);
  const esDiv=d=>/^(dividendo|dividend)$/i.test(d);
  const esRetDiv=d=>/retenci[oó]n del dividendo|dividend tax|impuesto sobre (el )?dividendo/i.test(d);
  const esInt=d=>/^(inter[eé]s|interest)\b/i.test(d)&&!/negativ|deudor|debit|margin|margen|d[eé]bito/i.test(d);
  const interno=d=>/cuenta de efectivo|cash account|sweep|money market|fondo monetario/i.test(d);
  const esIngreso=d=>/^(ingreso|dep[oó]sito|deposit|flatex deposit|ideal deposit|sofort deposit)\b/i.test(d);
  const esRetirada=d=>/^(retirada|withdrawal|reembolso|processed flatex withdrawal|flatex withdrawal)\b/i.test(d);
  const r2=v=>Math.round(v*100)/100;
  const fxs=F.filter(f=>esFX(f.desc));
  // a euros: la conversión automática de DEGIRO deja una «Retirada Cambio de
  // Divisa» por lo cobrado en la divisa y, a la misma hora, su «Ingreso» en euros
  const aEur=g=>{
    if(g.div==='EUR')return 1;
    const neto=g.bruto-g.ret;
    const c=fxs.filter(f=>f.div===g.div&&f.imp<0&&Math.abs(-f.imp-neto)<=Math.max(0.02,neto*0.002)&&
      f.fecha>=g.fecha&&isoDias(g.fecha,f.fecha)<=7).sort((a,b)=>a.fecha.localeCompare(b.fecha))[0];
    if(c){
      const e=fxs.find(f=>f.div==='EUR'&&f.imp>0&&f.fecha===c.fecha&&f.hora===c.hora);
      if(e&&neto>0)return e.imp/neto;
      if(c.fx>0)return 1/c.fx;
      if(e&&e.fx>0)return 1/e.fx;
    }
    return null;
  };
  const G=new Map(), rentas=[], flujos=[], sinCambio=[];
  F.forEach(f=>{
    if(esFX(f.desc))return;
    if(esDiv(f.desc)||esRetDiv(f.desc)){
      const k=f.fecha+'|'+(f.isin||f.prod)+'|'+f.div;
      const g=G.get(k)||{fecha:f.fecha,isin:f.isin,nombre:f.prod,div:f.div,bruto:0,ret:0};
      if(esDiv(f.desc))g.bruto+=f.imp; else g.ret+=-f.imp;
      G.set(k,g); return;
    }
    if(f.div!=='EUR'||interno(f.desc))return;
    if(esInt(f.desc)&&f.imp>0){
      rentas.push({cat:'rend',fecha:f.fecha,bruto:r2(f.imp),ret:0,retExt:0,neto:r2(f.imp),isin:'',tick:'',nombre:'',
        desc:'Intereses DEGIRO',ext:'dgc:'+f.fecha+':int:'+Math.round(f.imp*100)});
    } else if(esIngreso(f.desc)&&f.imp>0){
      flujos.push({fecha:f.fecha,type:'aporta',amount:r2(f.imp),ext:'dgc:'+f.fecha+':aporta:'+Math.round(f.imp*100)});
    } else if(esRetirada(f.desc)&&f.imp<0){
      flujos.push({fecha:f.fecha,type:'retira',amount:r2(-f.imp),ext:'dgc:'+f.fecha+':retira:'+Math.round(-f.imp*100)});
    }
  });
  G.forEach(g=>{
    if(!(g.bruto>0))return;
    const k=aEur(g);
    if(k==null){ sinCambio.push({fecha:g.fecha,nombre:g.nombre||g.isin,div:g.div,bruto:r2(g.bruto)}); return; }
    // la retención del país de la empresa; si la empresa es española, es retención española
    const esp=/^ES/.test(g.isin), bruto=r2(g.bruto*k), ret=r2(Math.max(0,g.ret)*k);
    rentas.push({cat:'dividendo',fecha:g.fecha,bruto,ret:esp?ret:0,retExt:esp?0:ret,neto:r2(bruto-ret),
      isin:g.isin,tick:'',nombre:g.nombre,desc:('Dividendo '+(g.nombre||g.isin)).slice(0,60),
      div:g.div,ext:'dgc:'+g.fecha+':'+(g.isin||g.nombre)+':'+Math.round(g.bruto*100)});
  });
  rentas.sort((a,b)=>a.fecha.localeCompare(b.fecha)); flujos.sort((a,b)=>a.fecha.localeCompare(b.fecha));
  const fs=F.map(f=>f.fecha).sort();
  return {fuente:'degiro_cuenta',rentas,flujos,sinCambio,n:F.length,desde:fs[0],hasta:fs[fs.length-1]};
}
function dgcBroker(){ return (cfg.brokers||[]).find(b=>/degiro/i.test(String(b.name||'')))||null; }
// lo que falta por apuntar: ni con la misma clave ni ya puesto a mano
function dgcNuevos(P,bk){
  const BF=(typeof brokerFlows!=='undefined')?brokerFlows:[];
  const ren=(P.rentas||[]).filter(x=>!incomeLog.some(e=>(e.ext&&e.ext===x.ext)||
    (!e.ext&&e.cat===x.cat&&Math.abs((Number(e.amt)||0)-x.neto)<0.015&&e.date&&Math.abs(isoDias(e.date,x.fecha))<=3)));
  const flu=(P.flujos||[]).filter(x=>!BF.some(f=>f.ext===x.ext||
    (bk&&f.brokerId===bk.id&&f.type===x.type&&Math.abs((Number(f.amount)||0)-x.amount)<0.01&&f.date&&Math.abs(isoDias(f.date,x.fecha))<=4)));
  return {ren,flu};
}
function dgcAplicar(P,o){
  o=o||{}; const bk=dgcBroker(), N=dgcNuevos(P,bk);
  const r=(o.divs===false)?{n:0,bruto:0}:rentasAplicar(N.ren,'degiro');
  let flujos=0;
  if(o.flujos&&bk){
    if(typeof brokerFlows==='undefined')brokerFlows=[];
    N.flu.forEach((x,k)=>{ brokerFlows.push({id:'bf_d'+Date.now()+'_'+k,date:x.fecha,brokerId:bk.id,
      type:x.type,amount:x.amount,ext:x.ext}); flujos++; });
  }
  return {rentas:r.n,bruto:r.bruto||0,flujos};
}
let _dgcPending=null;
function dgcStart(text,fname){
  const P=degiroCuentaParse(text);
  if(P.err){alert('No pude leer el estado de cuenta.\n\n'+P.err);return;}
  P.fname=fname||'Account.csv'; _dgcPending=P; dgcPreview();
}
function dgcPreview(){
  const P=_dgcPending; if(!P)return;
  const bk=dgcBroker(), N=dgcNuevos(P,bk);
  let h='<div style="font-size:11.5px;color:var(--muted);margin-bottom:.55rem;line-height:1.45">'+escapeHtml(P.fname)+' · '+
    P.n+' movimientos del '+fmtDate(P.desde)+' al '+fmtDate(P.hasta)+'. Es el <strong>estado de cuenta de DEGIRO</strong>: '+
    'no se lee como extracto del banco, porque sus compras, comisiones y cambios de divisa no son gastos tuyos.</div>';
  const tabla=(cab,filas)=>'<div class="tbl-scroll" style="max-height:160px;overflow:auto"><table class="detail-table" style="font-size:11px">'+
    '<thead><tr>'+cab.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+filas.join('')+'</tbody></table></div>';
  h+='<div style="border:1px solid var(--border);border-radius:6px;padding:.55rem .6rem;margin-bottom:.6rem">';
  if(N.ren.length){
    h+='<div style="font-size:11.5px;font-weight:600;margin-bottom:.3rem">Dividendos e intereses nuevos ('+N.ren.length+')</div>'+
      tabla(['Fecha','De','Bruto','Retenido','Cobrado'],N.ren.map(x=>'<tr><td>'+fmtDate(x.fecha)+'</td><td>'+escapeHtml(x.nombre||x.desc).slice(0,26)+'</td>'+
        '<td>'+fmt2(x.bruto)+'€</td><td>'+fmt2(x.ret+x.retExt)+'€</td><td>'+fmt2(x.neto)+'€</td></tr>'))+
      '<label style="display:block;font-size:11px;margin-top:.4rem"><input type="checkbox" id="dgc-divs" checked> '+
      'Registrarlos como ingresos, con su retención <span style="color:var(--faint)">(cuentan en la previsión de la renta)</span></label>';
  } else {
    h+='<div style="font-size:11.5px">'+(P.rentas.length?'Los '+P.rentas.length+' dividendos e intereses del archivo ya los tenías.':'En estas fechas no hay dividendos ni intereses.')+'</div>';
  }
  if(P.sinCambio.length)h+='<div style="font-size:10.5px;color:var(--amber);margin-top:.35rem">'+P.sinCambio.length+
    ' dividendo(s) en otra divisa sin su cambio a euros en el archivo ('+P.sinCambio.map(x=>escapeHtml(x.nombre)+' '+fmt2(x.bruto)+' '+x.div).join(', ')+
    '): no se registran. Apúntalos a mano en euros.</div>';
  h+='</div>';
  if(N.flu.length){
    h+='<div style="border:1px solid var(--border);border-radius:6px;padding:.55rem .6rem;margin-bottom:.6rem">'+
      '<div style="font-size:11.5px;font-weight:600;margin-bottom:.3rem">Ingresos y retiradas de dinero que no tienes apuntados ('+N.flu.length+')</div>'+
      tabla(['Fecha','Movimiento','Importe'],N.flu.map(x=>'<tr><td>'+fmtDate(x.fecha)+'</td><td>'+(x.type==='aporta'?'Ingreso':'Retirada')+'</td><td>'+fmt2(x.amount)+'€</td></tr>'))+
      (bk?'<label style="display:block;font-size:11px;margin-top:.4rem"><input type="checkbox" id="dgc-flows"> '+
          'Registrarlos como aportaciones a '+escapeHtml(bk.name)+' <span style="color:var(--faint)">(los que ya tenías, aunque sea con un par de días de diferencia, no se repiten)</span></label>'
        :'<div style="font-size:10.5px;color:var(--muted);margin-top:.35rem">No tienes ningún bróker llamado DEGIRO: créalo en Datos entrada para poder apuntarlos.</div>')+
      '</div>';
  }
  const hay=N.ren.length||(N.flu.length&&bk);
  h+='<div style="display:flex;gap:.5rem;justify-content:flex-end;flex-wrap:wrap">'+
    '<button class="btn-sm" onclick="_dgcPending=null;document.getElementById(\'dlv-modal\').remove()" style="font-size:12px">'+(hay?'Cancelar':'Cerrar')+'</button>'+
    (hay?'<button class="btn-sm" onclick="dgcCommit()" style="font-size:12px;background:var(--navy);color:#fff;border-color:var(--navy)">Aplicar</button>':'')+'</div>';
  showModalWide('📥 Estado de cuenta de DEGIRO',h);
}
function dgcCommit(){
  const P=_dgcPending; if(!P)return;
  const divs=!!document.getElementById('dgc-divs')?.checked, flu=!!document.getElementById('dgc-flows')?.checked;
  if(!divs&&!flu){toast('No has marcado nada');return;}
  if(!guardedAction('importar el estado de cuenta de DEGIRO'))return;
  const R=dgcAplicar(P,{divs,flujos:flu});
  _dgcPending=null; save(); renderAll();
  document.getElementById('dlv-modal')?.remove();
  toast('✅ '+R.rentas+' dividendo(s) o interés(es)'+(R.flujos?' · '+R.flujos+' movimiento(s) de dinero':'')+' · puedes deshacerlo');
}

// v169 · Archivos de bolsa o de fondos que llegan por «Importar extracto del
// banco»: se reconocen por dentro y van a su sitio en vez de convertirse en
// ingresos y gastos. Devuelve qué era, o null si es de un banco de verdad.
function archivoNoBanco(txt,buf,fname,mtime){
  if(dgcEs(txt)){ dgcStart(txt,fname); return 'el estado de cuenta de DEGIRO'; }
  const cab=String(txt||'').slice(0,400).toLowerCase();
  if(/producto|product/.test(cab)&&/(symbol\/isin|valor en eur|value in eur)/.test(cab)){ brokerFile(buf,fname,mtime); return 'la cartera de DEGIRO'; }
  if(navEsCSV(txt)){
    const P=navParseCSV(txt);
    if(!P.err){ _navPending={serie:P.serie,fname:fname||'histórico'}; navShowPreview(); return 'un histórico de valor liquidativo'; }
  }
  const T=dgTxParse(txt);
  if(T&&!T.err&&T.ops&&T.ops.length){ _dgPend=T.ops; dgTxRevisar(); return 'las operaciones de DEGIRO'; }
  return null;
}

let _dgPend=null;
function dgTxFile(ev){
  const f=(ev.target.files||[])[0]; ev.target.value='';
  if(!f)return;
  const r=new FileReader();
  r.onload=e=>{
    const P=dgTxParse(e.target.result);
    if(P.err){alert(P.err);return;}
    _dgPend=P.ops;
    dgTxRevisar();
  };
  r.readAsText(f,'utf-8');
}
function dgTxRevisar(){
  if(!_dgPend)return;
  const D=dgDiff(_dgPend);
  const cambian=D.filter(x=>x.cambia);
  const fechas=_dgPend.map(o=>o.date).sort();
  let msg='He leído '+_dgPend.length+' operaciones de '+D.length+' acciones, del '+
    fmtDate(fechas[0])+' al '+fmtDate(fechas[fechas.length-1])+'.\n\n';
  if(!cambian.length){
    msg+='Todo coincide con lo que ya tienes. No hay nada que cambiar.';
    alert(msg); _dgPend=null; return;
  }
  msg+='Cambiaría '+cambian.length+' acción(es):\n\n';
  msg+=cambian.slice(0,14).map(x=>{
    const l='· '+x.prod+(x.nueva?'  ← ACCIÓN NUEVA':(x.porParecido?('  → la emparejo con tu «'+x.stock.name+'»'):''));
    const t=(Math.abs(x.difTit)>0.5)?('\n    títulos: '+fmt(x.titApp)+' → '+fmt(x.titCsv)):'';
    const c=(Math.abs(x.difCoste)>0.05)?('\n    coste: '+fmt2(x.costeApp)+'€ → '+fmt2(x.costeCsv)+'€'):'';
    const o=(x.opsCsv!==x.opsApp)?('\n    operaciones: '+x.opsApp+' → '+x.opsCsv):'';
    return l+t+c+o;
  }).join('\n');
  if(cambian.length>14)msg+='\n· …y '+(cambian.length-14)+' más';
  msg+='\n\nEl CSV manda: se sustituyen tus operaciones de esas acciones por las suyas.\n'+
       'Los precios vienen ya en euros del propio DEGIRO, así que no hay que convertir nada.\n\n'+
       '¿Aplicar? (se puede deshacer)';
  if(!confirm(msg))return;
  dgTxAplicar(cambian);
}
// v145 · Antes esto borraba TODAS las compras y ventas de cada acción del
// archivo y las rehacía desde el CSV, con el argumento de que «el CSV es la
// verdad». Con un solo bróker colaba. Con dos no: una acción que tengas
// también en XTB perdía sus operaciones de XTB sin decir nada, porque el CSV
// de DEGIRO no las menciona. Ahora se añade lo que falta y no se borra nada;
// lo que el archivo no trae se cuenta y se te dice, pero se queda donde está.
function dgTxAplicar(cambian){
  if(!guardedAction('importar '+_dgPend.length+' operaciones de DEGIRO'))return;
  let nuevasAcc=0, creadas=0, yaEstaban=0, ajenas=0;
  cambian.forEach(p=>{
    let s=p.stock;
    if(!s){
      s={id:'stk_'+Date.now()+'_'+Math.floor(Math.random()*1e4),
         name:dgTitulo(p.prod), existing:false, idea:'', isin:p.isin||null};
      cfg.stocks.push(s); nuevasAcc++;
    }else if(!s.isin&&p.isin){ s.isin=p.isin; }
    const ops=p.ops.slice().sort((a,b)=>a.date.localeCompare(b.date));
    const ordenes=new Set(ops.map(o=>o.orden));
    // v149 · Una orden de DEGIRO puede ejecutarse en varios trozos, y todos
    // llevan el MISMO número de orden: los títulos de una compra pueden ser dos
    // ejecuciones iguales. Emparejar solo por número de orden se comía la
    // segunda y te dejaba con la mitad de los títulos. Cada apunte que ya
    // tienes solo puede emparejarse con UNA operación del archivo.
    const usados=new Set();
    ops.forEach((o,i)=>{
      const rep=transactions.find(t=>!usados.has(t.id)&&t.stockId===s.id&&(
        (o.orden&&t.orden===o.orden&&t.type===o.tipo&&t.date===o.date&&Math.abs((t.shares||0)-o.n)<0.001) ||
        (o.orden&&t.orden===o.orden&&!(t.shares>0)) ||
        (t.type===o.tipo&&t.date===o.date&&Math.abs((t.shares||0)-o.n)<0.001)));
      if(rep){
        usados.add(rep.id);
        if(!rep.orden&&o.orden)rep.orden=o.orden;     // queda identificada para la próxima
        yaEstaban++; return;
      }
      transactions.push({id:'tx_dg_'+String(o.orden||'').slice(0,8)+'_'+i+'_'+Date.now().toString(36),
        stockId:s.id, stockName:s.name, name:s.name, type:o.tipo, date:o.date,
        shares:o.n, price:Math.round(o.precio*1e6)/1e6,
        costs:Math.round(o.costes*100)/100,
        total:Math.round(o.valEUR*100)/100,
        year:parseInt(String(o.date).slice(0,4)),
        orden:o.orden, src:'degiro_tx'});
      creadas++;
    });
    // operaciones que ya tienes de esta acción y que el archivo no menciona:
    // o son de otro bróker o las anotaste a mano. Ni se tocan ni se cuentan
    // como error, pero conviene saber cuántas son. Se cuentan DESPUÉS de
    // emparejar, para no contar como ajena una que sí estaba en el archivo.
    ajenas+=transactions.filter(t=>t.stockId===s.id&&(t.type==='buy'||t.type==='sell')
              &&!(t.orden&&ordenes.has(t.orden))).length;
    // el archivo solo puede cerrar una posición si no queda nada de ella en
    // ningún otro sitio; con dos brókers eso hay que mirarlo, no suponerlo
    if(Math.abs(p.titCsv)<0.5){
      const tit=transactions.filter(t=>t.stockId===s.id)
        .reduce((a,t)=>a+(t.type==='buy'?(t.shares||0):t.type==='sell'?-(t.shares||0):0),0);
      if(Math.abs(tit)<0.5)soldStocks.add(s.id);
    } else soldStocks.delete(s.id);
  });
  // el FIFO se rehace sobre TODAS las operaciones de cada acción, vengan del
  // bróker que vengan: si no, el coste de adquisición saldría cojo
  try{recomputeAllStockGains();}catch(e){console.warn('fifo',e);}
  _dgPend=null;
  save();
  try{renderFormLists();}catch(e){fallo('renderFormLists',e)}
  renderAll();
  try{renderAnalisis();}catch(e){fallo('renderAnalisis',e)}
  try{renderPrecios();}catch(e){fallo('renderPrecios',e)}
  alert('✅ Listo.\n\n· '+creadas+' operaciones nuevas registradas'+
    (yaEstaban?('\n· '+yaEstaban+' ya las tenías (no se duplican)'):'')+
    (nuevasAcc?('\n· '+nuevasAcc+' acción(es) nuevas creadas'):'')+
    (ajenas?('\n· '+ajenas+' operaciones tuyas que este archivo no menciona: se quedan como están '+
             '(si tienes esa acción también en XTB, es lo normal)'):'')+
    '\n\nRevisa el cuadre de posiciones en Análisis.');
}
// "EMPRESA EJEMPLO SA" en mayúsculas queda feo en las tablas
function dgTitulo(s){
  return String(s||'').toLowerCase().replace(/\b([a-záéíóúñ])/g,(m,c)=>c.toUpperCase())
    .replace(/\b(Sa|Sas|Nv|Plc|Inc|Ag|Se|Ltd|Spa|Asa|Oyj|Ab)\b/g,m=>m.toUpperCase())
    .replace(/\s+/g,' ').trim();
}

// ─── Importar un CSV de precios ─────────────────────────────────────
// Mismo lector que el de los VL de los fondos: aguanta el formato de Investing
// (Fecha / Último, coma decimal) y el de Yahoo (Date / Close, punto decimal).
function stkParseCSV(text){
  const r=navParseCSV(text);
  if(r.err)return r;
  return r;
}
// Adivina de qué acción es el archivo comparando el último precio con el que se
// deduce de tu última valoración de DEGIRO. Es difícil equivocarse: los precios
// de tus nueve acciones no se parecen entre sí.
function stkGuess(serie){
  const fin=serie[serie.length-1][1];
  return cfg.stocks.map(s=>{
    const F=stkPrecioFuentes(s.id);
    if(!F.length)return null;
    const mio=F[F.length-1].precio;
    if(!(mio>0))return null;
    return {id:s.id,name:s.name,mio,dif:Math.abs(mio-fin)/mio};
  }).filter(Boolean).sort((a,b)=>a.dif-b.dif);
}

let _stkPending=null;
function stkImportFile(ev){
  const f=(ev.target.files||[])[0]; ev.target.value='';
  if(!f)return;
  const r=new FileReader();
  r.onload=e=>{
    const p=stkParseCSV(e.target.result);
    if(p.err){toast(p.err);return;}
    const cands=stkGuess(p.serie);
    const nombre=f.name.replace(/\.(csv|txt)$/i,'');
    // Si el nombre del archivo lleva el nombre o el ISIN de una acción, gana eso
    const porNombre=cfg.stocks.find(s=>{
      const n=String(s.name||'').toLowerCase().split(/[\s.]+/)[0];
      return n.length>2&&nombre.toLowerCase().includes(n);
    })||cfg.stocks.find(s=>s.isin&&nombre.toUpperCase().includes(s.isin));
    _stkPending={serie:p.serie,archivo:f.name};
    const lista=cfg.stocks.map((s,i)=>{
      const c=cands.find(x=>x.id===s.id);
      return '  '+(i+1)+') '+s.name+(c?'  → tu último precio '+fmt2(c.mio)+'€':'');
    }).join('\n');
    const sug=porNombre?cfg.stocks.findIndex(s=>s.id===porNombre.id)
                       :(cands.length?cfg.stocks.findIndex(s=>s.id===cands[0].id):0);
    const s0=p.serie[0], s1=p.serie[p.serie.length-1];
    const res=prompt('He leído '+p.serie.length+' precios, de '+fmtDate(s0[0])+' a '+fmtDate(s1[0])+
      '.\nÚltimo precio del archivo: '+fmt2(s1[1])+'€\n\n¿De qué acción son? Escribe el número.\n\n'+lista,
      String(sug+1));
    if(res==null){_stkPending=null;return;}
    const n=parseInt(String(res).trim(),10);
    if(!(n>=1&&n<=cfg.stocks.length)){toast('Número no válido');_stkPending=null;return;}
    stkGuardar(cfg.stocks[n-1].id,f.name);
  };
  r.readAsText(f);
}
function stkGuardar(id,archivo){
  if(!_stkPending)return;
  const s=cfg.stocks.find(x=>x.id===id)||{};
  // v117 · Antes de guardar nada, comprobar la escala contra tus propios precios.
  let ser=_stkPending.serie, factor=1, moneda='eur';
  const D=stkDetectaEscala(id,ser);
  const T=stkEscalaTexto(D);
  if(D&&D.tipo!=='ok'){
    const r=confirm(s.name+' — '+T.titulo+'\n\n'+T.cuerpo+'\n\n'+
      '¿Aplico el factor ×'+D.prop.toFixed(D.tipo==='peniques'?6:4)+' a todo el archivo?\n\n'+
      '(Si dices que no, se guardan los precios tal cual y la cartera saldrá mal.)');
    if(r){ser=stkAplicaFactor(ser,D.prop);factor=D.prop;moneda=D.tipo;}
  }else if(!D){
    if(!confirm(s.name+' — '+T.titulo+'\n\n'+T.cuerpo+'\n\n¿Guardo el archivo igualmente?')){_stkPending=null;return;}
  }
  if(!guardedAction('importar precios históricos'))return;
  const previo=stkStore()[id];
  // Si ya había serie, se fusiona: los días nuevos se añaden, los repetidos se
  // sustituyen. Así puedes traer el histórico en varios trozos.
  const m=new Map((previo&&previo.serie?previo.serie:[]).map(p=>[p[0],p[1]]));
  ser.forEach(p=>m.set(p[0],p[1]));
  const fin=[...m.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  stkStore()[id]={isin:s.isin||null,fuente:archivo||(_stkPending?_stkPending.archivo:''),
    n:fin.length,desde:fin[0][0],hasta:fin[fin.length-1][0],serie:fin,
    factor:factor,moneda:moneda};
  _stkPending=null;
  save(); renderPrecios(); try{renderAnalisisEvolution();}catch(e){fallo('renderAnalisisEvolution',e)}
  toast('📈 '+(s.name||id)+': '+fin.length+' precios guardados');
}
function stkBorrar(id){
  const s=cfg.stocks.find(x=>x.id===id)||{};
  if(!confirm('¿Borrar el histórico de precios de '+(s.name||id)+'?\n\nLas operaciones y las valoraciones de DEGIRO no se tocan.'))return;
  if(!guardedAction('borrar precios de '+(s.name||id)))return;
  delete stkStore()[id];
  save(); renderPrecios(); try{renderAnalisisEvolution();}catch(e){fallo('renderAnalisisEvolution',e)}
}
function stkCopiarBusqueda(id){
  const c=stkCobertura(id); if(!c)return;
  const desde=c.faltaAntes||c.primera, hasta=c.faltaDespues||c.ultima;
  const txt=(c.isin?c.isin+' ':'')+c.nombre+' histórico precios '+fmtDate(desde)+' a '+fmtDate(hasta);
  try{navigator.clipboard.writeText(txt);toast('Copiado: '+txt);}
  catch(e){prompt('Copia esto y búscalo:',txt);}
}

// v119 · Plegada por defecto: una vez cargados los precios, esta tabla no hay
// que verla a diario. El resumen se queda en la cabecera, y si algo va mal el
// aviso obliga a abrirla.
let _preciosOpen=false;
try{_preciosOpen=ALM.getItem('dlv_preciosopen')==='1';}catch(e){fallo('_preciosOpen',e)}
function togglePrecios(){
  _preciosOpen=!_preciosOpen;
  try{ALM.setItem('dlv_preciosopen',_preciosOpen?'1':'0');}catch(e){fallo('ALM.setItem',e)}
  renderPrecios();
}
function renderPrecios(){
  const box=document.getElementById('precios-body'); if(!box)return;
  const C=stkCoberturaTodas();
  const badge=document.getElementById('precios-badge');
  const arrow=document.getElementById('precios-arrow');
  const conPrecios=C.filter(x=>x.tienePrecios).length;
  const malAviso=(typeof stkAuditar==='function')?stkAuditar().filter(x=>x.D&&x.D.tipo!=='ok').length:0;
  if(arrow)arrow.innerHTML=_preciosOpen?'&#9662;':'&#9656;';
  if(badge)badge.innerHTML=conPrecios+' de '+C.length+' acciones con histórico'+
    (conPrecios<C.length?' · <span style="color:var(--amber)">faltan '+(C.length-conPrecios)+'</span>':
      ' <span style="color:var(--teal)">✓</span>')+
    (malAviso?' · <span style="color:var(--red);font-weight:700">⚠ '+malAviso+' con la escala mal</span>':'');
  if(!C.length){box.innerHTML=_preciosOpen?'<div style="font-size:12px;color:var(--muted)">No tienes operaciones de acciones registradas.</div>':'';return;}
  // plegada, salvo que haya algo mal: eso no se esconde
  if(!_preciosOpen&&!malAviso){box.innerHTML='';return;}
  const serie=stkCarteraDiaria();
  const compl=serie.filter(x=>x.completo).length;
  let h='<div style="font-size:11.5px;color:var(--muted);margin-bottom:.55rem">'+
    'Tus compras y ventas ya dicen cuántos títulos tenías cada día. Lo único que falta para valorar la cartera '+
    'a diario es el precio, y ese se descarga <strong>una vez por acción</strong>. Después la gráfica se actualiza sola '+
    'sin volver a tocar DEGIRO.</div>';
  // v117 · Lo primero de todo: ¿hay alguna serie con la escala equivocada?
  (function(){
    const A=(typeof stkAuditar==='function')?stkAuditar():[];
    const mal=A.filter(x=>x.D&&x.D.tipo!=='ok');
    const absurdos=(typeof stkDiasAbsurdos==='function')?stkDiasAbsurdos(serie):[];
    if(!mal.length&&!absurdos.length)return;
    const peniques=mal.filter(x=>x.D.tipo==='peniques');
    h+='<div style="background:#FDECEA;border:1px solid #E8A79E;border-radius:6px;padding:.6rem .7rem;font-size:11.5px;color:#8A2A1A;margin-bottom:.6rem">'+
      '<strong>⚠ '+mal.length+' serie(s) no están en euros o no están a escala.</strong>'+
      (peniques.length?' '+peniques.length+' vienen en <strong>peniques</strong>: las bolsas de Londres cotizan en GBX, no en libras, '+
        'y eso multiplica el valor por cien.':'')+
      (absurdos.length?' Hay <strong>'+absurdos.length+' día(s)</strong> en los que la cartera sale más de cuatro veces por encima '+
        'de tu mayor valoración real de DEGIRO — el máximo es el '+fmtDate(absurdos.reduce((a,b)=>b.val>a.val?b:a).date)+
        ' con '+fmt(Math.round(absurdos.reduce((a,b)=>b.val>a.val?b:a).val))+'€.':'')+
      '<div style="margin-top:.4rem">'+
      '<button type="button" class="btn-xs" style="background:#B03020;color:#fff;border-color:#B03020" onclick="stkCorregirTodas()">Revisar y corregir la escala</button>'+
      '<span style="font-size:10.5px;color:#A0503A;margin-left:.4rem">verás la lista antes de tocar nada · se puede deshacer</span></div>'+
      '<div style="margin-top:.35rem;font-size:10.5px;color:#A0503A">'+
      mal.slice(0,6).map(x=>{const m=x.D.muestras[0];
        return escapeHtml(x.nombre)+': el archivo dice '+fmt2(m.arch)+' el '+fmtDate(m.fecha)+' y tú tenías '+fmt2(m.real)+'€ (×'+
        x.D.prop.toFixed(x.D.tipo==='peniques'?6:4)+')';}).join('<br>')+
      (mal.length>6?'<br>…y '+(mal.length-6)+' más':'')+'</div></div>';
  })();
  if(serie.length){
    h+='<div style="background:'+(compl===serie.length?'#E8F5EE':'var(--surface2)')+';border-radius:6px;padding:.5rem .6rem;font-size:11.5px;margin-bottom:.55rem">'+
      'Serie diaria reconstruida: <strong>'+serie.length+' días</strong> desde '+fmtDate(serie[0].date)+'. '+
      (compl===serie.length
        ? '<span style="color:var(--teal)">Todos los días tienen precio fresco de todas las acciones abiertas.</span>'
        : '<strong>'+compl+'</strong> con precio de verdad y <strong>'+(serie.length-compl)+'</strong> arrastrando '+
          'el último precio conocido, que puede ser de hace meses. Esos días no se usan en la gráfica diaria: '+
          'una línea plana no es una cotización, es la falta de datos disfrazada.')+
      '</div>';
  }
  h+='<div class="tbl-scroll"><table class="detail-table" style="font-size:11.5px">'+
    '<thead><tr><th style="text-align:left">Acción</th><th class="px-x">Títulos</th><th>La tienes desde</th>'+
    '<th>Precios que tengo</th><th class="px-x">Cobertura</th><th>Qué falta</th><th></th></tr></thead><tbody>';
  C.forEach(c=>{
    const pct=Math.round(c.cobertura*100);
    const falta=[];
    if(!c.tienePrecios)falta.push('todo: '+fmtDate(c.primera)+' → '+fmtDate(c.ultima));
    else{
      if(c.faltaAntes)falta.push('de '+fmtDate(c.faltaAntes)+' a '+fmtDate(c.desde));
      if(c.faltaDespues)falta.push('de '+fmtDate(c.faltaDespues)+' a '+fmtDate(c.ultima));
    }
    h+='<tr'+(c.abierta?'':' style="opacity:.6"')+'>'+
      '<td style="text-align:left">'+escapeHtml(c.nombre)+(c.abierta?'':' <span style="font-size:9px;color:var(--faint)">(cerrada)</span>')+
        (c.isin?'<div style="font-size:9px;color:var(--faint)">'+c.isin+'</div>':'')+
        '<div class="px-m">'+(c.titulosHoy?fmt(c.titulosHoy)+' títulos · ':'')+
          (c.tienePrecios?fmtDate(c.desde)+'→'+fmtDate(c.hasta)+' ('+c.n+')':'sin histórico')+'</div></td>'+
      '<td class="px-x">'+(c.titulosHoy?fmt(c.titulosHoy):'—')+'</td>'+
      '<td style="white-space:nowrap">'+fmtDate(c.primera)+'</td>'+
      '<td style="white-space:nowrap">'+(c.tienePrecios
        ? fmtDate(c.desde)+' → '+fmtDate(c.hasta)+'<div style="font-size:9px;color:var(--faint)">'+c.n+' precios</div>'+
          (c.meta&&c.meta.factor&&Math.abs(c.meta.factor-1)>1e-9
            ? '<div style="font-size:9px;color:var(--teal)">'+
              ({peniques:'peniques',dolares:'dólares',divisa:'otra divisa',raro:'factor manual'}[c.meta.moneda]||'ajustado')+
              ' ×'+c.meta.factor.toFixed(c.meta.moneda==='peniques'?6:4)+'</div>':'')
        : '<span style="color:var(--amber)">ninguno</span>')+'</td>'+
      '<td class="px-x">'+(c.tienePrecios
        ? '<div style="height:7px;background:#EEE;border-radius:4px;overflow:hidden;min-width:44px"><div style="height:100%;width:'+
          Math.min(100,pct)+'%;background:'+(pct>=90?'#1A7A3A':(pct>=50?'#A05800':'#B03020'))+'"></div></div>'+
          '<div style="font-size:9px;color:var(--faint)">'+pct+'%</div>'
        : '—')+'</td>'+
      '<td style="font-size:10.5px;color:'+(falta.length?'var(--amber)':'var(--teal)')+'">'+
        (falta.length?falta.join('<br>'):'nada ✓')+'</td>'+
      '<td style="white-space:nowrap">'+
        '<button type="button" class="btn-xs" onclick="stkCopiarBusqueda(\''+c.id+'\')" title="Copiar el texto de búsqueda">🔎</button> '+
        (c.tienePrecios?'<a href="#" onclick="event.preventDefault();stkBorrar(\''+c.id+'\')" style="color:var(--red);text-decoration:none">✕</a>':'')+
      '</td></tr>';
  });
  h+='</tbody></table></div>';
  h+='<div style="margin-top:.6rem;display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">'+
    '<button type="button" class="btn-xs" style="background:var(--navy);color:#fff;border-color:var(--navy)" '+
    'onclick="document.getElementById(\'precios-file\').click()">📈 Importar CSV de precios</button>'+
    '<input type="file" id="precios-file" accept=".csv,.txt" style="display:none" onchange="stkImportFile(event)">'+
    '<span style="font-size:10.5px;color:var(--muted)">un archivo por acción · se pueden importar por trozos</span></div>';
  h+='<details style="margin-top:.55rem"><summary style="font-size:11.5px;font-weight:600;cursor:pointer">De dónde bajar los precios</summary>'+
    '<div style="font-size:11px;color:var(--muted);margin-top:.4rem;line-height:1.6">'+
    'El botón 🔎 de cada fila te copia al portapapeles el ISIN, el nombre y el rango de fechas que necesitas. '+
    'Con eso:<ul style="margin:.3rem 0 0 1rem;padding:0">'+
    '<li><strong>Investing.com</strong> → busca la acción → pestaña «Datos históricos» → elige el rango → «Descargar datos». '+
    'Sale un CSV con columnas <em>Fecha</em> y <em>Último</em>, que es justo lo que lee esto.</li>'+
    '<li><strong>Yahoo Finance</strong> → la acción → «Historical Data» → «Download». Columnas <em>Date</em> y <em>Close</em>: también vale.</li>'+
    '<li><strong>La web del mercado</strong> (Euronext, Bolsa de Madrid, Deutsche Börse) si la acción no está en los anteriores.</li>'+
    '</ul>'+
    '<div style="margin-top:.4rem">Da igual el orden de las filas, el separador (coma o punto y coma) y el formato de la fecha. '+
    'Si el archivo trae más días de los que necesitas no pasa nada: solo se usan los que estabas dentro. '+
    'Y si lo traes en varios trozos, se fusionan.</div>'+
    '<div style="margin-top:.4rem"><strong>Divisas y peniques: ya se detecta solo.</strong> Al importar, la app compara el archivo '+
    'contra un precio tuyo real —lo que pagaste en una compra o lo que valía en una valoración de DEGIRO— <em>en la misma fecha</em>. '+
    'Si el cociente sale 0,0115 son peniques (Londres cotiza en GBX, no en libras); si sale 0,87 son dólares. Te lo dice con la prueba '+
    'delante y aplica el factor si aceptas.</div>'+
    '<div style="margin-top:.4rem;color:var(--amber)"><strong>Aun así, mejor bajarlos en euros.</strong> El factor de cambio se aplica '+
    'constante a toda la serie, y el euro/dólar se mueve: cuanto más atrás vayas, más se desvía la valoración. En Investing puedes '+
    'elegir el mercado — busca la acción en Euronext, Xetra o el BME y bájala en euros. Para las de Londres no hay alternativa en euros, '+
    'así que ahí el factor es lo que hay.</div>'+
    '</div></details>';
  box.innerHTML=h;
  markScrollables(box);
}

let _navPending=null;
function navImportFile(ev){
  const f=(ev.target.files||[])[0]; ev.target.value='';
  if(!f)return;
  const r=new FileReader();
  r.onload=e=>{
    // Admite tanto el CSV de Investing como un paquete .json con varios fondos
    if(/\.json$/i.test(f.name)||/^\s*\{/.test(String(e.target.result))){
      try{
        const j=JSON.parse(e.target.result);
        const nav=(j.personal&&j.personal.navHistory)||j.navHistory;
        if(!nav||!Object.keys(nav).length){toast('Ese JSON no lleva histórico de VL');return;}
        if(!guardedAction('importar histórico de VL'))return;
        let n=0,fondos=[];
        Object.keys(nav).forEach(k=>{
          if(!cfg.funds.some(x=>x.id===k))return;   // no crear fondos que no tienes
          navStore()[k]=nav[k]; n+=(nav[k].n||0);
          fondos.push((cfg.funds.find(x=>x.id===k)||{}).name||k);
        });
        if(!n){toast('Ese archivo no trae histórico de ninguno de tus fondos');return;}
        savePersonal(); save();
        try{renderFondos();}catch(_){fallo('renderFondos',_)}
        alert('Histórico de VL importado:\n\n· '+fondos.join('\n· ')+'\n\n'+n+' días en total.');
        toast('✅ '+n+' días de VL importados');
      }catch(err){toast('No se pudo leer el JSON: '+err.message);}
      return;
    }
    const P=navParseCSV(e.target.result);
    if(P.err){alert('No pude leer el archivo.\n\n'+P.err);return;}
    _navPending={serie:P.serie,fname:f.name};
    navShowPreview();
  };
  r.readAsText(f);
}
function navShowPreview(){
  const P=_navPending; if(!P)return;
  const S=P.serie, ini=S[0], fin=S[S.length-1];
  const cands=navGuessFund(S);
  const best=cands[0];
  const sel=P.fid||(best?best.fid:(cfg.funds[0]||{}).id);
  let h='<div style="font-size:11.5px;color:var(--muted);margin-bottom:.5rem">'+
    escapeHtml(P.fname)+' · <strong>'+S.length+'</strong> días · '+fmtDate(ini[0])+' → '+fmtDate(fin[0])+
    ' · VL final <strong>'+fin[1].toFixed(3).replace('.',',')+'€</strong></div>';
  h+='<div style="font-size:11.5px;margin-bottom:.4rem">¿A qué fondo pertenece?</div>'+
    '<select id="nav-fid" onchange="navPickFund(this.value)" style="font-size:12px;width:100%;margin-bottom:.5rem">'+
    cfg.funds.map(f=>{
      const c=cands.find(x=>x.fid===f.id);
      const dif=c?(' — tu VL '+c.mio.toFixed(2).replace('.',',')+'€, difiere '+(c.dif*100).toFixed(2).replace('.',',')+'%'):'';
      return '<option value="'+f.id+'"'+(f.id===sel?' selected':'')+'>'+escapeHtml(f.name)+dif+'</option>';
    }).join('')+'</select>';
  const c=cands.find(x=>x.fid===sel);
  if(c){
    const ok=c.dif<0.02;
    h+='<div style="background:'+(ok?'#E8F5EE':'#FFF6E0')+';border:1px solid '+(ok?'#9ED4B4':'#E8C97A')+
      ';border-radius:6px;padding:.5rem .6rem;font-size:11.5px;color:'+(ok?'var(--teal)':'var(--amber)')+';margin-bottom:.6rem">'+
      (ok
        ? '<strong>Cuadra.</strong> El VL del archivo y el que se deduce de tus participaciones difieren un '+(c.dif*100).toFixed(2).replace('.',',')+'%, compatible con el desfase de días.'
        : '<strong>No cuadra: difiere un '+(c.dif*100).toFixed(1).replace('.',',')+'%.</strong> Casi seguro que ese archivo es de OTRA CLASE del mismo fondo. '+
          'Las clases llevan la misma cartera pero distintas comisiones, así que su rentabilidad no es la tuya. '+
          'Puedes importarlo igualmente como referencia, pero los números que salgan no serán los de tu posición.')+
      '</div>';
    // v169 · y lo que pasa con la valoración del fondo
    const VI=getFundVLInfo(sel), pa=fundParts(sel);
    if(ok&&pa>0&&(!VI.date||fin[0]>VI.date))
      h+='<div style="font-size:11.5px;margin-bottom:.6rem">Además, el fondo se pone al día: <strong>'+fmt2(pa*fin[1])+'€</strong> el '+fmtDate(fin[0])+
        ' ('+fmtR(pa)+' participaciones × '+fin[1].toFixed(3).replace('.',',')+'€)'+(VI.date?', en vez de los '+fmt2(VI.amount)+'€ del '+fmtDate(VI.date):'')+'.</div>';
  }
  h+='<div style="display:flex;gap:.5rem;justify-content:flex-end;flex-wrap:wrap">'+
    '<button class="btn-sm" onclick="document.getElementById(\'dlv-modal\').remove()" style="font-size:12px">Cancelar</button>'+
    '<button class="btn-sm" onclick="navCommit()" style="font-size:12px;background:var(--navy);color:#fff;border-color:var(--navy)">Importar</button></div>';
  showModalWide('📈 Histórico de valor liquidativo',h);
}
function navPickFund(fid){ if(_navPending){_navPending.fid=fid; navShowPreview();} }
function navCommit(){
  const P=_navPending; if(!P)return;
  const fid=document.getElementById('nav-fid')?.value||P.fid;
  if(!fid){toast('Elige un fondo');return;}
  if(!guardedAction('importar histórico de VL'))return;
  const R=navAplicar(P.serie,fid,P.fname);
  if(R.err){toast(R.err);return;}
  savePersonal(); save();
  _navPending=null;
  document.getElementById('dlv-modal')?.remove();
  try{renderFondos();}catch(e){fallo('renderFondos',e)} try{renderAll();}catch(e){fallo('renderAll',e)}
  toast('✅ '+P.serie.length+' días de VL importados'+
    (R.valorado?' · fondo al día: '+fmt2(R.valorado.amount)+'€ el '+fmtDate(R.valorado.fecha):' · la valoración no cambia: '+R.motivo));
}
function navBorrar(fid){
  if(!confirm('¿Borrar el histórico de VL de este fondo? Las gráficas volverán a usar solo tus valoraciones.'))return;
  delete navStore()[fid]; savePersonal(); save();
  try{renderFondos();}catch(e){fallo('renderFondos',e)}
  toast('Histórico borrado');
}


// v169 · Aquí había una segunda setPuestoActual, de la v103, que guardaba el
// puesto en un dato que ya nadie leía. Como en JavaScript manda la última
// función con el mismo nombre, el selector «Tu puesto actual» no cambiaba
// nada. Se queda solo la buena, la que marca el puesto propio en la lista.


// ════════════════════════════════════════════
// v104 · CORRECCIÓN DE LOS SESGOS DE LECTURA
// ════════════════════════════════════════════
// Tres cosas te estaban dando una foto más amable que la real:
//  1. El ahorro salía de records[], cuyo último cierre es Ene-26 → la app te
//     enseñaba feb-25/ene-26 llamándolo "últimos 12 meses".
//  2. Ese mismo número alimentaba la proyección a 2045.
//  3. La media mezcla meses con paga extra y meses normales, y el 76% del
//     ahorro venía de los extraordinarios.

// ─── Ahorro real, de los apuntes, no de los cierres mensuales ────────
function ahorroReal12(){
  const M=(typeof ahorroMonthly==='function')?ahorroMonthly():[];
  if(!M.length)return null;
  const cur=(new Date()).getFullYear()+'-'+String((new Date()).getMonth()+1).padStart(2,'0');
  const cerrados=M.filter(x=>x.month<cur);          // el mes en curso está a medias
  const ult=cerrados.slice(-12);
  if(!ult.length)return null;
  return {meses:ult,total:ult.reduce((s,x)=>s+x.savings,0),n:ult.length,
    desde:ult[0].month,hasta:ult[ult.length-1].month};
}
// CORREGIDO en v105. La versión anterior marcaba como "extraordinario" todo mes
// que superase la mediana en un 30%, y así trataba las PAGAS EXTRA y la
// PRODUCTIVIDAD como si fueran golpes de suerte. No lo son: forman parte de la
// estructura de tu sueldo, se repiten todos los años y son perfectamente
// previsibles. Solo están distribuidas de forma desigual.
// Lo único que no se repite es lo que TÚ marcas como no recurrente (una
// sentencia, unos atrasos puntuales). Ahora es una decisión tuya, no un umbral.
function ingresoNoRecurrente(x){
  if(!x)return 0;
  const t=Number(x.amt)||0;
  // v110 · marcado a mano, y con importe parcial: un apunte de X€ puede
  // ser X de nómina (ordinaria) y Y de una sentencia (no se repetirá).
  if(x.noRec===true)return Math.min(t,x.noRecImp!=null?(Number(x.noRecImp)||0):t);
  if(x.noRec===false)return 0;                     // desmarcado a mano
  return Number(x.noRecAuto)||0;                   // detectado del desglose de nómina
}
// El desglose de nómina sabe cosas que el apunte del banco no: si un ingreso de
// X€ eran Y de nómina y Z de una sentencia, aquí se recupera.
function detectarNoRecurrentes(){
  let n=0;
  const nh=(typeof NOM_HIST==='function')?NOM_HIST():[];
  const unicos=nh.filter(x=>x.cat==='extra'&&x.nd);
  if(!unicos.length)return 0;
  unicos.forEach(u=>{
    const ym=u.ym||String(u.date||'').slice(0,7);
    // el apunte del banco de ese mes que contiene este importe embebido
    const cand=incomeLog.filter(e=>String(e.date||'').startsWith(ym)&&e.cat==='nomina');
    const exacto=cand.find(e=>Math.abs((e.amt||0)-(u.amt||0))<0.02);
    const compuesto=cand.find(e=>{
      const nm=nh.find(z=>z.ym===ym&&z.cat==='nomina'&&z.splitFrom);
      return nm&&Math.abs((e.amt||0)-(nm.splitFrom||0))<0.02;
    });
    const t=exacto||compuesto;
    if(t&&t.noRecAuto==null&&t.noRec==null){t.noRecAuto=u.amt;n++;}
  });
  if(n)save();
  return n;
}
function marcarNoRecurrente(id,v){
  const x=incomeLog.find(e=>e.id===id); if(!x)return;
  if(v==null)delete x.noRec; else x.noRec=v;
  save(); renderAll();
}
// ════════════════════════════════════════════
// v110 · AHORRO ORDINARIO EN EL PERIODO ELEGIDO
// ════════════════════════════════════════════
// ahorroPartido() sólo sabe de los últimos 12 meses cerrados. Las fichas de
// Ahorro usan el rango de fechas que tú eliges, así que necesitan su propio
// cálculo. Las pagas extra y la productividad NO son extraordinarias: son tu
// sueldo repartido de forma desigual. Extraordinario es únicamente lo que no
// se va a repetir (la sentencia, unos atrasos) — marcado a mano o deducido del
// desglose de la nómina.
function ahorroRango(fromM,toM){
  const _ci=(typeof compIncomeIds==='function')?compIncomeIds():new Set();
  const _ce=(typeof compExpenseIds==='function')?compExpenseIds():new Set();
  const dentro=d=>{const m=String(d||'').slice(0,7);return m>=fromM&&m<=toM;};
  let ing=0,ingNoRec=0,gas=0,gasNoRec=0;
  const marcadosIng=[],marcadosGas=[];
  incomeLog.forEach(x=>{
    // v126 · antes se descartaban intereses y dividendos aquí y no en el
    // dashboard, y por eso las dos pantallas daban ingresos distintos todos
    // los meses. Mismo criterio en todas partes: entran.
    if(_ci.has(x.id))return;
    if(!dentro(x.date))return;
    ing+=Number(x.amt)||0;
    const nr=(typeof ingresoNoRecurrente==='function')?ingresoNoRecurrente(x):0;
    if(nr>0){ingNoRec+=nr;marcadosIng.push({id:x.id,date:x.date,desc:x.desc||'(sin concepto)',imp:nr,total:Number(x.amt)||0,auto:x.noRec==null});}
  });
  expenseLog.forEach(x=>{
    if(_ce.has(x.id))return;
    if(!dentro(x.date))return;
    const dev=(typeof pendDev==='function')?pendDev(x):0;
    const neto=Math.max(0,(Number(x.amt)||0)-dev);
    gas+=neto;
    const nr=(typeof gastoNoRecurrente==='function')?Math.min(neto,gastoNoRecurrente(x)):0;
    if(nr>0){gasNoRec+=nr;marcadosGas.push({id:x.id,date:x.date,name:x.name||'(sin concepto)',imp:nr,total:neto});}
  });
  const meses=[];
  {const a=fromM.split('-'),b=toM.split('-');
   let y=+a[0],m=+a[1];const ye=+b[0],me=+b[1];
   while(y<ye||(y===ye&&m<=me)){meses.push(y+'-'+String(m).padStart(2,'0'));m++;if(m>12){m=1;y++;}}}
  const n=Math.max(1,meses.length);
  const aho=ing-gas;
  const ingOrd=ing-ingNoRec, gasOrd=gas-gasNoRec, ahoOrd=ingOrd-gasOrd;
  return {n,ing,gas,aho,ingNoRec,gasNoRec,ingOrd,gasOrd,ahoOrd,marcadosIng,marcadosGas,
    tasa:ing>0?aho/ing:0, tasaOrd:ingOrd>0?ahoOrd/ingOrd:0,
    hayExtra:(ingNoRec>0.005||gasNoRec>0.005)};
}
// Simétrico al de ingresos: un gasto es extraordinario sólo si TÚ lo marcas.
// Nada se decide por un umbral — un gasto grande no es lo mismo que un gasto
// que no se va a repetir.
function gastoNoRecurrente(x){
  if(!x)return 0;
  const t=Number(x.amt)||0;
  if(x.noRec===true)return Math.min(t,x.noRecImp!=null?(Number(x.noRecImp)||0):t);
  if(x.noRec===false)return 0;
  return Number(x.noRecAuto)||0;
}
// ── Marcar un apunte como extraordinario, desde su propia lista ──────
// El panel de percepción llevaba versiones diciendo «márcalo desde la lista de
// ingresos» y en la lista no había nada que pulsar. Esto es ese botón.
function nrValor(kind,id){
  const L=kind==='i'?incomeLog:expenseLog;
  const x=L.find(e=>e.id===id); if(!x)return 0;
  return kind==='i'?ingresoNoRecurrente(x):gastoNoRecurrente(x);
}
function nrMarcar(kind,id){
  const L=kind==='i'?incomeLog:expenseLog;
  const x=L.find(e=>e.id===id); if(!x)return;
  const t=Number(x.amt)||0, actual=nrValor(kind,id);
  const cual=kind==='i'?'ingreso':'gasto';
  const r=prompt('¿Cuánto de este '+cual+' es extraordinario, es decir, NO se va a repetir?\n\n'+
    String((kind==='i'?x.desc:x.name)||'')+' · '+fmtDate(x.date)+' · '+fmt2(t)+'€\n\n'+
    'Escribe 0 para que cuente entero como ordinario.\n'+
    (kind==='i'?'Recuerda: las pagas extra y la productividad SON ordinarias — son tu sueldo repartido de forma desigual.'
              :'Extraordinario es lo que no repetirás: una mudanza, una reparación grande. Un recibo anual no lo es.'),
    String(actual>0?actual:t).replace('.',','));
  if(r==null)return;
  const v=cuadreNum(r);
  if(!isFinite(v)||v<=0){x.noRec=false;delete x.noRecImp;}
  else{x.noRec=true;x.noRecImp=Math.min(v,t);}
  save();
  try{renderTxIngList();}catch(e){fallo('renderTxIngList',e)}
  try{renderGastosList();}catch(e){fallo('renderGastosList',e)}
  try{renderAhorro();}catch(e){fallo('renderAhorro',e)}
  try{renderAll();}catch(e){fallo('renderAll',e)}
  toast(nrValor(kind,id)>0?'★ Extraordinario: '+fmt2(nrValor(kind,id))+'€ fuera de la cifra principal de Ahorro'
                          :'Vuelve a contar entero como ordinario');
}
function nrBtn(kind,id){
  const v=nrValor(kind,id);
  return '<button type="button" class="btn-xs'+(v>0?' fmode-on':'')+'" data-nr="'+kind+'|'+id+'" onclick="nrMarcar(this.dataset.nr.slice(0,1),this.dataset.nr.slice(2))" title="'+
    (v>0?'Extraordinario: '+fmt2(v)+'€ fuera de la cifra principal. Pulsa para cambiarlo.'
        :'Marcar como extraordinario (no se repetirá)')+'">'+(v>0?'★':'☆')+'</button>';
}
function ahorroPartido(){
  const R=ahorroReal12(); if(!R)return null;
  const desde=R.desde, hasta=R.hasta;
  const dentro=e=>{const m=String(e.date||'').slice(0,7);return m>=desde&&m<=hasta;};
  const marcados=incomeLog.filter(e=>dentro(e)&&ingresoNoRecurrente(e)>0)
    .map(e=>({id:e.id,date:e.date,desc:e.desc||'(sin concepto)',imp:ingresoNoRecurrente(e),
      total:Number(e.amt)||0,auto:e.noRec==null}));
  const noRec=marcados.reduce((s,x)=>s+x.imp,0);
  const recurrente=R.total-noRec;
  return {
    total:R.total, n:R.n, desde, hasta,
    medMes:R.total/R.n,
    noRec, marcados,
    recurrente, recMes:recurrente/R.n,
    pctNoRec:R.total>0?noRec/R.total:0,
    mediana:(function(){const a=R.meses.map(x=>x.savings).sort((p,q)=>p-q);
      return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;})()
  };
}
// Qué aportación usa la proyección. Por defecto la ORDINARIA, que es la que
// puedes sostener sin depender de que caiga una paga extra.
function aportacionProyeccion(){
  const P=ahorroPartido();
  const modo=cfg.projAporte||'recurrente';
  if(!P) return {v:(typeof avgAho==='function'?avgAho():0),modo:'cierres',lbl:'cierres mensuales'};
  if(modo==='manual'&&cfg.projAporteManual!=null) return {v:Number(cfg.projAporteManual)||0,modo:'manual',lbl:'valor que fijaste'};
  if(modo==='media') return {v:P.medMes,modo:'media',lbl:'los 12 meses tal cual'};
  return {v:P.recMes,modo:'recurrente',lbl:'sin lo no recurrente'};
}
function setProjAporte(m){
  cfg.projAporte=m;
  if(m==='manual'){
    const v=prompt('¿Qué aportación mensual quieres usar en la proyección? (€)',Math.round(aportacionProyeccion().v));
    if(v==null)return; cfg.projAporteManual=parseFloat(String(v).replace(',','.'))||0;
  }
  save(); renderAll();
}

// ─── Concentración ──────────────────────────────────────────────────
function concentracion(){
  const r=(typeof getDashRecord==='function')?getDashRecord():null;
  if(!r)return null;
  const items=[];
  const cash=getCash(r); if(cash>0)items.push({tipo:'Liquidez',nombre:'Liquidez y bróker',v:cash});
  cfg.funds.forEach(f=>{
    const b=balanceLog.filter(x=>x.refType==='fund'&&x.refId===f.id).sort((a,b)=>a.date.localeCompare(b.date));
    if(b.length&&b[b.length-1].amount>0)items.push({tipo:'Fondo',nombre:f.name,v:b[b.length-1].amount});
  });
  const agg=(typeof getStockAggregates==='function')?getStockAggregates():{};
  cfg.stocks.forEach(s=>{
    const a=agg[s.id];
    if(a&&a.totalShares>0.0001&&a.currentVal>0)items.push({tipo:'Acción',nombre:s.name,v:a.currentVal});
  });
  const tot=items.reduce((s,x)=>s+x.v,0);
  if(tot<=0)return null;
  items.forEach(x=>x.pct=x.v/tot);
  items.sort((a,b)=>b.v-a.v);
  const rv=items.filter(x=>x.tipo!=='Liquidez').reduce((s,x)=>s+x.v,0);
  return {items,tot,rv,rvPct:rv/tot,
    mayor:items[0], top3:items.slice(0,3).reduce((s,x)=>s+x.pct,0),
    alerta:items.filter(x=>x.pct>=0.25&&x.tipo!=='Liquidez')};
}

// ─── Ventana de compensación de pérdidas ────────────────────────────
function ventanaPerdidas(anio){
  const y=anio||String(new Date().getFullYear());
  const agg=(typeof getStockAggregates==='function')?getStockAggregates():{};
  let ganado=0;
  transactions.filter(t=>t.type==='sell'&&String(t.date||'').startsWith(y)).forEach(t=>{
    if(t.gain!=null)ganado+=Number(t.gain)||0;
    else{
      const a=agg[t.stockId];
      if(a&&a.avgPrice)ganado+=((t.price||0)-a.avgPrice)*(t.shares||0);
    }
  });
  const latentes=[];
  cfg.stocks.forEach(s=>{
    const a=agg[s.id];
    if(!a||a.totalShares<=0.0001)return;
    if(a.unrealizedPL!=null&&a.unrealizedPL<0)latentes.push({nombre:s.name,pl:a.unrealizedPL});
  });
  const perdLat=latentes.reduce((s,x)=>s+x.pl,0);
  const compensable=Math.min(Math.abs(perdLat),Math.max(0,ganado));
  return {anio:y,ganado,perdLat,latentes:latentes.sort((a,b)=>a.pl-b.pl),
    compensable,ahorroMin:compensable*0.19,ahorroMax:compensable*0.21};
}

// ─── Panel ──────────────────────────────────────────────────────────
function renderPercepcion(){
  const box=document.getElementById('percep-body'); if(!box)return;
  try{detectarNoRecurrentes();}catch(e){fallo('detectarNoRecurrentes',e)}
  const P=ahorroPartido(), C=concentracion(), V=ventanaPerdidas();
  const ap=aportacionProyeccion();
  const eur=v=>fmt(Math.round(v))+'€';
  let h='';

  // ── ahorro ordinario vs extraordinario
  if(P){
    const eurP=v=>fmt(Math.round(v))+'€';
    h+='<div style="font-size:12px;font-weight:700;margin:.2rem 0 .4rem">Tu ahorro sostenible</div>';
    h+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:6px;margin-bottom:.5rem">'+
      [['Ahorrado en 12 meses',eurP(P.total),'var(--muted)'],
       ['No recurrente',P.noRec?('−'+eurP(P.noRec)):'0€','var(--red)'],
       ['Ritmo sostenible',eurP(P.recMes)+'/mes','var(--navy)'],
       ['Mes típico',eurP(P.mediana)+'/mes','var(--muted)']]
      .map(([l,v,c])=>'<div style="background:var(--surface2);border-radius:6px;padding:.45rem .5rem;text-align:center">'+
        '<div style="font-size:15px;font-weight:700;color:'+c+'">'+v+'</div>'+
        '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)">'+l+'</div></div>').join('')+
      '</div>';
    h+='<div style="font-size:11px;color:var(--muted);margin-bottom:.6rem">'+
      'Tus <strong>pagas extra y la productividad cuentan como recurrentes</strong>: son parte de la estructura '+
      'de tu sueldo y se repiten todos los años, aunque lleguen de golpe. Solo se descuenta lo que de verdad '+
      'no volverá, y eso lo decides tú.</div>';
    if(P.marcados.length){
      h+='<div style="font-size:11px;margin-bottom:.6rem">Descontado como no recurrente ('+fmtMonth(P.desde)+' → '+fmtMonth(P.hasta)+'):<ul style="margin:.25rem 0 0 1rem">'+
        P.marcados.map(x=>'<li>'+fmtDate(x.date)+' · '+escapeHtml(String(x.desc)).slice(0,44)+' · <strong>'+eurP(x.imp)+'</strong>'+
          (x.imp<x.total?' <span style="color:var(--faint)">(de un apunte de '+eurP(x.total)+')</span>':'')+
          (x.auto?' <span style="color:var(--teal);font-size:9.5px">detectado del desglose</span>':'')+
          ' <a href="#" onclick="event.preventDefault();marcarNoRecurrente(\''+x.id+'\',false)" style="color:var(--navy);text-decoration:none">tratarlo como recurrente</a></li>').join('')+
        '</ul></div>';
    }else{
      h+='<div style="font-size:11px;color:var(--muted);margin-bottom:.6rem">No hay nada marcado como no recurrente. '+
        'Puedes marcar un ingreso concreto desde la lista de ingresos en Datos entrada.</div>';
    }
    h+='<div style="font-size:11.5px;margin-bottom:.9rem;padding:.5rem .6rem;background:var(--surface2);border-radius:6px">'+
      'La proyección del panel usa <strong>'+eurP(ap.v)+'/mes</strong> ('+ap.lbl+'). Cambiar a: '+
      ['recurrente','media','manual'].map(m=>'<button type="button" class="btn-xs'+(ap.modo===m?' fmode-on':'')+
        '" onclick="setProjAporte(\''+m+'\')" style="margin-left:3px">'+
        ({recurrente:'sostenible',media:'12 meses tal cual',manual:'a mano'}[m])+'</button>').join('')+
      '</div>';
  }

  // ── concentración
  if(C){
    h+='<div style="font-size:12px;font-weight:700;margin:.2rem 0 .4rem">Concentración</div>';
    if(C.alerta.length){
      h+='<div style="background:#FFF6E0;border:1px solid #E8C97A;border-radius:6px;padding:.5rem .6rem;font-size:11.5px;color:var(--amber);margin-bottom:.5rem">'+
        C.alerta.map(a=>'<strong>'+escapeHtml(a.nombre)+'</strong> es el <strong>'+(a.pct*100).toFixed(1).replace('.',',')+'%</strong> de todo tu patrimonio').join('<br>')+
        '<br>Renta variable total: <strong>'+(C.rvPct*100).toFixed(1).replace('.',',')+'%</strong>. '+
        'Sube y baja junta: tenerlo repartido en varias líneas no lo diversifica si todas son del mismo estilo.</div>';
    }
    h+='<div class="tbl-scroll"><table class="detail-table" style="font-size:11.5px"><tbody>';
    C.items.slice(0,8).forEach(x=>{
      const w=Math.max(2,Math.round(x.pct*100));
      h+='<tr><td style="max-width:190px">'+escapeHtml(x.nombre).slice(0,32)+
        '<div style="font-size:9.5px;color:var(--faint)">'+x.tipo+'</div></td>'+
        '<td>'+eur(x.v)+'</td>'+
        '<td style="width:46%"><div style="display:flex;align-items:center;gap:5px">'+
          '<div style="height:7px;border-radius:4px;background:'+(x.pct>=0.25&&x.tipo!=='Liquidez'?'var(--amber)':'var(--navy)')+';width:'+w+'%"></div>'+
          '<span style="font-size:10.5px;color:var(--muted)">'+(x.pct*100).toFixed(1).replace('.',',')+'%</span></div></td></tr>';
    });
    h+='</tbody></table></div>';
  }

  // ── ventana de pérdidas
  if(V&&V.compensable>0){
    h+='<div style="font-size:12px;font-weight:700;margin:1rem 0 .4rem">Compensación de pérdidas '+V.anio+'</div>'+
      '<div style="background:#E8F5EE;border:1px solid #9ED4B4;border-radius:6px;padding:.5rem .6rem;font-size:11.5px;color:var(--teal)">'+
      'Llevas <strong>'+eur(V.ganado)+'</strong> de plusvalías realizadas y <strong>'+eur(V.perdLat)+'</strong> latentes sin aflorar. '+
      'Realizando esas pérdidas compensarías hasta <strong>'+eur(V.compensable)+'</strong>, entre '+
      '<strong>'+eur(V.ahorroMin)+' y '+eur(V.ahorroMax)+'</strong> menos de impuestos.'+
      '<div style="font-size:10.5px;color:var(--muted);margin-top:.3rem">'+
      V.latentes.slice(0,5).map(l=>escapeHtml(l.nombre).slice(0,26)+' '+eur(l.pl)).join(' · ')+
      '<br>Recomprar el mismo valor antes de 2 meses anula la compensación. No es gratis: implica quedarte fuera o rotar.</div></div>';
  }
  box.innerHTML=h||'<div style="font-size:12px;color:var(--muted)">Aún no hay suficientes datos.</div>';
  markScrollables(box);
}


// ════════════════════════════════════════════
// v106 · PROVISIÓN FISCAL Y TASA DE AHORRO HONESTA
// ════════════════════════════════════════════
// No se trata de adelantarle dinero a Hacienda — eso es prestárselo sin interés
// durante año y medio. Se trata de saber que ese pago viene, tenerlo apartado
// mentalmente y no contarlo como ahorro disponible.
function fiscalCfg(){
  cfg.fiscal=cfg.fiscal||{prev:[]};
  cfg.fiscal.prev=cfg.fiscal.prev||[];
  return cfg.fiscal;
}
function fiscalPagos(){
  // pagos ya hechos a Hacienda, para deducir el patrón
  const cats=Object.entries(cfg.customCats||{}).filter(([k,v])=>/impuesto|hacienda|tribut/i.test(v)).map(([k])=>k);
  const comp=compExpenseIds();   // v163 · un pago que Hacienda te devolvió y has compensado tampoco
  return expenseLog.filter(x=>cats.includes(x.cat)&&(Number(x.amt)||0)>400&&!comp.has(x.id)
      &&!((typeof pendDev==='function')&&pendDev(x)>0))   // un duplicado reclamado no es tu carga fiscal
    .sort((a,b)=>String(a.date).localeCompare(String(b.date)));
}
// En España la declaración se puede fraccionar 60% en junio y 40% en noviembre.
// Si el histórico encaja con ese reparto, el 40% pendiente es previsible.
function fiscalDetecta(){
  const P=fiscalPagos(), out=[];
  const porAnio={};
  P.forEach(x=>{(porAnio[x.date.slice(0,4)]=porAnio[x.date.slice(0,4)]||[]).push(x);});
  const anios=Object.keys(porAnio).sort();
  let patron=false;
  anios.forEach(y=>{
    const p=porAnio[y];
    if(p.length>=2){
      const t=p.reduce((s,x)=>s+x.amt,0);
      if(Math.abs(p[0].amt/t-0.6)<0.02) patron=true;
    }
  });
  const hoy=todayISO(), anio=hoy.slice(0,4);
  const esteAnio=porAnio[anio]||[];
  // ¿hay un pago de junio que parezca el 60% sin su 40% correspondiente?
  const jun=esteAnio.find(x=>x.date.slice(5,7)>='05'&&x.date.slice(5,7)<='07'&&x.amt>800);
  const nov=esteAnio.find(x=>x.date.slice(5,7)>='10'&&x.date.slice(5,7)<='12');
  if(patron&&jun&&!nov){
    out.push({id:'auto_40_'+anio,fecha:anio+'-11-05',
      concepto:'2º plazo declaración (40%)',importe:Math.round(jun.amt/0.6*0.4*100)/100,auto:true,
      nota:'En años anteriores fraccionaste 60/40. Si este año también, esto queda pendiente.'});
  }
  // Próxima declaración. OJO: no se suman todos los pagos del año, porque el
  // 40% pendiente pertenece a la MISMA declaración que el 60% ya pagado, y
  // porque puede haber tributos distintos mezclados. Se reconstruye el total
  // desde el primer plazo, que es lo único que se sabe con certeza.
  let ultTotal=null, ultAnio=null;
  anios.forEach(y=>{
    const p=porAnio[y];
    const primero=p.find(x=>x.date.slice(5,7)>='05'&&x.date.slice(5,7)<='07'&&x.amt>800);
    if(!primero)return;
    const segundo=p.find(x=>x.date.slice(5,7)>='10'&&x.date.slice(5,7)<='12'&&x.amt>400);
    // si hay 2º plazo y suma 60/40, el total es la suma; si no, se extrapola
    let t;
    if(segundo&&Math.abs(primero.amt/(primero.amt+segundo.amt)-0.6)<0.03) t=primero.amt+segundo.amt;
    else if(patron) t=primero.amt/0.6;
    else t=primero.amt;
    ultTotal=Math.round(t*100)/100; ultAnio=y;
  });
  // v121 · Si hay nóminas suficientes esto deja de ser "lo mismo que el año
  // pasado": se reconstruye la declaración entera —ventas de acciones
  // incluidas— y el heurístico 60/40 queda solo como red de seguridad.
  let calculada=false;
  try{
    fiscalAniosPendientes().forEach(a=>{
      const R=fiscalRenta(a);
      if(!R||R.resultado<=0)return;
      calculada=true;
      const notaVentas=R.porVentas>0
        ? ' De ese importe, '+fmt(Math.round(R.porVentas))+'€ vienen de las ventas de acciones, por las que nadie te retiene nada.'
        : '';
      out.push({id:'auto_dec_'+(a+1),fecha:R.fechaPago,
        concepto:'Declaración '+a+' (calculada)',importe:Math.round(R.resultado*100)/100,auto:true,
        nota:'Reconstruida con tus nóminas, la IPT, los intereses y las ventas de acciones.'+notaVentas});
    });
  }catch(e){ console.warn('fiscalRenta',e); }
  if(!calculada&&ultTotal){
    const sig=String(Number(anio)+1);
    out.push({id:'auto_dec_'+sig,fecha:sig+'-06-30',
      concepto:'Declaración '+anio+' (estimada)',importe:ultTotal,auto:true,
      nota:'Estimación de partida: la declaración de '+ultAnio+' salió a '+fmt(Math.round(ultTotal))+'€. Pon tu propio cálculo cuando lo tengas.'});
  }
  return out;
}
function fiscalPrevisiones(){
  const c=fiscalCfg();
  const manual=c.prev.slice();
  const ids=new Set(manual.map(x=>x.id));
  const auto=fiscalDetecta().filter(x=>!ids.has(x.id)&&!(c.ocultas||[]).includes(x.id));
  const hoy=todayISO();
  return [...manual,...auto].filter(x=>x.fecha>=hoy)
    .sort((a,b)=>String(a.fecha).localeCompare(String(b.fecha)));
}
// Dos cosas distintas que no deben mezclarse:
//   · la carga fiscal ANUAL recurrente → se reparte entre 12 y es lo que se
//     descuenta de la tasa de ahorro
//   · los pagos INMINENTES → no son una tasa, son dinero que necesitas pronto
function fiscalProvisionMensual(){
  const hoy=todayISO();
  const P=fiscalPrevisiones();
  // la declaración anual es la carga recurrente; el resto son puntuales
  const anual=P.filter(p=>/declaraci/i.test(p.concepto)&&!/plazo/i.test(p.concepto))
    .reduce((s,p)=>s+(Number(p.importe)||0),0);
  const det=P.map(p=>{
    const dias=Math.round((Date.parse(p.fecha)-Date.parse(hoy))/864e5);
    const recurrente=/declaraci/i.test(p.concepto)&&!/plazo/i.test(p.concepto);
    return {...p,dias,recurrente,mensual:recurrente?(Number(p.importe)||0)/12:null};
  });
  const inminentes=det.filter(x=>!x.recurrente&&x.dias<=180);
  return {mensual:anual/12, anual, det, inminentes,
    inmTotal:inminentes.reduce((s,x)=>s+(Number(x.importe)||0),0)};
}
function fiscalAdd(){
  const f=prompt('¿Cuándo lo pagarás? (AAAA-MM-DD)', String(Number(todayISO().slice(0,4))+1)+'-06-30');
  if(!f)return;
  const c=prompt('¿De qué es?','Declaración de la renta');
  if(c==null)return;
  const i=prompt('¿Cuánto estimas? (€)','0');
  if(i==null)return;
  fiscalCfg().prev.push({id:'fp_'+Date.now(),fecha:f.trim(),concepto:c.trim(),
    importe:parseFloat(String(i).replace(',','.'))||0});
  save(); renderAhorro();
}
function fiscalEdit(id){
  const c=fiscalCfg();
  let p=c.prev.find(x=>x.id===id);
  if(!p){ const a=fiscalDetecta().find(x=>x.id===id); if(!a)return;
    p={...a,auto:false}; c.prev.push(p); }
  const i=prompt('Importe estimado para «'+p.concepto+'» ('+fmtDate(p.fecha)+')',String(p.importe));
  if(i==null)return;
  p.importe=parseFloat(String(i).replace(',','.'))||0;
  save(); renderAhorro();
}
function fiscalDel(id){
  const c=fiscalCfg();
  const i=c.prev.findIndex(x=>x.id===id);
  if(i>=0)c.prev.splice(i,1);
  else {c.ocultas=c.ocultas||[]; c.ocultas.push(id);}
  save(); renderAhorro();
}

// ─── Las cuatro tasas de ahorro ─────────────────────────────────────
// Se separan dos ejes distintos que antes estaban mezclados:
//   · recurrente / no recurrente  → qué ingresos se repetirán
//   · bruto / neto de provisión   → qué parte ya está comprometida
function tasasAhorro(){
  const P=(typeof ahorroPartido==='function')?ahorroPartido():null;
  const R=(typeof ahorroReal12==='function')?ahorroReal12():null;
  if(!P||!R)return null;
  const ing=R.meses.reduce((s,x)=>s+x.income,0);
  const noRecIng=P.noRec;
  const prov=fiscalProvisionMensual().mensual*R.n;
  const f=(a,b)=>b>0?a/b:0;
  return {
    n:R.n, desde:R.desde, hasta:R.hasta,
    ingTotal:ing, ingRec:ing-noRecIng,
    ahoTotal:P.total, ahoRec:P.recurrente,
    prov, provMes:prov/R.n,
    tasaTotal:f(P.total,ing),
    tasaRec:f(P.recurrente,ing-noRecIng),
    tasaTotalNeta:f(P.total-prov,ing),
    tasaRecNeta:f(P.recurrente-prov,ing-noRecIng),
    ahoRecNetoMes:(P.recurrente-prov)/R.n,
    ahoTotalMes:P.total/R.n
  };
}


// ════════════════════════════════════════════════════════════════════
// v129 · QUÉ PARTE DE TU AHORRO NO SE VA A REPETIR
// ════════════════════════════════════════════════════════════════════
// Un ahorro de X € del que Y € son una sentencia cobrada una vez no
// es el mismo ahorro que X € de nómina. El primero no dice nada sobre el
// mes que viene. La app ya sabía distinguirlos, pero solo lo contaba en la
// pestaña de Ahorro: en el dashboard, en el histórico y en Consultas salía la
// cifra pelada. Ahora la nota acompaña al número esté donde esté.
//
// Extraordinario es únicamente lo que TÚ marcas como no recurrente, o lo que
// se deduce del desglose de una nómina (una regularización por sentencia, unos
// atrasos). Las pagas extra y la productividad NO lo son: son tu sueldo
// repartido de forma desigual y vuelven todos los años.
function ahorroExtra(fromM,toM){
  const R=(typeof ahorroRango==='function')?ahorroRango(fromM,toM):null;
  if(!R)return null;
  const neto=(R.ingNoRec||0)-(R.gasNoRec||0);
  return {ing:R.ing,gas:R.gas,aho:R.aho,ahoOrd:R.ahoOrd,
    ingNoRec:R.ingNoRec||0, gasNoRec:R.gasNoRec||0, neto,
    hay:Math.abs(neto)>0.005,
    marcadosIng:R.marcadosIng||[], marcadosGas:R.marcadosGas||[],
    pct:R.aho>0?neto/R.aho:0};
}
// Rango de meses de un periodo de fechas suelto (para Consultas y similares)
function _mesesDe(from,to){
  return {f:String(from||'').slice(0,7)||'0000-01', t:String(to||'').slice(0,7)||'9999-12'};
}
// La nota, en una línea. Es la misma frase en todas las pantallas a propósito:
// si cambia el sitio pero no el texto, se reconoce de un vistazo.
function ahorroExtraNota(fromM,toM,opt){
  opt=opt||{};
  const E=ahorroExtra(fromM,toM);
  if(!E)return '';
  if(!E.hay){
    return opt.siempre
      ? '<span style="color:var(--teal)">Todo el ahorro es ordinario: nada de esto viene de un ingreso o un gasto que no se vaya a repetir.</span>'
      : '';
  }
  const q=E.neto>0?'de ese ahorro':'a ese ahorro';
  const det=[];
  E.marcadosIng.forEach(x=>det.push(escapeHtml(String(x.desc||'').slice(0,30))+' '+fmt2(x.imp)+'€'));
  E.marcadosGas.forEach(x=>det.push(escapeHtml(String(x.name||'').slice(0,30))+' −'+fmt2(x.imp)+'€'));
  return '<strong style="color:var(--amber)">'+(E.neto>0?'':'−')+fmt(Math.abs(Math.round(E.neto)))+'€ '+q+
    ' es extraordinario</strong> y no se repetirá'+
    (E.aho>0?' ('+Math.round(Math.abs(E.pct)*100)+'% del total)':'')+
    '. Sin eso, el ahorro ordinario son <strong>'+fmt(Math.round(E.ahoOrd))+'€</strong>'+
    (det.length?'. Viene de: '+det.join(' · '):'')+'.';
}
// Versión corta, para los sitios donde solo cabe un renglón
function ahorroExtraCorta(fromM,toM){
  const E=ahorroExtra(fromM,toM);
  if(!E||!E.hay)return '';
  return (E.neto>0?'incluye ':'descontado ')+fmt(Math.abs(Math.round(E.neto)))+'€ extraordinario · ordinario '+
    fmt(Math.round(E.ahoOrd))+'€';
}

// ════════════════════════════════════════════════════════════════════
// v129 · LO QUE HA CRECIDO TU DINERO EN EL PERIODO
// ════════════════════════════════════════════════════════════════════
// El ahorro solo cuenta lo que entra y sale de la cuenta. Pero tu dinero
// también crece sin que tú hagas nada: las acciones que vendes con plusvalía
// y los fondos que se revalorizan. Esta casilla suma las tres cosas, que es
// la respuesta a "¿cuánto he ganado en total este periodo?".
//
// Ojo con lo que NO incluye: lo que han subido o bajado las acciones que
// sigues teniendo sin vender. Eso está en Análisis, y se dice aquí abajo
// para que no se busque una cuadratura que no existe.
function crecimientoPeriodo(from,to){
  const M=_mesesDe(from,to);
  const E=ahorroExtra(M.f,M.t);
  const aho=E?E.aho:0;
  const _ci=(typeof compIncomeIds==='function')?compIncomeIds():new Set();
  let plus=0, nVentas=0;
  (typeof transactions!=='undefined'?transactions:[]).forEach(t=>{
    if(t.type!=='sell')return;
    const d=String(t.date||''); if(!(d>=from&&d<=to))return;
    plus+=Number(t.gainLoss)||0; nVentas++;
  });
  let fondos=null;
  try{
    const F=fondosBloquePeriodo(from,to);
    if(F)fondos={ben:F.ben,ini:F.valIni,fin:F.valFin,flujo:F.flujo,desdeReal:F.desdeReal,
      desfase:F.desfase,recortado:F.recortado};
  }catch(e){fallo('F',e)}
  let latente=null;
  try{
    const A=stkBloquePeriodo(from,to);
    if(A)latente=A.ben-plus;   // lo que se movió sin vender
  }catch(e){fallo('A',e)}
  const total=aho+plus+(fondos?fondos.ben:0);
  return {aho,extra:E,plus,nVentas,fondos,latente,total};
}

function renderFiscal(){
  const box=document.getElementById('fiscal-body'); if(!box)return;
  const T=tasasAhorro(), PR=fiscalPrevisiones(), PM=fiscalProvisionMensual();
  const eur=v=>fmt(Math.round(v))+'€';
  const pc=v=>(v*100).toFixed(1).replace('.',',')+'%';
  let h='';
  if(T){
    h+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px;margin-bottom:.55rem">'+
      [['Tasa con extraordinarios',pc(T.tasaTotal),eur(T.ahoTotalMes)+'/mes','var(--muted)'],
       ['Tasa ordinaria',pc(T.tasaRec),'sin lo que no se repite','var(--navy)'],
       ['Ordinaria neta de impuestos',pc(T.tasaRecNeta),eur(T.ahoRecNetoMes)+'/mes real','var(--teal)'],
       ['Provisión fiscal',eur(PM.mensual)+'/mes',eur(T.prov)+' al año','var(--amber)']]
      .map(([l,v,s,c])=>'<div style="background:var(--surface2);border-radius:6px;padding:.45rem .5rem;text-align:center">'+
        '<div style="font-size:15px;font-weight:700;color:'+c+'">'+v+'</div>'+
        '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)">'+l+'</div>'+
        '<div style="font-size:9.5px;color:var(--faint);margin-top:1px">'+s+'</div></div>').join('')+'</div>';
    h+='<div style="font-size:11px;color:var(--muted);margin-bottom:.7rem">'+
      'Las <strong>pagas extra y la productividad cuentan como ordinarias</strong>: son tu sueldo, repartido de forma desigual. '+
      'La tasa ordinaria descuenta solo lo que no volverá. La <strong>neta</strong> descuenta además la parte mensual de los '+
      'impuestos que ya sabes que vienen — es la única cifra que puedes gastar o invertir sin hacerte trampas.</div>';
  }
  if(PM.inminentes.length){
    h+='<div style="background:#FFF6E0;border:1px solid #E8C97A;border-radius:6px;padding:.5rem .6rem;font-size:11.5px;color:var(--amber);margin-bottom:.6rem">'+
      '<strong>Pago cercano: '+eur(PM.inmTotal)+'</strong> — '+
      PM.inminentes.map(x=>escapeHtml(x.concepto)+' el '+fmtDate(x.fecha)+' (en '+x.dias+' días)').join(' · ')+
      '. Esto no es una tasa mensual, es dinero que necesitas tener disponible. '+
      'No se reparte entre doce: se comprueba que lo tienes.</div>';
  }
  // v121 · la declaración desmontada pieza a pieza, antes de la lista de pagos
  try{ h+=iptAvisoHTML(); }catch(e){ console.warn('iptAviso',e); }
  try{ h+=previsionRentaHTML(); }catch(e){ console.warn('previsionRenta',e); }
  try{ h+=cotejoHTML(); }catch(e){ console.warn('cotejo',e); }

  h+='<div style="font-size:12px;font-weight:700;margin:.2rem 0 .4rem;display:flex;justify-content:space-between;align-items:center">'+
    '<span>Impuestos que vienen</span>'+
    '<button type="button" class="btn-xs" onclick="fiscalAdd()">+ Añadir previsión</button></div>';
  if(!PR.length){
    h+='<div style="font-size:11.5px;color:var(--muted)">No hay ningún pago previsto anotado. Añade tu estimación de la próxima declaración para que deje de ser una sorpresa.</div>';
  }else{
    h+='<div class="tbl-scroll"><table class="detail-table" style="font-size:11.5px">'+
      '<thead><tr><th>Cuándo</th><th style="text-align:left">Concepto</th><th>Importe</th><th>Aparta/mes</th><th></th></tr></thead><tbody>';
    PR.forEach(p=>{
      const dd=PM.det.find(x=>x.id===p.id);
      const dias=Math.round((Date.parse(p.fecha)-Date.parse(todayISO()))/864e5);
      h+='<tr><td style="white-space:nowrap">'+fmtDate(p.fecha)+
        '<div style="font-size:9.5px;color:var(--faint)">en '+dias+' días</div></td>'+
        '<td style="text-align:left;max-width:230px">'+escapeHtml(p.concepto)+
        (p.auto?' <span style="font-size:9px;color:var(--teal)">sugerido</span>':'')+
        (p.nota?'<div style="font-size:9.5px;color:var(--faint)">'+escapeHtml(p.nota)+'</div>':'')+'</td>'+
        '<td style="font-weight:600">'+eur(p.importe)+'</td>'+
        '<td>'+((dd&&dd.mensual!=null)?eur(dd.mensual):'<span style="color:var(--faint)">puntual</span>')+'</td>'+
        '<td style="white-space:nowrap"><a href="#" onclick="event.preventDefault();fiscalEdit(\''+p.id+'\')" style="text-decoration:none">✏️</a> '+
        '<a href="#" onclick="event.preventDefault();fiscalDel(\''+p.id+'\')" style="color:var(--red);text-decoration:none">✕</a></td></tr>';
    });
    h+='</tbody></table></div>';
  }
  const hist=fiscalPagos();
  if(hist.length){
    h+='<div style="font-size:10.5px;color:var(--faint);margin-top:.5rem">Ya pagados: '+
      hist.slice(-6).map(x=>fmtDate(x.date)+' '+eur(x.amt)).join(' · ')+'</div>';
  }
  box.innerHTML=h;
  markScrollables(box);
}


// ════════════════════════════════════════════
// v107 · DINERO QUE PAGASTE PERO TE DEBEN
// ════════════════════════════════════════════
// Faltaba un concepto entero: un gasto que salió de tu cuenta pero que no es
// tuyo porque te lo van a devolver. El caso que lo destapó: pagaste tu renta
// entera a mano (X€) porque la domiciliación no se cargó a tiempo, y al
// día siguiente Hacienda cobró igualmente el primer plazo. Ese importe está
// reclamado. Contarlo como gasto hunde tu ahorro y no figura como lo que es:
// dinero que te deben.
// Es distinto de "reembolsos", que casa un cobro YA recibido con sus gastos.
// Aquí el cobro todavía no ha llegado.
function pendDev(x){
  if(!x||!x.pendDev)return 0;
  if(x.pendDev.cobrado)return 0;
  const v=Number(x.pendDev.imp);
  return isFinite(v)&&v>0?Math.min(v,Number(x.amt)||0):(Number(x.amt)||0);
}
function pendDevTotal(){
  return expenseLog.reduce((s,x)=>s+pendDev(x),0);
}
function pendDevLista(){
  return expenseLog.filter(x=>pendDev(x)>0)
    .map(x=>({id:x.id,date:x.date,name:x.name,amt:Number(x.amt)||0,imp:pendDev(x),
      desde:(x.pendDev&&x.pendDev.desde)||x.date,nota:(x.pendDev&&x.pendDev.nota)||''}))
    .sort((a,b)=>String(a.date).localeCompare(String(b.date)));
}
function pendDevMarcar(id){
  const x=expenseLog.find(e=>e.id===id); if(!x){toast('No encuentro ese gasto');return;}
  const i=prompt('¿Cuánto de este gasto te tienen que devolver?\n\n'+
    (x.name||'')+' · '+fmtDate(x.date)+' · '+fmt2(x.amt)+'€',String(x.amt));
  if(i==null)return;
  const imp=parseFloat(String(i).replace(',','.'))||0;
  if(imp<=0){delete x.pendDev;save();renderAll();toast('Marca retirada');return;}
  const n=prompt('¿Por qué? (opcional)','Reclamado, pendiente de devolución');
  x.pendDev={imp:Math.min(imp,Number(x.amt)||0),desde:todayISO(),nota:(n||'').trim()};
  save(); renderAll();
  toast('Marcado: '+fmt(imp)+'€ pendientes de cobro');
}
function pendDevCobrado(id){
  const x=expenseLog.find(e=>e.id===id); if(!x||!x.pendDev)return;
  if(!confirm('¿Ya te lo han devuelto?\n\nSe dejará de contar como pendiente de cobro. '+
    'Si el ingreso lo has anotado aparte, el gasto seguirá sin contar como gasto tuyo, que es lo correcto.'))return;
  x.pendDev.cobrado=todayISO();
  save(); renderAll(); toast('Marcado como cobrado');
}
function pendDevQuitar(id){
  const x=expenseLog.find(e=>e.id===id); if(!x)return;
  delete x.pendDev; save(); renderAll(); toast('Vuelve a contar como gasto tuyo');
}

function renderPendDev(){
  const box=document.getElementById('penddev-body'); if(!box)return;
  const L=pendDevLista(), T=pendDevTotal();
  const eur=v=>fmt(Math.round(v))+'€';
  let h='';
  if(!L.length){
    h='<div style="font-size:11.5px;color:var(--muted)">Nada pendiente de cobro. '+
      'Si alguna vez pagas algo que te tienen que devolver — un duplicado, un anticipo, algo de otra persona — '+
      'márcalo desde la lista de gastos y dejará de hundir tu ahorro sin dejar de estar registrado.</div>';
  }else{
    h+='<div style="background:#E8F5EE;border:1px solid #9ED4B4;border-radius:6px;padding:.55rem .65rem;font-size:11.5px;color:var(--teal);margin-bottom:.5rem">'+
      '<strong>'+eur(T)+' pendientes de cobro.</strong> No cuentan como gasto tuyo en la tasa de ahorro '+
      'ni en el gasto medio, pero siguen registrados. Tampoco se suman al patrimonio: hasta que no estén '+
      'en tu cuenta son una promesa, no un saldo.</div>';
    h+='<div class="tbl-scroll"><table class="detail-table" style="font-size:11.5px">'+
      '<thead><tr><th>Fecha</th><th style="text-align:left">Concepto</th><th>Pagado</th><th>A devolver</th><th></th></tr></thead><tbody>';
    L.forEach(x=>{
      const dias=Math.round((Date.parse(todayISO())-Date.parse(x.desde))/864e5);
      h+='<tr><td style="white-space:nowrap">'+fmtDate(x.date)+'</td>'+
        '<td style="text-align:left;max-width:220px">'+escapeHtml(String(x.name||'')).slice(0,42)+
        (x.nota?'<div style="font-size:9.5px;color:var(--faint)">'+escapeHtml(x.nota)+'</div>':'')+
        '<div style="font-size:9.5px;color:var(--faint)">reclamado hace '+dias+' días</div></td>'+
        '<td>'+fmt2(x.amt)+'€</td><td style="font-weight:600;color:var(--teal)">'+fmt2(x.imp)+'€</td>'+
        '<td style="white-space:nowrap">'+
        '<button type="button" class="btn-xs" onclick="pendDevCobrado(\''+x.id+'\')">Cobrado</button> '+
        '<a href="#" onclick="event.preventDefault();pendDevQuitar(\''+x.id+'\')" style="color:var(--red);text-decoration:none">✕</a></td></tr>';
    });
    h+='</tbody></table></div>';
  }
  h+='<div style="margin-top:.5rem;font-size:11px;color:var(--muted)">'+
    '¿Marcar un gasto como pendiente de cobro? Pega su concepto: '+
    '<input type="text" id="penddev-buscar" placeholder="p. ej. TRIBUTO" style="font-size:11px;width:150px;padding:1px 5px">'+
    '<button type="button" class="btn-xs" onclick="pendDevBuscar()" style="margin-left:4px">Buscar</button>'+
    '<div id="penddev-res" style="margin-top:.35rem"></div></div>';
  box.innerHTML=h;
  markScrollables(box);
}
function pendDevBuscar(){
  const q=(document.getElementById('penddev-buscar')?.value||'').trim().toLowerCase();
  const res=document.getElementById('penddev-res'); if(!res)return;
  if(q.length<3){res.innerHTML='<span style="color:var(--faint);font-size:10.5px">Escribe al menos 3 letras.</span>';return;}
  const hit=expenseLog.filter(x=>!isHistExp(x)&&String(x.name||'').toLowerCase().includes(q)&&!pendDev(x))
    .sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,8);
  res.innerHTML=hit.length
    ? hit.map(x=>'<div style="font-size:11px;padding:1px 0">'+fmtDate(x.date)+' · '+escapeHtml(String(x.name||'')).slice(0,38)+
        ' · <strong>'+fmt2(x.amt)+'€</strong> '+
        '<a href="#" onclick="event.preventDefault();pendDevMarcar(\''+x.id+'\')" style="color:var(--navy);text-decoration:none">marcar</a></div>').join('')
    : '<span style="color:var(--faint);font-size:10.5px">Sin resultados.</span>';
}



// ════════════════════════════════════════════════════════════════════
// v112 · JUBILACIÓN: SIMULADOR AÑO A AÑO
// ════════════════════════════════════════════════════════════════════
// Todas las cifras están verificadas a agosto de 2026 y son editables:
// cuando cambie el Presupuesto o se publique la revalorización real, la
// corriges y todo lo posterior se recalcula.
//
// Lo que hay detrás de cada número:
//   · Escala del art. 31.1 del RDLeg 670/1987 (texto refundido de Clases Pasivas)
//   · Fórmula del art. 31.2 para carrera en dos cuerpos (C2 → C1)
//   · Arrastre de fracciones del art. 31.3
//   · Haberes reguladores 2026 del RD 241/2026, anexo III
//   · Jubilación forzosa a los 65 (art. 28.2.a) — en Clases Pasivas NO se retrasa a 67
//   · Voluntaria: 60 años + 30 de servicio (art. 28.2.b), sin coeficientes reductores
//   · Carencia mínima de 15 años (art. 29)
//   · Prolongación hasta los 70 (art. 67.3 TREBEP), previa autorización
//   · Complemento por demora: 4 puntos por año completo pasados los 65
//     (DA 17ª del RDLeg 670/1987, añadida por la Ley 21/2021, que extiende
//      a Clases Pasivas el art. 210.2 LGSS)
//   · IPT del Régimen General: 55% de la base reguladora; el incremento del
//     20% (art. 196.2 LGSS y art. 6 del Decreto 1646/1972) sube al 75%, exige
//     55 años cumplidos y QUEDA EN SUSPENSO MIENTRAS TRABAJES.


// ════════════════════════════════════════════════════════════════════
// v113 · IRPF SOBRE LAS PENSIONES
// ════════════════════════════════════════════════════════════════════
// Una pensión es rendimiento del trabajo y tributa como tal. Ni la de Clases
// Pasivas ni la IPT están exentas: solo lo están la incapacidad ABSOLUTA y la
// gran invalidez (art. 7.f LIRPF). Así que el bruto de la ficha anterior no es
// lo que te llega al banco.
//
// El cálculo que se hace aquí es el de la DECLARACIÓN, no el de la retención:
//   íntegro − 2.000 € de otros gastos (art. 19.2)
//           − reducción del art. 20 (si el rendimiento es bajo)
//   = base liquidable
//   cuota = escala(base) − escala(mínimo personal y familiar), por las dos
//           mitades: la estatal y la de tu comunidad
// Es la cifra que de verdad acabas pagando por el año, que es lo que importa
// para planificar. La retención mensual es otra cosa y casi nunca coincide.

// Escala general ESTATAL — art. 63.1 LIRPF (la mitad estatal)
const IRPF_ESTATAL=[[0,0.095],[12450,0.12],[20200,0.15],[35200,0.185],[60000,0.225],[300000,0.245]];
// Escalas AUTONÓMICAS. Editables desde la ficha: cambian con cada presupuesto
// autonómico y conviene comprobarlas el año que vayas a jubilarte de verdad.
const IRPF_AUTON={
  // v122 · CORREGIDA. La escala que había aquí (8,8 / 11,7 / 14,6 / 17 / 19,4...)
  // era de una versión anterior de la Ley 13/1997 y se quedaba corta en todos
  // los tramos. Contrastada casilla a casilla con la declaración de 2025:
  // base liquidable X → Y (casilla 0529) y mínimo → cuota
  // (casilla 0531). Las dos salen exactas con estos tipos.
  'Comunitat Valenciana':[[0,0.09],[12000,0.12],[22000,0.15],[32000,0.175],[42000,0.20],
    [52000,0.225],[62000,0.25],[72000,0.265],[100000,0.275],[150000,0.285],[200000,0.295]],
  'Región de Murcia':[[0,0.095],[12450,0.112],[20200,0.133],[34000,0.179],[60000,0.225]],
  'Madrid':[[0,0.085],[13362.22,0.107],[18004.20,0.128],[35425.68,0.176],[57320.40,0.205]],
  'Andalucía':[[0,0.095],[13000,0.12],[21000,0.15],[35200,0.186],[50000,0.225],[300000,0.2350]],
  'Cataluña':[[0,0.105],[12450,0.12],[17707.20,0.14],[21000,0.15],[33007.20,0.188],
    [53407.20,0.215],[90000,0.235],[120000,0.245],[175000,0.255]],
  'Escala estatal duplicada':[[0,0.095],[12450,0.12],[20200,0.15],[35200,0.185],[60000,0.225],[300000,0.245]]
};
// v169 · La escala autonómica cambia con los años. La valenciana bajó con la
// Ley 5/2026 de la Generalitat (31/7/2026, DOGV 10/8/2026) para TODO 2026 y
// vuelve a bajar en 2027. Cada escala rige desde su año; IRPF_AUTON es la de
// antes. Los mínimos autonómicos no cambian.
const IRPF_AUTON_ANIOS={
  'Comunitat Valenciana':[
    [2026,[[0,0.088],[12000,0.117],[22000,0.146],[32000,0.17],[42000,0.194],
      [52000,0.219],[62000,0.244],[72000,0.261],[100000,0.2735],[150000,0.2835],[200000,0.2935]]],
    [2027,[[0,0.087],[12000,0.116],[22000,0.145],[32000,0.169],[42000,0.193],
      [52000,0.218],[62000,0.243],[72000,0.26],[100000,0.2725],[150000,0.2825],[200000,0.2925]]]
  ]
};
// Hasta qué año están revisadas las tablas fiscales (escalas, ITP, AJD). Cada
// enero de un año posterior, «Te toca» avisa de que hay que repasarlas.
const TABLAS_FISCALES_ANIO=2026;
function escalaAuton(ccaa,anio){
  const y=Number(anio)||Number(todayISO().slice(0,4));
  const H=IRPF_AUTON_ANIOS[ccaa];
  if(H){ let e=null; H.forEach(([desde,esc])=>{ if(y>=desde)e=esc; }); if(e)return e; }
  return IRPF_AUTON[ccaa]||IRPF_AUTON['Escala estatal duplicada'];
}
// Mínimo del contribuyente — art. 57 LIRPF
const IRPF_MIN_BASE=5550, IRPF_MIN_65=1150, IRPF_MIN_75=1400;
// Mínimo por discapacidad del contribuyente — art. 60 LIRPF.
// Un pensionista con IPT reconocida tiene acreditado el 33% de oficio
// (art. 60.3 LIRPF): no hace falta certificado del IMSERSO.
const IRPF_MIN_DISC={0:0,33:3000,65:9000};
const IRPF_MIN_DISC_ASIST=3000;      // movilidad reducida o grado ≥65%
const IRPF_GASTOS=2000;              // art. 19.2.f
// Comunidades que suben su propio mínimo personal y familiar
const IRPF_MIN_AUTON_FACTOR={'Comunitat Valenciana':1.10};

function irpfEscalaCuota(base,escala){
  let c=0;
  for(let i=0;i<escala.length;i++){
    const desde=escala[i][0], tipo=escala[i][1];
    const hasta=(i+1<escala.length)?escala[i+1][0]:Infinity;
    if(base<=desde)break;
    c+=(Math.min(base,hasta)-desde)*tipo;
  }
  return c;
}
// Reducción del art. 20 LIRPF. A partir de cierto rendimiento se agota, así que
// con una pensión media no resta nada; se incluye por si el escenario es bajo.
// v169 · Con los tres tramos del art. 20 (RDL 4/2024, desde 2024). Antes
// faltaba el tercero y entre 17.673,52 € y 19.747,50 € restaba de menos.
function irpfRedTrabajo(rn){
  if(rn<=14852)return 7302;
  if(rn<=17673.52)return 7302-1.75*(rn-14852);
  if(rn<=19747.5)return Math.max(0,2364.34-1.14*(rn-17673.52));
  return 0;
}
function irpfCalc(brutoAnual,edad,opt){
  opt=opt||{};
  const escAut=escalaAuton(opt.ccaa,opt.anio);      // v169 · la del año del cálculo
  const bruto=Math.max(0,Number(brutoAnual)||0);
  // v114 · Un funcionario en activo deduce además sus cotizaciones (derechos
  // pasivos y MUFACE, art. 19.2.a) y, si tiene discapacidad reconocida, 3.500€
  // más de otros gastos (7.750€ con grado ≥65% o movilidad reducida,
  // art. 19.2.f). Ese incremento es SOLO para trabajadores activos: en cuanto
  // te jubilas desaparece, y por eso el neto de la pensión cae más de lo que
  // parece por la simple bajada del bruto.
  const cotiz=Math.max(0,Number(opt.cotizaciones)||0);
  const gastosExtra=Math.max(0,Number(opt.gastosExtra)||0);
  const gastos=IRPF_GASTOS+gastosExtra;
  const rnPrevio=Math.max(0,bruto-cotiz-gastos);
  const red=irpfRedTrabajo(rnPrevio);
  const baseLiq=Math.max(0,rnPrevio-red);
  // mínimo personal y familiar
  const disc=IRPF_MIN_DISC[opt.discapacidad||0]||0;
  const asist=opt.asistencia?IRPF_MIN_DISC_ASIST:0;
  let minEstatal=IRPF_MIN_BASE+((edad>=65)?IRPF_MIN_65:0)+((edad>=75)?IRPF_MIN_75:0)+disc+asist;
  const f=IRPF_MIN_AUTON_FACTOR[opt.ccaa]||1;
  const minAuton=minEstatal*f;
  const cuotaEst=Math.max(0,irpfEscalaCuota(baseLiq,IRPF_ESTATAL)-irpfEscalaCuota(Math.min(minEstatal,baseLiq),IRPF_ESTATAL));
  const cuotaAut=Math.max(0,irpfEscalaCuota(baseLiq,escAut)-irpfEscalaCuota(Math.min(minAuton,baseLiq),escAut));
  const cuota=cuotaEst+cuotaAut;
  const neto=bruto-cuota;
  return {bruto,cotiz,gastos,gastosExtra,red,baseLiq,minEstatal,minAuton,disc,asist,
    cuotaEst,cuotaAut,cuota,neto,
    tipoMedio:bruto>0?cuota/bruto:0,
    // marginal: lo que te costaría el siguiente euro
    marginal:(function(){const a=irpfEscalaCuota(baseLiq,IRPF_ESTATAL)+irpfEscalaCuota(baseLiq,escAut);
      const b=irpfEscalaCuota(baseLiq+100,IRPF_ESTATAL)+irpfEscalaCuota(baseLiq+100,escAut);
      return (b-a)/100;})()};
}
// ════════════════════════════════════════════════════════════════════
// v121 · PREVISIÓN AFINADA DE LA DECLARACIÓN DE LA RENTA
// ════════════════════════════════════════════════════════════════════
// Hasta v120 la previsión decía, en el fondo, "lo mismo que pagaste el año
// pasado". Eso ignora justo lo que más duele: NADIE retiene por las ventas
// de acciones. Vendes con plusvalía en mayo, cobras el importe entero, te
// lo gastas o lo reinviertes, y catorce meses después Hacienda te pasa la
// factura del 19-21% que nunca se apartó.
//
// Aquí se reconstruye la declaración completa con lo que la app ya sabe:
//   · nóminas cobradas + proyección de las que faltan hasta diciembre,
//     hecha por COMPONENTES (lo fijo se repite; lo variable —productividad,
//     pagas extra, atrasos— se estima por el mismo mes del año anterior)
//   · la IPT, que es rendimiento del trabajo de un SEGUNDO pagador: cada
//     pagador retiene como si fuera el único, y por eso siempre sale a pagar
//   · intereses y dividendos → base del ahorro
//   · ganancias y pérdidas por venta de acciones (FIFO) → base del ahorro
//   · las retenciones que ya te han practicado
// La diferencia es dinero que ya debes, aunque todavía esté en tu cuenta.

// Escala del ahorro. El tramo superior subió al 30% con la Ley 7/2024.
const IRPF_AHORRO=[[0,0.19],[6000,0.21],[50000,0.23],[200000,0.27],[300000,0.30]];

// Componentes de nómina que se cobran todos los meses. Todo lo demás
// (productividad, pagas extra, atrasos, regularizaciones) es variable.
const NOM_FIJOS=/sueldo base|trienio|complemento destino|complemento espec|objetivos a cuenta/;
// Atrasos que vienen de una sentencia o de varios años: candidatos a la
// reducción del 30% por rendimiento irregular (art. 18.2 LIRPF).
const NOM_IRREGULAR=/sent(encia|\.)|retroactiv|atrasos? de (19|20)\d\d/;

function fiscalNorm(s){
  return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
}
// Descompone una nómina en lo que se repite y lo que no.
function fiscalNomPartes(n){
  const nd=n.nd||{}, dev=nd.devengos||[];
  let fijo=0, varia=0, irreg=0;
  dev.forEach(c=>{
    const a=Number(c.amount)||0, nm=fiscalNorm(c.name);
    if(NOM_FIJOS.test(nm)) fijo+=a; else varia+=a;
    if(NOM_IRREGULAR.test(nm)) irreg+=a;
  });
  if(!dev.length) fijo=Number(nd.total_dev)||0;   // nómina sin desglose
  const irpf=Number(nd.irpf_importe)||0;
  const cot=Math.max(0,(Number(nd.total_ded)||0)-irpf);   // MUFACE + derechos pasivos
  return {fijo,varia,irreg,total:fijo+varia,irpf,cot,pct:Number(nd.irpf_pct)||0};
}

// ── Rendimientos del trabajo: nóminas reales + proyección ────────────
// La proyección no extrapola el total del mes (que sube y baja con las
// extras): repite lo fijo y estima lo variable con el mismo mes del año
// anterior, reescalado por lo que ha subido el sueldo. Así diciembre sale
// con su paga extra y noviembre no.
function fiscalTrabajo(anio){
  anio=Number(anio);
  const H=(typeof NOM_HIST==='function')?NOM_HIST():[];
  const delAnio=y=>H.filter(n=>String(n.ym||n.date||'').slice(0,4)===String(y));
  const est=delAnio(anio).slice().sort((a,b)=>String(a.ym).localeCompare(String(b.ym)));
  const ant=delAnio(anio-1);
  if(!est.length&&!ant.length)return null;

  let real=0, retReal=0, cotReal=0, irregReal=0;
  let fijoUlt=0, ymUlt='', pctUlt=0, ymPct='';
  const mesesConDato=new Set();
  est.forEach(n=>{
    const P=fiscalNomPartes(n), mm=String(n.ym||'').slice(5,7);
    real+=P.total; retReal+=P.irpf; cotReal+=P.cot; irregReal+=P.irreg;
    if(mm)mesesConDato.add(mm);
    if(P.fijo>0&&String(n.ym)>=ymUlt){ fijoUlt=P.fijo; ymUlt=String(n.ym); }
    if(P.pct>0&&P.fijo>0&&String(n.ym)>=ymPct){ pctUlt=P.pct; ymPct=String(n.ym); }
  });
  // Agrupa el año anterior por mes para tener el patrón estacional
  const patron={};
  ant.forEach(n=>{
    const mm=String(n.ym||'').slice(5,7); if(!mm)return;
    const P=fiscalNomPartes(n);
    const p=patron[mm]=patron[mm]||{fijo:0,varia:0,cot:0};
    p.fijo+=P.fijo; p.varia+=P.varia; p.cot+=P.cot;
  });
  const hoy=todayISO();
  const anioHoy=Number(hoy.slice(0,4));
  const cerrado=anio<anioHoy;
  let proy=0, cotProy=0, retProy=0;
  const detProy=[];
  if(!cerrado&&fijoUlt>0){
    for(let m=1;m<=12;m++){
      const mm=String(m).padStart(2,'0');
      if(mesesConDato.has(mm))continue;
      const p=patron[mm];
      const factor=(p&&p.fijo>0)?fijoUlt/p.fijo:1;
      const varia=p?p.varia*factor:0;
      const cot=(p&&p.cot>0)?p.cot*factor:0;
      const tot=fijoUlt+varia;
      proy+=tot; cotProy+=cot;
      detProy.push({mes:mm,fijo:fijoUlt,varia,total:tot,
        base:p?('como '+mm+'/'+(anio-1)):'solo lo fijo'});
    }
    retProy=proy*(pctUlt/100);
  }
  return {anio,real,proy,total:real+proy,
    cot:cotReal+cotProy, cotReal, cotProy,
    ret:retReal+retProy, retReal, retProy, pct:pctUlt,
    irreg:irregReal, meses:mesesConDato.size, detProy, cerrado,
    ultimoMes:ymUlt};
}

// ── IPT: segundo pagador, 12 mensualidades sin extras ────────────────
function fiscalIPT(anio){
  anio=Number(anio);
  const L=(typeof incomeLog!=='undefined'?incomeLog:[])
    .filter(x=>x.cat==='ipt'&&String(x.date||'').slice(0,4)===String(anio))
    .sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const cobrado=L.reduce((s,x)=>s+(Number(x.amt)||0),0);
  const hoy=todayISO();
  const cerrado=anio<Number(hoy.slice(0,4));
  const ult=L.length?(Number(L[L.length-1].amt)||0):0;
  const pagas=(typeof iptNumPagas==='function')?iptNumPagas():14;
  const restantes=cerrado?0:Math.max(0,pagas-L.length);
  return {cobrado,n:L.length,ult,proy:ult*restantes,total:cobrado+ult*restantes,cerrado};
}

// ── Rendimientos del capital mobiliario ──────────────────────────────
// Solo 'rend' (intereses) y 'dividendo'. 'otro2' son bizums y devoluciones:
// no son renta y meterlos aquí inflaría la factura.
// v169 · Los apuntes de XTB y del estado de cuenta de DEGIRO traen el bruto
// (bruto), la retención española (ret) y la del país de la empresa (retExt).
// Lo que cuenta para Hacienda es el BRUTO. La retención española se descuenta
// tal cual; la extranjera no es española: da derecho a la deducción por doble
// imposición internacional, como mucho el 15 % del bruto (lo que fijan los
// convenios). Los apuntes sin ese detalle (los intereses que llegan por el
// banco) siguen como antes: se supone la retención del 19 %. Solo se proyecta
// el resto del año para los intereses, que llegan cada mes.
function fiscalCapMob(anio){
  anio=Number(anio);
  const L=(typeof incomeLog!=='undefined'?incomeLog:[])
    .filter(x=>(x.cat==='rend'||x.cat==='dividendo')&&String(x.date||'').slice(0,4)===String(anio));
  const bruto=x=>Number(x.bruto!=null?x.bruto:x.amt)||0;
  const cobrado=L.reduce((s,x)=>s+bruto(x),0);
  const R=L.filter(x=>x.cat==='rend');
  const cobR=R.reduce((s,x)=>s+bruto(x),0);
  const meses=new Set(R.map(x=>String(x.date).slice(5,7))).size;
  const hoy=todayISO();
  const cerrado=anio<Number(hoy.slice(0,4));
  const proy=(!cerrado&&meses>0&&meses<12)?cobR/meses*(12-meses):0;
  let retEs=0, retExt=0, ddi=0, sinDato=0, div=0;
  L.forEach(x=>{
    const b=bruto(x); if(x.cat==='dividendo')div+=b;
    if(x.ret==null&&x.retExt==null){ sinDato+=b; return; }
    retEs+=Math.abs(Number(x.ret)||0);
    const re=Math.abs(Number(x.retExt)||0);
    retExt+=re; ddi+=Math.min(re,b*0.15);
  });
  return {cobrado,proy,total:cobrado+proy,n:L.length,meses,cerrado,dividendos:div,retEs,retExt,ddi,sinDato};
}

// ── Ganancias y pérdidas por venta de acciones ───────────────────────
function fiscalGanancias(anio){
  anio=String(anio);
  if(typeof recomputeAllStockGains==='function'){try{recomputeAllStockGains();}catch(e){fallo('recomputeAllStockGains',e)}}
  const ops=(typeof transactions!=='undefined'?transactions:[])
    .filter(t=>t.type==='sell'&&String(t.date||'').slice(0,4)===anio&&t.gainLoss!=null)
    .map(t=>({date:t.date,
      nombre:t.stockName||((cfg.stocks||[]).find(s=>s.id===t.stockId)||{}).name||t.stockId||'?',
      importe:Number(t.total)||0, coste:Number(t.costBasis)||0,
      // v169 · lo que cuenta para Hacienda, con la regla de los dos meses
      real:Number(t.gainLoss)||0, aplazada:Number(t.perdidaAplazada)||0, integrada:Number(t.perdidaIntegrada)||0,
      pl:Math.round(((Number(t.gainLoss)||0)+(Number(t.perdidaAplazada)||0)+(Number(t.perdidaIntegrada)||0))*100)/100}))
    .sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const gan=ops.filter(o=>o.pl>0).reduce((s,o)=>s+o.pl,0);
  const per=ops.filter(o=>o.pl<0).reduce((s,o)=>s+o.pl,0);
  const aplazadas=ops.reduce((s,o)=>s+o.aplazada,0), integradas=ops.reduce((s,o)=>s+o.integrada,0);
  return {ops,gan,per,neto:gan+per,n:ops.length,aplazadas,integradas};
}

// ── La declaración entera ────────────────────────────────────────────
function fiscalRenta(anio,opt){
  anio=Number(anio); opt=opt||{};
  const T=fiscalTrabajo(anio);
  if(!T||T.total<=0)return null;
  const I=fiscalIPT(anio), K=fiscalCapMob(anio), G=fiscalGanancias(anio);
  const pc=(typeof pensionCfg==='function')?pensionCfg():{};
  const fc=(typeof fiscalCfg==='function')?fiscalCfg():{};
  const ccaa=pc.ccaa||'Comunitat Valenciana';
  const escAut=escalaAuton(ccaa,anio);              // v169 · la de ese ejercicio
  const disc=(opt.disc!=null)?Number(opt.disc):(Number(pc.discapacidad)||0);
  // edad a 31 de diciembre del ejercicio
  let edad=0;
  if(pc.nacimientoFecha){
    edad=anio-Number(String(pc.nacimientoFecha).slice(0,4));
  }

  // ── Base imponible general ──
  const trabIntegro=T.total+I.total;
  // Reducción del 30% por rendimiento irregular (art. 18.2). No se aplica
  // sola: hay que pedirla. Por eso viene desactivada y se ve lo que ahorra.
  const irregBase=Math.min(T.irreg,300000);
  const redIrreg=fc.irregular?irregBase*0.30:0;
  const cotiz=T.cot;
  // art. 19.2.f: 3.500 € más de gastos si eres trabajador ACTIVO con
  // discapacidad ≥33% (7.750 € con ≥65% o movilidad reducida). Desaparece
  // en cuanto te jubilas.
  const gastoDisc=disc>=65?7750:(disc>=33?3500:0);
  const gastos=IRPF_GASTOS+gastoDisc;
  const rnPrevio=Math.max(0,trabIntegro-redIrreg-cotiz-gastos);
  const redTrab=irpfRedTrabajo(rnPrevio);
  const baseGen=Math.max(0,rnPrevio-redTrab);

  // ── Base imponible del ahorro ──
  // art. 49: si las pérdidas superan a las ganancias, el exceso compensa
  // hasta el 25% del saldo positivo de rendimientos; el resto, 4 años.
  const rcm=Math.max(0,K.total), gp=G.neto;
  let baseAho, gpPendiente=0;
  if(gp>=0){ baseAho=rcm+gp; }
  else{
    const compens=Math.min(-gp,rcm*0.25);
    baseAho=Math.max(0,rcm-compens);
    gpPendiente=gp+compens;
  }

  // ── Mínimo personal y familiar ──
  // Reduce primero la base general; lo que sobre, la del ahorro (art. 56/66).
  const minEst=IRPF_MIN_BASE+(IRPF_MIN_DISC[disc]||0)+
    ((edad>=65)?IRPF_MIN_65:0)+((edad>=75)?IRPF_MIN_75:0);
  const fAut=IRPF_MIN_AUTON_FACTOR[ccaa]||1;
  const minAut=minEst*fAut;
  const minGenEst=Math.min(minEst,baseGen), minGenAut=Math.min(minAut,baseGen);
  const minAhoEst=Math.min(Math.max(0,minEst-minGenEst),baseAho);
  const minAhoAut=Math.min(Math.max(0,minAut-minGenAut),baseAho);

  const cuotaGen=Math.max(0,irpfEscalaCuota(baseGen,IRPF_ESTATAL)-irpfEscalaCuota(minGenEst,IRPF_ESTATAL))
                +Math.max(0,irpfEscalaCuota(baseGen,escAut)-irpfEscalaCuota(minGenAut,escAut));
  const minAhoMedio=(minAhoEst+minAhoAut)/2;
  const cuotaAho=Math.max(0,irpfEscalaCuota(baseAho,IRPF_AHORRO)-irpfEscalaCuota(minAhoMedio,IRPF_AHORRO));
  // ── Deducciones autonómicas ──
  // La app no puede deducirlas de tus movimientos (gastos de salud, alquiler,
  // donativos, material escolar...), pero si el año pasado las hubo lo normal
  // es que se repitan. Se arrastra la del último ejercicio declarado.
  const declPrev=(typeof fiscalDecl==='function')?fiscalDecl(anio-1):null;
  const deducAut=(fc.deducAuton!=null)?(Number(fc.deducAuton)||0)
    :((declPrev&&isFinite(Number(declPrev.deducAut)))?Number(declPrev.deducAut):0);
  const cuotaBruta=cuotaGen+cuotaAho;
  // v169 · deducción por doble imposición internacional: lo que retuvo el país
  // del dividendo, hasta el 15 % de su bruto y sin pasar de la cuota del ahorro
  const ddi=Math.min(Number(K.ddi)||0,cuotaAho);
  const cuota=Math.max(0,cuotaBruta-deducAut-ddi);

  // ── Cuánto de la factura viene SOLO por vender acciones ──
  // Se calcula por diferencia: la misma declaración sin esas ventas.
  const baseAhoSin=rcm;
  const minAhoSin=Math.min(minAhoMedio,baseAhoSin);
  const cuotaAhoSin=Math.max(0,irpfEscalaCuota(baseAhoSin,IRPF_AHORRO)-irpfEscalaCuota(minAhoSin,IRPF_AHORRO));
  const porVentas=Math.max(0,cuotaAho-cuotaAhoSin);

  // ── Retenciones ──
  const retIPT=I.total*((Number(fc.iptRetPct)||0)/100);
  // v169 · la retención española que de verdad consta; si un apunte no dice
  // nada (los intereses de siempre), se supone la del 19 %
  const retCap=(Number(K.retEs)||0)+((Number(K.sinDato)||0)+(Number(K.proy)||0))*((fc.capRetPct==null?19:Number(fc.capRetPct)||0)/100);
  const retenciones=T.ret+retIPT+retCap;
  const resultado=cuota-retenciones;

  // Fecha de pago y cuánto hay que apartar cada mes hasta entonces
  const fechaPago=(anio+1)+'-06-30';
  const hoy=todayISO();
  const mesesHasta=Math.max(1,Math.round((Date.parse(fechaPago)-Date.parse(hoy))/864e5/30.44));

  return {anio,T,I,K,G,ccaa,disc,edad,
    trabIntegro,irregBase,redIrreg,cotiz,gastos,gastoDisc,redTrab,baseGen,
    rcm,gp,baseAho,gpPendiente,
    minEst,minAut,minGenEst,minAhoEst:minAhoMedio,
    cuotaGen,cuotaAho,cuotaBruta,deducAut,deducAutHeredada:(fc.deducAuton==null&&deducAut>0),ddi,cuota,porVentas,
    retenciones,retTrab:T.ret,retIPT,retCap,
    resultado,fechaPago,mesesHasta,
    apartarMes:resultado>0?resultado/mesesHasta:0,
    tipoMedio:trabIntegro+baseAho>0?cuota/(trabIntegro+rcm+Math.max(0,gp)):0,
    dosPagadores:(T.total>0&&I.total>0)};
}

// Años cuya declaración todavía está por pagar: la del ejercicio en curso
// (se paga en junio del siguiente) y, si aún no ha pasado el 30 de junio,
// la del ejercicio anterior.
function fiscalAniosPendientes(){
  const hoy=todayISO();
  const y=Number(hoy.slice(0,4)), out=[y];
  if(hoy.slice(5)<'07-01')out.unshift(y-1);
  return out;
}




// ════════════════════════════════════════════════════════════════════
// v123 · PAGAS DE LA IPT QUE FALTAN POR REGISTRAR
// ════════════════════════════════════════════════════════════════════
// La IPT del Régimen General se cobra en 14 pagas: una al mes más dos
// extraordinarias, en junio y en noviembre (art. 46 RD 2530/1970 y práctica
// del INSS). Los extractos del banco a veces no llegan a importarse enteros,
// y entonces desaparecen pagas que sí se cobraron.
//
// Esto no es un detalle estético. El cotejo con la declaración de 2025 lo
// destapó: la casilla 0003 decía X € y la app solo tenía Y €.
// El hueco, X €, son exactamente NUEVE pagas de Y €. Renta que
// entró en la cuenta, que Hacienda tiene fichada, y que aquí no estaba: la
// tasa de ahorro salía más baja de lo real y la previsión de la renta se
// quedaba corta por el mismo importe.
function iptNumPagas(){
  const fc=(typeof fiscalCfg==='function')?fiscalCfg():{};
  if(fc.iptPagas!=null)return Number(fc.iptPagas)||14;
  const pc=(typeof pensionCfg==='function')?pensionCfg():{};
  return Number(pc.iptPagas)||14;
}
// El calendario del año: un cobro cada mes y, si son 13 o 14 pagas, las
// extraordinarias de junio y noviembre.
function iptCalendario(){
  const pagas=iptNumPagas(), n={};
  for(let m=1;m<=12;m++)n[String(m).padStart(2,'0')]=1;
  if(pagas>=13)n['06']=2;
  if(pagas>=14)n['11']=2;
  return n;
}
function _moda(a){
  const c={}; let mejor=null,max=0;
  a.forEach(v=>{c[v]=(c[v]||0)+1; if(c[v]>max){max=c[v];mejor=v;}});
  return mejor==null?0:Number(mejor);
}
function _mediana(a){
  if(!a.length)return 22;
  const s=a.slice().sort((x,y)=>x-y);
  return s[Math.floor(s.length/2)];
}
// Qué pagas faltan de un año. Solo mira meses que ya han pasado: lo que
// todavía no ha llegado no falta, está por llegar.
function iptFaltantes(anio){
  anio=Number(anio);
  const hoy=todayISO();
  const L=(typeof incomeLog!=='undefined'?incomeLog:[])
    .filter(x=>x.cat==='ipt'&&String(x.date||'').slice(0,4)===String(anio));
  if(!L.length)return null;   // sin ninguna referencia del año no se inventa nada
  const importe=_moda(L.map(x=>Math.round((Number(x.amt)||0)*100)/100));
  const dia=_mediana(L.map(x=>Number(String(x.date).slice(8,10))||22));
  if(!importe)return null;
  const hay={};
  L.forEach(x=>{const m=String(x.date).slice(5,7); hay[m]=(hay[m]||0)+1;});
  const esp=iptCalendario(), falta=[];
  Object.keys(esp).sort().forEach(m=>{
    const fecha=anio+'-'+m+'-'+String(dia).padStart(2,'0');
    if(fecha>hoy)return;                       // aún no le toca
    for(let i=(hay[m]||0);i<esp[m];i++){
      falta.push({mes:m,fecha,importe,extra:i>0});
    }
  });
  return {anio,falta,importe,dia,registradas:L.length,
    total:Math.round(falta.reduce((s,f)=>s+f.importe,0)*100)/100};
}
// Todos los años con pagas pendientes de anotar
function iptFaltantesTodos(){
  const anios=[...new Set((typeof incomeLog!=='undefined'?incomeLog:[])
    .filter(x=>x.cat==='ipt').map(x=>String(x.date||'').slice(0,4)))].filter(Boolean).sort();
  return anios.map(a=>iptFaltantes(a)).filter(f=>f&&f.falta.length);
}
function iptAnotar(anio){
  const F=iptFaltantes(anio);
  if(!F||!F.falta.length){ toast('No falta ninguna paga de '+anio); return; }
  const lista=F.falta.map(f=>'  · '+fmtDate(f.fecha)+(f.extra?'  (paga extra)':'')+'   '+fmt2(f.importe)+'€').join('\n');
  if(!confirm('Se van a anotar '+F.falta.length+' pagas de tu IPT de '+anio+
    ', '+fmt2(F.total)+'€ en total:\n\n'+lista+
    '\n\nSon pagas que cobraste y que no están en la app. Cambiarán tu tasa de ahorro de ese año '+
    'y la previsión de la renta.\n\n¿Las anoto?'))return;
  if(!guardedAction('anotar '+F.falta.length+' pagas de la IPT de '+anio))return;
  F.falta.forEach((f,i)=>{
    incomeLog.push({
      id:'ipt_'+anio+'_'+f.mes+'_'+(f.extra?'x':'m')+'_'+i,
      date:f.fecha, ym:f.fecha.slice(0,7), cat:'ipt',
      amt:f.importe,
      desc:'PRESTACIONES SEGURIDAD SOCIAL'+(f.extra?' · paga extra':'')+' · anotada al cotejar con la declaración'
    });
  });
  save(); renderAll();
  toast(F.falta.length+' pagas anotadas · '+fmt2(F.total)+'€');
}

function iptAvisoHTML(){
  let T=[];
  try{ T=iptFaltantesTodos(); }catch(e){ console.warn('iptFaltantes',e); return ''; }
  if(!T.length)return '';
  const e2=v=>fmt2(Math.round(v*100)/100)+'€';
  const total=T.reduce((s,f)=>s+f.total,0);
  const nPagas=T.reduce((s,f)=>s+f.falta.length,0);
  let h='<div style="background:#FFF6E0;border:1px solid #E8C97A;border-radius:6px;padding:.55rem .65rem;'+
    'font-size:11.5px;color:var(--amber);margin-bottom:.6rem">'+
    '<strong>Faltan '+nPagas+' pagas de tu IPT: '+e2(total)+'.</strong> '+
    'Se cobra en '+iptNumPagas()+' pagas (una al mes más las extras de junio y noviembre) y en la app '+
    'no están todas. Es dinero que entró en tu cuenta: mientras no esté, tu tasa de ahorro sale más '+
    'baja de lo que fue y la previsión de la renta se queda corta.'+
    '<div style="margin-top:.4rem;display:flex;flex-wrap:wrap;gap:.4rem;align-items:center">';
  T.forEach(f=>{
    h+='<button type="button" class="btn-xs" onclick="iptAnotar('+f.anio+')">'+
      'Anotar las '+f.falta.length+' de '+f.anio+' ('+e2(f.total)+')</button>';
  });
  h+='</div>'+
    '<div style="color:var(--muted);margin-top:.35rem">'+
    T.map(f=>f.anio+': faltan '+f.falta.map(x=>fmtDate(x.fecha)+(x.extra?' (extra)':'')).join(', ')).join(' · ')+
    '</div></div>';
  return h;
}

// ════════════════════════════════════════════════════════════════════
// v122 · COTEJO CON LA DECLARACIÓN PRESENTADA
// ════════════════════════════════════════════════════════════════════
// La v121 intentaba adivinar si la declaración cuadraba comparando el
// resultado con lo que se pagó, y se equivocó de mala manera: concluyó que
// no se había aplicado la discapacidad cuando sí se había aplicado. El
// error real estaba en otro sitio (la escala autonómica) y en que a la app
// le faltaban ingresos.
//
// Adivinar no sirve. Lo que sirve es coger el PDF del modelo 100, meter
// las casillas y cotejarlas una a una con lo que tiene la app. Entonces
// aparecen dos cosas distintas, y las dos importan:
//   · casillas que no cuadran → a la app le falta o le sobra información
//   · el motor recalculado desde las casillas reales → si sale el mismo
//     resultado que Hacienda, la previsión del año en curso es fiable
const DECL_CASILLAS=[
  {k:'trabajo',   c:'0003', l:'Retribuciones dinerarias del trabajo', app:'trabajo'},
  {k:'cotiz',     c:'0013', l:'Cotizaciones (SS, MUFACE, derechos pasivos)', app:'cotiz'},
  {k:'gastos',    c:'0019', l:'Otros gastos deducibles'},
  {k:'gastoDisc', c:'0021', l:'Gastos por trabajador activo con discapacidad'},
  {k:'capmob',    c:'0027', l:'Intereses de cuentas y depósitos', app:'capmob'},
  {k:'ganancias', c:'0339', l:'Ganancias por transmisión de acciones', app:'ganancias'},
  {k:'minEst',    c:'0519', l:'Mínimo personal y familiar (estatal)'},
  {k:'minAut',    c:'0520', l:'Mínimo personal y familiar (autonómico)'},
  {k:'deducAut',  c:'0564', l:'Deducciones autonómicas'},
  {k:'retTrab',   c:'0596', l:'Retenciones del trabajo', app:'retTrab'},
  {k:'retCap',    c:'0597', l:'Retenciones del capital mobiliario'},
  {k:'resultado', c:'0670', l:'Resultado de la declaración'}
];
// v169 · Tu declaración ya presentada vive en tus datos (fiscal.decl): se apunta
// en «Cotejo con la declaración» y viaja en tus copias. Ya no va precargada en
// el código, que es público.
const DECL_SEED={};

function fiscalDecls(){
  const c=fiscalCfg();
  if(!c.decl){ c.decl=JSON.parse(JSON.stringify(DECL_SEED)); }
  return c.decl;
}
function fiscalDecl(anio){ return fiscalDecls()[String(anio)]||null; }
function setDeclCas(anio,k,v){
  const D=fiscalDecls();
  D[String(anio)]=D[String(anio)]||{};
  const n=String(v).trim().replace(/\./g,'').replace(',','.');
  D[String(anio)][k]=(n===''?null:(Number(n)||0));
  save(); renderAll();
}
function declAdd(){
  const a=prompt('¿De qué ejercicio quieres meter las casillas del modelo 100?',
    String(new Date().getFullYear()-1));
  if(!a||!/^\d{4}$/.test(a.trim()))return;
  const D=fiscalDecls();
  if(!D[a.trim()])D[a.trim()]={};
  save(); renderAll();
}

// Recalcula la declaración PARTIENDO de las casillas declaradas. Si esto da
// lo mismo que Hacienda, el motor es correcto y lo que falla (si falla) son
// los datos que tiene la app.
function irpfDesdeCasillas(D,ccaa,anio){
  const escAut=escalaAuton(ccaa,anio);
  const n=k=>Number(D[k])||0;
  const rnPrevio=Math.max(0,n('trabajo')-n('cotiz')-n('gastos')-n('gastoDisc'));
  const baseGen=Math.max(0,rnPrevio-irpfRedTrabajo(rnPrevio));
  const baseAho=Math.max(0,n('capmob')+n('ganancias'));
  const minE=n('minEst'), minA=n('minAut');
  const minGenE=Math.min(minE,baseGen), minGenA=Math.min(minA,baseGen);
  const minAhoE=Math.min(Math.max(0,minE-minGenE),baseAho);
  const minAhoA=Math.min(Math.max(0,minA-minGenA),baseAho);
  const cuotaGenE=Math.max(0,irpfEscalaCuota(baseGen,IRPF_ESTATAL)-irpfEscalaCuota(minGenE,IRPF_ESTATAL));
  const cuotaGenA=Math.max(0,irpfEscalaCuota(baseGen,escAut)-irpfEscalaCuota(minGenA,escAut));
  // el gravamen del ahorro va al 50% estatal y 50% autonómico
  const cuotaAhoE=Math.max(0,irpfEscalaCuota(baseAho,IRPF_AHORRO)-irpfEscalaCuota(minAhoE,IRPF_AHORRO))/2;
  const cuotaAhoA=Math.max(0,irpfEscalaCuota(baseAho,IRPF_AHORRO)-irpfEscalaCuota(minAhoA,IRPF_AHORRO))/2;
  const intE=cuotaGenE+cuotaAhoE, intA=cuotaGenA+cuotaAhoA;
  const liq=intE+Math.max(0,intA-n('deducAut'));
  const pagos=n('retTrab')+n('retCap');
  return {baseGen,baseAho,cuotaGenE,cuotaGenA,cuotaAhoE,cuotaAhoA,
    intEstatal:intE,intAutonomica:intA,cuotaLiquida:liq,pagos,resultado:liq-pagos};
}

// Lo que la app cree que pasó ese año, en las mismas magnitudes.
function fiscalSegunApp(anio){
  const T=fiscalTrabajo(anio), I=fiscalIPT(anio), K=fiscalCapMob(anio), G=fiscalGanancias(anio);
  if(!T)return null;
  return {trabajo:T.total+I.total, cotiz:T.cot, capmob:K.total,
    ganancias:Math.max(0,G.neto), retTrab:T.ret,
    _T:T,_I:I,_K:K,_G:G};
}

function fiscalCotejo(anio){
  const D=fiscalDecl(anio);
  if(!D)return null;
  const A=fiscalSegunApp(anio);
  const pc=(typeof pensionCfg==='function')?pensionCfg():{};
  const ccaa=pc.ccaa||'Comunitat Valenciana';
  const R=irpfDesdeCasillas(D,ccaa,anio);
  const decl=Number(D.resultado);
  const filas=DECL_CASILLAS.filter(f=>f.app&&A).map(f=>{
    const d=Number(D[f.k]);
    const a=Number(A[f.app]);
    return {...f, decl:d, app:a,
      dif:(isFinite(d)&&isFinite(a))?a-d:null};
  });
  return {anio,D,A,R,decl,filas,
    motorOk:isFinite(decl)?Math.abs(R.resultado-decl)<=1:null,
    desvioMotor:isFinite(decl)?R.resultado-decl:null};
}


// Una diferencia sola no dice nada; una diferencia que es un múltiplo exacto
// de una paga sí. Aquí se busca ese tipo de coincidencia, que es la que
// convierte "no cuadra" en "te falta esto concreto".
function cotejoPista(f,C){
  const A=C.A; if(!A)return '';
  const e2=v=>fmt2(Math.round(Math.abs(v)*100)/100)+'€';
  if(f.k==='trabajo'&&f.dif<0&&A._I&&A._I.ult>0){
    const n=Math.abs(f.dif)/A._I.ult;
    if(Math.abs(n-Math.round(n))<0.01&&Math.round(n)>=1){
      return ' — son <strong>'+Math.round(n)+' pagas exactas de '+e2(A._I.ult)+'</strong> de tu IPT. '+
        'Encaja con el atrasado que se cobra cuando se reconoce la incapacidad con efectos retroactivos: '+
        'Hacienda lo tiene, tu cuenta lo recibió y la app no lo registró.';
    }
    return ' — revisa si hubo atrasos, un finiquito o un pagador que no está en la app.';
  }
  if(f.k==='capmob'&&f.dif>0){
    return ' — mira de qué entidad viene cada apunte: si alguno es de un bróker extranjero, '+
      'Hacienda no lo tiene fichado y habría que declararlo igualmente.';
  }
  if(f.k==='ganancias'){
    return ' — Hacienda toma el importe bruto de la transmisión y suma los gastos al valor de '+
      'adquisición; la app resta las comisiones de la venta. La diferencia es de céntimos.';
  }
  return '';
}

function cotejoHTML(){
  const D=fiscalDecls();
  const anios=Object.keys(D).sort().reverse();
  if(!anios.length)return '';
  const e2=v=>fmt2(Math.round((Number(v)||0)*100)/100)+'€';
  let h='';
  anios.forEach(a=>{
    const C=fiscalCotejo(a);
    if(!C)return;
    h+=cotejoUnAnio(C,e2);
  });
  h+='<div style="text-align:right;margin-bottom:.6rem">'+
    '<button type="button" class="btn-xs" onclick="declAdd()">+ Meter otra declaración</button></div>';
  return h;
}

function cotejoUnAnio(C,e2){
  const id='cot-'+C.anio;
  const inp=(k,v)=>'<input type="text" inputmode="decimal" style="width:88px;font-size:11px;padding:1px 4px;text-align:right" '+
    'value="'+(v==null||!isFinite(v)?'':fmt2(v))+'" onchange="setDeclCas(\''+C.anio+'\',\''+k+'\',this.value)">';
  // ¿hay casillas que no cuadran con lo que tiene la app?
  const desajustes=C.filas.filter(f=>f.dif!=null&&Math.abs(f.dif)>1);
  const faltan=desajustes.filter(f=>f.dif<0);

  let h='<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:.7rem">';
  h+='<div class="coll-head" onclick="toggleColl(\''+id+'\')" style="padding:.5rem .7rem;background:var(--surface2)">'+
    '<span style="font-size:12px;font-weight:700">Cotejo con la declaración de '+C.anio+' que presentaste'+
    (desajustes.length?' <span style="color:var(--amber);font-weight:400">· '+desajustes.length+
      ' casilla(s) no cuadran con la app</span>':' <span style="color:var(--teal);font-weight:400">· todo cuadra</span>')+
    '</span><span class="coll-arr" id="'+id+'-arr">▾</span></div>';
  h+='<div id="'+id+'" style="display:none;padding:.55rem .7rem">';

  // 1. ¿El motor reproduce la declaración?
  if(C.motorOk!=null){
    h+='<div style="background:'+(C.motorOk?'#E8F5F0':'#FFF6E0')+';border:1px solid '+
      (C.motorOk?'#8FCBB8':'#E8C97A')+';border-radius:6px;padding:.5rem .6rem;font-size:11.5px;margin-bottom:.6rem">'+
      '<strong>'+(C.motorOk?'El motor reproduce tu declaración.':'El motor no cuadra con tu declaración.')+'</strong> '+
      'Partiendo de tus casillas, este cálculo da <strong>'+e2(C.R.resultado)+'</strong> y la declaración dice <strong>'+
      e2(C.decl)+'</strong>'+(C.motorOk?' — al céntimo.':' ('+(C.desvioMotor>=0?'+':'−')+e2(Math.abs(C.desvioMotor))+' de desvío).')+
      (C.motorOk?' Con lo cual, la previsión de arriba usa las mismas escalas y mínimos que usó Hacienda contigo: '+
        'lo que no case será porque falten datos en la app, no porque el cálculo esté mal.':'')+
      '</div>';
  }

  // 2. Casilla a casilla: declaración vs app
  h+='<table class="detail-table" style="font-size:11.5px;width:100%">'+
    '<thead><tr><th style="text-align:left">Casilla</th><th style="text-align:right">Declaración</th>'+
    '<th style="text-align:right">La app</th><th style="text-align:right">Diferencia</th></tr></thead><tbody>';
  DECL_CASILLAS.forEach(f=>{
    const fila=C.filas.find(x=>x.k===f.k);
    const dv=C.D[f.k];
    const cuadra=fila&&fila.dif!=null&&Math.abs(fila.dif)<=1;
    h+='<tr><td style="text-align:left">'+f.l+
      '<div style="font-size:9.5px;color:var(--faint)">casilla '+f.c+'</div></td>'+
      '<td style="text-align:right">'+inp(f.k,dv)+'</td>'+
      '<td style="text-align:right">'+(fila&&isFinite(fila.app)?e2(fila.app):
        '<span style="color:var(--faint)">—</span>')+'</td>'+
      '<td style="text-align:right;white-space:nowrap;font-weight:600;color:'+
        (fila&&fila.dif!=null?(cuadra?'var(--teal)':'var(--amber)'):'var(--faint)')+'">'+
        (fila&&fila.dif!=null?(cuadra?'cuadra ✓':(fila.dif>0?'+':'−')+e2(Math.abs(fila.dif))):'—')+
      '</td></tr>';
  });
  h+='</tbody></table>';

  // 3. Qué significan los desajustes
  if(desajustes.length){
    h+='<div style="margin-top:.5rem;font-size:11px;background:var(--surface2);border-radius:6px;padding:.5rem .6rem">'+
      '<strong>Qué hacer con esto.</strong> La columna "diferencia" es <em>app menos declaración</em>. '+
      'En negativo, a la app le falta dinero que Hacienda sí tiene fichado: casi siempre un ingreso que '+
      'nunca llegó a apuntarse, y que además está falseando tu tasa de ahorro. En positivo hay dos '+
      'lecturas posibles y conviene distinguirlas: o la app cuenta algo que no es renta, o esa renta '+
      'existió y no se declaró.'+
      '<ul style="margin:.3rem 0 0 1rem;padding:0">'+
      desajustes.map(f=>'<li style="margin-bottom:.15rem">'+f.l+': '+
        (f.dif<0?'faltan <strong>'+e2(-f.dif)+'</strong> en la app'
                :'sobran <strong>'+e2(f.dif)+'</strong> en la app')+
        (cotejoPista(f,C)||'')+'</li>').join('')+
      '</ul>'+
      (faltan.length?'<div style="margin-top:.35rem;color:var(--muted)">Mientras no se corrija, la '+
        'previsión del año en curso se queda corta por lo mismo que se quedó corta aquí.</div>':'')+
      '</div>';
  }
  if(C.D.nota){
    h+='<div style="margin-top:.4rem;font-size:10px;color:var(--faint)">'+escapeHtml(C.D.nota)+'</div>';
  }
  h+='</div></div>';
  return h;
}

// ── Ajustes finos de la previsión (se guardan en cfg.fiscal) ─────────
function setFiscal(k,v){
  const c=fiscalCfg();
  if(k==='irregular')c[k]=!!v;
  else c[k]=(v===''||v==null)?null:(Number(String(v).replace(',','.'))||0);
  save(); renderAll();
}

// ── La ficha: la declaración desmontada pieza a pieza ────────────────
function previsionRentaHTML(){
  const anios=fiscalAniosPendientes();
  let out='';
  anios.forEach(a=>{
    const R=fiscalRenta(a);
    if(!R)return;
    out+=previsionUnAnio(R);
  });
  return out;
}

function previsionUnAnio(R){
  const e0=v=>fmt(Math.round(v))+'€';
  const e2=v=>fmt2(Math.round(v*100)/100)+'€';
  const fila=(l,v,nota,cls)=>'<tr><td style="text-align:left">'+l+
    (nota?'<div style="font-size:9.5px;color:var(--faint)">'+nota+'</div>':'')+'</td>'+
    '<td style="text-align:right;white-space:nowrap'+(cls==='b'?';font-weight:700':'')+'">'+v+'</td></tr>';
  const sep=t=>'<tr><td colspan="2" style="text-align:left;padding-top:.45rem;font-size:10px;'+
    'text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700">'+t+'</td></tr>';
  const T=R.T,I=R.I,K=R.K,G=R.G;
  const fc0=fiscalCfg();
  const id='prev-renta-'+R.anio;
  const pagar=R.resultado>0;

  let h='<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:.7rem">';
  // Cabecera con el número grande
  h+='<div style="background:'+(pagar?'var(--navy)':'#0E6B57')+';color:#fff;padding:.6rem .8rem">'+
    '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;opacity:.85">'+
      'Previsión de la Renta '+R.anio+' · se presenta en junio de '+(R.anio+1)+'</div>'+
    '<div style="font-size:23px;font-weight:700;margin:.1rem 0">'+
      (pagar?e0(R.resultado)+' a pagar':e0(-R.resultado)+' a devolver')+'</div>';
  if(pagar&&R.porVentas>0){
    h+='<div style="font-size:11px;opacity:.92">'+
      '<strong>'+e0(R.porVentas)+' salen de las ventas de acciones</strong> — y de eso nadie te retiene nada. '+
      'El dinero de las plusvalías ya lo cobraste entero.</div>';
  }
  if(pagar){
    h+='<div style="font-size:10.5px;opacity:.8;margin-top:.15rem">'+
      'Quedan '+R.mesesHasta+' meses hasta el '+fmtDate(R.fechaPago)+': aparta '+e0(R.apartarMes)+'/mes.</div>';
  }
  h+='</div>';

  // Aviso de los dos pagadores
  if(R.dosPagadores){
    h+='<div style="background:#FFF6E0;border-bottom:1px solid #E8C97A;padding:.45rem .8rem;font-size:11px;color:var(--amber)">'+
      '<strong>Dos pagadores.</strong> La nómina retiene como si la IPT no existiera y la Seguridad Social '+
      'retiene como si la nómina no existiera. Sumadas caen en un tramo más alto, y esa diferencia '+
      'no la adelanta nadie: aparece entera en junio.</div>';
  }

  h+='<div style="padding:.5rem .8rem">';
  h+='<table class="detail-table" style="font-size:11.5px;width:100%">';

  h+=sep('Rendimientos del trabajo');
  h+=fila('Nóminas cobradas',e2(T.real),T.meses+' meses registrados');
  if(T.proy>0)h+=fila('Nóminas que faltan',e2(T.proy),
    T.detProy.length+' meses estimados por componentes ('+T.detProy.map(d=>d.mes).join(', ')+')');
  if(I.total>0)h+=fila('IPT Seguridad Social',e2(I.total),
    I.n+' pagas cobradas'+(I.proy>0?' + '+Math.round(I.proy/(I.ult||1))+' estimadas a '+e2(I.ult):''));
  if(R.redIrreg>0)h+=fila('− Reducción 30% rendimiento irregular','−'+e2(R.redIrreg),'art. 18.2 LIRPF');
  h+=fila('− Cotizaciones','−'+e2(R.cotiz),'MUFACE + derechos pasivos · art. 19.2.a');
  h+=fila('− Otros gastos','−'+e2(IRPF_GASTOS),'art. 19.2.f');
  if(R.gastoDisc>0)h+=fila('− Incremento por discapacidad','−'+e2(R.gastoDisc),
    'trabajador activo con discapacidad '+R.disc+'% · art. 19.2.f');
  if(R.redTrab>0)h+=fila('− Reducción por obtención de rendimientos','−'+e2(R.redTrab),'art. 20 LIRPF');
  h+=fila('<strong>Base imponible general</strong>',e2(R.baseGen),'','b');

  h+=sep('Base del ahorro');
  if(G.n)h+=fila('Ganancias por venta de acciones',(G.neto>=0?'+':'')+e2(G.neto),
    G.n+' operaciones · FIFO'+(G.per<0?' · '+e2(-G.per)+' de pérdidas compensadas':'')+
    (G.aplazadas>0?' · '+e2(G.aplazadas)+' de pérdidas que no cuentan aún (recompraste en menos de dos meses)':'')+
    (G.integradas<0?' · '+e2(-G.integradas)+' de pérdidas aplazadas que ya cuentan':''));
  if(K.total>0)h+=fila('Intereses y dividendos',e2(K.total),
    (K.cobrado>0?e2(K.cobrado)+' brutos cobrados'+(K.meses?' · intereses en '+K.meses+' meses':'')+(K.proy>0?' + '+e2(K.proy)+' estimados':''):'')+
    (K.dividendos>0?' · '+e2(K.dividendos)+' de dividendos':''));
  if(R.gpPendiente<0)h+=fila('Pérdidas que quedan pendientes',e2(-R.gpPendiente),
    'compensables en los 4 ejercicios siguientes · art. 49');
  h+=fila('<strong>Base imponible del ahorro</strong>',e2(R.baseAho),'','b');

  h+=sep('Cuota');
  h+=fila('Mínimo personal y familiar','−'+e2(R.minEst),
    fmt(IRPF_MIN_BASE)+'€ de contribuyente'+(R.disc>0?' + '+fmt(IRPF_MIN_DISC[R.disc]||0)+'€ por discapacidad':'')+
    (R.minAut!==R.minEst?' · '+e2(R.minAut)+' en el tramo autonómico':''));
  h+=fila('Escala general (estatal + '+escapeHtml(R.ccaa)+')',e2(R.cuotaGen));
  h+=fila('Escala del ahorro',e2(R.cuotaAho),'19% hasta 6.000€, 21% hasta 50.000€');
  if(R.deducAut>0)h+=fila('− Deducciones autonómicas','−'+e2(R.deducAut),
    R.deducAutHeredada?('arrastrada de tu declaración de '+(R.anio-1)+'; edítala abajo si cambia'):'puesta a mano');
  if(R.ddi>0)h+=fila('− Doble imposición internacional','−'+e2(R.ddi),
    'lo que retuvo el país de la empresa, hasta el 15 % de cada dividendo · art. 80');
  h+=fila('<strong>Cuota líquida</strong>',e2(R.cuota),'','b');
  h+=fila('− Retenciones de la nómina','−'+e2(R.retTrab),
    e2(T.retReal)+' practicadas'+(T.retProy>0?' + '+e2(T.retProy)+' estimadas al '+String(T.pct).replace('.',',')+'%':''));
  if(R.retIPT>0)h+=fila('− Retención de la IPT','−'+e2(R.retIPT));
  if(R.retCap>0)h+=fila('− Retención de '+(K.dividendos>0?'intereses y dividendos':'intereses'),'−'+e2(R.retCap),
    K.sinDato>0||K.proy>0?'la que consta en los apuntes; al '+String(fc0.capRetPct==null?19:fc0.capRetPct).replace('.',',')+' % en los que no la dicen':'la que consta en los apuntes');
  h+=fila('<strong>'+(pagar?'A PAGAR':'A DEVOLVER')+'</strong>',
    '<span style="color:'+(pagar?'var(--red)':'var(--teal)')+'">'+e2(Math.abs(R.resultado))+'</span>','','b');
  h+='</table>';

  // Palancas: lo que no se puede deducir de los datos y hay que decirle
  h+='<div style="margin-top:.5rem;font-size:11px;display:flex;flex-wrap:wrap;gap:.4rem .9rem;align-items:center">';
  const fc=fiscalCfg();
  h+='<label>Retención sobre la IPT <input type="number" step="1" style="width:52px;font-size:11px;padding:1px 3px" '+
    'value="'+(fc.iptRetPct==null?0:fc.iptRetPct)+'" onchange="setFiscal(\'iptRetPct\',this.value)">%</label>';
  h+='<label>Retención de intereses <input type="number" step="1" style="width:52px;font-size:11px;padding:1px 3px" '+
    'value="'+(fc.capRetPct==null?19:fc.capRetPct)+'" onchange="setFiscal(\'capRetPct\',this.value)">%</label>';
  h+='<label>Deducciones autonómicas <input type="number" step="1" style="width:62px;font-size:11px;padding:1px 3px" '+
    'value="'+(fc.deducAuton==null?Math.round(R.deducAut):fc.deducAuton)+'" onchange="setFiscal(\'deducAuton\',this.value)">€</label>';
  h+='</div>';

  // Reducción por rendimiento irregular: no se aplica sola, hay que pedirla
  if(R.irregBase>0){
    h+='<div style="margin-top:.45rem;background:var(--surface2);border-radius:6px;padding:.45rem .55rem;font-size:11px">'+
      '<label style="display:block"><input type="checkbox"'+(fc.irregular?' checked':'')+
      ' onchange="setFiscal(\'irregular\',this.checked)"> '+
      'Aplicar la reducción del 30% a los '+e2(R.irregBase)+' de atrasos por sentencia</label>'+
      '<div style="color:var(--muted);margin-top:.15rem">'+
      'El art. 18.2 LIRPF reduce un 30% los rendimientos generados en más de dos años. Un atraso de sentencia '+
      'que regulariza varios ejercicios suele encajar, pero <strong>no se aplica solo</strong>: hay que marcarlo '+
      'en la casilla de la declaración. '+(fc.irregular
        ?'Está aplicada: sin ella pagarías más.'
        :'Si encaja, la base baja '+e2(R.irregBase*0.30)+' y la factura, unos '+e0(R.irregBase*0.30*0.38)+'.')+
      '</div></div>';
  }

  // Lo que todavía se puede hacer antes del 31 de diciembre
  if(!T.cerrado){
    h+='<div style="margin-top:.45rem;font-size:11px;color:var(--muted)">'+
      '<strong>Hasta el 31 de diciembre todavía se puede mover.</strong> '+
      (G.neto>0?'Llevas '+e0(G.neto)+' de plusvalías realizadas: aflorar pérdidas latentes antes de fin de año las compensa '+
        'euro a euro y baja esta factura. Ojo con la regla de los dos meses (art. 33.5.f): si recompras el mismo '+
        'valor dentro de los dos meses siguientes, la pérdida no cuenta.'
       :'Sin plusvalías netas este año, no hay nada que compensar.')+
      '</div>';
  }

  h+='<div style="margin-top:.4rem;font-size:10px;color:var(--faint)">'+
    'Estimación con los datos de la app y las escalas de '+R.anio+'. Las deducciones autonómicas se arrastran '+
    'del último ejercicio declarado; no contempla aportaciones a planes de pensiones ni cambios en tu situación '+
    'familiar. Es una previsión para apartar dinero, no una declaración.'+
    '</div>';

  h+='</div></div>';
  return h;
}

// Límite de la obligación de declarar con dos pagadores (art. 96 LIRPF).
// Con Clases Pasivas y el INSS pagando a la vez, el límite baja de 22.000 a
// 15.876 €, así que declarar deja de ser opcional.
const IRPF_LIM_1PAG=22000, IRPF_LIM_2PAG=15876, IRPF_LIM_2PAG_MIN=1500;

const CP_ESCALA=[0,1.24,2.55,3.88,5.31,6.83,8.43,10.11,11.88,13.73,15.67,
  17.71,19.86,22.10,24.45,26.92,30.57,34.23,37.88,41.54,45.19,
  48.84,52.50,56.15,59.81,63.46,67.11,70.77,74.42,78.08,81.73,
  85.38,89.04,92.69,96.35,100.00];
// Haberes reguladores de CÁLCULO de pensiones — RD 241/2026, anexo III (€/año)
const CP_HABER_2026={A1:52697.06,A2:41473.91,B:36317.13,C1:31852.67,C2:25200.74,E:21485.65};
const CP_HABER_2025={A1:51311.65,A2:40383.55,B:35362.35,C1:31015.26,C2:24538.21,E:20920.79};
// Haberes reguladores a efectos de COTIZACIÓN (Ley 31/2022, PGE 2023, congelados
// por prórroga presupuestaria). Sirven para reconocer el régimen desde la nómina:
// derechos pasivos 3,86% y MUFACE 1,69%, en 14 pagas.
const CP_COTIZ={A1:42813.66,A2:33695.42,B:29505.79,C1:25878.65,C2:20474.32,E:17455.98};
const CP_MAX_2026_MES=3359.60, CP_MAX_2026_ANIO=47034.40;  // tope de pensión pública 2026
const CP_REVAL={2025:0.028,2026:0.027};
const CP_GRUPOS=['A1','A2','B','C1','C2','E'];

function pensionCfg(){
  const c=cfg.pension=cfg.pension||{};
  if(c.grupo==null)c.grupo='C1';
  if(c.haberRegAnio==null)c.haberRegAnio=2026;
  if(c.revalDefault==null)c.revalDefault=0.027;
  if(c.cpPagas==null)c.cpPagas=14;
  // ── v112 · fechas reales en vez de "años de servicio" a ojo
  // v169 · sin valores por defecto tuyos: los pones tú (están en tus datos)
  if(c.fIngreso==null)c.fIngreso='';                 // entrada en la Administración
  if(c.grupoIni==null)c.grupoIni=c.grupo;            // cuerpo de ingreso
  if(c.fGrupo2==null)c.fGrupo2='';                   // nombramiento en un segundo cuerpo, si lo hubo
  if(c.nacimientoFecha==null){
    // De versiones anteriores solo se guardaba el AÑO. Se rellena el 1 de enero
    // para no dejar la ficha muerta, pero se marca como inventado: un día de
    // diferencia mueve la fecha de jubilación forzosa y la de los 55.
    c.nacimientoFecha=(c.nacimiento?c.nacimiento+'-01-01':'');
    c.nacDerivada=!!c.nacimiento;
  }
  // v169 · la fecha de nacimiento ya no se rellena desde el código: es tuya y
  // está en tus datos. Si solo se sabe el año, queda marcada como inventada.
  if(c.edadForzosa==null)c.edadForzosa=65;           // Clases Pasivas, art. 28.2.a
  if(c.edadMaxProlong==null)c.edadMaxProlong=70;     // art. 67.3 TREBEP
  if(c.aniosRGSSprevios==null)c.aniosRGSSprevios=0;  // cotizados antes de ser funcionario
  if(c.totaliza==null)c.totaliza=false;              // ¡ojo! totalizar obliga a elegir
  if(c.demoraOn==null)c.demoraOn=true;
  if(c.ipt20==null)c.ipt20=true;                     // contar el +20% al dejar de trabajar
  if(c.haberReg==null)c.haberReg=CP_HABER_2026[c.grupo]||CP_HABER_2026.C1;
  if(c.iptMes==null){
    const ult=incomeLog.filter(x=>x.cat==='ipt').sort((a,b)=>String(b.date).localeCompare(String(a.date)))[0];
    c.iptMes=ult?Math.round((ult.amt||0)*100)/100:0;
    c.iptPagas=14;
  }
  // v123 · la IPT del Régimen General se cobra en 14 pagas: 12 mensuales más
  // las extraordinarias de junio y noviembre. Antes el valor por defecto era
  // 12 y dejaba fuera dos pagas enteras en todos los cálculos. Se corrige una
  // sola vez: si después pones otro número a mano, se respeta.
  if(c.iptPagas==null)c.iptPagas=14;
  if(!c.mig14pagas){ if(c.iptPagas===12)c.iptPagas=14; c.mig14pagas=true; }
  if(c.iptPct==null)c.iptPct=55;                     // grado reconocido: 55% de la BR
  // v113 · IRPF. Con una IPT reconocida, el art. 60.3 LIRPF te da acreditado
  // el 33% de discapacidad de oficio, sin certificado del IMSERSO.
  if(c.ccaa==null)c.ccaa='Comunitat Valenciana';
  if(c.discapacidad==null)c.discapacidad=(Number(c.iptMes)>0?33:0);   // con IPT, el 33 % de oficio (art. 60.3 LIRPF)
  if(c.asistencia==null)c.asistencia=false;
  if(c.verNeto==null)c.verNeto=true;
  c.reval=c.reval||{};
  return c;
}
function setPension(k,v){
  const c=pensionCfg();
  if(k==='revalDefaultPct'){c.revalDefault=(parseFloat(String(v).replace(',','.'))||0)/100;save();renderPension();return;}
  if(k==='nacimientoFecha')c.nacDerivada=false;   // en cuanto la tocas, es tuya
  const num=['haberReg','haberRegAnio','edadForzosa','edadMaxProlong','iptMes','iptPagas',
             'cpPagas','nacimiento','aniosRGSSprevios','iptPct','discapacidad'];
  const bool=['totaliza','demoraOn','ipt20','asistencia','verNeto'];
  c[k]=bool.includes(k)?!!v:(num.includes(k)?(parseFloat(String(v).replace(',','.'))||0):v);
  if(k==='grupo'){c.haberReg=CP_HABER_2026[v]||c.haberReg;}
  save(); renderPension();
}
function setPensionReval(anio,cual,v){
  const c=pensionCfg();
  c.reval[anio]=c.reval[anio]||{};
  const n=String(v).trim();
  if(n===''){delete c.reval[anio][cual]; if(!Object.keys(c.reval[anio]).length)delete c.reval[anio];}
  else c.reval[anio][cual]=(parseFloat(n.replace(',','.'))||0)/100;
  save(); renderPension();
}
function pensionReval(anio,cual){
  const c=pensionCfg();
  if(c.reval[anio]&&c.reval[anio][cual]!=null)return c.reval[anio][cual];
  if(CP_REVAL[anio]!=null)return CP_REVAL[anio];
  return c.revalDefault;
}
function pctEscala(anios){
  const a=Math.max(0,Math.floor(anios||0));
  return (a>=35?100:CP_ESCALA[a]||0)/100;
}

// ─── Fechas ─────────────────────────────────────────────────────────
function jubMeses(desdeISO,hastaISO){
  if(!desdeISO||!hastaISO)return 0;
  const a=new Date(desdeISO+'T00:00:00'), b=new Date(hastaISO+'T00:00:00');
  if(isNaN(a)||isNaN(b)||b<a)return 0;
  let m=(b.getFullYear()-a.getFullYear())*12+(b.getMonth()-a.getMonth());
  if(b.getDate()<a.getDate())m--;
  return Math.max(0,m);
}
function jubSumaAnios(iso,n){
  if(!iso||!/^\d{4}-\d{2}-\d{2}/.test(String(iso)))return '';
  return isoMasAnios(iso,Math.floor(n));     // v169 · antes salía un día antes (UTC)
}

// ─── El cálculo de la pensión de Clases Pasivas ─────────────────────
// Art. 31.2: P = R1·C1 + (R2−R1)·C2
//   R1 = haber regulador del PRIMER cuerpo (orden cronológico, no por cuantía:
//        la fórmula se autocorrige por signo si se baja de grupo)
//   R2 = haber regulador del segundo cuerpo
//   C1 = % de la escala por los años completos TOTALES de servicio
//   C2 = % por los años completos desde el acceso al segundo cuerpo
// Art. 31.3: los meses sueltos del primer tramo se arrastran al siguiente.
function jubCalculo(fechaJub){
  const c=pensionCfg();
  if(!c.fIngreso||!fechaJub)return null;
  const hayDosCuerpos=!!(c.fGrupo2&&c.fGrupo2>c.fIngreso&&c.fGrupo2<=fechaJub);
  const R1=(CP_HABER_2026[c.grupoIni]||CP_HABER_2026.C2);
  const R2=(CP_HABER_2026[c.grupo]||CP_HABER_2026.C1);
  const mesesTotal=jubMeses(c.fIngreso,fechaJub);
  const mesesT1=hayDosCuerpos?jubMeses(c.fIngreso,c.fGrupo2):mesesTotal;
  const mesesT2=hayDosCuerpos?jubMeses(c.fGrupo2,fechaJub):0;
  const arrastre=mesesT1%12;                       // art. 31.3
  const aniosCP=Math.floor(mesesTotal/12);         // años SOLO de funcionario
  const extraRGSS=c.totaliza?Math.max(0,Math.floor(c.aniosRGSSprevios||0)):0;
  const aniosTotal=aniosCP+extraRGSS;
  const aniosT2=hayDosCuerpos?Math.floor((mesesT2+arrastre)/12):0;
  const C1=pctEscala(aniosTotal);
  const C2=pctEscala(aniosT2);
  const anual=hayDosCuerpos?(R1*C1+(R2-R1)*C2):(R2*C1);
  return {R1,R2,hayDosCuerpos,mesesTotal,mesesT1,mesesT2,arrastre,
    aniosCP,extraRGSS,aniosTotal,aniosT2,C1,C2,anual,
    aniosCPmeses:mesesTotal%12};
}
// Complemento por demora (DA 17ª): 4 puntos por año completo pasados los 65.
// Desde el 1/4/2025 (RD-ley 11/2024) el 2º año en adelante admite medios años
// al 2%. Se aplica sobre el haber regulador del último cuerpo, que es el
// equivalente natural de "la respectiva base reguladora" del art. 210.2 LGSS.
function jubDemora(fechaJub){
  const c=pensionCfg();
  if(!c.demoraOn||!c.nacimientoFecha)return {meses:0,puntos:0,extra:0};
  const f65=jubSumaAnios(c.nacimientoFecha,c.edadForzosa);
  const m=jubMeses(f65,fechaJub);
  if(m<12)return {meses:m,puntos:0,extra:0};
  const anios=Math.floor(m/12);
  const semestreExtra=(anios>=2&&m%12>=6)?1:0;
  const puntos=anios*0.04+semestreExtra*0.02;
  const R2=(CP_HABER_2026[c.grupo]||CP_HABER_2026.C1);
  return {meses:m,anios,semestreExtra,puntos,extra:R2*puntos};
}

// ─── Escenarios ─────────────────────────────────────────────────────
// Fechas clave: la primera en que puede causar pensión (carencia de 15 años),
// la primera voluntaria (60 + 30 de servicio), la forzosa y el tope de prórroga.
function jubFechas(){
  const c=pensionCfg();
  if(!c.fIngreso||!c.nacimientoFecha)return null;
  const f60=jubSumaAnios(c.nacimientoFecha,60);
  const fForzosa=jubSumaAnios(c.nacimientoFecha,c.edadForzosa);
  const fMax=jubSumaAnios(c.nacimientoFecha,c.edadMaxProlong);
  const extra=c.totaliza?Math.max(0,Math.floor(c.aniosRGSSprevios||0)):0;
  // carencia: 15 años de servicios computables
  const fCarencia=jubSumaAnios(c.fIngreso,Math.max(0,15-extra));
  // voluntaria: 60 años Y 30 de servicios computables
  const f30=jubSumaAnios(c.fIngreso,Math.max(0,30-extra));
  const fVoluntaria=(f30>f60?f30:f60);
  return {f60,f30,fVoluntaria,fForzosa,fMax,fCarencia,
    voluntariaPosible:fVoluntaria<=fMax,
    carenciaOK:fCarencia<=fForzosa};
}
// ════════════════════════════════════════════════════════════════════
// v159 · UNA SOLA FECHA DE JUBILACIÓN PARA TODA LA APP
// ════════════════════════════════════════════════════════════════════
// El panel, la proyección por escenarios, sus hitos y la proyección de ahorro
// llevaban 2045 escrito a mano, «cuando cumples 67». Pero en Clases Pasivas la
// forzosa es a los 65 —este mismo módulo lo dice— y eso es abril de 2043: dos
// años de sueldo y aportaciones proyectados que no existirán salvo que pidas la
// prórroga. Ahora todo sale de aquí, y el escenario se elige.
function jubPlan(){
  const c=pensionCfg(), F=jubFechas();
  const esc=c.jubEscenario||'forzosa';
  let f=null;
  if(F) f=(esc==='voluntaria'?F.fVoluntaria:(esc==='prorroga'?F.fMax:F.fForzosa));
  if(!f) f='2043-12-31';
  const y=+f.slice(0,4), m=+f.slice(5,7);
  const nom={voluntaria:'voluntaria',forzosa:'forzosa',prorroga:'con prórroga'}[esc]||'forzosa';
  return {fecha:f,anio:y,mes:m,escenario:esc,nombre:nom,F};
}
function setJubEscenario(v){
  pensionCfg().jubEscenario=v; save();
  try{initCharts();}catch(e){fallo('initCharts',e)}
  try{renderAhorro();}catch(e){fallo('renderAhorro',e)}
  try{renderPension();}catch(e){fallo('renderPension',e)}
}
function jubSelectorHTML(){
  const J=jubPlan(), F=J.F;
  const op=(v,t)=>'<option value="'+v+'"'+(J.escenario===v?' selected':'')+'>'+t+'</option>';
  return '<select onchange="setJubEscenario(this.value)" style="font-size:11px;padding:1px 4px">'+
    (F?op('voluntaria','Voluntaria · '+fmtDate(F.fVoluntaria)):'')+
    op('forzosa','Forzosa · '+(F?fmtDate(F.fForzosa):'65 años'))+
    (F?op('prorroga','Prórroga · '+fmtDate(F.fMax)):'')+
    '</select>';
}
// La IPT: hoy cobra el 55% de su base reguladora. El +20% (art. 6 del Decreto
// 1646/1972) exige 55 años cumplidos y NO estar trabajando: mientras siga de
// funcionario está en suspenso. Al jubilarse puede pedirlo — pero pasada la
// edad ordinaria de jubilación del Régimen General (67) la práctica del INSS
// suele denegarlo, y ahí no hay doctrina unificada. Por eso se avisa.
function jubIPT(fechaJub){
  const c=pensionCfg();
  const base=Number(c.iptMes)||0;
  const pct=Number(c.iptPct)||55;
  const conIncremento=base*(pct+20)/pct;
  const f55=c.nacimientoFecha?jubSumaAnios(c.nacimientoFecha,55):null;
  const f67=c.nacimientoFecha?jubSumaAnios(c.nacimientoFecha,67):null;
  const tiene55=!!(f55&&fechaJub>=f55);
  const antesDe67=!!(f67&&fechaJub<f67);
  const aplica=c.ipt20&&tiene55;
  return {base,conIncremento,incremento:conIncremento-base,
    f55,f67,tiene55,antesDe67,aplica,
    mes:aplica?conIncremento:base,
    dudoso:aplica&&!antesDe67};
}
function jubEscenario(fechaJub,etiqueta){
  const c=pensionCfg();
  const K=jubCalculo(fechaJub); if(!K)return null;
  const D=jubDemora(fechaJub);
  const I=jubIPT(fechaJub);
  const cpAnual=K.anual+D.extra;
  const cpMes=cpAnual/(c.cpPagas||14);
  const iptAnual=I.mes*(c.iptPagas||14);
  const edad=c.nacimientoFecha?Math.floor(jubMeses(c.nacimientoFecha,fechaJub)/12):null;
  const totalAnual=cpAnual+(c.totaliza?0:iptAnual);   // si totaliza, hay que elegir
  // v113 · Hacienda no ve dos pensiones: ve una sola base imponible con dos
  // pagadores. Por eso el IRPF se calcula sobre la suma, no pensión a pensión.
  const F=irpfCalc(totalAnual,edad==null?65:edad,
    {ccaa:c.ccaa,discapacidad:c.discapacidad,asistencia:c.asistencia,anio:Number(fechaJub.slice(0,4))});
  return {etiqueta,fecha:fechaJub,anio:Number(fechaJub.slice(0,4)),edad,
    K,D,I,cpAnual,cpMes,iptMes:I.mes,iptAnual,
    totalAnual,totalMes:totalAnual/12,
    irpf:F,netoAnual:F.neto,netoMes:F.neto/12,tipoMedio:F.tipoMedio,
    topeSupera:totalAnual>CP_MAX_2026_ANIO,
    pctTope:totalAnual/CP_MAX_2026_ANIO};
}
// Una fila por año, desde el primero en que puede jubilarse hasta el tope de
// prórroga. Es la tabla que contesta "¿y si aguanto un año más?".
function jubTabla(){
  const c=pensionCfg(), F=jubFechas();
  if(!F)return null;
  const primera=(F.fVoluntaria>F.fCarencia?F.fVoluntaria:F.fCarencia);
  const filas=[];
  const yFor=Number(F.fForzosa.slice(0,4));
  const y0=Number(primera.slice(0,4)), y1=Number(F.fMax.slice(0,4));
  for(let y=y0;y<=y1;y++){
    // Antes de la forzosa la referencia es el aniversario de ingreso: es cuando
    // se completa un año de servicio. Desde la forzosa es el cumpleaños: es
    // cuando se completa un año de prórroga y salta otro 4% de demora.
    let f=(y>=yFor)?(y+c.nacimientoFecha.slice(4)):(y+c.fIngreso.slice(4));
    if(f<primera)f=primera;
    if(f>F.fMax)f=F.fMax;
    const e=jubEscenario(f,'');
    if(!e)continue;
    e.necesitaPermiso=(f>F.fForzosa);
    e.esForzosa=(y===yFor);
    filas.push(e);
  }
  return {F,filas,primera};
}

function renderPension(){
  const box=document.getElementById('pension-body'); if(!box)return;
  const c=pensionCfg();
  const eur=v=>fmt(Math.round(v))+'€';
  const eur2=v=>fmt2(v)+'€';
  const pc=v=>(v*100).toFixed(2).replace('.',',')+'%';
  const num=(k,v,w,step)=>'<input type="number" step="'+(step||'1')+'" value="'+(v==null?'':v)+
    '" onchange="setPension(\''+k+'\',this.value)" style="font-size:11px;width:'+(w||62)+'px;padding:1px 4px">';
  const fec=(k,v)=>'<input type="date" value="'+(v||'')+'" onchange="setPension(\''+k+'\',this.value)" style="font-size:11px;padding:1px 4px">';
  const sel=(k,v,ops)=>'<select onchange="setPension(\''+k+'\',this.value)" style="font-size:11px;padding:1px 3px">'+
    ops.map(o=>'<option value="'+o+'"'+(o===v?' selected':'')+'>'+o+'</option>').join('')+'</select>';
  const chk=(k,v,txt)=>'<label style="display:block;margin-top:.3rem;font-size:11.5px"><input type="checkbox"'+(v?' checked':'')+
    ' onchange="setPension(\''+k+'\',this.checked)"> '+txt+'</label>';
  let h='';

  // ── 1. Tus datos ──────────────────────────────────────────────────
  h+='<div style="font-size:12px;font-weight:700;margin:.1rem 0 .4rem">Tus datos</div>'+
    '<div style="display:flex;flex-wrap:wrap;gap:.45rem .9rem;font-size:11.5px;margin-bottom:.6rem">'+
    '<label>Nacimiento '+fec('nacimientoFecha',c.nacimientoFecha)+
      (c.nacDerivada?' <span style="color:var(--amber);font-size:10px">← me he inventado el día, corrígelo</span>':'')+'</label>'+
    '<label>Ingreso en la Administración '+fec('fIngreso',c.fIngreso)+' como '+sel('grupoIni',c.grupoIni,CP_GRUPOS)+'</label>'+
    '<label>Pasas a '+sel('grupo',c.grupo,CP_GRUPOS)+' el '+fec('fGrupo2',c.fGrupo2)+'</label>'+
    '<label>IPT hoy '+num('iptMes',c.iptMes,66,'0.01')+'€ × '+num('iptPagas',c.iptPagas,40)+' pagas ('+num('iptPct',c.iptPct,40)+'% de tu base)</label>'+
    '<label>Jubilación forzosa a los '+num('edadForzosa',c.edadForzosa,42)+'</label>'+
    '<label>Prórroga máxima hasta los '+num('edadMaxProlong',c.edadMaxProlong,42)+'</label>'+
    '<label>Años cotizados antes de ser funcionario '+num('aniosRGSSprevios',c.aniosRGSSprevios,44)+'</label>'+
    '<label>IRPF de '+sel('ccaa',c.ccaa,Object.keys(IRPF_AUTON))+'</label>'+
    '<label>Discapacidad reconocida '+sel('discapacidad',String(c.discapacidad),['0','33','65'])+'%</label>'+
    '</div>';

  if(!c.nacimientoFecha||!c.fIngreso){
    box.innerHTML=h+'<div style="font-size:12px;color:var(--muted)">Pon tu <strong>fecha de nacimiento</strong> y la de <strong>ingreso en la Administración</strong> y sale todo lo demás.</div>';
    return;
  }
  const T=jubTabla(); if(!T){box.innerHTML=h;return;}
  const F=T.F;
  const hoyISO=todayISO();
  const eVol=jubEscenario(F.fVoluntaria>F.fCarencia?F.fVoluntaria:F.fCarencia,'Lo antes posible');
  const eFor=jubEscenario(F.fForzosa,'Forzosa a los '+c.edadForzosa);
  const eMax=jubEscenario(F.fMax,'Prórroga hasta los '+c.edadMaxProlong);
  const hoyK=jubCalculo(hoyISO);

  // ── 1bis. El encuadramiento, que es de donde cuelga todo lo demás ──
  // Clases Pasivas está cerrado a quien ingresó desde el 1/1/2011 (art. 20 del
  // RD-ley 13/2010). Si la fecha de ingreso es posterior y la nómina descuenta
  // derechos pasivos, una de las dos cosas hay que aclararla antes de fiarse
  // de ninguna cifra de esta ficha.
  (function(){
    const cot=CP_COTIZ[c.grupo]||0;
    const dp=cot*0.0386/14, mu=cot*0.0169/14;
    const post2011=c.fIngreso>='2011-01-01';
    h+='<div style="background:'+(post2011?'#FFF6E0':'var(--surface2)')+';border:1px solid '+
      (post2011?'#E8C97A':'var(--border)')+';border-radius:6px;padding:.55rem .65rem;font-size:11.5px;color:'+
      (post2011?'var(--amber)':'var(--muted)')+';margin-bottom:.6rem">'+
      '<strong>Esta ficha calcula una pensión de Clases Pasivas.</strong> Tus nóminas lo confirman: te descuentan '+
      eur2(dp)+' de derechos pasivos y '+eur2(mu)+' de MUFACE al mes, que es exactamente el 3,86% y el 1,69% del haber '+
      'regulador de cotización del subgrupo '+c.grupo+'. Un funcionario del Régimen General no paga eso.'+
      (post2011?('<br><br><strong>Pero hay algo que no cuadra y conviene que lo aclares.</strong> Clases Pasivas se cerró '+
        'a quien ingresó desde el <strong>1 de enero de 2011</strong> (art. 20 del RD-ley 13/2010), y tú tienes puesto el '+
        fmtDate(c.fIngreso)+'. O tu fecha de ingreso efectivo es anterior (servicios previos, interinidad, otro cuerpo), '+
        'o hay algo particular en tu encuadramiento. <strong>Pídele a tu habilitación el certificado de servicios efectivos</strong>: '+
        'si resultara que estás en el Régimen General, los números de aquí no te sirven — la jubilación forzosa sería a los 67, '+
        'no a los 65, y la pensión saldría de tus bases de cotización, no del haber regulador.'):'')+
      '</div>';
  })();

  // ── 2. A día de hoy ───────────────────────────────────────────────
  const edadHoy=Math.floor(jubMeses(c.nacimientoFecha,hoyISO)/12);
  h+='<div style="font-size:12px;font-weight:700;margin:.5rem 0 .4rem">A día de hoy ('+fmtDate(hoyISO)+')</div>';
  h+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:6px;margin-bottom:.5rem">'+
    [['Edad',edadHoy+' años','','var(--muted)'],
     ['Servicio acreditado',hoyK.aniosCP+' años',hoyK.aniosCPmeses+' meses más','var(--navy)'],
     ['Escala art. 31',pc(hoyK.C1),'sobre el haber regulador','var(--navy)'],
     ['Si te jubilaras ya',eur(hoyK.anual/(c.cpPagas||14))+'/mes',
      (hoyK.aniosCP<15?'aún no llegas a los 15 años de carencia':'×'+(c.cpPagas||14)+' pagas'),
      hoyK.aniosCP<15?'var(--red)':'var(--teal)']]
    .map(([l,v,s,col])=>'<div style="background:var(--surface2);border-radius:6px;padding:.45rem .5rem;text-align:center">'+
      '<div style="font-size:15px;font-weight:700;color:'+col+'">'+v+'</div>'+
      '<div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)">'+l+'</div>'+
      (s?'<div style="font-size:9.5px;color:var(--faint);margin-top:1px">'+s+'</div>':'')+'</div>').join('')+'</div>';
  if(hoyK.aniosCP<15){
    h+='<div style="background:#FFF6E0;border:1px solid #E8C97A;border-radius:6px;padding:.5rem .6rem;font-size:11.5px;color:var(--amber);margin-bottom:.6rem">'+
      'Todavía no tienes los <strong>15 años de servicio</strong> que exige el art. 29 para causar pensión de Clases Pasivas. '+
      'Los cumples el <strong>'+fmtDate(F.fCarencia)+'</strong>. Hasta entonces, jubilarte no daría pensión de funcionario.</div>';
  }

  // ── 3. Los tres escenarios ────────────────────────────────────────
  h+='<div style="font-size:12px;font-weight:700;margin:.6rem 0 .35rem">Los tres momentos que importan</div>';
  h+='<div style="font-size:11px;color:var(--muted);margin-bottom:.45rem">'+
    'Todo en <strong>euros de hoy</strong>: sin inflación ni revalorizaciones, para poder compararlos entre sí. '+
    'Más abajo está la proyección año a año con la revalorización que tú pongas.</div>';
  h+='<div class="tbl-scroll"><table class="detail-table" style="font-size:11.5px">'+
    '<thead><tr><th style="text-align:left">Escenario</th><th>Cuándo</th><th class="jub-x">Edad</th><th class="jub-x">Años serv.</th>'+
    '<th class="jub-x">% escala</th><th class="jub-x">Clases Pasivas</th><th class="jub-x">IPT</th>'+
    '<th>Bruto/mes</th><th>IRPF</th><th>Neto/mes</th></tr></thead><tbody>';
  [eVol,eFor,eMax].forEach((e,i)=>{
    if(!e)return;
    const dest=(i===2);
    h+='<tr'+(dest?' style="background:color-mix(in srgb,var(--teal) 8%,transparent)"':'')+'>'+
      '<td style="text-align:left"><strong>'+
        (i===0?'Lo antes que puedes':(i===1?'Forzosa a los '+c.edadForzosa:'Aguantando hasta los '+c.edadMaxProlong))+'</strong>'+
        '<div style="font-size:9.5px;color:var(--faint)">'+
        (i===0?(F.fVoluntaria>F.fCarencia?'60 años + 30 de servicio':'al cumplir la carencia de 15 años')
             :(i===1?'te jubilan de oficio':'con autorización, art. 67.3 EBEP'))+'</div>'+
        '<div class="jub-m">'+e.edad+' años · '+e.K.aniosTotal+' de servicio · '+pc(e.K.C1)+
        (e.D.puntos?' +'+(e.D.puntos*100).toFixed(0)+' demora':'')+
        '<br>CP '+eur(e.cpMes)+' + IPT '+eur(e.iptMes)+'</div></td>'+
      '<td style="white-space:nowrap">'+fmtDate(e.fecha)+'</td>'+
      '<td class="jub-x">'+e.edad+'</td>'+
      '<td class="jub-x">'+e.K.aniosTotal+(e.K.hayDosCuerpos?'<div style="font-size:9px;color:var(--faint)">'+e.K.aniosT2+' en '+c.grupo+'</div>':'')+'</td>'+
      '<td class="jub-x">'+pc(e.K.C1)+(e.D.puntos?'<div style="font-size:9px;color:var(--teal)">+'+(e.D.puntos*100).toFixed(0)+' demora</div>':'')+'</td>'+
      '<td class="jub-x"><strong>'+eur(e.cpMes)+'</strong><div style="font-size:9px;color:var(--faint)">'+eur(e.cpAnual)+'/año</div></td>'+
      '<td class="jub-x">'+eur(e.iptMes)+(e.I.aplica?'<div style="font-size:9px;color:var(--teal)">con el +20%</div>':'')+'</td>'+
      '<td>'+eur(e.totalMes)+'<div style="font-size:9px;color:var(--faint)">'+eur(e.totalAnual)+'/año</div></td>'+
      '<td style="color:var(--red)">−'+eur(e.irpf.cuota/12)+'<div style="font-size:9px;color:var(--faint)">'+
        (e.tipoMedio*100).toFixed(1).replace('.',',')+'% medio</div></td>'+
      '<td style="font-weight:700;color:var(--teal)">'+eur(e.netoMes)+'<div style="font-size:9px;color:var(--faint)">'+eur(e.netoAnual)+'/año</div></td></tr>';
  });
  h+='</tbody></table></div>';

  // ── 4. Lo que cuesta irse pronto / lo que gana aguantar ───────────
  if(eVol&&eMax){
    const dif=eMax.netoMes-eVol.netoMes;
    const difB=eMax.totalMes-eVol.totalMes;
    const anios=Math.round(jubMeses(eVol.fecha,eMax.fecha)/12);
    h+='<div style="background:var(--surface2);border-radius:6px;padding:.55rem .65rem;font-size:11.5px;margin:.5rem 0 .6rem">'+
      'Entre irte en <strong>'+eVol.anio+'</strong> y aguantar hasta <strong>'+eMax.anio+'</strong> ('+anios+' años más) '+
      'hay <strong style="color:var(--teal)">'+eur(dif)+'/mes netos</strong> de diferencia ('+eur(difB)+' brutos), '+
      eur(dif*12)+' al año limpios, de por vida. '+
      (eMax.D.puntos?'De esa subida, <strong>'+eur(eMax.D.extra/(c.cpPagas||14))+'/mes</strong> vienen del complemento por demora ('+
        (eMax.D.puntos*100).toFixed(0)+' puntos por '+eMax.D.anios+' años pasados los '+c.edadForzosa+'), y el resto de subir en la escala.':'')+
      '</div>';
  }

  // ── 5. El +20% de la IPT ──────────────────────────────────────────
  const I0=jubIPT(F.fForzosa);
  h+='<div style="font-size:12px;font-weight:700;margin:.6rem 0 .35rem">El +20% de tu IPT</div>';
  h+='<div style="font-size:11.5px;color:var(--muted);margin-bottom:.4rem">'+
    'Tu IPT es el <strong>'+c.iptPct+'% de tu base reguladora</strong>: '+eur2(c.iptMes)+'/mes. '+
    'El incremento del art. 6 del Decreto 1646/1972 la sube al '+(c.iptPct+20)+'% — serían '+
    '<strong style="color:var(--teal)">'+eur2(I0.conIncremento)+'/mes</strong>, '+eur2(I0.incremento)+' más. '+
    'Pero exige dos cosas: <strong>55 años cumplidos</strong> (los tuyos, el '+fmtDate(I0.f55)+') y '+
    '<strong>no estar trabajando</strong>. Mientras sigas de funcionario está en suspenso, así que solo aparece '+
    'en las filas en las que ya te has jubilado.</div>';
  h+='<div style="font-size:11.5px;color:var(--muted);margin-bottom:.4rem">'+
    'Tu IPT es del <strong>Régimen General</strong> y tu jubilación será de <strong>Clases Pasivas</strong>: son dos sistemas '+
    'distintos, sostenidos por cotizaciones distintas, y por eso pueden cobrarse a la vez. El art. 26 del RDLeg 670/1987 solo '+
    'obliga a elegir cuando las dos nacen de <em>una única prestación de servicios a la Administración</em>, que no es tu caso '+
    'mientras no toques la casilla de totalizar de aquí abajo.</div>';
  h+='<div style="background:#FFF6E0;border:1px solid #E8C97A;border-radius:6px;padding:.5rem .6rem;font-size:11px;color:var(--amber);margin-bottom:.5rem">'+
    '<strong>El detalle que puede costarte el +20%.</strong> A los 67 (para ti, el '+fmtDate(I0.f67)+') tu IPT pasa a llamarse '+
    'jubilación por el art. 200.4 LGSS. La ley no dice que el incremento no pueda pedirse después, pero el INSS suele denegarlo '+
    'porque desaparece la premisa de "dificultad para encontrar empleo", y no hay doctrina unificada del Supremo. '+
    'Traducido: si te jubilas <strong>antes de los 67</strong> y lo pides en cuanto ceses, vas sobre seguro; si aguantas hasta los '+
    c.edadMaxProlong+', el +20% es una apuesta. Y ojo: los efectos solo se retrotraen <strong>tres meses</strong> (art. 53.1 LGSS), '+
    'así que se pide el mismo mes en que dejes de trabajar.</div>';
  h+=chk('ipt20',c.ipt20,'Contar el +20% en los escenarios de jubilación');

  // ── 6. Totalizar: la decisión que puede costarte una pensión ──────
  h+='<div style="font-size:12px;font-weight:700;margin:.7rem 0 .35rem">Tus años cotizados antes de ser funcionario</div>';
  h+='<div style="background:#FDECEA;border:1px solid #E8A79E;border-radius:6px;padding:.55rem .65rem;font-size:11.5px;color:#8A2A1A;margin-bottom:.5rem">'+
    '<strong>Cuidado con esto.</strong> Puedes sumar tus años del Régimen General a los de funcionario para subir en la escala '+
    'o para llegar a los 30 años de la voluntaria (art. 32.1.e del RDLeg 670/1987 y art. 4 del RD 691/1991). '+
    'Pero si lo haces, <strong>esos mismos años dejan de poder sostener tu IPT</strong>: el art. 32.1.e in fine y el art. 5.1 '+
    'del RD 691/1991 obligan a <strong>elegir una de las dos pensiones</strong>. No es un matiz: es perder una entera. '+
    'Con dos pensiones compatibles casi siempre sale mejor no totalizar, pero la comparación la puedes hacer aquí.</div>';
  h+=chk('totaliza',c.totaliza,'Totalizar mis años del Régimen General (y renunciar a la IPT)');
  if(c.totaliza){
    h+='<div style="font-size:11px;color:var(--muted);margin-top:.3rem">Con la casilla marcada la IPT deja de sumarse en las tablas, que es exactamente lo que pasaría.</div>';
  }

  // ── 6bis. El IRPF, que es lo que separa el bruto del banco ────────
  (function(){
    const e=eFor||eVol; if(!e)return;
    const F=e.irpf;
    h+='<div style="font-size:12px;font-weight:700;margin:.7rem 0 .35rem">Lo que se queda Hacienda</div>';
    h+='<div style="font-size:11.5px;color:var(--muted);margin-bottom:.45rem">'+
      'Las dos pensiones son <strong>rendimiento del trabajo</strong> y tributan. Ni la de Clases Pasivas ni tu IPT están exentas: '+
      'solo lo están la incapacidad <em>absoluta</em> y la gran invalidez (art. 7.f LIRPF). Esto es lo que sale en el escenario de '+
      'jubilación a los '+c.edadForzosa+':</div>';
    const fila=(l,v,sub,col)=>'<tr><td style="text-align:left">'+l+
      (sub?'<div style="font-size:9.5px;color:var(--faint)">'+sub+'</div>':'')+'</td>'+
      '<td style="'+(col?'color:'+col+';':'')+'white-space:nowrap">'+v+'</td></tr>';
    h+='<div class="tbl-scroll"><table class="detail-table" style="font-size:11.5px"><tbody>'+
      fila('Pensiones íntegras',eur2(F.bruto),'Clases Pasivas + IPT, en un año','')+
      fila('− Otros gastos',       '−'+eur2(F.gastos),'art. 19.2.f LIRPF, fijo','var(--red)')+
      (F.red>0?fila('− Reducción por rendimientos del trabajo','−'+eur2(F.red),'art. 20 LIRPF','var(--red)'):'')+
      fila('= Base liquidable',    eur2(F.baseLiq),'','')+
      fila('Mínimo personal y familiar',eur2(F.minEstatal),
        '5.550€ base'+((e.edad>=65)?' + 1.150€ por tener más de 65':'')+
        (F.disc?' + '+fmt(F.disc)+'€ por discapacidad ≥'+c.discapacidad+'%':'')+
        (F.minAuton!==F.minEstatal?' · tu comunidad aplica '+eur2(F.minAuton):''),'var(--teal)')+
      fila('Cuota estatal',        eur2(F.cuotaEst),'escala del art. 63 LIRPF','var(--red)')+
      fila('Cuota autonómica',     eur2(F.cuotaAut),c.ccaa,'var(--red)')+
      '<tr style="border-top:2px solid var(--navy)"><td style="text-align:left;font-weight:700">IRPF del año</td>'+
      '<td style="font-weight:700;color:var(--red)">'+eur2(F.cuota)+'</td></tr>'+
      '<tr><td style="text-align:left;font-weight:700">Te queda</td>'+
      '<td style="font-weight:700;color:var(--teal)">'+eur2(F.neto)+'</td></tr>'+
      '</tbody></table></div>';
    h+='<div style="font-size:11px;color:var(--muted);margin-top:.4rem">'+
      'Tipo medio <strong>'+(F.tipoMedio*100).toFixed(1).replace('.',',')+'%</strong>; el siguiente euro te costaría el '+
      '<strong>'+(F.marginal*100).toFixed(1).replace('.',',')+'%</strong>. '+
      'Tu <strong>IPT te da acreditado el 33% de discapacidad de oficio</strong> a efectos de IRPF (art. 60.3 LIRPF): '+
      'no necesitas certificado del IMSERSO, y son '+fmt(IRPF_MIN_DISC[33])+'€ más de mínimo exento. '+
      'Si algún día te reconocieran un grado ≥65%, cámbialo arriba: el mínimo sube a '+fmt(IRPF_MIN_DISC[65])+'€.</div>';
    h+='<div style="background:#E8F5EE;border:1px solid #9ED4B4;border-radius:6px;padding:.5rem .6rem;font-size:11px;color:var(--teal);margin-top:.45rem">'+
      '<strong>El mínimo por discapacidad no se pierde al jubilarte.</strong> A los 67 tu IPT pasa a llamarse jubilación '+
      '(art. 200.4 LGSS) y cabía temerse que Hacienda dejara de darte por acreditado el 33%. No: el <strong>TEAC, en '+
      'resolución de 19 de julio de 2024 (RG 4263/2023)</strong>, fijó que lo que importa no es el grado que tengas al '+
      'cumplir la edad, sino haber accedido a la jubilación <em>desde</em> una incapacidad permanente total, absoluta o '+
      'gran invalidez. No hace falta certificado del IMSERSO ni ningún trámite: el cambio de nombre es solo eso.'+
      '<div style="margin-top:.3rem">De hecho tu mínimo <strong>sube</strong>, no baja: a los 65 se le suman '+
      fmt(IRPF_MIN_65)+'€ por edad, de '+fmt(IRPF_MIN_BASE+(IRPF_MIN_DISC[c.discapacidad]||0))+'€ a '+
      fmt(IRPF_MIN_BASE+IRPF_MIN_65+(IRPF_MIN_DISC[c.discapacidad]||0))+'€.</div>'+
      '<div style="margin-top:.3rem;color:var(--amber)">Lo que sí pierdes son los <strong>3.500€ de gastos deducibles '+
      'del art. 19.2.f</strong>: esos son solo para <em>trabajadores activos</em> y desaparecen el día que dejas de '+
      'trabajar. Están contados en la comparativa de puestos y NO en esta ficha, que es lo correcto.</div></div>';
    h+='<div style="background:#FFF6E0;border:1px solid #E8C97A;border-radius:6px;padding:.5rem .6rem;font-size:11px;color:var(--amber);margin-top:.45rem">'+
      '<strong>Dos pagadores: no te fíes de la retención.</strong> Clases Pasivas y el INSS te retendrán cada uno por su cuenta, '+
      'como si el otro no existiera, así que cada retención saldrá de un tramo bajo y la <strong>suma se quedará corta</strong>. '+
      'Lo que ves aquí es el IRPF de verdad del año, el que acaba saliendo en la declaración; el neto mensual que veas en el banco '+
      'será mayor y en junio tendrás que devolver la diferencia. Con dos pagadores además <strong>declarar deja de ser opcional</strong> '+
      'a partir de '+fmt(IRPF_LIM_2PAG)+'€ en vez de '+fmt(IRPF_LIM_1PAG)+'€ (art. 96 LIRPF), y tú los superas de largo. '+
      'Puedes pedirle a cualquiera de los dos que te retenga de más para no llevarte el susto.</div>';
    h+='<div style="font-size:10.5px;color:var(--faint);margin-top:.35rem">'+
      'Cálculo de contribuyente individual sin más rentas, sin hijos y sin deducciones autonómicas. '+
      'Las escalas autonómicas cambian con cada presupuesto: comprueba la tuya el año que te jubiles de verdad.</div>';
  })();

  // ── 7. Año a año ──────────────────────────────────────────────────
  h+='<div style="font-size:12px;font-weight:700;margin:.7rem 0 .35rem">Año a año: ¿y si aguanto uno más?</div>';
  h+='<div style="font-size:10.5px;color:var(--muted);margin-bottom:.35rem">'+
    'En euros de hoy. Hasta los '+c.edadForzosa+' la fecha de cada fila es el aniversario de tu ingreso, que es cuando se '+
    'completa un año de servicio; a partir de ahí es tu cumpleaños, que es cuando se completa un año de prórroga y salta otro '+
    '4% de demora. Las filas marcadas <em>prórroga</em> dependen de que te la autoricen. Una <strong>?</strong> junto a la IPT '+
    'significa que ese año ya has pasado de los 67 y el +20% es dudoso. '+
    'El <strong>neto</strong> descuenta el IRPF del año entero, no la retención mensual.</div>';
  h+='<div class="tbl-scroll" style="max-height:340px;overflow:auto"><table class="detail-table" style="font-size:11px">'+
    '<thead><tr><th>Año</th><th>Edad</th><th class="jub-x">Años serv.</th><th class="jub-x">% escala</th><th class="jub-x">Demora</th>'+
    '<th class="jub-x">Clases Pasivas</th><th class="jub-x">IPT</th><th>Bruto/mes</th><th>IRPF</th>'+
    '<th>Neto/mes</th><th class="jub-x"></th></tr></thead><tbody>';
  T.filas.forEach(e=>{
    const marca=e.esForzosa;
    h+='<tr'+(marca?' style="background:color-mix(in srgb,var(--navy) 8%,transparent);font-weight:600"':'')+'>'+
      '<td>'+e.anio+(marca?' ★':'')+
        '<div class="jub-m">'+e.K.aniosTotal+' años · '+pc(e.K.C1)+
        (e.D.puntos?' +'+(e.D.puntos*100).toFixed(0)+' demora':'')+
        (e.necesitaPermiso?' · prórroga':'')+'</div></td><td>'+e.edad+'</td>'+
      '<td class="jub-x">'+e.K.aniosTotal+'</td><td class="jub-x">'+pc(e.K.C1)+'</td>'+
      '<td class="jub-x">'+(e.D.puntos?'+'+(e.D.puntos*100).toFixed(0)+'%':'<span style="color:var(--faint)">—</span>')+'</td>'+
      '<td class="jub-x">'+eur(e.cpMes)+'</td>'+
      '<td class="jub-x">'+eur(e.iptMes)+(e.I.dudoso?' <span title="Pasados los 67 el INSS suele denegar el +20%" style="color:var(--amber)">?</span>':'')+'</td>'+
      '<td>'+eur(e.totalMes)+'</td>'+
      '<td style="color:var(--red)">−'+eur(e.irpf.cuota/12)+'<div class="jub-x" style="font-size:9px;color:var(--faint)">'+
        (e.tipoMedio*100).toFixed(1).replace('.',',')+'%</div></td>'+
      '<td style="font-weight:700;color:var(--teal)">'+eur(e.netoMes)+'</td>'+
      '<td class="jub-x" style="font-size:9px;color:var(--faint);white-space:nowrap">'+
        (e.necesitaPermiso?'prórroga':(e.esForzosa?'forzosa':''))+
        (e.pctTope>0.95?' <span style="color:var(--amber)">tope</span>':'')+'</td></tr>';
  });
  h+='</tbody></table></div>';

  // ── 8. Tope conjunto ──────────────────────────────────────────────
  const peor=T.filas[T.filas.length-1];
  if(peor){
    const pctT=peor.totalAnual/CP_MAX_2026_ANIO;
    h+='<div style="font-size:11.5px;color:'+(pctT>0.9?'var(--amber)':'var(--muted)')+';margin-top:.5rem">'+
      'El tope de pensiones públicas de 2026 es <strong>'+eur(CP_MAX_2026_ANIO)+'/año</strong> ('+eur(CP_MAX_2026_MES)+'/mes) '+
      'y se aplica a la <strong>suma</strong> de las dos, no a cada una (art. 3 del RD 241/2026). '+
      'Tu escenario más alto llegaría a '+eur(peor.totalAnual)+'/año, el <strong>'+Math.round(pctT*100)+'%</strong> del tope'+
      (pctT>1?': habría recorte.':'. No te recorta.')+'</div>';
  }

  // ── 9. Qué cubre de tu gasto ──────────────────────────────────────
  try{
    const S=(typeof ahorroRango==='function')?ahorroRango(primerDiaHaceNMeses(12).slice(0,7),ultimoDiaMesAnterior().slice(0,7)):null;
    if(S&&S.gasOrd>0&&eFor){
      const gastoMes=S.gasOrd/S.n;
      const cob=eFor.netoMes/gastoMes;   // v113 · el gasto se paga con el neto, no con el bruto
      h+='<div style="background:'+(cob>=1?'#E8F5EE':'#FFF6E0')+';border:1px solid '+(cob>=1?'#9ED4B4':'#E8C97A')+
        ';border-radius:6px;padding:.55rem .65rem;font-size:11.5px;color:'+(cob>=1?'var(--teal)':'var(--amber)')+';margin-top:.6rem">'+
        'Gastas <strong>'+eur(gastoMes)+'/mes</strong> (ordinario, últimos 12 meses cerrados). '+
        'Jubilándote a los '+c.edadForzosa+' las dos pensiones te dejarían <strong>'+eur(eFor.netoMes)+'/mes limpios</strong>, '+
        'el <strong>'+Math.round(cob*100)+'%</strong> de lo que gastas'+
        (cob<1?'; el hueco sería de <strong>'+eur(gastoMes-eFor.netoMes)+'/mes</strong> a cargo de tu patrimonio.'
              :'. Sobrarían '+eur(eFor.netoMes-gastoMes)+'/mes.')+
        ' Comparado en euros de hoy, sin inflación por ninguno de los dos lados.</div>';
    }
  }catch(e){console.warn('cobertura',e);}

  // ── 10. Revalorización año a año (proyección nominal) ─────────────
  h+='<div style="font-size:12px;font-weight:700;margin:.7rem 0 .35rem">Revalorización real</div>'+
    '<div style="font-size:10.5px;color:var(--muted);margin-bottom:.35rem">'+
    'Cuando se publique la revalorización de un año, escríbela y todo lo posterior se recalcula. '+
    'En blanco se usa el '+num('revalDefaultPct',(c.revalDefault*100).toFixed(1),46,'0.1')+'% por defecto.</div>';
  const y0=new Date().getFullYear();
  let hab=CP_HABER_2026[c.grupo]||c.haberReg, ipt=c.iptMes;
  h+='<div class="tbl-scroll" style="max-height:220px;overflow:auto"><table class="detail-table" style="font-size:11px">'+
    '<thead><tr><th>Año</th><th>Reval. CP</th><th>Reval. IPT</th><th class="jub-x">Haber regulador '+c.grupo+'</th><th>IPT/mes</th></tr></thead><tbody>';
  for(let y=y0;y<=Number(F.fMax.slice(0,4));y++){
    if(y>2026){hab*=(1+pensionReval(y,'cp'));ipt*=(1+pensionReval(y,'ipt'));}
    const propio=!!(c.reval[y]);
    h+='<tr'+(propio?' style="background:color-mix(in srgb,var(--teal) 7%,transparent)"':'')+'><td>'+y+'</td>'+
      '<td><input type="number" step="0.1" value="'+(c.reval[y]&&c.reval[y].cp!=null?(c.reval[y].cp*100).toFixed(1):'')+
        '" placeholder="'+(pensionReval(y,'cp')*100).toFixed(1)+'" onchange="setPensionReval('+y+',\'cp\',this.value)" style="width:52px;font-size:10.5px;padding:0 3px;text-align:right"></td>'+
      '<td><input type="number" step="0.1" value="'+(c.reval[y]&&c.reval[y].ipt!=null?(c.reval[y].ipt*100).toFixed(1):'')+
        '" placeholder="'+(pensionReval(y,'ipt')*100).toFixed(1)+'" onchange="setPensionReval('+y+',\'ipt\',this.value)" style="width:52px;font-size:10.5px;padding:0 3px;text-align:right"></td>'+
      '<td class="jub-x">'+eur(hab)+'</td><td>'+eur2(ipt)+'</td></tr>';
  }
  h+='</tbody></table></div>';

  // ── 11. De dónde sale cada cifra ──────────────────────────────────
  const K=eFor||eVol;
  h+='<details style="margin-top:.6rem"><summary style="font-size:11.5px;font-weight:600;cursor:pointer">De dónde sale cada cifra</summary>'+
    '<div style="font-size:11px;color:var(--muted);margin-top:.4rem;line-height:1.55">'+
    '<strong>Estás en Clases Pasivas, no en el Régimen General.</strong> Tus nóminas descuentan '+
    '<strong>3,86% de derechos pasivos</strong> y <strong>1,69% de MUFACE</strong> sobre el haber regulador de cotización '+
    'del subgrupo '+c.grupo+' ('+eur(CP_COTIZ[c.grupo]||0)+'/año, congelado desde los PGE 2023). '+
    'Eso da '+eur2((CP_COTIZ[c.grupo]||0)*0.0386/14)+' y '+eur2((CP_COTIZ[c.grupo]||0)*0.0169/14)+' al mes: exactamente lo que te retienen.'+
    '<br><br><strong>La pensión</strong> no se calcula sobre esa base sino sobre el haber regulador de cálculo, que es mayor: '+
    eur(CP_HABER_2026[c.grupo]||0)+'/año para '+c.grupo+' en 2026 (RD 241/2026, anexo III).'+
    (K&&K.K.hayDosCuerpos?('<br><br><strong>Como has servido en dos cuerpos</strong> se aplica el art. 31.2: '+
      'P = R₁·C₁ + (R₂−R₁)·C₂, en orden cronológico. Para ti R₁ = '+eur(K.K.R1)+' ('+c.grupoIni+') y '+
      'R₂ = '+eur(K.K.R2)+' ('+c.grupo+'), con un salto de '+eur(K.K.R2-K.K.R1)+'. '+
      'C₁ es el porcentaje por tus años <em>totales</em> y C₂ el de los años desde que eres '+c.grupo+'. '+
      'Los '+K.K.arrastre+' meses sueltos del primer tramo se arrastran al segundo (art. 31.3).'):'')+
    '<br><br><strong>La jubilación forzosa en Clases Pasivas sigue en los 65</strong>, no se ha retrasado a 67 como en el '+
    'Régimen General. La voluntaria pide 60 años y 30 de servicio, y <strong>no lleva coeficientes reductores</strong>: '+
    'si sale menos es solo porque bajas en la escala.'+
    '<br><br><strong>El complemento por demora sí existe en Clases Pasivas</strong> desde 2022: la DA 17ª del RDLeg 670/1987, '+
    'añadida por la Ley 21/2021, extiende el art. 210.2 LGSS. Son 4 puntos por año completo pasados los 65 (y 2 puntos por '+
    'semestre a partir del segundo año, desde abril de 2025). Aquí se aplica sobre el haber regulador de tu último cuerpo, '+
    'que es el equivalente natural de "la respectiva base reguladora"; Clases Pasivas no ha publicado un ejemplo con dos cuerpos, '+
    'así que ese punto conviene confirmarlo.'+
    '<br><br><strong>El IRPF</strong> sale de la escala estatal del art. 63 LIRPF más la autonómica de '+c.ccaa+', '+
    'con los 2.000€ de otros gastos del art. 19.2.f y el mínimo personal y familiar de los arts. 57 y 60. '+
    'Es el impuesto del año completo, calculado como en la declaración; la retención mensual sigue otras reglas y con dos '+
    'pagadores se queda corta a propósito. No se incluyen deducciones autonómicas ni estatales que puedas tener.'+
    '<br><br><strong>Lo que no puedo saber por ti:</strong> tus años de servicio reconocidos oficialmente. Pídele a tu '+
    'habilitación el <em>certificado de servicios efectivos</em>: los trienios de la nómina no son la misma cuenta.'+
    '</div></details>';

  box.innerHTML=h;
  markScrollables(box);
}

// ─── INIT ───────────────────────────────────────────────────────────
// v169 · Solo en la app de siempre: en la versión nueva el motor va encerrado
// (__LEG existe) y no pinta nada. Y si el motor no es de la misma versión que
// la página, no se arranca: mejor un aviso que media app con datos a medias.
if(typeof __LEG==='undefined'){
if(typeof MOTOR_ESPERADO!=='undefined'&&MOTOR_ESPERADO!==MOTOR_VERSION){ motorComprobar(MOTOR_VERSION); }
else {
load();
migrateFundIdent();
try{detectarNoRecurrentes();}catch(e){console.warn('noRec',e);}
restoreSectionStates();
resetNominaConcepts();
// Default the entry form to the current month
(function(){
  const t=new Date();
  const fy=document.getElementById('fy'); if(fy)fy.value=t.getFullYear();
  const fm=document.getElementById('fm'); if(fm)fm.value=t.getMonth()+1;
})();
renderAll();
goToCurrentMonth();
applyDarkPref();
renderBackupReminder();
try{_recatOpen=ALM.getItem('dlv_recatopen')==='1';}catch(e){fallo('_recatOpen',e)}
renderRecatPanel();
renderUndoBar();
renderDiag();
renderSyncPanel();
renderPersonalBanner();
renderDegiroPanel();
initTodayDates();
wrapTables();
initLayoutObserver();
// v115 · Compactar la barra al bajar. Se usa un umbral con histéresis para que
// no parpadee justo en el límite.
(function(){
  const tb=document.querySelector('.topbar'); if(!tb)return;
  let compacta=false;
  const on=()=>{
    const y=window.scrollY||document.documentElement.scrollTop||0;
    if(!compacta&&y>90){compacta=true;tb.classList.add('compacta');}
    else if(compacta&&y<40){compacta=false;tb.classList.remove('compacta');}
  };
  window.addEventListener('scroll',on,{passive:true});
  on();
})();

}
}
