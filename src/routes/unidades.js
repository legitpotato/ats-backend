const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const pool = require("../db");
const audit = require("../lib/audit");

// helper: normaliza booleanos desde checkbox HTML / strings
function toBool(v) {
  if (v === true || v === false) return v;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return (
    s === "true" ||
    s === "1" ||
    s === "on" ||
    s === "sí" ||
    s === "si" ||
    s === "y" ||
    s === "yes"
  );
}

// genera códigos únicos tipo CS-202511051230-1234
function generarCodigoSeguimiento() {
  const fecha = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 12);
  const aleatorio = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `CS-${fecha}-${aleatorio}`;
}

// POST /api/unidades. Crear unidad (inventario del centro del usuario), registra creada_por_id y devuelve creado_en.
router.post("/", auth, async (req, res) => {
  try {
    const { centro_id, id: usuario_id } = req.user;
    if (!centro_id) {
      return res.status(400).json({ error: "Usuario sin centro" });
    }

    const {
      tipo_componente,
      grupo,
      rh,
      fecha_extraccion,
      fecha_vencimiento,
      filtrado,
      irradiado,
    } = req.body;

    if (
      !tipo_componente ||
      !grupo ||
      !rh ||
      !fecha_extraccion ||
      !fecha_vencimiento
    ) {
      return res.status(400).json({ error: "Campos obligatorios faltantes" });
    }

    const filtradoBool = toBool(filtrado);
    const irradiadoBool = toBool(irradiado);
    const codigo = generarCodigoSeguimiento();

    const { rows } = await pool.query(
      `
      INSERT INTO unidad
        (id, tipo_componente, grupo, rh, fecha_extraccion, fecha_vencimiento,
         codigo_seguimiento, estado, centro_actual_id, filtrado, irradiado,
         creada_por_id)
      VALUES (uuid_generate_v4(), $1,$2,$3,$4,$5,$6,'disponible',$7,$8,$9,$10)
      RETURNING id, tipo_componente, grupo, rh, fecha_vencimiento, estado,
                codigo_seguimiento, filtrado, irradiado, creada_por_id, creado_en
      `,
      [
        tipo_componente,
        grupo,
        rh,
        fecha_extraccion,
        fecha_vencimiento,
        codigo,
        centro_id,
        filtradoBool,
        irradiadoBool,
        usuario_id,
      ]
    );

    const nueva = rows[0];

    // Auditoría
    await audit({
      req,
      entidad: "unidad",
      entidad_id: nueva.id,
      accion: "CREAR",
      detalles: {
        tipo_componente,
        grupo,
        rh,
        fecha_extraccion,
        fecha_vencimiento,
        filtrado: filtradoBool,
        irradiado: irradiadoBool,
        codigo_seguimiento: codigo,
      },
    });

    res.status(201).json({ ok: true, unidad: nueva });
  } catch (e) {
    console.error("POST /api/unidades", e);
    res.status(500).json({ error: "No se pudo crear la unidad" });
  }
});


//GET /api/unidades
//Listar unidades de mi centro con filtros básicos, oculta las que estén en una oferta abierta
router.get("/", auth, async (req, res) => {
  try {
    const { centro_id } = req.user;
    if (!centro_id) {
      return res.status(400).json({ error: "Usuario sin centro" });
    }

    const { tipo, grupo, rh, estado, filtrado, irradiado } = req.query;
    const params = [centro_id];
    const where = ["u.centro_actual_id = $1"];

    if (tipo) {
      params.push(tipo);
      where.push(`u.tipo_componente = $${params.length}`);
    }
    if (grupo) {
      params.push(grupo);
      where.push(`u.grupo = $${params.length}`);
    }
    if (rh) {
      params.push(rh);
      where.push(`u.rh = $${params.length}`);
    }
    if (estado) {
      params.push(estado);
      where.push(`u.estado = $${params.length}`);
    }
    if (filtrado !== undefined) {
      params.push(toBool(filtrado));
      where.push(`u.filtrado = $${params.length}`);
    }
    if (irradiado !== undefined) {
      params.push(toBool(irradiado));
      where.push(`u.irradiado = $${params.length}`);
    }

    const { rows } = await pool.query(
      `
      SELECT
        u.id,
        u.tipo_componente,
        u.grupo,
        u.rh,
        u.fecha_vencimiento,
        u.estado,
        u.codigo_seguimiento,
        u.filtrado,
        u.irradiado,
        u.creado_en
      FROM unidad u
      WHERE ${where.join(" AND ")}
        -- no mostrar unidades que están en una oferta abierta
        AND NOT EXISTS (
          SELECT 1
          FROM oferta_item oi
          JOIN oferta o ON o.id = oi.oferta_id
          WHERE oi.unidad_id = u.id
            AND o.estado = 'abierta'
        )
      ORDER BY u.fecha_vencimiento ASC, u.creado_en DESC
      LIMIT 200
      `,
      params
    );

    res.json(rows);
  } catch (e) {
    console.error("GET /api/unidades", e);
    res.status(500).json({ error: "Error interno" });
  }
});


// GET /api/unidades/:id
// Detalle de una unidad de mi centro
router.get("/:id", auth, async (req, res) => {
  try {
    const { centro_id } = req.user;
    const { id } = req.params;

    const { rows } = await pool.query(
      `
      SELECT
        u.id,
        u.tipo_componente,
        u.grupo,
        u.rh,
        u.fecha_extraccion,
        u.fecha_vencimiento,
        u.estado,
        u.codigo_seguimiento,
        u.filtrado,
        u.irradiado,
        u.creado_en,
        u.creada_por_id,
        up.nombre AS creada_por_nombre,
        up.email  AS creada_por_email
      FROM unidad u
      LEFT JOIN usuario up ON up.id = u.creada_por_id
      WHERE u.id = $1
        AND u.centro_actual_id = $2
      `,
      [id, centro_id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Unidad no encontrada" });
    }

    res.json(rows[0]);
  } catch (e) {
    console.error("GET /api/unidades/:id", e);
    res.status(500).json({ error: "Error interno" });
  }
});

module.exports = router;
