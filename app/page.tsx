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

    const currentBatchConfig = { ...formData };

    setIsSending(true);
    setStatus({ total: list.length, sent: 0, failed: 0, remaining: list.length });

    let sentCount = 0;
    let failedCount = 0;

    // Concurrency: Batch size 6 (ek sath 6 email jayenge)
    const BATCH_SIZE = 6;
    // Gmail deliverability safe delay between batches (2000ms = 2 seconds)
    const BATCH_DELAY_MS = 2000;

    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      const batchRecipients = list.slice(i, i + BATCH_SIZE);

      // Ek sath 6 parallel requests trigger karna
      const batchPromises = batchRecipients.map(async (recipient) => {
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
          return data.success;
        } catch {
          return false;
        }
      });

      const results = await Promise.allSettled(batchPromises);

      results.forEach((result) => {
        if (result.status === 'fulfilled' && result.value === true) {
          sentCount++;
        } else {
          failedCount++;
        }
      });

      setStatus({
        total: list.length,
        sent: sentCount,
        failed: failedCount,
        remaining: list.length - (sentCount + failedCount),
      });

      // Har 6 emails ke batch ke baad safe throttle delay
      if (i + BATCH_SIZE < list.length) {
        await new Promise((res) => setTimeout(res, BATCH_DELAY_MS));
      }
    }

    setIsSending(false);
    alert('Campaign Execution Completed!');
  };

  return (
    <div style={{ padding: '30px', fontFamily: 'sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <h2>Secure Bulk Mailer (Concurrent Mode)</h2>

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
          {isSending ? 'Processing Batches...' : 'Launch Campaign'}
        </button>
      </div>
    </div>
  );
}
