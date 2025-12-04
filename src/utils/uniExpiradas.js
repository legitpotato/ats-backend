const pool = require("../db");
const { notificarOfertaCanceladaPorVencimiento } = require("../lib/notificaciones");

async function uniExpiradas() {
  const client = await pool.connect();
  const ofertasCanceladas = [];

  try {
    await client.query("BEGIN");
    // Ofertas abiertas con al menos una unidad vencida
    const { rows: ofertasConVencidas } = await client.query(`
      SELECT o.id
      FROM oferta o
      WHERE o.estado = 'abierta'
        AND EXISTS (
          SELECT 1
          FROM oferta_item oi
          JOIN unidad u ON u.id = oi.unidad_id
          WHERE oi.oferta_id = o.id
            AND u.fecha_vencimiento < NOW()
        )
      FOR UPDATE SKIP LOCKED
    `);

    for (const { id: ofertaId } of ofertasConVencidas) {
      // Cancelar oferta
      await client.query(
        `UPDATE oferta SET estado = 'cancelada' WHERE id = $1`,
        [ofertaId]
      );

      // Pasar a histórico las unidades VENCIDAS
      await client.query(
        `
        INSERT INTO unidad_historico
          (id, tipo_componente, grupo, rh, fecha_extraccion, fecha_vencimiento,
           codigo_seguimiento, estado, centro_actual_id, filtrado, irradiado, creado_en, creada_por_id)
        SELECT
          u.id, u.tipo_componente, u.grupo, u.rh, u.fecha_extraccion, u.fecha_vencimiento,
          u.codigo_seguimiento, 'vencida', u.centro_actual_id, u.filtrado, u.irradiado, u.creado_en, u.creada_por_id
        FROM unidad u
        JOIN oferta_item oi ON oi.unidad_id = u.id
        WHERE oi.oferta_id = $1
          AND u.fecha_vencimiento < NOW()
        `,
        [ofertaId]
      );

      // Borrar unidades vencidas
      await client.query(
        `
        DELETE FROM unidad
        WHERE id IN (
          SELECT u.id
          FROM unidad u
          JOIN oferta_item oi ON oi.unidad_id = u.id
          WHERE oi.oferta_id = $1
            AND u.fecha_vencimiento < NOW()
        )
        `,
        [ofertaId]
      );

      // Liberar unidades no vencidas
      await client.query(
        `
        UPDATE unidad
        SET estado = 'disponible'
        WHERE id IN (
          SELECT u.id
          FROM unidad u
          JOIN oferta_item oi ON oi.unidad_id = u.id
          WHERE oi.oferta_id = $1
            AND u.fecha_vencimiento >= NOW()
        )
        `,
        [ofertaId]
      );

      ofertasCanceladas.push(ofertaId);
    }

    // Otras unidades vencidas no asociadas a oferta
    await client.query(`
      INSERT INTO unidad_historico
        (id, tipo_componente, grupo, rh, fecha_extraccion, fecha_vencimiento,
         codigo_seguimiento, estado, centro_actual_id, filtrado, irradiado, creado_en, creada_por_id)
      SELECT
        u.id, u.tipo_componente, u.grupo, u.rh, u.fecha_extraccion, u.fecha_vencimiento,
        u.codigo_seguimiento, 'vencida', u.centro_actual_id, u.filtrado, u.irradiado, u.creado_en, u.creada_por_id
      FROM unidad u
      WHERE u.fecha_vencimiento < NOW()
        AND u.estado = 'disponible'
    `);

    await client.query(`
      DELETE FROM unidad
      WHERE fecha_vencimiento < NOW()
        AND estado = 'disponible'
    `);

    await client.query("COMMIT");

    console.log(
      `Unidades vencidas procesadas. Ofertas canceladas: ${ofertasCanceladas.length}.`
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Error en uniExpiradas:", err);
  } finally {
    client.release();
  }

  // Notificaciones fuera de la transacción
  for (const ofertaId of ofertasCanceladas) {
    try {
      await notificarOfertaCanceladaPorVencimiento({ ofertaId });
    } catch (e) {
      console.error("[notifs] oferta cancelada por vencimiento:", e);
    }
  }
}

module.exports = uniExpiradas;
