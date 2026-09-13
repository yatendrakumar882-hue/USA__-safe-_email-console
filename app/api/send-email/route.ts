import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { SocksProxyAgent } from 'socks-proxy-agent';

export async function POST(req: Request) {
  try {
    const { senderName, email, appPassword, subject, body, to } = await req.json();

    if (!email || !appPassword || !to) {
      return NextResponse.json({ success: false, error: 'Email, App Password, and Recipient are required.' }, { status: 400 });
    }

    // Load SOCKS5 Proxies from Vercel Environment Variables
    const rawProxies = process.env.SOCKS5_PROXY_URLS || '';
    const proxyList = rawProxies.split(',').map((p) => p.trim()).filter(Boolean);
    const randomProxy = proxyList.length > 0 ? proxyList[Math.floor(Math.random() * proxyList.length)] : null;
    const agent = randomProxy ? new SocksProxyAgent(randomProxy) : undefined;

    // Direct SMTP Transporter with connection pooling & timeouts
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: email.trim(),
        pass: appPassword.replace(/\s+/g, ''),
      },
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      ...(agent && {
        pool: false,
        // @ts-ignore
        agent: agent,
      }),
    });

    const cleanSender = senderName ? `"${senderName}" <${email.trim()}>` : email.trim();
    const domain = email.includes('@') ? email.split('@')[1] : 'gmail.com';
    const messageId = `<${Date.now()}.${Math.random().toString(36).substring(2, 9)}@${domain}>`;

    // Send Mail (Plain Text + Anti-Spam Personal Headers)
    const info = await transporter.sendMail({
      from: cleanSender,
      to: to.trim(),
      subject: subject,
      text: body,
      messageId: messageId,
      headers: {
        'X-Mailer': 'Microsoft Outlook 16.0',
        'X-Priority': '3',
        'Importance': 'normal',
        'Precedence': 'personal',
      },
    });

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    console.error('SMTP Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Transmission failed' }, { status: 500 });
  }
}
