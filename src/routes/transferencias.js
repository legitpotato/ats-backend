const express = require("express"); 
const router = express.Router();
const auth = require("../middlewares/auth");
const pool = require("../db");
const audit = require("../lib/audit");

// Importa las notificaciones al inicio
const {
  notificarTransferenciaCreada,
  notificarTransferenciaEstado,
  notificarCambioEstadoOferta,
} = require("../lib/notificaciones");

router.post("/desde-oferta", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { oferta_id, unidad_ids } = req.body;
    const destCentroId = req.user?.centro_id;
    if (!destCentroId) return res.status(400).json({ error: "Usuario sin centro" });
    if (!oferta_id)  return res.status(400).json({ error: "oferta_id requerido" });

    await client.query("BEGIN");

    // 1) Oferta (lock)
    const { rows: ofRows } = await client.query(
      `SELECT id, centro_id, estado FROM oferta WHERE id = $1 FOR UPDATE`,
      [oferta_id]
    );
    if (!ofRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Oferta no existe" });
    }
    const oferta = ofRows[0];
    if (oferta.estado !== "abierta") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "La oferta no está abierta" });
    }

    // Evita aceptar ofertas del mismo centro
    if (oferta.centro_id === destCentroId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "No puedes aceptar ofertas de tu propio centro" });
    }

    // Unidades de la oferta
    const { rows: unTodas } = await client.query(
      `
      SELECT u.*
      FROM oferta_item oi
      JOIN unidad u ON u.id = oi.unidad_id
      WHERE oi.oferta_id = $1
      ORDER BY u.fecha_vencimiento ASC
      `,
      [oferta_id]
    );
    if (!unTodas.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "La oferta no tiene unidades" });
    }

    // Determinar set seleccionado (todas deben estar 'asignada')
    let unSel = unTodas.filter(u => u.estado === "asignada");
    if (Array.isArray(unidad_ids) && unidad_ids.length) {
      const setIds = new Set(unidad_ids);
      const filtradas = unTodas.filter(u => setIds.has(u.id));
      if (filtradas.length !== unidad_ids.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Una o más unidades no pertenecen a la oferta" });
      }
      if (filtradas.some(u => u.estado !== "asignada")) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Una o más unidades no están disponibles para transferir" });
      }
      unSel = filtradas;
    }
    if (!unSel.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "No hay unidades seleccionadas disponibles" });
    }

    // Homogeneidad (todas con misma combinación)
    const sameKey = (u) => [u.tipo_componente,u.grupo,u.rh,!!u.filtrado,!!u.irradiado].join("|");
    const key0 = sameKey(unSel[0]);
    const heterogeneas = unSel.some(u => sameKey(u) !== key0);
    if (heterogeneas) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "La selección incluye unidades con atributos distintos (tipo/grupo/RH/flags). Selecciona un grupo homogéneo." });
    }

    const base = unSel[0];

    // Buscar la mejor solicitud compatible del centro destino
    let sol;
    {
      const { rows: solRows } = await client.query(
        `
        SELECT s.*
        FROM solicitud s
        WHERE s.estado = 'pendiente'
          AND s.centro_solicitante_id = $1
          AND s.tipo_componente = $2
          AND s.grupo = $3
          AND s.rh = $4
          AND s.filtrado = $5
          AND s.irradiado = $6
          AND s.cantidad <= $7
        ORDER BY s.urgente DESC, s.creada_en ASC
        LIMIT 1
        `,
        [
          destCentroId,
          base.tipo_componente, base.grupo, base.rh,
          base.filtrado, base.irradiado,
          unSel.length
        ]
      );

      if (solRows.length) {
        sol = solRows[0];
      } else {
        // Auto-crear “solicitud sombra” cuando no existe una coincidencia
        const ins = await client.query(
          `
          INSERT INTO solicitud
            (id, centro_solicitante_id, estado, tipo_componente, grupo, rh, filtrado, irradiado, cantidad, urgente, creada_en)
          VALUES (uuid_generate_v4(), $1, 'pendiente', $2, $3, $4, $5, $6, $7, false, now())
          RETURNING *
          `,
          [
            destCentroId,
            base.tipo_componente, base.grupo, base.rh,
            base.filtrado, base.irradiado,
            unSel.length
          ]
        );
        sol = ins.rows[0];
      }
    }

    // Tomar exactamente s.cantidad unidades (por vencimiento asc)
    const unidadesTomadas = unSel.slice(0, sol.cantidad);

    // Crear transferencia
    const transfRes = await client.query(
      `
      INSERT INTO transferencia
        (id, solicitud_id, oferta_id, centro_origen_id, centro_destino_id, estado, fecha_creada)
      VALUES (uuid_generate_v4(), $1, $2, $3, $4, 'creada', now())
      RETURNING id
      `,
      [sol.id, oferta_id, oferta.centro_id, destCentroId]
    );
    const transferenciaId = transfRes.rows[0].id;

    // Ítems
    await client.query(
      `
      INSERT INTO transferencia_item (id, transferencia_id, unidad_id)
      SELECT uuid_generate_v4(), $1, x.id
      FROM UNNEST($2::uuid[]) AS x(id)
      `,
      [transferenciaId, unidadesTomadas.map(u => u.id)]
    );

    // Estados
    await client.query(`UPDATE solicitud SET estado = 'aceptada' WHERE id = $1`, [sol.id]);
    // No mover unidades aún; se actualizan al ENVIAR/RECIBIR.

    // ¿quedan 'asignada' en la oferta?
    const { rows: quedan } = await client.query(
      `
      SELECT COUNT(*)::int AS c
      FROM oferta_item oi
      JOIN unidad u ON u.id = oi.unidad_id
      WHERE oi.oferta_id = $1
        AND u.estado = 'asignada'
      `,
      [oferta_id]
    );
    const ofertaSeCierra = (quedan[0].c || 0) === 0;
    if (ofertaSeCierra) {
      await client.query(`UPDATE oferta SET estado = 'cerrada' WHERE id = $1`, [oferta_id]);
    }

    await client.query("COMMIT");

    // Notificar creación de transferencia (fuera de la tx)
    try {
      await notificarTransferenciaCreada({
        transferenciaId,
        centroOrigenId: oferta.centro_id,
        centroDestinoId: destCentroId,
      });
    } catch (e) {
      console.error("[notifs] transferencia creada (desde-oferta):", e);
    }

    // Si la oferta se cerró, avisar cambio de estado
    if (ofertaSeCierra) {
      try {
        await notificarCambioEstadoOferta({ ofertaId: oferta_id, nuevoEstado: "cerrada" });
      } catch (e) {
        console.error("[notifs] oferta cerrada tras transferencia:", e);
      }
    }

    await audit({
      req,
      entidad: "transferencia",
      entidad_id: transferenciaId,
      accion: "CREAR",
      detalles: {
        desde_oferta: oferta_id,
        solicitud_id: sol.id,
        unidades: unidadesTomadas.map(u => u.id),
        oferta_cierra: ofertaSeCierra
      },
    });

    res.json({ ok: true, transferencia_id: transferenciaId });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("POST /api/transferencias/desde-oferta", e);
    res.status(500).json({ error: "No se pudo crear la transferencia" });
  } finally {
    client.release();
  }
});

