const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "Y##";

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 1. Spintax Parser (Inbox Placement के लिए - हर ईमेल को अलग टेक्स्ट बनाता है)
function parseSpintax(text) {
  if (!text) return '';
  const spintaxRegex = /\{([^{}]+)\}/g;
  while (spintaxRegex.test(text)) {
    text = text.replace(spintaxRegex, (match, choices) => {
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
  }
  return text;
}

// 2. Gmail Transporter
let cachedTransporter = null;
let lastEmail = '';

function getTransporter(userEmail, appPassword) {
  const cleanPass = (appPassword || '').replace(/\s+/g, '');
  if (cachedTransporter && lastEmail === userEmail) {
    return cachedTransporter;
  }
  cachedTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // SSL Direct
    auth: {
      user: userEmail,
      pass: cleanPass,
    },
    tls: {
      rejectUnauthorized: true,
    }
  });
  lastEmail = userEmail;
  return cachedTransporter;
}

// 3. Login API Route (Password: Y##)
app.post('/api/login', (req, res) => {
  const inputPass = req.body.password || req.body.pass;
  if (!inputPass) {
    return res.status(400).json({ success: false, message: 'कृपया पासवर्ड दर्ज करें।' });
  }
  if (inputPass.trim() === ACCESS_PASSWORD.trim()) {
    return res.json({ success: true, message: 'Access Granted' });
  } else {
    return res.status(401).json({ success: false, message: 'गलत पासवर्ड!' });
  }
});

// 4. Send Single Email API (Live Counter & Direct Inbox Optimized)
app.post('/api/send-single', async (req, res) => {
  try {
    const {
      senderName,
      senderEmail,
      appPassword,
      subject,
      message,
      recipient
    } = req.body;

    if (!senderEmail || !appPassword || !recipient) {
      return res.status(400).json({ success: false, message: 'फ़ील्ड्स अधूरी हैं।' });
    }

    const transporter = getTransporter(senderEmail, appPassword);
    const targetEmail = recipient.trim();
    const recipientUser = targetEmail.split('@')[0];

    // Spintax & Name Personalization
    let cleanBody = parseSpintax(message || '')
      .replace(/\{name\}/gi, recipientUser)
      .replace(/\{email\}/gi, targetEmail);

    let cleanSubject = parseSpintax(subject || 'Inquiry');

    // Clean 1-on-1 Personal Mail Format (कोई अनसब्सक्राइब या प्रोमोशन लिंक नहीं)
    const mailOptions = {
      from: `"${senderName || senderEmail.split('@')[0]}" <${senderEmail}>`,
      to: targetEmail,
      replyTo: senderEmail,
      subject: cleanSubject,
      text: cleanBody,
      headers: {
        'Date': new Date().toUTCString(),
        'X-Mailer': 'Apple Mail (2.3654.120.0.1)',
        'X-Priority': '3',
      }
    };

    const info = await transporter.sendMail(mailOptions);
    return res.json({
      success: true,
      message: 'Sent',
      id: info.messageId
    });

  } catch (error) {
    console.error('Send error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'SMTP Error'
    });
  }
});

// Root Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[✓] Server is running on port ${PORT}`);
});

module.exports = app;
