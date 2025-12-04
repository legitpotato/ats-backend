const nodemailer = require("nodemailer");

const {
  BREVO_SMTP_HOST,
  BREVO_SMTP_PORT,
  BREVO_SMTP_USER,
  BREVO_SMTP_PASS,
  EMAIL_FROM,
} = process.env;

// Normalizar variables de entorno (evita fallos por espacios o valores indefinidos)
const HOST = (BREVO_SMTP_HOST || "").trim();
const PORT = Number((BREVO_SMTP_PORT || "587").trim());
const USER = (BREVO_SMTP_USER || "").trim();
const PASS = (BREVO_SMTP_PASS || "").trim();
const FROM = (EMAIL_FROM || "ATS Notificaciones <asistente-ats@outlook.com>").trim();

// Validación temprana: si falta configuración crítica, advertimos.
// (No hacemos throw para permitir usar entornos de desarrollo sin SMTP real)
if (!HOST || !USER || !PASS) {
  console.warn("[email] Falta configuración SMTP de Brevo en .env");
  console.warn({
    HOST_present: !!HOST,
    USER_present: !!USER,
    PASS_present: !!PASS,
  });
}

// Configuración del transporte SMTP. 
// Usamos fallback seguro y soportamos STARTTLS (puerto 587) o SMTPS (465)
const transporter = nodemailer.createTransport({
  host: HOST || "smtp-relay.brevo.com",
  port: PORT || 587,
  secure: PORT === 465, // TRUE solo si es SMTPS
  auth: { user: USER, pass: PASS },
  // tls: { rejectUnauthorized: false }, // Útil solo si hay problemas de certificados
});

// Log de resumen (sin exponer credenciales) para debugging
console.log("[email] SMTP:", {
  host: HOST || "smtp-relay.brevo.com",
  port: PORT || 587,
  secure: PORT === 465,
  from: FROM,
});

/**
 * Envia un correo electrónico usando el transporte configurado.
 * @param {Object} opts
 * @param {string} opts.to - Destinatario del correo
 * @param {string} opts.subject - Asunto del mensaje
 * @param {string} [opts.text] - Contenido en texto plano
 * @param {string} [opts.html] - Contenido en HTML
 */
async function sendEmail({ to, subject, text, html }) {
  if (!to) throw new Error("Falta 'to'");
  if (!subject) throw new Error("Falta 'subject'");

  // Si no se entrega `text`, generamos uno vacío a menos que exista HTML.
  const mailOptions = {
    from: FROM,
    to,
    subject,
    text: text || (html ? undefined : ""),
    html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("[email] Enviado:", info.messageId);
    return info;

  } catch (err) {
    // Error manejado y re-emitido para que la capa superior pueda reaccionar
    console.error("[email] Error enviando correo:", err);
    throw err;
  }
}

module.exports = { sendEmail };
