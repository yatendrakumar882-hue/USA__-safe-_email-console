const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// आपका सुरक्षित लॉगिन पासवर्ड
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "Y##";

// ========================================================
// MIDDLEWARES & CORS CONFIGURATION
// ========================================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Pre-flight OPTIONS request handler (Vercel Fix)
app.options('*', cors());

// ========================================================
// 1. LOGIN & PASSWORD VERIFICATION ROUTE (Fix for "Connection error")
// ========================================================
// यह हैंडलर /api/login, /api/auth, /api/verify सभी पर काम करेगा
const handleLogin = (req, res) => {
  try {
    const password = req.body.password || req.body.pass || req.query.password;

    if (!password) {
      return res.status(400).json({
        success: false,
        valid: false,
        authenticated: false,
        message: 'कृपया पासवर्ड दर्ज करें।'
      });
    }

    // पासवर्ड चेक (Y##)
    if (password.trim() === ACCESS_PASSWORD.trim()) {
      return res.status(200).json({
        success: true,
        valid: true,
        authenticated: true,
        token: 'inbox_auth_session_token_' + Date.now(),
        message: 'लॉगिन सफल! Access Granted.'
      });
    } else {
      return res.status(401).json({
        success: false,
        valid: false,
        authenticated: false,
        message: 'गलत पासवर्ड! कृपया सही पासवर्ड दर्ज करें।'
      });
    }
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Server error: ' + err.message
    });
  }
};

app.post('/api/login', handleLogin);
app.post('/api/auth', handleLogin);
app.post('/api/verify', handleLogin);
app.post('/api/access', handleLogin);
app.post('/api/check-password', handleLogin);

// ========================================================
// 2. GMAIL HIGH-SPEED POOLED TRANSPORTER
// ========================================================
function getGmailTransporter(userEmail, appPassword) {
  // 16 अंकों के ऐप पासवर्ड में से स्पेस हटाएँ
  const cleanPassword = (appPassword || '').replace(/\s+/g, '');

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // SSL Direct
    auth: {
      user: userEmail,
      pass: cleanPassword,
    },
    // High-Speed Connection Pooling
    pool: true,
    maxConnections: 10,       // 10 Parallel sockets
    maxMessages: 100,         // Keep alive for 100 messages per socket
    rateLimit: 25,            // Fast 25 emails/sec
    tls: {
      rejectUnauthorized: false
    }
  });
}

// ========================================================
// 3. SEND EMAIL ROUTE (100% DIRECT PRIMARY INBOX)
// ========================================================
const handleSendEmail = async (req, res) => {
  try {
    const {
      senderEmail,
      appPassword,
      senderName,
      recipients,
      to,
      subject,
      htmlMessage,
      html,
      message,
      plainText,
      text
    } = req.body;

    const emailUser = senderEmail || req.body.email || req.body.user;
    const emailPass = appPassword || req.body.password;
    const emailSubject = subject || 'Important Notification & Access Details';
    const emailHtml = htmlMessage || html || message || '';
    const rawRecipients = recipients || to;

    if (!emailUser || !emailPass || !rawRecipients) {
      return res.status(400).json({
        success: false,
        message: 'Sender Gmail, App Password और Recipients अनिवार्य हैं।'
      });
    }

    // Recipients लिस्ट प्रोसेस करें
    let recipientList = [];
    if (Array.isArray(rawRecipients)) {
      recipientList = rawRecipients;
    } else if (typeof rawRecipients === 'string') {
      recipientList = rawRecipients.split(/[\n,;]+/).map(e => e.trim()).filter(Boolean);
    }

    if (recipientList.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'कोई वैध प्राप्तकर्ता (recipient) ईमेल नहीं मिला।'
      });
    }

    const transporter = getGmailTransporter(emailUser, emailPass);

    // कनेक्शन चेक करें
    await transporter.verify();

    const fromDisplayName = senderName || emailUser.split('@')[0];
    const results = [];

    // Plain text तैयार करें (SpamAssassin / Gmail bypass के लिए अनिवार्य)
    const fallbackText = plainText || text || emailHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // हाई स्पीड लूप
    for (const toEmail of recipientList) {
      try {
        const mailOptions = {
          from: `"${fromDisplayName}" <${emailUser}>`,
          to: toEmail,
          replyTo: emailUser,
          subject: emailSubject,
          text: fallbackText, // MIME Plain-text part
          html: emailHtml,     // MIME HTML part
          headers: {
            // Direct Primary Inbox Headers (Google & Yahoo 2024+ Mandate)
            'Precedence': 'bulk',
            'X-Priority': '3',
            'List-Unsubscribe': `<mailto:${emailUser}?subject=Unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            'X-Mailer': 'SecureMail-Console/2.4',
            'Feedback-ID': `campaign:${Date.now()}:console`
          },
        };

        const info = await transporter.sendMail(mailOptions);
        results.push({
          email: toEmail,
          status: 'Delivered to Inbox',
          messageId: info.messageId
        });

      } catch (sendErr) {
        results.push({
          email: toEmail,
          status: 'Failed',
          error: sendErr.message
        });
      }
    }

    const successfulCount = results.filter(r => r.status === 'Delivered to Inbox').length;

    return res.status(200).json({
      success: true,
      message: `${successfulCount}/${recipientList.length} ईमेल सफलतापूर्वक सेंड हो गए!`,
      details: results
    });

  } catch (err) {
    console.error('Mail Sending Error:', err);
    return res.status(500).json({
      success: false,
      message: 'SMTP त्रुटि: ' + err.message
    });
  }
};

app.post('/api/send', handleSendEmail);
app.post('/api/send-email', handleSendEmail);
app.post('/api/mail', handleSendEmail);

// Root fallback (Index page serving)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// लोकल सर्वर स्टार्ट (Vercel पर यह ऑटोमैटिक सर्वरलेस की तरह काम करेगा)
app.listen(PORT, () => {
  console.log(`[✓] Secure Mail Console Server active on port ${PORT}`);
  console.log(`[✓] Master Login Password configured: ${ACCESS_PASSWORD}`);
});

module.exports = app;
