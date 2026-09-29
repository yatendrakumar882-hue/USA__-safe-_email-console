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

// Direct Port 587 Transporter (1 Batch = 6 Emails, Auto Pool Cleanup)
function getInboxTransporter(email, appPassword, forceReset = false) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const senderDomain = cleanEmail.includes('@') ? cleanEmail.split('@')[1] : 'gmail.com';
  const key = `inbox6_${cleanEmail}_${cleanPass}`;

  // Clean up old account pools when switching Gmail IDs
  for (const [existingKey, existingTransporter] of poolMap.entries()) {
    if (existingKey !== key || forceReset) {
      try { existingTransporter.close(); } catch {}
      poolMap.delete(existingKey);
    }
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
      maxConnections: 6, // 1 Batch = 6 Emails
      maxMessages: 24,   // Fresh connection socket every 24 emails
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

// THE PROVEN INBOX ENGINE:
// Automatically neutralizes spam-flagged phrases and builds unique human messages
function buildUniqueHumanMessage(rawTemplate, recipient, senderName) {
  if (!rawTemplate) return '';

  const isHtml = /<[a-z][\s\S]*>/i.test(rawTemplate);
  let selectedTemplate = String(rawTemplate).trim();

  // If multiple template lines are pasted, pick 1 random line per recipient
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

  const fallbackName = recipient.firstName || recipient.name || 'there';
  content = content.replace(/{Name}/gi, recipient.name || fallbackName);
  content = content.replace(/{FirstName}/gi, recipient.firstName || fallbackName);
  content = content.replace(/{First_Name}/gi, recipient.firstName || fallbackName);
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);

  // 1. Rotate opening website compliment
  content = content.replace(
    /\b(Your website|Your site)\s+(looks|appears|seems|is)\s+(great|good|solid|impressive|appealing|attractive|polished|refined|modern|clean|organized|excellent|well built|engaging|balanced|structured|neat)\b/gi,
    () => {
      const noun = pickRandom([
        'Your website',
        'Your site',
        'Your web page',
        'The design of your site'
      ]);
      const verb = pickRandom(['looks', 'appears', 'seems', 'is']);
      const adj = pickRandom([
        'really great', 'impressive', 'well-built', 'very clean', 'modern',
        'polished', 'solid', 'well-organized', 'appealing', 'excellent',
        'neat', 'refined', 'well-structured', 'sharp'
      ]);
      return `${noun} ${verb} ${adj}`;
    }
  );

  // 2. Replace blacklisted "not showing on page one / Google's top results" with Proven Inbox-Safe Phrases
  content = content.replace(
    /(,?\s*(yet|but)\s+(it is not showing on page one|it does not showing on page one|an? error is keeping it out of Google's top results|an? error is stopping it from showing up on the top results))/gi,
    () => {
      const conn = pickRandom([', but', ', yet', '—however,', ', though']);
      const phrase = pickRandom([
        'a small issue is keeping it from appearing in the initial search view',
        'a minor technical issue is holding it back from the main search results',
        'it is currently missing from the top organic spots due to a small issue',
        'a small configuration issue is preventing it from surfacing higher up',
        'it is sitting just outside the primary search view right now',
        'a minor indexing issue is keeping it from showing up where it should',
        'a small on-page issue is holding back its visibility in search',
        'it is not coming up in the main search view yet because of a small issue',
        'a quick fixable issue is keeping it from appearing in the top spots',
        'it is being held back from the primary results by a minor issue'
      ]);
      return `${conn} ${phrase}`;
    }
  );

  // Fallback for standalone phrase
  content = content.replace(
    /(not showing on page one|does not showing on page one|keeping it out of Google's top results|stopping it from showing up on the top results)/gi,
    () => pickRandom([
      'not appearing in the initial search view',
      'missing from the top organic spots',
      'held back from the primary search results',
      'not coming up in the main results yet',
      'sitting just outside the top search view',
      'not surfacing where it should be in search'
    ])
  );

  // 3. Replace blacklisted "Can I send a screen shot?" with Proven Inbox-Safe Questions
  content = content.replace(
    /(Can|May) I (send|email)( you)? (a |the )?screen\s*shot\??\.?/gi,
    () => pickRandom([
      'Would you mind if I shared a quick note on what I noticed?',
      'Let me know if I can send over the details I found.',
      'Happy to share a quick breakdown if you are open to it.',
      'Should I send over what I spotted on my end?',
      'Mind if I forward the details over to you?',
      'Let me know if you would like me to share what I found.',
      'Can I send over a quick capture of what I spotted?',
      'Would it be okay if I shared the details with you?'
    ])
  );

  content = content.replace(
    /Can I sent quote\.?/gi,
    () => pickRandom([
      'Let me know if I can share a few details.',
      'Happy to send over more info if helpful.',
      'Would you be open to seeing what I found?'
    ])
  );

  // 4. Add recipient's FirstName naturally to greeting so every email has a unique opening hash
  if (recipient.firstName && !content.toLowerCase().includes(recipient.firstName.toLowerCase())) {
    if (/^(Hello!|Hi!|Hey,|Hello,|Hi,)/i.test(content)) {
      content = content.replace(/^(Hello!|Hi!|Hey,|Hello,|Hi,)/i, (match) => {
        const cleanGreet = match.replace(/[!.,]/g, '');
        return `${cleanGreet} ${recipient.firstName},\n\n`;
      });
    } else {
      const greet = pickRandom(['Hi', 'Hello', 'Hey']);
      content = `${greet} ${recipient.firstName},\n\n${content}`;
    }
  }

  // 5. Natural human sign-off (No robotic footer)
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

// Ensures Subject Line never triggers bulk duplicate hash filter across 100 emails
function buildInboxSafeSubject(rawSubject, recipient) {
  let base = rawSubject ? parseSpintax(rawSubject).trim() : '';
  const fallback = recipient.firstName || recipient.name || '';

  if (base) {
    base = base.replace(/{Name}/gi, recipient.name || fallback || '');
    base = base.replace(/{FirstName}/gi, recipient.firstName || fallback || '');
    base = base.replace(/{First_Name}/gi, recipient.firstName || fallback || '');
    base = base.replace(/{Email}/gi, recipient.email);
    base = base.replace(/{Domain}/gi, recipient.domain);
  }

  const namePart = recipient.firstName ? `for ${recipient.firstName}` : '';
  const prefixName = recipient.firstName ? `${recipient.firstName} - ` : '';

  if (!base) {
    return pickRandom(
