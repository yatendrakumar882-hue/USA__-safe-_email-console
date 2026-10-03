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
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Standard Transporter Setup
function createTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPassword = appPassword.replace(/\s+/g, '').trim();

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // TLS via STARTTLS
    auth: {
      user: cleanEmail,
      pass: cleanPassword
    }
  });
}

// Authentication
app.post('/api/auth', (req, res) => {
  if (req.body.password === SITE_PASSWORD) {
    return res.json({ success: true, message: 'Authorized' });
  }
  return res.status(401).json({ success: false, message: 'Invalid Password' });
});

// SMTP Verification
app.post('/api/verify', async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: 'Missing credentials' });
  }

  try {
    const transporter = createTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP Ready' });
  } catch (err) {
    return res.status(401).json({ success: false, message: err.message });
  }
});

// Standard Sequential Stream Handler
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid parameters' })}\n\n`);
    res.end();
    return;
  }

  const transporter = createTransporter(email, appPassword);

  for (let i = 0; i < recipients.length; i++) {
    const rawRecipient = recipients[i];
    const targetEmail = typeof rawRecipient === 'object' ? rawRecipient.email : rawRecipient;

    if (!targetEmail) continue;

    try {
      const mailOptions = {
        from: senderName ? `"${senderName}" <${email.toLowerCase().trim()}>` : email.toLowerCase().trim(),
        to: targetEmail.toLowerCase().trim(),
        subject: subject,
        text: messageBody
      };

      await transporter.sendMail(mailOptions);

      res.write(`data: ${JSON.stringify({ success: true, recipient: targetEmail, sentCount: i + 1 })}\n\n`);

      // Safe Delay (300 to 500 ms) to prevent instant server-side rate limits
      const safeDelay = Math.floor(300 + Math.random() * 200);
      await new Promise(resolve => setTimeout(resolve, safeDelay));

    } catch (err) {
      res.write(`data: ${JSON.stringify({ success: false, recipient: targetEmail, error: err.message })}\n\n`);
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server active on port ${PORT}`));

export default app;