// GET /api/transferencias/mias?scope=ambos|origen|destino
router.get("/mias", auth, async (req, res) => {
  try {
    const { centro_id } = req.user;
    if (!centro_id) return res.status(400).json({ error: "Usuario sin centro" });

    // scope=origen|destino|ambos (default ambos)
    const scope = (req.query.scope || "ambos").toLowerCase();
    const where =
      scope === "origen"  ? "t.centro_origen_id  = $1" :
      scope === "destino" ? "t.centro_destino_id = $1" :
                            "(t.centro_origen_id = $1 OR t.centro_destino_id = $1)";

    const sql = `
      SELECT
        t.id,
        t.estado,
        t.fecha_creada,
        co.id   AS centro_origen_id,
        co.nombre AS centro_origen,
        cd.id   AS centro_destino_id,
        cd.nombre AS centro_destino,
        (SELECT COUNT(*)::int FROM transferencia_item ti WHERE ti.transferencia_id = t.id) AS unidades
      FROM transferencia t
      JOIN centro_sangre co ON co.id = t.centro_origen_id
      JOIN centro_sangre cd ON cd.id = t.centro_destino_id
      WHERE ${where}
      ORDER BY t.fecha_creada DESC
    `;
    const { rows } = await pool.query(sql, [centro_id]);
    res.json(rows);
  } catch (e) {
    console.error("GET /api/transferencias/mias", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// PATCH /api/transferencias/:id/avanzar  { accion: 'enviar' | 'recibir' | 'cancelar' }
router.patch("/:id/avanzar", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { accion } = req.body;
    const { centro_id } = req.user;

    if (!["enviar", "recibir", "cancelar"].includes(accion)) {
      return res.status(400).json({ error: "Acción inválida" });
    }

    await client.query("BEGIN");

    // lock de la transferencia y datos clave
    const { rows: tRows } = await client.query(
      `
      SELECT
        t.id, t.estado, t.oferta_id,
        t.centro_origen_id, t.centro_destino_id
      FROM transferencia t
      WHERE t.id = $1
      FOR UPDATE
      `,
      [id]
    );
    if (!tRows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Transferencia no existe" });
    }
    const t = tRows[0];

    // unidades involucradas
    const { rows: uRows } = await client.query(
      `
      SELECT u.id
      FROM transferencia_item ti
      JOIN unidad u ON u.id = ti.unidad_id
      WHERE ti.transferencia_id = $1
      `,
      [id]
    );
    const unidadIds = uRows.map(r => r.id);

    // helpers
    const reopenOfferIfNeeded = async () => {
      if (!t.oferta_id) return;
      // Si hay al menos una unidad 'asignada' de esa oferta, deja oferta en 'abierta'
      await client.query(`
        UPDATE oferta SET estado = 'abierta'
        WHERE id = $1
          AND EXISTS (
            SELECT 1
            FROM oferta_item oi
            JOIN unidad u ON u.id = oi.unidad_id
            WHERE oi.oferta_id = $1 AND u.estado = 'asignada'
          )
      `, [t.oferta_id]);
    };

    if (accion === "enviar") {
      // Solo centro de origen y estado 'creada'
      if (centro_id !== t.centro_origen_id) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Solo el centro de origen puede marcar como enviada" });
      }
      if (t.estado !== "creada") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "La transferencia no está en estado 'creada'" });
      }

      await client.query(
        `UPDATE transferencia SET estado = 'en_transito', fecha_enviada = NOW() WHERE id = $1`,
        [id]
      );
      // Las unidades pasan a EN TRANSITO
      if (unidadIds.length) {
        await client.query(
          `
          UPDATE unidad
          SET estado = 'en_transito',
              centro_actual_id = $1 -- mantener origen mientras viaja; o NULL si prefieres
          WHERE id = ANY($2::uuid[])
          `,
          [t.centro_origen_id, unidadIds]
        );
      }

      // No tocamos estado de unidades aún, se marcan transferidas al recibir.
    } else if (accion === "recibir") {
      // Solo centro de destino y estado 'en_transito'
      if (centro_id !== t.centro_destino_id) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Solo el centro de destino puede marcar como recibida" });
      }
      if (t.estado !== "en_transito") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "La transferencia no está en tránsito" });
      }

      await client.query(
        `UPDATE transferencia SET estado = 'recibida', fecha_recibida = NOW() WHERE id = $1`,
        [id]
      );

      // Las unidades pasan a 'transferida' en el destino
      if (unidadIds.length) {
        await client.query(
          `
          UPDATE unidad
          SET estado = 'transferida',
              centro_actual_id = $1
          WHERE id = ANY($2::uuid[])
          `,
          [t.centro_destino_id, unidadIds]
        );
      }

    } else if (accion === "cancelar") {
      // Solo centro de origen y estado 'creada' o 'en_transito'
      if (centro_id !== t.centro_origen_id) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Solo el centro de origen puede cancelar" });
      }
      if (!["creada", "en_transito"].includes(t.estado)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "No es posible cancelar en este estado" });
      }

      await client.query(
        `UPDATE transferencia SET estado = 'cancelada', fecha_cancelada = NOW() WHERE id = $1`,
        [id]
      );

      // Devolver unidades a 'asignada' en el centro de origen (vuelven a la oferta)
      if (unidadIds.length) {
        await client.query(
          `
          UPDATE unidad
          SET estado = 'asignada',
              centro_actual_id = $1
          WHERE id = ANY($2::uuid[])
          `,
          [t.centro_origen_id, unidadIds]
        );
      }

      // Reabrir oferta si corresponde
      await reopenOfferIfNeeded();
    }

    await client.query("COMMIT");

    // Notificaciones fuera de la transacción
    try {
      await notificarTransferenciaEstado({
        transferenciaId: id,
        centroOrigenId: t.centro_origen_id,
        centroDestinoId: t.centro_destino_id,
        accion,
      });

      // Si cancelaste y había oferta asociada, podrías avisar que quedó abierta
      if (accion === "cancelar" && t.oferta_id) {
        await notificarCambioEstadoOferta({ ofertaId: t.oferta_id, nuevoEstado: "abierta" });
      }
    } catch (e) {
      console.error("[notifs] avanzar transferencia:", e);
    }

    // Auditoría del cambio
    try {
      await audit({
        req,
        entidad: "transferencia",
        entidad_id: id,
        accion: "CAMBIO_ESTADO",
        detalles: { accion },
      });
    } catch (e) {
      console.error("audit transferencia avanzar:", e);
    }

    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(()=>{});
    console.error("PATCH /api/transferencias/:id/avanzar", e);
    res.status(500).json({ error: "Error interno" });
  } finally {
    client.release();
  }
});

