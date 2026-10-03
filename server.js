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

// Transporter Cache Pool
const transporterCache = new Map();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

// Dynamic SMTP Transporter Creator (Port 587 STARTTLS)
function GetTransporterForAccount(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPassword = appPassword.replace(/\s+/g, '').trim();
  const cacheKey = `${cleanEmail}:${cleanPassword}`;

  if (!transporterCache.has(cacheKey)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // STARTTLS
      auth: {
        user: cleanEmail,
        pass: cleanPassword
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      rateDelta: 1000,
      rateLimit: 5,
      socketTimeout: 20000,
      connectionTimeout: 20000,
      tls: {
        rejectUnauthorized: true
      }
    });
    transporterCache.set(cacheKey, transporter);
  }
  return transporterCache.get(cacheKey);
}

// Recipient Parser
function ParseRecipient(entry) {
  let email = '';
  let name = '';

  if (typeof entry === 'object' && entry !== null) {
    email = (entry.email || entry.recipient || '').trim();
    name = (entry.name || entry.fullName || entry.first_name || '').trim();
  } else if (typeof entry === 'string') {
    const str = entry.trim();
    const matchAngle = str.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (matchAngle) {
      name = matchAngle[1] ? matchAngle[1].trim() : '';
      email = matchAngle[2].trim();
    } else if (str.includes(',')) {
      const parts = str.split(',');
      if (parts[0].includes('@')) {
        email = parts[0].trim();
        name = parts[1].trim();
      } else {
        name = parts[0].trim();
        email = parts[1].trim();
      }
    } else {
      email = str;
    }
  }

  if (!name && email.includes('@')) {
    const prefix = email.split('@')[0];
    name = prefix.replace(/[0-9_.-]/g, ' ').trim();
  }

  const formattedName = name
    ? name.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    : '';

  const firstName = formattedName ? formattedName.split(' ')[0] : '';
  const domain = email.includes('@') ? email.split('@')[1] : '';

  return {
    email: email.toLowerCase(),
    name: formattedName,
    firstName: firstName,
    domain: domain
  };
}

// Deep Spintax Parser
function ParseSpintax(text) {
  if (!text) return '';
  let str = String(text);
  const regex = /\{([^{}]+)\}/s;
  let depth = 0;

  while (regex.test(str) && depth < 50) {
    str = str.replace(regex, (_, choices) => {
      if (!choices.includes('|')) return choices;
      const arr = choices.split('|');
      const pick = arr[Math.floor(Math.random() * arr.length)];
      return pick ? pick.trim() : '';
    });
    depth++;
  }
  return str.replace(/[\{\}]/g, '').trim();
}

// Unique Personalization + Zero Spam Hash Noise
function PersonalizeContent(template, recipient) {
  if (!template) return '';
  let text = ParseSpintax(template);
  const fallback = recipient.firstName || recipient.name || 'there';

  text = text.replace(/{Name}/gi, recipient.name || fallback);
  text = text.replace(/{FirstName}/gi, recipient.firstName || fallback);
  text = text.replace(/{First_Name}/gi, recipient.firstName || fallback);
  text = text.replace(/{Email}/gi, recipient.email);
  text = text.replace(/{Domain}/gi, recipient.domain);

  return text;
}

// Generate RFC Clean Message ID
function GenerateMessageId(senderDomain) {
  const randomHex = crypto.randomBytes(12).toString('hex');
  const timestamp = Date.now();
  return `<${timestamp}.${randomHex}@${senderDomain || 'gmail.com'}>`;
}

// Auth API
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    return res.json({ success: true, message: 'Authorized' });
  }
  return res.status(401).json({ success: false, message: 'Invalid Admin Password' });
});

// Single or Multi SMTP Verification
app.post('/api/verify', async (req, res) => {
  const { email, appPassword, accounts } = req.body;

  let accountsToTest = [];

  if (Array.isArray(accounts) && accounts.length > 0) {
    accountsToTest = accounts;
  } else if (email && appPassword) {
    accountsToTest = [{ email, appPassword }];
  } else {
    return res.status(400).json({ success: false, message: 'No accounts provided' });
  }

  try {
    for (const acc of accountsToTest) {
      const transporter = GetTransporterForAccount(acc.email, acc.appPassword);
      await transporter.verify();
    }
    return res.json({ success: true, message: `Verified ${accountsToTest.length} SMTP Account(s) Successfully` });
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: err.message || 'SMTP Authentication Failed'
    });
  }
});

