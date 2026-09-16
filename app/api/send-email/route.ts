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

    // Sensitive Words NLP Masking List
    const spamWords = [
      'error', 'page', 'site', 'website', 'quote', 'screenshot', 'sereenshot',
      'information', 'google', 'first', 'frist', 'hi', 'hello', 'send',
      'email', 'ranking', 'seo', 'glitch', 'bug', 'problem', 'details'
    ];

    // Har sensitive word ke beech invisible zero-width space taaki NLP filters trigger na hon
    let protectedHtmlBody = normalizedBody;
    spamWords.forEach((word) => {
      const regex = new RegExp(`(${word[0]})(${word.slice(1)})`, 'gi');
      protectedHtmlBody = protectedHtmlBody.replace(regex, '$1&#8203;$2');
    });

    // Outlook Quote Font Shrink Permanent Fix (Inline 11pt Arial on every paragraph)
    const formattedHtml = protectedHtmlBody
      .split('\r\n\r\n')
      .map(
        (para: string) =>
          `<div style="margin: 0 0 12px 0; font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.5; color: #222222;">${para.replace(
            /\r\n/g,
            '<br/>'
          )}</div>`
      )
      .join('');

    // Direct High-Trust Native Google Connection (Zero Proxy/Script Footprint)
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: cleanEmail,
        pass: cleanAppPass,
      },
      connectionTimeout: 10000,
      greetingTimeout: 8000,
      socketTimeout: 12000,
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
    console.error('SMTP Delivery Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Delivery failed' }, { status: 500 });
  }
}
