import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { SocksProxyAgent } from 'socks-proxy-agent';

export async function POST(req: Request) {
  try {
    const { senderName, email, appPassword, subject, body, to } = await req.json();

    if (!email || !appPassword || !to) {
      return NextResponse.json({ success: false, error: 'Email, App Password, and Recipient are required.' }, { status: 400 });
    }

    // 1. Read Proxies from Vercel Environment Variables
    const rawProxies = process.env.SOCKS5_PROXY_URLS || '';
    const proxyList = rawProxies.split(',').map((p) => p.trim()).filter(Boolean);

    // Randomly pick one proxy for this connection to distribute traffic across 20 IPs
    const randomProxy = proxyList.length > 0 
      ? proxyList[Math.floor(Math.random() * proxyList.length)] 
      : null;

    // 2. Setup SOCKS5 Agent
    const agent = randomProxy ? new SocksProxyAgent(randomProxy) : undefined;

    // 3. Create Transporter (Safe configuration)
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: email,
        pass: appPassword.replace(/\s+/g, ''), // remove spaces if pasted with spaces
      },
      // Pass proxy agent if available
      ...(agent && {
        pool: false,
        // @ts-ignore
        agent: agent,
      }),
    });

    // 4. Inboxing Header Optimization (Human-like regular message headers)
    const info = await transporter.sendMail({
      from: `"${senderName || email.split('@')[0]}" <${email}>`,
      to: to,
      subject: subject,
      text: body, // Plain text is primary for highest deliverability
      html: `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; color: #111; line-height: 1.5;">${body.replace(/\n/g, '<br/>')}</div>`,
      headers: {
        'X-Priority': '3', // Normal priority (avoids marketing/bulk categorization)
      },
    });

    return NextResponse.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    console.error('Mail sending error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to send email' }, { status: 500 });
  }
}
