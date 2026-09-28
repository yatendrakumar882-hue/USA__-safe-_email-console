import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

const globalSession = { stopRequested: false };
const poolMap = new Map();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Closes old account connections when switching Gmail IDs after 24 emails
function getCleanGmailTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const key = `gmail_${cleanEmail}`;

  // Close previous Gmail account pools so switching accounts every 24 emails starts 100% fresh
  for (const [existingKey, existingTransporter] of poolMap.entries()) {
    if (existingKey !== key) {
      try { existingTransporter.close(); } catch {}
      poolMap.delete(existingKey);
    }
  }

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // Direct STARTTLS on Port 587 (No Proxy)
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      pool: true,
      maxConnections: 4, // 1 Batch = 4 Emails
      maxMessages: 24,   // Fresh socket lifecycle for 24-email batches
      socketTimeout: 30000,
      connectionTimeout: 30000
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

  while (regex.test(spun) && iterations < 35) {
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

// Keeps the exact meaning and tone while avoiding spam-blacklisted phrase fingerprints
function buildInboxMessage(rawTemplate, recipient) {
  if (!rawTemplate) return '';

  const isHtml = /<[a-z][\s\S]*>/i.test(rawTemplate);
  let selectedTemplate = String(rawTemplate).trim();

  // If multiple template lines are pasted, pick 1 random line per email
  if (!isHtml) {
    const lines = selectedTemplate
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 15);

    const looksLikeVariationList =
      lines.length >= 2 &&
      lines.filter(l => /^(hi|hello|hey|your|good\s)/i.test(l)).length >= Math.ceil(lines.length * 0.6);

    if (looksLikeVariationList) {
      selectedTemplate = pickRandom(lines);
    }
  }

  let content = parseSpintax(selectedTemplate);

  const fallbackName = recipient.firstName || recipient.name || '';
  content = content.replace(/{Name}/gi, recipient.name || fallbackName || '');
  content = content.replace(/{FirstName}/gi, recipient.firstName || fallbackName || '');
  content = content.replace(/{First_Name}/gi, recipient.firstName || fallbackName || '');
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);

  // 1. Vary opening compliment naturally
  content = content.replace(
    /\b(Your website|Your site)\s+(looks|appears|seems|is)\s+(great|good|solid|impressive|appealing|attractive|polished|refined|modern|clean|organized|excellent|well built|engaging|balanced|structured|neat)\b/gi,
    () => {
      const noun = pickRandom(['Your website', 'Your site', 'Your web page']);
      const verb = pickRandom(['looks', 'appears', 'seems']);
      const adj = pickRandom([
        'great', 'impressive', 'well-built', 'clean', 'modern',
        'polished', 'solid', 'organized', 'appealing', 'excellent',
        'neat', 'refined', 'structured', 'sharp'
      ]);
      return `${noun} ${verb} ${adj}`;
    }
  );

  // 2. Safe inbox-friendly phrasing with exact same meaning
  content = content.replace(
    /(,?\s*(yet|but)\s+(it is not showing on page one|it does not showing on page one|an? error is keeping it out of Google's top results|an? error is stopping it from showing up on the top results))/gi,
    () => {
      const conn = pickRandom([', but', ', yet', '—however,']);
      const reason = pickRandom([
        'a small error is keeping it from appearing in the top search results',
        'a minor issue is holding it back from the main search page',
        'a small technical issue is stopping it from surfacing in the top results',
        'an indexing issue is keeping it out of the primary search view',
        'a small site error is preventing it from showing up in the top results',
        'it is currently held back from the top search spots due to a small error',
        'a minor error is keeping it from ranking on the main results page',
        'it is missing from the top search view because of a small issue',
        'a small visibility issue is stopping it from appearing higher in search',
        'an on-page error is keeping it just outside the top search results'
      ]);
      return `${conn} ${reason}`;
    }
  );

  content = content.replace(
    /(not showing on page one|does not showing on page one|keeping it out of Google's top results|stopping it from showing up on the top results)/gi,
    () => pickRandom([
      'not appearing in the top search results due to a small error',
      'held back from the main search page by a minor issue',
      'missing from the top search view because of a small error',
      'not showing up in the primary search results yet',
      'kept out of the top search spots by a small site issue'
    ])
  );

  // 3. Safe variations for the screenshot question
  content = content.replace(
    /(Can|May) I (send|email)( you)? (a |the )?screen\s*shot\??\.?/gi,
    () => pickRandom([
      'Can I send you a quick screen capture of the error?',
      'May I email you the image showing what I found?',
      'Mind if I share a quick capture of the issue?',
      'Can I send over the snapshot I took of the error?',
      'May I forward you the screen capture I just took?',
      'Should I send over the image of what I spotted?',
      'Can I share a quick picture of the error with you?',
      'Would it be okay if I emailed you the screen capture?'
    ])
  );

  content = content.replace(
    /Can I sent quote\.?/gi,
    () => pickRandom([
      'Can I send over the screen capture and details?',
      'May I share a quick capture of what I found?',
      'Can I email you the details and capture?'
    ])
  );

  return content.trim();
}

// Keeps the EXACT Subject Line entered by the user (NO auto-change)
function buildExactSubject(rawSubject, recipient) {
  if (!rawSubject) return '';
  let content = parseSpintax(rawSubject);
  const fallback = recipient.firstName || recipient.name || '';
  content = content.replace(/{Name}/gi, recipient.name || fallback || '');
  content = content.replace(/{FirstName}/gi, recipient.firstName || fallback || '');
  content = content.replace(/{First_Name}/gi, recipient.firstName || fallback || '');
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

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) return res.json({ success: true, message: 'Authorized' });
  return res.status(401).json({ success: false, message: 'Unauthorized Password' });
});

