const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const pool = require("../db");

// GET /api/usuarios/me — Perfil del usuario autenticado
router.get("/me", auth, async (req, res) => {
  try {
    const { uid } = req.user; // viene desde el middleware auth() que valida Firebase

    const { rows } = await pool.query(
      `
      SELECT 
        u.id,
        u.uid_firebase,
        u.nombre,
        u.email,
        u.telefono,
        u.rol,
        u.activo,
        u.creado_en,
        u.centro_id,
        c.nombre       AS centro_nombre,
        c.direccion    AS centro_direccion,
        c.comuna       AS centro_comuna,
        c.region       AS centro_region,
        c.telefono     AS centro_telefono,
        c.email        AS centro_email
      FROM usuario u
      LEFT JOIN centro_sangre c ON c.id = u.centro_id
      WHERE u.uid_firebase = $1
      `,
      [uid]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    res.json(rows[0]);
  } catch (e) {
    console.error("GET /api/usuarios/me", e);
    res.status(500).json({ error: "Error interno" });
  }
});

// PUT /api/usuarios/me — Actualiza datos básicos del usuario
router.put("/me", auth, async (req, res) => {
  try {
    const { uid } = req.user;
    const { nombre, telefono, centro_id } = req.body || {};

    // Traer id por uid
    const find = await pool.query(
      `SELECT id FROM usuario WHERE uid_firebase = $1`,
      [uid]
    );
    if (!find.rows.length) return res.status(404).json({ error: "Usuario no encontrado" });

    const { rows } = await pool.query(
      `
      UPDATE usuario
      SET 
        nombre   = COALESCE($1, nombre),
        telefono = COALESCE($2, telefono),
        centro_id= COALESCE($3, centro_id)
      WHERE uid_firebase = $4
      RETURNING id, uid_firebase, nombre, email, telefono, rol, activo, creado_en, centro_id
      `,
      [nombre, telefono, centro_id, uid]
    );

    // opcional: devolver también datos del centro
    const perfil = rows[0];
    const center = await pool.query(
      `SELECT nombre AS centro_nombre, direccion AS centro_direccion, comuna AS centro_comuna,
              region AS centro_region, telefono AS centro_telefono, email AS centro_email
       FROM centro_sangre WHERE id = $1`,
      [perfil.centro_id]
    );
    res.json({ ...perfil, ...(center.rows[0] || {}) });
  } catch (e) {
    console.error("PUT /api/usuarios/me", e);
    res.status(500).json({ error: "Error interno" });
  }
});


module.exports = router;
