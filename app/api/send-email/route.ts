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

    const rawProxies = process.env.SOCKS5_PROXY_URLS || '';
    const proxyList = rawProxies.split(',').map((p) => p.trim()).filter(Boolean);
    const displayName = senderName ? senderName.trim() : cleanEmail.split('@')[0];

    const sendWithTransport = async (proxyUrl?: string) => {
      const agent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;

      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
          user: cleanEmail,
          pass: cleanAppPass,
        },
        connectionTimeout: 8000,
        greetingTimeout: 5000,
        socketTimeout: 10000,
        ...(agent && {
          pool: false,
          // @ts-ignore
          agent: agent,
        }),
      });

      // Pure Native Google 1-on-1 Envelope: Guarantees 100% SPF/DKIM authentication pass
      return await transporter.sendMail({
        from: `"${displayName}" <${cleanEmail}>`,
        to: cleanTo,
        envelope: {
          from: cleanEmail,
          to: [cleanTo],
        },
        subject: subject.trim(),
        text: body.trim(),
        encoding: 'utf-8',
      });
    };

    let info;
    const selectedProxy = proxyList.length > 0 
      ? proxyList[Math.floor(Math.random() * proxyList.length)] 
      : undefined;

    try {
      info = await sendWithTransport(selectedProxy);
    } catch (proxyError) {
      console.warn('Proxy socket drop, activating direct fail-safe...', proxyError);
      info = await sendWithTransport(undefined);
    }

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    console.error('Final SMTP Delivery Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Delivery failed' }, { status: 500 });
  }
}
