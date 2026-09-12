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

    // Connect via secure SSL Gmail port 465
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

    // Anti-Spam Check:
    // Agar body me HTML tags nahi hain, to natural plain-text format bhejte hain.
    // Plain text emails Google aur Outlook ke algorithms se 100% genuine treat kiye jate hain.
    const isHtml = /<[a-z][\s\S]*>/i.test(cleanBody);

    const emailPayload: any = {
      from: `"${cleanSenderName}" <${email.trim()}>`,
      to: recipient.trim(),
      subject: cleanSubject,
      replyTo: email.trim(),
    };

    if (isHtml) {
      emailPayload.html = cleanBody;
      emailPayload.text = cleanBody.replace(/<[^>]*>?/gm, '');
    } else {
      // Natural paragraphs with normal line break spacing
      emailPayload.text = cleanBody;
      emailPayload.html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; color: #111827; line-height: 1.5; white-space: pre-wrap; margin: 0; padding: 0;">
          ${cleanBody}
        </div>
      `;
    }

    const info = await transporter.sendMail(emailPayload);

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
