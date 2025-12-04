const pool = require("../db");

module.exports = async function watchdogTransferencias() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // creadas hace >48h (no enviadas)
    const { rows: expiradasCreadas } = await client.query(`
      SELECT id FROM transferencia
      WHERE estado = 'creada'
        AND fecha_creada < NOW() - INTERVAL '48 hours'
    `);

    for (const { id } of expiradasCreadas) {
        // revertir unidades a 'asignada' en su oferta original
        await client.query(`
            UPDATE unidad SET estado = 'asignada'
            WHERE id IN (
            SELECT ti.unidad_id
            FROM transferencia_item ti
            WHERE ti.transferencia_id = $1
            )
        `, [id]);

        // cancelar transferencia
        await client.query(`UPDATE transferencia SET estado = 'cancelada' WHERE id = $1`, [id]);
        // Reabrir la oferta si tras la cancelación quedaron unidades 'asignada' vinculadas
        await client.query(`
        UPDATE oferta o
        SET estado = 'abierta'
        WHERE o.id = (
            SELECT t.oferta_id FROM transferencia t WHERE t.id = $1
        )
        AND EXISTS (
            SELECT 1
            FROM oferta_item oi
            JOIN unidad u ON u.id = oi.unidad_id
            WHERE oi.oferta_id = (
            SELECT t2.oferta_id FROM transferencia t2 WHERE t2.id = $1
            )
            AND u.estado = 'asignada'
        )
        `, [id]);
    }

    // en_transito hace >7 días
    const { rows: expiradasTransito } = await client.query(`
      SELECT id, centro_origen_id FROM transferencia
      WHERE estado = 'en_transito'
        AND fecha_creada < NOW() - INTERVAL '7 days'
    `);

    for (const { id, centro_origen_id } of expiradasTransito) {
        // devolver unidades al centro origen, estado 'asignada'
        await client.query(`
            UPDATE unidad
            SET estado = 'asignada', centro_actual_id = $2
            WHERE id IN (
            SELECT ti.unidad_id FROM transferencia_item ti
            WHERE ti.transferencia_id = $1
            )
        `, [id, centro_origen_id]);

        await client.query(`UPDATE transferencia SET estado = 'cancelada' WHERE id = $1`, [id]);
        // Reabrir la oferta si tras la cancelación quedaron unidades 'asignada' vinculadas
        await client.query(`
        UPDATE oferta o
        SET estado = 'abierta'
        WHERE o.id = (
            SELECT t.oferta_id FROM transferencia t WHERE t.id = $1
        )
        AND EXISTS (
            SELECT 1
            FROM oferta_item oi
            JOIN unidad u ON u.id = oi.unidad_id
            WHERE oi.oferta_id = (
            SELECT t2.oferta_id FROM transferencia t2 WHERE t2.id = $1
            )
            AND u.estado = 'asignada'
        )
        `, [id]);
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(()=>{});
    console.error("watchdogTransferencias error:", e);
  } finally {
    client.release();
  }
};