// GET /api/transferencias/:id/hist-agregado — Resumen de oferta/solicitud
router.get("/:id/hist-agregado", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { centro_id } = req.user;
    if (!centro_id) return res.status(400).json({ error: "Usuario sin centro" });

    // Cabecera mínima para validar permisos y leer ids vinculados
    const { rows } = await pool.query(
      `
      SELECT
        t.id, t.oferta_id, t.solicitud_id,
        t.centro_origen_id, t.centro_destino_id
      FROM transferencia t
      WHERE t.id = $1
      `,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "No existe" });

    const t = rows[0];
    // Permisos: debe pertenecer a tu centro (origen o destino)
    if (t.centro_origen_id !== centro_id && t.centro_destino_id !== centro_id) {
      return res.status(403).json({ error: "Sin permisos" });
    }

    // Oferta simple
    let oferta = null;
    if (t.oferta_id) {
      const { rows: o } = await pool.query(
        `
        SELECT o.id, o.estado, c.nombre AS centro_nombre
        FROM oferta o
        JOIN centro_sangre c ON c.id = o.centro_id
        WHERE o.id = $1
        `,
        [t.oferta_id]
      );
      oferta = o[0] || null;
    }

    // Solicitud simple
    let solicitud = null;
    if (t.solicitud_id) {
      const { rows: s } = await pool.query(
        `
        SELECT s.id, s.estado, c.nombre AS centro_nombre
        FROM solicitud s
        JOIN centro_sangre c ON c.id = s.centro_solicitante_id
        WHERE s.id = $1
        `,
        [t.solicitud_id]
      );
      solicitud = s[0] || null;
    }

    res.json({ oferta, solicitud });
  } catch (e) {
    console.error("GET /api/transferencias/:id/hist-agregado", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// GET /api/transferencias/:id — Detalle completo
router.get("/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { centro_id } = req.user;
    if (!centro_id) return res.status(400).json({ error: "Usuario sin centro" });

    // Cabecera
    const { rows } = await pool.query(
      `
      SELECT
        t.id, t.estado, t.fecha_creada, t.fecha_enviada, t.fecha_recibida, t.fecha_cancelada,
        t.oferta_id, t.solicitud_id,
        t.centro_origen_id, co.nombre AS centro_origen,
        t.centro_destino_id, cd.nombre AS centro_destino
      FROM transferencia t
      JOIN centro_sangre co ON co.id = t.centro_origen_id
      JOIN centro_sangre cd ON cd.id = t.centro_destino_id
      WHERE t.id = $1
      `,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "No existe" });

    const t = rows[0];

    // Permisos: debe pertenecer a tu centro (origen o destino)
    if (t.centro_origen_id !== centro_id && t.centro_destino_id !== centro_id) {
      return res.status(403).json({ error: "Sin permisos para ver esta transferencia" });
    }

    // Unidades
    const { rows: uRows } = await pool.query(
      `
      SELECT
        u.id,
        u.codigo_seguimiento AS codigo,
        u.tipo_componente    AS tipo,
        u.grupo,
        u.rh,
        u.filtrado,
        u.irradiado,
        u.fecha_vencimiento  AS vence
      FROM transferencia_item ti
      JOIN unidad u ON u.id = ti.unidad_id
      WHERE ti.transferencia_id = $1
      ORDER BY u.fecha_vencimiento ASC NULLS LAST
      `,
      [id]
    );

    // Contactos (placeholder: null para no romper tu esquema)
    const detalle = {
      ...t,
      contacto_origen_nombre:  null,
      contacto_origen_email:   null,
      contacto_origen_fono:    null,
      contacto_destino_nombre: null,
      contacto_destino_email:  null,
      contacto_destino_fono:   null,
      unidades: uRows,
    };

    res.json(detalle);
  } catch (e) {
    console.error("GET /api/transferencias/:id", e);
    res.status(500).json({ error: "Error interno" });
  }
});


module.exports = router;
