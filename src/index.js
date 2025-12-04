require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const uniExpiradas = require("./utils/uniExpiradas");
const cron = require("node-cron");
const watchdogTransferencias = require("./utils/watchdogTransferencias");
const { caducarSolicitudesAntiguas } = require("./utils/solExpiradas");

// Cron jobs
caducarSolicitudesAntiguas();
setInterval(caducarSolicitudesAntiguas, 24 * 60 * 60 * 1000);

watchdogTransferencias();
cron.schedule("0 */3 * * *", () => watchdogTransferencias().catch(console.error));

uniExpiradas();
setInterval(uniExpiradas, 24 * 60 * 60 * 1000);

const app = express();

// ✅ Aquí agregamos el CORS configurado correctamente:
app.use(cors({
  origin: [
    "http://localhost:5173",              // para desarrollo local
    "https://ats-backend-yvfd.onrender.com",    // para producción
  ],
  credentials: true,
}));

app.use(express.json());
app.use(morgan("dev"));

// Healthcheck
app.get("/api/health", (_, res) => res.send("OK"));

// Rutas
app.use("/api/usuarios", require("./routes/usuarios"));
app.use("/api/admin/usuarios", require("./routes/adminUsers"));
app.use("/api/centros", require("./routes/centros"));
app.use("/api/unidades", require("./routes/unidades"));
app.use("/api/ofertas", require("./routes/ofertas"));
app.use("/api/solicitudes", require("./routes/solicitudes"));
app.use("/api/transferencias", require("./routes/transferencias"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
