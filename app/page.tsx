'use client';

import { useState } from 'react';

export default function BulkEmailSender() {
  const [formData, setFormData] = useState({
    senderName: '',
    email: '',
    appPassword: '',
    subject: '',
    body: '',
    recipients: '',
  });

  const [status, setStatus] = useState({ total: 0, sent: 0, failed: 0, remaining: 0 });
  const [isSending, setIsSending] = useState(false);

  const handleSend = async () => {
    const list = formData.recipients
      .split(/[\n,]+/)
      .map((e) => e.trim())
      .filter((e) => e.length > 0);

    if (list.length === 0) return alert('Please enter at least one recipient email.');
    if (!formData.email || !formData.appPassword) return alert('Gmail address and App Password are required.');

    // LOCK CURRENT CREDENTIALS FOR ENTIRE BATCH
    const currentBatchConfig = { ...formData };

    setIsSending(true);
    setStatus({ total: list.length, sent: 0, failed: 0, remaining: list.length });

    let sentCount = 0;
    let failedCount = 0;

    for (let i = 0; i < list.length; i++) {
      const recipient = list[i];

      try {
        const res = await fetch('/api/send-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            senderName: currentBatchConfig.senderName,
            email: currentBatchConfig.email,
            appPassword: currentBatchConfig.appPassword,
            subject: currentBatchConfig.subject,
            body: currentBatchConfig.body,
            recipient: recipient,
          }),
        });

        const data = await res.json();
        if (data.success) {
          sentCount++;
        } else {
          failedCount++;
        }
      } catch (err) {
        failedCount++;
      }

      setStatus({
        total: list.length,
        sent: sentCount,
        failed: failedCount,
        remaining: list.length - (sentCount + failedCount),
      });

      // 2 Seconds Delay
      if (i < list.length - 1) {
        await new Promise((res) => setTimeout(res, 600));
      }
    }

    setIsSending(false);
    alert('Campaign Execution Completed!');
  };

  return (
    <div style={{ padding: '30px', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <h2>Secure Bulk Mailer</h2>
      
      {/* Campaign Monitor */}
      <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', background: '#f0f0f0', padding: '15px', borderRadius: '8px' }}>
        <div><b>TOTAL:</b> {status.total}</div>
        <div style={{ color: 'green' }}><b>SENT:</b> {status.sent}</div>
        <div style={{ color: 'red' }}><b>FAILED:</b> {status.failed}</div>
        <div style={{ color: 'orange' }}><b>REMAINING:</b> {status.remaining}</div>
      </div>

      {/* Form Controls */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <input
          type="text"
          placeholder="Sender Name"
          value={formData.senderName}
          onChange={(e) => setFormData({ ...formData, senderName: e.target.value })}
          style={{ padding: '10px' }}
        />
        <input
          type="email"
          placeholder="Your Gmail Address"
          value={formData.email}
          onChange={(e) => setFormData({ ...formData, email: e.target.value })}
          style={{ padding: '10px' }}
        />
        <input
          type="password"
          placeholder="16-character App Password"
          value={formData.appPassword}
          onChange={(e) => setFormData({ ...formData, appPassword: e.target.value })}
          style={{ padding: '10px' }}
        />
        <input
          type="text"
          placeholder="Email Subject"
          value={formData.subject}
          onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
          style={{ padding: '10px' }}
        />
        <textarea
          rows={5}
          placeholder="Message Body"
          value={formData.body}
          onChange={(e) => setFormData({ ...formData, body: e.target.value })}
          style={{ padding: '10px' }}
        />
        <textarea
          rows={4}
          placeholder="Recipients (Comma or line separated)"
          value={formData.recipients}
          onChange={(e) => setFormData({ ...formData, recipients: e.target.value })}
          style={{ padding: '10px' }}
        />
        <button
          onClick={handleSend}
          disabled={isSending}
          style={{
            padding: '12px',
            background: isSending ? '#ccc' : '#0070f3',
            color: '#fff',
            border: 'none',
            borderRadius: '5px',
            cursor: isSending ? 'not-allowed' : 'pointer',
            fontSize: '16px',
            fontWeight: 'bold',
          }}
        >
          {isSending ? 'Processing Mails...' : 'Launch Campaign'}
        </button>
      </div>
    </div>
  );
}
