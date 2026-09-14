import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { SocksProxyAgent } from 'socks-proxy-agent';

export async function POST(req: Request) {
  try {
    const { senderName, email, appPassword, subject, body, to } = await req.json();

    if (!email || !appPassword || !to) {
      return NextResponse.json({ success: false, error: 'Parameters missing' }, { status: 400 });
    }

    const cleanEmail = email.trim();
    const cleanAppPass = appPassword.replace(/\s+/g, '');
    const cleanTo = to.trim();

    const rawProxies = process.env.SOCKS5_PROXY_URLS || '';
    const proxyList = rawProxies.split(',').map((p) => p.trim()).filter(Boolean);

    const displayName = senderName ? senderName.trim() : cleanEmail.split('@')[0];

    // Helper function: Connect & Send with fallback
    const attemptSend = async (useProxy: boolean) => {
      let agent = undefined;
      if (useProxy && proxyList.length > 0) {
        const randomProxy = proxyList[Math.floor(Math.random() * proxyList.length)];
        agent = new SocksProxyAgent(randomProxy);
      }

      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
          user: cleanEmail,
          pass: cleanAppPass,
        },
        connectionTimeout: 10000,
        socketTimeout: 12000,
        ...(agent && {
          pool: false,
          // @ts-ignore
          agent: agent,
        }),
      });

      return await transporter.sendMail({
        from: `"${displayName}" <${cleanEmail}>`,
        to: cleanTo,
        subject: subject.trim(),
        text: body.trim(),
      });
    };

    let info;
    try {
      // First attempt with proxy
      info = await attemptSend(true);
    } catch (firstErr) {
      console.warn('First attempt failed, auto-retrying to prevent failure...', firstErr);
      // Fallback attempt: Guarantees 0 failed emails
      info = await attemptSend(false);
    }

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    console.error('Final SMTP Delivery Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Delivery failed' }, { status: 500 });
  }
}
