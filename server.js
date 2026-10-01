import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
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

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ==========================================================================
   1. CLEAN DIRECT GMAIL TRANSPORTER (NO PROXY, PROPER POOL REUSE)
   ========================================================================== */
function closeAllPools() {
  for (const [key, transporter] of poolMap.entries()) {
    try {
      transporter.close();
    } catch (e) {
      // Ignore close errors
    }
    poolMap.delete(key);
  }
}

function getNativeTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const senderDomain = cleanEmail.includes('@') ? cleanEmail.split('@')[1] : 'gmail.com';
  const key = `native_${cleanEmail}_${cleanPass}`;

  // Close old pool if switching to a different Gmail account
  for (const [existingKey, existingTransporter] of poolMap.entries()) {
    if (existingKey !== key) {
      try {
        existingTransporter.close();
      } catch (e) {
        // Ignore
      }
      poolMap.delete(existingKey);
    }
  }

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      name: senderDomain,
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      pool: true,
      maxConnections: 4,
      maxMessages: 25,
      socketTimeout: 30000,
      connectionTimeout: 30000,
      greetingTimeout: 15000,
      disableFileAccess: true,
      disableUrlAccess: true,
      tls: {
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2'
      }
    });
    poolMap.set(key, transporter);
  }

  return poolMap.get(key);
}

function generateCleanMessageId(domain = 'gmail.com') {
  const randomPart = crypto.randomBytes(10).toString('hex');
  const timePart = Date.now().toString(36);
  return `<${timePart}.${randomPart}@${domain}>`;
}

