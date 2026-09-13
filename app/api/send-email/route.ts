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

    // Convert text blocks into clean, native paragraph tags
    // margin: 0 0 16px 0 preserves exact 1-line gap in Gmail & Outlook
    const paragraphs = cleanBody
      .split(/\n+/)
      .map(
        (p: string) =>
          `<p style="margin: 0 0 16px 0; padding: 0; font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.5; color: #222222; mso-line-height-rule: exactly;">${p.trim()}</p>`
      )
      .join('');

    // Table-based 18px top spacer (never stripped by Outlook reply engines)
    const formattedHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
        </head>
        <body style="margin: 0; padding: 0; background-color: #ffffff;">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">
            <tr>
              <td height="18" style="font-size: 18px; line-height: 18px; height: 18px; mso-line-height-rule: exactly;">&nbsp;</td>
            </tr>
            <tr>
              <td style="font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #222222; line-height: 1.5; mso-line-height-rule: exactly;">
                ${paragraphs}
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;

    // Dispatching clean conversational email (No spam headers)
    const info = await transporter.sendMail({
      from: `"${cleanSenderName}" <${email.trim()}>`,
      to: recipient.trim(),
      subject: cleanSubject,
      text: cleanBody, // True plain-text version passes primary inbox filters
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
