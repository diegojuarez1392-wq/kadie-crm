# Kadie CRM WhatsApp

CRM web para ecommerce conectado a WhatsApp Cloud API. Incluye bandeja de conversaciones, bot inicial, pase a asesor humano, pedidos y seguimiento de conversaciones provenientes de anuncios Click-to-WhatsApp.

## Despliegue
- Node.js 20+
- `npm install`
- `npm start`
- Endpoint del webhook de Meta: `/webhook`
- Esquema de base de datos: `supabase-schema.sql`

Las credenciales de Meta y Supabase se configuran como variables de entorno en Render; nunca deben subirse al repositorio.
