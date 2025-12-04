require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const uniExpiradas = require("./utils/uniExpiradas");
const cron = require("node-cron");
const watchdogTransferencias = require("./utils/watchdogTransferencias");
const { caducarSolicitudesAntiguas } = require("./utils/solExpiradas")


caducarSolicitudesAntiguas()
setInterval(caducarSolicitudesAntiguas, 24 * 60 * 60 * 1000);

watchdogTransferencias()
cron.schedule("0 */3 * * *", () => {  // cada 3 horas
  watchdogTransferencias().catch(console.error);
});

uniExpiradas();
setInterval(uniExpiradas, 24 * 60 * 60 * 1000);

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

app.get("/api/health", (_, res) => res.send("OK"));

app.use("/api/usuarios", require("./routes/usuarios"));
app.use("/api/admin/usuarios", require("./routes/adminUsers"));
app.use("/api/centros", require("./routes/centros"));
app.use("/api/unidades", require("./routes/unidades")); 
app.use("/api/ofertas", require("./routes/ofertas"));
app.use("/api/solicitudes", require("./routes/solicitudes"));
app.use("/api/transferencias", require("./routes/transferencias"));


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
