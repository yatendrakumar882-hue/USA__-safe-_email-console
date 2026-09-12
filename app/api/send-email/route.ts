import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';

export async function POST(req: Request) {
  try {
    const { senderName, email, appPassword, recipient, subject, body } = await req.json();

    // 1. Basic validation
    if (!email || !appPassword || !recipient) {
      return NextResponse.json(
        { success: false, error: 'Sender email, app password, and recipient are required.' },
        { status: 400 }
      );
    }

    // 2. Transporter configuration for Gmail Secure Port 465 (SSL/TLS)
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: email.trim(),
        pass: appPassword.replace(/\s+/g, ''), // Spaces remove karta hai
      },
      tls: {
        rejectUnauthorized: false,
      },
    });

    const cleanBody = body || '';
    const cleanSubject = subject || 'No Subject';
    const cleanSenderName = senderName?.trim() || email.split('@')[0];

    // 3. Clean and standard HTML layout (inbox deliverability improve karne ke liye)
    const formattedHtml = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${cleanSubject}</title>
        </head>
        <body style="margin: 0; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #1f2937; background-color: #ffffff;">
          <div style="max-width: 600px; margin: 0 auto;">
            ${cleanBody.replace(/\n/g, '<br/>')}
          </div>
        </body>
      </html>
    `;

    // 4. Send email configuration
    const info = await transporter.sendMail({
      from: `"${cleanSenderName}" <${email.trim()}>`,
      to: recipient.trim(),
      subject: cleanSubject,
      text: cleanBody, // Plain text fallback
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
