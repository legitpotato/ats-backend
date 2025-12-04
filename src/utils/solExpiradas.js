const pool = require("../db");
const audit = require("../lib/audit");

async function caducarSolicitudesAntiguas() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      UPDATE solicitud
      SET estado = 'cancelada'
      WHERE estado = 'pendiente'
        AND creada_en < now() - interval '7 days'
      RETURNING id, centro_solicitante_id, tipo_componente, grupo, rh, cantidad
      `
    );

    for (const sol of rows) {
      await audit({
        req: null, // si tu helper lo permite
        entidad: "solicitud",
        entidad_id: sol.id,
        accion: "AUTO_CANCELACION_POR_EXPIRACION",
        detalles: {
          motivo: "Más de 7 días pendiente",
          ...sol,
        },
      });
    }

    await client.query("COMMIT");
    console.log(`Solicitudes auto-canceladas por expiración: ${rows.length}`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Error caducarSolicitudesAntiguas", e);
  } finally {
    client.release();
  }
}

module.exports = { caducarSolicitudesAntiguas };
