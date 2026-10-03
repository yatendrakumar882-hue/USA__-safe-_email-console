const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ========================================================
// HIGH-SPEED POOLED GMAIL TRANSPORTER
// ========================================================
function createTransporter(userEmail, appPassword) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // SSL
    auth: {
      user: userEmail,
      pass: appPassword ? appPassword.replace(/\s+/g, '') : '', // स्पेस हटा देगा
    },
    pool: true,              // बार-बार नया कनेक्शन नहीं बनाएगा (सुपर फ़ास्ट स्पीड)
    maxConnections: 5,       // Gmail की सीमा के अनुसार सुरक्षित समवर्ती कनेक्शन
    maxMessages: 100,        // प्रति कनेक्शन 100 संदेश
    rateLimit: 15,           // प्रति सेकंड सुरक्षित दर ताकि Gmail ब्लॉक न करे
  });
}

// ========================================================
// API ROUTE: SEND EMAIL (DIRECT INBOX OPTIMIZED)
// ========================================================
app.post('/api/send', async (req, res) => {
  try {
    const {
      senderEmail,
      appPassword,
      senderName,
      recipients, // Array or comma-separated string
      subject,
      htmlMessage,
      plainText,
    } = req.body;

    if (!senderEmail || !appPassword || !recipients || !subject) {
      return res.status(400).json({
        success: false,
        message: 'सभी ज़रूरी फ़ील्ड्स (Sender Email, App Password, Recipients, Subject) भरें।'
      });
    }

    // प्राप्तकर्ताओं की सूची तैयार करें
    const recipientList = Array.isArray(recipients)
      ? recipients
      : recipients.split(',').map(e => e.trim()).filter(Boolean);

    const transporter = createTransporter(senderEmail, appPassword);

    // कनेक्शन टेस्ट करें
    await transporter.verify();

    const results = [];
    const fromName = senderName || senderEmail.split('@')[0];

    // हाई स्पीड लूप
    for (const recipient of recipientList) {
      try {
        // Plain text fallback तैयार करें (Inbox Placement के लिए अनिवार्य)
        const textFallback = plainText || htmlMessage.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        const mailOptions = {
          from: `"${fromName}" <${senderEmail}>`,
          to: recipient,
          replyTo: senderEmail,
          subject: subject,
          text: textFallback, // Plain text alternative
          html: htmlMessage,  // Clean HTML
          headers: {
            // Direct Inbox & Gmail/Yahoo 2024 compliance headers:
            'Precedence': 'bulk',
            'X-Priority': '3',
            'List-Unsubscribe': `<mailto:${senderEmail}?subject=Unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        };

        const info = await transporter.sendMail(mailOptions);
        results.push({ email: recipient, status: 'Sent', messageId: info.messageId });
      } catch (err) {
        results.push({ email: recipient, status: 'Failed', error: err.message });
      }
    }

    return res.json({
      success: true,
      message: `${results.filter(r => r.status === 'Sent').length} ईमेल सफलतापूर्वक भेजे गए!`,
      details: results,
    });

  } catch (error) {
    console.error('SMTP Error:', error);
    return res.status(500).json({
      success: false,
      message: 'ईमेल भेजने में त्रुटि: ' + error.message,
    });
  }
});

// Root Route fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[✓] Mailer Server running on http://localhost:${PORT}`);
});

module.exports = app;
