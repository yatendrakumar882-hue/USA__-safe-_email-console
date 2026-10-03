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
app.use(express.static(path.join(process.cwd(), 'public')));

// Standard Transporter Factory
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

// Authentication Endpoint
app.post('/api/auth', (req, res) => {
  if (req.body.password === SITE_PASSWORD) {
    return res.json({ success: true, message: 'Authenticated' });
  }
  return res.status(401).json({ success: false, message: 'Invalid Password' });
});

// Verification Endpoint
app.post('/api/verify', async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: 'Missing credentials' });
  }

  try {
    const transporter = createTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP credentials verified successfully' });
  } catch (err) {
    return res.status(401).json({ success: false, message: err.message });
  }
});

// Sequential Transactional Send Route
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

  for (const recipient of recipients) {
    const targetEmail = typeof recipient === 'object' ? recipient.email : recipient;
    if (!targetEmail) continue;

    try {
      const mailOptions = {
        from: senderName ? `"${senderName}" <${email}>` : email,
        to: targetEmail,
        subject: subject,
        text: messageBody
      };

      await transporter.sendMail(mailOptions);

      res.write(`data: ${JSON.stringify({ success: true, recipient: targetEmail })}\n\n`);

      // Safe processing delay to respect standard SMTP rate limits
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (err) {
      res.write(`data: ${JSON.stringify({ success: false, recipient: targetEmail, error: err.message })}\n\n`);
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

app.use((req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
