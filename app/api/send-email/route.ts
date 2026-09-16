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

    // Standard RFC line endings
    const normalizedBody = body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n').trim();

    // Clean inline formatting for Outlook & Gmail (11pt Arial)
    const formattedHtml = normalizedBody
      .split('\r\n\r\n')
      .map(
        (para: string) =>
          `<div style="margin-bottom: 12px; font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.5; color: #222222;">${para.replace(
            /\r\n/g,
            '<br/>'
          )}</div>`
      )
      .join('');

    // Direct High-Trust Connection (Bina kisi proxy footprint ke)
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: cleanEmail,
        pass: cleanAppPass,
      },
      connectionTimeout: 10000,
    });

    const info = await transporter.sendMail({
      from: `"${displayName}" <${cleanEmail}>`,
      to: cleanTo,
      subject: subject.trim(),
      text: normalizedBody,
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:12px;font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#222222;">${formattedHtml}</body></html>`,
    });

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    console.error('SMTP Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Delivery failed' }, { status: 500 });
  }
}
