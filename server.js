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

const globalSession = { stopRequested: false };
const poolMap = new Map();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ==========================================================================
   1. PROFESSIONAL SMTP / SES TRANSPORTER POOL MANAGEMENT
   ========================================================================== */
function closeAllPools() {
  for (const [key, transporter] of poolMap.entries()) {
    try {
      transporter.close();
    } catch (e) {}
    poolMap.delete(key);
  }
}

function getProfessionalTransporter(smtpHost, smtpPort, smtpUser, smtpPass) {
  const cleanHost = smtpHost.trim();
  const portNum = parseInt(smtpPort, 10) || 587;
  const cleanUser = smtpUser.toLowerCase().trim();
  const cleanPass = smtpPass.trim();
  const key = `smtp_${cleanHost}_${portNum}_${cleanUser}`;

  for (const [existingKey, existingTransporter] of poolMap.entries()) {
    if (existingKey !== key) {
      try {
        existingTransporter.close();
      } catch (e) {}
      poolMap.delete(existingKey);
    }
  }

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: cleanHost,
      port: portNum,
      secure: portNum === 465, // true for 465 (SSL), false for 587 (TLS)
      auth: {
        user: cleanUser,
        pass: cleanPass
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 200,
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

/* ==========================================================================
   2. RECIPIENT & SPINTAX ENGINE
   ========================================================================== */
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
    } else if (str.includes(',')) {
      const parts = str.split(',');
      if (parts[0].includes('@')) {
        email = parts[0].trim();
        rawName = parts[1].trim();
      } else {
        rawName = parts[0].trim();
        email = parts[1].trim();
      }
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

  return {
    email: email.toLowerCase(),
    name: formattedName,
    firstName: firstName,
    domain: domain
  };
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

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function extractTemplateDeck(rawTemplate) {
  if (!rawTemplate) return [''];
  const isHtml = /<[a-z][\s\S]*>/i.test(rawTemplate);
  const cleanRaw = String(rawTemplate).trim();

  if (!isHtml) {
    const lines = cleanRaw
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 10);
    if (lines.length >= 2) {
      return shuffleArray(lines);
    }
  }

  return [cleanRaw];
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

function stripHtmlTags(htmlString) {
  return htmlString
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ==========================================================================
   3. API ROUTES
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) return res.json({ success: true, message: 'Authorized' });
  return res.status(401).json({ success: false, message: 'Unauthorized Password' });
});

app.post('/api/verify', async (req, res) => {
  const { smtpHost, smtpPort, smtpUser, smtpPass } = req.body;

  if (!smtpHost || !smtpUser || !smtpPass) {
    return res.status(400).json({ success: false, message: 'SMTP Credentials required' });
  }

  try {
    const transporter = getProfessionalTransporter(smtpHost, smtpPort || 587, smtpUser, smtpPass);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP Server Verified & Ready' });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error.message || 'SMTP Authentication Failed.'
    });
  }
});

/* ==========================================================================
   4. STREAMING ROUTE FOR PROFESSIONAL SMTP / SES
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { smtpHost, smtpPort, smtpUser, smtpPass, senderEmail, senderName, subject, messageBody, recipients } = req.body;

  if (!smtpHost || !smtpUser || !smtpPass || !senderEmail || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Request Data or Missing SMTP Configuration' })}\n\n`);
    res.end();
    return;
  }

  const cleanSenderEmail = senderEmail.toLowerCase().trim();
  const cleanSenderName = (senderName || '').replace(/["\r\n]/g, '').trim();
  globalSession.stopRequested = false;

  const keepAlivePing = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (e) {}
  }, 2500);

  const defaultSubject = '{Quick question|Website Review|Quick note}';
  const defaultBody = `Hi {FirstName},\n\nYour website looks great, but a minor issue is affecting your visibility. Can I share a quick screenshot?`;

  const finalSubjectTemplate = (subject && subject.trim()) ? subject : defaultSubject;
  const rawBodyTemplate = (messageBody && messageBody.trim()) ? messageBody : defaultBody;

  let templateDeck = extractTemplateDeck(rawBodyTemplate);
  let deckIndex = 0;

  const transporter = getProfessionalTransporter(smtpHost, smtpPort || 587, smtpUser, smtpPass);
  const BATCH_SIZE = 5;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User' })}\n\n`);
      break;
    }

    const batch = recipients.slice(i, i + BATCH_SIZE);

    const batchTasks = batch.map(async (rawRecipient, idx) => {
      if (globalSession.stopRequested) return;

      const recipient = parseRecipientData(rawRecipient);
      if (!recipient.email) return;

      if (deckIndex >= templateDeck.length) {
        templateDeck = shuffleArray(templateDeck);
        deckIndex = 0;
      }
      const selectedBodyLine = templateDeck[deckIndex++];

      try {
        if (idx > 0) {
          await new Promise(resolve => setTimeout(resolve, idx * 80));
        }

        const personalizedSubject = personalizeContent(finalSubjectTemplate, recipient);
        const personalizedBody = personalizeContent(selectedBodyLine, recipient);
        const isHtml = /<[a-z][\s\S]*>/i.test(personalizedBody);

        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanSenderEmail}>` : cleanSenderEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          replyTo: cleanSenderEmail,
          subject: personalizedSubject,
          textEncoding: 'quoted-printable',
          text: isHtml ? stripHtmlTags(personalizedBody) : personalizedBody,
          html: isHtml ? `<div dir="ltr">${personalizedBody}</div>` : `<div dir="ltr">${personalizedBody.replace(/\n/g, '<br>')}</div>`
        };

        await transporter.sendMail(mailOptions);

        const successData = { success: true, recipient: recipient.email, name: recipient.name };
        res.write(`data: ${JSON.stringify(successData)}\n\n`);

      } catch (err) {
        const failData = { success: false, recipient: recipient.email, error: err.message };
        res.write(`data: ${JSON.stringify(failData)}\n\n`);
      }
    });

    await Promise.allSettled(batchTasks);

    if (i + BATCH_SIZE < recipients.length && !globalSession.stopRequested) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }

  closeAllPools();
  clearInterval(keepAlivePing);
  res.write('data: [DONE]\n\n');
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  closeAllPools();
  res.json({ success: true, message: 'Stopped by User' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

export default app;
