'use strict';
const crypto = require('crypto');

module.exports = function registerFinance({ app, db }) {
  const PASSWORD = process.env.FINANCE_PASSWORD || '';
  const SECRET = process.env.FINANCE_SESSION_SECRET || crypto.createHash('sha256').update(`kadie:${PASSWORD}`).digest('hex');
  const COOKIE = 'kadie_finance';
  const attempts = new Map();

  const n = v => Number(v || 0);
  const isoDay = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : null;
  const safeEq = (a,b) => {
    const x=Buffer.from(String(a||'')), y=Buffer.from(String(b||''));
    return x.length===y.length && crypto.timingSafeEqual(x,y);
  };
  const cookies = req => Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),decodeURIComponent(x.slice(i+1))]}));
  const sign = exp => crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
  const validToken = token => {
    const [exp,sig] = String(token||'').split('.');
    if(!exp || !sig || Number(exp) < Date.now()) return false;
    return safeEq(sig, sign(exp));
  };
  const financeAuth = (req,res,next) => {
    if(!PASSWORD) return res.status(503).json({error:'Finanzas aún no tiene contraseña configurada',code:'finance_not_configured'});
    if(!validToken(cookies(req)[COOKIE])) return res.status(401).json({error:'Finanzas bloqueado',code:'finance_locked'});
    next();
  };

  async function fetchAll(makeQuery, pageSize=900){
    const rows=[];
    for(let from=0;;from+=pageSize){
      const q=makeQuery().range(from,from+pageSize-1);
      const {data,error}=await q;
      if(error) throw error;
      rows.push(...(data||[]));
      if(!data || data.length<pageSize) break;
    }
    return rows;
  }

  app.get('/api/finance/status',(req,res)=>res.json({configured:Boolean(PASSWORD),unlocked:Boolean(PASSWORD&&validToken(cookies(req)[COOKIE]))}));

  app.post('/api/finance/unlock',(req,res)=>{
    if(!PASSWORD) return res.status(503).json({error:'Configura FINANCE_PASSWORD en Render'});
    const ip=req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const now=Date.now(); const a=attempts.get(ip)||{count:0,blockedUntil:0};
    if(a.blockedUntil>now) return res.status(429).json({error:'Demasiados intentos. Intenta nuevamente en unos minutos.'});
    if(!safeEq(req.body?.password,PASSWORD)){
      a.count+=1; if(a.count>=5){a.count=0;a.blockedUntil=now+10*60*1000;} attempts.set(ip,a);
      return res.status(401).json({error:'Clave incorrecta'});
    }
    attempts.delete(ip);
    const exp=Date.now()+8*60*60*1000;
    const secure=(req.headers['x-forwarded-proto']==='https');
    res.setHeader('Set-Cookie',`${COOKIE}=${encodeURIComponent(`${exp}.${sign(exp)}`)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${8*60*60}${secure?'; Secure':''}`);
    res.json({ok:true});
  });

  app.post('/api/finance/logout',(_req,res)=>{
    res.setHeader('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ok:true});
  });

  app.get('/api/finance/summary',financeAuth,async(req,res)=>{
    try{
      if(!db) throw new Error('Base de datos no configurada');
      const today=new Date().toISOString().slice(0,10);
      const from=isoDay(req.query.from)||today, to=isoDay(req.query.to)||today;
      const start=`${from}T00:00:00.000Z`, end=`${to}T23:59:59.999Z`;
      const product=String(req.query.product||'').trim();
      const campaign=String(req.query.campaign||'').trim();
      const filtered=Boolean(product||campaign);

      const orderFactory=()=>{
        let q=db.from('orders').select('*').gte('created_at',start).lte('created_at',end).order('created_at',{ascending:true});
        if(product) q=q.eq('product',product);
        if(campaign) q=q.eq('campaign',campaign);
        return q;
      };
      const deliveredFactory=()=>{
        let q=db.from('orders').select('*').in('status',['Entregado','Liquidado']).gte('delivered_at',start).lte('delivered_at',end).order('delivered_at',{ascending:true});
        if(product) q=q.eq('product',product);
        if(campaign) q=q.eq('campaign',campaign);
        return q;
      };

      const [orders,delivered,expenses,history]=await Promise.all([
        fetchAll(orderFactory),
        fetchAll(deliveredFactory),
        fetchAll(()=>db.from('finance_expenses').select('*').gte('expense_date',from).lte('expense_date',to).order('expense_date',{ascending:true})),
        fetchAll(()=>db.from('finance_daily_history').select('*').gte('finance_date',from).lte('finance_date',to).order('finance_date',{ascending:true}))
      ]);

      const categorySum=(re)=>expenses.filter(x=>re.test(String(x.category||''))).reduce((s,x)=>s+n(x.amount),0);
      const manualExpenses=expenses.filter(x=>String(x.source||'manual')!=='excel');
      const manualExtra=manualExpenses.reduce((s,x)=>s+n(x.amount),0);

      let sales,cogs,delivery,handling,metaAds,tiktokAds,personnel,personnel2,profit,daily;

      if(!filtered && history.length){
        sales=history.reduce((s,x)=>s+n(x.sales_total),0);
        cogs=history.reduce((s,x)=>s+n(x.cogs),0);
        delivery=history.reduce((s,x)=>s+n(x.delivery_cost),0);
        handling=history.reduce((s,x)=>s+n(x.handling_cost),0);
        metaAds=history.reduce((s,x)=>s+n(x.facebook_ads),0);
        tiktokAds=history.reduce((s,x)=>s+n(x.tiktok_ads),0);
        personnel=history.reduce((s,x)=>s+n(x.personnel),0);
        personnel2=history.reduce((s,x)=>s+n(x.personnel2),0);
        profit=history.reduce((s,x)=>s+n(x.pl),0)-manualExtra;
        daily=history.map(x=>({date:String(x.finance_date),sales:n(x.sales_total),cogs:n(x.cogs),delivery:n(x.delivery_cost),handling:n(x.handling_cost),metaAds:n(x.facebook_ads),tiktokAds:n(x.tiktok_ads),personnel:n(x.personnel)+n(x.personnel2),expenses:0,profit:n(x.pl)}));
        manualExpenses.forEach(x=>{
          const r=daily.find(d=>d.date===String(x.expense_date));
          if(r){r.expenses+=n(x.amount);r.profit-=n(x.amount);}
        });
      }else{
        sales=delivered.reduce((s,x)=>s+n(x.amount),0);
        cogs=delivered.reduce((s,x)=>s+n(x.cogs),0);
        delivery=delivered.reduce((s,x)=>s+n(x.delivery_cost),0);
        handling=delivered.reduce((s,x)=>s+n(x.handling_cost),0);
        metaAds=categorySum(/meta|facebook/i);
        tiktokAds=categorySum(/tiktok/i);
        personnel=categorySum(/personal|sueld|planilla/i);
        personnel2=0;
        const external=expenses.reduce((s,x)=>s+n(x.amount),0);
        profit=sales-cogs-delivery-handling-external;
        const days={};
        const dayrow=d=>days[d]||(days[d]={date:d,sales:0,cogs:0,delivery:0,handling:0,metaAds:0,tiktokAds:0,personnel:0,expenses:0,profit:0});
        delivered.forEach(x=>{const d=String(x.delivered_at||x.created_at).slice(0,10),r=dayrow(d);r.sales+=n(x.amount);r.cogs+=n(x.cogs);r.delivery+=n(x.delivery_cost);r.handling+=n(x.handling_cost)});
        expenses.forEach(x=>{const r=dayrow(String(x.expense_date));const a=n(x.amount);r.expenses+=a;if(/meta|facebook/i.test(x.category||''))r.metaAds+=a;else if(/tiktok/i.test(x.category||''))r.tiktokAds+=a;else if(/personal|sueld|planilla/i.test(x.category||''))r.personnel+=a;});
        Object.values(days).forEach(r=>r.profit=r.sales-r.cogs-r.delivery-r.handling-r.expenses);
        daily=Object.values(days).sort((a,b)=>a.date.localeCompare(b.date));
      }

      const adSpend=metaAds+tiktokAds;
      const people=personnel+personnel2;
      const otherManual=manualExpenses.filter(x=>!/(meta|facebook|tiktok|ads|publicidad|personal|sueld|planilla|delivery|envio|envío|mercader|producto|cogs|handling)/i.test(x.category||'')).reduce((s,x)=>s+n(x.amount),0);
      const totalCosts=cogs+delivery+handling+adSpend+people+manualExtra;

      const productMap={};
      delivered.forEach(o=>{
        const key=String(o.product||'Sin producto').trim()||'Sin producto';
        const r=productMap[key]||(productMap[key]={product:key,orders:0,sales:0,cogs:0,delivery:0,handling:0,contribution:0,margin:0});
        r.orders+=1;r.sales+=n(o.amount);r.cogs+=n(o.cogs);r.delivery+=n(o.delivery_cost);r.handling+=n(o.handling_cost);
      });
      const productBreakdown=Object.values(productMap).map(r=>{r.contribution=r.sales-r.cogs-r.delivery-r.handling;r.margin=r.sales?r.contribution/r.sales*100:0;return r;}).sort((a,b)=>b.sales-a.sales).slice(0,30);

      const products=[...new Set(orders.map(x=>x.product).filter(Boolean))].sort();
      const campaigns=[...new Set(orders.map(x=>x.campaign).filter(Boolean))].sort();
      const deliveredCount=delivered.length || Math.round(history.reduce((s,x)=>s+n(x.sales_count),0));

      res.json({
        from,to,
        metrics:{orders:orders.length,delivered:deliveredCount,sales,cogs,delivery,handling,metaAds,tiktokAds,adSpend,personnel:people,otherExpenses:otherManual,manualExpenses:manualExtra,totalCosts,profit,margin:sales?profit/sales*100:0,avgTicket:deliveredCount?sales/deliveredCount:0,roas:adSpend?sales/adSpend:0,poas:adSpend?profit/adSpend:0,cpa:deliveredCount?adSpend/deliveredCount:0},
        daily,expenses,products,campaigns,productBreakdown,
        costBreakdown:[
          {name:'Mercadería (COGS)',amount:cogs},
          {name:'Envíos / delivery',amount:delivery},
          {name:'Handling / operación',amount:handling},
          {name:'Meta Ads',amount:metaAds},
          {name:'TikTok Ads',amount:tiktokAds},
          {name:'Personal',amount:people},
          {name:'Otros gastos manuales',amount:otherManual}
        ],
        filteredScope:filtered
      });
    }catch(e){res.status(500).json({error:e.message});}
  });

  app.post('/api/finance/expenses',financeAuth,async(req,res)=>{
    try{
      if(!db) throw new Error('Base de datos no configurada');
      const expense_date=isoDay(req.body?.expense_date); const category=String(req.body?.category||'').trim().slice(0,80); const amount=n(req.body?.amount); const notes=String(req.body?.notes||'').trim().slice(0,500);
      if(!expense_date||!category||amount<=0) return res.status(400).json({error:'Completa fecha, categoría y un monto mayor a 0'});
      const {data,error}=await db.from('finance_expenses').insert({expense_date,category,amount,notes,source:'manual'}).select().single(); if(error) throw error;
      res.json(data);
    }catch(e){res.status(500).json({error:e.message});}
  });
};
