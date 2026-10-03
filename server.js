import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

const transporterPool = new Map();
const globalSession = { stopRequested: false };

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
      maxConnections: 10,
      maxMessages: 100,
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
  res.setHeader('X-Accel-Buffering', 'no');

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

  globalSession.stopRequested = false;

  const BLITZ_SIZE = 6;         // 6 emails parallel per blitz batch
  const MAX_PER_ACCOUNT = 25;   // Limit 25 per account

  let senderIndex = 0;
  let currentSenderSentCount = 0;

  for (let i = 0; i < recipients.length; i += BLITZ_SIZE) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User' })}\n\n`);
      break;
    }

    const blitzBatch = recipients.slice(i, i + BLITZ_SIZE);

    const blitzTasks = blitzBatch.map(async (rawRecipient, idx) => {
      if (globalSession.stopRequested) return;

      const recipient = CleanRecipient(rawRecipient);
      if (!recipient.email) return;

      if (currentSenderSentCount >= MAX_PER_ACCOUNT) {
        senderIndex++;
        currentSenderSentCount = 0;
      }

      if (senderIndex >= senders.length) {
        res.write(`data: ${JSON.stringify({ success: false, error: 'All sender accounts reached 25 email limit' })}\n\n`);
        return;
      }

      const currentSender = senders[senderIndex];
      const transporter = GetFreshTransporter(currentSender.email, currentSender.appPassword);

      try {
        // Micro staggered delay to avoid connection collisions
        if (idx > 0) {
          await new Promise(resolve => setTimeout(resolve, idx * 90));
        }

        const uniqueNoise = '\u200B'.repeat(Math.floor(Math.random() * 3) + 1);
        const randomMsgId = `<${Date.now()}.${crypto.randomBytes(6).toString('hex')}@gmail.com>`;

        const mailOptions = {
          from: currentSender.senderName 
            ? `"${currentSender.senderName}" <${currentSender.email.toLowerCase().trim()}>`
            : currentSender.email.toLowerCase().trim(),
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          subject: subject,
          text: `${messageBody}${uniqueNoise}`,
          messageId: randomMsgId,
          headers: {
            'X-Mailer': 'Gmail Console Client',
            'X-Priority': '3'
          }
        };

        await transporter.sendMail(mailOptions);
        currentSenderSentCount++;

        res.write(`data: ${JSON.stringify({ 
          success: true, 
          recipient: recipient.email, 
          senderUsed: currentSender.email,
          accountSentCount: currentSenderSentCount 
        })}\n\n`);

      } catch (err) {
        res.write(`data: ${JSON.stringify({ success: false, recipient: recipient.email, error: err.message })}\n\n`);
      }
    });

    await Promise.allSettled(blitzTasks);

    if (senderIndex >= senders.length) break;

    // Fast micro pause between batches (180ms)
    if (i + BLITZ_SIZE < recipients.length && !globalSession.stopRequested) {
      await new Promise(resolve => setTimeout(resolve, 180));
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  res.json({ success: true, message: 'Stopped by User' });
});

app.use((req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🚀 Fast Blitz Inboxing Engine Active on Port ${PORT}`));
}

export default app;
