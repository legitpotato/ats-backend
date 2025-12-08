# ATS – Backend  
Sistema de backend del proyecto **ATS (Asistente de Transferencia de Sangre)**, encargado de gestionar la lógica de negocio, operaciones y comunicación con la base de datos.  
Aquí se administran usuarios, roles, unidades de sangre, ofertas, solicitudes y la trazabilidad completa del proceso.

## Tecnologías principales
- Node.js + Express
- Prisma ORM
- PostgreSQL
- JSON Web Tokens (JWT)
- Nodemailer / Brevo para notificaciones

## Cómo ejecutar el proyecto
1. Instalar dependencias:
   ```bash
   npm install
   npm install express
   npm install prisma @prisma/client
   npm install pg
   npm install jsonwebtoken
   npm install nodemailer
   
2. Ejecutar entorno:
   ```bash
   npm run dev
