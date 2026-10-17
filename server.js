'use strict';
const express = require('express');
const helmet = require('helmet');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
const BRAND = process.env.CRM_BRAND || 'Kadie CRM';
const USER = process.env.CRM_USER || '';
const PASS = process.env.CRM_PASSWORD || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '';
const META_WA_TOKEN = process.env.META_WA_TOKEN || '';
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const db = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}}) : null;

app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'1mb', verify:(req,_res,buf)=>{req.rawBody=buf;}}));

function auth(req,res,next){
  if (!USER || !PASS) return next();
  const h=req.get('authorization')||'';
  if(!h.startsWith('Basic ')) return res.set('WWW-Authenticate','Basic realm="Kadie CRM"').status(401).send('Acceso restringido');
  const [u,p]=Buffer.from(h.slice(6),'base64').toString().split(':');
  if(u!==USER||p!==PASS) return res.set('WWW-Authenticate','Basic realm="Kadie CRM"').status(401).send('Credenciales incorrectas');
  next();
}
function phone(v){return String(v||'').replace(/\D/g,'');}
function text(v){return String(v||'').trim().slice(0,4096);}
function plusHours(h){return new Date(Date.now()+h*3600000).toISOString();}
function verifySignature(req){
  if(!META_APP_SECRET) return true;
  const sig=req.get('x-hub-signature-256')||'';
  if(!sig.startsWith('sha256=')) return false;
  const expected='sha256='+crypto.createHmac('sha256',META_APP_SECRET).update(req.rawBody||Buffer.alloc(0)).digest('hex');
  try{return crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected));}catch{return false;}
}
async function waSend(to,body){
  if(!META_PHONE_NUMBER_ID||!META_WA_TOKEN) throw new Error('WhatsApp todavía no está configurado');
  const r=await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${META_PHONE_NUMBER_ID}/messages`,{method:'POST',headers:{Authorization:`Bearer ${META_WA_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:phone(to),type:'text',text:{body:text(body),preview_url:false}})});
  const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j?.error?.message||`Meta ${r.status}`); return j;
}
async function getConversation(p,name,referral){
  if(!db) throw new Error('Base de datos no configurada');
  const normalized=phone(p);
  const {data:old,error:e}=await db.from('conversations').select('*').eq('phone',normalized).maybeSingle(); if(e) throw e;
  const patch={customer_name:name||old?.customer_name||'Cliente WhatsApp',last_inbound_at:new Date().toISOString(),service_window_until:plusHours(24),updated_at:new Date().toISOString()};
  if(referral){patch.source='click_to_whatsapp';patch.entry_window_until=plusHours(72);patch.referral=referral;patch.ctwa_clid=referral.ctwa_clid||null;patch.referral_source_id=referral.source_id||null;}
  if(old){const {data,error}=await db.from('conversations').update(patch).eq('id',old.id).select().single();if(error)throw error;return data;}
  const {data,error}=await db.from('conversations').insert({phone:normalized,customer_name:name||'Cliente WhatsApp',mode:'bot',status:'Abierto',source:referral?'click_to_whatsapp':'whatsapp',last_inbound_at:new Date().toISOString(),service_window_until:plusHours(24),entry_window_until:referral?plusHours(72):null,referral:referral||{}}).select().single();if(error)throw error;return data;
}
async function saveMessage(conversationId,row){
  if(!db) return;
  const {error}=await db.from('messages').insert({conversation_id:conversationId,direction:row.direction,type:row.type||'text',body:row.body||'',wa_message_id:row.wa_message_id||null,status:row.status||null,metadata:row.metadata||{},created_at:row.created_at||new Date().toISOString()});
  if(error&&!String(error.message).toLowerCase().includes('duplicate')) throw error;
}
function detectProduct(t){
  const s=text(t).toLowerCase();
  if(s.includes('batana')) return {name:'Combo Batana',reply:'El combo de Batana está enfocado en fortalecer, nutrir y cuidar el cabello. ¿Deseas que te muestre la promoción disponible?'};
  if(s.includes('romero')) return {name:'Shampoo de Romero',reply:'El Shampoo de Romero complementa una rutina enfocada en fortalecimiento, crecimiento y cuidado anticaspa. ¿Deseas conocer el combo?'};
  if(s.includes('orange')||s.includes('naranja')||s.includes('exfoliante')) return {name:'ORANGE VC',reply:'ORANGE VC ayuda a complementar la limpieza y exfoliación facial para dejar la piel más suave y luminosa. ¿Deseas conocer la promoción?'};
  if(s.includes('cana')) return {name:'Cubre Canas',reply:'El Cubre Canas sirve para retocar visualmente las canas de forma rápida y temporal. ¿Qué color buscas: negro, marrón o café?'};
  return null;
}
function wantsHuman(t){return /(asesor|humano|persona|vendedor|vendedora)/i.test(text(t));}
async function bot(conversation,inbound){
  if(wantsHuman(inbound)){await db.from('conversations').update({mode:'human',updated_at:new Date().toISOString()}).eq('id',conversation.id);return 'Claro. Te comunicaré con un asesor para que continúe contigo.';}
  const product=detectProduct(inbound);
  if(product){await db.from('conversations').update({product:product.name,updated_at:new Date().toISOString()}).eq('id',conversation.id);return product.reply;}
  if(/(precio|cuanto|cuánto|promocion|promoción|combo)/i.test(inbound)) return 'Tenemos promociones disponibles 😊. Indícame qué producto te interesa para mostrarte el combo correcto.';
  if(/(envio|envío|delivery|provincia|lima)/i.test(inbound)) return 'Realizamos entregas en Lima y envíos a provincia. Dime tu distrito o ciudad y te indico la modalidad disponible.';
  if(/(quiero|separa|pedido|comprar|sí|si)/i.test(inbound)) return 'Perfecto. Para registrar tu pedido envíame: nombre completo, distrito/ciudad, dirección y una referencia.';
  return '¡Hola! Soy el asistente de Kadie 😊. Puedo ayudarte con promociones, productos, delivery y pedidos. También puedes escribir “asesor” si prefieres atención humana.';
}

