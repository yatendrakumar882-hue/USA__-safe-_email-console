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

    // Preserve exact 4-line breaks
    const normalizedBody = body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n').trim();

    // Direct authentic Google Transport (Bina proxy ke direct IP trust)
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: cleanEmail,
        pass: cleanAppPass,
      },
    });

    const info = await transporter.sendMail({
      from: `"${displayName}" <${cleanEmail}>`,
      to: cleanTo,
      subject: subject.trim(),
      text: normalizedBody,
    });

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    console.error('Delivery Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Delivery failed' }, { status: 500 });
  }
}
