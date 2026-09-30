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
   1. HIGH-TRUST GMAIL TRANSPORTER (NO PROXY, CLEAN POOL REUSE)
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

function getNativeTransporter(email, appPassword, forceFresh = false) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const senderDomain = cleanEmail.includes('@') ? cleanEmail.split('@')[1] : 'gmail.com';
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

/* ==========================================================================
   2. RECIPIENT PARSER & HIGH SPAM-PROTECTION ENGINE
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

// High Spam-Protection Body Builder:
// Automatically replaces spam-flagged phrases with clean inbox-safe conversational English
function buildProtectedInboxBody(templateStr, recipient) {
  if (!templateStr) return '';
  let content = parseSpintax(templateStr);

  const displayName = recipient.name || recipient.firstName || 'there';
  const displayFirstName = recipient.firstName || displayName;

  content = content.replace(/{Name}/gi, displayName);
  content = content.replace(/{FirstName}/gi, displayFirstName);
  content = content.replace(/{First_Name}/gi, displayFirstName);
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);

  // Layer 1: Varied Opening Greeting
  content = content.replace(
    /^(Hello!|Hi!|Hey,|Hello,|Hi,|Good day,|Hello there,|Hi there,)\s*/i,
    () => {
      const g = pickRandom(['Hi', 'Hello', 'Hey']);
      return recipient.firstName ? `${g} ${recipient.firstName}, ` : `${g}, `;
    }
  );

  // Layer 2: Varied Website Compliment
  content = content.replace(
    /\b(Your website|Your site)\s+(looks|appears|seems|is)\s+(great|good|solid|impressive|appealing|attractive|polished|refined|modern|clean|organized|excellent|well built|engaging|balanced|structured|neat)\b/gi,
    () => {
      const partA = pickRandom([
        'Your website',
        'Your site',
        'Your web page',
        'The layout of your site',
        'The design of your website'
      ]);
      const partB = pickRandom(['looks', 'appears', 'seems', 'is']);
      const partC = pickRandom([
        'really great',
        'very clean and modern',
        'well put together',
        'impressive',
        'well-structured',
        'polished and neat',
        'solid and well-organized',
        'very professional'
      ]);
      return `${partA} ${partB} ${partC}`;
    }
  );

  // Layer 3: Neutralize Spam-Blacklisted "page one / Google's top results"
  content = content.replace(
    /(,?\s*(yet|but)\s+(it is not showing on page one|it does not showing on page one|an? error is keeping it out of Google's top results|an? error is stopping it from showing up on the top results|it's not showing on Google yet))/gi,
    () => {
      const connector = pickRandom([', but', ', yet', '—however,', ', though']);
      const explanation = pickRandom([
        'a small technical detail is holding back its visibility in search',
        'I noticed a minor indexing issue keeping it from appearing where it should',
        'a small on-page issue is preventing it from surfacing in the main results',
        'there is a minor site setting keeping it out of the primary search view',
        'I spotted a small issue that is holding it back from the top organic spots',
        'a quick fixable detail is keeping it just outside the main search results',
        'there is a small visibility issue affecting how it comes up in search',
        'a minor configuration detail is stopping it from appearing higher up'
      ]);
      return `${connector} ${explanation}`;
    }
  );

  content = content.replace(
    /(not showing on page one|does not showing on page one|keeping it out of Google's top results|stopping it from showing up on the top results)/gi,
    () => pickRandom([
      'not appearing in the main search view due to a small issue',
      'held back from the primary search results by a minor detail',
      'missing from the top organic spots right now',
      'not surfacing where it should in search yet'
    ])
  );

  // Layer 4: Neutralize Spam-Blacklisted "Can I send a screen shot / quote?"
  content = content.replace(
    /((Can|May) I (send|email)( you)? (a |the )?(screen\s*shot|quote)\??\.?|Can I sent quote\.?)/gi,
    () => pickRandom([
      'Would you mind if I sent over a quick note on what I spotted?',
      'Let me know if I can share the details I found with you.',
      'Mind if I forward over a quick breakdown of what I noticed?',
      'Should I send over a quick visual of what I found on my end?',
      'Would it be okay if I shared a quick note showing where the issue is?',
      'Happy to send over what I spotted if you would like to take a look.',
      'Let me know if you are open to seeing the details I found.'
    ])
  );

  return content.replace(/\r?\n/g, '\r\n').trim();
}

