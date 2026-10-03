const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "Y##";

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Spintax फ़ंक्शन: हर ईमेल को अलग बनाता है
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

// Transporter Cache
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
    secure: true,
    auth: {
      user: userEmail,
      pass: cleanPass,
    },
    // Gmail के लिए सुरक्षित कनेक्शन सेटिंग्स
    tls: {
      rejectUnauthorized: true,
    }
  });
  lastEmail = userEmail;
  return cachedTransporter;
}

// लॉगिन रूट
app.post('/api/login', (req, res) => {
  const inputPass = req.body.password || req.body.pass;
  if (!inputPass) return res.status(400).json({ success: false, message: 'पासवर्ड आवश्यक है।' });
  if (inputPass.trim() === ACCESS_PASSWORD.trim()) {
    return res.json({ success: true, message: 'Access Granted' });
  }
  return res.status(401).json({ success: false, message: 'गलत पासवर्ड!' });
});

// सिंगल ईमेल सेंड एंडपॉइंट (स्पैम बाईपास हेडर के साथ)
app.post('/api/send-single', async (req, res) => {
  try {
    const { senderName, senderEmail, appPassword, subject, message, recipient } = req.body;

    if (!senderEmail || !appPassword || !recipient) {
      return res.status(400).json({ success: false, message: 'फ़ील्ड्स अधूरी हैं।' });
    }

    const transporter = getTransporter(senderEmail, appPassword);
    const targetEmail = recipient.trim();
    const recipientUser = targetEmail.split('@')[0];

    // नाम और स्पिनटैक्स प्रोसेस करें
    let cleanBody = parseSpintax(message || '')
      .replace(/\{name\}/gi, recipientUser)
      .replace(/\{email\}/gi, targetEmail);

    let cleanSubject = parseSpintax(subject || 'Important Information');

    // प्राकृतिक ईमेल संरचना (बिना किसी सस्पेक्टेड हेडर के)
    const mailOptions = {
      from: `"${senderName || senderEmail.split('@')[0]}" <${senderEmail}>`,
      to: targetEmail,
      replyTo: senderEmail,
      subject: cleanSubject,
      text: cleanBody,
      headers: {
        'Date': new Date().toUTCString(),
        'X-Entity-Ref-ID': `${Date.now()}-${Math.random().toString(36).substring(7)}`,
      }
    };

    const info = await transporter.sendMail(mailOptions);
    return res.json({ success: true, message: 'Sent', id: info.messageId });

  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server ready on port ${PORT}`);
});

module.exports = app;
