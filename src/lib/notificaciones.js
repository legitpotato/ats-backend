const pool = require("../db");
const { sendEmail } = require("./email");

// Helpers base
async function crearNotificacionYCorreo({
  usuarioId,
  email,
  tipo,
  mensaje,
  refEntidadId = null,
  refEntidadTipo = null,
  emailOptions,
}) {
  if (!usuarioId && !email) {
    console.warn("[notificaciones] Sin usuarioId ni email, se omite");
    return;
  }

  if (usuarioId) {
    try {
      await pool.query(
        `INSERT INTO notificacion
           (usuario_id, tipo, mensaje, ref_entidad_id, ref_entidad_tipo)
         VALUES ($1,$2,$3,$4,$5)`,
        [usuarioId, tipo, mensaje, refEntidadId, refEntidadTipo]
      );
    } catch (e) {
      console.error("[notificaciones] Error insertando notificación:", e);
    }
  }

  if (email && emailOptions) {
    try {
      await sendEmail({
        to: email,
        subject: emailOptions.subject,
        text: emailOptions.text,
        html: emailOptions.html,
      });
    } catch (e) {
      console.error("[notificaciones] Error enviando correo:", e);
    }
  }
}

async function crearNotificacionYCorreoLote({
  usuariosDestino = [], // [{id, email, nombre}]
  emails = [],          // [string]
  tipo,
  mensaje,
  refEntidadId = null,
  refEntidadTipo = null,
  subject = "ATS – Notificación",
  html = null,
}) {
  // 1) Notificación en BD para quienes tengan id
  if (usuariosDestino.length) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const u of usuariosDestino) {
        if (!u?.id) continue;
        await client.query(
          `INSERT INTO notificacion (usuario_id, tipo, mensaje, ref_entidad_id, ref_entidad_tipo)
           VALUES ($1,$2,$3,$4,$5)`,
          [u.id, tipo, mensaje, refEntidadId, refEntidadTipo]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[notifs] error insertando notificaciones:", e);
    } finally {
      client.release();
    }
  }

  // 2) Emails directos
  const toSend = [
    ...emails,
    ...usuariosDestino.map(u => u?.email).filter(Boolean),
  ];
  const unique = [...new Set(toSend)];
  for (const to of unique) {
    try {
      await sendEmail({ to, subject, text: mensaje, html: html || `<p>${mensaje}</p>` });
    } catch (e) {
      console.error("[notifs] error email:", e);
    }
  }
}

async function getEmailsDeCentro(centroId) {
  const { rows } = await pool.query(
    `SELECT email
     FROM usuario
     WHERE activo = TRUE AND centro_id = $1 AND email IS NOT NULL`,
    [centroId]
  );
  return rows.map(r => r.email);
}

// Notificaciones específicas (rutas usan estas firmas)

// Confirmación al creador de una solicitud (POST /api/solicitudes)
async function notificarSolicitudCreada({
  usuarioId,
  usuarioEmail,
  usuarioNombre,
  solicitud,
}) {
  const tipo = "solicitud";
  const refEntidadId = solicitud.id;
  const refEntidadTipo = "Solicitud";

  const asunto = "ATS – Nueva solicitud creada";
  const saludo = usuarioNombre ? `Hola ${usuarioNombre},` : "Hola,";
  const msgPlano = `Has creado una nueva solicitud de ${solicitud.tipo_componente} ${solicitud.grupo}${solicitud.rh} x${solicitud.cantidad} unidades${solicitud.urgente ? " (URGENTE)" : ""}.`;

  await crearNotificacionYCorreo({
    usuarioId,
    email: usuarioEmail,
    tipo,
    mensaje: msgPlano,
    refEntidadId,
    refEntidadTipo,
    emailOptions: {
      subject: asunto,
      text: msgPlano,
      html: `
        <p>${saludo}</p>
        <p>Has creado una nueva <strong>solicitud</strong> en ATS:</p>
        <ul>
          <li><b>Tipo:</b> ${solicitud.tipo_componente}</li>
          <li><b>Grupo/RH:</b> ${solicitud.grupo}${solicitud.rh}</li>
          <li><b>Cantidad:</b> ${solicitud.cantidad}</li>
          <li><b>Urgente:</b> ${solicitud.urgente ? "Sí" : "No"}</li>
        </ul>
        <p>Puedes revisar el estado de la solicitud en el módulo de <strong>Solicitudes</strong>.</p>
        <p>Saludos,<br/>ATS – Asistente de Transferencia de Sangre</p>
      `,
    },
  });
}

