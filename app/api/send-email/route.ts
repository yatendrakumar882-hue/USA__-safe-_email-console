import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { SocksProxyAgent } from 'socks-proxy-agent';

export async function POST(req: Request) {
  try {
    const { senderName, email, appPassword, subject, body, to } = await req.json();

    if (!email || !appPassword || !to) {
      return NextResponse.json({ success: false, error: 'Missing parameters' }, { status: 400 });
    }

    const cleanEmail = email.trim();
    const cleanAppPass = appPassword.replace(/\s+/g, '');
    const cleanTo = to.trim();

    // SOCKS5 Proxy Loading
    const rawProxies = process.env.SOCKS5_PROXY_URLS || '';
    const proxyList = rawProxies.split(',').map((p) => p.trim()).filter(Boolean);
    const randomProxy = proxyList.length > 0 
      ? proxyList[Math.floor(Math.random() * proxyList.length)] 
      : null;
    const agent = randomProxy ? new SocksProxyAgent(randomProxy) : undefined;

    // Authentic Google SMTP Config
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: cleanEmail,
        pass: cleanAppPass,
      },
      connectionTimeout: 15000,
      socketTimeout: 20000,
      ...(agent && {
        pool: false,
        // @ts-ignore
        agent: agent,
      }),
    });

    const displayName = senderName ? senderName.trim() : cleanEmail.split('@')[0];

    // Bilkul clean Google signature (Koi fake header ya fake message-id nahi)
    const info = await transporter.sendMail({
      from: `"${displayName}" <${cleanEmail}>`,
      to: cleanTo,
      subject: subject.trim(),
      text: body,
    });

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    console.error('Delivery Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Delivery failed' }, { status: 500 });
  }
}
