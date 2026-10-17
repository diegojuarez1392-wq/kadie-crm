'use strict';
const multer=require('multer');
const XLSX=require('xlsx');
const crypto=require('crypto');
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:15*1024*1024}});

const txt=(v,n=1500)=>String(v??'').trim().slice(0,n);
const num=v=>{if(typeof v==='number')return Number.isFinite(v)?v:0;const x=Number(String(v??'').replace(/[^0-9.-]/g,''));return Number.isFinite(x)?x:0};
const phone=v=>String(v??'').replace(/\D/g,'').slice(0,20);
function dateISO(v){if(v instanceof Date&&!isNaN(v))return v.toISOString().slice(0,10);if(typeof v==='number'){const d=XLSX.SSF.parse_date_code(v);if(d)return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;}const s=String(v||'').trim();if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;return null}
function rowVal(r,names){for(const n of names){if(Object.prototype.hasOwnProperty.call(r,n)&&r[n]!==''&&r[n]!=null)return r[n]}return ''}
function normalizedStatus(sent,store,confirmation){const s=txt(sent,80).toUpperCase();const st=txt(store,80).toUpperCase();const c=txt(confirmation,80).toUpperCase();if(s.includes('CANCEL')||c.includes('CANCEL'))return 'Cancelado';if(s.includes('REPROGRAM'))return 'Reprogramado';if(s.includes('POR ENVIAR'))return 'Por enviar';if(st.includes('ENTREGADO'))return 'Entregado';if(s==='SI'||s==='SÍ')return 'Enviado';return c.includes('CONFIRM')?'Confirmado':'Pendiente'}
function keyFor(sheet,order,phoneNum,date,product){return crypto.createHash('sha1').update([sheet,order,phoneNum,date,product].join('|')).digest('hex')}

