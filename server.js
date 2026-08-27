const express = require('express');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const APP_SECRET = process.env.APP_SECRET;

// Middleware
app.use(express.json());

/**
 * GET webhook verification endpoint
 * Facebook sends a GET request to verify the webhook URL
 */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Verify the token matches
  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      // Token mismatch
      console.error('❌ Webhook verification failed - invalid token');
      res.sendStatus(403);
    }
  } else {
    console.error('❌ Webhook verification failed - missing parameters');
    res.sendStatus(400);
  }
});

/**
 * POST webhook endpoint
 * Receives messages and events from Facebook Messenger
 */
app.post('/webhook', (req, res) => {
  const body = req.body;

  // Verify request signature
  if (!verifyRequestSignature(req)) {
    console.error('❌ Request signature verification failed');
    return res.sendStatus(403);
  }

  // Handle webhook events
  if (body.object === 'page') {
    body.entry.forEach((entry) => {
      const pageID = entry.id;
      const timeOfEvent = entry.time;

      // Iterate over each messaging event
      entry.messaging.forEach((messagingEvent) => {
        if (messagingEvent.message) {
          handleMessage(messagingEvent);
        } else if (messagingEvent.postback) {
          handlePostback(messagingEvent);
        } else if (messagingEvent.delivery) {
          handleDelivery(messagingEvent);
        } else if (messagingEvent.read) {
          handleRead(messagingEvent);
        } else {
          console.log('Webhook received unknown messagingEvent: ', messagingEvent);
        }
      });
    });

    // Return a '200 OK' response to all events immediately
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

/**
 * Verify the request signature from Facebook
 * @param {Object} req - Express request object
 * @returns {Boolean} - True if signature is valid
 */
function verifyRequestSignature(req) {
  const signature = req.get('x-hub-signature');

  if (!signature) {
    console.warn('Request signature missing');
    return false;
  }

  const elements = signature.split('=');
  const signatureHash = elements[1];
  const body = req.rawBody || JSON.stringify(req.body);
  const hash = crypto
    .createHmac('sha1', APP_SECRET)
    .update(body)
    .digest('hex');

  if (hash === signatureHash) {
    return true;
  } else {
    console.error('Signature validation failed');
    return false;
  }
}

/**
 * Handle incoming messages
 * @param {Object} event - Messaging event from Facebook
 */
function handleMessage(event) {
  const senderID = event.sender.id;
  const recipientID = event.recipient.id;
  const timeOfMessage = event.timestamp;
  const message = event.message;

  console.log(
    `Received message for user ${senderID} and page ${recipientID} at ${timeOfMessage} with message:`,
    message
  );

  if (message.text) {
    // Handle text message
    console.log(`Message text: ${message.text}`);
    sendTextMessage(senderID, `Echo: ${message.text}`);
  } else if (message.attachments) {
    // Handle attachments (images, files, etc.)
    console.log(`Received attachment:`, message.attachments);
    sendTextMessage(senderID, 'Thanks for sending an attachment!');
  }
}

/**
 * Handle postback from interactive messages
 * @param {Object} event - Postback event from Facebook
 */
function handlePostback(event) {
  const senderID = event.sender.id;
  const recipientID = event.recipient.id;
  const timeOfPostback = event.timestamp;
  const payload = event.postback.payload;

  console.log(
    `Received postback for user ${senderID} and page ${recipientID} with payload: ${payload}`
  );

  sendTextMessage(senderID, `Postback received with payload: ${payload}`);
}

/**
 * Handle delivery confirmation
 * @param {Object} event - Delivery event from Facebook
 */
function handleDelivery(event) {
  const senderID = event.sender.id;
  const deliveryMetadata = event.delivery;

  console.log(
    `Received delivery confirmation for message(s) from user ${senderID}:`,
    deliveryMetadata
  );
}

/**
 * Handle read receipt
 * @param {Object} event - Read event from Facebook
 */
function handleRead(event) {
  const senderID = event.sender.id;
  const readMetadata = event.read;

  console.log(`User ${senderID} read message(s) up to watermark ${readMetadata.watermark}`);
}

/**
 * Send a text message to the user
 * @param {String} recipientID - User's Facebook ID
 * @param {String} messageText - Text to send
 */
function sendTextMessage(recipientID, messageText) {
  const messageData = {
    recipient: {
      id: recipientID,
    },
    message: {
      text: messageText,
    },
  };

  callSendAPI(messageData);
}

/**
 * Call the Send API
 * @param {Object} messageData - Message data to send
 */
function callSendAPI(messageData) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error('PAGE_ACCESS_TOKEN is not configured');
    return;
  }

  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(messageData),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.message_id) {
        console.log(`✅ Message sent with ID: ${data.message_id}`);
      } else if (data.error) {
        console.error(`❌ Error sending message: ${data.error.message}`);
      }
    })
    .catch((err) => console.error(`Error calling Send API: ${err}`));
}

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).send('Facebook Messenger Webhook Server is running ✅');
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Server is running on http://localhost:${PORT}`);
  console.log(`📍 Webhook endpoint: http://localhost:${PORT}/webhook\n`);
});
