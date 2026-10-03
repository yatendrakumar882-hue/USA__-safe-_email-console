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

// Cache active SMTP connections per user credentials
const smtpTransporterCache = new Map();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

// Direct Gmail Port 587 Transporter Pooling
function GetNativeSMTPTransporter(emailAddress, appPasswordKey) {
  const cleanEmail = emailAddress.toLowerCase().trim();
  const cleanPassword = appPasswordKey.replace(/\s+/g, '').trim();
  const poolKey = `pool_${cleanEmail}_${cleanPassword}`;

  if (!smtpTransporterCache.has(poolKey)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // STARTTLS connection
      auth: {
        user: cleanEmail,
        pass: cleanPassword
      },
      pool: true,
      maxConnections: 3,
      maxMessages: 500,
      rateDelta: 1000,
      rateLimit: 3,
      socketTimeout: 30000,
      connectionTimeout: 30000,
      tls: {
        rejectUnauthorized: true
      }
    });
    smtpTransporterCache.set(poolKey, transporter);
  }
  return smtpTransporterCache.get(poolKey);
}

// Recipient Parser
function FormatRecipientDetails(entry) {
  let email = '';
  let fullPersonName = '';

  if (typeof entry === 'object' && entry !== null) {
    email = (entry.email || entry.recipient || '').trim();
    fullPersonName = (entry.name || entry.fullName || entry.first_name || '').trim();
  } else if (typeof entry === 'string') {
    const text = entry.trim();
    const formattedAngle = text.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (formattedAngle) {
      fullPersonName = formattedAngle[1] ? formattedAngle[1].trim() : '';
      email = formattedAngle[2].trim();
    } else if (text.includes(',')) {
      const parts = text.split(',');
      if (parts[0].includes('@')) {
        email = parts[0].trim();
        fullPersonName = parts[1].trim();
      } else {
        fullPersonName = parts[0].trim();
        email = parts[1].trim();
      }
    } else {
      email = text;
    }
  }

  if (!fullPersonName && email.includes('@')) {
    const addressName = email.split('@')[0];
    fullPersonName = addressName.replace(/[0-9_.-]/g, ' ').trim();
  }

  const formattedName = fullPersonName
    ? fullPersonName.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    : '';

  const firstName = formattedName ? formattedName.split(' ')[0] : '';
  const domainName = email.includes('@') ? email.split('@')[1] : '';

  return {
    email: email.toLowerCase(),
    name: formattedName,
    firstName: firstName,
    domain: domainName
  };
}

// Spintax Processing engine: {Hi|Hello|Hey}
function ParseSpintaxVariations(rawText) {
  if (!rawText) return '';
  let currentString = String(rawText);
  const spintaxMatcher = /\{([^{}]+)\}/s;
  let counter = 0;

  while (spintaxMatcher.test(currentString) && counter < 40) {
    currentString = currentString.replace(spintaxMatcher, (_, optionsString) => {
      if (!optionsString.includes('|')) return optionsString;
      const choicesArr = optionsString.split('|');
      const selectedIndex = Math.floor(Math.random() * choicesArr.length);
      return choicesArr[selectedIndex] ? choicesArr[selectedIndex].trim() : '';
    });
    counter++;
  }
  return currentString.replace(/[\{\}]/g, '').trim();
}

// Dynamic Email Tag Replacement Engine
function PersonalizeEmailContent(templateContent, recipientObj) {
  if (!templateContent) return '';
  let text = ParseSpintaxVariations(templateContent);
  const fallbackName = recipientObj.firstName || recipientObj.name || 'there';

  text = text.replace(/{Name}/gi, recipientObj.name || fallbackName);
  text = text.replace(/{FirstName}/gi, recipientObj.firstName || fallbackName);
  text = text.replace(/{First_Name}/gi, recipientObj.firstName || fallbackName);
  text = text.replace(/{Email}/gi, recipientObj.email);
  text = text.replace(/{Domain}/gi, recipientObj.domain);

  return text;
}

// Standard Message ID Generator to Pass Domain Warmup Checks
function CreateNaturalMessageId(domainStr) {
  const randomValue = crypto.randomBytes(16).toString('hex');
  const timestampNow = Date.now();
  return `<${timestampNow}.${randomValue}@${domainStr || 'gmail.com'}>`;
}

// Password Verification Endpoint
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    return res.json({ success: true, message: 'Authenticated' });
  }
  return res.status(401).json({ success: false, message: 'Invalid Admin Password' });
});

// Credentials Verification Endpoint
app.post('/api/verify', async (req, res) => {
  const { email, appPassword } = req.body;

  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: 'Email and App Password required' });
  }

  try {
    const activeTransporter = GetNativeSMTPTransporter(email, appPassword);
    await activeTransporter.verify();
    return res.json({ success: true, message: 'SMTP Connection Verified' });
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

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Payload Data' })}\n\n`);
    res.end();
    return;
  }

  const cleanUserEmail = email.toLowerCase().trim();
  const cleanSenderLabel = (senderName || '').replace(/["\r\n]/g, '').trim();
  const domainHost = cleanUserEmail.split('@')[1] || 'gmail.com';

  const pingTimer = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 3000);

  const nativeTransporter = GetNativeSMTPTransporter(email, appPassword);
  
  // Safe Human Batching
  const BATCH_SIZE = 3;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const currentBatch = recipients.slice(i, i + BATCH_SIZE);

    const emailTasks = currentBatch.map(async (rawRecipientData, itemIndex) => {
      const recipient = FormatRecipientDetails(rawRecipientData);
      if (!recipient.email) return { success: false, recipient: '', error: 'Invalid Target Address' };

      try {
        if (itemIndex > 0) {
          // Micro delay to simulate human typing
          await new Promise(r => setTimeout(r, Math.floor(250 + Math.random() * 250)));
        }

        const customSubject = PersonalizeEmailContent(subject, recipient);
        const customBodyHtml = PersonalizeEmailContent(messageBody, recipient);

        const cleanPlainText = customBodyHtml
          .replace(/<br\s*[\/]?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<[^>]+>/g, '')
          .trim();

        const wrappedHtml = `<div dir="ltr">${customBodyHtml}</div>`;
        const uniqueMsgId = CreateNaturalMessageId(domainHost);

        const mailHeadersAndPayload = {
          from: cleanSenderLabel ? `"${cleanSenderLabel}" <${cleanUserEmail}>` : cleanUserEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          replyTo: cleanUserEmail,
          subject: customSubject || 'Important Update',
          text: cleanPlainText,
          html: wrappedHtml,
          messageId: uniqueMsgId
        };

        await nativeTransporter.sendMail(mailHeadersAndPayload);
        
        return { success: true, recipient: recipient.email, name: recipient.name };
      } catch (error) {
        return { success: false, recipient: recipient.email, error: error.message };
      }
    });

    const executionResults = await Promise.allSettled(emailTasks);

    for (const resultObj of executionResults) {
      if (resultObj.status === 'fulfilled' && resultObj.value.recipient) {
        res.write(`data: ${JSON.stringify(resultObj.value)}\n\n`);
      }
    }

    if (i + BATCH_SIZE < recipients.length) {
      // Dynamic anti-spam batch delay
      const delayTime = Math.floor(1200 + Math.random() * 800);
      await new Promise(r => setTimeout(r, delayTime));
    }
  }

  clearInterval(pingTimer);
  res.write('data: [DONE]\n\n');
  res.end();
});

// Serve frontend UI
app.use((req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🚀 Primary Inbox SMTP Server listening on port ${PORT}`));
}

export default app;
