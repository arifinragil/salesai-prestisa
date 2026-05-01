const { requireStaff } = require('./auth');

function requireAdmin(req, res, next) {
  requireStaff(req, res, (err) => {
    if (err) return next(err);
    if (req.staff?.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin role required' });
    }
    next();
  });
}

module.exports = { requireAdmin };
