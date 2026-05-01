require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const logger = require('./services/logger');
const notify = require('./services/notify');
const attachSocket = require('./socket');

const authRoutes = require('./routes/auth');
const webhookRoutes = require('./routes/webhook');
const inboxRoutes = require('./routes/inbox');
const adminRoutes = require('./routes/admin');
const wahaAdminRoutes = require('./routes/wahaAdmin');
const healthRoutes = require('./routes/health');

const aiAgent = require('./services/aiAgent');

const app = express();
const server = http.createServer(app);

const corsOrigin = process.env.CRM_FRONTEND_ORIGIN || 'https://salesai.prestisa.net';
const io = new Server(server, { cors: { origin: corsOrigin, credentials: true } });

app.set('trust proxy', 1);
app.set('io', io);
notify.setIO(io);

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/waha', wahaAdminRoutes);
app.use('/webhook', webhookRoutes);
app.use(healthRoutes);

app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, 'unhandled');
  res.status(err.status || 500).json({ success: false, message: err.message || 'Internal server error' });
});

attachSocket(io);

function startBackgroundJobs() {
  if (process.env.DISABLE_WORKER === 'true') {
    logger.info('worker disabled (DISABLE_WORKER=true)');
    return;
  }
  aiAgent.startWorker().catch((err) => logger.error({ err: err.message }, 'worker crashed'));
  setInterval(() => {
    aiAgent.reapStaleLocks().catch((err) => logger.warn({ err: err.message }, 'reapStaleLocks failed'));
  }, 60_000);
}

if (require.main === module) {
  const port = parseInt(process.env.CRM_BACKEND_PORT) || 3009;
  server.listen(port, () => {
    logger.info({ port, provider: process.env.WA_PROVIDER || 'waha' }, 'crm-pilot-backend listening');
    startBackgroundJobs();
  });

  const shutdown = (sig) => {
    logger.info({ sig }, 'shutting down');
    aiAgent.stopWorker();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { app, server, io };