// Realtime Stream Sending Route
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const {
    email,
    appPassword,
    accounts, // Array of { email, appPassword, senderName } for Multi-Account Rotation
    senderName,
    subject,
    messageBody,
    recipients
  } = req.body;

  // Build Senders Pool
  let sendersPool = [];

  if (Array.isArray(accounts) && accounts.length > 0) {
    sendersPool = accounts.map(a => ({
      email: a.email.toLowerCase().trim(),
      appPassword: a.appPassword.replace(/\s+/g, '').trim(),
      senderName: (a.senderName || senderName || '').trim()
    }));
  } else if (email && appPassword) {
    sendersPool = [{
      email: email.toLowerCase().trim(),
      appPassword: appPassword.replace(/\s+/g, '').trim(),
      senderName: (senderName || '').trim()
    }];
  }

  if (sendersPool.length === 0 || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Sender Pool or Recipient List' })}\n\n`);
    res.end();
    return;
  }

  const pingTimer = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 3000);

  // Aapki demand: 1 Batch mein exact 6 Mails
  const BATCH_SIZE = 6;
  let globalAccountIndex = 0;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const currentBatch = recipients.slice(i, i + BATCH_SIZE);

    const emailPromises = currentBatch.map(async (rawRecipient, batchOffset) => {
      const recipient = ParseRecipient(rawRecipient);
      if (!recipient.email) return { success: false, recipient: '', error: 'Invalid Target Email' };

      // Round-robin sender account assignment
      const currentSender = sendersPool[(globalAccountIndex + batchOffset) % sendersPool.length];
      const currentTransporter = GetTransporterForAccount(currentSender.email, currentSender.appPassword);
      const senderDomain = currentSender.email.split('@')[1] || 'gmail.com';

      try {
        if (batchOffset > 0) {
          // Human-like Micro Jittering (150ms - 350ms)
          await new Promise(r => setTimeout(r, Math.floor(150 + Math.random() * 200)));
        }

        const personalizedSubj = PersonalizeContent(subject, recipient);
        const personalizedBody = PersonalizeContent(messageBody, recipient);

        // Invisible zero-width noise code to ensure 100% unique mail hash for Gmail filters
        const zeroWidthNoise = `&#8203;`.repeat(Math.floor(Math.random() * 5) + 1);

        const cleanPlainText = personalizedBody
          .replace(/<br\s*[\/]?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<[^>]+>/g, '')
          .trim();

        const formattedHtml = `<div dir="ltr">${personalizedBody}${zeroWidthNoise}</div>`;
        const msgId = GenerateMessageId(senderDomain);

        const mailPayload = {
          from: currentSender.senderName
            ? `"${currentSender.senderName}" <${currentSender.email}>`
            : currentSender.email,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          replyTo: currentSender.email,
          subject: personalizedSubj || 'Quick update',
          text: cleanPlainText,
          html: formattedHtml,
          messageId: msgId
        };

        await currentTransporter.sendMail(mailPayload);

        return {
          success: true,
          recipient: recipient.email,
          name: recipient.name,
          senderUsed: currentSender.email
        };
      } catch (err) {
        return {
          success: false,
          recipient: recipient.email,
          error: err.message,
          senderUsed: currentSender.email
        };
      }
    });

    const batchResults = await Promise.allSettled(emailPromises);

    for (const resItem of batchResults) {
      if (resItem.status === 'fulfilled' && resItem.value.recipient) {
        res.write(`data: ${JSON.stringify(resItem.value)}\n\n`);
      }
    }

    // Account Index Increment for Next Batch
    globalAccountIndex += currentBatch.length;

    if (i + BATCH_SIZE < recipients.length) {
      // Natural Human Delay between Batches (800ms - 1500ms)
      const batchDelay = Math.floor(800 + Math.random() * 700);
      await new Promise(r => setTimeout(r, batchDelay));
    }
  }

  clearInterval(pingTimer);
  res.write('data: [DONE]\n\n');
  res.end();
});

// Serve Frontend Static UI
app.use((req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🚀 Multi-Account Direct Inbox Server running on port ${PORT}`));
}

export default app;
