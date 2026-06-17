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
const operatorToolsRoutes = require('./routes/operatorTools');
const usersRoutes = require('./routes/users');
const funnelRoutes = require('./routes/funnel');
const pipelineRoutes = require('./routes/pipeline');
const tasksRoutes = require('./routes/tasks');
const notificationsRoutes = require('./routes/notifications');
const savedViewsRoutes = require('./routes/savedViews');
const healthRoutes = require('./routes/health');
const suggestionsRoutes = require('./routes/suggestions');
const supervisorRoutes = require('./routes/supervisor');
const supervisorControlRoutes = require('./routes/supervisorControl');
const leadDistRoutes = require('./routes/leadDist');
const retentionRoutes = require('./routes/retention');
const b2bRoutes = require('./routes/b2b');
const customerIssuesRoutes = require('./routes/customerIssues');

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

// Static admin pages (login, WAHA session management)
const path = require('path');
app.use('/admin', express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true }));
app.get('/admin', (_req, res) => res.redirect('/admin/waha-sessions.html'));

// Operator-uploaded files (sent to customers via WAHA). Public read so WAHA
// can fetch by URL — filenames are random nonces (8-byte hex) so listing is
// effectively impossible without knowing the URL.
const { UPLOAD_ROOT } = require('./services/uploadService');
app.use('/uploads', express.static(UPLOAD_ROOT, { etag: true, lastModified: true, maxAge: '7d' }));

app.use('/api/auth', authRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/api/inbox/conversations/:id/suggestions', suggestionsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/waha', wahaAdminRoutes);
app.use('/api/ops', operatorToolsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/funnel', funnelRoutes);
app.use('/api/pipeline', pipelineRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/users/me/notifications', notificationsRoutes);
app.use('/api/saved-views', savedViewsRoutes);
app.use('/api/supervisor', supervisorRoutes);
app.use('/api/supervisor-control', supervisorControlRoutes);
app.use('/api/lead-dist', leadDistRoutes);
app.use('/api/retention', retentionRoutes);
app.use('/api/b2b', b2bRoutes);
app.use('/api/customer-issues', customerIssuesRoutes);
app.use('/api/tax-requests', require('./routes/taxRequests'));
app.use('/api/lotus-inbox', require('./routes/lotusInbox'));
app.use('/webhook', webhookRoutes);
app.use('/webhook/vonage', require('./routes/vonageWebhook'));
app.use(healthRoutes);

app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, 'unhandled');
  res.status(err.status || 500).json({ success: false, message: err.message || 'Internal server error' });
});

attachSocket(io);

async function hydrateGlobalToggle() {
  try {
    const settingsSvc = require('./services/settings');
    const stored = await settingsSvc.getSetting('ai_global_enabled', null);
    if (stored != null) {
      process.env.AI_GLOBAL_ENABLED = stored ? 'true' : 'false';
      logger.info({ ai_global_enabled: stored }, 'hydrated AI global toggle from DB');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'failed to hydrate AI global toggle (using env default)');
  }
}

function startBackgroundJobs() {
  if (process.env.DISABLE_WORKER === 'true') {
    logger.info('worker disabled (DISABLE_WORKER=true)');
    return;
  }
  hydrateGlobalToggle().finally(() => {
    aiAgent.startWorker().catch((err) => logger.error({ err: err.message }, 'worker crashed'));
  });
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
