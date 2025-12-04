require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const uniExpiradas = require("./utils/uniExpiradas");
const cron = require("node-cron");
const watchdogTransferencias = require("./utils/watchdogTransferencias");
const { caducarSolicitudesAntiguas } = require("./utils/solExpiradas");

// CRON JOBS
caducarSolicitudesAntiguas();
setInterval(caducarSolicitudesAntiguas, 24 * 60 * 60 * 1000);

watchdogTransferencias();
cron.schedule("0 */3 * * *", () => watchdogTransferencias().catch(console.error));

uniExpiradas();
setInterval(uniExpiradas, 24 * 60 * 60 * 1000);

const app = express();

// CORS — actualizado para tus dominios reales
const allowedOrigins = [
  "http://localhost:5173",
  "https://ats-tawny.vercel.app",
  "https://ats-legitpotatos-projects.vercel.app",
  "https://ats-git-main-legitpotatos-projects.vercel.app",
  "https://ats-ixthsy77o-legitpotatos-projects.vercel.app",
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // Permite Postman / curl / SSR
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS bloqueado para origen: ${origin}`));
  },
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