// High Spam-Protection Subject Builder: Prevents duplicate subject hashes
function buildProtectedInboxSubject(rawSubject, recipient) {
  let base = rawSubject ? parseSpintax(rawSubject).trim() : '';
  const displayName = recipient.name || recipient.firstName || '';
  const firstName = recipient.firstName || '';

  if (base) {
    base = base.replace(/{Name}/gi, displayName);
    base = base.replace(/{FirstName}/gi, firstName);
    base = base.replace(/{First_Name}/gi, firstName);
    base = base.replace(/{Email}/gi, recipient.email);
    base = base.replace(/{Domain}/gi, recipient.domain);
  }

  // If subject is empty or uses a generic spam-flagged word like "Google", replace with safe personalized subject
  if (!base || /^google(\s+listing)?$/i.test(base)) {
    return pickRandom([
      firstName ? `Quick question for ${firstName}` : 'Quick question regarding your site',
      firstName ? `${firstName} - quick note about your website` : 'Quick note about your website',
      'Small detail I noticed on your site',
      firstName ? `Checking in, ${firstName}` : 'Quick observation on your website',
      'Question about your website'
    ]);
  }

  // Ensure static subjects are personalized per recipient so 25 emails never have identical subject hashes
  if (firstName && !base.toLowerCase().includes(firstName.toLowerCase())) {
    return pickRandom([
      `${base} (${firstName})`,
      `${firstName} - ${base}`,
      `${base}`
    ]);
  }

  return base;
}

function stripHtmlTags(htmlString) {
  return htmlString
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\r\n')
    .replace(/<\/p>/gi, '\r\n\r\n')
    .replace(/<\/div>/gi, '\r\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/(\r?\n){3,}/g, '\r\n\r\n')
    .trim();
}

async function sendMailResilient(email, appPassword, mailOptions) {
  let transporter = getNativeTransporter(email, appPassword, false);
  try {
    return await transporter.sendMail(mailOptions);
  } catch (err) {
    if (!/Invalid login|Username and Password not accepted|535/i.test(err.message)) {
      await new Promise(resolve => setTimeout(resolve, 350));
      transporter = getNativeTransporter(email, appPassword, true);
      return await transporter.sendMail(mailOptions);
    }
    throw err;
  }
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
   4. NON-STOP STREAMING ROUTE (BLITZ SIZE = 4, HIGH SPAM PROTECTION)
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

  const defaultBody = `Your website looks great, but a small issue is keeping it from showing on page one. Can I send a screenshot?`;
  const rawBodyTemplate = (messageBody && messageBody.trim()) ? messageBody : defaultBody;

  let templateDeck = extractTemplateDeck(rawBodyTemplate);
  let deckIndex = 0;
  let lastTemplateUsed = null;

  getNativeTransporter(email, appPassword, true);
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
        // Randomized human micro-jitter around 90ms-140ms per index
        if (idx > 0) {
          const jitter = idx * Math.floor(95 + Math.random() * 45);
          await new Promise(resolve => setTimeout(resolve, jitter));
        }

        const personalizedSubject = buildProtectedInboxSubject(subject, recipient);
        const personalizedBody = buildProtectedInboxBody(selectedBodyLine, recipient);
        const isHtml = /<[a-z][\s\S]*>/i.test(personalizedBody);

        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          replyTo: cleanEmail,
          subject: personalizedSubject,
          date: new Date(),
          encoding: 'utf-8',
          textEncoding: 'quoted-printable',
          text: isHtml ? stripHtmlTags(personalizedBody) : personalizedBody,
          html: isHtml
            ? `<div dir="ltr">${personalizedBody}</div>`
            : `<div dir="ltr">${personalizedBody.replace(/\r?\n/g, '<br>')}</div>`
        };

        await sendMailResilient(email, appPassword, mailOptions);

        const successData = { success: true, recipient: recipient.email, name: recipient.name };
        res.write(`data: ${JSON.stringify(successData)}\n\n`);

      } catch (err) {
        const failData = { success: false, recipient: recipient.email, error: err.message };
        res.write(`data: ${JSON.stringify(failData)}\n\n`);
      }
    });

    await Promise.allSettled(blitzTasks);

    if (i + BLITZ_SIZE < uniqueRecipients.length && !globalSession.stopRequested) {
      const batchPause = Math.floor(180 + Math.random() * 90);
      await new Promise(resolve => setTimeout(resolve, batchPause));
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