module.exports=function registerOrderOps({app,db}){
  app.get('/api/order-ops',async(req,res)=>{
    try{
      if(!db)throw new Error('Base de datos no configurada');
      let q=db.from('orders').select('*').eq('source','operational_excel').order('created_at',{ascending:false});
      const from=txt(req.query.from,10),to=txt(req.query.to,10),status=txt(req.query.status,80),advisor=txt(req.query.advisor,120),courier=txt(req.query.courier,120),store=txt(req.query.store,120),search=txt(req.query.search,120);
      if(from)q=q.gte('created_at',`${from}T00:00:00Z`);if(to)q=q.lte('created_at',`${to}T23:59:59Z`);if(status)q=q.eq('status',status);if(advisor)q=q.eq('advisor',advisor);if(courier)q=q.eq('courier',courier);if(store)q=q.eq('store',store);
      const {data,error}=await q.limit(1000);if(error)throw error;let rows=data||[];
      if(search){const s=search.toLowerCase();rows=rows.filter(x=>[x.customer_name,x.phone,x.order_number,x.product,x.district,x.province].some(v=>String(v||'').toLowerCase().includes(s)))}
      const total=rows.length,porEnviar=rows.filter(x=>x.status==='Por enviar').length,enviados=rows.filter(x=>x.status==='Enviado').length,reprogramados=rows.filter(x=>x.status==='Reprogramado').length,cancelados=rows.filter(x=>x.status==='Cancelado').length;
      const sum=rows.reduce((s,x)=>s+num(x.amount),0);
      const opts=k=>[...new Set(rows.map(x=>x[k]).filter(Boolean))].sort();
      res.json({rows,metrics:{total,porEnviar,enviados,reprogramados,cancelados,sales:sum},filters:{advisors:opts('advisor'),couriers:opts('courier'),stores:opts('store')}});
    }catch(e){res.status(400).json({error:e.message})}
  });

  app.get('/api/order-ops/uploads',async(_req,res)=>{if(!db)return res.json([]);const {data,error}=await db.from('order_uploads').select('*').order('created_at',{ascending:false}).limit(20);if(error)return res.status(400).json({error:error.message});res.json(data||[])});

  app.post('/api/order-ops/upload',upload.single('file'),async(req,res)=>{
    try{
      if(!db)throw new Error('Base de datos no configurada');if(!req.file)throw new Error('Selecciona un Excel');
      const wb=XLSX.read(req.file.buffer,{type:'buffer',cellDates:true});
      const supported=wb.SheetNames.filter(n=>['KADIE STORE','ELKE'].includes(n.trim().toUpperCase()));
      if(!supported.length)throw new Error('No encontré las hojas KADIE STORE o ELKE en el archivo');
      const rows=[];
      for(const sheet of supported){
        const data=XLSX.utils.sheet_to_json(wb.Sheets[sheet],{defval:'',raw:true});
        data.forEach((r,i)=>{
          const isElke=sheet.trim().toUpperCase()==='ELKE';
          const date=dateISO(rowVal(r,isElke?['Fecha']:['Columna 1','FECHA']));
          const order=txt(rowVal(r,isElke?['# Pedido']:['FECHA','# Pedido']),100);
          const customer=txt(rowVal(r,['Nombre']),300), phoneNum=phone(rowVal(r,isElke?['Número']:['NUMERO','Número']));
          const product=txt(rowVal(r,['Producto']),1500);if(!date||(!order&&!phoneNum&&!customer))return;
          const amount=num(rowVal(r,['Total']));
          const sent=txt(rowVal(r,isElke?['ENVIADO']:['ENVIADO']),80);
          const confirmation=txt(rowVal(r,isElke?['Confirmacion']:['Confirmacion']),80);
          const store=txt(rowVal(r,isElke?['Estado']:['TIENDA']),100);
          const address=txt(rowVal(r,isElke?['Dirección']:['3','Dirección']),1500);
          const district=txt(rowVal(r,['Distrito']),300);
          const province=txt(rowVal(r,['Provincia']),300);
          const department=txt(rowVal(r,['Departamento']),300);
          const shippingDate=dateISO(rowVal(r,isElke?['ENVIAR NUEVAMENTE ']:['FECHA DE ENVIO']));
          const advisor=txt(rowVal(r,['VENDEDOR']),120);
          const importKey=keyFor(sheet,order,phoneNum,date,product);
          rows.push({customer_name:customer,phone:phoneNum,product,amount,cogs:num(rowVal(r,['COGS'])),delivery_cost:num(rowVal(r,['Costo Envío'])),handling_cost:num(rowVal(r,['Handling'])),district,address,reference:txt(rowVal(r,['OBSERVACIONES(REFERENCIA)']),1500),status:normalizedStatus(sent,store,confirmation),advisor,created_at:`${date}T12:00:00Z`,updated_at:new Date().toISOString(),order_number:order,dni:txt(rowVal(r,['DNI']),60),payment_method:txt(rowVal(r,['Método de Pago']),100),shipping_method:txt(rowVal(r,['Método de Envío']),100),courier:txt(rowVal(r,['Courier']),100),province,department,source:'operational_excel',quantity:num(rowVal(r,['Cantidad']))||1,contacted:txt(rowVal(r,['Contactado']),80),confirmation,store,shipment_note:txt(rowVal(r,['PAQUETE DEVUELTO A REPROGRAMAR']),300),shipping_date:shippingDate,sent_status:sent,import_key:importKey,imported_sheet:sheet,import_filename:req.file.originalname});
        });
      }
      let imported=0;
      for(let i=0;i<rows.length;i+=250){const batch=rows.slice(i,i+250);const {error}=await db.from('orders').upsert(batch,{onConflict:'import_key'});if(error)throw error;imported+=batch.length;}
      await db.from('order_uploads').insert({filename:req.file.originalname,imported_rows:imported,updated_rows:0,skipped_rows:0,sheets:supported});
      res.json({ok:true,imported,sheets:supported});
    }catch(e){console.error('Operational upload:',e);res.status(400).json({error:e.message})}
  });

  app.patch('/api/order-ops/:id',async(req,res)=>{
    try{if(!db)throw new Error('Base de datos no configurada');const allowed=['status','sent_status','shipment_note','shipping_date','advisor','courier'];const patch={updated_at:new Date().toISOString()};for(const k of allowed)if(Object.prototype.hasOwnProperty.call(req.body||{},k))patch[k]=txt(req.body[k],300)||null;const {data,error}=await db.from('orders').update(patch).eq('id',req.params.id).select().single();if(error)throw error;res.json(data)}catch(e){res.status(400).json({error:e.message})}
  });
};