app.post('/api/verify', async (req, res) => {
  const { email, appPassword } = req.body;

  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: 'Credentials required' });
  }

  try {
    const transporter = getCleanGmailTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP verified successfully' });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error.message || 'SMTP Auth Failed. Check 16-char App Password.'
    });
  }
});

app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Request Data' })}\n\n`);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || '').replace(/["\r\n]/g, '').trim();
  globalSession.stopRequested = false;

  const keepAlivePing = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 4000);

  const transporter = getCleanGmailTransporter(email, appPassword);

  // 1 Batch = 4 Emails
  const BATCH_SIZE = 4;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User' })}\n\n`);
      break;
    }

    const batch = recipients.slice(i, i + BATCH_SIZE);

    const sendPromises = batch.map(async (rawRecipient, idx) => {
      const recipient = parseRecipientData(rawRecipient);
      if (!recipient.email) return { success: false, recipient: '', error: 'Invalid Email' };

      try {
        if (idx > 0) {
          await new Promise(resolve => setTimeout(resolve, Math.floor(150 + Math.random() * 120)));
        }

        const finalSubject = buildExactSubject(subject, recipient);
        const finalBody = buildInboxMessage(messageBody, recipient);
        const isHtml = /<[a-z][\s\S]*>/i.test(finalBody);

        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          replyTo: cleanEmail,
          subject: finalSubject
        };

        if (isHtml) {
          mailOptions.html = `<div dir="ltr">${finalBody}</div>`;
          mailOptions.text = stripHtmlTags(finalBody);
        } else {
          mailOptions.text = finalBody;
          mailOptions.html = `<div dir="ltr">${finalBody.replace(/\n/g, '<br>')}</div>`;
        }

        await transporter.sendMail(mailOptions);

        const payload = { success: true, recipient: recipient.email, name: recipient.name };
        io.emit('mail_sent', payload);
        return payload;

      } catch (err) {
        const errPayload = { success: false, recipient: recipient.email, error: err.message };
        io.emit('mail_error', errPayload);
        return errPayload;
      }
    });

    const results = await Promise.allSettled(sendPromises);

    for (const resItem of results) {
      if (resItem.status === 'fulfilled' && resItem.value.recipient) {
        res.write(`data: ${JSON.stringify(resItem.value)}\n\n`);
      }
    }

    if (i + BATCH_SIZE < recipients.length) {
      const batchDelay = Math.floor(350 + Math.random() * 100);
      await new Promise(resolve => setTimeout(resolve, batchDelay));
    }
  }

  clearInterval(keepAlivePing);
  res.write('data: [DONE]\n\n');
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  res.json({ success: true, message: 'Sending process stopped' });
});

app.use((req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`🚀 Mailer server running on port ${PORT}`);
});

export default app;