/* ==========================================================================
   2. RECIPIENT DATA, SPINTAX & SAFE INBOX FOOTER ENGINE
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

  email = email.replace(/[\u200B-\u200D\uFEFF"<>'\s]/g, '').toLowerCase();

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
    email,
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
      .filter(l => l.length > 15);

    const looksLikeVariationList =
      lines.length >= 2 &&
      lines.filter(l => /^(hi|hello|hey|your|good\s)/i.test(l)).length >= Math.ceil(lines.length * 0.6);

    if (looksLikeVariationList) {
      return shuffleArray([...new Set(lines)]);
    }
  }

  return [cleanRaw];
}

// 100% Exact Template & Subject (No words changed in your main text)
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

// Safe Primary-Inbox Footer:
// Keeps main template untouched while making every email's MIME body unique & compliant
function buildSafeInboxFooter(senderName, senderEmail, recipient) {
  const signOff = pickRandom([
    'Best regards,',
    'Kind regards,',
    'Warm regards,',
    'Best,',
    'Sincerely,',
    'Thanks & regards,'
  ]);

  const roleTitle = pickRandom([
    'Digital Outreach & Web Review',
    'Client Relations & Site Analysis',
    'Web Visibility Specialist',
    'Search & Digital Operations',
    'Business Development & Web Audit',
    'Online Presence Coordinator'
  ]);

  const targetRef = recipient.domain && !/gmail\.com|yahoo\.com|outlook\.com|hotmail\.com|icloud\.com|aol\.com/i.test(recipient.domain)
    ? recipient.domain
    : recipient.email;

  const politeNote = pickRandom([
    `Note: Sent as a one-time personal outreach to ${targetRef}. If this isn't relevant to you, simply reply "no thanks" and I won't follow up.`,
    `Direct note for ${recipient.firstName || targetRef}. If you prefer not to receive further notes from me, just reply "pass" and I'll update my notes.`,
    `This is a direct 1-to-1 message regarding ${targetRef}. Feel free to reply "not interested" if you'd rather I don't reach out again.`,
    `Personal inquiry sent to ${recipient.email}. If I reached the wrong person, please let me know and I will not message again.`,
    `Sent directly by ${senderName || 'our team'} for ${targetRef}. Reply "stop" anytime if you'd prefer no future follow-up.`
  ]);

  const displaySender = senderName || senderEmail.split('@')[0];

  const textFooter = `\n\n--\n${signOff}\n${displaySender}\n${roleTitle}\n${senderEmail}\n\n${politeNote}`;

  const htmlFooter = `<br><br><div style="color:#444444;font-size:13px;line-height:1.5;border-top:1px solid #eeeeee;padding-top:10px;margin-top:14px;">` +
    `<div>${signOff}<br><strong>${displaySender}</strong><br><span style="color:#666666;font-size:12px;">${roleTitle} &bull; <a href="mailto:${senderEmail}" style="color:#555555;text-decoration:none;">${senderEmail}</a></span></div>` +
    `<div style="color:#888888;font-size:11px;margin-top:8px;">${politeNote}</div>` +
    `</div>`;

  return { textFooter, htmlFooter };
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
  const { email, appPassword } = req.body;

  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: 'Credentials required' });
  }

  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  if (cleanPass.length !== 16) {
    return res.status(400).json({ success: false, message: 'App Password must be 16 characters' });
  }

  try {
    const transporter = getNativeTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP ready' });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error.message || 'SMTP Auth Failed. Check 16-char App Password.'
    });
  }
});

/* ==========================================================================
   4. NON-STOP STREAMING ROUTE (BLITZ SIZE = 4)
   ========================================================================== */
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
    try {
      res.write(': keep-alive\n\n');
    } catch (e) {
      // Ignored
    }
  }, 2500);

  const defaultSubject = '{Quick question|Site Overview|Quick note}';
  const defaultBody = `Your site looks great, but a small issue is keeping it from showing in the top results. Can I send a screenshot?`;

  const finalSubjectTemplate = (subject && subject.trim()) ? subject : defaultSubject;
  const rawBodyTemplate = (messageBody && messageBody.trim()) ? messageBody : defaultBody;

  let templateDeck = extractTemplateDeck(rawBodyTemplate);
  let deckIndex = 0;

  const transporter = getNativeTransporter(email, appPassword);
  const BLITZ_SIZE = 4;

  for (let i = 0; i < recipients.length; i += BLITZ_SIZE) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User' })}\n\n`);
      break;
    }

    const blitzBatch = recipients.slice(i, i + BLITZ_SIZE);

    const blitzTasks = blitzBatch.map(async (rawRecipient, idx) => {
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
          await new Promise(resolve => setTimeout(resolve, idx * 90));
        }

        // Exact subject and body without changing a single word
        const personalizedSubject = personalizeContent(finalSubjectTemplate, recipient);
        const personalizedBody = personalizeContent(selectedBodyLine, recipient);
        const isHtml = /<[a-z][\s\S]*>/i.test(personalizedBody);

        // Safe inbox footer appended cleanly below the message
        const { textFooter, htmlFooter } = buildSafeInboxFooter(cleanSenderName, cleanEmail, recipient);

        const fullPlainText = `${isHtml ? stripHtmlTags(personalizedBody) : personalizedBody}${textFooter}`;
        const fullHtmlBody = isHtml
          ? `<div dir="ltr">${personalizedBody}${htmlFooter}</div>`
          : `<div dir="ltr">${personalizedBody.replace(/\n/g, '<br>')}${htmlFooter}</div>`;

        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          subject: personalizedSubject,
          messageId: generateCleanMessageId(senderDomain),
          textEncoding: 'quoted-printable',
          text: fullPlainText,
          html: fullHtmlBody
        };

        await transporter.sendMail(mailOptions);

        const successData = { success: true, recipient: recipient.email, name: recipient.name };
        res.write(`data: ${JSON.stringify(successData)}\n\n`);

      } catch (err) {
        const failData = { success: false, recipient: recipient.email, error: err.message };
        res.write(`data: ${JSON.stringify(failData)}\n\n`);
      }
    });

    await Promise.allSettled(blitzTasks);

    if (i + BLITZ_SIZE < recipients.length && !globalSession.stopRequested) {
      await new Promise(resolve => setTimeout(resolve, 180));
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
  console.log(`🚀 Non-stop Blitz Mailer running on port ${PORT}`);
});

export default app;
