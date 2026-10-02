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
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

const globalSession = { stopRequested: false };
const poolMap = new Map();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function closeAllPools() {
  for (const [key, transporter] of poolMap.entries()) {
    try {
      transporter.close();
    } catch (e) {}
    poolMap.delete(key);
  }
}

function getHighSpeedTransporter(config) {
  const { email, appPassword, smtpHost, smtpPort, smtpUser, smtpPass } = config;
  
  let host = smtpHost || 'smtp.gmail.com';
  let port = parseInt(smtpPort, 10) || (host === 'smtp.gmail.com' ? 465 : 587);
  let user = (smtpUser || email || '').toLowerCase().trim();
  let pass = (smtpPass || appPassword || '').replace(/\s+/g, '').trim();
  
  const key = `fast_${host}_${port}_${user}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: host,
      port: port,
      secure: port === 465,
      auth: { user, pass },
      pool: true,
      maxConnections: 5, // Fast parallel connections
      maxMessages: 100,
      socketTimeout: 30000,
      connectionTimeout: 30000,
      tls: {
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2'
      }
    });
    poolMap.set(key, transporter);
  }

  return poolMap.get(key);
}

function parseRecipientData(input) {
  let email = '';
  let rawName = '';

  if (typeof input === 'object' && input !== null) {
    email = (input.email || input.recipient || '').trim();
    rawName = (input.name || input.fullName || input.first_name || '').trim();
  } else if (typeof input === 'string') {
    const str = input.trim();
    const angleMatch = str.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (angleMatch) {
      rawName = angleMatch[1] ? angleMatch[1].trim() : '';
      email = angleMatch[2].trim();
    } else {
      email = str;
    }
  }

  if (!rawName && email.includes('@')) {
    const prefix = email.split('@')[0];
    rawName = prefix.replace(/[0-9_.-]/g, ' ').trim();
  }

  const formattedName = rawName
    ? rawName.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    : '';

  const firstName = formattedName ? formattedName.split(' ')[0] : '';
  const domain = email.includes('@') ? email.split('@')[1] : '';

  return { email: email.toLowerCase(), name: formattedName, firstName, domain };
}

function parseSpintax(text) {
  if (!text) return '';
  let spun = String(text);
  const regex = /\{([^{}]+)\}/s;
  let iterations = 0;

  while (regex.test(spun) && iterations < 25) {
    spun = spun.replace(regex, (_, choices) => {
      if (!choices.includes('|')) return choices;
      const options = choices.split('|');
      const pick = options[Math.floor(Math.random() * options.length)];
      return pick ? pick.trim() : '';
    });
    iterations++;
  }
  return spun.replace(/[\{\}]/g, '').trim();
}

function personalizeContent(template, recipient) {
  if (!template) return '';
  let content = parseSpintax(template);

  const displayName = recipient.name || recipient.firstName || 'there';
  const displayFirstName = recipient.firstName || displayName;

  content = content.replace(/{Name}/gi, displayName);
  content = content.replace(/{FirstName}/gi, displayFirstName);
  content = content.replace(/{First_Name}/gi, displayFirstName);
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);

  return content.trim();
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) return res.json({ success: true, message: 'Authorized' });
  return res.status(401).json({ success: false, message: 'Unauthorized Password' });
});

app.post('/api/verify', async (req, res) => {
  try {
    const transporter = getHighSpeedTransporter(req.body);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP Verified Successfully' });
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message || 'SMTP Failed' });
  }
});

app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const { email, appPassword, smtpHost, smtpPort, smtpUser, smtpPass, senderName, subject, messageBody, recipients } = req.body;
  const senderEmail = email || smtpUser;
  const activePass = appPassword || smtpPass;

  if (!senderEmail || !activePass || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Request Data' })}\n\n`);
    res.end();
    return;
  }

  const cleanSenderEmail = senderEmail.toLowerCase().trim();
  const cleanSenderName = (senderName || '').replace(/["\r\n]/g, '').trim();
  globalSession.stopRequested = false;

  const transporter = getHighSpeedTransporter(req.body);
  const BATCH_SIZE = 5; // Fast parallel batch sending

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User' })}\n\n`);
      break;
    }

    const batch = recipients.slice(i, i + BATCH_SIZE);

    const batchTasks = batch.map(async (rawRecipient) => {
      if (globalSession.stopRequested) return;

      const recipient = parseRecipientData(rawRecipient);
      if (!recipient.email) return;

      try {
        const personalizedSubject = personalizeContent(subject, recipient);
        const personalizedBody = personalizeContent(messageBody, recipient);
        
        // Unique Message-ID generation for better inbox threading & legitimacy
        const domainPart = cleanSenderEmail.split('@')[1] || 'gmail.com';
        const messageId = `<${crypto.randomBytes(16).toString('hex')}.${Date.now()}@${domainPart}>`;

        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanSenderEmail}>` : cleanSenderEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          replyTo: cleanSenderEmail,
          subject: personalizedSubject,
          messageId: messageId,
          headers: {
            'List-Unsubscribe': `<mailto:${cleanSenderEmail}?subject=unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            'X-Priority': '3',
            'X-MSMail-Priority': 'Normal',
            'Importance': 'Normal',
            'X-Mailer': 'Microsoft Outlook 16.0'
          },
          textEncoding: 'quoted-printable',
          text: personalizedBody,
          html: `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #222; line-height: 1.5;">${personalizedBody.replace(/\n/g, '<br>')}</div>`
        };

        await transporter.sendMail(mailOptions);
        res.write(`data: ${JSON.stringify({ success: true, recipient: recipient.email })}\n\n`);

      } catch (err) {
        res.write(`data: ${JSON.stringify({ success: false, recipient: recipient.email, error: err.message })}\n\n`);
      }
    });

    await Promise.allSettled(batchTasks);

    // Minimal delay between batches for fast speed
    if (i + BATCH_SIZE < recipients.length && !globalSession.stopRequested) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  closeAllPools();
  res.write('data: [DONE]\n\n');
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  closeAllPools();
  res.json({ success: true, message: 'Stopped' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
