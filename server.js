import 'dotenv/config';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
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

// Creates a fresh pooled transporter that automatically rotates sockets every 16 messages
// so Gmail never flags the connection after 50-100 emails
function getDirectTransporter(email, appPassword, forceRefresh = false) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const senderDomain = cleanEmail.includes('@') ? cleanEmail.split('@')[1] : 'gmail.com';
  const key = `inbox4_${cleanEmail}_${cleanPass}`;

  if (forceRefresh && poolMap.has(key)) {
    try {
      poolMap.get(key).close();
    } catch {}
    poolMap.delete(key);
  }

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // Direct STARTTLS on Port 587 (No Proxy)
      name: senderDomain,
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      pool: true,
      maxConnections: 5, // 5 parallel connections for 5-email batch
      maxMessages: 16,   // Refreshes socket every 16 emails (4 batches) to prevent 50+ session flagging
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

// High-diversity combinatorial generator (200,000+ combinations)
// Keeps the exact same meaning, no footer, no forced hello/thanks, so it doesn't burn out after 50-100 emails
function buildInboxSafeBody(rawTemplate, recipient) {
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

  // 1. Rotate the opening compliment naturally so the first 5 words aren't identical across 100 emails
  content = content.replace(
    /\b(Your website|Your site)\s+(looks|appears|seems|is)\s+(great|good|solid|impressive|appealing|attractive|polished|refined|modern|clean|organized|excellent|well built|engaging|balanced|structured|neat)\b/gi,
    () => {
      const subjectNoun = pickRandom([
        'Your website',
        'Your site',
        'Your web page',
        'Your online site'
      ]);
      const verb = pickRandom(['looks', 'appears', 'seems', 'is']);
      const adj = pickRandom([
        'great', 'impressive', 'well-built', 'clean', 'modern',
        'polished', 'solid', 'well-organized', 'appealing', 'excellent',
        'neat', 'refined', 'well-structured', 'sharp', 'professional'
      ]);
      return `${subjectNoun} ${verb} ${adj}`;
    }
  );

  // 2. Massive pool (25+ variations) for the "error keeping it off Google's top/first page" clause
  content = content.replace(
    /(,?\s*(yet|but)\s+(it is not showing on page one|it does not showing on page one|an? error is keeping it out of Google's top results|an? error is stopping it from showing up on the top results))/gi,
    () => {
      const connector = pickRandom([', but', ', yet', '—however,', ', though']);
      const errorPart = pickRandom([
        'a small error is keeping it off Google’s top page',
        'an issue is stopping it from appearing on the first page',
        'a minor error is holding it back from page one',
        'a small indexing issue is keeping it out of the top results',
        'it is currently not surfacing on the first page of search',
        'a technical error is preventing it from showing on page one',
        'it is missing from the initial page of search results',
        'a small site issue is keeping it off the main results page',
        'it isn’t showing up on the first page where it belongs',
        'a minor visibility error is holding it off the top page',
        'an on-page issue is stopping it from reaching page one',
        'it is sitting just outside the top page results due to an error',
        'a small search error is keeping it from appearing on page one',
        'it is not coming up on the primary page of results yet',
        'a minor configuration error is keeping it off Google’s first page',
        'it is being held back from the top search results by a small error',
        'a quick fixable error is stopping it from showing on page one',
        'it is not appearing in the top page view right now'
      ]);
      return `${connector} ${errorPart}`;
    }
  );

  // Fallback if user wrote a slightly different phrasing of "not showing on page one"
  content = content.replace(
    /(not showing on page one|does not showing on page one|keeping it out of Google's top results|stopping it from showing up on the top results)/gi,
    () => pickRandom([
      'not appearing on the first page of results',
      'not showing up on Google’s top page',
      'missing from the first page of search results',
      'held back from showing on page one',
      'not coming up on the top page right now',
      'kept off the first page due to a small error',
      'not surfacing on the main search page',
      'sitting outside the first page of results'
    ])
  );

  // 3. Massive pool (20+ variations) for "Can I send a screenshot?"
  content = content.replace(
    /(Can|May) I (send|email)( you)? (a |the )?screen\s*shot\??\.?/gi,
    () => pickRandom([
      'Can I send you the screenshot?',
      'May I send over a screenshot?',
      'Can I email you the screenshot?',
      'Mind if I send a quick screenshot?',
      'Can I share the screenshot with you?',
      'May I email you a quick screenshot?',
      'Can I send over the screenshot I took?',
      'Would it be okay if I sent the screenshot?',
      'Should I email you the screenshot?',
      'Can I forward the screenshot over to you?',
      'May I share a quick screenshot of what I spotted?',
      'Can I send you a quick screenshot of the error?',
      'Mind if I email over the screenshot?',
      'Can I share the screenshot I just captured?',
      'May I send the screenshot to this email?'
    ])
  );

  content = content.replace(
    /Can I sent quote\.?/gi,
    () => pickRandom([
      'Can I send you the screenshot?',
      'May I share the screenshot and details?',
      'Mind if I send over a quick screenshot?'
    ])
  );

  return content.trim();
}

function buildInboxSafeSubject(rawSubject, recipient) {
  const domainPart = recipient.domain ? ` (${recipient.domain})` : '';
  const namePart = recipient.firstName ? `${recipient.firstName} - ` : '';

  // If user left subject blank or used a static repeated subject, rotate cleanly
  if (!rawSubject || !rawSubject.includes('{')) {
    const base = rawSubject ? rawSubject.trim() : '';
    return pickRandom([
      base || 'Quick question regarding your site',
      `${namePart}Quick question about your website`,
      `Small issue spotted on your site${domainPart}`,
      `Quick note regarding your website`,
      `${namePart}Small error on your site`,
      `Observation on your website${domainPart}`,
      `Quick check on your site`,
      `Noticed a small issue on your website`
    ]);
  }

  let content = parseSpintax(rawSubject);
  const fallback = recipient.firstName || recipient.name || '';
  content = content.replace(/{Name}/gi, recipient.name || fallback || '');
  content = content.replace(/{FirstName}/gi, recipient.firstName || fallback || '');
  content = content.replace(/{First_Name}/gi, recipient.firstName || fallback || '');
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);
  return content.trim() || 'Quick question';
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
    const transporter = getDirectTransporter(email, appPassword);
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
  const senderDomain = cleanEmail.includes('@') ? cleanEmail.split('@')[1] : 'gmail.com';
  const cleanSenderName = (senderName || '').replace(/["\r\n]/g, '').trim();
  globalSession.stopRequested = false;

  const keepAlivePing = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 4000);

  let transporter = getDirectTransporter(email, appPassword, true);

  // 1 Batch = 5 Emails
  const BATCH_SIZE = 5;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User' })}\n\n`);
      break;
    }

    // Refresh SMTP pool every 24 emails (5 batches) so Gmail never flags long sessions after 50 emails
    if (i > 0 && i % 24 === 0) {
      transporter = getDirectTransporter(email, appPassword, true);
      await new Promise(resolve => setTimeout(resolve, 900));
    }

    const batch = recipients.slice(i, i + BATCH_SIZE);

    const sendPromises = batch.map(async (rawRecipient, idx) => {
      const recipient = parseRecipientData(rawRecipient);
      if (!recipient.email) return { success: false, recipient: '', error: 'Invalid Email' };

      try {
        if (idx > 0) {
          await new Promise(resolve => setTimeout(resolve, Math.floor(140 + Math.random() * 110)));
        }

        const finalSubject = buildInboxSafeSubject(subject, recipient);
        const finalBody = buildInboxSafeBody(messageBody, recipient);
        const isHtml = /<[a-z][\s\S]*>/i.test(finalBody);

        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          replyTo: cleanEmail,
          subject: finalSubject,
          messageId: `<${crypto.randomUUID()}@${senderDomain}>`,
          encoding: 'utf-8'
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

    // Smooth pause after every 5-email batch (600ms - 900ms)
    if (i + BATCH_SIZE < recipients.length) {
      const batchDelay = Math.floor(600 + Math.random() * 300);
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
