import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { senderName, email, appPassword, subject, body, to } = await req.json();

    if (!email || !appPassword || !to) {
      return NextResponse.json({ success: false, error: 'Parameters missing' }, { status: 400 });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanAppPass = appPassword.replace(/\s+/g, '');
    const cleanTo = to.trim().toLowerCase();
    const displayName = senderName ? senderName.trim() : cleanEmail.split('@')[0];

    // Standard RFC CRLF line endings
    const normalizedBody = body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n').trim();

    // Natural HTML Formatting: Authentic Gmail Webmail structure (Zero Obfuscation)
    const formattedHtml = normalizedBody
      .split('\r\n\r\n')
      .map(
        (para: string) =>
          `<div style="margin-bottom: 12px; font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.5; color: #222222;">${para.replace(
            /\r\n/g,
            '<br>'
          )}</div>`
      )
      .join('');

    // Clean Google Webmail Body
    const fullHtml = `<div dir="ltr" style="font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #222222; line-height: 1.5;">${formattedHtml}</div>`;

    // Direct High-Trust Native Google TLS Transport
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: cleanEmail,
        pass: cleanAppPass,
      },
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });

    // Pure Genuine Google Envelope (Passes 100% SPF, DKIM & DMARC)
    const info = await transporter.sendMail({
      from: `"${displayName}" <${cleanEmail}>`,
      to: cleanTo,
      subject: subject.trim(),
      text: normalizedBody,
      html: fullHtml,
    });

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    console.error('SMTP Delivery Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Delivery failed' }, { status: 500 });
  }
}
