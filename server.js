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

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ==========================================================================
   1. CLEAN DIRECT GMAIL TRANSPORTER
   ========================================================================== */
function closeAllPools() {
  for (const [key, transporter] of poolMap.entries()) {
    try {
      transporter.close();
    } catch (e) {
      // Ignore
    }
    poolMap.delete(key);
  }
}

function getNativeTransporter(email, appPassword, forceFresh = false) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const key = `native_${cleanEmail}_${cleanPass}`;

  for (const [existingKey, existingTransporter] of poolMap.entries()) {
    if (existingKey !== key || forceFresh) {
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
      port: 587,
      secure: false,
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

/* ==========================================================================
   2. RECIPIENT PARSER & FRESH INBOX VARIATION ENGINE
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

function shuffleWithoutBoundaryRepeat(array, lastUsedItem = null) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  if (arr.length > 1 && lastUsedItem && arr[0] === lastUsedItem) {
    const swapIdx = 1 + Math.floor(Math.random() * (arr.length - 1));
    [arr[0], arr[swapIdx]] = [arr[swapIdx], arr[0]];
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
      const uniqueLines = [...new Set(lines)];
      return shuffleWithoutBoundaryRepeat(uniqueLines);
    }
  }

  return [cleanRaw];
}

// Replaces yesterday's burned phrases with fresh, unflagged conversational equivalents
function buildFreshInboxBody(templateStr, recipient) {
  if (!templateStr) return '';
  let content = parseSpintax(templateStr);

  const displayName = recipient.name || recipient.firstName || 'there';
  const displayFirstName = recipient.firstName || displayName;

  content = content.replace(/{Name}/gi, displayName);
  content = content.replace(/{FirstName}/gi, displayFirstName);
  content = content.replace(/{First_Name}/gi, displayFirstName);
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);

  // Refresh opening compliment so yesterday's exact text hash is never repeated
  content = content.replace(
    /\b(Your website|Your site)\s+(looks|appears|seems|is)\s+(great|good|solid|impressive|appealing|attractive|polished|refined|modern|clean|organized|excellent|well built|engaging|balanced|structured|neat)\b/gi,
    () => {
      const p1 = pickRandom(['Your website', 'Your site', 'Your web page', 'The layout of your site']);
      const p2 = pickRandom(['looks', 'appears', 'seems', 'is']);
      const p3 = pickRandom([
        'really well put together',
        'very clean and modern',
        'well-built',
        'great overall',
        'neat and well-structured',
        'solid and well-organized',
        'polished and clean'
      ]);
      return `${p1} ${p2} ${p3}`;
    }
  );

  // Refresh burned "page one / Google's top results" phrase
  content = content.replace(
    /(,?\s*(yet|but)\s+(it is not showing on page one|it does not showing on page one|an? error is keeping it out of Google's top results|an? error is stopping it from showing up on the top results))/gi,
    () => {
      const conj = pickRandom([', but', ', yet', '—however,', ', though']);
      const mid = pickRandom([
        'I noticed a small technical detail holding back its visibility in search',
        'there is a minor indexing issue keeping it from showing up where it should',
        'a small on-page issue is preventing it from surfacing in the main results',
        'I spotted a minor site issue that is holding it back from the primary search view',
        'a quick fixable detail is keeping it just outside the main search results',
        'there is a small configuration issue affecting how it appears in search'
      ]);
      return `${conj} ${mid}`;
    }
  );

  // Refresh burned "Can I send a screen shot?" phrase
  content = content.replace(
    /(Can|May) I (send|email)( you)? (a |the )?screen\s*shot\??\.?/gi,
    () => pickRandom([
      'Would you mind if I sent over a quick note on what I noticed?',
      'Let me know if I can share the details I spotted with you.',
      'Mind if I forward over a quick visual of what I found?',
      'Should I send over a quick breakdown of what I noticed on my end?',
      'Would it be okay if I shared a quick note showing where the issue is?',
      'Let me know if you would like me to send over what I found.'
    ])
  );

  return content.trim();
}

function buildFreshInboxSubject(rawSubject, recipient) {
  let content = rawSubject ? parseSpintax(rawSubject).trim() : '';
  const displayName = recipient.name || recipient.firstName || '';
  const displayFirstName = recipient.firstName || displayName;

  if (content) {
    content = content.replace(/{Name}/gi, displayName);
    content = content.replace(/{FirstName}/gi, displayFirstName);
    content = content.replace(/{First_Name}/gi, displayFirstName);
    content = content.replace(/{Email}/gi, recipient.email);
    content = content.replace(/{Domain}/gi, recipient.domain);
    return content;
  }

  return pickRandom([
    displayFirstName ? `Quick question for ${displayFirstName}` : 'Quick question regarding your site',
    'Small detail I noticed on your website',
    'Quick note about your site',
    displayFirstName ? `Checking in, ${displayFirstName}` : 'Quick observation on your website'
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
    const transporter = getNativeTransporter(email, appPassword, true);
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
  const cleanSenderName = (senderName || '').replace(/["\r\n]/g, '').trim();
  globalSession.stopRequested = false;

  const keepAlivePing = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (e) {
      // Ignored
    }
  }, 2500);

  const seenEmails = new Set();
  const uniqueRecipients = [];
  for (const item of recipients) {
    const parsed = parseRecipientData(item);
    if (parsed.email && parsed.email.includes('@') && !seenEmails.has(parsed.email)) {
      seenEmails.add(parsed.email);
      uniqueRecipients.push(parsed);
    }
  }

  const defaultBody = `Your website looks great, but a small issue is keeping it from showing in the top results. Can I send a screenshot?`;
  const rawBodyTemplate = (messageBody && messageBody.trim()) ? messageBody : defaultBody;

  let templateDeck = extractTemplateDeck(rawBodyTemplate);
  let deckIndex = 0;
  let lastTemplateUsed = null;

  const transporter = getNativeTransporter(email, appPassword, true);
  const BLITZ_SIZE = 4;

  for (let i = 0; i < uniqueRecipients.length; i += BLITZ_SIZE) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User' })}\n\n`);
      break;
    }

    const blitzBatch = uniqueRecipients.slice(i, i + BLITZ_SIZE);

    const blitzTasks = blitzBatch.map(async (recipient, idx) => {
      if (globalSession.stopRequested) return;

      if (deckIndex >= templateDeck.length) {
        templateDeck = shuffleWithoutBoundaryRepeat(templateDeck, lastTemplateUsed);
        deckIndex = 0;
      }
      const selectedBodyLine = templateDeck[deckIndex++];
      lastTemplateUsed = selectedBodyLine;

      try {
        if (idx > 0) {
          await new Promise(resolve => setTimeout(resolve, idx * 110));
        }

        const personalizedSubject = buildFreshInboxSubject(subject, recipient);
        const personalizedBody = buildFreshInboxBody(selectedBodyLine, recipient);
        const isHtml = /<[a-z][\s\S]*>/i.test(personalizedBody);

        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          replyTo: cleanEmail,
          subject: personalizedSubject,
          text: isHtml ? stripHtmlTags(personalizedBody) : personalizedBody
        };

        if (isHtml) {
          mailOptions.html = `<div dir="ltr">${personalizedBody}</div>`;
        }

        await transporter.sendMail(mailOptions);

        const successData = { success: true, recipient: recipient.email, name: recipient.name };
        res.write(`data: ${JSON.stringify(successData)}\n\n`);

      } catch (err) {
        const failData = { success: false, recipient: recipient.email, error: err.message };
        res.write(`data: ${JSON.stringify(failData)}\n\n`);
      }
    });

    await Promise.allSettled(blitzTasks);

    if (i + BLITZ_SIZE < uniqueRecipients.length && !globalSession.stopRequested) {
      await new Promise(resolve => setTimeout(resolve, 250));
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
