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

    // Standard RFC line endings (\r\n) taaki exact line structure intact rahe
    const normalizedBody = body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n').trim();

    // Outlook Quote Font Fix: Inline exact 11pt / Arial styling on every block
    const formattedHtml = normalizedBody
      .split('\r\n\r\n')
      .map(
        (para: string) =>
          `<p style="margin: 0 0 14px 0; font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.5; color: #222222;">${para.replace(
            /\r\n/g,
            '<br/>'
          )}</p>`
      )
      .join('');

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

      return await transporter.sendMail({
        from: `"${displayName}" <${cleanEmail}>`,
        to: cleanTo,
        subject: subject.trim(),
        text: normalizedBody,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:12px;font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#222222;">${formattedHtml}</body></html>`,
      });
    };

    let info;
    try {
      info = await sendEmailViaSmtp(proxyList.length > 0);
    } catch (primaryErr: any) {
      console.warn('Proxy socket drop, executing direct fallback...', primaryErr?.message);
      info = await sendEmailViaSmtp(false);
    }

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    console.error('Final SMTP Delivery Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Delivery failed' }, { status: 500 });
  }
}
