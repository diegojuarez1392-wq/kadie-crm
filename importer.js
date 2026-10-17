'use strict';
const multer=require('multer');
const XLSX=require('xlsx');
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024}});

function normPhone(v){return String(v||'').replace(/\D/g,'').slice(0,20)}
function txt(v,n=1200){return String(v??'').trim().slice(0,n)}
function num(v){const x=Number(v);return Number.isFinite(x)?x:0}
function dateISO(v){if(v instanceof Date&&!isNaN(v))return v.toISOString().slice(0,10);if(typeof v==='number'){const d=XLSX.SSF.parse_date_code(v);if(d)return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;}const s=String(v||'').trim();if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;return null}
function isCancelled(r){const f=String(r['Total']??'').toUpperCase();const p=String(r['Producto']??'').toUpperCase();return f.includes('CANCEL')||f==='CELADO'||p.includes('CANCELÓ TODO')||p.includes('CANCELO TODO')||p.includes('(CANCEL')}

module.exports=function registerImporter({app,db}){
  app.get('/api/import/status',async(_req,res)=>{
    if(!db)return res.json({configured:false,orders:0,customers:0,financeDays:0});
    const [o,c,f]=await Promise.all([
      db.from('orders').select('id',{count:'exact',head:true}).eq('source','excel'),
      db.from('customers').select('id',{count:'exact',head:true}).eq('source','excel'),
      db.from('finance_daily_history').select('finance_date',{count:'exact',head:true}).eq('source','excel')
    ]);
    res.json({configured:true,orders:o.count||0,customers:c.count||0,financeDays:f.count||0});
  });

  app.post('/api/import/excel',upload.single('file'),async(req,res)=>{
    try{
      if(!db)throw new Error('Base de datos no configurada');
      if(!req.file)throw new Error('Selecciona un archivo Excel');
      const wb=XLSX.read(req.file.buffer,{type:'buffer',cellDates:true});
      const pedidosName=wb.SheetNames.find(x=>x.trim().toUpperCase()==='PEDIDOS 1')||wb.SheetNames.find(x=>x.toUpperCase().includes('PEDIDOS'));
      const bbddName=wb.SheetNames.find(x=>x.trim().toUpperCase()==='BBDD');
      if(!pedidosName||!bbddName)throw new Error('El Excel debe contener las hojas BBDD y PEDIDOS 1');
      const pedidos=XLSX.utils.sheet_to_json(wb.Sheets[pedidosName],{defval:'',raw:true});
      const bbdd=XLSX.utils.sheet_to_json(wb.Sheets[bbddName],{range:11,defval:'',raw:true});
      const orderRows=[];
      pedidos.forEach((r,i)=>{
        const d=dateISO(r['Fecha']); if(!d)return;
        const cancel=isCancelled(r);
        const rawTotal=r['Total']; const amount=typeof rawTotal==='number'?rawTotal:num(rawTotal);
        orderRows.push({customer_name:txt(r['Nombre'],300),phone:normPhone(r['Número']),product:txt(r['Producto']),amount:cancel?0:amount,cogs:num(r['COGS']),delivery_cost:num(r['Costo Envío']),handling_cost:num(r['Handling']),district:txt(r['Distrito'],300),address:txt(r['Dirección']),reference:'',status:cancel?'Cancelado':'Entregado',campaign:null,ad_name:null,advisor:null,delivered_at:cancel?null:`${d}T12:00:00Z`,created_at:`${d}T12:00:00Z`,updated_at:`${d}T12:00:00Z`,order_number:txt(r['# Pedido'],100),dni:txt(r['DNI'],60),payment_method:txt(r['Método de Pago'],100),shipping_method:txt(r['Método de Envío'],100),courier:txt(r['Courier'],100),province:txt(r['Provincia'],200),department:txt(r['Departamento'],200),excel_sales_flag:num(r['VENTAS']),source:'excel',source_row:i+2});
      });
      const financeRows=[]; const expenseRows=[];
      bbdd.forEach(r=>{
        const d=dateISO(r['FECHA']);if(!d)return;
        const fr={finance_date:d,sales_count:num(r['Cantidad de Ventas']),sales_total:num(r['Ventas Totales']),cogs:num(r['COGS']),delivery_cost:num(r['Costo de envíos']),handling_cost:num(r['Costos Handling']),facebook_ads:num(r['Facebook ads']),tiktok_ads:num(r['Tiktok Ads']),personnel:num(r['Personal']),pl:num(r['P/L']),margin:num(r['%']),roas:num(r['ROAS']),poas:num(r['POAS']),cpa:num(r['CPA Promedio']),month_label:txt(r['MES'],50),personnel2:num(r['PERSONAL2']),roi_ads:num(r['ROI EN ADDS']),source:'excel'};
        financeRows.push(fr);
        [['Meta Ads','facebook_ads'],['TikTok Ads','tiktok_ads'],['Personal','personnel']].forEach(([cat,k])=>{if(fr[k]>0)expenseRows.push({expense_date:d,category:cat,amount:fr[k],notes:'Importado desde Excel histórico',source:'excel',external_key:`excel:${d}:${cat}`})});
      });
      for(let i=0;i<orderRows.length;i+=250){const {error}=await db.from('orders').upsert(orderRows.slice(i,i+250),{onConflict:'source,source_row'});if(error)throw error;}
      for(let i=0;i<financeRows.length;i+=250){const {error}=await db.from('finance_daily_history').upsert(financeRows.slice(i,i+250),{onConflict:'finance_date'});if(error)throw error;}
      for(let i=0;i<expenseRows.length;i+=250){const {error}=await db.from('finance_expenses').upsert(expenseRows.slice(i,i+250),{onConflict:'external_key'});if(error)throw error;}
      const customerMap=new Map();
      for(const r of orderRows){if(!r.phone)continue;const old=customerMap.get(r.phone);const delivered=r.status==='Entregado';if(!old){customerMap.set(r.phone,{phone:r.phone,customer_name:r.customer_name,dni:r.dni,address:r.address,district:r.district,province:r.province,department:r.department,first_order_at:r.created_at,last_order_at:r.created_at,total_orders:delivered?1:0,total_spend:delivered?r.amount:0,source:'excel',updated_at:new Date().toISOString()});}else{if(r.created_at<old.first_order_at)old.first_order_at=r.created_at;if(r.created_at>=old.last_order_at){old.last_order_at=r.created_at;old.customer_name=r.customer_name||old.customer_name;old.dni=r.dni||old.dni;old.address=r.address||old.address;old.district=r.district||old.district;old.province=r.province||old.province;old.department=r.department||old.department;}if(delivered){old.total_orders++;old.total_spend+=r.amount;}}}
      const customers=[...customerMap.values()];
      for(let i=0;i<customers.length;i+=250){const {error}=await db.from('customers').upsert(customers.slice(i,i+250),{onConflict:'phone'});if(error)throw error;}
      res.json({ok:true,orders:orderRows.length,customers:customers.length,financeDays:financeRows.length,expenses:expenseRows.length});
    }catch(e){console.error('Import Excel:',e);res.status(400).json({error:e.message});}
  });
};
