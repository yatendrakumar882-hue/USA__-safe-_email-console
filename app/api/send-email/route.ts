import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';

export async function POST(req: Request) {
  try {
    const { senderName, email, appPassword, recipient, subject, body } = await req.json();

    if (!email || !appPassword || !recipient) {
      return NextResponse.json(
        { success: false, error: 'Sender credentials and recipient are required.' },
        { status: 400 }
      );
    }

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
    const cleanSubject = (subject || '').trim() || 'Details';
    const cleanSenderName = senderName?.trim() || email.split('@')[0];

    // Paragraph format: har block par strict inline 11pt/Arial style
    // margin-bottom: 16px se har line/paragraph ke baad exact 1 line ka gap aayega
    const formattedParagraphs = cleanBody
      .split(/\n+/)
      .map(
        (line: string) => `
        <p style="margin: 0 0 16px 0; padding: 0; font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.5; color: #222222; mso-line-height-rule: exactly;">
          ${line.trim()}
        </p>
      `
      )
      .join('');

    // pt-based strict styling jo Outlook Word engine aur Gmail reply threads dono me font size lock rakhegi
    // Top padding: 18px sender header se 1-line distance create karta hai (Screenshot ke according)
    const formattedHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
        </head>
        <body style="margin: 0; padding: 0; background-color: #ffffff;">
          <div style="margin: 0; padding: 18px 0 0 0; font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #222222; line-height: 1.5; text-align: left; mso-line-height-rule: exactly;">
            ${formattedParagraphs}
          </div>
        </body>
      </html>
    `;

    const info = await transporter.sendMail({
      from: `"${cleanSenderName}" <${email.trim()}>`,
      to: recipient.trim(),
      subject: cleanSubject,
      text: cleanBody,
      html: formattedHtml,
      replyTo: email.trim(),
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
