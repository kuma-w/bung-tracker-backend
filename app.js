require('dotenv').config();
const express = require('express');
const cors = require('cors');
const eventsRouter   = require('./routes/events');
const paymentsRouter = require('./routes/payments');

const app = express();
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
}));
app.use(express.json());
app.use(eventsRouter);
app.use(paymentsRouter);

module.exports = app;
