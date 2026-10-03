import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

function GetTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPassword = appPassword.replace(/\s+/g, '').trim();

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // Standard STARTTLS
    auth: {
      user: cleanEmail,
      pass: cleanPassword
    }
  });
}

app.post('/api/auth', (req, res) => {
  if (req.body.password === SITE_PASSWORD) return res.json({ success: true });
  return res.status(401).json({ success: false, message: 'Invalid Password' });
});

app.post('/api/verify', async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) return res.status(400).json({ success: false, message: 'Missing fields' });

  try {
    const transporter = GetTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP Verified' });
  } catch (err) {
    return res.status(401).json({ success: false, message: err.message });
  }
});

app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Parameters' })}\n\n`);
    res.end();
    return;
  }

  const transporter = GetTransporter(email, appPassword);

  for (let i = 0; i < recipients.length; i++) {
    const rawRecipient = recipients[i];
    const targetEmail = typeof rawRecipient === 'object' ? rawRecipient.email : rawRecipient;
    
    if (!targetEmail) continue;

    try {
      // Clean, standard options (No fake headers, no invisible noise)
      const mailOptions = {
        from: senderName ? `"${senderName}" <${email.toLowerCase().trim()}>` : email.toLowerCase().trim(),
        to: targetEmail.toLowerCase().trim(),
        subject: subject,
        text: messageBody
      };

      await transporter.sendMail(mailOptions);

      res.write(`data: ${JSON.stringify({ 
        success: true, 
        recipient: targetEmail,
        sentCount: i + 1 
      })}\n\n`);

      // Natural Human Delay (3 to 6 seconds) - Essential to reduce immediate Spam flagging
      const delay = Math.floor(3000 + Math.random() * 3000);
      await new Promise(r => setTimeout(r, delay));

    } catch (err) {
      res.write(`data: ${JSON.stringify({ success: false, recipient: targetEmail, error: err.message })}\n\n`);
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

app.use((req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Clean Engine Active on Port ${PORT}`));

export default app;
