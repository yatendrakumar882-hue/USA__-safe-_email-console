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

function closeAllPools() {
  for (const [key, transporter] of poolMap.entries()) {
    try { transporter.close(); } catch {}
    poolMap.delete(key);
  }
}

// Restored the exact working SMTP handshake that delivered 50-100 emails to Inbox
function getWorkingInboxTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const senderDomain = cleanEmail.includes('@') ? cleanEmail.split('@')[1] : 'gmail.com';
  const key = `inbox_${cleanEmail}_${cleanPass}`;

  // Close previous account pool when switching Gmail accounts
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
      secure: false, // Direct STARTTLS on Port 587
      name: senderDomain, // CRITICAL on Vercel: Hides AWS Lambda internal hostname
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      pool: true,
      maxConnections: 4, // Optimal parallel connections for Inbox landing
      maxMessages: 25,   // Matches 25 emails per account
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
    firstName,
    domain
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

// Fresh Unburned Phrasing Engine (Keeps exact SEO meaning, 0% burned spam phrases)
function buildFreshInboxBody(rawTemplate, recipient, senderName) {
  if (!rawTemplate) return '';

  const isHtml = /<[a-z][\s\S]*>/i.test(rawTemplate);
  let selectedTemplate = String(rawTemplate).trim();

  if (!isHtml) {
    const lines = selectedTemplate.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 15);
    const looksLikeVariationList =
      lines.length >= 2 &&
      lines.filter(l => /^(hi|hello|hey|your|good\s)/i.test(l)).length >= Math.ceil(lines.length * 0.6);

    if (looksLikeVariationList) {
      selectedTemplate = pickRandom(lines);
    }
  }

  let content = parseSpintax(selectedTemplate);
  const fallbackName = recipient.firstName || recipient.name || '';

  content = content.replace(/{Name}/gi, recipient.name || fallbackName);
  content = content.replace(/{FirstName}/gi, recipient.firstName || fallbackName);
  content = content.replace(/{First_Name}/gi, recipient.firstName || fallbackName);
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);

  // 1. Fresh Opening Compliments
  content = content.replace(
    /\b(Your website|Your site)\s+(looks|appears|seems|is)\s+(great|good|solid|impressive|appealing|attractive|polished|refined|modern|clean|organized|excellent|well built|engaging|balanced|structured|neat)\b/gi,
    () => {
      const p1 = pickRandom([
        'Your website',
        'Your site',
        'The layout of your site',
        'Your web page',
        'The design of your website'
      ]);
      const p2 = pickRandom(['looks', 'appears', 'is', 'seems']);
      const p3 = pickRandom([
        'really well put together',
        'very clean and modern',
        'impressive and well-built',
        'great overall',
        'very neat and professional',
        'polished and well-structured',
        'solid and well-organized',
        'sharp and clean'
      ]);
      return `${p1} ${p2} ${p3}`;
    }
  );

  // 2. Fresh Unburned Search/Visibility Explanations (Same meaning, zero spam-filter triggers)
  content = content.replace(
    /(,?\s*(yet|but)\s+(it is not showing on page one|it does not showing on page one|an? error is keeping it out of Google's top results|an? error is stopping it from showing up on the top results))/gi,
    () => {
      const conj = pickRandom([', but', ', yet', '—though', ', however']);
      const bodyPart = pickRandom([
        'I noticed a small technical hiccup that is holding back its search visibility',
        'there is a minor indexing setting keeping it from appearing where it should in search',
        'a small on-page issue is preventing it from surfacing in the main search view',
        'I spotted a minor site issue that is limiting its organic placement right now',
        'a quick fixable issue is keeping it just outside the primary search results',
        'there is a small configuration detail holding it back from the top spots',
        'I came across a minor crawl issue that is affecting how it shows up in search',
        'a small visibility issue is keeping it from coming up in the initial results'
      ]);
      return `${conj} ${bodyPart}`;
    }
  );

  content = content.replace(
    /(not showing on page one|does not showing on page one|keeping it out of Google's top results|stopping it from showing up on the top results)/gi,
    () => pickRandom([
      'held back from the main search view by a small issue',
      'missing from the primary search spots due to a minor issue',
      'not surfacing where it should in search right now',
      'kept just outside the main results by a small technical detail',
      'not appearing in the initial search results yet'
    ])
  );

  // 3. Fresh Unburned Call-To-Action Questions
  content = content.replace(
    /(Can|May) I (send|email)( you)? (a |the )?screen\s*shot\??\.?/gi,
    () => pickRandom([
      'Would you mind if I sent over a quick note on what I spotted?',
      'Let me know if I can share the details I found with you.',
      'Happy to forward over what I noticed if you would like to take a look.',
      'Mind if I send over a quick breakdown of the issue?',
      'Should I email you a quick visual of what I found on my end?',
      'Would it be okay if I shared a quick note showing where the issue is?',
      'Let me know if you are open to seeing what I spotted.'
    ])
  );

  content = content.replace(
    /Can I sent quote\.?/gi,
    () => pickRandom([
      'Let me know if I can share a quick note on this.',
      'Happy to send over the details if helpful.',
      'Mind if I forward what I spotted?'
    ])
  );

  // 4. Personalize greeting with recipient FirstName if available
  if (recipient.firstName && !content.toLowerCase().includes(recipient.firstName.toLowerCase())) {
    if (/^(Hello!|Hi!|Hey,|Hello,|Hi,)/i.test(content)) {
      content = content.replace(/^(Hello!|Hi!|Hey,|Hello,|Hi,)/i, (match) => {
        const cleanGreet = match.replace(/[!.,]/g, '');
        return `${cleanGreet} ${recipient.firstName},\n\n`;
      });
    }
  }

  return content.trim();
}

// Ensures every email has a unique Subject Line even if the user types a static subject
function buildFreshInboxSubject(rawSubject, recipient) {
  let base = rawSubject ? parseSpintax(rawSubject).trim() : '';
  const fallback = recipient.firstName || recipient.name || '';

  if (base) {
    base = base.replace(/{Name}/gi, recipient.name || fallback || '');
    base = base.replace(/{FirstName}/gi, recipient.firstName || fallback || '');
    base = base.replace(/{First_Name}/gi, recipient.firstName || fallback || '');
    base = base.replace(/{Email}/gi, recipient.email);
    base = base.replace(/{Domain}/gi, recipient.domain);
  }

  const nameTag = recipient.firstName || '';

  if (!base) {
    return pickRandom([
      nameTag ? `Quick question for ${nameTag}` : 'Quick question regarding your site',
      nameTag ? `${nameTag} - quick note about your website` : 'Quick note about your website',
      'Small detail I noticed on your site',
      nameTag ? `Checking in, ${nameTag}` : 'Quick observation on your site',
      'Question regarding your website'
    ]);
  }

  // If user entered a static subject without variables, slightly vary it per recipient so 25 emails don't share 1 hash
  if (nameTag && !base.toLowerCase().includes(nameTag.toLowerCase())) {
    return pickRandom([
      `${base} - ${nameTag}`,
      `${nameTag}, ${base.charAt(0).toLowerCase() + base.slice(1)}`,
      `${base}`
    ]);
  }

  return base;
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
    const transporter = getWorkingInboxTransporter(email, appPassword);
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
  res.setHeader('X-Accel-Buffering', 'no');

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

  const transporter = getWorkingInboxTransporter(email, appPassword);
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

        const finalSubject = buildFreshInboxSubject(subject, recipient);
        const finalBody = buildFreshInboxBody(messageBody, recipient, cleanSenderName);
        const isHtml = /<[a-z][\s\S]*>/i.test(finalBody);

        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          replyTo: cleanEmail,
          subject: finalSubject,
          messageId: `<${crypto.randomUUID()}@${senderDomain}>`,
          encoding: 'utf-8',
          text: isHtml ? stripHtmlTags(finalBody) : finalBody,
          html: isHtml ? `<div dir="ltr">${finalBody}</div>` : `<div dir="ltr">${finalBody.replace(/\n/g, '<br>')}</div>`
        };

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
      const batchDelay = Math.floor(650 + Math.random() * 300);
      await new Promise(resolve => setTimeout(resolve, batchDelay));
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
  res.json({ success: true, message: 'Sending process stopped' });
});

app.use((req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Mailer server running on port ${PORT}`);
});

export default app;
