const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const pool = require("../db");
const audit = require("../lib/audit");
const { crearNotificacionYCorreo, notificarSolicitudCreada } = require("../lib/notificaciones");

// helper para booleanos
function toBool(v) {
  if (v === true || v === false) return v;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "on" || s === "sí" || s === "si";
}

// POST /api/solicitudes  (crear)
router.post("/", auth, async (req, res) => {
  try {
    const { centro_id } = req.user;
    if (!centro_id)
      return res.status(400).json({ error: "Usuario sin centro asignado" });

    const {
      tipo_componente,
      grupo,
      rh,
      cantidad,
      urgente = false,
      observaciones = null,
      filtrado = false,
      irradiado = false,
    } = req.body;

    if (!tipo_componente || !grupo || !rh || !cantidad) {
      return res.status(400).json({ error: "Campos obligatorios faltantes" });
    }

    const filtradoBool = toBool(filtrado);
    const irradiadoBool = toBool(irradiado);


    // buscar cuántas ofertas abiertas calzan con esta solicitud
    const { rows: coincidencias } = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM oferta o
      JOIN oferta_item oi ON oi.oferta_id = o.id
      JOIN unidad u      ON u.id = oi.unidad_id
      WHERE o.estado = 'abierta'
        AND u.estado = 'asignada'
        AND u.tipo_componente = $1
        AND u.grupo = $2
        AND u.rh = $3
        AND u.filtrado = $4
        AND u.irradiado = $5
        AND o.centro_id <> $6
      GROUP BY o.id
      HAVING COUNT(u.id) >= $7
    `,
      [
        tipo_componente,
        grupo,
        rh,
        filtradoBool,
        irradiadoBool,
        centro_id,
        Number(cantidad)
      ]
    );

    // coincidencias.length = cantidad de ofertas que por sí solas pueden cumplir la solicitud
    const matchCount = coincidencias.length;



    const { rows } = await pool.query(
      `
      INSERT INTO solicitud
        (id,
         centro_solicitante_id,
         tipo_componente,
         grupo,
         rh,
         cantidad,
         urgente,
         observaciones,
         filtrado,
         irradiado,
         estado,
         creada_en)
      VALUES (uuid_generate_v4(), $1,$2,$3,$4,$5,$6,$7,$8,$9,'pendiente', now())
      RETURNING id, estado, creada_en
    `,
      [
        centro_id,
        tipo_componente,
        grupo,
        rh,
        Number(cantidad),
        !!urgente,
        observaciones,
        filtradoBool,
        irradiadoBool,
      ]
    );

    const nueva = rows[0];

    const usuarioId      = req.user?.id || null;
    const usuarioEmail   = req.user?.email || null;
    const usuarioNombre  = req.user?.nombre || null;

    // Notificación + correo mediante el wrapper
    try {
      await notificarSolicitudCreada({
        usuarioId,
        usuarioEmail,
        usuarioNombre,
        solicitud: {
          ...nueva,
          tipo_componente,
          grupo,
          rh,
          cantidad: Number(cantidad),
          urgente: !!urgente,
        },
      });
    } catch (err) {
      console.error("[notificaciones] Error enviando notificación de solicitud:", err);
    }



    // auditoría
    await audit({
      req,
      entidad: "solicitud",
      entidad_id: nueva.id,
      accion: "CREAR",
      detalles: {
        tipo_componente,
        grupo,
        rh,
        cantidad: Number(cantidad),
        urgente: !!urgente,
        observaciones,
        filtrado: filtradoBool,
        irradiado: irradiadoBool,
      },
    });

    // mientras, devuelve solo la solicitud, el matching se agrega en el paso anterior, pero ahora ya tendrá filtrado/irradiado en la tabla
    res.status(201).json({
      ok: true,
      solicitud: nueva,
      match: matchCount > 0,
      match_count: matchCount
    });

  } catch (e) {
    console.error("POST /api/solicitudes", e);
    res.status(500).json({ error: "No se pudo crear la solicitud" });
  }
});

// GET /api/solicitudes  -> lista global (por defecto, pendientes)
router.get("/", auth, async (req, res) => {
  try {
    const estado = (req.query.estado || "pendiente").toLowerCase();
    const q      = (req.query.q || "").trim();
    const page   = Math.max(1, parseInt(req.query.page  || "1", 10));
    const limit  = Math.max(1, Math.min(100, parseInt(req.query.limit || "20", 10)));
    const offset = (page - 1) * limit;

    const params = [];
    const where  = [];

    if (estado && ["pendiente","aceptada","rechazada","cancelada","parcial"].includes(estado)) {
      params.push(estado);
      where.push(`s.estado = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      where.push(`(c.nombre ILIKE $${params.length} OR COALESCE(s.observaciones,'') ILIKE $${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      SELECT
        s.id,
        s.tipo_componente,
        s.grupo,
        s.rh,
        s.cantidad,
        s.urgente,
        s.filtrado,
        s.irradiado,
        s.estado,
        s.creada_en,
        s.observaciones,
        s.centro_solicitante_id,
        s.centro_solicitante_id AS centro_id,
        c.nombre   AS centro_nombre,
        c.region,
        c.comuna,
        c.latitud,
        c.longitud
      FROM solicitud s
      JOIN centro_sangre c ON c.id = s.centro_solicitante_id
      ${whereSql}
      ORDER BY s.creada_en DESC
      OFFSET ${offset} LIMIT ${limit}
    `;

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM solicitud s
      JOIN centro_sangre c ON c.id = s.centro_solicitante_id
      ${whereSql}
    `;

    const [rowsRes, countRes] = await Promise.all([
      pool.query(sql, params),
      pool.query(countSql, params),
    ]);

    res.json({
      page,
      limit,
      total: countRes.rows[0]?.total || 0,
      items: rowsRes.rows,
    });
  } catch (e) {
    console.error("GET /api/solicitudes", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// GET /api/solicitudes/mias
router.get("/mias", auth, async (req, res) => {
  try {
    const { centro_id } = req.user;
    if (!centro_id)
      return res.status(400).json({ error: "Usuario sin centro" });

    const q = `
      SELECT s.id,
             s.tipo_componente,
             s.grupo,
             s.rh,
             s.cantidad,
             s.urgente,
             s.observaciones,
             s.filtrado,
             s.irradiado,
             s.estado,
             s.creada_en,
             s.centro_solicitante_id AS centro_id,
             c.nombre AS centro_nombre,
             c.comuna,
             c.region,
             c.latitud,
             c.longitud
      FROM solicitud s
      JOIN centro_sangre c ON c.id = s.centro_solicitante_id
      WHERE s.centro_solicitante_id = $1 AND s.estado = 'pendiente'
      ORDER BY s.creada_en DESC
      LIMIT 200
    `;
    const { rows } = await pool.query(q, [centro_id]);
    res.json(rows);
  } catch (e) {
    console.error("GET /api/solicitudes/mias", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// GET /api/solicitudes/:id  -> detalle de una solicitud
router.get("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;

    const sql = `
      SELECT
        s.id,
        s.tipo_componente,
        s.grupo,
        s.rh,
        s.cantidad,
        s.urgente,
        s.filtrado,
        s.irradiado,
        s.estado,
        s.creada_en,
        s.observaciones,
        s.centro_solicitante_id,
        c.nombre   AS centro_nombre,
        c.region,
        c.comuna,
        c.latitud,
        c.longitud
      FROM solicitud s
      JOIN centro_sangre c ON c.id = s.centro_solicitante_id
      WHERE s.id = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(sql, [id]);
    if (!rows.length) return res.status(404).json({ error: "No existe la solicitud" });

    res.json(rows[0]);
  } catch (e) {
    console.error("GET /api/solicitudes/:id", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// GET /api/solicitudes/:id/detalle
router.get("/:id/detalle", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { centro_id: miCentroId } = req.user;

    if (!miCentroId) {
      return res.status(400).json({ error: "Usuario sin centro asignado" });
    }

    // Traer la solicitud + info del centro solicitante
    const { rows: solRows } = await pool.query(
      `
      SELECT
        s.id,
        s.centro_solicitante_id,
        s.tipo_componente,
        s.grupo,
        s.rh,
        s.cantidad,
        s.urgente,
        s.observaciones,
        s.filtrado,
        s.irradiado,
        s.estado,
        s.creada_en,
        c.nombre  AS centro_nombre,
        c.region,
        c.comuna,
        c.latitud,
        c.longitud
      FROM solicitud s
      JOIN centro_sangre c ON c.id = s.centro_solicitante_id
      WHERE s.id = $1
      `,
      [id]
    );

    if (!solRows.length) {
      return res.status(404).json({ error: "No existe la solicitud" });
    }

    const sol = solRows[0];

    // Si es mi propia solicitud, no ofrezco unidades para atenderla
    if (sol.centro_solicitante_id === miCentroId) {
      return res.json({
        ...sol,
        unidades: [], // nada seleccionable
      });
    }

    // Buscar unidades COMPATIBLES de mi centro (disponibles) para atender
    const { rows: unidades } = await pool.query(
      `
      SELECT
        u.id,
        u.codigo_seguimiento,
        u.tipo_componente,
        u.grupo,
        u.rh,
        u.filtrado,
        u.irradiado,
        u.fecha_vencimiento AS vence,
        u.estado,
        -- ya filtramos por compatibilidad y disponibilidad, así que son seleccionables
        TRUE AS seleccionable
      FROM unidad u
      WHERE
        u.centro_actual_id = $1
        AND u.estado = 'disponible'
        AND u.tipo_componente = $2
        AND u.grupo = $3
        AND u.rh = $4
        AND u.filtrado = $5
        AND u.irradiado = $6
      ORDER BY u.fecha_vencimiento ASC
      `,
      [
        miCentroId,
        sol.tipo_componente,
        sol.grupo,
        sol.rh,
        sol.filtrado,
        sol.irradiado,
      ]
    );

    return res.json({
      ...sol,
      unidades,
    });
  } catch (e) {
    console.error("GET /api/solicitudes/:id/detalle", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// PATCH /api/solicitudes/:id/estado
router.patch("/:id/estado", auth, async (req, res) => {
  try {
    const { id } = req.params;
    // Acepta ambos nombres por comodidad de front
    const nuevoEstado = req.body.nuevo_estado ?? req.body.nuevoEstado;

    const permitidos = ["pendiente","aceptada","rechazada","cancelada","parcial"];
    if (!permitidos.includes(nuevoEstado)) {
      return res.status(400).json({ error: "Estado inválido" });
    }

    const { rows } = await pool.query(
      `
      UPDATE solicitud
      SET estado = $1
      WHERE id = $2
      RETURNING id, estado, centro_solicitante_id
      `,
      [nuevoEstado, id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: "No existe la solicitud" });
    }
    const act = rows[0];

    // auditoría con acción válida
    await audit({
      req,
      entidad: "solicitud",
      entidad_id: id,
      accion: "CAMBIO_ESTADO",
      detalles: { nuevo_estado: nuevoEstado },
    });

    // Notificar (no bloqueante)
    (async () => {
      try {
        const { notificarCambioEstadoSolicitud } = require("../lib/notificaciones");
        await notificarCambioEstadoSolicitud({ solicitudId: id, nuevoEstado });
      } catch (e) {
        console.error("[notifs] cambio estado solicitud:", e);
      }
    })();

    res.json({ ok: true, solicitud: act });
  } catch (e) {
    console.error("PATCH /api/solicitudes/:id/estado", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// Crear transferencia desde una SOLICITUD usando unidades de mi inventario
// POST /api/solicitudes/desde-solicitud
router.post("/desde-solicitud", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { centro_id: origenCentroId } = req.user;
    if (!origenCentroId) {
      return res.status(400).json({ error: "Usuario sin centro" });
    }

    const { solicitud_id, unidad_ids = [], observaciones = null } = req.body;
    if (!solicitud_id) return res.status(400).json({ error: "solicitud_id requerido" });
    if (!Array.isArray(unidad_ids) || unidad_ids.length === 0) {
      return res.status(400).json({ error: "Debes indicar al menos una unidad" });
    }

    await client.query("BEGIN");

    // Lock solicitud
    const { rows: solRows } = await client.query(
      `SELECT * FROM solicitud WHERE id = $1 FOR UPDATE`,
      [solicitud_id]
    );
    if (!solRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Solicitud no existe" });
    }
    const sol = solRows[0];

    if (sol.estado !== "pendiente") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "La solicitud ya no está pendiente" });
    }

    const destCentroId = sol.centro_solicitante_id;
    if (destCentroId === origenCentroId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "No puedes satisfacer tu propia solicitud" });
    }

    // Unidades propias disponibles + homogeneidad (bloqueadas con FOR UPDATE)
    const { rows: unidades } = await client.query(
      `
      SELECT id, tipo_componente, grupo, rh, filtrado, irradiado, fecha_vencimiento
      FROM unidad
      WHERE id = ANY($1::uuid[])
        AND centro_actual_id = $2
        AND estado = 'disponible'
      ORDER BY fecha_vencimiento ASC
      FOR UPDATE
      `,
      [unidad_ids, origenCentroId]
    );
    if (unidades.length !== unidad_ids.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Una o más unidades no pertenecen a tu centro o no están disponibles" });
    }
    if (!unidades.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No hay unidades seleccionadas disponibles" });
    }

    const sameKey = (u) => [u.tipo_componente, u.grupo, u.rh, !!u.filtrado, !!u.irradiado].join("|");
    const keyUnits = sameKey(unidades[0]);
    const keySol   = [sol.tipo_componente, sol.grupo, sol.rh, !!sol.filtrado, !!sol.irradiado].join("|");
    if (unidades.some(u => sameKey(u) !== keyUnits) || keyUnits !== keySol) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Las unidades no son homogéneas o no coinciden con la solicitud" });
    }

    const tomar = Math.min(unidades.length, sol.cantidad);
    const unidadesTomadas = unidades.slice(0, tomar);

    // Oferta “sombra” cerrada
    const ofertaRes = await client.query(
      `
      INSERT INTO oferta (id, centro_id, estado, observaciones)
      VALUES (uuid_generate_v4(), $1, 'cerrada', $2)
      RETURNING id
      `,
      [origenCentroId, observaciones || `Oferta generada desde solicitud ${solicitud_id}`]
    );
    const ofertaId = ofertaRes.rows[0].id;

    await client.query(
      `
      INSERT INTO oferta_item (id, oferta_id, unidad_id)
      SELECT uuid_generate_v4(), $1, x.id
      FROM UNNEST($2::uuid[]) AS x(id)
      `,
      [ofertaId, unidadesTomadas.map(u => u.id)]
    );

    // Transferencia
    const transfRes = await client.query(
      `
      INSERT INTO transferencia
        (id, solicitud_id, oferta_id, centro_origen_id, centro_destino_id, estado, fecha_creada)
      VALUES (uuid_generate_v4(), $1, $2, $3, $4, 'creada', now())
      RETURNING id
      `,
      [solicitud_id, ofertaId, origenCentroId, destCentroId]
    );
    const transferenciaId = transfRes.rows[0].id;

    await client.query(
      `
      INSERT INTO transferencia_item (id, transferencia_id, unidad_id)
      SELECT uuid_generate_v4(), $1, x.id
      FROM UNNEST($2::uuid[]) AS x(id)
      `,
      [transferenciaId, unidadesTomadas.map(u => u.id)]
    );

    // Actualizaciones derivadas
    const restantes = sol.cantidad - tomar;
    if (restantes <= 0) {
      await client.query(`UPDATE solicitud SET estado = 'aceptada' WHERE id = $1`, [solicitud_id]);
    } else {
      await client.query(`UPDATE solicitud SET cantidad = $1 WHERE id = $2`, [restantes, solicitud_id]);
    }

    await client.query("COMMIT");

    // Auditoría (post commit)
    await audit({
      req,
      entidad: "transferencia",
      entidad_id: transferenciaId,
      accion: "CREAR",
      detalles: {
        origen: "desde_solicitud",
        solicitud_id,
        oferta_id: ofertaId,
        unidades: unidadesTomadas.map(u => u.id),
        cantidad_enviada: tomar,
      },
    });

    // Respuesta rápida al cliente
    res.json({ ok: true, transferencia_id: transferenciaId });

    // Notificación post commit, no bloqueante
    setImmediate(async () => {
      try {
        const { notificarTransferenciaCreada } = require("../lib/notificaciones");
        await notificarTransferenciaCreada({
          transferenciaId,
          centroOrigenId: origenCentroId,
          centroDestinoId: destCentroId,
        });
      } catch (e) {
        console.error("[notifs] transferencia creada:", e);
      }
    });

  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("POST /api/solicitudes/desde-solicitud", e);
    res.status(500).json({ error: "No se pudo crear la transferencia desde la solicitud" });
  } finally {
    client.release();
  }
});



module.exports = router;
