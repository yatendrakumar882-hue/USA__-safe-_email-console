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

function closeAllPools() {
  for (const [key, transporter] of poolMap.entries()) {
    try { transporter.close(); } catch {}
    poolMap.delete(key);
  }
}

function getAccountTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const key = `acct_${cleanEmail}`;

  // Always close previous account sockets when switching to a new Gmail account
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
      secure: false,
      auth: { user: cleanEmail, pass: cleanPass },
      pool: true,
      maxConnections: 6,
      maxMessages: 25,
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

// Multi-structure generator so Account 1, Account 2, ... Account 200 don't share one template skeleton
function buildMultiAccountInboxMessage(rawTemplate, recipient, senderName) {
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

  // Detect if it's the SEO / website issue template and rotate across completely different human layouts
  const isSeoTemplate = /(not showing on page one|top results|screen\s*shot|sent quote)/i.test(content);

  if (isSeoTemplate && !isHtml) {
    const greetWord = pickRandom(['Hi', 'Hello', 'Hey', 'Good day']);
    const greetLine = fallbackName
      ? pickRandom([`${greetWord} ${fallbackName},`, `${greetWord} ${fallbackName} -`, `${fallbackName},`])
      : `${greetWord},`;

    const compliment = pickRandom([
      'I was just looking through your website and it looks really well put together',
      'Your site looks great and is very clean',
      'I came across your website today—the layout looks really solid',
      'Your web page looks very professional and well-organized',
      'I was reviewing your site and the design looks impressive',
      'Your website appears very neat and well-structured',
      'Just checked out your site and it looks great overall',
      'Your site has a really clean and modern look'
    ]);

    const issue = pickRandom([
      'however, a small technical issue is keeping it from appearing in the main search view.',
      'but I noticed a minor indexing issue holding it back from the top search results.',
      'yet a small on-page issue is stopping it from surfacing where it should in search.',
      'though there is a minor visibility issue preventing it from showing up higher.',
      'but a small configuration issue is keeping it out of the primary results.',
      'yet a quick fixable issue is holding back its placement right now.',
      'however, a small site issue is stopping it from coming up in the initial results.',
      'but I spotted a minor issue that is keeping it just outside the main search results.'
    ]);

    const ask = pickRandom([
      'Would you mind if I shared a quick note showing what I found?',
      'Let me know if I can send over the details I spotted.',
      'Happy to forward a quick breakdown if you would like to take a look.',
      'Should I send over a quick capture of what I noticed on my end?',
      'Mind if I email over the details so you can see it?',
      'Let me know if you are open to me sharing what I found.',
      'Can I send over a quick note on how to fix it?',
      'Would it be okay if I shared what I spotted with you?'
    ]);

    const closing = senderName
      ? pickRandom([
          `\n\nBest,\n${senderName}`,
          `\n\nThanks,\n${senderName}`,
          `\n\nRegards,\n${senderName}`,
          `\n\n-\n${senderName}`,
          `\n\nKind regards,\n${senderName}`
        ])
      : '';

    const layoutStyle = pickRandom([1, 2, 3, 4]);

    if (layoutStyle === 1) {
      return `${greetLine}\n\n${compliment}, ${issue} ${ask}${closing}`;
    } else if (layoutStyle === 2) {
      return `${greetLine}\n\n${compliment}, ${issue}\n\n${ask}${closing}`;
    } else if (layoutStyle === 3) {
      return `${compliment}, ${issue}\n\n${ask}${closing}`;
    } else {
      return `${greetLine} ${compliment.charAt(0).toLowerCase() + compliment.slice(1)}, ${issue} ${ask}${closing}`;
    }
  }

  return content.trim();
}

function buildMultiAccountSubject(rawSubject, recipient) {
  let base = rawSubject ? parseSpintax(rawSubject).trim() : '';
  const fallback = recipient.firstName || recipient.name || '';

  if (base) {
    base = base.replace(/{Name}/gi, recipient.name || fallback || '');
    base = base.replace(/{FirstName}/gi, recipient.firstName || fallback || '');
    base = base.replace(/{First_Name}/gi, recipient.firstName || fallback || '');
    base = base.replace(/{Email}/gi, recipient.email);
    base = base.replace(/{Domain}/gi, recipient.domain);
    return base;
  }

  const namePart = recipient.firstName ? `for ${recipient.firstName}` : '';
  return pickRandom([
    `Quick question ${namePart}`.trim(),
    `Note regarding your site`,
    `Quick observation ${namePart}`.trim(),
    `Checking in ${namePart}`.trim(),
    `Small detail on your website`
  ]);
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
    const transporter = getAccountTransporter(email, appPassword);
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
  const cleanSenderName = (senderName || '').replace(/["\r\n]/g, '').trim();
  globalSession.stopRequested = false;

  const keepAlivePing = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 4000);

  const transporter = getAccountTransporter(email, appPassword);
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
          await new Promise(resolve => setTimeout(resolve, Math.floor(160 + Math.random() * 120)));
        }

        const finalSubject = buildMultiAccountSubject(subject, recipient);
        const finalBody = buildMultiAccountInboxMessage(messageBody, recipient, cleanSenderName);
        const isHtml = /<[a-z][\s\S]*>/i.test(finalBody);

        // Pure native options: No fake UUID Message-ID so Gmail assigns genuine @mail.gmail.com ID
        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          subject: finalSubject
        };

        if (isHtml) {
          mailOptions.html = `<div dir="ltr">${finalBody}</div>`;
          mailOptions.text = stripHtmlTags(finalBody);
        } else {
          // Pure text/plain has the highest cross-account deliverability
          mailOptions.text = finalBody;
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
      const batchDelay = Math.floor(800 + Math.random() * 350);
      await new Promise(resolve => setTimeout(resolve, batchDelay));
    }
  }

  // Close socket pool after finishing the 25-email run so the next Gmail account starts clean
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
