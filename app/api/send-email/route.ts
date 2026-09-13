import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { SocksProxyAgent } from 'socks-proxy-agent';

export async function POST(req: Request) {
  try {
    const { senderName, email, appPassword, subject, body, to } = await req.json();

    if (!email || !appPassword || !to) {
      return NextResponse.json({ success: false, error: 'Email, App Password, and Recipient are required.' }, { status: 400 });
    }

    const cleanEmail = email.trim();
    const cleanAppPass = appPassword.replace(/\s+/g, '');
    const cleanTo = to.trim();

    // SOCKS5 Proxy rotation from Vercel ENV
    const rawProxies = process.env.SOCKS5_PROXY_URLS || '';
    const proxyList = rawProxies.split(',').map((p) => p.trim()).filter(Boolean);
    const randomProxy = proxyList.length > 0 
      ? proxyList[Math.floor(Math.random() * proxyList.length)] 
      : null;
    const agent = randomProxy ? new SocksProxyAgent(randomProxy) : undefined;

    // Secure SMTP connection with conservative timeouts
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: cleanEmail,
        pass: cleanAppPass,
      },
      connectionTimeout: 20000,
      greetingTimeout: 15000,
      socketTimeout: 25000,
      ...(agent && {
        pool: false,
        // @ts-ignore
        agent: agent,
      }),
    });

    const displayName = senderName ? senderName.trim() : cleanEmail.split('@')[0];
    const uniqueMessageId = `<${Date.now()}.${Math.random().toString(36).substring(2, 9)}@mail.gmail.com>`;

    // Pure 1-to-1 Plain Text Signature (Maximum Inbox Deliverability)
    const mailOptions = {
      from: `"${displayName}" <${cleanEmail}>`,
      to: cleanTo,
      subject: subject.trim(),
      text: body,
      messageId: uniqueMessageId,
      date: new Date(),
      headers: {
        'MIME-Version': '1.0',
        'X-Google-Sender-Auth': cleanEmail,
      },
    };

    const info = await transporter.sendMail(mailOptions);

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    console.error('Delivery Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Delivery failed' }, { status: 500 });
  }
}
