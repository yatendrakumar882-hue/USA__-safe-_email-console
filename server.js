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

// 1. Spintax Parser (Inbox Placement का सबसे बड़ा सीक्रेट)
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

// 2. Login Route (Y## पासवर्ड फिक्स)
app.post('/api/login', (req, res) => {
  const { password, pass } = req.body;
  const inputPass = password || pass;

  if (!inputPass) {
    return res.status(400).json({ success: false, message: 'कृपया पासवर्ड दर्ज करें।' });
  }

  if (inputPass.trim() === ACCESS_PASSWORD.trim()) {
    return res.json({ success: true, message: 'Access Granted' });
  } else {
    return res.status(401).json({ success: false, message: 'गलत पासवर्ड!' });
  }
});

// 3. Gmail High-Speed Transporter
function createTransporter(userEmail, appPassword) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: userEmail,
      pass: (appPassword || '').replace(/\s+/g, ''), // 16-अंकों का पासवर्ड
    },
    pool: true,
    maxConnections: 10,
    maxMessages: 100,
    rateLimit: 20
  });
}

// 4. Send Email API (Direct Inbox Ready)
app.post('/api/send', async (req, res) => {
  try {
    const {
      senderName,
      senderEmail,
      appPassword,
      subject,
      message,
      htmlMessage,
      recipients
    } = req.body;

    if (!senderEmail || !appPassword || !recipients) {
      return res.status(400).json({
        success: false,
        message: 'Sender Gmail, App Password और Recipients अनिवार्य हैं।'
      });
    }

    // Recipients list parse
    let recipientList = [];
    if (Array.isArray(recipients)) {
      recipientList = recipients;
    } else if (typeof recipients === 'string') {
      recipientList = recipients.split(/[\n,;]+/).map(r => r.trim()).filter(Boolean);
    }

    if (recipientList.length === 0) {
      return res.status(400).json({ success: false, message: 'कोई ईमेल नहीं मिला।' });
    }

    const transporter = createTransporter(senderEmail, appPassword);
    await transporter.verify();

    const results = [];
    const baseBody = htmlMessage || message || '';

    for (const recipient of recipientList) {
      try {
        // हर ईमेल के लिए Spintax और Name रैंडमाइज़ करें ताकि इनबॉक्स में जाए
        const recipientName = recipient.split('@')[0];
        let personalizedBody = baseBody
          .replace(/\{name\}/gi, recipientName)
          .replace(/\{email\}/gi, recipient);
        personalizedBody = parseSpintax(personalizedBody);

        let personalizedSubject = parseSpintax(subject || 'Notification');

        const mailOptions = {
          from: `"${senderName || senderEmail.split('@')[0]}" <${senderEmail}>`,
          to: recipient,
          replyTo: senderEmail,
          subject: personalizedSubject,
          text: personalizedBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
          html: personalizedBody.includes('<') ? personalizedBody : `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1e293b;">${personalizedBody.replace(/\n/g, '<br>')}</div>`,
          headers: {
            'Precedence': 'bulk',
            'X-Priority': '3',
            'List-Unsubscribe': `<mailto:${senderEmail}?subject=Unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
          }
        };

        const info = await transporter.sendMail(mailOptions);
        results.push({ email: recipient, status: 'Sent', messageId: info.messageId });
      } catch (err) {
        results.push({ email: recipient, status: 'Failed', error: err.message });
      }
    }

    const sentCount = results.filter(r => r.status === 'Sent').length;
    return res.json({
      success: true,
      message: `${sentCount}/${recipientList.length} ईमेल सफलतापूर्वक सेंड हो गए!`,
      details: results
    });

  } catch (error) {
    console.error('SMTP Error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'SMTP Server Error'
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
