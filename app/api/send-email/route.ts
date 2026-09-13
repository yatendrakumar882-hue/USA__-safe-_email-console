import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { SocksProxyAgent } from 'socks-proxy-agent';

export async function POST(req: Request) {
  try {
    const { senderName, email, appPassword, subject, body, to } = await req.json();

    if (!email || !appPassword || !to) {
      return NextResponse.json({ success: false, error: 'Missing parameters' }, { status: 400 });
    }

    // Proxy load
    const rawProxies = process.env.SOCKS5_PROXY_URLS || '';
    const proxyList = rawProxies.split(',').map((p) => p.trim()).filter(Boolean);
    const randomProxy = proxyList.length > 0 ? proxyList[Math.floor(Math.random() * proxyList.length)] : null;
    const agent = randomProxy ? new SocksProxyAgent(randomProxy) : undefined;

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: email,
        pass: appPassword.replace(/\s+/g, ''),
      },
      ...(agent && {
        pool: false,
        // @ts-ignore
        agent: agent,
      }),
    });

    // Generate unique Message-ID to look like standard client
    const cleanFrom = senderName ? `"${senderName}" <${email}>` : email;
    const domain = email.split('@')[1] || 'gmail.com';
    const cleanMessageId = `<${Date.now()}.${Math.random().toString(36).substring(2, 9)}@${domain}>`;

    // Send Mail: ONLY PLAIN TEXT (NO HTML wrappers)
    const info = await transporter.sendMail({
      from: cleanFrom,
      to: to.trim(),
      subject: subject,
      text: body, // Deliverability rule: plain text inbox me sabse clean jata hai
      messageId: cleanMessageId,
      headers: {
        'X-Mailer': 'Microsoft Outlook 16.0', // Trusted MUA Header
        'Precedence': 'personal',
        'Importance': 'normal',
      },
    });

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
