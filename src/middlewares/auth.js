const admin = require("../lib/firebaseAdmin");
const pool = require("../db");

async function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token" });
  }

  try {
    const token = h.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);

    const { rows } = await pool.query(
      `SELECT id, rol, centro_id, nombre, email
       FROM usuario
       WHERE uid_firebase = $1`,
      [decoded.uid]
    );

    const row = rows[0] || {};
    req.user = {
      id: row?.id || null,
      uid: decoded.uid, 
      user_id: row?.id || null,
      email: row?.email || decoded.email || null,
      nombre: row?.nombre || null,
      rol: row?.rol || null,
      centro_id: row?.centro_id || null,
    };

    next();
  } catch (e) {
    console.error("verifyIdToken:", e);
    res.status(401).json({ error: "Invalid token" });
  }
}

module.exports = authMiddleware;