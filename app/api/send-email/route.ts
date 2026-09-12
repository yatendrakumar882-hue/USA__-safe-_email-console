import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';

export async function POST(req: Request) {
  try {
    const { senderName, email, appPassword, recipient, subject, body } = await req.json();

    if (!email || !appPassword || !recipient) {
      return NextResponse.json(
        { success: false, error: 'Missing credentials or recipient' },
        { status: 400 }
      );
    }

    // Gmail Port 465 TLS Connection
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: email,
        pass: appPassword.replace(/\s+/g, ''),
      },
      tls: {
        rejectUnauthorized: false,
      },
    });

    const cleanBody = body || '';
    const formattedHtml = `<div style="font-family: sans-serif; font-size: 14px; color: #000;">${cleanBody.replace(/\n/g, '<br/>')}</div>`;

    const info = await transporter.sendMail({
      from: `"${senderName || 'Sender'}" <${email}>`,
      to: recipient,
      subject: subject || 'No Subject',
      text: cleanBody, // Plain Text Fallback
      html: formattedHtml, // HTML Version
      replyTo: email,
      headers: {
        'X-Priority': '3',
        'X-MSMail-Priority': 'Normal',
        'Importance': 'Normal',
      },
    });

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    console.error('Nodemailer Error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to send email' },
      { status: 500 }
    );
  }
}
