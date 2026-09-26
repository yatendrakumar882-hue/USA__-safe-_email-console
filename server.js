import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ==========================================================================
   1. BOT PROTECTION & AUTHENTICATION
   ========================================================================== */
async function verifyTurnstileToken(token, remoteIp) {
  if (!token || !TURNSTILE_SECRET_KEY) return true;

  try {
    const formData = new URLSearchParams();
    formData.append('secret', TURNSTILE_SECRET_KEY);
    formData.append('response', token);
    if (remoteIp) formData.append('remoteip', remoteIp);

    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    const outcome = await result.json();
    return outcome.success === true;
  } catch (error) {
    console.error('Turnstile verification error:', error);
    return false;
  }
}

/* ==========================================================================
   2. TRANSPORTER FACTORY
   ========================================================================== */
function createTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: cleanEmail,
      pass: cleanPass
    },
    pool: true,
    maxConnections: 1,
    maxMessages: 100,
    socketTimeout: 30000,
    connectionTimeout: 30000
  });
}

/* ==========================================================================
   3. DATA PARSING HELPERS
   ========================================================================== */
function parseRecipientData(input) {
  let email = '';
  let name = '';

  if (typeof input === 'object' && input !== null) {
    email = (input.email || '').trim();
    name = (input.name || '').trim();
  } else if (typeof input === 'string') {
    email = input.trim();
  }

  return {
    email: email.toLowerCase(),
    name: name
  };
}

/* ==========================================================================
   4. API ROUTES
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (SITE_PASSWORD && password === SITE_PASSWORD) {
    return res.json({ success: true, message: 'Authorized' });
  }
  return res.status(401).json({ success: false, message: 'Unauthorized' });
});

app.post('/api/send-stream', async (req, res) => {
  // SSE Headers Setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let isAborted = false;
  req.on('close', () => {
    isAborted = true;
  });

  const { email, appPassword, senderName, subject, messageBody, recipients, cfToken } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Request Data' })}\n\n`);
    res.end();
    return;
  }

  if (cfToken) {
    const isHuman = await verifyTurnstileToken(cfToken, clientIp);
    if (!isHuman) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Security Verification Failed' })}\n\n`);
      res.end();
      return;
    }
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || 'Sender').replace(/["\r\n]/g, '').trim();

  const keepAlivePing = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keep-alive\n\n');
    }
  }, 5000);

  const transporter = createTransporter(email, appPassword);

  try {
    for (const rawRecipient of recipients) {
      if (isAborted) break;

      const recipient = parseRecipientData(rawRecipient);
      if (!recipient.email) continue;

      const mailOptions = {
        from: `"${cleanSenderName}" <${cleanEmail}>`,
        to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
        subject: subject || 'Notice',
        text: messageBody || ''
      };

      try {
        await transporter.sendMail(mailOptions);
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ success: true, recipient: recipient.email })}\n\n`);
        }
      } catch (err) {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ success: false, recipient: recipient.email, error: err.message })}\n\n`);
        }
      }
    }
  } finally {
    clearInterval(keepAlivePing);
    transporter.close();
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
