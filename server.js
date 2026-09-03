// https://github.com/AR700169/facebook-messenger-webhook/blob/main/server.js
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

// Optional: If you're running Node < 18 install node-fetch:
// npm install node-fetch
// const fetch = require('node-fetch');
const fetch = global.fetch || require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const APP_SECRET = process.env.APP_SECRET;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Minimal env validation
if (!VERIFY_TOKEN || !APP_SECRET) {
  console.error('❌ CRITICAL: Missing required environment variables (VERIFY_TOKEN, APP_SECRET)');
  process.exit(1);
}

const CAN_SEND = Boolean(PAGE_ACCESS_TOKEN);
if (!CAN_SEND) {
  console.warn('⚠️  PAGE_ACCESS_TOKEN is not configured — send functionality disabled');
}

// Security: trust proxy if behind one so rate limiter and IP detection works
if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Use helmet for common security headers
app.use(helmet({
  // Customize if needed
}));

// Limit request body size and capture raw body for signature verification
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    // Save raw body for signature verification (exact bytes)
    req.rawBody = buf;
  }
}));

// Rate limiting to prevent abuse (apply after body parsing to allow health checks through)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Health & readiness endpoints
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/ready', (req, res) => res.status(200).json({ status: 'ready' }));

/**
 * GET webhook verification endpoint
 */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (!mode || !token || !challenge) {
    console.warn('⚠️  Webhook verification failed - missing parameters');
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  if (mode === 'subscribe' && constantTimeCompare(token, VERIFY_TOKEN)) {
    console.log('✅ Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  console.warn('⚠️  Webhook verification attempted with invalid token');
  return res.status(403).json({ error: 'Forbidden' });
});

/**
 * POST webhook endpoint
 */
app.post('/webhook', (req, res) => {
  // Verify request signature immediately using rawBody captured by express.json verify
  if (!verifyRequestSignature(req)) {
    console.error('❌ Request signature verification failed');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const body = req.body;

  if (body.object !== 'page') {
    console.warn(`⚠️  Invalid webhook object type: ${body.object}`);
    return res.status(400).json({ error: 'Invalid object type' });
  }

  if (!Array.isArray(body.entry)) {
    console.warn('⚠️  Invalid entry format in webhook');
    return res.status(400).json({ error: 'Invalid entry format' });
  }

  // Process asynchronously so we can return 200 quickly
  setImmediate(() => {
    body.entry.forEach((entry) => {
      if (!entry.id || !Array.isArray(entry.messaging)) {
        console.warn('⚠️  Invalid entry structure');
        return;
      }

      entry.messaging.forEach((messagingEvent) => {
        try {
          if (messagingEvent.message) {
            handleMessage(messagingEvent);
          } else if (messagingEvent.postback) {
            handlePostback(messagingEvent);
          } else if (messagingEvent.delivery) {
            handleDelivery(messagingEvent);
          } else if (messagingEvent.read) {
            handleRead(messagingEvent);
          }
        } catch (err) {
          console.error('❌ Error processing messagingEvent:', err && err.stack ? err.stack : err);
        }
      });
    });
  });

  // Return immediately
  res.status(200).json({ status: 'ok' });
});

/**
 * constant-time comparison
 */
function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify the request signature from Facebook using x-hub-signature-256
 */
function verifyRequestSignature(req) {
  const signatureHeader = req.get('x-hub-signature-256');
  if (!signatureHeader) {
    console.warn('⚠️  Request signature missing');
    return false;
  }

  const elements = signatureHeader.split('=');
  if (elements.length !== 2) {
    console.warn('⚠️  Invalid signature format');
    return false;
  }

  const [algorithm, signatureHash] = elements;
  if (algorithm !== 'sha256') {
    console.warn(`⚠️  Unexpected signature algorithm: ${algorithm}`);
    return false;
  }

  try {
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const hmac = crypto.createHmac('sha256', APP_SECRET);
    hmac.update(raw);
    const expected = hmac.digest('hex');
    return constantTimeCompare(expected, signatureHash);
  } catch (err) {
    console.error('❌ Error verifying signature:', err && err.stack ? err.stack : err);
    return false;
  }
}

/**
 * sanitize input
 */
function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/[<>]/g, '').substring(0, 1000);
}

/**
 * Handlers
 */
