const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const APP_SECRET = process.env.APP_SECRET;

// Validate required environment variables
if (!VERIFY_TOKEN || !APP_SECRET) {
  console.error('❌ CRITICAL: Missing required environment variables (VERIFY_TOKEN, APP_SECRET)');
  process.exit(1);
}

// Security middleware
// Limit request body size to prevent DoS attacks
app.use(express.json({ limit: '1mb' }));

// Store raw body for signature verification
app.use((req, res, next) => {
  let data = '';
  req.on('data', (chunk) => {
    data += chunk;
  });
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
});

// Rate limiting to prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

app.use(limiter);

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

/**
 * GET webhook verification endpoint
 * Facebook sends a GET request to verify the webhook URL
 */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Validate all parameters are present
  if (!mode || !token || !challenge) {
    console.warn('⚠️  Webhook verification failed - missing parameters');
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  // Verify the token matches using constant-time comparison
  if (mode === 'subscribe' && constantTimeCompare(token, VERIFY_TOKEN)) {
    console.log('✅ Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  // Token mismatch - don't reveal which parameter failed
  console.warn('⚠️  Webhook verification attempted with invalid token');
  return res.status(403).json({ error: 'Forbidden' });
});

/**
 * POST webhook endpoint
 * Receives messages and events from Facebook Messenger
 */
app.post('/webhook', (req, res) => {
  const body = req.body;

  // Verify request signature immediately
  if (!verifyRequestSignature(req)) {
    console.error('❌ Request signature verification failed');
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Validate object type
  if (body.object !== 'page') {
    console.warn(`⚠️  Invalid webhook object type: ${body.object}`);
    return res.status(400).json({ error: 'Invalid object type' });
  }

  // Validate entry array exists
  if (!Array.isArray(body.entry)) {
    console.warn('⚠️  Invalid entry format in webhook');
    return res.status(400).json({ error: 'Invalid entry format' });
  }

  // Handle webhook events asynchronously
  setImmediate(() => {
    body.entry.forEach((entry) => {
      if (!entry.id || !Array.isArray(entry.messaging)) {
        console.warn('⚠️  Invalid entry structure');
        return;
      }

      // Iterate over each messaging event
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
          console.error('❌ Error processing messagingEvent:', err.message);
        }
      });
    });
  });

  // Return immediately to avoid timeout
  res.status(200).json({ status: 'ok' });
});

/**
 * Constant-time comparison to prevent timing attacks
 * @param {String} a - First string
 * @param {String} b - Second string
 * @returns {Boolean} - True if strings match
 */
function constantTimeCompare(a, b) {
  if (!a || !b) return false;
  
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * Verify the request signature from Facebook
 * Uses SHA256 for better security than SHA1
 * @param {Object} req - Express request object
 * @returns {Boolean} - True if signature is valid
 */
function verifyRequestSignature(req) {
  const signature = req.get('x-hub-signature-256');

  if (!signature) {
    console.warn('⚠️  Request signature missing');
    return false;
  }

  const elements = signature.split('=');
  
  if (elements.length !== 2) {
    console.warn('⚠️  Invalid signature format');
    return false;
  }

  const [algorithm, signatureHash] = elements;

  if (algorithm !== 'sha256') {
    console.warn(`⚠️  Unexpected signature algorithm: ${algorithm}`);
    return false;
  }

  const body = req.rawBody || JSON.stringify(req.body);
  
  try {
    const hash = crypto
      .createHmac('sha256', APP_SECRET)
      .update(body)
      .digest('hex');

    return constantTimeCompare(hash, signatureHash);
  } catch (err) {
    console.error('❌ Error verifying signature:', err.message);
    return false;
  }
}

/**
 * Sanitize input to prevent injection attacks
 * @param {String} input - Input string
 * @returns {String} - Sanitized string
 */
function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[<>]/g, '') // Remove angle brackets
    .substring(0, 1000); // Limit length to 1000 chars
}

/**
 * Handle incoming messages
 * @param {Object} event - Messaging event from Facebook
 */
function handleMessage(event) {
  try {
    const senderID = event.sender?.id;
    const recipientID = event.recipient?.id;
    const timeOfMessage = event.timestamp;
    const message = event.message;

    // Validate required fields
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
    console.error('❌ Error handling message:', err.message);
  }
}

/**
 * Handle postback from interactive messages
 * @param {Object} event - Postback event from Facebook
 */
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
    console.error('❌ Error handling postback:', err.message);
  }
}

/**
 * Handle delivery confirmation
 * @param {Object} event - Delivery event from Facebook
 */
function handleDelivery(event) {
  try {
    const senderID = event.sender?.id;

    if (!senderID) {
      console.warn('⚠️  Delivery confirmation missing sender ID');
      return;
    }

    console.log(`✉️  Delivery confirmation from user ${senderID}`);
  } catch (err) {
    console.error('❌ Error handling delivery:', err.message);
  }
}

/**
 * Handle read receipt
 * @param {Object} event - Read event from Facebook
 */
function handleRead(event) {
  try {
    const senderID = event.sender?.id;

    if (!senderID) {
      console.warn('⚠️  Read receipt missing sender ID');
      return;
    }

    console.log(`👁️  Read receipt from user ${senderID}`);
  } catch (err) {
    console.error('❌ Error handling read receipt:', err.message);
  }
}

/**
 * Send a text message to the user
 * @param {String} recipientID - User's Facebook ID
 * @param {String} messageText - Text to send
 */
function sendTextMessage(recipientID, messageText) {
  if (!recipientID || !messageText) {
    console.warn('⚠️  Invalid message parameters');
    return;
  }

  const messageData = {
    recipient: {
      id: recipientID,
    },
    message: {
      text: sanitizeInput(messageText),
    },
  };

  callSendAPI(messageData);
}

/**
 * Call the Send API with error handling
 * @param {Object} messageData - Message data to send
 */
function callSendAPI(messageData) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('❌ PAGE_ACCESS_TOKEN is not configured');
    return;
  }

  // Use query parameter for token instead of URL parameter
  const url = 'https://graph.facebook.com/v18.0/me/messages';

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${PAGE_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(messageData),
  })
    .then((res) => {
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      return res.json();
    })
    .then((data) => {
      if (data.message_id) {
        console.log(`✅ Message sent with ID: ${data.message_id}`);
      } else if (data.error) {
        console.error(`❌ API Error: ${data.error.message}`);
      }
    })
    .catch((err) => {
      console.error('❌ Error calling Send API:', err.message);
    });
}

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Facebook Messenger Webhook Server is running' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`\n🚀 Server is running on http://localhost:${PORT}`);
  console.log(`📍 Webhook endpoint: http://localhost:${PORT}/webhook\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
