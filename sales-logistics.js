'use strict';

const txt=(v,n=1200)=>String(v??'').trim().slice(0,n);
const phone=v=>String(v??'').replace(/\D/g,'').slice(0,20);
const num=v=>{const x=Number(v);return Number.isFinite(x)?x:0};
const validStatus=new Set(['Nuevo','Confirmado','Por enviar','Enviado','Entregado','Reprogramado','Cancelado']);

module.exports=function registerSalesLogistics({app,db}){
  app.get('/api/products',async(_req,res)=>{
    try{if(!db)throw new Error('Base de datos no configurada');const {data,error}=await db.from('product_catalog').select('*').eq('active',true).order('name',{ascending:true});if(error)throw error;res.json(data||[])}catch(e){res.status(400).json({error:e.message})}
  });

  app.get('/api/sales-orders',async(req,res)=>{
    try{
      if(!db)throw new Error('Base de datos no configurada');
      let q=db.from('orders').select('*').eq('source','crm').order('created_at',{ascending:false});
      const from=txt(req.query.from,10),to=txt(req.query.to,10),status=txt(req.query.status,80),courier=txt(req.query.courier,80),advisor=txt(req.query.advisor,100);
      if(from)q=q.gte('created_at',`${from}T00:00:00Z`);if(to)q=q.lte('created_at',`${to}T23:59:59Z`);if(status)q=q.eq('status',status);if(courier)q=q.eq('courier',courier);if(advisor)q=q.eq('advisor',advisor);
      const {data,error}=await q.limit(1000);if(error)throw error;
      let rows=data||[];const search=txt(req.query.search,150).toLowerCase();if(search)rows=rows.filter(r=>[r.order_number,r.customer_name,r.phone,r.dni,r.product].some(v=>String(v||'').toLowerCase().includes(search)));
      const options=k=>[...new Set(rows.map(x=>x[k]).filter(Boolean))].sort();
      res.json({rows,filters:{advisors:options('advisor'),couriers:options('courier')}});
    }catch(e){res.status(400).json({error:e.message})}
  });

  app.post('/api/sales-orders',async(req,res)=>{
    try{
      if(!db)throw new Error('Base de datos no configurada');
      const productId=txt(req.body?.product_catalog_id,80);if(!productId)throw new Error('Selecciona un producto o combo');
      const {data:product,error:pe}=await db.from('product_catalog').select('*').eq('id',productId).eq('active',true).single();if(pe)throw pe;
      const customer=txt(req.body?.customer_name,300),p=phone(req.body?.phone),address=txt(req.body?.address,1500),advisor=txt(req.body?.advisor,120);
      if(!customer)throw new Error('Ingresa el nombre del cliente');if(!p)throw new Error('Ingresa el teléfono');if(!address)throw new Error('Ingresa la dirección');if(!advisor)throw new Error('Selecciona o escribe el vendedor');
      const {data:nextNo,error:noe}=await db.rpc('next_kadie_order_number');if(noe)throw noe;
      const date=/^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date||''))?req.body.date:new Date().toISOString().slice(0,10);
      const quantity=Math.max(1,num(req.body?.quantity)||1);
      const payload={
        customer_name:customer,phone:p,dni:txt(req.body?.dni,60),product:product.name,product_catalog_id:product.id,quantity,
        amount:num(product.price)*quantity,cogs:num(product.cogs)*quantity,address,district:txt(req.body?.district,200),province:txt(req.body?.province,200),department:txt(req.body?.department,200),
        courier:txt(req.body?.courier,80),reference:txt(req.body?.reference,1500),advisor,status:'Nuevo',source:'crm',store:'Kadie Store',order_number:nextNo,
        created_at:`${date}T12:00:00Z`,updated_at:new Date().toISOString(),status_updated_at:new Date().toISOString()
      };
      const {data,error}=await db.from('orders').insert(payload).select().single();if(error)throw error;res.json(data);
    }catch(e){res.status(400).json({error:e.message})}
  });

  app.patch('/api/sales-orders/:id',async(req,res)=>{
    try{
      if(!db)throw new Error('Base de datos no configurada');
      const patch={updated_at:new Date().toISOString()};
      const fields=['customer_name','dni','phone','address','district','province','department','courier','reference','advisor'];
      for(const k of fields)if(Object.prototype.hasOwnProperty.call(req.body||{},k))patch[k]=k==='phone'?phone(req.body[k]):txt(req.body[k],1500);
      if(req.body?.status){const status=txt(req.body.status,80);if(!validStatus.has(status))throw new Error('Estado no válido');patch.status=status;patch.status_updated_at=new Date().toISOString();if(status==='Enviado')patch.sent_at=new Date().toISOString();if(status==='Entregado')patch.delivered_at=new Date().toISOString();}
      const {data,error}=await db.from('orders').update(patch).eq('id',req.params.id).eq('source','crm').select().single();if(error)throw error;res.json(data);
    }catch(e){res.status(400).json({error:e.message})}
  });

  app.get('/api/logistics',async(req,res)=>{
    try{
      if(!db)throw new Error('Base de datos no configurada');
      let q=db.from('orders').select('id,created_at,order_number,customer_name,dni,phone,address,district,province,department,courier,reference,advisor,status,product,amount').eq('source','crm').order('created_at',{ascending:false});
      const status=txt(req.query.status,80),from=txt(req.query.from,10),to=txt(req.query.to,10),department=txt(req.query.department,120);
      if(status)q=q.eq('status',status);if(from)q=q.gte('created_at',`${from}T00:00:00Z`);if(to)q=q.lte('created_at',`${to}T23:59:59Z`);if(department)q=q.eq('department',department);
      const {data,error}=await q.limit(1000);if(error)throw error;let rows=data||[];const search=txt(req.query.search,120).toLowerCase();if(search)rows=rows.filter(r=>[r.order_number,r.customer_name,r.phone,r.dni,r.address].some(v=>String(v||'').toLowerCase().includes(search)));
      const metrics={total:rows.length,nuevo:rows.filter(x=>x.status==='Nuevo').length,porEnviar:rows.filter(x=>x.status==='Por enviar').length,enviado:rows.filter(x=>x.status==='Enviado').length,entregado:rows.filter(x=>x.status==='Entregado').length,reprogramado:rows.filter(x=>x.status==='Reprogramado').length,cancelado:rows.filter(x=>x.status==='Cancelado').length};
      res.json({rows,metrics,departments:[...new Set(rows.map(x=>x.department).filter(Boolean))].sort()});
    }catch(e){res.status(400).json({error:e.message})}
  });
};
