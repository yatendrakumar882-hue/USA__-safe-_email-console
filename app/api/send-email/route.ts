// 2-LANE CONCURRENT ENGINE (Speed Noticeably Fast)
  const handleSendEmails = async () => {
    if (recipientList.length === 0 || isSending) return;

    setIsSending(true);
    let sent = 0;
    let failed = 0;

    setStatus({ total: recipientList.length, sent: 0, failed: 0, remaining: recipientList.length });
    setStatusText('Paced inbox delivery running...');

    let currentIndex = 0;
    const CONCURRENCY = 2; // 2 Emails ek sath chalengi (Network wait aadha ho jayega)
    const INTER_MAIL_DELAY = 100; // 100ms safe pause

    const worker = async () => {
      while (currentIndex < recipientList.length) {
        const index = currentIndex++;
        const toEmail = recipientList[index];
        const personalizedBody = generateCleanBody(formData.body, toEmail, index);
        const personalizedSubject = generateCleanSubject(formData.subject, index);

        try {
          const res = await fetch('/api/send-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              senderName: formData.senderName,
              email: formData.email,
              appPassword: formData.appPassword,
              subject: personalizedSubject,
              body: personalizedBody,
              to: toEmail,
            }),
          });

          const data = await res.json();
          if (data.success) {
            sent++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }

        setStatus({
          total: recipientList.length,
          sent,
          failed,
          remaining: recipientList.length - (sent + failed),
        });

        if (INTER_MAIL_DELAY > 0) {
          await new Promise((resolve) => setTimeout(resolve, INTER_MAIL_DELAY));
        }
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, recipientList.length) }, () => worker());
    await Promise.all(workers);

    setStatusText(`Completed! Total sent: ${sent}, Failed: ${failed}`);
    setIsSending(false);
  };