// Transferencia creada (POST /api/transferencias/desde-solicitud o /desde-oferta)
async function notificarTransferenciaCreada({ transferenciaId, centroOrigenId, centroDestinoId }) {
  // Trae transferencia + (posible) solicitud + centros + unidades
  const { rows } = await pool.query(
    `
    WITH t AS (
      SELECT t.id, t.fecha_creada, t.solicitud_id, t.centro_origen_id, t.centro_destino_id
      FROM transferencia t
      WHERE t.id = $1
    ),
    sol AS (
      SELECT s.id, s.tipo_componente, s.grupo, s.rh, s.cantidad, s.urgente
      FROM solicitud s
      JOIN t ON t.solicitud_id = s.id
    ),
    co AS (
      SELECT c.id, c.nombre, c.region, c.comuna
      FROM centro_sangre c JOIN t ON c.id = t.centro_origen_id
    ),
    cd AS (
      SELECT c.id, c.nombre, c.region, c.comuna
      FROM centro_sangre c JOIN t ON c.id = t.centro_destino_id
    ),
    u AS (
      SELECT
        u.id,
        u.codigo_seguimiento AS codigo,
        to_char(u.fecha_vencimiento, 'YYYY-MM-DD') AS vence
      FROM transferencia_item ti
      JOIN unidad u ON u.id = ti.unidad_id
      WHERE ti.transferencia_id = (SELECT id FROM t)
      ORDER BY u.fecha_vencimiento ASC, u.codigo_seguimiento ASC
    )
    SELECT
      t.id,
      t.fecha_creada,
      -- sol es opcional: si no existe, construimos un JSON vacío
      COALESCE(
        (
          SELECT json_build_object(
            'id', s.id,
            'tipo', s.tipo_componente,
            'grupo', s.grupo,
            'rh', s.rh,
            'cantidad', s.cantidad,
            'urgente', s.urgente
          ) FROM sol s
        ),
        json_build_object(
          'id', null, 'tipo', null, 'grupo', null, 'rh', null, 'cantidad', null, 'urgente', false
        )
      ) AS solicitud,
      json_build_object('id', co.id, 'nombre', co.nombre, 'region', co.region, 'comuna', co.comuna) AS origen,
      json_build_object('id', cd.id, 'nombre', cd.nombre, 'region', cd.region, 'comuna', cd.comuna) AS destino,
      COALESCE(
        (SELECT json_agg(json_build_object('id', u.id, 'codigo', u.codigo, 'vence', u.vence)) FROM u),
        '[]'::json
      ) AS unidades
    FROM t
    JOIN co ON true
    JOIN cd ON true
    `,
    [transferenciaId]
  );
  if (!rows.length) return;

  const t = rows[0];
  const unidades = Array.isArray(t.unidades) ? t.unidades : [];
  const totalU = unidades.length;
  const previewU = unidades.slice(0, 30); // evita correos demasiado largos
  const resto = totalU > 30 ? totalU - 30 : 0;

  const asunto = "ATS – Nueva transferencia creada";
  const solicitudTxt = t.solicitud?.tipo
    ? `${t.solicitud.tipo} ${t.solicitud.grupo || ""}${t.solicitud.rh || ""} x${t.solicitud.cantidad || ""}${t.solicitud.urgente ? " (URGENTE)" : ""}`
    : "(sin solicitud asociada)";

  const mensajePlano =
    `Transferencia ${t.id} creada\n` +
    `Origen: ${t.origen.nombre} (${t.origen.comuna}, ${t.origen.region})\n` +
    `Destino: ${t.destino.nombre} (${t.destino.comuna}, ${t.destino.region})\n` +
    `Solicitud: ${solicitudTxt}\n` +
    `Unidades: ${totalU}`;

  const listadoUnidades = previewU
    .map(u => `<li>${u.codigo || u.id} (vence: ${u.vence || "—"})</li>`)
    .join("");
  const cola = resto ? `<p>…y <b>+${resto}</b> unidades más.</p>` : "";

  const html = `
    <p><b>Se creó una nueva transferencia</b></p>
    <p><b>Origen:</b> ${t.origen.nombre} (${t.origen.comuna}, ${t.origen.region})<br/>
       <b>Destino:</b> ${t.destino.nombre} (${t.destino.comuna}, ${t.destino.region})</p>
    <p><b>Solicitud:</b> ${solicitudTxt}</p>
    <p><b>Unidades:</b> ${totalU}</p>
    ${listadoUnidades ? `<ul>${listadoUnidades}</ul>` : ""}
    ${cola}
    <p>— ATS</p>
  `;

  // Correos a ambos centros; si no te pasan los IDs, usamos los que vienen de la transferencia
  const origenId  = centroOrigenId  || t.origen?.id;
  const destinoId = centroDestinoId || t.destino?.id;

  const emailsOrigen  = origenId  ? await getEmailsDeCentro(origenId)  : [];
  const emailsDestino = destinoId ? await getEmailsDeCentro(destinoId) : [];

  // De-dup
  const all = [...new Set([...emailsOrigen, ...emailsDestino])];

  if (all.length) {
    await crearNotificacionYCorreoLote({
      emails: all,
      tipo: "transferencia",
      mensaje: mensajePlano,
      refEntidadId: transferenciaId,
      refEntidadTipo: "Transferencia",
      subject: asunto,
      html,
    });
  }
}

