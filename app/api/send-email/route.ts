import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';

export async function POST(req: Request) {
  try {
    const { senderName, email, appPassword, recipient, subject, body } = await req.json();

    if (!email || !appPassword || !recipient) {
      return NextResponse.json(
        { success: false, error: 'Credentials and recipient are required.' },
        { status: 400 }
      );
    }

    // Gmail Direct Port 465 SSL Connection
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: email.trim(),
        pass: appPassword.replace(/\s+/g, ''),
      },
      tls: {
        rejectUnauthorized: false,
      },
    });

    const cleanBody = (body || '').trim();
    const cleanSubject = (subject || '').trim() || 'Quick update';
    const cleanSenderName = senderName?.trim() || email.split('@')[0];

    // INBOX SECRET: Plain text + zero complex wrapper
    // Filters standard human emails ko prefer karte hain jisme koi promotional layout na ho
    const info = await transporter.sendMail({
      from: `"${cleanSenderName}" <${email.trim()}>`,
      to: recipient.trim(),
      subject: cleanSubject,
      text: cleanBody, // True natural text
      replyTo: email.trim(),
      headers: {
        'X-Mailer': 'Apple Mail (2.3654.120.0.1)', // Simulates authentic device mail
      },
    });

    return NextResponse.json({
      success: true,
      messageId: info.messageId,
    });
  } catch (error: any) {
    console.error('Nodemailer Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to dispatch email.',
      },
      { status: 500 }
    );
  }
}
