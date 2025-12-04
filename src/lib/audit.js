const pool = require("../db");

async function audit({ req, entidad, entidad_id, accion, detalles = {} }) {
  try {
    await pool.query(
      `INSERT INTO auditoria (usuario_id, entidad, entidad_id, accion, detalles)
       VALUES ($1,$2,$3,$4,$5)`,
      [req?.user?.user_id || null, entidad, entidad_id || null, accion, detalles]
    );
  } catch (e) {
    console.error("audit error:", e);
  }
}
module.exports = audit;
