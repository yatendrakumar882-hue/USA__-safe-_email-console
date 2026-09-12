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

    // Har line ko paragraph me wrap karke line-height aur bottom margin enforce karte hain
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

    // Table wrapper layout:
    // Outlook desktop CSS padding ko remove kar deta hai, lekin Table row/cell height aur <br/> ko kabhi delete nahi karta.
    const formattedHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
        </head>
        <body style="margin: 0; padding: 0; background-color: #ffffff;">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">
            <!-- Exact 1-line top spacer for Outlook & Gmail (18px height) -->
            <tr>
              <td height="18" style="font-size: 18px; line-height: 18px; height: 18px; mso-line-height-rule: exactly;">&nbsp;</td>
            </tr>
            <tr>
              <td style="font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #222222; line-height: 1.5; mso-line-height-rule: exactly;">
                ${formattedParagraphs}
              </td>
            </tr>
          </table>
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