// Cambio de estado de SOLICITUD (PATCH /api/solicitudes/:id/estado)
async function notificarCambioEstadoSolicitud({ solicitudId, nuevoEstado, nuevo_estado }) {
  const estado = nuevoEstado ?? nuevo_estado;
  if (!estado) return;

  const { rows } = await pool.query(
    `SELECT s.id, s.estado, s.centro_solicitante_id, c.nombre AS centro
     FROM solicitud s
     JOIN centro_sangre c ON c.id = s.centro_solicitante_id
     WHERE s.id = $1`,
    [solicitudId]
  );
  if (!rows.length) return;
  const s = rows[0];

  const asunto  = "ATS – Cambio de estado de solicitud";
  const mensaje = `La solicitud ${s.id} del centro ${s.centro} cambió a estado: ${estado}.`;

  const emails = await getEmailsDeCentro(s.centro_solicitante_id);
  await crearNotificacionYCorreoLote({
    emails,
    tipo: "solicitud",
    mensaje,
    refEntidadId: solicitudId,
    refEntidadTipo: "Solicitud",
    subject: asunto,
  });
}

// Cambio de estado de OFERTA (PATCH /api/ofertas/:id/estado)
async function notificarCambioEstadoOferta({ ofertaId, nuevoEstado, nuevo_estado }) {
  const estado = nuevoEstado ?? nuevo_estado;
  if (!estado) return;

  const { rows } = await pool.query(
    `SELECT o.id, o.estado, o.centro_id, c.nombre AS centro
     FROM oferta o
     JOIN centro_sangre c ON c.id = o.centro_id
     WHERE o.id = $1`,
    [ofertaId]
  );
  if (!rows.length) return;
  const o = rows[0];

  const asunto  = "ATS – Cambio de estado de oferta";
  const mensaje = `La oferta ${o.id} del centro ${o.centro} cambió a estado: ${estado}.`;

  const emails = await getEmailsDeCentro(o.centro_id);
  await crearNotificacionYCorreoLote({
    emails,
    tipo: "oferta",
    mensaje,
    refEntidadId: ofertaId,
    refEntidadTipo: "Oferta",
    subject: asunto,
  });
}


// Extras
async function destinatariosCentro(centroId, roles = ["coordinador", "admin"]) {
  const { rows } = await pool.query(
    `SELECT id, email, nombre
     FROM usuario
     WHERE centro_id = $1 AND activo = TRUE
       AND (rol = ANY($2::text[]))`,
    [centroId, roles]
  );
  return rows; // [{id, email, nombre}, ...]
}

async function notificarOfertaCreada({ centroId, ofertaId, observaciones }) {
  const dests = await destinatariosCentro(centroId);
  for (const d of dests) {
    const msg = `Se creó una nueva oferta (#${ofertaId.slice(0,8)}...). ${observaciones ? `Obs: ${observaciones}` : ""}`;
    await crearNotificacionYCorreo({
      usuarioId: d.id,
      email: d.email,
      tipo: "oferta",
      mensaje: msg,
      refEntidadId: ofertaId,
      refEntidadTipo: "Oferta",
      emailOptions: {
        subject: "ATS – Nueva oferta creada",
        text: msg,
        html: `<p>Hola ${d.nombre || ""},</p><p>${msg}</p>`,
      },
    });
  }
}

