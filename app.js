require('dotenv').config();
const express = require('express');
const cors = require('cors');
const eventsRouter   = require('./routes/events');
const paymentsRouter = require('./routes/payments');

const app = express();
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
}));
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/payment') return next();
  express.json()(req, res, next);
});

app.use((req, res, next) => {
  const start = Date.now();
  if (req.method === 'POST' || req.method === 'PATCH') {
    console.log(`→ ${req.method} ${req.originalUrl} body:`, JSON.stringify(req.body));
  }
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`← ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use(eventsRouter);
app.use(paymentsRouter);

module.exports = app;
