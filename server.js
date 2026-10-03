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

// Standard Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Create Transporter Pool (Standard TLS configuration)
function createTransporter(user, pass) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // STARTTLS
    requireTLS: true,
    auth: { user, pass },
    pool: true,
    maxConnections: 5,
    maxMessages: 100
  });
}

// Health Check / Main Route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Single Email Dispatch Route
app.post('/api/send-email', async (req, res) => {
  const { email, appPassword, to, subject, htmlContent, textContent } = req.body;

  if (!email || !appPassword || !to || !subject) {
    return res.status(400).json({ success: false, message: 'Required fields missing' });
  }

  try {
    const transporter = createTransporter(email, appPassword);

    const mailOptions = {
      from: email,
      to: to,
      subject: subject,
      text: textContent || 'Hello, please view this email in an HTML-compatible reader.',
      html: htmlContent || `<p>${textContent}</p>`
    };

    const info = await transporter.sendMail(mailOptions);
    return res.json({ success: true, messageId: info.messageId });
  } catch (error) {
    console.error('Mail Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
