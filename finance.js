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
      let oq=db.from('orders').select('*').gte('created_at',start).lte('created_at',end);
      let dq=db.from('orders').select('*').in('status',['Entregado','Liquidado']).gte('delivered_at',start).lte('delivered_at',end);
      if(req.query.product){oq=oq.eq('product',req.query.product);dq=dq.eq('product',req.query.product);}
      if(req.query.campaign){oq=oq.eq('campaign',req.query.campaign);dq=dq.eq('campaign',req.query.campaign);}
      const [or,dr,er]=await Promise.all([
        oq,
        dq,
        db.from('finance_expenses').select('*').gte('expense_date',from).lte('expense_date',to).order('expense_date',{ascending:true})
      ]);
      if(or.error) throw or.error; if(dr.error) throw dr.error; if(er.error) throw er.error;
      const orders=or.data||[], delivered=dr.data||[], expenses=er.data||[];
      const sales=delivered.reduce((s,x)=>s+n(x.amount),0);
      const cogs=delivered.reduce((s,x)=>s+n(x.cogs),0);
      const delivery=delivered.reduce((s,x)=>s+n(x.delivery_cost),0);
      const handling=delivered.reduce((s,x)=>s+n(x.handling_cost),0);
      const external=expenses.reduce((s,x)=>s+n(x.amount),0);
      const adSpend=expenses.filter(x=>/(meta|facebook|tiktok|ads|publicidad)/i.test(x.category||'')).reduce((s,x)=>s+n(x.amount),0);
      const profit=sales-cogs-delivery-handling-external;
      const days={};
      const dayrow=d=>days[d]||(days[d]={date:d,sales:0,cogs:0,delivery:0,handling:0,expenses:0,profit:0});
      delivered.forEach(x=>{const d=String(x.delivered_at||x.created_at).slice(0,10),r=dayrow(d);r.sales+=n(x.amount);r.cogs+=n(x.cogs);r.delivery+=n(x.delivery_cost);r.handling+=n(x.handling_cost)});
      expenses.forEach(x=>{const r=dayrow(String(x.expense_date));r.expenses+=n(x.amount)});
      Object.values(days).forEach(r=>r.profit=r.sales-r.cogs-r.delivery-r.handling-r.expenses);
      const products=[...new Set(orders.map(x=>x.product).filter(Boolean))].sort();
      const campaigns=[...new Set(orders.map(x=>x.campaign).filter(Boolean))].sort();
      res.json({from,to,metrics:{orders:orders.length,delivered:delivered.length,sales,cogs,delivery,handling,expenses:external,adSpend,profit,margin:sales?profit/sales*100:0,avgTicket:delivered.length?sales/delivered.length:0,roas:adSpend?sales/adSpend:0,poas:adSpend?profit/adSpend:0,cpa:delivered.length?adSpend/delivered.length:0},daily:Object.values(days).sort((a,b)=>a.date.localeCompare(b.date)),expenses,products,campaigns});
    }catch(e){res.status(500).json({error:e.message});}
  });

  app.post('/api/finance/expenses',financeAuth,async(req,res)=>{
    try{
      if(!db) throw new Error('Base de datos no configurada');
      const expense_date=isoDay(req.body?.expense_date); const category=String(req.body?.category||'').trim().slice(0,80); const amount=n(req.body?.amount); const notes=String(req.body?.notes||'').trim().slice(0,500);
      if(!expense_date||!category||amount<=0) return res.status(400).json({error:'Completa fecha, categoría y un monto mayor a 0'});
      const {data,error}=await db.from('finance_expenses').insert({expense_date,category,amount,notes}).select().single(); if(error) throw error;
      res.json(data);
    }catch(e){res.status(500).json({error:e.message});}
  });
};
