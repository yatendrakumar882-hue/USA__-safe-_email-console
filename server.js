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

// Yahan apna custom login password set karein
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ==========================================================================
   1. AUTHENTICATION ROUTE
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    return res.json({ success: true, message: 'Authorized' });
  }
  return res.status(401).json({ success: false, message: 'Unauthorized Password' });
});

/* ==========================================================================
   2. STANDARD EMAIL STREAMING ROUTE
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let isAborted = false;
  req.on('close', () => {
    isAborted = true;
  });

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Request Data' })}\n\n`);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const cleanSenderName = (senderName || 'Sender').replace(/["\r\n]/g, '').trim();

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: cleanEmail,
      pass: cleanPass
    },
    socketTimeout: 30000,
    connectionTimeout: 30000
  });

  const keepAlivePing = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keep-alive\n\n');
    }
  }, 5000);

  try {
    for (const rawRecipient of recipients) {
      if (isAborted) break;

      const recipientEmail = (typeof rawRecipient === 'object' ? rawRecipient.email : rawRecipient || '').trim().toLowerCase();
      if (!recipientEmail) continue;

      const mailOptions = {
        from: `"${cleanSenderName}" <${cleanEmail}>`,
        to: recipientEmail,
        subject: subject || 'Notice',
        text: messageBody || ''
      };

      try {
        await transporter.sendMail(mailOptions);
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ success: true, recipient: recipientEmail })}\n\n`);
        }
      } catch (err) {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ success: false, recipient: recipientEmail, error: err.message })}\n\n`);
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
