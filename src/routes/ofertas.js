const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const pool = require("../db");
const audit = require("../lib/audit");

// Crear oferta con items + detectar solicitudes compatibles
router.post("/", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { centro_id } = req.user;
    if (!centro_id)
      return res.status(400).json({ error: "Usuario sin centro" });

    const { unidad_ids = [], observaciones = null } = req.body;
    if (!Array.isArray(unidad_ids) || unidad_ids.length === 0) {
      return res
        .status(400)
        .json({ error: "Debes indicar al menos una unidad" });
    }

    // validar unidades
    const { rows: unidades } = await pool.query(
      `
      SELECT id, tipo_componente, grupo, rh, filtrado, irradiado
      FROM unidad
      WHERE id = ANY($1::uuid[])
        AND centro_actual_id = $2
        AND estado = 'disponible'
    `,
      [unidad_ids, centro_id]
    );
    if (unidades.length !== unidad_ids.length) {
      return res.status(400).json({
        error:
          "Una o más unidades no pertenecen al centro o no están disponibles",
      });
    }

    const base = unidades[0];

    await client.query("BEGIN");

    // crear oferta
    const ofertaRes = await client.query(
      `
      INSERT INTO oferta (id, centro_id, estado, observaciones)
      VALUES (uuid_generate_v4(), $1, 'abierta', $2)
      RETURNING id, creada_en, estado
    `,
      [centro_id, observaciones]
    );
    const ofertaId = ofertaRes.rows[0].id;

    // items
    for (const u of unidad_ids) {
      await client.query(
        `INSERT INTO oferta_item (id, oferta_id, unidad_id)
         VALUES (uuid_generate_v4(), $1, $2)`,
        [ofertaId, u]
      );
    }

    // bloquear unidades
    await client.query(
      `UPDATE unidad SET estado = 'asignada' WHERE id = ANY($1::uuid[])`,
      [unidad_ids]
    );

    // buscar solo cuántas solicitudes calzan
    const { rows: coincidencias } = await client.query(
      `
      SELECT count(*)::int AS total
      FROM solicitud
      WHERE estado = 'pendiente'
        AND tipo_componente = $1
        AND grupo = $2
        AND rh = $3
        AND filtrado = $4
        AND irradiado = $5
        AND cantidad <= $6
        AND centro_solicitante_id <> $7
    `,
      [
        base.tipo_componente,
        base.grupo,
        base.rh,
        base.filtrado,
        base.irradiado,
        unidad_ids.length,
        centro_id,
      ]
    );

    await client.query("COMMIT");

    // después de COMMIT y audit, no bloqueante
    (async () => {
      try {
        const { notificarOfertaCreada } = require("../lib/notificaciones");
        await notificarOfertaCreada({
          centroId: req.user.centro_id,
          ofertaId: ofertaId,
          observaciones
        });
      } catch (e) {
        console.error("[notifs] oferta creada:", e);
      }
    })();

    await audit({
      req,
      entidad: "oferta",
      entidad_id: ofertaId,
      accion: "CREAR",
      detalles: {
        unidad_ids,
        observaciones,
        coincidencias: coincidencias[0].total,
      },
    });

    return res.status(201).json({
      ok: true,
      oferta: ofertaRes.rows[0],
      match: coincidencias[0].total > 0,
      match_count: coincidencias[0].total,
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("POST /api/ofertas", e);
    res.status(500).json({ error: "No se pudo crear la oferta" });
  } finally {
    client.release();
  }
});

// Valida unidades y busca solicitudes compatibles, sin crear nada
router.post("/precheck", auth, async (req, res) => {
  try {
    const { centro_id } = req.user;
    if (!centro_id)
      return res.status(400).json({ error: "Usuario sin centro" });

    const { unidad_ids = [], observaciones = null } = req.body;
    if (!Array.isArray(unidad_ids) || unidad_ids.length === 0) {
      return res
        .status(400)
        .json({ error: "Debes indicar al menos una unidad" });
    }

    // validar unidades igual que en POST /
    const { rows: unidades } = await pool.query(
      `
      SELECT id, tipo_componente, grupo, rh, filtrado, irradiado
      FROM unidad
      WHERE id = ANY($1::uuid[])
        AND centro_actual_id = $2
        AND estado = 'disponible'
    `,
      [unidad_ids, centro_id]
    );

    if (unidades.length !== unidad_ids.length) {
      return res.status(400).json({
        error:
          "Una o más unidades no pertenecen al centro o no están disponibles",
      });
    }

    const base = unidades[0];

    // buscar solicitudes compatibles (que podrían ser cubiertas con estas unidades)
    const { rows: solicitudes } = await pool.query(
      `
      SELECT
        s.id,
        s.tipo_componente,
        s.grupo,
        s.rh,
        s.cantidad,
        s.urgente,
        s.observaciones,
        s.filtrado,
        s.irradiado,
        s.creada_en,
        s.centro_solicitante_id,
        c.nombre AS centro_nombre,
        c.region,
        c.comuna
      FROM solicitud s
      JOIN centro_sangre c ON c.id = s.centro_solicitante_id
      WHERE s.estado = 'pendiente'
        AND s.tipo_componente = $1
        AND s.grupo = $2
        AND s.rh = $3
        AND s.filtrado = $4
        AND s.irradiado = $5
        AND s.cantidad <= $6
        AND s.centro_solicitante_id <> $7
      ORDER BY s.urgente DESC, s.creada_en ASC
    `,
      [
        base.tipo_componente,
        base.grupo,
        base.rh,
        base.filtrado,
        base.irradiado,
        unidad_ids.length,
        centro_id,
      ]
    );

    return res.json({
      ok: true,
      observaciones,
      unidades: unidades.map((u) => u.id),
      solicitudes_compatibles: solicitudes,
    });
  } catch (e) {
    console.error("POST /api/ofertas/precheck", e);
    res.status(500).json({ error: "Error interno en precheck" });
  }
});

