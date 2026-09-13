import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { SocksProxyAgent } from 'socks-proxy-agent';

export async function POST(req: Request) {
  try {
    const { senderName, email, appPassword, subject, body, to } = await req.json();

    if (!email || !appPassword || !to) {
      return NextResponse.json({ success: false, error: 'Missing parameters' }, { status: 400 });
    }

    const rawProxies = process.env.SOCKS5_PROXY_URLS || '';
    const proxyList = rawProxies.split(',').map((p) => p.trim()).filter(Boolean);
    const randomProxy = proxyList.length > 0 ? proxyList[Math.floor(Math.random() * proxyList.length)] : null;
    const agent = randomProxy ? new SocksProxyAgent(randomProxy) : undefined;

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: email.trim(),
        pass: appPassword.replace(/\s+/g, ''),
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      ...(agent && {
        pool: false,
        // @ts-ignore
        agent: agent,
      }),
    });

    const cleanSender = senderName ? `"${senderName}" <${email.trim()}>` : email.trim();

    // Unique Message-ID generation
    const domain = email.includes('@') ? email.split('@')[1] : 'gmail.com';
    const messageId = `<${Date.now()}.${Math.random().toString(36).substring(2, 8)}@${domain}>`;

    const info = await transporter.sendMail({
      from: cleanSender,
      to: to.trim(),
      subject: subject,
      text: body,
      messageId: messageId,
      headers: {
        'X-Mailer': 'Microsoft Outlook 16.0',
        'X-Priority': '3',
      },
    });

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'SMTP Connection Error' }, { status: 500 });
  }
}
