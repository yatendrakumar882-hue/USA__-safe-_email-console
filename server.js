import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

const transporterPool = new Map();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

function GetFreshTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPassword = appPassword.replace(/\s+/g, '').trim();
  const poolKey = `${cleanEmail}_${cleanPassword}`;

  if (!transporterPool.has(poolKey)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // STARTTLS
      auth: {
        user: cleanEmail,
        pass: cleanPassword
      },
      pool: true,
      maxConnections: 1,
      maxMessages: 25, // Single connection max messages limit
      tls: {
        rejectUnauthorized: true
      }
    });
    transporterPool.set(poolKey, transporter);
  }
  return transporterPool.get(poolKey);
}

function CleanRecipient(input) {
  let email = '';
  let name = '';

  if (typeof input === 'object' && input !== null) {
    email = (input.email || input.recipient || '').trim();
    name = (input.name || input.fullName || input.first_name || '').trim();
  } else if (typeof input === 'string') {
    const str = input.trim();
    const matchAngle = str.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (matchAngle) {
      name = matchAngle[1] ? matchAngle[1].trim() : '';
      email = matchAngle[2].trim();
    } else {
      email = str;
    }
  }

  return { email: email.toLowerCase(), name };
}

app.post('/api/auth', (req, res) => {
  if (req.body.password === SITE_PASSWORD) return res.json({ success: true });
  return res.status(401).json({ success: false, message: 'Invalid Password' });
});

app.post('/api/verify', async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) return res.status(400).json({ success: false, message: 'Missing fields' });

  try {
    const transporter = GetFreshTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP Verified' });
  } catch (err) {
    return res.status(401).json({ success: false, message: err.message });
  }
});

app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const { email, appPassword, accounts, senderName, subject, messageBody, recipients } = req.body;

  let senders = [];
  if (Array.isArray(accounts) && accounts.length > 0) {
    senders = accounts;
  } else if (email && appPassword) {
    senders = [{ email, appPassword, senderName }];
  }

  if (senders.length === 0 || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Parameters' })}\n\n`);
    res.end();
    return;
  }

  const MAX_PER_ACCOUNT = 25; // Strict Limit: 25 emails per account
  let senderIndex = 0;
  let currentSenderSentCount = 0;

  for (let i = 0; i < recipients.length; i++) {
    const recipient = CleanRecipient(recipients[i]);
    if (!recipient.email) continue;

    // Check if current account reached limit (25 emails)
    if (currentSenderSentCount >= MAX_PER_ACCOUNT) {
      senderIndex++;
      currentSenderSentCount = 0; // Reset counter for next sender account
    }

    // Check if we ran out of available sender accounts
    if (senderIndex >= senders.length) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'All sender accounts reached 25 email limit' })}\n\n`);
      break;
    }

    const currentSender = senders[senderIndex];
    const transporter = GetFreshTransporter(currentSender.email, currentSender.appPassword);

    try {
      const mailOptions = {
        from: currentSender.senderName 
          ? `"${currentSender.senderName}" <${currentSender.email.toLowerCase().trim()}>`
          : currentSender.email.toLowerCase().trim(),
        to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
        subject: subject, // Original subject without changes
        text: messageBody, // Original plain text message body without modification
        html: `<div style="font-family: Arial, sans-serif; font-size: 14px;">${messageBody.replace(/\n/g, '<br>')}</div>`
      };

      await transporter.sendMail(mailOptions);
      currentSenderSentCount++; // Increment count for active account

      res.write(`data: ${JSON.stringify({ 
        success: true, 
        recipient: recipient.email, 
        senderUsed: currentSender.email,
        accountSentCount: currentSenderSentCount 
      })}\n\n`);

      // Normal delay between emails
      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      res.write(`data: ${JSON.stringify({ success: false, recipient: recipient.email, error: err.message })}\n\n`);
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

app.use((req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🚀 Server Running on Port ${PORT}`));
}

export default app;