async function notificarOfertaEstado({ centroId, ofertaId, nuevoEstado }) {
  const dests = await destinatariosCentro(centroId);
  for (const d of dests) {
    const msg = `La oferta ${ofertaId.slice(0,8)} cambió a estado ${nuevoEstado}.`;
    await crearNotificacionYCorreo({
      usuarioId: d.id,
      email: d.email,
      tipo: "oferta",
      mensaje: msg,
      refEntidadId: ofertaId,
      refEntidadTipo: "Oferta",
      emailOptions: {
        subject: "ATS – Cambio de estado en oferta",
        text: msg,
        html: `<p>${msg}</p>`,
      },
    });
  }
}

async function notificarTransferenciaEstado({ transferenciaId, centroDestinoId, centroOrigenId, accion }) {
  // enviar -> notifica destino; recibir -> notifica origen; cancelar -> notifica ambos
  const mapa = {
    enviar:   [centroDestinoId],
    recibir:  [centroOrigenId],
    cancelar: [centroOrigenId, centroDestinoId],
  };
  const centros = mapa[accion] || [];
  for (const cid of centros) {
    const dests = await destinatariosCentro(cid);
    for (const d of dests) {
      const msg = `La transferencia ${transferenciaId.slice(0,8)} fue ${accion}.`;
      await crearNotificacionYCorreo({
        usuarioId: d.id,
        email: d.email,
        tipo: "transferencia",
        mensaje: msg,
        refEntidadId: transferenciaId,
        refEntidadTipo: "Transferencia",
        emailOptions: {
          subject: "ATS – Actualización de transferencia",
          text: msg,
          html: `<p>${msg}</p>`,
        },
      });
    }
  }
}

async function notificarSolicitudEstado({ centroId, solicitudId, nuevoEstado }) {
  const dests = await destinatariosCentro(centroId, ["coordinador", "admin", "personal"]);
  for (const d of dests) {
    const msg = `La solicitud ${solicitudId.slice(0,8)} cambió a estado ${nuevoEstado}.`;
    await crearNotificacionYCorreo({
      usuarioId: d.id,
      email: d.email,
      tipo: "solicitud",
      mensaje: msg,
      refEntidadId: solicitudId,
      refEntidadTipo: "Solicitud",
      emailOptions: {
        subject: "ATS – Cambio de estado en solicitud",
        text: msg,
        html: `<p>${msg}</p>`,
      },
    });
  }
}

async function notificarOfertaCanceladaPorVencimiento({ ofertaId }) {
  const { rows } = await pool.query(
    `SELECT o.id, c.id AS centro_id, c.nombre AS centro_nombre
     FROM oferta o
     JOIN centro_sangre c ON c.id = o.centro_id
     WHERE o.id = $1`,
    [ofertaId]
  );
  if (!rows.length) return;
  const of = rows[0];

  const { rows: u } = await pool.query(
    `SELECT id, nombre, email
     FROM usuario
     WHERE centro_id = $1
     ORDER BY (rol='coordinador') DESC, (rol='admin') DESC, nombre ASC
     LIMIT 1`,
    [of.centro_id]
  );
  const contacto = u[0];
  if (!contacto?.email) return;

  const asunto = "ATS – Oferta cancelada por vencimiento de unidades";
  const texto  = `Hola ${contacto.nombre || ""},
Tu oferta ${ofertaId} del centro ${of.centro_nombre} fue cancelada porque una o más unidades vencieron.
— ATS`;
  const html   = `
    <p>Hola ${contacto.nombre || ""},</p>
    <p>Tu oferta <b>${ofertaId}</b> del centro <b>${of.centro_nombre}</b> fue <b>cancelada</b> porque una o más unidades vencieron.</p>
    <p>— ATS</p>
  `;

  await crearNotificacionYCorreo({
    usuarioId: contacto.id,
    email: contacto.email,
    tipo: "oferta",
    mensaje: `Oferta ${ofertaId} cancelada por vencimiento de unidades.`,
    refEntidadId: ofertaId,
    refEntidadTipo: "Oferta",
    emailOptions: { subject: asunto, text: texto, html },
  });
}


// exports

module.exports = {
  // helpers
  crearNotificacionYCorreo,
  crearNotificacionYCorreoLote,
  getEmailsDeCentro,


  notificarSolicitudCreada,
  notificarTransferenciaCreada,
  notificarCambioEstadoSolicitud,
  notificarCambioEstadoOferta,   

  // extras
  destinatariosCentro,
  notificarOfertaCreada,
  notificarOfertaEstado,
  notificarTransferenciaEstado,
  notificarSolicitudEstado,
  notificarOfertaCanceladaPorVencimiento,
};
