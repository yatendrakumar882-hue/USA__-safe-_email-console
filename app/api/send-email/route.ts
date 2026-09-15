import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { SocksProxyAgent } from 'socks-proxy-agent';

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

    // Standard RFC line endings (\r\n) taaki exact line structure preserve rahe
    const normalizedBody = body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n').trim();

    const rawProxies = process.env.SOCKS5_PROXY_URLS || '';
    const proxyList = rawProxies.split(',').map((p) => p.trim()).filter(Boolean);

    const sendEmailViaSmtp = async (useProxy: boolean) => {
      let agent: SocksProxyAgent | undefined = undefined;

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
        greetingTimeout: 8000,
        socketTimeout: 12000,
        ...(agent && {
          pool: false,
          // @ts-ignore
          agent: agent,
        }),
      });

      // Pure Native Google Transport (100% authentic SPF/DKIM signature)
      return await transporter.sendMail({
        from: `"${displayName}" <${cleanEmail}>`,
        to: cleanTo,
        subject: subject.trim(),
        text: normalizedBody,
      });
    };

    let info;
    try {
      info = await sendEmailViaSmtp(proxyList.length > 0);
    } catch (primaryErr: any) {
      console.warn('Initial transport dropped, using direct clean connection...', primaryErr?.message);
      info = await sendEmailViaSmtp(false);
    }

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    console.error('Final SMTP Delivery Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Delivery failed' }, { status: 500 });
  }
}
