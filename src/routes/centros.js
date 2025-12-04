const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const requireRole = require("../middlewares/requireRole");
const pool = require("../db");
const audit = require("../lib/audit");

// Crear centro
router.post("/", auth, requireRole("admin"), async (req, res) => {
  try {
    const {
      nombre,
      direccion,
      comuna,
      region,
      latitud,
      longitud,
      telefono,
      email,
    } = req.body;
    if (!nombre)
      return res.status(400).json({ error: "nombre es obligatorio" });

    const { rows } = await pool.query(
      `
      INSERT INTO centro_sangre
        (id, nombre, direccion, comuna, region,
         latitud, longitud, telefono, email, activo)
      VALUES (uuid_generate_v4(), $1,$2,$3,$4,$5,$6,$7,$8, TRUE)
      RETURNING id, nombre, region, comuna
    `,
      [
        nombre,
        direccion || null,
        comuna || null,
        region || null,
        latitud || null,
        longitud || null,
        telefono || null,
        email || null,
      ]
    );

    const centro = rows[0];

    // auditoría
    await audit({
      req,
      entidad: "centro_sangre",
      entidad_id: centro.id,
      accion: "CREAR",
      detalles: {
        nombre,
        comuna,
        region,
        telefono,
        email,
      },
    });

    res.status(201).json({ ok: true, centro });
  } catch (e) {
    console.error("POST /api/centros", e);
    res.status(500).json({ error: "No se pudo crear el centro" });
  }
});

// Listar centros
router.get("/", auth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT id, nombre, region, comuna, activo
      FROM centro_sangre
      ORDER BY nombre
    `
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /api/centros", e);
    res.status(500).json({ error: "Error interno" });
  }
});

module.exports = router;