function handleMessage(event) {
  try {
    const senderID = event.sender?.id;
    const recipientID = event.recipient?.id;
    const message = event.message;

    if (!senderID || !recipientID) {
      console.warn('⚠️  Message missing sender or recipient ID');
      return;
    }

    console.log(`📨 Message received from user ${senderID}`);

    if (message.text) {
      const text = sanitizeInput(message.text);
      console.log(`   Text: ${text.substring(0, 100)}...`);
      sendTextMessage(senderID, `Echo: ${text}`);
    } else if (message.attachments && Array.isArray(message.attachments)) {
      console.log(`   Attachments: ${message.attachments.length} file(s)`);
      sendTextMessage(senderID, 'Thanks for sending an attachment!');
    }
  } catch (err) {
    console.error('❌ Error handling message:', err && err.stack ? err.stack : err);
  }
}

function handlePostback(event) {
  try {
    const senderID = event.sender?.id;
    const payload = event.postback?.payload;

    if (!senderID || !payload) {
      console.warn('⚠️  Postback missing required fields');
      return;
    }

    const sanitizedPayload = sanitizeInput(payload);
    console.log(`📤 Postback received from user ${senderID}`);
    sendTextMessage(senderID, `Postback: ${sanitizedPayload}`);
  } catch (err) {
    console.error('❌ Error handling postback:', err && err.stack ? err.stack : err);
  }
}

function handleDelivery(event) {
  try {
    const senderID = event.sender?.id;
    if (!senderID) {
      console.warn('⚠️  Delivery confirmation missing sender ID');
      return;
    }
    console.log(`✉️  Delivery confirmation from user ${senderID}`);
  } catch (err) {
    console.error('❌ Error handling delivery:', err && err.stack ? err.stack : err);
  }
}

function handleRead(event) {
  try {
    const senderID = event.sender?.id;
    if (!senderID) {
      console.warn('⚠️  Read receipt missing sender ID');
      return;
    }
    console.log(`👁️  Read receipt from user ${senderID}`);
  } catch (err) {
    console.error('❌ Error handling read receipt:', err && err.stack ? err.stack : err);
  }
}

/**
 * Send a text message
 */
function sendTextMessage(recipientID, messageText) {
  if (!recipientID || !messageText) {
    console.warn('⚠️  Invalid message parameters');
    return;
  }

  const messageData = {
    recipient: { id: recipientID },
    message: { text: sanitizeInput(messageText) },
  };

  callSendAPI(messageData).catch(err => {
    console.error('❌ sendTextMessage failed:', err && err.stack ? err.stack : err);
  });
}

/**
 * Call the Send API with retries and improved error handling
 */
async function callSendAPI(messageData, attempts = 0) {
  if (!CAN_SEND) {
    console.error('❌ PAGE_ACCESS_TOKEN is not configured — cannot send messages');
    return;
  }

  const url = 'https://graph.facebook.com/v18.0/me/messages';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${PAGE_ACCESS_TOKEN}`,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(messageData),
    });

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      // Handle rate limiting & transient errors with exponential backoff
      const status = res.status;
      const errMsg = body && body.error ? body.error.message : `HTTP ${status}`;
      if ((status === 429 || status >= 500) && attempts < 3) {
        const wait = Math.pow(2, attempts) * 1000;
        console.warn(`⚠️ Send API returned ${status}. Retrying in ${wait}ms (attempt ${attempts + 1})`);
        await new Promise(r => setTimeout(r, wait));
        return callSendAPI(messageData, attempts + 1);
      }
      throw new Error(`Send API error: ${errMsg}`);
    }

    if (body && body.message_id) {
      console.log(`✅ Message sent with ID: ${body.message_id}`);
    } else if (body && body.error) {
      console.error(`❌ API Error: ${body.error.message}`);
    }
  } catch (err) {
    console.error('❌ Error calling Send API:', err && err.stack ? err.stack : err);
    if (attempts < 3) {
      const wait = Math.pow(2, attempts) * 1000;
      await new Promise(r => setTimeout(r, wait));
      return callSendAPI(messageData, attempts + 1);
    }
    throw err;
  }
}

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Not Found' }));

// Error handling middleware (last)
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err && err.stack ? err.stack : err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`\n🚀 Server is running on http://localhost:${PORT}`);
  console.log(`📍 Webhook endpoint: http://localhost:${PORT}/webhook\n`);
});

// Graceful shutdown and global error handling
function shutdown(code = 0) {
  console.log('Shutdown initiated');
  server.close(() => {
    console.log('Server closed');
    process.exit(code);
  });
  // Force exit after 10s
  setTimeout(() => {
    console.error('Forcing shutdown');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
  shutdown(1);
});
