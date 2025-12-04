const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const requireRole = require("../middlewares/requireRole");
const pool = require("../db");
const admin = require("../lib/firebaseAdmin");
const audit = require("../lib/audit");

router.post("/", auth, requireRole("admin"), async (req, res) => {
  const client = await pool.connect();
  let fbUser = null;
  try {
    const { email, password, nombre, rol, centro_id } = req.body;

    if (!email || !password || !nombre || !rol) {
      return res.status(400).json({ error: "Faltan campos obligatorios" });
    }
    if (!["admin", "coordinador", "personal"].includes(rol)) {
      return res.status(400).json({ error: "Rol inválido" });
    }
    if ((rol === "coordinador" || rol === "personal") && !centro_id) {
      return res
        .status(400)
        .json({ error: "centro_id es obligatorio para este rol" });
    }

    // 1) Firebase
    fbUser = await admin.auth().createUser({
      email,
      password,
      displayName: nombre,
      disabled: false,
    });

    await admin.auth().setCustomUserClaims(fbUser.uid, {
      rol,
      centro_id: centro_id || null,
    });

    // 2) DB
    await client.query("BEGIN");
    const { rows } = await client.query(
      `
      INSERT INTO usuario
        (id, uid_firebase, email, nombre, rol, centro_id, activo)
      VALUES (uuid_generate_v4(), $1,$2,$3,$4,$5, TRUE)
      RETURNING id, email, nombre, rol, centro_id
    `,
      [fbUser.uid, email, nombre, rol, centro_id || null]
    );
    await client.query("COMMIT");

    const creado = rows[0];

    // auditoría
    await audit({
      req,
      entidad: "usuario",
      entidad_id: creado.id,
      accion: "CREAR",
      detalles: {
        email,
        nombre,
        rol,
        centro_id: centro_id || null,
        firebase_uid: fbUser.uid,
      },
    });

    res.status(201).json({ ok: true, usuario: creado });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    try {
      if (fbUser?.uid) await admin.auth().deleteUser(fbUser.uid);
    } catch {}
    console.error("POST /api/admin/usuarios:", e);
    res.status(500).json({ error: "No se pudo crear el usuario" });
  } finally {
    client.release();
  }
});

module.exports = router;
