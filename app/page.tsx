'use client';

import React, { useState } from 'react';

export default function SecureMailConsole() {
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
  const [statusText, setStatusText] = useState('Ready to send');

  const handleSendEmails = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSending(true);

    const recipientList = formData.recipients
      .split('\n')
      .map((r) => r.trim())
      .filter((r) => r.length > 0);

    if (recipientList.length === 0) {
      setStatusText('Please enter at least one recipient email.');
      setIsSending(false);
      return;
    }

    let sentCount = 0;
    let failedCount = 0;
    const BATCH_SIZE = 6;

    for (let i = 0; i < recipientList.length; i += BATCH_SIZE) {
      const currentBatch = recipientList.slice(i, i + BATCH_SIZE);

      await Promise.all(
        currentBatch.map(async (recipientEmail) => {
          try {
            const res = await fetch('/api/send-email', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                senderName: formData.senderName,
                email: formData.email,
                appPassword: formData.appPassword,
                subject: formData.subject,
                body: formData.body,
                to: recipientEmail,
              }),
            });
            const data = await res.json();
            if (data.success) {
              sentCount++;
            } else {
              failedCount++;
            }
          } catch {
            failedCount++;
          }
        })
      );

      setStatus({
        total: recipientList.length,
        sent: sentCount,
        failed: failedCount,
        remaining: recipientList.length - (sentCount + failedCount),
      });

      if (i + BATCH_SIZE < recipientList.length) {
        setStatusText(`Batch sent (${sentCount}/${recipientList.length}). Waiting 4s...`);
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    }

    setStatusText('Completed all emails!');
    setIsSending(false);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-white p-6 flex justify-center items-center">
      <div className="w-full max-w-2xl bg-slate-800 p-8 rounded-xl shadow-lg border border-slate-700">
        <h1 className="text-2xl font-bold mb-6 text-center text-blue-400">Secure Mail Console</h1>

        <form onSubmit={handleSendEmails} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm mb-1">Sender Name</label>
              <input
                type="text"
                required
                className="w-full p-2.5 rounded bg-slate-700 border border-slate-600 focus:outline-none focus:border-blue-500"
                value={formData.senderName}
                onChange={(e) => setFormData({ ...formData, senderName: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm mb-1">Sender Gmail</label>
              <input
                type="email"
                required
                className="w-full p-2.5 rounded bg-slate-700 border border-slate-600 focus:outline-none focus:border-blue-500"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm mb-1">Gmail App Password (16 letters)</label>
            <input
              type="password"
              required
              className="w-full p-2.5 rounded bg-slate-700 border border-slate-600 focus:outline-none focus:border-blue-500"
              value={formData.appPassword}
              onChange={(e) => setFormData({ ...formData, appPassword: e.target.value })}
            />
          </div>

          <div>
            <label className="block text-sm mb-1">Subject</label>
            <input
              type="text"
              required
              className="w-full p-2.5 rounded bg-slate-700 border border-slate-600 focus:outline-none focus:border-blue-500"
              value={formData.subject}
              onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
            />
          </div>

          <div>
            <label className="block text-sm mb-1">Recipients (1 email per line)</label>
            <textarea
              rows={4}
              required
              className="w-full p-2.5 rounded bg-slate-700 border border-slate-600 focus:outline-none focus:border-blue-500 font-mono text-sm"
              value={formData.recipients}
              onChange={(e) => setFormData({ ...formData, recipients: e.target.value })}
            />
          </div>

          <div>
            <label className="block text-sm mb-1">Email Body</label>
            <textarea
              rows={5}
              required
              className="w-full p-2.5 rounded bg-slate-700 border border-slate-600 focus:outline-none focus:border-blue-500 text-sm"
              value={formData.body}
              onChange={(e) => setFormData({ ...formData, body: e.target.value })}
            />
          </div>

          <button
            type="submit"
            disabled={isSending}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 rounded font-semibold transition disabled:opacity-50"
          >
            {isSending ? 'Sending Batches...' : 'Send Emails (2 per batch)'}
          </button>
        </form>

        <div className="mt-6 p-4 bg-slate-700/50 rounded-lg text-sm space-y-1">
          <p><span className="text-slate-400">Status:</span> {statusText}</p>
          <p><span className="text-slate-400">Progress:</span> Total: {status.total} | Sent: {status.sent} | Failed: {status.failed} | Left: {status.remaining}</p>
        </div>
      </div>
    </div>
  );
}
