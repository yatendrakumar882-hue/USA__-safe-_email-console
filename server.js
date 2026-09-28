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

function getFastCleanTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const senderDomain = cleanEmail.includes('@') ? cleanEmail.split('@')[1] : 'gmail.com';
  const key = `fast_${cleanEmail}_${cleanPass}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // Direct STARTTLS on 587 (No Proxy)
      name: senderDomain,
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      pool: true,
      maxConnections: 6, // Fast parallel connections
      maxMessages: 98000,
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

// Keeps the EXACT SEO meaning:
// "Your site looks great, but due to an error it is not on Google's top page. Can I send a screenshot?"
// while varying sentence structure so every single email lands in Primary Inbox
function buildUniqueHumanMessage(rawTemplate, recipient, senderName) {
  if (!rawTemplate) return '';

  const isHtml = /<[a-z][\s\S]*>/i.test(rawTemplate);
  let selectedTemplate = String(rawTemplate).trim();

  // If multiple lines of templates are pasted, pick 1 random line per email
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
  content = content.replace(/{Name}/gi, recipient.name || fallbackName || 'there');
  content = content.replace(/{FirstName}/gi, recipient.firstName || fallbackName || 'there');
  content = content.replace(/{First_Name}/gi, recipient.firstName || fallbackName || 'there');
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);

  // 1. Exact meaning variations for "not showing on page one / Google's top results"
  content = content.replace(
    /(yet it is not showing on page one|yet it does not showing on page one|keeping it out of Google's top results|stopping it from showing up on the top results)/gi,
    () => pickRandom([
      'but a small error is keeping it off Google’s top page',
      'yet an SEO error is stopping it from ranking on Google’s first page',
      'but a minor error is preventing it from showing on Google’s top page',
      'yet a technical error is keeping it off the first page of Google',
      'but an indexing error is stopping it from appearing on Google’s top page',
      'yet a small site error is holding it back from Google’s first page',
      'but an error is keeping it from showing up on Google’s top page',
      'yet a minor SEO issue is stopping it from reaching Google’s first page'
    ])
  );

  // 2. Exact meaning variations for "Can I send a screenshot?"
  content = content.replace(
    /(Can|May) I (send|email)( you)? (a |the )?screen\s*shot\??/gi,
    () => pickRandom([
      'Can I send you the screenshot?',
      'May I email you a screenshot of the error?',
      'Can I share the screenshot with you?',
      'Mind if I send over the screenshot?',
      'Can I email you a quick screenshot?',
      'May I send over the screenshot I took?',
      'Can I send you a screenshot showing the error?',
      'Would it be okay if I sent you the screenshot?'
    ])
  );

  // 3. Exact meaning variations for "Can I sent quote"
  content = content.replace(
    /Can I sent quote\.?/gi,
    () => pickRandom([
      'Can I send you a screenshot and a quick quote?',
      'May I email you the screenshot and details?',
      'Can I share the screenshot with you?'
    ])
  );

  // Personalize greeting with recipient's FirstName naturally
  if (fallbackName && !content.toLowerCase().includes(fallbackName.toLowerCase())) {
    content = content.replace(/^(Hello!|Hi!|Hey,|Hello,|Hi,)/i, (match) => {
      const cleanGreet = match.replace(/[!.,]/g, '');
      return `${cleanGreet} ${fallbackName},\n\n`;
    });
  }

  // Clean sign-off
  if (!isHtml && !/(regards|thanks|best|sincerely|cheers)/i.test(content)) {
    const signOff = pickRandom([
      'Best regards,',
      'Thanks,',
      'Kind regards,',
      'Best,',
      'Warm regards,'
    ]);
    const signName = senderName || '';
    content = `${content}\n\n${signOff}${signName ? `\n${signName}` : ''}`;
  }

  return content.trim();
}

function buildUniqueSubject(rawSubject, recipient) {
  let subj = personalizeContentBasic(rawSubject, recipient);
  if (!subj) {
    const namePart = recipient.firstName ? `${recipient.firstName} - ` : '';
    subj = pickRandom([
      `${namePart}Small error on your website`,
      `Quick question about your site's Google ranking`,
      `Spotted a small SEO error on your site`,
      `${namePart}Your website on Google's top page`,
      `Screenshot of a small error on your site`
    ]);
  }
  return subj;
}

function personalizeContentBasic(template, recipient) {
  if (!template) return '';
  let content = parseSpintax(template);
  const fallback = recipient.firstName || recipient.name || '';
  content = content.replace(/{Name}/gi, recipient.name || fallback || 'there');
  content = content.replace(/{FirstName}/gi, recipient.firstName || fallback || 'there');
  content = content.replace(/{First_Name}/gi, recipient.firstName || fallback || 'there');
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
    const transporter = getFastCleanTransporter(email, appPassword);
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

  const transporter = getFastCleanTransporter(email, appPassword);
  const BATCH_SIZE = 6;

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
          await new Promise(resolve => setTimeout(resolve, Math.floor(120 + Math.random() * 100)));
        }

        const finalSubject = buildUniqueSubject(subject, recipient);
        const finalBody = buildUniqueHumanMessage(messageBody, recipient, cleanSenderName);
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