// Listar ofertas (filtros, búsqueda, agregados de unidades y paginación)
router.get("/", auth, async (req, res) => {
  try {
    const estado = (req.query.estado || "").toLowerCase();
    const q = (req.query.q || "").trim();
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || "20", 10)));
    const offset = (page - 1) * limit;

    const params = [];
    const where = [];
    if (estado && ["abierta","cerrada","cancelada"].includes(estado)) {
      params.push(estado);
      where.push(`o.estado = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(c.nombre ILIKE $${params.length} OR COALESCE(o.observaciones,'') ILIKE $${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      WITH base AS (
        SELECT
          o.id,
          o.estado,
          o.creada_en,
          o.observaciones,
          c.id AS centro_id,
          c.nombre AS centro_nombre,
          c.region,
          c.comuna,
          c.latitud,
          c.longitud
        FROM oferta o
        JOIN centro_sangre c ON c.id = o.centro_id
        ${whereSql}
        ORDER BY o.creada_en DESC
        OFFSET ${offset}
        LIMIT ${limit}
      )
      SELECT
        b.*,
        COUNT(oi.id)::int AS unidades_ofertadas,
        MIN(u.fecha_vencimiento) AS vence_min,
        COALESCE(
          JSON_AGG(
            DISTINCT JSONB_BUILD_OBJECT(
              'tipo', u.tipo_componente,
              'grupo', u.grupo,
              'rh', u.rh,
              'filtrado', u.filtrado,
              'irradiado', u.irradiado,
              'vence', u.fecha_vencimiento
            )
          ) FILTER (WHERE u.id IS NOT NULL),
          '[]'::json
        ) AS unidades
      FROM base b
      LEFT JOIN oferta_item oi ON oi.oferta_id = b.id
      LEFT JOIN unidad u       ON u.id = oi.unidad_id
      GROUP BY b.id, b.estado, b.creada_en, b.observaciones, b.centro_id, b.centro_nombre, b.region, b.comuna, b.latitud, b.longitud
      ORDER BY b.creada_en DESC
    `;

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM oferta o
      JOIN centro_sangre c ON c.id = o.centro_id
      ${whereSql}
    `;

    const [rowsRes, countRes] = await Promise.all([
      pool.query(sql, params),
      pool.query(countSql, params)
    ]);

    res.json({
      page,
      limit,
      total: countRes.rows[0]?.total || 0,
      items: rowsRes.rows
    });
  } catch (e) {
    console.error("GET /api/ofertas", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// Cerrar y cancelar oferta
router.patch("/:id/estado", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { nuevo_estado } = req.body;
    const permitidos = ["abierta", "cerrada", "cancelada"];
    if (!permitidos.includes(nuevo_estado)) {
      return res.status(400).json({ error: "Estado inválido" });
    }

    await client.query("BEGIN");

    // 1) Cambiar estado de la oferta
    const { rows } = await client.query(
      `
      UPDATE oferta
      SET estado = $1
      WHERE id = $2
      RETURNING id, estado, creada_en
    `,
      [nuevo_estado, id]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "No existe la oferta" });
    }

    // 2) Ajustar inventario según el nuevo estado
    if (nuevo_estado === "cancelada") {
      await client.query(
        `
        UPDATE unidad
        SET estado = 'disponible'
        WHERE id IN (
          SELECT oi.unidad_id
          FROM oferta_item oi
          WHERE oi.oferta_id = $1
        )
      `,
        [id]
      );
    } else if (nuevo_estado === "abierta") {
      await client.query(
        `
        UPDATE unidad
        SET estado = 'asignada'
        WHERE id IN (
          SELECT oi.unidad_id
          FROM oferta_item oi
          WHERE oi.oferta_id = $1
        )
      `,
        [id]
      );
    }
    // si 'cerrada': se supone que luego la transferencia las pasa a 'transferida'

    await client.query("COMMIT");

    await audit({
      req,
      entidad: "oferta",
      entidad_id: id,
      accion: "CAMBIO_ESTADO",
      detalles: {
        nuevo_estado,
      },
    });

    try {
      const { notificarCambioEstadoOferta } = require("../lib/notificaciones");
      await notificarCambioEstadoOferta({ ofertaId: id, nuevoEstado: nuevo_estado });
    } catch (e) {
      console.error("[notifs] cambio estado oferta:", e);
    }

    res.json({ ok: true, oferta: rows[0] });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("PATCH /api/ofertas/:id/estado", e);
    res.status(500).json({ error: "Error interno" });
  } finally {
    client.release();
  }
});

// GET /api/ofertas/mias
router.get("/mias", auth, async (req, res) => {
  try {
    const { centro_id } = req.user;
    if (!centro_id) return res.status(400).json({ error: "Usuario sin centro" });

    const estado = (req.query.estado || "").toLowerCase();
    const q = (req.query.q || "").trim();
    const page  = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || "20", 10)));
    const offset = (page - 1) * limit;

    const params = [centro_id];
    const where = ["o.centro_id = $1"];
    if (estado && ["abierta","cerrada","cancelada"].includes(estado)) {
      params.push(estado); where.push(`o.estado = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(c.nombre ILIKE $${params.length} OR COALESCE(o.observaciones,'') ILIKE $${params.length})`);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const sql = `
      WITH base AS (
        SELECT o.id, o.estado, o.creada_en, o.observaciones,
               c.id AS centro_id, c.nombre AS centro_nombre, c.region, c.comuna, c.latitud, c.longitud
        FROM oferta o
        JOIN centro_sangre c ON c.id = o.centro_id
        ${whereSql}
        ORDER BY o.creada_en DESC
        OFFSET ${offset} LIMIT ${limit}
      )
      SELECT b.*,
             COUNT(oi.id)::int AS unidades_ofertadas,
             MIN(u.fecha_vencimiento) AS vence_min,
             JSON_AGG(
               DISTINCT JSONB_BUILD_OBJECT(
                 'id', u.id,
                 'tipo', u.tipo_componente,
                 'grupo', u.grupo,
                 'rh', u.rh,
                 'filtrado', u.filtrado,
                 'irradiado', u.irradiado,
                 'vence', u.fecha_vencimiento
               )
             ) FILTER (WHERE u.id IS NOT NULL) AS unidades
      FROM base b
      LEFT JOIN oferta_item oi ON oi.oferta_id = b.id
      LEFT JOIN unidad u       ON u.id = oi.unidad_id
      GROUP BY b.id, b.estado, b.creada_en, b.observaciones, b.centro_id, b.centro_nombre, b.region, b.comuna, b.latitud, b.longitud
      ORDER BY b.creada_en DESC
    `;
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM oferta o
      JOIN centro_sangre c ON c.id = o.centro_id
      ${whereSql}
    `;
    const [rowsRes, countRes] = await Promise.all([pool.query(sql, params), pool.query(countSql, params)]);
    res.json({ page, limit, total: countRes.rows[0]?.total || 0, items: rowsRes.rows });
  } catch (e) {
    console.error("GET /api/ofertas/mias", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// GET /api/ofertas/:id
router.get("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;

    const ofertaSql = `
      SELECT
        o.id, o.estado, o.creada_en, o.observaciones,
        c.id   AS centro_id,   c.nombre AS centro_nombre,
        c.region, c.comuna, c.latitud, c.longitud,
        uo.id  AS usuario_id,  uo.nombre AS usuario_nombre, uo.email AS usuario_email
      FROM oferta o
      JOIN centro_sangre c ON c.id = o.centro_id
      LEFT JOIN usuario uo  ON uo.centro_id = c.id
      WHERE o.id = $1
      LIMIT 1
    `;
    const { rows: ofertaRows } = await pool.query(ofertaSql, [id]);
    if (!ofertaRows.length) return res.status(404).json({ error: "No existe la oferta" });
    const oferta = ofertaRows[0];

    // todas las unidades (vigentes y su data)
    const unidadesSql = `
      SELECT
        u.id,
        u.tipo_componente,
        u.grupo,
        u.rh,
        u.filtrado,
        u.irradiado,
        u.fecha_vencimiento AS vence,
        u.codigo_seguimiento,
        u.estado,
        -- seleccionable si la oferta está abierta y la unidad está 'asignada' a esta oferta
        (o.estado = 'abierta' AND u.estado = 'asignada') AS seleccionable
      FROM oferta_item oi
      JOIN unidad u ON u.id = oi.unidad_id
      JOIN oferta o ON o.id = oi.oferta_id
      WHERE oi.oferta_id = $1
      ORDER BY u.fecha_vencimiento ASC
    `;
    const { rows: unidades } = await pool.query(unidadesSql, [id]);

    return res.json({ ...oferta, unidades });
  } catch (e) {
    console.error("GET /api/ofertas/:id", e);
    res.status(500).json({ error: "Error interno" });
  }
});


module.exports = router;
