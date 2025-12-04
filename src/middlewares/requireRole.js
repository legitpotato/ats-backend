module.exports = (...rolesPermitidos) => (req, res, next) => {
  const rol = req.user?.rol;
  if (!rol || !rolesPermitidos.includes(rol)) {
    return res.status(403).json({ error: "FORBIDDEN" });
  }
  next();
};