app.get('/health',(_req,res)=>res.json({ok:true,brand:BRAND,db:Boolean(db),whatsapp:Boolean(META_PHONE_NUMBER_ID&&META_WA_TOKEN)}));
app.get('/webhook',(req,res)=>{if(req.query['hub.mode']==='subscribe'&&req.query['hub.verify_token']===META_VERIFY_TOKEN)return res.status(200).send(req.query['hub.challenge']);res.sendStatus(403);});
app.post('/webhook',async(req,res)=>{
  if(!verifySignature(req)) return res.sendStatus(401);
  res.sendStatus(200);
  try{
    const changes=req.body?.entry?.flatMap(e=>e.changes||[])||[];
    for(const c of changes){const value=c.value||{};for(const m of value.messages||[]){
      if(m.type!=='text') continue;
      const from=phone(m.from); const name=value.contacts?.[0]?.profile?.name||'Cliente WhatsApp'; const referral=m.referral||null;
      const conversation=await getConversation(from,name,referral);
      await saveMessage(conversation.id,{direction:'inbound',body:m.text?.body||'',wa_message_id:m.id,metadata:{referral}});
      if(conversation.mode==='bot'){
        const reply=await bot(conversation,m.text?.body||'');
        const sent=await waSend(from,reply);
        await saveMessage(conversation.id,{direction:'outbound',body:reply,wa_message_id:sent?.messages?.[0]?.id||null,status:'sent'});
      }
    }}
  }catch(err){console.error('Webhook:',err.message);}
});

app.use(auth);
app.get('/api/status',(_req,res)=>res.json({brand:BRAND,databaseConfigured:Boolean(db),whatsappConfigured:Boolean(META_PHONE_NUMBER_ID&&META_WA_TOKEN&&META_VERIFY_TOKEN),financeConfigured:Boolean(process.env.FINANCE_PASSWORD),graphVersion:GRAPH_VERSION}));
app.get('/api/conversations',async(_req,res)=>{if(!db)return res.json([]);const {data,error}=await db.from('conversations').select('*').order('updated_at',{ascending:false}).limit(200);if(error)return res.status(500).json({error:error.message});res.json(data||[]);});
app.get('/api/conversations/:id/messages',async(req,res)=>{if(!db)return res.json([]);const {data,error}=await db.from('messages').select('*').eq('conversation_id',req.params.id).order('created_at',{ascending:true}).limit(500);if(error)return res.status(500).json({error:error.message});res.json(data||[]);});
app.post('/api/conversations/:id/send',async(req,res)=>{try{if(!db)throw new Error('Base de datos no configurada');const {data:c,error}=await db.from('conversations').select('*').eq('id',req.params.id).single();if(error)throw error;const body=text(req.body?.body);if(!body)throw new Error('Mensaje vacío');const sent=await waSend(c.phone,body);await saveMessage(c.id,{direction:'outbound',body,wa_message_id:sent?.messages?.[0]?.id||null,status:'sent',metadata:{sent_by:'human'}});await db.from('conversations').update({mode:'human',updated_at:new Date().toISOString()}).eq('id',c.id);res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/conversations/:id/mode',async(req,res)=>{if(!db)return res.status(400).json({error:'Base de datos no configurada'});const mode=['bot','human','paused'].includes(req.body?.mode)?req.body.mode:'human';const {error}=await db.from('conversations').update({mode,updated_at:new Date().toISOString()}).eq('id',req.params.id);if(error)return res.status(500).json({error:error.message});res.json({ok:true,mode});});
app.get('/api/orders',async(_req,res)=>{if(!db)return res.json([]);const {data,error}=await db.from('orders').select('*').order('created_at',{ascending:false}).limit(300);if(error)return res.status(500).json({error:error.message});res.json(data||[]);});
app.post('/api/orders',async(req,res)=>{if(!db)return res.status(400).json({error:'Base de datos no configurada'});const payload={customer_name:text(req.body.customer_name),phone:phone(req.body.phone),product:text(req.body.product),amount:Number(req.body.amount||0),district:text(req.body.district),address:text(req.body.address),reference:text(req.body.reference),status:'Confirmado'};const {data,error}=await db.from('orders').insert(payload).select().single();if(error)return res.status(500).json({error:error.message});res.json(data);});

require('./finance')({app,db});
app.use(express.static(path.join(__dirname,'public')));
app.listen(PORT,()=>console.log(`${BRAND} running on ${PORT}`));
