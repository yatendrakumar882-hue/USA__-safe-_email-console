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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 1. Spintax Parser (इनबॉक्स डिलीवरी के लिए)
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

// 2. Transporter Cache (कनेक्शन रीयूज़ से स्पीड बहुत तेज़ रहेगी)
let cachedTransporter = null;
let lastUserEmail = '';

function getTransporter(userEmail, appPassword) {
  const cleanPass = (appPassword || '').replace(/\s+/g, '');
  if (cachedTransporter && lastUserEmail === userEmail) {
    return cachedTransporter;
  }
  cachedTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: userEmail,
      pass: cleanPass,
    },
    pool: true,
    maxConnections: 10,
    maxMessages: 200,
  });
  lastUserEmail = userEmail;
  return cachedTransporter;
}

// 3. Login Verification API (Password: Y##)
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

// 4. Send Single Email API (लाइव काउंटर के लिए प्रति-ईमेल एंडपॉइंट)
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
      return res.status(400).json({ success: false, message: 'ज़रूरी फ़ील्ड्स गायब हैं।' });
    }

    const transporter = getTransporter(senderEmail, appPassword);
    const recipientClean = recipient.trim();
    const recipientName = recipientClean.split('@')[0];

    // Spintax & Personalization
    let body = parseSpintax(message || '')
      .replace(/\{name\}/gi, recipientName)
      .replace(/\{email\}/gi, recipientClean);
    let emailSubject = parseSpintax(subject || 'Inquiry');

    // 100% Direct Inbox Mail Options: कोई अनसब्सक्राइब या प्रोमोशन लिंक नहीं जोड़ा गया है
    const mailOptions = {
      from: `"${senderName || senderEmail.split('@')[0]}" <${senderEmail}>`,
      to: recipientClean,
      replyTo: senderEmail,
      subject: emailSubject,
      text: body, // Pure clean text as requested
      headers: {
        'X-Mailer': 'Apple Mail (2.3654.120.0.1)',
        'X-Priority': '3',
      }
    };

    const info = await transporter.sendMail(mailOptions);
    return res.json({
      success: true,
      message: 'Sent',
      messageId: info.messageId
    });

  } catch (error) {
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
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
